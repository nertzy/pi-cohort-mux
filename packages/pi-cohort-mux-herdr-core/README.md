# pi-cohort-mux-herdr-core

[![npm](https://img.shields.io/npm/v/pi-cohort-mux-herdr-core)](https://www.npmjs.com/package/pi-cohort-mux-herdr-core)
[![CI](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-cohort-mux-herdr-core)](https://github.com/nertzy/pi-cohort-mux/blob/main/LICENSE)

A [herdr-core](https://github.com/herdrdev/herdr-core) execution adapter for
[pi-cohort](https://github.com/jjuraszek/pi-cohort). herdr-core (`hc`) is the
terminal server behind the Herdr app. Inside one of its terminals, each
`subagent` child runs in a hidden terminal under the caller's (or in a tab of
the caller's space, with `PI_COHORT_MUX_HERDR_CORE_PLACEMENT=tab`).

```sh
pi install npm:pi-cohort
pi install npm:pi-cohort-mux-herdr-core
```

Needs `pi-cohort` 7.6.1 or newer (7.x or 8.x) and Node.js 26 or newer. Outside herdr-core the
adapter reports itself unavailable, so `pi-cohort` falls back to its native
backend. For herdr, the terminal multiplexer, install
[`pi-cohort-mux-herdr`](https://www.npmjs.com/package/pi-cohort-mux-herdr)
instead. See the
[repository README](https://github.com/nertzy/pi-cohort-mux#readme) for
placement and backend selection.
