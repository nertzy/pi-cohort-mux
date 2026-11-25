/**
 * herdr-core execution backend for pi-cohort.
 *
 * herdr-core (`hc`) is the terminal server behind the Herdr app. It is a
 * different program from the herdr terminal multiplexer, with its own socket
 * protocol. This implements the v1 execution-backend SPI over that socket:
 *   detect()          — probe herdr-core and prove it started this terminal
 *   launch(request)   — start a child terminal under the caller's
 *   reattach(handle)  — reconnect to an existing terminal by opaque handle
 *   close(handle)     — end and remove the owned terminal (idempotent on
 *                       absence)
 *
 * Placement (PI_COHORT_MUX_HERDR_CORE_PLACEMENT, default "hidden"):
 *   hidden — the child is a terminal with no place in the Herdr window. It is
 *            the caller's child, so it ends when the caller's terminal ends.
 *   tab    — the child also carries the caller's `herdr.space` label, which
 *            the app turns into a tab in that space. It has its own place on
 *            screen, so it outlives the caller's terminal.
 *
 * Either way terminal.run starts the bootstrap as the terminal's argv: no
 * login shell, nothing typed, nothing in shell history.
 *
 * A terminal whose program ended stays, finished and readable, until it is
 * removed. So the lease reports `exited` with the real exit code or signal,
 * and `surface_closed` only once the terminal is removed.
 *
 * Grounded in the other adapters' lessons:
 *   - Subscribe and get the ack BEFORE creating the terminal.
 *   - Every socket call is bounded; a create herdr-core never answers may
 *     still have made a terminal. Each launch carries its own label, so the
 *     adapter finds exactly that terminal and ends it. A create timeout also
 *     starts a cool-down during which detect() reports herdr-core
 *     unavailable, so pi-cohort's auto selection falls back to native.
 *   - Any failure after create ends exactly the created terminal and stops
 *     the subscription. Only a terminal carrying this adapter's launch label
 *     is ever ended or removed.
 *   - Inherited HC_* variables are scrubbed from the child environment, so
 *     the terminal's own identity, set by herdr-core, wins.
 *   - HC_* variables are inherited by everything started under a terminal,
 *     so detect() also requires the terminal's own program to be this process
 *     or one of its ancestors.
 *
 * Security: request.environment travels only through the owner-only FIFO
 * (env-bootstrap.sh reads it inside the terminal). The FIFO path, never its
 * contents, appears in the terminal's argv. secretPipePath has no defined
 * child-side mapping in the v1 SPI, so launch rejects it.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { constants } from "node:os";
import {
  createEnvironmentPipe,
  createEventQueue,
  createLease,
  environmentBootstrapPath,
  processAncestors,
  serializeEnvironment,
} from "pi-cohort-mux";

import {
  HerdrCoreError,
  herdrCoreRequest,
  subscribeHerdrCore,
} from "./herdr-core-client.js";

export { HerdrCoreError, herdrCoreRequest, subscribeHerdrCore };

const REQUEST_DEADLINE_MS = 10_000;
const ACK_DEADLINE_MS = 10_000;
const HANDOFF_DEADLINE_MS = 10_000;
const ORPHAN_GRACE_MS = 3_000;
const COOLDOWN_MS = 60_000;
const PLACEMENTS = ["hidden", "tab"];
/** Names one launch, so its terminal can be found and proven ours. */
const LAUNCH_LABEL = "pi-cohort-mux.launch";
/** The Herdr app gives a terminal carrying this label a tab in that space. */
const SPACE_LABEL = "herdr.space";

// ─── Error classification ─────────────────────────────────────────────────────

/** herdr-core's word for a terminal that does not exist. */
const isAbsent = (error) =>
  error instanceof HerdrCoreError && error.kind === "not_found";

const isTimeout = (error) => error?.timedOut === true;

const isAbort = (error) =>
  error?.name === "AbortError" || error?.code === "ABORT_ERR";

/** A connection failure after the request reached herdr-core. */
const isLostAfterSend = (error) =>
  error?.requestSent === true && !(error instanceof HerdrCoreError);

/**
 * herdr-core answers `unavailable` when it could not save its terminals, and
 * says the operation may already have completed.
 */
const isUnsavedOutcome = (error) =>
  error instanceof HerdrCoreError && error.kind === "unavailable";

/**
 * True when a create failed in a way that may still have made the terminal:
 * a timeout, an abort, a connection lost after the request was sent, a
 * response we could not use, or herdr-core's own `unavailable`. Any other
 * error herdr-core reported means nothing was created.
 */
const createOutcomeUnknown = (error) =>
  isTimeout(error) ||
  isAbort(error) ||
  isLostAfterSend(error) ||
  isUnsavedOutcome(error) ||
  error?.unexpectedResponse === true;

// ─── Request building ─────────────────────────────────────────────────────────

/**
 * A terminal name from the run's awareness title. herdr-core allows 1-32 of
 * a-z 0-9 - _ . and refuses a name a live terminal already has, so the name
 * ends with the start of the launch's own token.
 */
function nameFor(request, token) {
  const title = request.awareness?.title;
  const base = (typeof title === "string" ? title : "")
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .slice(0, 23)
    .replace(/^-+|-+$/g, "");
  return `${base || "pi"}-${token.slice(0, 8)}`;
}

/**
 * herdr-core sets HC_* (HC_TERMINAL_ID, HC_TERMINAL_SOCKET, HC_SCOPE) in every
 * terminal it starts, so the child terminal already has its own values.
 */
const SURFACE_ENVIRONMENT_PREFIX = "HC_";

/** Drop inherited HC_* variables; herdr-core gives the terminal its own. */
function scrubMuxEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([key]) => !key.startsWith(SURFACE_ENVIRONMENT_PREFIX),
    ),
  );
}

// ─── Event translation ────────────────────────────────────────────────────────

/** The name of a signal number, as Node reports signals: 15 is "SIGTERM". */
function signalName(number) {
  if (number === null || number === undefined) return null;
  const named = Object.entries(constants.signals).find(
    ([, value]) => value === number,
  );
  return named ? named[0] : String(number);
}

/** How a finished terminal's program ended, as the SPI's `exited` fact. */
const exitedFact = (terminal) => ({
  type: "exited",
  status: terminal.exit_code ?? null,
  signal: signalName(terminal.signal),
});

/**
 * The SPI fact for one herdr-core event, or undefined for the many that say
 * nothing about a child's lifecycle (foreground, status, title, size, ...).
 */
function translateEvent({ type, data }, requested) {
  if (type === "finished") return exitedFact(data ?? {});
  if (type === "removed") return { type: "surface_closed", requested };
  if (type === "lost" || type === "restarted")
    return {
      type: "unknown",
      fact: "herdr_core_event",
      reason: `herdr-core reported ${type}`,
    };
  return undefined;
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a herdr-core execution backend.
 *
 * @param {object} [options]
 * @param {object} [options.env=process.env] Where HC_TERMINAL_ID,
 *   HC_TERMINAL_SOCKET, and PI_COHORT_MUX_HERDR_CORE_PLACEMENT are read.
 * @param {"hidden"|"tab"} [options.placement] Overrides the env placement.
 * @param {number} [options.requestDeadlineMs] Bound on each herdr-core
 *   request.
 * @param {number} [options.ackDeadlineMs] Bound on the subscription ack.
 * @param {number} [options.handoffDeadlineMs] Bound on the child reading its
 *   environment after the terminal exists.
 * @param {number} [options.orphanGraceMs] How long an ambiguous create waits
 *   for a late terminal to appear.
 * @param {number} [options.cooldownMs] How long detect() reports herdr-core
 *   unavailable after a create timed out.
 * @param {number} [options.pid] This process (for testing).
 * @param {Function} [options.ancestors] Lists this process's ancestors,
 *   nearest first, as { pid } records (for testing).
 * @param {Function} [options.now] Clock for the cool-down (for testing).
 */
export function createHerdrCoreExecutionBackend({
  env = process.env,
  placement = env.PI_COHORT_MUX_HERDR_CORE_PLACEMENT || "hidden",
  requestDeadlineMs = REQUEST_DEADLINE_MS,
  ackDeadlineMs = ACK_DEADLINE_MS,
  handoffDeadlineMs = HANDOFF_DEADLINE_MS,
  orphanGraceMs = ORPHAN_GRACE_MS,
  cooldownMs = COOLDOWN_MS,
  pid = process.pid,
  ancestors = () => processAncestors({ pid, timeout: requestDeadlineMs }),
  now = Date.now,
} = {}) {
  const socketPath = () => env.HC_TERMINAL_SOCKET;
  const callerId = () => env.HC_TERMINAL_ID;
  const call = (method, params, options = {}) =>
    herdrCoreRequest(socketPath(), method, params, {
      timeout: requestDeadlineMs,
      ...options,
    });
  const placementError = PLACEMENTS.includes(placement)
    ? undefined
    : `herdr-core placement "${placement}" is not supported; set PI_COHORT_MUX_HERDR_CORE_PLACEMENT to "hidden" or "tab"`;
  const noSpaceError = () =>
    `herdr-core tab placement needs the caller's terminal ${callerId()} to carry a ${SPACE_LABEL} label; it is in no Herdr space`;

  // Launch tokens whose terminal close() is removing, so that removal is
  // "requested". Keyed by token, not address: another core may reuse an
  // address for a terminal of another launch.
  const closing = new Set();
  let cooldown = null;

  function coolingDownReason() {
    if (!cooldown || now() >= cooldown.until) return undefined;
    return cooldown.reason;
  }
  function startCooldown(error) {
    cooldown = {
      until: now() + cooldownMs,
      reason: `herdr-core did not answer a create within its deadline (${error.message}); cooling down for ${Math.round(cooldownMs / 1_000)}s`,
    };
  }

  // HC_* variables are inherited by everything started under a terminal,
  // including a program that outlives it and hands them on (a tmux server, a
  // detached job). What an inherited environment cannot fake is descent:
  // herdr-core starts a terminal's program itself and reports its pid, so
  // that pid is this process or one of its ancestors.
  async function ownershipProblem(caller) {
    if (caller.state !== "live" || !Number.isInteger(caller.pid))
      return `herdr-core terminal ${caller.address} is not running, so it did not start this process`;
    if (caller.pid === pid) return undefined;
    let chain;
    try {
      chain = await ancestors();
    } catch (error) {
      return `cannot prove herdr-core started this terminal: ${error.message}`;
    }
    if (chain.some((ancestor) => ancestor.pid === caller.pid)) return undefined;
    return `herdr-core did not start this terminal: the program of ${caller.address} (pid ${caller.pid}) is not an ancestor of this process, so HC_TERMINAL_ID was inherited`;
  }

  /**
   * End and remove one terminal, only while it carries the launch's label:
   * an address is unique on one core, and another core may reuse it. Its
   * absence at any step is success. `requested` marks the removal as asked
   * for through close(), once the terminal is known to be this launch's.
   */
  async function endOwnedTerminal(address, token, { requested = false } = {}) {
    try {
      const terminal = await call("terminal.get", { terminal: address });
      if (terminal.labels?.[LAUNCH_LABEL] !== token) return;
      if (requested) closing.add(token);
      // A no-op for a finished terminal; a live one is finished on return.
      await call("terminal.kill", { terminal: address });
      await call("terminal.rm", { terminal: address });
    } catch (error) {
      if (isAbsent(error)) return;
      if (requested) closing.delete(token);
      throw error;
    }
  }

  /** End a terminal this launch created but never handed out. */
  async function rollback(address, token, error) {
    try {
      await endOwnedTerminal(address, token);
    } catch (endError) {
      return new AggregateError(
        [error, endError],
        `launch failed and created terminal ${address} could not be removed`,
      );
    }
    return error;
  }

  /**
   * The address in the launch's `created` event, or "" after `graceMs`. A
   * stream that has failed still waits the whole time, so the label lookup
   * that follows runs after herdr-core could last have made the terminal.
   */
  function createdWithin(subscription, graceMs) {
    return new Promise((resolve) => {
      // A buffered notification can settle this before onNotification returns.
      let remove = () => {};
      const timer = setTimeout(() => done(""), graceMs);
      const done = (address) => {
        clearTimeout(timer);
        remove();
        resolve(address);
      };
      remove = subscription.onNotification((notification, error) => {
        if (error) return;
        if (
          notification.method === "event" &&
          notification.params?.type === "created"
        )
          done(String(notification.params.terminal ?? ""));
      });
    });
  }

  /**
   * After a create whose outcome is unknown, collect a terminal herdr-core
   * made anyway. Withdraw the FIFO first, so a terminal that starts from now
   * on cannot run the child and exits. Then wait briefly for the terminal:
   * the subscription, filtered to this launch's label, names it in `created`;
   * if the stream is gone too, ask once for terminals carrying the label.
   */
  async function collectOrphan(subscription, environmentPipe, token, error) {
    await rm(environmentPipe.pipePath, { force: true });
    const created = await createdWithin(subscription, orphanGraceMs);
    let addresses = created ? [created] : [];
    if (!created) {
      const listed = await call(
        "terminal.list",
        { labels: { [LAUNCH_LABEL]: token }, all: true },
        { timeout: Math.min(requestDeadlineMs, orphanGraceMs) },
      ).catch(() => undefined);
      addresses = (listed?.terminals ?? []).map((terminal) => terminal.address);
    }
    return addresses.reduce(
      async (reported, address) => rollback(address, token, await reported),
      error,
    );
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
                  `environment hand-off did not complete within ${handoffDeadlineMs}ms; the child never opened its FIFO (failed shell?)`,
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

  /** What a fresh herdr-core query shows about an owned terminal. */
  async function freshFacts(address, token) {
    try {
      const terminal = await call("terminal.get", { terminal: address });
      if (terminal.labels?.[LAUNCH_LABEL] !== token)
        return [{ type: "surface_closed", requested: false, snapshot: true }];
      if (terminal.state === "finished")
        return [{ ...exitedFact(terminal), snapshot: true }];
      return [
        {
          type: "unknown",
          fact: "snapshot",
          reason: "terminal live in a fresh herdr-core query",
          snapshot: true,
        },
      ];
    } catch (error) {
      if (isAbsent(error))
        return [
          {
            type: "surface_closed",
            requested: closing.has(token),
            snapshot: true,
          },
        ];
      return [
        {
          type: "unknown",
          fact: "snapshot",
          reason: `herdr-core query failed: ${error.message}`,
        },
      ];
    }
  }

  /**
   * Reconcile a lease from fresh evidence: the overflowed fact as observed,
   * then what herdr-core shows now, then whether live observation still runs.
   */
  async function reconcileTerminal({ lost, handle, subscription }) {
    const stamp = (body) => ({
      ...body,
      source: "mux",
      surface: handle.surface,
      timestamp: body.timestamp ?? Date.now(),
    });
    const facts = lost ? [stamp(lost)] : [];
    facts.push(
      ...(await freshFacts(handle.data.terminal, handle.data.launch)).map(
        stamp,
      ),
    );
    if (subscription.ended) {
      facts.push(
        stamp({
          type: "backend_disconnected",
          reason:
            "herdr-core event stream ended; live observation is not restored",
        }),
      );
    }
    return facts;
  }

  /** Wire a subscription to a lease for one owned terminal. */
  function observe({ subscription, handle, request, initial = [] }) {
    const eventQueue = createEventQueue(initial);
    const address = handle.data.terminal;
    const push = (body) =>
      eventQueue.push({
        ...body,
        source: "mux",
        surface: handle.surface,
        timestamp: Date.now(),
      });
    const removeListener = subscription.onNotification(
      (notification, error) => {
        if (error)
          return push({ type: "backend_disconnected", reason: error.message });
        // The subscriber fell behind and herdr-core skipped events. Whatever
        // it sends with the notice, a fresh look at the terminal says what
        // the skipped events would have.
        if (notification.method === "missed")
          return freshFacts(address, handle.data.launch).then((facts) =>
            facts.forEach(push),
          );
        if (
          notification.method !== "event" ||
          notification.params?.terminal !== address
        )
          return;
        // A terminal that loses the launch label leaves this subscription's
        // filter: herdr-core sends this one labels event and then nothing
        // more, neither finished nor removed. It is no longer this launch's
        // terminal, which is what a fresh look would report too.
        if (
          notification.params.type === "labels" &&
          notification.params.data?.labels?.[LAUNCH_LABEL] !==
            handle.data.launch
        )
          return push({ type: "surface_closed", requested: false });
        const fact = translateEvent(
          notification.params,
          closing.has(handle.data.launch),
        );
        if (fact) push(fact);
      },
    );
    return createLease({
      handle,
      request,
      eventQueue,
      reconcile: (lost) => reconcileTerminal({ lost, handle, subscription }),
      releaseTransport: async () => {
        removeListener();
        await subscription.stop();
      },
    });
  }

  async function subscribe(token) {
    const subscription = subscribeHerdrCore(
      socketPath(),
      { labels: { [LAUNCH_LABEL]: token } },
      { ackDeadline: ackDeadlineMs },
    );
    try {
      await subscription.ack;
    } catch (error) {
      await subscription.stop();
      throw error;
    }
    return subscription;
  }

  return {
    name: "herdr-core",
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
      if (!socketPath() || !callerId())
        return unavailable(
          "not inside a herdr-core terminal: HC_TERMINAL_ID and HC_TERMINAL_SOCKET must be set",
        );
      let hello;
      try {
        hello = await call("hello", { generation: 1 });
      } catch (error) {
        return unavailable(`herdr-core is unreachable: ${error.message}`);
      }
      const version = String(hello?.version ?? "");
      const capabilities = Array.isArray(hello?.features)
        ? hello.features.map(String)
        : [];
      const refuse = (reason) => unavailable(reason, version, capabilities);
      if (!capabilities.includes("events"))
        return refuse(`herdr-core ${version} does not offer events`);
      let caller;
      try {
        caller = await call("terminal.get", { terminal: callerId() });
      } catch (error) {
        return refuse(
          isAbsent(error)
            ? `HC_TERMINAL_ID ${callerId()} not found in herdr-core`
            : `herdr-core terminal probe failed: ${error.message}`,
        );
      }
      const problem = await ownershipProblem(caller);
      if (problem) return refuse(problem);
      if (placement === "tab" && !caller.labels?.[SPACE_LABEL])
        return refuse(noSpaceError());
      return { available: true, version, capabilities };
    },

    async launch(request) {
      if (request.secretPipePath !== undefined) {
        throw new Error(
          "herdr-core backend cannot honor ExecutionSurfaceRequest.secretPipePath: the v1 SPI does not define its child-side transport",
        );
      }
      if (!socketPath() || !callerId()) {
        throw new Error(
          "herdr-core backend requires HC_TERMINAL_SOCKET and HC_TERMINAL_ID; launch outside herdr-core is not supported",
        );
      }
      if (placementError) throw new Error(placementError);
      const cooling = coolingDownReason();
      if (cooling)
        throw new Error(`herdr-core backend is cooling down: ${cooling}`);
      const payload = serializeEnvironment(
        scrubMuxEnvironment(request.environment),
      );

      const token = randomUUID();
      const labels = { [LAUNCH_LABEL]: token };
      let space;
      if (placement === "tab") {
        const caller = await call("terminal.get", { terminal: callerId() });
        space = caller.labels?.[SPACE_LABEL];
        if (!space) throw new Error(noSpaceError());
        labels[SPACE_LABEL] = space;
      }
      const name = nameFor(request, token);

      // Observe before creating, so no event about the new terminal is missed.
      const subscription = await subscribe(token);
      let environmentPipe;
      try {
        environmentPipe = await createEnvironmentPipe(payload, {
          always: true,
        });
      } catch (error) {
        await subscription.stop();
        throw error;
      }

      let address;
      try {
        const created = await call(
          "terminal.run",
          {
            argv: [
              "/bin/sh",
              environmentBootstrapPath,
              environmentPipe.pipePath,
              request.command,
              ...request.args,
            ],
            cwd: request.cwd,
            name,
            labels,
            parent: callerId(),
            // herdr-core would otherwise type exit notes into the caller.
            no_notify: true,
            outlive_parent: placement === "tab",
          },
          { signal: request.signal },
        );
        address = created?.address;
        if (typeof address !== "string" || address === "") {
          throw Object.assign(
            new Error(
              `unexpected herdr-core terminal.run response: ${JSON.stringify(created)}`,
            ),
            { unexpectedResponse: true },
          );
        }
      } catch (error) {
        if (isTimeout(error) || isLostAfterSend(error)) startCooldown(error);
        const reported = createOutcomeUnknown(error)
          ? await collectOrphan(subscription, environmentPipe, token, error)
          : error;
        await environmentPipe.cleanup();
        await subscription.stop();
        throw reported;
      }

      // From here the terminal exists. Until a lease is returned, every
      // failure ends exactly that terminal and stops the subscription.
      try {
        try {
          await awaitHandoff(environmentPipe, request.signal);
        } finally {
          await environmentPipe.cleanup();
        }
      } catch (error) {
        const reported = await rollback(address, token, error);
        await subscription.stop();
        throw reported;
      }

      const handle = {
        protocolVersion: 1,
        backend: "herdr-core",
        surface: { kind: "terminal", id: address },
        display: {
          label: `herdr-core:${address}`,
          hint:
            placement === "tab"
              ? `Herdr tab in space ${space}, terminal ${address}`
              : `hidden herdr-core terminal ${address} (hc attach ${name})`,
        },
        data: { placement, terminal: address, launch: token, cwd: request.cwd },
      };
      return observe({ subscription, handle, request });
    },

    async reattach(handle) {
      const address = handle?.data?.terminal;
      const token = handle?.data?.launch;
      if (!address || !token)
        return {
          status: "unknown",
          reason: "handle has no herdr-core terminal; cannot query herdr-core",
        };
      let subscription;
      try {
        subscription = await subscribe(token);
      } catch (error) {
        return { status: "unknown", reason: error.message };
      }
      let terminal;
      try {
        terminal = await call("terminal.get", { terminal: address });
      } catch (error) {
        await subscription.stop();
        if (isAbsent(error)) return { status: "gone" };
        return { status: "unknown", reason: error.message };
      }
      // An address is unique on one core; another core may reuse it.
      if (terminal.labels?.[LAUNCH_LABEL] !== token) {
        await subscription.stop();
        return { status: "gone" };
      }
      const fact = (body) => ({
        ...body,
        source: "mux",
        timestamp: Date.now(),
        surface: handle.surface,
      });
      const initial = [
        fact({
          type: "unknown",
          fact: "snapshot",
          reason: "reattach observation",
          snapshot: true,
        }),
      ];
      if (terminal.state === "finished")
        initial.push(fact({ ...exitedFact(terminal), snapshot: true }));
      const lease = observe({ subscription, handle, request: {}, initial });
      return { status: "present", lease };
    },

    async close(handle, _reason) {
      const address = handle?.data?.terminal;
      const token = handle?.data?.launch;
      if (!address || !token) return;
      // Only a terminal carrying this launch's label is ours to end.
      await endOwnedTerminal(address, token, { requested: true });
    },
  };
}

export { createHerdrCoreExecutionBackend as createHerdrCoreBackend };

// The adapter convention: "./execution-backend" default-exports the factory.
export default createHerdrCoreExecutionBackend;
