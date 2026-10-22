import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSessions, parseSessionSnapshot, SESSION_LIMITS } from "../pi-extension/project-refine/core/sessions.ts";
import { extractEpisodes } from "../pi-extension/project-refine/core/episodes.ts";
import { historyMessage } from "../pi-extension/project-refine/core/history.ts";
import { discoverProject } from "../pi-extension/project-refine/core/project.ts";
import type { ProjectScope, Worktree } from "../pi-extension/project-refine/core/types.ts";

const old = "2001-01-01T00:00:00.000Z";
const recent = "2026-01-20T00:00:00.000Z";
const since = Date.parse("2026-01-01");
function entry(id: string, parentId: string | null, role: string, content: any, extra: Record<string, any> = {}) {
  return { type: "message", id, parentId, timestamp: recent, message: { role, content, ...extra } };
}
function header(id: string, cwd: string, extra: Record<string, any> = {}) { return { type: "session", version: 3, id, cwd, timestamp: old, ...extra }; }
function jsonl(rows: unknown[]) { return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"; }
function fixture(t: test.TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "project-refine-session-")));
  const root = join(base, "project");
  const store = join(base, "custom store");
  mkdirSync(root); mkdirSync(store);
  const wt: Worktree = { id: "main", root, available: true, historical: false };
  const scope: ProjectScope = { id: "project", root, kind: "directory", worktrees: [wt], warnings: [] };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  function save(name: string, rows: unknown[], tail = "") {
    const file = join(store, name);
    writeFileSync(file, jsonl(rows) + tail);
    return file;
  }
  return { base, root, store, wt, scope, save };
}
const textOf = (episodes: Awaited<ReturnType<typeof collectSessions>>["episodes"]) => episodes.flatMap((e) => e.excerpts.map((x) => x.text)).join("\n");

test("resumed old filenames use activity dates, nested cwd matches, source bytes/mtime and project stay unchanged", async (t) => {
  const f = fixture(t);
  const nested = join(f.root, "src"); mkdirSync(nested);
  const guidance = join(f.root, "AGENTS.md"); writeFileSync(guidance, "Do not change me\n");
  const file = f.save("2001_old.jsonl", [header("resumed", nested),
    { ...entry("old", null, "user", "Original request"), timestamp: old },
    entry("new", "old", "user", "Actually use the supported API"), entry("done", "new", "assistant", "Done")]);
  const before = readFileSync(file); const mtime = statSync(file).mtimeMs;
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.filesScanned, 1); assert.equal(result.matchedSessions, 1);
  assert.equal(result.episodes.length, 1); assert.equal(result.episodes[0].kind, "correction");
  assert.equal(result.episodes[0].outcome, "unknown");
  assert.equal(result.episodes[0].activityAt, recent);
  assert.deepEqual(result.perWorktree.main, { sessions: 1, episodes: 1 });
  assert.match(textOf(result.episodes), /Original request/);
  assert.ok(result.episodes[0].entryIds.every((id) => id.startsWith("resumed:")));
  assert.deepEqual(readFileSync(file), before); assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(readFileSync(guidance, "utf8"), "Do not change me\n");
});

test("catalog attributes cwd before parsing transcript bodies; filename/directory slugs do not grant membership", async (t) => {
  const f = fixture(t); const elsewhere = join(f.base, "elsewhere"); mkdirSync(elsewhere);
  f.save("unrelated.jsonl", [header("foreign", elsewhere)], "NOT JSON COMPLETE LINE\n");
  f.save("included.jsonl", [header("local", f.root), entry("u", null, "user", "Local request")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.filesScanned, 2); assert.equal(result.matchedSessions, 1);
  assert.equal(result.episodes[0].sessionId, "local");
  assert.ok(!result.warnings.some((warning) => warning.includes("NOT JSON") || warning.includes("unrelated.jsonl")));
});

test("branch ancestry never pairs sibling calls/results or flattens multiple roots", async (t) => {
  const f = fixture(t);
  f.save("tree.jsonl", [header("tree", f.root), entry("u", null, "user", "Task A"),
    entry("call", "u", "assistant", [{ type: "toolCall", id: "test", name: "bash", arguments: { command: "npm test" } }]),
    entry("left", "call", "toolResult", "2 tests passed", { toolCallId: "test", toolName: "bash", isError: false, details: { exitCode: 0 } }),
    entry("right", "u", "toolResult", "2 tests passed", { toolCallId: "test", toolName: "bash", isError: false, details: { exitCode: 0 } }),
    entry("root2", null, "user", "Independent root")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 3);
  const left = result.episodes.find((e) => e.leafId === "left")!;
  const right = result.episodes.find((e) => e.leafId === "right")!;
  assert.equal(left.outcome, "observed-success"); assert.equal(right.outcome, "unknown");
  assert.ok(right.limitations.some((s) => s.includes("Unpaired")));
  assert.ok(!right.entryIds.includes("tree:call"));
  const second = result.episodes.find((e) => e.leafId === "root2")!;
  assert.deepEqual(second.entryIds, ["tree:root2"]);
});

test("completed shared-ancestor windows are deduplicated while divergent suffixes remain", async (t) => {
  const f = fixture(t);
  f.save("branches.jsonl", [header("branches", f.root), entry("u", null, "user", "Common task"), entry("a", "u", "assistant", "Common answer"),
    entry("l", "a", "user", "Left task"), entry("r", "a", "user", "Right task")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 3);
  assert.equal(result.episodes.filter((e) => e.entryIds.includes("branches:u")).length, 1);
  assert.match(textOf(result.episodes), /Left task/); assert.match(textOf(result.episodes), /Right task/);
});

test("verified related fork copies share source identities, unrelated equal text does not", async (t) => {
  const f = fixture(t);
  const common = [entry("u", null, "user", "Identical task"), entry("a", "u", "assistant", "Identical answer")];
  const parent = f.save("a-parent.jsonl", [header("parent", f.root), ...common]);
  f.save("b-fork.jsonl", [header("fork", f.root, { parentSession: parent }), ...common, entry("new", "a", "user", "Divergent fork request")]);
  f.save("c-independent.jsonl", [header("independent", f.root), ...common]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 3); assert.equal(result.episodes.length, 3);
  assert.equal(result.episodes.filter((e) => textOf([e]).includes("Identical task")).length, 2);
  assert.ok(result.episodes.some((e) => e.entryIds.includes("independent:u")));
  assert.ok(result.episodes.some((e) => e.entryIds.includes("parent:u")));
});

test("fork claims without exact copied prefix never merge distinct observations", async (t) => {
  const f = fixture(t);
  const parent = f.save("a.jsonl", [header("one", f.root), entry("u", null, "user", "Same task")]);
  f.save("b.jsonl", [header("two", f.root, { parentSession: parent }), { ...entry("u", null, "user", "Same task"), timestamp: old }, entry("a", "u", "assistant", "Recent continuation")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 2);
  assert.ok(result.episodes.some((e) => e.entryIds.includes("two:u")));
});

test("cyclic fork metadata cannot turn equal text into a verified shared source", async (t) => {
  const f = fixture(t);
  const common = entry("u", null, "user", "Repeated correction");
  f.save("a-cycle.jsonl", [header("cycle-a", f.root, { parentSession: join(f.store, "b-cycle.jsonl") }), common]);
  f.save("b-cycle.jsonl", [header("cycle-b", f.root, { parentSession: join(f.store, "a-cycle.jsonl") }), common]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 2);
  assert.ok(result.warnings.some((s) => /cyclic.*fork metadata/.test(s)));
});

test("legacy v1 linear graph and v2 hook messages are adapted purely with stable synthetic citations", (t) => {
  const f = fixture(t);
  const text = jsonl([header("legacy", f.root, { version: 1 }), { type: "message", timestamp: recent, message: { role: "user", content: "Legacy request" } },
    { type: "message", timestamp: recent, message: { role: "assistant", content: [{ type: "text", text: "Legacy answer" }, { type: "thinking", thinking: "HIDDEN THINKING" }, { type: "image", data: "HIDDEN IMAGE" }] } }]);
  const first = parseSessionSnapshot(text, "legacy.jsonl", f.wt);
  const second = parseSessionSnapshot(text, "legacy.jsonl", f.wt);
  assert.deepEqual(first.nodes.map((n) => n.id), second.nodes.map((n) => n.id));
  assert.equal(first.nodes[1].parentId, first.nodes[0].id);
  const episodes = extractEpisodes([first], { since });
  assert.match(textOf(episodes), /Legacy answer/); assert.doesNotMatch(textOf(episodes), /HIDDEN/);
  assert.match(episodes[0].entryIds[0], /^legacy:legacy-line-/);
  const v2 = parseSessionSnapshot(jsonl([header("v2", f.root, { version: 2 }), entry("hook", null, "hookMessage", "HIDDEN CUSTOM"), entry("u", "hook", "user", "Visible")]), "v2", f.wt);
  assert.equal(historyMessage(v2.nodes[0].raw.message)?.role, "custom");
  assert.doesNotMatch(textOf(extractEpisodes([v2], { since })), /HIDDEN CUSTOM/);
});

test("compaction/context edits preserve raw evidence but explicitly deny visibility reconstruction", async (t) => {
  const f = fixture(t);
  f.save("context.jsonl", [header("context", f.root), entry("u", null, "user", "Original raw instruction"),
    { type: "compaction", id: "c", parentId: "u", timestamp: recent, summary: "Summary claim", firstKeptEntryId: "c" },
    { type: "context_edit", id: "e", parentId: "c", timestamp: recent, targetId: "u", replacement: null },
    entry("a", "e", "assistant", "Done")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.match(textOf(result.episodes), /Original raw instruction/);
  assert.ok(result.episodes[0].excerpts.some((e) => e.source === "summary"));
  assert.ok(result.episodes[0].limitations.some((s) => /Compaction present/.test(s)));
  assert.ok(result.episodes[0].limitations.some((s) => /Context edits present/.test(s)));
  assert.equal(result.episodes[0].outcome, "unknown");
});

test("correction episodes retain failure, preceding command and subsequent observed recovery; assistant done alone is unknown", async (t) => {
  const f = fixture(t);
  f.save("recovery.jsonl", [header("recovery", f.root), entry("u", null, "user", "Run the checks"),
    entry("call1", "u", "assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }]),
    entry("fail", "call1", "toolResult", "Missing setup", { toolCallId: "c1", toolName: "bash", isError: true }),
    entry("correct", "fail", "user", "Actually install dependencies before testing"),
    entry("call2", "correct", "assistant", [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }]),
    entry("pass", "call2", "toolResult", "12 tests passed", { toolCallId: "c2", toolName: "bash", isError: false, details: { exitCode: 0 } }),
    entry("done", "pass", "assistant", "Done")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 1); const episode = result.episodes[0];
  assert.equal(episode.kind, "correction"); assert.equal(episode.outcome, "observed-success");
  for (const id of ["call1", "fail", "correct", "call2", "pass"]) assert.ok(episode.entryIds.includes(`recovery:${id}`));
  assert.ok(episode.limitations.some((s) => /not overall task success/.test(s)));
});

test("later failures override earlier passing verification; ordinary non-error tool output is not task success", (t) => {
  const f = fixture(t);
  const parsed = parseSessionSnapshot(jsonl([header("outcomes", f.root), entry("u", null, "user", "Task"),
    entry("c1", "u", "assistant", [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "npm test" } }]),
    entry("r1", "c1", "toolResult", "2 tests passed", { toolCallId: "x", toolName: "bash", isError: false }),
    entry("c2", "r1", "assistant", [{ type: "toolCall", id: "y", name: "bash", arguments: { command: "npm test" } }]),
    entry("r2", "c2", "toolResult", "Failed", { toolCallId: "y", toolName: "bash", isError: true }), entry("a", "r2", "assistant", "Done")]), "outcomes", f.wt);
  assert.equal(extractEpisodes([parsed], { since })[0].outcome, "observed-failure");
  const read = parseSessionSnapshot(jsonl([header("read", f.root), entry("c", null, "assistant", [{ type: "toolCall", id: "r", name: "read", arguments: { path: "file" } }]),
    entry("r", "c", "toolResult", "Contents", { toolCallId: "r", toolName: "read", isError: false })]), "read", f.wt);
  assert.equal(extractEpisodes([read], { since })[0].outcome, "unknown");
});

test("safe custom/user-bash handling and conservative skill-read/nested metadata evidence", async (t) => {
  const f = fixture(t);
  f.save("skills.jsonl", [header("skills", f.root),
    { type: "custom_message", id: "hidden", parentId: null, timestamp: recent, customType: "extension", display: false, content: "HIDDEN BODY" },
    entry("user", "hidden", "user", [{ type: "text", text: "Use skill" }, { type: "image", data: "IMAGE SECRET" }]),
    entry("call", "user", "assistant", [{ type: "thinking", thinking: "THINKING SECRET" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "/skills/example/SKILL.md", unrelatedSecret: "SECRET ARG" } }]),
    entry("result", "call", "toolResult", "Skill content", { toolCallId: "read", toolName: "read", isError: false, details: { secret: "SECRET DETAIL" }, nestedCalls: { complete: false, calls: [{ id: "nested", name: "read", status: "ok", arguments: { path: "/another/SKILL.md", secret: "SECRET NESTED" }, content: "SECRET NESTED BODY" }] } }),
    entry("bash", "result", "bashExecution", undefined, { command: "npm test", output: "2 tests passed", exitCode: 0, cancelled: false, truncated: true, excludeFromContext: true, fullOutputPath: "/never/read/this" }),
    entry("custom", "bash", "custom", "HIDDEN CUSTOM", { display: true })]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  const text = textOf(result.episodes);
  assert.doesNotMatch(text, /SECRET|HIDDEN|never\/read/);
  assert.match(text, /Skill read attempt only/); assert.match(text, /actual activation.*unverified/);
  assert.match(text, /Nested-call metadata only/); assert.match(text, /User bash/);
  assert.ok(result.episodes[0].limitations.some((s) => /excludeFromContext/.test(s)));
  assert.ok(result.episodes[0].limitations.some((s) => /truncated/.test(s)));
});

test("current-session entry boundary freezes history; null/missing/unknown cutoff is safe", async (t) => {
  const f = fixture(t);
  f.save("active.jsonl", [header("active", f.root), entry("u", null, "user", "Before"), entry("a", "u", "assistant", "Before answer"),
    entry("later", "a", "user", "AFTER CUTOFF"), entry("answer", "later", "assistant", "AFTER ANSWER")]);
  const options = { sessionRoots: [f.store], since, currentSessionId: "active" };
  const result = await collectSessions(f.scope, { ...options, currentEntryId: "a" });
  assert.doesNotMatch(textOf(result.episodes), /AFTER/); assert.match(textOf(result.episodes), /Before/);
  assert.equal((await collectSessions(f.scope, { ...options, currentEntryId: null })).episodes.length, 0);
  for (const cutoff of [undefined, "absent"]) {
    const skipped = await collectSessions(f.scope, { ...options, currentEntryId: cutoff });
    assert.equal(skipped.episodes.length, 0); assert.ok(skipped.warnings.some((s) => /cutoff/.test(s)));
  }
});

test("refinement ledger intervals are ancestry-local (after,before], propagate to verified forks, and preserve ordinary work", async (t) => {
  const f = fixture(t);
  const nodes = [entry("u", null, "user", "Ordinary before"), entry("generated", "u", "assistant", "GENERATED INTERVAL"),
    entry("end", "generated", "assistant", "GENERATED END"), entry("later", "end", "user", "Ordinary after")];
  const file = f.save("a-parent.jsonl", [header("p", f.root), ...nodes]);
  f.save("b-fork.jsonl", [header("f", f.root, { parentSession: file }), ...nodes]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since,
    intervals: [{ sessionId: "p", afterEntryId: "u", beforeEntryId: "end" }] });
  assert.doesNotMatch(textOf(result.episodes), /GENERATED/);
  assert.match(textOf(result.episodes), /Ordinary before/); assert.match(textOf(result.episodes), /Ordinary after/);
  assert.equal(result.episodes.length, 2);
});

test("/project-refine requests and custom run markers suppress generated content without dropping entire session", async (t) => {
  const f = fixture(t);
  f.save("refine.jsonl", [header("refine", f.root), entry("u", null, "user", "Ordinary task"),
    entry("cmd", "u", "user", "/project-refine propose --since 14d"), entry("generated", "cmd", "assistant", "GENERATED ANALYSIS"),
    entry("next", "generated", "user", "Ordinary next"),
    { type: "custom", id: "start", parentId: "next", timestamp: recent, customType: "project-refine/start", data: { phase: "start", secret: "SECRET MARKER" } },
    entry("generated2", "start", "assistant", "GENERATED MARKER ANALYSIS"),
    { type: "custom", id: "end", parentId: "generated2", timestamp: recent, customType: "project-refine/end", data: { phase: "end" } },
    entry("last", "end", "user", "Ordinary last")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  const text = textOf(result.episodes);
  assert.doesNotMatch(text, /GENERATED|project-refine|SECRET/);
  for (const word of ["task", "next", "last"]) assert.match(text, new RegExp(`Ordinary ${word}`));
});

test("malformed complete lines, duplicate/orphan IDs and unsupported versions are explicit; torn tails are partial", async (t) => {
  const f = fixture(t);
  f.save("version.jsonl", [header("future", f.root, { version: 999 })]);
  f.save("malformed.jsonl", [header("bad", f.root), entry("u", null, "user", "Should not leak from corrupt file")], "{oops}\n");
  f.save("duplicate.jsonl", [header("dup", f.root), entry("u", null, "user", "One"), entry("u", null, "user", "Two")]);
  f.save("orphan.jsonl", [header("orphan", f.root), entry("u", "absent", "user", "Orphan")]);
  const torn = f.save("torn.jsonl", [header("torn", f.root), entry("u", null, "user", "Complete evidence")], '{"type":"message","id":"unfinished');
  const before = readFileSync(torn); const mtime = statSync(torn).mtimeMs;
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.filesScanned, 5); assert.equal(result.matchedSessions, 1); assert.equal(result.episodes.length, 1);
  for (const expected of [/unsupported session version/, /malformed complete/, /duplicate entry/, /orphan\/forward/, /torn/]) assert.ok(result.warnings.some((s) => expected.test(s)));
  assert.match(textOf(result.episodes), /Complete evidence/); assert.doesNotMatch(textOf(result.episodes), /Should not leak/);
  assert.deepEqual(readFileSync(torn), before); assert.equal(statSync(torn).mtimeMs, mtime);
});

test("missing activity cannot fall back to filename/header date, and old-only activity is omitted", async (t) => {
  const f = fixture(t);
  f.save("2026-recent-name.jsonl", [header("old", f.root), { ...entry("u", null, "user", "Old request"), timestamp: old }]);
  f.save("2026-missing-time.jsonl", [header("missing", f.root), { ...entry("u", null, "user", "Unknown date"), timestamp: "invalid" }]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 2); assert.equal(result.episodes.length, 0);
  assert.ok(result.warnings.some((s) => /activity timestamp/.test(s)));
});

test("no symlinks, bounded nested catalog depth, and unavailable stores are disclosed", async (t) => {
  const f = fixture(t);
  const outside = join(f.base, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "hidden.jsonl"), jsonl([header("escape", f.root), entry("u", null, "user", "Do not collect") ]));
  symlinkSync(outside, join(f.store, "linkdir")); symlinkSync(join(outside, "hidden.jsonl"), join(f.store, "link.jsonl"));
  let nested = f.store;
  for (let i = 0; i < SESSION_LIMITS.depth + 1; i++) { nested = join(nested, "nested"); mkdirSync(nested); }
  writeFileSync(join(nested, "deep.jsonl"), jsonl([header("deep", f.root), entry("u", null, "user", "Too deep")]));
  const result = await collectSessions(f.scope, { sessionRoots: [f.store, join(f.base, "missing")], since });
  assert.equal(result.episodes.length, 0); assert.equal(result.filesScanned, 0);
  for (const expected of [/symlink/, /traversal limit/, /unavailable/]) assert.ok(result.warnings.some((s) => expected.test(s)));
  const linked = await collectSessions(f.scope, { sessionRoots: [join(f.store, "linkdir")], since });
  assert.equal(linked.filesScanned, 0); assert.ok(linked.warnings.some((s) => /symlinked/.test(s)));
});

test("snapshot byte, node, branch, episode and excerpt bounds are explicit", async (t) => {
  const f = fixture(t);
  f.save("large.jsonl", [header("large", f.root), entry("u", null, "user", "Bounded evidence")], JSON.stringify(entry("oversized", "u", "assistant", "x".repeat(SESSION_LIMITS.snapshotBytes))) + "\n");
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.episodes.length, 1); assert.ok(result.warnings.some((s) => /byte budget/.test(s)));
  const nodes: unknown[] = [header("nodes", f.root)];
  for (let i = 0; i <= SESSION_LIMITS.nodes; i++) nodes.push(entry(`n${i}`, i ? `n${i - 1}` : null, "user", `Request ${i}`));
  const parsed = parseSessionSnapshot(jsonl(nodes), "nodes", f.wt);
  assert.equal(parsed.nodes.length, SESSION_LIMITS.nodes); assert.ok(parsed.limitations.some((s) => /Node limit/.test(s)));
  const warnings: string[] = [];
  const episodes = extractEpisodes([parsed], { since }, (s) => warnings.push(s));
  assert.equal(episodes.length, SESSION_LIMITS.episodes); assert.ok(warnings.some((s) => /Episode catalog limit/.test(s)));
  const branchRows = [header("branches", f.root), entry("root", null, "user", "Root")];
  for (let i = 0; i < SESSION_LIMITS.branches + 2; i++) branchRows.push(entry(`b${i}`, "root", "assistant", `Leaf ${i}`));
  const branched = parseSessionSnapshot(jsonl(branchRows), "branches", f.wt);
  assert.equal(extractEpisodes([branched], { since }, (s) => warnings.push(s)).length, SESSION_LIMITS.branches);
  assert.ok(warnings.some((s) => /branch limit/.test(s)));
  const long = parseSessionSnapshot(jsonl([header("long", f.root), entry("u", null, "user", "z".repeat(3000))]), "long", f.wt);
  const clipped = extractEpisodes([long], { since })[0];
  assert.ok(clipped.excerpts[0].truncated); assert.ok(clipped.excerpts[0].text.length < 2100);
});

test("conflicting session citation namespaces are omitted, byte-identical duplicate files count once", async (t) => {
  const f = fixture(t);
  const common = [header("same", f.root), entry("u", null, "user", "Same event")];
  f.save("a.jsonl", common); f.save("b.jsonl", common);
  let result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 1); assert.equal(result.episodes.length, 1);
  f.save("c.jsonl", [header("same", f.root), entry("u", null, "user", "Conflicting event")]);
  result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 0); assert.equal(result.episodes.length, 0);
  assert.ok(result.warnings.some((s) => /conflicting files/.test(s)));
});

test("Git linked worktrees/nested cwd match, separate clone and nested repository do not; Git index is unchanged", async (t) => {
  const f = fixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
  git(f.root, "init"); writeFileSync(join(f.root, "tracked"), "fixture\n"); git(f.root, "add", "tracked"); git(f.root, "commit", "-m", "fixture");
  const linked = join(f.base, "linked worktree"); git(f.root, "worktree", "add", "--detach", linked);
  const clone = join(f.base, "clone"); git(f.base, "clone", f.root, clone);
  const nested = join(f.root, "nested-repo"); mkdirSync(nested); git(nested, "init");
  const subdir = join(linked, "src"); mkdirSync(subdir);
  const scope = await discoverProject(f.root);
  f.save("main.jsonl", [header("main", f.root), entry("u", null, "user", "Main evidence")]);
  f.save("linked.jsonl", [header("linked", subdir), entry("u", null, "user", "Linked evidence")]);
  f.save("clone.jsonl", [header("clone", clone), entry("u", null, "user", "CLONE LEAK")]);
  f.save("nested.jsonl", [header("nested", nested), entry("u", null, "user", "NESTED LEAK")]);
  const index = join(f.root, ".git", "index"); const bytes = readFileSync(index); const mtime = statSync(index).mtimeMs;
  const result = await collectSessions(scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 2); assert.equal(result.episodes.length, 2);
  assert.equal(Object.values(result.perWorktree).filter((w) => w.sessions === 1).length, 2);
  assert.doesNotMatch(textOf(result.episodes), /LEAK/);
  assert.deepEqual(readFileSync(index), bytes); assert.equal(statSync(index).mtimeMs, mtime);
});

test("invalid UTF-8, overlong/incomplete headers and graph cycles are explicit corrupt inputs", async (t) => {
  const f = fixture(t);
  const badEncoding = Buffer.concat([Buffer.from(jsonl([header("encoding", f.root)])), Buffer.from('{"type":"message","id":"u","parentId":null,"timestamp":"' + recent + '","message":{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]);
  writeFileSync(join(f.store, "encoding.jsonl"), badEncoding);
  writeFileSync(join(f.store, "header-limit.jsonl"), jsonl([header("header", f.root, { ignored: "x".repeat(SESSION_LIMITS.headerBytes) })]));
  writeFileSync(join(f.store, "incomplete-header.jsonl"), JSON.stringify(header("partial", f.root)));
  f.save("cycle.jsonl", [header("cycle", f.root), entry("a", "b", "user", "Cycle"), entry("b", "a", "user", "Cycle")]);
  const result = await collectSessions(f.scope, { sessionRoots: [f.store], since });
  assert.equal(result.matchedSessions, 0); assert.equal(result.episodes.length, 0);
  assert.equal(result.warnings.filter((s) => s.includes("unsupported/corrupt/unreadable")).length, 4);
});

test("skill-read failures and nested ok metadata never establish loading; reused call IDs are ambiguous", (t) => {
  const f = fixture(t);
  const parsed = parseSessionSnapshot(jsonl([header("attempt", f.root),
    entry("a", null, "assistant", [{ type: "toolCall", id: "s", name: "read", arguments: { path: "/skill/SKILL.md" } }]),
    entry("r", "a", "toolResult", "No such file", { toolCallId: "s", toolName: "read", isError: true }),
    entry("c1", "r", "assistant", [{ type: "toolCall", id: "reuse", name: "bash", arguments: { command: "npm test" } }]),
    entry("c2", "c1", "assistant", [{ type: "toolCall", id: "reuse", name: "bash", arguments: { command: "npm test" } }]),
    entry("pass", "c2", "toolResult", "99 tests passed", { toolCallId: "reuse", toolName: "bash", isError: false, details: { exitCode: 0 } })]), "attempt", f.wt);
  const episode = extractEpisodes([parsed], { since })[0];
  assert.equal(episode.outcome, "observed-failure");
  assert.match(textOf([episode]), /Skill read attempt outcome unknown\/failed/);
  assert.ok(episode.limitations.some((s) => /Repeated tool call ID/.test(s)));
});

test("missing/incompatible refinement boundaries are conservatively excluded, not leaked", async (t) => {
  const f = fixture(t);
  f.save("interval.jsonl", [header("interval", f.root), entry("u", null, "user", "Before"), entry("left", "u", "assistant", "GENERATED LEFT"), entry("right", "u", "assistant", "GENERATED RIGHT")]);
  for (const interval of [
    { sessionId: "interval", afterEntryId: "missing", beforeEntryId: "left" },
    { sessionId: "interval", afterEntryId: "left", beforeEntryId: "right" },
  ]) {
    const result = await collectSessions(f.scope, { sessionRoots: [f.store], since, intervals: [interval] });
    assert.equal(result.episodes.length, 0);
    assert.ok(result.warnings.some((s) => /conservatively excluded/.test(s)));
  }
  const open = await collectSessions(f.scope, { sessionRoots: [f.store], since, intervals: [{ sessionId: "interval", afterEntryId: "u", beforeEntryId: "missing" }] });
  assert.doesNotMatch(textOf(open.episodes), /GENERATED/); assert.match(textOf(open.episodes), /Before/);
});

test("bounded excerpt selection keeps motivating failure, call and latest correction/recovery neighbors", (t) => {
  const f = fixture(t);
  const rows: unknown[] = [header("neighbors", f.root), entry("u", null, "user", "Initial task"),
    entry("call", "u", "assistant", [{ type: "toolCall", id: "fail", name: "bash", arguments: { command: "npm test" } }]),
    entry("fail", "call", "toolResult", "Motivating failure", { toolCallId: "fail", toolName: "bash", isError: true })];
  let parent = "fail";
  for (let i = 0; i < 40; i++) { const id = `comment${i}`; rows.push(entry(id, parent, "assistant", `Comment ${i}`)); parent = id; }
  rows.push(entry("correction", parent, "user", "Actually use the proper test command"),
    entry("retry", "correction", "assistant", [{ type: "toolCall", id: "pass", name: "bash", arguments: { command: "npm test" } }]),
    entry("pass", "retry", "toolResult", "10 tests passed", { toolCallId: "pass", toolName: "bash", isError: false }));
  const episode = extractEpisodes([parseSessionSnapshot(jsonl(rows), "neighbors", f.wt)], { since })[0];
  assert.ok(episode.excerpts.length <= SESSION_LIMITS.excerpts);
  for (const id of ["u", "call", "fail", "correction", "retry", "pass"]) assert.ok(episode.entryIds.includes(`neighbors:${id}`));
  assert.ok(episode.limitations.some((s) => /Excerpt limit/.test(s)));
});

test("abort is propagated without writes, and empty stores return honest coverage warnings", async (t) => {
  const f = fixture(t);
  const file = f.save("one.jsonl", [header("one", f.root), entry("u", null, "user", "Untouched")]);
  const bytes = readFileSync(file); const mtime = statSync(file).mtimeMs;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectSessions(f.scope, { sessionRoots: [f.store], since, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(readFileSync(file), bytes); assert.equal(statSync(file).mtimeMs, mtime);
  const empty = await collectSessions(f.scope, { sessionRoots: [], since });
  assert.equal(empty.filesScanned, 0); assert.equal(empty.episodes.length, 0);
  assert.ok(empty.warnings.some((s) => /No session stores/.test(s)));
});
