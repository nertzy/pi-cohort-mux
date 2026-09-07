import { readdir, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const [socketPath, metadataBase64] = process.argv.slice(2);
const cwd = process.cwd();
const metadata = metadataBase64 ? JSON.parse(Buffer.from(metadataBase64, "base64url")) : undefined;

async function git(args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function observation() {
  const markers = (await readdir(cwd)).filter((entry) => entry.startsWith("marker-"));
  const gitEntry = await stat(path.join(cwd, ".git")).then(() => true, () => false);
  const gitObservation = gitEntry
    ? {
      topLevel: await git(["rev-parse", "--show-toplevel"]),
      branch: await git(["symbolic-ref", "--short", "HEAD"]).catch(() => null),
      detached: await git(["symbolic-ref", "-q", "HEAD"]).then(() => false, () => true),
    }
    : undefined;

  return { cwd, markers, git: gitObservation, metadata };
}

const message = `${JSON.stringify(await observation())}\n`;
const client = net.createConnection(socketPath);
client.once("connect", () => client.end(message));
client.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
