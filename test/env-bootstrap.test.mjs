/**
 * Synthetic FIFO bootstrap probe — no cmux dependency.
 *
 * Exercises src/env-bootstrap.sh directly:
 *   1. mkfifo -m 600 <tmpdir>/e.fifo
 *   2. Background writer sends KEY=VALUE\n via tee
 *   3. Spawn: sh env-bootstrap.sh <fifo> node -e '<assertion>'
 *   4. Assert exit 0
 *
 * These tests run in any environment with /bin/sh and node ≥ 20.
 * Writers are always killed in the finally block so a missing/failing
 * bootstrap script never leaves a blocked tee process hanging.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const BOOTSTRAP_PATH = fileURLToPath(new URL("../src/env-bootstrap.sh", import.meta.url));

/**
 * Start a background tee writer: sends payload to fifoPath.
 * Returns { done: Promise<void>, abort(): void }.
 * done resolves when tee exits (for any reason).
 */
function writeFifo(fifoPath, payload) {
  const child = spawnProcess("/usr/bin/tee", [fifoPath], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const done = new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.stdin.end(payload, "utf8");
  return {
    done,
    abort() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

/** Spawn the bootstrap and return its exit code. */
function runBootstrap(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnProcess("/bin/sh", [BOOTSTRAP_PATH, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    proc.once("exit", (code) => resolve(code ?? 1));
    proc.once("error", reject);
  });
}

test("env-bootstrap: reads PROBE_KEY from FIFO and execs node with it set", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-test-"));
  const fifoPath = join(tmpDir, "e.fifo");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);
    writer = writeFifo(fifoPath, "PROBE_KEY=probe-value\n");

    const exitCode = await runBootstrap([
      fifoPath,
      process.execPath,
      "-e",
      "process.exit(process.env.PROBE_KEY === 'probe-value' ? 0 : 1)",
    ]);

    assert.equal(exitCode, 0, "bootstrap should exec node with PROBE_KEY set to probe-value");
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("env-bootstrap: preserves embedded = in values", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-test-"));
  const fifoPath = join(tmpDir, "e.fifo");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);
    writer = writeFifo(fifoPath, "ENCODED=base64=data=here\n");

    const exitCode = await runBootstrap([
      fifoPath,
      process.execPath,
      "-e",
      "process.exit(process.env.ENCODED === 'base64=data=here' ? 0 : 1)",
    ]);

    assert.equal(exitCode, 0, "bootstrap should preserve embedded = characters in values");
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("env-bootstrap: multiple env vars are all set in the exec'd process", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-test-"));
  const fifoPath = join(tmpDir, "e.fifo");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);
    writer = writeFifo(fifoPath, "VAR_A=val-a\nVAR_B=val-b\n");

    const exitCode = await runBootstrap([
      fifoPath,
      process.execPath,
      "-e",
      "process.exit(process.env.VAR_A === 'val-a' && process.env.VAR_B === 'val-b' ? 0 : 1)",
    ]);

    assert.equal(exitCode, 0, "bootstrap should export all KEY=VALUE lines from the FIFO");
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("env-bootstrap: empty FIFO path skips injection and execs the command directly", async () => {
  // Empty string as FIFO path → no FIFO opened, command runs immediately.
  const exitCode = await runBootstrap([
    "",
    process.execPath,
    "-e",
    "process.exit(0)",
  ]);
  assert.equal(exitCode, 0, "bootstrap should exec command without injection when FIFO path is empty");
});

test("env-bootstrap: values with spaces are preserved", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-test-"));
  const fifoPath = join(tmpDir, "e.fifo");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);
    writer = writeFifo(fifoPath, "GREETING=hello world\n");

    const exitCode = await runBootstrap([
      fifoPath,
      process.execPath,
      "-e",
      "process.exit(process.env.GREETING === 'hello world' ? 0 : 1)",
    ]);

    assert.equal(exitCode, 0, "bootstrap should preserve space characters in values");
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});
