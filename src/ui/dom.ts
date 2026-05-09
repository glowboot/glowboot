/** Centralised `document.getElementById` wall — imported by every module
 *  that needs DOM access so we only have one place to update selectors. */

/** The live canvas element. Declared with `let` (not `const`) so the
 *  render-mode hot-swap can drop in a fresh element when the user
 *  changes between Canvas 2D and WebGL — a canvas's context type is
 *  fixed once `getContext()` is called, so swapping modes requires a
 *  new DOM node. ES-module live bindings propagate the reassignment to
 *  every importer that doesn't cache the ref locally. */
export let canvas: HTMLCanvasElement = document.getElementById("screen") as HTMLCanvasElement;

/** Replace the current canvas reference. Called by `state.swapRenderer`
 *  after inserting a fresh `<canvas>` into the DOM. Only the owner of
 *  the rendering lifecycle should call this. */
export function setCanvas(el: HTMLCanvasElement): void {
  canvas = el;
}
export const romInput = document.getElementById("rom-input") as HTMLInputElement;
export const loadBtn = document.getElementById("load-btn") as HTMLButtonElement | null;
export const fsBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement | null;
export const canvasPlaceholder = document.getElementById("canvas-placeholder") as HTMLButtonElement | null;

/** Fullscreen target — covers the canvas AND the touch overlay so mobile
 *  users can play in fullscreen with on-screen D-pad / A-B buttons. Was
 *  previously the canvas itself, which meant fullscreen killed the touch
 *  overlay entirely. */
export const consoleEl = document.querySelector<HTMLElement>(".console");

export const recentsTrigger = document.getElementById("recents-trigger") as HTMLButtonElement | null;
export const recentsPop = document.getElementById("recents-pop") as HTMLElement | null;
export const slotsTrigger = document.getElementById("slots-trigger") as HTMLButtonElement | null;
export const slotsPop = document.getElementById("slots-pop") as HTMLElement | null;
export const cheatsTrigger = document.getElementById("cheats-trigger") as HTMLButtonElement | null;
export const cheatsPop = document.getElementById("cheats-pop") as HTMLElement | null;
export const debuggerTrigger = document.getElementById("debugger-trigger") as HTMLButtonElement | null;
export const debuggerPop = document.getElementById("debugger-pop") as HTMLElement | null;
export const printerTrigger = document.getElementById("printer-trigger") as HTMLButtonElement | null;
export const printerPop = document.getElementById("printer-pop") as HTMLElement | null;
export const cartInfoTrigger = document.getElementById("cart-info-trigger") as HTMLButtonElement | null;
export const cartInfoPop = document.getElementById("cart-info-pop") as HTMLElement | null;
export const moreTrigger = document.getElementById("more-trigger") as HTMLButtonElement | null;
export const morePop = document.getElementById("more-pop") as HTMLElement | null;
export const settingsTrigger = document.getElementById("settings-trigger") as HTMLButtonElement | null;
export const settingsPop = document.getElementById("settings-pop") as HTMLElement | null;
export const settingsSavedPip = document.getElementById("settings-saved") as HTMLElement | null;
export const settingsSearchInput = document.getElementById("settings-search") as HTMLInputElement | null;
export const paletteSelect = document.getElementById("palette-select") as HTMLSelectElement | null;
export const paletteNote = document.getElementById("palette-note") as HTMLElement | null;
export const colorCorrectionToggle = document.getElementById("color-correction-toggle") as HTMLInputElement | null;
export const integerScaleToggle = document.getElementById("integer-scale-toggle") as HTMLInputElement | null;
export const pixelResponseSlider = document.getElementById("pixel-response") as HTMLInputElement | null;
export const renderModeSelect = document.getElementById("render-mode") as HTMLSelectElement | null;
export const gradeBrightness = document.getElementById("grade-brightness") as HTMLInputElement | null;
export const gradeContrast = document.getElementById("grade-contrast") as HTMLInputElement | null;
export const gradeGamma = document.getElementById("grade-gamma") as HTMLInputElement | null;
export const gradeSaturation = document.getElementById("grade-saturation") as HTMLInputElement | null;
export const gradeTemperature = document.getElementById("grade-temperature") as HTMLInputElement | null;
export const autoPauseToggle = document.getElementById("auto-pause-toggle") as HTMLInputElement | null;
export const audioRumbleToggle = document.getElementById("audio-rumble-toggle") as HTMLInputElement | null;
export const rumblePresetSelect = document.getElementById("rumble-preset-select") as HTMLSelectElement | null;
export const rumbleStrengthSlider = document.getElementById("rumble-strength-slider") as HTMLInputElement | null;
export const rewindCapacitySelect = document.getElementById("rewind-capacity-select") as HTMLSelectElement | null;
export const linkCableModeSelect = document.getElementById("link-cable-mode") as HTMLSelectElement | null;
export const linkRoomCodeInput = document.getElementById("link-room-code") as HTMLInputElement | null;
export const linkStatusEl = document.getElementById("link-status") as HTMLElement | null;
export const gamepadDetectedEl = document.getElementById("gamepad-detected") as HTMLElement | null;
export const settingsExportBtn = document.getElementById("settings-export") as HTMLButtonElement | null;
export const settingsImportBtn = document.getElementById("settings-import") as HTMLButtonElement | null;
export const settingsImportInput = document.getElementById("settings-import-input") as HTMLInputElement | null;
export const libraryExportBtn = document.getElementById("library-export") as HTMLButtonElement | null;
export const libraryImportBtn = document.getElementById("library-import") as HTMLButtonElement | null;
export const libraryImportInput = document.getElementById("library-import-input") as HTMLInputElement | null;
export const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement | null;
export const muteButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mute-btn"));
export const touchRoot = document.querySelector<HTMLElement>(".gb-touch");
export const touchSelect = document.getElementById("touch-mode") as HTMLSelectElement | null;
export const touchHapticToggle = document.getElementById("touch-haptic-toggle") as HTMLInputElement | null;
export const touchMirrorToggle = document.getElementById("touch-mirror-toggle") as HTMLInputElement | null;
export const touchScaleSlider = document.getElementById("touch-scale-slider") as HTMLInputElement | null;
export const touchSpacingSlider = document.getElementById("touch-spacing-slider") as HTMLInputElement | null;

// Now-playing strip
export const titleEl = document.getElementById("np-title");
export const statusEl = document.getElementById("np-status");
export const fpsEl = document.getElementById("np-fps");
export const timeEl = document.getElementById("np-time");
export const frameEl = document.getElementById("frame");
export const speedEl = document.getElementById("np-speed");
export const touchSpeedLabelEl = document.getElementById("touch-speed-label");

// Canvas overlays + toast
export const overlayRewind = document.getElementById("overlay-rewind") as HTMLElement | null;
export const overlayFlash = document.getElementById("overlay-flash") as HTMLElement | null;
export const recBadge = document.getElementById("rec-badge") as HTMLElement | null;
export const toastEl = document.getElementById("toast") as HTMLElement | null;
export const toastErrorEl = document.getElementById("toast-error") as HTMLElement | null;

// Bindings editor (Settings → Controls)
export const bindingsKeyboardEl = document.getElementById("bindings-keyboard");
export const bindingsGamepadEl = document.getElementById("bindings-gamepad");
export const bindingsHintEl = document.getElementById("bindings-hint");
export const bindingsResetKey = document.getElementById("bindings-reset-keyboard");
export const bindingsResetPad = document.getElementById("bindings-reset-gamepad");
export const bindingsHotkeysEl = document.getElementById("bindings-hotkeys");
export const bindingsResetHotkeys = document.getElementById("bindings-reset-hotkeys");

// Section-level reset buttons (live next to each section's <h4>).
// Keyboard / hotkeys / gamepad use the existing bindingsReset* exports
// above — those buttons just moved location in the HTML, the IDs are
// unchanged. The five below are new.
export const displayResetBtn = document.getElementById("display-reset") as HTMLButtonElement | null;
export const touchResetBtn = document.getElementById("touch-reset") as HTMLButtonElement | null;
export const rumbleResetBtn = document.getElementById("rumble-reset") as HTMLButtonElement | null;
export const audioResetBtn = document.getElementById("audio-reset") as HTMLButtonElement | null;
export const sessionResetBtn = document.getElementById("session-reset") as HTMLButtonElement | null;
