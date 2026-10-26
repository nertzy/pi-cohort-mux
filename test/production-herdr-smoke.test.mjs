/**
 * Production herdr smoke: the real backend against a real herdr server, in
 * both placements. Opt-in (PI_COHORT_MUX_PRODUCTION_HERDR_SMOKE=1) and
 * skipped without a `herdr` binary.
 *
 * Isolation: the test starts its own herdr server under a temporary
 * XDG_CONFIG_HOME, so it has its own config, sessions, and socket, and never
 * reaches the user's herdr. Every inherited HERDR_* variable is removed from
 * what it spawns. It stops only the server it started.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import {
  createHerdrExecutionBackend,
  herdrRequest,
} from "pi-cohort-mux-herdr/execution-backend";

const execFile = promisify(execFileCallback);
const DEADLINE_MS = 30_000;

async function herdrVersion() {
  try {
    return (await execFile("herdr", ["--version"])).stdout.trim();
  } catch {
    return undefined;
  }
}

const skip =
  process.env.PI_COHORT_MUX_PRODUCTION_HERDR_SMOKE !== "1"
    ? "opt-in: set PI_COHORT_MUX_PRODUCTION_HERDR_SMOKE=1"
    : (await herdrVersion())
      ? false
      : "herdr not on PATH";

const isolatedEnv = (configHome) => {
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  for (const key of Object.keys(env))
    if (key.startsWith("HERDR_")) delete env[key];
  return env;
};

async function until(predicate, what, timeout = DEADLINE_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Start an isolated herdr server and a workspace whose root pane is the caller. */
async function startServer(t) {
  // Short: macOS caps Unix socket paths near 104 bytes.
  const root = await mkdtemp("/tmp/pcmh-");
  const env = isolatedEnv(join(root, "config"));
  const server = spawn("herdr", ["server"], {
    env,
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  t.after(async () => {
    await execFile("herdr", ["server", "stop"], { env }).catch(() => {});
    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(5_000, false, { ref: false }),
    ]);
    if (!stopped) server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  const socketPath = await until(async () => {
    const { stdout } = await execFile("herdr", ["session", "list", "--json"], {
      env,
    }).catch(() => ({ stdout: "" }));
    const running = (stdout ? JSON.parse(stdout).sessions : []).find(
      (session) => session.running,
    );
    return (
      running?.socket_path &&
      (await exists(running.socket_path)) &&
      running.socket_path
    );
  }, `the isolated herdr server (stderr: ${stderr})`);

  const created = await herdrRequest(socketPath, "workspace.create", {
    label: "pi-cohort-mux smoke",
    cwd: root,
    focus: false,
  });
  return { root, socketPath, callerPaneId: created.root_pane.pane_id };
}

function backendFor(herdr, placement) {
  return createHerdrExecutionBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: herdr.socketPath,
      HERDR_PANE_ID: herdr.callerPaneId,
    },
    placement,
    requestDeadlineMs: DEADLINE_MS,
    ackDeadlineMs: DEADLINE_MS,
    handoffDeadlineMs: DEADLINE_MS,
  });
}

/** A child that records what it ran with, then exits (or lingers). */
function childRequest(herdr, sentinel, { linger = false } = {}) {
  const script = `
    require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({
      cwd: process.cwd(),
      probe: process.env.PROBE,
      pane: process.env.HERDR_PANE_ID,
    }));
    setTimeout(() => {}, ${linger ? 600_000 : 300});
  `;
  return {
    command: process.execPath,
    args: ["-e", script],
    cwd: herdr.root,
    environment: { PROBE: "piped", HERDR_PANE_ID: "parent-must-not-win" },
    runId: "smoke-run",
    childId: "smoke-child",
    signal: new AbortController().signal,
    awareness: { title: "smoke" },
  };
}

async function nextEvent(lease, timeout = DEADLINE_MS) {
  const iterator = lease.events[Symbol.asyncIterator]();
  const result = await Promise.race([
    iterator.next(),
    sleep(timeout, undefined, { ref: false }).then(() => {
      throw new Error("no lease event within the deadline");
    }),
  ]);
  return result.value;
}

for (const placement of ["tab", "split"]) {
  test(`production herdr (${placement}): launch → piped env in cwd → exited → gone`, {
    skip,
  }, async (t) => {
    const herdr = await startServer(t);
    const backend = backendFor(herdr, placement);
    const detection = await backend.detect();
    assert.equal(detection.available, true, detection.reason);

    const sentinel = join(herdr.root, `${placement}-ran.json`);
    const lease = await backend.launch(childRequest(herdr, sentinel));
    t.after(() => lease.release());
    assert.equal(lease.handle.backend, "herdr");
    assert.equal(lease.handle.data.placement, placement);

    const ran = await until(
      async () => JSON.parse(await readFile(sentinel, "utf8").catch(() => "0")),
      "the child to run",
    );
    assert.deepEqual(ran, {
      cwd: await realpath(herdr.root),
      probe: "piped",
      pane: lease.handle.surface.id,
    });

    const exited = await nextEvent(lease);
    assert.equal(exited.type, "exited");
    assert.equal(exited.surface.id, lease.handle.surface.id);
    await until(
      async () => (await backend.reattach(lease.handle)).status === "gone",
      "herdr to drop the exited pane",
    );
  });

  test(`production herdr (${placement}): close() ends a running child's pane, requested`, {
    skip,
  }, async (t) => {
    const herdr = await startServer(t);
    const backend = backendFor(herdr, placement);
    const sentinel = join(herdr.root, `${placement}-linger.json`);
    const lease = await backend.launch(
      childRequest(herdr, sentinel, { linger: true }),
    );
    t.after(() => lease.release());
    await until(() => exists(sentinel), "the lingering child to start");

    await backend.close(lease.handle, "explicit_cleanup");
    const closed = await nextEvent(lease);
    assert.deepEqual([closed.type, closed.requested], ["surface_closed", true]);
    assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
    await backend.close(lease.handle, "explicit_cleanup");
  });
}
