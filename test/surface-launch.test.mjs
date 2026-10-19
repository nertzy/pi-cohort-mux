/**
 * surface-launch.sh — the first thing a cmux child surface runs. No cmux
 * needed: a fake cmux CLI records the self-close call.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const LAUNCHER = fileURLToPath(new URL("../packages/pi-cohort-mux-cmux/src/surface-launch.sh", import.meta.url));
const BOOTSTRAP = fileURLToPath(new URL("../packages/pi-cohort-mux/src/env-bootstrap.sh", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "surface launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launchDir = join(root, "launch");
  const fifo = join(launchDir, "environment.fifo");
  const cwd = join(root, "work dir");
  const cliLog = join(root, "cli.log");
  const cli = join(root, "fake-cmux");
  const ran = join(root, "ran");
  await mkdir(launchDir);
  await mkdir(cwd);
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${cliLog}'\n`);
  await chmod(cli, 0o755);
  await execFile("mkfifo", ["-m", "600", fifo]);
  // The child records its cwd and env so tests can tell whether it ran.
  const child = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), probe: process.env.PROBE }))`];
  return { root, launchDir, fifo, cwd, cli, cliLog, ran, child };
}

function launch(f, { surfaceId = "SURFACE-UUID-1", launchDir = f.launchDir } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CMUX_SURFACE_ID;
    if (surfaceId !== null) env.CMUX_SURFACE_ID = surfaceId;
    const proc = spawn("/bin/sh", [LAUNCHER, launchDir, f.fifo, f.cli, f.cwd, BOOTSTRAP, ...f.child], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.once("exit", (code) => resolve({ code, stderr }));
    proc.once("error", reject);
  });
}

const exists = (path) => stat(path).then(() => true, () => false);

test("surface-launch: reports its surface id, then runs the child in its cwd with the piped environment", async (t) => {
  const f = await fixture(t);
  const writer = spawn("/usr/bin/tee", [f.fifo], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => writer.kill("SIGKILL"));
  writer.stdin.end("PROBE=piped\n");

  const { code } = await launch(f);

  assert.equal(code, 0);
  assert.equal(await readFile(join(f.launchDir, "surface-id"), "utf8"), "SURFACE-UUID-1\n");
  const ran = JSON.parse(await readFile(f.ran, "utf8"));
  assert.deepEqual(ran, { cwd: await import("node:fs/promises").then((fs) => fs.realpath(f.cwd)), probe: "piped" });
  assert.equal(await exists(f.cliLog), false, "no self-close on the happy path");
});

test("surface-launch: an abandoned launch (directory gone) closes its own surface and never runs the child", async (t) => {
  const f = await fixture(t);

  const { code, stderr } = await launch(f, { launchDir: join(f.root, "removed") });

  assert.equal(code, 70);
  assert.match(stderr, /abandoned/);
  assert.equal(await exists(f.ran), false);
  assert.equal(await readFile(f.cliLog, "utf8"), "close-surface --surface SURFACE-UUID-1 --force\n");
});

test("surface-launch: a launch whose FIFO was withdrawn after it reported closes itself and never runs the child", async (t) => {
  const f = await fixture(t);
  await rm(f.fifo);

  const { code } = await launch(f);

  assert.equal(code, 70);
  assert.equal(await readFile(join(f.launchDir, "surface-id"), "utf8"), "SURFACE-UUID-1\n");
  assert.equal(await exists(f.ran), false);
  assert.equal(await readFile(f.cliLog, "utf8"), "close-surface --surface SURFACE-UUID-1 --force\n");
});

test("surface-launch: without CMUX_SURFACE_ID an abandoned launch exits without calling cmux", async (t) => {
  const f = await fixture(t);
  await rm(f.fifo);

  const { code } = await launch(f, { surfaceId: null });

  assert.equal(code, 70);
  assert.equal(await exists(f.ran), false);
  assert.equal(await exists(f.cliLog), false);
});
