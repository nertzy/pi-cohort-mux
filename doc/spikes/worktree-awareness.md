# Worktree-aware surface launch spike

This fixture proves the location boundary for an execution backend. Cohort
creates and cleans its Git worktrees under its existing policy; the fixture and
future backend neither create nor remove them.

## Contract exercised

`cwd` is the sole required location input and is authoritative. The parent
creates a disposable repository, then creates two linked worktrees on separate
branches. A real disposable tmux server respawns the same reporter in each
exact `cwd`. The reporter sends a JSON observation over an owner-only Unix
socket; the test never derives behavior from pane text.

Each linked-worktree reporter observes its own physical working directory,
Git top-level, branch, detached state, and marker file. Neither sees the other
worktree's marker. Independently of tmux availability, the parent directly
launches the same reporter with absolute `process.execPath` in a plain non-Git
directory, no metadata, and an empty `PATH`. It reports its exact cwd, no
markers, no Git observation, and no metadata. That always-running proof shows
that Git is not invoked when `.git` is absent; the tmux-gated case covers only
the linked worktrees.

Optional metadata is echoed only as display/persistence context. One reporter
receives a deliberately incorrect `repositoryRoot`; its observed cwd remains
its supplied linked-worktree cwd. Metadata therefore cannot replace or rewrite
`cwd`.

## Lifecycle and cleanup

The tmux test uses window-scoped `remain-on-exit`, a native `pane-died` hook,
and a pre-armed `tmux wait-for` channel per reporter. The structured result
socket and native process wait both have bounded deadlines. There is no timer
polling, sleeping, terminal capture, or pane-text parsing.

After all reporters exit cleanly, the parent kills the disposable tmux server
and proves both linked-worktree paths still exist and remain listed by Git.
Only then does the parent remove the disposable directory. That ordering proves
that closing the surface is not backend-managed worktree cleanup.

This is a fixture-only compatibility proof, not a production adapter, public
API, profile, or worktree-hook contract.
