#!/bin/sh
# pane-launch: the first thing a herdr child pane runs.
# Usage: sh pane-launch.sh <launch-dir> <fifo> <cwd> <bootstrap> <cmd> [args...]
#
# In tab placement herdr runs this argv directly; in split placement it is
# typed into the user's login shell, so everything that must behave
# identically lives here, under /bin/sh.
#
#   1. Report this pane's own identity: write $HERDR_PANE_ID to
#      <launch-dir>/pane-id, atomically via rename. The adapter reads it only
#      after an ambiguous create failure (a timeout or abort, when herdr may
#      still have made the pane), so it can close exactly this pane.
#   2. Refuse to start an abandoned launch: once the adapter gives up it
#      withdraws the FIFO, then removes the launch directory. Either absence
#      means nobody will collect this pane, so exit 70 without running the
#      child; herdr removes a pane whose process has exited.
#   3. cd to the requested cwd (exit 71 on failure), then exec the env
#      bootstrap, which reads the environment from the FIFO.

_pl_dir=$1 _pl_fifo=$2 _pl_cwd=$3 _pl_bootstrap=$4
shift 4

_pl_abandon() {
  echo "pi-cohort-mux: launch abandoned; this pane exits" >&2
  exit 70
}

{ printf '%s\n' "${HERDR_PANE_ID-}" > "$_pl_dir/pane-id.tmp" && mv -f "$_pl_dir/pane-id.tmp" "$_pl_dir/pane-id"; } 2>/dev/null || _pl_abandon
[ -p "$_pl_fifo" ] || _pl_abandon
cd "$_pl_cwd" || exit 71

exec /bin/sh "$_pl_bootstrap" "$_pl_fifo" "$@"
