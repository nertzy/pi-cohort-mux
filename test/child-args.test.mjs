import assert from "node:assert/strict";
import test from "node:test";

import { trustedChildArgs } from "pi-cohort-mux";

test("appends --approve after the task so an interactive child never stops on the trust prompt", () => {
  assert.deepEqual(
    trustedChildArgs(["/pi/cli.js", "--session", "s.jsonl", "do the task"]),
    ["/pi/cli.js", "--session", "s.jsonl", "do the task", "--approve"],
  );
});

test("keeps an explicit trust decision the caller already made", () => {
  for (const flag of ["--approve", "-a", "--no-approve", "-na"]) {
    const args = ["/pi/cli.js", flag, "do the task"];
    assert.deepEqual(trustedChildArgs(args), args, flag);
  }
});

test("returns a copy", () => {
  const args = ["/pi/cli.js", "task"];
  const result = trustedChildArgs(args);
  assert.notEqual(result, args);
  assert.deepEqual(args, ["/pi/cli.js", "task"]);
});
