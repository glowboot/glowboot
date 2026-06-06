/**
 * Synthesized call stack for the debugger.
 *
 * The real LR35902 has no notion of frames — it's just a stack pointer
 * and bytes in memory. We infer the logical call chain by watching the
 * four instruction families that push/pop a return address:
 *
 *   CALL / CALLcc        push
 *   RST n                push
 *   IRQ dispatch         push (serviceInterrupt in cpu.ts)
 *   RET / RETI / RETcc   pop
 *
 * This covers the common case. It fails on:
 *   - Manual `PUSH BC / POP BC` style games that use PUSH-RET for jump
 *     tables (Pokémon G/S does this). The pop has no matching frame in
 *     our list, so we just clear down to the unwind point.
 *   - Save-state loads mid-execution (the SP is restored but we have no
 *     history) — `clear()` is called on load to reset.
 *   - STOP / unusual control flow that never returns (we just grow
 *     unbounded; `MAX_DEPTH` caps it).
 *
 * The stack is process-global, mirroring the breakpoint registry.
 */

type FrameKind = "call" | "rst" | "irq";

export interface CallFrame {
  /** Address of the CALL/RST/IRQ instruction itself (where the push happened). */
  callSite: number;
  /** Address the RET will return to (PC right after the CALL, or the post-IRQ PC). */
  returnAddr: number;
  kind: FrameKind;
}

const MAX_DEPTH = 256;

const frames: CallFrame[] = [];

export function notePush(frame: CallFrame): void {
  if (frames.length >= MAX_DEPTH) {
    // Shift the oldest entry out rather than drop the new one — the top
    // of the stack is the interesting part for debugging.
    frames.shift();
  }
  frames.push(frame);
}

/**
 * Called on RET/RETI/RETcc taken. Pops the top frame if one exists.
 * Returns the popped frame or null. Divergence (the popped return
 * address not matching our stored `returnAddr`) is possible for the
 * PUSH-RET trick — just remove the frame anyway; the tracker is a
 * best-effort view.
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
