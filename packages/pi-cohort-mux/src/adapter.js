import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXECUTION_BACKEND_PROTOCOL_VERSION,
  registerExecutionBackend,
} from "pi-cohort/execution-backend";

import { createSubagentBadgeResolver } from "./tool-badge.js";

// The adapter convention: an adapter package exports "./execution-backend",
// whose default export is a zero-argument backend factory. This module is the
// only place that knows how that maps onto pi-cohort's registration.
const BACKEND_SUBPATH = "./execution-backend";
const BACKEND_FACTORY_EXPORT = "default";

// An adapter's whole Pi extension. `moduleUrl` is the calling module's
// import.meta.url, which locates the adapter's package; `createBackend` is the
// same factory the package default-exports from "./execution-backend". The
// badge is added only after pi-cohort accepts the backend.
export function installMuxAdapter(pi, moduleUrl, createBackend) {
  const reload = reloadDescriptor(moduleUrl);
  const backend = createBackend();
  const dispose = registerExecutionBackend(backend, { reload });
  pi?.registerToolRenderer?.(createSubagentBadgeResolver(backend.name));
  return dispose;
}

const reloadDescriptor = (moduleUrl) => ({
  protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
  packageJsonUrl: pathToFileURL(packageJsonAbove(moduleUrl)).href,
  publicSubpath: BACKEND_SUBPATH,
  factoryExport: BACKEND_FACTORY_EXPORT,
});

function packageJsonAbove(moduleUrl) {
  for (
    let directory = dirname(fileURLToPath(moduleUrl));
    ;
    directory = dirname(directory)
  ) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) {
      throw new Error(`no package.json above ${moduleUrl}`);
    }
  }
}
