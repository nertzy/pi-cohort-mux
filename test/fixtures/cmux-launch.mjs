/**
 * Read a cmux create call the way the child surface does: the initial command
 * cmux runs as the surface's process, then the launch file surface-launch.sh
 * sources from its launch directory. Call it while the create is in flight;
 * the launcher removes the directory after the hand-off.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const CREATE_METHODS = new Set(["pane.create", "surface.create"]);

/** The v2 method of a `cmux rpc <method> <params>` create call, or undefined. */
export function createMethod(args) {
  return args[0] === "rpc" && CREATE_METHODS.has(args[1]) ? args[1] : undefined;
}

/** The JSON params of a `cmux rpc` create call. */
export function createParams(args) {
  return JSON.parse(args[2]);
}

const shellTokens = (script) =>
  execFileSync("/bin/sh", ["-c", script]).toString().split("\0").slice(0, -1);

/** The initial command of a create call, split back into its shell tokens. */
export function commandTokens(args) {
  return shellTokens(`printf '%s\\0' ${createParams(args).initial_command}`);
}

export function launchOf(args) {
  const [launcher, launchDir, cli, ...extra] = commandTokens(args);
  const launchFile = join(launchDir, "launch.sh");
  const [fifo, cwd, bootstrap, ...child] = execFileSync("/bin/sh", [
    "-c",
    '. "$1"; printf "%s\\0" "$@"',
    "sh",
    launchFile,
  ])
    .toString()
    .split("\0")
    .slice(0, -1);
  return {
    launcher,
    launchDir,
    cli,
    extra,
    launchFile,
    fifo,
    cwd,
    bootstrap,
    child,
  };
}
