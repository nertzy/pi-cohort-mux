export function createLease({
  handle,
  request,
  eventQueue,
  reconcile,
  releaseTransport,
}) {
  let releasePromise;
  let cleanupCompleted = false;
  // Ending iteration (`for await` break, return()) releases the lease through
  // the same shared, retryable operation as release(); finishing the queue
  // alone would leave the transport running while `released` reports true.
  const events = {
    next: () => eventQueue.events.next(),
    async return() {
      eventQueue.finish();
      await release();
      return { done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  function release() {
    if (cleanupCompleted) return Promise.resolve();
    if (releasePromise) return releasePromise;

    releasePromise = (async () => {
      try {
        await releaseTransport?.();
        cleanupCompleted = true;
      } finally {
        // Consumers must never remain blocked merely because transport
        // cleanup failed. The failed cleanup itself remains retryable.
        eventQueue.finish();
      }
    })();
    releasePromise.catch(() => {
      releasePromise = undefined;
    });
    return releasePromise;
  }
  return {
    handle,
    request,
    events,
    async reconcile() {
      const lost = eventQueue.lostAuthoritativeFact;
      // Resume before the backend gathers fresh evidence, so nothing observed
      // while it does is dropped by a still-suspended queue.
      eventQueue.resumeFromSuspension();
      return reconcile(lost);
    },
    release,
    push: eventQueue.push,
    get suspended() {
      return eventQueue.suspended;
    },
    get released() {
      return eventQueue.released;
    },
    get queuedEvents() {
      return eventQueue.queuedEvents;
    },
  };
}
