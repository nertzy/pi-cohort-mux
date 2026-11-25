import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);

/**
 * The processes a process descends from, nearest first.
 *
 * A multiplexer's environment variables are inherited by everything started
 * under one of its terminals, including a terminal server that outlives that
 * terminal and hands the same variables to terminals the multiplexer never
 * made. An adapter proves the multiplexer started this terminal by finding the
 * multiplexer's own process in this chain.
 *
 * `command` is ps's `comm`: the executable's path on macOS, and a name
 * truncated to 15 characters on Linux, so match by `pid` where the
 * multiplexer reports one.
 *
 * @param {object} [options]
 * @param {Function} [options.execFile] promisified execFile (for testing).
 * @param {number} [options.pid] the process to start from; default this one.
 * @param {number} [options.timeout] milliseconds ps may take.
 * @returns {Promise<Array<{ pid: number, command: string }>>}
 */
export async function processAncestors({
  execFile = defaultExecFile,
  pid = process.pid,
  timeout,
} = {}) {
  const { stdout } = await execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], {
    timeout,
  });
  const table = new Map();
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (row)
      table.set(Number(row[1]), { parent: Number(row[2]), command: row[3] });
  }
  const self = table.get(pid);
  if (!self) throw new Error(`ps did not list process ${pid}`);

  const ancestors = [];
  const seen = new Set([pid]);
  for (
    let current = self.parent;
    table.has(current) && !seen.has(current);
    current = table.get(current).parent
  ) {
    seen.add(current);
    ancestors.push({ pid: current, command: table.get(current).command });
  }
  return ancestors;
}
