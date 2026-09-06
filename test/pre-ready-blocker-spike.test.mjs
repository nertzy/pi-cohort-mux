import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createFakeScheduler, createMachine } from "./fixtures/lifecycle/state-machine.mjs";
import { createJsonlFrameBuffer } from "./fixtures/startup-blocker/jsonl-frame-buffer.mjs";

const execFile = promisify(execFileCallback);
const tmuxAvailable = await execFile("tmux", ["-V"]).then(() => true, () => false);
const tmuxTimeout = 5_000;

function fixtureMachine() {
  const scheduler = createFakeScheduler();
  return { scheduler, machine: createMachine({ scheduler }) };
}

function dispatch(machine, type, detail = {}) {
  return machine.dispatch({ type, ...detail });
}

function tmux(server, ...args) {
  return execFile("tmux", ["-L", server, "-f", "/dev/null", ...args], { timeout: tmuxTimeout });
}

function waitForProcess(child, deadline) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`lifecycle signal did not arrive within ${deadline}ms`));
    }, deadline);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`lifecycle waiter exited with ${code ?? signal}`));
    });
  });
}

function writeSocket(client, frame) {
  return new Promise((resolve, reject) => client.write(frame, (error) => error ? reject(error) : resolve()));
}

async function controlSocket(socketPath, { deadline = tmuxTimeout } = {}) {
  let connection;
  let resolveConnection;
  let resolveReady;
  let rejectReady;
  const connected = new Promise((resolve) => { resolveConnection = resolve; });
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const server = net.createServer((client) => {
    connection = client;
    resolveConnection(client);
    let data = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(readyTimer);
      resolveReady(JSON.parse(data.slice(0, newline)));
    });
  });
  const readyTimer = setTimeout(() => rejectReady(new Error(`control ready did not arrive within ${deadline}ms`)), deadline);
  ready.catch(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    connected,
    ready,
    async shutdown({ split = false } = {}) {
      const frame = `${JSON.stringify({ type: "shutdown" })}\n`;
      if (!split) return writeSocket(connection, frame);
      const midpoint = Math.floor(frame.length / 2);
      await writeSocket(connection, frame.slice(0, midpoint));
      await writeSocket(connection, frame.slice(midpoint));
    },
    async close() {
      clearTimeout(readyTimer);
      rejectReady(new Error("control socket closed before ready"));
      connection?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function writeFifo(fifo) {
  await execFile("sh", ["-c", "printf release > \"$1\"", "sh", fifo], { timeout: tmuxTimeout });
}

function waitForPaneExit(server, channel, { deadline = tmuxTimeout, launch = spawn } = {}) {
  const child = launch("tmux", ["-L", server, "-f", "/dev/null", "wait-for", channel]);
  return waitForProcess(child, deadline);
}

test("injected deadline classifies a generic pre-ready blocker without an exit claim", () => {
  const { scheduler, machine } = fixtureMachine();
  const pane = "pre-ready-spike:0.0";

  dispatch(machine, "surface_created", { pane });
  scheduler.fire("ready");

  const snapshot = machine.snapshot();
  assert.equal(snapshot.phase, "blocked_before_ready");
  assert.equal(snapshot.intent, "retain");
  assert.equal(pane, "pre-ready-spike:0.0");
  assert.equal(snapshot.facts.exited, undefined);
  assert.match(pane, /:\d+\.\d+$/);
  assert.doesNotMatch(JSON.stringify(snapshot), /mise|shell prompt|prompt text|direnv/i);
});

test("unsignaled lifecycle waiter rejects at its deadline", async () => {
  const child = new EventEmitter();
  child.kill = () => {};

  await assert.rejects(
    waitForPaneExit("unused", "unsignaled", { deadline: 1, launch: () => child }),
    /lifecycle signal did not arrive within 1ms/,
  );
});

test("control readiness rejects at its deadline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pre-ready-control-"));
  const socketPath = path.join(directory, "control.sock");
  const control = await controlSocket(socketPath, { deadline: 1 });

  try {
    await assert.rejects(control.ready, /control ready did not arrive within 1ms/);
  } finally {
    await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("control cleanup destroys an accepted client before closing the server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pre-ready-control-"));
  const socketPath = path.join(directory, "control.sock");
  const control = await controlSocket(socketPath);
  const client = net.createConnection(socketPath);

  try {
    await once(client, "connect");
    await control.connected;
    const closed = once(client, "close");
    await control.close();
    await closed;
    await assert.rejects(control.ready, /control socket closed before ready/);
  } finally {
    client.destroy();
    await control.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("incremental shutdown framing retains a split frame until its newline arrives", () => {
  const frames = [];
  const parser = createJsonlFrameBuffer((frame) => frames.push(frame));
  const shutdown = `${JSON.stringify({ type: "shutdown" })}\n`;
  const midpoint = Math.floor(shutdown.length / 2);

  parser.feed(shutdown.slice(0, midpoint));
  assert.deepEqual(frames, []);
  assert.equal(parser.buffer, shutdown.slice(0, midpoint));

  parser.feed(shutdown.slice(midpoint));
  assert.deepEqual(frames, [{ type: "shutdown" }]);
  assert.equal(parser.buffer, "");
});

test("authoritative nonzero exit before ready is startup_failed with exact provenance", () => {
  const { machine } = fixtureMachine();

  dispatch(machine, "surface_created");
  dispatch(machine, "exited", { status: 23, signal: null });

  const snapshot = machine.snapshot();
  assert.equal(snapshot.phase, "startup_failed");
  assert.deepEqual(snapshot.facts.exited, { status: 23, signal: null });
  assert.deepEqual(snapshot.provenance.at(-1), { type: "exited", source: "mux" });
});

test("real tmux lifecycle hook retains a blocked pane, recovers on control ready, and observes clean exit", { skip: !tmuxAvailable && "tmux is unavailable; reducer-only cases remain active" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pre-ready-blocker-"));
  const fifo = path.join(directory, "release.fifo");
  const socketPath = path.join(directory, "control.sock");
  const server = `pre-ready-${process.pid}-${Date.now()}`;
  const session = "pre-ready-spike";
  const channelPrefix = `pane-died-${process.pid}-${Date.now()}`;
  const launcher = path.resolve("test/fixtures/startup-blocker/launcher.mjs");
  let control;

  try {
    await execFile("mkfifo", ["-m", "600", fifo]);
    control = await controlSocket(socketPath);
    await tmux(server, "new-session", "-d", "-s", "observer", "cat");
    await tmux(server, "set-option", "-w", "-g", "remain-on-exit", "on");
    await tmux(server, "set-hook", "-g", "pane-died", `run-shell -b 'tmux -L ${server} -f /dev/null wait-for -S ${channelPrefix}-#{pane_id}'`);
    const { stdout: paneIdOutput } = await tmux(server, "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, process.execPath, launcher, fifo, socketPath);
    const paneId = paneIdOutput.trim();

    const { scheduler, machine } = fixtureMachine();
    const pane = `${session}:0.0`;
    dispatch(machine, "surface_created", { pane });
    scheduler.fire("ready");
    assert.equal(machine.snapshot().phase, "blocked_before_ready");
    assert.equal(machine.snapshot().intent, "retain");
    assert.equal(machine.snapshot().facts.exited, undefined);
    assert.match(pane, /:\d+\.\d+$/);
    assert.doesNotMatch(JSON.stringify(machine.snapshot()), /mise|shell prompt|prompt text|direnv/i);

    await writeFifo(fifo);
    const frame = await control.ready;
    assert.deepEqual(frame, { type: "ready" });
    dispatch(machine, frame.type);
    assert.equal(machine.snapshot().phase, "running");

    const observedExit = waitForPaneExit(server, `${channelPrefix}-${paneId}`);
    await control.shutdown({ split: true });
    await observedExit;
    const { stdout: cleanExit } = await tmux(server, "display-message", "-p", "-t", pane, "#{pane_dead} #{pane_dead_status}");
    assert.equal(cleanExit.trim(), "1 0");

    const { stdout: exitPaneIdOutput } = await tmux(server, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", session, "-n", "exit-before-ready", "cat");
    const exitPaneId = exitPaneIdOutput.trim();
    const exitPane = `${session}:1.0`;
    const observedFailure = waitForPaneExit(server, `${channelPrefix}-${exitPaneId}`);
    await tmux(server, "respawn-pane", "-k", "-t", exitPane, process.execPath, launcher, "--exit-before-ready", "23");
    await observedFailure;
    const { stdout } = await tmux(server, "display-message", "-p", "-t", exitPane, "#{pane_dead_status}");
    const status = Number(stdout.trim());
    assert.equal(status, 23);
    const failed = fixtureMachine().machine;
    dispatch(failed, "surface_created", { pane: exitPane });
    dispatch(failed, "exited", { status, signal: null });
    assert.equal(failed.snapshot().phase, "startup_failed");
    assert.deepEqual(failed.snapshot().facts.exited, { status: 23, signal: null });
  } finally {
    await tmux(server, "kill-server").catch(() => {});
    if (control) await control.close();
    await rm(directory, { recursive: true, force: true });
  }
});
