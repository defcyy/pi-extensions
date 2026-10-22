# Project Refine

Manual, proposal-only reflection on a project's Pi sessions **across its Git worktrees**. It combines a local resource audit with cited historical requests, corrections, tool failures/recoveries, and useful verification workflows. Suggestions may improve `AGENTS.md`, skills, references, prompts, or setup documentation.

**Nothing is applied.** Accepting a proposal records a review decision. This extension does not edit project files, resume/write source sessions, run project scripts, install packages, commit, or inject learned instructions into task conversations.

Requires **Pi >=1.3.0 <2**, Git for repository scoping, and an active configured model for proposals. Core tests also run without a provider or paid model calls. The other extensions in this package remain covered by the regression suite after the Pi development dependency upgrade.

## Commands

```text
/project-refine                         # Menu/help
/project-refine audit                   # Local inventory + session coverage, no model
/project-refine propose --since 14d      # Preview, consent, then one bounded model call
/project-refine propose --since all     # Broader history, still bounded per run
/project-refine review [full-proposal-id]
/project-refine history
/project-refine cancel
/project-refine reset                   # Confirm deletion of this project's private data
```

Scope options (quote paths containing spaces):

```text
--root "/project"                       # Explicit root, required outside Git
--session-root "/custom/sessions"        # Repeatable; supplied roots replace default stores
--historical-root "/old/worktree"        # Explicit association with this repository
--exclude-worktree "/project/feature"    # Exclude evidence from this root
--rereview                              # Reconsider covered episodes/rejected suggestions
```

Without `--session-root`, collection scans the resolved Pi agent directory's `sessions`, the current session directory, and `PI_CODING_AGENT_SESSION_DIR` when set. Explicitly add other custom stores; arbitrary stores cannot be inferred from history.

Bare invocation offers actions by placing the selected command in the input editor; submit it to run. Audit/history/review reports work without a UI. **Noninteractive `propose` is deliberately refused**: no absent dialog or generic `--yes` can authorize provider disclosure. TUI and RPC clients must support preview and confirmation.

## Review and disclosure

`propose` waits for the current agent to be idle, snapshots evidence, sanitizes it, and opens a disclosure preview. Inspect the worktree scope, resource/evidence omissions, exact payload and provider/model. Cancel if it includes sensitive material. Edits in the preview editor are ignored; use scope options to narrow collection instead. Closing/submitting a preview is not consent: a separate confirmation binds authorization to the payload digest and selected provider/model.

The reviewer uses the active Pi model/provider configuration, **no tools**, no ambient resource discovery, and no silent model fallback. It has one 90-second call, at most six uncovered episodes, a 48 KiB total request-text cap (further reduced for small-context models), and at most three proposals. Output tokens are capped at 6,000. Provider-reported usage is saved when available. Redaction is pattern-based and incomplete; there is no guarantee that all secrets or injection attempts are detected.

A report contains session-qualified evidence citations and exact excerpts, applicability/exceptions, minimal proposed diffs against disclosed hashes, and an explicit **“structural-only; behavior not evaluated”** label. Unknown citations/quotes, unsafe targets, ambiguous/overlapping edits, stale files, tool requests, truncated replies, and malformed output fail the run without advancing coverage.

Review can accept, reject, or defer a proposal. **Accept does not apply it.** Use the private Markdown report/patch manually if desired; automatic application, undo and execution trials are not implemented.

## Project and resource scope

- Local repository identity is its canonical Git common directory. Main/linked/detached worktrees share evidence; separate clones and nested independent repositories/submodules do not, even with matching remotes.
- Sessions started in nested worktree directories are included. Header `cwd`, not encoded directory names or creation-date filenames, establishes attribution. Recent activity in resumed old sessions is eligible.
- Registered missing worktrees and previously verified paths can be attributed historically. Unknown pruned worktrees require `--historical-root`; a reused path with conflicting live repository identity is rejected. Complete recovery of unrecorded removed worktrees is impossible from cwd-only headers.
- Edits target only the selected current checkout. Other worktrees supply evidence, not edit destinations. `--root` in Git must select a checkout of the same repository; monorepo subproject filtering is not implemented.
- Named resources: root/nested `AGENTS.md`, `.pi/skills`, `.agents/skills`, `.github/skills`, skill Markdown references, `.pi/prompts`, `.pi/settings.json`, and common package manifests. Setup/configuration files are advisory-only. New `AGENTS.md` or a non-colliding new skill in an established skill directory can be proposed.
- No global/ancestor/package-installed resources, executable extensions, dependencies/build directories, symlinks, or custom configured discovery paths are loaded. Ambiguous ownership and scanner limitations are shown. Audit never executes setup commands.

## History fidelity and coverage

The collector reads bounded immutable JSONL snapshots. It supports v1–v3 headers, legacy string/block content, conversation branches/multiple roots, ancestry-paired tool outcomes, current-session entry cutoffs, and verified related-fork prefixes. Thinking/images/system/hidden custom bodies are not submitted. Ordinary task conversations are retained when marked refinement intervals are excluded.

Historical **raw evidence is not a model-visible context replay**. Compaction, `context_edit`, system deltas, unavailable old skill content and the final active leaf are explicitly marked unknown where not reconstructed. Tool output and excerpts can be truncated; nested-call bodies may be absent. A non-error read does not establish that a skill was followed. Assistant claims, later user messages, or an ordinary successful tool call do not prove overall task success.

Collection and requests have explicit file/byte/node/branch/episode limits. Reports show retained counts and omissions, not a false claim that every session was analyzed. The first implementation performs **one combined review call per invocation**, not multi-batch synthesis. Repeat `propose` to continue over uncovered episodes across worktrees; `--since all` broadens the date window. The collector's 200-episode catalog limit is an explicit initial limitation for large backlogs; narrow date ranges when the catalog is saturated.

Coverage is keyed by source episode, reviewer version, current resource manifest, selected checkout and model. Only submitted episodes from a validated successful response advance it; valid zero-proposal results count as analyzed. Re-review invalidates neither source history nor previous decisions. Rejected unchanged proposal fingerprints are suppressed unless `--rereview` is used; semantic paraphrases are not guaranteed to share a fingerprint.

## Private state and safety boundaries

State is under `<resolved-pi-agent-dir>/project-refine/<project-id>/`:

- Redacted JSON run records and Markdown reports.
- Compact coverage, verified/explicit historical worktree associations, and append-only review decisions.
- No additional raw transcript copies or source-session sidecars.

Directories/files use 0700/0600 permissions where supported, atomic publication, and cross-process locking. Unsafe IDs, corrupt data, symlinks, non-private files and hardlinks are rejected. Reports expire after 30 days on a subsequent state mutation; compact coverage/decisions persist until `reset`. Retention is not a background timer. Reset removes this project's private data only and causes future collection to reconsider history.

This is not an OS sandbox. Pi extensions have user permissions; hostile concurrent filesystem writers cannot be fully controlled by path/hash checks. Secret scanners and schema checks cannot prove semantic safety or behavioral improvement. Remote providers may process authorized evidence according to their own policies.

## Development

```sh
pnpm test
pnpm typecheck
pi -e ./pi-extension/project-refine/index.ts
```

The suite exercises real disposable Git worktrees and read-only synthetic session snapshots, injected no-tools review calls, cancellation and invalid responses, exact diffs, redaction, private storage/retention, cross-process concurrency, and no-project-write invariants. Model effectiveness and full task replay are not claimed by those tests.

The reviewer version is part of coverage identity. Changes to payload preparation can therefore cause previously analyzed evidence to be reviewed again. Existing reports still expire normally; compact coverage and decisions remain until reset.
