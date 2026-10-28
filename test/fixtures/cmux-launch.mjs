/**
 * Read a cmux create call the way the child surface does: the --command line
 * the login shell runs, then the launch file surface-launch.sh sources from
 * its launch directory. Call it while the create is in flight; the launcher
 * removes the directory after the hand-off.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const shellTokens = (script) =>
  execFileSync("/bin/sh", ["-c", script]).toString().split("\0").slice(0, -1);

/** The --command string of a create call, split back into its shell tokens. */
export function commandTokens(args) {
  return shellTokens(`printf '%s\\0' ${args[args.indexOf("--command") + 1]}`);
}

export function launchOf(args) {
  const [sh, launcher, launchDir, cli, ...extra] = commandTokens(args);
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
    sh,
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
