import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import githubSkills, { findGithubSkillDirs, findGitRoot } from "../pi-extension/github-skills/index.ts";

function sandbox(): { root: string; cleanup(): void } {
  // realpath: macOS tmpdir is a /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "github-skills-")));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function skill(dir: string, name: string): string {
  const skillsDir = join(dir, ".github", "skills");
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n`);
  return skillsDir;
}

function discover(cwd: string, trusted = true) {
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
  githubSkills({ on(name: string, fn: any) { if (name === "resources_discover") handler = fn; } } as any);
  assert.ok(handler, "registers a resources_discover handler");
  return handler({ type: "resources_discover", cwd, reason: "startup" }, { isProjectTrusted: () => trusted });
}

test("a git repository without .github/skills contributes nothing", async () => {
  const { root, cleanup } = sandbox();
  try {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", ".github", "workflows"), { recursive: true });
    assert.deepEqual(findGithubSkillDirs(join(root, "repo")), []);
    assert.deepEqual(await discover(join(root, "repo")), {});
  } finally {
    cleanup();
  }
});

test("a directory outside any git repository still works, with or without skills", async () => {
  const { root, cleanup } = sandbox();
  try {
    const plain = join(root, "plain", "nested");
    mkdirSync(plain, { recursive: true });
    assert.equal(findGitRoot(plain), undefined);
    assert.deepEqual(await discover(plain), {});

    const withSkills = skill(join(root, "plain"), "outside-repo");
    assert.deepEqual(await discover(plain), { skillPaths: [withSkills] });
  } finally {
    cleanup();
  }
});

test("inside a repository, discovery walks up to the repo root and stops there", async () => {
  const { root, cleanup } = sandbox();
  try {
    skill(root, "above-repo"); // Must not leak into the repository.
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const repoSkills = skill(repo, "repo-skill");
    const pkg = join(repo, "packages", "app");
    const pkgSkills = skill(pkg, "package-skill");
    const deep = join(pkg, "src", "lib");
    mkdirSync(deep, { recursive: true });

    assert.deepEqual(findGithubSkillDirs(deep), [pkgSkills, repoSkills]);
    assert.deepEqual(findGithubSkillDirs(repo), [repoSkills]);
  } finally {
    cleanup();
  }
});

test("a worktree or submodule .git file marks the repository root", () => {
  const { root, cleanup } = sandbox();
  try {
    skill(root, "outer");
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/feat\n");
    const worktreeSkills = skill(worktree, "feature");
    assert.equal(findGitRoot(join(worktree)), worktree);
    assert.deepEqual(findGithubSkillDirs(worktree), [worktreeSkills]);
  } finally {
    cleanup();
  }
});

test("a .github/skills file instead of a directory is ignored", () => {
  const { root, cleanup } = sandbox();
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "skills"), "not a directory");
    assert.deepEqual(findGithubSkillDirs(root), []);
  } finally {
    cleanup();
  }
});

test("an explicitly untrusted project contributes no skills", async () => {
  const { root, cleanup } = sandbox();
  try {
    mkdirSync(join(root, ".git"));
    skill(root, "untrusted");
    assert.deepEqual(await discover(root, false), {});
  } finally {
    cleanup();
  }
});

test("a missing cwd does not throw", async () => {
  const { root, cleanup } = sandbox();
  try {
    assert.deepEqual(await discover(join(root, "does-not-exist")), {});
  } finally {
    cleanup();
  }
});
