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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// ─── Collision regression tests ───────────────────────────────────────────────
//
// Each test injects an env var whose name matches a bootstrap-internal variable
// (original loop vars: key/val/line; FIFO-path var: fifo; proposed-rename vars:
// _bs_key/_bs_val/_bs_line/_bs_fifo; shell specials: IFS/PATH), followed by at
// least one MORE env var so that loop-variable overwriting would manifest.
// A collision-free implementation passes all these; the original export-based
// loop fails for key/val/line.

function makeCollisionTest(varName, subsequentVar = "OTHER") {
  return async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-test-"));
    const fifoPath = join(tmpDir, "e.fifo");
    let writer;

    try {
      await execFile("mkfifo", ["-m", "600", fifoPath]);
      const payload = `${varName}=intended-value\n${subsequentVar}=sentinel\n`;
      writer = writeFifo(fifoPath, payload);

      const assertion =
        `process.exit(process.env[${JSON.stringify(varName)}] === 'intended-value' ? 0 : 1)`;

      const exitCode = await runBootstrap([
        fifoPath,
        process.execPath,
        "-e",
        assertion,
      ]);

      assert.equal(
        exitCode,
        0,
        `bootstrap should deliver correct value for env var named '${varName}' when not the last entry`,
      );
    } finally {
      writer?.abort();
      await writer?.done;
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

// Original bootstrap loop variable names — bug in export-based implementation.
test("env-bootstrap: env var named 'key' gets correct value when not last entry",
  makeCollisionTest("key"));
test("env-bootstrap: env var named 'val' gets correct value when not last entry",
  makeCollisionTest("val"));
test("env-bootstrap: env var named 'line' gets correct value when not last entry",
  makeCollisionTest("line"));

// FIFO-path variable name in the original bootstrap.
test("env-bootstrap: env var named 'fifo' gets correct value when not last entry",
  makeCollisionTest("fifo"));

// Proposed-rename internal variable names (_bs_* prefix).
// A rename-only fix would expose these names to the same bug.
test("env-bootstrap: env var named '_bs_key' gets correct value when not last entry",
  makeCollisionTest("_bs_key"));
test("env-bootstrap: env var named '_bs_val' gets correct value when not last entry",
  makeCollisionTest("_bs_val"));
test("env-bootstrap: env var named '_bs_line' gets correct value when not last entry",
  makeCollisionTest("_bs_line"));
test("env-bootstrap: env var named '_bs_fifo' gets correct value when not last entry",
  makeCollisionTest("_bs_fifo"));

// Shell specials: must survive with correct values regardless of loop behavior.
test("env-bootstrap: IFS survives correctly when followed by another env var",
  makeCollisionTest("IFS", "PROBE"));

test("env-bootstrap: PATH survives correctly when followed by another env var",
  makeCollisionTest("PATH", "PROBE"));

// ─── No-argv proof ────────────────────────────────────────────────────────────
//
// Proves that the bootstrap never passes KEY=VALUE pairs as argv to env(1).
// A canary fake `env` is installed first on PATH; it writes a sentinel file and
// exits non-zero if it ever receives an argument whose form is KEY=VALUE.
// Bootstrap success (exit 0) with no sentinel file proves env(1) was never
// invoked with assignment argv — the secrets stayed in the shell's built-in
// export, not in any external process's argv.

test("env-bootstrap: never invokes env(1) with KEY=VALUE argv (process-level proof)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-no-argv-"));
  const fifoPath = join(tmpDir, "e.fifo");
  const fakeEnvPath = join(tmpDir, "env");
  const sentinelPath = join(tmpDir, "env-called-with-assignment");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);

    // Canary env: write sentinel and exit 1 if called with any KEY=VALUE arg.
    // If never invoked with assignment argv, the sentinel is never created.
    const fakeEnvScript = [
      "#!/bin/sh",
      `SENTINEL='${sentinelPath}'`,
      "for arg; do",
      "  case \"$arg\" in",
      "    [A-Za-z_]*=*) touch \"$SENTINEL\"; exit 1;;",
      "  esac",
      "done",
      "/usr/bin/env \"$@\"",
    ].join("\n") + "\n";
    await writeFile(fakeEnvPath, fakeEnvScript, { mode: 0o755 });

    writer = writeFifo(fifoPath, "SECRET_KEY=secret-value\n");

    // Run bootstrap with canary env prepended to PATH.
    const exitCode = await new Promise((resolve, reject) => {
      const childEnv = { ...process.env, PATH: `${tmpDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
      const proc = spawnProcess(
        "/bin/sh",
        [
          BOOTSTRAP_PATH,
          fifoPath,
          process.execPath,
          "-e",
          "process.exit(process.env.SECRET_KEY === 'secret-value' ? 0 : 1)",
        ],
        { stdio: ["ignore", "ignore", "inherit"], env: childEnv },
      );
      proc.once("exit", (code) => resolve(code ?? 1));
      proc.once("error", reject);
    });

    // Bootstrap must succeed — the real command ran with the env var set.
    assert.equal(exitCode, 0, "bootstrap should exec command successfully with env var set via export");

    // Sentinel must not exist — env(1) was never called with KEY=VALUE argv.
    let sentinelExists = false;
    try {
      // If sentinel exists, writeFile above will have created it.
      await execFile("test", ["-f", sentinelPath]);
      sentinelExists = true;
    } catch {
      // Expected: sentinel not created means env(1) was never called with assignments.
    }
    assert.equal(
      sentinelExists,
      false,
      "env(1) must never be invoked with KEY=VALUE argv — secrets must stay in shell export",
    );
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── Executable path with '=' ─────────────────────────────────────────────────
//
// Executable paths containing '=' must work. The delimiter-based approach
// correctly identifies the command boundary regardless of the command's form,
// unlike env(1)'s first-non-assignment heuristic which relies on NAME validity.

test("env-bootstrap: executable path containing '=' is handled correctly", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "env-bootstrap-eq-path="));
  const fifoPath = join(tmpDir, "e.fifo");
  // Script that simply exits 0, placed inside a dir whose name contains '='.
  const scriptPath = join(tmpDir, "run=me.sh");
  let writer;

  try {
    await execFile("mkfifo", ["-m", "600", fifoPath]);
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    writer = writeFifo(fifoPath, "A_VAR=value\n");

    const exitCode = await runBootstrap([fifoPath, "/bin/sh", scriptPath]);

    assert.equal(exitCode, 0, "bootstrap should exec a script whose path contains '='");
  } finally {
    writer?.abort();
    await writer?.done;
    await rm(tmpDir, { recursive: true, force: true });
  }
});
