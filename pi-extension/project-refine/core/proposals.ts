import { isAbsolute, posix } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { existingSkillName, proposedSkillName } from "./skill-metadata.ts";
import type { EvidenceEpisode, Proposal, ProposalEdit, ResourceManifest } from "./types.ts";
import { digest } from "./util.ts";

const CATEGORIES = ["instructions", "skill-routing", "skill-procedure", "setup", "workflow"] as const;
const SCOPES = ["project-wide", "task-specific", "worktree/version-specific"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const Text = Type.String({ minLength: 1, maxLength: 6000 });
const WireProposal = Type.Object({
  category: Type.Union(CATEGORIES.map((value) => Type.Literal(value))),
  scope: Type.Union(SCOPES.map((value) => Type.Literal(value))),
  problem: Text,
  suggestion: Text,
  expectedEffect: Text,
  exceptions: Text,
  confidence: Type.Union(CONFIDENCES.map((value) => Type.Literal(value))),
  citations: Type.Array(Type.Object({ entryId: Text, quote: Type.String({ minLength: 8, maxLength: 2000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
  edits: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 500 }),
    baseHash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    oldText: Type.String({ maxLength: 12_000 }),
    newText: Type.String({ maxLength: 12_000 }),
  }, { additionalProperties: false }), { maxItems: 6 }),
}, { additionalProperties: false });

export const ReviewResponseSchema = Type.Object({
  proposals: Type.Array(WireProposal, { maxItems: 3 }),
}, { additionalProperties: false });

const VALIDATION = "structural-only; behavior not evaluated" as const;

export function safeRelativePath(path: string): boolean {
  return !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && path === posix.normalize(path)
    && path !== "." && !path.startsWith("../") && !path.split("/").some((part) => part === ".git" || part === "node_modules");
}

function newFileAllowed(path: string, manifest: ResourceManifest): boolean {
  if (path === "AGENTS.md") return true;
  const match = path.match(/^(.*?(?:\.pi|\.agents|\.github)\/skills)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/);
  if (!match) return false;
  // Only add skills to an already inventoried skill directory, not a new hierarchy.
  return manifest.resources.some((resource) => resource.kind === "skill" && resource.path.startsWith(`${match[1]}/`));
}

/** Pure exact matching: every edit uses the same original snapshot; never touches disk. */
export function renderEdits(edits: ProposalEdit[], manifest: ResourceManifest, inventory: ResourceManifest = manifest): string[] {
  const byPath = new Map<string, ProposalEdit[]>();
  for (const edit of edits) {
    if (!safeRelativePath(edit.path)) {
      throw new Error("Proposal target is not a safe project-relative path.");
    }
    const group = byPath.get(edit.path) ?? [];
    group.push(edit);
    byPath.set(edit.path, group);
  }
  const results = new Map<string, string>();
  const diffs: string[] = [];
  for (const [path, group] of byPath) {
    const resource = manifest.resources.find((item) => item.path === path);
    if (resource && !resource.editable) {
      throw new Error("Proposal targets an advisory-only or truncated resource.");
    }
    const original = resource?.content ?? "";
    if (!resource) {
      if (inventory.resources.some((item) => item.path === path)) {
        throw new Error("Proposal targets an undisclosed existing resource.");
      }
      if (group.length !== 1 || group[0].baseHash !== null || group[0].oldText !== "" || !newFileAllowed(path, manifest)) {
        throw new Error("Unsupported new-file proposal; use an advisory recommendation instead.");
      }
    }
    const replacements = group.map((edit) => {
      if (resource && (edit.baseHash !== resource.hash || digest(original) !== resource.hash)) {
        throw new Error("Proposal baseline hash does not match the current disclosed resource.");
      }
      if (edit.oldText === edit.newText || (!resource && !edit.newText.trim())) {
        throw new Error("Proposal contains an empty/no-op edit.");
      }
      if (resource && !edit.oldText) {
        throw new Error("Existing-file proposals require a nonempty exact anchor.");
      }
      const start = original.indexOf(edit.oldText);
      if (start < 0 || (edit.oldText && original.indexOf(edit.oldText, start + 1) !== -1)) {
        throw new Error("Proposal anchor is missing or ambiguous.");
      }
      if (original.includes("\r\n") && /(^|[^\r])\n/.test(edit.newText)) {
        throw new Error("Proposal must preserve CRLF line endings.");
      }
      return { start, end: start + edit.oldText.length, text: edit.newText };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < replacements.length; i++) {
      if (replacements[i].start < replacements[i - 1].end) {
        throw new Error("Proposal edits overlap.");
      }
    }
    let updated = original;
    for (const replacement of [...replacements].reverse()) {
      updated = updated.slice(0, replacement.start) + replacement.text + updated.slice(replacement.end);
    }
    if (resource?.kind === "skill" || path.endsWith("/SKILL.md")) proposedSkillName(updated);
    results.set(path, updated);
    diffs.push(generateUnifiedPatch(path, original, updated));
  }
  const names = new Map<string, string>();
  for (const resource of inventory.resources) {
    if (resource.kind !== "skill") continue;
    const updated = results.get(resource.path);
    const name = updated === undefined
      ? existingSkillName(resource.content, resource.path)
      : proposedSkillName(updated);
    const previous = names.get(name);
    if (previous !== undefined && (updated !== undefined || results.has(previous))) {
      throw new Error("Proposed skill name collides with another skill.");
    }
    names.set(name, resource.path);
  }
  for (const [path, content] of results) {
    if (!path.endsWith("/SKILL.md") || inventory.resources.some((r) => r.path === path)) continue;
    const name = proposedSkillName(content);
    if (names.has(name)) {
      throw new Error("Proposed skill name collides with another skill.");
    }
    names.set(name, path);
  }
  return diffs;
}

export function validateProposals(raw: unknown, projectId: string, manifest: ResourceManifest, episodes: EvidenceEpisode[], inventory: ResourceManifest = manifest): Proposal[] {
  if (!Check(ReviewResponseSchema, raw)) {
    throw new Error("Reviewer returned an invalid proposal schema.");
  }
  const excerpts = new Map<string, string[]>();
  for (const episode of episodes) {
    for (const excerpt of episode.excerpts) {
      excerpts.set(excerpt.entryId, [...(excerpts.get(excerpt.entryId) ?? []), excerpt.text]);
    }
  }
  const proposals = raw.proposals.map((wire) => {
    for (const value of [wire.problem, wire.suggestion, wire.expectedEffect, wire.exceptions]) {
      if (!value.trim()) {
        throw new Error("Proposal fields cannot be blank.");
      }
    }
    for (const citation of wire.citations) {
      if (!citation.quote.trim() || !excerpts.get(citation.entryId)?.some((text) => text.includes(citation.quote))) {
        throw new Error("Proposal contains an unknown citation or an invented quote.");
      }
    }
    const diffs = renderEdits(wire.edits, manifest, inventory);
    const fingerprint = digest({
      projectId,
      category: wire.category,
      scope: wire.scope,
      lesson: wire.suggestion.trim().toLowerCase().replace(/\s+/g, " "),
      operations: [...wire.edits].sort((a, b) => a.path.localeCompare(b.path) || a.oldText.localeCompare(b.oldText)),
      evidence: [...wire.citations].sort((a, b) => a.entryId.localeCompare(b.entryId) || a.quote.localeCompare(b.quote)),
    });
    return {
      ...wire,
      id: digest({ projectId, manifest: manifest.digest, wire }),
      fingerprint,
      diffs,
      validation: VALIDATION,
    } satisfies Proposal;
  });
  // Check combined edits too: independently valid proposals must not overlap or collide when reviewed together.
  renderEdits(proposals.flatMap((proposal) => proposal.edits), manifest, inventory);
  return proposals;
}
