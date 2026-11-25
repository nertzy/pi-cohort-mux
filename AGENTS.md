# AGENTS.md

Guidance for coding agents working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) too; it owns the ownership and provenance
rules.

## Layout

- `packages/pi-cohort-mux`: mux-agnostic mechanics (event queue, lease,
  environment FIFO and its `sh` bootstrap). It does not import `pi-cohort`.
- `packages/pi-cohort-mux-cmux`, `packages/pi-cohort-mux-herdr`, and
  `packages/pi-cohort-mux-herdr-core`: the cmux, herdr, and herdr-core
  execution backends, which register with the host's `pi-cohort` through its
  public `pi-cohort/execution-backend` API. herdr is the terminal
  multiplexer; herdr-core (`hc`) is the terminal server behind the Herdr app.
- `test/`: behavior tests, spikes against real tmux, cmux, and Pi, and their
  fixtures. `doc/`: design plans and spike write-ups.

## Commands

```sh
npm ci
npm run check     # lint, then the full test suite
npm run lint:fix  # Biome and markdownlint auto-fixes
```

Lint also needs `actionlint` on `PATH`; [CONTRIBUTING.md](CONTRIBUTING.md)
covers installing it. Tests that need `pi`, `tmux`, or a live cmux session skip with a reason when the
tool is absent. The real-cmux tests mutate the running app, so run them one file
at a time:

```sh
PI_COHORT_MUX_PRODUCTION_CMUX_SMOKE=1 node --test --test-concurrency=1 \
  test/cmux-parity-spike.test.mjs test/production-cmux-smoke.test.mjs
```

The real-herdr tests start their own herdr server under a temporary
`XDG_CONFIG_HOME`, so they never reach the user's herdr:

```sh
PI_COHORT_MUX_PRODUCTION_HERDR_SMOKE=1 node --test --test-concurrency=1 \
  test/production-herdr-smoke.test.mjs
```

The real-herdr-core tests start their own core under a temporary `HC_SESSION`
and temporary XDG directories, so they never reach the user's core:

```sh
PI_COHORT_MUX_PRODUCTION_HERDR_CORE_SMOKE=1 node --test --test-concurrency=1 \
  test/production-herdr-core-smoke.test.mjs
```

## Rules

- Write the failing test first for a behavior change.
- Import only public package entry points; never a dependency's `src/...` path.
- The environment travels only through the owner-only FIFO. Never put an
  environment value in a command line, argv, or a file that outlives the launch.
- Close only cmux surfaces and workspaces, herdr panes, or herdr-core
  terminals that this code or test created, by exact ref or id. Never close, rename, or focus anything else
  in the user's session, except to put back the selected tab and the focused
  pane that a launch displaced. Experiment against an isolated herdr server
  (`XDG_CONFIG_HOME` or `HERDR_SESSION`), never the user's, and never run
  `herdr server stop` against it. The same holds for herdr-core: use a core
  isolated by its own `HC_SESSION` and XDG directories, with every inherited
  `HC_*` variable removed, and never stop or restart the user's core.
- Do not publish packages, push tags, or merge pull requests.
