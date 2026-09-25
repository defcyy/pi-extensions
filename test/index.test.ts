import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import herdrSubagents, { __test__ } from "../pi-extension/herdr-subagents/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await delay(10);
  }
}

function makeHarness(sessionId: string) {
  const events = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: unknown[] = [];
  const pi: any = {
    on(name: string, handler: (...args: any[]) => any) {
      events.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    appendEntry(_type: string, entry: unknown) {
      entries.push(entry);
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  };
  // This harness models an unmarked parent. Keep its role independent of a
  // delegated worker's inherited environment when the suite is run there.
  const workerEnv = [
    "PI_HERDR_SUBAGENT",
    "PI_HERDR_HANDOVER_FILE",
    "PI_HERDR_JOB_ID",
  ] as const;
  const previousWorkerEnv = Object.fromEntries(workerEnv.map((name) => [name, process.env[name]]));
  for (const name of workerEnv) delete process.env[name];
  try {
    herdrSubagents(pi);
  } finally {
    for (const name of workerEnv) {
      if (previousWorkerEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousWorkerEnv[name];
    }
  }

  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
    scopedModels: [],
    thinkingLevel: "low",
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget() {}, notify() {} },
  };
  events.get("session_start")?.({}, ctx);
  return { ctx, entries, events, messages, tools };
}

interface FakeHerdr {
  closed: string;
  splitStarted: string;
  cleanup(): void;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function useFakeHerdr(scenario: string): FakeHerdr {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-index-"));
  const executable = join(dir, "herdr");
  const closed = join(dir, "pane-closed");
  const splitStarted = join(dir, "split-started");
  const handoverState = join(dir, "handover-state.json");
  const script = join(dir, "fake-herdr.cjs");
  // Some endpoint-security agents SIGKILL `node <script>` when any argument
  // is 1000+ characters, and pane split passes the full PATH as one. The
  // executable is therefore a shell shim that hands its argv to Node through a
  // NUL-separated file, so the Node process only ever sees short arguments.
  writeFileSync(
    executable,
    `#!/bin/sh
args_file=$(mktemp ${shellQuote(join(dir, "args.XXXXXX"))}) || exit 1
printf '%s\\0' "$@" > "$args_file"
exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$args_file"
`,
  );
  writeFileSync(
    script,
    `const fs = require("node:fs");
const argsFile = process.argv[2];
const args = fs.readFileSync(argsFile, "utf8").split("\\0").slice(0, -1);
fs.rmSync(argsFile, { force: true });
const command = args.slice(0, 2).join(" ");
const agent = (name, status = "idle", paneId = "w-test:child", session = "session-a") => ({
  agent: "pi", name, agent_status: status,
  agent_session: {agent:"pi", kind:"path", value:session},
  pane_id: paneId, tab_id: "w-test:t1", workspace_id: "w-test", focused: false
});
if (command === "pane layout") {
  console.log(JSON.stringify({result:{layout:{area:{width:160,height:60},panes:[{pane_id:"w-test:main",rect:{width:160,height:60,x:0,y:0}}]}}}));
} else if (command === "pane split") {
  fs.writeFileSync(process.env.FAKE_SPLIT_STARTED, "started");
  const handoverFile = args.find((arg) => arg.startsWith("PI_HERDR_HANDOVER_FILE="))?.slice("PI_HERDR_HANDOVER_FILE=".length);
  const jobId = args.find((arg) => arg.startsWith("PI_HERDR_JOB_ID="))?.slice("PI_HERDR_JOB_ID=".length);
  if (handoverFile && jobId) fs.writeFileSync(process.env.FAKE_HANDOVER_STATE, JSON.stringify({ handoverFile, jobId }));
  setTimeout(() => console.log(JSON.stringify({result:{pane:{pane_id:"w-test:child",tab_id:"w-test:t1",workspace_id:"w-test"}}})), process.env.FAKE_SCENARIO === "pending" ? 150 : 0);
} else if (command === "pane close") {
  fs.writeFileSync(process.env.FAKE_PANE_CLOSED, "closed");
  setTimeout(() => process.exit(0), process.env.FAKE_SCENARIO === "close-race" ? 200 : 0);
} else if (command === "agent start") {
  if (process.env.FAKE_START_ARGS) fs.writeFileSync(process.env.FAKE_START_ARGS, JSON.stringify(args));
  if (process.env.FAKE_SCENARIO === "wait-mismatch") {
    console.error(JSON.stringify({error:{message:"simulated start failure"}}));
    process.exit(1);
  }
  const pane = process.env.FAKE_SCENARIO === "wrong-recovery" ? "w-test:other" : "w-test:child";
  console.log(JSON.stringify({result:{agent:agent(args[2], "idle", pane)}}));
} else if (command === "agent get") {
  const pane = process.env.FAKE_SCENARIO === "wrong-recovery" ? "w-test:other" : "w-test:child";
  const status = ["wait-mismatch", "delayed-handover"].includes(process.env.FAKE_SCENARIO) ? "working" : "idle";
  console.log(JSON.stringify({result:{agent:agent(args[2], status, pane)}}));
} else if (command === "agent wait") {
  if (process.env.FAKE_SCENARIO === "delayed-handover") {
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_HANDOVER_STATE, "utf8"));
    fs.writeFileSync(state.handoverFile, JSON.stringify({
      type: "caller_ping", jobId: state.jobId,
      task: "Audit the delayed migration", reason: "It can run independently"
    }));
    console.log(JSON.stringify({result:{agent:agent(args[2], "done")}}));
  } else {
    console.log(JSON.stringify({result:{agent:agent("foreign-agent", "idle", "w-test:other")}}));
  }
} else if (command === "agent read") {
  console.log("Worker result");
} else if (command === "agent prompt") {
  if (process.env.FAKE_SCENARIO === "delayed-handover") {
    console.error(JSON.stringify({error:{message:"timed out"}}));
    process.exit(1);
  } else if (process.env.FAKE_SCENARIO === "handover") {
    const state = JSON.parse(fs.readFileSync(process.env.FAKE_HANDOVER_STATE, "utf8"));
    fs.writeFileSync(state.handoverFile, JSON.stringify({
      type: "caller_ping", jobId: state.jobId,
      task: "Review the migration ordering", reason: "It is independent parallel work", context: "Inspect db/migrations"
    }));
    console.error(JSON.stringify({error:{message:"worker exited after handover"}}));
    process.exit(1);
  } else if (process.env.FAKE_SCENARIO === "prompt-mismatch") {
    console.log(JSON.stringify({result:{agent:agent("foreign-agent", "idle", "w-test:other")}}));
  } else if (process.env.FAKE_SCENARIO === "prompt-session-mismatch") {
    console.log(JSON.stringify({result:{agent:agent(args[2], "idle", "w-test:child", "session-b")}}));
  } else if (process.env.FAKE_SCENARIO === "success") {
    console.log(JSON.stringify({result:{agent:agent(args[2])}}));
  } else {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_PANE_CLOSED)) return;
      clearInterval(timer);
      console.error(JSON.stringify({error:{message:"pane closed while waiting"}}));
      process.exit(1);
    }, 5);
  }
} else if (command === "agent read") {
  process.stdout.write("screen output");
} else {
  console.log(JSON.stringify({result:{}}));
}
`,
  );
  chmodSync(executable, 0o755);

  const previous = {
    path: process.env.PATH,
    herdrEnv: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
    workspace: process.env.HERDR_WORKSPACE_ID,
    fenceSandbox: process.env.FENCE_SANDBOX,
    startArgs: process.env.FAKE_START_ARGS,
  };
  process.env.PATH = `${dir}:${previous.path ?? ""}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w-test:main";
  process.env.HERDR_WORKSPACE_ID = "w-test";
  process.env.FENCE_SANDBOX = "1";
  process.env.FAKE_SCENARIO = scenario;
  process.env.FAKE_PANE_CLOSED = closed;
  process.env.FAKE_SPLIT_STARTED = splitStarted;
  process.env.FAKE_HANDOVER_STATE = handoverState;

  return {
    closed,
    splitStarted,
    cleanup() {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.herdrEnv === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = previous.herdrEnv;
      if (previous.pane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previous.pane;
      if (previous.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = previous.workspace;
      if (previous.fenceSandbox === undefined) delete process.env.FENCE_SANDBOX;
      else process.env.FENCE_SANDBOX = previous.fenceSandbox;
      if (previous.startArgs === undefined) delete process.env.FAKE_START_ARGS;
      else process.env.FAKE_START_ARGS = previous.startArgs;
      delete process.env.FAKE_SCENARIO;
      delete process.env.FAKE_PANE_CLOSED;
      delete process.env.FAKE_SPLIT_STARTED;
      delete process.env.FAKE_HANDOVER_STATE;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function shutdown(harness: ReturnType<typeof makeHarness>): void {
  harness.events.get("session_shutdown")?.();
}

function dispatch(
  harness: ReturnType<typeof makeHarness>,
  task: string,
  parallelReason = "The parent continues independent work",
) {
  return harness.tools.get("herdr_subagent").execute(
    "dispatch",
    { task, parallelReason },
    undefined,
    undefined,
    harness.ctx,
  );
}

test("delegated workers expose only caller_ping and produce a parent handover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-handover-"));
  const handoverFile = join(dir, "handover.json");
  const previous = {
    marker: process.env.PI_HERDR_SUBAGENT,
    file: process.env.PI_HERDR_HANDOVER_FILE,
    jobId: process.env.PI_HERDR_JOB_ID,
  };
  process.env.PI_HERDR_SUBAGENT = "1";
  process.env.PI_HERDR_HANDOVER_FILE = handoverFile;
  process.env.PI_HERDR_JOB_ID = "job-1";
  const tools = new Map<string, any>();
  const events = new Map<string, (...args: any[]) => any>();
  const commands: string[] = [];
  try {
    herdrSubagents({
      on(name: string, handler: (...args: any[]) => any) { events.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string) { commands.push(name); },
      registerMessageRenderer() {},
    } as any);
    assert.deepEqual([...tools.keys()], ["caller_ping"]);
    assert.deepEqual(commands, []);
    assert.match(
      events.get("before_agent_start")?.({ systemPrompt: "base" }).systemPrompt,
      /one-shot worker, not the parent orchestrator/,
    );

    let shutDown = false;
    await assert.rejects(
      tools.get("caller_ping").execute(
        "blank-ping",
        { task: "   ", reason: "parallel" },
        undefined,
        undefined,
        { shutdown() { shutDown = true; } },
      ),
      /cannot be blank/,
    );
    assert.equal(shutDown, false);
    assert.equal(existsSync(handoverFile), false);

    await tools.get("caller_ping").execute(
      "ping-1",
      { task: "Review the database migration", reason: "It can run independently", context: "See db/" },
      undefined,
      undefined,
      { shutdown() { shutDown = true; } },
    );
    assert.equal(shutDown, true);
    assert.deepEqual(JSON.parse(readFileSync(handoverFile, "utf8")), {
      type: "caller_ping",
      jobId: "job-1",
      task: "Review the database migration",
      reason: "It can run independently",
      context: "See db/",
    });
  } finally {
    if (previous.marker === undefined) delete process.env.PI_HERDR_SUBAGENT;
    else process.env.PI_HERDR_SUBAGENT = previous.marker;
    if (previous.file === undefined) delete process.env.PI_HERDR_HANDOVER_FILE;
    else process.env.PI_HERDR_HANDOVER_FILE = previous.file;
    if (previous.jobId === undefined) delete process.env.PI_HERDR_JOB_ID;
    else process.env.PI_HERDR_JOB_ID = previous.jobId;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown during pane creation closes the unused pane", async () => {
  const fake = useFakeHerdr("pending");
  const harness = makeHarness("session-pending");
  try {
    const dispatchTool = harness.tools.get("herdr_subagent");
    await assert.rejects(
      dispatchTool.execute(
        "invalid",
        { task: "review shutdown", parallelReason: "   " },
        undefined,
        undefined,
        harness.ctx,
      ),
      /parallelReason cannot be empty or whitespace/,
    );
    const result = dispatch(harness, "review shutdown", "The parent continues shutdown handling");
    await waitFor(() => existsSync(fake.splitStarted));
    shutdown(harness);

    await assert.rejects(result, /parent Pi session ended/);
    assert.equal(existsSync(fake.closed), true);
    assert.equal(__test__.runningJobs.size, 0);
  } finally {
    fake.cleanup();
  }
});

test("closing an owned active job stops it without delivering a failure", async () => {
  const fake = useFakeHerdr("close-race");
  const harness = makeHarness("session-close");
  try {
    const queued = await dispatch(harness, "remain active");
    const jobId = queued.details.id as string;
    await waitFor(() => __test__.runningJobs.get(jobId)?.state === "working");

    await harness.tools.get("herdr_subagent_control").execute(
      "control-1",
      { jobId, action: "close" },
      undefined,
    );
    await waitFor(() => !__test__.runningJobs.has(jobId));

    assert.equal(existsSync(fake.closed), true);
    assert.deepEqual(harness.entries, []);
    assert.deepEqual(harness.messages, []);
  } finally {
    shutdown(harness);
    fake.cleanup();
  }
});

test("a successful one-shot worker uses the parent model and closes its pane", async () => {
  const fake = useFakeHerdr("success");
  const startArgs = join(fake.closed, "..", "agent-start-args.json");
  const harness = makeHarness("session-success");
  try {
    process.env.FAKE_START_ARGS = startArgs;
    const queued = await dispatch(
      harness,
      "Review the API",
      "The parent updates independent documentation",
    );
    await waitFor(() => !__test__.runningJobs.has(queued.details.id));

    const completion = harness.entries.at(-1);
    assert.equal(completion.details.status, "completed");
    assert.match(completion.content, /Worker result/);
    const args = JSON.parse(readFileSync(startArgs, "utf8")) as string[];
    assert.equal(args[0], "agent");
    assert.equal(args[1], "start");
    assert.equal(args[args.indexOf("--model") + 1], "test/model");
    assert.equal(args[args.indexOf("--thinking") + 1], "low");
    assert.equal(existsSync(fake.closed), true);
  } finally {
    shutdown(harness);
    fake.cleanup();
  }
});

test("caller_ping returns a proposal to the main agent without spawning a child", async () => {
  const fake = useFakeHerdr("handover");
  const harness = makeHarness("session-handover");
  try {
    const queued = await dispatch(
      harness,
      "Implement the API",
      "The parent updates independent documentation",
    );
    await waitFor(() => !__test__.runningJobs.has(queued.details.id));

    const completion = harness.entries.at(-1);
    assert.equal(completion.details.status, "handover");
    assert.match(completion.content, /Proposed task: Review the migration ordering/);
    assert.match(completion.content, /has not started another subagent/);
    assert.equal(existsSync(fake.closed), true);
  } finally {
    shutdown(harness);
    fake.cleanup();
  }
});

test("caller_ping is still delivered after the initial prompt wait times out", async () => {
  const fake = useFakeHerdr("delayed-handover");
  const harness = makeHarness("session-delayed-handover");
  try {
    const queued = await dispatch(
      harness,
      "Implement the API",
      "The parent updates independent documentation",
    );
    await waitFor(() => !__test__.runningJobs.has(queued.details.id));

    assert.deepEqual(
      harness.entries.map((entry) => entry.details.status),
      ["timed-out", "handover"],
    );
    assert.equal(existsSync(fake.closed), true);
  } finally {
    shutdown(harness);
    fake.cleanup();
  }
});

const identityFailures = [
  { scenario: "wrong-recovery", error: /expected pane_id "w-test:child"/ },
  { scenario: "wait-mismatch", error: /expected w-test:child/ },
  { scenario: "prompt-mismatch", error: /expected w-test:child/ },
  { scenario: "prompt-session-mismatch", error: /different Pi session/ },
];

for (const { scenario, error } of identityFailures) {
  test(`identity failure ${scenario} fails safely and retains the pane`, async () => {
    const fake = useFakeHerdr(scenario);
    const harness = makeHarness(`session-${scenario}`);
    try {
      const queued = await dispatch(
        harness,
        "verify child identity",
        "The parent verifies another component",
      );
      await waitFor(() => !__test__.runningJobs.has(queued.details.id));

      const completion = harness.entries.at(-1);
      assert.equal(completion.details.status, "failed");
      assert.match(completion.details.error, error);
      assert.equal(existsSync(fake.closed), false);
    } finally {
      shutdown(harness);
      fake.cleanup();
    }
  });
}
