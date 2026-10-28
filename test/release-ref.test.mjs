import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const script = resolve("scripts/check-release-ref.mjs");
const repositories = [];

after(() => {
  for (const directory of repositories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writePackage(directory, name, manifest) {
  mkdirSync(join(directory, "packages", name), { recursive: true });
  writeFileSync(
    join(directory, "packages", name, "package.json"),
    `${JSON.stringify({ name, ...manifest })}\n`,
  );
}

function commit(directory, message) {
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.com",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { cwd: directory },
  );
}

function repository({ adapterVersion = "1.2.3", coreRange = "1.2.3" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-cohort-mux-release-ref-"));
  repositories.push(directory);
  writeFileSync(join(directory, "package.json"), '{"version":"0.0.0"}\n');
  writePackage(directory, "core", { version: "1.2.3" });
  writePackage(directory, "adapter", {
    version: adapterVersion,
    dependencies: { core: coreRange, other: "^4.0.0" },
  });
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  commit(directory, "fixture");
  return directory;
}

function check(directory, type, name) {
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_TYPE: type,
      GITHUB_REF_NAME: name,
    },
  });
}

test("rejects a branch ref", () => {
  const result = check(repository(), "branch", "main");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run from tag v1\.2\.3/);
});

test("rejects a tag that does not match the package version", () => {
  const directory = repository();
  execFileSync("git", ["tag", "v9.9.9"], { cwd: directory });

  const result = check(directory, "tag", "v9.9.9");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run from tag v1\.2\.3/);
});

test("rejects packages whose versions differ", () => {
  const directory = repository({ adapterVersion: "1.2.4" });
  execFileSync("git", ["tag", "v1.2.3"], { cwd: directory });

  const result = check(directory, "tag", "v1.2.3");

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Packages must share one version: adapter@1\.2\.4, core@1\.2\.3/,
  );
});

test("rejects a sibling dependency that is not the release version", () => {
  const directory = repository({ coreRange: "^1.2.0" });
  execFileSync("git", ["tag", "v1.2.3"], { cwd: directory });

  const result = check(directory, "tag", "v1.2.3");

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /adapter must depend on core 1\.2\.3, not \^1\.2\.0/,
  );
});

test("rejects the matching version tag when it does not point at HEAD", () => {
  const directory = repository();
  execFileSync("git", ["tag", "v1.2.3"], { cwd: directory });
  writeFileSync(join(directory, "later.txt"), "later commit\n");
  commit(directory, "later fixture");

  const result = check(directory, "tag", "v1.2.3");

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Tag v1\.2\.3 does not point at the checked-out commit\./,
  );
});

test("accepts the matching version tag at HEAD", () => {
  const directory = repository();
  execFileSync("git", ["tag", "v1.2.3"], { cwd: directory });

  const result = check(directory, "tag", "v1.2.3");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release ref v1\.2\.3 matches adapter, core\./);
});
