// Fixture-only lifecycle spike. This is deliberately not an adapter or production API.
export function createFakeScheduler() {
  const timers = new Map();
  const replacementCounts = new Map();

  return {
    schedule(name, callback) {
      if (timers.has(name)) replacementCounts.set(name, (replacementCounts.get(name) ?? 0) + 1);
      timers.set(name, callback);
    },
    cancel(name) {
      timers.delete(name);
    },
    fire(name) {
      const callback = timers.get(name);
      timers.delete(name);
      callback?.();
    },
    count: () => timers.size,
    replacements: (name) => replacementCounts.get(name) ?? 0,
  };
}

const terminalPhases = new Set(["paused", "requested_closure", "result_missing"]);

const sourceFor = {
  surface_created: "mux",
  surface_closed: "mux",
  exited: "mux",
  backend_disconnected: "mux",
  no_observed_activity: "mux",
  ready: "control",
  settled: "control",
  interrupt_ack: "control",
  shutdown_ack: "control",
  progress: "session_log",
  result: "session_log",
  interrupt: "parent",
  shutdown_after_delivery: "parent",
  explicit_close: "parent",
};

export function createMachine({ scheduler }) {
  const state = {
    facts: {},
    provenance: [],
    reconciliations: {},
    phase: "created",
    intent: "retain",
  };

  const record = (event) => state.provenance.push({ type: event.type, source: event.source ?? sourceFor[event.type] });
  const activity = () => {
    delete state.facts.activity;
    scheduler.schedule("activity", () => {
      state.facts.activity = "no_observed_activity";
      derive();
    });
  };
  const derive = () => {
    // Terminal outcomes preserve their original-call classification as later facts arrive.
    if (terminalPhases.has(state.phase)) return;

    if (state.facts.result !== undefined && state.facts.settled) {
      state.phase = "delivery_candidate";
      state.intent = "close_after_delivery";
    } else if (state.facts.exitUnknown) {
      state.phase = "exit_unknown";
      state.intent = "retain";
    } else if (state.facts.interruptAck) {
      state.phase = "paused";
      state.intent = "retain";
    } else if (state.facts.exited) {
      state.phase = state.facts.ready ? "child_crashed" : "startup_failed";
      state.intent = "retain";
    } else if (state.facts.resultMissing) {
      state.phase = "result_missing";
      state.intent = "retain";
    } else if (state.facts.explicitClose) {
      state.phase = "requested_closure";
      state.intent = "close";
    } else if (state.facts.controlDisconnected) {
      state.phase = "control_disconnected";
      state.intent = "retain";
    } else if (state.facts.readyDeadline) {
      state.phase = "blocked_before_ready";
      state.intent = "retain";
    } else if (state.facts.surfaceClosed && !state.facts.ready) {
      state.phase = "surface_closed_before_ready";
      state.intent = "retain";
    } else if (state.facts.activity === "no_observed_activity") {
      state.phase = "needs_attention";
      state.intent = "retain";
    } else if (state.facts.ready) {
      state.phase = "running";
      state.intent = "retain";
    } else if (state.facts.surfaceCreated) {
      state.phase = "awaiting_ready";
      state.intent = "retain";
    }
  };

  const reconcileOnce = (source) => {
    if (state.reconciliations[source]) return;
    state.reconciliations[source] = 1;
  };

  const dispatch = (event) => {
    record(event);
    switch (event.type) {
      case "surface_created":
        state.facts.surfaceCreated = true;
        state.facts.mux = "observed";
        scheduler.schedule("ready", () => {
          state.facts.readyDeadline = true;
          derive();
        });
        break;
      case "surface_closed":
        state.facts.surfaceClosed = true;
        state.facts.surfaceCloseRequested = Boolean(event.requested);
        scheduler.cancel("ready");
        break;
      case "exited":
        state.facts.exited = { status: event.status, signal: event.signal };
        scheduler.cancel("ready");
        scheduler.cancel("activity");
        scheduler.cancel("exit_after_shutdown");
        break;
      case "backend_disconnected":
        if (event.source === "control") {
          state.facts.controlDisconnected = true;
          reconcileOnce("control");
        } else {
          state.facts.mux = "unknown";
          reconcileOnce("mux");
        }
        break;
      case "ready":
        state.facts.ready = true;
        if (!state.facts.surfaceClosed) delete state.facts.readyDeadline;
        scheduler.cancel("ready");
        activity();
        break;
      case "settled":
        state.facts.settled = true;
        if (state.facts.result === undefined) scheduler.schedule("settled_result", () => {
          state.facts.resultMissing = true;
          derive();
        });
        break;
      case "progress":
        state.facts.progress = event.value;
        activity();
        break;
      case "no_observed_activity":
        state.facts.activity = "no_observed_activity";
        break;
      case "result":
        state.facts.result = event.value;
        scheduler.cancel("settled_result");
        activity();
        break;
      case "shutdown_after_delivery":
        state.facts.shutdownRequested = true;
        break;
      case "shutdown_ack":
        state.facts.shutdownAck = true;
        if (state.facts.shutdownRequested) scheduler.schedule("exit_after_shutdown", () => {
          state.facts.exitUnknown = true;
          derive();
        });
        break;
      case "explicit_close":
        state.facts.explicitClose = true;
        break;
      case "interrupt_ack":
        state.facts.interruptAck = true;
        break;
      case "interrupt":
        break;
      default:
        throw new Error(`Unknown fixture event: ${event.type}`);
    }
    derive();
    return snapshot();
  };

  const snapshot = () => structuredClone(state);
  return { dispatch, snapshot };
}
