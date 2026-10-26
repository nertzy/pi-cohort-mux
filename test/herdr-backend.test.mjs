/**
 * herdr execution backend against the fake herdr server: detection, both
 * placements, the environment hand-off, event translation, rollback, the
 * create cool-down, orphan collection, reconcile, reattach, and close.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHerdrExecutionBackend } from "pi-cohort-mux-herdr/execution-backend";

import { startFakeHerdr } from "./fixtures/fake-herdr/server.mjs";

const LAUNCHER = fileURLToPath(
  new URL(
    "../packages/pi-cohort-mux-herdr/src/pane-launch.sh",
    import.meta.url,
  ),
);
const BOOTSTRAP = fileURLToPath(
  new URL("../packages/pi-cohort-mux/src/env-bootstrap.sh", import.meta.url),
);

async function setup(t, { fake = {}, ...options } = {}) {
  const herdr = await startFakeHerdr(fake);
  t.after(() => herdr.close());
  const backend = createHerdrExecutionBackend({ env: herdr.env, ...options });
  return { herdr, backend };
}

const request = (overrides = {}) => ({
  command: "/usr/local/bin/child-host",
  args: ["--session", "it's session.jsonl"],
  cwd: "/work/project",
  environment: {
    SAFE: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: "/parent.sock",
  },
  runId: "run-1",
  childId: "child-1",
  signal: new AbortController().signal,
  awareness: { title: "delegate" },
  ...overrides,
});

const methods = (herdr) => herdr.requests.map((r) => r.method);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function nextEvent(lease) {
  const result = await lease.events[Symbol.asyncIterator]().next();
  return result.value;
}

// ─── detect ───────────────────────────────────────────────────────────────────

test("detect: outside a herdr pane the backend is unavailable and says why", async () => {
  const backend = createHerdrExecutionBackend({ env: {} });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.equal(detection.version, "");
  assert.deepEqual(detection.capabilities, []);
  assert.match(
    detection.reason,
    /HERDR_ENV, HERDR_SOCKET_PATH, and HERDR_PANE_ID/,
  );
});

test("detect: inside a live herdr pane it reports herdr's version and capabilities", async (t) => {
  const { herdr, backend } = await setup(t);
  assert.deepEqual(await backend.detect(), {
    available: true,
    version: "0.9.5",
    capabilities: ["live_handoff", "health_check"],
  });
  assert.deepEqual(methods(herdr), ["ping", "pane.get"]);
});

test("detect: a stale HERDR_PANE_ID is unavailable after one read-only probe", async (t) => {
  const herdr = await startFakeHerdr();
  t.after(() => herdr.close());
  const backend = createHerdrExecutionBackend({
    env: { ...herdr.env, HERDR_PANE_ID: "w1:p9" },
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.equal(detection.reason, "HERDR_PANE_ID w1:p9 not found in herdr");
});

test("detect: an unreachable herdr socket is unavailable", async () => {
  const backend = createHerdrExecutionBackend({
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/no-such-herdr.sock",
      HERDR_PANE_ID: "w1:p1",
    },
  });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /herdr is unreachable/);
});

test("detect: an unknown placement is unavailable rather than guessed", async (t) => {
  const { backend } = await setup(t, { placement: "sideways" });
  const detection = await backend.detect();
  assert.equal(detection.available, false);
  assert.match(detection.reason, /placement "sideways".*"tab" or "split"/);
});

test("placement: PI_COHORT_MUX_HERDR_PLACEMENT selects it and defaults to tab", async (t) => {
  const herdr = await startFakeHerdr();
  t.after(() => herdr.close());
  const split = createHerdrExecutionBackend({
    env: { ...herdr.env, PI_COHORT_MUX_HERDR_PLACEMENT: "split" },
  });
  assert.equal(split.placement, "split");
  assert.equal(
    createHerdrExecutionBackend({ env: herdr.env }).placement,
    "tab",
  );
});

test("declares HERDR_* as surface-owned so attempts keep the pane's identity", () => {
  assert.deepEqual(
    createHerdrExecutionBackend({ env: {} }).surfaceEnvironmentPrefixes,
    ["HERDR_"],
  );
});

// ─── launch: tab placement ───────────────────────────────────────────────────

test("tab launch: subscribes first, then runs the launcher argv in a new background tab", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());

  assert.deepEqual(methods(herdr), [
    "events.subscribe",
    "pane.get",
    "layout.apply",
  ]);
  const apply = herdr.requests[2].params;
  assert.equal(apply.workspace_id, "w1");
  assert.equal(apply.focus, false);
  assert.equal(apply.tab_label, "delegate");
  const [shell, launcher, launchDir, fifo, cwd, bootstrap, ...child] =
    apply.root.command;
  assert.deepEqual(
    { type: apply.root.type, label: apply.root.label, cwd: apply.root.cwd },
    { type: "pane", label: "delegate", cwd: "/work/project" },
  );
  assert.equal(shell, "/bin/sh");
  assert.equal(launcher, LAUNCHER);
  assert.equal(fifo, `${launchDir}/environment.fifo`);
  assert.equal(cwd, "/work/project");
  assert.equal(bootstrap, BOOTSTRAP);
  assert.deepEqual(child, [
    "/usr/local/bin/child-host",
    "--session",
    "it's session.jsonl",
  ]);
});

test("tab launch: the environment goes only through the FIFO, without the parent's HERDR_* identity", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(
    request({ environment: { SECRET_TOKEN: "s3cret", HERDR_TAB_ID: "w1:t1" } }),
  );
  t.after(() => lease.release());
  assert.deepEqual(herdr.handoffs, [
    { paneId: "w1:p2", environment: "SECRET_TOKEN=s3cret\n" },
  ]);
  assert.doesNotMatch(JSON.stringify(herdr.requests), /s3cret/);
});

test("tab launch: returns an opaque, serializable handle naming the pane", async (t) => {
  const { backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  assert.deepEqual(lease.handle, {
    protocolVersion: 1,
    backend: "herdr",
    surface: { kind: "pane", id: "w1:p2" },
    display: { label: "herdr:w1:p2", hint: "herdr tab w1:t2, pane w1:p2" },
    data: {
      placement: "tab",
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:p2",
      cwd: "/work/project",
    },
  });
});

test("tab launch: labels default to pi and drop control characters", async (t) => {
  const { herdr, backend } = await setup(t);
  const plain = await backend.launch(request({ awareness: undefined }));
  const odd = await backend.launch(
    request({ awareness: { title: "evil\u001b[31m\nname" } }),
  );
  t.after(() => Promise.all([plain.release(), odd.release()]));
  const labels = herdr.requests
    .filter((r) => r.method === "layout.apply")
    .map((r) => r.params.tab_label);
  assert.deepEqual(labels, ["pi", "evil[31mname"]);
});

// ─── launch: split placement ─────────────────────────────────────────────────

test("split launch: the first child splits right of the caller, later ones stack below it", async (t) => {
  const { herdr, backend } = await setup(t, { placement: "split" });
  const first = await backend.launch(request());
  const second = await backend.launch(request());
  t.after(() => Promise.all([first.release(), second.release()]));
  const splits = herdr.requests
    .filter((r) => r.method === "pane.split")
    .map((r) => r.params);
  assert.deepEqual(splits, [
    {
      target_pane_id: "w1:p1",
      direction: "right",
      focus: false,
      cwd: "/work/project",
    },
    {
      target_pane_id: "w1:p2",
      direction: "down",
      focus: false,
      cwd: "/work/project",
    },
  ]);
  assert.equal(second.handle.data.placement, "split");
  assert.equal(second.handle.display.hint, "herdr pane w1:p3 (tab w1:t1)");
});

test("split launch: types the launcher into the login shell, unexported and kept as its parent", async (t) => {
  const { herdr, backend } = await setup(t, { placement: "split" });
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const { pane_id, text } = herdr.requests.find(
    (r) => r.method === "pane.send_text",
  ).params;
  assert.equal(pane_id, "w1:p2");
  // A leading space keeps it out of shell history; no exec, so the login
  // shell stays the parent and absorbs signals sent to its own pid; exit
  // closes the pane when the child ends.
  assert.match(text, /^ '\/bin\/sh' '/);
  assert.doesNotMatch(text, /\bexec\b/);
  assert.ok(text.endsWith("; exit\n"), JSON.stringify(text));
  assert.ok(text.includes(`'it'"'"'s session.jsonl'`));
  assert.deepEqual(
    herdr.requests.find((r) => r.method === "pane.rename").params,
    { pane_id: "w1:p2", label: "delegate" },
  );
  assert.deepEqual(herdr.handoffs, [
    { paneId: "w1:p2", environment: "SAFE=1\n" },
  ]);
});

test("split launch: stacks from the caller again once the previous child is gone", async (t) => {
  const { herdr, backend } = await setup(t, { placement: "split" });
  const first = await backend.launch(request());
  await first.release();
  herdr.exit("w1:p2");
  const second = await backend.launch(request());
  t.after(() => second.release());
  const last = herdr.requests.filter((r) => r.method === "pane.split").at(-1);
  assert.deepEqual(
    { target: last.params.target_pane_id, direction: last.params.direction },
    { target: "w1:p1", direction: "right" },
  );
});

test("split launch: stacks below the newest live child when a later one is gone", async (t) => {
  const { herdr, backend } = await setup(t, { placement: "split" });
  const first = await backend.launch(request());
  const second = await backend.launch(request());
  await second.release();
  herdr.exit("w1:p3");
  const third = await backend.launch(request());
  await third.release();
  herdr.exit("w1:p4");
  const fourth = await backend.launch(request());
  t.after(() => Promise.all([first.release(), fourth.release()]));
  const splits = herdr.requests.filter((r) => r.method === "pane.split");
  assert.deepEqual(
    splits.slice(2).map((r) => [r.params.target_pane_id, r.params.direction]),
    [
      ["w1:p2", "down"],
      ["w1:p2", "down"],
    ],
  );
  const probesOfGone = herdr.requests.filter(
    (r) => r.method === "pane.get" && r.params.pane_id === "w1:p3",
  );
  assert.equal(probesOfGone.length, 1, "a gone child is forgotten once found");
});

test("split launch: an unanswered split closes the pane named in herdr's late answer and cools down", async (t) => {
  let clock = 1_000;
  let splits = 0;
  const { herdr, backend } = await setup(t, {
    placement: "split",
    fake: {
      hooks: {
        "pane.split": () => (splits++ === 0 ? { delayMs: 100 } : undefined),
      },
    },
    requestDeadlineMs: 50,
    orphanGraceMs: 1_000,
    now: () => clock,
  });
  await assert.rejects(backend.launch(request()), /did not answer within 50ms/);
  assert.equal(herdr.panes.has("w1:p2"), false, "the orphan pane was closed");
  assert.deepEqual(herdr.requests.at(-1), {
    method: "pane.close",
    params: { pane_id: "w1:p2" },
  });
  assert.equal(methods(herdr).includes("pane.send_text"), false);
  assert.match((await backend.detect()).reason, /cooling down/);
  clock += 60_000;
  const next = await backend.launch(request());
  t.after(() => next.release());
  const last = herdr.requests.filter((r) => r.method === "pane.split").at(-1);
  assert.equal(
    last.params.target_pane_id,
    "w1:p1",
    "the orphan is not stacked on",
  );
});

test("split launch: refuses a backslash a fish login shell would misread, before creating anything", async (t) => {
  const { herdr, backend } = await setup(t, { placement: "split" });
  await assert.rejects(
    backend.launch(request({ args: ["C:\\path"] })),
    /backslash/,
  );
  assert.deepEqual(methods(herdr), []);
});

test("split launch: a failed send_text closes exactly the pane it split", async (t) => {
  const { herdr, backend } = await setup(t, {
    placement: "split",
    fake: {
      hooks: {
        "pane.send_text": () => ({
          error: { code: "internal", message: "pty gone" },
        }),
      },
    },
  });
  await assert.rejects(backend.launch(request()), /pty gone/);
  assert.equal(herdr.panes.has("w1:p2"), false);
  assert.deepEqual(
    herdr.requests.find((r) => r.method === "pane.close").params,
    { pane_id: "w1:p2" },
  );
  await settle();
  assert.equal(herdr.subscriberCount, 0);
});

// ─── events ───────────────────────────────────────────────────────────────────

test("events: the lease reports its own pane's exit and ignores other panes", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  herdr.emit("pane_closed", { pane_id: "w1:p99", workspace_id: "w1" });
  herdr.emit("pane_moved", movedFrame("w1:p98", "w1:p97"));
  herdr.emit("workspace_closed", { workspace_id: "w2" });
  herdr.exit("w1:p2");
  const event = await nextEvent(lease);
  assert.equal(typeof event.timestamp, "number");
  assert.deepEqual(
    { ...event, timestamp: 0 },
    {
      type: "exited",
      status: null,
      signal: null,
      source: "mux",
      surface: { kind: "pane", id: "w1:p2" },
      timestamp: 0,
    },
  );
});

// herdr 0.9.5's pushed pane_moved payload (src/api/schema/events.rs).
const movedFrame = (previous, next) => ({
  previous_pane_id: previous,
  previous_workspace_id: previous.split(":")[0],
  previous_tab_id: `${previous.split(":")[0]}:t2`,
  pane: {
    pane_id: next,
    workspace_id: next.split(":")[0],
    tab_id: `${next.split(":")[0]}:t1`,
  },
});

test("events: a move of the owned pane is reported, and the pane is followed to its new id", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  herdr.emit("pane_moved", movedFrame("w1:p2", "w2:p5"));
  const moved = await nextEvent(lease);
  assert.equal(moved.type, "unknown");
  assert.equal(moved.fact, "herdr_event");
  assert.match(moved.reason, /pane moved from w1:p2 to w2:p5/);
  herdr.emit("workspace_closed", { workspace_id: "w1" });
  herdr.emit("pane_exited", { pane_id: "w2:p5", workspace_id: "w2" });
  const exited = await nextEvent(lease);
  assert.equal(exited.type, "exited", "the old workspace closing is not ours");
});

test("events: a pane closed by someone else is unrequested; one closed through close() is requested", async (t) => {
  const { herdr, backend } = await setup(t);
  const ours = await backend.launch(request());
  const theirs = await backend.launch(request());
  t.after(() => Promise.all([ours.release(), theirs.release()]));
  herdr.emit("pane_closed", { pane_id: "w1:p3", workspace_id: "w1" });
  herdr.panes.delete("w1:p3");
  await backend.close(ours.handle, "explicit_cleanup");
  const [closedByOthers, closedByUs] = [
    await nextEvent(theirs),
    await nextEvent(ours),
  ];
  assert.equal(closedByOthers.type, "surface_closed");
  assert.equal(closedByOthers.requested, false);
  assert.equal(closedByUs.type, "surface_closed");
  assert.equal(closedByUs.requested, true);
});

test("events: closing the caller's workspace closes the child's surface", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  herdr.emit("workspace_closed", { workspace_id: "w2" });
  herdr.emit("workspace_closed", { workspace_id: "w1" });
  const event = await nextEvent(lease);
  assert.deepEqual([event.type, event.requested], ["surface_closed", false]);
});

test("events: a herdr stream that ends on its own reports backend_disconnected", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  herdr.dropSubscribers();
  const event = await nextEvent(lease);
  assert.equal(event.type, "backend_disconnected");
  assert.match(event.reason, /ended unexpectedly/);
});

test("release: stops observing without closing the pane", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  await settle();
  assert.equal(herdr.subscriberCount, 0);
  assert.equal(herdr.panes.has("w1:p2"), true);
  assert.equal(methods(herdr).includes("pane.close"), false);
});

// ─── launch failures ─────────────────────────────────────────────────────────

test("launch: a child that never reads its environment is rolled back by exact pane", async (t) => {
  const { herdr, backend } = await setup(t, {
    fake: { child: "none" },
    handoffDeadlineMs: 50,
  });
  await assert.rejects(
    backend.launch(request()),
    /environment hand-off did not complete within 50ms/,
  );
  assert.equal(herdr.panes.has("w1:p2"), false);
  assert.deepEqual(herdr.requests.at(-1), {
    method: "pane.close",
    params: { pane_id: "w1:p2" },
  });
  await settle();
  assert.equal(herdr.subscriberCount, 0);
});

test("launch: an error herdr reports means nothing was created, and starts no cool-down", async (t) => {
  const { herdr, backend } = await setup(t, {
    fake: {
      hooks: {
        "layout.apply": () => ({
          error: {
            code: "workspace_not_found",
            message: "workspace w1 not found",
          },
        }),
      },
    },
  });
  await assert.rejects(backend.launch(request()), /workspace w1 not found/);
  assert.equal(methods(herdr).includes("pane.close"), false);
  assert.equal((await backend.detect()).available, true);
  await settle();
  assert.equal(herdr.subscriberCount, 0);
});

test("launch: an unanswered create closes the pane herdr made anyway and cools down", async (t) => {
  let clock = 1_000;
  const { herdr, backend } = await setup(t, {
    fake: {
      child: "orphan",
      hooks: {
        "layout.apply": (_params, { run }) => {
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
  assert.equal(herdr.panes.has("w1:p2"), false, "the orphan pane was closed");
  assert.deepEqual(herdr.requests.at(-1), {
    method: "pane.close",
    params: { pane_id: "w1:p2" },
  });

  const cooling = await backend.detect();
  assert.equal(cooling.available, false);
  assert.match(cooling.reason, /cooling down for 60s/);
  await assert.rejects(backend.launch(request()), /cooling down/);

  clock += 60_000;
  assert.equal((await backend.detect()).available, true);
});

test("launch: a create whose connection drops after sending is collected like an unanswered one", async (t) => {
  const { herdr, backend } = await setup(t, {
    fake: {
      child: "orphan",
      hooks: {
        "layout.apply": (_params, { run }) => {
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
  assert.equal(herdr.panes.has("w1:p2"), false, "the orphan pane was closed");
  assert.match((await backend.detect()).reason, /cooling down/);
});

test("launch: secretPipePath is refused, not silently dropped", async (t) => {
  const { herdr, backend } = await setup(t);
  await assert.rejects(
    backend.launch(request({ secretPipePath: "/tmp/secret" })),
    /secretPipePath/,
  );
  assert.deepEqual(methods(herdr), []);
});

test("launch: outside herdr it refuses before touching anything", async () => {
  const backend = createHerdrExecutionBackend({ env: {} });
  await assert.rejects(backend.launch(request()), /requires HERDR_SOCKET_PATH/);
});

// ─── reconcile ────────────────────────────────────────────────────────────────

test("reconcile: reports a fresh look at the pane, then its absence after exit", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  const [present] = await lease.reconcile();
  assert.deepEqual([present.type, present.fact], ["unknown", "snapshot"]);
  herdr.panes.delete("w1:p2");
  const [gone] = await lease.reconcile();
  assert.deepEqual(
    [gone.type, gone.requested, gone.snapshot],
    ["surface_closed", false, true],
  );
});

test("reconcile: a lost event stream adds backend_disconnected", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  t.after(() => lease.release());
  herdr.dropSubscribers();
  await settle();
  const facts = await lease.reconcile();
  assert.deepEqual(
    facts.map((fact) => fact.type),
    ["unknown", "backend_disconnected"],
  );
});

// ─── reattach ─────────────────────────────────────────────────────────────────

test("reattach: a live pane is present, with a snapshot fact first", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  const result = await backend.reattach(lease.handle);
  assert.equal(result.status, "present");
  t.after(() => result.lease.release());
  assert.deepEqual(result.lease.handle.surface, { kind: "pane", id: "w1:p2" });
  const first = await nextEvent(result.lease);
  assert.deepEqual([first.type, first.fact], ["unknown", "snapshot"]);
  herdr.exit("w1:p2");
  assert.equal((await nextEvent(result.lease)).type, "exited");
});

test("reattach: an exited pane is gone; a handle without a pane is unknown", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  herdr.exit("w1:p2");
  assert.deepEqual(await backend.reattach(lease.handle), { status: "gone" });
  const unknown = await backend.reattach({ ...lease.handle, data: null });
  assert.equal(unknown.status, "unknown");
  await settle();
  assert.equal(herdr.subscriberCount, 0);
});

// ─── close ────────────────────────────────────────────────────────────────────

test("close: closes the owned pane and is idempotent once it is gone", async (t) => {
  const { herdr, backend } = await setup(t);
  const lease = await backend.launch(request());
  await lease.release();
  await backend.close(lease.handle, "delivered");
  assert.equal(herdr.panes.has("w1:p2"), false);
  await backend.close(lease.handle, "delivered");
  await backend.close({ ...lease.handle, data: null }, "delivered");
  assert.deepEqual(
    herdr.requests.filter((r) => r.method === "pane.close").length,
    2,
  );
});

test("close: any other herdr error propagates", async (t) => {
  const { backend } = await setup(t, {
    fake: {
      hooks: {
        "pane.close": () => ({ error: { code: "internal", message: "busy" } }),
      },
    },
  });
  const lease = await backend.launch(request());
  await lease.release();
  await assert.rejects(backend.close(lease.handle, "delivered"), /busy/);
});
