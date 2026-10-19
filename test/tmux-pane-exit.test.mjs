import assert from "node:assert/strict";
import test from "node:test";
import { pollPaneDead } from "./support/tmux-pane-exit.mjs";

/** Fake `tmux display-message` that answers each poll from `replies` in order. */
function scripted(replies) {
  const formats = [];
  let index = 0;
  const run = async (_file, args) => {
    formats.push(args.at(-1));
    return { stdout: `${replies[Math.min(index++, replies.length - 1)]}\n` };
  };
  return { run, formats, polls: () => index };
}

test("pane_dead poll waits for the exit status tmux 3.4 records after marking the pane dead", async () => {
  // tmux 3.4 sets pane_dead on pty EOF, before it reaps the child.
  const tmux = scripted(["0||", "1||", "1||", "1|23|"]);
  await pollPaneDead("server", "%1", { interval: 1, run: tmux.run });
  assert.equal(tmux.polls(), 4, "resolved only once the status was recorded");
  assert.match(tmux.formats[0], /#\{pane_dead_status\}/);
});

test("pane_dead poll accepts a signal death, which records no status", async () => {
  const tmux = scripted(["1||", "1||9"]);
  await pollPaneDead("server", "%1", { interval: 1, run: tmux.run });
  assert.equal(tmux.polls(), 2);
});

test("pane_dead poll stops quietly when aborted", async () => {
  const tmux = scripted(["0||"]);
  const controller = new AbortController();
  const polling = pollPaneDead("server", "%1", { interval: 5, run: tmux.run, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await polling;
  assert.ok(tmux.polls() >= 1);
});
