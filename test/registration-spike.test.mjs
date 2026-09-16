import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { once } from "node:events";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";

const fixture = (name) => new URL(`fixtures/registration/${name}`, import.meta.url);
const fixturePath = (name) => fileURLToPath(fixture(name));
const registryKey = Symbol.for("pi-cohort.registration-spike.backends.v1");
const probeTimeout = 10_000;

function resolvePi() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory || ".", "pi");

    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH for an executable pi binary.
    }
  }

  return null;
}

async function stopChild(child, close) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  await Promise.race([
    close.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await close.catch(() => {});
  }
}

async function probePi(pi, extensions) {
  const child = spawn(pi, [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    ...extensions.flatMap((extension) => ["--extension", fixturePath(extension)]),
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const close = once(child, "close");
  let stdout = "";
  let stderr = "";
  let timeout;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    child.stdin.end('{"id":"probe","type":"prompt","message":"/registration-spike"}\n');
    const [exitCode, signal] = await Promise.race([
      close,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Pi RPC probe timed out after ${probeTimeout}ms`)), probeTimeout);
      }),
    ]);

    return { exitCode, signal, stderr, stdout };
  } finally {
    clearTimeout(timeout);
    await stopChild(child, close);
  }
}

const pi = resolvePi();
const apiA = await import(fixture("public-api-a.mjs"));
const apiB = await import(fixture("public-api-b.mjs"));
const core = (await import(fixture("fake-core-extension.mjs"))).default;
const companion = (await import(fixture("fake-companion-extension.mjs"))).default;

beforeEach(() => {
  delete globalThis[registryKey];
});

test("companion-first registration is resolved when the core command executes", () => {
  const commands = new Map();
  companion({ registerCommand: (name, command) => commands.set(name, command) });
  core({ registerCommand: (name, command) => commands.set(name, command) });

  assert.deepEqual(commands.get("registration-spike").handler(), ["fake-backend"]);
});

test("core-first registration is resolved when the core command executes", () => {
  const commands = new Map();
  core({ registerCommand: (name, command) => commands.set(name, command) });
  companion({ registerCommand: (name, command) => commands.set(name, command) });

  assert.deepEqual(commands.get("registration-spike").handler(), ["fake-backend"]);
});

test("separate public API module copies share one versioned global hub", () => {
  apiA.registerBackend({ name: "alpha" });
  apiB.registerBackend({ name: "beta" });

  assert.deepEqual(apiA.listBackends().map((backend) => backend.name), ["alpha", "beta"]);
  assert.deepEqual(apiB.listBackends().map((backend) => backend.name), ["alpha", "beta"]);
});

test("duplicate backend names fail loudly without replacing the original", () => {
  const original = { name: "duplicate" };
  apiA.registerBackend(original);

  assert.throws(() => apiB.registerBackend({ name: "duplicate" }), /already registered/);
  assert.equal(apiA.listBackends()[0], original);
});

test("incompatible hub protocol versions fail loudly", () => {
  globalThis[registryKey] = { version: 999, backends: new Map() };

  assert.throws(() => apiA.listBackends(), /Unsupported.*version/);
});

test("a disposer permits re-registration after reload", () => {
  const dispose = apiA.registerBackend({ name: "reloadable" });
  dispose();
  apiB.registerBackend({ name: "reloadable" });

  assert.deepEqual(apiA.listBackends().map((backend) => backend.name), ["reloadable"]);
});

test("a stale disposer cannot remove a re-registered backend", () => {
  const oldDispose = apiA.registerBackend({ name: "reloadable" });
  oldDispose();
  const replacement = { name: "reloadable" };
  apiB.registerBackend(replacement);
  oldDispose();

  assert.equal(apiA.listBackends()[0], replacement);
});

test("backend enumeration is deterministic by backend name", () => {
  apiA.registerBackend({ name: "zulu" });
  apiB.registerBackend({ name: "alpha" });
  apiA.registerBackend({ name: "middle" });

  assert.deepEqual(apiB.listBackends().map((backend) => backend.name), ["alpha", "middle", "zulu"]);
});

for (const [name, extensions] of [
  ["companion-first", ["fake-companion-extension.mjs", "fake-core-extension.mjs"]],
  ["core-first", ["fake-core-extension.mjs", "fake-companion-extension.mjs"]],
]) {
  test(`Pi 0.85.0 RPC smoke discovers a backend with ${name} CLI extension order`, {
    skip: pi === null && "Pi executable is unavailable on PATH",
    timeout: probeTimeout + 2_000,
  }, async () => {
    const { exitCode, signal, stderr, stdout } = await probePi(pi, extensions);

    assert.equal(signal, null, `Pi stderr: ${stderr}`);
    assert.equal(exitCode, 0, `Pi stderr: ${stderr}\nPi stdout: ${stdout}`);
    assert.match(stderr, /REGISTRATION_SPIKE_BACKENDS:\["fake-backend"\]/);
  });
}
