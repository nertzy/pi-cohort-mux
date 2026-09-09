export const protocolVersion = 1;

export function createConformanceBackend() {
  const state = {
    trace: [], closed: new Set(), launches: [], releaseCount: 0,
    subscriptions: 0, reconciles: 0, lastRequest: undefined,
  };
  const backend = {
    name: "deterministic-mux",
    protocolVersion,
    state,
    async detect() {
      return { available: true, version: "test-1", capabilities: ["launch", "reattach", "close"] };
    },
    async launch(request) {
      state.trace.push("observe", "start");
      state.lastRequest = request;
      state.launches.push(request);
      const initial = request.immediateExit
        ? [{ type: "exited", status: 0, signal: null, source: "mux", surfaceId: `surface-${state.launches.length}` }]
        : [];
      return lease(state, request, { id: `surface-${state.launches.length}` }, initial);
    },
    async reattach(handle) {
      if (handle.id === "gone") return { status: "gone" };
      if (handle.id === "unknown") return { status: "unknown", reason: "native unavailable" };
      const result = lease(state, {}, handle, [{ type: "surface_closed", requested: false, snapshot: true }]);
      result.push({ type: "exited", status: 0, signal: null, live: true });
      return { status: "present", lease: result };
    },
    async close(handle) { state.closed.add(handle.id); },
  };
  return backend;
}

function lease(state, request, identity, initial = []) {
  const queue = [...initial];
  let suspended = false;
  let released = false;
  let lostAuthoritativeFact;
  let waiter;
  state.subscriptions += 1;
  const handle = {
    backend: "deterministic-mux", protocolVersion, kind: "pane", id: identity.id,
    display: `test:${identity.id}`, reattach: { nativeId: identity.id },
  };
  const finish = () => {
    if (released) return;
    released = true;
    state.releaseCount += 1;
    waiter?.({ done: true });
  };
  const events = {
    async next() {
      if (queue.length) return { value: queue.shift(), done: false };
      if (released) return { done: true };
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() { finish(); return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
  return {
    handle, events,
    async reconcile() {
      state.reconciles += 1;
      const facts = lostAuthoritativeFact
        ? [{ ...lostAuthoritativeFact, source: "mux", surfaceId: identity.id, snapshot: true }]
        : [{ type: "unknown", fact: "snapshot", reason: "native snapshot" }];
      suspended = false;
      return facts;
    },
    async release() { finish(); },
    push(event) {
      if (suspended) return;
      if (
        queue.length >= 2
        && event.type === "no_observed_activity"
        && queue.at(-1)?.type === "no_observed_activity"
      ) {
        queue[queue.length - 1] = event;
      } else if (queue.length >= 3) {
        lostAuthoritativeFact = event;
        queue.push({ type: "unknown", fact: "event_stream", reason: "overflow" });
        suspended = true;
      } else queue.push(event);
      if (waiter && queue.length) { const resolve = waiter; waiter = undefined; resolve({ value: queue.shift(), done: false }); }
    },
    get suspended() { return suspended; },
    get released() { return released; },
    get queuedEvents() { return [...queue]; },
    request,
  };
}
