import { spawn } from "node:child_process";

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgentSession {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
}

export interface HerdrAgent {
  agent?: string | null;
  name?: string | null;
  agent_session?: HerdrAgentSession | null;
  agent_status: HerdrAgentStatus;
  cwd?: string | null;
  foreground_cwd?: string | null;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_title?: string | null;
  focused?: boolean;
}

export interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
}

export interface HerdrLayout {
  area: { width: number; height: number };
  panes: Array<{
    pane_id: string;
    rect: { width: number; height: number; x: number; y: number };
  }>;
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HerdrIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrIdentityError";
  }
}

export class HerdrCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    args: string[],
    exitCode: number | null,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function errorText(stderr: string, stdout: string, code: number | null): string {
  for (const raw of [stderr, stdout]) {
    try {
      const parsed = JSON.parse(raw);
      const error = parsed?.error;
      if (typeof error?.message === "string") return error.message;
      if (typeof error?.code === "string") return error.code;
    } catch {
      // Herdr syntax errors and terminal reads are not necessarily JSON.
    }
  }
  return stderr.trim() || stdout.trim() || `herdr exited with code ${code ?? "unknown"}`;
}

export async function runHerdr(args: string[], options: CommandOptions = {}): Promise<string> {
  if (options.signal?.aborted) {
    throw new HerdrCommandError("Herdr command aborted", args, null, "", "");
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("herdr", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationError: HerdrCommandError | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      fn();
    };

    const terminate = (error: HerdrCommandError) => {
      if (terminationError || settled) return;
      terminationError = error;
      if (timer) clearTimeout(timer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };

    const abort = () => {
      terminate(new HerdrCommandError("Herdr command aborted", args, null, stdout, stderr));
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(() => reject(new HerdrCommandError(error.message, args, null, stdout, stderr)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (terminationError) reject(terminationError);
        else if (code === 0) resolve(stdout);
        else reject(new HerdrCommandError(errorText(stderr, stdout, code), args, code, stdout, stderr));
      });
    });

    timer = options.timeoutMs
      ? setTimeout(() => {
          terminate(
            new HerdrCommandError(
              `Herdr command timed out after ${options.timeoutMs}ms`,
              args,
              null,
              stdout,
              stderr,
            ),
          );
        }, options.timeoutMs)
      : undefined;

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

async function runJson<T>(args: string[], options?: CommandOptions): Promise<T> {
  const stdout = await runHerdr(args, options);
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
      throw new Error("missing result object");
    }
    return parsed as T;
  } catch (error) {
    throw new HerdrCommandError(
      `Herdr returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      args,
      0,
      stdout,
      "",
    );
  }
}

function validateAgent(value: unknown): HerdrAgent {
  const agent = value as Partial<HerdrAgent> | null;
  const statuses: HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];
  if (
    !agent ||
    typeof agent.pane_id !== "string" ||
    typeof agent.tab_id !== "string" ||
    typeof agent.workspace_id !== "string" ||
    !agent.agent_status ||
    !statuses.includes(agent.agent_status)
  ) {
    throw new Error("Herdr returned an invalid agent record.");
  }
  return agent as HerdrAgent;
}

function validatePane(value: unknown): HerdrPane {
  const pane = value as Partial<HerdrPane> | null;
  if (
    !pane ||
    typeof pane.pane_id !== "string" ||
    typeof pane.tab_id !== "string" ||
    typeof pane.workspace_id !== "string"
  ) {
    throw new Error("Herdr returned an invalid pane record.");
  }
  return pane as HerdrPane;
}

export async function getAgent(target: string, options?: CommandOptions): Promise<HerdrAgent> {
  const response = await runJson<{ result: { agent: HerdrAgent } }>(
    ["agent", "get", target],
    options,
  );
  return validateAgent(response.result.agent);
}

export async function getCurrentLayout(options?: CommandOptions): Promise<HerdrLayout> {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) throw new Error("HERDR_PANE_ID is not set");
  const response = await runJson<{ result: { layout: HerdrLayout } }>(
    ["pane", "layout", "--pane", paneId],
    options,
  );
  const layout = response.result.layout;
  if (!layout?.area || !Array.isArray(layout.panes)) {
    throw new Error("Herdr returned an invalid pane layout.");
  }
  return layout;
}

export async function splitPane(params: {
  parentPaneId: string;
  direction: "right" | "down";
  cwd: string;
  env?: Record<string, string>;
  options?: CommandOptions;
}): Promise<HerdrPane> {
  const args = [
    "pane",
    "split",
    "--pane",
    params.parentPaneId,
    "--direction",
    params.direction,
    "--cwd",
    params.cwd,
    "--no-focus",
  ];
  for (const [name, value] of Object.entries(params.env ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  const response = await runJson<{ result: { pane: HerdrPane } }>(
    args,
    params.options,
  );
  return validatePane(response.result.pane);
}

export async function closePane(paneId: string, options?: CommandOptions): Promise<void> {
  await runHerdr(["pane", "close", paneId], options);
}

export async function startPiAgent(params: {
  name: string;
  paneId: string;
  model?: string;
  thinking?: string;
  tools?: string;
  systemPrompt?: string;
  options?: CommandOptions;
}): Promise<HerdrAgent> {
  const args = [
    "agent",
    "start",
    params.name,
    "--kind",
    "pi",
    "--pane",
    params.paneId,
    "--timeout",
    "30000",
  ];
  const piArgs: string[] = [];
  if (params.model) piArgs.push("--model", params.model);
  if (params.thinking) piArgs.push("--thinking", params.thinking);
  if (params.tools) piArgs.push("--tools", params.tools);
  if (params.systemPrompt) piArgs.push("--append-system-prompt", params.systemPrompt);
  if (piArgs.length > 0) args.push("--", ...piArgs);

  const response = await runJson<{ result: { agent: HerdrAgent } }>(args, {
    ...params.options,
    timeoutMs: params.options?.timeoutMs ?? 35_000,
  });
  const agent = validateAgent(response.result.agent);
  if (
    agent.pane_id !== params.paneId ||
    (agent.name != null && agent.name !== params.name)
  ) {
    throw new HerdrIdentityError(
      `Herdr returned an invalid agent identity: expected pane_id ${JSON.stringify(params.paneId)}` +
        ` and name ${JSON.stringify(params.name)}, received pane_id ${JSON.stringify(agent.pane_id)}` +
        ` and name ${JSON.stringify(agent.name)}.`,
    );
  }
  return agent;
}

export async function promptAgent(params: {
  target: string;
  task: string;
  timeoutMs: number;
  options?: CommandOptions;
}): Promise<HerdrAgent> {
  const response = await runJson<{ result: { agent: HerdrAgent } }>(
    [
      "agent",
      "prompt",
      params.target,
      params.task,
      "--wait",
      "--timeout",
      String(params.timeoutMs),
    ],
    { ...params.options, timeoutMs: params.timeoutMs + 5_000 },
  );
  return validateAgent(response.result.agent);
}

export async function waitAgent(params: {
  target: string;
  until?: HerdrAgentStatus[];
  timeoutMs: number;
  options?: CommandOptions;
}): Promise<HerdrAgent> {
  const args = ["agent", "wait", params.target];
  for (const status of params.until ?? []) args.push("--until", status);
  args.push("--timeout", String(params.timeoutMs));
  const response = await runJson<{ result: { agent: HerdrAgent } }>(args, {
    ...params.options,
    timeoutMs: params.timeoutMs + 5_000,
  });
  return validateAgent(response.result.agent);
}

export async function sendAgentKeys(
  target: string,
  keys: string[],
  options?: CommandOptions,
): Promise<void> {
  await runHerdr(["agent", "send-keys", target, ...keys], options);
}

export async function focusAgent(target: string, options?: CommandOptions): Promise<void> {
  await runHerdr(["agent", "focus", target], options);
}

export async function readAgent(
  target: string,
  lines = 160,
  options: CommandOptions = {},
): Promise<string> {
  return (
    await runHerdr(
      [
        "agent",
        "read",
        target,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      { ...options, timeoutMs: options.timeoutMs ?? 5_000 },
    )
  ).trim();
}

export function isHerdrTimeout(error: unknown): boolean {
  return error instanceof HerdrCommandError && /timed?\s*out|timeout/i.test(error.message);
}
