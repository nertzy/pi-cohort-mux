import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Each published file and its mode. cmux execs surface-launch.sh directly,
// so it must ship executable; the other scripts run under `sh`.
const common = { LICENSE: 0o644, "README.md": 0o644, "package.json": 0o644 };
const expected = {
  "pi-cohort-mux": {
    ...common,
    "src/adapter.js": 0o644,
    "src/env-bootstrap.sh": 0o644,
    "src/environment.js": 0o644,
    "src/event-queue.js": 0o644,
    "src/index.js": 0o644,
    "src/lease.js": 0o644,
    "src/tool-badge.js": 0o644,
  },
  "pi-cohort-mux-cmux": {
    ...common,
    "src/cmux-backend.js": 0o644,
    "src/index.js": 0o644,
    "src/surface-launch.sh": 0o755,
  },
  "pi-cohort-mux-herdr": {
    ...common,
    "src/herdr-backend.js": 0o644,
    "src/herdr-client.js": 0o644,
    "src/index.js": 0o644,
    "src/pane-launch.sh": 0o644,
  },
};

const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces"], {
    encoding: "utf8",
  }),
);
const packs = Array.isArray(pack) ? pack : Object.values(pack);
const actual = Object.fromEntries(
  packs.map(({ name, files }) => [
    name,
    Object.fromEntries(
      files
        .map(({ path, mode }) => [path, mode])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  ]),
);

assert.deepEqual(actual, expected);
for (const [name, files] of Object.entries(actual)) {
  console.log(`${name} contents match: ${Object.keys(files).join(", ")}`);
}
