#!/usr/bin/env node
/**
 * Fake cmux CLI for use in PATH-based integration tests.
 *
 * Responds to the exact cmux subcommands used by the cmux adapter:
 *   cmux --version
 *   cmux capabilities
 *   cmux events --no-heartbeat --name <name> ...
 *   cmux workspace create --name <n> --cwd <d> --focus false --command <cmd>
 *   cmux --id-format both list-pane-surfaces --workspace <ref> --json
 *   cmux workspace close <ref>
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

  case "workspace": {
    const action = rest[0];
    switch (action) {
      case "create": {
        // Parse --name, --cwd, --focus, --command flags (order may vary).
        let name, cwd, focus, command;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === "--name") { name = rest[++i]; continue; }
          if (rest[i] === "--cwd") { cwd = rest[++i]; continue; }
          if (rest[i] === "--focus") { focus = rest[++i]; continue; }
          if (rest[i] === "--command") { command = rest[++i]; continue; }
        }
        if (!name || !cwd || !command) {
          fail("fake-cmux workspace create: missing required args");
        }
        emit(`OK ${WS_REF}`);
        break;
      }

      case "close": {
        const ref = rest[1];
        if (!ref) fail("fake-cmux workspace close: missing workspace ref");
        if (CLOSE_NOT_FOUND) {
          fail(`Error: not_found: Workspace ${ref} not found`);
        }
        // Success: no output.
        break;
      }

      default:
        fail(`fake-cmux: unknown workspace subcommand: ${action}`);
    }
    break;
  }

  case "list-pane-surfaces": {
    // --id-format both was already consumed above if present.
    if (NOT_FOUND) {
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
