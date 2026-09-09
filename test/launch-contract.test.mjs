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

test("hands the requested environment to cmux through an owner-only named pipe", async () => {
  const secret = "SYNTHETIC_SECRET_VALUE";
  let environmentPayload;
  let environmentPipe;
  let launchedOptions;

  const execFile = async (_command, args, options) => {
    if (args[0] === "workspace" && args[1] === "create") {
      launchedOptions = options;
      const envFileIndex = args.indexOf("--env-file");
      assert.notEqual(envFileIndex, -1);
      environmentPipe = args[envFileIndex + 1];

      const stats = await lstat(environmentPipe);
      assert.equal(stats.isFIFO(), true);
      assert.equal(stats.mode & 0o777, 0o600);

      environmentPayload = await readFile(environmentPipe, "utf8");
      assert.equal(JSON.stringify(args).includes(secret), false);
      assert.equal(JSON.stringify(options).includes(secret), false);
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
  await assert.rejects(lstat(environmentPipe), { code: "ENOENT" });
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
