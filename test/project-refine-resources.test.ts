import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverProject } from "../pi-extension/project-refine/core/project.ts";
import { inventoryResources } from "../pi-extension/project-refine/core/resources.ts";
import { digest } from "../pi-extension/project-refine/core/util.ts";

function sandbox(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "refine-resources-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root: string, path: string, content: string | Uint8Array): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000, env, stdio: ["ignore", "pipe", "pipe"] });
}
function init(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
}
function snapshot(root: string): unknown[] {
  const result: unknown[] = [];
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path);
      else result.push([path, info.mode, info.size, info.mtimeMs, info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("base64")]);
    }
  }
  visit(root);
  return result;
}
const skill = (name: string, body = "") => `---\nname: ${name}\ndescription: Use for local project tests.\n---\n${body}`;

test("inventories current checkout guidance deterministically, setup advisory-only, without running or writing anything", async (t) => {
  const temp = sandbox(t);
  const root = join(temp, "checkout with spaces");
  const linked = join(temp, "other worktree");
  init(root);
  git(root, "worktree", "add", "--detach", linked);
  put(temp, "AGENTS.md", "ancestor instruction must not leak");
  put(linked, "AGENTS.md", "other checkout must not leak");
  put(root, "AGENTS.md", "# Root\r\nKeep original line endings.\r\n");
  put(root, "packages/app/AGENTS.md", "Nested guidance\n");
  put(root, "packages/app/package.json", '{"name":"nested"}\n');
  put(root, ".pi/skills/lint/SKILL.md", skill("lint", "[Guide](references/guide.md)\n`references/missing.md`\n[shell](scripts/check.sh)\n"));
  put(root, ".pi/skills/lint/references/guide.md", "[Shared](../../../../docs/shared%20guide.md)\n");
  put(root, "docs/shared guide.md", "Shared deep guidance\n");
  put(root, "docs/unselected.md", "Not automatically inventoried\n");
  put(root, ".pi/skills/lint/scripts/check.sh", "#!/bin/sh\ntouch SHOULD_NOT_EXIST\n");
  put(root, ".agents/skills/release/SKILL.md", skill("release"));
  put(root, ".github/skills/copy/SKILL.md", skill("lint"));
  put(root, ".pi/skills/standalone.md", skill("standalone"));
  put(root, ".pi/prompts/review.md", "---\ndescription: Review\n---\nReview $@\n");
  put(root, ".pi/settings.json", '{"extensions":["./extensions/evil.mjs"],"skills":["../../private"],"packages":["uninstalled"]}\n');
  put(root, "package.json", '{"scripts":{"prepare":"touch SHOULD_NOT_EXIST"}}\n');
  put(root, ".pi/extensions/evil.mjs", 'import {writeFileSync} from "node:fs"; writeFileSync("SHOULD_NOT_EXIST", "executed");\n');
  put(root, ".pi/extensions/AGENTS.md", "Extension-owned, not editable project guidance\n");
  put(root, ".pi/packages/installed/AGENTS.md", "Installed package guidance\n");
  const before = snapshot(temp);
  const scope = await discoverProject(root);
  const manifest = await inventoryResources(scope);
  assert.deepEqual(manifest.resources.map((item) => [item.path, item.kind, item.editable]), [
    [".agents/skills/release/SKILL.md", "skill", true],
    [".github/skills/copy/SKILL.md", "skill", true],
    [".pi/prompts/review.md", "prompt", true],
    [".pi/settings.json", "setup", false],
    [".pi/skills/lint/SKILL.md", "skill", true],
    [".pi/skills/lint/references/guide.md", "reference", true],
    [".pi/skills/standalone.md", "skill", true],
    ["AGENTS.md", "instruction", true],
    ["docs/shared guide.md", "reference", true],
    ["package.json", "setup", false],
    ["packages/app/AGENTS.md", "instruction", true],
    ["packages/app/package.json", "setup", false],
  ]);
  assert.ok(manifest.resources.every((item) => item.hash === digest(item.content)));
  assert.equal(manifest.resources.find((item) => item.path === "AGENTS.md")?.content, "# Root\r\nKeep original line endings.\r\n");
  assert.match(manifest.warnings.join("\n"), /Skill name collision "lint"/);
  assert.match(manifest.warnings.join("\n"), /Missing local reference.*references\/missing.md/);
  assert.match(manifest.warnings.join("\n"), /custom configured paths.*not loaded/);
  assert.equal((await inventoryResources(scope)).digest, manifest.digest);
  assert.deepEqual(snapshot(temp), before, "project files, Git index and mtimes are unchanged");
});

test("rejects symlinks, dependency/build dirs, escapes, submodules and nested worktrees even through references", async (t) => {
  const temp = sandbox(t);
  const root = join(temp, "main");
  init(root);
  init(join(root, "nested repo"));
  put(root, "nested repo/AGENTS.md", "different repository\n");
  git(root, "worktree", "add", "--detach", join(root, "nested worktree"));
  put(root, "nested worktree/AGENTS.md", "other target checkout\n");
  put(root, "submodule/.git", "gitdir: /nonexistent\n");
  put(root, "submodule/AGENTS.md", "submodule boundary\n");
  for (const dir of ["node_modules", "vendor", "dist", "build", "target", "generated", ".venv"]) put(root, `${dir}/AGENTS.md`, "excluded\n");
  put(root, "docs/real.md", "owned reference\n");
  put(temp, "private.md", "private must not be read\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  symlinkSync(join(temp, "private.md"), join(root, "docs", "escape.md"));
  symlinkSync(join(root, "docs", "real.md"), join(root, "docs", "internal-link.md"));
  symlinkSync(temp, join(root, "linked-dir"), "dir");
  put(root, ".pi/skills/check/SKILL.md", skill("check", [
    "[Escape](../../../../private.md)",
    "[Encoded escape](%2e%2e/%2e%2e/%2e%2e/%2e%2e/private.md)",
    "[Symlink](../../../docs/escape.md)",
    "[Internal symlink](../../../docs/internal-link.md)",
    "[Nested](<../../../nested repo/AGENTS.md>)",
    "[Worktree](<../../../nested worktree/AGENTS.md>)",
    "[Submodule](../../../submodule/AGENTS.md)",
    "[Dependency](../../../node_modules/AGENTS.md)",
    "[Absolute](/etc/project-refine-never-read.md)",
    "[File URL](file:///etc/project-refine-never-read.md)",
    "[Remote](https://example.invalid/never.md)",
    "[Safe](../../../docs/real.md#section)",
  ].join("\n")));
  const before = snapshot(temp);
  const manifest = await inventoryResources(await discoverProject(root));
  assert.deepEqual(manifest.resources.map((item) => item.path), [".pi/skills/check/SKILL.md", "docs/real.md"]);
  const warnings = manifest.warnings.join("\n");
  assert.match(warnings, /Rejected resource path escape/);
  assert.match(warnings, /Skipped symlink/);
  assert.match(warnings, /Skipped nested repository: nested repo/);
  assert.match(warnings, /Skipped nested repository: nested worktree/);
  assert.match(warnings, /Skipped nested repository: submodule/);
  assert.match(warnings, /Rejected absolute or unsupported local reference/);
  assert.match(warnings, /Omitted dependency\/build\/generated resource/);
  assert.deepEqual(snapshot(temp), before);
});

test("validates scalar/block frontmatter, malformed metadata, missing script paths and reference cycles safely", async (t) => {
  const root = sandbox(t);
  put(root, ".agents/skills/good/SKILL.md", '---\nname: "good"\ndescription: >-\n  Run checks when\n  changing the project.\ndisable-model-invocation: true\n---\n[Guide][guide]\n[guide]: <references/with space.md>\n`references/missing.md`\n`scripts/missing.py`\n');
  put(root, ".agents/skills/good/references/with space.md", "[Cycle](../SKILL.md)\n");
  put(root, ".pi/skills/bad-name/SKILL.md", "---\nname: Bad--Name\ndescription: [invalid array\ndisable-model-invocation: 'true'\nmetadata: \"unterminated\n---\n");
  put(root, ".pi/skills/unclosed/SKILL.md", "---\nname: unclosed\ndescription: Oops\n");
  put(root, ".pi/skills/duplicate-key/SKILL.md", "---\nname: first\nname: second\ndescription: 'Unclosed\n---\n");
  put(root, ".pi/skills/plain/SKILL.md", "No frontmatter\n");
  put(root, ".pi/settings.json", "{broken json");
  const before = snapshot(root);
  const manifest = await inventoryResources(await discoverProject(root, { root }));
  const warnings = manifest.warnings.join("\n");
  assert.match(warnings, /Invalid skill name "Bad--Name"/);
  assert.match(warnings, /Unsupported non-string skill field description/);
  assert.match(warnings, /Invalid disable-model-invocation boolean/);
  assert.match(warnings, /Malformed or unsupported quoted skill field metadata/);
  assert.match(warnings, /Malformed skill frontmatter \(missing closing delimiter\)/);
  assert.match(warnings, /Duplicate skill frontmatter key name/);
  assert.match(warnings, /Malformed quoted skill field description/);
  assert.match(warnings, /Missing skill frontmatter/);
  assert.match(warnings, /Missing skill description/);
  assert.match(warnings, /Malformed setup JSON \(advisory only\)/);
  assert.match(warnings, /Missing local reference.*scripts\/missing.py/);
  assert.ok(manifest.resources.some((item) => item.path.endsWith("with space.md")));
  assert.equal(manifest.resources.filter((item) => item.path.endsWith("with space.md")).length, 1);
  assert.ok(!manifest.warnings.some((warning) => warning.includes("frontmatter") && warning.includes("skills/good/")));
  assert.deepEqual(snapshot(root), before);
});

test("bounds individual and total bytes and rejects unsupported text rather than truncating editable baselines", async (t) => {
  const root = sandbox(t);
  put(root, "AGENTS.md", "x".repeat(128 * 1024 + 1));
  put(root, ".pi/prompts/00-invalid.md", new Uint8Array([0xff, 0xfe]));
  put(root, ".pi/prompts/01-binary.md", "text\0binary");
  for (let i = 0; i < 18; i++) put(root, `.pi/prompts/large-${String(i).padStart(2, "0")}.md`, "x".repeat(128 * 1024));
  const before = snapshot(root);
  const manifest = await inventoryResources(await discoverProject(root, { root }));
  assert.ok(manifest.resources.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) <= 2 * 1024 * 1024);
  assert.ok(manifest.resources.every((item) => item.content.length === 128 * 1024));
  assert.match(manifest.warnings.join("\n"), /exceeds file byte limit/);
  assert.match(manifest.warnings.join("\n"), /total byte limit reached/);
  assert.match(manifest.warnings.join("\n"), /Unsupported non-UTF-8/);
  assert.match(manifest.warnings.join("\n"), /Unsupported binary/);
  assert.ok(!manifest.resources.some((item) => item.path === "AGENTS.md"));
  assert.deepEqual(snapshot(root), before);
});

test("bounds resource count and directory depth, with deterministic incomplete-inventory diagnostics", async (t) => {
  const root = sandbox(t);
  for (let i = 0; i < 270; i++) put(root, `.pi/prompts/${String(i).padStart(3, "0")}.md`, `Prompt ${i}\n`);
  const deep = `${Array.from({ length: 22 }, () => "deep").join("/")}/AGENTS.md`;
  put(root, deep, "too deep\n");
  put(root, ".agents/skills/depth/SKILL.md", skill("depth", `[Deep](../../../${deep})\n`));
  const before = snapshot(root);
  const scope = await discoverProject(root, { root });
  const manifest = await inventoryResources(scope);
  assert.equal(manifest.resources.length, 256);
  assert.match(manifest.warnings.join("\n"), /Resource file count limit reached/);
  assert.match(manifest.warnings.join("\n"), /Directory depth limit reached/);
  assert.match(manifest.warnings.join("\n"), /Resource directory depth limit reached/);
  assert.ok(!manifest.resources.some((item) => item.path === deep));
  assert.equal((await inventoryResources(scope)).digest, manifest.digest);
  assert.deepEqual(snapshot(root), before);
});

test("a checkout path reused by another repository cannot be inventoried under a stale identity", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const root = join(temp, "checkout");
  init(main);
  git(main, "worktree", "add", "--detach", root);
  const scope = await discoverProject(root);
  git(main, "worktree", "remove", root);
  init(root);
  put(root, "AGENTS.md", "Different repository at the same path\n");
  const before = snapshot(temp);
  await assert.rejects(inventoryResources(scope), /no longer matches project scope/);
  assert.deepEqual(snapshot(temp), before);
});

test("abort before or during inventory never writes project files", async (t) => {
  const root = sandbox(t);
  for (let i = 0; i < 40; i++) put(root, `packages/${i}/AGENTS.md`, "guidance\n");
  const scope = await discoverProject(root, { root });
  const before = snapshot(root);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(inventoryResources(scope, stopped.signal), { name: "AbortError" });
  const running = new AbortController();
  const result = inventoryResources(scope, running.signal);
  running.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(snapshot(root), before);
});
