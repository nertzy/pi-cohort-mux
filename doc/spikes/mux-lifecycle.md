# Mux lifecycle capability spike

**Version scope:** this spike is grounded in cmux **0.64.22** (`cmux --version`:
`cmux 0.64.22 (102) [ddd4a01bc]`) and tmux **3.7c** (`tmux -V`: `tmux 3.7c`).
It defines an adapter boundary, not a claim that either mux supplies Pi results.
Probe only these exact versions at adapter startup. An auto-selected adapter that
cannot establish the required capability set falls back to native execution; an
explicitly selected unavailable or incompatible adapter fails loudly. Do not
silently emulate an unavailable lifecycle fact.

## Facts have separate provenance

An adapter must retain independent facts and their source. In particular,
`created`, `ready`, `settled`, `exited(status)`, `surface_closed`,
`backend_disconnected`, `no_observed_activity`, and `unknown` are not aliases
for one another. `ready` and `settled` below are **Pi semantic** facts; neither
follows from a terminal object existing.

| Fact class | cmux 0.64.22 | tmux 3.7c | What it can authoritatively mean | What it cannot mean |
| --- | --- | --- | --- | --- |
| Terminal/mux entity | `events.stream` publishes `workspace.created`, `workspace.closed`, `pane.created`, `pane.closed`, `surface.created`, and `surface.closed`. A successful `surface.health` or list query is a one-shot current snapshot. | The adapter owns the session/window/pane identifiers. Creation command success gives a pane ID; retained panes expose `pane_dead`, `pane_dead_status`, `pane_dead_signal`, and `pane_dead_time`. | `created`, current entity presence, `surface_closed`, or a retained pane's `exited(status)`. | `surface.created`/pane creation is not Pi readiness. A health snapshot is UI-hosting/rendering state, not process state. |
| Pi semantic lifecycle | Native Pi integration installed by `cmux hooks pi install` emits `agent.hook.*` Feed events, including activity and Stop derived after Pi `agent_settled`. | No native Pi semantics. The adapter must obtain them from Pi. | A surface-bound Pi session identifier, hook activity, and Pi settlement/Stop when the public hook is installed. | A terminal's existence, PID, current command, or output is not Pi health, readiness, settlement, or a Cohort result. |
| Adapter-owned process | cmux exposes no generic public terminal-child exit/status event. | Launch with `remain-on-exit on`; bridge a `pane-died` hook through control-mode `%message`; persist the retained pane fields before cleanup. | An adapter-owned process can become `exited(status)` from the retained pane fact. | `pane-exited` without retention is not an exit-status route. `pane_pid` is only the first pane process and does not prove a wrapped Pi child is alive. |
| Transport connectivity | `events.stream` ack, event frames, heartbeat, local EOF/read/write error. | Control-mode records and connection; `%exit [reason]` ends the control client's backend authority. | `subscribed`, stream/control connection health, or `backend_disconnected`. | Disconnect does not close a workspace/surface or prove a child exited. A heartbeat only proves stream delivery. |
| Activity/silence observation | No public lifecycle activity or command-staleness event; `system.top`, `debug.terminals`, and health are snapshots. | `monitor-activity`/`monitor-silence` and alert hooks are window-level terminal-output observations. | `no_observed_activity` (or observed terminal output) over the selected interval. | Silence never proves a hang, death, blockage, or Pi unhealthiness. Output never proves a final result. |

A state transition must preserve this provenance in its event record. For
example, a cmux `surface.closed` becomes `surface_closed`, while an EOF becomes
`backend_disconnected`; neither may be rewritten to `exited`. If a fact was
missed or a query could not complete, retain its last known value and record
`unknown`, rather than inventing a closure or a result.

## cmux: resumable mux facts, not command completion

`events.stream` (the `cmux events` CLI) is the public lifecycle subscription.
It is a blocking, newline-delimited JSON stream with an ack, sequence cursor,
resume metadata, and heartbeats. Use one continuous, resumable subscription for
workspace, surface, and pane creation/closure; do not use periodic list calls as
its replacement.

1. Process each event durably, then persist its cursor/sequence.
2. Reconnect using that cursor after EOF or a read/write error.
3. If the ack reports `resume.gap`, or its `boot_id` changed, mark affected mux
   facts `unknown` and perform one snapshot reconciliation (`workspace.list`,
   `surface.list`, and, where needed, `surface.health`).
4. Resume streaming after that one reconciliation. An overdue heartbeat is a
   stream deadline: reconnect and label the transport unresponsive/disconnected;
   it is never a terminal deadline.

`surface.created` proves only that cmux created its model surface. It does not
prove a view is attached to a window, that the terminal child accepts input, or
that Pi is ready. `surface.health` may reconcile UI attachment/renderer state,
but has no public health-change event and no terminal completion meaning.
Likewise, `wait-for` is only a named user synchronization signal, not a
terminal/process lifecycle wait. cmux's published capabilities include
`events.v1`, and its public methods include `events.stream`, `surface.health`,
workspace/surface/pane operations, `system.top`, and `debug.terminals`; they do
not include a generic command-completed, process-exited, exit-code, or
PTY-idle lifecycle event.

### Native Pi hook integration

`cmux hooks pi install` generates the Pi extension at
`~/.pi/agent/extensions/cmux-session.ts` (or its `PI_CODING_AGENT_DIR`
equivalent). Its public bridge publishes `agent.hook.<HookEventName>` events.
For Pi it can authoritatively add a surface-bound Pi session identity, tool
activity telemetry, and a Stop/completion observation that is derived from Pi's
`agent_settled` after the agent is idle. This is a valuable semantic lifecycle
signal and is distinct from surface creation.

It is deliberately not a Cohort result transport: public workstream event
payloads redact `extra_fields` (and sensitive input/context fields), so they
cannot carry the full Cohort result payload. Nor are hook events a generic
terminal exit/status contract. cmux's private AgentChat process-exit watcher and
mobile registry are implementation details, not an SPI dependency. An adapter
that requires full results or control must own a separate Pi lifecycle IPC
channel and retain its complete structured payload there.

## tmux: adapter-owned retained exit facts

A tmux adapter owns its server/session/window/pane handles and should use an
isolated, explicit server lifetime policy. Launch the tracked process with
`exec pi ...` after setup where possible; otherwise the outer shell can survive
while Pi has already failed.

For each adapter-owned run:

1. Set `remain-on-exit on` before launch, so the pane remains queryable after
   its program exits.
2. Install a `pane-died` hook that sends an unambiguous, fixed-prefix record by
   `display-message`; consume that hook as `%message` in a persistent
   control-mode client. Capture `hook_pane`, `pane_dead`, `pane_dead_status`,
   `pane_dead_signal`, and `pane_dead_time` into durable adapter state.
3. Optionally install `refresh-client -B` pane-format subscriptions as
   reconciliation. They are coalesced (at most once per second) and limited to
   the attached session, so they are not the sole completion mechanism.
4. Before `kill-pane`, persist explicit `closing` intent. A resulting removal
   is requested cleanup, not spontaneous child failure. Close a successful
   retained pane only after its Pi result was delivered; retain failed,
   interrupted, or unknown runs for diagnosis.

`pane-died` happens specifically when retention leaves the exited pane open;
therefore the dead-pane formats provide the durable status/signal/time route.
`pane-exited` fires for process exit generally, but without retention the pane
is closing and its dead/status fields are blank: it is not an exit-status route.
`%exit [reason]` means loss of the control backend, not child success or
failure. Reconnect/reconcile once; do not classify every tracked pane as dead.

## Ordering, deadlines, and recovery

The hierarchy is intentionally narrow:

1. Consume native mux push facts first (`events.stream`, tmux control `%message`
   from `pane-died`).
2. Use adapter-owned Pi lifecycle IPC for full Pi results, ready/settled control,
   and interruption acknowledgement.
3. Reconcile once after a cursor gap, boot change, control loss, or a specific
   ambiguous operation; use a successful snapshot only for current mux state.
4. Apply a deadline only when a particular expected event is missing (for
   example, no stream ack, a missing Pi IPC ready/settled acknowledgement, or a
   missing retained-pane observation after an adapter-owned termination).

There are no sleep/poll loops in this design. A deadline changes the missing
fact to `unknown`/transport-unresponsive and triggers the one reconciliation or
explicit failure path; it does not manufacture `exited` or `settled`.

## Verified probes

No long-lived `cmux events` probe was launched here: prior lifecycle research
observed stream heartbeats and had to interrupt the subscriber, which confirms
it is intentionally blocking rather than a one-shot probe.

| Probe command | Observed result | Consequence |
| --- | --- | --- |
| `cmux --version`; `cmux capabilities` | `0.64.22`; JSON lists `events.v1`, `surface.health`, `workspace.list`, `surface.list`, `pane.list`, `system.top`, and `debug.terminals` methods; no generic exit-status method. `events.stream` is verified by `cmux events --help` and the public docs/source/socket method. | Stream mux model facts; do not claim generic child exit facts. |
| `cmux events --help`; `cmux hooks --help`; `cmux hooks pi --help` | Events help documents `--after`, `--cursor-file`, `--reconnect`, and `--no-heartbeat`; hooks help accepts `cmux hooks <agent> install` and lists the generated Pi extension path. | Use cursor resume and the exact install form `cmux hooks pi install`; do not guess flags. |
| Bounded source inspection: `rg -n -M 200 'agent\\.hook|agent_settled|hooks pi install' /Users/grant/code/cmux/{Sources,CLI,docs}` | The generated Pi extension subscribes to `agent_settled`; event publishing names `agent.hook.<HookEventName>`; documentation lists the hook event family. Separate source inspection shows `extra_fields` redaction. | Hooks contribute bounded semantic signals, not unredacted Cohort results. |
| Disposable tmux 3.7c server with `remain-on-exit on`, a `pane-died` hook, and child `exit 23` | Retained pane format output: `%2|dead=1|status=23|signal=|time=1788736354`. | `pane-died` plus retained pane formats yields `exited(23)` with status provenance. |
| tmux control-mode `refresh-client -B 'pane-state:%*:#{pane_id},#{pane_dead},#{pane_dead_status}'` | Retained-exit observation: `%subscription-changed pane-state $0 @0 0 %1 : %1,1,23`. | Subscription is useful reconciliation, not the primary/coherent result channel. |

The absolute `pane_dead_time` value is tmux's observed epoch value, not an
assertion about wall-clock ordering across machines. All source and probe claims
above are version-scoped; later cmux/tmux releases must be re-probed before
adding capabilities or relaxing the degrade behavior.
