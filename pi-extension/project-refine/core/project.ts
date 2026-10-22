import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectScope, Worktree } from "./types.ts";
import { digest, errorCode, errorMessage, isRecord, isWithin, throwIfAborted } from "./util.ts";

const execute = promisify(execFile);
const GIT_TIMEOUT = 5_000;

function missing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

// Ignore ambient repository/config overrides: -C, not the caller's GIT_DIR,
// must determine identity. These Git builtins do not run project code.
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await execute("git", ["--no-optional-locks", "-C", cwd, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8", timeout: GIT_TIMEOUT, maxBuffer: 4 * 1024 * 1024, signal,
  });
  throwIfAborted(signal);
  return result.stdout;
}

async function repository(cwd: string, signal?: AbortSignal): Promise<{ root: string; commonDir: string } | undefined> {
  let top: string;
  try {
    top = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  } catch (error) {
    throwIfAborted(signal);
    // A broken repository, permissions error, timeout or missing Git is not a
    // successful non-Git discovery.
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    if (errorCode(error) === 128 && /not a git repository/i.test(stderr)) {
      // Broken .git files/submodules are boundaries too, not ordinary
      // directories that may inherit an explicit non-Git parent's identity.
      let current = cwd;
      while (true) {
        throwIfAborted(signal);
        let marker = false;
        try { await lstat(join(current, ".git")); marker = true; }
        catch (entryError) { if (!missing(entryError)) throw entryError; }
        if (marker) throw error;
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    }
    throw error;
  }
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
  return {
    root: await realpath(top.replace(/\r?\n$/, "")),
    commonDir: await realpath(common.replace(/\r?\n$/, "")),
  };
}

/** Canonicalize missing descendants without losing symlinked existing ancestors. */
async function location(input: string): Promise<{ path: string; exists: boolean; ancestor: string }> {
  let current = resolve(input);
  const tail: string[] = [];
  while (true) {
    try {
      const path = await realpath(current);
      if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${current}`);
      return { path: join(path, ...tail), exists: tail.length === 0, ancestor: path };
    } catch (error) {
      if (!missing(error)) throw error;
      // Do not turn a dangling symlink into an approved historical directory.
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Dangling symlink: ${current}`);
      } catch (entryError) {
        if (!missing(entryError)) throw entryError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(current.slice(parent.length).replace(/^[/\\]/, ""));
      current = parent;
    }
  }
}

function worktree(projectId: string, root: string, available: boolean, historical: boolean, branch?: string): Worktree {
  return { id: digest({ projectId, root }), root, available, historical, ...(branch ? { branch } : {}) };
}

interface GitWorktree { root: string; branch?: string; locked?: string; prunable?: string }
function parseWorktrees(output: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let record: GitWorktree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      record = { root: field.slice(9) };
      records.push(record);
    } else if (record && field.startsWith("branch ")) record.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (record && (field === "locked" || field.startsWith("locked "))) record.locked = field.slice(7) || "no reason given";
    else if (record && (field === "prunable" || field.startsWith("prunable "))) record.prunable = field.slice(9) || "no reason given";
  }
  return records;
}

/** Select a checkout, identify its local common-dir, and enumerate registered worktrees.
 * Extra historical paths are accepted only from the caller's approved list.
 * `root` is a checkout root (not an implicit monorepo subproject filter).
 */
export async function discoverProject(cwd: string, options: { root?: string; historicalRoots?: string[]; signal?: AbortSignal } = {}): Promise<ProjectScope> {
  const { signal } = options;
  throwIfAborted(signal);
  const start = await location(cwd);
  if (!start.exists) throw new Error(`Project cwd does not exist: ${cwd}`);
  const repo = await repository(start.path, signal);
  const selected = options.root === undefined ? undefined : await location(resolve(start.path, options.root));
  if (selected && !selected.exists) throw new Error(`Explicit project root does not exist: ${selected.path}`);
  let scope: ProjectScope;
  if (repo) {
    const target = selected ? await repository(selected.path, signal) : repo;
    if (!target || target.commonDir !== repo.commonDir || (selected && selected.path !== target.root)) {
      throw new Error("Explicit root must be a checkout root of the same repository; subproject filtering is not supported.");
    }
    const id = digest({ kind: "git", commonDir: repo.commonDir });
    scope = { id, root: target.root, kind: "git", commonDir: repo.commonDir, worktrees: [], warnings: [] };
    const records = parseWorktrees(await git(target.root, ["worktree", "list", "--porcelain", "-z"], signal));
    for (const record of records) {
      throwIfAborted(signal);
      if (record.locked !== undefined) scope.warnings.push(`Locked worktree ${record.root}: ${record.locked}`);
      if (record.prunable !== undefined) scope.warnings.push(`Prunable worktree ${record.root}: ${record.prunable}`);
      try {
        const loc = await location(record.root);
        if (loc.exists) {
          const verified = await repository(loc.path, signal);
          if (verified?.commonDir !== repo.commonDir || verified.root !== loc.path) {
            scope.warnings.push(`Rejected worktree identity conflict: ${record.root}`);
            continue;
          }
        } else scope.warnings.push(`Unavailable registered worktree: ${loc.path}`);
        scope.worktrees.push(worktree(id, loc.path, loc.exists, false, record.branch));
      } catch (error) {
        throwIfAborted(signal);
        scope.warnings.push(`Unable to verify registered worktree ${record.root}: ${errorMessage(error)}`);
      }
    }
    if (!scope.worktrees.some((entry) => entry.root === scope.root)) {
      const verified = await repository(scope.root, signal);
      if (!verified || verified.commonDir !== repo.commonDir || verified.root !== scope.root) throw new Error("Selected checkout identity changed during discovery.");
      scope.worktrees.push(worktree(id, scope.root, true, false));
    }
  } else {
    if (!selected) throw new Error("Non-Git projects require an explicit root.");
    if (!isWithin(selected.path, start.path)) throw new Error("Project cwd is outside the explicit root.");
    if (await repository(selected.path, signal)) throw new Error("Explicit root does not match the non-Git cwd.");
    const id = digest({ kind: "directory", root: selected.path });
    scope = { id, root: selected.path, kind: "directory", worktrees: [worktree(id, selected.path, true, false)], warnings: ["Directory scope uses an explicit root; no Git identity is available."] };
  }

  for (const approved of options.historicalRoots ?? []) {
    throwIfAborted(signal);
    try {
      const loc = await location(resolve(start.path, approved));
      if (scope.worktrees.some((entry) => entry.root === loc.path)) continue;
      if (loc.exists) {
        const verified = await repository(loc.path, signal);
        if (scope.kind === "git" ? verified?.commonDir !== scope.commonDir || verified?.root !== loc.path : verified !== undefined) {
          scope.warnings.push(`Rejected historical root identity conflict: ${loc.path}`);
          continue;
        }
      }
      scope.worktrees.push(worktree(scope.id, loc.path, loc.exists, true));
      scope.warnings.push(`Caller-approved historical association: ${loc.path}; past repository identity cannot be recovered from session cwd alone.`);
    } catch (error) {
      throwIfAborted(signal);
      scope.warnings.push(`Rejected historical root ${approved}: ${errorMessage(error)}`);
    }
  }
  scope.worktrees.sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0);
  scope.warnings.push("Removed/pruned worktrees not registered by Git require caller-approved historical roots; separate clones and nested repositories are excluded.");
  if (scope.kind === "git") scope.warnings.push("Identity is the local canonical common-dir path, not proof of historical repository contents if that same common-dir path is replaced.");
  throwIfAborted(signal);
  return scope;
}

/** Attribute a session cwd, verifying live repository identity rather than a prefix. */
export async function attributeCwd(scope: ProjectScope, cwd: string, signal?: AbortSignal): Promise<Worktree | undefined> {
  throwIfAborted(signal);
  try {
    const loc = await location(cwd);
    const candidates = scope.worktrees.filter((entry) => isWithin(entry.root, loc.path)).sort((a, b) => b.root.length - a.root.length);
    for (const candidate of candidates) {
      // Re-check even approved/previously unavailable paths: they may have been
      // reused since discovery. Only wholly absent portions rely on approval.
      if (isWithin(candidate.root, loc.ancestor)) {
        const verified = await repository(loc.ancestor, signal);
        if (scope.kind === "git") {
          if (verified && verified.commonDir === scope.commonDir && verified.root === candidate.root) return candidate;
        } else if (!verified) return candidate;
        return undefined; // Nested independent repository, submodule or reuse.
      }
      if (!loc.exists && (candidate.historical || !candidate.available)) {
        // The root itself must still be missing, not replaced with a file or a
        // dangling symlink (location() would reject either).
        const root = await location(candidate.root);
        if (!root.exists) return candidate;
      }
    }
  } catch {
    // Cancellation is not an attribution failure and must reach the caller.
    throwIfAborted(signal);
    // Unverifiable cwds must never broaden evidence scope.
  }
  throwIfAborted(signal);
  return undefined;
}
