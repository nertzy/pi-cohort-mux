# pi-cohort-mux

[![npm](https://img.shields.io/npm/v/pi-cohort-mux)](https://www.npmjs.com/package/pi-cohort-mux)
[![CI](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nertzy/pi-cohort-mux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-cohort-mux)](https://github.com/nertzy/pi-cohort-mux/blob/main/LICENSE)

Mux-agnostic mechanics shared by the
[pi-cohort](https://github.com/jjuraszek/pi-cohort) multiplexer adapters: the
event queue, the launch lease, and the owner-only environment FIFO with its
`sh` bootstrap. It does not import `pi-cohort`.

Install an adapter instead, which depends on this package:
[`pi-cohort-mux-cmux`](https://www.npmjs.com/package/pi-cohort-mux-cmux) or
[`pi-cohort-mux-herdr`](https://www.npmjs.com/package/pi-cohort-mux-herdr).
See the [repository README](https://github.com/nertzy/pi-cohort-mux#readme)
for the adapter convention.
