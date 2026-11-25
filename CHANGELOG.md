# Changelog

Notable changes to `pi-cohort-mux`, `pi-cohort-mux-cmux`, and
`pi-cohort-mux-herdr` are documented here. The three packages share one
version and release together.

## [Unreleased]

### Fixed

- `pi-cohort-mux-cmux`: the adapter no longer claims a terminal that only
  inherited cmux's `CMUX_*` variables, such as one made by a terminal server
  that was started from a cmux surface. It now detects cmux only when the cmux
  app is an ancestor of the pi process, and says why when it is not
  ([#23](https://github.com/nertzy/pi-cohort-mux/issues/23)).

### Changed

- `pi-cohort-mux-cmux`: tmux inside a cmux surface is no longer detected on
  its own, because the tmux server is not a descendant of cmux. Set
  `PI_COHORT_MUX_CMUX_TRUST_ENV=1` in that session to keep using the adapter.

### Added

- `pi-cohort-mux-cmux`: `PI_COHORT_MUX_CMUX_TRUST_ENV=1` accepts the `CMUX_*`
  variables without the ancestor check.
- `pi-cohort-mux`: `processAncestors()` lists the processes a process descends
  from, for adapters that prove their multiplexer started the terminal.

## [0.2.0] - 2026-11-13

### Changed

- Both adapters support `pi-cohort` 8 as well as 7: their peer range is now
  `^7.0.0 || ^8.0.0`.
- `pi-cohort-mux-cmux`: each child now runs in a background tab in the
  caller's own pane, as herdr's children do, instead of in a helper pane split
  off to the right. Set `PI_COHORT_MUX_CMUX_PLACEMENT=split` to keep the
  helper pane.

### Added

- `pi-cohort-mux-cmux`: `PI_COHORT_MUX_CMUX_PLACEMENT` chooses where children
  go, `tab` (default) or `split`.

### Fixed

- `pi-cohort-mux-cmux`: a child that exits is now reported as exited, not only
  as its tab closing. `pi-cohort` waits for that report before it treats a
  child as gone. Without it, an interrupted cmux child ended with "Process
  termination could not be confirmed" on `pi-cohort` 7.6.5 and later, and a
  child that was set up but never used failed to finish on 8.0 and later. A
  tab you close yourself still reports only the close.

## [0.1.0] - 2026-11-11

### Added

- `pi-cohort-mux-cmux`: inside a cmux terminal, each `pi-cohort` `subagent`
  child runs in a background tab in a helper pane of the caller's workspace.
  The tab closes when the child exits.
- `pi-cohort-mux-herdr`: inside a herdr pane, each child runs in a background
  tab, or in a split with `PI_COHORT_MUX_HERDR_PLACEMENT=split`. herdr removes
  it when the child exits.
- Both adapters register with the host's `pi-cohort` 7.x, mark the calls they
  ran with a `[cmux]` or `[herdr]` badge, pass the child's environment only
  through an owner-only FIFO, and report themselves unavailable outside their
  multiplexer so `pi-cohort`'s `auto` selection falls back to native.
- `pi-cohort-mux`: the shared mechanics behind both adapters (event queue,
  launch lease, environment FIFO and its `sh` bootstrap) and
  `installMuxAdapter`, the one call an adapter's Pi extension makes.
