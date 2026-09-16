# Contributing

## Ownership boundary

[jjuraszek/pi-cohort](https://github.com/jjuraszek/pi-cohort) owns Cohort
orchestration and its SPI. This repository owns only mux transport; do not treat
any current integration as an accepted SPI.

## Provenance and API discipline

Preserve donor attribution and provenance when adapting code from
[nertzy/pi-interactive-subagents](https://github.com/nertzy/pi-interactive-subagents),
its upstream reference
[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents),
or related work such as
[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents). Record
material adaptations clearly in the relevant code or commit.

Do not import private `src/...` paths from dependencies. The public
`@earendil-works` Pi API is the source of truth.

## Changes

Write tests first for behavior changes, then run:

```sh
npm test
```

The package is private. Do not publish it.
