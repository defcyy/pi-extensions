import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import projectRefine, { supportedPiVersion } from "../pi-extension/project-refine/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function harness() {
  let command: Command | undefined;
  const messages: Array<{ content: string; options: unknown }> = [];
  const notices: string[] = [];
  const pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage"> = {
    registerCommand(name, value) { assert.equal(name, "project-refine"); assert.equal(command, undefined); command = value; },
    sendUserMessage(content, options) { assert.ok(typeof content === "string"); messages.push({ content, options }); },
  };
  const ctx = {
    cwd: "/projects/current checkout", hasUI: false,
    isProjectTrusted: () => true, isIdle: () => true,
    model: { provider: "router", id: "auto", api: "pi-virtual", contextWindow: 0 } as object | undefined,
    sessionManager: {
      getSessionDir: () => "/sessions/custom",
      getSessionId: () => "current-session",
      getSessionFile: (): string | undefined => "/sessions/custom/current.jsonl",
      getLeafId: (): string | null => "before-refinement",
    },
    // Deliberately omit dialogs, model calls and lifecycle APIs.
    ui: { notify(text: string) { notices.push(text); } },
  };
  projectRefine(pi as ExtensionAPI);
  assert.ok(command);
  const registered = command;
  return { ctx, messages, notices, execute: (focus = "") => registered.handler(focus, ctx as unknown as ExtensionCommandContext) };
}

function setEnv(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

function contextOf(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf("{")));
}

test("supported Pi version range is unchanged", () => {
  for (const version of ["1.3.0", "1.4.0", "1.3.0-beta"]) assert.equal(supportedPiVersion(version), true);
  for (const version of ["0.85.1", "1.2.9", "2.0.0", "invalid"]) assert.equal(supportedPiVersion(version), false);
});

test("registers one command and dispatches one normal turn without dialogs or special provider handling", async () => {
  const h = harness();
  assert.equal(h.messages.length, 0, "registration must not start work");
  await h.execute();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options, undefined, "must not steer or queue into another task");
  assert.deepEqual(h.notices, []);
});

test("includes project/session metadata and resolves an additional session store from cwd", async (t) => {
  setEnv(t, "PI_CODING_AGENT_SESSION_DIR", "relative store");
  const h = harness();
  await h.execute();
  assert.deepEqual(contextOf(h.messages[0].content), {
    cwd: h.ctx.cwd,
    sessionRoots: [join(getAgentDir(), "sessions"), "/sessions/custom", resolve(h.ctx.cwd, "relative store")],
    currentSession: { id: "current-session", file: "/sessions/custom/current.jsonl", entryCutoff: "before-refinement" },
  });
});

test("deduplicates session roots and respects the resolved Pi agent directory", async (t) => {
  setEnv(t, "PI_CODING_AGENT_DIR", "/custom/agent");
  setEnv(t, "PI_CODING_AGENT_SESSION_DIR", "/custom/agent/sessions");
  const h = harness();
  h.ctx.sessionManager.getSessionDir = () => "/custom/agent/sessions";
  await h.execute();
  assert.deepEqual(contextOf(h.messages[0].content).sessionRoots, ["/custom/agent/sessions"]);
});

test("preserves optional focus as data rather than parsing subcommands or shell syntax", async () => {
  const h = harness();
  const focus = 'Focus on testing skills; $(not-a-command)\n"quoted"';
  await h.execute(`  ${focus}  `);
  assert.equal(contextOf(h.messages[0].content).focus, focus);
});

test("omits blank focus and supports a session without a persisted file or leaf", async () => {
  const h = harness();
  h.ctx.sessionManager.getSessionFile = () => undefined;
  h.ctx.sessionManager.getLeafId = () => null;
  await h.execute("  ");
  const context = contextOf(h.messages[0].content);
  assert.equal(Object.hasOwn(context, "focus"), false);
  assert.deepEqual(context.currentSession, { id: "current-session", entryCutoff: null });
});

for (const guard of ["trust", "busy", "model"]) {
  test(`${guard} guard blocks dispatch before collecting metadata`, async () => {
    const h = harness();
    if (guard === "trust") h.ctx.isProjectTrusted = () => false;
    else if (guard === "busy") h.ctx.isIdle = () => false;
    else h.ctx.model = undefined;
    h.ctx.sessionManager.getSessionDir = () => { throw new Error("must not collect metadata when guarded"); };
    await h.execute();
    assert.deepEqual(h.messages, []);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], guard === "trust" ? /trusted/ : guard === "busy" ? /current task/ : /Select a model/);
  });
}

test("dispatched prompt retains the setup-only scope, evidence safeguards and approval boundary", async () => {
  const h = harness();
  await h.execute();
  const prompt = h.messages[0].content;
  assert.match(prompt, /project-local AGENTS\.md[\s\S]*agent configuration/);
  assert.match(prompt, /Do not propose application\/extension implementation/);
  assert.match(prompt, /stop at entryCutoff[\s\S]*omitting thinking, hidden\/system content and credentials/);
  assert.match(prompt, /do not count them as independent feedback/);
  assert.match(prompt, /Read-only until I approve specific changes:[\s\S]*Ask which proposals I approve, then end the turn and wait/);
});
