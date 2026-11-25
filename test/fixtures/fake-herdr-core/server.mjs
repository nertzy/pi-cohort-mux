/**
 * A stateful fake herdr-core on a real Unix socket, speaking its JSON-RPC 2.0
 * line protocol as herdr-core 0.1.22 does:
 *
 *   - a connection carries any number of requests and stays open until the
 *     client closes it; after events.subscribe it carries only notifications;
 *   - events.subscribe answers {channel, seq, terminals}, then pushes
 *     {"method":"event","params":{type, terminal, seq, data}};
 *   - errors are {"error":{code, message, data:{kind, hint}}} with
 *     herdr-core's kinds (not_found, live, name_taken, spawn_failed);
 *   - terminal records and event payloads match ones captured from a real
 *     core: `created` carries the whole record, `finished` carries exit_code,
 *     signal and reason, `removed` carries nothing.
 *
 * Children: by default the fake plays a child that reads its environment, so
 * a launch's FIFO hand-off completes. A `cat` process drains the FIFO named
 * in a terminal.run argv, and the fake records what it read. It is a process
 * so that ending the terminal ends the reader, as it would a real child.
 * Tests reach in through `hooks` to delay, fail, or drop a request. A hook
 * returning `{ delayMs }` does the work at once but answers that much later.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const rpcError = (kind, message) => ({
  error: { code: -32000, message, data: { kind, hint: "" } },
});

const record = (address, fields = {}) => ({
  address,
  argv: [],
  cols: 200,
  created_ms: Date.now(),
  cwd: "/",
  die_with_parent: false,
  exit_code: null,
  finished_ms: null,
  identity: "ghostty",
  keep: false,
  labels: {},
  name: null,
  notify: false,
  parent: null,
  pid: null,
  reason: null,
  reported: false,
  rm: false,
  rows: 120,
  screen: "exact",
  signal: null,
  state: "live",
  status: null,
  status_ms: null,
  template: null,
  title: "",
  turn: 0,
  ...fields,
});

const carries = (terminal, labels = {}) =>
  Object.entries(labels).every(
    ([key, value]) => terminal.labels[key] === value,
  );

export async function startFakeHerdrCore({
  version = "0.1.22",
  features = ["framed", "attach", "events", "status"],
  callerId = "t1",
  callerPid = process.pid,
  callerLabels = { "herdr.space": "space-1", "herdr.tab": "tab-1" },
  child = "drain",
  hooks = {},
} = {}) {
  // macOS caps Unix socket paths near 104 bytes; keep it short.
  const directory = await mkdtemp(join("/tmp", "fhc-"));
  const socketPath = join(directory, "core.sock");
  const terminals = new Map([
    [
      callerId,
      record(callerId, {
        argv: ["/bin/sh"],
        labels: callerLabels,
        pid: callerPid,
      }),
    ],
  ]);
  const subscribers = new Set();
  const requests = [];
  const handoffs = [];
  const readers = new Map();
  let nextTerminal = 2;
  let nextPid = 50_000;
  let seq = 0;

  const matches = (filter, terminal) =>
    (!filter.terminal || filter.terminal === terminal.address) &&
    (!filter.children_of || filter.children_of === terminal.parent) &&
    carries(terminal, filter.labels);

  function notify(method, params, terminal) {
    const line = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    for (const { socket, filter } of subscribers) {
      if (!terminal || matches(filter, terminal)) socket.write(line);
    }
  }

  function emit(type, address, data = {}) {
    const terminal = terminals.get(address) ?? record(address);
    notify("event", { type, terminal: address, seq: ++seq, data }, terminal);
  }

  /**
   * Change a terminal's labels as `terminal.label` does. herdr-core 0.1.22
   * tells every subscriber whose filter matched before or matches now, once,
   * with the labels as they are afterwards; a subscriber the terminal no
   * longer matches then hears nothing more about it.
   */
  function relabel(address, labels) {
    const terminal = terminals.get(address);
    const before = new Set(
      [...subscribers].filter(({ filter }) => matches(filter, terminal)),
    );
    for (const [key, value] of Object.entries(labels)) {
      if (value === "") delete terminal.labels[key];
      else terminal.labels[key] = value;
    }
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "labels",
        terminal: address,
        seq: ++seq,
        data: { labels: { ...terminal.labels } },
      },
    })}\n`;
    for (const subscriber of subscribers) {
      if (before.has(subscriber) || matches(subscriber.filter, terminal))
        subscriber.socket.write(line);
    }
  }

  function finish(address, { exitCode = 0, signal = null, reason = "exited" }) {
    const terminal = terminals.get(address);
    if (!terminal || terminal.state === "finished") return terminal;
    readers.get(address)?.kill("SIGKILL");
    Object.assign(terminal, {
      state: "finished",
      exit_code: signal === null ? exitCode : null,
      signal,
      reason,
      finished_ms: Date.now(),
    });
    emit("finished", address, {
      exit_code: terminal.exit_code,
      finished_ms: terminal.finished_ms,
      reason,
      signal,
    });
    return terminal;
  }

  // Play the child: read the environment from the FIFO, as env-bootstrap.sh
  // would.
  function playChild(address, argv) {
    if (child === "none") return;
    const fifo = argv.find((token) => token.endsWith("/environment.fifo"));
    if (!fifo) return;
    const reader = spawn("/bin/cat", [fifo], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    readers.set(address, reader);
    let environment = "";
    reader.stdout.setEncoding("utf8");
    reader.stdout.on("data", (chunk) => {
      environment += chunk;
    });
    reader.on("exit", (code) => {
      readers.delete(address);
      if (code === 0) handoffs.push({ terminal: address, environment });
    });
  }

  const absent = (address) =>
    rpcError("not_found", `no terminal ${JSON.stringify(address)}`);

  const methods = {
    hello: () => ({
      core: { id: "fake-core", name: "fake" },
      features,
      framed: false,
      generation: 1,
      methods: Object.keys(methods),
      version,
    }),
    "terminal.get": ({ terminal }) =>
      terminals.get(terminal) ?? absent(terminal),
    "terminal.list": ({ labels, all = false }) => {
      const carrying = [...terminals.values()].filter((t) =>
        carries(t, labels),
      );
      const live = carrying.filter((t) => t.state === "live");
      return {
        hidden_finished: all ? 0 : carrying.length - live.length,
        machines: [],
        terminals: all ? carrying : live,
      };
    },
    "terminal.run": (params) => {
      const { argv = [], cwd = "/", labels = {}, name = null } = params;
      if (params.parent && !terminals.has(params.parent))
        return absent(params.parent);
      const taken = [...terminals.values()].some(
        (t) => name !== null && t.state === "live" && t.name === name,
      );
      if (taken) return rpcError("name_taken", `the name "${name}" is taken`);
      const address = `t${nextTerminal++}`;
      const terminal = record(address, {
        argv,
        cwd,
        labels,
        name,
        parent: params.parent ?? null,
        die_with_parent: Boolean(params.parent) && !params.outlive_parent,
        notify: Boolean(params.parent) && !params.no_notify,
        pid: nextPid++,
        rm: params.rm ?? false,
      });
      terminals.set(address, terminal);
      emit("created", address, { ...terminal });
      playChild(address, argv);
      return { ...terminal };
    },
    "terminal.kill": ({ terminal }) => {
      if (!terminals.has(terminal)) return absent(terminal);
      return { ...finish(terminal, { signal: 1, reason: "killed" }) };
    },
    "terminal.rm": ({ terminal }) => {
      const found = terminals.get(terminal);
      if (!found) return absent(terminal);
      if (found.state === "live")
        return rpcError("live", `${terminal} is still running`);
      emit("removed", terminal);
      terminals.delete(terminal);
      return { removed: terminal };
    },
  };

  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    const answer = (id, outcome) => {
      if (socket.destroyed) return;
      socket.write(
        `${JSON.stringify(outcome?.error ? { jsonrpc: "2.0", id, ...outcome } : { jsonrpc: "2.0", id, result: outcome })}\n`,
      );
    };
    async function handle({ id, method, params = {} }) {
      requests.push({ method, params });
      const hook = await hooks[method]?.(params, {
        socket,
        terminals,
        // Let the core do the work, as when it acts but never answers.
        run: () => methods[method]?.(params),
      });
      if (hook === "drop") return; // never answer
      if (hook === "hangup") return socket.destroy();
      if (hook?.delayMs !== undefined) {
        const late = methods[method]?.(params);
        setTimeout(() => answer(id, late), hook.delayMs);
        return;
      }
      if (hook) return answer(id, hook);
      if (method === "events.subscribe") {
        const entry = { socket, filter: params };
        subscribers.add(entry);
        socket.on("close", () => subscribers.delete(entry));
        return answer(id, {
          channel: null,
          seq,
          terminals: [...terminals.values()].filter(
            (t) => t.state === "live" && matches(params, t),
          ),
        });
      }
      answer(
        id,
        methods[method]?.(params) ?? {
          error: {
            code: -32601,
            message: `unknown method ${JSON.stringify(method)}`,
            data: { kind: "unknown_method", hint: "" },
          },
        },
      );
    }
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) handle(JSON.parse(line));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    callerId,
    terminals,
    requests,
    handoffs,
    emit,
    notify,
    relabel,
    /** Resolves once every child playing now has finished reading. */
    childrenDone() {
      return Promise.all(
        [...readers.values()].map(
          (reader) => new Promise((resolve) => reader.once("exit", resolve)),
        ),
      );
    },
    /** A child's program ended: the terminal stays, finished. */
    exit(address, { exitCode = 0, signal = null } = {}) {
      finish(address, { exitCode, signal });
    },
    /** End every live subscription, as a core restart would. */
    dropSubscribers() {
      for (const { socket } of subscribers) socket.destroy();
    },
    get subscriberCount() {
      return subscribers.size;
    },
    get openConnections() {
      return connections.size;
    },
    env: { HC_TERMINAL_ID: callerId, HC_TERMINAL_SOCKET: socketPath },
    async close() {
      for (const reader of readers.values()) reader.kill("SIGKILL");
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
