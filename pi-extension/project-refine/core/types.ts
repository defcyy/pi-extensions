export interface Worktree {
  id: string;
  root: string;
  available: boolean;
  historical: boolean;
  branch?: string;
}

export interface ProjectScope {
  id: string;
  root: string;
  kind: "git" | "directory";
  commonDir?: string;
  worktrees: Worktree[];
  warnings: string[];
}

export interface Resource {
  path: string;
  kind: "instruction" | "skill" | "reference" | "prompt" | "setup";
  hash: string;
  content: string;
  editable: boolean;
}

export interface ResourceManifest {
  digest: string;
  resources: Resource[];
  warnings: string[];
}

export interface EvidenceExcerpt {
  entryId: string; // Session-qualified citation, not an unqualified short ID.
  source: "human" | "assistant-claim" | "tool" | "summary";
  text: string;
  truncated: boolean;
}

export interface EvidenceEpisode {
  id: string;
  sessionId: string;
  leafId: string;
  worktreeId: string;
  entryIds: string[];
  activityAt: string;
  kind: "correction" | "recovery" | "success" | "neutral";
  outcome: "observed-success" | "observed-failure" | "unknown";
  excerpts: EvidenceExcerpt[];
  limitations: string[];
}

export interface RefineInterval {
  sessionId: string;
  afterEntryId: string | null;
  beforeEntryId?: string | null;
}

export interface SessionCollection {
  episodes: EvidenceEpisode[];
  filesScanned: number;
  matchedSessions: number;
  warnings: string[];
  perWorktree: Record<string, { sessions: number; episodes: number }>;
}

export interface ProposalCitation {
  entryId: string;
  quote: string;
}

export interface ProposalEdit {
  path: string;
  baseHash: string | null;
  oldText: string;
  newText: string;
}

export interface Proposal {
  id: string;
  fingerprint: string;
  category: "instructions" | "skill-routing" | "skill-procedure" | "setup" | "workflow";
  scope: "project-wide" | "task-specific" | "worktree/version-specific";
  problem: string;
  suggestion: string;
  expectedEffect: string;
  exceptions: string;
  confidence: "low" | "medium" | "high";
  citations: ProposalCitation[];
  edits: ProposalEdit[];
  diffs: string[];
  validation: "structural-only; behavior not evaluated";
}

export interface ReviewDecision {
  proposalId: string;
  fingerprint: string;
  contextDigest: string;
  decision: "accepted" | "rejected" | "deferred";
  at: string;
}

export interface ModelUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: number;
}

export interface RefineRun {
  schemaVersion: 1;
  id: string;
  projectId: string;
  targetRoot: string;
  startedAt: string;
  finishedAt?: string;
  status: "success" | "failed" | "aborted";
  model: string;
  contextDigest: string;
  analyzedEpisodeIds: string[];
  coverage: {
    filesScanned: number;
    matchedSessions: number;
    eligibleEpisodes: number;
    selectedEpisodes: number;
    omittedEpisodes: number;
    perWorktree: SessionCollection["perWorktree"];
  };
  warnings: string[];
  proposals: Proposal[];
  usage: ModelUsage[];
  error?: string;
}

export interface ProjectState {
  schemaVersion: 1;
  historicalRoots: string[];
  covered: Record<string, string[]>; // Context digest -> successfully analyzed episode IDs.
  decisions: ReviewDecision[];
  intervals: RefineInterval[];
}
