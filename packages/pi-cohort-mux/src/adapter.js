import { registerExecutionBackend } from "pi-cohort/execution-backend";

import { createSubagentBadgeResolver } from "./tool-badge.js";

// An adapter's whole Pi extension: register its backend with pi-cohort, with
// the reload descriptor the backend carries, and badge subagent calls that ran
// on it with the backend's own name. The badge is added only after pi-cohort
// accepts the backend.
export function installMuxAdapter(pi, backend) {
  const dispose = registerExecutionBackend(backend, { reload: backend.reload });
  pi?.registerToolRenderer?.(createSubagentBadgeResolver(backend.name));
  return dispose;
}
