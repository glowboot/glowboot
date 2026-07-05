/**
 * Synthesised call stack for the SNES debugger.
 *
 * The 65C816 has real subroutine instructions, so unlike the ARM
 * tracker this one instruments exact opcode pairs:
 *
 *   JSR abs / JSR (abs,X)   push   — same-bank call, RTS returns
 *   JSL long                push   — cross-bank call, RTL returns
 *   RTS / RTL               pop
 *
 * Still best-effort: hand-rolled dispatch (push address + RTS) or a
 * cart that unwinds the stack manually will desync the tracker. The
 * user reads the list as "what call chain got us here", not ground
 * truth — same trade-off as the GB / GBA trackers.
 *
 * Process-global, mirrors the shape of the other engines' modules.
 */

export type SnesFrameKind = "jsr" | "jsl";

export interface SnesCallFrame {
  /** 24-bit `(pbr << 16) | pc` of the JSR / JSL opcode byte. */
  from: number;
  /** 24-bit call target. */
  to: number;
  /** Emulation flag at call time (RTS/RTL stack widths differ by mode). */
  e: number;
  kind: SnesFrameKind;
}

const MAX_DEPTH = 64;
const frames: SnesCallFrame[] = [];

export function notePushSnes(frame: SnesCallFrame): void {
  if (frames.length >= MAX_DEPTH) {
    frames.shift();
  }
  frames.push(frame);
}

export function notePopSnes(): SnesCallFrame | null {
  return frames.pop() ?? null;
}

export function frameListSnes(): readonly SnesCallFrame[] {
  return frames;
}

export function clearAllSnesFrames(): void {
  frames.length = 0;
}
