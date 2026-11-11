# pi-cohort-mux-cmux

[![npm](https://img.shields.io/npm/v/pi-cohort-mux-cmux)](https://www.npmjs.com/package/pi-cohort-mux-cmux)
[![CI](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-cohort-mux-cmux)](https://github.com/nertzy/pi-cohort-mux/blob/main/LICENSE)

A [cmux](https://github.com/manaflow-ai/cmux) execution adapter for
[pi-cohort](https://github.com/jjuraszek/pi-cohort). Inside a cmux terminal,
each `subagent` child runs in its own background tab in a helper pane of the
caller's workspace, and its tab closes when the child exits.

```sh
pi install npm:pi-cohort
pi install npm:pi-cohort-mux-cmux
```

Needs `pi-cohort` 7.x and Node.js 26 or newer. Outside cmux the adapter
reports itself unavailable, so `pi-cohort` falls back to its native backend.
See the [repository README](https://github.com/nertzy/pi-cohort-mux#readme)
for placement and backend selection.
