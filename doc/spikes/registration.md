# Companion registration spike

This executable spike lives entirely under `test/fixtures/registration/`; it is
not a production registry or mux adapter. Run `npm test` to exercise both the
in-process cases and a Pi 0.85.0 RPC subprocess probe.

## Decision

A future companion imports a deliberately public `pi-cohort` registration API.
That API owns a versioned hub stored on `globalThis` under the stable
`Symbol.for("pi-cohort.registration-spike.backends.v1")` key. The hub contains a
name-keyed `Map`; enumeration sorts backend names. Registration rejects a name
that is already registered and returns an identity-safe disposer: it removes an
entry only when that exact registration is still current.

The fake core resolves `listBackends()` inside its command handler, after Pi has
called extension factories, rather than taking a list while the core factory is
running. The companion can therefore load before or after the core. The smoke
probe invokes that command only after Pi's sequential factory loading has
completed, and asserts a non-empty `fake-backend` result in both CLI
`--extension` orders.

## Alternatives considered

- **Global hub alone:** sharing a symbol works mechanically, but provides no
  intentional import contract for companions and leaves validation, protocol
  ownership, and reload semantics implicit.
- **Package discovery:** scanning installed packages or configured paths couples
  discovery to Pi installation layout and configuration, misses explicitly
  loaded companions, and has no useful reload ownership model.
- **Public core API plus global hub (chosen):** a public API makes the supported
  registration boundary explicit while the global symbol lets independent
  physical copies of that public module share one process-local hub. It needs no
  package scanning, hard-coded paths, private `src/...` imports, or configured
  module paths.

## Load and reload assumptions

Pi 0.85.0 loads explicit `--extension` paths in CLI order and awaits each
factory before continuing (verified against its installed `docs/extensions.md`
and `dist/core/extensions/loader.js`). Factories can register a backend, and a
core command can resolve the registry later at execution time. A Pi reload is
modeled as the old extension's disposer running before a replacement registers;
a stale old disposer cannot delete the replacement. A duplicate active backend
name and an incompatible hub protocol version throw immediately rather than
silently selecting one.

## Remaining risks

This does not yet prove the final `pi-cohort` package export surface, actual mux
backend interface validation, or Pi's real interactive `/reload` teardown
ordering. The subprocess smoke test uses an explicit fixture API and fake
extensions, so it proves Pi factory/load-order behavior without making a model
call; production code must retain that public import boundary when introduced.
