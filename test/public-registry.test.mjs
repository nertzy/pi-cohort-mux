import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mux = await jiti.import(new URL("../src/index.js", import.meta.url).href);
const installMuxExtension = mux.default;
const spi = await jiti.import("pi-cohort/execution-backend");
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
    const selected = await spi.selectExecutionBackend("cmux");
    assert.equal(selected.selection.kind, "external");
    assert.equal(selected.selection.backend.name, "cmux");

    const registration = registry.executionBackendRegistrations().find(
      ({ name }) => name === "cmux",
    );
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
