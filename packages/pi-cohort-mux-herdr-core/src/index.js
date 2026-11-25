import { installMuxAdapter } from "pi-cohort-mux/adapter";

import { createHerdrCoreExecutionBackend } from "./herdr-core-backend.js";

export {
  createHerdrCoreBackend,
  createHerdrCoreExecutionBackend,
} from "./herdr-core-backend.js";

export default function installPiCohortMuxHerdrCore(pi) {
  return installMuxAdapter(
    pi,
    import.meta.url,
    createHerdrCoreExecutionBackend,
  );
}
