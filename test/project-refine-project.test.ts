import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { attributeCwd, discoverProject } from "../pi-extension/project-refine/core/project.ts";

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, env, stdio: ["ignore", "pipe", "pipe"] });
}
function init(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--initial-branch=main");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
}
function sandbox(t: { after(fn: () => void): void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "refine-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

test("canonical common-dir identity includes main, linked and detached worktrees without writes", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main checkout");
  const feature = join(temp, "feature space; echo not-a-command");
  const detached = join(temp, "detached checkout");
  init(main);
  git(main, "worktree", "add", "-b", "feature", feature);
  git(main, "worktree", "add", "--detach", detached);
  git(main, "worktree", "lock", "--reason", "fixture lock", feature);
  mkdirSync(join(feature, "packages", "app"), { recursive: true });
  const alias = join(temp, "alias");
  symlinkSync(main, alias, "dir");
  const before = snapshot(temp);
  const scope = await discoverProject(join(feature, "packages", "app"));
  assert.equal(scope.root, feature);
  assert.equal(scope.kind, "git");
  assert.equal(scope.commonDir, realpathSync(join(main, ".git")));
  assert.deepEqual(scope.worktrees.map((item) => item.root).sort(), [main, feature, detached].sort());
  assert.ok(scope.worktrees.every((item) => item.available && !item.historical));
  assert.equal(scope.worktrees.find((item) => item.root === feature)?.branch, "feature");
  assert.equal(scope.worktrees.find((item) => item.root === detached)?.branch, undefined);
  assert.match(scope.warnings.join("\n"), /Locked worktree.*fixture lock/);
  assert.equal((await discoverProject(alias)).id, scope.id);
  assert.equal((await discoverProject(main)).worktrees.find((item) => item.root === feature)?.id, (await attributeCwd(scope, join(feature, "packages", "app")))?.id);
  assert.equal((await attributeCwd(scope, join(alias, "not-yet-created")))?.root, main);
  assert.equal((await discoverProject(feature, { root: main })).root, main);
  await assert.rejects(discoverProject(feature, { root: join(feature, "packages") }), /checkout root/);
  assert.deepEqual(snapshot(temp), before, "all project/Git files and mtimes unchanged");
});

test("nested repositories, actual submodules and same-remote separate clones never share scope", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const source = join(temp, "submodule source");
  const clone = join(temp, "clone");
  init(main);
  init(source);
  init(join(main, "nested"));
  git(main, "-c", "protocol.file.allow=always", "submodule", "add", source, "module space");
  git(main, "clone", "--quiet", main, clone);
  git(main, "remote", "add", "origin", "https://example.invalid/same.git");
  git(clone, "remote", "set-url", "origin", "https://example.invalid/same.git");
  mkdirSync(join(main, "nested", "deep"));
  const before = snapshot(temp);
  const scope = await discoverProject(main);
  assert.equal(await attributeCwd(scope, join(main, "nested", "deep")), undefined);
  assert.equal(await attributeCwd(scope, join(main, "nested", "missing")), undefined);
  assert.equal(await attributeCwd(scope, join(main, "module space")), undefined);
  assert.equal(await attributeCwd(scope, clone), undefined);
  assert.notEqual((await discoverProject(clone)).id, scope.id);
  assert.notEqual((await discoverProject(join(main, "module space"))).id, scope.id);
  assert.notEqual((await discoverProject(join(main, "nested"))).id, scope.id);
  assert.deepEqual(snapshot(temp), before);
});

test("registered unavailable worktrees are reported; pruned historical associations require caller approval", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const old = join(temp, "old linked checkout");
  init(main);
  git(main, "worktree", "add", "--detach", old);
  rmSync(old, { recursive: true });
  const registered = await discoverProject(main);
  assert.equal(registered.worktrees.find((item) => item.root === old)?.available, false);
  assert.match(registered.warnings.join("\n"), /Unavailable registered worktree/);
  assert.equal((await attributeCwd(registered, join(old, "packages", "app")))?.root, old);
  git(main, "worktree", "prune", "--expire", "now");
  const scope = await discoverProject(main);
  assert.equal(await attributeCwd(scope, join(old, "packages", "app")), undefined);
  const before = snapshot(temp);
  const approved = await discoverProject(main, { historicalRoots: [old, old] });
  assert.equal(approved.worktrees.filter((item) => item.root === old).length, 1);
  assert.equal(approved.worktrees.find((item) => item.root === old)?.historical, true);
  assert.equal((await attributeCwd(approved, join(old, "packages", "app")))?.root, old);
  assert.equal(await attributeCwd(approved, join(temp, "old linked checkout-copy", "app")), undefined);
  assert.deepEqual(snapshot(temp), before);
});

test("reused historical paths are rejected both during discovery and after a scope snapshot", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const old = join(temp, "reused");
  init(main);
  const scope = await discoverProject(main, { historicalRoots: [old] });
  assert.ok(await attributeCwd(scope, join(old, "missing")));
  init(old);
  assert.equal(await attributeCwd(scope, old), undefined);
  assert.equal(await attributeCwd(scope, join(old, "missing")), undefined);
  const rejected = await discoverProject(main, { historicalRoots: [old] });
  assert.ok(!rejected.worktrees.some((item) => item.root === old));
  assert.match(rejected.warnings.join("\n"), /Rejected historical root identity conflict/);
  rmSync(old, { recursive: true });
  mkdirSync(old);
  assert.equal(await attributeCwd(scope, old), undefined, "an existing unverified directory cannot inherit historical Git identity");
  const plain = await discoverProject(main, { historicalRoots: [old] });
  assert.ok(!plain.worktrees.some((item) => item.root === old));
});

test("non-Git projects require an explicit canonical root and exclude nested repositories", async (t) => {
  const temp = sandbox(t);
  const root = join(temp, "plain");
  const child = join(root, "nested");
  mkdirSync(child, { recursive: true });
  await assert.rejects(discoverProject(child), /explicit root/);
  const scope = await discoverProject(child, { root: ".." });
  assert.equal(scope.kind, "directory");
  assert.equal(scope.root, root);
  assert.equal((await attributeCwd(scope, child))?.root, root);
  assert.equal((await attributeCwd(scope, join(child, "missing")))?.root, root);
  assert.equal(await attributeCwd(scope, join(temp, "plain-other")), undefined);
  init(join(root, "repo"));
  assert.equal(await attributeCwd(scope, join(root, "repo")), undefined);
  assert.equal(await attributeCwd(scope, join(root, "repo", "missing")), undefined);
  mkdirSync(join(root, "broken-submodule"));
  writeFileSync(join(root, "broken-submodule", ".git"), "gitdir: /nonexistent-project-refine-gitdir\n");
  assert.equal(await attributeCwd(scope, join(root, "broken-submodule")), undefined);
  assert.equal(await attributeCwd(scope, join(root, "broken-submodule", "missing")), undefined);
  await assert.rejects(discoverProject(child, { root: join(temp, "outside") }), /does not exist/);
  await assert.rejects(discoverProject(child, { root: join(root, "repo") }), /outside/);
  await assert.rejects(discoverProject(join(root, "repo"), { root }), /checkout root/);
});

test("canonical historical ancestors work, while dangling symlinks and files cannot expand scope", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const parent = join(temp, "history");
  init(main);
  mkdirSync(parent);
  symlinkSync(parent, join(temp, "history alias"), "dir");
  symlinkSync(join(temp, "absent target"), join(temp, "dangling"), "dir");
  writeFileSync(join(temp, "a file"), "not a cwd");
  const scope = await discoverProject(main, { historicalRoots: [join(temp, "history alias", "old"), join(temp, "dangling"), join(temp, "a file")] });
  assert.ok(scope.worktrees.some((item) => item.root === join(parent, "old")));
  assert.equal((await attributeCwd(scope, join(temp, "history alias", "old", "deep")))?.root, join(parent, "old"));
  assert.equal(await attributeCwd(scope, join(temp, "dangling", "deep")), undefined);
  assert.match(scope.warnings.join("\n"), /Dangling symlink/);
  assert.match(scope.warnings.join("\n"), /Not a directory/);
});

test("Git identity ignores ambient GIT_DIR overrides and supports cancellation", async (t) => {
  const temp = sandbox(t);
  const main = join(temp, "main");
  const other = join(temp, "other");
  init(main);
  init(other);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, ".git");
  try {
    const scope = await discoverProject(main);
    assert.equal(scope.commonDir, join(main, ".git"));
    assert.equal((await attributeCwd(scope, main))?.root, main);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  const controller = new AbortController();
  controller.abort();
  const before = snapshot(temp);
  await assert.rejects(discoverProject(main, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(discoverProject(join(dirname(main), "missing")), /does not exist/);
  assert.deepEqual(snapshot(temp), before);
});
