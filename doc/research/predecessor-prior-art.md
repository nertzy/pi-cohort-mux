# pi-cohort-mux predecessor and prior art

**Research date:** 2026-09-06
**Scope:** public source and GitHub metadata only. This records reusable boundaries and
constraints; it does **not** represent any predecessor as a drop-in execution backend.

## Lineage

`jjuraszek/pi-cohort` is a standalone continuation of
[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents), rather
than merely a renamed install alias. The Cohort history retains the predecessor
commits and then explicitly records the split:

| Cohort commit | Evidence |
| --- | --- |
| [`102f9455eaf7`](https://github.com/jjuraszek/pi-cohort/commit/102f9455eaf7) | “Discover agents/chains flat with explicit precedence; set up fork release” |
| [`1cc337117b2c`](https://github.com/jjuraszek/pi-cohort/commit/1cc337117b2c) | “Switch to standalone semver release model (drop upstream tracking)” |
| [`0e74d3c05398`](https://github.com/jjuraszek/pi-cohort/commit/0e74d3c05398) | “Rename pi-subagents -> pi-cohort” |
| [`4d781741f851`](https://github.com/jjuraszek/pi-cohort/commit/4d781741f851) | completes the Cohort rename across commands, config, and status keys |

The repository itself describes Cohort as an “async subagent delegation” Pi
extension: <https://github.com/jjuraszek/pi-cohort>. Therefore the mux work
extends Cohort's orchestration, rather than importing the predecessor as a
parallel orchestrator.

## Herdr project-pane predecessor

The following merged `nicobailon/pi-subagents` PRs form a useful sequence of
Herdr-pane work. They are **project panes and inspection surfaces**, not a
portable general-purpose child execution backend.

| PR | What the evidence establishes |
| --- | --- |
| [#730](https://github.com/nicobailon/pi-subagents/pull/730) | Reports async state to a Herdr pane, restores status after resume, and bridges `needs_attention`; it is a status bridge. |
| [#735](https://github.com/nicobailon/pi-subagents/pull/735) | Adds `project.open`, `project.status`, and `project.close`, persists bindings in a project `.pi-subagents/project-panes/herdr.json`, and starts Pi in the target project. |
| [#921](https://github.com/nicobailon/pi-subagents/pull/921) | Makes quoted Node invocations valid in Windows PowerShell for both inspector and project-pane commands. |
| [#949](https://github.com/nicobailon/pi-subagents/pull/949) | Publishes a versioned extension-to-extension project-pane lifecycle API with structured results, ownership-aware idle closing, and explicit human trust verification. |
| [#1092](https://github.com/nicobailon/pi-subagents/pull/1092) | Extracts shell-command formatting so pane commands work in POSIX shells, Fish, Nushell, and PowerShell. |
| [#1232](https://github.com/nicobailon/pi-subagents/pull/1232) | Makes unattended inspector/project-pane opens `--no-focus` by default while retaining explicit focus. |
| [#1366](https://github.com/nicobailon/pi-subagents/pull/1366) | Adds pane/view snapshots to status surfaces, pane-safe focus/close controls, and documents authority between run, project pane, and view. |

### What current source actually provides

At inspected predecessor revision
[`45a405a389d56a65895ba6866cdcd41dd1d5683c`](https://github.com/nicobailon/pi-subagents/tree/45a405a389d56a65895ba6866cdcd41dd1d5683c):

* [`src/api/project-panes.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/api/project-panes.ts)
  is a deliberately public re-export boundary. It exports
  `PROJECT_PANES_API_VERSION`, `createProjectPaneManager`, lifecycle functions,
  typed results, and error types; its header tells extensions not to import
  `src/inspectors/herdr/*` directly.
* [`src/inspectors/herdr/project-panes.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/inspectors/herdr/project-panes.ts)
  defines `PROJECT_PANES_API_VERSION = 1`, structured discriminated results,
  a persisted local binding, `human-verification-required` trust, and
  ownership/idle checks. This is a lifecycle adapter around Herdr, not an
  abstract scheduler.
* [`docs/extension-api.md#project-panes`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/docs/extension-api.md#project-panes)
  says the target project pane runs a **separate Pi session**. The parent keeps
  coordination authority but does not own/control that peer's subagents, and
  existing headless runs are not moved into the pane.
* [`src/inspectors/herdr/inspector-runner.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/inspectors/herdr/inspector-runner.ts)
  calls an inspector “a raw dashboard pane, not the child session and not a
  literal attach”; it reads lifecycle artifacts and forwards `steer`/`stop`
  through the existing control inbox. Closing it does not stop the run. This
  is inspection/attachment behavior, distinct from an execution backend.

The predecessor also demonstrates safe extension integration mechanics:

* [`src/api/background-work.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/api/background-work.ts)
  uses `Symbol.for("pi-subagents.background-work.v1")` on `globalThis`, stores
  a `version`, validates the registry shape, and rejects unsupported versions.
* [`src/api/external-runs.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/api/external-runs.ts)
  follows the same pattern with `Symbol.for("pi-subagents.external-runs.v2")`.
* [`src/workflows/workflow-resources.ts`](https://github.com/nicobailon/pi-subagents/blob/45a405a389d56a65895ba6866cdcd41dd1d5683c/src/workflows/workflow-resources.ts)
  adds session-scoped registration and disposal to its versioned global registry.

Those are patterns to reuse: a small versioned public boundary, validation at
that boundary, and a mux-specific adapter behind it. They do not change the
fact that Cohort must remain the owner of dispatch, completion, artifacts, and
orchestration semantics.

## Ordered strategy prior art: vim-dispatch

At inspected [`tpope/vim-dispatch` revision
`a2ff28abdb2d89725192db5b8562977d392a4d3f`](https://github.com/tpope/vim-dispatch/tree/a2ff28abdb2d89725192db5b8562977d392a4d3f):

* [`plugin/dispatch.vim`](https://github.com/tpope/vim-dispatch/blob/a2ff28abdb2d89725192db5b8562977d392a4d3f/plugin/dispatch.vim#L84-L97)
  defines an explicit ordered handler list.
* [`autoload/dispatch.vim`](https://github.com/tpope/vim-dispatch/blob/a2ff28abdb2d89725192db5b8562977d392a4d3f/autoload/dispatch.vim#L408-L421)
  tries that list in order and stops at the first handler that claims the
  request.
* [`autoload/dispatch/tmux.vim`](https://github.com/tpope/vim-dispatch/blob/a2ff28abdb2d89725192db5b8562977d392a4d3f/autoload/dispatch/tmux.vim#L1-L50)
  keeps tmux command construction inside the tmux handler rather than the core
  dispatcher.

Use the same policy boundary without copying editor-specific behavior:
pi-cohort-mux registers an explicit `[cmux, tmux]` list, and Cohort tries it in
that order. Higher-level, more opinionated transports come first: tmux can run
inside cmux, but cmux cannot run inside tmux. A named user/project backend still
overrides `auto`. Core does not hard-code these adapter names or infer priority
from them.

Do not copy vim-dispatch's temp-file completion polling, destructive pane
cleanup, or per-editor opt-out globals. Cohort's session JSONL remains result
evidence, and adapters remain limited to transport and mux lifecycle facts.

## Direct mux descendants

Three public descendants independently confirm demand for visible interactive
children, while differing materially in architecture:

* [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents)
  describes itself as interactive Pi subagents in cmux terminals and documents
  focus-independent child-surface command delivery.
* [`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents) explicitly
  states that it began as a fork of HazAT and supports interactive children in
  Herdr, cmux, tmux, Zellij, and WezTerm alongside headless children.
* [`amosblomqvist/pi-interactive-subagents`](https://github.com/amosblomqvist/pi-interactive-subagents)
  identifies itself as a HazAT fork and attributes the multi-multiplexer
  surface layer and status widget to that origin.

These repositories are useful prior art for terminal placement, visible
sessions, focus preservation, and child-to-parent messaging. They are not
interchangeable implementations and none should be represented as a drop-in
backend for pi-cohort-mux.

### Secret transport rejection

The inspected edxeth revision
[`9fac527abe414fae2750ccd7c3a92898aa266c17`](https://github.com/edxeth/pi-subagents/tree/9fac527abe414fae2750ccd7c3a92898aa266c17)
uses a one-shot but persistent-on-disk environment capsule:

* [`src/launch/env-capsule.ts`](https://github.com/edxeth/pi-subagents/blob/9fac527abe414fae2750ccd7c3a92898aa266c17/src/launch/env-capsule.ts)
  serializes `parentEnv` and overrides as JSON to `capsule.json` in a private
  temp directory (mode `0600`), retaining unconsumed capsules up to one hour.
* [`src/launch/run-child.mjs`](https://github.com/edxeth/pi-subagents/blob/9fac527abe414fae2750ccd7c3a92898aa266c17/src/launch/run-child.mjs)
  reads that file, unlinks it, then spawns the child with the merged environment.

Its permissions and cleanup are thoughtful, but the capsule contains parent
environment values on disk before consumption. Reject this transport for
pi-cohort-mux: the project requirement is **no plaintext secrets on disk**.
Use a companion-first, one-shot in-memory/pipe handoff instead.

## False lead: AzYuJie Herdr fork

[`AzYuJie/pi-subagents-herdr`](https://github.com/AzYuJie/pi-subagents-herdr)
looks relevant from its repository description, but its default branch is an
old upstream snapshot rather than an independent Herdr implementation. The
supplied research checkout's fork `main` is
`935ffe483899bccacc6ba65c8ab670d344ab38c8`; current
`nicobailon/pi-subagents` `upstream/main` is
`45a405a389d56a65895ba6866cdcd41dd1d5683c`; and their merge-base is the fork
snapshot, `935ffe483899bccacc6ba65c8ab670d344ab38c8`.

`git rev-list --left-right --count upstream/main...main` returns `337 0`:
the fork is 337 upstream commits behind and has zero fork-only commits. Any
Herdr code in that fork snapshot was therefore inherited from predecessor
upstream, not independently implemented there. A two-dot diff against today's
upstream is necessarily large because it includes the later upstream changes;
it is not evidence of a fork-specific delta. Treat the repository as an old
upstream snapshot, not a separate implementation source.

## Design takeaways for pi-cohort-mux

1. Preserve **Cohort orchestration ownership**. A mux bridge launches/routs a
   Cohort-owned child; it must not replace Cohort's run bookkeeping, output,
   completion, or acceptance contracts.
2. Copy the predecessor's **public-boundary plus adapter decomposition**:
   versioned narrow API at the integration seam; mux/vendor commands isolated
   behind an adapter; no consumer imports of internal implementation modules.
3. Define and test load order: **companion-first** installation must work, and
   **core-first** loading must discover/attach the bridge later. Versioned
   `Symbol.for`/`globalThis` registries are an appropriate process-local
   rendezvous only after strict version and shape validation.
4. Keep the distinction explicit: Herdr inspectors are attached read/control
   views and predecessor project panes are separate peer Pi sessions. Neither
   establishes a general child-process execution backend.
5. Do not copy edxeth's JSON environment capsule. Any secret handoff must avoid
   plaintext persistence, including failure paths and delayed pane startup.
6. Make `auto` policy explicit through adapter registration order. Register
   higher-level transports first (`cmux`, then `tmux`); do not let alphabetical
   order or core-side adapter knowledge choose the winner.

## Verification record

Commands were run against the supplied local research checkouts and GitHub CLI:

```sh
# predecessor source, remotes, and false-lead ancestry
git -C /tmp/pi-subagents-upstream remote -v
git -C /tmp/pi-subagents-upstream rev-parse origin/main
git -C /tmp/pi-subagents-upstream rev-parse upstream/main
git -C /tmp/pi-subagents-upstream merge-base origin/main upstream/main
git -C /tmp/pi-subagents-upstream rev-list --left-right --count upstream/main...main
git -C /tmp/pi-subagents-upstream diff --stat upstream/main..main

# public API, inspector semantics, and versioned registry source
sed -n '450,525p' /tmp/pi-subagents-upstream/docs/extension-api.md
sed -n '1,125p' /tmp/pi-subagents-upstream/src/api/background-work.ts
sed -n '1,125p' /tmp/pi-subagents-upstream/src/api/external-runs.ts
sed -n '1,145p' /tmp/edxeth-pi-subagents-research/src/launch/env-capsule.ts
sed -n '1,115p' /tmp/edxeth-pi-subagents-research/src/launch/run-child.mjs

# PR/repository/history metadata
gh pr view {730,735,949,921,1092,1232,1366} --repo nicobailon/pi-subagents --json number,title,url,state,body,mergedAt
gh api 'repos/jjuraszek/pi-cohort/commits?per_page=100'
gh repo view jjuraszek/pi-cohort HazAT/pi-interactive-subagents edxeth/pi-subagents amosblomqvist/pi-interactive-subagents AzYuJie/pi-subagents-herdr
```
