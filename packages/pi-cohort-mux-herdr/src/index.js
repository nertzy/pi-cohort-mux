import { installMuxAdapter } from "pi-cohort-mux/adapter";

import { createHerdrExecutionBackend } from "./herdr-backend.js";

export {
  createHerdrBackend,
  createHerdrExecutionBackend,
} from "./herdr-backend.js";

export default function installPiCohortMuxHerdr(pi) {
  return installMuxAdapter(pi, import.meta.url, createHerdrExecutionBackend);
}
