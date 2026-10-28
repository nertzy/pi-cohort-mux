#!/bin/sh
# surface-launch: the first thing a cmux child surface runs.
# Usage: surface-launch.sh <launch-dir> <cmux-cli>
#
# cmux runs this script as the surface's own process. It is executable and
# runs under its shebang, so no shell profile is read. cmux keeps the initial
# command in its surface records, so that command carries only fixed paths.
# The request lives in <launch-dir>/launch.sh, an owner-only file whose
# single `set -- <fifo> <cwd> <bootstrap> <cmd> [args...]` line, quoted for
# /bin/sh, this script sources. Everything that must behave identically
# lives here, under /bin/sh.
#
#   1. Report this surface's own identity: write $CMUX_SURFACE_ID to
#      <launch-dir>/surface-id, atomically via rename. The launcher reads it
#      only after an ambiguous create failure (a timeout or abort, when cmux
#      may still have made the surface), so it can close exactly this surface
#      without guessing from titles or positions.
#   2. Refuse to start an abandoned launch: once the launcher gives up it
#      withdraws the FIFO, then removes the launch directory. Any absence
#      (directory, launch file, or FIFO) means nobody will collect this
#      surface, so it exits 70 without running the child.
#   3. cd to the requested cwd (exit 71 on failure), then run the env
#      bootstrap, which reads the environment from the FIFO and execs the
#      child, and exit with the child's status.
#
# cmux holds a surface open after its initial command exits, so on every
# exit this script closes its own surface (it is ours). It stays the
# child's parent to do so: SIGINT and SIGQUIT from the surface reach the
# child, and this script only notes them, waiting for the child to finish.

_sl_dir=$1 _sl_cli=$2
_sl_id=${CMUX_SURFACE_ID-}

if [ -n "$_sl_id" ]; then
  trap '"$_sl_cli" close-surface --surface "$_sl_id" --force >/dev/null 2>&1' EXIT
fi
# Caught, not ignored, so the child starts with the default handlers.
trap : INT QUIT

_sl_abandon() {
  echo "pi-cohort-mux: launch abandoned; closing this surface" >&2
  exit 70
}

{ printf '%s\n' "$_sl_id" > "$_sl_dir/surface-id.tmp" && mv -f "$_sl_dir/surface-id.tmp" "$_sl_dir/surface-id"; } 2>/dev/null || _sl_abandon
# A missing file would make `.` exit this shell, so check first.
[ -f "$_sl_dir/launch.sh" ] || _sl_abandon
. "$_sl_dir/launch.sh"
_sl_fifo=$1 _sl_cwd=$2 _sl_bootstrap=$3
shift 3
[ -p "$_sl_fifo" ] || _sl_abandon
cd "$_sl_cwd" || exit 71

/bin/sh "$_sl_bootstrap" "$_sl_fifo" "$@"
