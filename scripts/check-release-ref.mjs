import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every package under packages/ releases in lockstep from one v<version> tag.
const manifests = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) =>
    JSON.parse(
      readFileSync(join("packages", entry.name, "package.json"), "utf8"),
    ),
  )
  .sort((a, b) => a.name.localeCompare(b.name));
const names = new Set(manifests.map(({ name }) => name));

function fail(message) {
  console.error(message);
  process.exit(1);
}

const versions = new Set(manifests.map(({ version }) => version));
if (versions.size !== 1) {
  const list = manifests.map(({ name, version }) => `${name}@${version}`);
  fail(`Packages must share one version: ${list.join(", ")}`);
}

const [version] = versions;
const expectedTag = `v${version}`;
if (
  process.env.GITHUB_REF_TYPE !== "tag" ||
  process.env.GITHUB_REF_NAME !== expectedTag
) {
  fail(`Publish workflow must run from tag ${expectedTag}.`);
}

for (const { name, dependencies = {} } of manifests) {
  for (const [dependency, range] of Object.entries(dependencies)) {
    if (names.has(dependency) && range !== version) {
      fail(`${name} must depend on ${dependency} ${version}, not ${range}.`);
    }
  }
}

const tagsAtHead = execFileSync("git", ["tag", "--points-at", "HEAD"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
if (!tagsAtHead.includes(expectedTag)) {
  fail(`Tag ${expectedTag} does not point at the checked-out commit.`);
}

console.log(`Release ref ${expectedTag} matches ${[...names].join(", ")}.`);
