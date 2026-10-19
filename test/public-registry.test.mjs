import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mux = await jiti.import(new URL("../packages/pi-cohort-mux-cmux/src/index.js", import.meta.url).href);
const { selectExecutionBackend } = await jiti.import(
  "pi-cohort/execution-backend",
);
const installMuxExtension = mux.default;

test("registers through the public pi-cohort execution-backend API", async () => {
  assert.equal(typeof mux.createCmuxExecutionBackend, "function");

  const dispose = installMuxExtension();
  let selectionResult;
  let detectionError;
  try {
    try {
      selectionResult = await selectExecutionBackend("cmux");
    } catch (error) {
      detectionError = error;
    }

    if (detectionError) {
      // Selection reaches detect() only when the named backend is registered.
      // A non-cmux environment therefore still proves registration through the
      // public API without depending on upstream's private registry layout.
      assert.equal(detectionError.message, "Execution backend 'cmux' is unavailable");
    } else {
      assert.equal(selectionResult.selection.kind, "external");
      assert.equal(selectionResult.selection.backend.name, "cmux");
      assert.equal(selectionResult.selection.backend.protocolVersion, 1);
    }
  } finally {
    dispose();
  }

  await assert.rejects(
    selectExecutionBackend("cmux"),
    /Execution backend 'cmux' is not registered/,
  );
});
