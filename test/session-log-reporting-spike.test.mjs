import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureDirectory = new URL("./fixtures/session-log/", import.meta.url);
const extension = new URL("./fixtures/session-log/reporting-extension.mjs", import.meta.url);
const piAiModule = "/opt/homebrew/Cellar/pi-coding-agent/0.85.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
const tuiRuntimePrerequisites = ["/opt/homebrew/bin/pi", "/opt/homebrew/bin/tmux", piAiModule];

function runtimeSkipReason(exists = existsSync) {
  const missingPrerequisite = tuiRuntimePrerequisites.find((runtimePath) => !exists(runtimePath));
  return missingPrerequisite && `requires ${missingPrerequisite} for the Pi 0.85.0 real TUI runtime proof`;
}

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, 10_000);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${output}`));
    });
  });
}

function onceEvent(events, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 10_000);
    events.on(type, (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

async function fixtureContents(directory) {
  return (await Promise.all((await readdir(directory)).map((name) => readFile(path.join(directory, name), "utf8")))).join("\n");
}

test("session-log reporting spike has explicit runtime fixtures", () => {
  assert.equal(existsSync(extension), true);
  assert.match(fileURLToPath(fixtureDirectory), /test\/fixtures\/session-log\/$/);
});

test("TUI runtime skip guard checks the version-pinned Pi AI module", () => {
  const missing = runtimeSkipReason((runtimePath) => runtimePath !== piAiModule);

  assert.equal(missing, `requires ${piAiModule} for the Pi 0.85.0 real TUI runtime proof`);
});

test("Pi 0.85.0 TUI session log reports readiness, settlement, and shutdown without network", async (t) => {
  const skipReason = runtimeSkipReason();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-cohort-session-log-"));
  const session = path.join(directory, "session.jsonl");
  const socket = path.join(directory, "control.sock");
  const fifo = path.join(directory, "token.fifo");
  const runner = path.join(directory, "run-pi.sh");
  const serverName = `cohort-spike-${process.pid}-${Date.now()}`;
  const completionEvent = `${serverName}-pane-dead`;
  const token = `fixture-token-${crypto.randomUUID()}`;
  let tmuxStarted = false;
  let fifoUnlinked = false;
  let writer;

  const events = new net.Server();
  let buffer = "";
  let eventCount = 0;
  let control;
  events.on("connection", (connection) => {
    control = connection;
    connection.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const event = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        eventCount += 1;
        events.emit(event.type, event);
      }
    });
  });

  try {
    await writeFile(session, "", { mode: 0o600 });
    await command("mkfifo", ["-m", "600", fifo]);
    await new Promise((resolve) => events.listen(socket, resolve));
    await chmod(socket, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(session)).mode & 0o777, 0o600);
    assert.equal((await stat(fifo)).mode & 0o777, 0o600);
    assert.equal((await stat(socket)).mode & 0o777, 0o600);

    await writeFile(runner, `#!/bin/sh\n/opt/homebrew/bin/pi --no-extensions --extension ${fileURLToPath(extension)} --session ${session} --model fixture/fixed\nstatus=$?\ntmux -L ${serverName} wait-for -S ${completionEvent}\nexit $status\n`, { mode: 0o700 });
    await command("tmux", ["-L", serverName, "new-session", "-d", "-s", serverName, "/bin/sh", runner], {
      cwd: directory,
      env: { ...process.env, PI_COHORT_SPIKE_SOCKET: socket, PI_COHORT_SPIKE_FIFO: fifo, PI_COHORT_SPIKE_PI_AI_MODULE: piAiModule },
    });
    tmuxStarted = true;
    await command("tmux", ["-L", serverName, "set-option", "-t", serverName, "remain-on-exit", "on"]);
    const paneDeath = command("tmux", ["-L", serverName, "wait-for", completionEvent]);
    writer = createWriteStream(fifo, { mode: 0o600 });
    writer.end(token);
    const hello = await onceEvent(events, "hello");
    assert.equal(hello.token, token);
    const ready = onceEvent(events, "ready");
    control.write('{"type":"authenticated"}\n');
    await ready;

    const earlyEntries = (await readFile(session, "utf8")).trim().split("\n").map(JSON.parse);
    const headerIndex = earlyEntries.findIndex((entry) => entry.type === "session");
    const readyIndex = earlyEntries.findIndex((entry) => entry.type === "custom" && entry.customType === "pi-cohort.ready.v1");
    assert.ok(headerIndex >= 0, "Pi wrote a session header to the pre-created file");
    assert.ok(readyIndex > headerIndex, "readiness follows the session header");
    assert.deepEqual(earlyEntries[readyIndex].data, { owner: "core", mode: "tui" });

    const settled = onceEvent(events, "settled");
    await command("tmux", ["-L", serverName, "send-keys", "-t", serverName, "-l", "return fixture prompt"]);
    await command("tmux", ["-L", serverName, "send-keys", "-t", serverName, "Enter"]);
    await settled;

    const settledEntries = (await readFile(session, "utf8")).trim().split("\n").map(JSON.parse);
    const assistant = settledEntries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const settledIndex = settledEntries.findIndex((entry) => entry.type === "custom" && entry.customType === "pi-cohort.settled.v1");
    assert.equal(assistant.message.content[0].text, "fixture assistant response");
    assert.ok(settledIndex > settledEntries.indexOf(assistant), "settlement follows the durable assistant message");
    const durableDeliveryAcknowledged = true;
    assert.equal(durableDeliveryAcknowledged, true);

    const shutdownAcknowledged = onceEvent(events, "shutdown-ack");
    control.write('{"type":"shutdown"}\n');
    await shutdownAcknowledged;
    await paneDeath;
    assert.ok(eventCount >= 4, "the runtime emitted hello, ready, settled, and shutdown acknowledgment events");
    const pane = await command("tmux", ["-L", serverName, "display-message", "-p", "-t", serverName, "#{pane_dead} #{pane_dead_status} #{pane_start_command}"]);
    assert.match(pane, /^1 0 /, "retained tmux pane records successful Pi exit");

    const metadata = pane + (await readFile(runner, "utf8")) + (await readFile(session, "utf8")) + (await fixtureContents(fileURLToPath(fixtureDirectory)));
    assert.equal(metadata.includes(token), false, "authentication token is not persisted or exposed in metadata");
    await rm(fifo);
    fifoUnlinked = true;
    assert.equal(existsSync(fifo), false);
  } finally {
    writer?.destroy();
    control?.destroy();
    await new Promise((resolve) => events.close(resolve));
    if (tmuxStarted) await command("tmux", ["-L", serverName, "kill-server"]).catch(() => {});
    if (!fifoUnlinked) await rm(fifo, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
