import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrAgent, HerdrLayout } from "../pi-extension/herdr-subagents/herdr.ts";
import {
  canCloseOwnedPane,
  chooseSplitDirection,
  chooseSplitParent,
  completionBatchDelay,
  findReusableAgents,
  makeTaskAgentName,
  requestedLaunchOverrides,
  resolveModelSelection,
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

test("completion batching waits for active siblings but flushes the final result quickly", () => {
  assert.equal(completionBatchDelay(3), 3_000);
  assert.equal(completionBatchDelay(2), 3_000);
  assert.equal(completionBatchDelay(1), 300);
});

test("explicit launch settings are detected even when empty", () => {
  assert.deepEqual(requestedLaunchOverrides({}), []);
  assert.deepEqual(
    requestedLaunchOverrides({ thinking: "low", tools: "", systemPrompt: "review" }),
    ["thinking", "tools", "systemPrompt"],
  );
});

test("owned pane cleanup requires the same idle, unfocused recognized agent", () => {
  assert.equal(canCloseOwnedPane(agent(), "w1:p2"), true);
  assert.equal(canCloseOwnedPane(agent({ focused: true }), "w1:p2"), false);
  assert.equal(canCloseOwnedPane(agent({ agent_status: "working" }), "w1:p2"), false);
  assert.equal(canCloseOwnedPane(agent(), "w1:other"), false);
});

test("findReusableAgents returns recognized idle agents in the same workspace and cwd", () => {
  const agents = [
    agent(),
    agent({ pane_id: "w1:p3", agent_status: "working" }),
    agent({ pane_id: "w1:p4", agent: "claude" }),
    agent({ pane_id: "w1:p7", agent: null }),
    agent({ pane_id: "w2:p1", workspace_id: "w2" }),
    agent({ pane_id: "w1:p5", cwd: "/other", foreground_cwd: "/other" }),
    agent({ pane_id: "w1:p6", agent_status: "done" }),
  ];

  assert.deepEqual(
    findReusableAgents({
      agents,
      workspaceId: "w1",
      currentPaneId: "w1:p1",
      cwd: "/repo",
      reservedTargets: new Set(["w1:p6"]),
    }).map((candidate) => candidate.pane_id),
    ["w1:p2", "w1:p4"],
  );
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
