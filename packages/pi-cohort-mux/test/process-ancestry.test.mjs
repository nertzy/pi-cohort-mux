/**
 * processAncestors: the chain of processes a mux adapter checks to prove that
 * its multiplexer started this terminal, rather than trusting inherited
 * environment variables.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { processAncestors } from "../src/index.js";

const psAnswering = (stdout, calls = []) =>
  async function execFile(command, args, options) {
    calls.push({ command, args, options });
    return { stdout, stderr: "" };
  };

test("lists a process's ancestors nearest first, with the command ps reports", async () => {
  const calls = [];
  const execFile = psAnswering(
    [
      "    1     0 /sbin/launchd",
      "  700     1 /Applications/Some Terminal.app/Contents/MacOS/terminal",
      "  800   700 /usr/bin/login",
      "  900   800 -fish",
      " 1000   900 pi",
      " 2000     1 /usr/sbin/unrelated",
      "",
    ].join("\n"),
    calls,
  );

  const ancestors = await processAncestors({
    execFile,
    pid: 1000,
    timeout: 1234,
  });

  assert.deepEqual(ancestors, [
    { pid: 900, command: "-fish" },
    { pid: 800, command: "/usr/bin/login" },
    {
      pid: 700,
      command: "/Applications/Some Terminal.app/Contents/MacOS/terminal",
    },
    { pid: 1, command: "/sbin/launchd" },
  ]);
  assert.deepEqual(calls, [
    {
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,comm="],
      options: { timeout: 1234 },
    },
  ]);
});

test("stops where the chain leaves the process table", async () => {
  const execFile = psAnswering("  900   555 fish\n 1000   900 pi\n");
  assert.deepEqual(await processAncestors({ execFile, pid: 1000 }), [
    { pid: 900, command: "fish" },
  ]);
});

test("stops rather than loops when the process table has a cycle", async () => {
  const execFile = psAnswering("  900  1000 fish\n 1000   900 pi\n");
  assert.deepEqual(await processAncestors({ execFile, pid: 1000 }), [
    { pid: 900, command: "fish" },
  ]);
});

test("rejects when ps does not list the process, instead of reporting no ancestors", async () => {
  const execFile = psAnswering("  900     1 fish\n");
  await assert.rejects(
    processAncestors({ execFile, pid: 1000 }),
    /ps did not list process 1000/,
  );
});

test("rejects when ps fails", async () => {
  const execFile = async () => {
    throw new Error("spawn ps ENOENT");
  };
  await assert.rejects(processAncestors({ execFile, pid: 1000 }), /ENOENT/);
});

test("against the real ps, this process's nearest ancestor is its parent", async () => {
  const [parent] = await processAncestors();
  assert.equal(parent.pid, process.ppid);
  assert.equal(typeof parent.command, "string");
  assert.notEqual(parent.command, "");
});
