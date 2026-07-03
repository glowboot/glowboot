/**
 * Synthesized call stack for the debugger.
 *
 * The 6502 has no notion of frames — it's just a stack pointer and bytes in
 * page 1. We infer the logical call chain by watching the instruction families
 * that push/pop a return address:
 *
 *   JSR                 push
 *   BRK                 push (software interrupt)
 *   IRQ dispatch        push (maskable, mapper / APU)
 *   NMI dispatch        push (V-Blank)
 *   RTS / RTI           pop
 *
 * This covers the common case. It fails on:
 *   - Manual `PHA … RTS` jump tables (the pop has no matching frame; we just
 *     unwind to the nearest one).
 *   - Save-state loads mid-execution (the SP is restored but we have no
 *     history) — `clear()` is called on load to reset.
 *   - Routines that never return (we just grow; `MAX_DEPTH` caps it).
 *
 * The stack is process-global, mirroring the breakpoint registry.
 */

type FrameKind = "jsr" | "brk" | "irq" | "nmi";

export interface CallFrame {
  /** Address of the JSR/BRK instruction, or the handler entry for IRQ/NMI. */
  callSite: number;
  /** Address the RTS/RTI returns to. */
  returnAddr: number;
  kind: FrameKind;
}

const MAX_DEPTH = 256;

const frames: CallFrame[] = [];

export function notePush(frame: CallFrame): void {
  if (frames.length >= MAX_DEPTH) {
    // Shift the oldest entry out rather than drop the new one — the top of the
    // stack is the interesting part for debugging.
    frames.shift();
  }
  frames.push(frame);
}

/**
 * Called on RTS/RTI taken. Pops the top frame if one exists. Returns the popped
 * frame or null. Divergence (the popped return address not matching our stored
 * `returnAddr`) is possible for the PHA/RTS trick — just remove the frame
 * anyway; the tracker is a best-effort view.
 */
export function notePop(): CallFrame | null {
  return frames.pop() ?? null;
}

export function frameList(): readonly CallFrame[] {
  return frames;
}

export function clear(): void {
  frames.length = 0;
}
