import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { registerCommands } from "../pi-extension/project-refine/commands.ts";
import { executeReview, prepareReview } from "../pi-extension/project-refine/core/reviewer.ts";
import { validateProposals } from "../pi-extension/project-refine/core/proposals.ts";
import { discoverProject } from "../pi-extension/project-refine/core/project.ts";
import { initialState, RefineStore } from "../pi-extension/project-refine/core/storage.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";
import type { EvidenceEpisode, ProjectScope, ResourceManifest, SessionCollection } from "../pi-extension/project-refine/core/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function evidence(root = "/project") {
  const scope: ProjectScope = { id: digest("hardening-project"), root, kind: "directory", warnings: [],
    worktrees: [{ id: digest("main"), root, available: true, historical: false }] };
  const content = "# Rules\nRun tests.\n";
  const manifest: ResourceManifest = { digest: digest(content), warnings: [], resources: [
    { path: "AGENTS.md", kind: "instruction", content, hash: digest(content), editable: true },
  ] };
  const episode: EvidenceEpisode = { id: digest("episode"), sessionId: "source", leafId: "a", worktreeId: scope.worktrees[0].id,
    entryIds: ["source:u"], activityAt: "2026-01-01T00:00:00.000Z", kind: "correction", outcome: "unknown", limitations: [],
    excerpts: [{ entryId: "source:u", source: "human", text: "Please use pnpm tests, not npm tests. Also run lint before finishing.", truncated: false }] };
  const collection: SessionCollection = { filesScanned: 1, matchedSessions: 1, warnings: [], perWorktree: {}, episodes: [episode] };
  return { scope, manifest, episode, collection, state: initialState() };
}

function proposal(f = evidence()) {
  return { category: "instructions", scope: "project-wide", problem: "Missing test runner guidance", suggestion: "Document the project test runner.",
    expectedEffect: "Avoid repeated corrections.", exceptions: "Only this repository; behavior not evaluated.", confidence: "medium",
    citations: [{ entryId: "source:u", quote: "Please use pnpm tests" }],
    edits: [{ path: "AGENTS.md", baseHash: f.manifest.resources[0].hash, oldText: "Run tests.", newText: "Run pnpm tests." }] };
}

async function commandFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "refine-hardening-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"); const agentDir = join(root, "agent"); const sessions = join(root, "sessions");
  await Promise.all([mkdir(project), mkdir(agentDir), mkdir(sessions)]);
  await writeFile(join(project, "AGENTS.md"), "# Rules\nRun tests.\n");
  const now = Date.now() - 10000;
  const entries = [
    { type: "session", version: 3, id: "source", cwd: project, timestamp: new Date(now).toISOString() },
    { type: "message", id: "u", parentId: null, timestamp: new Date(now).toISOString(), message: { role: "user", content: "Please use pnpm tests, not npm tests.", timestamp: now } },
    { type: "message", id: "a", parentId: "u", timestamp: new Date(now + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Understood; I will use pnpm tests." }], stopReason: "stop", timestamp: now + 1000 } },
    { type: "message", id: "next", parentId: "a", timestamp: new Date(now + 2000).toISOString(), message: { role: "user", content: "Another task.", timestamp: now + 2000 } },
  ];
  await writeFile(join(sessions, "source.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const scope = await discoverProject(project, { root: project });
  const store = new RefineStore(agentDir, scope.id);
  const events = new Map<string, (...args: any[]) => any>();
  const output: string[] = []; const notices: string[] = []; let handler!: (args: string, ctx: any) => Promise<void>;
  const model = { provider: "consented", id: "model", contextWindow: 200000 };
  const calls: any[] = [];
  const ctx: any = { cwd: project, hasUI: true, isProjectTrusted: () => true, model,
    modelRegistry: { streamSimple(selected: any, context: any) { calls.push({ model: selected, context }); return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"proposals":[]}' }] }) }; } },
    waitForIdle: async () => {}, sessionManager: { getSessionId: () => "parent", getLeafId: () => null, getSessionDir: () => sessions },
    ui: { notify(text: string) { notices.push(text); }, setStatus() {}, setEditorText() {}, select: async () => undefined,
      editor: async (_title: string, text: string) => { output.push(text); return text; }, confirm: async () => true } };
  registerCommands({ on(name: string, fn: any) { events.set(name, fn); }, registerCommand(_name: string, command: any) { handler = command.handler; } } as any, { agentDir });
  return { project, sessions, agentDir, store, ctx, model, calls, output, notices, events,
    execute: (args: string) => handler(args, ctx), propose: () => handler(`propose --root "${project}" --session-root "${sessions}"`, ctx) };
}

for (const switchAt of ["preview", "consent"] as const) {
  test(`provider changes during ${switchAt} cannot redirect already disclosed evidence`, async (t) => {
    const f = await commandFixture(t);
    const switched = { provider: "not-consented", id: "other", contextWindow: 200000 };
    const editor = f.ctx.ui.editor;
    f.ctx.ui.editor = async (title: string, text: string) => { const result = await editor(title, text); if (switchAt === "preview" && title.includes("disclosure")) f.ctx.model = switched; return result; };
    f.ctx.ui.confirm = async (_title: string, text: string) => { assert.match(text, /consented\/model/); if (switchAt === "consent") f.ctx.model = switched; return true; };
    await f.propose();
    assert.equal(f.calls.length, 1, f.notices.join("\n"));
    assert.deepEqual(f.calls[0].model, f.model, "the provider shown in consent must receive the call");
    assert.equal((await f.store.listRuns())[0].model, "consented/model");
  });
}

for (const contextWindow of [0, 200000]) {
  test(`virtual models with contextWindow ${contextWindow} cannot route evidence past provider consent`, async (t) => {
    const f = await commandFixture(t);
    f.ctx.model = { ...f.model, api: "pi-virtual", contextWindow };
    await f.propose();
    assert.equal(f.calls.length, 0, "neither routing nor streaming may receive evidence");
    assert.equal(f.output.length, 0, "must refuse before preview, not disclose a misleading destination");
    assert.ok(f.notices.some((text) => /Virtual\/router models.*\/model.*No model call made/.test(text)));
    assert.ok(!f.notices.some((text) => /insufficient context/.test(text)), "zero means unknown for virtual models");
    assert.deepEqual(await f.store.listRuns(), []);
    assert.deepEqual((await f.store.loadState()).covered, {});
    await f.execute(`audit --root "${f.project}" --session-root "${f.sessions}"`);
    assert.ok(f.output.some((text) => text.includes("AGENTS.md")), "local audit must still work with virtual selection");
    assert.equal(f.calls.length, 0);
  });
}

for (const cancel of ["user", "shutdown"] as const) {
  test(`${cancel} cancellation during a successful save's storage wait cannot publish coverage`, async (t) => {
    const f = await commandFixture(t);
    await f.store.rememberRoots([f.project]);
    const lock = join(f.agentDir, "project-refine", `.${f.store.projectId}.lock`);
    const reached = deferred(); const settled = deferred();
    const save = RefineStore.prototype.saveRun;
    t.mock.method(RefineStore.prototype, "saveRun", async function (this: RefineStore, ...args: Parameters<typeof save>) {
      // Hold an actual live-owner storage lock only after collection/review have completed.
      await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }), { mode: 0o600 });
      const pending = save.apply(this, args);
      reached.resolve();
      try { await pending; } finally { settled.resolve(); }
    });
    const pending = f.propose();
    try {
      await reached.promise;
      if (cancel === "user") await f.execute("cancel");
      else f.events.get("session_shutdown")!();
    } finally {
      await unlink(lock);
      await pending;
      // abortable() may return before the underlying storage promise settles.
      await settled.promise;
    }
    assert.equal((await f.store.listRuns()).filter((run) => run.status === "success").length, 0);
    assert.deepEqual((await f.store.loadState()).covered, {});
    assert.ok(!f.notices.some((text) => text.startsWith("Project Refine success:")));
  });
}

for (const cancel of ["user", "shutdown"] as const) {
  test(`${cancel} cancellation after staging artifacts cannot publish the successful review`, async (t) => {
    const f = await commandFixture(t);
    const reached = deferred(); const release = deferred(); const settled = deferred();
    // Pause the filesystem durability boundary after both staging artifacts exist,
    // without replacing storage's publication or cancellation implementation.
    const handle = await open(f.project, "r");
    const prototype = Object.getPrototypeOf(handle);
    const sync = handle.sync;
    await handle.close();
    let paused = false;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const current = await this.stat();
      if (!paused && current.isDirectory()) {
        const runs = join(f.store.root, "runs");
        const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.filter((entry) => entry.isDirectory())) {
          const folder = join(runs, entry.name);
          const candidate = await stat(folder);
          if (candidate.ino !== current.ino || candidate.dev !== current.dev) continue;
          const files = await readdir(folder);
          if (!files.includes("run.json") || !files.includes("report.md")) continue;
          paused = true;
          reached.resolve();
          await release.promise;
          break;
        }
      }
      return sync.call(this);
    });
    const save = RefineStore.prototype.saveRun;
    t.mock.method(RefineStore.prototype, "saveRun", async function (this: RefineStore, ...args: Parameters<typeof save>) {
      try { await save.apply(this, args); } finally { settled.resolve(); }
    });
    const pending = f.propose();
    try {
      await reached.promise;
      if (cancel === "user") await f.execute("cancel");
      else f.events.get("session_shutdown")!();
    } finally {
      release.resolve();
      await pending;
      await settled.promise;
    }
    assert.equal((await f.store.listRuns()).filter((run) => run.status === "success").length, 0);
    assert.deepEqual((await f.store.loadState()).covered, {});
    assert.ok(!f.notices.some((text) => text.startsWith("Project Refine success:")));
  });
}

test("reset recovers corrupt private state through the public command without touching source files", async (t) => {
  const f = await commandFixture(t);
  await f.store.rememberRoots([f.project]);
  await writeFile(join(f.store.root, "state.json"), "{broken", { mode: 0o600 });
  await assert.rejects(f.store.loadState());
  const rules = await readFile(join(f.project, "AGENTS.md"), "utf8");
  const session = await readFile(join(f.sessions, "source.jsonl"), "utf8");
  await f.execute(`reset --root "${f.project}"`);
  assert.deepEqual(await f.store.loadState(), initialState());
  assert.deepEqual(await f.store.listRuns(), []);
  assert.equal(await readFile(join(f.project, "AGENTS.md"), "utf8"), rules);
  assert.equal(await readFile(join(f.sessions, "source.jsonl"), "utf8"), session);
  assert.equal(f.calls.length, 0);
});

test("omitted skills still prevent name collisions but never authorize undisclosed exact anchors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "refine-hidden-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = evidence(root);
  const skill = (name: string) => `---\nname: ${name}\ndescription: Project test procedure.\n---\nUse pnpm tests.\n`;
  for (const [path, content] of [[".pi/skills/visible/SKILL.md", skill("visible")], [".pi/skills/hidden/SKILL.md", skill("hidden") + "Undisclosed local procedure.\n".repeat(400)]]) {
    f.manifest.resources.push({ path, kind: "skill", content, hash: digest(content), editable: true });
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { maxRequestBytes: 16000 });
  const hidden = f.manifest.resources.at(-1)!;
  assert.ok(prepared.payload.resources.some((resource) => resource.path.includes("visible")));
  assert.ok(!prepared.payload.resources.some((resource) => resource.path === hidden.path));
  assert.ok(!prepared.serialized.includes("Undisclosed local procedure."));
  const wire = proposal(f);
  const review = (edit: typeof wire.edits[number] | { path: string; baseHash: null; oldText: string; newText: string }) => executeReview(prepared, f.scope,
    async () => ({ text: JSON.stringify({ proposals: [{ ...wire, category: "skill-procedure", edits: [edit] }] }) }));
  const newSkill = { path: ".pi/skills/another/SKILL.md", baseHash: null, oldText: "", newText: skill("unique") };
  assert.equal((await review(newSkill)).proposals.length, 1, "noncolliding skills in the disclosed hierarchy remain supported");
  await assert.rejects(review({ ...newSkill, newText: skill("hidden") }), /collid/i);
  await assert.rejects(review({ path: hidden.path, baseHash: hidden.hash, oldText: "name: hidden", newText: "name: renamed" }), /advisory|disclos|inventor|baseline|unsupported/i);
});

for (const tail of ["long excerpt", "late excerpt"] as const) {
  test(`an episode marked covered retains the correction in its ${tail}`, async () => {
    const f = evidence();
    const correction = "Actually, always run pnpm lint before the final test command.";
    if (tail === "long excerpt") f.episode.excerpts[0].text = "Earlier bounded context. ".repeat(70) + correction;
    else {
      f.episode.excerpts = Array.from({ length: 12 }, (_, index) => ({ entryId: `source:u${index}`, source: "human" as const,
        text: index === 11 ? correction : `Earlier bounded context number ${index}.`, truncated: false }));
      f.episode.entryIds = f.episode.excerpts.map((excerpt) => excerpt.entryId);
    }
    const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
    assert.equal(prepared.payload.episodes.length, 1);
    assert.deepEqual(prepared.payload.episodes[0].excerpts, f.episode.excerpts, "already bounded evidence must not be silently shortened again");
    const wire = proposal(f);
    wire.edits = [];
    wire.citations = [{ entryId: f.episode.excerpts.at(-1)!.entryId, quote: correction }];
    assert.equal((await executeReview(prepared, f.scope, async () => ({ text: JSON.stringify({ proposals: [wire] }) }))).proposals.length, 1);
    f.state.covered[prepared.contextDigest] = prepared.payload.episodes.map((episode) => episode.id);
    assert.equal(prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model").payload.episodes.length, 0);
  });
}

test("episodes that cannot fit completely are omitted rather than partially submitted and covered", () => {
  const f = evidence();
  f.episode.excerpts[0].text = "Bounded but larger than this request. ".repeat(500) + "Final correction: use pnpm lint.";
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { maxRequestBytes: 16000 });
  assert.equal(prepared.payload.episodes.length, 0);
  assert.equal(prepared.eligibleEpisodes, 1);
  assert.equal(prepared.omittedEpisodes, 1);
  assert.deepEqual(f.state.covered, {});
});

test("materially changed operations and cited evidence produce new rejection fingerprints", () => {
  const f = evidence();
  const wire = proposal(f);
  const fingerprint = (value: typeof wire) => validateProposals({ proposals: [value] }, f.scope.id, f.manifest, f.collection.episodes)[0].fingerprint;
  const baseline = fingerprint(wire);
  assert.equal(fingerprint(structuredClone(wire)), baseline, "unchanged proposals remain suppressible");
  assert.notEqual(fingerprint({ ...wire, edits: [{ ...wire.edits[0], newText: "Run pnpm tests and pnpm lint." }] }), baseline, "new edit content is a materially different proposal");
  assert.notEqual(fingerprint({ ...wire, edits: [] }), baseline, "advice-only and concrete operations must not share a rejection key");
  assert.notEqual(fingerprint({ ...wire, citations: [{ entryId: "source:u", quote: "Also run lint before finishing." }] }), baseline, "new supporting evidence must allow reconsideration");
  f.episode.excerpts.push({ ...f.episode.excerpts[0], entryId: "source:independent" });
  assert.notEqual(fingerprint({ ...wire, citations: [{ ...wire.citations[0], entryId: "source:independent" }] }), baseline, "independent evidence is not the same rejected finding");
});
