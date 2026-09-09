#!/bin/sh
# env-bootstrap: read env from a FIFO, then exec the real command.
# Usage: sh env-bootstrap.sh <fifo-path-or-empty> <cmd> [args...]
# Reads KEY=VALUE lines; values with embedded '=' are preserved.
# Empty lines are skipped. Never uses eval — no shell injection.
fifo="$1"; shift
if [ -n "$fifo" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key="${line%%=*}"
    val="${line#*=}"
    export "$key"="$val"
  done < "$fifo"
fi
exec "$@"
