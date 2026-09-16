import assert from "node:assert/strict";
import test from "node:test";
import { createEventQueue, createLease } from "../src/index.js";

test("lease reconciles overflow and releases transport exactly once", async () => {
  const queue = createEventQueue([{type:"a"},{type:"b"},{type:"c"}]);
  queue.push({ type: "surface_closed" });
  let releases = 0;
  const lease = createLease({ handle: {}, request: {}, eventQueue: queue,
    reconcile: lost => [lost], releaseTransport: async () => { releases += 1; } });
  assert.deepEqual(await lease.reconcile(), [{ type: "surface_closed" }]);
  assert.equal(lease.suspended, false);
  await lease.release(); await lease.release();
  assert.equal(releases, 1);
  assert.equal(lease.released, true);
});

test("concurrent release callers await the same in-flight cleanup", async () => {
  const queue = createEventQueue([]);
  let resolveCleanup;
  let releases = 0;
  const cleanup = new Promise(resolve => { resolveCleanup = resolve; });
  const lease = createLease({
    handle: {}, request: {}, eventQueue: queue, reconcile: () => [],
    releaseTransport: async () => { releases += 1; await cleanup; },
  });

  let firstSettled = false;
  let secondSettled = false;
  const first = lease.release().then(() => { firstSettled = true; });
  const second = lease.release().then(() => { secondSettled = true; });
  await Promise.resolve();

  const stateWhileCleaning = { releases, firstSettled, secondSettled };
  resolveCleanup();
  await Promise.all([first, second]);
  assert.deepEqual(stateWhileCleaning, {
    releases: 1,
    firstSettled: false,
    secondSettled: false,
  });
  assert.equal(lease.released, true);
});

test("failed release finishes consumers, propagates, and remains retryable", async () => {
  const queue = createEventQueue([]);
  const failure = new Error("transport cleanup failed");
  let releases = 0;
  const lease = createLease({
    handle: {}, request: {}, eventQueue: queue, reconcile: () => [],
    releaseTransport: async () => {
      releases += 1;
      if (releases === 1) throw failure;
    },
  });
  const consumer = lease.events[Symbol.asyncIterator]().next();

  await assert.rejects(lease.release(), error => error === failure);
  assert.deepEqual(await consumer, { done: true });
  await lease.release();
  assert.equal(releases, 2);
  assert.equal(lease.released, true);
});
