import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import { createCmuxBackend } from "../src/cmux-backend.js";

const WORKSPACE_REF = "workspace:17";
const WORKSPACE_ID = "AABBCCDD-0000-0000-0000-111122223333";
const SURFACE_ID = "DDCCBBAA-0000-0000-0000-444455556666";

class FakeEventsChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    setImmediate(() => {
      this.stdout.push(`${JSON.stringify({ type: "ack", version: 1 })}\n`);
    });
  }

  kill(signal) {
    setImmediate(() => {
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit("exit", 0, signal);
    });
  }
}

const request = (overrides = {}) => ({
  command: "/usr/local/bin/pi",
  args: ["--session", "/tmp/session with spaces.jsonl"],
  cwd: "/tmp/worktree with spaces",
  environment: {},
  runId: "run-17",
  childId: "child-3",
  signal: new AbortController().signal,
  ...overrides,
});

function snapshot() {
  return {
    workspace_id: WORKSPACE_ID,
    workspace_ref: WORKSPACE_REF,
    pane_id: "pane-id",
    pane_ref: "pane:1",
    surfaces: [{
      id: SURFACE_ID,
      ref: "surface:1",
      title: "child",
      type: "terminal",
    }],
  };
}

test("hands the requested environment through a child-side bootstrap reading an owner-only named pipe", async () => {
  const secret = "SYNTHETIC_SECRET_VALUE";
  let environmentPayload;
  let fifoPipePath;
  let commandStr;
  let launchedOptions;

  const execFile = async (_command, args, options) => {
    if (args[0] === "workspace" && args[1] === "create") {
      launchedOptions = options;

      // --env-file must NOT appear in createArgs (bootstrap reads the FIFO itself)
      assert.equal(args.includes("--env-file"), false, "--env-file must not appear in workspace create args");

      // The bootstrap command is in --command
      const cmdIdx = args.indexOf("--command");
      assert.notEqual(cmdIdx, -1, "--command must be present");
      commandStr = args[cmdIdx + 1];

      // Bootstrap path must appear in the command string
      assert.ok(
        commandStr.includes("env-bootstrap.sh"),
        "command must reference env-bootstrap.sh",
      );

      // Extract the FIFO path from the command string (single-quoted token ending in /environment.fifo)
      const fifoMatch = commandStr.match(/'([^']+\/environment\.fifo)'/)
      assert.ok(fifoMatch, "FIFO path must appear in the command string");
      fifoPipePath = fifoMatch[1];

      // FIFO must exist, be a real FIFO, and be owner-only mode 0600
      const stats = await lstat(fifoPipePath);
      assert.equal(stats.isFIFO(), true, "pipe must be a FIFO");
      assert.equal(stats.mode & 0o777, 0o600, "pipe must be mode 0600");

      // Secret must not appear in args or options
      assert.equal(JSON.stringify(args).includes(secret), false, "secret must not appear in args");
      assert.equal(JSON.stringify(options).includes(secret), false, "secret must not appear in options");

      // Read from the FIFO so the background tee writer can complete
      environmentPayload = await readFile(fifoPipePath, "utf8");
      return { stdout: `OK ${WORKSPACE_REF}\n`, stderr: "" };
    }
    if (args[0] === "--id-format") {
      return { stdout: `${JSON.stringify(snapshot())}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const backend = createCmuxBackend({
    execFile,
    spawn: () => new FakeEventsChild(),
  });

  const lease = await backend.launch(request({
    environment: {
      PI_COHORT_CHILD_HOST_CONFIG: "/tmp/host-config.json",
      TEST_ONLY_TOKEN: secret,
    },
  }));
  await lease.release();

  assert.equal(
    environmentPayload,
    `PI_COHORT_CHILD_HOST_CONFIG=/tmp/host-config.json\nTEST_ONLY_TOKEN=${secret}\n`,
  );
  assert.equal(launchedOptions.signal.aborted, false);
  // FIFO and its temp directory must be cleaned up
  await assert.rejects(lstat(fifoPipePath), { code: "ENOENT" });
});

test("rejects secretPipePath instead of silently dropping an undefined transport", async () => {
  let commands = 0;
  const backend = createCmuxBackend({
    execFile: async () => {
      commands += 1;
      throw new Error("must not launch");
    },
    spawn: () => {
      commands += 1;
      throw new Error("must not subscribe");
    },
  });

  await assert.rejects(
    backend.launch(request({ secretPipePath: "/private/tmp/secret.fifo" })),
    /cannot honor ExecutionSurfaceRequest\.secretPipePath/,
  );
  assert.equal(commands, 0);
});
