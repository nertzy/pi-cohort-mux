import { registerExecutionBackend } from "pi-cohort/execution-backend";

import { createCmuxExecutionBackend } from "./cmux-backend.js";

export { createCmuxBackend, createCmuxExecutionBackend } from "./cmux-backend.js";
export { createEventQueue } from "./event-queue.js";

const reload = Object.freeze({
  protocolVersion: 1,
  packageJsonUrl: new URL("../package.json", import.meta.url).href,
  publicSubpath: "./execution-backend",
  factoryExport: "createCmuxExecutionBackend",
});

export default function installPiCohortMux() {
  return registerExecutionBackend(createCmuxExecutionBackend(), { reload });
}
