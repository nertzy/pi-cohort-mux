import assert from "node:assert/strict";
import test from "node:test";
import { createFakeScheduler, createMachine } from "./fixtures/lifecycle/state-machine.mjs";

function machine() {
  const scheduler = createFakeScheduler();
  return { scheduler, state: createMachine({ scheduler }) };
}

function send(state, type, detail = {}) {
  return state.dispatch({ type, ...detail });
}

test("surface_created is not readiness", () => {
  const { state } = machine();

  send(state, "surface_created");

  assert.equal(state.snapshot().phase, "awaiting_ready");
  assert.equal(state.snapshot().facts.ready, undefined);
});

test("authoritative exit before ready is startup_failed and preserves exit evidence", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "exited", { status: 23, signal: null });

  assert.equal(state.snapshot().phase, "startup_failed");
  assert.deepEqual(state.snapshot().facts.exited, { status: 23, signal: null });
});

test("surface closure before ready is not a crash", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "surface_closed", { requested: false });

  assert.equal(state.snapshot().phase, "surface_closed_before_ready");
  assert.equal(state.snapshot().intent, "retain");
});

test("ready deadline records blocked_before_ready without terminal parsing", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  scheduler.fire("ready");

  assert.equal(state.snapshot().phase, "blocked_before_ready");
  assert.equal(state.snapshot().intent, "retain");
  assert.equal(JSON.stringify(state.snapshot()).match(/mise|direnv|credential/i), null);
});

test("late authoritative ready recovers a missing-ready deadline while the surface remains valid", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  scheduler.fire("ready");
  send(state, "ready");

  assert.equal(state.snapshot().phase, "running");
  assert.equal(state.snapshot().facts.readyDeadline, undefined);
  assert.equal(state.snapshot().intent, "retain");
});

test("control disconnect reconciles exactly once and never declares death", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "backend_disconnected", { source: "control" });
  send(state, "backend_disconnected", { source: "control" });

  assert.equal(state.snapshot().phase, "control_disconnected");
  assert.equal(state.snapshot().reconciliations.control, 1);
  assert.equal(state.snapshot().intent, "retain");
});

test("mux disconnect invalidates only mux facts", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "progress", { value: "working" });
  send(state, "backend_disconnected", { source: "mux" });

  assert.equal(state.snapshot().facts.mux, "unknown");
  assert.equal(state.snapshot().facts.ready, true);
  assert.equal(state.snapshot().facts.progress, "working");
});

test("advisory inactivity needs attention but never claims a hang or kills", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  send(state, "ready");
  scheduler.fire("activity");

  assert.equal(state.snapshot().phase, "needs_attention");
  assert.equal(state.snapshot().facts.activity, "no_observed_activity");
  assert.equal(state.snapshot().intent, "retain");
  assert.equal(JSON.stringify(state.snapshot()).match(/hung|healthy|dead|kill/i), null);
});

test("an observed mux inactivity fact has the same advisory classification", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "no_observed_activity");

  assert.equal(state.snapshot().phase, "needs_attention");
  assert.equal(state.snapshot().facts.activity, "no_observed_activity");
});

test("structured activity clears advisory inactivity before replacing its deadline", () => {
  for (const [type, detail] of [
    ["ready", {}],
    ["progress", { value: "working" }],
    ["result", { value: "done" }],
  ]) {
    const { state, scheduler } = machine();
    send(state, "surface_created");
    send(state, "ready");
    scheduler.fire("activity");
    send(state, type, detail);

    assert.notEqual(state.snapshot().phase, "needs_attention");
    assert.equal(state.snapshot().facts.activity, undefined);
    assert.equal(scheduler.count(), 1);
  }
});

test("result and settled win over later surface closure as a delivery candidate", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "result", { value: { answer: "done" } });
  send(state, "settled");
  send(state, "surface_closed", { requested: false });

  assert.equal(state.snapshot().phase, "delivery_candidate");
  assert.deepEqual(state.snapshot().facts.result, { answer: "done" });
  assert.equal(state.snapshot().intent, "close_after_delivery");
});

test("settled without result becomes taken_over after a grace deadline", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "settled");
  scheduler.fire("settled_result");

  assert.equal(state.snapshot().phase, "taken_over");
  assert.equal(state.snapshot().intent, "retain");
  assert.equal(state.snapshot().retainWorktree, true);
});

test("exit before settled is child_crashed with no model fallback", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "exited", { status: 1, signal: null });

  assert.equal(state.snapshot().phase, "child_crashed");
  assert.equal("modelFallback" in state.snapshot(), false);
});

test("shutdown deadline without exit retains exit_unknown and does not synthesize evidence", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "shutdown_after_delivery");
  send(state, "shutdown_ack");
  scheduler.fire("exit_after_shutdown");

  assert.equal(state.snapshot().phase, "exit_unknown");
  assert.equal(state.snapshot().facts.exited, undefined);
  assert.equal(state.snapshot().intent, "retain");
});

test("explicit adapter close is requested closure rather than child failure", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "explicit_close");
  send(state, "surface_closed", { requested: true });

  assert.equal(state.snapshot().phase, "requested_closure");
  assert.equal(state.snapshot().intent, "close");
});

test("interrupt acknowledgment pauses and retains the run", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "interrupt");
  send(state, "interrupt_ack");

  assert.equal(state.snapshot().phase, "paused");
  assert.equal(state.snapshot().intent, "retain");
});

test("paused calls remain paused after a late result and settlement", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "interrupt_ack");
  send(state, "result", { value: "late" });
  send(state, "settled");

  assert.equal(state.snapshot().phase, "paused");
  assert.equal(state.snapshot().intent, "retain");
  assert.equal(state.snapshot().facts.result, "late");
  assert.equal(state.snapshot().facts.settled, true);
  assert.deepEqual(state.snapshot().provenance.slice(-2).map((fact) => fact.type), ["result", "settled"]);
});

test("requested closures remain requested after a late result and settlement", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "explicit_close");
  send(state, "result", { value: "late" });
  send(state, "settled");

  assert.equal(state.snapshot().phase, "requested_closure");
  assert.equal(state.snapshot().intent, "close");
  assert.equal(state.snapshot().facts.result, "late");
  assert.equal(state.snapshot().facts.settled, true);
  assert.deepEqual(state.snapshot().provenance.slice(-2).map((fact) => fact.type), ["result", "settled"]);
});

test("taken-over calls remain taken over after a late result", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "settled");
  scheduler.fire("settled_result");
  send(state, "result", { value: "late" });

  assert.equal(state.snapshot().phase, "taken_over");
  assert.equal(state.snapshot().intent, "retain");
  assert.equal(state.snapshot().facts.result, "late");
  assert.equal(state.snapshot().provenance.at(-1).type, "result");
});

test("observed exit after interrupt acknowledgment remains paused and retains exit provenance", () => {
  const { state } = machine();
  send(state, "surface_created");
  send(state, "ready");
  send(state, "interrupt");
  send(state, "interrupt_ack");
  send(state, "exited", { status: 0, signal: null });

  assert.equal(state.snapshot().phase, "paused");
  assert.equal(state.snapshot().intent, "retain");
  assert.deepEqual(state.snapshot().facts.exited, { status: 0, signal: null });
  assert.equal(state.snapshot().provenance.at(-1).type, "exited");
});

test("structured activity replaces one advisory deadline without periodic timers", () => {
  const { state, scheduler } = machine();
  send(state, "surface_created");
  send(state, "ready");
  assert.equal(scheduler.count(), 1);
  send(state, "progress", { value: "one" });
  assert.equal(scheduler.count(), 1);
  assert.equal(scheduler.replacements("activity"), 1);
  send(state, "result", { value: "two" });
  assert.equal(scheduler.count(), 1);
  assert.equal(scheduler.replacements("activity"), 2);
});

test("race table preserves fact provenance, reconciliation, and close intent", () => {
  const races = [
    { events: [["exited", { status: 1, signal: null }], ["surface_closed", { requested: false }]], phase: "startup_failed", intent: "retain", source: "mux" },
    { events: [["surface_closed", { requested: false }], ["exited", { status: 1, signal: null }]], phase: "startup_failed", intent: "retain", source: "mux" },
    { events: [["result", { value: "ok" }], ["settled"], ["surface_closed", { requested: false }]], phase: "delivery_candidate", intent: "close_after_delivery", source: "mux" },
    { events: [["surface_closed", { requested: false }], ["result", { value: "ok" }], ["settled"]], phase: "delivery_candidate", intent: "close_after_delivery", source: "mux" },
    { events: [["backend_disconnected", { source: "control" }], ["backend_disconnected", { source: "control" }]], phase: "control_disconnected", intent: "retain", source: "control" },
  ];

  for (const race of races) {
    const { state } = machine();
    send(state, "surface_created");
    for (const [type, detail] of race.events) send(state, type, detail);
    const snapshot = state.snapshot();
    assert.equal(snapshot.phase, race.phase);
    assert.equal(snapshot.intent, race.intent);
    assert.ok(snapshot.provenance.some((fact) => fact.source === race.source));
    assert.ok((snapshot.reconciliations.control ?? 0) <= 1);
  }
});
