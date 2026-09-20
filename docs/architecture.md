# Architecture

## Purpose

`pi-herdr-subagents` adds asynchronous delegation to a Pi session running in Herdr.

Herdr owns panes, process startup, agent detection, prompting, and normalized agent state. The extension owns target selection, job supervision, result extraction, cleanup policy, and Pi UI updates.

It does not provide a generic multiplexer layer, distributed job queue, worktree management, or automatic code merging.

## Modules

| Module | Responsibility |
|---|---|
| `index.ts` | Tools, jobs, supervision, controls, shutdown, completion delivery, and UI |
| `herdr.ts` | Bounded Herdr CLI calls and response validation |
| `policy.ts` | Reuse rules, split placement, generated names, and model selection |
| `session.ts` | Incremental Pi session reading and UTF-8-safe result truncation |
| `fenced-bin/pi` | Fence-aware launcher for fresh children of a fenced parent |

The job supervisor remains in `index.ts` because it depends directly on Pi lifecycle callbacks. Stateless policy and I/O helpers live in separate modules.

## Dispatch

A dispatch follows this decision path:

1. If `target` is supplied, validate and reserve that agent.
2. Otherwise apply `reuse`:
   - `never` creates a fresh Pi agent;
   - `auto` reuses one safe match or creates a fresh agent;
   - `require` reuses one safe match or fails.
3. Register the job before starting background supervision.
4. Return the job ID and pane immediately.

A reusable agent must be:

- recognized by Herdr;
- idle or done;
- in the same workspace and working directory;
- the only eligible match;
- not already reserved by another job.

Fresh creation is the default because matching workspace and directory does not prove ownership or user intent.

## Pane placement

The first fresh child splits from the parent Pi pane. Later concurrent children split from the newest live extension-owned child. This keeps new panes in a subagent area rather than repeatedly shrinking the parent.

Finished, detached, and closed jobs stop being split anchors. If layout inspection fails, the extension falls back to the parent pane.

Short Herdr mutations and target selection are serialized. Child model work still runs in parallel. No more than four jobs may be active or pending.

## Fence startup

When the parent has `FENCE_SANDBOX=1`, the extension prepends `fenced-bin` to the fresh pane's `PATH`. Herdr still starts the normal `pi` command, but the bundled launcher runs first.

The launcher:

1. removes its own directory from `PATH`;
2. exports `HERDR_AGENT=pi`;
3. runs the real Pi directly if already sandboxed;
4. otherwise runs `fence -- pi ...`.

This preserves Herdr's Pi detection while giving fresh children Fence confinement. Existing and reused agents are not modified.

## Job lifecycle

A job moves through these practical states:

```text
queued → starting → working → completed/failed
                         ↘ blocked
                         ↘ timed-out → continued supervision
                         ↘ detached
```

`timeoutMs` is only the initial wait threshold. A timed-out or blocked job remains reserved and supervised through bounded wait calls until it finishes or the user detaches or closes it.

Controls behave as follows:

- `focus` changes pane focus only;
- `interrupt` sends Ctrl-C and supervision continues;
- `detach` stops supervision without touching the pane;
- `close` is allowed only for extension-owned panes.

If a close attempt fails, supervision resumes.

## Identity and ownership

Each job stores immutable expected identity:

- pane ID;
- agent name;
- Pi session path when available;
- parent Pi session ID;
- whether the pane is extension-owned.

Every later Herdr response must match that identity. On a mismatch, the extension does not prompt, collect from, or automatically close the unexpected agent. The job fails and an owned pane is retained for inspection.

Existing and reused panes are never closed automatically. A one-shot pane is closed only when it is still the same recognized, idle or done, unfocused agent.

## Results and cleanup

For Pi children, the extension records the session byte position before prompting and reads only newly appended assistant output. Other agent kinds may fall back to terminal capture.

Completion order is:

1. collect and truncate the result;
2. preserve the result independently of cleanup;
3. attempt safe one-shot cleanup;
4. persist a compact record in the parent session;
5. deliver the visible completion message.

Result text is limited to 16 KiB without splitting UTF-8 code points. Cleanup failure produces a warning rather than replacing successful output with an error.

Near-simultaneous results are batched. While sibling jobs remain, delivery waits up to three seconds. After the final sibling settles, the batch flushes after 300 ms. Only the final inserted message triggers a parent model turn.

## Parent shutdown

Each job has an `AbortController` and belongs to the parent session that created it.

On parent shutdown, the extension:

- stops local watchers;
- flushes pending messages without starting another model turn;
- releases reservations as runners unwind;
- closes a pane selected during an unfinished dispatch before its agent starts;
- leaves already-running child panes intact;
- prevents stale delivery into a replacement Pi session.

Jobs are not adopted automatically after restart or reload. Their panes survive for manual inspection.

## Failure containment

- Herdr commands use argument arrays, not shell interpolation.
- Calls are bounded, abortable, and escalated from SIGTERM to SIGKILL when needed.
- Detached promises always have rejection handlers.
- UI, persistence, delivery, and cleanup errors stay inside the background runner.
- Successful output is preserved even if delivery or cleanup fails.
- Failed startup cleanup is best effort.

## Known limits

### Shared working tree

Parallel agents use the requested directory directly and can conflict when editing. Use isolated worktrees or keep concurrent tasks read-only.

### User takeover

A focused one-shot pane is retained at completion. This is conservative but cannot detect every earlier interaction. Use `retention: "interactive"` when follow-up work is expected.

### Non-Pi output

Pi provides structured JSONL output. Terminal fallback for other agents may contain UI text or incomplete history.

### No durable adoption

Active jobs are not reattached after parent replacement. This avoids sending old results into the wrong session.

## Tests

The test suite covers routing and reuse policy, model resolution, split placement, session extraction, UTF-8 truncation, Herdr response validation, identity mismatches, command timeout handling, shutdown races, close coordination, and Fence launcher behavior.

High-value manual checks are:

- several simultaneous fresh jobs;
- blocked and timed-out supervision;
- interrupting or closing a child while the parent remains active;
- cleanup failure after successful output;
- parent shutdown while a child is running.
