import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const shimDir = resolve(
  fileURLToPath(new URL("../pi-extension/herdr-subagents/fenced-bin/", import.meta.url)),
);
const shimPath = join(shimDir, "pi");

async function makeFakeCommands() {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-fence-shim-"));
  const bin = join(dir, "bin");
  const fenceCalled = join(dir, "fence-called");
  await mkdir(bin);
  await writeFile(
    join(bin, "fence"),
    `#!/bin/sh
: > "$FAKE_FENCE_CALLED"
[ "$1" = "--" ] || exit 64
shift
export FENCE_SANDBOX=1
exec "$@"
`,
  );
  await writeFile(
    join(bin, "pi"),
    `#!/bin/sh
printf 'FENCE_SANDBOX=%s\n' "\${FENCE_SANDBOX:-unset}"
printf 'HERDR_AGENT=%s\n' "\${HERDR_AGENT:-unset}"
printf 'ARGS=%s\n' "$*"
`,
  );
  await chmod(join(bin, "fence"), 0o755);
  await chmod(join(bin, "pi"), 0o755);
  return { dir, bin, fenceCalled };
}

async function runShim(
  bin: string,
  fenceCalled: string,
  args: string[],
  alreadyFenced: boolean,
) {
  return execFileAsync(shimPath, args, {
    env: {
      ...process.env,
      PATH: `${shimDir}:${bin}:/usr/bin:/bin`,
      FENCE_SANDBOX: alreadyFenced ? "1" : "",
      HERDR_AGENT: "",
      FAKE_FENCE_CALLED: fenceCalled,
    },
    timeout: 5_000,
  });
}

test("Pi shim enters Fence and preserves arguments and Herdr identity", async () => {
  await access(shimPath, constants.X_OK);
  const fake = await makeFakeCommands();
  try {
    const result = await runShim(fake.bin, fake.fenceCalled, ["--model", "test/model"], false);
    assert.match(result.stdout, /FENCE_SANDBOX=1/);
    assert.match(result.stdout, /HERDR_AGENT=pi/);
    assert.match(result.stdout, /ARGS=--model test\/model/);
    await access(fake.fenceCalled);
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("Pi shim does not nest Fence when already sandboxed", async () => {
  await access(shimPath, constants.X_OK);
  const fake = await makeFakeCommands();
  try {
    const result = await runShim(fake.bin, fake.fenceCalled, ["--thinking", "low"], true);
    assert.match(result.stdout, /FENCE_SANDBOX=1/);
    assert.match(result.stdout, /HERDR_AGENT=pi/);
    assert.match(result.stdout, /ARGS=--thinking low/);
    await assert.rejects(access(fake.fenceCalled));
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});
