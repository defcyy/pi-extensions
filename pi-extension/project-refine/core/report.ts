import type { PreparedReview } from "./reviewer.ts";
import type { ProjectScope, RefineRun, ResourceManifest, SessionCollection } from "./types.ts";

export function scopeReport(scope: ProjectScope, manifest: ResourceManifest, collection?: SessionCollection): string {
  const lines = ["# Project Refine — local audit", "", `Project: ${scope.id}`, `Target checkout: ${scope.root}`,
    `Kind: ${scope.kind}`, "", "## Worktrees", ...scope.worktrees.map((w) => `- ${w.root}${w.historical ? " (historical attribution)" : ""}${!w.available ? " (unavailable)" : ""}`),
    "", `## Resources (${manifest.resources.length})`, ...manifest.resources.map((r) => `- ${r.path} · ${r.kind} · ${r.editable ? "proposal target" : "advisory only"} · ${r.hash.slice(0, 12)}`)];
  if (collection) {
    lines.push("", `## Evidence: ${collection.matchedSessions} matched sessions; ${collection.episodes.length} eligible episodes`,
      `Catalog files inspected: ${collection.filesScanned}`);
    for (const worktree of scope.worktrees) {
      const counts = collection.perWorktree[worktree.id];
      lines.push(`- ${worktree.root}: ${counts?.sessions ?? 0} sessions, ${counts?.episodes ?? 0} episodes`);
    }
  }
  const warnings = [...scope.warnings, ...manifest.warnings, ...(collection?.warnings ?? [])];
  if (warnings.length) lines.push("", "## Limitations", ...warnings.map((warning) => `- ${warning}`));
  lines.push("", "No project scripts executed. No project files, source sessions or Git index written.");
  return lines.join("\n");
}

export function disclosureReport(prepared: PreparedReview, model: string): string {
  return [`# Disclosure preview — ${model}`, "", "The exact request below goes to your configured provider. It may be remote.",
    "Redaction is best-effort; inspect the payload. No tools, ambient project instructions or executions are available to the reviewer.",
    `Redactions: ${prepared.redactions}; selected: ${prepared.payload.episodes.length}; uncovered omitted: ${prepared.omittedEpisodes}.`,
    "Closing this preview is NOT consent. A separate confirmation follows. Changes in this editor are ignored; cancel and narrow the evidence if needed.", "", prepared.serialized].join("\n");
}

export function runReport(run: RefineRun): string {
  const lines = ["# Project Refine — proposal-only report", "", `Run: ${run.id}`, `Project: ${run.projectId}`,
    `Target checkout: ${run.targetRoot}`, `Model: ${run.model}`, `Status: ${run.status}`, `Started: ${run.startedAt}`,
    `Context: ${run.contextDigest}`, "", `Evidence: ${run.coverage.matchedSessions} matched sessions; ${run.coverage.selectedEpisodes}/${run.coverage.eligibleEpisodes} uncovered episodes selected; ${run.coverage.omittedEpisodes} omitted.`,
    `Structural validation only. Behavior not evaluated. Accepting a suggestion does NOT apply it.`, ""];
  if (run.error) lines.push(`Error: ${run.error}`, "");
  if (!run.proposals.length && run.status === "success") lines.push("No actionable proposals supported by the selected evidence. This is not a claim about omitted history.", "");
  for (const [index, proposal] of run.proposals.entries()) {
    lines.push(`## ${index + 1}. ${proposal.problem}`, `ID: ${proposal.id}`, `Category: ${proposal.category}; scope: ${proposal.scope}; confidence: ${proposal.confidence}`,
      "", proposal.suggestion, "", `Expected effect (not measured): ${proposal.expectedEffect}`, `Exceptions/counterevidence: ${proposal.exceptions}`, "", "Evidence:",
      ...proposal.citations.map((citation) => `- ${citation.entryId}: ${JSON.stringify(citation.quote)}`), "");
    if (!proposal.edits.length) lines.push("Advisory-only; no edit proposed.", "");
    for (const diff of proposal.diffs) lines.push("```diff", diff, "```", "");
  }
  if (run.warnings.length) lines.push("## Limitations", ...run.warnings.map((warning) => `- ${warning}`), "");
  lines.push(`Usage: ${JSON.stringify(run.usage)}`, "", "No project files or source sessions modified. No commits, installations, or execution trials performed.");
  return lines.join("\n");
}
