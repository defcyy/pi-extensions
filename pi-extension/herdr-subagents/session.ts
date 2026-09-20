import { open, stat } from "node:fs/promises";

export interface SessionCursor {
  path?: string;
  offset: number;
}

export async function getSessionCursor(sessionFile: string | undefined): Promise<SessionCursor> {
  if (!sessionFile) return { offset: 0 };
  try {
    const info = await stat(sessionFile);
    return { path: sessionFile, offset: info.size };
  } catch {
    return { path: sessionFile, offset: 0 };
  }
}

export async function findAssistantTextAfter(
  sessionFile: string | undefined,
  cursor: SessionCursor,
): Promise<string | null> {
  if (!sessionFile) return null;

  let handle;
  try {
    handle = await open(sessionFile, "r");
    const info = await handle.stat();
    const offset = cursor.path === sessionFile && cursor.offset <= info.size ? cursor.offset : 0;
    const length = info.size - offset;
    if (length <= 0) return null;

    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim());

    for (let index = lines.length - 1; index >= 0; index--) {
      let entry: any;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;

      const text = Array.isArray(entry.message.content)
        ? entry.message.content
            .filter((part: any) => part?.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text)
            .join("\n")
            .trim()
        : "";
      if (text) return text;

      if (entry.message.stopReason === "error" && typeof entry.message.errorMessage === "string") {
        return `Agent error: ${entry.message.errorMessage}`;
      }
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  return null;
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function truncateUtf8(text: string, maxBytes = 16 * 1024): {
  text: string;
  truncated: boolean;
} {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };

  const suffix = "\n\n[Output truncated. Open the Herdr pane or Pi session for the full result.]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maxBytes) {
    return { text: utf8Prefix(suffix, maxBytes), truncated: true };
  }

  const prefix = utf8Prefix(text, maxBytes - suffixBytes);
  return { text: `${prefix}${suffix}`, truncated: true };
}
