import { execFile as execFileCallback } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Resolve once tmux reports `pane` dead. Requires remain-on-exit, which keeps a
 * dead pane listed. Stops quietly when `signal` aborts.
 */
export async function pollPaneDead(server, pane, { signal, interval = 100 } = {}) {
  while (!signal?.aborted) {
    const { stdout } = await execFile(
      "tmux",
      ["-L", server, "-f", "/dev/null", "display-message", "-p", "-t", pane, "#{pane_dead}"],
      { timeout: 5_000 },
    );
    if (stdout.trim() === "1") return;
    await sleep(interval, undefined, { signal }).catch(() => {});
  }
}

/**
 * Wait for a pane's death through its pane-died hook (`hooked`, the promise of
 * the `wait-for` child `waiter`) or a pane_dead poll, whichever reports first.
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
