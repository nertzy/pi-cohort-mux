/**
 * A deadline for the real-cmux tests: `defaultMs`, or
 * `PI_COHORT_MUX_CMUX_DEADLINE_MS` when that is larger. CI sets it because a
 * freshly booted macOS runner is so short of CPU that one cmux call can take
 * longer than the defaults. It only ever lengthens a deadline.
 */
export function cmuxDeadline(defaultMs, env = process.env) {
  const raw = env.PI_COHORT_MUX_CMUX_DEADLINE_MS;
  if (raw === undefined || raw === "") return defaultMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `PI_COHORT_MUX_CMUX_DEADLINE_MS must be a positive whole number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.max(defaultMs, value);
}
