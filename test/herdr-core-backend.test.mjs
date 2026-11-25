/**
 * herdr-core execution backend against the fake herdr-core: detection and
 * its ownership proof, both placements, the environment hand-off, event
 * translation, rollback, the create cool-down, orphan collection, reconcile,
 * reattach, and close.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHerdrCoreExecutionBackend } from "pi-cohort-mux-herdr-core/execution-backend";

import { startFakeHerdrCore } from "./fixtures/fake-herdr-core/server.mjs";

const BOOTSTRAP = fileURLToPath(
  new URL("../packages/pi-cohort-mux/src/env-bootstrap.sh", import.meta.url),
);
const LAUNCH_LABEL = "pi-cohort-mux.launch";

async function setup(t, { fake = {}, ...options } = {}) {
  const core = await startFakeHerdrCore(fake);
  t.after(() => core.close());
  const backend = createHerdrCoreExecutionBackend({
    env: core.env,
    ...options,
  });
  return { core, backend };
}

const request = (overrides = {}) => ({
  command: "/usr/local/bin/child-host",
  args: ["--session", "it's session.jsonl"],
  cwd: "/work/project",
  environment: {
    SAFE: "1",
    HC_TERMINAL_ID: "t1",
    HC_TERMINAL_SOCKET: "/parent.sock",
  },
  runId: "run-1",
  childId: "child-1",
  signal: new AbortController().signal,
  awareness: { title: "delegate" },
  ...overrides,
});

const methods = (core) => core.requests.map((r) => r.method);
const sent = (core, method) =>
  core.requests.filter((r) => r.method === method).map((r) => r.params);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function nextEvent(lease) {
  const result = await lease.events[Symbol.asyncIterator]().next();
  return result.value;
}

// ─── detect ───────────────────────────────────────────────────────────────────

test("detect: outside a herdr-core terminal the backend is unavailable and says why", async () => {
  const backend = createHerdrCoreExecutionBackend({ env: {} });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.equal(detection.version, "");
  assert.deepEqual(detection.capabilities, []);
  assert.match(detection.reason, /HC_TERMINAL_ID and HC_TERMINAL_SOCKET/);
});

test("detect: in a terminal whose program is this process it reports the core's version and features", async (t) => {
  const { core, backend } = await setup(t);
  assert.deepEqual(await backend.detect(), {
    available: true,
    version: "0.1.22",
    capabilities: ["framed", "attach", "events", "status"],
  });
  assert.deepEqual(methods(core), ["hello", "terminal.get"]);
});

test("detect: available when the terminal's program is an ancestor of this process", async (t) => {
  const { backend } = await setup(t, {
    fake: { callerPid: 4242 },
    ancestors: async () => [
      { pid: 900, command: "fish" },
      { pid: 4242, command: "herdr-core" },
    ],
  });
  assert.equal((await backend.detect()).available, true);
});

test("detect: unavailable with a reason when the HC_* variables were only inherited", async (t) => {
  const { backend } = await setup(t, {
    fake: { callerPid: 4242 },
    ancestors: async () => [{ pid: 900, command: "tmux" }],
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.equal(detection.version, "0.1.22");
  assert.match(
    detection.reason,
    /herdr-core did not start this terminal: .*t1.*4242.*inherited/,
  );
});

test("detect: unavailable when this process's ancestors cannot be listed", async (t) => {
  const { backend } = await setup(t, {
    fake: { callerPid: 4242 },
    ancestors: async () => {
      throw new Error("ps: not permitted");
    },
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(
    detection.reason,
    /cannot prove herdr-core started this terminal: ps: not permitted/,
  );
});

test("detect: a terminal that has finished cannot have started this process", async (t) => {
  const { core, backend } = await setup(t);
  core.exit("t1");
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /t1 is not running/);
});

test("detect: a stale HC_TERMINAL_ID is unavailable after one read-only probe", async (t) => {
  const core = await startFakeHerdrCore();
  t.after(() => core.close());
  const backend = createHerdrCoreExecutionBackend({
    env: { ...core.env, HC_TERMINAL_ID: "t9" },
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.equal(detection.reason, "HC_TERMINAL_ID t9 not found in herdr-core");
});

test("detect: an unreachable herdr-core socket is unavailable", async () => {
  const backend = createHerdrCoreExecutionBackend({
    env: {
      HC_TERMINAL_ID: "t1",
      HC_TERMINAL_SOCKET: "/tmp/no-such-herdr-core.sock",
    },
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /herdr-core is unreachable/);
});

test("detect: a core without the events feature is unavailable", async (t) => {
  const { backend } = await setup(t, { fake: { features: ["attach"] } });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /0\.1\.22 does not offer events/);
});

test("detect: an unknown placement is unavailable rather than guessed", async (t) => {
  const { backend } = await setup(t, { placement: "sideways" });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /placement "sideways".*"hidden" or "tab"/);
});

test("detect: tab placement is unavailable when the caller's terminal is in no Herdr space", async (t) => {
  const { backend } = await setup(t, {
    fake: { callerLabels: {} },
    placement: "tab",
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /tab placement.*herdr\.space/);
});

test("placement: PI_COHORT_MUX_HERDR_CORE_PLACEMENT selects it and defaults to hidden", async (t) => {
  const core = await startFakeHerdrCore();
  t.after(() => core.close());
  const tab = createHerdrCoreExecutionBackend({
    env: { ...core.env, PI_COHORT_MUX_HERDR_CORE_PLACEMENT: "tab" },
  });
  assert.equal(tab.placement, "tab");
  assert.equal(
    createHerdrCoreExecutionBackend({ env: core.env }).placement,
    "hidden",
  );
});

test("declares HC_* as surface-owned so attempts keep the terminal's identity", () => {
  const backend = createHerdrCoreExecutionBackend({ env: {} });
  assert.equal(backend.name, "herdr-core");
  assert.deepEqual(backend.surfaceEnvironmentPrefixes, ["HC_"]);
});

// ─── launch: hidden placement ────────────────────────────────────────────────

test("hidden launch: subscribes by a launch label first, then runs the bootstrap argv under the caller", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());

  assert.deepEqual(methods(core), ["events.subscribe", "terminal.run"]);
  const [subscribed] = sent(core, "events.subscribe");
  const [run] = sent(core, "terminal.run");
  const token = run.labels[LAUNCH_LABEL];
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(subscribed, { labels: { [LAUNCH_LABEL]: token } });
  assert.deepEqual(run.labels, { [LAUNCH_LABEL]: token });

  const [shell, bootstrap, fifo, ...child] = run.argv;
  assert.equal(shell, "/bin/sh");
  assert.equal(bootstrap, BOOTSTRAP);
  assert.match(fifo, /\/environment\.fifo$/);
  assert.deepEqual(child, [
    "/usr/local/bin/child-host",
    "--session",
    "it's session.jsonl",
  ]);
  assert.deepEqual(
    { ...run, argv: undefined, labels: undefined, name: undefined },
    {
      argv: undefined,
      labels: undefined,
      name: undefined,
      cwd: "/work/project",
      parent: "t1",
      no_notify: true,
      outlive_parent: false,
    },
  );
  assert.equal(run.name, `delegate-${token.slice(0, 8)}`);
});

test("hidden launch: the environment goes only through the FIFO, without the parent's HC_* identity", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(
    request({ environment: { SECRET_TOKEN: "s3cret", HC_SCOPE: "parent" } }),
  );
  t.after(() => lease.release());
  await core.childrenDone();
  assert.deepEqual(core.handoffs, [
    { terminal: "t2", environment: "SECRET_TOKEN=s3cret\n" },
  ]);
  assert.doesNotMatch(JSON.stringify(core.requests), /s3cret/);
});

test("hidden launch: returns an opaque, serializable handle naming the terminal", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const [{ labels, name }] = sent(core, "terminal.run");
  assert.deepEqual(lease.handle, {
    protocolVersion: 1,
    backend: "herdr-core",
    surface: { kind: "terminal", id: "t2" },
    display: {
      label: "herdr-core:t2",
      hint: `hidden herdr-core terminal t2 (hc attach ${name})`,
    },
    data: {
      placement: "hidden",
      terminal: "t2",
      launch: labels[LAUNCH_LABEL],
      cwd: "/work/project",
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(lease.handle)), lease.handle);
});

test("hidden launch: names default to pi and keep to herdr-core's alphabet and length", async (t) => {
  const { core, backend } = await setup(t);
  const plain = await backend.launch(request({ awareness: undefined }));
  const odd = await backend.launch(
    request({
      awareness: { title: "Evil\u001b[31m\nName with a very long tail indeed" },
    }),
  );
  t.after(() => Promise.all([plain.release(), odd.release()]));
  const names = sent(core, "terminal.run").map((params) => params.name);
  assert.match(names[0], /^pi-[0-9a-f]{8}$/);
  assert.match(names[1], /^evil-31m-name-with-a-ve-[0-9a-f]{8}$/);
  for (const name of names) assert.match(name, /^[a-z0-9._-]{1,32}$/);
});

// ─── launch: tab placement ───────────────────────────────────────────────────

test("tab launch: labels the child with the caller's Herdr space and lets it outlive the caller", async (t) => {
  const { core, backend } = await setup(t, { placement: "tab" });
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  assert.deepEqual(methods(core), [
    "terminal.get",
    "events.subscribe",
    "terminal.run",
  ]);
  const [run] = sent(core, "terminal.run");
  assert.deepEqual(run.labels, {
    [LAUNCH_LABEL]: run.labels[LAUNCH_LABEL],
    "herdr.space": "space-1",
  });
  assert.equal(run.parent, "t1");
  assert.equal(run.outlive_parent, true);
  assert.equal(lease.handle.data.placement, "tab");
  assert.equal(
    lease.handle.display.hint,
    "Herdr tab in space space-1, terminal t2",
  );
});

test("tab launch: a caller in no Herdr space is refused before anything is created", async (t) => {
  const { core, backend } = await setup(t, {
    fake: { callerLabels: {} },
    placement: "tab",
  });
  await assert.rejects(backend.launch(request()), /herdr\.space/);
  assert.deepEqual(methods(core), ["terminal.get"]);
});

// ─── events ───────────────────────────────────────────────────────────────────

test("events: the lease reports its terminal's exit code and ignores everything else", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  core.emit("foreground", "t2", { name: "node", pid: 50_000 });
  core.emit("status", "t2", { status: "working" });
  core.emit("title", "t2", { title: "child" });
  core.notify("heartbeat", { seq: 9 });
  core.notify("event", {
    type: "finished",
    terminal: "t99",
    seq: 10,
    data: { exit_code: 1, signal: null, reason: "exited" },
  });
  core.exit("t2", { exitCode: 3 });
  const event = await nextEvent(lease);
  assert.equal(typeof event.timestamp, "number");
  assert.deepEqual(
    { ...event, timestamp: 0 },
    {
      type: "exited",
      status: 3,
      signal: null,
      source: "mux",
      surface: { kind: "terminal", id: "t2" },
      timestamp: 0,
    },
  );
});

test("events: a program ended by a signal reports the signal's name and no status", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  core.exit("t2", { signal: 15 });
  const event = await nextEvent(lease);
  assert.deepEqual(
    [event.type, event.status, event.signal],
    ["exited", null, "SIGTERM"],
  );
});

test("events: a terminal removed by someone else is unrequested; one removed through close() is requested", async (t) => {
  const { core, backend } = await setup(t);
  const ours = await backend.launch(request());
  const theirs = await backend.launch(request());
  t.after(() => Promise.all([ours.release(), theirs.release()]));
  core.emit("removed", "t3");
  core.terminals.delete("t3");
  await backend.close(ours.handle, "explicit_cleanup");
  const closedByOthers = await nextEvent(theirs);
  assert.deepEqual(
    [closedByOthers.type, closedByOthers.requested],
    ["surface_closed", false],
  );
  const [killed, closedByUs] = [await nextEvent(ours), await nextEvent(ours)];
  assert.deepEqual(
    [killed.type, killed.signal],
    ["exited", "SIGHUP"],
    "close() ends a running program first",
  );
  assert.deepEqual(
    [closedByUs.type, closedByUs.requested],
    ["surface_closed", true],
  );
});

test("events: a lost or restarted program is reported as an unknown fact", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  core.emit("lost", "t2");
  const event = await nextEvent(lease);
  assert.deepEqual(
    [event.type, event.fact, event.reason],
    ["unknown", "herdr_core_event", "herdr-core reported lost"],
  );
});

test("events: after a missed notice the lease reports what a fresh look shows", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  // The exit happened while the subscriber was behind: no finished event.
  Object.assign(core.terminals.get("t2"), {
    state: "finished",
    exit_code: 7,
    reason: "exited",
  });
  core.notify("missed", { seq: 20, terminals: [] });
  const event = await nextEvent(lease);
  assert.deepEqual([event.type, event.status], ["exited", 7]);
});

test("events: a terminal that loses its launch label is reported closed, since herdr-core then stops reporting it", async (t) => {
  for (const [how, value] of [
    ["removed", ""],
    ["replaced", "someone-else"],
  ]) {
    const { core, backend } = await setup(t);
    const lease = await backend.launch(request());
    t.after(() => lease.release());
    const address = lease.handle.data.terminal;
    core.relabel(address, { "pi-cohort-mux.launch": value });
    // The real core delivers nothing further for this terminal.
    core.exit(address, { exitCode: 0 });
    const event = await nextEvent(lease);
    assert.deepEqual(
      [event.type, event.requested],
      ["surface_closed", false],
      `launch label ${how}`,
    );
  }
});

test("events: a label change that keeps the launch label says nothing about the child", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const address = lease.handle.data.terminal;
  core.relabel(address, { where: "somewhere / 2" });
  core.exit(address, { exitCode: 4 });
  const event = await nextEvent(lease);
  assert.deepEqual([event.type, event.status], ["exited", 4]);
});

test("events: a herdr-core stream that ends on its own reports backend_disconnected", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  core.dropSubscribers();
  const event = await nextEvent(lease);
  assert.equal(event.type, "backend_disconnected");
  assert.match(event.reason, /ended unexpectedly/);
});

test("release: stops observing without ending the terminal", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  await settle();
  assert.equal(core.subscriberCount, 0);
  assert.equal(core.terminals.get("t2").state, "live");
  assert.equal(methods(core).includes("terminal.kill"), false);
});

// ─── launch failures ─────────────────────────────────────────────────────────

test("launch: a child that never reads its environment is rolled back by exact terminal", async (t) => {
  const { core, backend } = await setup(t, {
    fake: { child: "none" },
    handoffDeadlineMs: 50,
  });
  await assert.rejects(
    backend.launch(request()),
    /environment hand-off did not complete within 50ms/,
  );
  assert.equal(core.terminals.has("t2"), false);
  assert.deepEqual(core.requests.slice(-2), [
    { method: "terminal.kill", params: { terminal: "t2" } },
    { method: "terminal.rm", params: { terminal: "t2" } },
  ]);
  await settle();
  assert.equal(core.subscriberCount, 0);
});

test("launch: a rollback leaves alone a terminal that no longer carries the launch label", async (t) => {
  // Another core answering on the socket may reuse the address.
  let core;
  ({ core } = await setup(t, {
    fake: {
      child: "none",
      hooks: {
        "terminal.run": (_params, { run }) => {
          const created = run();
          core.terminals.get(created.address).labels = {};
          return created;
        },
      },
    },
  }));
  const backend = createHerdrCoreExecutionBackend({
    env: core.env,
    handoffDeadlineMs: 50,
  });
  await assert.rejects(
    backend.launch(request()),
    /environment hand-off did not complete within 50ms/,
  );
  assert.equal(core.terminals.get("t2").state, "live");
  assert.equal(methods(core).includes("terminal.kill"), false);
  assert.equal(methods(core).includes("terminal.rm"), false);
});

test("launch: herdr-core's unavailable error may follow a create, so the terminal is collected", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          run();
          return {
            error: {
              code: -32000,
              message:
                "cannot save terminals: disk full; the operation may already have completed",
              data: { kind: "unavailable" },
            },
          };
        },
      },
    },
    orphanGraceMs: 200,
  });
  await assert.rejects(
    backend.launch(request()),
    (error) => error.kind === "unavailable",
  );
  assert.equal(core.terminals.has("t2"), false, "the orphan was removed");
  assert.equal(
    (await backend.detect()).available,
    true,
    "herdr-core answered, so no cool-down",
  );
  await settle();
  assert.equal(core.subscriberCount, 0);
});

test("launch: an error herdr-core reports means nothing was created, and starts no cool-down", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": () => ({
          error: {
            code: -32000,
            message: 'cannot start "/bin/sh": No such file or directory',
            data: { kind: "spawn_failed" },
          },
        }),
      },
    },
  });
  await assert.rejects(
    backend.launch(request()),
    (error) =>
      error.kind === "spawn_failed" && /cannot start/.test(error.message),
  );
  assert.equal(methods(core).includes("terminal.kill"), false);
  assert.equal((await backend.detect()).available, true);
  await settle();
  assert.equal(core.subscriberCount, 0);
});

test("launch: an unanswered create ends the terminal herdr-core made anyway and cools down", async (t) => {
  let clock = 1_000;
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          run();
          return "drop";
        },
      },
    },
    requestDeadlineMs: 50,
    cooldownMs: 60_000,
    now: () => clock,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.equal(core.terminals.has("t2"), false, "the orphan was removed");
  assert.deepEqual(core.requests.slice(-2), [
    { method: "terminal.kill", params: { terminal: "t2" } },
    { method: "terminal.rm", params: { terminal: "t2" } },
  ]);

  const cooling = await backend.detect();
  assert.equal(cooling.available, false);
  assert.match(cooling.reason, /cooling down for 60s/);
  await assert.rejects(backend.launch(request()), /cooling down/);

  clock += 60_000;
  assert.equal((await backend.detect()).available, true);
  await settle();
  assert.equal(core.subscriberCount, 0);
});

test("launch: a create whose connection drops after sending is collected like an unanswered one", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          run();
          return "hangup";
        },
      },
    },
  });
  await assert.rejects(
    backend.launch(request()),
    /closed the connection without answering/,
  );
  assert.equal(core.terminals.has("t2"), false, "the orphan was removed");
  assert.match((await backend.detect()).reason, /cooling down/);
});

test("launch: an orphan made after its created event was lost is found by its launch label", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          // The event stream goes first, then the core acts without answering.
          core.dropSubscribers();
          setTimeout(run, 30);
          return "drop";
        },
      },
    },
    requestDeadlineMs: 50,
    orphanGraceMs: 200,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.equal(core.terminals.has("t2"), false, "the orphan was removed");
  const [listed] = sent(core, "terminal.list");
  assert.deepEqual(Object.keys(listed.labels), [LAUNCH_LABEL]);
  assert.equal(listed.all, true);
});

test("launch: an orphan made late in the grace period, with the event stream gone, is still collected", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          core.dropSubscribers();
          // After the create has timed out, before the grace period ends.
          setTimeout(run, 120);
          return "drop";
        },
      },
    },
    requestDeadlineMs: 50,
    orphanGraceMs: 200,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.deepEqual(methods(core).slice(-3), [
    "terminal.get",
    "terminal.kill",
    "terminal.rm",
  ]);
  assert.equal(core.terminals.has("t2"), false, "the orphan was removed");
});

test("launch: an orphan that no longer carries the launch label is left alone", async (t) => {
  const { core, backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.run": (_params, { run }) => {
          const created = run();
          core.terminals.get(created.address).labels = {};
          return "drop";
        },
      },
    },
    requestDeadlineMs: 50,
    orphanGraceMs: 50,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.equal(core.terminals.get("t2").state, "live");
  assert.equal(methods(core).includes("terminal.kill"), false);
});

test("launch: an unanswered create that made nothing ends nothing", async (t) => {
  const { core, backend } = await setup(t, {
    fake: { hooks: { "terminal.run": () => "drop" } },
    requestDeadlineMs: 50,
    orphanGraceMs: 50,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.equal(methods(core).includes("terminal.kill"), false);
  assert.equal(methods(core).includes("terminal.rm"), false);
});

test("launch: secretPipePath is refused, not silently dropped", async (t) => {
  const { core, backend } = await setup(t);
  await assert.rejects(
    backend.launch(request({ secretPipePath: "/tmp/secret" })),
    /secretPipePath/,
  );
  assert.deepEqual(methods(core), []);
});

test("launch: outside herdr-core it refuses before touching anything", async () => {
  const backend = createHerdrCoreExecutionBackend({ env: {} });
  await assert.rejects(
    backend.launch(request()),
    /requires HC_TERMINAL_SOCKET and HC_TERMINAL_ID/,
  );
});

// ─── reconcile ────────────────────────────────────────────────────────────────

test("reconcile: reports a fresh look at the terminal: live, then its exit, then its absence", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const [live] = await lease.reconcile();
  assert.deepEqual([live.type, live.fact], ["unknown", "snapshot"]);
  core.exit("t2", { exitCode: 2 });
  const [finished] = await lease.reconcile();
  assert.deepEqual(
    [finished.type, finished.status, finished.signal, finished.snapshot],
    ["exited", 2, null, true],
  );
  core.terminals.delete("t2");
  const [gone] = await lease.reconcile();
  assert.deepEqual(
    [gone.type, gone.requested, gone.snapshot],
    ["surface_closed", false, true],
  );
});

test("reconcile: a lost event stream adds backend_disconnected", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  core.dropSubscribers();
  await settle();
  const facts = await lease.reconcile();
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["unknown", "backend_disconnected"],
  );
});

// ─── reattach ─────────────────────────────────────────────────────────────────

test("reattach: a live terminal is present, with a snapshot fact first", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  const result = await backend.reattach(lease.handle);
  assert.equal(result.status, "present");
  t.after(() => result.lease.release());
  assert.deepEqual(result.lease.handle.surface, {
    kind: "terminal",
    id: "t2",
  });
  const first = await nextEvent(result.lease);
  assert.deepEqual([first.type, first.fact], ["unknown", "snapshot"]);
  core.exit("t2");
  assert.equal((await nextEvent(result.lease)).type, "exited");
});

test("reattach: a finished terminal is still present, and says how it ended", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  core.exit("t2", { exitCode: 4 });
  const result = await backend.reattach(lease.handle);
  assert.equal(result.status, "present");
  t.after(() => result.lease.release());
  const [first, second] = [
    await nextEvent(result.lease),
    await nextEvent(result.lease),
  ];
  assert.deepEqual([first.type, first.fact], ["unknown", "snapshot"]);
  assert.deepEqual([second.type, second.status], ["exited", 4]);
});

test("reattach: a removed terminal is gone; a handle without a terminal is unknown", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  await backend.close(lease.handle, "delivered");
  assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
  const unknown = await backend.reattach({ ...lease.handle, data: null });
  assert.equal(unknown.status, "unknown");
  await settle();
  assert.equal(core.subscriberCount, 0);
});

test("reattach: another core's terminal at the same address is not ours", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  core.terminals.get("t2").labels = {};
  assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
});

// ─── close ────────────────────────────────────────────────────────────────────

test("close: ends and removes the owned terminal and is idempotent once it is gone", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  await backend.close(lease.handle, "delivered");
  assert.equal(core.terminals.has("t2"), false);
  await backend.close(lease.handle, "delivered");
  await backend.close({ ...lease.handle, data: null }, "delivered");
  assert.equal(sent(core, "terminal.kill").length, 1);
  assert.equal(sent(core, "terminal.rm").length, 1);
});

test("close: removes a terminal whose program already ended", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  core.exit("t2", { exitCode: 0 });
  await backend.close(lease.handle, "delivered");
  assert.equal(core.terminals.has("t2"), false);
});

test("close: never touches a terminal that does not carry the launch label", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  core.terminals.get("t2").labels = { [LAUNCH_LABEL]: "someone-else" };
  await backend.close(lease.handle, "delivered");
  assert.equal(core.terminals.get("t2").state, "live");
  assert.equal(methods(core).includes("terminal.kill"), false);
  assert.equal(methods(core).includes("terminal.rm"), false);
});

test("close: a handle that is refused does not mark the terminal's later removal as requested", async (t) => {
  const { core, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const stale = {
    ...lease.handle,
    data: { ...lease.handle.data, launch: "another-launch" },
  };
  await backend.close(stale, "delivered");
  assert.equal(core.terminals.get("t2").state, "live");
  core.emit("removed", "t2");
  core.terminals.delete("t2");
  const closed = await nextEvent(lease);
  assert.deepEqual([closed.type, closed.requested], ["surface_closed", false]);
});

test("close: a closed launch does not mark another launch at the same address as requested", async (t) => {
  const { core, backend } = await setup(t);
  const first = await backend.launch(request());
  await first.release();
  const record = { ...core.terminals.get("t2") };
  await backend.close(first.handle, "delivered");
  // Another core reuses the address for a terminal of another launch.
  core.terminals.set("t2", {
    ...record,
    labels: { [LAUNCH_LABEL]: "second-launch" },
  });
  const reattached = await backend.reattach({
    ...first.handle,
    data: { ...first.handle.data, launch: "second-launch" },
  });
  assert.equal(reattached.status, "present");
  t.after(() => reattached.lease.release());
  const iterator = reattached.lease.events[Symbol.asyncIterator]();
  await iterator.next(); // the reattach snapshot
  core.emit("removed", "t2");
  core.terminals.delete("t2");
  const closed = (await iterator.next()).value;
  assert.deepEqual([closed.type, closed.requested], ["surface_closed", false]);
});

test("close: any other herdr-core error propagates", async (t) => {
  const { backend } = await setup(t, {
    fake: {
      hooks: {
        "terminal.rm": () => ({
          error: { code: -32000, message: "busy", data: { kind: "internal" } },
        }),
      },
    },
  });
  const lease = await backend.launch(request());
  await lease.release();
  await assert.rejects(backend.close(lease.handle, "delivered"), /busy/);
});
