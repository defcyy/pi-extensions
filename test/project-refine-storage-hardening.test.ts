import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PathLike } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { RefineStore, sanitizeRun } from "../pi-extension/project-refine/core/storage.ts";
import type { RefineRun } from "../pi-extension/project-refine/core/types.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";

const PROJECT = digest("storage-hardening-project");
const CONTEXT = digest("storage-hardening-context");
const MAX_RUNS = 10000;

function run(overrides: Partial<RefineRun> = {}): RefineRun {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    projectId: PROJECT,
    targetRoot: "/project",
    startedAt: new Date().toISOString(),
    status: "success",
    model: "provider/model",
    contextDigest: CONTEXT,
    analyzedEpisodeIds: [digest(randomUUID())],
    coverage: { filesScanned: 1, matchedSessions: 1, eligibleEpisodes: 1, selectedEpisodes: 1, omittedEpisodes: 0, perWorktree: {} },
    warnings: [],
    proposals: [],
    usage: [],
    ...overrides,
  };
}

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "refine-store-hardening-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new RefineStore(join(base, "agent"), PROJECT);
  return { store, folder: join(store.root, "runs") };
}

/** Update named builtin exports after mocking the mutable default fs object. */
function publishFilesystemMocks(t: TestContext): void {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

/** Simulate directory occupancy without creating/validating ten thousand records. */
function occupyRunSlots(t: TestContext, folder: string, slots: number): void {
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (path: PathLike, options?: { withFileTypes?: boolean }) => {
    const entries = options?.withFileTypes ? await readdir(path, { withFileTypes: true }) : await readdir(path);
    if (path === folder) {
      // Preserve real records for validation/cleanup, but report occupied slots at
      // both the reader's Dirent boundary and the writer's name-only boundary.
      const actualEntries = [...entries];
      entries.length += slots;
      Object.defineProperty(entries, Symbol.iterator, { value: () => actualEntries[Symbol.iterator]() });
    }
    return entries;
  });
  publishFilesystemMocks(t);
}

for (const deletedArtifact of ["report.md", "run.json"]) {
  test(`interrupted retention after deleting ${deletedArtifact} leaves readable state and only ignored staging`, async (t) => {
    const { store, folder } = await fixture(t);
    const value = run();
    await store.saveRun(value, "report");
    const old = { ...value, startedAt: new Date(Date.now() - 31 * 86400000).toISOString() };
    await fs.writeFile(join(folder, value.id, "run.json"), JSON.stringify(old));

    // Observe the actual directory durability boundary, not a mocked cleanup implementation.
    const handle = await fs.open(folder, "r");
    const folderStat = await handle.stat();
    const prototype = Object.getPrototypeOf(handle);
    const sync = handle.sync;
    await handle.close();
    let syncedRuns = false;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const stat = await this.stat();
      if (stat.dev === folderStat.dev && stat.ino === folderStat.ino) syncedRuns = true;
      return sync.call(this);
    });
    const rm = fs.rm;
    let interruptedStage: string | undefined;
    t.mock.method(fs, "rm", async (path: PathLike, options?: Parameters<typeof rm>[1]) => {
      if (typeof path === "string" && dirname(path) === folder && basename(path).startsWith(".stage-")) {
        interruptedStage = path;
        assert.equal(syncedRuns, true, "the run-directory rename must be fsynced before recursive deletion");
        await assert.rejects(fs.stat(join(folder, value.id)), { code: "ENOENT" });
        const ledger: unknown = JSON.parse(await fs.readFile(join(store.root, "state.json"), "utf8"));
        assert.deepEqual(ledger, {
          schemaVersion: 1,
          historicalRoots: ["/after-retention"],
          covered: { [CONTEXT]: value.analyzedEpisodeIds },
          decisions: [],
          intervals: [],
        }, "the recovered ledger must be persisted before retiring any run");
        await fs.unlink(join(path, deletedArtifact));
        throw new Error("simulated interrupted recursive deletion");
      }
      return rm(path, options);
    });
    publishFilesystemMocks(t);

    await assert.rejects(store.rememberRoots(["/after-retention"]), /simulated interrupted/);
    assert.ok(interruptedStage);
    assert.match(basename(interruptedStage), /^\.stage-[a-f0-9-]{36}$/);
    assert.deepEqual(await store.listRuns(), []);
    assert.deepEqual((await store.loadState()).covered[CONTEXT], value.analyzedEpisodeIds);

    t.mock.restoreAll();
    syncBuiltinESMExports();
    await store.rememberRoots(["/after-recovery"]);
    assert.deepEqual(await fs.readdir(folder), []);
    assert.deepEqual((await store.loadState()).covered[CONTEXT], value.analyzedEpisodeIds);
  });
}

test("the last run slot may publish, but the next save fails before staging and leaves readers usable", async (t) => {
  const { store, folder } = await fixture(t);
  await store.rememberRoots(["/project"]);
  occupyRunSlots(t, folder, MAX_RUNS - 1);

  const last = run();
  await store.saveRun(last, "last available slot");
  assert.deepEqual((await store.listRuns()).map((value) => value.id), [last.id]);
  const ledger = await fs.readFile(join(store.root, "state.json"), "utf8");
  const entries = await fs.readdir(folder);
  assert.equal(entries.length, MAX_RUNS);

  const overflow = run();
  await assert.rejects(store.saveRun(overflow, "must not publish"), /size limit/);
  assert.equal(await fs.readFile(join(store.root, "state.json"), "utf8"), ledger);
  assert.deepEqual([...(await fs.readdir(folder))], [last.id]);
  await assert.rejects(fs.stat(join(folder, overflow.id)), { code: "ENOENT" });
  assert.deepEqual((await store.listRuns()).map((value) => value.id), [last.id]);
  assert.deepEqual((await store.loadState()).covered[CONTEXT], last.analyzedEpisodeIds);
});

test("interrupted staging entries consume capacity before another run can publish", async (t) => {
  const { store, folder } = await fixture(t);
  const committed = run();
  await store.saveRun(committed, "committed");
  const stageName = `.stage-${randomUUID()}`;
  await fs.mkdir(join(folder, stageName), { mode: 0o700 });
  occupyRunSlots(t, folder, MAX_RUNS - 2);

  assert.equal((await fs.readdir(folder)).length, MAX_RUNS);
  const overflow = run();
  await assert.rejects(store.saveRun(overflow, "must not publish"), /size limit/);
  assert.deepEqual(new Set([...(await fs.readdir(folder))]), new Set([committed.id, stageName]));
  assert.deepEqual((await store.listRuns()).map((value) => value.id), [committed.id]);
  assert.deepEqual((await store.loadState()).covered[CONTEXT], committed.analyzedEpisodeIds);
});

test("sanitizeRun returns the same validated redacted record saved by the store without changing its input", async (t) => {
  const { store } = await fixture(t);
  const value = run({ warnings: ["password=private-warning"], error: "api_key=private-error" });
  const original = structuredClone(value);
  const sanitized = sanitizeRun(value);
  assert.deepEqual(value, original);
  assert.ok(!JSON.stringify(sanitized).includes("private-warning"));
  assert.ok(!JSON.stringify(sanitized).includes("private-error"));
  assert.equal(sanitized.projectId, PROJECT);
  assert.equal(sanitized.id, value.id);
  await store.saveRun(value, "report");
  assert.deepEqual(await store.readRun(value.id), sanitized);
});

test("sanitizeRun rejects malformed nested values and redaction that exceeds schema limits", () => {
  const invalidFields: [string, unknown][] = [
    ["coverage", { filesScanned: -1 }],
    ["warnings", [{}]],
    ["usage", [null]],
    ["proposals", [{ edits: [false] }]],
    ["projectId", "not-a-project-hash"],
  ];
  for (const [key, invalid] of invalidFields) {
    const value = run();
    Reflect.set(value, key, invalid);
    assert.throws(() => sanitizeRun(value), /Invalid project-refine/);
  }
  // Valid input can grow during masking; the result must be validated as well.
  const warning = "password=x" + " ".repeat(16384 - "password=x".length);
  assert.throws(() => sanitizeRun(run({ warnings: [warning] })), /Invalid project-refine/);
});
