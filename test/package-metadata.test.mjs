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

test("requires a compatible pi-cohort version containing the core SPI", () => {
  // Runtime dependency: src/index.js imports registerExecutionBackend from
  // pi-cohort/execution-backend. Version 6.1.0 is the compatibility floor
  // because it first published that API and the execution-backend testkit.
  assert.equal(packageJson.dependencies?.["pi-cohort"], "^6.1.0");
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
