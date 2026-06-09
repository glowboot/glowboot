/**
 * AI-play (experimental) — a closed-loop agent that drives the joypad from
 * what's on screen: capture frame → ask the vision model for the next input
 * → hold that button for N frames → repeat.
 *
 * It runs step-and-decide, NOT real-time: each decision is a (~seconds) model
 * call, so the game advances in bursts at the AI's thinking speed. Works best
 * on slow / turn-based games; twitch platformers will flail. Reuses the
 * bring-your-own AI-assist endpoint, so it's opt-in and costs the user's own
 * API budget — hence the hard MAX_STEPS cap and the explicit Stop.
 */

import { type Button } from "../../gb";
import { type GbaButton, parseGbaHeader } from "../../gba";
import { stopPacing } from "../session/pacing.js";
import { pauseGbaSession } from "../session/runtime-gba.js";
import { renderer, setPaused, state } from "../state.js";
import { askPlan, type PlayButton, type PlayPlan, preferredAnswerLang } from "./assist.js";

/** Safety cap so a runaway loop can't burn the user's API budget unbounded. */
const MAX_STEPS = 300;
/** Emulator frames advanced per repaint during an action — >1 fast-forwards
 *  the gameplay between decisions so it plays quicker while still animating. */
const FRAMES_PER_PAINT = 4;
/** Rolling save-state snapshots kept so the model can "rewind" out of a
 *  mistake. AI-play steps frames manually (bypassing the normal rewind
 *  buffer), so it keeps its own ring. Capped to bound memory. */
const SNAPSHOT_CAP = 40;
/** How many recent decisions a single "rewind" undoes. One snapshot per
 *  decision = per plan (a few moves each), so this is in plans, not single
 *  inputs — a handful jumps well clear of the mistake. Rewind again if not. */
const REWIND_MOVES = 4;
/** Buttons the GB joypad accepts (GBA additionally has l / r). */
const GB_BUTTONS = new Set<string>(["up", "down", "left", "right", "a", "b", "start", "select"]);

export interface AiPlayHooks {
  /** `appliedHint` is the player hint consumed by this decision (one-shot),
   *  so the UI can clear it once it's been taken into account. */
  onStep: (info: { step: number; plan: PlayPlan; frameUrl: string; appliedHint?: string }) => void;
  onError: (message: string) => void;
  /** `frameUrl` is the CURRENT frame at stop (the game advanced during play),
   *  so the caller can refresh its view instead of showing a stale capture. */
  onStop: (frameUrl: string) => void;
}

let playing = false;
/** Live player guidance, fed into the NEXT decision then consumed (one-shot).
 *  Set from the UI while the agent plays. */
let currentHint = "";
/** Persistent objective the agent works toward every decision until changed. */
let currentGoal = "";
export function isAiPlaying(): boolean {
  return playing;
}
export function setAiHint(hint: string): void {
  currentHint = hint.trim();
}
export function setAiGoal(goal: string): void {
  currentGoal = goal.trim();
}
export function stopAiPlay(): void {
  playing = false; // the loop checks this and exits; its finally() cleans up
}

function activeFramebuffer(): Uint8ClampedArray<ArrayBuffer> | null {
  if (state.gb) return state.gb.ppu.framebuffer;
  if (state.gba) return state.gba.framebuffer;
  return null;
}
function stepActive(): void {
  if (state.gb) state.gb.stepFrame();
  else state.gba?.stepFrame();
}
function pressActive(button: PlayButton): void {
  if (button === "none") return;
  if (state.gb) {
    if (GB_BUTTONS.has(button)) state.gb.joypad.press(button as Button);
  } else if (state.gba) {
    state.gba.joypad.press(button as GbaButton); // every non-"none" button is a valid GBA input
  }
}
function releaseAllActive(): void {
  state.gb?.joypad.releaseAll();
  state.gba?.joypad.releaseAll();
}
function saveSnapshot(): Uint8Array | null {
  return state.gb ? state.gb.saveState() : (state.gba?.saveState() ?? null);
}
function loadSnapshot(blob: Uint8Array): void {
  state.gb?.loadState(blob);
  state.gba?.loadState(blob);
}

function captureUrl(): string {
  const fb = activeFramebuffer()!;
  const w = state.gb ? 160 : 240;
  const h = state.gb ? 144 : 160;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(fb.subarray(0, w * h * 4)), w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Start the agent loop. Takes over the run loop (pauses normal pacing and
 *  steps frames itself between decisions). Resolves when it stops. */
export async function startAiPlay(hooks: AiPlayHooks): Promise<void> {
  if (playing || !activeFramebuffer()) return;
  playing = true;
  currentHint = ""; // fresh session
  if (state.gb) stopPacing();
  else pauseGbaSession();
  setPaused(true);

  const title = state.gb ? state.gb.cart.title || "" : state.gba ? parseGbaHeader(state.gba.mem.rom).title : "";
  const history: string[] = [];
  const snapshots: Uint8Array[] = []; // oldest → newest; one per decision
  let memory = ""; // the model's scratchpad, carried decision to decision
  let step = 0;
  try {
    while (playing && step < MAX_STEPS) {
      // Snapshot the state the model is about to look at, so a later "rewind"
      // can undo back to here.
      const snap = saveSnapshot();
      if (snap) {
        snapshots.push(snap);
        if (snapshots.length > SNAPSHOT_CAP) snapshots.shift();
      }

      const frameUrl = captureUrl();
      const appliedHint = currentHint; // consume one-shot: this decision uses it, then it's gone
      currentHint = "";
      let plan: PlayPlan;
      try {
        plan = await askPlan({
          imageDataUrl: frameUrl,
          gameTitle: title,
          history,
          hint: appliedHint || undefined,
          goal: currentGoal || undefined,
          memory: memory || undefined,
          responseLang: preferredAnswerLang()?.name
        });
      } catch (err) {
        console.warn("[AI-play] decision failed:", err);
        hooks.onError("AI request failed — check the provider/key in Settings.");
        break;
      }
      if (!playing) break;
      memory = plan.memory || memory; // carry the scratchpad forward (keep prior if blank)
      step++;
      hooks.onStep({ step, plan, frameUrl, appliedHint: appliedHint || undefined });
      history.push(`${plan.steps.map((s) => `${s.button}×${s.frames}`).join(", ")}: ${plan.reason}`.slice(0, 120));
      if (history.length > 6) history.shift();

      // Execute the planned inputs in order. A 'rewind' step undoes up to
      // REWIND_MOVES recent decisions and abandons the rest of the plan — the
      // next loop re-plans from the rewound state.
      for (const planStep of plan.steps) {
        if (!playing) break;
        if (planStep.button === "rewind") {
          const back = Math.min(REWIND_MOVES, snapshots.length - 1);
          if (back > 0) {
            loadSnapshot(snapshots[snapshots.length - 1 - back]!);
            snapshots.splice(snapshots.length - back); // drop the undone snapshots
            releaseAllActive();
            renderer.render(activeFramebuffer()!);
          }
          break;
        }
        // Hold the button for its frames, fast-forwarding (FRAMES_PER_PAINT
        // emulator frames per repaint) so it plays quickly but still animates.
        releaseAllActive();
        pressActive(planStep.button);
        for (let i = 0; i < planStep.frames && playing; i++) {
          stepActive();
          if ((i + 1) % FRAMES_PER_PAINT === 0) {
            renderer.render(activeFramebuffer()!);
            await nextFrame();
          }
        }
        renderer.render(activeFramebuffer()!); // show the frame after this step
        releaseAllActive();
      }
    }
  } finally {
    releaseAllActive();
    playing = false;
    hooks.onStop(activeFramebuffer() ? captureUrl() : "");
  }
}
