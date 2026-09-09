# Pre-ready startup blocker fixture spike

This fixture-only spike demonstrates a generic startup condition in which a
retained multiplexer pane exists but the child has not yet supplied its
structured control-plane `ready` fact. It is not a production adapter, API,
profile, or configuration contract.

## Boundary and evidence

The fixture launcher waits for a release byte on an owner-only FIFO. It emits
one JSON frame, `{ "type": "ready" }`, through an owner-only Unix socket only
after that release. Its newline-delimited control parser buffers arbitrary
socket chunks until a complete frame arrives. It neither writes a prompt nor
emits a terminal label, so the test never reads pane text or treats terminal
silence as a health signal.

Before creating a launcher pane, the real-tmux test configures a uniquely named
disposable server with the window-scoped `remain-on-exit` option and a
`pane-died` hook. The hook signals a unique `tmux wait-for` channel derived from
the native pane ID. The waiter is armed before each triggering shutdown or
respawn and accepts only a zero-status signal completion; its deadline rejects,
rather than substituting a delay for lifecycle evidence. The test therefore
waits for that native push event rather than repeatedly querying panes,
polling, or sleeping. The retained pane handle has the actionable
`session:window.pane` form.

The fixture dispatches `surface_created` to the task-9 reducer, fires its
injected ready deadline, and records `blocked_before_ready` with retain intent.
That state is explicitly a missing readiness fact, not an exit, a named-tool
failure, or a terminal diagnosis. When the socket frame arrives, dispatching
that authoritative `ready` fact recovers the reducer to `running`.

A separate launcher invocation exits before readiness with status 23. tmux's
retained-pane exit metadata supplies the exact observed status, which is
preserved when dispatched as `exited`; the reducer classifies it as
`startup_failed`. This keeps an authoritative exit distinct from the generic
pre-ready blocker.

## Isolation and cleanup

Each real-tmux run creates a private temporary directory, FIFO, and socket; the
directory is mode 0700 and the FIFO/socket are mode 0600. Every path kills the
disposable tmux server, destroys an accepted control client before closing its
server, and recursively removes the temporary directory. Readiness and command
waits have explicit bounds. If tmux is absent,
only the real-tmux case is skipped with an explicit reason; reducer-only cases
still execute and provide a nonzero test count.
