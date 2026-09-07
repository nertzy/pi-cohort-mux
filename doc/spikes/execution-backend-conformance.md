# Execution-backend conformance spike

This fixture-only testkit describes the minimum v1 checks a transport adapter
must pass. It deliberately has no production export: the final public subpath
belongs to `pi-cohort`, once its core-owned SPI exists.

`test/fixtures/execution-backend/testkit.mjs` accepts Node's `test` function, a
name, and a backend factory. It registers concrete tests and returns their
count, so a consumer can import it from a separate Node test file rather than
copying the scenarios. Every case receives a fresh request object graph, and an
external regression registers a mutating backend before an independent backend
to prove no request state crosses suites. The companion spike runs a deliberately empty backend
in a subprocess and requires a nonzero exit; a no-op kit cannot appear green.

The deterministic fixture proves surface transport only:

- v1 detection/version shape and rejection of a version mismatch;
- observer-before-command launch at the exact core-resolved `cwd`, with an
  immediate exit delivered after the lease exists;
- JSON-safe, handle-keyed reattachment/close metadata with a nonempty actionable
  display hint, no core run, child, attempt, task, result, output, or secret
  value, and no live function anywhere in the original handle graph;
- an owner-only pipe path as the only permitted launch handoff for a secret;
  a separate deliberately leaky backend receives the sentinel only through the
  test harness and is required to fail if it writes it to args, environment,
  handle/display, events, or persisted state;
- mux-only facts and stable surface identity, including deterministic advisory
  coalescing only with a same-type advisory tail, one explicit overflow marker,
  suspension, and a reconciliation snapshot equivalent to an overflowed terminal
  fact before resumption. The core drains the queued marker before reconciling;
  the next live fact proves observation resumed without redelivering stale
  backlog;
- idempotent release/iterator return without closing the retained surface;
- snapshot-before-live reattachment and distinct `present`, `gone`, and
  `unknown` outcomes;
- handle-keyed idempotent close after a restart, and ordinary non-Git `cwd`
  operation with no worktree metadata; and
- a one-shot secret-pipe path rather than a secret in launch/persisted surface
  data.

One logical child host gets one launched surface. Model attempts remain owned
by the core host and are not adapter behavior.

## Explicit exclusions

This is not coverage for session-log result delivery, `BLOCKED:` classification,
interruption semantics, worktree creation or cleanup, conversational messaging,
live child resume, `taken_over`, completion receipts, profiles, or a real mux
adapter. Those are core or product contracts and must be tested at their owning
boundary.
