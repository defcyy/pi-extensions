import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_RESOURCE_BYTES, readResourceSnapshot, ResourceSnapshotError } from "./files.ts";
import { existingSkillName } from "./skill-metadata.ts";
import { attributeCwd } from "./project.ts";
import type { ProjectScope, Resource, ResourceManifest } from "./types.ts";
import { digest, errorCode, isRecord, isWithin, throwIfAborted } from "./util.ts";

// Fixed audit budgets, independent of project configuration. Oversized files are
// omitted, not truncated into apparently valid editable baselines.
const MAX_DEPTH = 20;
const MAX_DIRS = 2_000;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCES = 2_000;
const MAX_WARNINGS = 256;
const SKIP = new Set([".git", "node_modules", "bower_components", "vendor", ".venv", "venv", ".env", "__pycache__", "site-packages", "dist", "build", "out", "target", "coverage", "generated", ".next", ".nuxt", ".output", ".cache", ".turbo", ".parcel-cache", ".yarn", ".pnpm-store", ".gradle", ".tox"]);
const MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "composer.json", "pom.xml"]);
const SKILL_DIRS = new Set([".pi", ".agents", ".github"]);
const markdown = (path: string) => [".md", ".markdown"].includes(extname(path).toLowerCase());
const sorted = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function absent(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Explicit links and code-path references only; never interpret shell or HTML. */
function references(content: string): string[] {
  const found = new Set<string>();
  // Ignore fenced examples: they need not describe actual local resources.
  let fence: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/\[[^\]\r\n]*\]\([ \t]*(?:<([^>\r\n]+)>|([^\s)]+))/g)) {
      found.add(match[1] ?? match[2]);
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
    if (definition) found.add(definition[1] ?? definition[2]);
    for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
      if (markdown(match[1]) || /^(?:\.\/)?(?:scripts|references|assets)\/[\w./ -]+$/.test(match[1])) {
        found.add(match[1]);
      }
    }
  }
  return [...found];
}

/** Inventory only the selected current checkout, never other worktrees or user
 * resources. Nothing is installed, loaded as configuration, imported or run.
 */
export async function inventoryResources(scope: ProjectScope, signal?: AbortSignal): Promise<ResourceManifest> {
  throwIfAborted(signal);
  const root = await realpath(scope.root);
  throwIfAborted(signal);
  const attributed = await attributeCwd(scope, root, signal);
  throwIfAborted(signal);
  if (!attributed || attributed.root !== root || root !== scope.root) {
    throw new Error("Selected resource checkout no longer matches project scope.");
  }
  const warnings = new Set<string>();
  let suppressed = false;
  const warn = (message: string) => {
    if (warnings.size < MAX_WARNINGS) warnings.add(message);
    else suppressed = true;
  };
  warn("Current selected checkout only; resource contents are not historical session versions.");
  warn("Project-local named resources only: AGENTS.md, .pi/.agents/.github skills, .pi/prompts, .pi/settings.json and named package manifests. Global/ancestor/installed resources, custom configured paths and executable extensions are not loaded.");
  warn("Static inspection only: no setup, scripts, commands or extensions are executed. Frontmatter validation supports routing scalars, not full YAML; references cover explicit local links and backtick paths, not arbitrary prose, HTML, fenced examples or shell commands.");
  warn("Symlinks, dependency/build/generated directories and nested repository boundaries are omitted. Ownership of generated files outside those directories cannot be established; filesystem races cannot be completely excluded.");
  const resources = new Map<string, Resource>();
  const checked = new Set<string>();
  const names = new Map<string, string>();
  const skillDocuments: Resource[] = [];
  const boundaries = new Map<string, boolean>();
  let bytes = 0;
  let entries = 0;
  let directories = 0;
  let referenceCount = 0;
  let fileBudgetReported = false;

  const display = (path: string) => relative(root, path).split(sep).join("/");
  async function boundary(path: string): Promise<boolean> {
    if (path === root) return false;
    const cached = boundaries.get(path);
    if (cached !== undefined) return cached;
    let found = false;
    try {
      await lstat(join(path, ".git"));
      found = true;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    // Bare repositories have no .git directory but are not project resources.
    if (!found) {
      try {
        found = (await lstat(join(path, "HEAD"))).isFile()
          && (await lstat(join(path, "objects"))).isDirectory()
          && (await lstat(join(path, "config"))).isFile();
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    boundaries.set(path, found);
    return found;
  }

  // Every path component is checked, including for references not found by the
  // directory walk. O_NOFOLLOW additionally protects the final open operation.
  async function safe(path: string): Promise<boolean> {
    throwIfAborted(signal);
    if (!isWithin(root, path) || path === root) {
      warn(`Rejected resource path escape: ${path}`);
      return false;
    }
    const parts = relative(root, path).split(sep);
    if (parts.length - 1 > MAX_DEPTH) {
      warn(`Resource directory depth limit reached (${MAX_DEPTH}): ${display(path)}`);
      return false;
    }
    if (parts.some((part) => SKIP.has(part))) {
      warn(`Omitted dependency/build/generated resource: ${display(path)}`);
      return false;
    }
    if (parts.some((part, i) => part === ".pi" && ["extensions", "packages"].includes(parts[i + 1]))) {
      warn(`Omitted executable-extension/installed-package resources: ${display(path)}`);
      return false;
    }
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        warn(`Skipped symlink: ${display(current)}`);
        return false;
      }
      if (i < parts.length - 1 && await boundary(current)) {
        warn(`Skipped nested repository: ${display(current)}`);
        return false;
      }
    }
    if (!isWithin(root, await realpath(path))) {
      warn(`Rejected canonical resource escape: ${display(path)}`);
      return false;
    }
    return true;
  }

  async function add(path: string, kind: Resource["kind"]): Promise<Resource | undefined> {
    throwIfAborted(signal);
    const key = display(path);
    const prior = resources.get(key);
    if (prior) return prior;
    if (checked.has(key)) return undefined;
    checked.add(key);
    if (resources.size >= MAX_FILES) {
      if (!fileBudgetReported) warn(`Resource file count limit reached (${MAX_FILES}); remaining resources omitted.`);
      fileBudgetReported = true;
      return undefined;
    }
    try {
      if (!await safe(path)) return undefined;
      // Preflight the aggregate budget as well as the shared reader's per-file
      // bound. The reader independently rechecks the opened file and its path.
      const info = await lstat(path);
      if (!info.isFile()) {
        warn(`Skipped non-regular resource: ${key}`);
        return undefined;
      }
      if (info.size > MAX_RESOURCE_BYTES) {
        warn(`Resource exceeds file byte limit (${MAX_RESOURCE_BYTES}): ${key}`);
        return undefined;
      }
      if (bytes + info.size > MAX_TOTAL_BYTES) {
        warn(`Resource total byte limit reached (${MAX_TOTAL_BYTES}): ${key}`);
        return undefined;
      }
      const snapshot = await readResourceSnapshot(path, {
        signal,
        maxBytes: Math.min(MAX_RESOURCE_BYTES, MAX_TOTAL_BYTES - bytes),
      });
      bytes += snapshot.bytes;
      if (!await safe(path)) {
        warn(`Resource changed during inventory: ${key}`);
        return undefined;
      }
      const { content } = snapshot;
      const resource: Resource = {
        path: key,
        kind,
        content,
        hash: digest(content),
        editable: kind !== "setup" && markdown(path),
      };
      resources.set(key, resource);
      if (kind === "skill") {
        const name = existingSkillName(content, key, warn);
        const previous = names.get(name);
        if (previous) warn(`Skill name collision ${JSON.stringify(name)}: ${previous}, ${key}`);
        else names.set(name, key);
        skillDocuments.push(resource);
      }
      if (kind === "setup" && extname(path) === ".json") {
        try {
          const parsed: unknown = JSON.parse(content);
          if (!isRecord(parsed)) warn(`Setup JSON is not an object (advisory only): ${key}`);
        } catch {
          warn(`Malformed setup JSON (advisory only): ${key}`);
        }
      }
      return resource;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof ResourceSnapshotError) {
        // Unsupported text still consumes the aggregate read budget, as it did
        // before extracting the bounded reader.
        bytes += error.bytes;
        const message = error.reason === "changed" ? "Resource changed during inventory" : error.message;
        warn(`${message}: ${key}`);
      } else {
        warn(`${absent(error) ? "Missing" : "Unreadable"} resource ${key}: ${errorCode(error) ?? "read error"}`);
      }
      return undefined;
    }
  }

  function category(path: string): Resource["kind"] | undefined {
    const parts = display(path).split("/");
    const file = parts.at(-1)!;
    if (file === "AGENTS.md") return "instruction";
    if (MANIFESTS.has(file) || file === "settings.json" && parts.at(-2) === ".pi") return "setup";
    for (let i = 0; i < parts.length - 2; i++) {
      if (SKILL_DIRS.has(parts[i]) && parts[i + 1] === "skills" && markdown(file)) {
        return file === "SKILL.md" || i + 2 === parts.length - 1 ? "skill" : "reference";
      }
      if (parts[i] === ".pi" && parts[i + 1] === "prompts" && markdown(file)) return "prompt";
    }
    return undefined;
  }

  async function walk(dir: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (depth > MAX_DEPTH) {
      warn(`Directory depth limit reached (${MAX_DEPTH}): ${display(dir)}`);
      return;
    }
    if (++directories > MAX_DIRS) {
      warn(`Directory count limit reached (${MAX_DIRS}); remaining directories omitted.`);
      return;
    }
    try {
      if (dir !== root && !await safe(dir)) return;
      if (await boundary(dir)) {
        warn(`Skipped nested repository: ${display(dir)}`);
        return;
      }
      const children = [];
      const handle = await opendir(dir);
      for await (const child of handle) {
        throwIfAborted(signal);
        if (++entries > MAX_ENTRIES) {
          warn(`Directory entry limit reached (${MAX_ENTRIES}); inventory is incomplete.`);
          break;
        }
        children.push(child);
      }
      children.sort((a, b) => sorted(a.name, b.name));
      for (const child of children) {
        throwIfAborted(signal);
        const path = join(dir, child.name);
        if (child.isSymbolicLink()) {
          warn(`Skipped symlink: ${display(path)}`);
          continue;
        }
        if (SKIP.has(child.name)) continue;
        if (child.isDirectory()) {
          if (entries <= MAX_ENTRIES && directories < MAX_DIRS) {
            await walk(path, depth + 1);
          } else {
            warn("Traversal budget exhausted; remaining directories omitted.");
          }
        } else if (child.isFile()) {
          const kind = category(path);
          if (kind) await add(path, kind);
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      warn(`Unreadable directory ${display(dir) || "."}: ${errorCode(error) ?? "read error"}`);
    }
  }

  await walk(root, 0);
  // Follow only explicit Markdown references originating in skill documents or
  // their Markdown references. Other local targets receive existence checks,
  // never reads. All targets obey the same exclusions and budgets as traversal.
  const queue = [...skillDocuments, ...[...resources.values()].filter((item) => item.kind === "reference")];
  const visited = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    if (visited.has(source.path)) continue;
    visited.add(source.path);
    for (const raw of references(source.content)) {
      throwIfAborted(signal);
      if (++referenceCount > MAX_REFERENCES) {
        warn(`Local reference count limit reached (${MAX_REFERENCES}); remaining references omitted.`);
        break;
      }
      if (!raw || raw.startsWith("#") || /^(?:https?|mailto|data|ftp):/i.test(raw)) continue;
      let target: string;
      try {
        target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
      } catch {
        warn(`Malformed local reference in ${source.path}: ${raw}`);
        continue;
      }
      if (!target) continue;
      if (isAbsolute(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.includes("\0") || target.includes("\\")) {
        warn(`Rejected absolute or unsupported local reference in ${source.path}: ${raw}`);
        continue;
      }
      const path = resolve(root, dirname(source.path), target);
      try {
        if (!await safe(path)) continue;
        if (markdown(path)) {
          const added = await add(path, category(path) ?? "reference");
          if (added) queue.push(added);
        }
      } catch (error) {
        throwIfAborted(signal);
        warn(`${absent(error) ? "Missing" : "Unreadable"} local reference in ${source.path}: ${raw}`);
      }
    }
    if (referenceCount > MAX_REFERENCES) break;
  }
  throwIfAborted(signal);
  if (suppressed) warnings.add("Additional inventory diagnostics omitted after warning limit.");
  const result = [...resources.values()].sort((a, b) => sorted(a.path, b.path));
  const diagnostics = [...warnings].sort(sorted);
  return {
    digest: digest({ projectId: scope.id, root, resources: result.map(({ path, kind, hash, editable }) => ({ path, kind, hash, editable })), warnings: diagnostics }),
    resources: result,
    warnings: diagnostics,
  };
}
