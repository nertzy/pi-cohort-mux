import { execFile as execFileCallback } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Resolve once tmux reports `pane` dead with its exit recorded: an exit status
 * or a signal. tmux 3.4 sets pane_dead on pty EOF, before it reaps the child, so
 * pane_dead alone can read "1" while the status is still empty (the same race
 * that can cost a pane its pane-died hook). Requires remain-on-exit, which keeps
 * a dead pane listed. Stops quietly when `signal` aborts. `run` is injectable
 * for tests.
 */
export async function pollPaneDead(server, pane, { signal, interval = 100, run = execFile } = {}) {
  while (!signal?.aborted) {
    const { stdout } = await run(
      "tmux",
      ["-L", server, "-f", "/dev/null", "display-message", "-p", "-t", pane, "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"],
      { timeout: 5_000 },
    );
    const [dead, status, deathSignal] = stdout.trim().split("|");
    if (dead === "1" && (status || deathSignal)) return;
    await sleep(interval, undefined, { signal }).catch(() => {});
  }
}

/**
 * Wait for a pane's death through its pane-died hook (`hooked`, the promise of
 * the `wait-for` child `waiter`) or a pane_dead poll, whichever reports first;
 * the poll resolves only once the exit status or signal is recorded.
 * tmux 3.4 sometimes never runs pane-died for a pane, so the hook alone can
 * stall until an unrelated pane dies. The hook's deadline still bounds the wait.
 */
export async function firstPaneDeath({ hooked, waiter, server, pane }) {
  const controller = new AbortController();
  const polled = pollPaneDead(server, pane, { signal: controller.signal });
  hooked.catch(() => {});
  polled.catch(() => {});
  try {
    await Promise.race([hooked, polled]);
  } finally {
    controller.abort();
    waiter.kill("SIGTERM");
  }
}
