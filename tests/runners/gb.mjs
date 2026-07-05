// Process entry point for `gb.ts` — the dispatcher (tests/run-roms.ts)
// spawns this file, which registers the tsx TypeScript loader and imports
// the runner. Also serves as the worker-thread entry if the runner ever
// parallelises (see gba.mjs).

import { register } from "tsx/esm/api";

register();
await import("./gb.ts");
