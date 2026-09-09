import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mux = await jiti.import(new URL("../src/index.js", import.meta.url).href);
const installMuxExtension = mux.default;
const spiDirectory = path.dirname(
  fileURLToPath(import.meta.resolve("pi-cohort/execution-backend")),
);
const registry = await jiti.import(
  pathToFileURL(path.join(spiDirectory, "registry.ts")).href,
);
const reload = await jiti.import(
  pathToFileURL(path.join(spiDirectory, "reload.ts")).href,
);

test("registers through the public pi-cohort registry and reloads its named factory", async () => {
  assert.equal(typeof mux.createCmuxExecutionBackend, "function");

  const dispose = installMuxExtension();
  try {
    // Verify the backend is registered by name without calling detect() — the
    // selection API requires detect() to return available:true, which depends on
    // live CMUX env vars and the real cmux binary. The registration contract
    // (name, reload manifest) is the stable, deterministically-testable surface.
    const registration = registry.executionBackendRegistrations().find(
      ({ name }) => name === "cmux",
    );
    assert.ok(registration, "cmux backend must be registered after installMuxExtension()");
    assert.equal(registration.reload?.factoryExport, "createCmuxExecutionBackend");
    assert.equal(registration.reload?.protocolVersion, 1);
    assert.equal(registration.reload?.publicSubpath, "./execution-backend");

    assert.deepEqual(registration?.reload, {
      protocolVersion: 1,
      packageJsonUrl: new URL("../package.json", import.meta.url).href,
      publicSubpath: "./execution-backend",
      factoryExport: "createCmuxExecutionBackend",
    });

    dispose();
    const reconstructed = await reload.reloadExecutionBackend(
      "cmux",
      registration.reload,
    );
    assert.equal(reconstructed.name, "cmux");
    assert.equal(reconstructed.protocolVersion, 1);
  } finally {
    dispose();
  }
});
