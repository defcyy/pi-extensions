import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeReview, prepareReview, piReviewer, validateLiveTargets, MAX_REQUEST_BYTES, SYSTEM_PROMPT, abortable } from "../pi-extension/project-refine/core/reviewer.ts";
import type { EvidenceEpisode, ProjectScope, ProjectState, ResourceManifest, SessionCollection } from "../pi-extension/project-refine/core/types.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";

function fixture(root = "/project") {
  const scope: ProjectScope = { id: "a".repeat(64), root, kind: "directory", worktrees: [
    { id: "one", root, available: true, historical: false }, { id: "two", root: "/two", available: true, historical: false }], warnings: [] };
  const content = "# Rules\nRun tests.\n";
  const manifest: ResourceManifest = { digest: digest(content), warnings: [], resources: [{ path: "AGENTS.md", kind: "instruction", content, hash: digest(content), editable: true }] };
  const makeEpisode = (index: number, worktreeId = "one"): EvidenceEpisode => ({
    id: digest(`ep${index}`), sessionId: `s${index}`, leafId: "a", worktreeId, entryIds: [`s${index}:u`], activityAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    kind: "correction", outcome: "unknown", limitations: [], excerpts: [{ entryId: `s${index}:u`, source: "human", text: "Please run pnpm tests before finishing.", truncated: false }],
  });
  const collection: SessionCollection = { filesScanned: 10, matchedSessions: 10, warnings: [], perWorktree: {},
    episodes: Array.from({ length: 10 }, (_, index) => makeEpisode(index, index % 2 ? "two" : "one")) };
  const state: ProjectState = { schemaVersion: 1, historicalRoots: [], covered: {}, decisions: [], intervals: [] };
  return { scope, manifest, collection, state };
}

test("review preparation is bounded, redacted, rotates worktrees, and only selects uncovered episodes", () => {
  const f = fixture();
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
  assert.equal(prepared.payload.episodes.length, 6);
  assert.equal(new Set(prepared.payload.episodes.map((e) => e.worktreeId)).size, 2);
  assert.equal(prepared.omittedEpisodes, 4);
  assert.ok(Buffer.byteLength(prepared.serialized) + Buffer.byteLength(SYSTEM_PROMPT) <= MAX_REQUEST_BYTES);
  f.state.covered[prepared.contextDigest] = prepared.payload.episodes.map((e) => e.id);
  const next = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
  assert.equal(next.payload.episodes.length, 4);
  assert.ok(next.payload.episodes.every((e) => !f.state.covered[prepared.contextDigest].includes(e.id)));
  assert.equal(prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { rereview: true }).payload.episodes.length, 6);
});

test("final serialized preview never silently exceeds the budget; redacted resources are advisory only", () => {
  const f = fixture();
  const syntheticToken = "sk-ant-" + "A".repeat(36);
  f.manifest.resources[0].content = `API_KEY="${syntheticToken}"\n`;
  f.manifest.resources[0].hash = digest(f.manifest.resources[0].content);
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { maxRequestBytes: 16000 });
  assert.ok(!prepared.serialized.includes(syntheticToken));
  assert.equal(prepared.payload.resources[0].editable, false);
  assert.ok(Buffer.byteLength(prepared.serialized) + Buffer.byteLength(SYSTEM_PROMPT) <= 16000);
  assert.throws(() => prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { maxRequestBytes: 100 }), /budget/);
});

test("configured Pi reviewer uses zero tools and no ambient session creation", async () => {
  let observed: any;
  const ctx: any = { model: { provider: "configured", id: "model" }, modelRegistry: {
    streamSimple(model: unknown, context: unknown, options: unknown) {
      observed = { model, context, options };
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"proposals":[]}' }], usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.01 } } }) };
    },
  } };
  const result = await piReviewer(ctx)("system", "payload", new AbortController().signal);
  assert.equal(result.text, '{"proposals":[]}');
  assert.deepEqual(observed.context.tools, []);
  assert.equal(observed.options.toolChoice, "none");
  assert.deepEqual(observed.model, ctx.model);
  assert.equal(observed.options.maxRetries, 0);
  assert.equal(result.usage?.totalTokens, 3);
});

test("valid empty review succeeds, malformed output fails, and cancellation ignores late results", async () => {
  const f = fixture();
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
  assert.deepEqual((await executeReview(prepared, f.scope, async () => ({ text: '{"proposals":[]}' }))).proposals, []);
  await assert.rejects(executeReview(prepared, f.scope, async () => ({ text: 'not JSON' })), /malformed/);
  await assert.rejects(executeReview(prepared, f.scope, async () => ({ text: '{"proposals":[{}]}' })), /schema/);
  const controller = new AbortController();
  const pending = executeReview(prepared, f.scope, async () => new Promise(() => {}), controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  const aborted = new AbortController(); aborted.abort(new Error("already cancelled"));
  await assert.rejects(abortable(Promise.resolve("late"), aborted.signal), /cancelled/);
  let dispatched = false;
  await assert.rejects(executeReview(prepared, f.scope, async () => { dispatched = true; return { text: '{"proposals":[]}' }; }, aborted.signal), /cancelled/);
  assert.equal(dispatched, false);
});

test("exact patches recheck live hashes and reject symlinks without modifying project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "refine-review-"));
  try {
    const f = fixture(root);
    const target = join(root, "AGENTS.md");
    await writeFile(target, f.manifest.resources[0].content);
    const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
    const citation = prepared.payload.episodes[0].excerpts[0];
    const response = { proposals: [{ category: "instructions", scope: "project-wide", problem: "Missing runner detail", suggestion: "Document pnpm tests.",
      expectedEffect: "Follow the observed correction.", exceptions: "Only this repository; not evaluated.", confidence: "medium", citations: [{ entryId: citation.entryId, quote: citation.text }],
      edits: [{ path: "AGENTS.md", baseHash: f.manifest.resources[0].hash, oldText: "Run tests.", newText: "Run pnpm tests." }] }] };
    const call = async () => ({ text: JSON.stringify(response) });
    assert.equal((await executeReview(prepared, f.scope, call)).proposals.length, 1);
    assert.equal(await readFile(target, "utf8"), f.manifest.resources[0].content);
    await writeFile(target, "changed");
    await assert.rejects(executeReview(prepared, f.scope, call), /changed/);
    await rm(target); await writeFile(join(root, "other"), f.manifest.resources[0].content);
    await symlink(join(root, "other"), target);
    await assert.rejects(executeReview(prepared, f.scope, call), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("live target validation rejects a huge replacement or FIFO without an unbounded read", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "refine-live-target-"));
  try {
    const f = fixture(root);
    const target = join(root, "AGENTS.md");
    const proposal: any = { edits: [{ path: "AGENTS.md", baseHash: f.manifest.resources[0].hash, oldText: "Run tests.", newText: "Run pnpm tests." }] };
    await writeFile(target, "x".repeat(128 * 1024 + 1));
    await assert.rejects(validateLiveTargets(f.scope, [proposal]), /byte limit/);
    await rm(target);
    execFileSync("mkfifo", [target]);
    await assert.rejects(validateLiveTargets(f.scope, [proposal]), /non-regular/);
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await assert.rejects(validateLiveTargets(f.scope, [proposal], aborted.signal), /cancelled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an oversized episode cannot discard resources from a later fitting review", () => {
  const f = fixture();
  const small = f.collection.episodes[0];
  const large: EvidenceEpisode = {
    ...small,
    id: digest("oversized episode"),
    activityAt: "2000-01-01T00:00:00.000Z",
    excerpts: Array.from({ length: 16 }, (_, index) => ({
      entryId: `large:${index}`,
      source: "human",
      text: "Earlier task context. ".repeat(100).slice(0, 2000),
      truncated: false,
    })),
  };
  f.collection.episodes = [large, small];
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model", { maxRequestBytes: 16000 });
  assert.deepEqual(prepared.payload.episodes.map((episode) => episode.id), [small.id]);
  assert.equal(prepared.payload.resources[0].path, "AGENTS.md");
  assert.equal(prepared.omittedEpisodes, 1);
  assert.ok(Buffer.byteLength(prepared.serialized) + Buffer.byteLength(SYSTEM_PROMPT) <= 16000);
});

test("CRLF baselines stay editable after disclosure redaction", () => {
  const f = fixture();
  f.manifest.resources[0].content = "# Rules\r\nRun tests.\r\n";
  f.manifest.resources[0].hash = digest(f.manifest.resources[0].content);
  const prepared = prepareReview(f.scope, f.manifest, f.collection, f.state, "test/model");
  assert.equal(prepared.payload.resources[0].editable, true);
  assert.equal(prepared.payload.resources[0].content, f.manifest.resources[0].content);
});
