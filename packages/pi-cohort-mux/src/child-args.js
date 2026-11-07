// A muxed child runs interactive Pi, so a project without a saved trust
// decision (every pi-cohort worktree lands in a fresh temp directory) shows the
// trust prompt in the pane and emits nothing until someone answers it. The
// parent already chose the child's project, so decide for it. Pi accepts the
// flag after the task positional, which keeps pi-cohort's "task is last"
// contract intact.
const TRUST_FLAGS = new Set(["--approve", "-a", "--no-approve", "-na"]);

export function trustedChildArgs(args) {
  if (args.some((arg) => TRUST_FLAGS.has(arg))) return [...args];
  return [...args, "--approve"];
}
