import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GITHUB_SKILLS_DIR = join(".github", "skills");

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest ancestor (inclusive) containing `.git` (a directory, or a file for worktrees/submodules). */
export function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Existing `.github/skills` directories from `cwd` upward, nearest first.
 *
 * Mirrors Pi's own `.agents/skills` discovery: inside a git repository the
 * walk stops at the repository root; outside one it continues to the
 * filesystem root. Nearest-first ordering matters because Pi keeps the first
 * skill found when names collide.
 */
export function findGithubSkillDirs(cwd: string): string[] {
  const start = resolve(cwd);
  const gitRoot = findGitRoot(start);
  const found: string[] = [];
  let dir = start;
  while (true) {
    const candidate = join(dir, GITHUB_SKILLS_DIR);
    if (isDirectory(candidate)) found.push(candidate);
    if (dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export default function githubSkills(pi: ExtensionAPI) {
  pi.on("resources_discover", async (event, ctx) => {
    // Honor an explicit "don't trust" decision like Pi does for project
    // skills. Folders without Pi-specific project resources count as trusted,
    // so Copilot-only repositories load without a prompt.
    if (!ctx.isProjectTrusted()) return {};
    try {
      const skillPaths = findGithubSkillDirs(event.cwd);
      return skillPaths.length > 0 ? { skillPaths } : {};
    } catch {
      // Discovery is best-effort and must never break startup.
      return {};
    }
  });
}
