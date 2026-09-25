import { randomBytes } from "node:crypto";
import { constants, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  canCloseOwnedPane,
  canDispatchJob,
  chooseSplitDirection,
  chooseSplitParent,
  completionBatchDelay,
  HERDR_HANDOVER_FILE_ENV,
  HERDR_JOB_ID_ENV,
  isDelegatedWorker,
  makeTaskAgentName,
  MAX_CONCURRENT_JOBS,
  workerPaneEnvironment,
  workerToolAllowlist,
} from "./policy.ts";
import {
  findAssistantTextAfter,
  getSessionCursor,
  truncateUtf8,
  type SessionCursor,
} from "./session.ts";

const Direction = StringEnum(["auto", "right", "down"] as const, {
  description: "Direction for a new split. Default: auto based on current pane geometry.",
});
const ThinkingLevel = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  { description: "Thinking-level override for the worker" },
);

const DispatchParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "Self-contained task to send to a fresh one-shot worker",
  }),
  parallelReason: Type.String({
    minLength: 1,
    description:
      "What useful independent work the main agent will do while this worker runs. Delegation is rejected when this is blank.",
  }),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Working directory. Defaults to the parent Pi working directory.",
    }),
  ),
  direction: Type.Optional(Direction),
  thinking: Type.Optional(ThinkingLevel),
  tools: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Comma-separated Pi tool allowlist for the worker",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      minLength: 1,
      description: "System prompt appended for the worker",
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
    "interrupt sends Ctrl-C; detach stops supervision but leaves the pane; close closes it; focus opens it.",
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
  | "handover"
  | "detached"
  | "failed";
type CompletionStatus =
  | "completed"
  | "completed-with-warning"
  | "handover"
  | "blocked"
  | "timed-out"
  | "failed";

interface RunningJob {
  id: string;
  task: string;
  parallelReason: string;
  target: string;
  expectedName: string;
  displayName: string;
  paneId: string;
  state: JobState;
  startedAt: number;
  parentSessionId: string;
  controller: AbortController;
  sessionFile?: string;
  sessionCursor: SessionCursor;
  model?: string;
  handoverFile: string;
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

interface HandoverRequest {
  type: "caller_ping";
  jobId: string;
  task: string;
  reason: string;
  context?: string;
}

const CallerPingParams = Type.Object({
  task: Type.String({
    minLength: 1,
    maxLength: 65_536,
    description: "Self-contained task the parent should consider assigning to another worker",
  }),
  reason: Type.String({
    minLength: 1,
    maxLength: 8_192,
    description: "Why separate parallel work is necessary instead of completing the task directly",
  }),
  context: Type.Optional(
    Type.String({
      maxLength: 65_536,
      description: "Relevant findings, file paths, constraints, and expected output",
    }),
  ),
});

const FENCED_PI_BIN_DIR = resolve(fileURLToPath(new URL("./fenced-bin/", import.meta.url)));
const FENCED_PI_SHIM = resolve(FENCED_PI_BIN_DIR, "pi");
const runningJobs = new Map<string, RunningJob>();
const pendingCompletions: PendingCompletion[] = [];
const recentJobs: RecentJob[] = [];
const ownedSplitAnchors: string[] = [];
const closeAttempts = new Map<string, Promise<boolean>>();
let pendingDispatches = 0;
let latestCtx: ExtensionContext | null = null;
let activeSessionId: string | null = null;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let mutationTail: Promise<void> = Promise.resolve();

function registerWorkerSurface(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Delegated worker boundary\nYou are a one-shot worker, not the parent orchestrator. Complete the assigned task directly and return a concise result. You cannot create or manage subagents. If another independent worker is genuinely needed for parallel work, call caller_ping with a self-contained proposed task, the reason parallel delegation is necessary, and all relevant context. Stop after calling it; the main agent alone decides whether to delegate. Do not request another worker for sequential work you can complete yourself.`,
  }));

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Hand a proposed parallel task back to the main agent and end this one-shot worker. This cannot create or manage a subagent; the main agent decides whether delegation is warranted.",
    parameters: CallerPingParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const handoverFile = process.env[HERDR_HANDOVER_FILE_ENV];
      const jobId = process.env[HERDR_JOB_ID_ENV];
      if (!handoverFile || !jobId) {
        throw new Error("caller_ping is available only in a managed Herdr worker.");
      }
      const task = params.task.trim();
      const reason = params.reason.trim();
      if (!task || !reason) throw new Error("caller_ping task and reason cannot be blank.");

      const request: HandoverRequest = {
        type: "caller_ping",
        jobId,
        task,
        reason,
        ...(params.context?.trim() ? { context: params.context.trim() } : {}),
      };
      const temporaryFile = `${handoverFile}.${process.pid}.tmp`;
      try {
        writeFileSync(temporaryFile, JSON.stringify(request), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        renameSync(temporaryFile, handoverFile);
      } finally {
        rmSync(temporaryFile, { force: true });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Handover sent to the main agent." }],
        details: { handedOver: true },
      };
    },
  });
}

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
    ["parallelReason", params.parallelReason],
    ["cwd", params.cwd],
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

async function freshPaneEnvironment(
  jobId: string,
  handoverFile: string,
): Promise<Record<string, string>> {
  const fenced = process.env.FENCE_SANDBOX === "1";
  if (fenced) {
    try {
      await access(FENCED_PI_SHIM, constants.X_OK);
    } catch {
      throw new Error(`The bundled fenced Pi launcher is missing or not executable: ${FENCED_PI_SHIM}`);
    }
  }
  return workerPaneEnvironment({
    fenced,
    fencedBinDir: FENCED_PI_BIN_DIR,
    handoverFile,
    jobId,
    path: process.env.PATH,
  });
}

async function discardWorkerPane(paneId: string): Promise<void> {
  removeSplitAnchor(paneId);
  try {
    await withMutationLock(() => closePane(paneId, { timeoutMs: 5_000 }));
  } catch (error) {
    console.error("[herdr-subagents] failed to clean up cancelled dispatch", error);
  }
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
  if (agent.name && agent.name !== job.expectedName) {
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

  job.sessionFile ??= observedSession;
  return agent;
}

async function createWorkerPane(params: {
  cwd: string;
  direction?: "auto" | "right" | "down";
  jobId: string;
  handoverFile: string;
  signal?: AbortSignal;
}): Promise<string> {
  const paneEnv = await freshPaneEnvironment(params.jobId, params.handoverFile);
  const mainPaneId = process.env.HERDR_PANE_ID!;
  let splitParentPaneId = mainPaneId;
  let direction: "right" | "down" =
    params.direction === "right" || params.direction === "down" ? params.direction : "right";
  try {
    const layout = await getCurrentLayout({ timeoutMs: 5_000, signal: params.signal });
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
    cwd: params.cwd,
    env: paneEnv,
    options: { timeoutMs: 5_000, signal: params.signal },
  });
  ownedSplitAnchors.push(pane.pane_id);
  return pane.pane_id;
}

function takeHandover(job: RunningJob): HandoverRequest | null {
  let raw: string;
  try {
    raw = readFileSync(job.handoverFile, "utf8");
  } catch {
    return null;
  } finally {
    rmSync(job.handoverFile, { force: true });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The worker produced an invalid caller_ping handover record.");
  }
  const request = value as Partial<HandoverRequest> | null;
  if (
    !request ||
    request.type !== "caller_ping" ||
    request.jobId !== job.id ||
    typeof request.task !== "string" ||
    !request.task.trim() ||
    request.task.length > 65_536 ||
    typeof request.reason !== "string" ||
    !request.reason.trim() ||
    request.reason.length > 8_192 ||
    (request.context !== undefined &&
      (typeof request.context !== "string" || request.context.length > 65_536))
  ) {
    throw new Error("The worker produced a caller_ping record with invalid identity or content.");
  }
  return {
    type: "caller_ping",
    jobId: request.jobId,
    task: request.task.trim(),
    reason: request.reason.trim(),
    ...(request.context?.trim() ? { context: request.context.trim() } : {}),
  };
}

async function deliverHandover(
  pi: ExtensionAPI,
  job: RunningJob,
  request: HandoverRequest,
): Promise<void> {
  job.state = "handover";
  const context = request.context ? `\nContext: ${request.context}` : "";
  const output =
    `The worker requested that the main agent consider another parallel task.\n` +
    `Proposed task: ${request.task}\nReason: ${request.reason}${context}\n\n` +
    "The request has not started another subagent. The main agent must decide whether parallel delegation is necessary and remains subject to the four-job limit.";
  let cleanupError: string | undefined;
  try {
    await withMutationLock(() => closePane(job.paneId, { timeoutMs: 5_000 }));
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  queueCompletion(pi, job, {
    output,
    status: "handover",
    error: cleanupError ? `The one-shot pane could not be closed: ${cleanupError}` : undefined,
  });
}

async function deliverPendingHandover(pi: ExtensionAPI, job: RunningJob): Promise<boolean> {
  const request = takeHandover(job);
  if (!request) return false;
  await deliverHandover(pi, job, request);
  return true;
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
  let heading: string;
  switch (params.status) {
    case "completed":
      heading = `Herdr subagent "${job.displayName}" completed (${elapsed(job.startedAt)}).`;
      break;
    case "completed-with-warning":
      heading = `Herdr subagent "${job.displayName}" completed with a cleanup warning (${elapsed(job.startedAt)}).`;
      break;
    case "handover":
      heading = `Herdr subagent "${job.displayName}" handed work back to the main agent (${elapsed(job.startedAt)}).`;
      break;
    case "blocked":
      heading = `Herdr subagent "${job.displayName}" is blocked and remains supervised.`;
      break;
    case "timed-out":
      heading = `Herdr subagent "${job.displayName}" exceeded its initial wait timeout and remains supervised.`;
      break;
    case "failed":
      heading = `Herdr subagent "${job.displayName}" failed.`;
  }
  const content = `${heading}\n\n${params.error ? `${params.error}\n\n` : ""}${clipped.text}${paneRef}${sessionRef}`;
  const details = {
    id: job.id,
    task: job.task,
    parallelReason: job.parallelReason,
    target: job.target,
    paneId: job.paneId,
    displayName: job.displayName,
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
  let agentDetected = false;

  try {
    job.state = "starting";
    updateWidget();
    try {
      startedAgent = await withMutationLock(() =>
        startPiAgent({
          name: job.target,
          paneId: job.paneId,
          model: job.model,
          thinking: params.thinking,
          tools: workerToolAllowlist(params.tools),
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
    job.displayName = startedAgent.name || startedAgent.pane_id;
    job.sessionFile = sessionPath(startedAgent);

    job.sessionCursor = await getSessionCursor(job.sessionFile);
    job.state = "working";
    updateWidget();

    let completedAgent: HerdrAgent;
    try {
      const promptedAgent = await promptAgent({
        target: job.target,
        task: params.task,
        timeoutMs: params.timeoutMs ?? 600_000,
        options: { signal: job.controller.signal },
      });
      if (await deliverPendingHandover(pi, job)) return;
      completedAgent = assertJobAgentIdentity(job, promptedAgent, "prompt completion");
    } catch (error) {
      if (await deliverPendingHandover(pi, job)) return;
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
    // A ping can arrive after the initial prompt wait timed out and supervision resumed.
    if (await deliverPendingHandover(pi, job)) return;
    if (completedAgent.agent_status === "unknown") {
      throw new Error(`Herdr lost agent detection for ${job.displayName}.`);
    }

    const output = await collectResult(job, completedAgent);
    if (job.controller.signal.aborted) return;
    let cleanupWarning: string | undefined;
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
    if (job.controller.signal.aborted) return;
    job.state = "completed";
    queueCompletion(pi, job, {
      output,
      status: cleanupWarning ? "completed-with-warning" : "completed",
      error: cleanupWarning ? `Task succeeded. ${cleanupWarning}` : undefined,
    });
  } catch (error) {
    if (job.controller.signal.aborted) return;
    if (await deliverPendingHandover(pi, job)) return;
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
    if (!agentDetected && !(error instanceof HerdrIdentityError)) {
      try {
        await withMutationLock(() => closePane(job.paneId, { timeoutMs: 5_000 }));
      } catch {
        // Best-effort cleanup of an empty pane.
      }
    }
    queueCompletion(pi, job, { output, status: "failed", error: message });
  } finally {
    removeSplitAnchor(job.paneId);
    rmSync(job.handoverFile, { force: true });
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
  // Workers expose only caller_ping. They never register spawning, management,
  // listing, command, lifecycle, or renderer surfaces.
  if (isDelegatedWorker(process.env)) {
    registerWorkerSurface(pi);
    return;
  }

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
      `Start a fresh one-shot Pi worker through Herdr. Use only when the task can run independently in parallel with useful main-agent work; do not delegate sequential, trivial, or tightly coupled work. Workers cannot spawn agents and may only hand proposed parallel work back through caller_ping. Completion is delivered automatically, and at most ${MAX_CONCURRENT_JOBS} jobs may be active or pending. Never poll after dispatching.`,
    promptSnippet:
      "Delegate a substantial independent task to a fresh one-shot worker only when useful parallel work exists",
    promptGuidelines: [
      `Only the main Pi agent can create workers, with at most ${MAX_CONCURRENT_JOBS} active or pending jobs. Workers are always fresh and one-shot.`,
      "Call herdr_subagent only when work is substantial and independent and you can identify useful work to continue concurrently. Do not delegate sequential steps, small tasks, or work requiring frequent coordination.",
      "Provide parallelReason with the concrete independent work the main agent will perform while the worker runs. After dispatching, do that work or end the turn; never poll for completion.",
      "A worker needing another agent must use caller_ping. That only returns a proposal; evaluate whether parallel delegation is truly needed before starting another fresh worker.",
      "A fresh worker always uses the parent model and inherits its thinking level unless explicitly overridden.",
    ],
    parameters: DispatchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertHerdrRuntime();
      assertNonBlankDispatch(params);
      if (!canDispatchJob(runningJobs.size, pendingDispatches)) {
        throw new Error(
          `At most ${MAX_CONCURRENT_JOBS} Herdr subagents may be active. Wait for one to finish or use herdr_subagent_control to detach it.`,
        );
      }
      // A fresh Pi process has its own defaults, so pass the parent's active
      // model explicitly instead of exposing a separate worker model selector.
      if (!ctx.model) {
        throw new Error("Cannot start a subagent because the parent has no active model.");
      }
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      const effectiveParams: DispatchInput = {
        ...params,
        thinking: params.thinking ?? ctx.thinkingLevel,
      };

      const id = randomBytes(4).toString("hex");
      const handoverFile = resolve(
        tmpdir(),
        `pi-herdr-handover-${process.pid}-${id}-${randomBytes(12).toString("hex")}.json`,
      );
      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      const parentSessionId = ctx.sessionManager.getSessionId();
      pendingDispatches++;
      let paneId: string;
      try {
        paneId = await withMutationLock(() =>
          createWorkerPane({ cwd, direction: params.direction, jobId: id, handoverFile, signal }),
        );
      } finally {
        pendingDispatches--;
      }
      if (signal?.aborted || activeSessionId !== parentSessionId) {
        await discardWorkerPane(paneId);
        rmSync(handoverFile, { force: true });
        throw signal?.reason instanceof Error
          ? signal.reason
          : new Error("The parent Pi session ended before delegation was registered.");
      }
      const generatedName = makeTaskAgentName(params.task, id);
      const job: RunningJob = {
        id,
        task: params.task,
        parallelReason: params.parallelReason.trim(),
        target: generatedName,
        expectedName: generatedName,
        displayName: generatedName,
        paneId,
        state: "starting",
        startedAt: Date.now(),
        parentSessionId,
        controller: new AbortController(),
        sessionCursor: { offset: 0 },
        model: parentModel,
        handoverFile,
      };
      runningJobs.set(id, job);
      updateWidget();

      void runJob(pi, job, effectiveParams).catch((error) => {
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
          parallelReason: job.parallelReason,
          model: job.model,
          status: "queued",
        },
      };
    },

    renderCall(args, theme) {
      const preview = args.task
        ? args.task.split("\n").find((line) => line.trim())?.slice(0, 100) || ""
        : "";
      return new Text(
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("fresh one-shot worker"))}${preview ? `\n${theme.fg("dim", preview)}` : ""}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as any;
      if (details?.status === "queued") {
        const model = details.model ? ` · ${details.model}` : "";
        return new Text(
          `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(details.target))}${theme.fg("dim", ` — one-shot · ${details.paneId}${model}`)}`,
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
      "List active delegated jobs or control one by job ID. Supports interrupt, detach, close, and focus.",
    promptSnippet: "Inspect or control active Herdr subagent jobs",
    parameters: ControlParams,
    async execute(_toolCallId, params: ControlInput, signal) {
      assertHerdrRuntime();
      if (!params.jobId && !params.action) {
        const activeLines = [...runningJobs.values()].map(
          (job) =>
            `• ${job.id} · ${job.displayName} [${job.paneId}] · ${job.state} · ${elapsed(job.startedAt)} · one-shot`,
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

export const __test__ = { runningJobs };
