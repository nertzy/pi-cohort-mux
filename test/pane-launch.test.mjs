/**
 * pane-launch.sh — the first thing a herdr child pane runs. No herdr needed.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LAUNCHER = fileURLToPath(
  new URL(
    "../packages/pi-cohort-mux-herdr/src/pane-launch.sh",
    import.meta.url,
  ),
);
const BOOTSTRAP = fileURLToPath(
  new URL("../packages/pi-cohort-mux/src/env-bootstrap.sh", import.meta.url),
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pane launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launchDir = join(root, "launch");
  const fifo = join(launchDir, "environment.fifo");
  const cwd = join(root, "work dir");
  const ran = join(root, "ran");
  await mkdir(launchDir);
  await mkdir(cwd);
  await execFile("mkfifo", ["-m", "600", fifo]);
  const child = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), probe: process.env.PROBE }))`,
  ];
  return { root, launchDir, fifo, cwd, ran, child };
}

function launch(
  f,
  { paneId = "w1:p7", launchDir = f.launchDir, cwd = f.cwd } = {},
) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.HERDR_PANE_ID;
    if (paneId !== null) env.HERDR_PANE_ID = paneId;
    const proc = spawn(
      "/bin/sh",
      [LAUNCHER, launchDir, f.fifo, cwd, BOOTSTRAP, ...f.child],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.once("exit", (code) => resolve({ code, stderr }));
    proc.once("error", reject);
  });
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("pane-launch: reports its pane id, then runs the child in its cwd with the piped environment", async (t) => {
  const f = await fixture(t);
  const writer = spawn("/usr/bin/tee", [f.fifo], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  t.after(() => writer.kill("SIGKILL"));
  writer.stdin.end("PROBE=piped\n");

  const { code } = await launch(f);

  assert.equal(code, 0);
  assert.equal(await readFile(join(f.launchDir, "pane-id"), "utf8"), "w1:p7\n");
  assert.deepEqual(JSON.parse(await readFile(f.ran, "utf8")), {
    cwd: await realpath(f.cwd),
    probe: "piped",
  });
});

test("pane-launch: an abandoned launch (directory gone) exits 70 without running the child", async (t) => {
  const f = await fixture(t);
  const { code, stderr } = await launch(f, {
    launchDir: join(f.root, "removed"),
  });
  assert.equal(code, 70);
  assert.match(stderr, /abandoned/);
  assert.equal(await exists(f.ran), false);
});

test("pane-launch: a launch whose FIFO was withdrawn after it reported exits 70 without running the child", async (t) => {
  const f = await fixture(t);
  await rm(f.fifo);
  const { code } = await launch(f);
  assert.equal(code, 70);
  assert.equal(await readFile(join(f.launchDir, "pane-id"), "utf8"), "w1:p7\n");
  assert.equal(await exists(f.ran), false);
});

test("pane-launch: a missing cwd exits 71 without running the child", async (t) => {
  const f = await fixture(t);
  const { code } = await launch(f, { cwd: join(f.root, "nowhere") });
  assert.equal(code, 71);
  assert.equal(await exists(f.ran), false);
});
