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
