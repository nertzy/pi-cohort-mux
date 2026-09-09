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
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { createCmuxBackend } from "../src/cmux-backend.js";

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
      this.stdout.push(JSON.stringify(ackFrame) + "\n");
      for (const frame of extraFrames) {
        this.stdout.push(JSON.stringify(frame) + "\n");
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

function fakeSnapshot() {
  return {
    workspace_id: FAKE_WS_ID,
    workspace_ref: FAKE_WS_REF,
    pane_id: FAKE_PN_ID,
    pane_ref: FAKE_PN_REF,
    surfaces: [{ id: FAKE_SF_ID, ref: FAKE_SF_REF, title: "pi-cohort-test", type: "terminal" }],
  };
}

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
 *   capabilities     – capabilities array returned by `cmux capabilities`
 *   version          – string returned by `cmux --version`
 */
function makeFakeIo({
  eventsFrames = [],
  snapshotNotFound = false,
  snapshotError = null,
  closeNotFound = false,
  closeError = null,
  capabilities = ["events.v1"],
  version = "cmux 0.64.22",
} = {}) {
  const calls = [];

  async function execFile(cli, args, _opts) {
    calls.push({ type: "exec", args: [...args] });

    if (args[0] === "--version") {
      return { stdout: version + "\n", stderr: "" };
    }
    if (args[0] === "capabilities") {
      return { stdout: JSON.stringify({ capabilities }) + "\n", stderr: "" };
    }
    if (args[0] === "workspace" && args[1] === "create") {
      const envFileIndex = args.indexOf("--env-file");
      if (envFileIndex !== -1) await readFile(args[envFileIndex + 1], "utf8");
      return { stdout: `OK ${FAKE_WS_REF}\n`, stderr: "" };
    }
    if (args[0] === "--id-format" && args[1] === "both" && args[2] === "list-pane-surfaces") {
      if (snapshotNotFound) {
        const err = Object.assign(new Error("list-pane-surfaces not found"), {
          stderr: "Error: not_found: Pane or workspace not found",
        });
        throw err;
      }
      if (snapshotError) throw snapshotError;
      return { stdout: JSON.stringify(fakeSnapshot()) + "\n", stderr: "" };
    }
    if (args[0] === "workspace" && args[1] === "close") {
      if (closeNotFound) {
        const err = Object.assign(new Error("workspace close failed"), {
          stderr: "Error: not_found: Workspace not found",
        });
        throw err;
      }
      if (closeError) throw closeError;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unhandled fake cmux exec: ${args.join(" ")}`);
  }

  function spawn(cli, args, _opts) {
    calls.push({ type: "spawn", args: [...args] });
    return new FakeEventsChild(FAKE_ACK, eventsFrames);
  }

  return { execFile, spawn, calls };
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
  const { execFile, spawn } = makeFakeIo({ capabilities: ["events.v1", "surface.health"] });
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
    if (saved.CMUX_WORKSPACE_ID === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

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
    if (saved.CMUX_WORKSPACE_ID !== undefined) process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH !== undefined) process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

test("detect: unavailable and does not throw when CLI fails", async () => {
  const brokenExec = async () => { throw new Error("spawn cmux ENOENT"); };
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
    if (saved.CMUX_WORKSPACE_ID === undefined) delete process.env.CMUX_WORKSPACE_ID;
    else process.env.CMUX_WORKSPACE_ID = saved.CMUX_WORKSPACE_ID;
    if (saved.CMUX_SOCKET_PATH === undefined) delete process.env.CMUX_SOCKET_PATH;
    else process.env.CMUX_SOCKET_PATH = saved.CMUX_SOCKET_PATH;
  }
});

// ─── launch ordering ──────────────────────────────────────────────────────────

test("launch: subscribes to events BEFORE creating workspace (spike ordering)", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const spawnIdx = calls.findIndex(
    (c) => c.type === "spawn" && c.args[0] === "events",
  );
  const createIdx = calls.findIndex(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "create",
  );
  assert.ok(spawnIdx >= 0, "events subscription was started");
  assert.ok(createIdx >= 0, "workspace was created");
  assert.ok(spawnIdx < createIdx, "events subscription started before workspace create");

  await lease.release();
});

test("launch: events subscription includes --no-heartbeat flag", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const eventsCall = calls.find((c) => c.type === "spawn" && c.args[0] === "events");
  assert.ok(eventsCall, "events spawn call present");
  assert.ok(eventsCall.args.includes("--no-heartbeat"), "includes --no-heartbeat");

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

test("launch: creates workspace with exact cwd from request", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({ cwd: "/exact/cwd/test" });
  const lease = await backend.launch(request);

  const createCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "create",
  );
  assert.ok(createCall, "workspace create call present");
  const cwdIdx = createCall.args.indexOf("--cwd");
  assert.ok(cwdIdx >= 0, "--cwd present");
  assert.equal(createCall.args[cwdIdx + 1], "/exact/cwd/test");

  await lease.release();
});

test("launch: creates workspace with --focus false (no focus stealing)", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const createCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "create",
  );
  const focusIdx = createCall.args.indexOf("--focus");
  assert.ok(focusIdx >= 0, "--focus present");
  assert.equal(createCall.args[focusIdx + 1], "false");

  await lease.release();
});

test("launch: command arg shell-escapes command and args", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const request = makeRequest({
    command: "/usr/bin/pi",
    args: ["--session", "path with spaces/session.jsonl"],
  });
  const lease = await backend.launch(request);

  const createCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "create",
  );
  const cmdIdx = createCall.args.indexOf("--command");
  assert.ok(cmdIdx >= 0, "--command present");
  const cmd = createCall.args[cmdIdx + 1];
  // Should be shell-quoted tokens joined with space
  assert.ok(cmd.includes("/usr/bin/pi"), "command present in --command arg");
  assert.ok(cmd.includes("path with spaces"), "path with spaces present (shell-quoted)");
  assert.ok(cmd.includes("session.jsonl"), "session flag present");
  // Single-quote escaping: ensure the space arg is quoted
  assert.ok(cmd.includes("'") || cmd.includes('"'), "quoting applied");

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

// ─── launch: handle structure ─────────────────────────────────────────────────

test("launch: handle has required identity fields from spike (UUID from snapshot)", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const handle = lease.handle;
  assert.equal(handle.backend, "cmux");
  assert.equal(handle.protocolVersion, 1);
  assert.equal(handle.kind, "pane");
  assert.equal(handle.id, FAKE_SF_ID, "id is the surface UUID from snapshot");
  assert.match(handle.display, /\S/, "display is non-empty");

  await lease.release();
});

test("launch: handle reattach contains the nine key set from the spike", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest({ cwd: "/test/cwd" }));

  const { reattach } = lease.handle;
  assert.deepEqual(Object.keys(reattach).sort(), [
    "cwd", "paneId", "paneRef", "surfaceId", "surfaceRef", "title", "type",
    "workspaceId", "workspaceRef",
  ]);
  assert.equal(reattach.workspaceId, FAKE_WS_ID);
  assert.equal(reattach.workspaceRef, FAKE_WS_REF);
  assert.equal(reattach.surfaceId, FAKE_SF_ID);
  assert.equal(reattach.cwd, "/test/cwd");

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

  lease.push({ type: "unknown", fact: "test-event", source: "mux", surfaceId: lease.handle.id });
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
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].type, "exited");
  assert.equal(reconciled[0].status, 23);
  assert.equal(reconciled[0].snapshot, true);
  assert.equal(reconciled[0].source, "mux");
  assert.equal(reconciled[0].surfaceId, lease.handle.id);
  assert.equal(lease.suspended, false);

  // New pushes work after reconcile
  lease.push({ type: "surface_closed", requested: true });
  assert.deepEqual((await lease.events.next()).value, { type: "surface_closed", requested: true });

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
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const lease = await backend.launch(makeRequest());

  const pending = lease.events.next();
  await lease.events.return();
  assert.deepEqual(await pending, { done: true });
  await lease.release();

  assert.equal(backend.state.releaseCount, 1);
  assert.equal(backend.state.closed.size, 0);
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

// ─── reattach ─────────────────────────────────────────────────────────────────

test("reattach: present — returns status=present with snapshot then live facts", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    backend: "cmux",
    protocolVersion: 1,
    kind: "pane",
    id: FAKE_SF_ID,
    display: `cmux:${FAKE_WS_REF}`,
    reattach: {
      workspaceId: FAKE_WS_ID, workspaceRef: FAKE_WS_REF,
      paneId: FAKE_PN_ID, paneRef: FAKE_PN_REF,
      surfaceId: FAKE_SF_ID, surfaceRef: FAKE_SF_REF,
      title: "test", type: "terminal", cwd: "/test/cwd",
    },
  };

  const result = await backend.reattach(handle);
  assert.equal(result.status, "present");
  const snapshot = (await result.lease.events.next()).value;
  assert.equal(snapshot.snapshot, true);
  const live = (await result.lease.events.next()).value;
  assert.equal(live.live, true);
  await result.lease.release();
});

test("reattach: gone — list-pane-surfaces not_found maps to status=gone", async () => {
  const { execFile, spawn } = makeFakeIo({ snapshotNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    reattach: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  };

  const result = await backend.reattach(handle);
  assert.deepEqual(result, { status: "gone" });
});

test("reattach: unknown — generic CLI error yields status=unknown with reason", async () => {
  const err = new Error("connection refused");
  const { execFile, spawn } = makeFakeIo({ snapshotError: err });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    reattach: { workspaceRef: FAKE_WS_REF, surfaceId: FAKE_SF_ID },
  };

  const result = await backend.reattach(handle);
  assert.equal(result.status, "unknown");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

test("reattach: unknown — missing workspaceRef in handle yields status=unknown", async () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  const result = await backend.reattach({ id: "surface-1" });
  assert.equal(result.status, "unknown");
  assert.ok(/workspaceRef/i.test(result.reason));
});

// ─── close ────────────────────────────────────────────────────────────────────

test("close: calls workspace close with the handle's workspaceRef", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = {
    id: FAKE_SF_ID,
    reattach: { workspaceRef: FAKE_WS_REF },
  };

  await backend.close(handle, "explicit_cleanup");

  const closeCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "close",
  );
  assert.ok(closeCall, "workspace close call present");
  assert.equal(closeCall.args[2], FAKE_WS_REF);
});

test("close: not_found is treated as idempotent absence — no error thrown", async () => {
  const { execFile, spawn } = makeFakeIo({ closeNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = { id: FAKE_SF_ID, reattach: { workspaceRef: FAKE_WS_REF } };

  await assert.doesNotReject(backend.close(handle, "explicit_cleanup"));
});

test("close: can be called twice idempotently when CLI always returns not_found", async () => {
  const { execFile, spawn } = makeFakeIo({ closeNotFound: true });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = { id: FAKE_SF_ID, reattach: { workspaceRef: FAKE_WS_REF } };

  await backend.close(handle, "explicit_cleanup");
  await backend.close(handle, "explicit_cleanup");
  // no error means idempotent
});

test("close: non-not_found CLI errors propagate (strict handle-keyed close)", async () => {
  const err = new Error("permission denied");
  const { execFile, spawn } = makeFakeIo({ closeError: err });
  const backend = createCmuxBackend({ execFile, spawn });
  const handle = { id: FAKE_SF_ID, reattach: { workspaceRef: FAKE_WS_REF } };

  await assert.rejects(
    backend.close(handle, "explicit_cleanup"),
    /permission denied/,
  );
});

test("close: no-op when handle has no workspaceRef", async () => {
  const { execFile, spawn, calls } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  await backend.close({ id: "surface-after-restart" }, "explicit_cleanup");

  const closeCall = calls.find(
    (c) => c.type === "exec" && c.args[0] === "workspace" && c.args[1] === "close",
  );
  assert.equal(closeCall, undefined, "workspace close not called for handle without workspaceRef");
});

// ─── SPI conformance: v1 metadata ────────────────────────────────────────────

test("cmux backend has required SPI metadata and methods", () => {
  const { execFile, spawn } = makeFakeIo();
  const backend = createCmuxBackend({ execFile, spawn });

  assert.equal(backend.name, "cmux");
  assert.equal(backend.protocolVersion, 1);
  for (const method of ["detect", "launch", "reattach", "close"]) {
    assert.equal(typeof backend[method], "function", `backend.${method} is a function`);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertNoFunction(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    assert.notEqual(typeof value, "function", "handle must not contain live functions");
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
    assert.equal(forbiddenKeys.includes(key), false, `handle leaks forbidden key: ${key}`);
    assertNoForbiddenKey(nested, forbiddenKeys, seen);
  }
}
