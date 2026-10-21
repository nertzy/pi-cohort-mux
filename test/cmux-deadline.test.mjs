import assert from "node:assert/strict";
import test from "node:test";

import { cmuxDeadline } from "./support/cmux-deadline.mjs";

const env = (value) => ({ PI_COHORT_MUX_CMUX_DEADLINE_MS: value });

test("cmux deadline: the default without an override", () => {
  assert.equal(cmuxDeadline(5_000, {}), 5_000);
  assert.equal(cmuxDeadline(5_000, env("")), 5_000);
});

test("cmux deadline: an override only lengthens the default", () => {
  assert.equal(cmuxDeadline(5_000, env("60000")), 60_000);
  assert.equal(cmuxDeadline(15_000, env("1000")), 15_000);
});

test("cmux deadline: a malformed override fails loudly", () => {
  for (const value of ["60s", "-1", "0", "1.5"]) {
    assert.throws(
      () => cmuxDeadline(5_000, env(value)),
      /positive whole number/,
    );
  }
});
