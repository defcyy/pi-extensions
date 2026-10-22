import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProjectScope, SessionCollection, Worktree } from "./types.ts";
import { attributeCwd } from "./project.ts";
import { digest, errorMessage, isRecord, throwIfAborted } from "./util.ts";
import { extractEpisodes } from "./episodes.ts";
import { historyMessage, SESSION_LIMITS, supportedSessionVersion } from "./history.ts";
import type { CollectSessionOptions, RawEntry, SessionHeader, SessionNode, SessionSnapshot } from "./history.ts";

// Preserve the original import surface without a runtime episodes -> sessions edge.
export { SESSION_LIMITS } from "./history.ts";
export type { CollectSessionOptions, RawEntry, SessionNode, SessionSnapshot } from "./history.ts";

// Independent of SessionManager: its open/resume paths can migrate files on disk.
// Pi 1.3's exported migration also assigns random v1 IDs; these deterministic,
// snapshot-local legacy IDs are intentionally NOT represented as native Pi IDs.
function headerOf(line: string, checkVersion = true): SessionHeader {
  const header: unknown = JSON.parse(line);
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string" || !header.id ||
      typeof header.cwd !== "string" || !header.cwd) {
    throw new Error("invalid session header");
  }
  if (checkVersion && !supportedSessionVersion(header.version)) {
    throw new Error(`unsupported session version ${String(header.version)}`);
  }
  return { ...header, type: "session", id: header.id, cwd: header.cwd };
}

function stable(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("nested fork metadata exceeds comparison depth");
  if (Array.isArray(value)) {
    return `[${value.map((part: unknown) => stable(part, depth + 1)).join(",")}]`;
  }
  if (isRecord(value)) {
    const fields = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`);
    return `{${fields.join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("unsupported fork metadata");
  return serialized;
}

/** Explicit, strict v1-v3 adapter. Never skips corrupt complete lines or repairs a
 * broken graph into a plausible conversation. v1 gets a deterministic linear graph. */
export function parseSessionSnapshot(text: string, file: string, worktree: Worktree): SessionSnapshot {
  if (!text.endsWith("\n")) throw new Error("snapshot must end at a complete-line boundary");
  const lines = text.split("\n");
  const header = headerOf(lines[0]);
  const version = header.version ?? 1;
  const nodes: SessionNode[] = [];
  const ids = new Set<string>();
  const limitations = [
    "Raw historical evidence, not a reconstruction of model-visible context or historical resource contents.",
    "Final active branch and settled state are unknown; leaves are alternatives, not independent successes.",
    "Thinking, images, system/custom bodies and arbitrary structured tool details are omitted; skill absence cannot be inferred.",
    "Refinement exclusions cover supplied ledger intervals, recognized markers and command windows only; unidentified external generated content may remain.",
  ];
  if (version === 1) limitations.push("Legacy v1 citations use deterministic synthetic line IDs, not native Pi entry IDs.");
  const knownTypes = new Set(["message", "model_change", "thinking_level_change", "usage", "compaction", "context_edit", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  const knownRoles = new Set(["system", "user", "assistant", "toolResult", "bashExecution", "custom", "hookMessage", "branchSummary", "compactionSummary"]);
  let invalidTimes = 0;
  let unsupportedEntries = 0;
  for (let i = 1; i < lines.length - 1; i++) {
    if (!lines[i].trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]);
    } catch {
      throw new Error(`malformed complete JSON line ${i + 1}`);
    }
    if (!isRecord(raw) || typeof raw.type !== "string" || raw.type === "session") {
      throw new Error(`invalid entry at line ${i + 1}`);
    }
    if (nodes.length >= SESSION_LIMITS.nodes) {
      limitations.push(`Node limit ${SESSION_LIMITS.nodes} reached; remaining complete lines were not parsed.`);
      break;
    }
    const id = version === 1 ? `legacy-line-${i + 1}` : raw.id;
    const parentId = version === 1 ? (nodes.at(-1)?.id ?? null) : raw.parentId;
    if (typeof id !== "string" || !id || !(parentId === null || typeof parentId === "string")) {
      throw new Error(`invalid graph fields at line ${i + 1}`);
    }
    if (ids.has(id)) throw new Error(`duplicate entry ID ${id}`);
    // Pi writes parents before children. Reject forward edges as well as cycles.
    if (parentId !== null && !ids.has(parentId)) throw new Error(`orphan/forward parent ${parentId} at ${id}`);
    const rawMessage = isRecord(raw.message) ? raw.message : undefined;
    const message = historyMessage(rawMessage);
    if (raw.type === "message" && !message) throw new Error(`invalid message at ${id}`);
    if (!knownTypes.has(raw.type) || (raw.type === "message" && message && !knownRoles.has(message.role))) {
      unsupportedEntries++;
    }
    const normalized: RawEntry = { ...raw, id, parentId };
    if (version !== 3 && raw.type === "message" && message?.role === "hookMessage") {
      normalized.message = { ...message, role: "custom" };
    }
    let at = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
    if (!Number.isFinite(at) && typeof rawMessage?.timestamp === "number") at = rawMessage.timestamp;
    if (Math.abs(at) > 8.64e15) at = NaN;
    if (!Number.isFinite(at)) invalidTimes++;
    nodes.push({
      id,
      parentId,
      timestamp: Number.isFinite(at) ? new Date(at).toISOString() : "",
      raw: normalized,
      citation: `${encodeURIComponent(header.id)}:${encodeURIComponent(id)}`,
      identity: digest([header.id, id]),
    });
    ids.add(id);
  }
  if (invalidTimes) limitations.push(`${invalidTimes} entries have no valid activity timestamp; they cannot establish date eligibility.`);
  if (unsupportedEntries) limitations.push(`${unsupportedEntries} unsupported entry types/roles omitted from evidence; graph linkage preserved only.`);
  if (nodes.some((node) => node.raw.type === "compaction")) limitations.push("Compaction present: earlier raw evidence was not necessarily visible after compaction; summaries are claims, not observations.");
  if (nodes.some((node) => node.raw.type === "context_edit")) limitations.push("Context edits present: original raw entries are retained here, but may have been replaced/omitted from later model context. No visibility/compliance inference is supported.");
  if (nodes.some((node) => node.raw.type === "message" && historyMessage(node.raw.message)?.role === "system")) limitations.push("System prompt/tool deltas are not replayed; historical instruction/tool availability is unknown.");
  return {
    sessionId: header.id,
    file,
    header,
    worktree,
    nodes,
    digest: digest(text),
    bytes: Buffer.byteLength(text),
    limitations: [...new Set(limitations)].slice(0, 32),
  };
}

async function readHeader(file: string, signal?: AbortSignal): Promise<SessionHeader> {
  // A cataloged regular file can be replaced with a FIFO before open().
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular session file");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < SESSION_LIMITS.headerBytes) {
      throwIfAborted(signal);
      const buffer = Buffer.alloc(Math.min(1024, SESSION_LIMITS.headerBytes - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
      if (!bytesRead) break;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
      if (end >= 0) return headerOf(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), false);
      length += bytesRead;
    }
    throw new Error("missing complete header or header byte limit reached");
  } finally {
    await handle.close();
  }
}

async function snapshot(file: string, budget: number, charge: (bytes: number) => void, signal?: AbortSignal): Promise<{ text: string; bytes: number; warnings: string[] }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular session file");
    const size = Math.min(before.size, SESSION_LIMITS.snapshotBytes, budget);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      throwIfAborted(signal);
      const result = await handle.read(buffer, read, Math.min(64 * 1024, size - read), read);
      if (!result.bytesRead) break;
      charge(result.bytesRead); // Failed/mutating/invalid snapshots also consume the I/O budget.
      read += result.bytesRead;
    }
    const after = await handle.stat();
    if (read !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("source changed during snapshot; skipped rather than claiming a consistent view");
    }
    const cutoff = buffer.lastIndexOf(10);
    if (cutoff < 0) throw new Error("no complete lines within snapshot budget");
    const warnings: string[] = [];
    if (before.size > size) warnings.push(`Snapshot byte budget reached (${size}/${before.size}); later activity unexamined.`);
    if (cutoff + 1 < size) warnings.push("Incomplete/torn or bounded final line omitted; only complete lines included.");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, cutoff + 1)), bytes: size, warnings };
  } finally {
    await handle.close();
  }
}

/** Catalog reads only bounded first lines before cwd attribution. No symlink
 * entries are followed; configured roots containing symlink components are rejected. */
export async function collectSessions(scope: ProjectScope, options: CollectSessionOptions): Promise<SessionCollection> {
  throwIfAborted(options.signal);
  const result: SessionCollection = {
    episodes: [],
    filesScanned: 0,
    matchedSessions: 0,
    warnings: [],
    perWorktree: Object.fromEntries(scope.worktrees.map((worktree) => [worktree.id, { sessions: 0, episodes: 0 }])),
  };
  let omittedWarnings = 0;
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    if (result.warnings.length < 255) {
      result.warnings.push(message);
      warned.add(message);
    } else {
      omittedWarnings++;
    }
  };
  const files = new Set<string>();
  const seenDirs = new Set<string>();
  let entries = 0;
  let bounded = false;
  async function walk(directory: string, depth: number): Promise<void> {
    throwIfAborted(options.signal);
    if (seenDirs.has(directory)) return;
    if (depth > SESSION_LIMITS.depth || seenDirs.size >= SESSION_LIMITS.directories ||
        entries >= SESSION_LIMITS.directoryEntries || files.size >= SESSION_LIMITS.files) {
      bounded = true;
      return;
    }
    seenDirs.add(directory);
    try {
      if (!(await lstat(directory)).isDirectory()) {
        warn(`${directory}: not a directory (symlinks unsupported)`);
        return;
      }
      const dir = await opendir(directory);
      for await (const item of dir) {
        throwIfAborted(options.signal);
        if (++entries > SESSION_LIMITS.directoryEntries || files.size >= SESSION_LIMITS.files) {
          bounded = true;
          break;
        }
        const path = join(directory, item.name);
        if (item.isSymbolicLink()) {
          warn(`${path}: symlink skipped`);
          continue;
        }
        if (item.isDirectory()) {
          await walk(path, depth + 1);
        } else if (item.isFile() && item.name.endsWith(".jsonl")) {
          files.add(path);
        }
      }
    } catch (error) {
      throwIfAborted(options.signal);
      warn(`${directory}: unreadable catalog (${errorMessage(error)})`);
    }
  }
  if (options.sessionRoots.length > SESSION_LIMITS.roots) warn(`Session root limit ${SESSION_LIMITS.roots} reached; remaining configured stores omitted.`);
  for (const root of [...new Set(options.sessionRoots.slice(0, SESSION_LIMITS.roots).map((root) => resolve(root)))].sort()) {
    try {
      if (await realpath(root) !== root) {
        warn(`${root}: symlinked session root skipped`);
        continue;
      }
      await walk(root, 0);
    } catch (error) {
      throwIfAborted(options.signal);
      warn(`${root}: unavailable session store (${errorMessage(error)})`);
    }
  }
  if (bounded) warn("Session catalog traversal limit reached (depth/directories/entries/files); coverage is incomplete.");
  if (!options.sessionRoots.length) warn("No session stores supplied; no history was scanned.");
  const sessions: SessionSnapshot[] = [];
  let bytes = 0;
  let nodes = 0;
  for (const file of [...files].sort()) {
    throwIfAborted(options.signal);
    result.filesScanned++;
    let worktree: Worktree | undefined;
    try {
      if (await realpath(file) !== file) throw new Error("symlinked session path skipped");
      const header = await readHeader(file, options.signal);
      worktree = await attributeCwd(scope, header.cwd, options.signal);
      if (!supportedSessionVersion(header.version)) throw new Error(`unsupported session version ${String(header.version)}`);
      if (!worktree) continue; // Never read unrelated transcript bodies.
      const prefix = `[${worktree.id}] ${file}`;
      if (bytes >= SESSION_LIMITS.totalBytes || nodes >= SESSION_LIMITS.totalNodes) {
        warn(`${prefix}: aggregate snapshot/node limit; session omitted`);
        continue;
      }
      const view = await snapshot(file, SESSION_LIMITS.totalBytes - bytes, (read) => {
        bytes += read;
      }, options.signal);
      const parsed = parseSessionSnapshot(view.text, file, worktree);
      if (parsed.header.id !== header.id || parsed.header.cwd !== header.cwd || parsed.header.version !== header.version) {
        throw new Error("header changed after attribution");
      }
      parsed.limitations.push(...view.warnings);
      const diagnostics = parsed.limitations.filter((message) => /limit|timestamp|unsupported/.test(message));
      for (const message of [...view.warnings, ...diagnostics]) {
        warn(`${prefix}: ${message}`);
      }
      if (nodes + parsed.nodes.length > SESSION_LIMITS.totalNodes) {
        warn(`${prefix}: aggregate node limit; session omitted`);
        continue;
      }
      nodes += parsed.nodes.length;
      if (parsed.sessionId === options.currentSessionId) {
        if (options.currentEntryId === undefined) {
          warn(`${prefix}: current-session cutoff missing; omitted for safety`);
          continue;
        }
        if (options.currentEntryId === null) {
          parsed.nodes = [];
        } else {
          const cutoff = parsed.nodes.findIndex((node) => node.id === options.currentEntryId);
          if (cutoff < 0) {
            warn(`${prefix}: current-session cutoff not found; omitted for safety`);
            continue;
          }
          parsed.nodes = parsed.nodes.slice(0, cutoff + 1);
        }
        parsed.limitations.push("Current session frozen at supplied entry boundary; later entries excluded.");
      }
      sessions.push(parsed);
    } catch (error) {
      throwIfAborted(options.signal);
      warn(`${worktree ? `[${worktree.id}] ` : ""}${file}: unsupported/corrupt/unreadable session (${errorMessage(error)})`);
    }
  }
  // A session ID is the external citation namespace. Conflicting copies cannot
  // safely share it. Byte-identical copies are catalog duplicates, not incidents.
  const byId = new Map<string, SessionSnapshot[]>();
  for (const session of sessions) byId.set(session.sessionId, [...(byId.get(session.sessionId) ?? []), session]);
  const usable: SessionSnapshot[] = [];
  for (const [id, copies] of byId) {
    if (new Set(copies.map((session) => session.digest)).size > 1) {
      warn(`Session ID ${id} has conflicting files; all copies omitted to avoid ambiguous citations.`);
      continue;
    }
    usable.push(copies[0]);
    if (copies.length > 1) warn(`Session ${id}: ${copies.length - 1} byte-identical duplicate files omitted.`);
  }
  deduplicateForkPrefixes(usable, warn);
  for (const session of usable) {
    result.matchedSessions++;
    (result.perWorktree[session.worktree.id] ??= { sessions: 0, episodes: 0 }).sessions++;
  }
  result.episodes = extractEpisodes(usable, options, warn);
  for (const episode of result.episodes) result.perWorktree[episode.worktreeId].episodes++;
  warn("Coverage counts reflect retained eligible episodes, not analyzed history. Missing/pruned unassociated worktrees and unsupported/corrupt stores cannot be recovered. No model-visible context replay is claimed.");
  if (omittedWarnings) result.warnings.push(`Diagnostic limit reached; ${omittedWarnings} additional warnings omitted.`);
  return result;
}

function deduplicateForkPrefixes(sessions: SessionSnapshot[], warn: (message: string) => void): void {
  const byFile = new Map(sessions.map((s) => [resolve(s.file), s]));
  const done = new Set<SessionSnapshot>();
  const visiting = new Set<SessionSnapshot>();
  const unverified = new Set<SessionSnapshot>();
  function visit(session: SessionSnapshot): void {
    if (done.has(session)) return;
    if (visiting.has(session) || visiting.size >= 128) {
      for (const ancestor of visiting) unverified.add(ancestor);
      unverified.add(session);
      warn(`Session ${session.sessionId}: cyclic/overdeep fork metadata; not used for deduplication.`);
      return;
    }
    visiting.add(session);
    const reference = session.header.parentSession;
    const parent = typeof reference === "string" ? byFile.get(resolve(dirname(session.file), reference)) : undefined;
    if (parent) visit(parent);
    if (parent && !unverified.has(parent) && !unverified.has(session)) {
      let copied = 0;
      for (let i = 0; i < Math.min(session.nodes.length, parent.nodes.length); i++) {
        const node = session.nodes[i];
        const original = parent.nodes[i];
        try {
          if (stable(node.raw) !== stable(original.raw)) break;
        } catch {
          session.limitations.push("Deep nested metadata prevented safe fork-prefix comparison; remaining prefix not deduplicated.");
          break;
        }
        node.citation = original.citation;
        node.identity = original.identity;
        copied++;
      }
      if (copied) {
        session.limitations.push(`Verified ${copied} exactly copied prefix entries from related parent session; shared citations count one incident.`);
      } else {
        session.limitations.push("Declared parent session has no verified copied prefix; no fork deduplication applied.");
      }
    } else if (reference) {
      if (parent && unverified.has(parent)) unverified.add(session);
      session.limitations.push("Parent fork source unavailable/unverified; equal text is not deduplicated across unrelated sources.");
    }
    visiting.delete(session);
    done.add(session);
  }
  for (const session of sessions) visit(session);
}
