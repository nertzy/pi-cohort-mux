import assert from "node:assert/strict";

const requiredMethods = ["detect", "launch", "reattach", "close"];
const forbiddenHandleKeys = ["runId", "childId", "attempt", "task", "result", "output"];
function createRequest() {
  return {
    command: "child-host", args: ["--session", "session.jsonl"], cwd: "/ordinary/cwd",
    runId: "run-1", childId: "child-1", environment: { SAFE: "1" },
    signal: new AbortController().signal, secretPipePath: "/private/fifo",
  };
}

export function registerExecutionBackendConformance({
  test, name, createBackend, prohibitedValues = [],
}) {
  test(`${name}: exposes the v1 detection shape`, async () => {
    const backend = required(createBackend());
    const detection = await backend.detect();
    assert.equal(backend.protocolVersion, 1, "protocol version must be v1");
    assert.equal(typeof detection.available, "boolean");
    assert.equal(typeof detection.version, "string");
    assert.ok(Array.isArray(detection.capabilities));
  });

  test(`${name}: rejects an incompatible protocol version`, () => {
    const backend = required(createBackend());
    assert.throws(() => required({ ...backend, protocolVersion: 2 }), /protocol version/);
  });

  test(`${name}: launches one observed surface at the exact cwd`, async () => {
    const backend = required(createBackend());
    const request = createRequest();
    const lease = await backend.launch(request);
    assert.equal(lease.request?.cwd ?? backend.state?.lastRequest?.cwd, request.cwd);
    assert.deepEqual(backend.state?.trace?.slice(0, 2), ["observe", "start"]);
    assert.equal(backend.state?.launches?.length, 1);
    await lease.release();
  });

  test(`${name}: buffers an immediate exit until after lease return`, async () => {
    const backend = required(createBackend());
    const lease = await backend.launch({ ...createRequest(), immediateExit: true });
    assert.deepEqual((await lease.events.next()).value, {
      type: "exited", status: 0, signal: null, source: "mux", surfaceId: lease.handle.id,
    });
    await lease.release();
  });

  test(`${name}: exposes a durable opaque handle without secret or core identity`, async () => {
    const backend = required(createBackend());
    const lease = await backend.launch(createRequest());
    assertOpaqueHandle(lease.handle, prohibitedValues);
    await lease.release();
  });

  test(`${name}: passes only a secret-pipe path and never leaks its value`, async () => {
    const backend = required(createBackend());
    const request = createRequest();
    const lease = await backend.launch(request);
    lease.push({ type: "unknown", fact: "safe_fixture", source: "mux", surfaceId: lease.handle.id });
    const event = (await lease.events.next()).value;
    assert.equal(backend.state.lastRequest.secretPipePath, "/private/fifo");
    assertNoProhibitedValue({
      args: backend.state.lastRequest.args,
      environment: backend.state.lastRequest.environment,
      handle: lease.handle,
      event,
      persisted: backend.state.persisted,
    }, prohibitedValues);
    await lease.release();
  });

  test(`${name}: keeps mux events free of core correlation`, async () => {
    const backend = required(createBackend());
    const lease = await backend.launch(createRequest());
    lease.push({ type: "exited", status: 0, signal: null, source: "mux", surfaceId: lease.handle.id });
    const event = (await lease.events.next()).value;
    assert.equal(event.source, "mux");
    assert.equal(event.surfaceId, lease.handle.id);
    assert.equal(JSON.stringify(event).includes("childId"), false);
    assert.equal(JSON.stringify(event).includes("runId"), false);
    await lease.release();
  });

  test(`${name}: coalesces advisory overflow and resumes only through reconciliation`, async () => {
    const backend = required(createBackend());
    const interleaved = await backend.launch(createRequest());
    interleaved.push({ type: "no_observed_activity", sinceMs: 0 });
    interleaved.push({ type: "surface_closed", requested: false });
    interleaved.push({ type: "no_observed_activity", sinceMs: 1 });
    assert.deepEqual(interleaved.queuedEvents, [
      { type: "no_observed_activity", sinceMs: 0 },
      { type: "surface_closed", requested: false },
      { type: "no_observed_activity", sinceMs: 1 },
    ], "an advisory fact cannot overwrite an entity fact at the queue tail");
    await interleaved.release();

    const lease = await backend.launch(createRequest());
    lease.push({ type: "no_observed_activity", sinceMs: 1 });
    lease.push({ type: "no_observed_activity", sinceMs: 2 });
    lease.push({ type: "no_observed_activity", sinceMs: 3 });
    assert.deepEqual(lease.queuedEvents, [
      { type: "no_observed_activity", sinceMs: 1 },
      { type: "no_observed_activity", sinceMs: 3 },
    ]);
    lease.push({ type: "surface_closed", requested: false });
    lease.push({ type: "exited", status: 23, signal: null });
    assert.equal(lease.suspended, true);
    assert.deepEqual(lease.queuedEvents, [
      { type: "no_observed_activity", sinceMs: 1 },
      { type: "no_observed_activity", sinceMs: 3 },
      { type: "surface_closed", requested: false },
      { type: "unknown", fact: "event_stream", reason: "overflow" },
    ]);
    assert.deepEqual([
      (await lease.events.next()).value,
      (await lease.events.next()).value,
      (await lease.events.next()).value,
      (await lease.events.next()).value,
    ], [
      { type: "no_observed_activity", sinceMs: 1 },
      { type: "no_observed_activity", sinceMs: 3 },
      { type: "surface_closed", requested: false },
      { type: "unknown", fact: "event_stream", reason: "overflow" },
    ]);
    assert.deepEqual(await lease.reconcile(), [{
      type: "exited", status: 23, signal: null, source: "mux", surfaceId: lease.handle.id, snapshot: true,
    }]);
    assert.equal(lease.suspended, false);
    lease.push({ type: "surface_closed", requested: true });
    assert.deepEqual((await lease.events.next()).value, { type: "surface_closed", requested: true });
    assert.deepEqual(lease.queuedEvents, []);
    await lease.release();
  });

  test(`${name}: release and iterator return stop observation without closing`, async () => {
    const backend = required(createBackend());
    const lease = await backend.launch(createRequest());
    const pending = lease.events.next();
    await lease.events.return();
    assert.deepEqual(await pending, { done: true });
    await lease.release();
    assert.equal(backend.state.releaseCount, 1);
    assert.equal(backend.state.closed.size, 0);
  });

  test(`${name}: reattaches with snapshot facts before live facts and distinguishes absence`, async () => {
    const backend = required(createBackend());
    const present = await backend.reattach({ id: "surface-1" });
    assert.equal(present.status, "present");
    assert.equal((await present.lease.events.next()).value.snapshot, true);
    assert.equal((await present.lease.events.next()).value.live, true);
    assert.deepEqual(await backend.reattach({ id: "gone" }), { status: "gone" });
    assert.deepEqual(await backend.reattach({ id: "unknown" }), { status: "unknown", reason: "native unavailable" });
    await present.lease.release();
  });

  test(`${name}: closes by persisted handle idempotently without a lease`, async () => {
    const backend = required(createBackend());
    const handle = { id: "surface-after-restart" };
    await backend.close(handle, "explicit_cleanup");
    await backend.close(handle, "explicit_cleanup");
    assert.equal(backend.state.closed.has(handle.id), true);
  });

  test(`${name}: treats retention as release without close and accepts non-Git cwd`, async () => {
    const backend = required(createBackend());
    const lease = await backend.launch(createRequest());
    await lease.release();
    assert.equal(backend.state.closed.size, 0);
    assert.equal(backend.state.lastRequest.cwd, "/ordinary/cwd");
    assert.equal("worktree" in backend.state.lastRequest, false);
  });

  return 12;
}

function assertOpaqueHandle(handle, prohibitedValues) {
  assert.equal(typeof handle.id, "string");
  assert.match(handle.display, /\S/, "handle must include an actionable display hint");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(handle)));
  assertNoFunction(handle);
  assertNoForbiddenKey(handle, forbiddenHandleKeys);
  assertNoProhibitedValue(handle, prohibitedValues);
}

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
    assert.equal(forbiddenKeys.includes(key), false, `handle leaks ${key}`);
    assertNoForbiddenKey(nested, forbiddenKeys, seen);
  }
}

function assertNoProhibitedValue(value, prohibitedValues, seen = new Set()) {
  if (prohibitedValues.length === 0 || value === undefined || value === null) return;
  if (typeof value !== "object") {
    for (const prohibited of prohibitedValues) {
      assert.notEqual(value, prohibited, "surface artifact leaks prohibited value");
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value)) {
    assertNoProhibitedValue(nested, prohibitedValues, seen);
  }
}

function required(backend) {
  assert.ok(backend && typeof backend === "object", "backend must be an object");
  for (const method of requiredMethods) assert.equal(typeof backend[method], "function", `backend.${method} must be a function`);
  assert.equal(backend.protocolVersion, 1, "backend protocol version must be v1");
  return backend;
}
