import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { ProjectState, RefineRun, ReviewDecision } from "./types.ts";
import { redactText, redactValue } from "./redact.ts";
import { errorCode, isRecord, throwIfAborted } from "./util.ts";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_RUNS = 10000;
const LOCAL_HOST = hostname();

export function initialState(): ProjectState {
  return { schemaVersion: 1, historicalRoots: [], covered: {}, decisions: [], intervals: [] };
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid project-refine private data (schema, ID, or size limit).");
}
function object(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  check(isRecord(value));
  if (keys) check(Object.keys(value).every((key) => keys.includes(key)));
}
function string(value: unknown, max = 1024 * 1024): asserts value is string {
  check(typeof value === "string" && value.length <= max);
}
function hash(value: unknown): asserts value is string {
  check(typeof value === "string" && HASH.test(value));
}
function uuid(value: unknown): asserts value is string {
  check(typeof value === "string" && UUID.test(value));
}
function array(value: unknown, max: number): asserts value is unknown[] {
  check(Array.isArray(value) && value.length <= max);
}
function number(value: unknown): asserts value is number {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12);
}
function count(value: unknown): asserts value is number {
  number(value);
  check(Number.isSafeInteger(value));
}
function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): asserts value is Values[number] {
  check(typeof value === "string" && values.includes(value));
}
function date(value: unknown): asserts value is string {
  string(value, 40);
  check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}
function path(value: unknown): asserts value is string {
  string(value, 16384);
  check(isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));
}
function source(value: unknown): asserts value is string {
  check(typeof value === "string" && SOURCE_ID.test(value));
}
function validateDecision(value: unknown): asserts value is ReviewDecision {
  object(value, ["proposalId", "fingerprint", "contextDigest", "decision", "at"]);
  hash(value.proposalId);
  hash(value.fingerprint);
  hash(value.contextDigest);
  oneOf(value.decision, ["accepted", "rejected", "deferred"]);
  date(value.at);
}
function validateState(value: unknown): asserts value is ProjectState {
  object(value, ["schemaVersion", "historicalRoots", "covered", "decisions", "intervals"]);
  check(value.schemaVersion === 1);
  array(value.historicalRoots, 10000);
  value.historicalRoots.forEach(path);
  check(new Set(value.historicalRoots).size === value.historicalRoots.length);
  object(value.covered);
  check(Object.keys(value.covered).length <= 10000);
  let total = 0;
  for (const [context, ids] of Object.entries(value.covered)) {
    hash(context);
    array(ids, 200000);
    ids.forEach(hash);
    total += ids.length;
    check(new Set(ids).size === ids.length);
  }
  check(total <= 500000);
  array(value.decisions, 100000);
  value.decisions.forEach(validateDecision);
  array(value.intervals, 100000);
  for (const interval of value.intervals) {
    object(interval, ["sessionId", "afterEntryId", "beforeEntryId"]);
    source(interval.sessionId);
    if (interval.afterEntryId !== null) source(interval.afterEntryId);
    if (interval.beforeEntryId !== undefined && interval.beforeEntryId !== null) source(interval.beforeEntryId);
  }
}
function validateRun(value: unknown, projectId?: string): asserts value is RefineRun {
  object(value, ["schemaVersion", "id", "projectId", "targetRoot", "startedAt", "finishedAt", "status", "model", "contextDigest", "analyzedEpisodeIds", "coverage", "warnings", "proposals", "usage", "error"]);
  check(value.schemaVersion === 1);
  uuid(value.id);
  hash(value.projectId);
  if (projectId !== undefined) check(value.projectId === projectId);
  path(value.targetRoot);
  date(value.startedAt);
  if (value.finishedAt !== undefined) date(value.finishedAt);
  oneOf(value.status, ["success", "failed", "aborted"]);
  string(value.model, 1024);
  hash(value.contextDigest);
  array(value.analyzedEpisodeIds, 10000);
  value.analyzedEpisodeIds.forEach(hash);
  check(new Set(value.analyzedEpisodeIds).size === value.analyzedEpisodeIds.length);
  object(value.coverage, ["filesScanned", "matchedSessions", "eligibleEpisodes", "selectedEpisodes", "omittedEpisodes", "perWorktree"]);
  for (const key of ["filesScanned", "matchedSessions", "eligibleEpisodes", "selectedEpisodes", "omittedEpisodes"]) count(value.coverage[key]);
  object(value.coverage.perWorktree);
  check(Object.keys(value.coverage.perWorktree).length <= 10000);
  for (const [id, counts] of Object.entries(value.coverage.perWorktree)) {
    hash(id);
    object(counts, ["sessions", "episodes"]);
    count(counts.sessions);
    count(counts.episodes);
  }
  array(value.warnings, 10000);
  value.warnings.forEach((item) => string(item, 16384));
  array(value.usage, 100);
  for (const usage of value.usage) {
    object(usage, ["input", "output", "totalTokens", "cost"]);
    for (const item of Object.values(usage)) if (item !== undefined) number(item);
  }
  if (value.error !== undefined) string(value.error, 16384);
  array(value.proposals, 100);
  const proposalIds = new Set<string>();
  for (const proposal of value.proposals) {
    object(proposal, ["id", "fingerprint", "category", "scope", "problem", "suggestion", "expectedEffect", "exceptions", "confidence", "citations", "edits", "diffs", "validation"]);
    hash(proposal.id);
    hash(proposal.fingerprint);
    check(!proposalIds.has(proposal.id));
    proposalIds.add(proposal.id);
    oneOf(proposal.category, ["instructions", "skill-routing", "skill-procedure", "setup", "workflow"]);
    oneOf(proposal.scope, ["project-wide", "task-specific", "worktree/version-specific"]);
    oneOf(proposal.confidence, ["low", "medium", "high"]);
    check(proposal.validation === "structural-only; behavior not evaluated");
    for (const key of ["problem", "suggestion", "expectedEffect", "exceptions"]) string(proposal[key]);
    array(proposal.diffs, 100);
    proposal.diffs.forEach((item) => string(item));
    array(proposal.citations, 1000);
    for (const citation of proposal.citations) {
      object(citation, ["entryId", "quote"]);
      string(citation.entryId, 1024);
      string(citation.quote);
    }
    array(proposal.edits, 100);
    for (const edit of proposal.edits) {
      object(edit, ["path", "baseHash", "oldText", "newText"]);
      string(edit.path, 16384);
      check(!/[\x00-\x1f\x7f]/.test(edit.path));
      if (edit.baseHash !== null) hash(edit.baseHash);
      string(edit.oldText);
      string(edit.newText);
    }
  }
}

/** Apply the same validated privacy boundary to command output and stored domain records. */
export function sanitizeRun(run: RefineRun): RefineRun {
  validateRun(run);
  const safeRun = redactValue(run).value;
  validateRun(safeRun, run.projectId);
  return safeRun;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Walk every ancestor without following symlinks, including configured agent-directory ancestors. */
async function inspect(file: string): Promise<boolean> {
  const absolute = resolve(file);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error("Unsafe project-refine storage path.");
  }
  return true;
}
async function directory(file: string): Promise<void> {
  if (await inspect(file)) {
    if (!(await fs.lstat(file)).isDirectory()) throw new Error("Unsafe project-refine storage directory.");
    return;
  }
  const parent = dirname(file);
  if (parent !== file) await directory(parent);
  try {
    await fs.mkdir(file, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  if (!(await inspect(file)) || !(await fs.lstat(file)).isDirectory()) throw new Error("Unsafe project-refine storage directory.");
}
async function readPrivate(file: string, max = MAX_JSON): Promise<string> {
  if (!(await inspect(file))) throw Object.assign(new Error("Private record is missing."), { code: "ENOENT" });
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > max) throw new Error("Unsafe, non-private, or oversized project-refine private file.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Corrupt project-refine private JSON.");
  }
}
async function syncDirectory(file: string): Promise<void> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeNew(file: string, content: string): Promise<void> {
  check(Buffer.byteLength(content) <= MAX_JSON);
  await inspect(dirname(file));
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function atomic(file: string, content: string): Promise<void> {
  await inspect(file);
  const temp = join(dirname(file), `.tmp-${randomUUID()}`);
  try {
    await writeNew(temp, content);
    await inspect(file);
    await fs.rename(temp, file);
    await syncDirectory(dirname(file));
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

interface Owner {
  pid: number;
  host: string;
  token: string;
}
function validateOwner(value: unknown): asserts value is Owner {
  object(value, ["pid", "host", "token"]);
  count(value.pid);
  check(value.pid > 0);
  string(value.host, 256);
  uuid(value.token);
}
function alive(owner: Owner): boolean {
  // Never steal remote/unknown locks or a live PID, regardless of the age of the lock.
  if (owner.host !== LOCAL_HOST) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export class RefineStore {
  readonly root: string;
  private readonly parent: string;
  private readonly lockPath: string;
  readonly projectId: string;
  constructor(agentDir: string, projectId: string) {
    hash(projectId);
    this.projectId = projectId;
    check(typeof agentDir === "string" && agentDir.length > 0 && !agentDir.includes("\0"));
    this.parent = join(resolve(agentDir), "project-refine");
    this.root = join(this.parent, projectId);
    this.lockPath = join(this.parent, `.${projectId}.lock`);
  }

  reportPath(runId: string): string {
    uuid(runId);
    return join(this.root, "runs", runId, "report.md");
  }

  /** Hard-link publication makes the PID owner record atomic, even if its creator dies. */
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await directory(this.parent);
    await fs.chmod(this.parent, 0o700);
    await inspect(this.root);
    const owner: Owner = { pid: process.pid, host: LOCAL_HOST, token: randomUUID() };
    const candidate = join(this.parent, `.${this.projectId}.owner-${owner.token}`);
    await writeNew(candidate, JSON.stringify(owner));
    let acquired = false;
    const deadline = Date.now() + 15000;
    const readOwner = async (file: string): Promise<Owner> => {
      // Published owner files may still have their original hard link until acquisition completes.
      await inspect(file);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        check(stat.isFile() && stat.size <= 1024);
        const value = json(await handle.readFile("utf8"));
        validateOwner(value);
        return value;
      } finally {
        await handle.close();
      }
    };
    // A permanent, owner-token-specific reaping claim prevents two stale-lock removers
    // racing to unlink a newly acquired live lock. Dead claimants can themselves be
    // claimed recursively; no timeout can revoke a living process's claim.
    const claimDead = async (dead: Owner, depth = 0): Promise<boolean> => {
      if (alive(dead)) return false;
      check(depth < 128);
      const claim = join(this.parent, `.${this.projectId}.reap-${dead.token}`);
      try {
        await fs.link(candidate, claim);
        await syncDirectory(this.parent);
        return true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const claimant = await readOwner(claim);
      if (claimant.token === owner.token) return true;
      return claimDead(claimant, depth + 1);
    };
    try {
      while (!acquired) {
        try {
          await fs.link(candidate, this.lockPath);
          acquired = true;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          try {
            const previous = await readOwner(this.lockPath);
            if (!alive(previous) && await claimDead(previous)) {
              const current = await readOwner(this.lockPath);
              if (current.token === previous.token && !alive(current)) await fs.unlink(this.lockPath);
            }
          } catch (error) {
            if (!missing(error)) throw error;
          }
          if (Date.now() >= deadline) throw new Error("Project-refine private storage is busy; no live lock was stolen.");
          await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));
        }
      }
      await inspect(this.root);
      return await operation();
    } finally {
      if (acquired) {
        const current = await readOwner(this.lockPath);
        if (current.token !== owner.token) throw new Error("Project-refine lock ownership changed.");
        await fs.unlink(this.lockPath);
      }
      await fs.unlink(candidate).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  private async ensureRoot(): Promise<void> {
    await directory(this.root);
    await fs.chmod(this.root, 0o700);
    const runs = join(this.root, "runs");
    await directory(runs);
    await fs.chmod(runs, 0o700);
  }
  private async state(): Promise<ProjectState> {
    if (await inspect(this.root)) {
      const stat = await fs.lstat(this.root);
      check(stat.isDirectory() && (stat.mode & 0o077) === 0);
    }
    const file = join(this.root, "state.json");
    if (!(await inspect(file))) return initialState();
    const value = json(await readPrivate(file));
    validateState(value);
    return value;
  }
  private async runs(): Promise<RefineRun[]> {
    const folder = join(this.root, "runs");
    if (!(await inspect(folder))) return [];
    const folderStat = await fs.lstat(folder);
    check(folderStat.isDirectory() && (folderStat.mode & 0o077) === 0);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    check(entries.length <= MAX_RUNS);
    const runs: RefineRun[] = [];
    for (const entry of entries) {
      // Staging records are never committed and never contribute coverage.
      if (/^\.stage-[a-f0-9-]{36}$/.test(entry.name)) {
        await this.safeTree(join(folder, entry.name));
        continue;
      }
      uuid(entry.name);
      check(entry.isDirectory() && !entry.isSymbolicLink());
      const runDir = join(folder, entry.name);
      await inspect(runDir);
      check(((await fs.lstat(runDir)).mode & 0o077) === 0);
      check((await fs.readdir(runDir)).sort().join(",") === "report.md,run.json");
      const value = json(await readPrivate(join(runDir, "run.json")));
      validateRun(value, this.projectId);
      check(value.id === entry.name);
      await readPrivate(join(runDir, "report.md"), 4 * 1024 * 1024);
      runs.push(value);
    }
    return runs;
  }
  private reconcile(state: ProjectState, runs: RefineRun[]): ProjectState {
    for (const run of runs) {
      if (run.status !== "success" || !run.analyzedEpisodeIds.length) continue;
      state.covered[run.contextDigest] = [...new Set([...(state.covered[run.contextDigest] ?? []), ...run.analyzedEpisodeIds])].sort();
    }
    validateState(state);
    return state;
  }
  private async persist(state: ProjectState): Promise<void> {
    validateState(state);
    await atomic(join(this.root, "state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  async loadState(): Promise<ProjectState> {
    // A missing project is a pure read: no directories, locks, or default state files.
    if (!(await inspect(this.root))) return initialState();
    return this.locked(async () => this.reconcile(await this.state(), await this.runs()));
  }
  async rememberRoots(roots: string[]): Promise<void> {
    array(roots, 10000);
    roots.forEach(path);
    if (!roots.length) {
      await this.loadState();
      return;
    }
    await this.locked(async () => {
      const runs = await this.runs();
      const state = this.reconcile(await this.state(), runs);
      const merged = [...new Set([...state.historicalRoots, ...roots])].sort();
      if (JSON.stringify(merged) === JSON.stringify(state.historicalRoots)) return;
      state.historicalRoots = merged;
      validateState(state);
      await this.ensureRoot();
      await this.persist(state);
      await this.cleanup(runs);
    });
  }

  async saveRun(run: RefineRun, report: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal);
    // Scan reviewer strings again at the private-storage boundary. Never retain a raw response.
    const safeRun = sanitizeRun(run);
    check(safeRun.projectId === this.projectId);
    string(report, 4 * 1024 * 1024);
    const safeReport = redactText(report).text;
    check(Buffer.byteLength(JSON.stringify(safeRun)) <= MAX_JSON && Buffer.byteLength(safeReport) <= 4 * 1024 * 1024);
    await this.locked(async () => {
      throwIfAborted(options.signal);
      const runs = await this.runs();
      const state = this.reconcile(await this.state(), runs);
      throwIfAborted(options.signal);
      await this.ensureRoot();
      const folder = join(this.root, "runs");
      const target = join(folder, safeRun.id);
      if (await inspect(target)) throw new Error("A project-refine run ID is already stored.");
      this.reconcile(state, [safeRun]);
      // Validate all ledger and directory limits BEFORE creating staging or publishing.
      check(Buffer.byteLength(JSON.stringify(state, null, 2)) + 1 <= MAX_JSON);
      // Staging entries also count toward the reader's limit, including interrupted saves.
      check((await fs.readdir(folder)).length < MAX_RUNS);
      const staging = join(folder, `.stage-${randomUUID()}`);
      await fs.mkdir(staging, { mode: 0o700 });
      let published = false;
      try {
        await writeNew(join(staging, "run.json"), JSON.stringify(safeRun, null, 2) + "\n");
        await writeNew(join(staging, "report.md"), safeReport);
        await syncDirectory(staging);
        await inspect(target);
        await inspect(folder);
        // Publication is the commit point. A cancelled/replaced runtime cannot
        // publish after waiting for a lock or after writing staging artifacts.
        throwIfAborted(options.signal);
        // Both artifacts become visible together; a crash before this rename consumes nothing.
        await fs.rename(staging, target);
        published = true;
        await syncDirectory(folder);
        // If interrupted here, load/mutation recovers the ledger from complete committed runs.
        await this.persist(state);
        await this.cleanup([...runs, safeRun]);
      } finally {
        if (!published) await this.removeTree(staging);
      }
    });
  }
  async listRuns(): Promise<RefineRun[]> {
    if (!(await inspect(this.root))) return [];
    return this.locked(async () => {
      await this.state();
      return (await this.runs()).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, 50);
    });
  }
  async readRun(id: string): Promise<RefineRun> {
    uuid(id);
    if (!(await inspect(this.root))) throw new Error("Project-refine run not found.");
    return this.locked(async () => {
      await this.state();
      const value = json(await readPrivate(join(this.root, "runs", id, "run.json")));
      validateRun(value, this.projectId);
      check(value.id === id);
      await readPrivate(this.reportPath(id), 4 * 1024 * 1024);
      return value;
    });
  }
  async decide(proposalId: string, decision: ReviewDecision["decision"]): Promise<ReviewDecision> {
    hash(proposalId);
    oneOf(decision, ["accepted", "rejected", "deferred"]);
    return this.locked(async () => {
      const runs = await this.runs();
      const state = this.reconcile(await this.state(), runs);
      const matches = runs.flatMap((run) => {
        if (run.status !== "success") return [];
        return run.proposals
          .filter((proposal) => proposal.id === proposalId)
          .map((proposal) => ({ run, proposal }));
      });
      if (!matches.length) throw new Error("Stored project-refine proposal not found (it may have expired).");
      const { run, proposal } = matches[0];
      check(matches.every((match) =>
        match.run.contextDigest === run.contextDigest &&
        match.proposal.fingerprint === proposal.fingerprint &&
        JSON.stringify(match.proposal) === JSON.stringify(proposal)
      ));
      const result: ReviewDecision = { proposalId, fingerprint: proposal.fingerprint, contextDigest: run.contextDigest, decision, at: new Date().toISOString() };
      state.decisions.push(result);
      validateState(state);
      await this.ensureRoot();
      await this.persist(state);
      await this.cleanup(runs);
      return result;
    });
  }

  /** Preflight the entire tree so reset/retention never follows a nested symlink. */
  private async safeTree(file: string): Promise<void> {
    if (!(await inspect(file))) return;
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(file)) await this.safeTree(join(file, name));
    } else if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Unsafe project-refine private tree.");
    }
  }
  private async removeTree(file: string): Promise<void> {
    await this.safeTree(file);
    await fs.rm(file, { recursive: true, force: true });
  }
  private async cleanup(runs: RefineRun[]): Promise<void> {
    // Called only after the recovered compact ledger has been committed.
    const folder = join(this.root, "runs");
    for (const run of runs) {
      if (Date.parse(run.finishedAt ?? run.startedAt) >= Date.now() - RETENTION_MS) continue;
      // Unpublish durably before recursive deletion: an interrupted rm must leave
      // an ignored staging tree, never an incomplete committed UUID directory.
      const staging = join(folder, `.stage-${randomUUID()}`);
      await fs.rename(join(folder, run.id), staging);
      await syncDirectory(folder);
      await this.removeTree(staging);
    }
    for (const name of await fs.readdir(folder)) {
      if (/^\.stage-[a-f0-9-]{36}$/.test(name)) await this.removeTree(join(folder, name));
    }
    for (const name of await fs.readdir(this.root)) {
      if (/^\.tmp-[a-f0-9-]{36}$/.test(name)) await this.removeTree(join(this.root, name));
    }
  }
  async reset(): Promise<void> {
    if (!(await inspect(this.root))) return;
    await this.locked(async () => {
      await this.removeTree(this.root);
      await syncDirectory(this.parent);
    });
  }
}
