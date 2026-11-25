/**
 * herdr-core socket client: one connection per request, a long-lived
 * connection per subscription, every wait bounded. Runs against the fake
 * herdr-core.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  herdrCoreRequest,
  subscribeHerdrCore,
} from "pi-cohort-mux-herdr-core/execution-backend";

import { startFakeHerdrCore } from "./fixtures/fake-herdr-core/server.mjs";

async function fake(t, options) {
  const core = await startFakeHerdrCore(options);
  t.after(() => core.close());
  return core;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("request: resolves a method's result and closes its connection", async (t) => {
  const core = await fake(t);
  const result = await herdrCoreRequest(core.socketPath, "terminal.get", {
    terminal: "t1",
  });
  assert.equal(result.address, "t1");
  assert.deepEqual(core.requests, [
    { method: "terminal.get", params: { terminal: "t1" } },
  ]);
  await settle();
  assert.equal(core.openConnections, 0);
});

test("request: a herdr-core error rejects with its kind and message", async (t) => {
  const core = await fake(t);
  await assert.rejects(
    herdrCoreRequest(core.socketPath, "terminal.rm", { terminal: "t9" }),
    (error) =>
      error.name === "HerdrCoreError" &&
      error.kind === "not_found" &&
      error.message === 'herdr-core terminal.rm: no terminal "t9"',
  );
});

test("request: an unanswered request times out and says so", async (t) => {
  const core = await fake(t, { hooks: { hello: () => "drop" } });
  await assert.rejects(
    herdrCoreRequest(core.socketPath, "hello", {}, { timeout: 50 }),
    (error) =>
      error.timedOut === true &&
      /did not answer within 50ms/.test(error.message),
  );
  await settle();
  assert.equal(core.openConnections, 0);
});

test("request: an abort rejects with an AbortError and drops the connection", async (t) => {
  const core = await fake(t, { hooks: { hello: () => "drop" } });
  const controller = new AbortController();
  const pending = herdrCoreRequest(
    core.socketPath,
    "hello",
    {},
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("request: a hang-up after the request was sent rejects and says herdr-core may have acted", async (t) => {
  const core = await fake(t, { hooks: { hello: () => "hangup" } });
  await assert.rejects(
    herdrCoreRequest(core.socketPath, "hello"),
    (error) =>
      error.requestSent === true &&
      /closed the connection without answering/.test(error.message),
  );
});

test("request: a missing socket rejects with the connection error, before anything was sent", async () => {
  await assert.rejects(
    herdrCoreRequest("/tmp/no-such-herdr-core.sock", "hello"),
    (error) => error.code === "ENOENT" && error.requestSent !== true,
  );
});

test("request: a partial line is buffered, and lines for other ids are skipped", async (t) => {
  const path = `/tmp/fhc-split-${process.pid}.sock`;
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const { id } = JSON.parse(chunk);
      socket.write(
        '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":1}}\n',
      );
      socket.write(`{"jsonrpc":"2.0","id":${id},"result":{"version":`);
      setTimeout(() => socket.write('"0.1.22"}}\n'), 10);
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.deepEqual(await herdrCoreRequest(path, "hello"), {
    version: "0.1.22",
  });
});

test("subscribe: acknowledges with the snapshot, then delivers notifications buffered before a listener", async (t) => {
  const core = await fake(t);
  const subscription = subscribeHerdrCore(core.socketPath, {
    terminal: "t1",
  });
  t.after(() => subscription.stop());
  const ack = await subscription.ack;
  assert.deepEqual(
    ack.terminals.map((terminal) => terminal.address),
    ["t1"],
  );
  assert.equal(core.subscriberCount, 1);
  core.exit("t1", { exitCode: 3 });
  core.notify("heartbeat", { seq: 1 });
  await settle();
  const notifications = [];
  subscription.onNotification((notification) =>
    notifications.push(notification),
  );
  assert.deepEqual(
    notifications.map(({ method, params }) => [method, params.type]),
    [
      ["event", "finished"],
      ["heartbeat", undefined],
    ],
  );
  assert.deepEqual(
    { ...notifications[0].params.data, finished_ms: 0 },
    { exit_code: 3, finished_ms: 0, reason: "exited", signal: null },
  );
  assert.deepEqual(core.requests.at(-1), {
    method: "events.subscribe",
    params: { terminal: "t1" },
  });
});

test("subscribe: a filter that matches nothing hears nothing", async (t) => {
  const core = await fake(t);
  const subscription = subscribeHerdrCore(core.socketPath, {
    labels: { launch: "other" },
  });
  t.after(() => subscription.stop());
  assert.deepEqual((await subscription.ack).terminals, []);
  core.exit("t1");
  await settle();
  const notifications = [];
  subscription.onNotification((notification) =>
    notifications.push(notification),
  );
  assert.deepEqual(notifications, []);
});

test("subscribe: a stream that ends on its own is a failure retained for a late listener", async (t) => {
  const core = await fake(t);
  const subscription = subscribeHerdrCore(core.socketPath, { terminal: "t1" });
  t.after(() => subscription.stop());
  await subscription.ack;
  core.dropSubscribers();
  await settle();
  assert.equal(subscription.ended, true);
  const errors = [];
  subscription.onNotification((_notification, error) => errors.push(error));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /herdr-core event stream ended unexpectedly/);
});

test("subscribe: stop() ends the stream without reporting a failure", async (t) => {
  const core = await fake(t);
  const subscription = subscribeHerdrCore(core.socketPath, { terminal: "t1" });
  await subscription.ack;
  const errors = [];
  subscription.onNotification(
    (_notification, error) => error && errors.push(error),
  );
  await subscription.stop();
  await settle();
  assert.equal(subscription.ended, false);
  assert.deepEqual(errors, []);
  assert.equal(core.subscriberCount, 0);
});

test("subscribe: stop() before the acknowledgement rejects it instead of leaving it pending", async (t) => {
  const core = await fake(t, { hooks: { "events.subscribe": () => "drop" } });
  const subscription = subscribeHerdrCore(core.socketPath, { terminal: "t1" });
  await settle();
  await subscription.stop();
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    subscription.ack.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(resolve, 100, pending)),
  ]);
  assert.notEqual(outcome, pending, "the acknowledgement settled");
  assert.match(outcome.message, /stopped before herdr-core acknowledged/);
  assert.equal(subscription.ended, false, "stop() is not a stream failure");
});

test("subscribe: an unacknowledged subscription times out", async (t) => {
  const core = await fake(t, { hooks: { "events.subscribe": () => "drop" } });
  const subscription = subscribeHerdrCore(
    core.socketPath,
    { terminal: "t1" },
    { ackDeadline: 50 },
  );
  t.after(() => subscription.stop());
  await assert.rejects(subscription.ack, /ack timed out/);
});

test("subscribe: a subscription herdr-core refuses rejects its ack with the kind", async (t) => {
  const core = await fake(t, {
    hooks: {
      "events.subscribe": () => ({
        error: {
          code: -32000,
          message: 'no terminal "t9"',
          data: { kind: "not_found" },
        },
      }),
    },
  });
  const subscription = subscribeHerdrCore(core.socketPath, { terminal: "t9" });
  t.after(() => subscription.stop());
  await assert.rejects(subscription.ack, (error) => error.kind === "not_found");
});

test("subscribe: an unreachable socket rejects its ack", async (t) => {
  const subscription = subscribeHerdrCore("/tmp/no-such-herdr-core.sock", {});
  t.after(() => subscription.stop());
  await assert.rejects(subscription.ack, (error) => error.code === "ENOENT");
});
