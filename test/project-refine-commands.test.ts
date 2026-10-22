import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerCommands, parseCommand } from "../pi-extension/project-refine/commands.ts";
import { RefineStore } from "../pi-extension/project-refine/core/storage.ts";
import { discoverProject } from "../pi-extension/project-refine/core/project.ts";
import type { ReviewerCall } from "../pi-extension/project-refine/core/reviewer.ts";
import projectRefine, { supportedPiVersion } from "../pi-extension/project-refine/index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdio: "pipe" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "refine-command-"));
  const project = join(root, "project"); const linked = join(root, "linked worktree"); const agentDir = join(root, "agent"); const sessions = join(root, "sessions");
  await mkdir(project); await mkdir(sessions); await mkdir(agentDir);
  git(project, "init", "-q");
  git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  git(project, "worktree", "add", "--detach", linked, "HEAD");
  const rules = "# Rules\nRun tests.\n";
  await writeFile(join(project, "AGENTS.md"), rules);
  const now = Date.now() - 10000;
  for (const [id, cwd] of [["session-main", project], ["session-linked", linked]]) {
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp: new Date(now).toISOString() },
      { type: "message", id: "u1", parentId: null, timestamp: new Date(now).toISOString(), message: { role: "user", content: "Please use pnpm tests instead of npm tests.", timestamp: now } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date(now + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Understood; I will use pnpm tests." }], stopReason: "stop", timestamp: now + 1000 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: new Date(now + 2000).toISOString(), message: { role: "user", content: "Another unrelated task.", timestamp: now + 2000 } },
    ];
    await writeFile(join(sessions, `${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const snapshot = async () => ({ rules: await readFile(join(project, "AGENTS.md"), "utf8"),
    main: await readFile(join(sessions, "session-main.jsonl"), "utf8"), linked: await readFile(join(sessions, "session-linked.jsonl"), "utf8"),
    mtime: (await stat(join(sessions, "session-main.jsonl"))).mtimeMs,
    index: git(project, "status", "--porcelain").toString() });
  return { root, project, linked, agentDir, sessions, snapshot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function harness(f: Awaited<ReturnType<typeof fixture>>, reviewer: ReviewerCall, hasUI = true, consent = true) {
  const events = new Map<string, (...args: any[]) => any>(); let command: any;
  const output: string[] = []; const notices: string[] = []; const statuses: (string | undefined)[] = [];
  const editorTexts: string[] = [];
  const ctx: any = {
    cwd: f.project, hasUI, mode: hasUI ? "tui" : "print", isProjectTrusted: () => true,
    model: { provider: "test", id: "model", contextWindow: 200000 }, modelRegistry: { streamSimple() {} },
    waitForIdle: async () => {}, sessionManager: { getSessionId: () => "parent", getLeafId: () => null, getSessionDir: () => f.sessions },
    ui: { notify(text: string) { notices.push(text); },
      setStatus(key: string, text: string | undefined) { assert.equal(key, "project-refine"); statuses.push(text); },
      setEditorText(text: string) { editorTexts.push(text); },
      editor: async (_title: string, text: string) => { output.push(text); return text; }, confirm: async () => consent,
      select: async () => "Accept" },
  };
  registerCommands({ on(name: string, fn: any) { events.set(name, fn); }, registerCommand(name: string, tool: any) { assert.equal(name, "project-refine"); command = tool; } } as any,
    { agentDir: f.agentDir, reviewer, output: (text) => output.push(text) });
  return { events, ctx, output, notices, statuses, editorTexts, execute: (args: string) => command.handler(args, ctx) };
}

test("the extension registers commands only, with no startup I/O/model/tool capability", () => {
  const events: string[] = []; const commands: string[] = [];
  projectRefine({ on(name: string) { events.push(name); }, registerCommand(name: string) { commands.push(name); } } as any);
  assert.deepEqual(commands, ["project-refine"]);
  assert.deepEqual(events, ["session_shutdown", "session_start"]);
  assert.equal(supportedPiVersion("0.85.1"), false);
  assert.equal(supportedPiVersion("1.3.0"), true);
  assert.equal(supportedPiVersion("1.4.0"), true);
  assert.equal(supportedPiVersion("2.0.0"), false);
});

test("command arguments are explicit and reject unknown or malformed options", () => {
  const parsed = parseCommand('propose --root "/some path" --since all --session-root /logs --historical-root /old --exclude-worktree /skip --rereview');
  assert.equal(parsed.root, "/some path"); assert.equal(parsed.since, 0); assert.equal(parsed.rereview, true);
  for (const input of ["apply x", "propose --yes", "propose --since yesterday", "propose --root", 'propose --root "missing']) assert.throws(() => parseCommand(input));
});

test("menu selection explains that the prepared command still needs submission", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const h = harness(f, async () => { calls++; return { text: '{"proposals":[]}' }; });
    h.ctx.ui.select = async () => "Propose";
    await h.execute("");
    assert.equal(calls, 0);
    assert.deepEqual(h.editorTexts, ["/project-refine propose"]);
    assert.ok(h.notices.some((text) => text.includes("Submit it to run")));
  } finally { await f.cleanup(); }
});

test("proposal progress starts before the idle wait and distinguishes preparation, consent, and analysis", async () => {
  const f = await fixture();
  try {
    let resume!: () => void;
    const idle = new Promise<void>((resolve) => { resume = resolve; });
    let calls = 0;
    const h = harness(f, async () => {
      calls++;
      assert.match(h.statuses.at(-1)!, /Analyzing/);
      assert.ok(h.notices.some((text) => text.includes("analysis started")));
      return { text: '{"proposals":[]}' };
    });
    h.ctx.waitForIdle = () => {
      assert.match(h.statuses.at(-1)!, /Waiting for the current agent/);
      return idle;
    };
    h.ctx.ui.editor = async (title: string, text: string) => {
      if (title.startsWith("Provider disclosure preview")) {
        assert.equal(calls, 0);
        assert.match(title, /submit to continue/);
        assert.match(h.statuses.at(-1)!, /Awaiting disclosure preview/);
      }
      return text;
    };
    h.ctx.ui.confirm = async () => {
      assert.equal(calls, 0);
      assert.match(h.statuses.at(-1)!, /Awaiting provider consent/);
      return true;
    };
    const pending = h.execute(`propose --session-root "${f.sessions}"`);
    assert.equal(calls, 0);
    assert.match(h.statuses.at(-1)!, /Waiting/);
    resume();
    await pending;
    assert.equal(calls, 1, h.notices.join("\n"));
    for (const stage of ["Discovering", "Inventorying", "Scanning", "Preparing", "Saving"]) {
      assert.ok(h.statuses.some((text) => text?.startsWith(stage)), `${stage} progress must be visible`);
    }
    assert.equal(h.statuses.at(-1), undefined);
  } finally { await f.cleanup(); }
});

test("cancelling during the visible idle wait clears progress without starting analysis", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const h = harness(f, async () => { calls++; return { text: '{"proposals":[]}' }; });
    h.ctx.waitForIdle = () => new Promise<void>(() => {});
    const pending = h.execute("propose");
    assert.match(h.statuses.at(-1)!, /Waiting for the current agent/);
    await h.execute("cancel");
    await pending;
    assert.equal(calls, 0);
    assert.equal(h.output.length, 0);
    assert.equal(h.statuses.at(-1), undefined);
  } finally { await f.cleanup(); }
});

test("cancelled preview and declined consent explicitly explain why analysis did not start", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const reviewer: ReviewerCall = async () => { calls++; return { text: '{"proposals":[]}' }; };
    const cancelled = harness(f, reviewer);
    cancelled.ctx.ui.editor = async () => undefined;
    await cancelled.execute(`propose --session-root "${f.sessions}"`);
    assert.ok(cancelled.notices.some((text) => /preview cancelled.*No model call made/.test(text)));
    assert.equal(cancelled.statuses.at(-1), undefined);
    const declined = harness(f, reviewer, true, false);
    await declined.execute(`propose --session-root "${f.sessions}"`);
    assert.ok(declined.notices.some((text) => /disclosure declined.*No model call made/.test(text)));
    assert.equal(declined.statuses.at(-1), undefined);
    assert.equal(calls, 0);
    assert.ok(![...cancelled.notices, ...declined.notices].some((text) => text.includes("analysis started")));
  } finally { await f.cleanup(); }
});

test("end-to-end proposal uses both worktrees, requires preview/consent, persists review only, and skips covered evidence", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot(); let calls = 0; let worktrees = 0;
    const h = harness(f, async (_system, payload) => {
      calls++;
      const data = JSON.parse(payload); worktrees = new Set(data.episodes.map((e: any) => e.worktreeId)).size;
      const citation = data.episodes.flatMap((e: any) => e.excerpts).find((e: any) => e.source === "human");
      const target = data.resources.find((r: any) => r.path === "AGENTS.md");
      return { text: JSON.stringify({ proposals: [{ category: "instructions", scope: "project-wide", problem: "Document the test runner", suggestion: "Use pnpm tests in this project.",
        expectedEffect: "Avoid repeated runner corrections.", exceptions: "Not measured; only this repository.", confidence: "medium",
        citations: [{ entryId: citation.entryId, quote: citation.text }], edits: [{ path: target.path, baseHash: target.hash, oldText: "Run tests.", newText: "Run pnpm tests." }] }] }),
        usage: { input: 120, output: 60, totalTokens: 180, cost: 0.001 } };
    });
    await h.execute(`propose --session-root "${f.sessions}"`);
    assert.equal(calls, 1); assert.equal(worktrees, 2);
    assert.ok(h.output.some((text) => text.includes("Disclosure preview")));
    assert.deepEqual(await f.snapshot(), before);
    const scope = await discoverProject(f.project);
    const store = new RefineStore(f.agentDir, scope.id);
    const runs = await store.listRuns();
    assert.equal(runs.length, 1); assert.equal(runs[0].status, "success"); assert.equal(runs[0].proposals.length, 1);
    assert.equal(runs[0].coverage.matchedSessions, 2); assert.equal(runs[0].usage[0].totalTokens, 180);
    await h.execute(`review ${runs[0].proposals[0].id}`);
    assert.equal((await store.loadState()).decisions.at(-1)?.decision, "accepted");
    assert.deepEqual(await f.snapshot(), before);
    await h.execute(`propose --session-root "${f.sessions}"`);
    assert.equal(calls, 1);
    assert.ok(h.output.some((text) => text.includes("No uncovered evidence")));
  } finally { await f.cleanup(); }
});

test("disclosure preview includes the exact serialized provider payload", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, "AGENTS.md"), 'API_KEY="fixture-only"\n');
    let sentPayload = "";
    const h = harness(f, async (_system, payload) => {
      sentPayload = payload;
      return { text: '{"proposals":[]}' };
    });
    await h.execute(`propose --session-root "${f.sessions}"`);
    assert.ok(sentPayload);
    assert.ok(h.output.some((preview) => preview.includes(sentPayload)), "JSON escaping must remain byte-identical in the preview");
    assert.ok(!sentPayload.includes("fixture-only"));
    assert.equal(JSON.parse(sentPayload).resources[0].editable, false);
  } finally {
    await f.cleanup();
  }
});

test("target-checkout evidence can be excluded without excluding its resources", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const h = harness(f, async (_system, payload) => {
      calls++;
      const data = JSON.parse(payload);
      assert.deepEqual(data.episodes.map((episode: { sessionId: string }) => episode.sessionId), ["session-linked"]);
      assert.ok(data.resources.some((resource: { path: string }) => resource.path === "AGENTS.md"));
      return { text: '{"proposals":[]}' };
    });
    await h.execute(`propose --session-root "${f.sessions}" --exclude-worktree "${f.project}"`);
    assert.equal(calls, 1, h.notices.join("\n"));
  } finally {
    await f.cleanup();
  }
});

test("noninteractive/untrusted/declined runs cannot invoke the reviewer or change source files", async () => {
  const f = await fixture();
  try {
    let calls = 0; const reviewer: ReviewerCall = async () => { calls++; return { text: '{"proposals":[]}' }; };
    const before = await f.snapshot();
    const print = harness(f, reviewer, false); await print.execute("propose"); assert.equal(calls, 0);
    assert.ok(print.output.some((text) => text.includes("consent")));
    const declined = harness(f, reviewer, true, false); await declined.execute(`propose --session-root "${f.sessions}"`); assert.equal(calls, 0);
    const untrusted = harness(f, reviewer); untrusted.ctx.isProjectTrusted = () => false; await untrusted.execute("audit");
    assert.equal(calls, 0); assert.ok(untrusted.notices.some((text) => text.includes("trusted")));
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.cleanup(); }
});

test("invalid responses do not consume coverage and user cancellation records no success", async () => {
  const f = await fixture();
  try {
    const invalid = harness(f, async () => ({ text: "malformed" }));
    await invalid.execute(`propose --session-root "${f.sessions}"`);
    const scope = await discoverProject(f.project); const store = new RefineStore(f.agentDir, scope.id);
    assert.equal((await store.listRuns())[0].status, "failed"); assert.deepEqual((await store.loadState()).covered, {});
    let started!: () => void; const reached = new Promise<void>((resolve) => { started = resolve; });
    const pending = harness(f, async () => { started(); return new Promise(() => {}); });
    const result = pending.execute(`propose --session-root "${f.sessions}"`);
    await reached; await pending.execute("cancel"); await result;
    assert.ok((await store.listRuns()).some((run) => run.status === "aborted"));
    assert.deepEqual((await store.loadState()).covered, {});
  } finally { await f.cleanup(); }
});

test("shutdown during model call discards late results without advancing coverage", async () => {
  const f = await fixture();
  try {
    let started!: () => void; const reached = new Promise<void>((resolve) => { started = resolve; });
    const h = harness(f, async () => { started(); return new Promise(() => {}); });
    const before = await f.snapshot();
    const pending = h.execute(`propose --session-root "${f.sessions}"`);
    await reached; h.events.get("session_shutdown")?.(); await pending;
    const scope = await discoverProject(f.project); const store = new RefineStore(f.agentDir, scope.id);
    assert.deepEqual((await store.loadState()).covered, {});
    assert.equal((await store.listRuns()).length, 0);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await f.cleanup(); }
});
