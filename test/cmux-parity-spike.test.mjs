import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const cliDeadline = 5_000;
const reporterPath = path.resolve("test/fixtures/cmux-parity/reporter.mjs");

function cmux(...args) {
  return execFile("cmux", args, { timeout: cliDeadline });
}

function quoteShell(token) {
  return "'" + String(token).replaceAll("'", "'\"'\"'") + "'";
}

function withDeadline(promise, message, deadline = cliDeadline) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), deadline);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function probeCmux() {
  try {
    const { stdout: version } = await cmux("--version");
    const { stdout: capabilitiesJson } = await cmux("capabilities");
    const capabilities = JSON.parse(capabilitiesJson);
    const available = Boolean(process.env.CMUX_WORKSPACE_ID) &&
      Boolean(process.env.CMUX_SOCKET_PATH) &&
      capabilities.capabilities?.includes("events.v1");
    return { available, version: version.trim(), capabilities };
  } catch (error) {
    return { available: false, error };
  }
}

const probe = await probeCmux();
const skip = probe.available ? false :
  `real public cmux is unreachable from this session (events.v1/CMUX_WORKSPACE_ID prerequisite missing): ${probe.error?.message ?? "not inside a cmux session"}`;

function subscribe(names) {
  const args = ["events", "--no-heartbeat"];
  for (const name of names) args.push("--name", name);
  const child = spawn("cmux", args, { stdio: ["ignore", "pipe", "pipe"] });
  let resolveAck;
  let rejectAck;
  const ack = new Promise((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
  let exited = false;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const facts = [];
  const waiters = new Set();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === "ack") resolveAck(frame);
      else {
        facts.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(frame)) {
            waiters.delete(waiter);
            waiter.resolve(frame);
          }
        }
      }
    }
  });
  const failure = (error) => {
    rejectAck(error);
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  child.once("error", failure);
  child.once("exit", (code, signal) => {
    exited = true;
    resolveExit();
    if (code !== 0 && signal !== "SIGTERM") {
      failure(new Error(`cmux events exited with code ${code}, signal ${signal}`));
    }
  });
  return {
    ack: withDeadline(ack, `cmux events (${names.join(",")}) did not acknowledge within ${cliDeadline}ms`),
    facts,
    waitFor(predicate, description, deadline = cliDeadline) {
      const existing = facts.find(predicate);
      if (existing) return Promise.resolve(existing);
      let waiter;
      const pending = new Promise((resolve, reject) => {
        waiter = { predicate, resolve, reject };
        waiters.add(waiter);
      });
      return withDeadline(
        pending,
        `${description} did not arrive within ${deadline}ms`,
        deadline,
      ).finally(() => waiters.delete(waiter));
    },
    async stop() {
      if (!exited) child.kill("SIGTERM");
      await withDeadline(exit, "cmux events did not stop");
    },
  };
}

async function startReporter(directory) {
  const socketPath = path.join(directory, "reporter.sock");
  let connection;
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let buffer = "";
  const server = net.createServer((client) => {
    connection = client;
    client.setEncoding("utf8");
    client.once("error", rejectReady);
    client.once("close", () => { resolveClosed(); rejectReady(new Error("reporter connection closed before ready")); });
    client.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === "ready") resolveReady(frame);
        if (frame.type === "shutdown-ack") connection.__shutdownAck?.(frame);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    ready: withDeadline(ready, `reporter ready did not arrive within ${cliDeadline}ms`),
    async shutdown() {
      const ack = withDeadline(new Promise((resolve, reject) => {
        if (!connection) return reject(new Error("reporter never connected"));
        connection.__shutdownAck = resolve;
        connection.write(`${JSON.stringify({ type: "shutdown" })}\n`, (error) => error && reject(error));
      }), `shutdown-ack did not arrive within ${cliDeadline}ms`);
      await ack;
      await withDeadline(closed, `reporter socket did not close within ${cliDeadline}ms`);
    },
    async close() {
      connection?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function createWorkspace({ name, cwd, command }) {
  const { stdout } = await cmux("workspace", "create", "--name", name, "--cwd", cwd, "--focus", "false", "--command", command);
  assert.match(stdout.trim(), /^OK workspace:\d+$/);
  return stdout.trim().split(" ")[1];
}

async function snapshot(workspaceRef) {
  const { stdout } = await execFile("cmux", ["--id-format", "both", "list-pane-surfaces", "--workspace", workspaceRef, "--json"], { timeout: cliDeadline });
  return JSON.parse(stdout);
}

test("real public cmux backend proves workspace/surface lifecycle parity end to end", { skip }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cmux-parity-"));
  const expectedCwd = await realpath(directory);
  const suffix = `${process.pid}-${Date.now()}`;
  let reporter;
  let events;
  let workspaceRef;
  let decoyRef;
  let decoy;
  try {
    reporter = await startReporter(directory);
    events = subscribe(["workspace.created", "surface.created", "surface.closed", "pane.closed", "workspace.closed"]);
    await events.ack;
    const { stdout: callerBefore } = await cmux("current-workspace");

    decoyRef = await createWorkspace({ name: `cmux-decoy-${suffix}`, cwd: directory, command: quoteShell("true") });
    decoy = await snapshot(decoyRef);
    await events.waitFor(
      (fact) => fact.name === "workspace.created" && fact.workspace_id === decoy.workspace_id,
      "decoy workspace.created",
    );
    workspaceRef = await createWorkspace({
      name: `cmux-parity-${suffix}`,
      cwd: directory,
      command: [process.execPath, reporterPath, reporter.socketPath].map(quoteShell).join(" "),
    });
    const { stdout: callerAfter } = await cmux("current-workspace");
    assert.equal(callerAfter.trim(), callerBefore.trim(), "--focus false must not move caller focus");

    const ready = await reporter.ready;
    assert.equal(ready.cwd, expectedCwd);
    assert.ok(ready.workspaceId);
    assert.ok(ready.surfaceId);
    const createdWorkspace = await events.waitFor((fact) => fact.name === "workspace.created" && fact.workspace_id === ready.workspaceId, "reporter workspace.created");
    const createdSurface = await events.waitFor((fact) => fact.name === "surface.created" && fact.surface_id === ready.surfaceId, "reporter surface.created");
    assert.equal(createdWorkspace.workspace_id, ready.workspaceId);
    assert.equal(createdSurface.surface_id, ready.surfaceId);

    const surfaces = await snapshot(workspaceRef);
    const surface = surfaces.surfaces.find((entry) => entry.id === ready.surfaceId);
    assert.ok(surface);
    const handle = { workspaceId: surfaces.workspace_id, workspaceRef: surfaces.workspace_ref, paneId: surfaces.pane_id, paneRef: surfaces.pane_ref, surfaceId: surface.id, surfaceRef: surface.ref, title: surface.title, type: surface.type, cwd: expectedCwd };
    assert.deepEqual(Object.keys(handle).sort(), ["cwd", "paneId", "paneRef", "surfaceId", "surfaceRef", "title", "type", "workspaceId", "workspaceRef"]);
    const reattached = JSON.parse(JSON.stringify(handle));
    assert.ok((await snapshot(reattached.workspaceRef)).surfaces.some((entry) => entry.id === reattached.surfaceId));

    // This subscription was acknowledged before shutdown. It observes every
    // candidate lifecycle fact in the entire shutdown window, then filters by
    // exact UUID; unrelated daemon facts are deliberately ignored.
    await reporter.shutdown();
    await assert.rejects(
      events.waitFor(
        (fact) => ["surface.closed", "pane.closed", "workspace.closed"].includes(fact.name) &&
          (fact.surface_id === reattached.surfaceId || fact.workspace_id === reattached.workspaceId || fact.pane_id === reattached.paneId),
        "generic reporter exit fact",
        1_500,
      ),
      /generic reporter exit fact did not arrive within 1500ms/,
    );

    // A decoy close shares this daemon-wide subscription. Its facts are
    // observed but cannot satisfy the reporter UUID predicate below.
    const decoyClose = events.waitFor(
      (fact) => fact.name === "workspace.closed" && fact.workspace_id === decoy.workspace_id,
      "decoy workspace.closed",
    );
    const surfaceClose = events.waitFor(
      (fact) => fact.name === "surface.closed" && fact.surface_id === reattached.surfaceId,
      "reporter surface.closed",
    );
    const workspaceClose = events.waitFor(
      (fact) => fact.name === "workspace.closed" && fact.workspace_id === reattached.workspaceId,
      "reporter workspace.closed",
    );
    await cmux("workspace", "close", decoyRef);
    await decoyClose;
    decoyRef = undefined;
    await cmux("workspace", "close", reattached.workspaceRef);
    await Promise.all([surfaceClose, workspaceClose]);
    workspaceRef = undefined;
    await assert.rejects(snapshot(reattached.workspaceRef), /not_found/i);
  } finally {
    if (workspaceRef) await cmux("workspace", "close", workspaceRef).catch(() => {});
    if (decoyRef) await cmux("workspace", "close", decoyRef).catch(() => {});
    if (events) await events.stop().catch(() => {});
    if (reporter) await reporter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cmux parity probe reports why the real backend was (not) exercised", () => {
  assert.equal(typeof probe.available, "boolean");
  if (probe.available) assert.match(probe.version, /^cmux \d+\.\d+\.\d+/);
  else assert.ok(skip);
});
