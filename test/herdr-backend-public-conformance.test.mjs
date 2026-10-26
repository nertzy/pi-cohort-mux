/**
 * herdr execution backend — public core testkit conformance.
 *
 * Drives the backend through pi-cohort's authoritative
 * `pi-cohort/execution-backend-testkit` (imported via Jiti) and its
 * `wrapWithConformanceHarness`, against the stateful fake herdr server, so it
 * runs without a real herdr.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createHerdrBackend } from "pi-cohort-mux-herdr/execution-backend";

import { startFakeHerdr } from "./fixtures/fake-herdr/server.mjs";

const jiti = createJiti(import.meta.url);
const {
  registerExecutionBackendConformance,
  wrapWithConformanceHarness,
  CONFORMANCE_TEST_COUNT,
} = await jiti.import("pi-cohort/execution-backend-testkit");

const servers = [];
test.after(() => Promise.all(servers.map((server) => server.close())));
const herdr = await startFakeHerdr();
servers.push(herdr);

for (const placement of ["tab", "split"]) {
  const registered = registerExecutionBackendConformance({
    test,
    name: `herdr backend, ${placement} placement (core testkit)`,
    createBackend: () => createHerdrBackend({ env: herdr.env, placement }),
    createHarness: (backend) => wrapWithConformanceHarness(backend),
    prohibitedValues: [],
  });

  test(`${placement} placement registers every core testkit case`, () => {
    assert.equal(registered, CONFORMANCE_TEST_COUNT);
  });
}
