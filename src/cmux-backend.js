/**
 * cmux execution backend for pi-cohort.
 *
 * Implements the v1 execution-backend SPI:
 *   detect()          — probe cmux availability and capabilities
 *   launch(request)   — create a workspace surface, subscribe to events
 *   reattach(handle)  — reconnect to an existing surface by opaque handle
 *   close(handle)     — close a workspace surface by handle (idempotent on not_found)
 *
 * Grounded in the cmux-parity spike (doc/spikes/cmux-parity.md):
 *   - Events subscription starts and acks BEFORE workspace create.
 *   - Handle UUID comes from the snapshot (list-pane-surfaces --id-format both).
 *   - close() maps only "not_found" to idempotent absence; other errors propagate.
 *   - reattach() maps "not_found" to { status: "gone" }; other errors to "unknown".
 *   - release() stops the subscription without closing the surface.
 *   - No screen scraping, send-keys, focus stealing, or intercom env vars.
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
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createEventQueue } from "./event-queue.js";

/**
 * Path to the POSIX shell bootstrap that reads env from a FIFO then execs the
 * real command. Resolved relative to this source file so it works regardless
 * of the process CWD. Invoked via /bin/sh to avoid an executable-bit dependency.
 */
const BOOTSTRAP_PATH = fileURLToPath(new URL("./env-bootstrap.sh", import.meta.url));

const execFile = promisify(execFileCallback);
const CLI_DEADLINE_MS = 10_000;
const ACK_DEADLINE_MS = 10_000;

function serializeEnvironment(environment) {
  return Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("cmux backend cannot encode an environment variable name");
    }
    if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.trim() !== value) {
      throw new Error(`cmux backend cannot encode environment variable ${key}`);
    }
    if (value.length >= 2 && (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    )) {
      throw new Error(`cmux backend cannot encode environment variable ${key}`);
    }
    return `${key}=${value}\n`;
  }).join("");
}

function startNamedPipeWriter(pipePath, payload) {
  const child = spawnProcess("/usr/bin/tee", [pipePath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`environment pipe writer exited with code ${code}, signal ${signal}`));
    });
  });
  child.stdin.end(payload, "utf8");
  return {
    completion,
    abort() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

async function createEnvironmentPipe(payload) {
  if (payload === "") return undefined;

  const directory = await mkdtemp(join(tmpdir(), "pi-cohort-mux-env-"));
  const pipePath = join(directory, "environment.fifo");
  try {
    await execFile("mkfifo", ["-m", "600", pipePath]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const writer = startNamedPipeWriter(pipePath, payload);
  return {
    pipePath,
    writer,
    async cleanup() {
      writer.abort();
      await writer.completion.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

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
 * Returns true only for "not_found" CLI errors (workspace/surface gone).
 * Matches the exact cmux error token to reduce false positives.
 * All other errors are transport failures and must propagate.
 */
function isNotFound(error) {
  const text = (error?.message ?? "") + (error?.stderr ?? "");
  return /\bnot_found\b/i.test(text);
}

// ─── Workspace ref parsing ────────────────────────────────────────────────────

/** Parse "OK workspace:N\n" from cmux workspace create stdout. */
function parseWorkspaceRef(output) {
  const match = output.trim().match(/^OK (workspace:\d+)$/);
  if (!match) {
    throw new Error(`Unexpected cmux workspace create output: ${JSON.stringify(output.trim())}`);
  }
  return match[1];
}

// ─── Snapshot (list-pane-surfaces) ───────────────────────────────────────────

async function takeSnapshot(execFileFn, cli, workspaceRef) {
  const { stdout } = await execFileFn(
    cli,
    ["--id-format", "both", "list-pane-surfaces", "--workspace", workspaceRef, "--json"],
    { timeout: CLI_DEADLINE_MS },
  );
  return JSON.parse(stdout);
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

// ─── Lease factory ────────────────────────────────────────────────────────────

function makeLease({ state, handle, request, eventQueue, subscription }) {
  let releaseCount = 0;

  return {
    handle,
    events: eventQueue.events,
    request,

    async reconcile() {
      state.reconciles += 1;
      const lost = eventQueue.lostAuthoritativeFact;
      const facts = lost
        ? [{ ...lost, source: "mux", surface: handle.surface, timestamp: Date.now(), snapshot: true }]
        : [{ type: "unknown", fact: "snapshot", reason: "mux snapshot", source: "mux", surface: handle.surface, timestamp: Date.now() }];
      eventQueue.resumeFromSuspension();
      return facts;
    },

    async release() {
      if (releaseCount > 0) return;
      releaseCount += 1;
      state.releaseCount += 1;
      if (subscription) {
        subscription.removeListener?.();
        await subscription.stop();
      }
      eventQueue.finish();
    },

    push: (event) => eventQueue.push(event),
    get suspended() { return eventQueue.suspended; },
    get released() { return eventQueue.released; },
    get queuedEvents() { return eventQueue.queuedEvents; },
  };
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

      const environmentPayload = serializeEnvironment(request.environment);

      // Observe (subscribe) before start (workspace create) — spike ordering.
      state.trace.push("observe");
      state.lastRequest = request;
      state.launches.push(request);

      const subscription = startSubscription(spawnFn, cli, [
        "workspace.created", "surface.created", "surface.closed",
        "pane.closed", "workspace.closed",
      ]);
      state.subscriptions += 1;

      // Wait for ack before creating workspace so no events are missed.
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
      const command = environmentPipe
        ? buildCommand("/bin/sh", [BOOTSTRAP_PATH, environmentPipe.pipePath, request.command, ...request.args])
        : buildCommand(request.command, request.args);
      const workspaceName = `pi-cohort-${randomUUID()}`;
      const createArgs = [
        "workspace", "create",
        "--name", workspaceName,
        "--cwd", request.cwd,
        "--focus", "false",
        "--command", command,
      ];

      let createOut;
      try {
        const launch = execFileFn(cli, createArgs, {
          timeout: CLI_DEADLINE_MS,
          signal: request.signal,
        });
        const [result] = await Promise.all([
          launch,
          environmentPipe?.writer.completion ?? Promise.resolve(),
        ]);
        createOut = result.stdout;
      } catch (error) {
        await subscription.stop();
        throw error;
      } finally {
        await environmentPipe?.cleanup();
      }
      const workspaceRef = parseWorkspaceRef(createOut);

      // Snapshot for UUID correlation (spike: three-way UUID correlation).
      const snapshot = await takeSnapshot(execFileFn, cli, workspaceRef);
      const snapshotSurface = snapshot.surfaces?.[0];

      // SPI-conforming handle shape (ExecutionSurfaceHandle).
      const surfaceIdentity = {
        kind: "pane",
        id: snapshotSurface?.id ?? snapshot.workspace_id,
      };
      const handle = {
        protocolVersion: 1,
        backend: "cmux",
        surface: surfaceIdentity,
        display: {
          label: `cmux:${workspaceRef}`,
          hint: `cmux:${workspaceRef}`,
        },
        data: {
          workspaceId: snapshot.workspace_id,
          workspaceRef: snapshot.workspace_ref,
          paneId: snapshot.pane_id,
          paneRef: snapshot.pane_ref,
          surfaceId: snapshotSurface?.id ?? null,
          surfaceRef: snapshotSurface?.ref ?? null,
          title: snapshotSurface?.title ?? null,
          type: snapshotSurface?.type ?? null,
          cwd: request.cwd,
        },
      };

      const eventQueue = createEventQueue();

      // Wire subscription frames to the lease queue.
      const removeListener = subscription.onFrame((frame, error) => {
        if (error) {
          eventQueue.push({
            type: "backend_disconnected",
            source: "mux",
            reason: error.message,
            timestamp: Date.now(),
            surface: handle.surface,
          });
        } else if (frame) {
          eventQueue.push(translateCmuxEvent(frame, handle.surface));
        }
      });

      // Attach the disposer so release() can call it.
      subscription.removeListener = removeListener;

      return makeLease({ state, handle, request, eventQueue, subscription });
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
        "workspace.created", "surface.created", "surface.closed",
        "pane.closed", "workspace.closed",
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
        const snapshot = await takeSnapshot(execFileFn, cli, workspaceRef);
        const snapshotSurface = handle.data?.surfaceId
          ? snapshot.surfaces?.find((s) => s.id === handle.data.surfaceId)
          : snapshot.surfaces?.[0];

        if (!snapshotSurface) {
          await subscription.stop();
          return { status: "gone" };
        }

        const reattachedSurface = { kind: "pane", id: snapshotSurface.id };
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
          } else if (frame) {
            eventQueue.push(translateCmuxEvent(frame, reattachedHandle.surface));
          }
        });
        subscription.removeListener = removeListener;

        return { status: "present", lease: makeLease({ state, handle: reattachedHandle, request: {}, eventQueue, subscription }) };
      } catch (error) {
        await subscription.stop();
        if (isNotFound(error)) return { status: "gone" };
        return { status: "unknown", reason: error.message };
      }
    },

    // ── close ──────────────────────────────────────────────────────────────

    async close(handle, _reason) {
      const workspaceRef = handle?.data?.workspaceRef;
      if (!workspaceRef) return; // no-op: nothing to close

      try {
        await execFileFn(cli, ["workspace", "close", workspaceRef], { timeout: CLI_DEADLINE_MS });
        state.closed.add(handle.surface?.id ?? workspaceRef);
      } catch (error) {
        if (isNotFound(error)) {
          // Already gone — idempotent absence, not an error.
          state.closed.add(handle.surface?.id ?? workspaceRef);
          return;
        }
        // Transport failure: propagate (strict handle-keyed close).
        throw error;
      }
    },
  };
}

export { createCmuxExecutionBackend as createCmuxBackend };
