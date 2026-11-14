/**
 * cmux execution backend for pi-cohort.
 *
 * Implements the v1 execution-backend SPI:
 *   detect()          — probe cmux availability and capabilities
 *   launch(request)   — add a child surface to the parent workspace
 *   reattach(handle)  — reconnect to an existing surface by opaque handle
 *   close(handle)     — force-close the owned surface by handle (idempotent on not_found)
 *
 * Placement (PI_COHORT_MUX_CMUX_PLACEMENT, default "tab", as herdr's):
 * children are unfocused terminal tabs inside the PARENT workspace — never
 * new workspaces.
 *   tab   — each child is a tab in the pane the parent's own surface
 *           (CMUX_SURFACE_ID) is in at that moment, so the layout never
 *           changes. The pane keeps the tab it showed and the workspace its
 *           focused pane (see keepSelection).
 *   split — mirrors the cohort bridge: one right-side helper pane holds the
 *           children. The first child creates the pane (no idle shell
 *           surface); later children add surfaces to it; cmux collapses the
 *           pane when its last surface closes.
 *
 * Grounded in the cmux-parity spike (doc/spikes/cmux-parity.md):
 *   - Events subscription starts and acks BEFORE surface create.
 *   - Handle UUID comes from the snapshot (list-pane-surfaces --id-format both).
 *   - Only frames that name the owned surface/pane/workspace reach the lease;
 *     children share the parent workspace, so unfiltered events are unsafe.
 *   - close() maps only not-found errors to idempotent absence; other errors propagate.
 *   - reattach() maps not-found errors to { status: "gone" }; other errors to "unknown".
 *   - release() stops the subscription without closing the surface.
 *   - cmux reports a surface closing, never its process exiting. The launcher
 *     records its exit status in an owner-only exit directory before it closes
 *     its own surface, and a close event for the surface with that status
 *     recorded is reported as `exited` before `surface_closed`. A close with
 *     no status (the user closed the tab, say) is not exit evidence.
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
 * path (not its contents) appears in the owner-only launch file — this is not a
 * secret. request.secretPipePath has no defined child-side mapping in the v1
 * SPI transport, so launch rejects it instead of silently dropping it — loud
 * rejection is safer than undefined behavior.
 */
import {
  execFile as execFileCallback,
  spawn as spawnProcess,
} from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
const HANDOFF_DEADLINE_MS = 10_000;
const ORPHAN_GRACE_MS = 3_000;
const SETTLE_DEADLINE_MS = 500;
const COOLDOWN_MS = 60_000;
const PLACEMENTS = ["tab", "split"];
const BOOTSTRAP_PATH = environmentBootstrapPath;
const LAUNCHER_PATH = fileURLToPath(
  new URL("./surface-launch.sh", import.meta.url),
);
const LAUNCH_FILE = "launch.sh";
/** Where surface-launch.sh records its exit status, in the exit directory. */
const EXIT_STATUS_FILE = "status";

// ─── Shell-safe command building ──────────────────────────────────────────────

/** Single-quote-escape a shell token (POSIX). */
function quoteShell(token) {
  return `'${String(token).replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Build the shell command string cmux runs as a surface's initial command.
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
  return /\bnot_found\b|\b(?:workspace|pane|surface) ref not found\b/i.test(
    text,
  );
}

/** True when execFile killed cmux at its deadline (cmux never answered). */
function isCliTimeout(error) {
  return error?.killed === true;
}

/** True when the request's abort signal cancelled the call. */
function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/**
 * True when a create call failed without cmux answering, so cmux may still
 * have made (or later make) the surface: a timeout, an abort, or output we
 * could not parse. An error cmux itself reported means nothing was created.
 */
function createOutcomeUnknown(error) {
  return (
    isCliTimeout(error) ||
    isAbort(error) ||
    error?.unexpectedCreateOutput === true
  );
}

/**
 * Resolve a bare CLI name against this process's PATH. The child surface runs
 * with the cmux app's environment, whose PATH need not reach the CLI, and a
 * late surface must be able to close itself.
 */
async function resolveExecutable(name) {
  if (name.includes("/")) return name;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (
      await access(candidate, fsConstants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return name;
}

// ─── Environment scrubbing ──────────────────────────────────────────────────

/**
 * Drop inherited CMUX_* variables. The new surface receives its own workspace,
 * surface, pane, and socket identity from cmux; forwarding the parent's values
 * through the env pipe would overwrite them and misroute child automation.
 */
const SURFACE_ENVIRONMENT_PREFIX = "CMUX_";

function scrubMuxEnvironment(environment) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.startsWith(SURFACE_ENVIRONMENT_PREFIX)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

// ─── Surface ref parsing ─────────────────────────────────────────────────────

/** Parse the refs from `cmux rpc pane.create|surface.create`'s JSON result. */
function parseCreateRefs(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    result = undefined;
  }
  const ref = (key, kind) =>
    typeof result?.[key] === "string" &&
    new RegExp(`^${kind}:\\d+$`).test(result[key])
      ? result[key]
      : null;
  const surfaceRef = ref("surface_ref", "surface");
  const workspaceRef = ref("workspace_ref", "workspace");
  if (!surfaceRef || !workspaceRef) {
    throw Object.assign(
      new Error(
        `Unexpected cmux create output: ${JSON.stringify(output.trim())}`,
      ),
      { unexpectedCreateOutput: true },
    );
  }
  return { surfaceRef, paneRef: ref("pane_ref", "pane"), workspaceRef };
}

// ─── Owned-surface close ─────────────────────────────────────────────────────

/**
 * close-surface for one owned surface. --force because cmux 0.65 refuses
 * (confirmation_required) while the surface's process runs, and close is
 * called right after the child host shuts down, or to stop a child outright;
 * the surface is ours, so there is no one else to confirm with.
 */
function closeSurfaceArgs(workspaceRef, surfaceRef) {
  return [
    "close-surface",
    "--workspace",
    workspaceRef,
    "--surface",
    surfaceRef,
    "--force",
  ];
}

// ─── Snapshot (list-pane-surfaces) ───────────────────────────────────────────

async function takeSnapshot(
  execFileFn,
  cli,
  workspaceRef,
  paneRef,
  deadline = CLI_DEADLINE_MS,
) {
  const args = [
    "--id-format",
    "both",
    "list-pane-surfaces",
    "--workspace",
    workspaceRef,
    "--json",
  ];
  if (paneRef) args.push("--pane", paneRef);
  const { stdout } = await execFileFn(cli, args, { timeout: deadline });
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
 * onFrame registers a (frame, error) -> void listener for subsequent event
 * frames; frames buffered between ack and first listener registration are
 * replayed, followed by a retained terminal error if the stream already ended.
 * stop() kills the subprocess and awaits its termination.
 *
 * Every termination other than stop() is a failure, whatever its exit code or
 * signal: a stream that ends on its own has stopped observing the surface.
 * Termination is settled on "close" (after stdout drains, so no frame trails
 * the failure) or on a spawn "error", which Node reports without any "exit".
 */
function startSubscription(spawnFn, cli, deadline, names) {
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
  let stopping = false;
  let terminalError = null;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  let buffer = "";
  // Frames arriving before the first onFrame listener are buffered.
  const frameBuffer = [];
  let frameListener = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (
      let newline = buffer.indexOf("\n");
      newline >= 0;
      newline = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
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
    if (terminalError) return;
    terminalError = error;
    rejectAck(error);
    // Retained until a listener attaches: launch wires its listener only
    // after create and snapshot, well after the ack.
    if (frameListener) frameListener(null, error);
  };
  const terminated = (error) => {
    if (exited) return;
    exited = true;
    resolveExit();
    if (!stopping) failure(error);
  };
  child.on("error", (error) => {
    // A spawn failure (no pid) never emits "exit"; settle termination here.
    if (child.pid === undefined) terminated(error);
    else failure(error);
  });
  child.once("close", (code, signal) => {
    terminated(
      new Error(
        `cmux events ended unexpectedly with code ${code}, signal ${signal}`,
      ),
    );
  });

  const timer = setTimeout(
    () => rejectAck(new Error("cmux events ack timed out")),
    deadline,
  );

  return {
    ack: ackPromise.then(
      (frame) => {
        clearTimeout(timer);
        return frame;
      },
      (err) => {
        clearTimeout(timer);
        throw err;
      },
    ),
    onFrame(listener) {
      frameListener = listener;
      for (const frame of frameBuffer.splice(0)) listener(frame);
      if (terminalError) listener(null, terminalError);
      return () => {
        if (frameListener === listener) frameListener = null;
      };
    },
    /** True once the stream has ended on its own; observation is gone. */
    get ended() {
      return terminalError !== null;
    },
    async stop() {
      stopping = true;
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
  if (
    name === "surface.closed" ||
    name === "workspace.closed" ||
    name === "pane.closed"
  ) {
    return {
      type: "surface_closed",
      requested: false,
      source: "mux",
      timestamp,
      surface,
    };
  }
  return {
    type: "unknown",
    fact: "cmux_event",
    reason: "unrecognized cmux event",
    source: "mux",
    timestamp,
    surface,
  };
}

/**
 * The exit status surface-launch.sh recorded in exitDir before it closed its
 * surface, or undefined when it recorded none.
 */
function recordedExitStatus(exitDir) {
  try {
    const text = readFileSync(join(exitDir, EXIT_STATUS_FILE), "utf8").trim();
    return /^\d+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a cmux execution backend.
 *
 * @param {object} [options]
 * @param {string} [options.cli="cmux"]        Path to the cmux binary.
 * @param {Function} [options.execFile]        Injected execFile (for testing).
 * @param {Function} [options.spawn]           Injected spawn (for testing).
 * @param {"tab"|"split"} [options.placement] Overrides
 *   PI_COHORT_MUX_CMUX_PLACEMENT.
 * @param {number} [options.cliDeadlineMs] Bound on each cmux CLI call. Raise
 *   it where cmux answers slowly, such as a freshly booted CI VM.
 * @param {number} [options.ackDeadlineMs] Bound on the events subscription
 *   acknowledging.
 * @param {number} [options.handoffDeadlineMs] Bound on the child reading its
 *   environment after the surface exists (for testing).
 * @param {number} [options.orphanGraceMs] How long an ambiguous create failure
 *   waits for a late surface to report its own id (for testing).
 * @param {number} [options.settleDeadlineMs] How long tab placement waits for
 *   cmux to list a child's tab before leaving the pane's selection alone (for
 *   testing).
 * @param {number} [options.cooldownMs] How long detect() reports cmux
 *   unavailable after a create timed out (for testing).
 * @param {Function} [options.now] Clock for the cool-down (for testing).
 */
export function createCmuxExecutionBackend({
  cli = "cmux",
  execFile: execFileFn = (...args) => execFile(...args),
  spawn: spawnFn = spawnProcess,
  placement = process.env.PI_COHORT_MUX_CMUX_PLACEMENT || "tab",
  cliDeadlineMs = CLI_DEADLINE_MS,
  ackDeadlineMs = ACK_DEADLINE_MS,
  handoffDeadlineMs = HANDOFF_DEADLINE_MS,
  orphanGraceMs = ORPHAN_GRACE_MS,
  settleDeadlineMs = SETTLE_DEADLINE_MS,
  cooldownMs = COOLDOWN_MS,
  now = Date.now,
} = {}) {
  const snapshotOf = (workspaceRef, paneRef) =>
    takeSnapshot(execFileFn, cli, workspaceRef, paneRef, cliDeadlineMs);
  const placementError = PLACEMENTS.includes(placement)
    ? undefined
    : `cmux placement "${placement}" is not supported; set PI_COHORT_MUX_CMUX_PLACEMENT to "tab" or "split"`;
  // Tab placement finds the parent's pane through the parent's own surface.
  const parentSurfaceError = () =>
    placement === "tab" && !process.env.CMUX_SURFACE_ID
      ? "cmux tab placement requires CMUX_SURFACE_ID, the parent's own surface"
      : undefined;

  const state = {
    trace: [],
    launches: [],
    closed: new Set(),
    releaseCount: 0,
    subscriptions: 0,
    reconciles: 0,
    lastRequest: undefined,
    helperPane: null,
    cooldown: null,
  };
  // Errors thrown before cmux was asked to create anything.
  const notCreated = new WeakSet();

  // A create that cmux never answered means its main thread is stalled (a
  // modal window, the app not frontmost). Report cmux unavailable for a while,
  // so pi-cohort's auto selection falls back to native at once instead of
  // every run waiting out the CLI deadline, and fail launches already queued.
  function coolingDownReason() {
    if (!state.cooldown || now() >= state.cooldown.until) return undefined;
    return state.cooldown.reason;
  }
  function coolDownIfStalled(error, call) {
    if (!isCliTimeout(error) || isAbort(error)) return;
    const seconds = Math.round(cooldownMs / 1_000);
    state.cooldown = {
      until: now() + cooldownMs,
      reason: `cmux did not answer ${call} within its deadline (${error.message}); cooling down for ${seconds}s`,
    };
  }

  // Helper-pane selection and surface creation run one launch at a time, so
  // concurrent first launches share one pane instead of each splitting the
  // workspace. Only the create CLI call is serialized, not the env hand-off.
  let helperLock = Promise.resolve();
  async function withHelperLock(operation) {
    const previous = helperLock;
    let unlock;
    helperLock = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  async function createSurface(parentWorkspace, command, signal) {
    return withHelperLock(async () => {
      const cooling = coolingDownReason();
      if (cooling) throw new Error(`cmux backend is cooling down: ${cooling}`);
      // Cool-downs start inside the lock, so launches queued behind this
      // one see them.
      let pane;
      try {
        pane =
          placement === "tab"
            ? await parentPane(parentWorkspace, signal)
            : await helperPane(parentWorkspace);
      } catch (error) {
        notCreated.add(error);
        coolDownIfStalled(error, "a pane lookup");
        throw error;
      }
      try {
        return await createSurfaceUnlocked(
          parentWorkspace,
          pane,
          command,
          signal,
        );
      } catch (error) {
        coolDownIfStalled(error, "a create");
        throw error;
      }
    });
  }

  /** The parent workspace's panes: focus, tabs in order, selected tab. */
  async function listPanes(
    parentWorkspace,
    { signal, timeout = cliDeadlineMs } = {},
  ) {
    const { stdout } = await execFileFn(
      cli,
      [
        "--id-format",
        "both",
        "list-panes",
        "--workspace",
        parentWorkspace,
        "--json",
      ],
      { timeout, signal },
    );
    return JSON.parse(stdout).panes ?? [];
  }

  /**
   * The pane the parent's surface is in right now. The user can drag that
   * tab to another pane between launches, so nothing is remembered, and the
   * focused pane is no substitute: focus may be anywhere.
   */
  async function parentPane(parentWorkspace, signal) {
    const parentSurface = process.env.CMUX_SURFACE_ID;
    const panes = await listPanes(parentWorkspace, { signal });
    const pane = panes.find((p) => p.surface_ids?.includes(parentSurface));
    if (!pane) {
      throw new Error(
        `CMUX_SURFACE_ID ${parentSurface} not found in cmux workspace ${parentWorkspace}; tab placement needs the parent's own pane`,
      );
    }
    return { ref: pane.ref, shown: pane.selected_surface_id };
  }

  /**
   * Put back the tab the parent's pane showed before a child was added to
   * it. cmux 0.65 keeps the selected tab of the pane that has the
   * workspace's focus, but in any other pane it selects the tab it adds,
   * even with focus false, which would cover the parent. It has no call
   * that only selects a tab: reordering a tab to the index it already has
   * selects it and moves the workspace's focus to its pane, so the tab
   * selected in the pane that has the focus is then reordered the same way.
   * Everything but the tab the pane showed comes from one listing taken
   * after the create: only a pane cmux left showing the child is touched,
   * so a tab the user picked or closed, or a focus they moved, while the
   * child was created is respected.
   */
  async function keepSelection(parentWorkspace, pane, childRef) {
    // For a moment after a create, cmux can answer with a listing from
    // before it; one that names the child is current. Launches queue behind
    // this wait, so no listing may outlast it.
    const deadline = Date.now() + settleDeadlineMs;
    let panes;
    let current;
    for (;;) {
      const timeout = Math.min(deadline - Date.now(), cliDeadlineMs);
      if (timeout <= 0) return;
      panes = await listPanes(parentWorkspace, { timeout });
      current = panes.find((p) => p.ref === pane.ref);
      if (current?.surface_refs?.includes(childRef)) break;
      await sleep(25);
    }
    if (current.selected_surface_ref !== childRef) return;
    if (!current.surface_ids.includes(pane.shown)) return;
    // The Dock's pane is listed too, and always reports focus.
    const focused = panes.find((p) => p.focused && !p.dock_scope);
    try {
      await selectInPlace(parentWorkspace, current, pane.shown);
    } finally {
      // Also after a reselect that failed: cmux may have applied it and
      // moved the focus before its answer was lost.
      if (focused?.selected_surface_id && focused !== current) {
        await selectInPlace(
          parentWorkspace,
          focused,
          focused.selected_surface_id,
        );
      }
    }
  }

  /** Select a tab of a listed pane by reordering it to the index it has. */
  async function selectInPlace(parentWorkspace, pane, surface) {
    const index = pane.surface_ids.indexOf(surface);
    await execFileFn(
      cli,
      [
        "reorder-surface",
        "--workspace",
        parentWorkspace,
        "--surface",
        surface,
        "--index",
        String(index),
        "--focus",
        "false",
      ],
      { timeout: cliDeadlineMs },
    );
  }

  /**
   * The live helper pane, if any. The first child creates the right-side
   * helper pane; later children become tabs in it. The pane never holds an
   * idle shell surface. cmux collapses a pane when its last surface closes,
   * so verify before reuse.
   */
  async function helperPane(parentWorkspace) {
    if (!state.helperPane) return null;
    try {
      await snapshotOf(parentWorkspace, state.helperPane.ref);
      return state.helperPane;
    } catch {
      state.helperPane = null;
      return null;
    }
  }

  async function createSurfaceUnlocked(parentWorkspace, pane, command, signal) {
    // The CLI's new-pane/new-surface --command types its text into whatever
    // shell the surface starts (initial_input); the raw v2 methods take
    // initial_command, which cmux runs as the surface's own process.
    const params = {
      workspace_id: parentWorkspace,
      type: "terminal",
      focus: false,
      initial_command: command,
    };
    const [method, target] = pane
      ? ["surface.create", { pane_id: pane.ref }]
      : ["pane.create", { direction: "right" }];
    const createArgs = [
      "rpc",
      method,
      JSON.stringify({ ...params, ...target }),
    ];
    const result = await execFileFn(cli, createArgs, {
      timeout: cliDeadlineMs,
      signal,
    });
    const refs = parseCreateRefs(result.stdout);
    const paneRef = pane?.ref ?? refs.paneRef;
    // Publish the pane before unlocking so the next launch adds a tab to it.
    if (!pane && paneRef) state.helperPane = { ref: paneRef, id: null };
    // Best effort: the child is already starting, and a tab left selected
    // is no reason to fail its launch.
    if (placement === "tab") {
      await keepSelection(parentWorkspace, pane, refs.surfaceRef).catch(
        () => {},
      );
    }
    return { ...refs, paneRef };
  }

  /**
   * After a create whose outcome is unknown, collect a surface cmux made anyway.
   * The surface launcher reports its own CMUX_SURFACE_ID into the launch
   * directory before it opens the FIFO. Withdraw the FIFO first, so a surface
   * that appears from now on refuses to start the child and closes itself;
   * then wait briefly for a report and close exactly the reported surface.
   * Returns the error to reject launch with.
   */
  async function collectOrphan(environmentPipe, parentWorkspace, error) {
    await rm(environmentPipe.pipePath, { force: true });
    const markerPath = join(environmentPipe.directory, "surface-id");
    const deadline = Date.now() + orphanGraceMs;
    let surfaceId = "";
    while (!surfaceId && Date.now() < deadline) {
      surfaceId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
      if (!surfaceId) await sleep(25);
    }
    if (!surfaceId) return error;
    try {
      await execFileFn(cli, closeSurfaceArgs(parentWorkspace, surfaceId), {
        timeout: cliDeadlineMs,
      });
    } catch (closeError) {
      if (!isNotFound(closeError)) {
        return new AggregateError(
          [error, closeError],
          `launch failed and the surface cmux created anyway (${surfaceId}) could not be closed`,
        );
      }
    }
    return error;
  }

  /** Wait for the child to read its environment, bounded and abortable. */
  async function awaitHandoff(environmentPipe, signal) {
    // A child that already read its environment must not outrun an abort
    // that arrived while its tab was being placed.
    signal?.throwIfAborted();
    if (!environmentPipe) return;
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
   * Reconcile a lease from fresh, identity-keyed cmux evidence: the overflowed
   * fact as it was observed, then what a new snapshot shows now, then whether
   * live observation still runs. Nothing cached is presented as current.
   */
  async function reconcileSurface({
    lost,
    surface,
    workspaceRef,
    paneRef,
    surfaceId,
    subscription,
  }) {
    state.reconciles += 1;
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
      const snapshot = await snapshotOf(workspaceRef, paneRef);
      facts.push(
        snapshot.surfaces?.some((s) => s.id === surfaceId)
          ? fact({
              type: "unknown",
              fact: "snapshot",
              reason: "surface present in a fresh cmux snapshot",
              snapshot: true,
            })
          : fact({ type: "surface_closed", requested: false, snapshot: true }),
      );
    } catch (error) {
      facts.push(
        isNotFound(error)
          ? fact({ type: "surface_closed", requested: false, snapshot: true })
          : fact({
              type: "unknown",
              fact: "snapshot",
              reason: `cmux snapshot unavailable: ${error.message}`,
            }),
      );
    }
    if (subscription.ended) {
      facts.push(
        fact({
          type: "backend_disconnected",
          reason: "cmux events stream ended; live observation is not restored",
        }),
      );
    }
    return facts;
  }

  /** Close a surface this launch created but never handed out. */
  async function rollbackSurface(refs, error) {
    try {
      await execFileFn(
        cli,
        closeSurfaceArgs(refs.workspaceRef, refs.surfaceRef),
        { timeout: cliDeadlineMs },
      );
    } catch (closeError) {
      if (isNotFound(closeError)) return error;
      return new AggregateError(
        [error, closeError],
        `launch failed and created surface ${refs.surfaceRef} could not be closed`,
      );
    }
    return error;
  }

  return {
    name: "cmux",
    protocolVersion: 1,
    surfaceEnvironmentPrefixes: [SURFACE_ENVIRONMENT_PREFIX],
    placement,
    state,

    // ── detect ─────────────────────────────────────────────────────────────

    async detect() {
      const cooling = coolingDownReason();
      if (cooling)
        return {
          available: false,
          version: "",
          capabilities: [],
          reason: cooling,
        };
      if (placementError)
        return {
          available: false,
          version: "",
          capabilities: [],
          reason: placementError,
        };
      try {
        const { stdout: versionOut } = await execFileFn(cli, ["--version"], {
          timeout: cliDeadlineMs,
        });
        const { stdout: capsJson } = await execFileFn(cli, ["capabilities"], {
          timeout: cliDeadlineMs,
        });
        const caps = JSON.parse(capsJson);
        const capabilities = Array.isArray(caps.capabilities)
          ? caps.capabilities
          : [];
        const version = versionOut.trim();
        const parentWorkspace = process.env.CMUX_WORKSPACE_ID;
        const available =
          Boolean(parentWorkspace) &&
          Boolean(process.env.CMUX_SOCKET_PATH) &&
          capabilities.includes("events.v1");
        if (!available) return { available, version, capabilities };
        const reason = parentSurfaceError();
        if (reason) return { available: false, version, capabilities, reason };
        // One read-only probe: a stale or foreign CMUX_WORKSPACE_ID would
        // otherwise surface only as a failed launch.
        try {
          await snapshotOf(parentWorkspace);
        } catch (error) {
          const reason = isNotFound(error)
            ? `CMUX_WORKSPACE_ID ${parentWorkspace} not found in cmux`
            : `cmux workspace probe failed: ${error.message}`;
          return { available: false, version, capabilities, reason };
        }
        // Likewise a stale CMUX_SURFACE_ID, or a parent tab since moved to
        // another workspace.
        if (placement === "tab") {
          try {
            await parentPane(parentWorkspace);
          } catch (error) {
            const reason = error.message;
            return { available: false, version, capabilities, reason };
          }
        }
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
        throw new Error(
          "cmux backend requires CMUX_WORKSPACE_ID; launch outside cmux is not supported",
        );
      }
      const unplaceable = placementError ?? parentSurfaceError();
      if (unplaceable) throw new Error(unplaceable);

      const environmentPayload = serializeEnvironment(
        scrubMuxEnvironment(request.environment),
      );
      const cooling = coolingDownReason();
      if (cooling) throw new Error(`cmux backend is cooling down: ${cooling}`);

      // Observe (subscribe) before start (surface create) — spike ordering.
      state.trace.push("observe");
      state.lastRequest = request;
      state.launches.push(request);

      const subscription = startSubscription(spawnFn, cli, ackDeadlineMs, [
        "surface.closed",
        "pane.closed",
        "workspace.closed",
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

      // The exit directory outlives the hand-off, for the launcher's exit
      // status, and goes with the lease.
      let exitDir;
      const removeExitDir = () =>
        exitDir && rm(exitDir, { recursive: true, force: true });
      let environmentPipe;
      try {
        exitDir = await mkdtemp(join(tmpdir(), "pi-cohort-mux-cmux-exit-"));
        environmentPipe = await createEnvironmentPipe(environmentPayload, {
          always: true,
        });
      } catch (error) {
        await removeExitDir();
        await subscription.stop();
        throw error;
      }

      // cmux runs the initial command as the surface's own process, so no
      // shell starts and nothing is typed. cmux holds a surface open after
      // that command exits, so surface-launch.sh closes its own surface when
      // the child exits, as herdr removes a pane: a crashed child leaves no
      // tab behind, and pi-cohort reports the failure to the parent. The
      // command names only fixed paths, since cmux keeps it in its surface
      // records; the request itself (cwd, command, args) goes in an
      // owner-only launch file beside the FIFO, quoted for /bin/sh. The
      // launcher records its exit status in the exit directory.
      // surface-launch.sh reports the surface's own id, refuses an abandoned
      // launch, enters the cwd, and runs env-bootstrap.sh, which reads the
      // environment from the FIFO. Neither the command nor the file carries
      // an environment value.
      let command;
      try {
        command = buildCommand(LAUNCHER_PATH, [
          environmentPipe.directory,
          await resolveExecutable(cli),
          exitDir,
        ]);
        await writeFile(
          join(environmentPipe.directory, LAUNCH_FILE),
          `set -- ${buildCommand(environmentPipe.pipePath, [
            request.cwd,
            BOOTSTRAP_PATH,
            request.command,
            ...request.args,
          ])}\n`,
          { mode: 0o600, flag: "wx" },
        );
      } catch (error) {
        await environmentPipe.cleanup();
        await removeExitDir();
        await subscription.stop();
        throw error;
      }

      let createRefs;
      try {
        createRefs = await createSurface(
          parentWorkspace,
          command,
          request.signal,
        );
      } catch (error) {
        const reported =
          createOutcomeUnknown(error) && !notCreated.has(error)
            ? await collectOrphan(environmentPipe, parentWorkspace, error)
            : error;
        await environmentPipe.cleanup();
        await removeExitDir();
        await subscription.stop();
        throw reported;
      }

      // From here the surface exists. Until a lease is returned, every failure
      // closes exactly that surface and stops the subscription.
      let snapshot;
      let snapshotSurface;
      try {
        try {
          await awaitHandoff(environmentPipe, request.signal);
        } finally {
          await environmentPipe?.cleanup();
        }
        // Snapshot for UUID correlation (spike: three-way UUID correlation).
        // The child has its environment by now, and its surface closes
        // with it, so a child that dies at once takes its surface (and a
        // last-surface helper pane) with it before this snapshot.
        const closedEarly = (cause) =>
          new Error(
            `surface ${createRefs.surfaceRef} closed right after the child started (the child exited, or something else closed it)`,
            { cause },
          );
        try {
          snapshot = await snapshotOf(parentWorkspace, createRefs.paneRef);
        } catch (error) {
          throw isNotFound(error) ? closedEarly(error) : error;
        }
        snapshotSurface = snapshot.surfaces?.find(
          (s) => s.ref === createRefs.surfaceRef,
        );
        if (!snapshotSurface) throw closedEarly();
      } catch (error) {
        const reported = await rollbackSurface(createRefs, error);
        await removeExitDir();
        await subscription.stop();
        throw reported;
      }
      if (
        placement === "split" &&
        (state.helperPane?.ref === createRefs.paneRef || !state.helperPane)
      ) {
        state.helperPane = {
          ref: snapshot.pane_ref ?? createRefs.paneRef,
          id: snapshot.pane_id,
        };
      }

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
      let exitReported = false;

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
          const fact = translateCmuxEvent(frame, handle.surface);
          if (fact.type === "surface_closed" && !exitReported) {
            const status = recordedExitStatus(exitDir);
            if (status !== undefined) {
              exitReported = true;
              eventQueue.push({
                type: "exited",
                status,
                signal: null,
                source: "mux",
                timestamp: fact.timestamp,
                surface: handle.surface,
              });
            }
          }
          eventQueue.push(fact);
        }
      });

      // Attach the disposer so release() can call it.
      subscription.removeListener = removeListener;

      return createLease({
        handle,
        request,
        eventQueue,
        reconcile: (lost) =>
          reconcileSurface({
            lost,
            surface: handle.surface,
            workspaceRef: snapshot.workspace_ref ?? parentWorkspace,
            paneRef: snapshot.pane_ref ?? createRefs.paneRef,
            surfaceId: snapshotSurface.id,
            subscription,
          }),
        releaseTransport: async () => {
          state.releaseCount += 1;
          subscription.removeListener?.();
          await subscription.stop();
          await removeExitDir();
        },
      });
    },

    // ── reattach ───────────────────────────────────────────────────────────

    async reattach(handle) {
      const workspaceRef = handle?.data?.workspaceRef;
      if (!workspaceRef) {
        return {
          status: "unknown",
          reason: "handle missing workspaceRef; cannot query cmux",
        };
      }

      // Start live observation BEFORE snapshot — mirror the launch ordering so
      // no events are missed between snapshot and first live delivery.
      const subscription = startSubscription(spawnFn, cli, ackDeadlineMs, [
        "surface.closed",
        "pane.closed",
        "workspace.closed",
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
        const snapshot = await snapshotOf(workspaceRef, handle.data?.paneRef);
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
          display: {
            label: `cmux:${workspaceRef}`,
            hint: `cmux:${workspaceRef}`,
          },
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
            eventQueue.push(
              translateCmuxEvent(frame, reattachedHandle.surface),
            );
          }
        });
        subscription.removeListener = removeListener;

        return {
          status: "present",
          lease: createLease({
            handle: reattachedHandle,
            request: {},
            eventQueue,
            reconcile: (lost) =>
              reconcileSurface({
                lost,
                surface: reattachedHandle.surface,
                workspaceRef,
                paneRef: handle.data?.paneRef ?? snapshot.pane_ref,
                surfaceId: snapshotSurface.id,
                subscription,
              }),
            releaseTransport: async () => {
              state.releaseCount += 1;
              subscription.removeListener?.();
              await subscription.stop();
            },
          }),
        };
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
        await execFileFn(cli, closeSurfaceArgs(workspaceRef, surfaceRef), {
          timeout: cliDeadlineMs,
        });
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

// The adapter convention: "./execution-backend" default-exports the factory.
export default createCmuxExecutionBackend;
