/**
 * herdr socket API client.
 *
 * herdr speaks newline-delimited JSON over a Unix socket. A plain request gets
 * one response line and herdr then closes the connection, so every request
 * opens its own. events.subscribe keeps its connection open: herdr
 * acknowledges with {"type":"subscription_started"}, then pushes
 * {"event","data"} frames. Every wait here is bounded or abortable.
 */
import { createConnection } from "node:net";

let nextId = 0;

/** A structured herdr error response, e.g. code "pane_not_found". */
export class HerdrError extends Error {
  constructor(method, { code, message }) {
    super(`herdr ${method}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
  }
}

const abortError = (signal) =>
  signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : Object.assign(new Error("herdr request aborted"), { name: "AbortError" });

/** Read newline-delimited JSON from a socket, one parsed value per line. */
function readLines(socket, onLine) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (
      let newline = buffer.indexOf("\n");
      newline >= 0;
      newline = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      onLine(value);
    }
  });
}

const requestLine = (method, params) =>
  `${JSON.stringify({ id: `pi-cohort-mux-${++nextId}`, method, params })}\n`;

/**
 * Send one request and resolve its result. Rejects with a HerdrError for an
 * error response, an error with `timedOut` when herdr does not answer within
 * `timeout`, an AbortError when `signal` aborts, or the connection's error.
 * A connection failure after the request was written carries
 * `requestSent: true`: herdr may have acted on it.
 *
 * With `onLateResult`, a request given up on by timeout or abort keeps
 * listening for up to `lateMs`; a result herdr sends in that window is
 * passed to onLateResult, so a caller can undo what herdr did anyway.
 */
export function herdrRequest(
  socketPath,
  method,
  params = {},
  { timeout = 10_000, signal, onLateResult, lateMs = 0 } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const socket = createConnection(socketPath);
    let sent = false;
    let settled = false;
    let lateTimer;
    const settle = (outcome, value, { awaitLate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (awaitLate && sent && onLateResult && lateMs > 0) {
        lateTimer = setTimeout(() => socket.destroy(), lateMs);
      } else {
        socket.destroy();
      }
      outcome(value);
    };
    const afterSend = (error) =>
      sent ? Object.assign(error, { requestSent: true }) : error;
    const timer = setTimeout(
      () =>
        settle(
          reject,
          Object.assign(
            new Error(`herdr ${method} did not answer within ${timeout}ms`),
            { timedOut: true },
          ),
          { awaitLate: true },
        ),
      timeout,
    );
    const onAbort = () =>
      settle(reject, abortError(signal), { awaitLate: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => {
      socket.write(requestLine(method, params));
      sent = true;
    });
    readLines(socket, (response) => {
      if (settled) {
        clearTimeout(lateTimer);
        socket.destroy();
        if (lateTimer && !response.error) onLateResult(response.result);
        return;
      }
      if (response.error)
        settle(reject, new HerdrError(method, response.error));
      else settle(resolve, response.result);
    });
    socket.on("error", (error) => settle(reject, afterSend(error)));
    socket.on("close", () => {
      clearTimeout(lateTimer);
      settle(
        reject,
        afterSend(
          new Error(`herdr closed the connection without answering ${method}`),
        ),
      );
    });
  });
}

/**
 * Subscribe to herdr events.
 *
 * Returns { ack, onFrame(listener), ended, stop() }. ack resolves once herdr
 * acknowledges. onFrame registers a (frame, error) listener; frames that
 * arrived before it are replayed, then a retained terminal error. Any end of
 * the stream other than stop() is a failure: observation is gone.
 */
export function subscribeHerdr(
  socketPath,
  kinds,
  { ackDeadline = 10_000 } = {},
) {
  const socket = createConnection(socketPath);
  let resolveAck;
  let rejectAck;
  const ack = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  let acknowledged = false;
  let stopping = false;
  let terminalError = null;
  let listener = null;
  const buffered = [];
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const failure = (error) => {
    if (terminalError || stopping) return;
    terminalError = error;
    rejectAck(error);
    listener?.(null, error);
  };

  socket.on("connect", () =>
    socket.write(
      requestLine("events.subscribe", {
        subscriptions: kinds.map((type) => ({ type })),
      }),
    ),
  );
  readLines(socket, (message) => {
    if (!acknowledged) {
      if (message.error)
        return failure(new HerdrError("events.subscribe", message.error));
      if (message.result?.type !== "subscription_started") return;
      acknowledged = true;
      return resolveAck(message.result);
    }
    if (!message.event) return;
    if (listener) listener(message);
    else buffered.push(message);
  });
  socket.on("error", failure);
  socket.on("close", () => {
    resolveClosed();
    failure(new Error("herdr event stream ended unexpectedly"));
  });

  const timer = setTimeout(
    () => rejectAck(new Error("herdr events.subscribe ack timed out")),
    ackDeadline,
  );
  const settledAck = ack.finally(() => clearTimeout(timer));
  settledAck.catch(() => {});

  return {
    ack: settledAck,
    onFrame(next) {
      listener = next;
      for (const frame of buffered.splice(0)) next(frame);
      if (terminalError) next(null, terminalError);
      return () => {
        if (listener === next) listener = null;
      };
    },
    /** True once the stream has ended on its own. */
    get ended() {
      return terminalError !== null;
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      socket.destroy();
      await closed;
    },
  };
}
