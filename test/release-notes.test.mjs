import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const script = resolve("scripts/extract-release-notes.mjs");
const directories = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extract(changelog, version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "pi-cohort-mux-release-notes-"));
  directories.push(directory);
  const changelogPath = join(directory, "CHANGELOG.md");
  writeFileSync(changelogPath, changelog);

  return spawnSync(process.execPath, [script, version, changelogPath], {
    encoding: "utf8",
  });
}

test("extracts the matching changelog section", () => {
  const result = extract(`# Changelog

## [1.2.4] - 2026-09-13

- Later.

## [1.2.3] - 2026-09-12

### Added

- Release feature.

## [1.2.2] - 2026-09-11

- Earlier.
`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "## [1.2.3] - 2026-09-12\n\n### Added\n\n- Release feature.\n",
  );
});

test("rejects a missing changelog section", () => {
  const result = extract(`# Changelog

## [1.2.30] - 2026-09-12

- Different release.
`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No changelog section found for 1\.2\.3/);
});

test("rejects an empty changelog section", () => {
  const result = extract(`# Changelog

## [1.2.3] - 2026-09-12

## [1.2.2] - 2026-09-11

- Earlier.
`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Changelog section for 1\.2\.3 is empty/);
});
