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
  const entries: unknown[] = [];
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
  herdrSubagents(pi);

  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "test", id: "model" },
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "model" }],
    },
    scopedModels: [],
    thinkingLevel: "low",
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget() {}, notify() {} },
  };
  events.get("session_start")?.({}, ctx);
  return { ctx, entries, events, messages, tools };
}

test("guards pending-dispatch, close-control, and agent-identity races", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-index-"));
  const executable = join(dir, "herdr");
  const log = join(dir, "commands.log");
  const marker = join(dir, "pane-closed");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
fs.appendFileSync(process.env.FAKE_HERDR_LOG, args.join(" ") + "\\n");
const agent = (name, status = "idle", paneId, session = "session-a") => ({
  agent: "pi", name, agent_status: status,
  agent_session: {agent:"pi", kind:"path", value:session},
  pane_id: paneId || (process.env.FAKE_SCENARIO === "wrong-recovery" ? "w-test:other" : "w-test:child"),
  tab_id: "w-test:t1", workspace_id: "w-test", focused: false
});
if (command === "pane layout") {
  console.log(JSON.stringify({result:{layout:{area:{width:160,height:60},panes:[{pane_id:"w-test:main",rect:{width:160,height:60,x:0,y:0}}]}}}));
} else if (command === "pane split") {
  setTimeout(() => console.log(JSON.stringify({result:{pane:{pane_id:"w-test:child",tab_id:"w-test:t1",workspace_id:"w-test"}}})), process.env.FAKE_SCENARIO === "pending" ? 150 : 0);
} else if (command === "pane close") {
  fs.writeFileSync(process.env.FAKE_HERDR_MARKER, "closed");
  setTimeout(() => process.exit(0), process.env.FAKE_SCENARIO === "close-race" ? 200 : 0);
} else if (command === "agent start") {
  const name = args[2];
  if (process.env.FAKE_SCENARIO === "wait-mismatch") {
    console.error(JSON.stringify({error:{message:"simulated start failure"}}));
    process.exit(1);
  } else {
    console.log(JSON.stringify({result:{agent:agent(name)}}));
  }
} else if (command === "agent get") {
  const status = process.env.FAKE_SCENARIO === "wait-mismatch" ? "working" : "idle";
  console.log(JSON.stringify({result:{agent:agent(args[2], status)}}));
} else if (command === "agent wait") {
  console.log(JSON.stringify({result:{agent:agent("foreign-agent", "idle", "w-test:other")}}));
} else if (command === "agent prompt") {
  if (process.env.FAKE_SCENARIO === "prompt-mismatch") {
    console.log(JSON.stringify({result:{agent:agent("foreign-agent", "idle", "w-test:other")}}));
  } else if (process.env.FAKE_SCENARIO === "prompt-session-mismatch") {
    console.log(JSON.stringify({result:{agent:agent(args[2], "idle", "w-test:child", "session-b")}}));
  } else {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_HERDR_MARKER)) return;
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

  const old = {
    path: process.env.PATH,
    herdrEnv: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
    workspace: process.env.HERDR_WORKSPACE_ID,
    fenceSandbox: process.env.FENCE_SANDBOX,
  };
  process.env.PATH = `${dir}:${old.path ?? ""}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w-test:main";
  process.env.HERDR_WORKSPACE_ID = "w-test";
  process.env.FENCE_SANDBOX = "1";
  process.env.FAKE_HERDR_LOG = log;
  process.env.FAKE_HERDR_MARKER = marker;

  try {
    process.env.FAKE_SCENARIO = "pending";
    const pendingHarness = makeHarness("session-old");
    const dispatch = pendingHarness.tools.get("herdr_subagent");
    await assert.rejects(
      dispatch.execute("blank", { task: "   " }, undefined, undefined, pendingHarness.ctx),
      /task cannot be empty or whitespace/,
    );
    const dispatchPromise = dispatch.execute(
      "call-1",
      { task: "review pending shutdown", reuse: "never", retention: "interactive" },
      undefined,
      undefined,
      pendingHarness.ctx,
    );
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("pane split"));
    pendingHarness.events.get("session_shutdown")?.();
    await assert.rejects(dispatchPromise, /parent Pi session ended/);
    const pendingLog = readFileSync(log, "utf8");
    assert.match(pendingLog, /pane close/);
    assert.match(pendingLog, /--env PATH=.*fenced-bin/);
    assert.doesNotMatch(pendingLog, /agent start/);
    assert.equal(__test__.runningJobs.size, 0);
    assert.equal(__test__.reservedPanes.size, 0);

    writeFileSync(log, "");
    rmSync(marker, { force: true });
    process.env.FAKE_SCENARIO = "close-race";
    const closeHarness = makeHarness("session-close");
    const closeDispatch = closeHarness.tools.get("herdr_subagent");
    const queued = await closeDispatch.execute(
      "call-2",
      { task: "remain active until closed", reuse: "never", retention: "interactive" },
      undefined,
      undefined,
      closeHarness.ctx,
    );
    const jobId = queued.details.id as string;
    await waitFor(() => readFileSync(log, "utf8").includes("agent prompt"));

    const control = closeHarness.tools.get("herdr_subagent_control");
    await control.execute("control-1", { jobId, action: "close" }, undefined);
    await waitFor(() => !__test__.runningJobs.has(jobId));
    assert.equal(closeHarness.entries.length, 0);
    assert.equal(closeHarness.messages.length, 0);
    closeHarness.events.get("session_shutdown")?.();

    writeFileSync(log, "");
    rmSync(marker, { force: true });
    process.env.FAKE_SCENARIO = "wrong-recovery";
    const identityHarness = makeHarness("session-identity");
    const identityDispatch = identityHarness.tools.get("herdr_subagent");
    const identityQueued = await identityDispatch.execute(
      "call-3",
      { task: "do not prompt a mismatched recovered agent", reuse: "never" },
      undefined,
      undefined,
      identityHarness.ctx,
    );
    await waitFor(() => !__test__.runningJobs.has(identityQueued.details.id));
    assert.doesNotMatch(readFileSync(log, "utf8"), /agent prompt|pane close/);
    identityHarness.events.get("session_shutdown")?.();

    writeFileSync(log, "");
    rmSync(marker, { force: true });
    process.env.FAKE_SCENARIO = "wait-mismatch";
    const waitHarness = makeHarness("session-wait-identity");
    const waitDispatch = waitHarness.tools.get("herdr_subagent");
    const waitQueued = await waitDispatch.execute(
      "call-4",
      { task: "do not prompt an agent returned from the wrong pane", reuse: "never" },
      undefined,
      undefined,
      waitHarness.ctx,
    );
    await waitFor(() => !__test__.runningJobs.has(waitQueued.details.id));
    const waitLog = readFileSync(log, "utf8");
    assert.match(waitLog, /agent wait/);
    assert.doesNotMatch(waitLog, /agent prompt|pane close/);
    assert.equal((waitHarness.entries.at(-1) as any).details.status, "failed");
    assert.match((waitHarness.entries.at(-1) as any).details.error, /expected w-test:child/);
    waitHarness.events.get("session_shutdown")?.();

    writeFileSync(log, "");
    rmSync(marker, { force: true });
    process.env.FAKE_SCENARIO = "prompt-mismatch";
    const promptHarness = makeHarness("session-prompt-identity");
    const promptDispatch = promptHarness.tools.get("herdr_subagent");
    const promptQueued = await promptDispatch.execute(
      "call-5",
      { task: "reject a prompt completion from the wrong pane", reuse: "never" },
      undefined,
      undefined,
      promptHarness.ctx,
    );
    await waitFor(() => !__test__.runningJobs.has(promptQueued.details.id));
    const promptLog = readFileSync(log, "utf8");
    assert.match(promptLog, /agent prompt/);
    assert.doesNotMatch(promptLog, /pane close/);
    assert.equal((promptHarness.entries.at(-1) as any).details.status, "failed");
    assert.match((promptHarness.entries.at(-1) as any).details.error, /expected w-test:child/);
    promptHarness.events.get("session_shutdown")?.();

    writeFileSync(log, "");
    rmSync(marker, { force: true });
    process.env.FAKE_SCENARIO = "prompt-session-mismatch";
    const sessionHarness = makeHarness("session-prompt-session-identity");
    const sessionDispatch = sessionHarness.tools.get("herdr_subagent");
    const sessionQueued = await sessionDispatch.execute(
      "call-6",
      { task: "reject a prompt completion from another Pi session", reuse: "never" },
      undefined,
      undefined,
      sessionHarness.ctx,
    );
    await waitFor(() => !__test__.runningJobs.has(sessionQueued.details.id));
    const sessionLog = readFileSync(log, "utf8");
    assert.match(sessionLog, /agent prompt/);
    assert.doesNotMatch(sessionLog, /pane close/);
    assert.equal((sessionHarness.entries.at(-1) as any).details.status, "failed");
    assert.match((sessionHarness.entries.at(-1) as any).details.error, /different Pi session/);
    sessionHarness.events.get("session_shutdown")?.();
  } finally {
    if (old.path === undefined) delete process.env.PATH;
    else process.env.PATH = old.path;
    if (old.herdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = old.herdrEnv;
    if (old.pane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = old.pane;
    if (old.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = old.workspace;
    if (old.fenceSandbox === undefined) delete process.env.FENCE_SANDBOX;
    else process.env.FENCE_SANDBOX = old.fenceSandbox;
    delete process.env.FAKE_HERDR_LOG;
    delete process.env.FAKE_HERDR_MARKER;
    delete process.env.FAKE_SCENARIO;
    rmSync(dir, { recursive: true, force: true });
  }
});
