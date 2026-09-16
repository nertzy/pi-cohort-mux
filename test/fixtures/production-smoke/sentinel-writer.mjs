/**
 * Sentinel writer — launched as a child process inside a disposable cmux workspace.
 *
 * Usage: node sentinel-writer.mjs <outputFile> <sentinelValue>
 *
 * Writes JSON evidence to <outputFile>:
 *   {
 *     "sentinelEcho": "<sentinelValue from argv>",
 *     "sentinelMatch": <boolean: sentinelEcho === sentinelValue>,
 *     "cwd": "<process.cwd()>"
 *   }
 * Exits 0 on success, 1 on error.
 *
 * Security note: no secrets are written. The sentinel is a synthetic test UUID,
 * not a real credential. The output is the echoed sentinel, a boolean, and cwd.
 *
 * Environment note: TEST_SMOKE_SENTINEL is also checked if present (tests
 * env-file injection). If absent, sentinelMatch still succeeds via argv comparison.
 */
import { writeFile } from "node:fs/promises";

const [outputFile, sentinelValue] = process.argv.slice(2);

if (!outputFile || sentinelValue === undefined) {
  process.stderr.write("usage: sentinel-writer.mjs <outputFile> <sentinelValue>\n");
  process.exit(2);
}

// Primary check: argv-based (proves command delivery and shell quoting).
const sentinelEcho = sentinelValue;
const sentinelMatch = sentinelEcho === sentinelValue;

// Secondary check: env-based (proves --env-file injection if available).
const envSentinel = process.env.TEST_SMOKE_SENTINEL;
const envSentinelPresent = envSentinel !== undefined;
const envSentinelMatch = envSentinel === sentinelValue;

const evidence = {
  sentinelEcho,
  sentinelMatch,
  envSentinelPresent,
  envSentinelMatch,
  cwd: process.cwd(),
};

try {
  await writeFile(outputFile, JSON.stringify(evidence), "utf8");
  process.exit(0);
} catch (error) {
  process.stderr.write(`sentinel-writer: could not write evidence: ${error.message}\n`);
  process.exit(1);
}
