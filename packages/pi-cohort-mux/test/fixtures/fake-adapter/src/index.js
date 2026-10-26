import { installMuxAdapter } from "pi-cohort-mux/adapter";

import createFakeExecutionBackend from "./execution-backend.js";

export default (pi) =>
  installMuxAdapter(pi, import.meta.url, createFakeExecutionBackend);
