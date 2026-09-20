import { resolve } from "node:path";
import type { HerdrAgent, HerdrLayout } from "./herdr.ts";

export interface ModelRef {
  provider: string;
  id: string;
}

const REUSABLE_STATES = new Set(["idle", "done"]);

export function isReusableAgent(agent: HerdrAgent): boolean {
  return typeof agent.agent === "string" && REUSABLE_STATES.has(agent.agent_status);
}

export function canCloseOwnedPane(agent: HerdrAgent, paneId: string): boolean {
  return agent.pane_id === paneId && !agent.focused && isReusableAgent(agent);
}

export function findReusableAgents(params: {
  agents: HerdrAgent[];
  workspaceId: string;
  currentPaneId: string;
  cwd: string;
  reservedTargets: ReadonlySet<string>;
}): HerdrAgent[] {
  const expectedCwd = resolve(params.cwd);
  return params.agents.filter((agent) => {
    const agentCwd = agent.foreground_cwd ?? agent.cwd;
    return (
      isReusableAgent(agent) &&
      agent.workspace_id === params.workspaceId &&
      agent.pane_id !== params.currentPaneId &&
      !params.reservedTargets.has(agent.pane_id) &&
      typeof agentCwd === "string" &&
      resolve(agentCwd) === expectedCwd
    );
  });
}

export function chooseSplitDirection(
  layout: HerdrLayout,
  currentPaneId: string,
): "right" | "down" {
  const pane = layout.panes.find((candidate) => candidate.pane_id === currentPaneId);
  const rect = pane?.rect ?? layout.area;
  return rect.width >= 100 && rect.width >= rect.height * 1.4 ? "right" : "down";
}

export function chooseSplitParent(
  layout: HerdrLayout,
  mainPaneId: string,
  ownedPaneIds: readonly string[],
): string {
  const livePanes = new Set(layout.panes.map((pane) => pane.pane_id));
  for (let index = ownedPaneIds.length - 1; index >= 0; index--) {
    if (livePanes.has(ownedPaneIds[index])) return ownedPaneIds[index];
  }
  return mainPaneId;
}

export function completionBatchDelay(activeJobs: number): number {
  return activeJobs > 1 ? 3_000 : 300;
}

export function requestedLaunchOverrides(params: {
  model?: string;
  thinking?: string;
  tools?: string;
  systemPrompt?: string;
}): string[] {
  return (["model", "thinking", "tools", "systemPrompt"] as const).filter(
    (key) => params[key] !== undefined,
  );
}

export function makeTaskAgentName(task: string, id: string): string {
  const words = task
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => !["please", "the", "a", "an", "to", "for"].includes(word))
    .slice(0, 4) ?? [];
  let base = words.join("-").replace(/^[^a-z]+/, "");
  if (!base) base = "pi-subagent";

  const suffix = id.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 8);
  const prefix = base.slice(0, Math.max(1, 31 - suffix.length)).replace(/-+$/, "") || "pi";
  return `${prefix}-${suffix}`.slice(0, 32);
}

export function agentDisplayName(agent: HerdrAgent): string {
  return agent.name || agent.pane_id;
}

/**
 * Resolve a user-facing model selector to Pi's canonical provider/model ID.
 * A missing selector inherits the parent model. Bare model IDs are accepted
 * only when they identify exactly one available model.
 */
export function resolveModelSelection(params: {
  requested?: string;
  parent?: ModelRef;
  available: ModelRef[];
}): string | undefined {
  const requested = params.requested?.trim();
  if (!requested) {
    return params.parent ? `${params.parent.provider}/${params.parent.id}` : undefined;
  }

  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const id = requested.slice(slash + 1);
    const match = params.available.find(
      (candidate) => candidate.provider === provider && candidate.id === id,
    );
    if (match) return `${match.provider}/${match.id}`;
    throw new Error(
      `Model "${requested}" is not available. Use an authenticated provider/model from Pi's available model list.`,
    );
  }

  const matches = params.available.filter((candidate) => candidate.id === requested);
  if (matches.length === 1) return `${matches[0].provider}/${matches[0].id}`;
  if (matches.length > 1) {
    throw new Error(
      `Model ID "${requested}" is available from multiple providers: ${matches
        .map((candidate) => `${candidate.provider}/${candidate.id}`)
        .join(", ")}. Specify provider/model.`,
    );
  }
  throw new Error(
    `Model "${requested}" is not available. Specify an authenticated provider/model reported by Pi.`,
  );
}
