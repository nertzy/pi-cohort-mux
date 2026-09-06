const socketPath = process.env.PI_COHORT_SPIKE_SOCKET;
const fifoPath = process.env.PI_COHORT_SPIKE_FIFO;
const piAiModule = process.env.PI_COHORT_SPIKE_PI_AI_MODULE;

if (!socketPath || !fifoPath || !piAiModule) throw new Error("Missing session-log spike runtime path");

const { createFauxCore, fauxAssistantMessage } = await import(piAiModule);
const net = await import("node:net");
const { readFileSync } = await import("node:fs");

const token = readFileSync(fifoPath, "utf8");
const control = net.createConnection(socketPath);
let context;
let authenticated = false;
let readyReported = false;
let reportReady = () => {};

function notify(message) {
  control.write(`${JSON.stringify(message)}\n`);
}

export default function (pi) {
  const fixture = createFauxCore({
    provider: "fixture",
    api: "fixture-api",
    models: [{ id: "fixed", name: "Fixed fixture", contextWindow: 4096, maxTokens: 1024 }],
  });
  fixture.setResponses([fauxAssistantMessage("fixture assistant response")]);
  pi.registerProvider("fixture", { ...fixture, apiKey: "fixture-not-a-secret" });

  reportReady = () => {
    if (!authenticated || !context || readyReported) return;

    readyReported = true;
    pi.appendEntry("pi-cohort.ready.v1", { owner: "core", mode: context.mode });
    notify({ type: "ready" });
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    reportReady();
  });

  pi.on("agent_settled", () => {
    pi.appendEntry("pi-cohort.settled.v1", { owner: "core" });
    notify({ type: "settled" });
  });
}

control.on("connect", () => notify({ type: "hello", token }));
control.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "authenticated") {
      authenticated = true;
      reportReady();
    }
    if (message.type === "shutdown") {
      notify({ type: "shutdown-ack" });
      context?.shutdown();
    }
  }
});
