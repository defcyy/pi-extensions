import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RefineStore, initialState } from "../pi-extension/project-refine/core/storage.ts";
import type { RefineRun, Proposal } from "../pi-extension/project-refine/core/types.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";

const PROJECT = digest("project");
const CONTEXT = digest("context");
const exec = promisify(execFile);
const moduleURL = new URL("../pi-extension/project-refine/core/storage.ts", import.meta.url).href;
function run(overrides: Partial<RefineRun> = {}): RefineRun {
  return { schemaVersion: 1, id: randomUUID(), projectId: PROJECT, targetRoot: "/project", startedAt: new Date().toISOString(), status: "success", model: "provider/model", contextDigest: CONTEXT,
    analyzedEpisodeIds: [digest(randomUUID())], coverage: { filesScanned: 1, matchedSessions: 1, eligibleEpisodes: 1, selectedEpisodes: 1, omittedEpisodes: 0, perWorktree: {} },
    warnings: [], proposals: [], usage: [], ...overrides };
}
function proposal(): Proposal {
  return { id: digest(randomUUID()), fingerprint: digest(randomUUID()), category: "instructions", scope: "project-wide", problem: "Tests need prerequisites", suggestion: "Document prerequisites", expectedEffect: "Fewer failures", exceptions: "None", confidence: "medium", citations: [], edits: [], diffs: [], validation: "structural-only; behavior not evaluated" };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await fs.mkdtemp(join(tmpdir(), "refine-store-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const agent = join(base, "agent");
  const store = new RefineStore(agent, PROJECT);
  return { base, agent, store, root: store.root };
}

test("constructor and missing reads never write, including reset and empty roots", async (t) => {
  const { base, store } = await fixture(t);
  assert.deepEqual(await store.loadState(), initialState());
  assert.deepEqual(await store.listRuns(), []);
  await store.reset(); await store.rememberRoots([]);
  assert.deepEqual(await fs.readdir(base), []);
  const a = initialState(); a.historicalRoots.push("/x"); assert.deepEqual(initialState().historicalRoots, []);
});

test("private permissions, defense redaction, atomic complete records and root union", async (t) => {
  const { store, root } = await fixture(t);
  const value = run({ warnings: ["password=storage-secret"], error: "api_key=error-secret", usage: [{ input: 3, cost: undefined }] });
  await store.rememberRoots(["/project", "/worktree"]);
  await store.saveRun(value, "Authorization: Bearer report-secret\n# Safe report");
  assert.deepEqual((await store.loadState()).covered[CONTEXT], value.analyzedEpisodeIds);
  const stored = await store.readRun(value.id);
  assert.ok(!JSON.stringify(stored).includes("storage-secret"));
  assert.ok(!JSON.stringify(stored).includes("error-secret"));
  assert.equal(stored.contextDigest, CONTEXT);
  assert.equal(stored.id, value.id);
  assert.ok(!(await fs.readFile(store.reportPath(value.id), "utf8")).includes("report-secret"));
  for (const file of [root, join(root, "runs"), join(root, "runs", value.id)]) assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
  for (const file of [join(root, "state.json"), join(root, "runs", value.id, "run.json"), store.reportPath(value.id)]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const before = (await fs.stat(join(root, "state.json"), { bigint: true })).mtimeNs;
  await store.rememberRoots(["/project"]);
  assert.equal((await fs.stat(join(root, "state.json"), { bigint: true })).mtimeNs, before);
  assert.deepEqual((await store.loadState()).historicalRoots, ["/project", "/worktree"]);
});

test("concurrent saves and cross-process decisions never lose updates", async (t) => {
  const { agent, store } = await fixture(t);
  const p = proposal(); const first = run({ proposals: [p] });
  await store.saveRun(first, "first");
  const values = Array.from({ length: 7 }, () => run());
  const script = `const {RefineStore}=await import(${JSON.stringify(moduleURL)}); const s=new RefineStore(process.argv[1], ${JSON.stringify(PROJECT)}); await s.saveRun(JSON.parse(process.argv[2]), 'child report'); await s.decide(${JSON.stringify(p.id)}, 'accepted');`;
  await Promise.all([
    ...values.slice(0, 5).map((value) => new RefineStore(agent, PROJECT).saveRun(value, "report")),
    ...values.slice(5).map((value) => exec(process.execPath, ["--input-type=module", "-e", script, agent, JSON.stringify(value)])),
    store.decide(p.id, "rejected"), store.decide(p.id, "deferred"), store.rememberRoots(["/other"]),
  ]);
  const state = await store.loadState();
  assert.deepEqual(new Set(state.covered[CONTEXT]), new Set([first, ...values].flatMap((value) => value.analyzedEpisodeIds)));
  assert.equal(state.decisions.length, 4);
  assert.ok(state.decisions.every((decision) => decision.proposalId === p.id && decision.fingerprint === p.fingerprint && decision.contextDigest === CONTEXT));
  assert.equal((await store.listRuns()).length, 8);
});

test("failed, aborted, invalid, duplicate and uncommitted runs consume no coverage", async (t) => {
  const { store, root } = await fixture(t);
  const failed = run({ status: "failed" }); const aborted = run({ status: "aborted" });
  await store.saveRun(failed, "failure"); await store.saveRun(aborted, "abort");
  assert.deepEqual((await store.loadState()).covered, {});
  await assert.rejects(store.saveRun(run({ contextDigest: "invalid" }), "report"));
  const success = run(); await store.saveRun(success, "success");
  const duplicate = run({ id: success.id });
  await assert.rejects(store.saveRun(duplicate, "must not overwrite"));
  await assert.rejects(store.saveRun(run(), "x".repeat(4 * 1024 * 1024 + 1)));
  const stage = join(root, "runs", `.stage-${randomUUID()}`);
  await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(join(stage, "run.json"), JSON.stringify(run()), { mode: 0o600 });
  assert.deepEqual((await store.loadState()).covered[CONTEXT], success.analyzedEpisodeIds);
  await store.saveRun(run({ status: "failed" }), "cleanup");
  await assert.rejects(fs.stat(stage), { code: "ENOENT" });
});

test("ledger recovers publication interrupted before state commit", async (t) => {
  const { store, root } = await fixture(t);
  const value = run(); await store.saveRun(value, "committed pair");
  await fs.writeFile(join(root, "state.json"), JSON.stringify(initialState()), { mode: 0o600 });
  assert.deepEqual((await store.loadState()).covered[CONTEXT], value.analyzedEpisodeIds);
  await store.rememberRoots(["/recovered"]);
  const disk = JSON.parse(await fs.readFile(join(root, "state.json"), "utf8"));
  assert.deepEqual(disk.covered[CONTEXT], value.analyzedEpisodeIds);
});

test("corrupt state and malformed stored records fail closed; reset remains available", async (t) => {
  const { store, root } = await fixture(t);
  await store.rememberRoots(["/project"]);
  for (const invalid of ["{", JSON.stringify({ ...initialState(), schemaVersion: 2 }), JSON.stringify({ ...initialState(), covered: { "../escape": [] } }), JSON.stringify({ ...initialState(), decisions: [{ decision: "accepted" }] }), JSON.stringify({ ...initialState(), rawTranscript: "no" })]) {
    await fs.writeFile(join(root, "state.json"), invalid);
    await assert.rejects(store.loadState());
    await assert.rejects(store.saveRun(run(), "report"));
  }
  await store.reset(); assert.deepEqual(await store.loadState(), initialState());
  const value = run(); await store.saveRun(value, "report");
  await fs.writeFile(join(root, "runs", value.id, "run.json"), JSON.stringify({ ...value, id: randomUUID() }));
  await assert.rejects(store.listRuns()); await assert.rejects(store.readRun(value.id));
});

test("strict path IDs and symlink guards protect state, runs, reports and reset", async (t) => {
  const { base, agent, store, root } = await fixture(t);
  assert.throws(() => new RefineStore(agent, "../escape"));
  assert.throws(() => store.reportPath("../../escape"));
  await assert.rejects(store.readRun("../escape"));
  const outside = join(base, "outside"); await fs.mkdir(outside); await fs.writeFile(join(outside, "keep"), "untouched");
  await fs.mkdir(join(agent, "project-refine"), { recursive: true, mode: 0o700 });
  await fs.symlink(outside, root);
  await assert.rejects(store.loadState()); await assert.rejects(store.reset());
  await fs.unlink(root);
  await store.rememberRoots(["/project"]);
  await fs.unlink(join(root, "state.json")); await fs.symlink(join(outside, "keep"), join(root, "state.json"));
  await assert.rejects(store.loadState()); await assert.rejects(store.saveRun(run(), "report"));
  await assert.rejects(store.reset()); await fs.unlink(join(root, "state.json"));
  const value = run(); await store.saveRun(value, "report");
  await fs.unlink(store.reportPath(value.id)); await fs.symlink(join(outside, "keep"), store.reportPath(value.id));
  await assert.rejects(store.readRun(value.id)); await assert.rejects(store.loadState()); await assert.rejects(store.reset());
  assert.equal(await fs.readFile(join(outside, "keep"), "utf8"), "untouched");
});

test("reset is scoped, and refuses non-private files and hardlinks", async (t) => {
  const { base, agent, store, root } = await fixture(t);
  const other = new RefineStore(agent, digest("other")); await other.rememberRoots(["/other"]);
  const outside = join(base, "source.jsonl"); await fs.writeFile(outside, "source data", { mode: 0o600 });
  await store.rememberRoots(["/project"]);
  await fs.chmod(join(root, "state.json"), 0o644); await assert.rejects(store.loadState());
  await fs.chmod(join(root, "state.json"), 0o600);
  await fs.link(outside, join(root, "hardlink")); await assert.rejects(store.reset());
  await fs.unlink(join(root, "hardlink")); await store.reset();
  assert.equal(await fs.readFile(outside, "utf8"), "source data");
  assert.deepEqual((await other.loadState()).historicalRoots, ["/other"]);
  assert.deepEqual(await store.loadState(), initialState());
});

test("retention cleans only explicit mutations and keeps compact coverage/decisions", async (t) => {
  const { store, root } = await fixture(t);
  const p = proposal(); const value = run({ proposals: [p] }); await store.saveRun(value, "report");
  await store.decide(p.id, "accepted");
  const old = { ...value, startedAt: new Date(Date.now() - 31 * 86400000).toISOString() };
  await fs.writeFile(join(root, "runs", value.id, "run.json"), JSON.stringify(old));
  assert.equal((await store.listRuns()).length, 1); // reads do not clean
  assert.equal((await store.loadState()).decisions.length, 1);
  await store.rememberRoots(["/mutate"]);
  assert.equal((await store.listRuns()).length, 0);
  const state = await store.loadState();
  assert.deepEqual(state.covered[CONTEXT], value.analyzedEpisodeIds);
  assert.equal(state.decisions.length, 1);
  await assert.rejects(store.decide(p.id, "rejected"), /not found/);
});

test("a dead local PID lock is recovered without age-based live-lock theft", async (t) => {
  const { agent, store } = await fixture(t);
  await store.rememberRoots(["/project"]);
  const child = await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const { hostname } = await import("node:os");
  const lock = join(agent, "project-refine", `.${PROJECT}.lock`);
  await fs.writeFile(lock, JSON.stringify({ pid: Number(child.stdout), host: hostname(), token: randomUUID() }), { mode: 0o600 });
  await store.rememberRoots(["/after-crash"]);
  assert.deepEqual((await store.loadState()).historicalRoots, ["/after-crash", "/project"]);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("live local lock owners cannot be stolen based on old timestamps", async (t) => {
  const { agent, store, root } = await fixture(t);
  await store.rememberRoots(["/project"]);
  const { hostname } = await import("node:os");
  const lock = join(agent, "project-refine", `.${PROJECT}.lock`);
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
  await fs.writeFile(lock, owner, { mode: 0o600 });
  await fs.utimes(lock, new Date(0), new Date(0));
  const pending = store.rememberRoots(["/waited"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await fs.readFile(lock, "utf8"), owner);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root, "state.json"), "utf8")).historicalRoots, ["/project"]);
  await fs.unlink(lock); await pending;
  assert.deepEqual((await store.loadState()).historicalRoots, ["/project", "/waited"]);
});

test("two processes recover the same dead lock without losing either save", async (t) => {
  const { agent, store } = await fixture(t);
  await store.rememberRoots(["/project"]);
  const child = await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const { hostname } = await import("node:os");
  await fs.writeFile(join(agent, "project-refine", `.${PROJECT}.lock`), JSON.stringify({ pid: Number(child.stdout), host: hostname(), token: randomUUID() }), { mode: 0o600 });
  const values = [run(), run()];
  const script = `const {RefineStore}=await import(${JSON.stringify(moduleURL)}); await new RefineStore(process.argv[1], ${JSON.stringify(PROJECT)}).saveRun(JSON.parse(process.argv[2]), 'recovered');`;
  await Promise.all(values.map((value) => exec(process.execPath, ["--input-type=module", "-e", script, agent, JSON.stringify(value)])));
  assert.deepEqual(new Set((await store.loadState()).covered[CONTEXT]), new Set(values.flatMap((value) => value.analyzedEpisodeIds)));
});

test("history is newest first and bounded to 50", async (t) => {
  const { store } = await fixture(t);
  // Build immutable records directly to keep this history-bound test inexpensive.
  await store.rememberRoots(["/project"]);
  const values = Array.from({ length: 53 }, (_, i) => run({ startedAt: new Date(Date.now() - i * 1000).toISOString(), status: "failed" }));
  for (const value of values) {
    const folder = join(store.root, "runs", value.id); await fs.mkdir(folder, { mode: 0o700 });
    await fs.writeFile(join(folder, "run.json"), JSON.stringify(value), { mode: 0o600 });
    await fs.writeFile(join(folder, "report.md"), "report", { mode: 0o600 });
  }
  assert.deepEqual((await store.listRuns()).map((value) => value.id), values.slice(0, 50).map((value) => value.id));
});

test("a replaced runtime cannot publish a successful run after waiting for a private-state lock", async (t) => {
  const { agent, store } = await fixture(t);
  const aborted = new AbortController(); aborted.abort(new Error("runtime replaced"));
  await assert.rejects(store.saveRun(run(), "report", { signal: aborted.signal }), /runtime replaced/);
  assert.deepEqual(await store.listRuns(), []);
  await store.rememberRoots(["/project"]);
  const { hostname } = await import("node:os");
  const lock = join(agent, "project-refine", `.${PROJECT}.lock`);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }), { mode: 0o600 });
  const controller = new AbortController();
  const pending = store.saveRun(run(), "late success", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort(new Error("runtime replaced"));
  await fs.unlink(lock);
  await assert.rejects(pending, /runtime replaced/);
  assert.deepEqual(await store.listRuns(), []);
  assert.deepEqual((await store.loadState()).covered, {});
});
