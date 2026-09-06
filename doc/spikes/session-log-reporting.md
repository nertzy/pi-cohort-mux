# Session-log reporting spike

This executable, fixture-only spike proves the narrow lifecycle boundary proposed
in [mux lifecycle](mux-lifecycle.md). It does not add a Cohort backend, mux
adapter, profile, or production API.

## What runs

`test/session-log-reporting-spike.test.mjs` creates a private `0700` temporary
directory, an empty `0600` `--session` JSONL file, a `0600` Unix control socket,
and a `0600` one-shot FIFO. It starts Pi 0.85.0 as an **interactive TUI** in a
uniquely named disposable tmux 3.7c server with `remain-on-exit` enabled. The
TUI is driven with `tmux send-keys`; it is not started in print, JSON, or RPC
mode.

The explicit `--no-extensions --extension` fixture loads even when normal
extension discovery is disabled. Its custom faux provider returns the fixed
`fixture assistant response` through Pi's installed `@earendil-works/pi-ai`
API. That is a local event stream, not an HTTP provider, model, or network call.

## Fact ownership and ordering observed

Pi owns session framing and assistant-message persistence. Cohort core owns the
custom entry names and control protocol; the companion/mux layer would only own
pane creation and terminal transport.

The runtime test observes this order from the already-known session JSONL:

1. Pi writes the `session` header into the pre-created empty session file.
2. The reporting extension appends `pi-cohort.ready.v1` after that header.
3. A real TUI prompt runs the fixture provider and Pi persists the assistant
   message.
4. Pi's actual `agent_settled` event causes the extension to append
   `pi-cohort.settled.v1` and send a structured settlement notification.
5. The parent reads the fixed assistant message from JSONL, records a simulated
   durable-delivery acknowledgment, and sends `shutdown`.
6. The extension acknowledges, calls `ctx.shutdown()`, and the wrapper signals
   a pre-armed tmux `wait-for` event after Pi exits. One retained-pane query then
   verifies `pane_dead=1` and `pane_dead_status=0`.

This separates entry-level progress (ready and settled lifecycle facts) from the
durable final result (the assistant message Pi wrote). A readiness notification
is therefore useful progress fidelity, not a substitute for reading the final
session entry.

## Security and cleanup

The authentication value exists only in the parent process and a one-shot FIFO.
Only the non-secret FIFO/socket/module paths are passed through environment or
arguments. The test asserts that the value is absent from tmux start-command
metadata, the Pi wrapper arguments, session JSONL, and committed fixture files;
it unlinks the FIFO before cleanup. Every child command has a deadline that sends
SIGTERM then SIGKILL, and `finally` closes the socket, kills the disposable tmux
server, unlinks the FIFO, and removes the temporary directory.

cmux hooks are optional: the proof uses standard tmux `wait-for` plus a retained
pane, so a future cmux adapter may improve integration but is not a lifecycle
requirement.

## Limitations

This is intentionally not production transport code. The FIFO is a test-only
one-shot authentication demonstration, durable delivery is simulated, and the
fixed provider proves no network behavior rather than provider compatibility.
The runtime example skips only when `pi` or `tmux` is unavailable; fixture-unit
checks still run. On the development machine both executables are present, so
the TUI proof executes.

The concept belongs in Cohort core because the custom session entries, settlement
meaning, JSONL result interpretation, and shutdown protocol must mean the same
thing for every terminal backend. A companion should not recreate those Cohort
semantics merely because it happens to create a pane.
