# Donor migration inventory

This is an inventory, not a source transfer. It was verified against
`/Users/grant/.pi/agent.common/git/github.com/nertzy/pi-interactive-subagents`
at `5faa6db`; all listed paths exist at that revision and all abbreviated commits
below resolve to commits. The donor's `package.json` identifies version 3.7.2 and
an MIT license.

## Transport to extract

Extract behavior and reimplement it behind this package's transport boundary; do
not transplant the donor's TypeScript or its pi extension APIs.

| Donor files | Behavior worth extracting | Verified history |
| --- | --- | --- |
| `pi-extension/subagents/cmux.ts` | Backend detection, shell escaping, create/send/read/close surface primitives, and exit-sidecar polling. Keep the new interface runtime-neutral. | `bb66567` — *feat: add WezTerm as a supported multiplexer backend*; `6e336fe` — *fix: preserve mux focus during subagent launch (#36)*; `a3236a9` — *fix(tmux): split subagent pane in parent's window, not the focused one*; `edde36e` — *fix(zellij): capture pane ID from new-pane stdout and rename pane instead of tab*. |
| `pi-extension/subagents/cmux.ts` | Preserve the source's focus and pane-placement edge cases as behavioral requirements for cmux, tmux, zellij, and WezTerm adapters. | The four commits above: Marcos A. Núñez authored the WezTerm addition; warren authored the focus fix; Daniel Griesser authored the tmux and zellij fixes. |
| `pi-extension/subagents/activity.ts`, `pi-extension/subagents/status.ts` | Optional portable activity/status state only if the target needs visible lifecycle observation; exclude donor widget rendering. | `b7c1a53` — *feat(subagents): add context loading progress indicators* (Daniel Griesser) changes `pi-extension/subagents/index.ts`, documenting that progress belongs at the donor extension boundary rather than in the transport adapter. |

## Tests to port

Port scenarios, assertions, and fixtures into target-owned tests. Adapt imports and
harnesses to the new public API; these donor tests are not directly executable in
the target runtime.

| Donor tests | Scenarios to retain | Verified history |
| --- | --- | --- |
| `test/test.ts` | Pure mux contracts: backend selection, escaping, surface creation/sending, and exit interpretation. | `bb66567`, `6e336fe` both modify this file; use them to retain WezTerm and focus-preservation regression coverage. |
| `test/integration/mux-surface.test.ts`, `test/integration/subagent-lifecycle.test.ts`, `test/integration/harness.ts` | Real multiplexer launch/lifecycle coverage, with target-owned setup and cleanup. | `6e336fe` modifies the harness and mux-surface test. |
| `test/cohort-bridge-pane-launch.test.ts`, `test/cohort-bridge-routing.test.ts` | Adapt only transport-facing launch, routing, command construction, and terminal-failure reporting scenarios. | `12d2abf` — *Run subagents in mux panes by default*; `5bb65cf` — *Run secure subagents in mux panes* (both Grant Hutchins). |
| `test/cohort-bridge-status.test.ts`, `test/output.test.ts` | Retain only target-owned status/output artifact contracts, if exposed by the new package. | `e7f6be2` — *Rename jacek-bridge to cohort-bridge and support per-call output files* (Grant Hutchins) adds the output test. |
| `test/cohort-bridge-acceptance.test.ts`, `test/cohort-bridge-chain.test.ts`, `test/cohort-bridge-worktree.test.ts` | Do **not** port pi-cohort acceptance, chain, or worktree orchestration as transport tests; use them only to identify integration seams that the caller must continue to own. | `12d2abf` adds all three; `5bb65cf` replaces/adds several of these suite files. |

## Compatibility/orchestration code to discard

These files bind the donor to pi-subagents/pi-cohort orchestration or donor UI.
They are unsafe as direct migration input; retain no implementation from them.

| Donor files | Why discard | Verified history |
| --- | --- | --- |
| `pi-extension/cohort-bridge.ts` (and removed predecessor `pi-extension/jacek-bridge.ts`) | Intercepts native `subagent` calls, dynamically loads pi-cohort, performs chain/parallel/worktree orchestration, persona handling, result delivery, and acceptance review. The target is transport only. | `de2d619` — *Add jacek-bridge: intercept pi-subagents tool calls and route to cmux panes*; `e7f6be2` renames it to cohort-bridge; `12d2abf` makes pane execution default; `5bb65cf` adds secure-subagent behavior. All four are by Grant Hutchins. |
| `pi-extension/subagents/index.ts`, `pi-extension/subagents/persona-resolve.ts`, `pi-extension/subagents/output.ts`, `pi-extension/subagents/model-failure.ts`, `pi-extension/subagents/subagent-done.ts`, `pi-extension/subagents/session.ts` | Donor extension registration, pi-subagents personas/session protocol, output semantics, model fallback, and completion controls are caller/runtime concerns, not mux transport. | `b7c1a53` changes donor extension progress; `e7f6be2`, `12d2abf`, and `5bb65cf` modify this compatibility surface; `b4b0287` changes `session.ts`. |
| `pi-extension/setup-bridge.sh`, `pi-extension/subagents/plugin/`, `README.md`, `NOTES.md`, `config.json.example` | Installation, Claude plugin, and operational documentation are specific to the donor package and should not define the new package API. | `e7f6be2` and `5bb65cf` modify setup/docs; `bb66567` and `6e336fe` also update donor README material. |

### Runtime and provenance notes

- The donor imports `@mariozechner/pi-coding-agent` in
  `pi-extension/cohort-bridge.ts`, `pi-extension/subagents/index.ts`, and
  `pi-extension/subagents/subagent-done.ts`; it imports `@mariozechner/pi-tui`
  in `index.ts`, `subagent-done.ts`, and `test/test.ts`. Those
  `@mariozechner/*` compatibility copies are **unsafe for direct migration**
  into the `@earendil-works/*` runtime: reimplement against the target's
  supported contracts rather than preserving donor types, UI components, module
  loading, or extension hooks.
- Git evidence attributes the adapter/orchestration additions (`de2d619`,
  `e7f6be2`, `12d2abf`, `5bb65cf`) to Grant Hutchins. Transport history also
  evidences contributions from Daniel Griesser, Marcos A. Núñez, warren, Tao
  Yang, Helmut Januschka, Jihun Kim, PrayagS, interpreteragent, shiina, and
  Adnan Basar. This is code-history attribution, not a replacement for license
  obligations or a claim of copyright ownership.
- The donor repository's `LICENSE` says MIT, `Copyright (c) 2026 HazAT`, and
  its package metadata says `author: HazAT`. If any substantial donor expression
  is copied later, preserve the required MIT notice and perform a legal/provenance
  review. This document recommends behavioral reimplementation and copies no
  donor code.
