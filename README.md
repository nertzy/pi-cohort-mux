# pi-cohort-mux

> Experimental and unreleased companion for [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort).

pi-cohort-mux aims to provide visible, multiplexer-backed child execution for
Cohort without duplicating Cohort orchestration. It is not ready to install or
publish.

Planned transport scope is [cmux](https://github.com/manaflow-ai/cmux) and tmux
pane execution. Pane command text and persistent environment files must never
contain secrets.

## Installation

This package depends on a pinned Git commit of the `nertzy/pi-cohort` fork via
HTTPS. No GitHub SSH key is required. Install with:

```sh
npm ci --allow-git root
```

`--allow-git root` is required because npm 12+ defaults `--allow-git` to `none`;
the `root` scope allows only the git dependency declared in this project's own
`package.json`, not transitive ones.

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
