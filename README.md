# pi-cohort-mux

> Experimental and unreleased companion for [jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort).

This private workspace contains a reusable mux mechanics package
(`pi-cohort-mux`) and a thin [cmux](https://github.com/manaflow-ai/cmux) adapter
(`pi-cohort-mux-cmux`) without duplicating Cohort orchestration. Neither package
is published yet. Pane command text and persistent environment files must never
contain secrets.

## Installation

The adapter supports `pi-cohort` 7.x and peer-depends on it, so it registers
with the host's copy instead of installing its own. Once separately published,
install the adapter entrypoint only;
`pi-cohort-mux-cmux` declares `pi-cohort-mux` as its dependency. Upstream
`pi-cohort` remains the separately activated host and owns backend selection,
orchestration, control, reporting, and detached reload.

For workspace development:

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
