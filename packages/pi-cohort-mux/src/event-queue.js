/**
 * Event queue for execution backend leases.
 *
 * Implements the overflow/coalescing/suspension contract from the SPI:
 *
 * - no_observed_activity advisories coalesce when the queue tail is the same
 *   advisory type (preserves first + most-recent; intermediate markers drop).
 * - When the queue holds ≥ 3 facts and a non-coalescing incoming fact arrives,
 *   the incoming fact is saved as the lostAuthoritativeFact and an overflow
 *   marker is appended; the queue suspends further pushes.
 * - Suspension lifts only through the caller invoking resumeFromSuspension()
 *   (after delivering the lost fact via reconcile()).
 * - finish() releases the async iterator without closing the underlying surface.
 */
export function createEventQueue(initial = []) {
  const queue = [...initial];
  let suspended = false;
  let released = false;
  let lostAuthoritativeFact;
  let waiter;

  function push(event) {
    if (suspended) return;
    if (
      queue.length >= 2 &&
      event.type === "no_observed_activity" &&
      queue.at(-1)?.type === "no_observed_activity"
    ) {
      // Replace the tail advisory with the fresher one.
      queue[queue.length - 1] = event;
    } else if (queue.length >= 3) {
      lostAuthoritativeFact = event;
      queue.push({ type: "unknown", fact: "event_stream", reason: "overflow" });
      suspended = true;
    } else {
      queue.push(event);
    }
    if (waiter && queue.length) {
      const resolve = waiter;
      waiter = undefined;
      resolve({ value: queue.shift(), done: false });
    }
  }

  function finish() {
    if (released) return;
    released = true;
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve({ done: true });
    }
  }

  function resumeFromSuspension() {
    suspended = false;
  }

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
    events,
    push,
    finish,
    resumeFromSuspension,
    get suspended() { return suspended; },
    get released() { return released; },
    get queuedEvents() { return [...queue]; },
    get lostAuthoritativeFact() { return lostAuthoritativeFact; },
  };
}
