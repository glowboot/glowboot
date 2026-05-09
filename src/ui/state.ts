import type { GameBoy, SerialLink } from "../gb";
import { AudioOutput } from "./audio-output.js";
import { canvas, setCanvas } from "./dom.js";
import { GamepadInput } from "./input/gamepad.js";
import { KEYS, lsGet } from "./persistence/local-storage.js";
import { CanvasRenderer, type ShaderName, WebGLRenderer } from "./renderer";
import type { RewindBuffer } from "./session/rewind-buffer.js";

/**
 * Shared mutable application state. Every feature module reads/writes
 * through `state.<field>` rather than module-level `let` bindings — which
 * would be invisible to other modules and wouldn't reflect re-assignments
 * across module boundaries. Keeping it all on one object makes the set of
 * shared variables obvious at a glance.
 *
 * The three singleton services (renderer, audio, gamepad) are exported as
 * ordinary consts because they're created exactly once and never replaced.
 */

/** Metadata carried alongside each rewind snapshot so the UI counters
 *  (frame number, elapsed time) track backwards in step with the engine.
 *  `framebuffer` is a copy of the PPU output at capture time — needed
 *  because the save-state doesn't include the rendered framebuffer,
 *  so after `gb.loadState()` the on-screen pixels would otherwise show
 *  the frame from BEFORE the rewind started. */
export interface RewindMeta {
  frameCount: number;
  elapsedMs: number;
  framebuffer: Uint8ClampedArray<ArrayBuffer>;
}

/** Live binding to the active renderer. Replaced by `swapRenderer` when
 *  the user changes the render-mode setting so callers don't have to
 *  reload. Importers that read `renderer` at call time (not at their own
 *  module init) pick up the new instance automatically. */
export let renderer: CanvasRenderer | WebGLRenderer = createRenderer(canvas);

function shaderForMode(mode: string | null): ShaderName | null {
  switch (mode) {
    case "webgl-lcd":
      return "lcd";
    case "webgl-xbr":
      return "xbr";
    case "webgl-sxbr":
      return "sxbr";
    case "webgl-crt":
      return "crt";
    case "webgl-dmg":
      return "dmg";
    case "webgl-pocket":
      return "pocket";
    case "webgl-light":
      return "light";
    case "webgl-sgb":
      return "sgb";
    case "webgl-bloom":
      return "bloom";
    case "webgl-scan":
      return "scan";
    default:
      return null;
  }
}

function createRenderer(c: HTMLCanvasElement): CanvasRenderer | WebGLRenderer {
  // Fall back to Super-xBR when no render-mode pref is stored — matches
  // the default surfaced by `panels.ts` so a fresh browser sees the same
  // shader immediately on first paint (and not a one-frame flash of
  // Canvas 2D before the setting binding has caught up).
  const stored = lsGet(KEYS.RENDER_MODE) ?? "webgl-sxbr";
  const shader = shaderForMode(stored);
  if (shader) {
    try {
      return new WebGLRenderer(c, shader);
    } catch (err) {
      console.warn("[Renderer] WebGL init failed — falling back to Canvas 2D:", err);
    }
  }
  return new CanvasRenderer(c);
}

/** Hot-swap the active renderer. Because a `<canvas>` element's context
 *  type is sticky (`getContext("2d")` after `getContext("webgl")`
 *  returns null and vice versa) we can't reuse the DOM node — we build
 *  a fresh canvas in the same slot, swap the `dom.canvas` live binding
 *  to point at it, construct the new renderer, and re-render the
 *  current frame so the user doesn't see a flash of empty screen.
 *
 *  The caller is responsible for re-applying any render-specific prefs
 *  (integer scale, pixel response, colour grade) against the new
 *  renderer — we return it so the caller can do that directly. */
export function swapRenderer(mode: string | null): CanvasRenderer | WebGLRenderer {
  const old = canvas;
  const parent = old.parentElement;
  if (!parent) return renderer;
  const fresh = document.createElement("canvas");
  fresh.id = old.id;
  fresh.className = old.className;
  parent.replaceChild(fresh, old);
  setCanvas(fresh);

  const shader = shaderForMode(mode);
  if (shader) {
    try {
      renderer = new WebGLRenderer(fresh, shader);
    } catch (err) {
      console.warn("[Renderer] WebGL init failed — falling back to Canvas 2D:", err);
      renderer = new CanvasRenderer(fresh);
    }
  } else {
    renderer = new CanvasRenderer(fresh);
  }

  // Push the last-rendered PPU frame through the new renderer so the
  // screen doesn't blank between swap and the next engine frame
  // (notable on paused games or during a mode switch at a menu).
  if (state.gb) renderer.render(state.gb.ppu.framebuffer);
  return renderer;
}
export const audio = new AudioOutput();
export const gamepad = new GamepadInput();

/**
 * Audio-rumble preset — named mix of the four APU channel envelopes.
 * Different games place "interesting" audio on different channels, so
 * offering pre-tuned mixes lets users swap a label instead of thinking
 * about weights. Weights are pre-normalized so their maximum combined
 * envelope is ≈ 1.0 — the strength slider then scales that uniformly,
 * so switching presets doesn't secretly change overall loudness.
 */
export interface RumblePreset {
  id: string;
  name: string;
  weights: { ch1: number; ch2: number; ch3: number; ch4: number };
}

export const RUMBLE_PRESETS: readonly RumblePreset[] = [
  // Balanced mix: lead melody + drums get the most emphasis, bass and
  // harmony contribute quietly. Works as a reasonable default for
  // most titles; user switches to a specific preset only when the
  // audio profile of the game they're playing suggests it.
  {
    id: "balanced",
    name: "Balanced (CH1 + CH4 lead)",
    weights: { ch1: 0.29, ch2: 0.14, ch3: 0.14, ch4: 0.43 }
  },
  // Melody-driven — the lead square channel (and a bit of its
  // harmony partner) carries the pulse. Good for games where tune
  // hits feel like they should rumble (Super Mario Land's jumps,
  // Tetris drops).
  {
    id: "melody",
    name: "Melody (CH1 + CH2)",
    weights: { ch1: 0.67, ch2: 0.33, ch3: 0, ch4: 0 }
  },
  // Rhythm: bass wave + drums. Picks up the groove without the
  // melody flutter. Nice in games with a driving bassline (DKC
  // descendants, some Kirby).
  {
    id: "rhythm",
    name: "Rhythm (CH3 + CH4)",
    weights: { ch1: 0, ch2: 0, ch3: 0.44, ch4: 0.56 }
  },
  // Pure impact: noise channel only. Rumble fires strictly on drums
  // / SFX / explosions — silent through melody and bass.
  {
    id: "impact",
    name: "Impact (CH4 only)",
    weights: { ch1: 0, ch2: 0, ch3: 0, ch4: 1 }
  },
  // Everything equal. Any audio → some rumble. Loudest-feeling
  // preset because four channels contribute simultaneously.
  {
    id: "full",
    name: "Full mix",
    weights: { ch1: 0.25, ch2: 0.25, ch3: 0.25, ch4: 0.25 }
  }
];

export const DEFAULT_RUMBLE_PRESET_ID = "balanced";

/** Currently-selected preset id. Panel handler writes this on dropdown
 *  change; state.ts reads it every poll through the registered
 *  envelope callback, so no re-wiring is needed on cart switch. */
export let rumblePresetId: string = DEFAULT_RUMBLE_PRESET_ID;
export function setRumblePresetId(id: string): void {
  rumblePresetId = id;
}

function resolvePreset(): RumblePreset {
  return RUMBLE_PRESETS.find((p) => p.id === rumblePresetId) ?? RUMBLE_PRESETS[0]!;
}

// Callback reads the current preset + live GameBoy every frame so
// switching ROMs or presets takes effect instantly without rewiring.
gamepad.setAudioEnvelopeSource(() => {
  const apu = state.gb?.apu;
  if (!apu) return 0;
  const w = resolvePreset().weights;
  return w.ch1 * apu.ch1Envelope + w.ch2 * apu.ch2Envelope + w.ch3 * apu.ch3Envelope + w.ch4 * apu.ch4Envelope;
});
gamepad.start();

export const state = {
  /** Current Game Boy engine, or null before any ROM has been loaded. */
  gb: null as GameBoy | null,
  paused: false,

  // Rewind
  rewinder: null as RewindBuffer<RewindMeta> | null,
  rewinding: false,
  rewindRaf: 0,

  // Status-strip counters (reset by resetStatus, incremented by tickStatus,
  // rewound by the rewind loop).
  frameCount: 0,
  runStartMs: 0,
  fpsLastMs: 0,
  fpsFrames: 0,

  /** performance.now() timestamp of the most recent save-state save or
   *  load for the current cart. Used by doLoadState to decide whether
   *  to prompt before clobbering in-progress gameplay. Cleared on cart
   *  swap so the first load on a new cart doesn't inherit a stale timer. */
  lastStateAt: 0,

  /** Timestamp of the current play-time sub-session; null when paused. */
  playSessionStart: null as number | null,
  /** Library id we're currently crediting play time to. */
  playTrackingId: null as string | null,

  /** Pending library-thumbnail capture for the current ROM. */
  thumbnailTimer: null as number | null,

  /** Filename the current ROM was loaded with. Retained across the
   *  running session so the Reset button can re-launch via
   *  `startEmulator` with the original display name. */
  currentFilename: null as string | null,

  /** Active link instance when the user has enabled link-cable pair
   *  mode in Settings. Concrete type is either `BroadcastChannelLink`
   *  (same-machine) or `WebRTCLink` (remote — uses the CF Worker for
   *  signalling, then upgrades to a P2P RTCDataChannel and falls back
   *  to the worker as a relay if the DataChannel can't establish);
   *  we only care about the shared `SerialLink` interface here. */
  link: null as SerialLink | null,

  /** True while the emulator is paused specifically because the window
   *  lost focus. Lets `auto-pause.ts` distinguish its own pause from a
   *  user-initiated one so focus→blur cycles don't accidentally resume
   *  a game the user deliberately paused before alt-tabbing away. */
  autoPausedOnBlur: false,

  /** Wall-clock `Date.now()` at which the emulator entered a paused /
   *  tab-hidden state. Non-zero while suspended; cleared after the RTC
   *  catch-up has been applied on resume. Covers both the user-pause
   *  (Space) and the tab-visibility paths, so multi-hour gaps credit
   *  the cart clock once on whichever resume transition fires first. */
  rtcWallPauseMs: 0
};

/** Update `state.paused` and mirror it to `body.is-paused` in one step.
 *  Centralising the mirror here means CSS-driven UI affordances (the
 *  touch-toolbar pause-vs-play icon swap, etc.) stay in sync no matter
 *  which call path flipped the state. */
export function setPaused(paused: boolean): void {
  state.paused = paused;
  document.body.classList.toggle("is-paused", paused);
}
