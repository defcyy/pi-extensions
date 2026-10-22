import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_RESOURCE_BYTES, readResourceSnapshot } from "../pi-extension/project-refine/core/files.ts";
import { discoverProject } from "../pi-extension/project-refine/core/project.ts";
import { renderEdits, validateProposals } from "../pi-extension/project-refine/core/proposals.ts";
import { inventoryResources } from "../pi-extension/project-refine/core/resources.ts";
import { existingSkillName, skillFields } from "../pi-extension/project-refine/core/skill-metadata.ts";
import type { EvidenceEpisode, Resource, ResourceManifest } from "../pi-extension/project-refine/core/types.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "refine-resource-hardening-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Run project checks.\n---\nUse pnpm.\n`;
const resource = (path: string, content: string, kind: Resource["kind"] = "skill"): Resource => ({
  path, content, kind, hash: digest(content), editable: true,
});
const manifest = (resources: Resource[]): ResourceManifest => ({ digest: digest(resources), resources, warnings: [] });
const instructions = resource("AGENTS.md", "Run npm test.\n", "instruction");
const established = resource(".pi/skills/checks/SKILL.md", skill("checks"));
const disclosed = manifest([instructions, established]);
const episodes: EvidenceEpisode[] = [{
  id: "episode", sessionId: "session", leafId: "user", worktreeId: "main", entryIds: ["session:user"],
  activityAt: "2026-01-01T00:00:00.000Z", kind: "correction", outcome: "unknown", limitations: [],
  excerpts: [{ entryId: "session:user", source: "human", text: "Use pnpm test instead of npm test.", truncated: false }],
}];
const advisory = {
  category: "workflow", scope: "project-wide", problem: "Repeated test runner correction.",
  suggestion: "Use pnpm test.", expectedEffect: "Avoid repeating the correction.", exceptions: "Only this project.",
  confidence: "medium", citations: [{ entryId: "session:user", quote: "Use pnpm test" }], edits: [],
};

const malformedSkills = [
  resource(".pi/skills/unclosed/SKILL.md", "---\nname: unclosed\nmetadata: [broken\n"),
  resource(".pi/skills/occupied/SKILL.md", "---\nname: occupied\ndescription: null\nmetadata: [broken\n---\nBody\n"),
  resource(".pi/skills/fallback/SKILL.md", "---\nmetadata: [broken\n---\nBody\n"),
  resource(".pi/skills/legacy.md", "---\nmetadata: !!not-a-routing-scalar value\n---\nBody\n"),
  resource(".pi/skills/list/SKILL.md", "---\n- not\n- a mapping\n---\nBody\n"),
  resource(".pi/skills/plain/SKILL.md", "No frontmatter at all.\n"),
];

test("unrelated malformed existing skills never reject empty, advisory or instruction-only results", () => {
  const inventory = manifest([...disclosed.resources, ...malformedSkills]);
  assert.deepEqual(validateProposals({ proposals: [] }, "project", disclosed, episodes, inventory), []);
  const [proposal] = validateProposals({ proposals: [advisory] }, "project", disclosed, episodes, inventory);
  assert.deepEqual(proposal.diffs, []);
  const edit = { path: instructions.path, baseHash: instructions.hash, oldText: "npm test", newText: "pnpm test" };
  assert.equal(renderEdits([edit], disclosed, inventory).length, 1);
  assert.equal(renderEdits([], inventory).length, 0);
});

test("full-inventory collisions retain scalar names and directory/file fallback despite malformed frontmatter", () => {
  const inventory = manifest([...disclosed.resources, ...malformedSkills]);
  for (const name of ["unclosed", "occupied", "fallback", "legacy", "list", "plain"]) {
    const edit = { path: ".pi/skills/new/SKILL.md", baseHash: null, oldText: "", newText: skill(name) };
    assert.throws(() => renderEdits([edit], disclosed, inventory), /collides/, name);
    assert.throws(() => renderEdits([{
      path: established.path, baseHash: established.hash, oldText: "name: checks", newText: `name: ${name}`,
    }], disclosed, inventory), /collides/, `rename to ${name}`);
  }
  assert.equal(renderEdits([{
    path: ".pi/skills/new/SKILL.md", baseHash: null, oldText: "", newText: skill("new"),
  }], disclosed, inventory).length, 1);
});

test("proposed skills remain strict even though existing skills are tolerant", () => {
  const invalid = [
    "No frontmatter", skill("Bad--Name"), skill("x".repeat(65)),
    skill("valid").replace("description: Run project checks.", "description: null"),
    skill("valid").replace("description: Run project checks.", `description: ${"x".repeat(1025)}`),
    skill("valid").replace("---\nUse pnpm.", "metadata: [broken\n---\nUse pnpm."),
    "---\nnull\n---\nBody\n", "---\n- array\n---\nBody\n",
  ];
  for (const newText of invalid) {
    assert.throws(() => renderEdits([{
      path: ".pi/skills/new/SKILL.md", baseHash: null, oldText: "", newText,
    }], disclosed), /frontmatter|name and description/);
  }
});

test("tolerant skill routing reads only scalar data and diagnoses unsupported YAML", () => {
  const warnings: string[] = [];
  const content = "---\nname: reserved\ndescription: >-\n  Run checks\n  after edits.\nmetadata: [broken\nother: &alias !!tag value\n---\n";
  assert.deepEqual(skillFields(content, "skill.md", (message) => warnings.push(message)), {
    name: "reserved", description: "Run checks after edits.",
  });
  assert.match(warnings.join("\n"), /Unsupported non-string skill field metadata/);
  assert.match(warnings.join("\n"), /Unsupported non-string skill field other/);
  assert.equal(existingSkillName(content, ".pi/skills/fallback/SKILL.md"), "reserved");
  assert.equal(existingSkillName("---\nname: '   '\n---\n", ".pi/skills/fallback/SKILL.md"), "fallback");
});

test("bounded snapshots preserve exact UTF-8 bytes, BOM and CRLF at the byte limit", async (t) => {
  const root = sandbox(t);
  const path = join(root, "resource.md");
  const content = "\uFEFFé\r\n";
  const bytes = Buffer.byteLength(content);
  writeFileSync(path, content);
  assert.deepEqual(await readResourceSnapshot(path, { maxBytes: bytes }), { content, bytes });
  await assert.rejects(readResourceSnapshot(path, { maxBytes: bytes - 1 }), /byte limit/);
  writeFileSync(path, "x".repeat(MAX_RESOURCE_BYTES));
  assert.equal((await readResourceSnapshot(path)).bytes, MAX_RESOURCE_BYTES);
  appendFileSync(path, "x");
  await assert.rejects(readResourceSnapshot(path), /byte limit/);
  writeFileSync(path, "");
  assert.deepEqual(await readResourceSnapshot(path, { maxBytes: 0 }), { content: "", bytes: 0 });
  for (const maxBytes of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(readResourceSnapshot(path, { maxBytes }), RangeError);
  }
});

test("bounded snapshots reject invalid UTF-8, binary data, symlinks, directories and FIFOs", async (t) => {
  const root = sandbox(t);
  const path = join(root, "resource.md");
  writeFileSync(path, new Uint8Array([0xc3, 0x28]));
  await assert.rejects(readResourceSnapshot(path), /non-UTF-8/);
  writeFileSync(path, "text\0binary");
  await assert.rejects(readResourceSnapshot(path), /binary/);
  const link = join(root, "link.md");
  symlinkSync(path, link);
  await assert.rejects(readResourceSnapshot(link), { code: "ELOOP" });
  await assert.rejects(readResourceSnapshot(root), /non-regular/);
  const fifo = join(root, "pipe.md");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(readResourceSnapshot(fifo), /non-regular/);
});

/** Patch the handle prototype rather than ambient fs functions so races occur
 * deterministically between the reader's actual I/O and its final stat checks.
 */
async function afterRead(t: TestContext, path: string, action: () => void): Promise<void> {
  const probe = await open(path, "r");
  const prototype: Pick<FileHandle, "read"> = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let changed = false;
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!changed) {
      changed = true;
      action();
    }
    return result;
  });
}

test("snapshot identity is rechecked after reading, including replacement with equal-sized content", async (t) => {
  const root = sandbox(t);
  const path = join(root, "resource.md");
  const replacement = join(root, "replacement.md");
  writeFileSync(path, "original");
  writeFileSync(replacement, "replaced");
  await afterRead(t, path, () => renameSync(replacement, path));
  await assert.rejects(readResourceSnapshot(path), /changed/);
});

test("snapshots diagnose a path removed during reading as changed", async (t) => {
  const path = join(sandbox(t), "resource.md");
  writeFileSync(path, "original");
  await afterRead(t, path, () => rmSync(path));
  await assert.rejects(readResourceSnapshot(path), /changed/);
});

test("snapshots reject same-inode rewrites even when content and size are unchanged", async (t) => {
  const path = join(sandbox(t), "resource.md");
  writeFileSync(path, "original");
  await afterRead(t, path, () => writeFileSync(path, "original"));
  await assert.rejects(readResourceSnapshot(path), /changed/);
});

test("growth cannot read beyond the configured limit plus one detection byte", async (t) => {
  const path = join(sandbox(t), "resource.md");
  writeFileSync(path, "original");
  const probe = await open(path, "r");
  const prototype: Pick<FileHandle, "read"> = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let total = 0;
  let capacity = 0;
  t.mock.method(prototype, "read", async function (
    this: FileHandle, buffer: Buffer, offset: number, length: number, position: number | null,
  ) {
    capacity = Math.max(capacity, buffer.length);
    const result = await Reflect.apply(original, this, [buffer, offset, Math.min(length, 7), position]);
    if (total === 0) appendFileSync(path, "x".repeat(MAX_RESOURCE_BYTES));
    total += result.bytesRead;
    return result;
  });
  await assert.rejects(readResourceSnapshot(path, { maxBytes: 32 }), /byte limit/);
  assert.equal(capacity, 33);
  assert.equal(total, 33);
});

test("bounded snapshots honor abort before opening and during the read loop", async (t) => {
  const path = join(sandbox(t), "resource.md");
  writeFileSync(path, "guidance");
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(readResourceSnapshot(path, { signal: stopped.signal }), { name: "AbortError" });
  const running = new AbortController();
  await afterRead(t, path, () => running.abort());
  await assert.rejects(readResourceSnapshot(path, { signal: running.signal }), { name: "AbortError" });
});

test("unsupported text still consumes the inventory's aggregate byte budget", async (t) => {
  const root = sandbox(t);
  const prompts = join(root, ".pi/prompts");
  mkdirSync(prompts, { recursive: true });
  for (let i = 0; i < 16; i++) {
    const invalid = Buffer.alloc(MAX_RESOURCE_BYTES, 0xff);
    writeFileSync(join(prompts, `${String(i).padStart(2, "0")}-invalid.md`), invalid);
  }
  writeFileSync(join(prompts, "last-valid.md"), "Not read after the budget is consumed.");
  const inventory = await inventoryResources(await discoverProject(root, { root }));
  assert.deepEqual(inventory.resources, []);
  assert.match(inventory.warnings.join("\n"), /Unsupported non-UTF-8/);
  assert.match(inventory.warnings.join("\n"), /total byte limit reached/);
});
