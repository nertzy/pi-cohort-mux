# cmux parity spike (Task 17)

**Version scope:** cmux **0.64.22** (`cmux --version`: `cmux 0.64.22 (102)
[ddd4a01bc]`), probed live from inside a real cmux session
(`CMUX_WORKSPACE_ID`/`CMUX_SOCKET_PATH` set) against the public `cmux` CLI
socket. This spike exists to prove, with real commands and real event
frames, that the design in `doc/spikes/mux-lifecycle.md` matches what public
cmux actually delivers -- before that design is frozen into an adapter SPI.

The executable proof is `test/cmux-parity-spike.test.mjs` plus the
adapter-owned reporter fixture `test/fixtures/cmux-parity/reporter.mjs`. It
explicitly skips when not reachable through a real cmux session (missing
`CMUX_WORKSPACE_ID`/`CMUX_SOCKET_PATH`, or `events.v1` absent from `cmux
capabilities`); it is not skipped in this environment, and it passed.

## What was proved, with evidence

### 1. `cmux events` is a push-driven subscription with client-side correlation

The executable proof starts one long-lived public
`cmux events --name <name> --no-heartbeat` subscriber. It buffers JSONL facts
and receives its `ack` before either disposable workspace is created. The test
matches only the exact UUIDs returned by the reporter and snapshot; unrelated
daemon-wide events, including deliberately-created decoy workspace events,
never satisfy a target wait. The subscriber is explicitly stopped and awaited
during cleanup. One-shot rejecting deadlines guard each expected fact; no
sleep or poll loop is used. Observed ack frame shape:

```jsonc
{
  "boot_id": "3148CDEF-7428-4382-8A8B-5260F7901996",
  "filters": { "categories": [], "names": ["surface.created", "workspace.created"] },
  "heartbeat_interval_seconds": 15,
  "protocol": "cmux-events",
  "replay_count": 0,
  "resume": { "after_seq": null, "gap": false, "latest_seq": 702958, "next_seq": 702959, "oldest_seq": 698863, "requested_after_seq": 702958 },
  "subscription_id": "2A3C5BF0-4038-436F-B303-9D57BDD3E4E5",
  "type": "ack",
  "version": 1
}
```

The test starts this subscription and awaits its `ack` promise *before*
launching the disposable workspace, so no create event can be missed.

### 2. `--focus false` genuinely does not steal focus

`cmux current-workspace` before and after `cmux workspace create --focus
false ...` returns the identical ref (e.g. `workspace:95` throughout), proven
directly in the test rather than assumed.

### 3. Native create events carry the exact same UUIDs as a one-shot snapshot query

Launching `cmux workspace create --name <n> --cwd <dir> --focus false
--command "<adapter-owned reporter>"` and filtering
`--name workspace.created --name surface.created` observed:

```jsonc
{"category":"workspace","name":"workspace.created","payload":{"workspace_id":"3FD50D24-...","cwd":"/tmp",...},"workspace_id":"3FD50D24-...","type":"event", ...}
{"category":"surface","name":"surface.created","payload":{"surface_id":"750FEC6A-...","pane_id":"0E3FAD42-...",...},"surface_id":"750FEC6A-...","type":"event", ...}
```

The reporter (connected over its own structured Unix socket, see below)
independently reported `CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID` from its own
process environment, and those values are identical to the `workspace_id`/
`surface_id` in the native events above. A one-shot
`cmux --id-format both list-pane-surfaces --workspace <ref> --json` snapshot
query (global `--id-format both` prints native UUIDs alongside short refs)
finds the same surface by UUID:

```jsonc
{
  "pane_id": "1BABD28C-...", "pane_ref": "pane:951",
  "surfaces": [{ "id": "950457B5-...", "ref": "surface:2506", "title": "cmux-parity-probe5", "type": "terminal", "selected": true, "index": 0 }],
  "window_id": "C6C39367-...", "window_ref": "window:1",
  "workspace_id": "E4CBA8EB-...", "workspace_ref": "workspace:107"
}
```

This three-way correlation (native event <-> reporter-observed env identity
<-> one-shot snapshot) is what backs the adapter's opaque handle:
`{ workspaceId, workspaceRef, paneId, paneRef, surfaceId, surfaceRef, title,
type, cwd }`. Core run/child identity (a Pi session id, a PID, a Cohort run
id) never appears in it -- the test asserts the handle's exact key set.

### 4. The reporter is socket-only evidence, never pane text

`test/fixtures/cmux-parity/reporter.mjs` is the adapter-owned command passed
to `cmux workspace create --command`. It connects (as a client) to an
owner-only (`chmod 0600`) Unix socket the test process listens on, sends one
`{"type":"ready","cwd":...,"workspaceId":...,"surfaceId":...}` frame, waits
for `{"type":"shutdown"}`, replies `{"type":"shutdown-ack"}`, and exits `0`.
No `read-screen`, pane text, terminal input, or arbitrary command steering is
used anywhere in the spike.

### 5. Serialized-handle reattach proves `present`, then later `gone` -- surface only, never Pi

After building the handle, the test does `JSON.parse(JSON.stringify(handle))`
to simulate an out-of-process reattach, then re-runs the same one-shot
`list-pane-surfaces --workspace <reattached.workspaceRef>` snapshot query and
asserts the surface is still `present` by UUID -- **before** the shutdown/close
sequence below runs. This is deliberately scoped to mux-surface presence; it
never claims anything about a Pi agent session's identity or liveness.

After the disposable workspace is closed by the reattached handle's ref, the
exact same one-shot query against the exact same ref fails:

```
$ cmux list-pane-surfaces --workspace workspace:112 --json
Error: not_found: Pane or workspace not found
```

exit code `1`. One real, adjacent gotcha found and avoided: a **never-valid**
ref number (one that was never returned by a real create) can silently
resolve back to the caller's own current workspace instead of erroring. The
`gone` proof in the test only ever uses the literal ref a real
`workspace create` returned and then closed -- never a fabricated one -- which
is the only case observed to reliably error.

### 6. cmux provides no generic process-exit fact for the reporter's own exit

Before sending the reporter's structured shutdown, the already-acknowledged
long-lived subscription is watching workspace/pane/surface lifecycle names.
After `shutdown-ack` and socket close, a 1500ms predicate wait for a fact
correlated to the reporter's exact workspace, pane, or surface UUID rejects.
Unrelated facts are permitted. This pre-armed, correlated absence window
proves no generic public cmux exit fact was observed for the reporter's own
exit; it does not infer process status from the subscription acknowledgment:

```
$ cmux events --name surface.closed --name pane.closed --name workspace.closed --no-heartbeat
{"...":"...","type":"ack",...}
<no reporter-UUID-correlated frame within 1500ms>
```

This is the empirical proof (not an inference from `cmux capabilities`) that
an inner command's own exit is invisible to the public event stream; only an
explicit `cmux workspace close` produces `surface.closed`/`workspace.closed`,
observed in the very next step of the same test with the exact reattached
UUIDs.

## Consequence for the adapter design

Every fact class the cmux adapter can rely on
(`created`/`present`/`surface_closed`/`gone`/`backend_disconnected`) is now
backed by a real, reproducible probe rather than documentation or source
inspection alone. `doc/spikes/mux-lifecycle.md`'s "Verified probes" table
was updated with a narrow pointer to this spike; its provenance table and
ordering/deadline rules needed no other change -- this spike found no
discrepancy between the earlier design and the live public CLI, only the
one ref-resolution gotcha noted above (already avoided by construction: the
adapter must always use the exact ref/UUID a create/list call actually
returned, never a synthesized one).

## Cleanup

Every disposable workspace/surface created by this spike was closed by the
end of its own test run and verified absent (`cmux workspace list` back to
its pre-spike count) after each of several repeated runs. The reporter's
Unix socket and its temp directory are removed in the test's `finally` block
on every path, including failure paths.
