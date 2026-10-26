/**
 * herdr execution backend for pi-cohort.
 *
 * Implements the v1 execution-backend SPI over herdr's socket API:
 *   detect()          — probe herdr and the caller's pane
 *   launch(request)   — start a child pane beside the caller
 *   reattach(handle)  — reconnect to an existing pane by opaque handle
 *   close(handle)     — close the owned pane by handle (idempotent on absence)
 *
 * Placement (PI_COHORT_MUX_HERDR_PLACEMENT, default "tab"):
 *   tab   — each child gets its own background tab in the caller's workspace,
 *           created by layout.apply with the launcher as the pane's argv: no
 *           login shell, nothing typed, nothing in shell history.
 *   split — the first child splits right of the caller's pane and later ones
 *           stack below the newest live child. herdr's pane.split takes no
 *           command, so the launcher is typed into the pane's login shell,
 *           with a leading space (kept out of history) and without exec (the
 *           shell stays the parent and absorbs signals sent to its own pid,
 *           such as a prompt plugin's SIGUSR1), followed by `; exit`.
 *
 * herdr removes a pane when its process exits, and reports pane_exited (with
 * no exit status) rather than pane_closed. pane.close reports pane_closed.
 *
 * Grounded in the cmux adapter's lessons:
 *   - Subscribe and get the ack BEFORE creating the pane.
 *   - Every socket call is bounded; a create herdr never answers may still
 *     have made a pane, so the launcher reports its own HERDR_PANE_ID into
 *     the private launch directory and the adapter closes exactly that pane.
 *     A create timeout also starts a cool-down during which detect() reports
 *     herdr unavailable, so pi-cohort's auto selection falls back to native.
 *   - Any failure after create closes exactly the created pane and stops the
 *     subscription. Only panes this adapter created are ever closed.
 *   - Only frames that name this lease's pane (or the caller's workspace, for
 *     workspace_closed) reach the lease.
 *   - Inherited HERDR_* variables are scrubbed from the child environment, so
 *     the pane's own identity, set by herdr, wins.
 *
 * Security: request.environment travels only through the owner-only FIFO
 * (env-bootstrap.sh reads it inside the pane). The FIFO path, never its
 * contents, appears in the pane's argv or typed command. secretPipePath has no
 * defined child-side mapping in the v1 SPI, so launch rejects it.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createEnvironmentPipe,
  createEventQueue,
  createLease,
  environmentBootstrapPath,
  serializeEnvironment,
} from "pi-cohort-mux";

import { HerdrError, herdrRequest, subscribeHerdr } from "./herdr-client.js";

export { HerdrError, herdrRequest, subscribeHerdr };

const REQUEST_DEADLINE_MS = 10_000;
const ACK_DEADLINE_MS = 10_000;
const HANDOFF_DEADLINE_MS = 10_000;
const ORPHAN_GRACE_MS = 3_000;
const COOLDOWN_MS = 60_000;
const PLACEMENTS = ["tab", "split"];
const LAUNCHER_PATH = fileURLToPath(
  new URL("./pane-launch.sh", import.meta.url),
);
const EVENT_KINDS = [
  "pane.exited",
  "pane.closed",
  "pane.moved",
  "workspace.closed",
];

// ─── Error classification ─────────────────────────────────────────────────────

/** herdr's structured codes for a pane or workspace that does not exist. */
const isAbsent = (error) =>
  error instanceof HerdrError &&
  ["pane_not_found", "workspace_not_found", "tab_not_found"].includes(
    error.code,
  );

const isTimeout = (error) => error?.timedOut === true;

const isAbort = (error) =>
  error?.name === "AbortError" || error?.code === "ABORT_ERR";

/** A connection failure after the request reached herdr. */
const isLostAfterSend = (error) =>
  error?.requestSent === true && !(error instanceof HerdrError);

/**
 * True when a create failed without herdr answering, so herdr may still have
 * made the pane: a timeout, an abort, a connection lost after the request was
 * sent, or a response we could not use. An error herdr itself reported means
 * nothing was created.
 */
const createOutcomeUnknown = (error) =>
  isTimeout(error) ||
  isAbort(error) ||
  isLostAfterSend(error) ||
  error?.unexpectedResponse === true;

// ─── Command building ─────────────────────────────────────────────────────────

/** Single-quote-escape a POSIX shell token. */
const quoteShell = (token) => `'${String(token).replaceAll("'", `'"'"'`)}'`;

/**
 * The line typed into a split pane's login shell. fish, unlike POSIX shells,
 * reads `\\` and `\'` as escapes inside single quotes, so a token with a
 * backslash cannot be quoted for every login shell; refuse it.
 */
function typedCommand(argv) {
  const unsafe = argv.find((token) => String(token).includes("\\"));
  if (unsafe !== undefined) {
    throw new Error(
      "herdr split placement cannot type a command containing a backslash: a fish login shell would misread it; use tab placement",
    );
  }
  return ` ${argv.map(quoteShell).join(" ")}; exit\n`;
}

/** A short, printable tab or pane label from the run's awareness title. */
function labelFor(request) {
  const title = request.awareness?.title;
  const text =
    typeof title === "string"
      ? [...title]
          .filter((c) => c >= " " && c !== "\u007f")
          .join("")
          .trim()
      : "";
  return text.slice(0, 32) || "pi";
}

/**
 * herdr sets HERDR_* (pane, tab, workspace, socket, HERDR_ENV) in every pane it
 * spawns, argv tabs included, so the child pane already has its own values.
 */
const SURFACE_ENVIRONMENT_PREFIX = "HERDR_";

/** Drop inherited HERDR_* variables; herdr gives the pane its own. */
function scrubMuxEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key]) => !key.startsWith(SURFACE_ENVIRONMENT_PREFIX),
    ),
  );
}

// ─── Event translation ────────────────────────────────────────────────────────

/** Whether a herdr event frame concerns the owned pane. */
function ownsFrame({ event, data }, owned) {
  if (event === "workspace_closed")
    return data?.workspace_id === owned.workspaceId;
  // herdr's pushed pane_moved names the old id and nests the moved pane.
  if (event === "pane_moved") return data?.previous_pane_id === owned.paneId;
  return data?.pane_id === owned.paneId;
}

function translateHerdrEvent({ event, data }, surface, closing) {
  const base = { source: "mux", surface, timestamp: Date.now() };
  if (event === "pane_exited")
    return { ...base, type: "exited", status: null, signal: null };
  if (event === "pane_closed")
    return {
      ...base,
      type: "surface_closed",
      requested: closing.has(surface.id),
    };
  if (event === "workspace_closed")
    return { ...base, type: "surface_closed", requested: false };
  return {
    ...base,
    type: "unknown",
    fact: "herdr_event",
    reason:
      event === "pane_moved"
        ? `pane moved from ${data?.previous_pane_id} to ${data?.pane?.pane_id}`
        : `unrecognized herdr event ${event}`,
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a herdr execution backend.
 *
 * @param {object} [options]
 * @param {object} [options.env=process.env] Where HERDR_ENV, HERDR_SOCKET_PATH,
 *   HERDR_PANE_ID, and PI_COHORT_MUX_HERDR_PLACEMENT are read.
 * @param {"tab"|"split"} [options.placement] Overrides the env placement.
 * @param {number} [options.requestDeadlineMs] Bound on each herdr request.
 * @param {number} [options.ackDeadlineMs] Bound on the subscription ack.
 * @param {number} [options.handoffDeadlineMs] Bound on the child reading its
 *   environment after the pane exists.
 * @param {number} [options.orphanGraceMs] How long an ambiguous create waits
 *   for a late pane to report its own id.
 * @param {number} [options.cooldownMs] How long detect() reports herdr
 *   unavailable after a create timed out.
 * @param {Function} [options.now] Clock for the cool-down (for testing).
 */
export function createHerdrExecutionBackend({
  env = process.env,
  placement = env.PI_COHORT_MUX_HERDR_PLACEMENT || "tab",
  requestDeadlineMs = REQUEST_DEADLINE_MS,
  ackDeadlineMs = ACK_DEADLINE_MS,
  handoffDeadlineMs = HANDOFF_DEADLINE_MS,
  orphanGraceMs = ORPHAN_GRACE_MS,
  cooldownMs = COOLDOWN_MS,
  now = Date.now,
} = {}) {
  const socketPath = () => env.HERDR_SOCKET_PATH;
  const callerPaneId = () => env.HERDR_PANE_ID;
  const call = (method, params, options = {}) =>
    herdrRequest(socketPath(), method, params, {
      timeout: requestDeadlineMs,
      ...options,
    });
  const placementError = PLACEMENTS.includes(placement)
    ? undefined
    : `herdr placement "${placement}" is not supported; set PI_COHORT_MUX_HERDR_PLACEMENT to "tab" or "split"`;

  // Panes being closed through close(), so their pane_closed is "requested".
  const closing = new Set();
  let cooldown = null;
  // Split panes this backend created, oldest first; split placement stacks
  // below the newest one still alive.
  const splitPanes = [];

  function coolingDownReason() {
    if (!cooldown || now() >= cooldown.until) return undefined;
    return cooldown.reason;
  }
  function startCooldown(error) {
    cooldown = {
      until: now() + cooldownMs,
      reason: `herdr did not answer a create within its deadline (${error.message}); cooling down for ${Math.round(cooldownMs / 1_000)}s`,
    };
  }

  // Pane creation runs one launch at a time, so split placement always
  // stacks below the newest child. Only creation is serialized.
  let createLock = Promise.resolve();
  async function withCreateLock(operation) {
    const previous = createLock;
    let unlock;
    createLock = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const cooling = coolingDownReason();
      if (cooling) throw new Error(`herdr backend is cooling down: ${cooling}`);
      return await operation();
    } catch (error) {
      // Inside the lock, so launches queued behind this one see it.
      if (isTimeout(error) || isLostAfterSend(error)) startCooldown(error);
      throw error;
    } finally {
      unlock();
    }
  }

  /**
   * Request options for a create: if herdr answers after we gave up, record
   * the pane it names, so the orphan can be closed by its exact id.
   */
  const createOptions = (request, late, paneIdOf) => ({
    signal: request.signal,
    lateMs: orphanGraceMs,
    onLateResult: (result) => {
      late.paneId = paneIdOf(result);
    },
  });

  async function createTab(argv, request, late) {
    const caller = await call("pane.get", { pane_id: callerPaneId() });
    const label = labelFor(request);
    const result = await call(
      "layout.apply",
      {
        workspace_id: caller.pane.workspace_id,
        tab_label: label,
        focus: false,
        root: { type: "pane", label, cwd: request.cwd, command: argv },
      },
      createOptions(
        request,
        late,
        (r) => r?.layout?.focused_pane_id ?? r?.layout?.root?.pane_id,
      ),
    );
    const layout = result?.layout;
    const paneId = layout?.focused_pane_id ?? layout?.root?.pane_id;
    if (!paneId) {
      throw Object.assign(
        new Error(
          `unexpected herdr layout.apply response: ${JSON.stringify(result)}`,
        ),
        { unexpectedResponse: true },
      );
    }
    return { workspaceId: layout.workspace_id, tabId: layout.tab_id, paneId };
  }

  async function splitTarget() {
    for (let index = splitPanes.length - 1; index >= 0; index--) {
      const paneId = splitPanes[index];
      try {
        await call("pane.get", { pane_id: paneId });
        return { target: paneId, direction: "down" };
      } catch (error) {
        if (!isAbsent(error)) throw error;
        splitPanes.splice(index, 1);
      }
    }
    return { target: callerPaneId(), direction: "right" };
  }

  async function createSplit(request, late) {
    const { target, direction } = await splitTarget();
    const result = await call(
      "pane.split",
      { target_pane_id: target, direction, focus: false, cwd: request.cwd },
      createOptions(request, late, (r) => r?.pane?.pane_id),
    );
    const pane = result?.pane;
    if (!pane?.pane_id) {
      throw Object.assign(
        new Error(
          `unexpected herdr pane.split response: ${JSON.stringify(result)}`,
        ),
        { unexpectedResponse: true },
      );
    }
    splitPanes.push(pane.pane_id);
    return {
      workspaceId: pane.workspace_id,
      tabId: pane.tab_id,
      paneId: pane.pane_id,
    };
  }

  /** Type the launcher into a split pane; the pane already exists. */
  async function startSplitChild(paneId, text, request) {
    await call("pane.rename", { pane_id: paneId, label: labelFor(request) });
    await call("pane.send_text", { pane_id: paneId, text });
  }

  /** Close a pane this launch created but never handed out. */
  async function rollback(paneId, error) {
    try {
      await call("pane.close", { pane_id: paneId });
    } catch (closeError) {
      if (isAbsent(closeError)) return error;
      return new AggregateError(
        [error, closeError],
        `launch failed and created pane ${paneId} could not be closed`,
      );
    }
    return error;
  }

  /**
   * After a create whose outcome is unknown, collect a pane herdr made anyway.
   * Withdraw the FIFO first, so a pane that starts from now on refuses to run
   * the child and exits; then wait briefly for the pane's id - from herdr's
   * late answer or the launcher's own pane-id report - and close exactly
   * that pane. A split pane has no launcher yet, so only a late answer can
   * name it; if none arrives, its idle login shell is left in place rather
   * than closing a pane by guess.
   */
  async function collectOrphan(environmentPipe, error, late) {
    await rm(environmentPipe.pipePath, { force: true });
    const markerPath = join(environmentPipe.directory, "pane-id");
    const deadline = Date.now() + orphanGraceMs;
    let paneId = "";
    while (!paneId && Date.now() < deadline) {
      paneId =
        late.paneId ||
        (await readFile(markerPath, "utf8").catch(() => "")).trim();
      if (!paneId) await sleep(25);
    }
    if (!paneId) return error;
    return rollback(paneId, error);
  }

  /** Wait for the child to read its environment, bounded and abortable. */
  async function awaitHandoff(environmentPipe, signal) {
    let timer;
    let onAbort;
    try {
      await Promise.race([
        environmentPipe.writer.completion,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `environment hand-off did not complete within ${handoffDeadlineMs}ms; the child never opened its FIFO (missing cwd or failed shell?)`,
                ),
              ),
            handoffDeadlineMs,
          );
          onAbort = () =>
            reject(
              signal.reason ??
                Object.assign(new Error("launch aborted"), {
                  name: "AbortError",
                }),
            );
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Reconcile a lease from fresh evidence: the overflowed fact as observed,
   * then what herdr shows now, then whether live observation still runs.
   */
  async function reconcilePane({ lost, surface, paneId, subscription }) {
    const fact = (body) => ({
      ...body,
      source: "mux",
      surface,
      timestamp: Date.now(),
    });
    const facts = lost
      ? [
          {
            ...lost,
            source: "mux",
            surface,
            timestamp: lost.timestamp ?? Date.now(),
          },
        ]
      : [];
    try {
      await call("pane.get", { pane_id: paneId });
      facts.push(
        fact({
          type: "unknown",
          fact: "snapshot",
          reason: "pane present in a fresh herdr query",
          snapshot: true,
        }),
      );
    } catch (error) {
      facts.push(
        isAbsent(error)
          ? fact({ type: "surface_closed", requested: false, snapshot: true })
          : fact({
              type: "unknown",
              fact: "snapshot",
              reason: `herdr query failed: ${error.message}`,
            }),
      );
    }
    if (subscription.ended) {
      facts.push(
        fact({
          type: "backend_disconnected",
          reason: "herdr event stream ended; live observation is not restored",
        }),
      );
    }
    return facts;
  }

  /** Wire a subscription to a lease for one owned pane. */
  function observe({ subscription, handle, request, initial = [] }) {
    const eventQueue = createEventQueue(initial);
    const owned = {
      paneId: handle.data.paneId,
      workspaceId: handle.data.workspaceId,
    };
    const removeListener = subscription.onFrame((frame, error) => {
      if (error) {
        eventQueue.push({
          type: "backend_disconnected",
          source: "mux",
          reason: error.message,
          timestamp: Date.now(),
          surface: handle.surface,
        });
      } else if (ownsFrame(frame, owned)) {
        eventQueue.push(translateHerdrEvent(frame, handle.surface, closing));
        // Keep following a moved pane; herdr reports it by its new id.
        if (frame.event === "pane_moved" && frame.data?.pane?.pane_id) {
          owned.paneId = frame.data.pane.pane_id;
          owned.workspaceId = frame.data.pane.workspace_id ?? owned.workspaceId;
        }
      }
    });
    return createLease({
      handle,
      request,
      eventQueue,
      reconcile: (lost) =>
        reconcilePane({
          lost,
          surface: handle.surface,
          paneId: owned.paneId,
          subscription,
        }),
      releaseTransport: async () => {
        removeListener();
        await subscription.stop();
      },
    });
  }

  async function subscribe() {
    const subscription = subscribeHerdr(socketPath(), EVENT_KINDS, {
      ackDeadline: ackDeadlineMs,
    });
    try {
      await subscription.ack;
    } catch (error) {
      await subscription.stop();
      throw error;
    }
    return subscription;
  }

  return {
    name: "herdr",
    protocolVersion: 1,
    surfaceEnvironmentPrefixes: [SURFACE_ENVIRONMENT_PREFIX],
    placement,

    async detect() {
      const unavailable = (reason, version = "", capabilities = []) => ({
        available: false,
        version,
        capabilities,
        reason,
      });
      const cooling = coolingDownReason();
      if (cooling) return unavailable(cooling);
      if (placementError) return unavailable(placementError);
      if (env.HERDR_ENV !== "1" || !socketPath() || !callerPaneId())
        return unavailable(
          "not inside a herdr pane: HERDR_ENV, HERDR_SOCKET_PATH, and HERDR_PANE_ID must be set",
        );
      let pong;
      try {
        pong = await call("ping", {});
      } catch (error) {
        return unavailable(`herdr is unreachable: ${error.message}`);
      }
      const version = String(pong?.version ?? "");
      const capabilities = Object.entries(pong?.capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name);
      // One read-only probe: a stale HERDR_PANE_ID would otherwise surface
      // only as a failed launch.
      try {
        await call("pane.get", { pane_id: callerPaneId() });
      } catch (error) {
        return unavailable(
          isAbsent(error)
            ? `HERDR_PANE_ID ${callerPaneId()} not found in herdr`
            : `herdr pane probe failed: ${error.message}`,
          version,
          capabilities,
        );
      }
      return { available: true, version, capabilities };
    },

    async launch(request) {
      if (request.secretPipePath !== undefined) {
        throw new Error(
          "herdr backend cannot honor ExecutionSurfaceRequest.secretPipePath: the v1 SPI does not define its child-side transport",
        );
      }
      if (!socketPath() || !callerPaneId()) {
        throw new Error(
          "herdr backend requires HERDR_SOCKET_PATH and HERDR_PANE_ID; launch outside herdr is not supported",
        );
      }
      if (placementError) throw new Error(placementError);
      const payload = serializeEnvironment(
        scrubMuxEnvironment(request.environment),
      );
      // The launcher argv is fixed except for the private launch paths, so
      // check that split placement can type it before creating anything.
      const argvFor = (pipe) => [
        "/bin/sh",
        LAUNCHER_PATH,
        pipe.directory,
        pipe.pipePath,
        request.cwd,
        environmentBootstrapPath,
        request.command,
        ...request.args,
      ];
      if (placement === "split")
        typedCommand(argvFor({ directory: "/", pipePath: "/" }));
      const cooling = coolingDownReason();
      if (cooling) throw new Error(`herdr backend is cooling down: ${cooling}`);

      // Observe before creating, so no event about the new pane is missed.
      const subscription = await subscribe();
      let environmentPipe;
      try {
        environmentPipe = await createEnvironmentPipe(payload, {
          always: true,
        });
      } catch (error) {
        await subscription.stop();
        throw error;
      }
      const argv = argvFor(environmentPipe);

      let created;
      const late = { paneId: "" };
      try {
        created = await withCreateLock(() =>
          placement === "tab"
            ? createTab(argv, request, late)
            : createSplit(request, late),
        );
      } catch (error) {
        const reported = createOutcomeUnknown(error)
          ? await collectOrphan(environmentPipe, error, late)
          : error;
        await environmentPipe.cleanup();
        await subscription.stop();
        throw reported;
      }

      // From here the pane exists. Until a lease is returned, every failure
      // closes exactly that pane and stops the subscription.
      try {
        try {
          if (placement === "split")
            await startSplitChild(created.paneId, typedCommand(argv), request);
          await awaitHandoff(environmentPipe, request.signal);
        } finally {
          await environmentPipe.cleanup();
        }
      } catch (error) {
        const reported = await rollback(created.paneId, error);
        await subscription.stop();
        throw reported;
      }

      const handle = {
        protocolVersion: 1,
        backend: "herdr",
        surface: { kind: "pane", id: created.paneId },
        display: {
          label: `herdr:${created.paneId}`,
          hint:
            placement === "tab"
              ? `herdr tab ${created.tabId}, pane ${created.paneId}`
              : `herdr pane ${created.paneId} (tab ${created.tabId})`,
        },
        data: {
          placement,
          workspaceId: created.workspaceId,
          tabId: created.tabId,
          paneId: created.paneId,
          cwd: request.cwd,
        },
      };
      return observe({ subscription, handle, request });
    },

    async reattach(handle) {
      const paneId = handle?.data?.paneId;
      if (!paneId)
        return {
          status: "unknown",
          reason: "handle has no herdr pane id; cannot query herdr",
        };
      let subscription;
      try {
        subscription = await subscribe();
      } catch (error) {
        return { status: "unknown", reason: error.message };
      }
      try {
        await call("pane.get", { pane_id: paneId });
      } catch (error) {
        await subscription.stop();
        if (isAbsent(error)) return { status: "gone" };
        return { status: "unknown", reason: error.message };
      }
      const lease = observe({
        subscription,
        handle,
        request: {},
        initial: [
          {
            type: "unknown",
            fact: "snapshot",
            reason: "reattach observation",
            source: "mux",
            snapshot: true,
            timestamp: Date.now(),
            surface: handle.surface,
          },
        ],
      });
      return { status: "present", lease };
    },

    async close(handle, _reason) {
      const paneId = handle?.data?.paneId;
      if (!paneId) return;
      closing.add(paneId);
      try {
        await call("pane.close", { pane_id: paneId });
      } catch (error) {
        if (isAbsent(error)) return;
        closing.delete(paneId);
        throw error;
      }
    },
  };
}

export { createHerdrExecutionBackend as createHerdrBackend };

// The adapter convention: "./execution-backend" default-exports the factory.
export default createHerdrExecutionBackend;
