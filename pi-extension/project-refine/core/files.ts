import { constants as bufferConstants } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { throwIfAborted } from "./util.ts";

export const MAX_RESOURCE_BYTES = 128 * 1024;

type SnapshotFailure = "not-regular" | "byte-limit" | "changed" | "utf8" | "binary";

export class ResourceSnapshotError extends Error {
  readonly reason: SnapshotFailure;
  /** Bytes consumed by a stable but unsupported text snapshot. */
  readonly bytes: number;

  constructor(reason: SnapshotFailure, message: string, bytes = 0) {
    super(message);
    this.name = "ResourceSnapshotError";
    this.reason = reason;
    this.bytes = bytes;
  }
}

function sameSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function pathSnapshot(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    // The file was already opened: disappearing or becoming inaccessible now
    // means the path can no longer establish the opened snapshot's identity.
    throw new ResourceSnapshotError("changed", "Resource path changed during read");
  }
}

/** Read a bounded, stable, regular UTF-8 file, without following its final
 * symlink or blocking on a FIFO. Scope, ancestor paths and ownership remain
 * the caller's policy; this helper establishes only the file snapshot.
 */
export async function readResourceSnapshot(
  path: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ content: string; bytes: number }> {
  const { signal, maxBytes = MAX_RESOURCE_BYTES } = options;
  throwIfAborted(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
    throw new RangeError("Resource byte limit must be a nonnegative bounded integer.");
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    throwIfAborted(signal);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ResourceSnapshotError("not-regular", "Skipped non-regular resource");
    }
    if (before.size > BigInt(maxBytes)) {
      throw new ResourceSnapshotError("byte-limit", `Resource exceeds file byte limit (${maxBytes})`);
    }
    const initialPath = await pathSnapshot(path);
    if (!sameSnapshot(before, initialPath)) {
      throw new ResourceSnapshotError("changed", "Resource changed during read");
    }

    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    throwIfAborted(signal);
    if (length > maxBytes) {
      throw new ResourceSnapshotError("byte-limit", "Resource grew beyond byte limit");
    }

    const after = await file.stat({ bigint: true });
    const currentPath = await pathSnapshot(path);
    throwIfAborted(signal);
    if (!sameSnapshot(before, after) || !sameSnapshot(before, currentPath) || BigInt(length) !== after.size) {
      throw new ResourceSnapshotError("changed", "Resource changed during read");
    }

    let content: string;
    try {
      // Preserve the BOM, line endings and exact baseline bytes in the string.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new ResourceSnapshotError("utf8", "Unsupported non-UTF-8 resource", length);
    }
    if (content.includes("\0")) {
      throw new ResourceSnapshotError("binary", "Unsupported binary resource", length);
    }
    return { content, bytes: length };
  } finally {
    await file.close();
  }
}
