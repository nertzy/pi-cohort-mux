#!/bin/sh
# surface-launch: the first thing a cmux child surface runs.
# Usage: sh surface-launch.sh <launch-dir> <fifo> <cmux-cli> <cwd> <bootstrap> <cmd> [args...]
#
# cmux types --command into the user's login shell (bash, zsh, fish, ...), so
# everything that must behave identically lives here, under /bin/sh.
#
#   1. Report this surface's own identity: write $CMUX_SURFACE_ID to
#      <launch-dir>/surface-id, atomically via rename. The launcher reads it
#      only after an ambiguous create failure (a timeout or abort, when cmux
#      may still have made the surface), so it can close exactly this surface
#      without guessing from titles or positions.
#   2. Refuse to start an abandoned launch: once the launcher gives up it
#      withdraws the FIFO, then removes the launch directory. Either absence
#      means nobody will collect this surface, so it closes itself (it is
#      ours) and exits 70 without running the child.
#   3. cd to the requested cwd (exit 71 on failure), then exec the env
#      bootstrap, which reads the environment from the FIFO.

_sl_dir=$1 _sl_fifo=$2 _sl_cli=$3 _sl_cwd=$4 _sl_bootstrap=$5
shift 5
_sl_id=${CMUX_SURFACE_ID-}

_sl_abandon() {
  echo "pi-cohort-mux: launch abandoned; closing this surface" >&2
  if [ -n "$_sl_id" ]; then
    "$_sl_cli" close-surface --surface "$_sl_id" --force >/dev/null 2>&1
  fi
  exit 70
}

{ printf '%s\n' "$_sl_id" > "$_sl_dir/surface-id.tmp" && mv -f "$_sl_dir/surface-id.tmp" "$_sl_dir/surface-id"; } 2>/dev/null || _sl_abandon
[ -p "$_sl_fifo" ] || _sl_abandon
cd "$_sl_cwd" || exit 71

exec /bin/sh "$_sl_bootstrap" "$_sl_fifo" "$@"
