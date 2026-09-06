# pi-cohort mux execution backends: context transfer

## Purpose

Create `nertzy/pi-cohort-mux`, a companion package that runs `pi-cohort` children in visible terminal-multiplexer surfaces without duplicating Cohort's orchestration logic. The new repository will extract the reusable transport behavior from `nertzy/pi-interactive-subagents`, prove a public execution-backend contract for `jjuraszek/pi-cohort`, and become the proposed upstream home for mux adapters after the design is validated.

This document transfers the current discovery and decisions into the new repository. It is not an assertion that the backend API has already been accepted upstream.

## Current status

- Design discovery is complete enough to start the new repository.
- No execution-backend implementation has been added to `pi-cohort`.
- No `pi-cohort-mux` repository or package has been created yet.
- The donor bridge remains the active local integration.
- The current `pi-cohort` design worktree is based on `origin/main` at `225ab55` (`5.3.1`) on branch `mux-execution-backends`.
- A context draft with detailed file and line references exists at `doc/specs/2026-09-06-mux-execution-backends.md` in that worktree.

## Repositories and intended ownership

### `jjuraszek/pi-cohort`

Owns orchestration and the public execution-backend SPI:

- request validation and effective agent resolution;
- single, parallel, chain, and dynamic-fanout semantics;
- clarification;
- worktree setup and cleanup;
- acceptance and reviewer gates;
- structured output and output-file behavior;
- model fallback policy;
- foreground and durable async coordination;
- run/session identity, persisted status, and result aggregation;
- backend selection and configuration.

Native child-process execution remains built in and backward compatible.

### `nertzy/pi-cohort-mux`

Begins as Grant's prototype companion package and owns mux transport:

- mux availability and capability detection;
- creating and identifying panes/surfaces;
- launching children without exposing secrets;
- observing lifecycle and returning portable events/results;
- interrupting children where supported;
- closing successful panes and retaining diagnostic panes;
- cmux and tmux adapters in the first releasable scope;
- a documented Herdr adapter design, with implementation deferred until its API is verified.

After the contract and conformance suite are proven, propose moving the repository/package alongside upstream `pi-cohort`. Do not put it in HazAT's GitHub fork network.

### `nertzy/pi-interactive-subagents`

Treat this as donor and migration code, not the permanent package:

- preserve attribution and applicable license notices when extracting code;
- preserve useful commit provenance where practical;
- keep the bridge working until the companion reaches migration parity;
- archive the fork only after cutover and after separating any standalone behavior that still has users.

## Decisions already made

1. **Packaging:** `pi-cohort` exposes a small public SPI; `pi-cohort-mux` is a separately installed companion package.
2. **Prototype ownership:** create a new `nertzy/pi-cohort-mux` repository now. Do not rename the existing GitHub fork.
3. **Upstream path:** prototype under `nertzy`, then propose transfer after the integration and conformance tests prove the boundary.
4. **Installation:** users install both packages. The companion should register automatically; ordinary configuration must not contain JavaScript module paths or adapter imports.
5. **Default selection:** when the companion is installed and a supported active mux is detected, use it automatically. Fall back to native execution when no mux is available.
6. **Override:** provide one simple user/project configuration value that forces `native` or a named backend. An explicitly selected unavailable backend fails loudly.
7. **Initial adapters:** implement cmux and tmux. Document how Herdr maps to the SPI, but defer its implementation until its public lifecycle/socket contract is verified. Zellij and WezTerm are later candidates despite existing donor support.
8. **Mode parity:** support pane-backed foreground and async children through the same backend contract. Keep Cohort's detached async runner as the durable coordinator.
9. **Pane retention:** close a pane only after successful result delivery. Retain failed, interrupted, paused, and attention-needed panes for inspection and explicit cleanup.
10. **SPI scope:** require only launch, lifecycle events, result capture, interruption, and cleanup. Carry opaque pane/session metadata for observability and adapter-owned controls. Screen scraping, focusing, and arbitrary interactive input are not core Cohort contracts in version one.
11. **Repository timing:** the prototype repository can be created and exercised against a development SPI immediately. A stable adapter release and normal installation depend on the SPI landing in a released `pi-cohort`; repository creation does not.
12. **Foreground/async workflow issue:** the current local bridge sometimes reroutes an explicitly foreground Cohort dispatch into a detached cmux pane. Do not let that block this project now, but record preservation of caller-requested execution semantics as a conformance requirement.

## Target architecture

Cohort compiles each logical child into a backend-neutral execution request. That request contains the already-resolved command, arguments, working directory, run/session identity, artifact locations, lifecycle hooks, and cancellation signals needed to execute one child. It must preserve the existing Pi argument and intercom environment contracts.

A registered backend executes that compiled request and returns a backend-neutral lifecycle/result stream. Cohort remains responsible for interpreting Pi JSONL events, model fallback, acceptance, aggregation, persistence, and orchestration. An adapter must not implement chains, fanout, personas, worktrees, output contracts, or acceptance.

The native backend wraps today's direct `child_process.spawn` behavior. The mux companion registers cmux and tmux backends. The same child contract is used from foreground execution and from the child-execution portion of the detached async runner; the companion does not replace the runner itself.

Adapters expose an availability result and a small capability set. Version-one required capabilities are deliberately narrow. Backend-specific metadata may identify a pane, socket, session, or runtime, but Cohort treats it as opaque data except for display and persistence.

## Important pi-cohort seams

Start core work at these boundaries:

- `src/runs/shared/pi-spawn.ts` — portable Pi command resolution;
- `src/runs/shared/pi-args.ts` — Pi arguments, session flags, nested routing, and intercom environment;
- `src/runs/foreground/execution.ts` — foreground `spawn()` and JSONL lifecycle;
- `src/runs/background/subagent-runner.ts` — duplicate async child streaming boundary;
- `src/runs/background/async-execution.ts` — durable runner launch; keep this independent from mux panes;
- `src/runs/foreground/subagent-executor.ts` — orchestration entry point; thread selection through it without adding mux logic;
- `src/shared/types.ts` — `RunSyncOptions`, results, status, and `ExtensionConfig`;
- `src/extension/config.ts` and `src/extension/index.ts` — configuration and runtime initialization.

The narrowest useful refactor is to place a backend-neutral child executor below orchestration and above raw process creation, then use it from both foreground execution and the detached runner's child path.

## Donor code map

Use the fork as behavioral evidence rather than copying its architecture wholesale:

- `pi-extension/cohort-bridge.ts`
  - current Cohort tool-call interception;
  - routing and native fallback;
  - launch/session/artifact lifecycle;
  - model fallback and result steering;
  - duplicated orchestration that must not move into the companion.
- `pi-extension/subagents/cmux.ts`
  - cmux, tmux, Zellij, and WezTerm detection;
  - surface creation and reuse;
  - command delivery and escaping;
  - lifecycle polling and cleanup;
  - currently monolithic and switch-based; split by adapter rather than retaining the closed union.
- `pi-extension/subagents/model-failure.ts`
  - failure classification useful as evidence, but model fallback belongs to Cohort.
- `pi-extension/subagents/subagent-done.ts`
  - structured terminal sidecars and autonomous-child completion.
- `pi-extension/subagents/output.ts` and `persona-resolve.ts`
  - compatibility copies that demonstrate missing public boundaries; do not move them into the mux package.
- bridge-specific tests
  - preserve lifecycle, cleanup-order, launch-safety, routing, and failure cases as candidate conformance tests.

The existing `cohort-bridge.ts` is roughly 2,500 Grant-authored lines, and the fork has roughly 6,000 added lines across its complete delta. This is substantial original adapter and compatibility work, but it currently depends on private Cohort modules and duplicates Cohort semantics.

## Registration and installation constraint

Pi packages can contain multiple extensions and extensions share the Pi process, but Pi's documented extension API does not provide a first-class cross-package service registry. Automatic adapter registration therefore needs an explicit, versioned design rather than an assumed import trick.

The first architecture spike should compare:

1. a small process-global registry keyed by a versioned `Symbol.for(...)` contract, tolerant of either extension load order;
2. Cohort discovering an installed companion through a stable package/runtime location;
3. a thin companion extension that calls a deliberately exported Cohort registration API.

Reject any option that depends on private `src/...` imports, hard-coded installation paths, or a required module path in ordinary user configuration. Prove reload behavior, duplicate registration, incompatible SPI versions, and both extension load orders before selecting the mechanism.

## Security requirements

- Never render resolved secrets into pane command text, generated scripts, persisted environment files, logs, or terminal metadata.
- Do not hard-code local Pi preset names or infer retention mode from a directory basename.
- Preserve the exact already-resolved launcher/runtime semantics without asking an adapter to reconstruct user policy.
- Use a one-shot, mode-`0600` named pipe or an equivalently ephemeral mechanism when secret-bearing launch state must cross into a pane process.
- Remove the handoff on success and every failure path.
- Treat structured process/session state—not rendered terminal screen contents—as the lifecycle source of truth.
- Fail loudly when a requested secure launch contract cannot be honored.

## Lifecycle requirements

A conforming adapter must demonstrate:

- child session and artifact identity is stable and returned to Cohort;
- startup failures are distinguishable from child failures;
- lifecycle events cannot be confused with terminal decoration or prompts;
- interrupt is soft and leaves the run in an explicit paused/interrupted state;
- cleanup happens after successful delivery, not merely after child exit;
- failed launch, send, observation, finalization, and fallback paths clean temporary state predictably;
- retained diagnostic panes are reported to the user with an actionable handle;
- parallel launches have deterministic result ordering and bounded resource usage;
- nested Cohort runs preserve depth and intercom routing;
- a parent exit does not destroy durable async coordination;
- unavailable auto-selected adapters fall back to native, while an unavailable explicit selection fails.

## First-release scope

### Included

- public, versioned Cohort backend SPI;
- native backend expressed through the same contract;
- backend registry and auto-selection;
- simple user/project override;
- cmux adapter;
- tmux adapter;
- foreground and durable-async parity;
- backend contract/conformance test kit;
- secret-safe launch handoff;
- migration documentation from `cohort-bridge.ts`;
- Herdr mapping/design note based on verified public APIs.

### Deferred

- Herdr adapter implementation;
- Zellij and WezTerm adapters;
- screen-read/scraping APIs;
- arbitrary input injection;
- focus/takeover as a Cohort-level contract;
- mux-owned chain, fanout, acceptance, output, persona, or worktree behavior;
- replacing Cohort's detached async coordinator;
- archiving the donor fork before migration parity.

## Proposed implementation sequence

### Phase 1: establish the prototype repository

- Create `nertzy/pi-cohort-mux` as an independent repository with its own package identity and license.
- Record donor provenance and attribution before moving code.
- Add a compatibility matrix covering Pi, `pi-cohort`, Node, cmux, and tmux versions.
- Add test fixtures for a minimal fake backend and fake mux CLI.
- Keep the repository unreleased while the SPI is provisional.

### Phase 2: design and upstream the core SPI

- Extract one backend-neutral child-execution contract in `pi-cohort`.
- Wrap current native foreground execution without changing behavior.
- Reuse the contract inside `subagent-runner.ts` while leaving the detached runner intact.
- Add registry, selection, config, version-negotiation, and failure behavior.
- Publish a conformance harness that an external adapter can consume.
- Open an upstream PR focused on the seam and native behavior, not mux implementation.

### Phase 3: prove registration and cmux

- Implement automatic companion registration using the proven load-order-safe mechanism.
- Extract and refactor cmux transport behavior from the donor.
- Preserve secure launcher handoff, structured completion, interruption, metadata, and cleanup.
- Run the same logical conformance scenarios against native and cmux backends.

### Phase 4: add tmux and mode parity

- Implement tmux behind the same interface without adding backend-specific branches to Cohort.
- Exercise foreground, async, parallel, nested, worktree, cancellation, output, acceptance, and model-fallback flows.
- Verify auto-selection and explicit overrides in nested-mux environments.

### Phase 5: migration and upstream proposal

- Replace the local bridge installation with normal installation of both packages.
- Compare behavior against the bridge before removing it.
- Document retained-pane recovery and explicit cleanup.
- Draft the transfer/upstream proposal with compatibility and conformance evidence.
- Only then deprecate the bridge and plan archival of the donor fork.

## Validation strategy

### Core contract

- Native regression tests for current foreground and async behavior.
- Contract tests for launch, event flow, result capture, interruption, cleanup, metadata, unavailable backends, and incompatible versions.
- Tests proving `auto`, `native`, and named-backend selection.
- Tests for both extension load orders, duplicate registration, and reload.
- Windows and no-mux CI retain native behavior.

### Adapter package

- Unit tests use fake executables and sockets; they assert exact argument boundaries without printing secret-bearing environment values.
- Lifecycle tests assert cleanup ordering for launch, send, poll, interrupt, result-delivery, and fallback failures.
- Optional real-mux smoke tests exercise create, launch, observe, interrupt, and close.
- Skipped real-mux tests must report discovered example counts and the reason for skipping; zero exercised cases cannot be reported as a pass.
- Foreground and async suites run the same behavioral matrix where their persistence expectations differ only at the Cohort coordinator layer.

### Migration parity

At minimum, verify:

- single and parallel children;
- sequential chains and dynamic fanout through Cohort orchestration;
- worktree-isolated tasks;
- structured and file output;
- acceptance/reviewer gates;
- model fallback;
- nested intercom identities;
- status, interruption, resume, and retained-pane metadata;
- successful close-after-delivery and failure retention;
- native fallback outside supported muxes.

## Herdr research brief

Do not implement from marketing claims. Verify the released Herdr CLI/socket API and version-specific behavior for:

- runtime and active-session detection;
- pane/session creation;
- launching a command without exposing its environment;
- structured working/blocked/idle events;
- wait semantics and process exit/result retrieval;
- interrupt, reconnect, and cleanup;
- whether lifecycle state remains valid across client disconnects and server restart;
- stable handles suitable for Cohort status and recovery;
- how nested agent launches are represented.

Map verified operations onto the same required SPI. Record richer Herdr-only capabilities as adapter metadata or future optional capabilities rather than expanding version one prematurely.

## Known risks

1. **No native cross-extension registry:** automatic installation may require a carefully versioned process-global protocol.
2. **Interactive versus machine-readable execution:** Cohort currently consumes Pi JSONL; visible interactive panes must provide equivalent structured completion without scraping rendered output.
3. **Secret propagation:** naive pane commands expose inherited credentials in logs and persisted metadata.
4. **Foreground/async drift:** visible panes must not silently change completion, cancellation, or durability semantics.
5. **Fork drift:** the bridge's copied persona/output/runtime logic can diverge from current Cohort while migration is in progress.
6. **Nested muxes:** multiple environment markers can be active; selection needs deterministic precedence and a simple explicit override.
7. **Release compatibility:** the adapter must declare and test compatible ranges for the Cohort SPI, Pi runtime, Node, and supported mux CLIs.
8. **Pane leakage:** retention is intentional on abnormal outcomes, so status must expose actionable handles and cleanup instructions.

## Open design questions for the new repository

Resolve these through code/API inspection before implementation:

- What exact registration mechanism works across separately installed Pi packages and both extension load orders?
- What is the smallest compiled launch request that supports native and pane execution without leaking secrets?
- Should Pi JSONL be captured through a private file/pipe while the pane runs the interactive TUI, or should the child use a dedicated machine-readable mode with a separately visible pane experience?
- How are retained panes enumerated and cleaned through the existing Cohort status/control surface without adding mux-specific management actions?
- What deterministic priority applies when cmux and tmux are both active?
- Which lifecycle metadata must persist in Cohort's async status files to reconnect after a parent restart?
- Which portions of donor history can be preserved cleanly without carrying the original package's obsolete architecture?

## First actions in the new repository

1. Create the repository and package skeleton without publishing it.
2. Copy this document into `doc/plans/` and keep it as the project handoff.
3. Add donor repository and upstream Cohort references to contributor documentation.
4. Inventory donor files and commits into three buckets: transport to extract, tests to port, compatibility code to discard.
5. Spike automatic registration with a fake backend before moving cmux code.
6. Write the backend conformance scenarios as package-agnostic tests.
7. Draft the minimal `pi-cohort` SPI change from those tests.
8. Open the upstream design discussion before presenting a code-heavy core PR.

## Do not carry forward

- tool-call interception as the permanent integration;
- dynamic imports from installed `pi-cohort/src/...` files;
- copied persona resolution or output behavior;
- mux implementations of chains, fanout, worktrees, acceptance, or fallback;
- a closed `cmux | tmux | zellij | wezterm` type in core;
- hard-coded local launcher/preset names;
- terminal screen scraping as completion evidence;
- mandatory mux dependencies in `pi-cohort`;
- silent fallback after an explicitly requested backend fails.
