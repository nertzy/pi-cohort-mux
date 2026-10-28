#!/bin/sh
# surface-launch: the first thing a cmux child surface runs.
# Usage: sh surface-launch.sh <launch-dir> <cmux-cli>
#
# cmux types --command into the user's login shell (bash, zsh, fish, ...)
# before it is ready, so the typed line carries only fixed paths: the tty
# drops input past 1023 bytes, and fish reads \\ and \' inside single quotes as
# escapes. The request lives in <launch-dir>/launch.sh, an owner-only file
# whose single `set -- <fifo> <cwd> <bootstrap> <cmd> [args...]` line, quoted
# for /bin/sh, this script sources. Everything that must behave identically
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
#      surface, so it closes itself (it is ours) and exits 70 without running
#      the child.
#   3. cd to the requested cwd (exit 71 on failure), then exec the env
#      bootstrap, which reads the environment from the FIFO.

_sl_dir=$1 _sl_cli=$2
_sl_id=${CMUX_SURFACE_ID-}

_sl_abandon() {
  echo "pi-cohort-mux: launch abandoned; closing this surface" >&2
  if [ -n "$_sl_id" ]; then
    "$_sl_cli" close-surface --surface "$_sl_id" --force >/dev/null 2>&1
  fi
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

exec /bin/sh "$_sl_bootstrap" "$_sl_fifo" "$@"
