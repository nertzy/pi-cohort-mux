import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("declares a private ESM package for pi-cohort mux backends", () => {
  assert.equal(packageJson.name, "pi-cohort-mux");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines.node, ">=20");
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.repository, "github:nertzy/pi-cohort-mux");
  assert.equal(packageJson.exports["."], "./src/index.js");
  assert.equal(
    packageJson.exports["./execution-backend"],
    "./src/cmux-backend.js",
  );
});

test("declares an exact immutable Git commit dependency on pi-cohort core SPI", () => {
  // Runtime dependency: src/index.js imports registerExecutionBackend from pi-cohort/execution-backend.
  // Must pin the nertzy/pi-cohort fork at the exact commit that introduced the SPI
  // (>=6.0.1 released version lacks SPI; no local tarballs or absolute paths).
  const REQUIRED_COMMIT = "84eb447af4ee2c2c1fbda97ca6e14ee1aa35d5a9";
  const piCohortDep = packageJson.dependencies?.["pi-cohort"];
  assert.ok(
    typeof piCohortDep === "string",
    "pi-cohort must be declared in dependencies",
  );
  assert.ok(
    piCohortDep.includes(REQUIRED_COMMIT),
    `pi-cohort dependency must pin exact commit ${REQUIRED_COMMIT}, got: ${piCohortDep}`,
  );
  assert.ok(
    piCohortDep.includes("nertzy/pi-cohort"),
    `pi-cohort dependency must reference nertzy/pi-cohort fork, got: ${piCohortDep}`,
  );
  // Must not be a tarball, absolute path, or semver range
  assert.ok(
    piCohortDep.startsWith("git+https://"),
    `pi-cohort dependency must use HTTPS URL (git+https://), got: ${piCohortDep}`,
  );
  assert.equal(piCohortDep.startsWith("file:"), false, "dependency must not be a local file path");
  assert.equal(piCohortDep.startsWith("/"), false, "dependency must not be an absolute path");
  assert.equal(piCohortDep.startsWith("^"), false, "dependency must not be a semver caret range");
  assert.equal(piCohortDep.startsWith(">="), false, "dependency must not be a semver gte range");
  // package must remain private / unpublished
  assert.equal(packageJson.private, true, "package must remain private:true");
});

test("declares jiti as a direct devDependency (used directly in test files)", () => {
  // jiti is imported directly in test/public-registry.test.mjs and
  // test/execution-backend-public-conformance.test.mjs. Relying on it solely
  // as a transitive dep from pi-cohort is unreliable.
  const jitiDep = packageJson.devDependencies?.["jiti"];
  assert.ok(
    typeof jitiDep === "string",
    "jiti must be declared in devDependencies (directly used in test files)",
  );
});

test("does not declare typebox as a direct dependency (transitive only)", () => {
  // typebox is not imported directly anywhere in pi-cohort-mux source or tests;
  // it is only used internally by pi-cohort and arrives as a transitive dep.
  assert.equal(
    packageJson.dependencies?.["typebox"],
    undefined,
    "typebox must not be a direct dependency of pi-cohort-mux",
  );
  assert.equal(
    packageJson.devDependencies?.["typebox"],
    undefined,
    "typebox must not be a direct devDependency of pi-cohort-mux",
  );
});
