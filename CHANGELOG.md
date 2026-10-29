# Changelog

Notable changes to `pi-cohort-mux`, `pi-cohort-mux-cmux`, and
`pi-cohort-mux-herdr` are documented here. The three packages share one
version and release together.

## [Unreleased]

## [0.1.0] - 2026-10-28

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
