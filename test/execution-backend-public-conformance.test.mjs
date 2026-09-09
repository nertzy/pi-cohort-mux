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
import { createCmuxBackend } from "../src/cmux-backend.js";

const jiti = createJiti(import.meta.url);
const kit = await jiti.import("pi-cohort/execution-backend-testkit");
const { registerExecutionBackendConformance, wrapWithConformanceHarness, CONFORMANCE_TEST_COUNT } = kit;

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
          JSON.stringify({ type: "ack", subscription_id: "conf-sub", version: 1 }) + "\n",
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
    });
  }
}

// ─── Stateful fake IO factory ─────────────────────────────────────────────────

/**
 * Creates a stateful fake cmux CLI (execFile + spawn) for conformance testing.
 * Tracks created workspaces and closed workspaces so reattach-after-close
 * returns "gone" and reattach-without-close returns "present".
 */
function makeStatefulFakeIo() {
  const workspaces = new Map(); // workspaceRef → snapshot
  const closedWorkspaces = new Set();
  let nextNum = 1;

  async function execFile(_cli, args, _opts) {
    if (args[0] === "--version") {
      return { stdout: "cmux 0.64.22\n", stderr: "" };
    }
    if (args[0] === "capabilities") {
      return { stdout: JSON.stringify({ capabilities: ["events.v1"] }) + "\n", stderr: "" };
    }
    if (args[0] === "workspace" && args[1] === "create") {
      // Read from the env-file FIFO (if present) so the tee writer can complete.
      const envFileIndex = args.indexOf("--env-file");
      if (envFileIndex !== -1) await readFile(args[envFileIndex + 1], "utf8");
      const n = nextNum++;
      const wsRef = `workspace:${n}`;
      const snapshot = {
        workspace_id: `ws-id-${n}`,
        workspace_ref: wsRef,
        pane_id: `pane-id-${n}`,
        pane_ref: `pane:${n}`,
        surfaces: [
          { id: `sf-id-${n}`, ref: `surface:${n}`, title: "conformance", type: "terminal" },
        ],
      };
      workspaces.set(wsRef, snapshot);
      return { stdout: `OK ${wsRef}\n`, stderr: "" };
    }
    if (args[0] === "--id-format" && args[1] === "both" && args[2] === "list-pane-surfaces") {
      const wsIdx = args.indexOf("--workspace");
      const wsRef = args[wsIdx + 1];
      if (closedWorkspaces.has(wsRef)) {
        const err = Object.assign(new Error("not_found"), {
          stderr: "Error: not_found: Workspace not found",
        });
        throw err;
      }
      const snap = workspaces.get(wsRef);
      if (!snap) {
        const err = Object.assign(new Error("not_found"), {
          stderr: "Error: not_found: Workspace not found",
        });
        throw err;
      }
      return { stdout: JSON.stringify(snap) + "\n", stderr: "" };
    }
    if (args[0] === "workspace" && args[1] === "close") {
      closedWorkspaces.add(args[2]);
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
  assert.equal(registered, CONFORMANCE_TEST_COUNT, `expected ${CONFORMANCE_TEST_COUNT} tests registered`);
});
