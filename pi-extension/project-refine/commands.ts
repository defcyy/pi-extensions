import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseCommand, type CommandOptions } from "./command-options.ts";
import { discoverProject } from "./core/project.ts";
import { inventoryResources } from "./core/resources.ts";
import { collectSessions } from "./core/sessions.ts";
import { RefineStore, sanitizeRun } from "./core/storage.ts";
import { redactText } from "./core/redact.ts";
import {
  abortable, executeReview, piReviewer, prepareReview, ReviewError,
  SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, MAX_REQUEST_BYTES, type ReviewerCall,
} from "./core/reviewer.ts";
import { disclosureReport, runReport, scopeReport } from "./core/report.ts";
import { digest, errorMessage, throwIfAborted } from "./core/util.ts";
import type { ProjectScope, ProjectState, RefineRun, ResourceManifest, SessionCollection } from "./core/types.ts";

export { parseCommand, type CommandOptions } from "./command-options.ts";

export const HELP = `Project Refine — proposals only (Pi >=1.3.0)
/project-refine audit [--since 14d|all]
/project-refine propose [--since 14d|all] [--rereview]
/project-refine review [proposal-id]
/project-refine history
/project-refine reset
/project-refine cancel
Scope options: --root <directory> (required outside Git), --session-root <directory> (repeatable),
--historical-root <previous-worktree-path> (explicit association), --exclude-worktree <path>.
Use quotes around paths containing spaces. All worktrees of this repository are included by default.
Propose requires interactive/RPC preview and explicit provider disclosure consent. No automatic application, commits, installations, or execution trials.`;

export interface CommandDependencies {
  agentDir?: string;
  reviewer?: ReviewerCall;
  now?: () => number;
  output?: (text: string) => void;
}

interface CommandJob {
  signal: AbortSignal;
  lifecycleSignal: AbortSignal;
  assertCurrent(): void;
  isCurrent(): boolean;
}

interface ProposalInput {
  scope: ProjectScope;
  manifest: ResourceManifest;
  collection: SessionCollection;
  state: ProjectState;
  options: CommandOptions;
  store: RefineStore;
  allRoots: string[];
}

function sessionRoots(ctx: ExtensionCommandContext, options: CommandOptions, agentDir: string): string[] {
  const roots = options.sessionRoots.length
    ? options.sessionRoots.map((path) => resolve(ctx.cwd, path))
    : [
      join(agentDir, "sessions"),
      ctx.sessionManager.getSessionDir(),
      ...(process.env.PI_CODING_AGENT_SESSION_DIR ? [resolve(ctx.cwd, process.env.PI_CODING_AGENT_SESSION_DIR)] : []),
    ];
  return [...new Set(roots)];
}

function evidenceScope(scope: ProjectScope, excludedPaths: string[], cwd: string): ProjectScope {
  const excluded = new Set(excludedPaths.map((path) => resolve(cwd, path)));
  const selected = {
    ...scope,
    worktrees: scope.worktrees.filter((tree) => !excluded.has(tree.root)),
    warnings: [...scope.warnings, ...[...excluded].map((path) => `Worktree excluded by user: ${path}`)],
  };
  if (!selected.worktrees.length) throw new Error("No worktrees remain in the selected evidence scope.");
  return selected;
}

export function registerCommands(pi: ExtensionAPI, dependencies: CommandDependencies = {}): void {
  let active: AbortController | undefined;
  let lifetime: AbortController | undefined;
  let generation = 0;

  const invalidate = (): void => {
    generation++;
    active?.abort(new Error("Parent session ended; refinement cancelled."));
    lifetime?.abort(new Error("Parent runtime changed; private result publication cancelled."));
  };
  pi.on("session_shutdown", invalidate);
  pi.on("session_start", invalidate);

  async function display(ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
    const safe = redactText(body).text;
    if (ctx.hasUI) {
      await ctx.ui.editor(`${title} (display only; edits ignored)`, safe);
    } else {
      (dependencies.output ?? console.log)(safe);
    }
  }

  async function showHelp(ctx: ExtensionCommandContext, args: string): Promise<void> {
    if (args.trim() || !ctx.hasUI) {
      await display(ctx, "Project Refine", HELP);
      return;
    }
    const choice = await ctx.ui.select("Project Refine — no project writes", ["Audit", "Propose", "Review", "History", "Help"]);
    if (!choice || choice === "Help") {
      await display(ctx, "Project Refine", HELP);
      return;
    }
    // Put the next command in the editor, rather than recursively invoking handlers.
    ctx.ui.setEditorText(`/project-refine ${choice.toLowerCase()}`);
  }

  async function showHistory(ctx: ExtensionCommandContext, store: RefineStore, state: ProjectState): Promise<void> {
    const runs = await store.listRuns();
    const lines = [
      "# Project Refine history",
      ...runs.map((run) => `- ${run.startedAt} · ${run.status} · ${run.id} · ${run.proposals.length} proposals · ${run.coverage.selectedEpisodes} episodes`),
      "",
      "Decisions (acceptance is not application):",
      ...state.decisions.map((decision) => `- ${decision.at} · ${decision.proposalId} · ${decision.decision}`),
      "",
      "Redacted reports expire after 30 days on subsequent mutations; compact coverage/decisions remain until reset.",
    ];
    await display(ctx, "Project Refine history", lines.join("\n"));
  }

  async function reviewStored(ctx: ExtensionCommandContext, store: RefineStore, options: CommandOptions, job: CommandJob): Promise<void> {
    const runs = (await store.listRuns()).filter((run) => run.status === "success");
    const proposals = runs.flatMap((run) => run.proposals.map((proposal) => ({ run, proposal })));
    let selected = options.id ? proposals.find((item) => item.proposal.id === options.id) : undefined;
    if (options.id && !selected) throw new Error("Proposal not found in retained reports.");

    if (!selected && ctx.hasUI && proposals.length) {
      const labels = proposals.map((item, index) => `${index + 1}. ${item.proposal.problem.slice(0, 100)} [${item.proposal.id.slice(0, 8)}]`);
      const choice = await ctx.ui.select("Review proposal (no project writes)", labels, { signal: job.signal });
      selected = choice ? proposals[labels.indexOf(choice)] : undefined;
    }
    if (!selected) {
      const body = proposals.length
        ? proposals.map((item) => `${item.proposal.id} ${item.proposal.problem}`).join("\n")
        : "No retained proposals. Run /project-refine propose.";
      await display(ctx, "Project Refine review", body);
      return;
    }

    await display(ctx, "Review — not applied", runReport({ ...selected.run, proposals: [selected.proposal] }));
    job.assertCurrent();
    if (!ctx.hasUI) return;
    const choice = await ctx.ui.select("Record a decision — no files will be applied", ["Accept", "Reject", "Defer"], { signal: job.signal });
    if (!choice) return;
    job.assertCurrent();

    // UI results are strings, not a reason to assert an unchecked union.
    let decision: "accepted" | "rejected" | "deferred";
    switch (choice) {
      case "Accept":
        decision = "accepted";
        break;
      case "Reject":
        decision = "rejected";
        break;
      case "Defer":
        decision = "deferred";
        break;
      default:
        return;
    }
    await store.decide(selected.proposal.id, decision);
    if (job.isCurrent()) ctx.ui.notify(`Decision recorded: ${decision}. Project files unchanged.`, "info");
  }

  async function propose(ctx: ExtensionCommandContext, input: ProposalInput, job: CommandJob): Promise<void> {
    const { scope, manifest, collection, state, options, store, allRoots } = input;
    const model = ctx.model;
    if (!model || typeof ctx.modelRegistry.streamSimple !== "function") {
      throw new Error("Project Refine requires Pi >=1.3.0 and an active configured model.");
    }
    const modelLabel = `${model.provider}/${model.id}`;
    // Capture the reviewer/provider before dialogs; ctx.model is a live getter.
    const reviewer = dependencies.reviewer ?? piReviewer(ctx, model);
    const maxBytes = Math.min(MAX_REQUEST_BYTES, Math.max(0, model.contextWindow - MAX_OUTPUT_TOKENS - 2048));
    if (maxBytes < 8000) {
      throw new Error("Selected model has insufficient context for bounded refinement; choose a larger-context model.");
    }
    const prepared = prepareReview(scope, manifest, collection, state, modelLabel, { rereview: options.rereview, maxRequestBytes: maxBytes });
    if (!prepared.payload.episodes.length) {
      await display(ctx, "No model call made", `${scopeReport(scope, manifest, collection)}\n\nNo uncovered evidence fits the current budget/date range. Use --since all, --rereview, or narrow resource scope. Coverage has not advanced.`);
      return;
    }

    // Do not redact the serialized JSON again: that changes escaped strings and
    // breaks the exact-preview contract. Its text values were sanitized in prepareReview.
    const preview = [
      redactText(scopeReport(scope, manifest, collection)).text,
      disclosureReport(prepared, redactText(modelLabel).text),
      `# Reviewer system instructions\n${SYSTEM_PROMPT}`,
    ].join("\n\n");
    const viewed = await ctx.ui.editor("Provider disclosure preview (edits ignored; Esc cancels)", preview);
    if (viewed === undefined) return;
    job.assertCurrent();
    const payloadDigest = digest(prepared.serialized);
    const authorized = await ctx.ui.confirm("Send this redacted evidence to the configured provider?", [
      redactText(modelLabel).text,
      `${prepared.payload.episodes.length} episodes across selected project worktrees; ${prepared.omittedEpisodes} uncovered episodes omitted.`,
      `Best-effort redaction (${prepared.redactions} replacements), not a secrecy guarantee.`,
      `Payload digest: ${payloadDigest}`,
      `At most one 90-second call, ${MAX_OUTPUT_TOKENS} output tokens. Acceptance never applies files.`,
    ].join("\n"), { signal: job.signal });
    if (!authorized) return;
    job.assertCurrent();

    let run: RefineRun = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId: scope.id,
      targetRoot: scope.root,
      startedAt: new Date().toISOString(),
      status: "failed",
      model: modelLabel,
      contextDigest: prepared.contextDigest,
      analyzedEpisodeIds: [],
      coverage: {
        filesScanned: collection.filesScanned,
        matchedSessions: collection.matchedSessions,
        eligibleEpisodes: prepared.eligibleEpisodes,
        selectedEpisodes: prepared.payload.episodes.length,
        omittedEpisodes: prepared.omittedEpisodes,
        perWorktree: collection.perWorktree,
      },
      warnings: [...prepared.warnings, `Request payload SHA-256: ${payloadDigest}`, "Reviewer: one bounded call; no execution/behavioral evaluation."],
      proposals: [],
      usage: [],
    };
    ctx.ui.setStatus("project-refine", "Reviewing bounded project evidence… (/project-refine cancel)");
    try {
      const result = await executeReview(prepared, scope, reviewer, job.signal);
      job.assertCurrent();
      const decisions = new Map(state.decisions
        .filter((decision) => decision.contextDigest === prepared.contextDigest)
        .map((decision) => [decision.fingerprint, decision.decision]));
      const proposals = options.rereview
        ? result.proposals
        : result.proposals.filter((proposal) => decisions.get(proposal.fingerprint) !== "rejected");
      run = {
        ...run,
        status: "success",
        analyzedEpisodeIds: prepared.payload.episodes.map((episode) => episode.id),
        proposals,
        usage: result.usage,
      };
      if (proposals.length !== result.proposals.length) {
        run.warnings.push("Previously rejected unchanged lessons suppressed; --rereview can reconsider them.");
      }
    } catch (error) {
      // Never persist raw provider errors: they can contain credentials or payloads.
      run = {
        ...run,
        status: job.signal.aborted ? "aborted" : "failed",
        error: "Review failed, was cancelled, timed out, or returned invalid/unsafe proposals. No coverage advanced.",
        usage: error instanceof ReviewError ? error.usage : [],
      };
    }
    run.finishedAt = new Date().toISOString();

    // User cancellation may record an aborted attempt. Runtime replacement must
    // discard every late result, including failures, without publishing anything.
    if (!job.isCurrent()) return;
    const safeRun = sanitizeRun(run);
    const publicationSignal = safeRun.status === "success"
      ? AbortSignal.any([job.signal, job.lifecycleSignal])
      : job.lifecycleSignal;
    await abortable(store.saveRun(safeRun, runReport(safeRun), { signal: publicationSignal }), publicationSignal);
    if (!job.isCurrent()) return;
    await store.rememberRoots(allRoots);
    if (!job.isCurrent()) return;
    ctx.ui.notify(`Project Refine ${safeRun.status}: ${safeRun.proposals.length} proposals. Report: ${store.reportPath(run.id)}`,
      safeRun.status === "success" ? "info" : "warning");
    await display(ctx, "Project Refine report", runReport(safeRun));
  }

  pi.registerCommand("project-refine", {
    description: "Reflect on this repository's Pi sessions across worktrees; review proposals without applying files",
    handler: async (args, ctx) => {
      const commandGeneration = generation;
      let owned: AbortController | undefined;
      try {
        const options = parseCommand(args, dependencies.now?.() ?? Date.now());
        if (options.action === "cancel") {
          active?.abort(new Error("Refinement cancelled by user."));
          ctx.ui.notify("Cancellation requested.", "info");
          return;
        }
        if (options.action === "help") {
          await showHelp(ctx, args);
          return;
        }
        if (active) throw new Error("A Project Refine command is already running. Use /project-refine cancel first.");
        if (!ctx.isProjectTrusted()) {
          throw new Error("Project Refine requires a trusted project; trust does not grant provider-disclosure consent.");
        }
        if (options.action === "propose" && !ctx.hasUI) {
          throw new Error("Propose requires a disclosure preview and interactive/RPC consent. No model call made. Use audit for noninteractive inventory.");
        }

        active = owned = new AbortController();
        const lifecycle = lifetime = new AbortController();
        const sessionId = ctx.sessionManager.getSessionId();
        const isCurrent = (): boolean => commandGeneration === generation && ctx.sessionManager.getSessionId() === sessionId;
        const signal = owned.signal;
        const job: CommandJob = {
          signal,
          lifecycleSignal: lifecycle.signal,
          isCurrent,
          assertCurrent() {
            throwIfAborted(signal);
            if (!isCurrent()) throw new Error("Session changed; refinement result discarded.");
          },
        };
        await abortable(ctx.waitForIdle(), job.signal);
        job.assertCurrent();

        const agentDir = dependencies.agentDir ?? getAgentDir();
        const root = options.root ? resolve(ctx.cwd, options.root) : undefined;
        let project = await discoverProject(ctx.cwd, { root, signal: job.signal });
        const store = new RefineStore(agentDir, project.id);
        // Reset must remain available when private JSON is corrupt.
        if (options.action === "reset") {
          if (!ctx.hasUI) return;
          const confirmed = await ctx.ui.confirm("Delete Project Refine private data?",
            "Deletes this repository's reports, coverage, history and decisions only. No project/source sessions are changed.",
            { signal: job.signal });
          if (!confirmed) return;
          job.assertCurrent();
          await store.reset();
          if (job.isCurrent()) ctx.ui.notify("Project Refine private data reset.", "info");
          return;
        }

        const state = await store.loadState();
        job.assertCurrent();
        if (options.action === "history") {
          await showHistory(ctx, store, state);
          return;
        }
        if (options.action === "review") {
          await reviewStored(ctx, store, options, job);
          return;
        }

        const historicalRoots = [...new Set([
          ...state.historicalRoots,
          ...options.historicalRoots.map((path) => resolve(ctx.cwd, path)),
        ])];
        if (historicalRoots.length) {
          project = await discoverProject(ctx.cwd, { root, historicalRoots, signal: job.signal });
        }
        const allRoots = project.worktrees.map((tree) => tree.root);
        const scope = evidenceScope(project, options.excludedWorktrees, ctx.cwd);
        // Target verification uses the full project; exclusions affect evidence only.
        const manifest = await inventoryResources(project, job.signal);
        const collection = await collectSessions(scope, {
          sessionRoots: sessionRoots(ctx, options, agentDir),
          since: options.since,
          currentSessionId: sessionId,
          currentEntryId: ctx.sessionManager.getLeafId(),
          intervals: state.intervals,
          signal: job.signal,
        });
        job.assertCurrent();
        if (options.action === "audit") {
          await store.rememberRoots(allRoots);
          if (job.isCurrent()) await display(ctx, "Project Refine audit", scopeReport(scope, manifest, collection));
          return;
        }
        await propose(ctx, { scope, manifest, collection, state, options, store, allRoots }, job);
      } catch (error) {
        if (commandGeneration !== generation) return;
        const text = redactText(errorMessage(error)).text;
        if (ctx.hasUI) ctx.ui.notify(text, "error");
        else (dependencies.output ?? console.log)(text);
      } finally {
        if (owned && active === owned) {
          active = undefined;
          lifetime = undefined;
          try {
            ctx.ui.setStatus("project-refine", undefined);
          } catch {
            // Runtime may already have shut down.
          }
        }
      }
    },
  });
}
