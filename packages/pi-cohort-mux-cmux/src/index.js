import { installMuxAdapter } from "pi-cohort-mux/adapter";
import { createCmuxExecutionBackend } from "./cmux-backend.js";

export {
  createCmuxBackend,
  createCmuxExecutionBackend,
} from "./cmux-backend.js";

export default function installPiCohortMux(pi) {
  return installMuxAdapter(pi, import.meta.url, createCmuxExecutionBackend);
}
