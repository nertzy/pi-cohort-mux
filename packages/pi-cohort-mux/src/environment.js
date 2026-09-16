import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const environmentBootstrapPath = fileURLToPath(new URL("./env-bootstrap.sh", import.meta.url));

export function serializeEnvironment(environment) {
  return Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("cannot encode an environment variable name");
    if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.trim() !== value) throw new Error(`cannot encode environment variable ${key}`);
    if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) throw new Error(`cannot encode environment variable ${key}`);
    return `${key}=${value}\n`;
  }).join("");
}

export async function createEnvironmentPipe(payload, { spawn = spawnProcess, run = (...args) => execFile(...args) } = {}) {
  if (payload === "") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "pi-cohort-mux-env-"));
  const pipePath = join(directory, "environment.fifo");
  try { await run("mkfifo", ["-m", "600", pipePath]); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const child = spawn("/usr/bin/tee", [pipePath], { stdio: ["pipe", "ignore", "pipe"] });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`environment pipe writer exited with code ${code}, signal ${signal}`)));
  });
  child.stdin.end(payload, "utf8");
  return { pipePath, writer: { completion }, async cleanup() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completion.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  } };
}
