// Process + worker-thread entry point for `gba.ts` (the GBA ROM-gate
// runner). The dispatcher (tests/run-roms.ts) spawns this file as the
// engine's process entry, and the runner's own worker threads re-enter
// through it too — Node's `--import` flag from the parent doesn't reach
// worker threads, so the tsx TypeScript loader is registered here
// programmatically. `gba.ts` branches on `isMainThread`. Node's `--import` flag
// from the parent process doesn't reach worker threads, so we register
// tsx's TypeScript loader here programmatically and then dynamically
// import the .ts file — which evaluates with `isMainThread === false`
// and installs the parentPort message handler.

import { register } from "tsx/esm/api";

register();
await import("./gba.ts");
