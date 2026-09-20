# pi-herdr-subagents

Asynchronous one-shot Pi workers in [Herdr](https://herdr.dev).

The extension lets the main Pi agent send substantial independent work to fresh background workers. Workers never reuse an existing agent or session, cannot create subagents, and are closed after successful completion. Results are delivered back to the main session automatically.

## Requirements

- Pi 0.85 or newer
- Herdr with agent and pane commands
- Pi running inside Herdr (`HERDR_ENV=1`)
- Fence on `PATH` when a fenced parent creates workers

## Install

```bash
pi install git:github.com/defcyy/pi-extensions
```

Then restart Pi inside Herdr. For project-local installation:

```bash
pi install -l git:github.com/defcyy/pi-extensions
```

For local development:

```bash
pnpm install
pi -e .
```

Pi packages execute code with your user permissions. Review the source before installation.

## Usage

Start a worker only when useful work can happen in parallel:

```ts
herdr_subagent({
  task: "Review the authentication flow and report correctness risks",
  parallelReason: "The main agent will implement the independent CLI changes concurrently",
});
```

The call returns immediately. Completion is delivered later as a steer message; do not poll for it.

Do not delegate sequential steps, small tasks, or work requiring frequent coordination. Run those directly in the main agent.

## One-shot lifecycle

1. The main extension reserves one of four job slots.
2. It creates a fresh Herdr pane marked with `PI_HERDR_SUBAGENT=1`.
3. It starts a fresh Pi process and sends one self-contained task.
4. It supervises the worker and extracts only its new assistant output.
5. It closes the successful worker pane and delivers the result.

There is no target selection, agent reuse, persistent worker, or session resume API. This avoids stale context and prevents an existing main-agent process from being treated as a restricted worker.

Additional concurrent workers split inside the existing worker area so the main pane is not repeatedly shrunk.

## Child-to-parent handover

A worker exposes one extension tool:

```ts
caller_ping({
  task: "Inspect the database migration ordering",
  reason: "This investigation is independent and can run while the parent continues implementation",
  context: "Relevant migrations are under db/migrations; report ordering conflicts only",
});
```

`caller_ping` does **not** create an agent. It writes a job-scoped handover, ends the one-shot worker, and notifies the main agent. The main agent then decides whether the proposed task genuinely warrants another parallel worker. Any new worker still counts against the global four-job limit.

Workers receive explicit boundary instructions to complete work directly and use `caller_ping` only when another independent parallel task is necessary—not for sequential work they can perform themselves.

## Tools

### `herdr_subagent`

| Parameter | Default | Meaning |
|---|---:|---|
| `task` | required | Self-contained task for a fresh worker |
| `parallelReason` | required | Useful independent work the main agent will perform concurrently |
| `cwd` | parent cwd | Worker working directory |
| `direction` | `auto` | `auto`, `right`, or `down` |
| `model` | parent model | Available `provider/model` override |
| `thinking` | parent level | Thinking-level override |
| `tools` | Pi default | Comma-separated worker tool allowlist; `caller_ping` is always added |
| `systemPrompt` | — | Additional worker system prompt |
| `timeoutMs` | `600000` | Initial wait threshold; supervision continues afterward |

### `herdr_subagent_control`

Call without arguments to list active and recent jobs. For an active job:

- `focus` — focus its pane;
- `interrupt` — send Ctrl-C while retaining supervision;
- `detach` — stop supervision and leave the pane open;
- `close` — close the owned pane and stop supervision.

### Worker-only `caller_ping`

| Parameter | Required | Meaning |
|---|---:|---|
| `task` | yes | Proposed self-contained parallel task |
| `reason` | yes | Why separate parallel work is necessary |
| `context` | no | Findings, paths, constraints, and expected output |

Workers do not receive `herdr_subagent`, `herdr_subagent_control`, commands, or main-session renderers.

## Fence inheritance

When the parent has `FENCE_SANDBOX=1`, fresh workers start through the bundled Fence-aware `pi` launcher. It preserves Herdr lifecycle detection, prevents nested Fence startup, and fails safely when the launcher is unavailable.

## Safety and limits

- Only the unmarked main Pi process can create or manage workers.
- At most four jobs may be active or provisioning.
- Every worker is fresh, marked, one-shot, and receives no spawning capability.
- `parallelReason` makes the parallelism decision explicit at every dispatch.
- A worker can propose work through `caller_ping`; only the main agent can approve and launch it.
- Agent pane, name, and Pi session identity are checked throughout execution.
- Parallel workers share the working tree. Prefer disjoint edits or read-only tasks.
- Parent replacement cannot receive stale results.
- Jobs are not adopted after restart or reload.

See [docs/architecture.md](docs/architecture.md) for implementation details.

## Development

```bash
pnpm test
pnpm typecheck
```
