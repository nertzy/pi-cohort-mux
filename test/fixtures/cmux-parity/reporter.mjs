// Adapter-owned reporter launched *inside* a disposable cmux surface via
// `cmux workspace create --command`. It never touches pane text, terminal
// input, or read-screen: all evidence crosses a structured, owner-only Unix
// socket the test process listens on. The reporter is the client.
//
// Protocol (newline-delimited JSON frames):
//   reporter -> test: {"type":"ready","cwd":<physical cwd>,"workspaceId":<CMUX_WORKSPACE_ID or null>,"surfaceId":<CMUX_SURFACE_ID or null>}
//   test -> reporter: {"type":"shutdown"}
//   reporter -> test: {"type":"shutdown-ack"}
// then the reporter exits 0.
import net from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: reporter.mjs <socket-path>\n");
  process.exit(2);
}

const client = net.createConnection(socketPath);
let buffer = "";

function send(frame) {
  client.write(`${JSON.stringify(frame)}\n`);
}

client.on("connect", () => {
  send({
    type: "ready",
    cwd: process.cwd(),
    workspaceId: process.env.CMUX_WORKSPACE_ID ?? null,
    surfaceId: process.env.CMUX_SURFACE_ID ?? null,
  });
});

client.setEncoding("utf8");
client.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  // eslint-disable-next-line no-cond-assign
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type === "shutdown") {
      send({ type: "shutdown-ack" });
      client.end(() => process.exit(0));
    }
  }
});

client.on("error", (error) => {
  process.stderr.write(`reporter socket error: ${error.message}\n`);
  process.exit(1);
});
