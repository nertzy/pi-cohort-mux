import { registerExecutionBackend } from "pi-cohort/execution-backend";

import { createCmuxExecutionBackend } from "./cmux-backend.js";
import { subagentBadgeResolver } from "./tool-color.js";

export {
  createCmuxBackend,
  createCmuxExecutionBackend,
} from "./cmux-backend.js";

const reload = Object.freeze({
  protocolVersion: 1,
  packageJsonUrl: new URL("../package.json", import.meta.url).href,
  publicSubpath: "./execution-backend",
  factoryExport: "createCmuxExecutionBackend",
});

export default function installPiCohortMux(pi) {
  pi?.registerToolRenderer?.(subagentBadgeResolver);
  return registerExecutionBackend(createCmuxExecutionBackend(), { reload });
}
