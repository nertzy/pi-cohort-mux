/**
 * cmux execution backend — fake CLI tests
 *
 * Grounded in the cmux-parity spike (doc/spikes/cmux-parity.md) and the
 * execution-backend conformance contract (test/fixtures/execution-backend/).
 * Uses injected fake exec/spawn functions rather than real cmux CLI so the
 * suite runs without a live cmux session or a PATH-provided binary.
 *
 * Key orderings proved by the spike and verified here:
 *   1. Events subscription started (and acked) BEFORE workspace create.
 *   2. UUID correlation: handle.id matches the surface UUID from the snapshot.
 *   3. Handle is JSON-safe, has no live functions, no forbidden core keys,
 *      no secret or core identity fields.
 *   4. close() treats only "not_found" as idempotent absence; other CLI errors
 *      propagate (strict handle-keyed close).
 *   5. reattach() maps not_found → "gone", other errors → "unknown".
 *   6. release() stops the subscription but does NOT close the surface.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import { createCmuxBackend } from "../packages/pi-cohort-mux-cmux/src/cmux-backend.js";
import {
  commandTokens,
  createMethod,
  createParams,
  launchOf,
} from "./fixtures/cmux-launch.mjs";

const isPaneCreate = (c) =>
  c.type === "exec" && createMethod(c.args) === "pane.create";
const isSurfaceCreate = (c) =>
  c.type === "exec" && createMethod(c.args) === "surface.create";
const isReorder = (c) => c.type === "exec" && c.args[0] === "reorder-surface";
const isWorkspaceListing = (c) =>
  c.type === "exec" && c.args[2] === "list-panes";

// ─── Fake child process for the events subscription ───────────────────────────

class FakeEventsChild extends EventEmitter {
  constructor(ackFrame, extraFrames = []) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this._killed = false;
    this._exited = false;
    // Emit ack (and any extra frames) on next iteration so listeners can be
    // attached first in the current synchronous setup phase.
    setImmediate(() => {
      if (this._killed) return;
      this.stdout.push(`${JSON.stringify(ackFrame)}\n`);
      for (const frame of extraFrames) {
        this.stdout.push(`${JSON.stringify(frame)}\n`);
      }
    });
  }

  kill(signal) {
    if (this._killed) return;
    this._killed = true;
    setImmediate(() => {
      if (!this._exited) {
        this._exited = true;
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("exit", 0, signal ?? "SIGTERM");
        this.emit("close", 0, signal ?? "SIGTERM");
      }
    });
  }
}

// ─── Shared test constants ────────────────────────────────────────────────────

const FAKE_ACK = { type: "ack", subscription_id: "test-sub-1", version: 1 };
const FAKE_WS_ID = "AABBCCDD-0000-0000-0000-111122223333";
const FAKE_SF_ID = "DDCCBBAA-0000-0000-0000-444455556666";
const FAKE_WS_REF = "workspace:42";
const FAKE_SF_REF = "surface:100";
const FAKE_PN_ID = "EEDDCCBB-0000-0000-0000-777788889999";
const FAKE_PN_REF = "pane:50";
const FAKE_PARENT_SF_ID = "11223344-0000-0000-0000-555566667777";
const FAKE_PARENT_PN_REF = "pane:7";

/** The result `cmux rpc pane.create|surface.create` prints. */
function fakeCreateResult() {
  return {
    window_id: "FFEEDDCC-0000-0000-0000-000011112222",
    window_ref: "window:1",
    workspace_id: FAKE_WS_ID,
    workspace_ref: FAKE_WS_REF,
    pane_id: FAKE_PN_ID,
    pane_ref: FAKE_PN_REF,
    surface_id: FAKE_SF_ID,
    surface_ref: FAKE_SF_REF,
    type: "terminal",
  };
}

function fakeSnapshot() {
  return {
    workspace_id: FAKE_WS_ID,
    workspace_ref: FAKE_WS_REF,
    pane_id: FAKE_PN_ID,
    pane_ref: FAKE_PN_REF,
    surfaces: [
      {
        id: FAKE_SF_ID,
        ref: FAKE_SF_REF,
        title: "pi-cohort-test",
        type: "terminal",
      },
    ],
  };
}

/** One pane as `cmux list-panes` reports it; its first tab is the selected one unless told. */
function fakePane(
  ref,
  surfaceIds,
  { selected = surfaceIds[0], focused = false } = {},
) {
  return {
    ref,
    focused,
    surface_ids: [...surfaceIds],
    selected_surface_id: selected,
  };
}

const fakeSurfaceRef = (id) =>
  id === FAKE_SF_ID ? FAKE_SF_REF : `surface:${id}`;

/**
 * A pane as one `cmux list-panes` answer reports it. `before` is the pane a
 * create just added a tab to, as it was: for a moment cmux still answers so.
 */
function listedPane(pane, before) {
  const stale = before?.ref === pane.ref;
  const surface_ids = pane.surface_ids.filter(
    (id) => !stale || id !== FAKE_SF_ID,
  );
  const selected = stale ? before.selected : pane.selected_surface_id;
  return {
    ...pane,
    surface_ids,
    surface_refs: surface_ids.map(fakeSurfaceRef),
    selected_surface_id: selected,
    selected_surface_ref: selected && fakeSurfaceRef(selected),
  };
}

/** cmux's Dock: listed with every workspace's panes, and always focused. */
const fakeDockPane = () => ({
  ...fakePane("pane:2", [], { selected: null, focused: true }),
  dock_scope: "global",
});

// launch() requires the parent workspace identity from the environment, and
// tab placement the parent surface's. Tests that name no placement cover what
// both placements share, and run it through split, whatever the developer's
// own setting; tab placement's tests name theirs.
const PARENT_ENVIRONMENT = {
  CMUX_WORKSPACE_ID: FAKE_WS_ID,
  CMUX_SURFACE_ID: FAKE_PARENT_SF_ID,
  PI_COHORT_MUX_CMUX_PLACEMENT: "split",
};

/** Set (or, for undefined, unset) process.env values; returns the undo. */
function setEnvironment(values) {
  const saved = Object.keys(values).map((key) => [key, process.env[key]]);
  const apply = (entries) => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(values));
  return () => apply(saved);
}

let restoreParentEnvironment;
before(() => {
  restoreParentEnvironment = setEnvironment(PARENT_ENVIRONMENT);
});
after(() => restoreParentEnvironment());

// ─── Fake IO builder ──────────────────────────────────────────────────────────

/**
 * Returns injected execFile and spawn functions that simulate the cmux CLI,
 * plus a `calls` log for ordering assertions.
 *
 * Options:
 *   eventsFrames     – extra frames emitted by events subprocess after ack
 *   snapshotNotFound – make list-pane-surfaces throw "not_found"
 *   snapshotError    – make list-pane-surfaces throw a custom error
 *   closeNotFound    – make workspace close throw "not_found"
 *   closeError       – make workspace close throw a custom error
 *   createError      – make pane.create/surface.create throw this error
 *   fifoUnread       – create succeeds but the child never opens the env FIFO
 *                      (e.g. its `cd` failed), so the hand-off never completes
 *   snapshotWithoutSurface – snapshots omit the created surface
 *   panes            – the parent workspace's panes, as `cmux list-panes`
 *                      reports them; creates and reorders update them as cmux
 *                      does. Default: the parent's tab alone in a focused pane
 *   selectsNewTab    – false when cmux leaves an unfocused pane's selected
 *                      tab alone, as it does a focused pane's
 *   staleListings    – how many list-panes answers after a create still
 *                      show the pane as it was before
 *   paneLookupError  – make list-panes throw this error
 *   reorderError     – make reorder-surface throw this error
 *   capabilities     – capabilities array returned by `cmux capabilities`
 *   version          – string returned by `cmux --version`
 */
function makeFakeIo({
  eventsFrames = [],
  snapshotNotFound = false,
  snapshotError = null,
  closeNotFound = false,
  closeError = null,
  createError = null,
  fifoUnread = false,
  snapshotWithoutSurface = false,
  panes = [
    fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID], { focused: true }),
  ],
  selectsNewTab = true,
  staleListings = 0,
  paneLookupError = null,
  reorderError = null,
  capabilities = ["events.v1"],
  version = "cmux 0.64.22",
} = {}) {
  const calls = [];
  const fifoPayloads = [];
  const launchFiles = [];
  // Mutable across calls so a test can simulate the helper pane collapsing
  // between launches; a successful create makes the pane exist again.
  const behavior = {
    paneGone: false,
    closeNotFound,
    closeError,
    createError,
    fifoUnread,
    snapshotWithoutSurface,
    snapshotNotFound,
    snapshotError,
    onSnapshot: null,
    surfaceBusy: false,
    onCreate: null,
    createOutput: null,
    panes,
    staleListings: 0,
    beforeCreate: null,
    paneLookupError,
    reorderError,
  };

  async function execFile(_cli, args, opts) {
    calls.push({ type: "exec", args: [...args], timeout: opts?.timeout });

    if (args[0] === "--version") {
      return { stdout: `${version}\n`, stderr: "" };
    }
    if (args[0] === "capabilities") {
      return { stdout: `${JSON.stringify({ capabilities })}\n`, stderr: "" };
    }
    if (args[2] === "list-panes") {
      if (behavior.paneLookupError) throw behavior.paneLookupError;
      const before = behavior.staleListings-- > 0 && behavior.beforeCreate;
      const listing = {
        panes: behavior.panes.map((pane) => listedPane(pane, before)),
      };
      return { stdout: `${JSON.stringify(listing)}\n`, stderr: "" };
    }
    if (args[0] === "reorder-surface") {
      if (behavior.reorderError) throw behavior.reorderError;
      const surface = args[args.indexOf("--surface") + 1];
      const index = Number(args[args.indexOf("--index") + 1]);
      const pane = behavior.panes.find((p) => p.surface_ids.includes(surface));
      // cmux 0.65 moves the tab to that index, selects it, and gives its pane
      // the workspace's focus, whatever --focus says.
      pane.surface_ids.splice(pane.surface_ids.indexOf(surface), 1);
      pane.surface_ids.splice(index, 0, surface);
      pane.selected_surface_id = surface;
      for (const other of behavior.panes) {
        if (!other.dock_scope) other.focused = other === pane;
      }
      return { stdout: "OK\n", stderr: "" };
    }
    if (createMethod(args)) {
      if (createMethod(args) === "surface.create" && behavior.paneGone) {
        const err = Object.assign(new Error("surface.create failed"), {
          stderr: "Error: not_found: Pane not found",
        });
        throw err;
      }
      await behavior.onCreate?.(args);
      if (behavior.createError) throw behavior.createError;
      // The launch file in the launch directory names the FIFO. Record what
      // the launcher would source, then drain the FIFO so the background tee
      // writer can complete.
      if (createParams(args).initial_command) {
        const launch = launchOf(args);
        launch.mode = (await stat(launch.launchFile)).mode & 0o777;
        launchFiles.push(launch);
        if (!behavior.fifoUnread)
          fifoPayloads.push(await readFile(launch.fifo, "utf8"));
      }
      behavior.paneGone = false;
      // cmux 0.65 adds a tab after the pane's selected one, and selects it
      // unless that pane has the workspace's focus, even with focus false.
      const pane = behavior.panes.find(
        (p) => p.ref === createParams(args).pane_id,
      );
      if (pane) {
        behavior.beforeCreate = {
          ref: pane.ref,
          selected: pane.selected_surface_id,
        };
        const shown = pane.surface_ids.indexOf(pane.selected_surface_id);
        pane.surface_ids.splice(shown + 1, 0, FAKE_SF_ID);
        if (!pane.focused && selectsNewTab)
          pane.selected_surface_id = FAKE_SF_ID;
        behavior.staleListings = staleListings;
      }
      const stdout =
        behavior.createOutput ?? `${JSON.stringify(fakeCreateResult())}\n`;
      return { stdout, stderr: "" };
    }
    if (
      args[0] === "--id-format" &&
      args[1] === "both" &&
      args[2] === "list-pane-surfaces"
    ) {
      const paneScoped = args.includes("--pane");
      await behavior.onSnapshot?.();
      if (behavior.snapshotNotFound || (paneScoped && behavior.paneGone)) {
        const err = Object.assign(new Error("list-pane-surfaces not found"), {
          stderr: "Error: not_found: Pane or workspace not found",
        });
        throw err;
      }
      if (behavior.snapshotError) throw behavior.snapshotError;
      const snapshot = fakeSnapshot();
      if (behavior.snapshotWithoutSurface) snapshot.surfaces = [];
      return { stdout: `${JSON.stringify(snapshot)}\n`, stderr: "" };
    }
    if (args[0] === "close-surface") {
      // cmux 0.65 refuses to close a surface whose process is still running.
      if (behavior.surfaceBusy && !args.includes("--force")) {
        throw Object.assign(new Error("close-surface failed"), {
          stderr:
            "Error: confirmation_required: Surface has a running process; retry with force=true",
        });
      }
      if (behavior.closeNotFound) {
        const err = Object.assign(new Error("close-surface failed"), {
          stderr: "Error: not_found: Surface not found",
        });
        throw err;
      }
      if (behavior.closeError) throw behavior.closeError;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unhandled fake cmux exec: ${args.join(" ")}`);
  }

  const children = [];
  function spawn(_cli, args, _opts) {
    calls.push({ type: "spawn", args: [...args] });
    const child = new FakeEventsChild(FAKE_ACK, eventsFrames);
    children.push(child);
    return child;
  }

  return {
    execFile,
    spawn,
    calls,
    behavior,
    fifoPayloads,
    launchFiles,
    children,
  };
}

const pathExists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** An execFile timeout as Node reports it: the child was killed. */
const createTimeout = () =>
  Object.assign(new Error("Command failed: cmux rpc pane.create (timed out)"), {
    killed: true,
    signal: "SIGTERM",
    code: null,
  });

function withSocketPath(fn) {
  return async (t) => {
    const restore = setEnvironment({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" });
    try {
      await fn(t);
    } finally {
      restore();
    }
  };
}

function makeRequest(overrides = {}) {
  return {
    command: "pi",
    args: ["--session", "session.jsonl"],
    cwd: "/test/cwd",
    runId: "run-1",
    childId: "child-1",
    environment: { SAFE: "1" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ─── detect ───────────────────────────────────────────────────────────────────

test("detect: parses version and capabilities from CLI output", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const result = await backend.detect();

  assert.equal(result.version, "cmux 0.64.22");
  assert.deepEqual(result.capabilities, ["events.v1"]);
  assert.equal(typeof result.available, "boolean");
});

test("detect: available when CMUX_WORKSPACE_ID, CMUX_SOCKET_PATH set and events.v1 present", async () => {
  const { execFile, spawn } = makeFakeIo({
    capabilities: ["events.v1", "surface.health"],
  });
  const backend = createCmuxBackend({ execFile, spawn });

  const saved = {
    CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
  };
  process.env.CMUX_WORKSPACE_ID = "ws-123";
  process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
  try {
    const result = await backend.detect();
    assert.equal(result.available, true);
    assert.ok(result.capabilities.includes("events.v1"));
  } finally {
    if (saved.CMUX_WORKSPACE_ID === undefined)
      delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH === undefined)
      delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

test(
  "detect: confirms CMUX_WORKSPACE_ID names a live workspace",
  withSocketPath(async () => {
    const { execFile, spawn, calls } = makeFakeIo();
    const backend = createCmuxBackend({ execFile, spawn });

    assert.equal((await backend.detect()).available, true);
    const probe = calls.find((c) => c.args.includes("list-pane-surfaces"));
    assert.ok(probe, "one read-only workspace probe");
    assert.equal(probe.args[probe.args.indexOf("--workspace") + 1], FAKE_WS_ID);
    assert.equal(probe.args.includes("--pane"), false);
  }),
);

test(
  "detect: unavailable with a reason when CMUX_WORKSPACE_ID names no workspace",
  withSocketPath(async () => {
    const { execFile, spawn } = makeFakeIo({ snapshotNotFound: true });
    const backend = createCmuxBackend({ execFile, spawn });

    const result = await backend.detect();
    assert.equal(result.available, false);
    assert.match(result.reason, /CMUX_WORKSPACE_ID .*not found/);
  }),
);

test("detect: unavailable when CMUX env markers absent", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  // Ensure env vars absent
  const saved = {
    CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
  };
  delete process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_SOCKET_PATH;
  try {
    const result = await backend.detect();
    assert.equal(result.available, false);
  } finally {
    if (saved.CMUX_WORKSPACE_ID !== undefined)
      process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH !== undefined)
      process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

test("detect: unavailable and does not throw when CLI fails", async () => {
  const brokenExec = async () => {
    throw new Error("spawn cmux ENOENT");
  };
  const backend = createCmuxBackend({ execFile: brokenExec, spawn: () => {} });

  const result = await backend.detect();
  assert.equal(result.available, false);
  assert.equal(result.version, "");
  assert.deepEqual(result.capabilities, []);
});

test("detect: unavailable when events.v1 capability absent from CLI response", async () => {
  const { execFile, spawn } = makeFakeIo({ capabilities: ["surface.health"] });
  const backend = createCmuxBackend({ execFile, spawn });

  const saved = {
    CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
  };
  process.env.CMUX_WORKSPACE_ID = "ws-123";
  process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
  try {
    const result = await backend.detect();
    assert.equal(result.available, false);
  } finally {
    if (saved.CMUX_WORKSPACE_ID === undefined)
      delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH === undefined)
      delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

// ─── launch ordering ──────────────────────────────────────────────────────────

test("launch: subscribes to events BEFORE creating the surface (spike ordering)", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const spawnIdx = calls.findIndex(
    (c) => c.type === "spawn" && c.args[0] === "events",
  );
  const createIdx = calls.findIndex(isPaneCreate);
  assert.ok(spawnIdx >= 0, "events subscription was started");
  assert.ok(createIdx >= 0, "surface was created");
  assert.ok(
    spawnIdx < createIdx,
    "events subscription started before surface create",
  );

  await lease.release();
});

test("launch: events subscription includes --no-heartbeat flag", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const eventsCall = calls.find(
    (c) => c.type === "spawn" && c.args[0] === "events",
  );
  assert.ok(eventsCall, "events spawn call present");
  assert.ok(
    eventsCall.args.includes("--no-heartbeat"),
    "includes --no-heartbeat",
  );

  await lease.release();
});

test("launch: state.trace records observe before start (subscription precedes workspace create)", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  assert.deepEqual(backend.state.trace.slice(0, 2), ["observe", "start"]);

  await lease.release();
});

test("launch: state tracks launch count and stores last request", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest();
  const lease = await backend.launch(request);

  assert.equal(backend.state.launches.length, 1);
  assert.equal(backend.state.lastRequest, request);

  await lease.release();
});

// ─── launch: workspace create args ───────────────────────────────────────────

test("launch: child command starts in the request cwd", async () => {
  const { execFile, spawn, launchFiles } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({ cwd: "/exact/cwd/test" });
  const lease = await backend.launch(request);

  const [launch] = launchFiles;
  assert.match(launch.launcher, /\/surface-launch\.sh$/);
  assert.ok(
    launch.cli === "cmux" || launch.cli.startsWith("/"),
    "the surface can close itself with the same CLI",
  );
  assert.equal(launch.extra.length, 1, "then only the exit directory");
  assert.match(launch.extra[0], /pi-cohort-mux-cmux-exit-/);
  assert.equal(launch.fifo, join(launch.launchDir, "environment.fifo"));
  assert.equal(
    launch.cwd,
    "/exact/cwd/test",
    "the launcher enters the request cwd",
  );
  assert.match(launch.bootstrap, /\/env-bootstrap\.sh$/);
  assert.deepEqual(launch.child, ["pi", "--session", "session.jsonl"]);
  assert.equal(launch.mode, 0o600, "the launch file is owner-only");
  assert.equal(
    await pathExists(launch.launchDir),
    false,
    "launch directory removed after the hand-off",
  );

  await lease.release();
});

test("launch: the initial command names only fixed paths; the request travels in the launch file", async () => {
  // cmux keeps a surface's initial command in its surface records, so the
  // child's cwd and args stay in the owner-only launch file, which /bin/sh
  // sources, however long or odd they are.
  const { execFile, spawn, calls, launchFiles } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const cwd = `/deep/${"d".repeat(600)}/back\\slash`;
  const args = ["a\\\\b", "C:\\", "it's", "line\nbreak", "x".repeat(3000)];
  const lease = await backend.launch(makeRequest({ cwd, args }));

  const command = createParams(calls.find(isPaneCreate).args).initial_command;
  assert.equal(command.includes("deep"), false, "the cwd is not in it");
  assert.equal(command.includes("xxx"), false, "the args are not in it");
  assert.equal(launchFiles[0].cwd, cwd);
  assert.deepEqual(launchFiles[0].child, ["pi", ...args]);
  await lease.release();
});

test("launch: cmux runs the launcher as the surface's own process, with nothing typed", async () => {
  // The launcher closes its own surface when the child exits, as herdr
  // removes a pane, so nothing follows it on the command line.
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const createCall = calls.find(isPaneCreate);
  const params = createParams(createCall.args);
  assert.equal(params.type, "terminal");
  assert.equal(params.initial_input, undefined, "nothing is typed");
  const [launcher, ...rest] = commandTokens(createCall.args);
  assert.match(launcher, /\/surface-launch\.sh$/, "the launcher runs itself");
  assert.equal(
    rest.length,
    3,
    "launch directory, CLI, and exit directory only",
  );
  assert.equal(params.initial_command.includes(";"), false, "no `; exit`");
  await lease.release();
});

test("launch: the launcher gets the CLI's absolute path, not the surface's PATH", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "pi-cohort-mux-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "cmux"), "#!/bin/sh\n");
  await chmod(join(bin, "cmux"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `/nonexistent-dir:${bin}:${savedPath}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  const { execFile, spawn, launchFiles } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const lease = await backend.launch(makeRequest());

  assert.equal(
    launchFiles[0].cli,
    join(bin, "cmux"),
    "a late surface can reach cmux even if its PATH cannot",
  );
  await lease.release();
});

test("launch: an empty environment still goes through the launcher's FIFO", async () => {
  const { execFile, spawn, calls, fifoPayloads } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest({ environment: {} }));

  const createCall = calls.find(isPaneCreate);
  assert.match(commandTokens(createCall.args)[0], /\/surface-launch\.sh$/);
  assert.deepEqual(
    fifoPayloads,
    [""],
    "an abandoned launch is refused even without environment",
  );
  await lease.release();
});

test("launch: creates the surface with focus false (no focus stealing)", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  assert.equal(createParams(calls.find(isPaneCreate).args).focus, false);

  await lease.release();
});

test("launch: first child creates the right-side helper pane, later children become tabs in it", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const first = await backend.launch(makeRequest());
  const second = await backend.launch(makeRequest());

  const newPaneCalls = calls.filter(isPaneCreate);
  const newSurfaceCalls = calls.filter(isSurfaceCreate);
  assert.equal(newPaneCalls.length, 1, "exactly one helper pane created");
  assert.equal(
    newSurfaceCalls.length,
    1,
    "second child added as a surface tab",
  );
  const paneParams = createParams(newPaneCalls[0].args);
  const surfaceParams = createParams(newSurfaceCalls[0].args);
  assert.equal(paneParams.direction, "right", "helper pane opens to the right");
  assert.equal(
    surfaceParams.pane_id,
    FAKE_PN_REF,
    "tab lands in the helper pane",
  );
  assert.equal(
    paneParams.workspace_id,
    FAKE_WS_ID,
    "children live in the parent workspace",
  );
  assert.equal(surfaceParams.workspace_id, FAKE_WS_ID);

  await first.release();
  await second.release();
});

test("launch: concurrent first launches share one helper pane", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const leases = await Promise.all([
    backend.launch(makeRequest()),
    backend.launch(makeRequest()),
    backend.launch(makeRequest()),
  ]);

  const creates = calls.filter(
    (c) => c.type === "exec" && createMethod(c.args),
  );
  assert.deepEqual(
    creates.map((c) => createMethod(c.args)),
    ["pane.create", "surface.create", "surface.create"],
    "one pane, then tabs in it",
  );
  for (const create of creates.slice(1))
    assert.equal(createParams(create.args).pane_id, FAKE_PN_REF);
  await Promise.all(leases.map((lease) => lease.release()));
});

test("launch: a failed helper-pane create does not block the next launch", async () => {
  const { execFile, spawn, calls, behavior } = makeFakeIo({
    createError: new Error("pane.create failed"),
  });
  const backend = createCmuxBackend({ execFile, spawn });

  // The second launch queues behind the first; the lock must not wedge.
  const results = await Promise.allSettled([
    backend.launch(makeRequest()),
    backend.launch(makeRequest()),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
  );
  behavior.createError = null;
  const lease = await backend.launch(makeRequest());

  const newPanes = calls.filter(isPaneCreate);
  assert.equal(
    newPanes.length,
    3,
    "each launch retried pane creation after a failed create",
  );
  await lease.release();
});

test("launch: collapsed helper pane is recreated instead of failing", async () => {
  const { execFile, spawn, calls, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const first = await backend.launch(makeRequest());
  behavior.paneGone = true; // user closed the helper pane between launches
  const second = await backend.launch(makeRequest());

  const newPaneCalls = calls.filter(isPaneCreate);
  assert.equal(newPaneCalls.length, 2, "a fresh helper pane was created");

  await first.release();
  await second.release();
});

// ─── placement ────────────────────────────────────────────────────────────────

test("placement: defaults to tab, as herdr's does", (t) => {
  t.after(setEnvironment({ PI_COHORT_MUX_CMUX_PLACEMENT: undefined }));
  const { execFile, spawn } = makeFakeIo();

  assert.equal(createCmuxBackend({ execFile, spawn }).placement, "tab");
});

test("placement: PI_COHORT_MUX_CMUX_PLACEMENT selects it, and the option overrides that", (t) => {
  t.after(setEnvironment({ PI_COHORT_MUX_CMUX_PLACEMENT: "split" }));
  const { execFile, spawn } = makeFakeIo();

  assert.equal(createCmuxBackend({ execFile, spawn }).placement, "split");
  assert.equal(
    createCmuxBackend({ execFile, spawn, placement: "tab" }).placement,
    "tab",
  );
});

test(
  "placement: an unknown one is unavailable rather than guessed",
  withSocketPath(async () => {
    const { execFile, spawn, calls } = makeFakeIo();
    const backend = createCmuxBackend({
      execFile,
      spawn,
      placement: "sideways",
    });

    const detection = await backend.detect();
    assert.equal(detection.available, false);
    assert.match(detection.reason, /placement "sideways".*"tab" or "split"/);
    await assert.rejects(backend.launch(makeRequest()), /placement "sideways"/);
    assert.deepEqual(calls, [], "cmux was never asked for anything");
  }),
);

test("launch (tab placement): each child is a background tab in the parent's own pane, with no split", async () => {
  const { execFile, spawn, calls, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const first = await backend.launch(makeRequest());
  // The user drags the parent's tab into another pane between launches.
  behavior.panes = [fakePane("pane:8", [FAKE_PARENT_SF_ID], { focused: true })];
  const second = await backend.launch(makeRequest());

  assert.deepEqual(calls.filter(isPaneCreate), [], "no pane is split off");
  assert.deepEqual(
    calls.filter(isSurfaceCreate).map((c) => {
      const { initial_command: _, ...params } = createParams(c.args);
      return params;
    }),
    [FAKE_PARENT_PN_REF, "pane:8"].map((pane_id) => ({
      workspace_id: FAKE_WS_ID,
      type: "terminal",
      focus: false,
      pane_id,
    })),
    "each tab lands, unfocused, in the pane the parent is in at that moment",
  );
  assert.deepEqual(
    calls.filter(isReorder),
    [],
    "cmux left a focused pane's selected tab alone, so nothing is reselected",
  );
  assert.equal(backend.state.helperPane, null, "there is no helper pane");

  await first.release();
  await second.release();
});

test("launch (tab placement): a parent pane without the workspace's focus keeps its selected tab, and focus stays where it was", async () => {
  const layout = () => [
    fakePane(FAKE_PARENT_PN_REF, ["TAB-BEFORE", FAKE_PARENT_SF_ID], {
      selected: FAKE_PARENT_SF_ID,
    }),
    fakeDockPane(),
    fakePane("pane:9", ["OTHER-A", "OTHER-B"], {
      selected: "OTHER-B",
      focused: true,
    }),
  ];
  const { execFile, spawn, calls, behavior } = makeFakeIo({ panes: layout() });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  const [parentPane, ...others] = layout();
  parentPane.surface_ids.push(FAKE_SF_ID);
  assert.deepEqual(
    behavior.panes,
    [parentPane, ...others],
    "only the child's tab is new: every pane kept its focus, selected tab, and tab order",
  );
  // cmux has no call that only selects a tab; reordering a tab to the index
  // it already has selects it and focuses its pane.
  assert.deepEqual(
    calls.filter(isReorder).map((c) => c.args),
    [
      [FAKE_PARENT_SF_ID, "1"],
      ["OTHER-B", "1"],
    ].map(([surface, index]) => [
      "reorder-surface",
      "--workspace",
      FAKE_WS_ID,
      "--surface",
      surface,
      "--index",
      index,
      "--focus",
      "false",
    ]),
    "the parent's tab is reselected in place, then the focused pane's tab to hand focus back",
  );

  await lease.release();
});

test("launch (tab placement): the pane keeps the tab it showed, even when that is not the parent's", async () => {
  const { execFile, spawn, behavior } = makeFakeIo({
    panes: [
      fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID, "SHOWN"], {
        selected: "SHOWN",
      }),
      fakePane("pane:9", ["OTHER"], { focused: true }),
    ],
  });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    behavior.panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      ["SHOWN", false],
      ["OTHER", true],
    ],
    "the parent's background tab is not brought forward",
  );

  await lease.release();
});

// For a moment after a create, real cmux can answer with the listing from
// before it.
const UNFOCUSED_PARENT_PANE = () => [
  fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID]),
  fakePane("pane:9", ["OTHER"], { focused: true }),
];

test("launch (tab placement): a listing from before the create is not taken for the pane's selection", async () => {
  const { execFile, spawn, behavior } = makeFakeIo({
    panes: UNFOCUSED_PARENT_PANE(),
    staleListings: 2,
  });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    behavior.panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      [FAKE_PARENT_SF_ID, false],
      ["OTHER", true],
    ],
    "the parent's tab is reselected once cmux lists the child",
  );

  await lease.release();
});

test("launch (tab placement): a pane whose selected tab cmux left alone is not reordered", async () => {
  const { execFile, spawn, calls } = makeFakeIo({
    panes: UNFOCUSED_PARENT_PANE(),
    selectsNewTab: false,
  });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(calls.filter(isReorder), []);

  await lease.release();
});

test("launch (tab placement): a child cmux never lists is not waited for past the settle deadline", async () => {
  const { execFile, spawn, calls } = makeFakeIo({
    panes: UNFOCUSED_PARENT_PANE(),
    staleListings: Number.POSITIVE_INFINITY,
  });
  const backend = createCmuxBackend({
    execFile,
    spawn,
    placement: "tab",
    settleDeadlineMs: 60,
  });

  const lease = await withinDeadline(backend.launch(makeRequest()));

  assert.deepEqual(calls.filter(isReorder), []);
  // Queued launches wait behind this one, so a listing that stalls must not
  // outlast the wait either.
  const waited = calls
    .slice(calls.findIndex(isSurfaceCreate))
    .filter(isWorkspaceListing);
  assert.ok(waited.length > 1, "the pane was listed until the deadline");
  assert.deepEqual(
    waited.filter((c) => !(c.timeout <= 60)),
    [],
    "no listing may run longer than what is left of the settle deadline",
  );

  await lease.release();
});

test("launch (tab placement): a tab that closes in the focused pane during the create does not move that pane's tab", async () => {
  const focusedPane = fakePane("pane:9", ["OTHER-A", "OTHER-B", "OTHER-C"], {
    selected: "OTHER-B",
    focused: true,
  });
  const { execFile, spawn, behavior } = makeFakeIo({
    panes: [fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID]), focusedPane],
  });
  behavior.onCreate = () => {
    focusedPane.surface_ids = ["OTHER-B", "OTHER-C"];
  };
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(behavior.panes, [
    fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID, FAKE_SF_ID]),
    fakePane("pane:9", ["OTHER-B", "OTHER-C"], { focused: true }),
  ]);

  await lease.release();
});

test("launch (tab placement): focus the user moved during the create stays where they moved it", async () => {
  const panes = [
    fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID]),
    fakePane("pane:9", ["OTHER"], { focused: true }),
    fakePane("pane:10", ["THIRD"]),
  ];
  const { execFile, spawn, behavior } = makeFakeIo({ panes });
  behavior.onCreate = () => {
    panes[1].focused = false;
    panes[2].focused = true;
  };
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    behavior.panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      [FAKE_PARENT_SF_ID, false],
      ["OTHER", false],
      ["THIRD", true],
    ],
  );

  await lease.release();
});

test("launch (tab placement): focus that left the parent's pane just before the create does not leave the child covering it", async () => {
  const panes = [
    fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID], { focused: true }),
    fakePane("pane:9", ["OTHER"]),
  ];
  const { execFile, spawn, behavior } = makeFakeIo({ panes });
  behavior.onCreate = () => {
    panes[0].focused = false;
    panes[1].focused = true;
  };
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      [FAKE_PARENT_SF_ID, false],
      ["OTHER", true],
    ],
  );

  await lease.release();
});

test("launch (tab placement): a tab the user selected right after the create is left selected", async () => {
  const panes = [
    fakePane(FAKE_PARENT_PN_REF, [FAKE_PARENT_SF_ID, "CHOSEN"]),
    fakePane("pane:9", ["OTHER"], { focused: true }),
  ];
  const io = makeFakeIo({ panes });
  const execFile = async (cli, args, opts) => {
    const result = await io.execFile(cli, args, opts);
    if (createMethod(args)) panes[0].selected_surface_id = "CHOSEN";
    return result;
  };
  const backend = createCmuxBackend({
    execFile,
    spawn: io.spawn,
    placement: "tab",
  });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(io.calls.filter(isReorder), []);

  await lease.release();
});

test("launch (tab placement): focus the user moved to the parent's pane right after the create is not handed elsewhere", async () => {
  const panes = UNFOCUSED_PARENT_PANE();
  const io = makeFakeIo({ panes });
  const execFile = async (cli, args, opts) => {
    const result = await io.execFile(cli, args, opts);
    if (createMethod(args)) {
      panes[0].focused = true;
      panes[1].focused = false;
    }
    return result;
  };
  const backend = createCmuxBackend({
    execFile,
    spawn: io.spawn,
    placement: "tab",
  });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      [FAKE_PARENT_SF_ID, true],
      ["OTHER", false],
    ],
  );

  await lease.release();
});

test("launch (tab placement): a shown tab that closed meanwhile is not asked for", async () => {
  const parentPane = fakePane(
    FAKE_PARENT_PN_REF,
    [FAKE_PARENT_SF_ID, "SHOWN"],
    {
      selected: "SHOWN",
    },
  );
  const { execFile, spawn, calls, behavior } = makeFakeIo({
    panes: [parentPane, fakePane("pane:9", ["OTHER"], { focused: true })],
  });
  behavior.onCreate = () => {
    parentPane.surface_ids = [FAKE_PARENT_SF_ID];
    parentPane.selected_surface_id = FAKE_PARENT_SF_ID;
  };
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(calls.filter(isReorder), []);

  await lease.release();
});

test("launch (tab placement): a tab cmux will not reselect does not fail the launch", async () => {
  const { execFile, spawn, calls } = makeFakeIo({
    panes: UNFOCUSED_PARENT_PANE(),
    reorderError: new Error("reorder-surface failed"),
  });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  const lease = await backend.launch(makeRequest());

  assert.equal(lease.handle.surface.id, FAKE_SF_ID);
  assert.deepEqual(closeSurfaceCalls(calls), [], "the child keeps running");

  await lease.release();
});

test("launch (tab placement): a reselect cmux applied but never answered still hands the focus back", async () => {
  const panes = UNFOCUSED_PARENT_PANE();
  const io = makeFakeIo({ panes });
  let reorders = 0;
  const execFile = async (cli, args, opts) => {
    const result = await io.execFile(cli, args, opts);
    if (args[0] === "reorder-surface" && reorders++ === 0) {
      throw Object.assign(new Error("timed out"), { killed: true });
    }
    return result;
  };
  const backend = createCmuxBackend({
    execFile,
    spawn: io.spawn,
    placement: "tab",
  });

  const lease = await backend.launch(makeRequest());

  assert.deepEqual(
    panes.map((pane) => [pane.selected_surface_id, pane.focused]),
    [
      [FAKE_PARENT_SF_ID, false],
      ["OTHER", true],
    ],
  );

  await lease.release();
});

test("launch (tab placement): aborting while the pane settles rolls back, though the child has its environment", async () => {
  const io = makeFakeIo({ panes: UNFOCUSED_PARENT_PANE(), staleListings: 2 });
  const controller = new AbortController();
  let created = false;
  const execFile = async (cli, args, opts) => {
    if (created && args[2] === "list-panes") {
      controller.abort(new Error("caller cancelled"));
    }
    const result = await io.execFile(cli, args, opts);
    if (createMethod(args)) created = true;
    return result;
  };
  const backend = createCmuxBackend({
    execFile,
    spawn: io.spawn,
    placement: "tab",
  });

  await assert.rejects(
    withinDeadline(backend.launch(makeRequest({ signal: controller.signal }))),
    /caller cancelled/,
  );

  assert.equal(io.fifoPayloads.length, 1, "the child read its environment");
  assertRolledBack(io.calls, io.children);
});

test("launch (tab placement): a parent surface in none of the workspace's panes fails the launch, creating nothing", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({
    panes: [fakePane("pane:8", ["SOMEONE-ELSE"], { focused: true })],
  });
  const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

  await assert.rejects(
    backend.launch(makeRequest()),
    new RegExp(`CMUX_SURFACE_ID ${FAKE_PARENT_SF_ID} .*not found`),
  );

  assert.deepEqual(
    calls.filter((c) => c.type === "exec" && createMethod(c.args)),
    [],
    "nothing was created",
  );
  assert.ok(children[0]._exited, "events subscription process stopped");
});

// Nothing was asked of cmux yet, so there is no orphan surface to wait for.
const PANE_LOOKUP_FAILURES = {
  "times out": {
    error: () =>
      Object.assign(new Error("Command failed: cmux list-panes (timed out)"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
      }),
    rejection: /list-panes \(timed out\)/,
    cooling: /did not answer a pane lookup within its deadline/,
  },
  "is aborted": {
    error: () =>
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    rejection: { name: "AbortError" },
    cooling: undefined,
  },
};
for (const [outcome, failure] of Object.entries(PANE_LOOKUP_FAILURES)) {
  test(
    `launch (tab placement): a parent pane lookup that ${outcome} fails the launch without waiting for an orphan`,
    withSocketPath(async () => {
      const io = makeFakeIo({ paneLookupError: failure.error() });
      const backend = createCmuxBackend({
        execFile: io.execFile,
        spawn: io.spawn,
        placement: "tab",
        orphanGraceMs: 60_000,
      });

      await withinDeadline(
        assert.rejects(backend.launch(makeRequest()), failure.rejection),
      );

      assert.deepEqual(
        io.calls.filter((c) => c.type === "exec" && createMethod(c.args)),
        [],
        "nothing was created",
      );
      io.behavior.paneLookupError = null;
      const detection = await backend.detect();
      if (failure.cooling) assert.match(detection.reason, failure.cooling);
      else assert.equal(detection.available, true, "cmux is not unhealthy");
    }),
  );
}

test(
  "tab placement: without CMUX_SURFACE_ID detect is unavailable with a reason and launch refuses",
  withSocketPath(async (t) => {
    t.after(setEnvironment({ CMUX_SURFACE_ID: undefined }));
    const { execFile, spawn, calls } = makeFakeIo();
    const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

    const detection = await backend.detect();
    assert.equal(detection.available, false);
    assert.match(detection.reason, /tab placement requires CMUX_SURFACE_ID/);
    await assert.rejects(
      backend.launch(makeRequest()),
      /tab placement requires CMUX_SURFACE_ID/,
    );
    assert.deepEqual(
      calls.filter((c) => c.type === "spawn"),
      [],
      "no subscription was started",
    );
  }),
);

test(
  "tab placement: detect is unavailable, with a reason, when the parent surface is in none of the workspace's panes",
  withSocketPath(async () => {
    // A stale CMUX_SURFACE_ID, or the parent's tab moved to another workspace.
    const { execFile, spawn } = makeFakeIo({
      panes: [fakePane("pane:8", ["SOMEONE-ELSE"], { focused: true })],
    });
    const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

    const detection = await backend.detect();

    assert.equal(detection.available, false);
    assert.match(
      detection.reason,
      new RegExp(`CMUX_SURFACE_ID ${FAKE_PARENT_SF_ID} .*not found`),
    );
  }),
);

test(
  "tab placement: detect is available inside a cmux surface",
  withSocketPath(async () => {
    const { execFile, spawn } = makeFakeIo();
    const backend = createCmuxBackend({ execFile, spawn, placement: "tab" });

    assert.equal((await backend.detect()).available, true);
  }),
);

test("declares CMUX_* as surface-owned so attempts keep the pane's identity", () => {
  const { execFile, spawn } = makeFakeIo();
  assert.deepEqual(
    createCmuxBackend({ execFile, spawn }).surfaceEnvironmentPrefixes,
    ["CMUX_"],
  );
});

test("launch: inherited CMUX_* identity is scrubbed from the child environment", async () => {
  const { execFile, spawn, fifoPayloads } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({
    environment: {
      CMUX_WORKSPACE_ID: "parent-ws",
      CMUX_SURFACE_ID: "parent-surface",
      SAFE_VALUE: "kept",
    },
  });
  const lease = await backend.launch(request);

  assert.equal(
    fifoPayloads.length,
    1,
    "environment delivered through the FIFO",
  );
  assert.ok(
    !fifoPayloads[0].includes("CMUX_"),
    `CMUX_* identity scrubbed, got: ${JSON.stringify(fifoPayloads[0])}`,
  );
  assert.ok(
    fifoPayloads[0].includes("SAFE_VALUE=kept"),
    "non-cmux variables pass through",
  );

  await lease.release();
});

test("launch: the launch file shell-escapes command and args", async () => {
  const { execFile, spawn, launchFiles } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({
    command: "/usr/bin/pi",
    args: ["--session", "path with spaces/session.jsonl", "it's $HOME"],
  });
  const lease = await backend.launch(request);

  assert.deepEqual(launchFiles[0].child, [
    "/usr/bin/pi",
    "--session",
    "path with spaces/session.jsonl",
    "it's $HOME",
  ]);

  await lease.release();
});

test("launch: rejects secretPipePath rather than silently dropping it", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({ secretPipePath: "/private/super-secret-fifo" });

  await assert.rejects(
    backend.launch(request),
    /cannot honor ExecutionSurfaceRequest\.secretPipePath/,
  );
  assert.equal(calls.length, 0);
});

test("launch: rejects empty-string env key loudly before any IO", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  // An empty key produces "=value\n" which the bootstrap cannot handle;
  // must be caught at the serialization boundary, before subscribe or FIFO.
  const request = makeRequest({ environment: { "": "silent-drop" } });

  await assert.rejects(
    backend.launch(request),
    /cannot encode an environment variable name/,
  );
  assert.equal(
    calls.length,
    0,
    "no execFile/spawn calls before key validation throws",
  );
});

test("launch: rejects env key with embedded whitespace loudly before any IO", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  // OS env allows whitespace in names; shell identifiers do not.
  // Must be rejected loudly at the boundary, not silently dropped.
  const request = makeRequest({ environment: { "MY KEY": "some-value" } });

  await assert.rejects(
    backend.launch(request),
    /cannot encode an environment variable name/,
  );
  assert.equal(
    calls.length,
    0,
    "no execFile/spawn calls before key validation throws",
  );
});

test("launch: rejects env key starting with a digit loudly before any IO", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  // "1INVALID" is not a valid POSIX shell identifier (must start with letter or _).
  // Must be rejected loudly at the serialization boundary, before subscribe or FIFO.
  const request = makeRequest({ environment: { "1INVALID": "some-value" } });

  await assert.rejects(
    backend.launch(request),
    /cannot encode an environment variable name/,
  );
  assert.equal(
    calls.length,
    0,
    "no execFile/spawn calls before key validation throws",
  );
});

// ─── launch: handle structure ─────────────────────────────────────────────────

test("launch: handle has SPI surface/display/data shape with UUID from snapshot", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const handle = lease.handle;
  assert.equal(handle.backend, "cmux");
  assert.equal(handle.protocolVersion, 1);
  assert.deepEqual(
    handle.surface,
    { kind: "surface", id: FAKE_SF_ID },
    "surface has UUID from snapshot",
  );
  assert.equal(
    typeof handle.display.label,
    "string",
    "display.label is a string",
  );
  assert.match(handle.display.hint, /\S/, "display.hint is non-empty");

  await lease.release();
});

test("launch: handle data contains the nine key set from the spike", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest({ cwd: "/test/cwd" }));

  const { data } = lease.handle;
  assert.deepEqual(Object.keys(data).sort(), [
    "cwd",
    "paneId",
    "paneRef",
    "surfaceId",
    "surfaceRef",
    "title",
    "type",
    "workspaceId",
    "workspaceRef",
  ]);
  assert.equal(data.workspaceId, FAKE_WS_ID);
  assert.equal(data.workspaceRef, FAKE_WS_REF);
  assert.equal(data.surfaceId, FAKE_SF_ID);
  assert.equal(data.cwd, "/test/cwd");

  await lease.release();
});

test("launch: handle is JSON-serializable (no live functions)", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  assert.doesNotThrow(() => JSON.parse(JSON.stringify(lease.handle)));
  assertNoFunction(lease.handle);

  await lease.release();
});

test("launch: handle has no forbidden core identity keys", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const forbidden = ["runId", "childId", "attempt", "task", "result", "output"];
  assertNoForbiddenKey(lease.handle, forbidden);

  await lease.release();
});

test("launch: handle contains no secret values", async () => {
  const secret = "super-secret-value-12345";
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({ environment: { TEST_ONLY_TOKEN: secret } });
  const lease = await backend.launch(request);

  // The actual secret value should never appear in handle, display, or
  // reattach fields.
  const serialized = JSON.stringify(lease.handle);
  assert.ok(!serialized.includes(secret), "secret value absent from handle");

  await lease.release();
});

test("launch: lease.request is the original request", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest();
  const lease = await backend.launch(request);

  assert.equal(lease.request, request);

  await lease.release();
});

// ─── launch: event queue behavior ────────────────────────────────────────────

test("launch: push and events.next deliver a fact through the lease queue", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  lease.push({
    type: "unknown",
    fact: "test-event",
    source: "mux",
    surface: lease.handle.surface,
  });
  const event = (await lease.events.next()).value;
  assert.equal(event.type, "unknown");
  assert.equal(event.fact, "test-event");

  await lease.release();
});

test("launch: no_observed_activity coalesces with same-type queue tail", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  lease.push({ type: "no_observed_activity", sinceMs: 1 });
  lease.push({ type: "no_observed_activity", sinceMs: 2 });
  lease.push({ type: "no_observed_activity", sinceMs: 3 });

  assert.deepEqual(lease.queuedEvents, [
    { type: "no_observed_activity", sinceMs: 1 },
    { type: "no_observed_activity", sinceMs: 3 },
  ]);

  await lease.release();
});

test("launch: advisory cannot overwrite an entity fact at queue tail", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  lease.push({ type: "no_observed_activity", sinceMs: 0 });
  lease.push({ type: "surface_closed", requested: false });
  lease.push({ type: "no_observed_activity", sinceMs: 1 });

  assert.deepEqual(lease.queuedEvents, [
    { type: "no_observed_activity", sinceMs: 0 },
    { type: "surface_closed", requested: false },
    { type: "no_observed_activity", sinceMs: 1 },
  ]);

  await lease.release();
});

test("launch: overflow suspends queue and reconcile clears suspension with lost fact", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  lease.push({ type: "no_observed_activity", sinceMs: 1 });
  lease.push({ type: "no_observed_activity", sinceMs: 3 });
  lease.push({ type: "surface_closed", requested: false });
  lease.push({ type: "exited", status: 23, signal: null }); // overflows

  assert.equal(lease.suspended, true);
  assert.deepEqual(lease.queuedEvents, [
    { type: "no_observed_activity", sinceMs: 1 },
    { type: "no_observed_activity", sinceMs: 3 },
    { type: "surface_closed", requested: false },
    { type: "unknown", fact: "event_stream", reason: "overflow" },
  ]);

  // Drain the queue
  await lease.events.next();
  await lease.events.next();
  await lease.events.next();
  await lease.events.next();

  // reconcile recovers the lost fact and clears suspension
  const reconciled = await lease.reconcile();
  assert.equal(reconciled.length, 2, "the lost fact, then fresh cmux evidence");
  assert.equal(reconciled[0].type, "exited");
  assert.equal(reconciled[0].status, 23);
  assert.equal(
    reconciled[0].snapshot,
    undefined,
    "an observed event is not relabeled as snapshot evidence",
  );
  assert.equal(reconciled[0].source, "mux");
  assert.deepEqual(reconciled[0].surface, lease.handle.surface);
  assert.equal(typeof reconciled[0].timestamp, "number");
  assert.equal(reconciled[1].fact, "snapshot");
  assert.equal(reconciled[1].snapshot, true);
  assert.equal(lease.suspended, false);
  assert.deepEqual(
    await lease.reconcile().then((facts) => facts.map((f) => f.type)),
    ["unknown"],
    "the lost fact is delivered once",
  );

  // New pushes work after reconcile
  lease.push({ type: "surface_closed", requested: true });
  assert.deepEqual((await lease.events.next()).value, {
    type: "surface_closed",
    requested: true,
  });

  await lease.release();
});

test("launch: release stops subscription without closing the surface", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  await lease.release();

  assert.equal(backend.state.releaseCount, 1);
  assert.equal(backend.state.closed.size, 0, "close not called during release");
});

test("launch: iterator return also stops subscription without closing surface", async () => {
  const { execFile, spawn, children } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const pending = lease.events.next();
  await lease.events.return();
  assert.deepEqual(await pending, { done: true });

  // No explicit release(): breaking out of `for await` must stop transport.
  assert.equal(backend.state.releaseCount, 1);
  assert.ok(children[0]._exited, "events subscription process stopped");
  assert.equal(backend.state.closed.size, 0);
  await lease.release(); // idempotent after iterator return
  assert.equal(backend.state.releaseCount, 1);
});

test("launch: breaking out of for-await releases the transport", async () => {
  const { execFile, spawn, children } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  lease.push({ type: "no_observed_activity", sinceMs: 1 });
  for await (const _event of lease.events) break;

  assert.equal(backend.state.releaseCount, 1);
  assert.ok(children[0]._exited, "events subscription process stopped");
});

// ─── launch: post-create failures roll back the created surface ──────────────

function closeSurfaceCalls(calls) {
  return calls.filter(
    (c) => c.type === "exec" && c.args[0] === "close-surface",
  );
}

function assertRolledBack(calls, children) {
  const closes = closeSurfaceCalls(calls);
  assert.equal(closes.length, 1, "the created surface is closed");
  assert.deepEqual(closes[0].args, [
    "close-surface",
    "--workspace",
    FAKE_WS_REF,
    "--surface",
    FAKE_SF_REF,
    "--force",
  ]);
  assert.ok(
    children.every((child) => child._exited),
    "events subscription stopped",
  );
}

test("launch: env hand-off that never completes times out and rolls back", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({ fifoUnread: true });
  const backend = createCmuxBackend({
    execFile,
    spawn,
    handoffDeadlineMs: 100,
  });

  await assert.rejects(
    withinDeadline(backend.launch(makeRequest())),
    /environment hand-off/,
  );
  assertRolledBack(calls, children);
});

test("launch: aborting during the env hand-off rolls back", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({ fifoUnread: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const controller = new AbortController();

  const launch = backend.launch(makeRequest({ signal: controller.signal }));
  setTimeout(() => controller.abort(new Error("caller cancelled")), 50);
  await assert.rejects(withinDeadline(launch), /caller cancelled/);
  assertRolledBack(calls, children);
});

test("launch: post-create snapshot failure rolls back the surface and subscription", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({
    snapshotError: new Error("snapshot timed out"),
  });
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(backend.launch(makeRequest()), /snapshot timed out/);
  assertRolledBack(calls, children);
});

test("launch: created surface missing from the snapshot is closed, not just unobserved", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({
    snapshotWithoutSurface: true,
  });
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(
    backend.launch(makeRequest()),
    /surface:100 closed right after the child started/,
  );
  assertRolledBack(calls, children);
});

test("launch: a child that exits before the snapshot is reported as gone, not as a cmux error", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({
    snapshotNotFound: true,
  });
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(backend.launch(makeRequest()), (error) => {
    assert.match(
      error.message,
      /surface:100 closed right after the child started \(the child exited, or something else closed it\)/,
    );
    assert.match(error.cause.stderr, /not_found/);
    return true;
  });
  assertRolledBack(calls, children);
});

test("launch: rollback that finds the surface already gone keeps the original error", async () => {
  const { execFile, spawn, calls, children } = makeFakeIo({
    snapshotError: new Error("snapshot timed out"),
    closeNotFound: true,
  });
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(
    backend.launch(makeRequest()),
    (error) => error.message === "snapshot timed out",
  );
  assertRolledBack(calls, children);
});

test("launch: rollback close failure is reported alongside the original error", async () => {
  const { execFile, spawn } = makeFakeIo({
    snapshotError: new Error("snapshot timed out"),
    closeError: new Error("socket gone"),
  });
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(backend.launch(makeRequest()), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((e) => e.message),
      ["snapshot timed out", "socket gone"],
    );
    assert.match(error.message, /surface:100/);
    return true;
  });
});

// ─── launch: ambiguous create failures ───────────────────────────────────────

/** Have the fake surface report its own id `delayMs` after the create call. */
function lateSurface(io, surfaceId, delayMs = 30) {
  const seen = {};
  io.behavior.onCreate = (args) => {
    const { launchDir, fifo } = launchOf(args);
    seen.launchDir = launchDir;
    setTimeout(async () => {
      seen.fifoPresent = await pathExists(fifo);
      await writeFile(join(launchDir, "surface-id"), `${surfaceId}\n`).catch(
        () => {},
      );
    }, delayMs);
  };
  return seen;
}

test("launch: a create that times out after cmux made the surface closes that surface by its own id", async () => {
  const io = makeFakeIo({ createError: createTimeout() });
  const seen = lateSurface(io, "ORPHAN-UUID");
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 1_000,
  });

  await assert.rejects(backend.launch(makeRequest()), (error) =>
    error.message.includes("timed out"),
  );

  const closes = closeSurfaceCalls(io.calls);
  assert.deepEqual(
    closes.map((c) => c.args),
    [
      [
        "close-surface",
        "--workspace",
        FAKE_WS_ID,
        "--surface",
        "ORPHAN-UUID",
        "--force",
      ],
    ],
  );
  assert.equal(
    seen.fifoPresent,
    false,
    "the FIFO is withdrawn before waiting, so the orphan cannot start the child",
  );
  assert.equal(await pathExists(seen.launchDir), false);
  assert.ok(
    io.children.every((child) => child._exited),
    "events subscription stopped",
  );
});

test("launch: a timed-out create with no surface reporting rejects after the grace and closes nothing", async () => {
  const io = makeFakeIo({ createError: createTimeout() });
  const seen = lateSurface(io, "TOO-LATE", 200);
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 50,
  });

  await assert.rejects(backend.launch(makeRequest()), /timed out/);

  assert.deepEqual(closeSurfaceCalls(io.calls), []);
  assert.equal(
    await pathExists(seen.launchDir),
    false,
    "a later surface finds no launch directory and closes itself",
  );
});

test("launch: a create result without refs is an unknown outcome, so the surface that reports is closed", async () => {
  const io = makeFakeIo({ fifoUnread: true });
  // The CLI's human summary instead of the rpc's JSON result.
  io.behavior.createOutput = `OK ${FAKE_SF_REF} ${FAKE_PN_REF} ${FAKE_WS_REF}\n`;
  lateSurface(io, "ORPHAN-UUID");
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 1_000,
  });

  await assert.rejects(
    backend.launch(makeRequest()),
    /Unexpected cmux create output/,
  );
  assert.deepEqual(
    closeSurfaceCalls(io.calls).map((c) => c.args.at(-2)),
    ["ORPHAN-UUID"],
  );
});

test("launch: a create cmux rejects outright does not wait for an orphan", async () => {
  const io = makeFakeIo({
    createError: Object.assign(new Error("pane.create failed"), {
      stderr: "Error: invalid_params: Missing or invalid direction",
    }),
  });
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 2_000,
  });

  const started = Date.now();
  await assert.rejects(backend.launch(makeRequest()), /pane.create failed/);
  assert.ok(Date.now() - started < 1_000, "no grace wait when cmux answered");
  assert.deepEqual(closeSurfaceCalls(io.calls), []);
});

test("launch: an orphan that cannot be closed is reported alongside the create failure", async () => {
  const io = makeFakeIo({
    createError: createTimeout(),
    closeError: new Error("socket gone"),
  });
  lateSurface(io, "ORPHAN-UUID");
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 1_000,
  });

  await assert.rejects(backend.launch(makeRequest()), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((e) => e.message),
      ["Command failed: cmux rpc pane.create (timed out)", "socket gone"],
    );
    assert.match(error.message, /ORPHAN-UUID/);
    return true;
  });
});

test(
  "launch: an aborted create also collects its orphan, without a cool-down",
  withSocketPath(async () => {
    const io = makeFakeIo({
      createError: Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    });
    lateSurface(io, "ORPHAN-UUID");
    const backend = createCmuxBackend({
      execFile: io.execFile,
      spawn: io.spawn,
      orphanGraceMs: 1_000,
    });

    await assert.rejects(backend.launch(makeRequest()), { name: "AbortError" });

    assert.equal(closeSurfaceCalls(io.calls).length, 1);
    assert.equal(
      (await backend.detect()).available,
      true,
      "the caller cancelled; cmux is not unhealthy",
    );
  }),
);

// ─── cool-down after a create timeout ────────────────────────────────────────

test(
  "detect: after a create timeout cmux is unavailable for the cool-down, without asking cmux",
  withSocketPath(async () => {
    let clock = 1_000_000;
    const io = makeFakeIo({ createError: createTimeout() });
    const backend = createCmuxBackend({
      execFile: io.execFile,
      spawn: io.spawn,
      orphanGraceMs: 10,
      cooldownMs: 60_000,
      now: () => clock,
    });
    await assert.rejects(backend.launch(makeRequest()));
    const callsBefore = io.calls.length;

    const cooling = await backend.detect();
    assert.equal(cooling.available, false);
    assert.match(cooling.reason, /timed out.*60s/);
    assert.equal(
      io.calls.length,
      callsBefore,
      "a cooling-down detect answers without cmux",
    );

    clock += 60_001;
    io.behavior.createError = null;
    assert.equal(
      (await backend.detect()).available,
      true,
      "probes cmux again after the cool-down",
    );
  }),
);

test("launch: launches queued behind a timed-out create fail fast instead of each waiting out the deadline", async () => {
  const io = makeFakeIo({ createError: createTimeout() });
  io.behavior.onCreate = () =>
    new Promise((resolve) => setTimeout(resolve, 30));
  const backend = createCmuxBackend({
    execFile: io.execFile,
    spawn: io.spawn,
    orphanGraceMs: 10,
  });

  const results = await Promise.allSettled([
    backend.launch(makeRequest()),
    backend.launch(makeRequest()),
  ]);

  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
  );
  // Whichever launch took the lock first timed out; the other failed fast.
  const messages = results.map((r) => r.reason.message).sort();
  assert.match(
    messages[0],
    /^Command failed: cmux rpc pane\.create \(timed out\)$/,
  );
  assert.match(messages[1], /^cmux backend is cooling down/);
  assert.equal(io.calls.filter(isPaneCreate).length, 1);
});

// ─── events subscription lifecycle ───────────────────────────────────────────

/**
 * Events child with a scripted lifecycle, following Node's real event order:
 *   "spawn-error" – emits error (ENOENT) and close, never exit (missing binary)
 *   "ack-exit0"   – acks, then exits 0 at once (before launch attaches a listener)
 *   "ack-sigterm" – acks, then is killed by someone else's SIGTERM
 */
class ScriptedEventsChild extends EventEmitter {
  constructor(script) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.pid = script === "spawn-error" ? undefined : 4242;
    this._exited = false;
    setImmediate(() => {
      if (script === "spawn-error") {
        this._exited = true;
        this.emit(
          "error",
          Object.assign(new Error("spawn cmux ENOENT"), { code: "ENOENT" }),
        );
        this.emit("close", -2, null);
        return;
      }
      this.stdout.push(`${JSON.stringify(FAKE_ACK)}\n`);
      setImmediate(() =>
        this._end(...(script === "ack-exit0" ? [0, null] : [null, "SIGTERM"])),
      );
    });
  }

  _end(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  kill(signal) {
    setImmediate(() => this._end(null, signal));
  }
}

function scriptedIo(script) {
  const io = makeFakeIo();
  return { ...io, spawn: () => new ScriptedEventsChild(script) };
}

function withinDeadline(promise, ms = 2_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`still pending after ${ms}ms`)),
        ms,
      ).unref(),
    ),
  ]);
}

test("launch: missing cmux binary (error + close, no exit) rejects instead of hanging", async () => {
  const { execFile, spawn, calls } = scriptedIo("spawn-error");
  const backend = createCmuxBackend({ execFile, spawn });

  await assert.rejects(withinDeadline(backend.launch(makeRequest())), /ENOENT/);
  assert.equal(
    calls.some(isPaneCreate),
    false,
    "no surface created without an ack",
  );
});

test("reattach: missing cmux binary returns unknown instead of hanging", async () => {
  const { execFile, spawn } = scriptedIo("spawn-error");
  const backend = createCmuxBackend({ execFile, spawn });

  const result = await withinDeadline(
    backend.reattach({
      data: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
    }),
  );
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /ENOENT/);
});

for (const [script, description] of [
  ["ack-exit0", "a clean exit 0"],
  ["ack-sigterm", "an external SIGTERM"],
]) {
  test(`launch: subscription ending with ${description} before the listener attaches is reported`, async () => {
    const { execFile, spawn } = scriptedIo(script);
    const backend = createCmuxBackend({ execFile, spawn });
    const lease = await backend.launch(makeRequest());

    const { value } = await withinDeadline(lease.events.next());
    assert.equal(value.type, "backend_disconnected");
    assert.equal(value.source, "mux");
    assert.deepEqual(value.surface, lease.handle.surface);
    assert.match(value.reason, /cmux events/);
    await lease.release();
  });
}

test("launch: intentional release does not report a disconnect", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  await lease.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lease.queuedEvents,
    [],
    "our own SIGTERM is not a disconnect",
  );
});

// ─── launch: cmux events translated to facts ─────────────────────────────────

test("launch: cmux workspace.closed event from subscription becomes surface_closed fact", async () => {
  const closeEvent = {
    name: "workspace.closed",
    workspace_id: FAKE_WS_ID,
    type: "event",
  };
  const { execFile, spawn } = makeFakeIo({ eventsFrames: [closeEvent] });
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  // The events subprocess emits the close event after the ack; it should
  // translate to a surface_closed fact in the lease queue.
  // Give the event loop time to process the stream data.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const event = (await lease.events.next()).value;
  assert.equal(event.type, "surface_closed");
  assert.equal(event.source, "mux");

  await lease.release();
});

// cmux reports no process exit, only the surface closing. surface-launch.sh
// writes its exit status to the exit directory before it closes its own
// surface, so pi-cohort, which waits for an `exited` fact before it trusts a
// child host gone, gets one only with that evidence.
const ownSurfaceClosed = {
  name: "surface.closed",
  surface_id: FAKE_SF_ID,
  pane_id: FAKE_PN_ID,
  workspace_id: FAKE_WS_ID,
  type: "event",
};

async function launchThatExits({ status, frames = [ownSurfaceClosed] } = {}) {
  const io = makeFakeIo({ eventsFrames: frames });
  io.behavior.onCreate = async (args) => {
    const [exitDir] = launchOf(args).extra;
    io.exitDir = exitDir;
    if (status !== undefined)
      await writeFile(join(exitDir, "status"), `${status}\n`);
  };
  const backend = createCmuxBackend({ execFile: io.execFile, spawn: io.spawn });
  const lease = await backend.launch(makeRequest());
  return { io, lease };
}

async function drain(lease) {
  const facts = [];
  for (;;) {
    const next = await Promise.race([
      lease.events.next(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 50)),
    ]);
    if (!next || next.done) return facts;
    facts.push(next.value);
  }
}

test("launch: the surface closing after its process recorded an exit status reports exited, then surface_closed", async () => {
  const { lease } = await launchThatExits({ status: 3 });

  const facts = await drain(lease);
  assert.deepEqual(
    facts.map(({ type, status, signal, requested }) => ({
      type,
      status,
      signal,
      requested,
    })),
    [
      { type: "exited", status: 3, signal: null, requested: undefined },
      {
        type: "surface_closed",
        status: undefined,
        signal: undefined,
        requested: false,
      },
    ],
  );
  assert.deepEqual(facts[0].surface, lease.handle.surface);
  assert.equal(facts[0].source, "mux");
  await lease.release();
});

test("launch: a surface that closes with no recorded exit status reports surface_closed alone", async () => {
  // The user closed the tab, say: the process may still be running.
  const { lease } = await launchThatExits();

  const facts = await drain(lease);
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["surface_closed"],
  );
  await lease.release();
});

test("launch: an exit status is reported once, however many close events follow", async () => {
  const paneClosed = {
    name: "pane.closed",
    pane_id: FAKE_PN_ID,
    workspace_id: FAKE_WS_ID,
    type: "event",
  };
  const { lease } = await launchThatExits({
    status: 0,
    frames: [ownSurfaceClosed, paneClosed],
  });

  const facts = await drain(lease);
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["exited", "surface_closed", "surface_closed"],
  );
  assert.equal(facts[0].status, 0);
  await lease.release();
});

test("launch: the exit directory is owner-only and goes with the lease", async () => {
  const { io, lease } = await launchThatExits();

  assert.equal((await stat(io.exitDir)).mode & 0o777, 0o700);
  await lease.release();
  assert.equal(await pathExists(io.exitDir), false);
});

test("launch: a launch that fails removes its exit directory", async () => {
  const io = makeFakeIo({ createError: new Error("boom") });
  io.behavior.onCreate = async (args) => {
    [io.exitDir] = launchOf(args).extra;
  };
  const backend = createCmuxBackend({ execFile: io.execFile, spawn: io.spawn });

  await assert.rejects(backend.launch(makeRequest()), /boom/);
  assert.ok(io.exitDir);
  assert.equal(await pathExists(io.exitDir), false);
});

test("launch: events naming a foreign surface are dropped", async () => {
  // Children share the parent workspace; lifecycle events for other surfaces
  // must never reach this lease (bridge-parity ownership filtering).
  const foreign = [
    {
      name: "surface.closed",
      surface_id: "surface-999",
      pane_id: FAKE_PN_ID,
      workspace_id: FAKE_WS_ID,
      type: "event",
    },
    {
      name: "pane.closed",
      pane_id: "pane-999",
      workspace_id: FAKE_WS_ID,
      type: "event",
    },
  ];
  const own = {
    name: "surface.closed",
    surface_id: FAKE_SF_ID,
    pane_id: FAKE_PN_ID,
    workspace_id: FAKE_WS_ID,
    type: "event",
  };
  const { execFile, spawn } = makeFakeIo({ eventsFrames: [...foreign, own] });
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const event = (await lease.events.next()).value;
  assert.equal(event.type, "surface_closed", "own surface event arrives");
  assert.equal(event.source, "mux");
  // The two foreign frames must not be queued ahead of it; the queue is now empty.
  const next = lease.events.next();
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve("no further events"), 50),
  );
  assert.equal(await Promise.race([next, timeout]), "no further events");

  await lease.release();
});

test("launch: unrecognized cmux event translates to sanitized unknown fact without raw event text", async () => {
  // An event name that is not one of the known close variants.
  const unknownEvent = {
    name: "workspace.renamed",
    type: "event",
    workspace_id: FAKE_WS_ID,
  };
  const { execFile, spawn } = makeFakeIo({ eventsFrames: [unknownEvent] });
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  // Give the event loop time to process the stream data.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const event = (await lease.events.next()).value;
  assert.equal(event.type, "unknown");
  assert.equal(event.fact, "cmux_event");
  assert.equal(event.source, "mux");
  // reason must be a core-owned string — no raw cmux event text.
  assert.equal(typeof event.reason, "string");
  assert.ok(event.reason.length > 0, "reason must be non-empty");
  assert.ok(
    !JSON.stringify(event).includes("workspace.renamed"),
    "unknown event must not leak raw cmux event name into the fact",
  );

  await lease.release();
});

// ─── reconcile: fresh cmux evidence ───────────────────────────────────────────

function snapshotCalls(calls) {
  return calls.filter(
    (c) => c.type === "exec" && c.args.includes("list-pane-surfaces"),
  ).length;
}

test("reconcile: queries cmux and reports the surface present", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());
  const before = snapshotCalls(calls);

  const facts = await lease.reconcile();

  assert.equal(
    snapshotCalls(calls),
    before + 1,
    "reconcile takes a fresh snapshot",
  );
  assert.deepEqual(
    facts.map(({ type, fact, snapshot }) => ({ type, fact, snapshot })),
    [{ type: "unknown", fact: "snapshot", snapshot: true }],
  );
  assert.match(facts[0].reason, /present/);
  await lease.release();
});

for (const [setup, description] of [
  [
    (b) => {
      b.snapshotWithoutSurface = true;
    },
    "missing from a fresh snapshot",
  ],
  [
    (b) => {
      b.snapshotNotFound = true;
    },
    "in a pane or workspace cmux no longer finds",
  ],
]) {
  test(`reconcile: a surface ${description} is reported closed`, async () => {
    const { execFile, spawn, behavior } = makeFakeIo();
    const backend = createCmuxBackend({ execFile, spawn });
    const lease = await backend.launch(makeRequest());
    setup(behavior);

    const facts = await lease.reconcile();

    assert.deepEqual(
      facts.map(({ type, requested, snapshot }) => ({
        type,
        requested,
        snapshot,
      })),
      [{ type: "surface_closed", requested: false, snapshot: true }],
    );
    assert.deepEqual(facts[0].surface, lease.handle.surface);
    await lease.release();
  });
}

test("reconcile: a failed snapshot reports recovery unavailable, not cached state", async () => {
  const { execFile, spawn, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());
  behavior.snapshotError = new Error("socket timeout");

  const facts = await lease.reconcile();

  assert.equal(facts.length, 1);
  assert.equal(facts[0].type, "unknown");
  assert.equal(facts[0].snapshot, undefined);
  assert.match(facts[0].reason, /unavailable.*socket timeout/);
  await lease.release();
});

test("reconcile: an ended event stream is reported as not restored", async () => {
  const { execFile, spawn } = scriptedIo("ack-exit0");
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const facts = await lease.reconcile();

  const disconnected = facts.find((f) => f.type === "backend_disconnected");
  assert.ok(disconnected, "reconcile says live observation is gone");
  assert.match(disconnected.reason, /not restored/);
  await lease.release();
});

test("reconcile: the queue resumes before the snapshot, so events during it are kept", async () => {
  const { execFile, spawn, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());
  for (const sinceMs of [1, 2])
    lease.push({ type: "no_observed_activity", sinceMs });
  lease.push({ type: "surface_closed", requested: false });
  lease.push({ type: "exited", status: 0, signal: null }); // overflows
  for (let i = 0; i < 4; i += 1) await lease.events.next();
  behavior.onSnapshot = () =>
    lease.push({
      type: "surface_closed",
      requested: true,
      marker: "during-snapshot",
    });

  await lease.reconcile();

  assert.equal((await lease.events.next()).value.marker, "during-snapshot");
  await lease.release();
});

test("reconcile: a reattached lease also queries cmux", async () => {
  const { execFile, spawn, calls, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const result = await backend.reattach({
    data: {
      workspaceRef: FAKE_WS_REF,
      paneRef: FAKE_PN_REF,
      surfaceId: FAKE_SF_ID,
    },
  });
  assert.equal(result.status, "present");
  behavior.snapshotWithoutSurface = true;
  const before = snapshotCalls(calls);

  const facts = await result.lease.reconcile();

  assert.equal(snapshotCalls(calls), before + 1);
  assert.equal(facts.at(-1).type, "surface_closed");
  await result.lease.release();
});

// ─── reattach ─────────────────────────────────────────────────────────────────

test("reattach: present — snapshot observation then real mux close event (no invented death events)", async () => {
  // Simulate the cmux events subscription emitting a real close event after ack.
  const closeEvent = {
    name: "workspace.closed",
    workspace_id: FAKE_WS_ID,
    type: "event",
  };
  const { execFile, spawn } = makeFakeIo({ eventsFrames: [closeEvent] });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    backend: "cmux",
    protocolVersion: 1,
    surface: { kind: "pane", id: FAKE_SF_ID },
    display: { label: `cmux:${FAKE_WS_REF}`, hint: `cmux:${FAKE_WS_REF}` },
    data: {
      workspaceId: FAKE_WS_ID,
      workspaceRef: FAKE_WS_REF,
      paneId: FAKE_PN_ID,
      paneRef: FAKE_PN_REF,
      surfaceId: FAKE_SF_ID,
      surfaceRef: FAKE_SF_REF,
      title: "test",
      type: "terminal",
      cwd: "/test/cwd",
    },
  };

  const result = await backend.reattach(handle);
  assert.equal(result.status, "present");

  // First event: real snapshot observation — NOT a fabricated death event.
  const snapshotEvent = (await result.lease.events.next()).value;
  assert.equal(
    snapshotEvent.snapshot,
    true,
    "first event must be snapshot observation",
  );
  assert.equal(snapshotEvent.source, "mux");
  assert.equal(typeof snapshotEvent.timestamp, "number");
  assert.deepEqual(snapshotEvent.surface, { kind: "surface", id: FAKE_SF_ID });
  assert.notEqual(
    snapshotEvent.type,
    "surface_closed",
    "snapshot observation must not be a death event",
  );
  assert.notEqual(
    snapshotEvent.type,
    "exited",
    "snapshot observation must not be a death event",
  );

  // Second event: real surface_closed delivered by the live subscription (actual mux evidence).
  const liveEvent = (await result.lease.events.next()).value;
  assert.equal(
    liveEvent.type,
    "surface_closed",
    "cmux close event must become surface_closed fact",
  );
  assert.equal(liveEvent.source, "mux");
  assert.ok(
    liveEvent.timestamp >= snapshotEvent.timestamp,
    "live event timestamp must be >= snapshot",
  );

  await result.lease.release();
});

test("reattach: present — live surface emits no invented death events", async () => {
  // No extra frames from the subscription — live surface stays alive.
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    backend: "cmux",
    protocolVersion: 1,
    surface: { kind: "pane", id: FAKE_SF_ID },
    display: { label: `cmux:${FAKE_WS_REF}`, hint: `cmux:${FAKE_WS_REF}` },
    data: {
      workspaceId: FAKE_WS_ID,
      workspaceRef: FAKE_WS_REF,
      paneId: FAKE_PN_ID,
      paneRef: FAKE_PN_REF,
      surfaceId: FAKE_SF_ID,
      surfaceRef: FAKE_SF_REF,
      title: "test",
      type: "terminal",
      cwd: "/test/cwd",
    },
  };

  const result = await backend.reattach(handle);
  assert.equal(result.status, "present");

  // The only pre-populated event is a snapshot observation — never surface_closed or exited.
  const snapshotEvent = (await result.lease.events.next()).value;
  assert.equal(snapshotEvent.snapshot, true, "must be a snapshot observation");
  assert.notEqual(
    snapshotEvent.type,
    "surface_closed",
    "live reattach must NOT emit invented surface_closed",
  );
  assert.notEqual(
    snapshotEvent.type,
    "exited",
    "live reattach must NOT emit invented exited",
  );

  await result.lease.release();
});

test("reattach: gone — list-pane-surfaces not_found maps to status=gone", async () => {
  const { execFile, spawn } = makeFakeIo({ snapshotNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    data: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  };

  const result = await backend.reattach(handle);
  assert.deepEqual(result, { status: "gone" });
});

// cmux 0.65 reports a closed workspace addressed by ref without the
// not_found token: "Error: Workspace ref not found: workspace:N".
const staleWorkspaceRef = () =>
  Object.assign(new Error("Command failed"), {
    stderr: `Error: Workspace ref not found: ${FAKE_WS_REF}\n`,
  });

test("reattach: gone — cmux 0.65 'Workspace ref not found' maps to status=gone", async () => {
  const { execFile, spawn } = makeFakeIo({
    snapshotError: staleWorkspaceRef(),
  });
  const backend = createCmuxBackend({ execFile, spawn });

  const result = await backend.reattach({
    data: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  });
  assert.deepEqual(result, { status: "gone" });
});

test("reattach: unknown — generic CLI error yields status=unknown with reason", async () => {
  const err = new Error("connection refused");
  const { execFile, spawn } = makeFakeIo({ snapshotError: err });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    data: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  };

  const result = await backend.reattach(handle);
  assert.equal(result.status, "unknown");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

test("reattach: unknown — missing workspaceRef in handle yields status=unknown", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const result = await backend.reattach({
    surface: { kind: "pane", id: "surface-1" },
  });
  assert.equal(result.status, "unknown");
  assert.ok(/workspaceRef/i.test(result.reason));
});

test("reattach: subscription exits before ack — returns unknown with non-empty reason, no subscription leak", async () => {
  // Regression: if the cmux events process crashes before emitting its ack
  // (e.g. the binary is not available or the socket is gone), reattach must
  // return { status: "unknown", reason: <non-empty string> } and must not
  // leak the subscription timer or child process.
  class FakeEventsChildNoAck extends EventEmitter {
    constructor() {
      super();
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });
      this._killed = false;
      this._exited = false;
      // Exit with a non-zero code on the next tick — no ack frame emitted.
      setImmediate(() => {
        if (this._killed) return;
        this._exited = true;
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("exit", 1, null);
        this.emit("close", 1, null);
      });
    }

    kill(signal) {
      if (this._killed) return;
      this._killed = true;
      setImmediate(() => {
        if (!this._exited) {
          this._exited = true;
          this.stdout.push(null);
          this.stderr.push(null);
          this.emit("exit", 0, signal ?? "SIGTERM");
          this.emit("close", 0, signal ?? "SIGTERM");
        }
      });
    }
  }

  const spawnedChildren = [];
  function spawn(_cli, _args, _opts) {
    const child = new FakeEventsChildNoAck();
    spawnedChildren.push(child);
    return child;
  }

  const { execFile } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    data: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  };

  const result = await backend.reattach(handle);

  assert.equal(
    result.status,
    "unknown",
    "status must be unknown when subscription cannot ack",
  );
  assert.equal(typeof result.reason, "string", "reason must be a string");
  assert.ok(result.reason.length > 0, "reason must be non-empty");
  assert.equal(
    result.lease,
    undefined,
    "no lease returned when subscription never acked",
  );
  // Exactly one subscription was started then stopped — no dangling process.
  assert.equal(spawnedChildren.length, 1, "one subscription child was spawned");
  assert.ok(
    spawnedChildren[0]._exited,
    "subscription child must have exited (no process leak)",
  );
});

// ─── close ────────────────────────────────────────────────────────────────────

// ─── deadlines ───────────────────────────────────────────────────────────────

test(
  "options: cliDeadlineMs bounds every cmux call the backend makes",
  withSocketPath(async () => {
    const { execFile, spawn, calls } = makeFakeIo();
    const backend = createCmuxBackend({ execFile, spawn, cliDeadlineMs: 1234 });

    await backend.detect();
    const lease = await backend.launch(makeRequest());
    const handle = lease.handle;
    await lease.release();
    await backend.close(handle, "explicit_cleanup");

    const execs = calls.filter((c) => c.type === "exec");
    assert.ok(
      execs.some((c) => createMethod(c.args)),
      "a create call ran",
    );
    assert.ok(
      execs.some((c) => c.args[0] === "close-surface"),
      "close ran",
    );
    assert.deepEqual(
      execs.filter((c) => c.timeout !== 1234).map((c) => c.args.join(" ")),
      [],
    );
  }),
);

test(
  "options: ackDeadlineMs bounds the events acknowledgement",
  withSocketPath(async () => {
    const { execFile, calls } = makeFakeIo();
    const spawn = (_cli, args) => {
      calls.push({ type: "spawn", args: [...args] });
      return new FakeEventsChild({ type: "noise" });
    };
    const backend = createCmuxBackend({ execFile, spawn, ackDeadlineMs: 50 });

    await assert.rejects(
      withinDeadline(backend.launch(makeRequest()), 1_000),
      /ack timed out/,
    );
  }),
);

test("close: calls close-surface with the handle's workspace and surface refs", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    surface: { kind: "surface", id: FAKE_SF_ID },
    data: { workspaceRef: FAKE_WS_REF, surfaceRef: FAKE_SF_REF },
  };

  await backend.close(handle, "explicit_cleanup");

  const closeCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "close-surface",
  );
  assert.ok(closeCall, "close-surface call present");
  assert.equal(
    closeCall.args[closeCall.args.indexOf("--workspace") + 1],
    FAKE_WS_REF,
  );
  assert.equal(
    closeCall.args[closeCall.args.indexOf("--surface") + 1],
    FAKE_SF_REF,
  );
});

test("close: force-closes the owned surface even while its process is still running", async () => {
  const { execFile, spawn, calls, behavior } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());
  await lease.release();
  behavior.surfaceBusy = true; // child host still exiting after shutdown

  await backend.close(lease.handle, "delivered");

  const close = calls
    .filter((c) => c.type === "exec" && c.args[0] === "close-surface")
    .at(-1);
  assert.ok(
    close.args.includes("--force"),
    "close must not stall on cmux's confirmation",
  );
  assert.equal(
    close.args[close.args.indexOf("--surface") + 1],
    FAKE_SF_REF,
    "only the owned surface",
  );
});

test("close: not_found is treated as idempotent absence — no error thrown", async () => {
  const { execFile, spawn } = makeFakeIo({ closeNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    surface: { kind: "surface", id: FAKE_SF_ID },
    data: { workspaceRef: FAKE_WS_REF, surfaceRef: FAKE_SF_REF },
  };

  await assert.doesNotReject(backend.close(handle, "explicit_cleanup"));
});

test("close: can be called twice idempotently when CLI always returns not_found", async () => {
  const { execFile, spawn } = makeFakeIo({ closeNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    surface: { kind: "surface", id: FAKE_SF_ID },
    data: { workspaceRef: FAKE_WS_REF, surfaceRef: FAKE_SF_REF },
  };

  await backend.close(handle, "explicit_cleanup");
  await backend.close(handle, "explicit_cleanup");
  // no error means idempotent
});

test("close: cmux 0.65 'Workspace ref not found' is idempotent absence", async () => {
  const { execFile, spawn } = makeFakeIo({ closeError: staleWorkspaceRef() });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    surface: { kind: "surface", id: FAKE_SF_ID },
    data: { workspaceRef: FAKE_WS_REF, surfaceRef: FAKE_SF_REF },
  };

  await assert.doesNotReject(backend.close(handle, "explicit_cleanup"));
});

test("close: non-not_found CLI errors propagate (strict handle-keyed close)", async () => {
  const err = new Error("permission denied");
  const { execFile, spawn } = makeFakeIo({ closeError: err });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    surface: { kind: "surface", id: FAKE_SF_ID },
    data: { workspaceRef: FAKE_WS_REF, surfaceRef: FAKE_SF_REF },
  };

  await assert.rejects(
    backend.close(handle, "explicit_cleanup"),
    /permission denied/,
  );
});

test("close: no-op when handle has no surfaceRef (e.g. null data)", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  await backend.close(
    { surface: { kind: "surface", id: "surface-after-restart" }, data: null },
    "explicit_cleanup",
  );

  const closeCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "close-surface",
  );
  assert.equal(
    closeCall,
    undefined,
    "close-surface not called for handle without surfaceRef",
  );
});

// ─── SPI conformance: v1 metadata ────────────────────────────────────────────

test("cmux backend has required SPI metadata and methods", () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  assert.equal(backend.name, "cmux");
  assert.equal(backend.protocolVersion, 1);
  for (const method of ["detect", "launch", "reattach", "close"]) {
    assert.equal(
      typeof backend[method],
      "function",
      `backend.${method} is a function`,
    );
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertNoFunction(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    assert.notEqual(
      typeof value,
      "function",
      "handle must not contain live functions",
    );
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) assertNoFunction(nested, seen);
}

function assertNoForbiddenKey(value, forbiddenKeys, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(
      forbiddenKeys.includes(key),
      false,
      `handle leaks forbidden key: ${key}`,
    );
    assertNoForbiddenKey(nested, forbiddenKeys, seen);
  }
}
