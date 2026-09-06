import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const tmuxAvailable = await execFile("tmux", ["-V"]).then(() => true, () => false);
const deadline = 5_000;

function command(command, args, options = {}) {
  return execFile(command, args, { timeout: deadline, ...options });
}

function tmux(server, ...args) {
  return command("tmux", ["-L", server, "-f", "/dev/null", ...args]);
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`native completion did not arrive within ${deadline}ms`));
    }, deadline);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`waiter exited with ${code ?? signal}`));
    });
  });
}

function waitForPaneExit(server, channel) {
  return waitForProcess(spawn("tmux", ["-L", server, "-f", "/dev/null", "wait-for", channel]));
}

async function resultSocket(socketPath, expected) {
  const messages = [];
  let resolveMessages;
  let rejectMessages;
  const received = new Promise((resolve, reject) => { resolveMessages = resolve; rejectMessages = reject; });
  const timer = setTimeout(() => rejectMessages(new Error(`expected ${expected} structured reports within ${deadline}ms`)), deadline);
  received.catch(() => {});
  const server = net.createServer((client) => {
    let buffer = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        messages.push(JSON.parse(line));
        if (messages.length === expected) {
          clearTimeout(timer);
          resolveMessages(messages);
        }
      }
    });
    client.once("error", rejectMessages);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    received,
    async close() {
      clearTimeout(timer);
      rejectMessages(new Error("result socket closed before all reports arrived"));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function git(cwd, ...args) {
  return command("git", args, { cwd });
}

async function initializeWorktrees(directory) {
  const repository = path.join(directory, "repository");
  const alpha = path.join(directory, "alpha");
  const beta = path.join(directory, "beta");
  await git(directory, "init", "--initial-branch=main", repository);
  await git(repository, "config", "user.email", "fixture@example.test");
  await git(repository, "config", "user.name", "Fixture");
  await command("sh", ["-c", "printf base > base.txt && git add base.txt && git commit -m base",], { cwd: repository });
  await git(repository, "worktree", "add", "-b", "alpha", alpha);
  await git(repository, "worktree", "add", "-b", "beta", beta);
  await command("sh", ["-c", "printf alpha > marker-alpha.txt && git add marker-alpha.txt && git commit -m alpha",], { cwd: alpha });
  await command("sh", ["-c", "printf beta > marker-beta.txt && git add marker-beta.txt && git commit -m beta",], { cwd: beta });
  return { repository, alpha, beta };
}

const reporter = path.resolve("test/fixtures/worktree-awareness/reporter.mjs");

function launchDirectReporter({ cwd, socketPath }) {
  return waitForProcess(spawn(process.execPath, [reporter, socketPath], {
    cwd,
    // The absolute Node path still runs, but any accidental git lookup fails.
    env: { PATH: "" },
  }));
}

async function launchReporter({ server, session, cwd, socketPath, metadata }) {
  const channel = `worktree-exit-${process.pid}-${Date.now()}-${session}`;
  await tmux(server, "new-session", "-d", "-s", session, "cat");
  await tmux(server, "set-option", "-w", "-t", `${session}:0`, "remain-on-exit", "on");
  await tmux(server, "set-hook", "-w", "-t", `${session}:0`, "pane-died", `run-shell -b 'tmux -L ${server} -f /dev/null wait-for -S ${channel}-#{pane_id}'`);
  const { stdout } = await tmux(server, "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}");
  const paneId = stdout.trim();
  const exited = waitForPaneExit(server, `${channel}-${paneId}`);
  const metadataBase64 = metadata ? Buffer.from(JSON.stringify(metadata)).toString("base64url") : "";
  await tmux(server, "respawn-pane", "-k", "-t", `${session}:0.0`, "-c", cwd, process.execPath, reporter, socketPath, metadataBase64);
  await exited;
  const { stdout: status } = await tmux(server, "display-message", "-p", "-t", `${session}:0.0`, "#{pane_dead_status}");
  assert.equal(status.trim(), "0");
}

test("direct reporter preserves a plain non-Git cwd without Git or awareness metadata", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "worktree-awareness-plain-")));
  const plain = path.join(directory, "plain");
  const socketPath = path.join(directory, "reports.sock");
  let reports;

  try {
    await command("mkdir", ["-m", "700", plain]);
    reports = await resultSocket(socketPath, 1);
    await launchDirectReporter({ cwd: plain, socketPath });
    const [report] = await reports.received;

    assert.equal(report.cwd, plain);
    assert.deepEqual(report.markers, []);
    assert.equal(report.git, undefined);
    assert.equal(report.metadata, undefined);
  } finally {
    if (reports) await reports.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("real tmux reporters preserve Cohort-resolved cwd across linked worktrees", { skip: !tmuxAvailable && "tmux is unavailable; no real-surface cases ran" }, async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "worktree-awareness-")));
  const socketPath = path.join(directory, "reports.sock");
  const server = `worktree-awareness-${process.pid}-${Date.now()}`;
  let reports;

  try {
    const { repository, alpha, beta } = await initializeWorktrees(directory);
    reports = await resultSocket(socketPath, 2);

    await launchReporter({ server, session: "alpha", cwd: alpha, socketPath, metadata: { repositoryRoot: path.join(directory, "wrong-root") } });
    await launchReporter({ server, session: "beta", cwd: beta, socketPath, metadata: { repositoryRoot: repository } });

    const byCwd = new Map((await reports.received).map((report) => [report.cwd, report]));
    assert.deepEqual([...byCwd.keys()].sort(), [alpha, beta].sort());
    assert.deepEqual(byCwd.get(alpha).markers, ["marker-alpha.txt"]);
    assert.deepEqual(byCwd.get(beta).markers, ["marker-beta.txt"]);
    assert.deepEqual(byCwd.get(alpha).git, { topLevel: alpha, branch: "alpha", detached: false });
    assert.deepEqual(byCwd.get(beta).git, { topLevel: beta, branch: "beta", detached: false });
    assert.equal(byCwd.get(alpha).metadata.repositoryRoot, path.join(directory, "wrong-root"));
    assert.equal(byCwd.get(alpha).cwd, alpha);
    assert.notEqual(byCwd.get(alpha).cwd, byCwd.get(alpha).metadata.repositoryRoot);

    await tmux(server, "kill-server");
    await assert.doesNotReject(git(repository, "worktree", "list", "--porcelain"));
    await assert.doesNotReject(command("test", ["-d", alpha]));
    await assert.doesNotReject(command("test", ["-d", beta]));
  } finally {
    await tmux(server, "kill-server").catch(() => {});
    if (reports) await reports.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
