/**
 * herdr-core socket client.
 *
 * herdr-core speaks JSON-RPC 2.0, one message per line, over a Unix socket.
 * A connection stays open after an answer, so each request here opens its
 * own and closes it once answered. After events.subscribe a connection
 * carries only notifications: {"method":"event"} for a fact about a terminal,
 * {"method":"heartbeat"} every 15 seconds. Every wait here is bounded or
 * abortable.
 */
import { createConnection } from "node:net";

let nextId = 0;

/** A herdr-core error response. `kind` is its own word, e.g. "not_found". */
export class HerdrCoreError extends Error {
  constructor(method, { code, message, data }) {
    super(`herdr-core ${method}: ${message}`);
    this.name = "HerdrCoreError";
    this.code = code;
    this.kind = data?.kind;
  }
}

const abortError = (signal) =>
  signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : Object.assign(new Error("herdr-core request aborted"), {
        name: "AbortError",
      });

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

const requestLine = (id, method, params) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

/**
 * Send one request and resolve its result. Rejects with a HerdrCoreError for
 * an error response, an error with `timedOut` when herdr-core does not answer
 * within `timeout`, an AbortError when `signal` aborts, or the connection's
 * error. A connection failure after the request was written carries
 * `requestSent: true`: herdr-core may have acted on it.
 */
export function herdrCoreRequest(
  socketPath,
  method,
  params = {},
  { timeout = 10_000, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const id = ++nextId;
    const socket = createConnection(socketPath);
    let sent = false;
    let settled = false;
    const settle = (outcome, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      outcome(value);
    };
    const afterSend = (error) =>
      sent ? Object.assign(error, { requestSent: true }) : error;
    const timer = setTimeout(
      () =>
        settle(
          reject,
          Object.assign(
            new Error(
              `herdr-core ${method} did not answer within ${timeout}ms`,
            ),
            { timedOut: true },
          ),
        ),
      timeout,
    );
    const onAbort = () => settle(reject, abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => {
      socket.write(requestLine(id, method, params));
      sent = true;
    });
    readLines(socket, (response) => {
      if (response.id !== id) return;
      if (response.error)
        settle(reject, new HerdrCoreError(method, response.error));
      else settle(resolve, response.result);
    });
    socket.on("error", (error) => settle(reject, afterSend(error)));
    socket.on("close", () =>
      settle(
        reject,
        afterSend(
          new Error(
            `herdr-core closed the connection without answering ${method}`,
          ),
        ),
      ),
    );
  });
}

/**
 * Subscribe to herdr-core events about the terminals `filter` selects
 * (`terminal`, `children_of`, `labels`).
 *
 * Returns { ack, onNotification(listener), ended, stop() }. ack resolves with
 * herdr-core's answer: `seq` and the matching live `terminals`.
 * onNotification registers a (notification, error) listener; notifications
 * that arrived before it are replayed, then a retained terminal error. Any
 * end of the stream other than stop() is a failure: observation is gone.
 */
export function subscribeHerdrCore(
  socketPath,
  filter = {},
  { ackDeadline = 10_000 } = {},
) {
  const id = ++nextId;
  const socket = createConnection(socketPath);
  let resolveAck;
  let rejectAck;
  const ack = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
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
    socket.write(requestLine(id, "events.subscribe", filter)),
  );
  readLines(socket, (message) => {
    if (message.id === id) {
      if (message.error)
        return failure(new HerdrCoreError("events.subscribe", message.error));
      return resolveAck(message.result);
    }
    if (typeof message.method !== "string") return;
    if (listener) listener(message);
    else buffered.push(message);
  });
  socket.on("error", failure);
  socket.on("close", () => {
    resolveClosed();
    failure(new Error("herdr-core event stream ended unexpectedly"));
  });

  const timer = setTimeout(
    () => rejectAck(new Error("herdr-core events.subscribe ack timed out")),
    ackDeadline,
  );
  const settledAck = ack.finally(() => clearTimeout(timer));
  settledAck.catch(() => {});

  return {
    ack: settledAck,
    onNotification(next) {
      listener = next;
      for (const notification of buffered.splice(0)) next(notification);
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
      // A caller still awaiting the acknowledgement must not wait forever;
      // rejecting a settled promise does nothing.
      rejectAck(
        new Error(
          "herdr-core events.subscribe was stopped before herdr-core acknowledged it",
        ),
      );
      socket.destroy();
      await closed;
    },
  };
}
