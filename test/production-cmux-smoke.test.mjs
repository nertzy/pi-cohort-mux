/**
 * Opt-in production smoke test for the cmux execution backend.
 *
 * Exercises createCmuxBackend with the actual `cmux` CLI — no injected fakes.
 * Tests the full lifecycle end-to-end:
 *   detect → launch → evidence → release-retains → reattach → close → verify-gone
 *
 * Run with:
 *   PI_COHORT_MUX_PRODUCTION_CMUX_SMOKE=1 node --test test/production-cmux-smoke.test.mjs
 *
 * Guard: skipped unless PI_COHORT_MUX_PRODUCTION_CMUX_SMOKE=1 AND cmux available.
 * No existing workspaces/surfaces are altered; only OWN created workspace is closed.
 *
 * Environment sentinel note:
 *   The backend passes environment vars via a named FIFO (--env-file <fifo>).
 *   The real cmux server cannot open FIFOs (POSIX EACCES — macOS API restriction
 *   on the server side). Passing a non-empty environment causes workspace create
 *   to fail. This smoke therefore passes environment: {} (no FIFO) and verifies
 *   command delivery and cwd via an argv-based sentinel instead. The FIFO
 *   incompatibility is documented as a residual risk.
 *
 * On completion (pass or fail), writes a structured report to:
 *   /tmp/pi-cohort-mux-production-cmux-smoke.md
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createCmuxBackend } from "../src/cmux-backend.js";

const execFile = promisify(execFileCallback);

const SMOKE_FLAG = "PI_COHORT_MUX_PRODUCTION_CMUX_SMOKE";
const EVIDENCE_DEADLINE_MS = 15_000;
const CLI_DEADLINE_MS = 10_000;
const SENTINEL_WRITER = fileURLToPath(
  new URL("fixtures/production-smoke/sentinel-writer.mjs", import.meta.url),
);

// ─── Opt-in guard ─────────────────────────────────────────────────────────────

const optedIn = process.env[SMOKE_FLAG] === "1";

// Probe cmux availability at module load time — only when opted in to avoid
// spawning subprocesses in normal test runs that don't set the flag.
let probe = { available: false, version: "", capabilities: [] };
if (optedIn) {
  try {
    probe = await createCmuxBackend().detect();
  } catch (error) {
    probe = { available: false, version: "", capabilities: [], error };
  }
}

const skipReason = !optedIn
  ? `set ${SMOKE_FLAG}=1 to run production cmux smoke`
  : !probe.available
    ? `cmux not available (events.v1/CMUX env missing): ${probe.error?.message ?? "not inside a cmux session"}`
    : false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Poll for a file to appear, returning its contents when found. */
async function pollForFile(filePath, deadline = EVIDENCE_DEADLINE_MS) {
  const end = Date.now() + deadline;
  while (Date.now() < end) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Evidence file not found within ${deadline}ms: ${filePath}`);
}

/** Returns true only when list-pane-surfaces returns a not_found error. */
async function verifyGone(workspaceRef) {
  try {
    await execFile(
      "cmux",
      ["--id-format", "both", "list-pane-surfaces", "--workspace", workspaceRef, "--json"],
      { timeout: CLI_DEADLINE_MS },
    );
    return false;
  } catch (error) {
    const text = (error?.message ?? "") + (error?.stderr ?? "");
    return /not_found/i.test(text);
  }
}

// ─── Production smoke test ────────────────────────────────────────────────────

test(
  "production cmux backend: launch → evidence → release-retains → reattach → close → verify-gone",
  { skip: skipReason || false },
  async () => {
    // Use empty environment to avoid FIFO creation.
    // The real cmux server cannot open FIFOs (EACCES, macOS API restriction).
    // Command delivery and cwd are verified via an argv-based sentinel instead.
    const backend = createCmuxBackend(); // real cmux CLI — no injection

    // State tracked across the try/finally so cleanup is unconditional.
    let tempDir;
    let expectedCwd;
    let launchLease;
    let reattachLease;
    let launchedWorkspaceRef;
    let testPassed = false;

    // Report accumulator — written in finally on both pass and fail paths.
    const report = {
      cliVersion: probe.version,
      available: probe.available,
      execPath: "cmux (PATH-resolved)",
    };

    try {
      // ── Resolve exact cmux binary path for the report ─────────────────────
      try {
        const { stdout } = await execFile("which", ["cmux"], { timeout: 2_000 });
        report.execPath = stdout.trim();
      } catch {
        // leave default
      }

      // ── Temp directory (realpath needed — macOS /tmp → /private/tmp) ───────
      tempDir = await mkdtemp(join(tmpdir(), "pi-cohort-mux-smoke-"));
      expectedCwd = await realpath(tempDir);
      const evidenceFile = join(tempDir, "evidence.json");

      // Synthetic sentinel: random UUID so evidence belongs unambiguously to
      // THIS specific workspace invocation.
      const sentinel = `smoke-sentinel-${randomUUID()}`;

      // ── detect sanity ─────────────────────────────────────────────────────
      assert.equal(probe.available, true, "cmux must be available for production smoke");
      assert.match(probe.version, /^cmux \d+/, "version string starts with cmux N");

      // ── launch with real cmux CLI ─────────────────────────────────────────
      // environment: {} avoids FIFO creation (cmux server cannot open FIFOs).
      // The sentinel is passed as an argv arg; the child echoes it back so
      // the test can verify this specific workspace's command was executed.
      launchLease = await backend.launch({
        command: process.execPath,
        args: [SENTINEL_WRITER, evidenceFile, sentinel],
        cwd: tempDir,
        environment: {}, // empty — no FIFO created; see module-level note
        runId: "smoke-run-1",
        childId: "smoke-child-1",
        signal: new AbortController().signal,
      });

      const handle = launchLease.handle;
      launchedWorkspaceRef = handle.data.workspaceRef;
      const ownedUUID = handle.surface.id;

      report.workspaceRef = launchedWorkspaceRef;
      report.surfaceUUID = ownedUUID;
      report.workspaceLabel = handle.display.label;

      // ── assert handle shape ───────────────────────────────────────────────
      assert.equal(handle.backend, "cmux", "handle.backend is cmux");
      assert.equal(handle.protocolVersion, 1, "handle.protocolVersion is 1");
      assert.equal(handle.surface.kind, "pane", "handle.surface.kind is pane");
      assert.match(
        ownedUUID,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "surface.id is a UUID (from snapshot)",
      );
      assert.ok(launchedWorkspaceRef, "workspaceRef present in handle.data");
      assert.equal(
        Object.keys(handle.data).sort().join(","),
        "cwd,paneId,paneRef,surfaceId,surfaceRef,title,type,workspaceId,workspaceRef",
        "handle.data has the nine expected keys",
      );

      // ── await sentinel evidence from child (bounded poll) ─────────────────
      const evidenceRaw = await pollForFile(evidenceFile, EVIDENCE_DEADLINE_MS);
      const evidence = JSON.parse(evidenceRaw);

      // argv sentinel: proves THIS specific child ran (not another workspace).
      assert.equal(evidence.sentinelEcho, sentinel, "child echoed back the argv sentinel (correct command delivered)");
      assert.equal(evidence.sentinelMatch, true, "argv sentinel equality is true in child");

      // cwd: proves the requested working directory was honored.
      assert.equal(evidence.cwd, expectedCwd, "child cwd matches the requested cwd from launch request");

      report.evidenceSentinelEcho = evidence.sentinelEcho === sentinel;
      report.evidenceSentinelMatch = evidence.sentinelMatch;
      report.evidenceCwdMatch = evidence.cwd === expectedCwd;
      report.evidenceEnvSentinelPresent = evidence.envSentinelPresent;
      report.evidenceEnvSentinelMatch = evidence.envSentinelMatch;

      // ── release launch lease (observer: stops subscription, retains surface) ─
      await launchLease.release();
      launchLease = null;
      report.releaseRetained = true;

      // ── reattach to live workspace ────────────────────────────────────────
      const reattachResult = await backend.reattach(handle);
      assert.equal(reattachResult.status, "present", "workspace still present after release (release retains)");
      reattachLease = reattachResult.lease;
      report.reattachStatus = reattachResult.status;

      // First event from reattach must be a snapshot observation — not a death event.
      const snapshotFact = (await reattachLease.events.next()).value;
      assert.equal(snapshotFact.snapshot, true, "first reattach event is a snapshot observation");
      assert.notEqual(snapshotFact.type, "surface_closed", "snapshot observation must not be a death event");
      assert.notEqual(snapshotFact.type, "exited", "snapshot observation must not be an exited event");

      // ── release reattach lease (retains surface, stops subscription) ──────
      await reattachLease.release();
      reattachLease = null;

      // ── close ONLY OWN workspace (by handle UUID) ─────────────────────────
      await backend.close(handle, "smoke_test_cleanup");

      // ── verify workspace is gone (not_found from list-pane-surfaces) ──────
      const gone = await verifyGone(launchedWorkspaceRef);
      assert.equal(gone, true, "workspace is gone after close (not_found from list-pane-surfaces)");
      report.closedAndGone = gone;
      launchedWorkspaceRef = undefined; // cleared — prevents double-close in finally
      testPassed = true;

    } finally {
      // Unconditional cleanup — ensures no owned workspace leaks on failure.
      if (launchLease) await launchLease.release().catch(() => {});
      if (reattachLease) await reattachLease.release().catch(() => {});
      if (launchedWorkspaceRef) {
        // Workspace was not closed by the test body (failed before close step).
        await execFile(
          "cmux",
          ["workspace", "close", launchedWorkspaceRef],
          { timeout: CLI_DEADLINE_MS },
        ).catch(() => {}); // not_found is fine — idempotent
      }
      if (tempDir) await rm(tempDir, { recursive: true, force: true });

      report.ownedWorkspaceCleanedUp = !launchedWorkspaceRef;
      report.rawExit = testPassed ? 0 : 1;

      // Write required report to /tmp.
      const reportLines = [
        "# pi-cohort-mux production cmux smoke report",
        "",
        `- raw exit: ${report.rawExit ?? 1}`,
        `- cli version: ${report.cliVersion}`,
        `- exact path executed: ${report.execPath}`,
        `- available: ${report.available}`,
        `- workspace ref: ${report.workspaceRef ?? "(not created)"}`,
        `- surface UUID: ${report.surfaceUUID ?? "(not created)"}`,
        `- workspace label: ${report.workspaceLabel ?? "(not created)"}`,
        `- argv sentinel match: ${report.evidenceSentinelMatch ?? "(not verified)"}`,
        `- argv sentinel echo: ${report.evidenceSentinelEcho ?? "(not verified)"}`,
        `- child cwd match: ${report.evidenceCwdMatch ?? "(not verified)"}`,
        `- env sentinel present (FIFO): ${report.evidenceEnvSentinelPresent ?? "(not verified)"}`,
        `- env sentinel match (FIFO): ${report.evidenceEnvSentinelMatch ?? "(not verified)"}`,
        `- release retained surface: ${report.releaseRetained ?? false}`,
        `- reattach status: ${report.reattachStatus ?? "(not attempted)"}`,
        `- closed and gone: ${report.closedAndGone ?? false}`,
        `- workspace cleanup evidence: ${
          report.ownedWorkspaceCleanedUp
            ? "no owned workspace remains"
            : "LEAKED — workspace close failed or was bypassed"
        }`,
        "",
        "## Notes",
        "environment: {} used — cmux server cannot open FIFOs (EACCES, macOS API",
        "restriction on server side). Env injection via --env-file FIFO is a known",
        "contract gap; see residual risks.",
      ];
      await writeFile(
        "/tmp/pi-cohort-mux-production-cmux-smoke.md",
        reportLines.join("\n") + "\n",
        "utf8",
      ).catch(() => {});
    }
  },
);

// ─── Probe diagnostic (always included, low overhead) ────────────────────────

test("production cmux smoke: probe diagnostic — opt-in guard and availability", () => {
  if (!optedIn) {
    // Not opted in: skipReason must be a non-empty string.
    assert.equal(typeof skipReason, "string", "skip reason is a string when not opted in");
    assert.ok(skipReason.length > 0, "skip reason is non-empty");
    return;
  }
  // Opted in: probe must have consistent shape.
  assert.equal(typeof probe.available, "boolean", "probe.available is a boolean");
  assert.equal(typeof probe.version, "string", "probe.version is a string");
  assert.ok(Array.isArray(probe.capabilities), "probe.capabilities is an array");
  if (probe.available) {
    assert.match(probe.version, /^cmux \d+/, "version starts with cmux N when available");
    assert.ok(
      probe.capabilities.includes("events.v1"),
      "events.v1 is in capabilities when available",
    );
  } else {
    assert.equal(typeof skipReason, "string", "skipReason explains unavailability");
  }
});
