import assert from "node:assert/strict";
import test from "node:test";
import { validateProposals, renderEdits } from "../pi-extension/project-refine/core/proposals.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";
import type { EvidenceEpisode, ResourceManifest } from "../pi-extension/project-refine/core/types.ts";

const content = "# Project\nRun npm test.\n";
const manifest: ResourceManifest = { digest: digest(content), warnings: [], resources: [
  { path: "AGENTS.md", kind: "instruction", hash: digest(content), content, editable: true },
  { path: ".pi/settings.json", kind: "setup", hash: digest("{}"), content: "{}", editable: false },
] };
const episodes: EvidenceEpisode[] = [{ id: "ep", sessionId: "session", leafId: "a", worktreeId: "main", entryIds: ["session:u"], activityAt: new Date().toISOString(),
  kind: "correction", outcome: "unknown", limitations: [], excerpts: [{ entryId: "session:u", source: "human", text: "Please use pnpm test, not npm test.", truncated: false }] }];
const wire = () => ({ category: "instructions", scope: "project-wide", problem: "Test runner correction", suggestion: "Use pnpm for project tests.",
  expectedEffect: "Avoid repeating the observed command correction.", exceptions: "Only this repository; behavior not evaluated.", confidence: "medium",
  citations: [{ entryId: "session:u", quote: "Please use pnpm test" }],
  edits: [{ path: "AGENTS.md", baseHash: digest(content), oldText: "Run npm test.", newText: "Run pnpm test." }] });

test("proposal validation returns a digest and a pure exact diff, including a valid no-op conclusion", () => {
  const baseline = JSON.stringify(manifest);
  const proposals = validateProposals({ proposals: [wire()] }, "project", manifest, episodes);
  assert.match(proposals[0].id, /^[a-f0-9]{64}$/);
  assert.match(proposals[0].diffs[0], /\+Run pnpm test\./);
  assert.equal(proposals[0].validation, "structural-only; behavior not evaluated");
  assert.equal(JSON.stringify(manifest), baseline);
  assert.deepEqual(validateProposals({ proposals: [] }, "project", manifest, episodes), []);
});

test("proposal validation rejects malformed shape, invented citations and unsupported quotes", () => {
  for (const raw of [{}, { proposals: [{ ...wire(), extra: true }] }, { proposals: [wire(), wire(), wire(), wire()] }]) {
    assert.throws(() => validateProposals(raw, "project", manifest, episodes), /schema/);
  }
  for (const citations of [[{ entryId: "other:u", quote: "Please use pnpm test" }], [{ entryId: "session:u", quote: "The tests all passed" }]]) {
    assert.throws(() => validateProposals({ proposals: [{ ...wire(), citations }] }, "project", manifest, episodes), /citation|quote/);
  }
});

test("proposal targets cannot traverse, rewrite settings, use stale hashes or ambiguous anchors", () => {
  const base = wire().edits[0];
  const cases = [
    { ...base, path: "../AGENTS.md" }, { ...base, path: "/tmp/AGENTS.md" }, { ...base, path: "x/../AGENTS.md" },
    { ...base, path: "x\\AGENTS.md" }, { ...base, path: ".pi/settings.json" }, { ...base, baseHash: digest("old") },
    { ...base, oldText: "" }, { ...base, oldText: "not found" }, { ...base, oldText: "Run", newText: "Run" },
  ];
  for (const edit of cases) assert.throws(() => renderEdits([edit], manifest));
  const repeated = { ...manifest, resources: [{ ...manifest.resources[0], content: "repeat repeat", hash: digest("repeat repeat") }] };
  assert.throws(() => renderEdits([{ ...base, oldText: "repeat", baseHash: digest("repeat repeat") }], repeated), /ambiguous/);
  assert.throws(() => renderEdits([base, { ...base, oldText: "npm test.", newText: "pnpm test." }], manifest), /overlap/);
});

test("new skills require an established directory and valid non-colliding frontmatter", () => {
  const skill = "---\nname: tests\ndescription: Run tests.\n---\nUse pnpm.\n";
  const skills = { ...manifest, resources: [...manifest.resources, { path: ".github/skills/tests/SKILL.md", kind: "skill" as const,
    hash: digest(skill), content: skill, editable: true }] };
  const edit = { path: ".github/skills/checks/SKILL.md", baseHash: null, oldText: "", newText: skill.replace("name: tests", "name: checks") };
  assert.equal(renderEdits([edit], skills).length, 1);
  assert.throws(() => renderEdits([edit], manifest), /new-file/);
  assert.throws(() => renderEdits([{ ...edit, newText: skill }], skills), /collides/);
  assert.throws(() => renderEdits([{ ...edit, newText: "missing frontmatter" }], skills), /frontmatter|description/);
});

test("all proposals together must have disjoint edits and preserve CRLF", () => {
  assert.throws(() => validateProposals({ proposals: [wire(), wire()] }, "project", manifest, episodes), /overlap/);
  const original = "Run npm test.\r\nEnd\r\n";
  const crlf = { ...manifest, resources: [{ ...manifest.resources[0], content: original, hash: digest(original) }] };
  assert.throws(() => renderEdits([{ path: "AGENTS.md", baseHash: digest(original), oldText: "Run npm test.\r\n", newText: "Run pnpm test.\n" }], crlf), /CRLF/);
});
