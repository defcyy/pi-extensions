import type { HerdrAgent, HerdrLayout } from "./herdr.ts";

const SETTLED_AGENT_STATES = new Set(["idle", "done"]);
export const HERDR_SUBAGENT_ENV = "PI_HERDR_SUBAGENT";
export const HERDR_HANDOVER_FILE_ENV = "PI_HERDR_HANDOVER_FILE";
export const HERDR_JOB_ID_ENV = "PI_HERDR_JOB_ID";
export const MAX_CONCURRENT_JOBS = 4;

export function canDispatchJob(activeJobs: number, pendingDispatches: number): boolean {
  return activeJobs + pendingDispatches < MAX_CONCURRENT_JOBS;
}

export function isDelegatedWorker(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[HERDR_SUBAGENT_ENV] === "1";
}

export function workerPaneEnvironment(params: {
  fenced: boolean;
  fencedBinDir: string;
  handoverFile: string;
  jobId: string;
  path?: string;
}): Record<string, string> {
  return {
    [HERDR_SUBAGENT_ENV]: "1",
    [HERDR_HANDOVER_FILE_ENV]: params.handoverFile,
    [HERDR_JOB_ID_ENV]: params.jobId,
    ...(params.fenced ? { PATH: `${params.fencedBinDir}:${params.path ?? ""}` } : {}),
  };
}

export function workerToolAllowlist(tools?: string): string | undefined {
  if (tools === undefined) return undefined;
  const names = tools.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.includes("caller_ping")) names.push("caller_ping");
  return names.join(",");
}

export function canCloseOwnedPane(agent: HerdrAgent, paneId: string): boolean {
  const settled = typeof agent.agent === "string" && SETTLED_AGENT_STATES.has(agent.agent_status);
  return agent.pane_id === paneId && !agent.focused && settled;
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
