/**
 * The two calls the cmux backend's detect() proves ownership with: where the
 * cmux app's executable is, and which processes this one descends from.
 */

/** The cmux app's executable, as `cmux identify` and `ps` both report it. */
export const FAKE_CMUX_APP = "/Applications/cmux.app/Contents/MacOS/cmux";

/** This process's ancestors in a cmux surface, nearest first. */
export const CMUX_SURFACE_ANCESTORS = ["fish", "/usr/bin/login", FAKE_CMUX_APP];

/** `ps -A -o pid=,ppid=,comm=` for this process under these ancestors. */
export function processTable(ancestorCommands) {
  const rows = [`${process.pid} 90001 pi`];
  ancestorCommands.forEach((command, index) => {
    const parent = index === ancestorCommands.length - 1 ? 1 : 90002 + index;
    rows.push(`${90001 + index} ${parent} ${command}`);
  });
  return `${rows.map((row) => `  ${row}`).join("\n")}\n`;
}

/**
 * Answer an ownership call as a cmux surface would, or return undefined for
 * any other call.
 */
export function answerOwnershipCall(
  cli,
  args,
  { ancestorCommands = CMUX_SURFACE_ANCESTORS, identify } = {},
) {
  if (cli === "ps")
    return { stdout: processTable(ancestorCommands), stderr: "" };
  if (args[0] === "identify") {
    const answer = identify ?? { app_executable_path: FAKE_CMUX_APP };
    return { stdout: `${JSON.stringify(answer)}\n`, stderr: "" };
  }
  return undefined;
}
