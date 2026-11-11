import { readFileSync } from "node:fs";

const [version, changelogPath = "CHANGELOG.md"] = process.argv.slice(2);

if (!version) {
  console.error("Usage: extract-release-notes.mjs <version> [changelog]");
  process.exit(1);
}

const lines = readFileSync(changelogPath, "utf8").split("\n");
const heading = `## [${version}]`;
const start = lines.findIndex(
  (line) => line === heading || line.startsWith(`${heading} - `),
);

if (start === -1) {
  console.error(`No changelog section found for ${version}.`);
  process.exit(1);
}

const nextSection = lines.findIndex(
  (line, index) => index > start && line.startsWith("## "),
);
const section = lines.slice(
  start,
  nextSection === -1 ? undefined : nextSection,
);
while (section.at(-1) === "") section.pop();

if (!section.slice(1).some((line) => line.trim())) {
  console.error(`Changelog section for ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(`${section.join("\n")}\n`);
