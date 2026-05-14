import type { Button, Joypad } from "../../gb";
import { type GamepadBinding, type GamepadBindings, GB_BUTTONS, loadGamepadBindings } from "./bindings.js";
import { safeVibrate } from "./haptic.js";

/**
 * Web Gamepad API integration.
 *
 * The Gamepad API is poll-only (no button events), so we read state every
 * `requestAnimationFrame` tick and diff against the previous snapshot to turn
 * edges into `Joypad.press` / `Joypad.release` calls.
 *
 * Mapping comes from the user-configurable bindings in `bindings.ts`. The
 * defaults match the W3C "standard" gamepad layout (Chrome/Edge auto-apply
 * this for most modern controllers); users with a non-standard pad rebind
 * via the Settings popover, captured through `captureNext()`.
 *
 * Browser quirks worth knowing:
 *  - Chrome / Edge: a gamepad is hidden from `navigator.getGamepads()` until
 *    the user presses a button on it **while the page has focus**.
 */

/** Analog-stick value beyond this magnitude counts as a press. */
const AXIS_DEADZONE = 0.5;
/** Half-window used to match a captured POV-hat sector value against the
 *  current axis reading. Sector spacing on a typical 8-way hat is ≈ 0.286,
 *  so 0.15 cleanly resolves a single sector without bleeding into neighbours. */
const POV_TOLERANCE = 0.15;
/** Axis baselines outside the [-1, 1] range identify POV-hat axes (which
 *  rest at e.g. 1.28). Capture stores the literal value for these. */
const POV_REST_MIN_ABS = 1.1;

export class GamepadInput {
  private joypad: Joypad | null = null;
  private rafId = 0;
  private running = false;
  private loggedFirstSight = false;
  private bindings: GamepadBindings = loadGamepadBindings();

  /** Tracks active sources so one Game Boy button can be held by multiple
   *  physical inputs without releasing prematurely. */
  private readonly pressed = new Set<string>();

  /** When non-null, the next button-press / significant axis movement is
   *  reported here instead of being dispatched to the joypad. Set by the
   *  bindings UI when the user is rebinding. */
  private captureCallback: ((b: GamepadBinding) => void) | null = null;
  /** Snapshot of axis values when capture mode started — needed because
   *  some POV-hat axes rest at non-zero values (e.g. +1.28 = "centered"). */
  private captureBaseline: { axes: Map<string, number>; buttons: Map<string, boolean> } | null = null;

  constructor() {
    window.addEventListener("gamepadconnected", (e) => {
      console.debug(
        `[Gamepad] connected #${e.gamepad.index}: "${e.gamepad.id}" ` +
          `(mapping: "${e.gamepad.mapping || "(non-standard)"}", ` +
          `${e.gamepad.buttons.length} buttons, ${e.gamepad.axes.length} axes)`
      );
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      console.debug(`[Gamepad] disconnected #${e.gamepad.index}`);
    });
  }

  /** Refresh from localStorage — call after the bindings UI saves. */
  refreshBindings(): void {
    this.bindings = loadGamepadBindings();
    this.releaseAll();
  }

  /**
   * Capture the next button press / axis movement from any connected pad and
   * deliver it as a {@link GamepadBinding}. Returns a cancel function.
   */
  captureNext(callback: (binding: GamepadBinding) => void): () => void {
    this.captureCallback = callback;
    this.captureBaseline = null; // (re)snapshot on next poll
    return () => {
      this.captureCallback = null;
      this.captureBaseline = null;
    };
  }

  bind(joypad: Joypad): void {
    this.joypad = joypad;
  }

  unbind(): void {
    this.releaseAll();
    this.joypad = null;
    // Cut any ongoing rumble — switching ROMs or pausing shouldn't
    // leave the motor spinning because the outgoing cart was in the
    // middle of a rumble pulse. `setRumble` only flips the flag, so
    // fire `applyRumble` synchronously here; the rAF poll that would
    // normally pick up the flag has either been cancelled (stop) or
    // may not run before the user notices a stuck motor.
    this.setRumble(false);
    this.forceRumbleReset();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      try {
        this.poll();
      } catch (err) {
        console.error("[Gamepad] poll error:", err);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.releaseAll();
    this.setRumble(false);
    this.forceRumbleReset();
  }

  // ─── Rumble ──────────────────────────────────────────────────────────
  // MBC5-rumble carts toggle a motor bit via writes to the RAM-bank
  // register (see Cartridge.onRumbleChange). Games like Pokémon Pinball
  // hammer that write many times per frame, so the cart's change hook
  // has to be cheap — no Gamepad API access on the hot path. `setRumble`
  // just flips a flag; the already-running rAF poll loop reads it and
  // schedules / resets the vibration actuator at most once per frame.
  //
  // Audio-reactive rumble runs alongside MBC5 rumble: a bass-energy
  // envelope from `AudioOutput` is sampled in the rAF loop and blended
  // with the cart signal via max(), so either source can drive the
  // motor and both together don't clip past 1.0.
  private rumbleActive = false;

  /** Wall-clock time at which the next `playEffect` re-pulse is due.
   *  Gamepad-API effects cap at a few seconds; we re-issue short
   *  pulses so the magnitude can track audio peaks when audio-reactive
   *  rumble is driving. */
  private rumbleReplayAt = 0;
  /** Tracks whether `reset()` needs to be fired on the next off-edge —
   *  avoids calling it every frame while the motor is already stopped. */
  private rumbleEngaged = false;
  /** User preference for audio-reactive rumble. When false, the audio
   *  envelope is ignored and only MBC5 cart rumble drives the motor. */
  private audioRumbleEnabled = false;
  /** Overall gain on the audio-rumble magnitude (0..1). The settings
   *  slider exposes this as "strength"; internal code multiplies the
   *  post-gate envelope by this factor. */
  private audioRumbleStrength = 0.5;
  /** Sampled once per poll from the attached audio source, if any. */
  private audioEnvelopeSource: (() => number) | null = null;

  /** Toggle audio-reactive rumble. Stops any in-flight audio pulse
   *  immediately on disable — MBC5 cart rumble (if active) will be
   *  re-armed on the next poll tick. */
  setAudioRumbleEnabled(on: boolean): void {
    this.audioRumbleEnabled = on;
    if (!on && !this.rumbleActive) this.forceRumbleReset();
  }

  /** Scale factor (0..1) applied to the audio-rumble magnitude. 0 is
   *  effectively off; higher values produce stronger vibration for
   *  the same channel envelope. Clamped on set so a stray out-of-
   *  range value never overdrives the motor. */
  setAudioRumbleStrength(factor: number): void {
    this.audioRumbleStrength = factor < 0 ? 0 : factor > 1 ? 1 : factor;
  }

  /** Provide a callback the poll loop samples each frame to read the
   *  current audio envelope magnitude in [0, 1]. Pass null to detach. */
  setAudioEnvelopeSource(src: (() => number) | null): void {
    this.audioEnvelopeSource = src;
  }

  /** Signal that rumble should be on / off. Cheap and synchronous: the
   *  actual Gamepad API work is deferred to the next poll tick. */
  setRumble(on: boolean): void {
    this.rumbleActive = on;
    if (on) this.rumbleReplayAt = 0; // force immediate first pulse on next poll
  }

  /** Immediate off — for `stop` / `unbind` paths where the rAF poll
   *  is about to be cancelled and the deferred teardown wouldn't run.
   *  Bypasses the `rumbleEngaged` gate so even a freshly-disabled motor
   *  that hasn't yet been touched gets a `reset()` call. */
  private forceRumbleReset(): void {
    if (typeof navigator.getGamepads === "function") {
      for (const pad of navigator.getGamepads()) {
        const actuator = (pad as (Gamepad & { vibrationActuator?: GamepadHapticActuator }) | null)?.vibrationActuator;
        if (actuator && typeof actuator.reset === "function") {
          void actuator.reset().catch(() => {
            /* ignore */
          });
        }
      }
    }
    // Cancel any in-flight mobile-device vibration too. The Vibration
    // API is Android-only (iOS Safari doesn't support it) and accepts
    // `vibrate(0)` as the universal "stop now" call.
    safeVibrate(0);
    this.rumbleEngaged = false;
  }

  private applyRumble(pads: (Gamepad | null)[]): void {
    // Cart rumble is a single bit → magnitude 1.0 when on. Audio
    // rumble is a continuous 0..1 value with a small noise gate so
    // ambient sine tones (title-screen drones, menu beeps) don't
    // wobble the motor. Above the gate, we expand the usable range
    // so even a moderate bass hit feels punchy.
    const cartMag = this.rumbleActive ? 1.0 : 0.0;
    let audioMag = 0;
    if (this.audioRumbleEnabled && this.audioEnvelopeSource) {
      const env = this.audioEnvelopeSource();
      // Strength acts as a *sensitivity* knob, not a magnitude scaler.
      // Many platforms (mobile vibration, several gamepad drivers)
      // ignore fractional magnitudes and fire at full strength once
      // above zero, which made magnitude-scaled approaches feel
      // identical at 5 % and 100 %. Reframing as "lower strength →
      // higher activation threshold → fewer pulses" works uniformly
      // because skipping a pulse is universal.
      //
      // The threshold rises quadratically as strength drops, so the
      // upper half of the slider keeps triggering on most audio peaks
      // while the lower half progressively tightens to bass-hits-only:
      //
      //   strength 1.0  → threshold 0.15 (every audio peak triggers)
      //   strength 0.75 → threshold ~0.20 (still very responsive)
      //   strength 0.50 → threshold ~0.36 (louder-than-average peaks)
      //   strength 0.25 → threshold ~0.63 (notable peaks only)
      //   strength 0.05 → threshold ~0.92 (loudest peaks only)
      //   strength 0.0  → threshold 1.0 (effectively off)
      //
      // Magnitude when fired scales with how far the peak overshoots
      // the threshold, clipped to the ceiling so good gamepads still
      // perceive a proportional intensity ramp on top of the rate
      // change.
      const AUDIO_GATE = 0.15;
      const AUDIO_CEILING = 0.8;
      const drop = 1 - this.audioRumbleStrength;
      const threshold = AUDIO_GATE + drop * drop * (1 - AUDIO_GATE);
      if (env > threshold) {
        const overshoot = (env - threshold) / (1 - threshold);
        audioMag = overshoot > AUDIO_CEILING ? AUDIO_CEILING : overshoot;
      }
    }
    const mag = cartMag > audioMag ? cartMag : audioMag;

    if (mag > 0) {
      const now = performance.now();
      if (now < this.rumbleReplayAt) return;
      // Short pulses when audio-driven so magnitude tracks peaks;
      // longer when cart-driven since the bit is stable.
      const duration = cartMag >= audioMag ? 1000 : 180;
      const gap = cartMag >= audioMag ? 800 : 100;
      for (const pad of pads) {
        const actuator = (pad as (Gamepad & { vibrationActuator?: GamepadHapticActuator }) | null)?.vibrationActuator;
        if (!actuator || typeof actuator.playEffect !== "function") continue;
        actuator
          .playEffect("dual-rumble", {
            // Drive both motors at the same magnitude. Some pad /
            // driver combos (Stadia, certain Bluetooth DualShock
            // setups) ignore sub-1.0 signals, so cart rumble is
            // pinned to 1.0 upstream for maximum compatibility;
            // audio rumble accepts the attenuation on those pads as
            // the price of continuous dynamics.
            startDelay: 0,
            duration,
            weakMagnitude: mag,
            strongMagnitude: mag
          })
          .catch(() => {
            /* ignore — browser may reject if tab is backgrounded */
          });
      }
      // Mobile-device vibration — Android phones expose the Vibration
      // API and ignore it on desktop. No intensity control: we issue a
      // pulse slightly longer than the replay gap so re-issues feel
      // continuous rather than staccato. Cart rumble gets the full
      // 1000 ms pulse matching the gamepad duration; audio rumble
      // scales its pulse length by magnitude so quieter peaks feel
      // softer (shorter) than bass hits.
      const vibeMs = cartMag >= audioMag ? duration : Math.max(30, Math.round(mag * 150));
      safeVibrate(vibeMs);
      this.rumbleEngaged = true;
      this.rumbleReplayAt = now + gap;
    } else if (this.rumbleEngaged) {
      for (const pad of pads) {
        const actuator = (pad as (Gamepad & { vibrationActuator?: GamepadHapticActuator }) | null)?.vibrationActuator;
        if (actuator && typeof actuator.reset === "function") {
          void actuator.reset().catch(() => {
            /* ignore */
          });
        }
      }
      safeVibrate(0);
      this.rumbleEngaged = false;
    }
  }

  private poll(): void {
    if (typeof navigator.getGamepads !== "function") return;
    const pads = navigator.getGamepads();

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad) continue;

      if (!this.loggedFirstSight) {
        this.loggedFirstSight = true;
        console.debug(`[Gamepad] polling active for #${pad.index} "${pad.id}"`);
      }

      if (this.captureCallback) {
        this.tryCapture(pad);
        continue; // suspend normal binding application while capturing
      }
      const joypad = this.joypad;
      if (joypad) this.applyBindings(joypad, pad);
    }
    // Apply the pending rumble state at most once per rAF tick,
    // regardless of how many times the cart toggled the motor bit
    // during the CPU's intervening frame. Keeps the Gamepad API off
    // the emulator's hot path.
    this.applyRumble(pads as (Gamepad | null)[]);
  }

  private applyBindings(joypad: Joypad, pad: Gamepad): void {
    for (const gb of GB_BUTTONS) {
      const b = this.bindings[gb];
      // Cleared bindings (null) never fire — the user can leave a
      // face button unmapped and re-add it later via the editor.
      const active = b !== null && isBindingActive(pad, b);
      this.apply(joypad, `${pad.index}:${gb}`, gb, active);
    }
  }

  private tryCapture(pad: Gamepad): void {
    if (!this.captureBaseline) {
      const axes = new Map<string, number>();
      const buttons = new Map<string, boolean>();
      for (let a = 0; a < pad.axes.length; a++) axes.set(`${pad.index}:a${a}`, pad.axes[a] ?? 0);
      for (let b = 0; b < pad.buttons.length; b++) buttons.set(`${pad.index}:b${b}`, pad.buttons[b]!.pressed);
      this.captureBaseline = { axes, buttons };
      return;
    }
    // Button transitions to pressed.
    for (let b = 0; b < pad.buttons.length; b++) {
      const key = `${pad.index}:b${b}`;
      const prev = this.captureBaseline.buttons.get(key) === true;
      const now = pad.buttons[b]!.pressed;
      if (now && !prev) {
        this.captureCallback?.({ type: "button", index: b });
        return;
      }
    }
    // Axis movement past deadzone from baseline. POV-hat axes (rest > 1)
    // additionally store the literal value so different sectors of the same
    // axis don't collapse to the same sign-only binding.
    for (let a = 0; a < pad.axes.length; a++) {
      const key = `${pad.index}:a${a}`;
      const base = this.captureBaseline.axes.get(key) ?? 0;
      const now = pad.axes[a] ?? 0;
      const delta = now - base;
      if (Math.abs(delta) > AXIS_DEADZONE) {
        const sign: -1 | 1 = delta > 0 ? 1 : -1;
        if (Math.abs(base) > POV_REST_MIN_ABS) {
          this.captureCallback?.({ type: "axis", index: a, sign, value: now });
        } else {
          this.captureCallback?.({ type: "axis", index: a, sign });
        }
        return;
      }
    }
  }

  private apply(joypad: Joypad, src: string, button: Button, active: boolean): void {
    const wasPressed = this.pressed.has(src);
    if (active && !wasPressed) {
      joypad.press(button);
      this.pressed.add(src);
    } else if (!active && wasPressed) {
      joypad.release(button);
      this.pressed.delete(src);
    }
  }

  private releaseAll(): void {
    const joypad = this.joypad;
    if (joypad && this.pressed.size > 0) {
      joypad.release("a");
      joypad.release("b");
      joypad.release("start");
      joypad.release("select");
      joypad.release("up");
      joypad.release("down");
      joypad.release("left");
      joypad.release("right");
    }
    this.pressed.clear();
  }
}

function isBindingActive(pad: Gamepad, b: GamepadBinding): boolean {
  if (b.type === "button") {
    return pad.buttons[b.index]?.pressed === true;
  }
  const v = pad.axes[b.index] ?? 0;
  if (b.value !== undefined) {
    // POV-hat sector — narrow band around the captured value.
    return Math.abs(v - b.value) < POV_TOLERANCE;
  }
  return b.sign > 0 ? v > AXIS_DEADZONE : v < -AXIS_DEADZONE;
}
