import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  closePane,
  focusAgent,
  getAgent,
  getCurrentLayout,
  isHerdrTimeout,
  listAgents,
  promptAgent,
  readAgent,
  sendAgentKeys,
  splitPane,
  startPiAgent,
  waitAgent,
  HerdrIdentityError,
  type HerdrAgent,
} from "./herdr.ts";
import {
  agentDisplayName,
  canCloseOwnedPane,
  chooseSplitDirection,
  chooseSplitParent,
  completionBatchDelay,
  findReusableAgents,
  isReusableAgent,
  makeTaskAgentName,
  requestedLaunchOverrides,
  resolveModelSelection,
} from "./policy.ts";
import {
  findAssistantTextAfter,
  getSessionCursor,
  truncateUtf8,
  type SessionCursor,
} from "./session.ts";

const ReuseMode = StringEnum(["auto", "never", "require"] as const, {
  description:
    "auto reuses one matching idle Herdr agent or creates a Pi agent; never always creates; require fails unless one exists. Default: never.",
});
const RetentionMode = StringEnum(["one-shot", "interactive"] as const, {
  description:
    "For newly created agents: one-shot closes its pane after success; interactive leaves it open. Existing panes are always left open. Default: one-shot.",
});
const Direction = StringEnum(["auto", "right", "down"] as const, {
  description: "Direction for a new split. Default: auto based on current pane geometry.",
});
const ThinkingLevel = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  { description: "Thinking-level override for a newly created Pi agent" },
);

const DispatchParams = Type.Object({
  task: Type.String({ minLength: 1, description: "Task to send to the Herdr agent" }),
  target: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Existing Herdr agent name or pane ID. When set, the extension never creates a replacement pane.",
    }),
  ),
  reuse: Type.Optional(ReuseMode),
  retention: Type.Optional(RetentionMode),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Working directory. Defaults to the parent Pi working directory.",
    }),
  ),
  direction: Type.Optional(Direction),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Available Pi model as provider/model (or an unambiguous model ID). When omitted, a new agent inherits the parent's selected model. An explicit model forces creation of a new agent.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevel),
  tools: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Comma-separated Pi tool allowlist for a newly created agent",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      minLength: 1,
      description: "System prompt appended only when starting a new Pi agent",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 5_000,
      maximum: 3_600_000,
      description:
        "Initial wait timeout in milliseconds. The extension continues supervising a child that exceeds it. Default: 600000 (10 minutes).",
    }),
  ),
});

const ControlAction = StringEnum(["interrupt", "detach", "close", "focus"] as const, {
  description:
    "interrupt sends Ctrl-C; detach stops supervision but leaves the pane; close is allowed only for extension-owned panes; focus opens the pane.",
});
const ControlParams = Type.Object({
  jobId: Type.Optional(
    Type.String({ minLength: 1, description: "Job ID returned by herdr_subagent" }),
  ),
  action: Type.Optional(ControlAction),
});
type ControlInput = Static<typeof ControlParams>;
interface ControlDetails {
  jobs: unknown[];
  jobId: string | null;
  action: string | null;
  paneId: string | null;
}

type DispatchInput = Static<typeof DispatchParams>;
type JobState =
  | "starting"
  | "working"
  | "timed-out"
  | "blocked"
  | "interrupting"
  | "closing"
  | "completed"
  | "detached"
  | "failed";
type CompletionStatus = "completed" | "completed-with-warning" | "blocked" | "timed-out" | "failed";

interface RunningJob {
  id: string;
  task: string;
  target: string;
  expectedName?: string;
  displayName: string;
  paneId: string;
  created: boolean;
  retention: "one-shot" | "interactive";
  state: JobState;
  startedAt: number;
  parentSessionId: string;
  controller: AbortController;
  sessionFile?: string;
  sessionCursor: SessionCursor;
  model?: string;
}

interface DispatchTarget {
  paneId: string;
  target: string;
  expectedName?: string;
  displayName: string;
  created: boolean;
}

interface PendingCompletion {
  pi: ExtensionAPI;
  parentSessionId: string;
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
}

interface RecentJob {
  id: string;
  displayName: string;
  paneId: string;
  state: JobState;
  elapsed: string;
}

const MAX_CONCURRENT_JOBS = 4;
const FENCED_PI_BIN_DIR = resolve(fileURLToPath(new URL("./fenced-bin/", import.meta.url)));
const FENCED_PI_SHIM = resolve(FENCED_PI_BIN_DIR, "pi");
const runningJobs = new Map<string, RunningJob>();
const reservedPanes = new Set<string>();
const pendingCompletions: PendingCompletion[] = [];
const recentJobs: RecentJob[] = [];
const ownedSplitAnchors: string[] = [];
const closeAttempts = new Map<string, Promise<boolean>>();
let pendingDispatches = 0;
let latestCtx: ExtensionContext | null = null;
let activeSessionId: string | null = null;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let mutationTail: Promise<void> = Promise.resolve();

async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function assertHerdrRuntime(): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error(
      "Herdr subagents require Pi to run inside a Herdr-managed pane (HERDR_ENV=1).",
    );
  }
  if (!process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) {
    throw new Error("Herdr did not provide HERDR_PANE_ID and HERDR_WORKSPACE_ID.");
  }
}

function assertNonBlankDispatch(params: DispatchInput): void {
  const values: Array<[string, string | undefined]> = [
    ["task", params.task],
    ["target", params.target],
    ["cwd", params.cwd],
    ["model", params.model],
    ["tools", params.tools],
    ["systemPrompt", params.systemPrompt],
  ];
  for (const [name, value] of values) {
    if (value !== undefined && value.trim().length === 0) {
      throw new Error(`${name} cannot be empty or whitespace.`);
    }
  }
}

function removeSplitAnchor(paneId: string): void {
  const index = ownedSplitAnchors.indexOf(paneId);
  if (index >= 0) ownedSplitAnchors.splice(index, 1);
}

async function freshPaneEnvironment(): Promise<Record<string, string> | undefined> {
  if (process.env.FENCE_SANDBOX !== "1") return undefined;
  try {
    await access(FENCED_PI_SHIM, constants.X_OK);
  } catch {
    throw new Error(`The bundled fenced Pi launcher is missing or not executable: ${FENCED_PI_SHIM}`);
  }
  return {
    PATH: `${FENCED_PI_BIN_DIR}:${process.env.PATH ?? ""}`,
  };
}

async function discardSelectedTarget(selected: DispatchTarget): Promise<void> {
  reservedPanes.delete(selected.paneId);
  if (!selected.created) return;
  removeSplitAnchor(selected.paneId);
  try {
    await withMutationLock(() => closePane(selected.paneId, { timeoutMs: 5_000 }));
  } catch (error) {
    console.error("[herdr-subagents] failed to clean up cancelled dispatch", error);
  }
}

function formatAgentLine(agent: HerdrAgent): string {
  const name = agent.name ? `${agent.name} ` : "";
  const current = agent.pane_id === process.env.HERDR_PANE_ID ? " · current" : "";
  const cwd = agent.foreground_cwd ?? agent.cwd ?? "unknown cwd";
  return `• ${name}[${agent.pane_id}] ${agent.agent ?? "unknown"} · ${agent.agent_status} · ${agent.workspace_id}/${agent.tab_id} · ${cwd}${current}`;
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function updateWidget(): void {
  try {
    if (!latestCtx?.hasUI) return;
    if (runningJobs.size === 0) {
      latestCtx.ui.setWidget("herdr-subagents", undefined);
      return;
    }

    latestCtx.ui.setWidget(
      "herdr-subagents",
      (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          const lines = [
            theme.fg("accent", theme.bold(`Herdr subagents — ${runningJobs.size} active`)),
          ];
          for (const job of runningJobs.values()) {
            const status =
              job.state === "failed"
                ? theme.fg("error", job.state)
                : job.state === "blocked" || job.state === "timed-out"
                  ? theme.fg("warning", job.state)
                  : theme.fg("dim", job.state);
            lines.push(
              truncateToWidth(
                `  ${elapsed(job.startedAt)}  ${job.displayName} (${job.paneId})  ${status}`,
                width,
              ),
            );
          }
          return lines;
        },
      }),
      { placement: "aboveEditor" },
    );
  } catch (error) {
    console.error("[herdr-subagents] widget update failed", error);
  }
}

function sessionPath(agent: HerdrAgent | undefined): string | undefined {
  return agent?.agent_session?.kind === "path" && typeof agent.agent_session.value === "string"
    ? agent.agent_session.value
    : undefined;
}

function assertJobAgentIdentity(
  job: RunningJob,
  agent: HerdrAgent,
  phase: string,
): HerdrAgent {
  if (agent.pane_id !== job.paneId) {
    throw new HerdrIdentityError(
      `Herdr returned pane ${agent.pane_id} for ${job.displayName} during ${phase}; expected ${job.paneId}.`,
    );
  }
  if (job.expectedName && agent.name && agent.name !== job.expectedName) {
    throw new HerdrIdentityError(
      `Herdr returned agent ${agent.name} for ${job.displayName} during ${phase}; expected ${job.expectedName}.`,
    );
  }

  const observedSession = sessionPath(agent);
  if (job.sessionFile && observedSession && observedSession !== job.sessionFile) {
    throw new HerdrIdentityError(
      `Herdr returned a different Pi session for ${job.displayName} during ${phase}.`,
    );
  }

  job.expectedName ??= agent.name ?? undefined;
  job.sessionFile ??= observedSession;
  return agent;
}

function validateExistingAgent(agent: HerdrAgent): void {
  if (!isReusableAgent(agent)) {
    throw new Error(
      `Herdr target ${agentDisplayName(agent)} is ${agent.agent_status} (${agent.agent ?? "no agent"}); expected an idle or done recognized agent.`,
    );
  }
  if (agent.pane_id === process.env.HERDR_PANE_ID) {
    throw new Error("Cannot delegate to the current Pi pane.");
  }
  if (reservedPanes.has(agent.pane_id)) {
    throw new Error(`Herdr target ${agentDisplayName(agent)} already has a delegated task running.`);
  }
}

async function selectTarget(
  params: DispatchInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<DispatchTarget> {
  const reuse = params.reuse ?? "never";

  if (params.target) {
    const agent = await getAgent(params.target, { timeoutMs: 5_000, signal });
    validateExistingAgent(agent);
    reservedPanes.add(agent.pane_id);
    return {
      paneId: agent.pane_id,
      target: agent.name || agent.pane_id,
      expectedName: agent.name ?? undefined,
      displayName: agentDisplayName(agent),
      created: false,
    };
  }

  if (reuse !== "never") {
    const agents = await listAgents({ timeoutMs: 5_000, signal });
    const candidates = findReusableAgents({
      agents,
      workspaceId: process.env.HERDR_WORKSPACE_ID!,
      currentPaneId: process.env.HERDR_PANE_ID!,
      cwd,
      reservedTargets: reservedPanes,
    });

    if (candidates.length > 1) {
      const choices = candidates
        .map((agent) => `${agentDisplayName(agent)} [${agent.pane_id}]`)
        .join(", ");
      throw new Error(
        `Multiple reusable Herdr agents match this workspace and cwd: ${choices}. Pass target explicitly or use reuse: "never".`,
      );
    }
    if (candidates.length === 1) {
      const agent = candidates[0];
      reservedPanes.add(agent.pane_id);
      return {
        paneId: agent.pane_id,
        target: agent.name || agent.pane_id,
        expectedName: agent.name ?? undefined,
        displayName: agentDisplayName(agent),
        created: false,
      };
    }
    if (reuse === "require") {
      throw new Error("No reusable idle/done agent exists in the current Herdr workspace and cwd.");
    }
  }

  const paneEnv = await freshPaneEnvironment();
  const mainPaneId = process.env.HERDR_PANE_ID!;
  let splitParentPaneId = mainPaneId;
  let direction: "right" | "down" =
    params.direction === "right" || params.direction === "down" ? params.direction : "right";
  try {
    const layout = await getCurrentLayout({ timeoutMs: 5_000, signal });
    splitParentPaneId = chooseSplitParent(layout, mainPaneId, ownedSplitAnchors);
    if (params.direction !== "right" && params.direction !== "down") {
      direction = chooseSplitDirection(layout, splitParentPaneId);
    }
  } catch {
    // Fall back to splitting the main pane when layout inspection is unavailable.
  }

  const pane = await splitPane({
    parentPaneId: splitParentPaneId,
    direction,
    cwd,
    env: paneEnv,
    options: { timeoutMs: 5_000, signal },
  });
  reservedPanes.add(pane.pane_id);
  ownedSplitAnchors.push(pane.pane_id);
  return {
    paneId: pane.pane_id,
    target: pane.pane_id,
    displayName: pane.pane_id,
    created: true,
  };
}

async function collectResult(job: RunningJob, agent: HerdrAgent): Promise<string> {
  assertJobAgentIdentity(job, agent, "result collection");
  const path = sessionPath(agent) ?? job.sessionFile;
  const fromSession = await findAssistantTextAfter(path, job.sessionCursor);
  if (fromSession) return fromSession;

  const screen = await readAgent(agent.name || agent.pane_id, 200, {
    timeoutMs: 5_000,
    signal: job.controller.signal,
  });
  return screen || "Agent completed without readable output.";
}

function flushCompletionQueue(triggerTurn = true): void {
  completionTimer = undefined;
  const queued = pendingCompletions.splice(0);
  const deliverable = queued.filter((item) => item.parentSessionId === activeSessionId);
  for (let index = 0; index < deliverable.length; index++) {
    const item = deliverable[index];
    try {
      item.pi.sendMessage(item.message, {
        triggerTurn: triggerTurn && index === deliverable.length - 1,
        deliverAs: "steer",
      });
    } catch (error) {
      console.error("[herdr-subagents] result delivery failed", error);
    }
  }
}

function scheduleCompletionFlush(): void {
  if (completionTimer) clearTimeout(completionTimer);
  completionTimer = setTimeout(flushCompletionQueue, completionBatchDelay(runningJobs.size));
}

function queueCompletion(
  pi: ExtensionAPI,
  job: RunningJob,
  params: {
    output: string;
    status: CompletionStatus;
    error?: string;
  },
): void {
  if (job.parentSessionId !== activeSessionId || job.controller.signal.aborted) return;

  const clipped = truncateUtf8(params.output);
  const sessionRef = job.sessionFile ? `\n\nSession: ${job.sessionFile}` : "";
  const paneRef = `\nHerdr pane: ${job.paneId}`;
  const heading =
    params.status === "completed"
      ? `Herdr subagent "${job.displayName}" completed (${elapsed(job.startedAt)}).`
      : params.status === "completed-with-warning"
        ? `Herdr subagent "${job.displayName}" completed with a cleanup warning (${elapsed(job.startedAt)}).`
        : params.status === "blocked"
          ? `Herdr subagent "${job.displayName}" is blocked and remains supervised.`
          : params.status === "timed-out"
            ? `Herdr subagent "${job.displayName}" exceeded its initial wait timeout and remains supervised.`
            : `Herdr subagent "${job.displayName}" failed.`;
  const content = `${heading}\n\n${params.error ? `${params.error}\n\n` : ""}${clipped.text}${paneRef}${sessionRef}`;
  const details = {
    id: job.id,
    task: job.task,
    target: job.target,
    paneId: job.paneId,
    displayName: job.displayName,
    created: job.created,
    retention: job.retention,
    status: params.status,
    elapsed: elapsed(job.startedAt),
    sessionFile: job.sessionFile,
    model: job.model,
    truncated: clipped.truncated,
    error: params.error,
  };
  const message = {
    customType: "herdr_subagent_result",
    content,
    display: true,
    details,
  };

  try {
    pi.appendEntry("herdr_subagent_result_record", { content, details });
  } catch (error) {
    console.error("[herdr-subagents] result persistence failed", error);
  }
  pendingCompletions.push({ pi, parentSessionId: job.parentSessionId, message });
  scheduleCompletionFlush();
}

async function waitForAgent(
  job: RunningJob,
  until: Array<"idle" | "blocked" | "done" | "unknown">,
): Promise<HerdrAgent> {
  while (!job.controller.signal.aborted) {
    try {
      const agent = await waitAgent({
        target: job.target,
        until,
        timeoutMs: 60_000,
        options: { signal: job.controller.signal },
      });
      return assertJobAgentIdentity(job, agent, "supervision wait");
    } catch (error) {
      if (isHerdrTimeout(error)) continue;
      throw error;
    }
  }
  throw job.controller.signal.reason ?? new Error("Job detached");
}

async function reportPause(
  pi: ExtensionAPI,
  job: RunningJob,
  agent: HerdrAgent,
  status: "blocked" | "timed-out",
  error?: string,
): Promise<void> {
  assertJobAgentIdentity(job, agent, `${status} reporting`);
  job.state = status;
  job.sessionFile = sessionPath(agent) ?? job.sessionFile;
  updateWidget();
  let output = "The agent is still running; use herdr_subagent_control to inspect or interrupt it.";
  try {
    output = await collectResult(job, agent);
  } catch {
    // The status notification is still useful without terminal output.
  }
  queueCompletion(pi, job, { output, status, error });
}

async function runJob(pi: ExtensionAPI, job: RunningJob, params: DispatchInput): Promise<void> {
  let startedAgent: HerdrAgent | undefined;
  let agentDetected = !job.created;

  try {
    if (job.created) {
      job.state = "starting";
      updateWidget();
      try {
        startedAgent = await withMutationLock(() =>
          startPiAgent({
            name: job.target,
            paneId: job.paneId,
            model: params.model,
            thinking: params.thinking,
            tools: params.tools,
            systemPrompt: params.systemPrompt,
            options: { signal: job.controller.signal },
          }),
        );
      } catch (startError) {
        try {
          startedAgent = assertJobAgentIdentity(
            job,
            await getAgent(job.target, {
              timeoutMs: 5_000,
              signal: job.controller.signal,
            }),
            "startup recovery",
          );
          agentDetected = typeof startedAgent.agent === "string";
        } catch {
          throw startError;
        }
        if (!agentDetected || startedAgent.agent_status === "unknown") throw startError;
        if (startedAgent.agent_status === "blocked") {
          await reportPause(
            pi,
            job,
            startedAgent,
            "blocked",
            startError instanceof Error ? startError.message : String(startError),
          );
          startedAgent = await waitForAgent(job, ["idle", "done", "unknown"]);
        } else if (startedAgent.agent_status === "working") {
          startedAgent = await waitForAgent(job, ["idle", "blocked", "done", "unknown"]);
          if (startedAgent.agent_status === "blocked") {
            await reportPause(pi, job, startedAgent, "blocked");
            startedAgent = await waitForAgent(job, ["idle", "done", "unknown"]);
          }
        }
      }
      startedAgent = assertJobAgentIdentity(job, startedAgent, "startup");
      agentDetected = typeof startedAgent.agent === "string";
      if (!agentDetected || startedAgent.agent_status === "unknown") {
        throw new Error(`Started agent ${job.target} did not become available.`);
      }
      job.target = startedAgent.name || startedAgent.pane_id;
      job.displayName = agentDisplayName(startedAgent);
      job.sessionFile = sessionPath(startedAgent);
    } else {
      startedAgent = assertJobAgentIdentity(
        job,
        await getAgent(job.target, {
          timeoutMs: 5_000,
          signal: job.controller.signal,
        }),
        "pre-dispatch validation",
      );
      if (!isReusableAgent(startedAgent)) {
        throw new Error(
          `Herdr target ${agentDisplayName(startedAgent)} changed to ${startedAgent.agent_status} before dispatch.`,
        );
      }
      job.sessionFile = sessionPath(startedAgent);
    }

    job.sessionCursor = await getSessionCursor(job.sessionFile);
    job.state = "working";
    updateWidget();

    let completedAgent: HerdrAgent;
    try {
      completedAgent = assertJobAgentIdentity(
        job,
        await promptAgent({
          target: job.target,
          task: params.task,
          timeoutMs: params.timeoutMs ?? 600_000,
          options: { signal: job.controller.signal },
        }),
        "prompt completion",
      );
    } catch (error) {
      if (!isHerdrTimeout(error)) throw error;
      let current: HerdrAgent;
      try {
        current = assertJobAgentIdentity(
          job,
          await getAgent(job.target, {
            timeoutMs: 5_000,
            signal: job.controller.signal,
          }),
          "timeout recovery",
        );
      } catch (readError) {
        if (job.controller.signal.aborted || !startedAgent) throw readError;
        current = { ...startedAgent, agent_status: "working" };
      }
      await reportPause(
        pi,
        job,
        current,
        "timed-out",
        "The initial wait timed out. Monitoring continues until the agent settles or is detached.",
      );
      completedAgent = await waitForAgent(job, ["idle", "blocked", "done", "unknown"]);
    }

    job.sessionFile = sessionPath(completedAgent) ?? job.sessionFile;
    if (completedAgent.agent_status === "blocked") {
      await reportPause(pi, job, completedAgent, "blocked");
      completedAgent = await waitForAgent(job, ["idle", "done", "unknown"]);
      job.sessionFile = sessionPath(completedAgent) ?? job.sessionFile;
    }
    if (completedAgent.agent_status === "unknown") {
      throw new Error(`Herdr lost agent detection for ${job.displayName}.`);
    }

    const output = await collectResult(job, completedAgent);
    if (job.controller.signal.aborted) return;
    let cleanupWarning: string | undefined;
    if (job.created && job.retention === "one-shot") {
      try {
        const closed = await withMutationLock(async () => {
          const latest = assertJobAgentIdentity(
            job,
            await getAgent(job.target, {
              timeoutMs: 5_000,
              signal: job.controller.signal,
            }),
            "one-shot cleanup",
          );
          if (!canCloseOwnedPane(latest, job.paneId)) return false;
          await closePane(job.paneId, { timeoutMs: 5_000, signal: job.controller.signal });
          return true;
        });
        if (!closed) {
          cleanupWarning =
            "The owned pane was focused, active, or no longer matched the completed agent, so it was retained.";
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        cleanupWarning = `The owned pane could not be closed safely: ${detail}`;
      }
    }
    if (job.controller.signal.aborted) return;
    job.state = "completed";
    queueCompletion(pi, job, {
      output,
      status: cleanupWarning ? "completed-with-warning" : "completed",
      error: cleanupWarning ? `Task succeeded. ${cleanupWarning}` : undefined,
    });
  } catch (error) {
    if (job.controller.signal.aborted) return;
    const closeAttempt = closeAttempts.get(job.id);
    if (closeAttempt && (await closeAttempt)) return;
    if (job.controller.signal.aborted) return;

    job.state = "failed";
    updateWidget();
    const message = error instanceof Error ? error.message : String(error);
    let output = "No agent output was available.";
    try {
      output = await readAgent(job.target, 120, { timeoutMs: 5_000 });
    } catch {
      // The pane may have failed before an agent was detected.
    }
    if (job.created && !agentDetected && !(error instanceof HerdrIdentityError)) {
      try {
        await withMutationLock(() => closePane(job.paneId, { timeoutMs: 5_000 }));
      } catch {
        // Best-effort cleanup of an empty pane.
      }
    }
    queueCompletion(pi, job, { output, status: "failed", error: message });
  } finally {
    reservedPanes.delete(job.paneId);
    if (job.created) removeSplitAnchor(job.paneId);
    runningJobs.delete(job.id);
    recentJobs.unshift({
      id: job.id,
      displayName: job.displayName,
      paneId: job.paneId,
      state: job.state,
      elapsed: elapsed(job.startedAt),
    });
    recentJobs.splice(20);
    updateWidget();
  }
}

export default function herdrSubagents(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ownedSplitAnchors.length = 0;
    latestCtx = ctx;
    activeSessionId = ctx.sessionManager.getSessionId();
    updateWidget();
  });

  pi.on("session_shutdown", () => {
    if (completionTimer) clearTimeout(completionTimer);
    flushCompletionQueue(false);
    for (const job of runningJobs.values()) {
      if (job.parentSessionId !== activeSessionId) continue;
      job.state = "detached";
      job.controller.abort(new Error("Parent Pi session shut down; child pane was left intact."));
    }
    try {
      latestCtx?.ui.setWidget("herdr-subagents", undefined);
    } catch {
      // Runtime teardown must not be interrupted by UI cleanup.
    }
    ownedSplitAnchors.length = 0;
    latestCtx = null;
    activeSessionId = null;
  });

  pi.registerTool({
    name: "herdr_subagent",
    label: "Herdr Subagent",
    description:
      "Asynchronously delegate a task through Herdr. Target an existing agent explicitly, opt into automatic reuse, or create a background Pi pane by default. Completion is delivered automatically and active jobs remain supervised after a wait timeout. Never poll after dispatching.",
    promptSnippet:
      "Delegate independent work asynchronously to an existing Herdr agent or newly created Pi agent",
    promptGuidelines: [
      "Use herdr_subagent for independent work that can proceed in parallel; after dispatching, continue other independent work or end the turn, and never poll Herdr for completion.",
      "Pass herdr_subagent.target when the user identifies an existing Herdr agent or pane. Without a target, a new pane is created unless reuse=auto or reuse=require is explicitly requested.",
      "Use herdr_subagent retention=interactive when the user should continue working in the spawned pane; use one-shot for autonomous disposable work.",
      "herdr_subagent inherits the parent model and thinking level for new agents; specify model only when the task clearly benefits from a different available model, such as a fast model for reconnaissance or a stronger reasoning model for architecture and debugging.",
    ],
    parameters: DispatchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertHerdrRuntime();
      assertNonBlankDispatch(params);
      if (runningJobs.size + pendingDispatches >= MAX_CONCURRENT_JOBS) {
        throw new Error(
          `At most ${MAX_CONCURRENT_JOBS} Herdr subagents may be active. Wait for one to finish or use herdr_subagent_control to detach it.`,
        );
      }
      if (params.target && params.reuse) {
        throw new Error("target and reuse cannot be combined; an explicit target already defines routing.");
      }
      const launchOverrides = requestedLaunchOverrides(params);
      if (launchOverrides.length > 0 && params.target) {
        throw new Error(
          `${launchOverrides.join(", ")} can only configure a newly created Pi agent; they cannot be applied to an existing target.`,
        );
      }
      if (
        launchOverrides.length > 0 &&
        params.reuse &&
        params.reuse !== "never"
      ) {
        throw new Error(
          `${launchOverrides.join(", ")} conflict with automatic/required reuse because launch options require a newly created Pi agent.`,
        );
      }

      const selectableModels =
        ctx.scopedModels.length > 0
          ? ctx.scopedModels.map((entry) => entry.model)
          : ctx.modelRegistry.getAvailable();
      const effectiveModel = resolveModelSelection({
        requested: params.model,
        parent: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        available: selectableModels.map((model) => ({ provider: model.provider, id: model.id })),
      });
      const effectiveParams: DispatchInput = {
        ...params,
        // Explicit launch options must be honored, so never silently reuse an
        // existing session whose model, thinking, tools, or prompt cannot be controlled here.
        reuse: launchOverrides.length > 0 ? "never" : (params.reuse ?? "never"),
        model: effectiveModel,
        thinking: params.thinking ?? ctx.thinkingLevel,
      };

      const id = randomBytes(4).toString("hex");
      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      const parentSessionId = ctx.sessionManager.getSessionId();
      pendingDispatches++;
      let selected: DispatchTarget;
      try {
        selected = await withMutationLock(() => selectTarget(effectiveParams, cwd, signal));
      } finally {
        pendingDispatches--;
      }
      if (signal?.aborted || activeSessionId !== parentSessionId) {
        await discardSelectedTarget(selected);
        throw signal?.reason instanceof Error
          ? signal.reason
          : new Error("The parent Pi session ended before delegation was registered.");
      }
      const retention = params.retention ?? "one-shot";
      const generatedName = selected.created ? makeTaskAgentName(params.task, id) : selected.target;
      const job: RunningJob = {
        id,
        task: params.task,
        target: generatedName,
        expectedName: selected.created ? generatedName : selected.expectedName,
        displayName: selected.created ? generatedName : selected.displayName,
        paneId: selected.paneId,
        created: selected.created,
        retention,
        state: selected.created ? "starting" : "working",
        startedAt: Date.now(),
        parentSessionId,
        controller: new AbortController(),
        sessionCursor: { offset: 0 },
        model: selected.created ? effectiveModel : undefined,
      };
      runningJobs.set(id, job);
      updateWidget();

      void runJob(pi, job, effectiveParams).catch((error) => {
        reservedPanes.delete(job.paneId);
        runningJobs.delete(job.id);
        updateWidget();
        console.error("[herdr-subagents] unhandled background job failure", error);
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Herdr subagent "${job.displayName}" queued in ${job.paneId} with job ID ${job.id}. ` +
              "Provisioning and execution continue asynchronously; completion will be delivered automatically.",
          },
        ],
        details: {
          id,
          target: job.target,
          paneId: job.paneId,
          created: job.created,
          retention,
          model: job.model,
          status: "queued",
        },
      };
    },

    renderCall(args, theme) {
      const target = args.target || (args.reuse ? `reuse:${args.reuse}` : "new");
      const preview = args.task
        ? args.task.split("\n").find((line) => line.trim())?.slice(0, 100) || ""
        : "";
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(target))}${preview ? `\n${theme.fg("dim", preview)}` : ""}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as any;
      if (details?.status === "queued") {
        const mode = details.created ? details.retention : "existing";
        const model = details.model ? ` · ${details.model}` : "";
        return new Text(
          `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.target))}${theme.fg("dim", ` — ${mode} · ${details.paneId}${model}`)}`,
          0,
          0,
        );
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "herdr_subagent_control",
    label: "Herdr Subagent Control",
    description:
      "List active delegated jobs or control one by job ID. Supports interrupt, detach, close for extension-owned panes, and focus.",
    promptSnippet: "Inspect or control active Herdr subagent jobs",
    parameters: ControlParams,
    async execute(_toolCallId, params: ControlInput, signal) {
      assertHerdrRuntime();
      if (!params.jobId && !params.action) {
        const activeLines = [...runningJobs.values()].map(
          (job) =>
            `• ${job.id} · ${job.displayName} [${job.paneId}] · ${job.state} · ${elapsed(job.startedAt)} · ${job.created ? "owned" : "existing"}`,
        );
        const recentLines = recentJobs.slice(0, 5).map(
          (job) => `  ${job.id} · ${job.displayName} · ${job.state} · ${job.elapsed}`,
        );
        const sections = [
          activeLines.length ? `Active:\n${activeLines.join("\n")}` : "No active jobs.",
          recentLines.length ? `Recent:\n${recentLines.join("\n")}` : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          details: {
            jobs: [...runningJobs.values()].map(({ controller: _controller, ...job }) => job),
            jobId: null,
            action: null,
            paneId: null,
          } as ControlDetails,
        };
      }
      if (!params.jobId || !params.action) {
        throw new Error("jobId and action must be provided together.");
      }

      const job = runningJobs.get(params.jobId);
      if (!job) throw new Error(`No active Herdr subagent job has ID ${params.jobId}.`);

      if (params.action === "focus") {
        await withMutationLock(() =>
          focusAgent(job.target, { timeoutMs: 5_000, signal }),
        );
      } else if (params.action === "interrupt") {
        const previousState = job.state;
        job.state = "interrupting";
        updateWidget();
        try {
          await withMutationLock(() =>
            sendAgentKeys(job.target, ["ctrl-c"], { timeoutMs: 5_000, signal }),
          );
        } finally {
          if (runningJobs.has(job.id) && job.state === "interrupting") job.state = previousState;
          updateWidget();
        }
      } else if (params.action === "detach") {
        job.state = "detached";
        job.controller.abort(new Error("Job detached by user; child pane was left intact."));
      } else {
        if (!job.created) throw new Error("The extension will not close a reused existing pane.");
        if (closeAttempts.has(job.id)) throw new Error("This job already has a close in progress.");

        const previousState = job.state;
        let settleClose!: (closed: boolean) => void;
        const closeAttempt = new Promise<boolean>((resolve) => {
          settleClose = resolve;
        });
        closeAttempts.set(job.id, closeAttempt);
        job.state = "closing";
        updateWidget();
        try {
          await withMutationLock(() => closePane(job.paneId, { timeoutMs: 5_000, signal }));
          removeSplitAnchor(job.paneId);
          job.state = "detached";
          job.controller.abort(new Error("Owned pane closed by user."));
          settleClose(true);
        } catch (error) {
          if (runningJobs.has(job.id) && job.state === "closing") job.state = previousState;
          settleClose(false);
          throw error;
        } finally {
          closeAttempts.delete(job.id);
          updateWidget();
        }
      }
      updateWidget();

      return {
        content: [
          {
            type: "text",
            text: `Applied ${params.action} to Herdr subagent ${job.displayName} (${job.id}).`,
          },
        ],
        details: {
          jobs: [],
          jobId: job.id,
          action: params.action,
          paneId: job.paneId,
        } as ControlDetails,
      };
    },
  });

  pi.registerTool({
    name: "herdr_agents",
    label: "Herdr Agents",
    description:
      "List Herdr-recognized agents and their names, pane IDs, status, workspace, and cwd. Use this to choose an explicit target; it is not a completion polling tool.",
    promptSnippet: "List addressable Herdr agents before choosing an explicit delegation target",
    parameters: Type.Object({}),
    async execute() {
      assertHerdrRuntime();
      const agents = await listAgents({ timeoutMs: 5_000 });
      const lines = agents.map(formatAgentLine);
      return {
        content: [{ type: "text", text: lines.join("\n") || "No Herdr agents found." }],
        details: { agents },
      };
    },
    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  pi.registerCommand("herdr-agents", {
    description: "List Herdr-recognized agents",
    handler: async (_args, ctx) => {
      try {
        assertHerdrRuntime();
        const agents = await listAgents({ timeoutMs: 5_000 });
        const lines = agents.map(formatAgentLine);
        ctx.ui.notify(lines.join("\n") || "No Herdr agents found.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerMessageRenderer("herdr_subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;
    return {
      invalidate() {},
      render(width: number) {
        const failed = details.status === "failed";
        const warning =
          details.status === "blocked" ||
          details.status === "timed-out" ||
          details.status === "completed-with-warning";
        const icon = failed
          ? theme.fg("error", "✗")
          : warning
            ? theme.fg("warning", "?")
            : theme.fg("success", "✓");
        const content = typeof message.content === "string" ? message.content : "";
        const lines = content.split("\n");
        const visible = options.expanded ? lines : lines.slice(0, 7);
        const body = [
          `${icon} ${theme.fg("toolTitle", theme.bold(details.displayName ?? details.target))} ${theme.fg("dim", `— ${details.status} · ${details.elapsed}`)}`,
          ...visible.slice(1).map((line) => truncateToWidth(line, Math.max(1, width - 4))),
        ];
        if (!options.expanded && lines.length > visible.length) {
          body.push(theme.fg("muted", `… ${lines.length - visible.length} more lines`));
        }
        if (!options.expanded) body.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        const box = new Box(1, 1, (text) =>
          theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text),
        );
        box.addChild(new Text(body.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}

export const __test__ = { runningJobs, reservedPanes };
