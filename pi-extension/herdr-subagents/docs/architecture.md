# Architecture

## Purpose

`pi-herdr-subagents` provides bounded asynchronous parallelism for a Pi session running in Herdr.

The main session may launch fresh one-shot Pi workers. Herdr owns panes, process startup, prompting, and normalized agent state. The extension owns job admission, worker isolation, supervision, handover delivery, cleanup, and UI updates.

It intentionally does not provide reusable agents, session continuation, arbitrary target panes, recursive orchestration, worktrees, or automatic merging.

## Modules

| Module | Responsibility |
|---|---|
| `index.ts` | Main and worker tool surfaces, jobs, supervision, handovers, controls, completion delivery, and UI |
| `herdr.ts` | Bounded Herdr CLI calls and response validation |
| `policy.ts` | Worker environment, concurrency, tool scope, split placement, generated names, and model selection |
| `session.ts` | Incremental Pi session reading and UTF-8-safe result truncation |
| `fenced-bin/pi` | Fence-aware launcher for workers of a fenced parent |

## Process roles

Role is fixed when a Pi process starts.

### Main process

An unmarked process registers:

- `herdr_subagent`;
- `herdr_subagent_control`;
- lifecycle handlers and the result renderer.

It enforces one shared limit of four active or pending jobs. Pending pane creation counts toward the limit so simultaneous calls cannot over-provision workers.

### Worker process

Every worker pane receives:

```text
PI_HERDR_SUBAGENT=1
PI_HERDR_JOB_ID=<job id>
PI_HERDR_HANDOVER_FILE=<unguessable temporary path>
```

A marked process registers only `caller_ping` plus a worker-boundary system-prompt hook. It does not register spawning, management, listing, command, or renderer surfaces. The marker is inherited by subprocesses, so a nested Pi process also cannot gain main-agent authority.

When the caller supplies an explicit Pi tool allowlist, the launcher adds `caller_ping` to it.

## Parallel-work admission

Every dispatch requires:

- a self-contained `task`;
- a nonblank `parallelReason` describing useful independent work the main agent will do concurrently.

Tool guidance explicitly rejects delegation for sequential steps, trivial work, and tasks needing frequent coordination. Semantic necessity ultimately remains a model decision, but the required rationale makes that decision explicit and reviewable.

## Dispatch

A dispatch always follows one path:

1. Validate Herdr and parallel-work inputs.
2. Reserve capacity before asynchronous provisioning.
3. Generate a job ID and private handover path.
4. Select a split location in the worker area.
5. Create a fresh marked pane.
6. Register the job before background execution.
7. Start a fresh Pi process with inherited or explicit model settings.
8. Send exactly one task.

There is no reuse, target, retention, or resume branch.

## Pane placement

The first worker splits from the main Pi pane. Later concurrent workers split from the newest live extension-owned worker pane. Finished, detached, and closed jobs stop being split anchors. If layout inspection fails, creation falls back to splitting the main pane.

Short Herdr mutations are serialized. Worker model execution remains parallel.

## Child-to-parent handover

A worker that believes another independent worker is necessary calls:

```text
caller_ping({ task, reason, context? })
```

The tool:

1. validates that it is running in a managed worker;
2. atomically publishes a mode-0600 job-scoped JSON handover;
3. shuts down the one-shot worker.

The parent supervisor validates the handover type, job identity, task, and reason. It closes the worker pane and delivers a `handover` result to the main session. No child is created automatically. The main agent evaluates the proposal and, if justified, makes a normal `herdr_subagent` call subject to the same parallel rationale and four-job limit.

This preserves one orchestration authority while giving workers a structured escalation channel.

## Job lifecycle

```text
queued → starting → working → completed
                         ↘ handover
                         ↘ blocked
                         ↘ timed-out → continued supervision
                         ↘ failed
                         ↘ detached
```

`timeoutMs` is an initial wait threshold rather than a job deadline. Blocked and timed-out workers remain supervised until they settle or are manually interrupted, detached, or closed.

Controls are restricted to extension-owned one-shot panes:

- `focus` changes focus;
- `interrupt` sends Ctrl-C and supervision continues;
- `detach` stops supervision but leaves the pane;
- `close` closes the pane and ends supervision.

## Identity checks

Each job records:

- pane ID;
- generated agent name;
- Pi session path when available;
- parent Pi session ID;
- private handover path.

Every Herdr response must match the expected pane, name, and session. On mismatch, the extension does not prompt, collect from, or automatically close the unexpected agent. This favors containment over aggressive cleanup.

## Results and cleanup

The parent records the child session byte offset before prompting and reads only assistant output appended afterward. Result text is truncated to 16 KiB without splitting UTF-8 code points.

Normal success ordering is:

1. collect output;
2. verify the settled agent identity;
3. safely close the unfocused owned pane;
4. persist a compact parent-session record;
5. deliver the visible completion.

A cleanup failure becomes a warning without discarding successful output. Handover shutdown uses the private sidecar as the authoritative result and closes the owned pane directly.

Near-simultaneous completions are batched. While siblings remain, delivery waits up to three seconds; after the final sibling settles, it flushes after 300 ms. Only the final inserted message triggers a parent model turn.

## Fence startup

For a fenced parent, the worker pane prepends `fenced-bin` to `PATH`. The launcher removes itself from `PATH`, sets `HERDR_AGENT=pi`, and either runs Pi directly inside an existing sandbox or enters Fence first.

## Parent shutdown

Every job belongs to the parent session that launched it and has an `AbortController`. Parent shutdown stops local watchers, flushes pending messages without starting another turn, releases reservations as runners unwind, and prevents stale delivery to a replacement session. A pane selected before job registration is closed.

Jobs are not adopted after restart or reload.

## Failure containment

- Herdr commands use argument arrays rather than shell interpolation.
- Calls are bounded and abortable.
- Detached promises have rejection handlers.
- Handover files use random paths, atomic publication, strict job identity, and best-effort removal.
- UI, persistence, delivery, and cleanup errors remain inside the background runner.
- Failed identity checks retain the pane rather than acting on an unexpected process.

## Known limits

### Shared working tree

Parallel workers use the requested directory directly. Concurrent writers must operate on disjoint files or use externally prepared worktrees.

### Parallelism is policy-assisted

`parallelReason` and prompt guidance make the admission decision explicit, but the extension cannot prove semantic independence automatically.

### Failed pane retention

A worker pane may remain when identity is uncertain, it is still active, or cleanup fails. It cannot be reused through this extension and may be closed with the control tool while the job remains active.

### No durable adoption

Active jobs are not reattached after parent replacement.

## Tests

The suite covers worker-only tool isolation and handover records, fresh worker environment construction, caller tool allowlisting, four-job admission, split placement, model resolution, session extraction, UTF-8 truncation, identity mismatches, command timeout and abort behavior, shutdown and close races, and Fence startup.
