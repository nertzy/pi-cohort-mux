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

Development needs Node.js 26 or newer and
[actionlint](https://github.com/rhysd/actionlint) 1.7.12, which `npm run lint`
calls and `npm ci` does not install. On macOS, install it with Homebrew:

```sh
brew install actionlint
```

For other platforms, follow actionlint's
[installation instructions](https://github.com/rhysd/actionlint/blob/v1.7.12/docs/install.md).
CI downloads the same release from the upstream project.

Write tests first for behavior changes, then run lint and the tests:

```sh
npm ci
npm run check
```

Lint treats Biome warnings as errors, so fix or suppress every warning.
`npm run lint:fix` applies Biome and markdownlint fixes.

The package is private. Do not publish it.
