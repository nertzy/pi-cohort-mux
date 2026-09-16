export function createLease({ handle, request, eventQueue, reconcile, releaseTransport }) {
  let releasePromise;
  let cleanupCompleted = false;
  return {
    handle,
    request,
    events: eventQueue.events,
    async reconcile() {
      const facts = await reconcile(eventQueue.lostAuthoritativeFact);
      eventQueue.resumeFromSuspension();
      return facts;
    },
    release() {
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
      releasePromise.catch(() => { releasePromise = undefined; });
      return releasePromise;
    },
    push: eventQueue.push,
    get suspended() { return eventQueue.suspended; },
    get released() { return eventQueue.released; },
    get queuedEvents() { return eventQueue.queuedEvents; },
  };
}
