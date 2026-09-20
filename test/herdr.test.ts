import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HerdrCommandError,
  listAgents,
  runHerdr,
  splitPane,
  startPiAgent,
} from "../pi-extension/herdr-subagents/herdr.ts";

test("startPiAgent accepts matching identities and rejects mismatches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-start-"));
  const executable = join(dir, "herdr");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$FAKE_HERDR_MODE" in
  matching)
    printf '%s\\n' '{"result":{"agent":{"name":"worker","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  matching-null-name)
    printf '%s\\n' '{"result":{"agent":{"name":null,"agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  wrong-pane)
    printf '%s\\n' '{"result":{"agent":{"name":"worker","agent_status":"idle","pane_id":"w1:p9","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  wrong-name)
    printf '%s\\n' '{"result":{"agent":{"name":"other","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
esac
`,
  );
  chmodSync(executable, 0o755);

  const oldPath = process.env.PATH;
  const oldMode = process.env.FAKE_HERDR_MODE;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  const start = () => startPiAgent({ name: "worker", paneId: "w1:p2", options: { timeoutMs: 1_000 } });

  try {
    process.env.FAKE_HERDR_MODE = "matching";
    assert.equal((await start()).pane_id, "w1:p2");

    process.env.FAKE_HERDR_MODE = "matching-null-name";
    assert.equal((await start()).name, null);

    process.env.FAKE_HERDR_MODE = "wrong-pane";
    await assert.rejects(
      start,
      /invalid agent identity: expected pane_id "w1:p2" and name "worker", received pane_id "w1:p9" and name "worker"/,
    );

    process.env.FAKE_HERDR_MODE = "wrong-name";
    await assert.rejects(
      start,
      /invalid agent identity: expected pane_id "w1:p2" and name "worker", received pane_id "w1:p2" and name "other"/,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.FAKE_HERDR_MODE;
    else process.env.FAKE_HERDR_MODE = oldMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Herdr adapter validates responses and bounds command execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const executable = join(dir, "herdr");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$FAKE_HERDR_MODE" in
  valid-list)
    printf '%s\\n' '{"result":{"agents":[{"agent":"pi","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}]}}'
    ;;
  invalid-record)
    printf '%s\\n' '{"result":{"agents":[{"agent_status":"idle"}]}}'
    ;;
  malformed)
    printf '%s\\n' 'not-json'
    ;;
  sleep)
    exec sleep 10
    ;;
  side-effect)
    touch "$FAKE_SIDE_EFFECT"
    printf '%s\\n' '{"result":{}}'
    ;;
  capture-split)
    printf '%s\\n' "$@" > "$FAKE_ARGS_FILE"
    printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p3","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  *)
    printf '%s\\n' '{"result":{}}'
    ;;
esac
`,
  );
  chmodSync(executable, 0o755);

  const oldPath = process.env.PATH;
  const oldMode = process.env.FAKE_HERDR_MODE;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    process.env.FAKE_HERDR_MODE = "valid-list";
    const agents = await listAgents({ timeoutMs: 1_000 });
    assert.equal(agents[0].pane_id, "w1:p2");

    process.env.FAKE_HERDR_MODE = "invalid-record";
    await assert.rejects(() => listAgents({ timeoutMs: 1_000 }), /invalid agent record/);

    process.env.FAKE_HERDR_MODE = "malformed";
    await assert.rejects(
      () => listAgents({ timeoutMs: 1_000 }),
      (error: unknown) => error instanceof HerdrCommandError && /invalid JSON/.test(error.message),
    );

    const argsFile = join(dir, "args");
    process.env.FAKE_HERDR_MODE = "capture-split";
    process.env.FAKE_ARGS_FILE = argsFile;
    await splitPane({
      parentPaneId: "w1:p1",
      direction: "right",
      cwd: "/repo",
      env: { PATH: "/fenced-bin:/usr/bin", HERDR_TEST: "yes" },
    });
    const splitArgs = readFileSync(argsFile, "utf8").trim().split("\n");
    assert.deepEqual(splitArgs.slice(-4), [
      "--env",
      "PATH=/fenced-bin:/usr/bin",
      "--env",
      "HERDR_TEST=yes",
    ]);

    process.env.FAKE_HERDR_MODE = "sleep";
    const startedAt = Date.now();
    await assert.rejects(() => runHerdr(["anything"], { timeoutMs: 25 }), /timed out/);
    assert.ok(Date.now() - startedAt < 2_000);

    const sideEffect = join(dir, "should-not-exist");
    process.env.FAKE_HERDR_MODE = "side-effect";
    process.env.FAKE_SIDE_EFFECT = sideEffect;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => runHerdr(["anything"], { signal: controller.signal }), /aborted/);
    assert.equal(existsSync(sideEffect), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.FAKE_HERDR_MODE;
    else process.env.FAKE_HERDR_MODE = oldMode;
    delete process.env.FAKE_SIDE_EFFECT;
    delete process.env.FAKE_ARGS_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
