import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createConformanceBackend } from "./fixtures/execution-backend/contract.mjs";
import { registerExecutionBackendConformance } from "./fixtures/execution-backend/testkit.mjs";

const secret = "do-not-persist-this-secret";
const fixture = () => createConformanceBackend();

const registered = registerExecutionBackendConformance({
  test,
  name: "deterministic surface backend",
  createBackend: fixture,
  prohibitedValues: [secret],
});

test("conformance suite registers concrete cases", () => {
  assert.ok(registered > 0);
});

test("an external Node test can import the kit and rejects broken backends", async () => {
  const testkit = new URL("./fixtures/execution-backend/testkit.mjs", import.meta.url).href;
  const contract = new URL("./fixtures/execution-backend/contract.mjs", import.meta.url).href;

  await assertRejectedExternalConformance(testkit, `
    registerExecutionBackendConformance({ test, name: "broken", createBackend: () => ({}) });
  `, /detect|backend/i);

  await assertRejectedExternalConformance(testkit, `
    import { createConformanceBackend } from ${JSON.stringify(contract)};
    const createBackend = () => {
      const backend = createConformanceBackend();
      const launch = backend.launch.bind(backend);
      backend.launch = async (request) => {
        const lease = await launch(request);
        lease.handle.callback = () => {};
        return lease;
      };
      return backend;
    };
    registerExecutionBackendConformance({ test, name: "function handle", createBackend });
  `, /live functions/i);

  await assertExternalConformance(testkit, `
    import assert from "node:assert/strict";
    import { createConformanceBackend } from ${JSON.stringify(contract)};
    const createMutatingBackend = () => {
      const backend = createConformanceBackend();
      const launch = backend.launch.bind(backend);
      backend.launch = async (request) => {
        request.args.push("--mutated-by-another-suite");
        request.environment.MUTATED = "true";
        return launch(request);
      };
      return backend;
    };
    const createIndependentBackend = () => {
      const backend = createConformanceBackend();
      const launch = backend.launch.bind(backend);
      backend.launch = async (request) => {
        assert.deepEqual(request.args, ["--session", "session.jsonl"]);
        assert.deepEqual(request.environment, { SAFE: "1" });
        return launch(request);
      };
      return backend;
    };
    registerExecutionBackendConformance({
      test, name: "mutating", createBackend: createMutatingBackend,
    });
    registerExecutionBackendConformance({
      test, name: "independent", createBackend: createIndependentBackend,
    });
  `, 24);

  await assertRejectedExternalConformance(testkit, `
    import { createConformanceBackend } from ${JSON.stringify(contract)};
    const sentinel = ${JSON.stringify(secret)};
    const createBackend = () => {
      const backend = createConformanceBackend();
      const launch = backend.launch.bind(backend);
      backend.launch = async (request) => {
        const lease = await launch(request);
        request.args.push(sentinel);
        request.environment.LEAK = sentinel;
        lease.handle.display = sentinel;
        lease.handle.callback = () => {};
        backend.state.persisted = { sentinel };
        const push = lease.push.bind(lease);
        lease.push = (event) => push({ ...event, sentinel });
        return lease;
      };
      return backend;
    };
    registerExecutionBackendConformance({
      test, name: "leaky", createBackend, prohibitedValues: [sentinel],
    });
  `, /prohibited value|live functions/i);
});

async function assertExternalConformance(testkit, body, expectedTestCount) {
  const result = await runExternalConformance(testkit, body);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, new RegExp(`tests ${expectedTestCount}`));
}

async function assertRejectedExternalConformance(testkit, body, expectedError) {
  const result = await runExternalConformance(testkit, body);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, expectedError);
}

async function runExternalConformance(testkit, body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-cohort-mux-kit-"));
  const externalTest = path.join(directory, "external.test.mjs");
  try {
    await writeFile(externalTest, `
      import test from "node:test";
      import { registerExecutionBackendConformance } from ${JSON.stringify(testkit)};
      ${body}
    `);
    return await processResult(process.execPath, ["--test", externalTest]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function processResult(command, arguments_) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const child = spawn(command, arguments_, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}
