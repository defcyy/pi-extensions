import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { extractEpisodes } from "../pi-extension/project-refine/core/episodes.ts";
import { historyMessage, SESSION_LIMITS as historyLimits } from "../pi-extension/project-refine/core/history.ts";
import { collectSessions, parseSessionSnapshot, SESSION_LIMITS } from "../pi-extension/project-refine/core/sessions.ts";
import type { ProjectScope, Worktree } from "../pi-extension/project-refine/core/types.ts";

const timestamp = "2026-01-20T00:00:00.000Z";
const worktree: Worktree = { id: "main", root: "/project", available: true, historical: false };
const header = { type: "session", version: 3, id: "history", cwd: worktree.root };
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function message(id: string, parentId: string | null, role: string, extra: Record<string, unknown> = {}) {
  return { type: "message", id, parentId, timestamp, message: { role, ...extra } };
}
function episodeText(rows: unknown[]) {
  const snapshot = parseSessionSnapshot(jsonl([header, ...rows]), "history.jsonl", worktree);
  const episodes = extractEpisodes([snapshot], { since: 0 });
  return { snapshot, episodes, text: episodes.flatMap((episode) => episode.excerpts.map((excerpt) => excerpt.text)).join("\n") };
}
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "refine-history-hardening-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const store = join(base, "sessions");
  await Promise.all([mkdir(root), mkdir(store)]);
  const tree: Worktree = { ...worktree, root };
  const scope: ProjectScope = { id: "project", root, kind: "directory", worktrees: [tree], warnings: [] };
  const file = join(store, "history.jsonl");
  await writeFile(file, jsonl([{ ...header, cwd: root }, message("u", null, "user", { content: "Visible request" })]));
  return { base, file, store, scope };
}

test("shared limits retain the sessions export and legacy normalization remains deterministic", () => {
  assert.equal(SESSION_LIMITS, historyLimits);
  assert.ok(Object.isFrozen(SESSION_LIMITS));
  const legacy = jsonl([{ ...header, version: 1 }, {
    type: "message", timestamp: "invalid", message: { role: "hookMessage", timestamp: Date.parse(timestamp), content: "HIDDEN" },
  }, { type: "message", timestamp, message: { role: "user", content: "Visible request" } }]);
  const parsed = parseSessionSnapshot(legacy, "legacy.jsonl", worktree);
  assert.equal(historyMessage(parsed.nodes[0].raw.message)?.role, "custom");
  assert.equal(parsed.nodes[0].timestamp, timestamp);
  assert.equal(parsed.nodes[1].parentId, parsed.nodes[0].id);
  assert.deepEqual(parsed.nodes, parseSessionSnapshot(legacy, "legacy.jsonl", worktree).nodes);
  assert.doesNotMatch(JSON.stringify(extractEpisodes([parsed], { since: 0 })), /HIDDEN/);
});

test("unknown entry types and augmented roles retain graph linkage without becoming evidence", () => {
  const result = episodeText([
    { type: "future_entry", id: "future", parentId: null, timestamp, message: { role: "user", content: "HIDDEN ENTRY" } },
    message("augmented", "future", "futureRole", { content: "HIDDEN ROLE" }),
    message("u", "augmented", "user", { content: [null, false, 1, [], { type: "text", text: {} }, { type: "text", text: "Visible" }] }),
  ]);
  assert.equal(result.snapshot.nodes.length, 3);
  assert.match(result.text, /Visible/);
  assert.doesNotMatch(result.text, /HIDDEN/);
  assert.ok(result.snapshot.limitations.some((note) => note.includes("2 unsupported")));
});

test("tool blocks, arguments, result details and nested metadata are shallowly guarded", () => {
  const result = episodeText([
    message("u", null, "user", { content: "Run checks" }),
    message("call", "u", "assistant", { content: [
      null, false, 2, [], { type: "toolCall", id: null, name: "bash" },
      { type: "toolCall", id: "ignored", name: {} },
      { type: "toolCall", id: "c", name: "bash", arguments: ["HIDDEN ARG"] },
    ] }),
    message("result", "call", "toolResult", {
      content: [{ type: "text", text: "2 tests passed" }, { type: "image", data: "HIDDEN IMAGE" }],
      toolCallId: "c", toolName: "bash", isError: false, details: [0],
      nestedCalls: { complete: false, calls: [null, 3, [], { name: "read", status: "ok", content: "HIDDEN BODY" }] },
    }),
    message("bash", "result", "bashExecution", { command: { toString: "HIDDEN COMMAND" }, exitCode: 0, output: false }),
  ]);
  assert.equal(result.episodes[0].outcome, "unknown", "invalid arguments must not invent a verification command");
  assert.match(result.text, /ancestry-paired/);
  assert.match(result.text, /read: ok/);
  assert.match(result.text, /User bash: \[unknown\]/);
  assert.doesNotMatch(result.text, /HIDDEN|exitCode=\[object/);
});

test("unsupported marker data cannot coerce objects or suppress unrelated ordinary work", () => {
  const result = episodeText([
    { type: "custom", id: "marker", parentId: null, timestamp, customType: "project-refine/event", data: { phase: { toString: "not callable" } } },
    message("u", "marker", "user", { content: "Visible request" }),
    message("a", "u", "assistant", { content: "Visible answer", nestedCalls: null }),
  ]);
  assert.match(result.text, /Visible request/);
  assert.match(result.text, /Visible answer/);
});

test("malformed messages are rejected rather than interpreted as supported history", () => {
  for (const invalid of [null, [], "user", { role: 3 }, {}]) {
    assert.throws(() => parseSessionSnapshot(jsonl([header, {
      type: "message", id: "bad", parentId: null, timestamp, message: invalid,
    }]), "invalid.jsonl", worktree), /invalid message/);
  }
});

test("collection preserves source bytes and modification time after guarded parsing", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const metadata = await stat(f.file);
  const collection = await collectSessions(f.scope, { sessionRoots: [f.store], since: 0 });
  assert.equal(collection.episodes.length, 1);
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await stat(f.file)).mtimeMs, metadata.mtimeMs);
});

for (const [phase, replacementOpen] of [["header", 1], ["snapshot", 2]] as const) {
  test(`a cataloged file replaced by a FIFO before ${phase} open cannot wait for a writer`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await fixture(t);
    const sessionsModule = new URL("../pi-extension/project-refine/core/sessions.ts", import.meta.url).href;
    // Isolate the filesystem hook and bound the child: regressing to blocking
    // open must fail the test, not wedge the entire test runner.
    const script = `
      import { execFileSync } from "node:child_process";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { collectSessions } from ${JSON.stringify(sessionsModule)};
      const file = ${JSON.stringify(f.file)};
      const open = fs.open;
      let opens = 0;
      fs.open = async function (path, ...args) {
        if (path === file && ++opens === ${replacementOpen}) {
          await fs.unlink(file);
          execFileSync("mkfifo", [file]);
        }
        return open.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const result = await collectSessions(${JSON.stringify(f.scope)}, { sessionRoots: [${JSON.stringify(f.store)}], since: 0 });
      console.log(JSON.stringify(result));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
    const collection: unknown = JSON.parse(stdout.trim());
    assert.match(JSON.stringify(collection), /not a regular session file/);
    assert.ok((await stat(f.file)).isFIFO());
  });
}
