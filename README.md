# pi-cohort-mux

> Experimental and unreleased companion for [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort).

pi-cohort-mux aims to provide visible, multiplexer-backed child execution for
Cohort without duplicating Cohort orchestration. It is not ready to install or
publish.

Planned transport scope is [cmux](https://github.com/manaflow-ai/cmux) and tmux
pane execution. Pane command text and persistent environment files must never
contain secrets.

## Installation

This package supports `pi-cohort` 6.1.0 and later compatible 6.x releases;
6.1.0 is the first release that published the execution-backend SPI and
testkit. Install from the npm registry:

```sh
npm ci
```

## Development

```sh
npm test
```

## Related projects

- [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort) — Cohort
  orchestration.
- [nertzy/pi-interactive-subagents](https://github.com/nertzy/pi-interactive-subagents)
  — donor implementation.
- [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
  — upstream reference.
- [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) — related
  reference.
