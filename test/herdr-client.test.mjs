/**
 * herdr socket client: one connection per request, a long-lived connection
 * per subscription, every wait bounded. Runs against the fake herdr server.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  herdrRequest,
  subscribeHerdr,
} from "pi-cohort-mux-herdr/execution-backend";

import { startFakeHerdr } from "./fixtures/fake-herdr/server.mjs";

async function fake(t, options) {
  const herdr = await startFakeHerdr(options);
  t.after(() => herdr.close());
  return herdr;
}

test("request: resolves a method's result over one connection", async (t) => {
  const herdr = await fake(t);
  const result = await herdrRequest(herdr.socketPath, "pane.get", {
    pane_id: "w1:p1",
  });
  assert.equal(result.type, "pane_info");
  assert.equal(result.pane.pane_id, "w1:p1");
  assert.deepEqual(herdr.requests, [
    { method: "pane.get", params: { pane_id: "w1:p1" } },
  ]);
});

test("request: a herdr error rejects with its code and message", async (t) => {
  const herdr = await fake(t);
  await assert.rejects(
    herdrRequest(herdr.socketPath, "pane.close", { pane_id: "w9:p9" }),
    (error) =>
      error.code === "pane_not_found" &&
      error.message === "herdr pane.close: pane w9:p9 not found",
  );
});

test("request: an unanswered request times out and says so", async (t) => {
  const herdr = await fake(t, { hooks: { ping: () => "drop" } });
  await assert.rejects(
    herdrRequest(herdr.socketPath, "ping", {}, { timeout: 50 }),
    (error) =>
      error.timedOut === true &&
      /did not answer within 50ms/.test(error.message),
  );
});

test("request: an abort rejects with an AbortError and drops the connection", async (t) => {
  const herdr = await fake(t, { hooks: { ping: () => "drop" } });
  const controller = new AbortController();
  const pending = herdrRequest(
    herdr.socketPath,
    "ping",
    {},
    {
      signal: controller.signal,
    },
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("request: a hang-up after the request was sent rejects and says herdr may have acted", async (t) => {
  const herdr = await fake(t, { hooks: { ping: () => "hangup" } });
  await assert.rejects(
    herdrRequest(herdr.socketPath, "ping"),
    (error) =>
      error.requestSent === true &&
      /closed the connection without answering/.test(error.message),
  );
});

test("request: a missing socket rejects with the connection error, before anything was sent", async () => {
  await assert.rejects(
    herdrRequest("/tmp/no-such-herdr.sock", "ping"),
    (error) => error.code === "ENOENT" && error.requestSent !== true,
  );
});

test("request: an answer arriving after the timeout reaches onLateResult", async (t) => {
  const herdr = await fake(t, {
    hooks: { "pane.get": () => ({ delayMs: 60 }) },
  });
  let late;
  const arrived = new Promise((resolve) => {
    late = resolve;
  });
  await assert.rejects(
    herdrRequest(
      herdr.socketPath,
      "pane.get",
      { pane_id: "w1:p1" },
      { timeout: 20, lateMs: 1_000, onLateResult: late },
    ),
    (error) => error.timedOut === true,
  );
  const result = await arrived;
  assert.equal(result.pane.pane_id, "w1:p1");
});

test("request: an answer after an abort reaches onLateResult too", async (t) => {
  const herdr = await fake(t, {
    hooks: { "pane.get": () => ({ delayMs: 60 }) },
  });
  const controller = new AbortController();
  let late;
  const arrived = new Promise((resolve) => {
    late = resolve;
  });
  const pending = herdrRequest(
    herdr.socketPath,
    "pane.get",
    { pane_id: "w1:p1" },
    { signal: controller.signal, lateMs: 1_000, onLateResult: late },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await arrived).pane.pane_id, "w1:p1");
});

test("request: without onLateResult a timed-out connection is dropped at once", async (t) => {
  const herdr = await fake(t, { hooks: { ping: () => "drop" } });
  await assert.rejects(
    herdrRequest(herdr.socketPath, "ping", {}, { timeout: 20 }),
    (error) => error.timedOut === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(herdr.openConnections, 0);
});

test("request: a partial line is buffered until its newline arrives", async (t) => {
  const path = `/tmp/fh-split-${process.pid}.sock`;
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write('{"id":"x","result":{"type":');
      setTimeout(() => socket.end('"pong"}}\n'), 10);
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.deepEqual(await herdrRequest(path, "ping"), { type: "pong" });
});

test("subscribe: acknowledges, then delivers frames buffered before a listener", async (t) => {
  const herdr = await fake(t);
  const subscription = subscribeHerdr(herdr.socketPath, ["pane.exited"]);
  t.after(() => subscription.stop());
  await subscription.ack;
  assert.equal(herdr.subscriberCount, 1);
  herdr.emit("pane_exited", { pane_id: "w1:p7", workspace_id: "w1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const frames = [];
  subscription.onFrame((frame) => frames.push(frame));
  assert.deepEqual(frames, [
    {
      event: "pane_exited",
      data: { pane_id: "w1:p7", workspace_id: "w1", type: "pane_exited" },
    },
  ]);
  assert.deepEqual(herdr.requests.at(-1), {
    method: "events.subscribe",
    params: { subscriptions: [{ type: "pane.exited" }] },
  });
});

test("subscribe: a stream that ends on its own is a failure retained for a late listener", async (t) => {
  const herdr = await fake(t);
  const subscription = subscribeHerdr(herdr.socketPath, ["pane.exited"]);
  t.after(() => subscription.stop());
  await subscription.ack;
  herdr.dropSubscribers();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(subscription.ended, true);
  const errors = [];
  subscription.onFrame((_frame, error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /herdr event stream ended unexpectedly/);
});

test("subscribe: stop() ends the stream without reporting a failure", async (t) => {
  const herdr = await fake(t);
  const subscription = subscribeHerdr(herdr.socketPath, ["pane.exited"]);
  await subscription.ack;
  const errors = [];
  subscription.onFrame((_frame, error) => error && errors.push(error));
  await subscription.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(subscription.ended, false);
  assert.deepEqual(errors, []);
  assert.equal(herdr.subscriberCount, 0);
});

test("subscribe: an unacknowledged subscription times out", async (t) => {
  const herdr = await fake(t, { hooks: { "events.subscribe": () => "drop" } });
  const subscription = subscribeHerdr(herdr.socketPath, ["pane.exited"], {
    ackDeadline: 50,
  });
  t.after(() => subscription.stop());
  await assert.rejects(subscription.ack, /ack timed out/);
});

test("subscribe: a refused subscription rejects its ack", async (t) => {
  const subscription = subscribeHerdr("/tmp/no-such-herdr.sock", [
    "pane.exited",
  ]);
  t.after(() => subscription.stop());
  await assert.rejects(subscription.ack, (error) => error.code === "ENOENT");
});
