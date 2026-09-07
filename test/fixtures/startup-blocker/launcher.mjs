import { createReadStream } from "node:fs";
import net from "node:net";
import { createJsonlFrameBuffer } from "./jsonl-frame-buffer.mjs";

const [firstArgument, secondArgument] = process.argv.slice(2);

if (firstArgument === "--exit-before-ready") {
  process.exit(Number(secondArgument));
}

const fifo = firstArgument;
const socketPath = secondArgument;
process.stdin.resume();

function exitCleanly() {
  process.exit(0);
}

process.once("SIGINT", exitCleanly);
process.once("SIGTERM", exitCleanly);

const release = createReadStream(fifo, { encoding: "utf8" });
release.once("data", () => {
  release.close();
  const control = net.createConnection(socketPath);
  control.once("connect", () => control.write(`${JSON.stringify({ type: "ready" })}\n`));
  const frames = createJsonlFrameBuffer((frame) => {
    if (frame.type === "shutdown") exitCleanly();
  });
  control.on("data", (chunk) => frames.feed(chunk));
  control.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
});
