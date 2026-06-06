/**
 * Synthesised call stack for the GBA debugger.
 *
 * ARM7TDMI has no hardware notion of frames — calls go via "Branch
 * with Link" (BL on ARM, BL-pair on Thumb) which writes LR; returns
 * are conventional uses of BX/POP/MOV pc, lr. We infer the logical
 * call chain by instrumenting just the load-bearing push/pop sites:
 *
 *   BL (ARM)               push       — `arm.ts executeBranch`
 *   BL pair (Thumb)        push       — `thumb.ts` Format 19 (second)
 *   IRQ dispatch           push       — `cpu.ts takeIrq` / HLE entry
 *   BX Rn (ARM + Thumb)    pop        — `arm.ts executeBx`, `thumb.ts` Fmt 5
 *   LDM* {..., pc}         pop        — `arm.ts` block-transfer w/ PC
 *   POP {..., pc} (Thumb)  pop        — `thumb.ts` Format 14 R=1
 *
 * False positives are inevitable — a `BX r0` to an arbitrary jump
 * table pops a frame whether or not the target was a real return.
 * The GB tracker accepts the same trade-off; the user reads the
 * stack as "what BL chain got us here, best effort", not as ground
 * truth.
 *
 * Process-global, mirrors the GB module's shape and the GBA
 * breakpoint registry.
 */

export type GbaFrameKind = "call" | "irq";

export interface GbaCallFrame {
  /** Address of the BL / Thumb-BL / IRQ entry that pushed this frame. */
  callSite: number;
  /** Where the conventional return would land — PC immediately after
   *  the linking instruction, or post-IRQ-handler PC. Used to nudge
   *  pop accuracy when later confirming a return matched expectations. */
  returnAddr: number;
  kind: GbaFrameKind;
}

const MAX_DEPTH = 256;
const frames: GbaCallFrame[] = [];

export function notePushGba(frame: GbaCallFrame): void {
  if (frames.length >= MAX_DEPTH) {
    frames.shift();
  }
  frames.push(frame);
}

export function notePopGba(): GbaCallFrame | null {
  return frames.pop() ?? null;
}

export function frameListGba(): readonly GbaCallFrame[] {
  return frames;
}

export function clearAllGbaFrames(): void {
  frames.length = 0;
}
