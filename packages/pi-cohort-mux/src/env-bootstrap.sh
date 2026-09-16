#!/bin/sh
# env-bootstrap: read env from a FIFO, then exec the real command.
# Usage: sh env-bootstrap.sh <fifo-path-or-empty> <cmd> [args...]
# Reads KEY=VALUE lines; values with embedded '=' are preserved (the shell's
# built-in export splits only on the first '='). Empty lines are skipped.
# Never uses eval. Never spawns env(1) — assignments are exported via the
# shell's built-in 'export NAME=VALUE', so no secret ever enters process argv.
#
# Algorithm:
#   1. Accumulate KEY=VALUE lines as positional params (prepended before cmd).
#   2. Insert an empty-string delimiter between env entries and command args.
#   3. Unset all bootstrap scratch variables before touching the environment
#      (prevents the bootstrap's own names from leaking or masking user values).
#   4. Export each entry via 'export "$1"' + shift until the empty delimiter.
#   5. Shift past the delimiter, then exec the command.
#
# No scratch variable is written after the export pass begins.
# Executable paths containing '=' are safe because the command boundary is
# the explicit empty-string delimiter, not argument shape heuristics.

_bs_fifo="$1"; shift

if [ -n "$_bs_fifo" ]; then
  # Place empty-string delimiter BEFORE command args first.
  # After the read loop: $@ = KEY1=V1 KEY2=V2 ... "" CMD arg1 arg2 ...
  set -- "" "$@"

  while IFS= read -r _bs_line; do
    case "$_bs_line" in '') continue;; esac
    set -- "$_bs_line" "$@"
  done < "$_bs_fifo"

  # Unset bootstrap scratch variables before modifying the environment.
  # This prevents the bootstrap's own names from persisting into the child
  # and ensures any parent-exported value for these names is cleared so
  # that a FIFO-supplied value (if any) wins cleanly via the export below.
  unset _bs_fifo _bs_line

  # Export each KEY=VALUE entry until the empty-string delimiter.
  # 'export "$1"' is a shell built-in — no external process, no argv leak.
  while [ -n "$1" ]; do
    export "$1"
    shift
  done
  shift  # discard the empty delimiter

  exec "$@"
else
  exec "$@"
fi
