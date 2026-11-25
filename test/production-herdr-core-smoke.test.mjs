/**
 * Production herdr-core smoke: the real backend against a real herdr-core,
 * in both placements. Opt-in (PI_COHORT_MUX_PRODUCTION_HERDR_CORE_SMOKE=1)
 * and skipped without a `herdr-core` binary.
 *
 * Isolation: each test starts its own core under a temporary HC_SESSION and
 * temporary XDG directories, so it has its own socket, state, and config, and
 * never reaches the user's core. Every inherited HC_* variable is removed
 * from what it spawns. It stops only the core it started.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createHerdrCoreExecutionBackend,
  herdrCoreRequest,
} from "pi-cohort-mux-herdr-core/execution-backend";

const execFile = promisify(execFileCallback);
const DEADLINE_MS = 30_000;
const DETECT_SCRIPT = fileURLToPath(
  new URL("./fixtures/production-smoke/herdr-core-detect.mjs", import.meta.url),
);

async function coreVersion() {
  try {
    return (await execFile("herdr-core", ["--version"])).stdout.trim();
  } catch {
    return undefined;
  }
}

const skip =
  process.env.PI_COHORT_MUX_PRODUCTION_HERDR_CORE_SMOKE !== "1"
    ? "opt-in: set PI_COHORT_MUX_PRODUCTION_HERDR_CORE_SMOKE=1"
    : (await coreVersion())
      ? false
      : "herdr-core not on PATH";

function isolatedEnv(root, session) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("HC_")) delete env[key];
  return {
    ...env,
    HC_SESSION: session,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "run"),
  };
}

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

/** Start an isolated core and a terminal that stands in for the caller's. */
async function startCore(t, { callerLabels = {} } = {}) {
  // Short: macOS caps Unix socket paths near 104 bytes.
  const root = await mkdtemp("/tmp/pcmc-");
  const session = `pcm${process.pid}`;
  const env = isolatedEnv(root, session);
  const socketPath = join(root, "run", "herdr-core", `${session}.sock`);
  const call = (method, params) =>
    herdrCoreRequest(socketPath, method, params, { timeout: DEADLINE_MS });
  t.after(async () => {
    // Only this core, found through its own socket under the scratch root.
    const listed = await call("terminal.list", { all: true }).catch(() => ({}));
    for (const { address } of listed.terminals ?? []) {
      await call("terminal.kill", { terminal: address }).catch(() => {});
      await call("terminal.rm", { terminal: address }).catch(() => {});
    }
    await execFile("herdr-core", ["server", "stop"], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await execFile("herdr-core", ["server", "start"], { env, cwd: root });
  await until(() => exists(socketPath), "the isolated core's socket");
  const caller = await call("terminal.run", {
    argv: ["/bin/sh", "-c", "sleep 600"],
    cwd: root,
    labels: callerLabels,
    no_parent: true,
  });
  return { root, socketPath, callerId: caller.address, call };
}

function backendFor(core, placement) {
  return createHerdrCoreExecutionBackend({
    env: { HC_TERMINAL_ID: core.callerId, HC_TERMINAL_SOCKET: core.socketPath },
    placement,
    requestDeadlineMs: DEADLINE_MS,
    ackDeadlineMs: DEADLINE_MS,
    handoffDeadlineMs: DEADLINE_MS,
  });
}

/** A child that records what it ran with, then exits 3 (or lingers). */
function childRequest(core, sentinel, { linger = false } = {}) {
  const script = `
    require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({
      cwd: process.cwd(),
      probe: process.env.PROBE,
      terminal: process.env.HC_TERMINAL_ID,
    }));
    setTimeout(() => process.exit(3), ${linger ? 600_000 : 300});
  `;
  return {
    command: process.execPath,
    args: ["-e", script],
    cwd: core.root,
    environment: { PROBE: "piped", HC_TERMINAL_ID: "parent-must-not-win" },
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

const SPACE = { "herdr.space": "smoke-space" };

test("production herdr-core: detect() is available only to a process the terminal started", {
  skip,
}, async (t) => {
  const core = await startCore(t);
  // This test process carries the terminal's HC_* variables but is not its
  // program's descendant: the inherited-environment case.
  const inherited = await backendFor(core, "hidden").detect();
  assert.equal(inherited.available, false);
  assert.match(inherited.reason, /did not start this terminal/);

  const result = join(core.root, "detect.json");
  await core.call("terminal.run", {
    argv: [process.execPath, DETECT_SCRIPT, result],
    cwd: core.root,
    no_parent: true,
  });
  const owned = await until(
    async () => JSON.parse(await readFile(result, "utf8").catch(() => "0")),
    "detect() inside a real terminal",
  );
  assert.equal(owned.available, true, owned.reason);
  assert.ok(owned.capabilities.includes("events"));
});

for (const placement of ["hidden", "tab"]) {
  test(`production herdr-core (${placement}): launch → piped env in cwd → exit code → removed`, {
    skip,
  }, async (t) => {
    const core = await startCore(t, { callerLabels: SPACE });
    const backend = backendFor(core, placement);

    const sentinel = join(core.root, `${placement}-ran.json`);
    const lease = await backend.launch(childRequest(core, sentinel));
    t.after(() => lease.release());
    assert.equal(lease.handle.backend, "herdr-core");
    assert.equal(lease.handle.data.placement, placement);

    const ran = await until(
      async () => JSON.parse(await readFile(sentinel, "utf8").catch(() => "0")),
      "the child to run",
    );
    assert.deepEqual(ran, {
      cwd: await realpath(core.root),
      probe: "piped",
      terminal: lease.handle.surface.id,
    });
    const terminal = await core.call("terminal.get", {
      terminal: lease.handle.surface.id,
    });
    assert.equal(terminal.parent, core.callerId);
    assert.equal(terminal.notify, false);
    assert.equal(terminal.die_with_parent, placement === "hidden");
    assert.equal(
      terminal.labels["herdr.space"],
      placement === "tab" ? "smoke-space" : undefined,
    );

    const exited = await nextEvent(lease);
    assert.deepEqual(
      [exited.type, exited.status, exited.signal],
      ["exited", 3, null],
    );
    // A finished terminal stays until it is closed.
    assert.equal((await backend.reattach(lease.handle)).status, "present");
    await backend.close(lease.handle, "delivered");
    const closed = await nextEvent(lease);
    assert.deepEqual([closed.type, closed.requested], ["surface_closed", true]);
    assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
  });

  test(`production herdr-core (${placement}): close() ends a running child, requested`, {
    skip,
  }, async (t) => {
    const core = await startCore(t, { callerLabels: SPACE });
    const backend = backendFor(core, placement);
    const sentinel = join(core.root, `${placement}-linger.json`);
    const lease = await backend.launch(
      childRequest(core, sentinel, { linger: true }),
    );
    t.after(() => lease.release());
    await until(() => exists(sentinel), "the lingering child to start");

    await backend.close(lease.handle, "explicit_cleanup");
    const ended = await nextEvent(lease);
    assert.deepEqual([ended.type, ended.signal], ["exited", "SIGHUP"]);
    const closed = await nextEvent(lease);
    assert.deepEqual([closed.type, closed.requested], ["surface_closed", true]);
    assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
    await backend.close(lease.handle, "explicit_cleanup");
  });
}

test("production herdr-core: a child whose launch label is removed is reported closed and left alone", {
  skip,
}, async (t) => {
  const core = await startCore(t);
  const backend = backendFor(core, "hidden");
  const sentinel = join(core.root, "relabeled.json");
  const lease = await backend.launch(
    childRequest(core, sentinel, { linger: true }),
  );
  t.after(() => lease.release());
  await until(() => exists(sentinel), "the lingering child to start");
  const terminal = lease.handle.surface.id;

  await core.call("terminal.label", {
    terminal,
    labels: { "pi-cohort-mux.launch": "" },
  });
  const closed = await nextEvent(lease);
  assert.deepEqual([closed.type, closed.requested], ["surface_closed", false]);
  assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });

  // No longer this launch's terminal, so close() must not end it.
  await backend.close(lease.handle, "explicit_cleanup");
  assert.equal((await core.call("terminal.get", { terminal })).state, "live");
});

test("production herdr-core: a hidden child ends with the caller's terminal, a tab child outlives it", {
  skip,
}, async (t) => {
  const core = await startCore(t, { callerLabels: SPACE });
  const hidden = await backendFor(core, "hidden").launch(
    childRequest(core, join(core.root, "hidden.json"), { linger: true }),
  );
  const tab = await backendFor(core, "tab").launch(
    childRequest(core, join(core.root, "tab.json"), { linger: true }),
  );
  t.after(() => Promise.all([hidden.release(), tab.release()]));
  await until(() => exists(join(core.root, "tab.json")), "the children");

  await core.call("terminal.kill", { terminal: core.callerId });
  assert.equal((await nextEvent(hidden)).type, "exited");
  const survivor = await core.call("terminal.get", {
    terminal: tab.handle.surface.id,
  });
  assert.equal(survivor.state, "live");
});
