import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("bundled Pi shim enters Fence and preserves Herdr agent reporting", async () => {
  await access(shimPath, constants.X_OK);

  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-fence-shim-"));
  const fakeBin = join(dir, "bin");
  const fenceLog = join(dir, "fence.log");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "fence"),
    `#!/bin/sh
printf 'called\\n' >> "$FAKE_FENCE_LOG"
[ "$1" = "--" ] || exit 64
shift
export FENCE_SANDBOX=1
exec "$@"
`,
  );
  await writeFile(
    join(fakeBin, "pi"),
    `#!/bin/sh
printf 'FENCE_SANDBOX=%s\\n' "\${FENCE_SANDBOX:-unset}"
printf 'HERDR_AGENT=%s\\n' "\${HERDR_AGENT:-unset}"
printf 'ARGS=%s\\n' "$*"
`,
  );
  await chmod(join(fakeBin, "fence"), 0o755);
  await chmod(join(fakeBin, "pi"), 0o755);

  const path = `${shimDir}:${fakeBin}:/usr/bin:/bin`;
  try {
    const launched = await execFileAsync(shimPath, ["--model", "test/model"], {
      env: {
        ...process.env,
        PATH: path,
        FENCE_SANDBOX: "",
        HERDR_AGENT: "",
        FAKE_FENCE_LOG: fenceLog,
      },
      timeout: 5_000,
    });
    assert.match(launched.stdout, /FENCE_SANDBOX=1/);
    assert.match(launched.stdout, /HERDR_AGENT=pi/);
    assert.match(launched.stdout, /ARGS=--model test\/model/);
    assert.equal(await readFile(fenceLog, "utf8"), "called\n");

    await writeFile(fenceLog, "");
    const alreadyFenced = await execFileAsync(shimPath, ["--thinking", "low"], {
      env: {
        ...process.env,
        PATH: path,
        FENCE_SANDBOX: "1",
        HERDR_AGENT: "",
        FAKE_FENCE_LOG: fenceLog,
      },
      timeout: 5_000,
    });
    assert.match(alreadyFenced.stdout, /FENCE_SANDBOX=1/);
    assert.match(alreadyFenced.stdout, /HERDR_AGENT=pi/);
    assert.match(alreadyFenced.stdout, /ARGS=--thinking low/);
    assert.equal(await readFile(fenceLog, "utf8"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
