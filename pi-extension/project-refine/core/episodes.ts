import type { EvidenceEpisode, EvidenceExcerpt, RefineInterval } from "./types.ts";
import type { CollectSessionOptions, RawEntry, SessionNode, SessionSnapshot } from "./history.ts";
import { historyMessage, isToolCallBlock, SESSION_LIMITS } from "./history.ts";
import { clip, digest, isRecord, textContent, throwIfAborted } from "./util.ts";

interface Event {
  node: SessionNode;
  source: EvidenceExcerpt["source"];
  text: string;
  failure?: boolean;
  success?: boolean;
  correction?: boolean;
}
interface Call {
  name: string;
  command?: string;
  skill?: string;
  ambiguous?: boolean;
  resultSeen?: boolean;
}
const correction = /\b(actually|instead|wrong|incorrect|correction|don't|do not|should have|you (?:missed|forgot)|not what|try again)\b|^no[,!.\s]/i;
const refineRequest = /^\s*\/project-refine(?:\s|$)/i;
const isVerification = (command: unknown) => typeof command === "string" && /(?:\b(?:test|pytest|vitest|jest|ctest|cargo test|go test)\b|\b(?:npm|pnpm|bun) (?:run )?(?:test|typecheck|check)\b|\btsc\b)/i.test(command);
const safeName = (value: unknown) => typeof value === "string" ? value.replace(/[^\w./:@+ -]/g, "").slice(0, 100) : "unknown";
const refinerType = (value: unknown): value is string => typeof value === "string" && /^(?:pi[.:/-])?project-refine(?:[.:/-]|$)/i.test(value);

function excludedIdentities(sessions: SessionSnapshot[], intervals: RefineInterval[], warn: (s: string) => void): Set<string> {
  const excluded = new Set<string>();
  for (const session of sessions) {
    const byId = new Map(session.nodes.map((n) => [n.id, n]));
    for (const interval of intervals.filter((i) => i.sessionId === session.sessionId)) {
      if (interval.afterEntryId !== null && !byId.has(interval.afterEntryId)) {
        warn(`[${session.worktree.id}] ${session.sessionId}: refinement start boundary missing; session conservatively excluded.`);
        for (const node of session.nodes) excluded.add(node.identity);
        continue;
      }
      const end = interval.beforeEntryId ? byId.get(interval.beforeEntryId) : undefined;
      if (interval.beforeEntryId && !end) {
        warn(`[${session.worktree.id}] ${session.sessionId}: refinement end boundary missing; treated as open interval.`);
      }
      // Ledger intervals are (afterEntryId, beforeEntryId], or open-ended.
      const endPath = new Set<string>();
      for (let node = end; node; node = node.parentId === null ? undefined : byId.get(node.parentId)) {
        endPath.add(node.id);
      }
      const after = interval.afterEntryId;
      if (end && after !== null && !endPath.has(after)) {
        warn(`[${session.worktree.id}] ${session.sessionId}: refinement boundaries are on incompatible branches; session conservatively excluded.`);
        for (const node of session.nodes) excluded.add(node.identity);
        continue;
      }
      const descendants = new Set<string>();
      for (const node of session.nodes) {
        if (node.id === after) {
          descendants.add(node.id);
          continue;
        }
        if (after === null || (node.parentId !== null && descendants.has(node.parentId))) {
          descendants.add(node.id);
          if (!end || endPath.has(node.id)) excluded.add(node.identity);
        }
      }
    }
  }
  return excluded;
}

function markerPhase(raw: RawEntry): "start" | "end" | undefined {
  if (!refinerType(raw.customType)) return undefined;
  const data = isRecord(raw.data) ? raw.data : undefined;
  const phase = data?.phase ?? data?.event ?? data?.type;
  if ((typeof phase === "string" && /^(?:end|finish|finished)$/.test(phase)) || /[.:/-](?:end|finish)$/.test(raw.customType)) {
    return "end";
  }
  if ((typeof phase === "string" && /^(?:start|begin)$/.test(phase)) || /[.:/-](?:start|begin)$/.test(raw.customType)) {
    return "start";
  }
  return undefined;
}

function eventsFor(node: SessionNode, calls: Map<string, Call>, limitations: Set<string>): Event[] {
  const raw = node.raw;
  if (raw.type === "compaction" || raw.type === "branch_summary") {
    return typeof raw.summary === "string" && raw.summary ? [{ node, source: "summary", text: raw.summary }] : [];
  }
  if (raw.type !== "message") return [];
  const message = historyMessage(raw.message);
  if (!message) return [];
  const text = textContent(message.content);
  if (message.role === "user") {
    return text ? [{ node, source: "human", text, correction: correction.test(text) }] : [];
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    limitations.add("Stored summary-role messages are assistant-generated context claims, not direct observations.");
    return typeof message.summary === "string" && message.summary ? [{ node, source: "summary", text: message.summary }] : [];
  }
  if (message.role === "assistant") {
    const result: Event[] = [];
    if (text) result.push({ node, source: "assistant-claim", text });
    const metadata = ["provider", "model", "thinkingLevel"]
      .filter((key) => typeof message[key] === "string")
      .map((key) => `${key}=${safeName(message[key])}`);
    if (metadata.length) {
      limitations.add(`Assistant metadata observed: ${metadata.join(", ")}; requested settings do not prove historical instruction visibility.`);
    }
    if (Array.isArray(message.content)) {
      const blocks: unknown[] = message.content.filter((part: unknown) => isRecord(part) && part.type === "toolCall");
      if (blocks.length > 32) {
        limitations.add("Tool-call count bounded to 32 per assistant entry; remaining calls omitted.");
      }
      for (const block of blocks.slice(0, 32)) {
        if (!isToolCallBlock(block)) continue;
        const args = isRecord(block.arguments) ? block.arguments : undefined;
        const command = typeof args?.command === "string" ? clip(args.command, SESSION_LIMITS.excerptChars).text : undefined;
        const path = typeof args?.path === "string" ? args.path
          : typeof args?.file_path === "string" ? args.file_path : undefined;
        const skill = /(?:^|[./_-])read$/i.test(block.name) &&
          typeof path === "string" && /(?:^|[/\\])SKILL\.md$/i.test(path) ? path : undefined;
        if (calls.has(block.id)) {
          // Ambiguous IDs cannot be used to establish result ancestry.
          calls.set(block.id, { name: block.name, ambiguous: true });
          limitations.add("Repeated tool call ID on this ancestry; ambiguous pairing omitted.");
          continue;
        }
        calls.set(block.id, { name: block.name, command, skill });
        result.push({
          node,
          source: "tool",
          text: `Tool call ${safeName(block.name)} (${safeName(block.id)})` +
            (command ? ` command: ${command}` : "") +
            (path ? ` path: ${clip(path, 512).text}` : "") +
            (skill ? "\nSkill read attempt only; successful load/use is not established by the call." : ""),
        });
      }
    }
    return result;
  }
  if (message.role === "toolResult") {
    const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
    const paired = !!call && !call.ambiguous && !call.resultSeen && call.name === message.toolName;
    if (paired) call.resultSeen = true;
    if (!paired) {
      limitations.add("Unpaired tool result: no matching earlier call on this ancestry; no success/skill inference is made.");
    }
    const details = isRecord(message.details) ? message.details : undefined;
    const exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;
    const failure = paired && (message.isError === true || (exitCode !== undefined && exitCode !== 0));
    const success = paired && message.isError === false && isVerification(call?.command) &&
      (exitCode === 0 || /(?:\b[1-9]\d* (?:tests?|checks?) passed\b|# pass [1-9]\d*\b|\bTests:\s+\d+ passed\b)/i.test(text));
    const errorState = message.isError === true ? "true" : message.isError === false ? "false" : "unknown";
    const lines = [
      `Tool result ${safeName(message.toolName)} (${safeName(message.toolCallId)}); ` +
        `${paired ? "ancestry-paired" : "unpaired"}; isError=${errorState}` +
        (exitCode === undefined ? "" : `; exitCode=${exitCode}`),
      text,
    ];
    if (call?.skill && paired) {
      const observedText = message.isError === false && text.trim() &&
        !/\b(?:not found|no such file|permission denied)\b/i.test(text);
      lines.push(observedText
        ? "Observed non-error skill-read response with text; actual activation, full content visibility and use remain unverified."
        : "Skill read attempt outcome unknown/failed; successful activation is not established.");
    }
    const nested = isRecord(message.nestedCalls) ? message.nestedCalls : undefined;
    if (nested && Array.isArray(nested.calls)) {
      lines.push(`Nested-call metadata only (complete=${nested.complete === true}); bodies unavailable:`);
      const children: unknown[] = nested.calls;
      for (const child of children.slice(0, 8)) {
        const record = isRecord(child) ? child : undefined;
        lines.push(`${safeName(record?.name)}: ${safeName(record?.status)} (not proof of skill content/use)`);
      }
      limitations.add("Nested tool metadata is bounded to eight records; absent nested result bodies cannot establish skill loading.");
    }
    return [{ node, source: "tool", text: lines.filter(Boolean).join("\n"), failure, success }];
  }
  if (message.role === "bashExecution") {
    if (message.excludeFromContext) limitations.add("User bash marked excludeFromContext: recorded action is not evidence of model visibility.");
    const failure = typeof message.exitCode === "number" && message.exitCode !== 0 && message.cancelled !== true;
    const success = message.exitCode === 0 && message.cancelled !== true && isVerification(message.command);
    limitations.add("User bash is a user-run action, not an assistant tool result; external full-output paths were not read.");
    if (message.truncated) limitations.add("Recorded user-bash output is already truncated.");
    return [{
      node,
      source: "tool",
      text: `User bash: ${typeof message.command === "string" ? message.command : "[unknown]"}\n` +
        `exitCode=${typeof message.exitCode === "number" ? message.exitCode : "unknown"}; cancelled=${message.cancelled === true}\n` +
        (typeof message.output === "string" ? message.output : ""),
      failure,
      success,
    }];
  }
  // custom/hookMessage/system and unknown augmented roles are not human requests.
  return [];
}

function renderEpisode(session: SessionSnapshot, leafId: string, events: Event[], limitations: Set<string>, since: number): EvidenceEpisode | undefined {
  if (!events.length) return undefined;
  const at = Math.max(...events.map((event) => Date.parse(event.node.timestamp)).filter(Number.isFinite));
  if (!Number.isFinite(at) || at < since) return undefined;
  const failedAt = events.findLastIndex((e) => e.failure);
  const succeededAt = events.findLastIndex((e) => e.success);
  const recovered = failedAt >= 0 && succeededAt > failedAt;
  const outcome = succeededAt > failedAt ? "observed-success" : failedAt >= 0 ? "observed-failure" : "unknown";
  const kind = events.some((e) => e.correction) ? "correction" : recovered ? "recovery" : outcome === "observed-success" ? "success" : "neutral";
  // Keep requests, corrections and failure/recovery neighbors ahead of ordinary
  // commentary, but preserve original ordering in the final excerpts.
  const selected = new Set<number>([0, events.length - 1]);
  const important = events.map((event, index) => ({ event, index })).filter(({ event }) => event.correction || event.failure || event.success).reverse();
  const humans = events.map((event, index) => ({ event, index })).filter(({ event }) => event.source === "human");
  const anchors = [events.findIndex((e) => e.failure), events.findLastIndex((e) => e.success), events.findLastIndex((e) => e.correction)]
    .filter((index) => index >= 0).map((index) => ({ index }));
  for (const { index: i } of [...anchors, ...important, ...humans]) {
    for (const index of [i, i - 1, i + 1]) {
      if (index >= 0 && index < events.length && selected.size < SESSION_LIMITS.excerpts) selected.add(index);
    }
  }
  for (let i = 0; i < events.length && selected.size < SESSION_LIMITS.excerpts; i++) {
    selected.add(i);
  }
  const excerpts: EvidenceExcerpt[] = [...selected].sort((a, b) => a - b).map((index) => ({
    entryId: events[index].node.citation,
    source: events[index].source,
    ...clip(events[index].text, SESSION_LIMITS.excerptChars),
  }));
  const entryIds = [...new Set(excerpts.map((e) => e.entryId))];
  const notes = new Set([...session.limitations, ...limitations]);
  if (events.length > selected.size) notes.add(`Excerpt limit: ${events.length - selected.size} events omitted; selected neighboring evidence only.`);
  if (excerpts.some((e) => e.truncated)) notes.add("Some excerpts truncated; conclusions must not assume omitted output.");
  notes.add("Outcomes describe observed verification/tool failure only, not overall task success; assistant claims and later user messages do not establish success.");
  notes.add("Correction/recovery labels are selection heuristics; chronological failure then verification does not establish causal recovery.");
  notes.add("Open/settled tail is unknown. Shared ancestor citations across branch alternatives represent one incident, not independent observations.");
  // Identity does not include leaf: an unchanged completed window on several
  // descendant branches is one source episode. Divergent suffixes stay separate.
  const identity = events.map((e) => [e.node.identity, e.source, digest(e.text)]);
  return {
    id: digest(["episodes-v1", identity]),
    sessionId: session.sessionId,
    leafId,
    worktreeId: session.worktree.id,
    entryIds,
    activityAt: new Date(at).toISOString(),
    kind,
    outcome,
    excerpts,
    limitations: [...notes].slice(0, 40),
  };
}

/** Branch-local request windows. A lexical correction extends the preceding task
 * rather than severing its motivating failure. Heuristics select, never diagnose. */
export function extractEpisodes(sessions: SessionSnapshot[], options: Pick<CollectSessionOptions, "since" | "intervals" | "signal">, warn: (s: string) => void = () => {}): EvidenceEpisode[] {
  const excluded = excludedIdentities(sessions, options.intervals ?? [], warn);
  const episodes = new Map<string, EvidenceEpisode>();
  let visits = 0;
  for (const session of sessions) {
    throwIfAborted(options.signal);
    const byId = new Map(session.nodes.map((node) => [node.id, node]));
    const parents = new Set(session.nodes.map((node) => node.parentId));
    const leaves = session.nodes.filter((node) => !parents.has(node.id));
    if (leaves.length > SESSION_LIMITS.branches) {
      warn(`[${session.worktree.id}] ${session.sessionId}: branch limit; ${leaves.length - SESSION_LIMITS.branches} alternative leaves omitted.`);
    }
    for (const leaf of leaves.slice(0, SESSION_LIMITS.branches)) {
      throwIfAborted(options.signal);
      const path: SessionNode[] = [];
      for (let node: SessionNode | undefined = leaf; node; node = node.parentId === null ? undefined : byId.get(node.parentId)) {
        if (++visits > SESSION_LIMITS.pathVisits) {
          warn("Conversation path-visit limit reached; remaining branches omitted.");
          return [...episodes.values()];
        }
        path.push(node);
      }
      path.reverse();
      let events: Event[] = [];
      let limitations = new Set<string>();
      let muted = false;
      const calls = new Map<string, Call>();
      const flush = () => {
        const episode = renderEpisode(session, leaf.id, events, limitations, options.since);
        if (episode) {
          const existing = episodes.get(episode.id);
          if (!existing && episodes.size < SESSION_LIMITS.episodes) {
            episodes.set(episode.id, episode);
          } else if (!existing) {
            warn(`[${session.worktree.id}] Episode catalog limit ${SESSION_LIMITS.episodes} reached; eligible windows omitted.`);
          }
        }
        events = [];
        limitations = new Set<string>();
      };
      for (const node of path) {
        throwIfAborted(options.signal);
        const raw = node.raw;
        const phase = markerPhase(raw);
        if (phase === "start") {
          flush();
          muted = true;
          calls.clear();
          continue;
        }
        if (phase === "end") {
          muted = false;
          calls.clear();
          continue;
        }
        const rawMessage = isRecord(raw.message) ? raw.message : undefined;
        const message = historyMessage(rawMessage);
        if (refinerType(raw.customType) || refinerType(rawMessage?.customType)) continue;
        if (excluded.has(node.identity)) {
          flush();
          calls.clear();
          continue;
        }
        const user = raw.type === "message" && message?.role === "user";
        const userText = user ? textContent(message.content) : "";
        if (user && refineRequest.test(userText)) {
          flush();
          muted = true;
          calls.clear();
          continue;
        }
        if (user && userText) {
          muted = false;
          if (events.length && !correction.test(userText)) flush();
        }
        if (muted) continue;
        const added = eventsFor(node, calls, limitations);
        // Memory bound for very long single-task histories. Keep both ends and
        // recent corrections/recovery; truncation is disclosed on the episode.
        events.push(...added);
        if (events.length > 512) {
          events.splice(16, events.length - 256);
          limitations.add("Long task window bounded: middle events omitted; motivating prefix and recent recovery retained.");
        }
      }
      flush();
    }
  }
  return [...episodes.values()].sort((a, b) => a.activityAt.localeCompare(b.activityAt) || a.id.localeCompare(b.id));
}
