import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findAssistantTextAfter,
  getSessionCursor,
  truncateUtf8,
} from "../pi-extension/herdr-subagents/session.ts";

test("extracts only assistant output written after the byte cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-session-"));
  const file = join(dir, "session.jsonl");
  const oldEntries: any[] = [
    { type: "session", id: "s1" },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
  ];
  writeFileSync(file, `${oldEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const cursor = await getSessionCursor(file);

  const newEntries: any[] = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "new result" },
        ],
      },
    },
  ];
  writeFileSync(
    file,
    `${oldEntries.concat(newEntries).map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  assert.equal(await findAssistantTextAfter(file, cursor), "new result");
  assert.equal(await findAssistantTextAfter(file, await getSessionCursor(file)), null);
  rmSync(dir, { recursive: true, force: true });
});

test("returns assistant provider errors when no text exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-session-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
    })}\n`,
  );

  assert.equal(
    await findAssistantTextAfter(file, { path: file, offset: 0 }),
    "Agent error: overloaded",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("truncateUtf8 preserves Unicode boundaries and the total byte limit", () => {
  const result = truncateUtf8("🙂".repeat(100), 128);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 128);
  assert.doesNotMatch(result.text, /�/);
  assert.match(result.text, /Output truncated/);
});
