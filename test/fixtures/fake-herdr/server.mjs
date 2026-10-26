/**
 * A stateful fake herdr server on a real Unix socket, speaking herdr's
 * newline-delimited JSON socket protocol as herdr 0.9.5 does:
 *
 *   - a plain request gets one response line, then the server closes the
 *     connection; events.subscribe keeps it open, acknowledges with
 *     {"type":"subscription_started"}, then pushes {"event","data"} frames;
 *   - errors are {"error":{"code","message"}} with herdr's codes
 *     (pane_not_found, workspace_not_found);
 *   - response and event shapes match ones captured from a real server.
 *
 * Children: by default the fake plays a child that reads its environment, so
 * a launch's FIFO hand-off completes. It drains the FIFO named in a
 * layout.apply argv or a pane.send_text line, records what it read, and
 * optionally writes the launcher's pane-id marker. Tests reach in through
 * `hooks` to delay, fail, or drop a request. A hook returning
 * `{ delayMs }` does the work at once but answers that much later.
 */
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const pane = (id, workspaceId, tabId, cwd = "/") => ({
  pane_id: id,
  terminal_id: `term_${id.replace(":", "_")}`,
  workspace_id: workspaceId,
  tab_id: tabId,
  focused: false,
  cwd,
  foreground_cwd: cwd,
  agent_status: "unknown",
  revision: 0,
});

const herdrError = (code, message) => ({ error: { code, message } });

export async function startFakeHerdr({
  version = "0.9.5",
  callerPaneId = "w1:p1",
  child = "drain",
  hooks = {},
} = {}) {
  // macOS caps Unix socket paths near 104 bytes; keep it short.
  const directory = await mkdtemp(join("/tmp", "fh-"));
  const socketPath = join(directory, "herdr.sock");
  const workspaceId = callerPaneId.split(":")[0];
  const panes = new Map([
    [callerPaneId, pane(callerPaneId, workspaceId, `${workspaceId}:t1`)],
  ]);
  const tabs = new Map([[`${workspaceId}:t1`, { label: "1" }]]);
  const subscribers = new Set();
  const requests = [];
  const handoffs = [];
  let nextPane = 2;
  let nextTab = 2;

  function emit(event, data) {
    const line = `${JSON.stringify({ event, data: { ...data, type: event } })}\n`;
    for (const { socket, kinds } of subscribers) {
      if (kinds.has(event.replace("_", "."))) socket.write(line);
    }
  }

  function removePane(id, event) {
    const removed = panes.get(id);
    if (!removed) return;
    panes.delete(id);
    if (![...panes.values()].some((p) => p.tab_id === removed.tab_id))
      tabs.delete(removed.tab_id);
    emit(event, { pane_id: id, workspace_id: removed.workspace_id });
  }

  // Play the child: read the environment from the FIFO, as env-bootstrap.sh
  // would, and report the pane id where the launcher would.
  async function playChild(paneId, tokens) {
    if (child === "none") return;
    const fifo = tokens.find((token) => token.endsWith("/environment.fifo"));
    if (!fifo) return;
    if (child === "orphan" || child === "drain-with-marker") {
      const marker = join(dirname(fifo), "pane-id");
      await writeFile(`${marker}.tmp`, `${paneId}\n`).catch(() => {});
      await rename(`${marker}.tmp`, marker).catch(() => {});
    }
    if (child === "orphan") return;
    const environment = await readFile(fifo, "utf8").catch(() => undefined);
    handoffs.push({ paneId, environment });
  }

  const unquote = (text) =>
    [...text.matchAll(/'((?:[^']|'"'"')*)'/g)].map((m) =>
      m[1].replaceAll(`'"'"'`, "'"),
    );

  const methods = {
    ping: () => ({
      type: "pong",
      version,
      protocol: 22,
      capabilities: { live_handoff: true, health_check: true },
    }),
    "pane.get": ({ pane_id }) =>
      panes.has(pane_id)
        ? { type: "pane_info", pane: panes.get(pane_id) }
        : herdrError("pane_not_found", `pane ${pane_id} not found`),
    "pane.split": ({ target_pane_id, cwd }) => {
      const target = panes.get(target_pane_id);
      if (!target)
        return herdrError("pane_not_found", `pane ${target_pane_id} not found`);
      const id = `${target.workspace_id}:p${nextPane++}`;
      panes.set(id, pane(id, target.workspace_id, target.tab_id, cwd));
      return { type: "pane_info", pane: panes.get(id) };
    },
    "pane.rename": ({ pane_id }) =>
      panes.has(pane_id)
        ? { type: "ok" }
        : herdrError("pane_not_found", `pane ${pane_id} not found`),
    "pane.send_text": ({ pane_id, text }) => {
      if (!panes.has(pane_id))
        return herdrError("pane_not_found", `pane ${pane_id} not found`);
      playChild(pane_id, unquote(text));
      return { type: "ok" };
    },
    "layout.apply": ({ workspace_id, tab_label, root }) => {
      if (workspace_id !== workspaceId)
        return herdrError(
          "workspace_not_found",
          `workspace ${workspace_id} not found`,
        );
      const tabId = `${workspace_id}:t${nextTab++}`;
      const id = `${workspace_id}:p${nextPane++}`;
      tabs.set(tabId, { label: tab_label });
      panes.set(id, pane(id, workspace_id, tabId, root.cwd));
      playChild(id, root.command ?? []);
      return {
        type: "layout_apply",
        layout: {
          workspace_id,
          tab_id: tabId,
          zoomed: false,
          focused_pane_id: id,
          root: { ...root, pane_id: id },
        },
      };
    },
    "pane.close": ({ pane_id }) => {
      if (!panes.has(pane_id))
        return herdrError("pane_not_found", `pane ${pane_id} not found`);
      removePane(pane_id, "pane_closed");
      return { type: "ok" };
    },
  };

  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { id, method, params = {} } = JSON.parse(buffer.slice(0, newline));
      buffer = "";
      requests.push({ method, params });
      const hook = await hooks[method]?.(params, {
        socket,
        panes,
        // Let herdr do the work, as when it acts but never answers.
        run: () => methods[method]?.(params),
      });
      if (hook === "drop") return; // never answer
      if (hook === "hangup") return socket.destroy();
      if (hook?.delayMs !== undefined) {
        const late = methods[method]?.(params);
        setTimeout(() => {
          if (!socket.destroyed)
            socket.end(`${JSON.stringify({ id, result: late })}\n`);
        }, hook.delayMs);
        return;
      }
      if (method === "events.subscribe") {
        const entry = {
          socket,
          kinds: new Set(params.subscriptions.map((s) => s.type)),
        };
        subscribers.add(entry);
        socket.on("close", () => subscribers.delete(entry));
        socket.write(
          `${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`,
        );
        return;
      }
      const outcome =
        hook ??
        methods[method]?.(params) ??
        herdrError("unknown_method", `unknown method ${method}`);
      socket.end(
        `${JSON.stringify(outcome.error ? { id, ...outcome } : { id, result: outcome })}\n`,
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    callerPaneId,
    workspaceId,
    panes,
    tabs,
    requests,
    handoffs,
    emit,
    /** A child's process ended: herdr drops its pane and says so. */
    exit(paneId) {
      removePane(paneId, "pane_exited");
    },
    /** End every live subscription, as a herdr restart would. */
    dropSubscribers() {
      for (const { socket } of subscribers) socket.destroy();
    },
    get subscriberCount() {
      return subscribers.size;
    },
    get openConnections() {
      return connections.size;
    },
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: callerPaneId,
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
