/**
 * cmux execution backend for pi-cohort.
 *
 * Implements the v1 execution-backend SPI:
 *   detect()          — probe cmux availability and capabilities
 *   launch(request)   — add a child surface to the parent workspace's helper pane
 *   reattach(handle)  — reconnect to an existing surface by opaque handle
 *   close(handle)     — close the owned surface by handle (idempotent on not_found)
 *
 * Placement mirrors the cohort bridge: children are terminal tabs in one
 * right-side helper pane inside the PARENT workspace — never new workspaces.
 * The first child creates the pane (no idle shell surface); later children
 * add surfaces to it; cmux collapses the pane when its last surface closes.
 *
 * Grounded in the cmux-parity spike (doc/spikes/cmux-parity.md):
 *   - Events subscription starts and acks BEFORE surface create.
 *   - Handle UUID comes from the snapshot (list-pane-surfaces --id-format both).
 *   - Only frames that name the owned surface/pane/workspace reach the lease;
 *     children share the parent workspace, so unfiltered events are unsafe.
 *   - close() maps only not-found errors to idempotent absence; other errors propagate.
 *   - reattach() maps not-found errors to { status: "gone" }; other errors to "unknown".
 *   - release() stops the subscription without closing the surface.
 *   - No screen scraping, send-keys, focus stealing, or intercom env vars.
 *   - Inherited CMUX_* env vars are scrubbed from the child environment so the
 *     new surface's own identity (set by cmux) always wins.
 *
 * SPI handle shape (ExecutionSurfaceHandle):
 *   { protocolVersion, backend, surface: { kind, id }, display: { label, hint }, data }
 *
 * SPI event shape (ExecutionBackendEvent base):
 *   { timestamp, source: "mux", surface: { kind, id }, ...type-specific }
 *
 * Security note: request.environment is transported through a mode-0600 named
 * pipe (FIFO). The bootstrap script (env-bootstrap.sh) runs inside the pane,
 * opens the FIFO itself, sets the env vars, then exec()s the real command.
 * Environment values never appear in argv, a regular file, or logs. The FIFO
 * path (not its contents) appears in the --command string — this is not a
 * secret. request.secretPipePath has no defined child-side mapping in the v1
 * SPI transport, so launch rejects it instead of silently dropping it — loud
 * rejection is safer than undefined behavior.
 */
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  createEnvironmentPipe,
  createEventQueue,
  createLease,
  environmentBootstrapPath,
  serializeEnvironment,
} from "pi-cohort-mux";

const execFile = promisify(execFileCallback);
const CLI_DEADLINE_MS = 10_000;
const ACK_DEADLINE_MS = 10_000;
const BOOTSTRAP_PATH = environmentBootstrapPath;

// ─── Shell-safe command building ──────────────────────────────────────────────

/** Single-quote-escape a shell token (POSIX). */
function quoteShell(token) {
  return "'" + String(token).replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Build the shell command string passed to cmux --command.
 * Only command + args are included; environment and secretPipePath are
 * intentionally excluded (see security note above).
 */
function buildCommand(command, args) {
  return [command, ...args].map(quoteShell).join(" ");
}

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Returns true only for CLI errors that mean the workspace/surface is gone:
 * the "not_found" token, or cmux 0.65's "<Kind> ref not found: <ref>" for a
 * stale ref. Matches exact wording to reduce false positives.
 * All other errors are transport failures and must propagate.
 */
function isNotFound(error) {
  const text = (error?.message ?? "") + (error?.stderr ?? "");
  return /\bnot_found\b|\b(?:workspace|pane|surface) ref not found\b/i.test(text);
}

// ─── Environment scrubbing ──────────────────────────────────────────────────

/**
 * Drop inherited CMUX_* variables. The new surface receives its own workspace,
 * surface, pane, and socket identity from cmux; forwarding the parent's values
 * through the env pipe would overwrite them and misroute child automation.
 */
function scrubMuxEnvironment(environment) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.startsWith("CMUX_")) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

// ─── Surface ref parsing ─────────────────────────────────────────────────────

/** Parse "OK surface:N pane:M workspace:K" from new-pane/new-surface stdout. */
function parseCreateRefs(output) {
  const text = output.trim();
  const surface = text.match(/(?:^|\s)(surface:\d+)(?:\s|$)/);
  const pane = text.match(/(?:^|\s)(pane:\d+)(?:\s|$)/);
  const workspace = text.match(/(?:^|\s)(workspace:\d+)(?:\s|$)/);
  if (!surface || !workspace) {
    throw new Error(`Unexpected cmux create output: ${JSON.stringify(text)}`);
  }
  return { surfaceRef: surface[1], paneRef: pane?.[1] ?? null, workspaceRef: workspace[1] };
}

/** Parse "OK pane:M" from list/create output that carries no surface. */
function parsePaneRef(output) {
  const match = output.trim().match(/(?:^|\s)(pane:\d+)(?:\s|$)/);
  return match?.[1] ?? null;
}

// ─── Snapshot (list-pane-surfaces) ───────────────────────────────────────────

async function takeSnapshot(execFileFn, cli, workspaceRef, paneRef) {
  const args = ["--id-format", "both", "list-pane-surfaces", "--workspace", workspaceRef, "--json"];
  if (paneRef) args.push("--pane", paneRef);
  const { stdout } = await execFileFn(cli, args, { timeout: CLI_DEADLINE_MS });
  return JSON.parse(stdout);
}

/** True when a cmux event frame names this lease's surface, pane, or workspace.
 * The most specific identity present on the frame must be ours: foreign surface
 * and pane events are dropped; workspace-scoped frames (no surface/pane id)
 * apply to every child in the parent workspace. */
function ownsFrame(frame, owned) {
  if (frame.surface_id) return frame.surface_id === owned.surfaceId;
  if (frame.pane_id) return frame.pane_id === owned.paneId;
  if (frame.workspace_id) return frame.workspace_id === owned.workspaceId;
  return false;
}

// ─── Events subscription ──────────────────────────────────────────────────────

/**
 * Start a long-lived `cmux events` subscription and wait for its ack.
 *
 * Returns:
 *   { ack: Promise, onFrame(listener): disposer, stop(): Promise }
 *
 * ack resolves to the ack frame when cmux acknowledges the subscription.
 * onFrame registers a (frame) -> void listener for subsequent event frames;
 * frames buffered between ack and first listener registration are replayed.
 * stop() kills the subprocess and awaits its exit.
 */
function startSubscription(spawnFn, cli, names, deadline = ACK_DEADLINE_MS) {
  const args = ["events", "--no-heartbeat"];
  for (const name of names) args.push("--name", name);
  const child = spawnFn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });

  let resolveAck;
  let rejectAck;
  const ackPromise = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });

  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  let buffer = "";
  // Frames arriving before the first onFrame listener are buffered.
  const frameBuffer = [];
  let frameListener = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "ack") {
        resolveAck(frame);
      } else if (frameListener) {
        frameListener(frame);
      } else {
        frameBuffer.push(frame);
      }
    }
  });

  const failure = (error) => {
    rejectAck(error);
    if (frameListener) frameListener(null, error);
  };
  child.once("error", failure);
  child.once("exit", (code, signal) => {
    exited = true;
    resolveExit();
    if (code !== 0 && signal !== "SIGTERM") {
      failure(new Error(`cmux events exited with code ${code}, signal ${signal}`));
    }
  });

  const timer = setTimeout(() => rejectAck(new Error("cmux events ack timed out")), deadline);

  return {
    ack: ackPromise.then(
      (frame) => { clearTimeout(timer); return frame; },
      (err) => { clearTimeout(timer); throw err; },
    ),
    onFrame(listener) {
      frameListener = listener;
      for (const frame of frameBuffer.splice(0)) listener(frame);
      return () => { if (frameListener === listener) frameListener = null; };
    },
    async stop() {
      if (!exited) child.kill("SIGTERM");
      await exitPromise;
    },
  };
}

// ─── cmux event translation ───────────────────────────────────────────────────

/**
 * Translate a cmux push-event frame to an SPI-conforming adapter fact.
 * surface must be an ExecutionSurfaceIdentity: { kind: string, id: string }.
 */
function translateCmuxEvent(frame, surface) {
  const name = frame.name;
  const timestamp = Date.now();
  if (name === "surface.closed" || name === "workspace.closed" || name === "pane.closed") {
    return { type: "surface_closed", requested: false, source: "mux", timestamp, surface };
  }
  return { type: "unknown", fact: "cmux_event", reason: "unrecognized cmux event", source: "mux", timestamp, surface };
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a cmux execution backend.
 *
 * @param {object} [options]
 * @param {string} [options.cli="cmux"]        Path to the cmux binary.
 * @param {Function} [options.execFile]        Injected execFile (for testing).
 * @param {Function} [options.spawn]           Injected spawn (for testing).
 */
export function createCmuxExecutionBackend({
  cli = "cmux",
  execFile: execFileFn = (...args) => execFile(...args),
  spawn: spawnFn = spawnProcess,
} = {}) {
  const state = {
    trace: [],
    launches: [],
    closed: new Set(),
    releaseCount: 0,
    subscriptions: 0,
    reconciles: 0,
    lastRequest: undefined,
    helperPane: null,
  };

  return {
    name: "cmux",
    protocolVersion: 1,
    state,

    // ── detect ─────────────────────────────────────────────────────────────

    async detect() {
      try {
        const { stdout: versionOut } = await execFileFn(cli, ["--version"], { timeout: CLI_DEADLINE_MS });
        const { stdout: capsJson } = await execFileFn(cli, ["capabilities"], { timeout: CLI_DEADLINE_MS });
        const caps = JSON.parse(capsJson);
        const capabilities = Array.isArray(caps.capabilities) ? caps.capabilities : [];
        const version = versionOut.trim();
        const available =
          Boolean(process.env.CMUX_WORKSPACE_ID) &&
          Boolean(process.env.CMUX_SOCKET_PATH) &&
          capabilities.includes("events.v1");
        return { available, version, capabilities };
      } catch {
        return { available: false, version: "", capabilities: [] };
      }
    },

    // ── launch ─────────────────────────────────────────────────────────────

    async launch(request) {
      if (request.secretPipePath !== undefined) {
        throw new Error(
          "cmux backend cannot honor ExecutionSurfaceRequest.secretPipePath: the v1 SPI does not define its child-side transport",
        );
      }

      const parentWorkspace = process.env.CMUX_WORKSPACE_ID;
      if (!parentWorkspace) {
        throw new Error("cmux backend requires CMUX_WORKSPACE_ID; launch outside cmux is not supported");
      }

      const environmentPayload = serializeEnvironment(scrubMuxEnvironment(request.environment));

      // Observe (subscribe) before start (surface create) — spike ordering.
      state.trace.push("observe");
      state.lastRequest = request;
      state.launches.push(request);

      const subscription = startSubscription(spawnFn, cli, [
        "surface.closed", "pane.closed", "workspace.closed",
      ]);
      state.subscriptions += 1;

      // Wait for ack before creating the surface so no events are missed.
      try {
        await subscription.ack;
      } catch (error) {
        await subscription.stop();
        throw error;
      }
      state.trace.push("start");

      let environmentPipe;
      try {
        environmentPipe = await createEnvironmentPipe(environmentPayload);
      } catch (error) {
        await subscription.stop();
        throw error;
      }

      // When a FIFO is present, wrap the real command in the bootstrap script:
      // sh env-bootstrap.sh <fifo> <cmd> [args...]
      // The bootstrap runs inside the pane, reads env from the FIFO itself,
      // then exec()s the real command. No --env-file; the FIFO path (not its
      // contents) is the only trace in the createArgs.
      const childCommand = environmentPipe
        ? buildCommand("/bin/sh", [BOOTSTRAP_PATH, environmentPipe.pipePath, request.command, ...request.args])
        : buildCommand(request.command, request.args);
      // cd first: new-pane has no working-directory flag, so keep both create
      // paths identical rather than trusting the pane's inherited cwd.
      const command = `cd ${quoteShell(request.cwd)} && ${childCommand}`;

      // First child creates the right-side helper pane; later children become
      // tabs in it. The pane never holds an idle shell surface. cmux collapses
      // a pane when its last surface closes, so verify before reuse.
      let helper = state.helperPane;
      if (helper) {
        try {
          await takeSnapshot(execFileFn, cli, parentWorkspace, helper.ref);
        } catch {
          helper = null;
          state.helperPane = null;
        }
      }
      const createArgs = helper
        ? ["new-surface", "--workspace", parentWorkspace, "--pane", helper.ref, "--type", "terminal", "--focus", "false", "--command", command]
        : ["new-pane", "--workspace", parentWorkspace, "--type", "terminal", "--direction", "right", "--focus", "false", "--command", command];

      let createRefs;
      try {
        const launch = execFileFn(cli, createArgs, {
          timeout: CLI_DEADLINE_MS,
          signal: request.signal,
        });
        const [result] = await Promise.all([
          launch,
          environmentPipe?.writer.completion ?? Promise.resolve(),
        ]);
        createRefs = parseCreateRefs(result.stdout);
      } catch (error) {
        await subscription.stop();
        throw error;
      } finally {
        await environmentPipe?.cleanup();
      }
      const paneRef = helper?.ref ?? createRefs.paneRef;

      // Snapshot for UUID correlation (spike: three-way UUID correlation).
      const snapshot = await takeSnapshot(execFileFn, cli, parentWorkspace, paneRef);
      const snapshotSurface = snapshot.surfaces?.find((s) => s.ref === createRefs.surfaceRef);
      if (!snapshotSurface) {
        await subscription.stop();
        throw new Error(`created surface ${createRefs.surfaceRef} not present in pane snapshot`);
      }
      state.helperPane = { ref: snapshot.pane_ref ?? paneRef, id: snapshot.pane_id };

      // SPI-conforming handle shape (ExecutionSurfaceHandle).
      const surfaceIdentity = {
        kind: "surface",
        id: snapshotSurface.id,
      };
      const handle = {
        protocolVersion: 1,
        backend: "cmux",
        surface: surfaceIdentity,
        display: {
          label: `cmux:${createRefs.surfaceRef}`,
          hint: `cmux:${snapshot.workspace_ref}/${createRefs.surfaceRef}`,
        },
        data: {
          workspaceId: snapshot.workspace_id,
          workspaceRef: snapshot.workspace_ref,
          paneId: snapshot.pane_id,
          paneRef: snapshot.pane_ref,
          surfaceId: snapshotSurface.id,
          surfaceRef: snapshotSurface.ref,
          title: snapshotSurface.title ?? null,
          type: snapshotSurface.type ?? null,
          cwd: request.cwd,
        },
      };

      const owned = {
        surfaceId: snapshotSurface.id,
        paneId: snapshot.pane_id,
        workspaceId: snapshot.workspace_id,
      };
      const eventQueue = createEventQueue();

      // Wire subscription frames to the lease queue, dropping anything that
      // does not name this lease's surface/pane/workspace — children share the
      // parent workspace, so unfiltered frames would attribute foreign events.
      const removeListener = subscription.onFrame((frame, error) => {
        if (error) {
          eventQueue.push({
            type: "backend_disconnected",
            source: "mux",
            reason: error.message,
            timestamp: Date.now(),
            surface: handle.surface,
          });
        } else if (frame && ownsFrame(frame, owned)) {
          eventQueue.push(translateCmuxEvent(frame, handle.surface));
        }
      });

      // Attach the disposer so release() can call it.
      subscription.removeListener = removeListener;

      return createLease({ handle, request, eventQueue,
        reconcile: (lost) => {
          state.reconciles += 1;
          return [lost ? { ...lost, source: "mux", surface: handle.surface, timestamp: Date.now(), snapshot: true } : { type: "unknown", fact: "snapshot", reason: "mux snapshot", source: "mux", surface: handle.surface, timestamp: Date.now() }];
        },
        releaseTransport: async () => { state.releaseCount += 1; subscription.removeListener?.(); await subscription.stop(); },
      });
    },

    // ── reattach ───────────────────────────────────────────────────────────

    async reattach(handle) {
      const workspaceRef = handle?.data?.workspaceRef;
      if (!workspaceRef) {
        return { status: "unknown", reason: "handle missing workspaceRef; cannot query cmux" };
      }

      // Start live observation BEFORE snapshot — mirror the launch ordering so
      // no events are missed between snapshot and first live delivery.
      const subscription = startSubscription(spawnFn, cli, [
        "surface.closed", "pane.closed", "workspace.closed",
      ]);
      state.subscriptions += 1;

      // Wait for subscription ack before proceeding.
      try {
        await subscription.ack;
      } catch (error) {
        await subscription.stop();
        return { status: "unknown", reason: error.message };
      }

      try {
        const snapshot = await takeSnapshot(execFileFn, cli, workspaceRef, handle.data?.paneRef);
        const snapshotSurface = handle.data?.surfaceId
          ? snapshot.surfaces?.find((s) => s.id === handle.data.surfaceId)
          : snapshot.surfaces?.find((s) => s.ref === handle.data?.surfaceRef);

        if (!snapshotSurface) {
          await subscription.stop();
          return { status: "gone" };
        }

        const reattachedSurface = { kind: "surface", id: snapshotSurface.id };
        const reattachedHandle = {
          ...handle,
          surface: reattachedSurface,
          display: { label: `cmux:${workspaceRef}`, hint: `cmux:${workspaceRef}` },
        };

        const eventQueue = createEventQueue();

        // Pre-populate one snapshot observation fact — actual mux evidence that
        // the surface is alive.  NOT fabricated death events (surface_closed/exited).
        eventQueue.push({
          type: "unknown",
          fact: "snapshot",
          reason: "reattach observation",
          source: "mux",
          snapshot: true,
          timestamp: Date.now(),
          surface: reattachedSurface,
        });

        const owned = {
          surfaceId: snapshotSurface.id,
          paneId: snapshot.pane_id,
          workspaceId: snapshot.workspace_id,
        };
        // Wire subscription frames AFTER pre-populating the snapshot observation
        // so the snapshot always arrives first in the queue.
        const removeListener = subscription.onFrame((frame, error) => {
          if (error) {
            eventQueue.push({
              type: "backend_disconnected",
              source: "mux",
              reason: error.message,
              timestamp: Date.now(),
              surface: reattachedHandle.surface,
            });
          } else if (frame && ownsFrame(frame, owned)) {
            eventQueue.push(translateCmuxEvent(frame, reattachedHandle.surface));
          }
        });
        subscription.removeListener = removeListener;

        return { status: "present", lease: createLease({ handle: reattachedHandle, request: {}, eventQueue,
          reconcile: (lost) => {
            state.reconciles += 1;
            return [lost ? { ...lost, source: "mux", surface: reattachedHandle.surface, timestamp: Date.now(), snapshot: true } : { type: "unknown", fact: "snapshot", reason: "mux snapshot", source: "mux", surface: reattachedHandle.surface, timestamp: Date.now() }];
          },
          releaseTransport: async () => { state.releaseCount += 1; subscription.removeListener?.(); await subscription.stop(); },
        }) };
      } catch (error) {
        await subscription.stop();
        if (isNotFound(error)) return { status: "gone" };
        return { status: "unknown", reason: error.message };
      }
    },

    // ── close ──────────────────────────────────────────────────────────────

    async close(handle, _reason) {
      const surfaceRef = handle?.data?.surfaceRef;
      const workspaceRef = handle?.data?.workspaceRef;
      if (!surfaceRef || !workspaceRef) return; // no-op: nothing to close

      try {
        // Close only the owned surface; the shared helper pane and parent
        // workspace belong to the user and other children.
        await execFileFn(cli, ["close-surface", "--workspace", workspaceRef, "--surface", surfaceRef], { timeout: CLI_DEADLINE_MS });
        state.closed.add(handle.surface?.id ?? surfaceRef);
      } catch (error) {
        if (isNotFound(error)) {
          // Already gone — idempotent absence, not an error.
          state.closed.add(handle.surface?.id ?? surfaceRef);
          return;
        }
        // Transport failure: propagate (strict handle-keyed close).
        throw error;
      }
    },
  };
}

export { createCmuxExecutionBackend as createCmuxBackend };
