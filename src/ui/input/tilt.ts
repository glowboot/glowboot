import { loadTiltBindings, mirrorModifierPairs, type TiltDirection } from "./bindings.js";

/**
 * Tilt / motion input source for every sensor cart Glowboot supports.
 * One read path serves all of them so the same `I`/`K`/`J`/`L`
 * keybinds + DeviceMotion plumbing apply uniformly:
 *
 *   - **`readTilt()`** — two-axis accelerometer used by the Game Boy
 *     MBC7 cart (Kirby Tilt 'n' Tumble) and the Game Boy Advance
 *     ADXL202E carts (Yoshi Topsy-Turvy, Koro Koro Puzzle).
 *   - **`readGyroscope()`** — single-axis ADXRS300 rotation rate for
 *     WarioWare: Twisted! (Game Boy Advance). Reuses the keyboard
 *     left/right (`J`/`L`) bindings for counter-clockwise / clockwise.
 *   - **`readSolarBrightness()`** — solar-sensor brightness for the
 *     Boktai trilogy (Game Boy Advance).
 *
 * Tilt axes return roughly `[-1, +1]` g-units where `+x` is east tilt
 * and `+y` is north tilt (player-forward). MBC7's read path scales by
 * `0x70` per g and adds the `0x81D0` rest value; the GBA accelerometer
 * cart code scales it for the ADXL202E's pulse-width output.
 *
 * Sources, polled in priority order:
 *   1. DeviceMotionEvent — phones / tablets. iOS 13+ requires a
 *      user-gesture permission grant via `requestPermission()`; we wire
 *      that to the canvas's first click after a sensor cart loads.
 *   2. Keyboard tilt bindings (default I/J/K/L) — desktop fallback.
 *      Distinct keyspace from the D-pad so the two input intents don't
 *      collide; user-rebindable via Settings → Controls → Keyboard.
 */

let started = false;
let motionSample: { x: number; y: number } | null = null;
const keyboardAxes = { x: 0, y: 0 };

/** Arm keyboard + best-effort DeviceMotion listening. Idempotent. On
 *  iOS the motion listener attaches but won't fire until a user gesture
 *  triggers `requestMotionPermission()`. */
export function startTilt(): void {
  if (started) return;
  started = true;

  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  if (typeof DeviceMotionEvent !== "undefined") {
    type WithPermission = {
      requestPermission?: () => Promise<"granted" | "denied" | "default">;
    };
    const ctor = DeviceMotionEvent as unknown as WithPermission;
    if (typeof ctor.requestPermission !== "function") {
      // Android / non-iOS: motion fires without a permission gate.
      window.addEventListener("devicemotion", onMotion);
    }
  }
}

/** iOS-only: must be called from inside a user-gesture handler.
 *  Returns true if motion is now streaming (or already was). */
export async function requestMotionPermission(): Promise<boolean> {
  if (typeof DeviceMotionEvent === "undefined") return false;
  type WithPermission = {
    requestPermission?: () => Promise<"granted" | "denied" | "default">;
  };
  const ctor = DeviceMotionEvent as unknown as WithPermission;
  if (typeof ctor.requestPermission !== "function") {
    window.addEventListener("devicemotion", onMotion);
    return true;
  }
  try {
    const result = await ctor.requestPermission();
    if (result === "granted") {
      window.addEventListener("devicemotion", onMotion);
      return true;
    }
  } catch {
    // Caller is allowed to ignore failure; tilt just falls back to
    // keyboard until the user retries.
  }
  return false;
}

function onKey(e: KeyboardEvent): void {
  // Skip when typing into a form field — same convention as keyboard.ts.
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
  // Re-read bindings on every keypress so user rebinds via the
  // Controls editor take effect immediately (no subscription dance).
  const tilt = loadTiltBindings();
  const codeToDir: Record<string, TiltDirection> = {};
  for (const dir of ["tiltForward", "tiltBack", "tiltLeft", "tiltRight"] as const) {
    if (tilt[dir]) codeToDir[tilt[dir]] = dir;
  }
  mirrorModifierPairs(codeToDir);
  const dir = codeToDir[e.code];
  if (!dir) return;
  const pressed = e.type === "keydown";
  switch (dir) {
    case "tiltLeft":
      keyboardAxes.x = pressed ? -1 : 0;
      break;
    case "tiltRight":
      keyboardAxes.x = pressed ? +1 : 0;
      break;
    case "tiltForward":
      keyboardAxes.y = pressed ? +1 : 0;
      break;
    case "tiltBack":
      keyboardAxes.y = pressed ? -1 : 0;
      break;
  }
}

function onMotion(e: DeviceMotionEvent): void {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x === null || g.y === null) return;
  // Convert m/s² → g. Phone held landscape with the home button on the
  // right: tilting the right edge down increases gx; tilting the top
  // edge away from the player decreases gy. We negate gx so a "tilt
  // right" reads as +x, and negate gy so "tilt forward" reads as +y.
  motionSample = {
    x: -(g.x ?? 0) / 9.81,
    y: -(g.y ?? 0) / 9.81
  };
}

/** Snapshot the current tilt. Cart calls this at the 0x55→0xAA latch.
 *  Keyboard wins whenever a tilt key is held — some desktop browsers
 *  fire `devicemotion` events with all-zero values from non-existent
 *  sensors, which would otherwise pin `motionSample` to {0,0} and
 *  lock the keyboard out entirely. DeviceMotion is the fallback when
 *  no key is held and the motion stream has actually produced a
 *  sample. */
export function readTilt(): { x: number; y: number } {
  if (keyboardAxes.x !== 0 || keyboardAxes.y !== 0) {
    return { x: keyboardAxes.x, y: keyboardAxes.y };
  }
  return motionSample ?? { x: 0, y: 0 };
}

/** Single-axis angular velocity around Z, in [-1, +1] units. Used by
 *  the GBA gyroscope cart (WarioWare: Twisted). Reuses the same
 *  keyboard X-axis the accelerometer cart maps from: hold the
 *  "tilt right" key for clockwise rotation, "tilt left" for anti-
 *  clockwise. Y-axis input is meaningless for a Z-rotation sensor so
 *  the function ignores it. */
export function readGyroscope(): number {
  // The gyroscope chip measures a RATE: `±1.0` is full-scale 300°/sec.
  // At full rate a held key makes WarioWare Twisted's menu cursor fly
  // past every option in under a frame — even after the cart's own
  // baseline calibration, the cursor integrates rotation aggressively.
  // 0.1 (≈30°/sec) gives the menu carousel enough time to land on
  // each option as the user holds the key, and a brief tap moves one
  // step at a time. The scale only applies to keyboard input;
  // DeviceMotion samples are already in real-rate units so they get
  // through unmodified. (Empirically tuned with WarioWare Twisted!'s
  // menu — important to reset the cart after changing this so the
  // cart's boot-time gyro baseline calibrates against the new value.)
  if (keyboardAxes.x !== 0) return keyboardAxes.x * 0.1;
  return motionSample?.x ?? 0;
}

/** Default ambient brightness — bright daylight, enough for Boktai's
 *  Solar Gun to charge but not maxed. Picked so a player who loads the
 *  cart without touching the Settings slider gets playable gameplay
 *  immediately. */
export const DEFAULT_SOLAR_BRIGHTNESS = 0.7;

let solarBrightnessCache = DEFAULT_SOLAR_BRIGHTNESS;

/** Settings panel calls this whenever the Solar Brightness slider
 *  changes (and once at boot, to seed from localStorage). Kept as a
 *  function rather than re-exporting the variable so callers can't
 *  accidentally clone it and miss subsequent updates. */
export function setSolarBrightnessCache(brightness: number): void {
  solarBrightnessCache = brightness;
}

/** Ambient luminance for the Boktai cart-side photodiode, in `[0, 1]`.
 *  0 = pitch black (cart calibration), 1 = direct sun. Sampled by the
 *  cart's GPIO solar sensor on each counter-reset pulse. */
export function readSolarBrightness(): number {
  return solarBrightnessCache;
}
