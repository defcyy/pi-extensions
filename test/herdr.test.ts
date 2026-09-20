import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runHerdr,
  splitPane,
  startPiAgent,
} from "../pi-extension/herdr-subagents/herdr.ts";

interface FakeHerdr {
  dir: string;
  setMode(mode: string): void;
  cleanup(): void;
}

function useFakeHerdr(): FakeHerdr {
  const dir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const executable = join(dir, "herdr");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$FAKE_HERDR_MODE" in
  matching-agent)
    printf '%s\n' '{"result":{"agent":{"name":"worker","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  wrong-pane)
    printf '%s\n' '{"result":{"agent":{"name":"worker","agent_status":"idle","pane_id":"w1:p9","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  wrong-name)
    printf '%s\n' '{"result":{"agent":{"name":"other","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  sleep)
    exec sleep 10
    ;;
  side-effect)
    touch "$FAKE_SIDE_EFFECT"
    printf '%s\n' '{"result":{}}'
    ;;
  capture-split)
    printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
    printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p3","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  *)
    printf '%s\n' '{"result":{}}'
    ;;
esac
`,
  );
  chmodSync(executable, 0o755);

  const previousPath = process.env.PATH;
  const previousMode = process.env.FAKE_HERDR_MODE;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;

  return {
    dir,
    setMode(mode: string) {
      process.env.FAKE_HERDR_MODE = mode;
    },
    cleanup() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMode === undefined) delete process.env.FAKE_HERDR_MODE;
      else process.env.FAKE_HERDR_MODE = previousMode;
      delete process.env.FAKE_SIDE_EFFECT;
      delete process.env.FAKE_ARGS_FILE;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startWorker() {
  return startPiAgent({ name: "worker", paneId: "w1:p2", options: { timeoutMs: 1_000 } });
}

test("startPiAgent returns an agent with the requested identity", async () => {
  const fake = useFakeHerdr();
  try {
    fake.setMode("matching-agent");
    const worker = await startWorker();
    assert.equal(worker.name, "worker");
    assert.equal(worker.pane_id, "w1:p2");
  } finally {
    fake.cleanup();
  }
});

test("startPiAgent rejects a different pane or agent name", async () => {
  const fake = useFakeHerdr();
  try {
    fake.setMode("wrong-pane");
    await assert.rejects(startWorker, /expected pane_id "w1:p2" and name "worker"/);

    fake.setMode("wrong-name");
    await assert.rejects(startWorker, /expected pane_id "w1:p2" and name "worker"/);
  } finally {
    fake.cleanup();
  }
});

test("splitPane forwards the worker environment without shell interpolation", async () => {
  const fake = useFakeHerdr();
  const argsFile = join(fake.dir, "args");
  try {
    fake.setMode("capture-split");
    process.env.FAKE_ARGS_FILE = argsFile;
    const pane = await splitPane({
      parentPaneId: "w1:p1",
      direction: "right",
      cwd: "/repo",
      env: { PI_HERDR_SUBAGENT: "1", PATH: "/fenced-bin:/usr/bin" },
    });

    assert.equal(pane.pane_id, "w1:p3");
    assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n").slice(-4), [
      "--env",
      "PI_HERDR_SUBAGENT=1",
      "--env",
      "PATH=/fenced-bin:/usr/bin",
    ]);
  } finally {
    fake.cleanup();
  }
});

test("runHerdr terminates commands that exceed their timeout", async () => {
  const fake = useFakeHerdr();
  try {
    fake.setMode("sleep");
    const startedAt = Date.now();
    await assert.rejects(() => runHerdr(["anything"], { timeoutMs: 25 }), /timed out/);
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    fake.cleanup();
  }
});

test("runHerdr does not start a command when already aborted", async () => {
  const fake = useFakeHerdr();
  const sideEffect = join(fake.dir, "should-not-exist");
  try {
    fake.setMode("side-effect");
    process.env.FAKE_SIDE_EFFECT = sideEffect;
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => runHerdr(["anything"], { signal: controller.signal }), /aborted/);
    assert.equal(existsSync(sideEffect), false);
  } finally {
    fake.cleanup();
  }
});
