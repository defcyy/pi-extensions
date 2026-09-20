# pi-herdr-subagents

Asynchronous Pi subagents in [Herdr](https://herdr.dev).

The extension creates or reuses Herdr agents, runs tasks in the background, and delivers results back to the parent Pi session. It is designed specifically for Herdr rather than as a generic terminal-multiplexer integration.

## Requirements

- Pi 0.85 or newer
- Herdr with agent and pane commands
- Pi running inside Herdr (`HERDR_ENV=1`)
- Fence on `PATH` when a fenced parent creates fresh agents

## Install

For local development:

```bash
pnpm install
pi -e .
```

Or install the local package:

```bash
pi install /absolute/path/to/pi-herdr-subagents
```

## Quick start

Create a fresh one-shot Pi agent:

```ts
herdr_subagent({
  task: "Review the authentication flow",
});
```

The call returns immediately. The child runs in another pane, and its result is delivered later to the parent.

Keep a fresh child open for follow-up work:

```ts
herdr_subagent({
  task: "Explore this design with me",
  retention: "interactive",
});
```

Target an existing Herdr agent:

```ts
herdr_subagent({
  target: "reviewer",
  task: "Review the current diff",
});
```

Opt into conservative automatic reuse:

```ts
herdr_subagent({
  task: "Check the test coverage",
  reuse: "auto",
});
```

Automatic reuse succeeds only when exactly one idle or done agent matches the current workspace and working directory. The default, `reuse: "never"`, always creates a fresh agent.

## What happens on fresh dispatch

1. The extension creates a Herdr pane without focusing it.
2. It starts Pi through `herdr agent start`.
3. It prompts the child in the background.
4. It supervises blocked and timed-out work.
5. It reads the child result and delivers it to the parent.
6. It closes a successful one-shot pane after a final safety check.

The first child splits from the parent pane. Additional concurrent children split inside the subagent area so the parent is not repeatedly shrunk.

## Fence inheritance

If the parent has `FENCE_SANDBOX=1`, fresh children also start through Fence. A bundled `pi` launcher:

- sets `HERDR_AGENT=pi` so Herdr can track lifecycle state;
- runs `fence -- pi ...`;
- removes itself from `PATH` to prevent recursion;
- avoids starting a nested Fence sandbox.

Fence uses its normal configuration discovery from the child's working directory. Existing or reused agents are left as-is and may be unsandboxed. If Fence is required but unavailable, fresh startup fails instead of silently running without a sandbox.

## Tools

### `herdr_subagent`

| Parameter | Default | Meaning |
|---|---:|---|
| `task` | required | Task sent to the child |
| `target` | — | Existing agent name or pane ID |
| `reuse` | `never` | `never`, `auto`, or `require` |
| `retention` | `one-shot` | `one-shot` or `interactive` for fresh panes |
| `cwd` | parent cwd | Child working directory |
| `direction` | `auto` | `auto`, `right`, or `down` |
| `model` | parent model | Model for a fresh Pi agent |
| `thinking` | parent level | Thinking level for a fresh Pi agent |
| `tools` | Pi default | Comma-separated tool allowlist |
| `systemPrompt` | — | System prompt appended for a fresh agent |
| `timeoutMs` | `600000` | Initial wait threshold |

Important rules:

- `reuse: "require"` fails rather than creating an agent.
- Launch options (`model`, `thinking`, `tools`, and `systemPrompt`) require a fresh agent.
- Existing agents keep their current model and settings.
- Explicit models are validated before pane creation.
- `timeoutMs` does not abandon the job; supervision continues after the timeout notice.
- Fresh names are derived from the task and include a unique suffix.

### `herdr_subagent_control`

Call with no arguments to list active and recent jobs. For an active job ID:

- `focus` — focus its pane;
- `interrupt` — send Ctrl-C and keep supervising;
- `detach` — stop supervision and leave the pane open;
- `close` — close an extension-owned pane and stop supervision.

The extension never closes an existing or reused pane.

### `herdr_agents`

Lists recognized agents with their name, pane, state, workspace, and working directory. Use it to choose an explicit target, not to poll task completion.

The `/herdr-agents` command shows the same information as a notification.

## Safety and limits

- At most four jobs may be active or pending.
- Reuse is explicit and ambiguous matches fail.
- Agent pane, name, and Pi session identity are checked throughout a job.
- Blocked, timed-out, and failed running agents remain open for inspection.
- Parent shutdown stops local supervision but leaves active children running.
- Results cannot be delivered into a replacement parent session.
- Parallel agents share the same working tree. Use read-only tasks or separate worktrees for concurrent edits.
- Jobs are not automatically adopted after a parent restart or reload.

See [docs/architecture.md](docs/architecture.md) for implementation details.

## Development

```bash
pnpm test
pnpm typecheck
```
