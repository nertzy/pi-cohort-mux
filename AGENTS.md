# AGENTS.md

Guidance for coding agents working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) too; it owns the ownership and provenance
rules.

## Layout

- `packages/pi-cohort-mux`: mux-agnostic mechanics (event queue, lease,
  environment FIFO and its `sh` bootstrap). It does not import `pi-cohort`.
- `packages/pi-cohort-mux-cmux`: the cmux execution backend that registers with
  the host's `pi-cohort` through its public `pi-cohort/execution-backend` API.
- `test/`: behavior tests, spikes against real tmux, cmux, and Pi, and their
  fixtures. `doc/`: design plans and spike write-ups.

## Commands

```sh
npm ci
npm run check     # lint, then the full test suite
npm run lint:fix  # Biome and markdownlint auto-fixes
```

Tests that need `pi`, `tmux`, or a live cmux session skip with a reason when the
tool is absent. The real-cmux tests mutate the running app, so run them one file
at a time:

```sh
PI_COHORT_MUX_PRODUCTION_CMUX_SMOKE=1 node --test --test-concurrency=1 \
  test/cmux-parity-spike.test.mjs test/production-cmux-smoke.test.mjs
```

## Rules

- Write the failing test first for a behavior change.
- Import only public package entry points; never a dependency's `src/...` path.
- The environment travels only through the owner-only FIFO. Never put an
  environment value in a command line, argv, or a file that outlives the launch.
- Close only cmux surfaces and workspaces this code or test created, by exact
  ref or id. Never close, rename, or focus anything else in the user's session.
- Do not publish packages, push tags, or merge pull requests.
