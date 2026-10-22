import type { RefineInterval, Worktree } from "./types.ts";
import { isRecord } from "./util.ts";

export const SESSION_LIMITS = Object.freeze({
  roots: 32,
  depth: 4,
  directories: 512,
  directoryEntries: 20_000,
  files: 2_000,
  headerBytes: 16 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  nodes: 10_000,
  totalNodes: 50_000,
  branches: 64,
  pathVisits: 200_000,
  episodes: 200,
  excerpts: 16,
  excerptChars: 2_000,
});

// Raw values stay in memory only. These shallow contracts validate only the
// fields used by history collection, not the SDK's extensible message tree.
export type RawEntry = Record<string, unknown>;
export interface SessionHeader extends RawEntry {
  type: "session";
  id: string;
  cwd: string;
}
export interface HistoryMessage extends Record<string, unknown> {
  role: string;
}
export interface ToolCallBlock extends Record<string, unknown> {
  type: "toolCall";
  id: string;
  name: string;
}
export interface SessionNode {
  id: string;
  parentId: string | null;
  timestamp: string;
  raw: RawEntry;
  citation: string;
  identity: string;
}
export interface SessionSnapshot {
  sessionId: string;
  file: string;
  header: SessionHeader;
  worktree: Worktree;
  nodes: SessionNode[];
  digest: string;
  bytes: number;
  limitations: string[];
}
export interface CollectSessionOptions {
  sessionRoots: string[];
  since: number;
  currentSessionId?: string;
  currentEntryId?: string | null;
  intervals?: RefineInterval[];
  signal?: AbortSignal;
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  return isRecord(value) && typeof value.role === "string";
}

export function historyMessage(value: unknown): HistoryMessage | undefined {
  return isHistoryMessage(value) ? value : undefined;
}

export function isToolCallBlock(value: unknown): value is ToolCallBlock {
  return isRecord(value) && value.type === "toolCall" &&
    typeof value.id === "string" && typeof value.name === "string";
}

export function supportedSessionVersion(value: unknown): boolean {
  return value === undefined || value === null || value === 1 || value === 2 || value === 3;
}
