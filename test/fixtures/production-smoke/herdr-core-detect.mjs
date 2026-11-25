/**
 * Runs inside a real herdr-core terminal: detect() with the terminal's own
 * environment, written as JSON to the path in argv[2].
 */
import { writeFileSync } from "node:fs";

import createHerdrCoreExecutionBackend from "pi-cohort-mux-herdr-core/execution-backend";

const detection = await createHerdrCoreExecutionBackend().detect();
writeFileSync(process.argv[2], JSON.stringify(detection));
