#!/usr/bin/env node
/**
 * Fake cmux CLI for use in PATH-based integration tests.
 *
 * Responds to the exact cmux subcommands used by the cmux adapter:
 *   cmux --version
 *   cmux capabilities
 *   cmux events --no-heartbeat --name <name> ...
 *   cmux new-pane --workspace <ws> --type terminal --direction right --focus false --command <cmd>
 *   cmux new-surface --workspace <ws> --pane <ref> --type terminal --focus false --command <cmd>
 *   cmux --id-format both list-pane-surfaces --workspace <ref> [--pane <ref>] --json
 *   cmux close-surface --workspace <ws> --surface <ref>
 *
 * Behaviour is configured by environment variables:
 *   FAKE_CMUX_VERSION           (default: "cmux 0.64.22")
 *   FAKE_CMUX_CAPABILITIES      comma-separated list (default: "events.v1")
 *   FAKE_CMUX_WORKSPACE_ID      UUID for created workspace (default: generated)
 *   FAKE_CMUX_WORKSPACE_REF     ref string (default: "workspace:1")
 *   FAKE_CMUX_SURFACE_ID        UUID for the surface (default: generated)
 *   FAKE_CMUX_SURFACE_REF       ref string (default: "surface:1")
 *   FAKE_CMUX_PANE_ID           UUID for the pane (default: generated)
 *   FAKE_CMUX_PANE_REF          ref string (default: "pane:1")
 *   FAKE_CMUX_NOT_FOUND         if "1", list-pane-surfaces and close throw not_found
 *   FAKE_CMUX_CLOSE_NOT_FOUND   if "1", only close throws not_found
 *   FAKE_CMUX_PANE_GONE         if "1", pane-scoped list-pane-surfaces throws not_found
 *   FAKE_CMUX_EVENTS_FRAMES     path to a JSON file with extra event frames to emit
 *
 * Usage (in a test that adds this directory to PATH):
 *   process.env.PATH = `${dirOfThisFile}:${process.env.PATH}`;
 *   // Then create the backend normally (no injected exec/spawn).
 *
 * The `cmux events` subcommand emits one ack frame and then blocks until
 * SIGTERM, optionally emitting frames from FAKE_CMUX_EVENTS_FRAMES first.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

const VERSION = process.env.FAKE_CMUX_VERSION ?? "cmux 0.64.22";
const CAPS = (process.env.FAKE_CMUX_CAPABILITIES ?? "events.v1").split(",").filter(Boolean);
const WS_ID = process.env.FAKE_CMUX_WORKSPACE_ID ?? randomUUID();
const WS_REF = process.env.FAKE_CMUX_WORKSPACE_REF ?? "workspace:1";
const SF_ID = process.env.FAKE_CMUX_SURFACE_ID ?? randomUUID();
const SF_REF = process.env.FAKE_CMUX_SURFACE_REF ?? "surface:1";
const PN_ID = process.env.FAKE_CMUX_PANE_ID ?? randomUUID();
const PN_REF = process.env.FAKE_CMUX_PANE_REF ?? "pane:1";
const NOT_FOUND = process.env.FAKE_CMUX_NOT_FOUND === "1";
const CLOSE_NOT_FOUND = NOT_FOUND || process.env.FAKE_CMUX_CLOSE_NOT_FOUND === "1";
const PANE_GONE = NOT_FOUND || process.env.FAKE_CMUX_PANE_GONE === "1";

function emit(text) { process.stdout.write(text + "\n"); }
function fail(message) { process.stderr.write(message + "\n"); process.exit(1); }

// Strip leading global flags like --id-format both before subcommand dispatch.
let cursor = 0;
let idFormat = "short";

if (args[cursor] === "--id-format") {
  idFormat = args[cursor + 1] ?? "short";
  cursor += 2;
}

const subcommand = args[cursor];
const rest = args.slice(cursor + 1);

switch (subcommand) {
  case "--version":
    emit(VERSION);
    break;

  case "capabilities":
    emit(JSON.stringify({ capabilities: CAPS }));
    break;

  case "events": {
    // Emit ack frame, then optional extra frames, then block until SIGTERM.
    const ack = {
      type: "ack",
      subscription_id: randomUUID(),
      version: 1,
      protocol: "cmux-events",
      heartbeat_interval_seconds: 15,
      replay_count: 0,
    };
    emit(JSON.stringify(ack));

    const framesFile = process.env.FAKE_CMUX_EVENTS_FRAMES;
    if (framesFile) {
      try {
        const frames = JSON.parse(readFileSync(framesFile, "utf8"));
        for (const frame of frames) emit(JSON.stringify(frame));
      } catch (err) {
        process.stderr.write(`fake-cmux: could not read events frames: ${err.message}\n`);
      }
    }

    // Block until killed; exit 0 on SIGTERM (expected termination).
    process.on("SIGTERM", () => process.exit(0));
    // Keep the process alive without consuming CPU.
    setInterval(() => {}, 60_000);
    break;
  }

  case "new-pane":
  case "new-surface": {
    let pane, workspace, command;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--workspace") { workspace = rest[++i]; continue; }
      if (rest[i] === "--pane") { pane = rest[++i]; continue; }
      if (rest[i] === "--command") { command = rest[++i]; continue; }
      if (rest[i] === "--type" || rest[i] === "--direction" || rest[i] === "--focus") { i++; continue; }
    }
    if (!workspace || !command) fail(`fake-cmux ${subcommand}: missing required args`);
    if (subcommand === "new-surface") {
      if (!pane) fail("fake-cmux new-surface: missing --pane");
      if (PANE_GONE) fail(`Error: not_found: Pane ${pane} not found`);
    }
    emit(`OK ${SF_REF} ${PN_REF} ${WS_REF}`);
    break;
  }

  case "close-surface": {
    let surface;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--surface") { surface = rest[++i]; continue; }
      if (rest[i] === "--workspace") { i++; continue; }
    }
    if (!surface) fail("fake-cmux close-surface: missing --surface");
    if (CLOSE_NOT_FOUND) {
      fail(`Error: not_found: Surface ${surface} not found`);
    }
    // Success: no output.
    break;
  }

  case "workspace": {
    fail("fake-cmux: workspace create/close are no longer used by the adapter");
  }

  case "list-pane-surfaces": {
    // --id-format both was already consumed above if present.
    let paneScoped = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--pane") { paneScoped = true; i++; continue; }
      if (rest[i] === "--workspace" || rest[i] === "--json") { if (rest[i] !== "--json") i++; continue; }
    }
    if (NOT_FOUND || (paneScoped && PANE_GONE)) {
      fail("Error: not_found: Pane or workspace not found");
    }
    const snapshot = {
      workspace_id: WS_ID,
      workspace_ref: WS_REF,
      pane_id: PN_ID,
      pane_ref: PN_REF,
      surfaces: [
        {
          id: SF_ID,
          ref: SF_REF,
          title: "pi-cohort-fake",
          type: "terminal",
          selected: true,
          index: 0,
        },
      ],
    };
    emit(JSON.stringify(snapshot));
    break;
  }

  default:
    fail(`fake-cmux: unknown subcommand: ${subcommand} (args: ${args.join(" ")})`);
}
