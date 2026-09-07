# Lifecycle state-machine fixture spike

This fixture proves the event-driven classification rules that a future core may
adopt. It is **not** a production state machine, mux adapter, process monitor,
or API. Its tests use an injected deterministic scheduler: there is no real
clock, sleep, polling, terminal scraping, or process control.

## Facts and provenance

Every input is retained with its originating boundary rather than being inferred
from a neighboring fact:

| Source | Inputs |
| --- | --- |
| mux | `surface_created`, `surface_closed { requested }`, `exited { status, signal }`, `backend_disconnected`, `no_observed_activity` |
| child control | `ready`, `settled`, `interrupt_ack`, `shutdown_ack`, `session_rebound` |
| session log | `progress`, `result` |
| parent intent | `interrupt`, `shutdown_after_delivery`, `explicit_close` |

`surface_created` is only mux-object existence, never readiness. `exited` is
authoritative only when it contains the observed status and signal. A mux
connection loss changes mux knowledge to `unknown`; it does not change control
or session-log facts, nor prove a child exited. A control loss before settlement
is `control_disconnected`, retained for one reconciliation, and is never a death
claim.

## State vocabulary and precedence

The fixture uses these displayable phases:

- `created`, `awaiting_ready`, and `running` are ordinary progress states.
- `startup_failed` is an authoritative exit before `ready`; it retains the exit
  evidence.
- `surface_closed_before_ready` says that the mux surface closed without an exit;
  it is not a crash.
- `blocked_before_ready` is the missing-ready deadline while the surface remains;
  it retains the run. A later authoritative `ready` while that surface is still
  valid clears the deadline fact and recovers to `running`. It assigns no
  explanation by parsing terminal output.
- `control_disconnected` is an unresolved control boundary loss.
- `needs_attention` records advisory `no_observed_activity`; it never means
  `hung`, `healthy`, or `dead`, and triggers no termination.
- `delivery_candidate` requires both `result` and `settled`, and wins over a
  subsequent unrequested surface closure.
- `taken_over` is settled without a result when its bounded grace expires. The
  pane and any Cohort-created worktree are retained. It is terminal for the
  original call: a later result remains retained as evidence and provenance but
  cannot make the call a `delivery_candidate`.
- `child_crashed` is an authoritative exit after readiness but before settlement.
  Model fallback remains a core concern and is deliberately absent here.
- `exit_unknown` is an unobserved exit after acknowledged shutdown; no status is
  synthesized and the run is retained.
- `requested_closure` follows explicit adapter-close intent, not child failure.
  It is terminal for the original call: later result, settlement, or exit facts
  remain retained as evidence and provenance but cannot reclassify it.
- `paused` follows `interrupt_ack` and is retained. It is terminal for the
  original call: later result, settlement, or observed exit facts are preserved
  as provenance and evidence but cannot reclassify the call.

One explicit terminal-precedence rule keeps `paused`, `requested_closure`, and
`taken_over` monotonic for the original call once each outcome is reached.
Later facts are still recorded with their source, but cannot reclassify those
calls as `delivery_candidate` or `child_crashed`. `blocked_before_ready` and
`needs_attention` remain recoverable rather than terminal.

For nonterminal outcomes, precedence is deliberately evidence-first: completed
delivery outranks later surface closure; observed exit otherwise outranks
ambiguous closure; missing-fact states retain instead of asserting an outcome.
Parent-requested closure is distinct from spontaneous closure.

## Deadlines and reconciliation

All timers are replaceable one-shot deadlines for a named missing fact: `ready`,
`settled_result`, `exit_after_shutdown`, and advisory `activity`. Every
structured activity event (`ready`, `progress`, or `result`) first clears an
existing advisory `no_observed_activity` fact, then replaces the single advisory
timer; it does not create a periodic timer. A detected mux or control disconnect
schedules exactly one reconciliation for that source, rather than a continuous
loop.

Absence of evidence is represented as missing or `unknown`, never converted into
an exit status, readiness, settlement, crash, hang, or automatic cleanup. The
race-table test exercises opposite arrival orders and checks source provenance,
exactly-once reconciliation, and whether the resulting action is close or
retain.
