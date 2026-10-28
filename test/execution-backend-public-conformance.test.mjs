/**
 * cmux execution backend — public core testkit conformance
 *
 * Wires the cmux backend through the authoritative `pi-cohort/execution-backend-testkit`
 * (imported via Jiti) using a stateful fake CLI and the core `wrapWithConformanceHarness`.
 *
 * This replaces the historical spike (test/fixtures/execution-backend/) as the
 * production conformance authority. The spike files remain for reference, clearly
 * labeled as historical.
 *
 * Determinism: all CLI calls are intercepted by a stateful fake IO; the test suite
 * runs without any live cmux session, binary, or CMUX environment variables.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";
import { createCmuxBackend } from "../packages/pi-cohort-mux-cmux/src/cmux-backend.js";
import { launchOf } from "./fixtures/cmux-launch.mjs";

const jiti = createJiti(import.meta.url);
const kit = await jiti.import("pi-cohort/execution-backend-testkit");
const {
  registerExecutionBackendConformance,
  wrapWithConformanceHarness,
  CONFORMANCE_TEST_COUNT,
} = kit;

// ─── Fake events subprocess ───────────────────────────────────────────────────

class FakeEventsChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this._killed = false;
    setImmediate(() => {
      if (!this._killed) {
        this.stdout.push(
          `${JSON.stringify({
            type: "ack",
            subscription_id: "conf-sub",
            version: 1,
          })}\n`,
        );
      }
    });
  }

  kill(signal) {
    if (this._killed) return;
    this._killed = true;
    setImmediate(() => {
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit("exit", 0, signal ?? "SIGTERM");
      this.emit("close", 0, signal ?? "SIGTERM");
    });
  }
}

// ─── Stateful fake IO factory ─────────────────────────────────────────────────

// launch() derives the parent workspace from the environment; pin it hermetically.
process.env.CMUX_WORKSPACE_ID ??= "ws-id-parent";

/**
 * Creates a stateful fake cmux CLI (execFile + spawn) for conformance testing.
 * Models bridge-parity placement: children are surfaces in a helper pane of the
 * parent workspace. Tracks created and closed surfaces so reattach-after-close
 * returns "gone" and reattach-without-close returns "present".
 */
function makeStatefulFakeIo() {
  const surfaces = new Map(); // surfaceRef → { paneRef, surface: {...} }
  const panes = new Map(); // paneRef → { paneId, surfaceRefs: Set }
  const workspaceRef = "workspace:1";
  const workspaceId = "ws-id-parent";
  let nextNum = 1;

  function snapshotFor(paneRef) {
    if (paneRef) {
      const pane = panes.get(paneRef);
      if (!pane) {
        const err = Object.assign(new Error("not_found"), {
          stderr: "Error: not_found: Pane not found",
        });
        throw err;
      }
      return {
        workspace_id: workspaceId,
        workspace_ref: workspaceRef,
        pane_id: pane.paneId,
        pane_ref: paneRef,
        surfaces: [...pane.surfaceRefs].map((ref) => surfaces.get(ref).surface),
      };
    }
    return {
      workspace_id: workspaceId,
      workspace_ref: workspaceRef,
      pane_id: "pane-id-0",
      pane_ref: "pane:0",
      surfaces: [...surfaces.values()].map((entry) => entry.surface),
    };
  }

  async function execFile(_cli, args, _opts) {
    if (args[0] === "--version") {
      return { stdout: "cmux 0.64.22\n", stderr: "" };
    }
    if (args[0] === "capabilities") {
      return {
        stdout: `${JSON.stringify({ capabilities: ["events.v1"] })}\n`,
        stderr: "",
      };
    }
    if (args[0] === "new-pane" || args[0] === "new-surface") {
      // The launch file names the FIFO; drain it so the background tee
      // writer can complete.
      if (args.includes("--command"))
        await readFile(launchOf(args).fifo, "utf8");
      let paneRef;
      if (args[0] === "new-pane") {
        paneRef = `pane:${nextNum}`;
        panes.set(paneRef, {
          paneId: `pane-id-${nextNum}`,
          surfaceRefs: new Set(),
        });
      } else {
        paneRef = args[args.indexOf("--pane") + 1];
        if (!panes.has(paneRef)) {
          const err = Object.assign(new Error("not_found"), {
            stderr: "Error: not_found: Pane not found",
          });
          throw err;
        }
      }
      const n = nextNum++;
      const surfaceRef = `surface:${n}`;
      const surface = {
        id: `sf-id-${n}`,
        ref: surfaceRef,
        title: "conformance",
        type: "terminal",
      };
      surfaces.set(surfaceRef, { paneRef, surface });
      panes.get(paneRef).surfaceRefs.add(surfaceRef);
      return {
        stdout: `OK ${surfaceRef} ${paneRef} ${workspaceRef}\n`,
        stderr: "",
      };
    }
    if (
      args[0] === "--id-format" &&
      args[1] === "both" &&
      args[2] === "list-pane-surfaces"
    ) {
      const paneIdx = args.indexOf("--pane");
      return {
        stdout: `${JSON.stringify(
          snapshotFor(paneIdx === -1 ? null : args[paneIdx + 1]),
        )}\n`,
        stderr: "",
      };
    }
    if (args[0] === "close-surface") {
      const surfaceRef = args[args.indexOf("--surface") + 1];
      const entry = surfaces.get(surfaceRef);
      if (!entry) {
        const err = Object.assign(new Error("not_found"), {
          stderr: "Error: not_found: Surface not found",
        });
        throw err;
      }
      panes.get(entry.paneRef)?.surfaceRefs.delete(surfaceRef);
      surfaces.delete(surfaceRef);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fake cmux exec: ${args.join(" ")}`);
  }

  function spawn(_cli, _args, _opts) {
    return new FakeEventsChild();
  }

  return { execFile, spawn };
}

// ─── Conformance registration ─────────────────────────────────────────────────

const registered = registerExecutionBackendConformance({
  test,
  name: "cmux backend (core testkit)",
  createBackend: () => {
    const io = makeStatefulFakeIo();
    return createCmuxBackend({ execFile: io.execFile, spawn: io.spawn });
  },
  createHarness: (backend) => wrapWithConformanceHarness(backend),
  prohibitedValues: [],
});

test("conformance suite registers the expected number of core testkit cases", () => {
  assert.equal(
    registered,
    CONFORMANCE_TEST_COUNT,
    `expected ${CONFORMANCE_TEST_COUNT} tests registered`,
  );
});
