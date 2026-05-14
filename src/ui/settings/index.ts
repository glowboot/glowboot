/**
 * Barrel for the Settings layer. Importing this file is the one-line
 * way for `main.ts` to register every Settings-popover handler: the
 * three panel modules all run side effects at import time (event
 * listeners, initial state application) and `collapse.ts` has no
 * exports of its own, so it's pulled in purely for side effects.
 *
 * External consumers (rom-loader, keyboard) get the named exports
 * they need (`applyCurrentPalette`, `codeToButton`, …) via the re-
 * exports below.
 */

import "./collapse.js";

export * from "./panels.js";
export * from "./bindings.js";
