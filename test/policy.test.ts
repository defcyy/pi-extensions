import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrAgent, HerdrLayout } from "../pi-extension/herdr-subagents/herdr.ts";
import {
  canCloseOwnedPane,
  canDispatchJob,
  chooseSplitDirection,
  chooseSplitParent,
  completionBatchDelay,
  HERDR_HANDOVER_FILE_ENV,
  HERDR_JOB_ID_ENV,
  HERDR_SUBAGENT_ENV,
  isDelegatedWorker,
  makeTaskAgentName,
  resolveModelSelection,
  workerPaneEnvironment,
  workerToolAllowlist,
} from "../pi-extension/herdr-subagents/policy.ts";

function agent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    agent: "pi",
    agent_status: "idle",
    cwd: "/repo",
    foreground_cwd: "/repo",
    pane_id: "w1:p2",
    tab_id: "w1:t1",
    workspace_id: "w1",
    ...overrides,
  };
}

test("worker panes are marked as delegated", () => {
  assert.deepEqual(
    workerPaneEnvironment({
      fenced: false,
      fencedBinDir: "/unused",
      handoverFile: "/tmp/handover.json",
      jobId: "job-1",
      path: "/usr/bin",
    }),
    {
      [HERDR_SUBAGENT_ENV]: "1",
      [HERDR_HANDOVER_FILE_ENV]: "/tmp/handover.json",
      [HERDR_JOB_ID_ENV]: "job-1",
    },
  );
});

test("fenced worker panes prepend the launcher directory", () => {
  assert.deepEqual(
    workerPaneEnvironment({
      fenced: true,
      fencedBinDir: "/extension/fenced-bin",
      handoverFile: "/tmp/handover.json",
      jobId: "job-1",
      path: "/usr/bin",
    }),
    {
      [HERDR_SUBAGENT_ENV]: "1",
      [HERDR_HANDOVER_FILE_ENV]: "/tmp/handover.json",
      [HERDR_JOB_ID_ENV]: "job-1",
      PATH: "/extension/fenced-bin:/usr/bin",
    },
  );
});

test("only the explicit worker marker disables delegation", () => {
  assert.equal(isDelegatedWorker({ [HERDR_SUBAGENT_ENV]: "1" }), true);
  assert.equal(isDelegatedWorker({}), false);
  assert.equal(isDelegatedWorker({ [HERDR_SUBAGENT_ENV]: "0" }), false);
});

test("dispatch capacity includes active and pending jobs", () => {
  assert.equal(canDispatchJob(3, 0), true);
  assert.equal(canDispatchJob(3, 1), false);
  assert.equal(canDispatchJob(4, 0), false);
});

test("an explicit worker allowlist always includes caller_ping", () => {
  assert.equal(workerToolAllowlist(undefined), undefined);
  assert.equal(workerToolAllowlist("read,bash"), "read,bash,caller_ping");
  assert.equal(workerToolAllowlist("read,caller_ping"), "read,caller_ping");
});

test("completion batching waits for active siblings but flushes the final result quickly", () => {
  assert.equal(completionBatchDelay(3), 3_000);
  assert.equal(completionBatchDelay(2), 3_000);
  assert.equal(completionBatchDelay(1), 300);
});

test("owned pane cleanup requires the same idle, unfocused recognized agent", () => {
  assert.equal(canCloseOwnedPane(agent(), "w1:p2"), true);
  assert.equal(canCloseOwnedPane(agent({ focused: true }), "w1:p2"), false);
  assert.equal(canCloseOwnedPane(agent({ agent_status: "working" }), "w1:p2"), false);
  assert.equal(canCloseOwnedPane(agent(), "w1:other"), false);
});

test("chooseSplitParent keeps later splits in the live subagent region", () => {
  const layout: HerdrLayout = {
    area: { width: 200, height: 60 },
    panes: [
      { pane_id: "w1:main", rect: { width: 100, height: 60, x: 0, y: 0 } },
      { pane_id: "w1:child-1", rect: { width: 50, height: 60, x: 100, y: 0 } },
      { pane_id: "w1:child-2", rect: { width: 50, height: 60, x: 150, y: 0 } },
    ],
  };

  assert.equal(
    chooseSplitParent(layout, "w1:main", ["w1:closed", "w1:child-1", "w1:child-2"]),
    "w1:child-2",
  );
  assert.equal(chooseSplitParent(layout, "w1:main", ["w1:closed"]), "w1:main");
});

test("chooseSplitDirection splits wide panes right and narrow panes down", () => {
  const wide: HerdrLayout = {
    area: { width: 200, height: 60 },
    panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 60, x: 0, y: 0 } }],
  };
  const narrow: HerdrLayout = {
    area: { width: 80, height: 60 },
    panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 60, x: 0, y: 0 } }],
  };

  assert.equal(chooseSplitDirection(wide, "w1:p1"), "right");
  assert.equal(chooseSplitDirection(narrow, "w1:p1"), "down");
});

test("makeTaskAgentName derives a valid unique Herdr name from the task", () => {
  const name = makeTaskAgentName("Please review authentication error handling", "ABCDEF12");
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(name, /^review-authentication/);
  assert.ok(name.endsWith("-abcdef12"));
  assert.doesNotMatch(
    makeTaskAgentName("Return exactly epsilon with a deliberately long description", "ABCDEF12"),
    /--abcdef12$/,
  );
});

test("resolveModelSelection inherits the parent model by default", () => {
  assert.equal(
    resolveModelSelection({
      parent: { provider: "anthropic", id: "claude-sonnet" },
      available: [{ provider: "anthropic", id: "claude-sonnet" }],
    }),
    "anthropic/claude-sonnet",
  );
});

test("resolveModelSelection validates canonical and unambiguous bare model IDs", () => {
  const available = [
    { provider: "anthropic", id: "claude-sonnet" },
    { provider: "openai", id: "gpt-5" },
  ];
  assert.equal(
    resolveModelSelection({ requested: "openai/gpt-5", available }),
    "openai/gpt-5",
  );
  assert.equal(
    resolveModelSelection({ requested: "claude-sonnet", available }),
    "anthropic/claude-sonnet",
  );
  assert.throws(
    () => resolveModelSelection({ requested: "openai/missing", available }),
    /not available/,
  );
});

test("resolveModelSelection rejects ambiguous bare model IDs", () => {
  assert.throws(
    () =>
      resolveModelSelection({
        requested: "shared-model",
        available: [
          { provider: "provider-a", id: "shared-model" },
          { provider: "provider-b", id: "shared-model" },
        ],
      }),
    /multiple providers/,
  );
});
