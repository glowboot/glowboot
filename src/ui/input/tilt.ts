import { loadTiltBindings, mirrorModifierPairs, type TiltDirection } from "./bindings.js";

/**
 * Tilt input source for MBC7 carts (Kirby Tilt 'n' Tumble).
 *
 * Returns axes in roughly `[-1, +1]` g-units where `+x` is east tilt and
 * `+y` is north tilt (player-forward). The cart's read path scales these
 * by `0x70` per g and adds the `0x81D0` rest value.
 *
 * Sources, polled in priority order:
 *   1. DeviceMotionEvent — phones / tablets. iOS 13+ requires a
 *      user-gesture permission grant via `requestPermission()`; we wire
 *      that to the canvas's first click after an MBC7 cart loads.
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
 *  DeviceMotion takes priority when streaming; otherwise keyboard. */
export function readTilt(): { x: number; y: number } {
  return motionSample ?? { x: keyboardAxes.x, y: keyboardAxes.y };
}
