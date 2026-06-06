// Worker-thread entry point for `run-gba-roms.ts`. Node's `--import` flag
// from the parent process doesn't reach worker threads, so we register
// tsx's TypeScript loader here programmatically and then dynamically
// import the .ts file — which evaluates with `isMainThread === false`
// and installs the parentPort message handler.

import { register } from "tsx/esm/api";

register();
await import("./run-gba-roms.ts");
