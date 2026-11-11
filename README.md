# pi-cohort-mux

[![CI](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml)
[![pi-cohort-mux on npm](https://img.shields.io/npm/v/pi-cohort-mux?label=pi-cohort-mux)](https://www.npmjs.com/package/pi-cohort-mux)
[![pi-cohort-mux-cmux on npm](https://img.shields.io/npm/v/pi-cohort-mux-cmux?label=pi-cohort-mux-cmux)](https://www.npmjs.com/package/pi-cohort-mux-cmux)
[![pi-cohort-mux-herdr on npm](https://img.shields.io/npm/v/pi-cohort-mux-herdr?label=pi-cohort-mux-herdr)](https://www.npmjs.com/package/pi-cohort-mux-herdr)
[![License: MIT](https://img.shields.io/npm/l/pi-cohort-mux)](LICENSE)

> Experimental companion for [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort).

This workspace contains a reusable mux mechanics package (`pi-cohort-mux`) and
thin adapters for [cmux](https://github.com/manaflow-ai/cmux)
(`pi-cohort-mux-cmux`) and [herdr](https://github.com/herdrdev/herdr)
(`pi-cohort-mux-herdr`), without duplicating Cohort orchestration. Pane command
text and persistent environment files must never contain secrets.

## Installation

Install `pi-cohort`, then the adapter for each multiplexer you use:

```sh
pi install npm:pi-cohort
pi install npm:pi-cohort-mux-cmux
pi install npm:pi-cohort-mux-herdr
```

Run `/reload` in existing sessions, or start new ones. The adapters need
Node.js 26 or newer.

Each adapter supports `pi-cohort` 7.x and peer-depends on it, so it registers
with the host's copy instead of installing its own. Install an adapter
entrypoint only; each adapter declares `pi-cohort-mux` as its dependency.
Upstream `pi-cohort` remains the separately activated host and owns backend selection,
orchestration, control, reporting, and detached reload.

In Pi's transcript, an adapter adds an accent badge, `[cmux]` or `[herdr]`, to a
`subagent` call that ran on its backend. The call's frame keeps Pi's usual
pending, success, and error colors.

An adapter follows one convention: its package exports `./execution-backend`,
whose default export is a zero-argument backend factory. Its Pi extension is
one call, `installMuxAdapter(pi, import.meta.url, createBackend)` from
`pi-cohort-mux/adapter`, with that same factory. Core finds the adapter's
package from `import.meta.url`, registers the backend with `pi-cohort` (including
the descriptor `pi-cohort` uses to rebuild it in another process), and names
the badge after the backend's `name`. Adapters carry no `pi-cohort`
registration details of their own.

With `pi-cohort`'s default `auto` backend selection, the first registered
adapter that detects its mux wins. Set `pi-cohort`'s `executionBackend` to
`cmux` or `herdr` to choose one, for example when herdr runs inside a cmux
terminal and both detect.

## Placement

Each adapter places children as background tabs by default, so a launch never
changes your layout, and offers a split for children you want beside you.
Choose per adapter with `PI_COHORT_MUX_CMUX_PLACEMENT` and
`PI_COHORT_MUX_HERDR_PLACEMENT`.

The default is only a starting point. Pick the placement that fits the
subagents and tools you run most:

- `tab` suits children you do not watch: CI and deploy watchers, a fan-out of
  reviewers, long chains. They stay out of the way until you look for them.
- `split` suits children you follow as they work: one implementer, or a
  reviewer you read along with.

An adapter reads its variable from the environment pi starts in, and the
setting covers every child that pi process launches. So set it where you
start pi: in your shell profile for a machine-wide choice, in a project's
environment for one repository, or in a launcher when you keep different pi
setups for different kinds of work.

### cmux

Inside a cmux terminal, children open as background tabs in the caller's
workspace:

- `tab` (default): each child becomes a tab in the caller's own pane, wherever
  that tab is at the time. No pane is added, the pane keeps showing the tab it
  showed, and focus stays where it was. When the caller's pane is not the
  focused one, cmux selects the new tab, so the adapter selects the earlier
  tab again and returns focus to the focused pane; focus leaves that pane for
  an instant. Choose `split` if you would rather nothing but the child's own
  tab were touched.
- `split`: the first child splits a helper pane off to the right, and later
  children become tabs in it. cmux removes the pane when its last tab closes.

cmux runs the adapter's launcher as the tab's own process, so nothing is typed
into a shell; the child's cwd, command, and arguments travel in an owner-only
launch file. The launcher closes a child's tab when the child exits, crashed
or not. `pi-cohort` reports a failed child to its parent with the child's
session file.

### herdr

Inside a herdr pane:

- `tab` (default): each child gets its own background tab in the caller's
  workspace, labeled with the agent's name. herdr runs the child directly, with
  no login shell.
- `split`: the first child splits right of the caller's pane and later children
  stack below the newest live one. herdr types the launch command into the
  pane's login shell, so the child inherits that shell's setup.

herdr removes a child's pane, and its tab, when the child exits.

If herdr does not answer a create, the adapter closes the pane herdr made
anyway, identified by herdr's late answer or the launcher's own report, and
then stops offering herdr for 60 seconds so `auto` falls back to native. One
case stays manual: if herdr drops the connection during a `split` create, it
never names the new pane, and no launcher runs in it yet. The adapter does not
close panes by guess, so an idle shell pane can be left beside the caller.

For workspace development:

```sh
npm ci
```

## Development

```sh
npm run check
```

Lint needs Node.js 26 or newer and `actionlint`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Related projects

- [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort) — Cohort
  orchestration.
- [nertzy/pi-interactive-subagents](https://github.com/nertzy/pi-interactive-subagents)
  — donor implementation.
- [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
  — upstream reference.
- [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) — related
  reference.
