/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from "virtual:pwa-register";

// Bootstrap the browser shell. Each module below registers its own event
// listeners / interval timers as a side effect of being imported, so the
// body of this file is just the service-worker handshake plus the import
// order — roughly "styles first, state, then UI glue, then entry points".
//
// The hardware emulators live under `src/gb/` (Game Boy + Game Boy
// Color) and `src/gba/` (Game Boy Advance) and are consumed from
// `ui/rom-loader.ts` — `new GameBoy(romBytes)` for `.gb` / `.gbc`,
// `new Gba(romBytes)` for `.gba`. The two engines are independent;
// only one runs at a time, and the UI swaps which one it talks to
// based on the loaded cart's extension.

registerSW({ immediate: true });

// Stylesheets — imported in cascade order. Vite bundles them and injects
// the combined sheet into the built document.
import "./ui/styles/base.css";
import "./ui/styles/themes.css";
import "./ui/styles/canvas.css";
import "./ui/styles/touch.css";
import "./ui/styles/popovers.css";
import "./ui/state.js";
import "./ui/settings"; // panels + collapse + controls bindings editor
import "./ui/popovers"; // library / slots / cheats / cart-info / settings
import "./ui/rom-loader.js"; // Load ROM button, drag-drop, launchQueue
import "./ui/session/actions.js"; // pause / turbo / screenshot / fullscreen btn
import "./ui/input/keyboard.js"; // global keydown / keyup routing
import "./ui/input/touch-actions.js"; // tap-to-trigger for the footer legend on touch
import "./ui/session/autosave.js"; // interval + visibility + beforeunload hooks
import "./ui/session/auto-pause.js"; // pause-on-blur / resume-on-focus
