/**
 * GBA BIOS high-level emulation (SWI dispatcher).
 *
 * The real GBA BIOS exposes ~30 functions via `SWI N`. We re-implement
 * the ones real games actually call, in TypeScript, so we don't have
 * to ship Nintendo BIOS code. Unknown SWIs fall through to the
 * standard ARM SVC exception entry — they land at PC=0x08 in the
 * zero-filled BIOS region and silently NOP-slide. (Real BIOS would
 * dispatch them; if a future ROM needs an unimplemented SWI, add it
 * to the switch below.)
 *
 * Function-number convention:
 *   ARM:    `swi #0xNN0000` — number is bits 23-16 of the instruction.
 *   Thumb:  `swi #0xNN`     — number is bits 7-0.
 * Both dispatch through the same `dispatchSwi(number)` here; the
 * decoder hands over the 8-bit function id.
 *
 * Calling convention (per GBATEK):
 *   Inputs come in r0-r3; outputs in r0-r3. r12 is scratch. Higher
 *   registers (r4-r11) must be preserved (the user's `swi` is logically
 *   a regular function call). For HLE we just don't touch them.
 *
 * Reference: GBATEK section "GBA BIOS Functions".
 */

import type { MemoryBus } from "../memory/bus.js";
import type { InterruptController } from "../memory/interrupts.js";
import type { ArmCpu } from "./cpu.js";
import { type ArmRegisters, CPSR_F, CPSR_I, CPSR_T, MODE_IRQ, MODE_SVC, MODE_SYS } from "./registers.js";

/** BIOS interrupt-check flag location in IWRAM. The standard libtonc /
 *  devkitARM IRQ-handler template ORs the consumed IF bits into this
 *  location; IntrWait / VBlankIntrWait read it to know which IRQs the
 *  user code has already serviced. We follow the same convention so
 *  programs built against the standard templates work unchanged. */
const BIOS_INTR_CHECK = 0x03007ff8;

/** SWI 0x0D — GetBiosChecksum returns this fixed 32-bit value on a
 *  Nintendo GBA BIOS image. Carts that probe it (Yu-Gi-Oh! Ultimate
 *  Masters 2006 + GX Duel Academy in the surveyed corpus) compare
 *  the result against this exact constant to confirm they're running
 *  on real Nintendo silicon before unlocking certain features. */
const NINTENDO_BIOS_CHECKSUM = 0xbaae187f | 0;

/** Per-SWI dispatch + return overhead, in cycles. Real BIOS spends
 *  ~45 cycles wrapping every call (mode switch, register save,
 *  dispatch table, return-pipeline refill) before any per-SWI work
 *  runs — total per-SWI overhead measured on real hardware is
 *  `45 + activeNonseqCycles16 + return-fetch`. Charging the mid-range
 *  approximation below on every HLE SWI hit keeps the cart's
 *  IRQ/timer state in step with what real BIOS would produce. */
const SWI_DISPATCH_CYCLES = 25;

/** Diagnostic hook fired around every handled SWI dispatch. Off by
 *  default — `setSwiTraceHook(fn)` enables, `setSwiTraceHook(null)`
 *  disables. Captures the SWI number plus r0–r3 before and after the
 *  handler, which is enough to drive a per-SWI input/output diff
 *  against a real-Nintendo-BIOS reference trace when investigating
 *  an HLE-only divergence. */
// Kept exported even when currently uninstalled — the dispatch site
// below reads `swiTraceHook` on every SWI, so re-enabling tracing from
// a future debug session or DevTools is just a `setSwiTraceHook(fn)`
// away. Knip flags both as unused; the comment above the type doc
// explains the intent.
export type SwiTraceHook = (
  swi: number,
  r0In: number,
  r1In: number,
  r2In: number,
  r3In: number,
  r0Out: number,
  r1Out: number,
  r2Out: number,
  r3Out: number
) => void;
let swiTraceHook: SwiTraceHook | null = null;
export function setSwiTraceHook(hook: SwiTraceHook | null): void {
  swiTraceHook = hook;
}

/** Dispatch a SWI call. Returns true if the SWI was handled in HLE
 *  and the caller should NOT proceed with the ARM SVC exception
 *  entry. Returns false to let the decoder fall through to the
 *  standard mode switch (the routine isn't implemented yet).
 *
 *  Active-CPU SWIs (math, copy, decompress, affine, etc.) charge
 *  `SWI_DISPATCH_CYCLES` of dispatch overhead plus a per-handler work
 *  cost (the inner functions add to `bus.accessCycles` directly). The
 *  state-modifying SWIs (SoftReset, Halt, IntrWait, VBlankIntrWait)
 *  skip the dispatch charge — SoftReset wipes the world and the
 *  halt/wait family suspends the CPU, so subsequent cycle accounting
 *  comes from the halt-release path, not this dispatch. That cycle
 *  budget is what lets cart game state stay aligned with real-BIOS
 *  runs over thousands of SWIs; HLE returning instantly (the pre-fix
 *  default of ~4 cycles) accumulated enough drift to diverge
 *  commercial carts after a few hundred frames. */
export function dispatchSwi(
  swiNumber: number,
  regs: ArmRegisters,
  bus: MemoryBus,
  cpu: ArmCpu,
  interrupts: InterruptController
): boolean {
  // Snapshot the input registers BEFORE dispatch so the trace hook
  // can see what the cart asked the SWI to do. Cheap when the hook
  // isn't installed — V8 should hoist the `!== null` test.
  let r0In = 0,
    r1In = 0,
    r2In = 0,
    r3In = 0;
  if (swiTraceHook !== null) {
    r0In = regs.r[0]! | 0;
    r1In = regs.r[1]! | 0;
    r2In = regs.r[2]! | 0;
    r3In = regs.r[3]! | 0;
  }
  const handled = dispatchSwiInner(swiNumber, regs, bus, cpu, interrupts);
  // Real BIOS leaves its open-bus latch holding GBATEK's "after SWI"
  // value (the word prefetched while the SWI epilogue ran) on every
  // SWI return — carts and mgba-suite memory's "BIOS load" rows read
  // it back through the protected BIOS region. The reference HLE sets
  // the same constant unconditionally at SWI end.
  if (handled && cpu.biosHandler !== null) cpu.biosHandler.biosOpenBus = 0xe3a02004 | 0;
  if (handled && swiTraceHook !== null) {
    swiTraceHook(
      swiNumber & 0xff,
      r0In,
      r1In,
      r2In,
      r3In,
      regs.r[0]! | 0,
      regs.r[1]! | 0,
      regs.r[2]! | 0,
      regs.r[3]! | 0
    );
  }
  return handled;
}

function dispatchSwiInner(
  swiNumber: number,
  regs: ArmRegisters,
  bus: MemoryBus,
  cpu: ArmCpu,
  interrupts: InterruptController
): boolean {
  switch (swiNumber & 0xff) {
    case 0x00:
      biosSoftReset(regs, bus, cpu);
      return true;
    case 0x01:
      biosRegisterRamReset(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x02:
      biosHalt(cpu);
      return true;
    case 0x04:
      biosIntrWait(regs, bus, cpu, interrupts);
      return true;
    case 0x05:
      biosVBlankIntrWait(regs, bus, cpu, interrupts);
      return true;
    case 0x06:
      biosDiv(regs, bus);
      return true;
    case 0x07:
      biosDivArm(regs, bus);
      return true;
    case 0x08:
      biosSqrt(regs, bus);
      return true;
    case 0x09:
      biosArcTan(regs, bus);
      return true;
    case 0x0a:
      biosArcTan2(regs, bus);
      return true;
    case 0x0b:
      biosCpuSet(regs, bus);
      return true;
    case 0x0c:
      biosCpuFastSet(regs, bus);
      return true;
    case 0x0d:
      regs.r[0] = NINTENDO_BIOS_CHECKSUM | 0;
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x0e:
      biosBgAffineSet(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x0f:
      biosObjAffineSet(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x10:
      biosBitUnPack(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x11:
      biosLz77UnComp(regs, bus, /* vram */ false);
      return true;
    case 0x12:
      biosLz77UnComp(regs, bus, /* vram */ true);
      return true;
    case 0x13:
      biosHuffUnComp(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x14:
      biosRleUnComp(regs, bus, /* vram */ false);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x15:
      biosRleUnComp(regs, bus, /* vram */ true);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x16:
      biosDiff8bitUnFilter(regs, bus, /* vram */ false);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x17:
      biosDiff8bitUnFilter(regs, bus, /* vram */ true);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x18:
      biosDiff16bitUnFilter(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x1e:
      biosSoundChannelClear(bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x1f:
      biosMidiKey2Freq(regs, bus);
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    case 0x28:
    case 0x29:
      // SoundDriverVSyncOff / SoundDriverVSyncOn — pause / resume the
      // BIOS-internal Sappy / M4A driver. We don't run that driver
      // ourselves, so there's nothing to pause; charge dispatch cycles
      // and acknowledge. Carts that call this pair (both Shrek titles
      // in our corpus survey) only need the SWI shape honoured.
      bus.accessCycles += SWI_DISPATCH_CYCLES;
      return true;
    default:
      return false;
  }
}

// ─── Reset ──────────────────────────────────────────────────────────

/** SWI 0x00 — SoftReset. Re-initialises the CPU exactly as the real
 *  BIOS does at the end of its boot path and transfers control to the
 *  cart-supplied reset vector. The flag byte at 0x03007FFA selects the
 *  destination: 0 = ROM (0x08000000), non-zero = EWRAM (0x02000000).
 *
 *  Per GBATEK the 0x100 bytes at 0x03007F00 (the BIOS stack area) are
 *  zeroed; everything else stays as the cart left it. */
function biosSoftReset(regs: ArmRegisters, bus: MemoryBus, cpu: ArmCpu): void {
  const flag = bus.read8(0x03007ffa) & 0xff;
  const target = flag === 0 ? 0x08000000 : 0x02000000;
  for (let addr = 0x03007f00; addr < 0x03008000; addr += 4) bus.write32(addr, 0);
  for (let i = 0; i <= 12; i++) regs.r[i] = 0;
  regs.setMode(MODE_SVC);
  regs.r[13] = 0x03007fe0;
  regs.r[14] = 0;
  regs.spsr = 0;
  regs.setMode(MODE_IRQ);
  regs.r[13] = 0x03007fa0;
  regs.r[14] = 0;
  regs.spsr = 0;
  regs.setMode(MODE_SYS);
  regs.r[13] = 0x03007f00;
  regs.r[14] = target;
  regs.cpsr = (regs.cpsr & ~(CPSR_T | CPSR_I | CPSR_F)) | MODE_SYS;
  regs.r[15] = target;
  cpu.invalidatePrefetch();
}

/** SWI 0x01 — RegisterRamReset(r0=resetFlags). For each bit set in r0,
 *  zero (or default-reset) the corresponding region:
 *    bit 0  EWRAM      (0x02000000-0x0203FFFF)
 *    bit 1  IWRAM      (0x03000000-0x03007E00, leaves BIOS stack alone)
 *    bit 2  Palette    (0x05000000-0x050003FF)
 *    bit 3  VRAM       (0x06000000-0x06017FFF)
 *    bit 4  OAM        (0x07000000-0x070003FF)
 *    bit 5  SIO        (registers, switches to general-purpose mode)
 *    bit 6  Sound      (registers)
 *    bit 7  All other  (registers — DMA, timers, IRQ ctrl, etc.)
 *  Commercial games typically call this with r0=0xFF early in boot. */
function biosRegisterRamReset(regs: ArmRegisters, bus: MemoryBus): void {
  const flags = regs.r[0]! & 0xff;
  const zeroRange = (start: number, end: number, width: 1 | 2 | 4): void => {
    for (let addr = start; addr < end; addr += width) {
      if (width === 4) bus.write32(addr, 0);
      else if (width === 2) bus.write16(addr, 0);
      else bus.write8(addr, 0);
    }
  };
  // EWRAM / IWRAM zeroing is high-bandwidth: doing it via bus.write32
  // charges full N-cycle access for each word, accumulating ~200K
  // cycles in the SWI step. Real BIOS performs the same clearing as
  // an interruptible ARM loop in SVC mode — the loop is much cheaper
  // per word AND its long runtime lets the cart's user IRQ handler
  // service VBlank mid-SWI, before BIOS overwrites the handler in
  // IWRAM. Our HLE is atomic per-step: ticking PPU by 200K cycles in
  // one go crosses VBlank entry, the SWI returns with IF.bit0 set,
  // and the IRQ delivers AFTER our zero loop has wiped the cart's
  // user handler — guaranteed crash (Robot Wars, others). Write
  // through the raw byte arrays to bypass cycle accounting; the
  // cart sees the same memory state without the spurious PPU drift.
  const mem = bus as unknown as { ewram: Uint8Array; iwram: Uint8Array };
  if ((flags & 0x01) !== 0 && mem.ewram) mem.ewram.fill(0);
  if ((flags & 0x02) !== 0 && mem.iwram) mem.iwram.fill(0, 0, 0x7e00);
  if ((flags & 0x04) !== 0) zeroRange(0x05000000, 0x05000400, 4);
  if ((flags & 0x08) !== 0) zeroRange(0x06000000, 0x06018000, 4);
  if ((flags & 0x10) !== 0) zeroRange(0x07000000, 0x07000400, 4);
  // Bits 5/6/7 reset MMIO registers. The simplest model is a blanket
  // zero of the relevant slots — real BIOS does roughly this. Games
  // that care about exact reset values typically re-init the registers
  // immediately afterwards anyway.
  if ((flags & 0x20) !== 0) {
    zeroRange(0x04000120, 0x0400012c, 2); // SIODATA / SIOCNT / SIOMLT
    bus.write16(0x04000134, 0); // RCNT
  }
  if ((flags & 0x40) !== 0) {
    zeroRange(0x04000060, 0x040000a8, 2); // sound channel + mixer registers
    bus.write32(0x040000a0, 0); // FIFO_A
    bus.write32(0x040000a4, 0); // FIFO_B
  }
  if ((flags & 0x80) !== 0) {
    // PPU regs starting at DISPSTAT (0x04000004) — real BIOS PRESERVES
    // DISPCNT (0x04000000) here. Verified by tracing the Nintendo BIOS
    // bit-7 reset loop: the BIOS writes DISPCNT=0x0080 (FORCE_BLANK)
    // once during boot at PC=0x09d6 and the SWI 0x01 handler at
    // PC=0x0c0c starts zeroing only at 0x04000004. Carts that read
    // DISPCNT.bit7 after RegisterRamReset see force-blank still on —
    // Drill Dozer's setup at PC=0x08000f48 takes a `BEQ` on
    // `DISPCNT & 0x80 == 0` to decide whether to run its DISPSTAT-
    // config-sync routine; clobbering DISPCNT here makes the cart
    // skip the sync, so VCount IRQ never gets armed and the
    // Timer-3-driven audio mixer never fires.
    zeroRange(0x04000004, 0x04000060, 2);
    zeroRange(0x040000b0, 0x04000100, 4); // DMA channels
    zeroRange(0x04000100, 0x04000110, 2); // timers
    zeroRange(0x04000200, 0x04000204, 2); // IE / IF
    bus.write16(0x04000208, 0); // IME
    bus.write32(0x04000204, 0); // WAITCNT (write32 covers both halves)
  }
  // Real Nintendo BIOS uses r0, r1, r3 as scratch through its reset
  // loops and doesn't restore them on exit. Some carts (Robot Wars
  // showed 513 spurious SWIs without this clobber) read r0/r1/r3 as
  // fresh scratch after the SWI; with the original input values left
  // in place, downstream cart code branches OOB. The real-BIOS values
  // depend on which flags were active (a per-SWI trace shows
  // r0=0x03007E1C / r1=0x03007E00 for flag=0x03 but
  // r0=0x03007DBC / r1=0x03000000 for flag=0xE0); since no observed
  // cart depends on the exact values — only that the registers differ
  // from the cart's input — clobber to zero, the simplest "not the
  // input" sentinel.
  regs.r[0] = 0;
  regs.r[1] = 0;
  regs.r[3] = 0;
}

// ─── Math ───────────────────────────────────────────────────────────

/** SWI 0x06 — Div(r0=numerator, r1=denominator). Returns:
 *    r0 = signed quotient
 *    r1 = signed remainder
 *    r3 = unsigned (absolute) quotient
 *  Division-by-zero behaviour on real BIOS is undefined. We return
 *  r0 = sign-extend(numerator), r1 = numerator, r3 = abs(numerator)
 *  — a sensible deterministic answer that keeps carts that hit the
 *  edge case from wedging on engine-dependent garbage. */
function biosDiv(regs: ArmRegisters, bus: MemoryBus): void {
  const num = regs.r[0]! | 0;
  const den = regs.r[1]! | 0;
  if (den === 0) {
    // Real BIOS divide-by-zero leaves r0 = sign(num) (treating 0 as
    // positive), r1 = numerator, r3 = 1 — mgba-suite bios-math's
    // "Div by zero" rows read all three back.
    regs.r[0] = num < 0 ? -1 : 1;
    regs.r[1] = num;
    regs.r[3] = 1;
    bus.accessCycles += SWI_DISPATCH_CYCLES + 11;
    return;
  }
  if (den === -1 && num === -0x80000000) {
    // INT_MIN / -1 overflows the negation; real BIOS yields the
    // wrapped quotient with remainder 0.
    regs.r[0] = -0x80000000;
    regs.r[1] = 0;
    regs.r[3] = -0x80000000;
    bus.accessCycles += SWI_DISPATCH_CYCLES + 100;
    return;
  }
  // JavaScript's `/` truncates toward zero only when both args are
  // ints and Math.trunc is applied — `(num / den) | 0` does both in
  // one shot.
  const quot = (num / den) | 0;
  const rem = (num - quot * den) | 0;
  regs.r[0] = quot;
  regs.r[1] = rem;
  regs.r[3] = Math.abs(quot) | 0;
  // Real BIOS cost: 4 (prologue) + 13 * loops + 7 (epilogue). `loops`
  // is the bit-width difference of the inputs, ≤32. Approximate as a
  // fixed mid-range cost — the cart can't observe the exact value,
  // only the total IRQ/timer drift over many calls.
  bus.accessCycles += SWI_DISPATCH_CYCLES + 100;
}

/** SWI 0x07 — DivArm(r0=denominator, r1=numerator). Same outputs as
 *  Div, just with the operand registers swapped (legacy ARM order). */
function biosDivArm(regs: ArmRegisters, bus: MemoryBus): void {
  const num = regs.r[1]! | 0;
  const den = regs.r[0]! | 0;
  regs.r[0] = num;
  regs.r[1] = den;
  biosDiv(regs, bus);
}

/** SWI 0x08 — Sqrt(r0). Returns r0 = floor(sqrt(r0)), treating r0 as
 *  unsigned 32-bit. */
function biosSqrt(regs: ArmRegisters, bus: MemoryBus): void {
  // Real BIOS runs an iterative shift-and-subtract refinement, not an
  // exact floor(sqrt): for some inputs the loop settles one off the
  // mathematical root, and mgba-suite bios-math pins those exact
  // values. Ported from the reference HLE's bit-faithful model.
  const x = regs.r[0]! >>> 0;
  if (x === 0) {
    regs.r[0] = 0;
    bus.accessCycles += SWI_DISPATCH_CYCLES + 40;
    return;
  }
  let upper = x;
  let bound = 1;
  while (bound < upper) {
    upper = upper >>> 1;
    bound = (bound << 1) >>> 0;
  }
  for (;;) {
    upper = x;
    let accum = 0;
    let lower = bound;
    for (;;) {
      const oldLower = lower;
      if (lower <= upper >>> 1) lower = (lower << 1) >>> 0;
      if (oldLower >= upper >>> 1) break;
    }
    for (;;) {
      accum = (accum << 1) >>> 0;
      if (upper >= lower) {
        accum = (accum + 1) >>> 0;
        upper = (upper - lower) >>> 0;
      }
      if (lower === bound) break;
      lower = lower >>> 1;
    }
    const oldBound = bound;
    bound = (bound + accum) >>> 0;
    bound = bound >>> 1;
    if (bound >= oldBound) {
      bound = oldBound;
      break;
    }
  }
  regs.r[0] = bound | 0;
  bus.accessCycles += SWI_DISPATCH_CYCLES + 40;
}

/** SWI 0x09 — ArcTan(r0). Input: signed Q1.14 in r0. Output: signed
 *  Q1.14 result in r0, in the range (-pi/2, pi/2) = (-0x4000, 0x4000).
 *  The 16-bit result is sign-extended to 32 bits. */
function biosArcTan(regs: ArmRegisters, bus: MemoryBus): void {
  const r = arcTanPolynomial(regs.r[0]! | 0);
  regs.r[0] = r.value;
  regs.r[1] = r.a;
  regs.r[3] = r.b;
  // Real BIOS cost: ~37 cycles base + 7 polynomial iterations.
  bus.accessCycles += SWI_DISPATCH_CYCLES + 50;
}

/** The exact 7-term polynomial the real BIOS ArcTan runs, including
 *  its int32-wraparound behaviour for inputs outside the valid Q1.14
 *  domain (|r0| > 0x4000 produces well-defined garbage carts and the
 *  bios-math suite rely on) and the intermediate values it leaves in
 *  r1 (`a`) and r3 (`b`). The result is the low 16 bits of
 *  `(i * b) >> 16`, sign-extended. Ported from a reference HLE that
 *  mirrors disassembled BIOS code. */
function arcTanPolynomial(i: number): { value: number; a: number; b: number } {
  const a = -(Math.imul(i, i) >> 14) | 0;
  let b = (Math.imul(0xa9, a) >> 14) + 0x390;
  b = (Math.imul(b, a) >> 14) + 0x91c;
  b = (Math.imul(b, a) >> 14) + 0xfb6;
  b = (Math.imul(b, a) >> 14) + 0x16aa;
  b = (Math.imul(b, a) >> 14) + 0x2081;
  b = (Math.imul(b, a) >> 14) + 0x3651;
  b = (Math.imul(b, a) >> 14) + 0xa2f9;
  const value = ((Math.imul(i, b) >> 16) << 16) >> 16;
  return { value, a: a | 0, b: b | 0 };
}

/** SWI 0x0A — ArcTan2(x=r0, y=r1). Output: r0 = angle in
 *  [0, 0x10000) corresponding to [0, 2*pi). Quadrant-aware. */
function biosArcTan2(regs: ArmRegisters, bus: MemoryBus): void {
  // Quadrant dispatch exactly as the real BIOS does it: axis-aligned
  // inputs take an early path that leaves r1 untouched; everything
  // else feeds `(n << 14) / d` into the ArcTan polynomial (whose `a`
  // intermediate lands in r1). r0 is the ZERO-extended 16-bit angle;
  // r3 is always left at 0x170 (a leftover BIOS constant the suite
  // reads back). Ported from a reference HLE.
  const x = regs.r[0]! | 0;
  const y = regs.r[1]! | 0;
  let value: number;
  if (y === 0) {
    value = x >= 0 ? 0 : 0x8000;
  } else if (x === 0) {
    value = y >= 0 ? 0x4000 : 0xc000;
  } else {
    let inner: { value: number; a: number };
    if (y >= 0) {
      if (x >= 0 && x >= y) {
        inner = arcTanPolynomial((((y << 14) | 0) / x) | 0);
        value = inner.value;
      } else if (x < 0 && -x >= y) {
        inner = arcTanPolynomial((((y << 14) | 0) / x) | 0);
        value = inner.value + 0x8000;
      } else {
        inner = arcTanPolynomial((((x << 14) | 0) / y) | 0);
        value = 0x4000 - inner.value;
      }
    } else {
      if (x <= 0 && -x > -y) {
        inner = arcTanPolynomial((((y << 14) | 0) / x) | 0);
        value = inner.value + 0x8000;
      } else if (x > 0 && x >= -y) {
        inner = arcTanPolynomial((((y << 14) | 0) / x) | 0);
        value = inner.value + 0x10000;
      } else {
        inner = arcTanPolynomial((((x << 14) | 0) / y) | 0);
        value = 0xc000 - inner.value;
      }
    }
    regs.r[1] = inner.a;
  }
  regs.r[0] = value & 0xffff;
  regs.r[3] = 0x170;
  // Real BIOS cost: ~11 cycles for axis-aligned shortcuts, otherwise
  // delegates to ArcTan. Use a mid-range fixed estimate.
  bus.accessCycles += SWI_DISPATCH_CYCLES + 80;
}

/** SWI 0x1F — MidiKey2Freq(r0=wavedata, r1=midiKey, r2=pitch).
 *  Returns r0 = play frequency for a MIDI note.
 *
 *  Per GBATEK + Cult-of-GBA BIOS reference:
 *    freq        = u32 at wavedata + 4   (sample-rate of wave's mid-C)
 *    factor      = (midiKey * 256 + pitch - 180 * 256) / (12 * 256)
 *    result      = round(freq * 2^factor)
 *
 *  WarioWare: Twisted!'s music driver calls this every note tick to
 *  compute playback rate; HLE'ing it as a NOP leaves the cart with
 *  garbage in r0 and the music samples come out at wrong frequencies,
 *  producing the "tinny" output observed before this handler was added. */
function biosMidiKey2Freq(regs: ArmRegisters, bus: MemoryBus): void {
  const waveData = regs.r[0]! | 0;
  const midiKey = regs.r[1]! & 0xff;
  // r2 is treated as signed 32-bit pitch; the Cult-of-GBA BIOS scales
  // it by 1/256 so callers pass a fixed-point semitone offset.
  const pitch = regs.r[2]! | 0;
  const freq = bus.read32(waveData + 4) >>> 0;
  // factor = (midiKey + pitch/256 - 180) / 12
  const factor = (midiKey * 256 + pitch - 180 * 256) / (12 * 256);
  const result = Math.round(freq * Math.pow(2, factor));
  regs.r[0] = result | 0;
}

// ─── Memory copy / fill ─────────────────────────────────────────────

const CPUSET_FILL = 1 << 24;
const CPUSET_WORD = 1 << 26;

/** Model the effective LDRH-then-STRH halfword the real BIOS CpuSet
 *  loop writes for an unaligned src. ARM7TDMI LDRH at an odd address
 *  loads the aligned halfword and ROR-8s its zero-extended 32-bit
 *  value: low byte → bits 24-31, high byte → bits 0-7, bits 8-23 = 0.
 *  STRH stores bits 0-15, so memory ends up with [high_byte, 0]. */
function ldrhStorePayload(bus: MemoryBus, addr: number): number {
  const raw = bus.read16(addr >>> 0) & 0xffff;
  if ((addr & 1) === 0) return raw;
  return (raw >>> 8) & 0xff;
}

/** SWI 0x0B — CpuSet(src=r0, dst=r1, control=r2).
 *  control: bits 0-20 = count (in size units),
 *           bit 24 = 0 (copy) / 1 (fill, read src once),
 *           bit 26 = 0 (16-bit halfword) / 1 (32-bit word).
 *  Used as memcpy / memset.
 *
 *  Halfword mode uses LDRH/STRH internally; unaligned src exercises
 *  the ARM7TDMI barrel-shifter rotation on the load side
 *  (`ldrhStorePayload`). Word mode does NOT rotate — the real BIOS
 *  word path appears to use LDM/STM (or to pre-align src), since the
 *  mgba-suite expected pattern for unaligned-src word CpuSet is the
 *  un-rotated source word.
 *
 *  Register clobber: real BIOS leaves r0, r1, and r2 **unchanged**
 *  (it uses internal scratch registers for the loop) and stores a
 *  BIOS-internal value in r3. GBATEK's documented `Output: r0,r1,r3
 *  modified, r2=0` is wrong — verified against a real Nintendo BIOS
 *  via per-instruction PC/reg trace of Bomberman Tournament. With the
 *  GBATEK-style "advance r0/r1, zero r2" behaviour the cart diverges
 *  at the first CpuSet return because it reads r0/r1 expecting the
 *  pre-call source/dst values (probably to call the next CpuSet with
 *  the same start address).
 *
 *  Cycle cost: BIOS uses an LDRH/STRH loop (halfword) or LDM/STM
 *  (word) — roughly 6 cycles per halfword or per word, plus
 *  per-call dispatch overhead. */
function biosCpuSet(regs: ArmRegisters, bus: MemoryBus): void {
  const src = regs.r[0]! | 0;
  // Real BIOS validates the source pointer and refuses to copy from
  // below EWRAM (the protected BIOS region and the 0x01 unmapped gap)
  // — the destination is left untouched. mgba-suite memory's "BIOS
  // (out-of-bounds) load" swi rows read back the dst's prior zeros.
  if (src >>> 24 < 0x02) {
    bus.accessCycles += SWI_DISPATCH_CYCLES;
    return;
  }
  let dst = regs.r[1]! | 0;
  const control = regs.r[2]! | 0;
  const count = control & 0x1fffff;
  const word = (control & CPUSET_WORD) !== 0;
  const fill = (control & CPUSET_FILL) !== 0;
  const step = word ? 4 : 2;
  let cur = src;
  if (fill) {
    const value = word ? bus.read32(cur >>> 0) | 0 : ldrhStorePayload(bus, cur);
    for (let i = 0; i < count; i++) {
      if (word) bus.write32(dst >>> 0, value);
      else bus.write16(dst >>> 0, value);
      dst = (dst + step) | 0;
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (word) bus.write32(dst >>> 0, bus.read32(cur >>> 0) | 0);
      else bus.write16(dst >>> 0, ldrhStorePayload(bus, cur));
      cur = (cur + step) | 0;
      dst = (dst + step) | 0;
    }
  }
  bus.accessCycles += SWI_DISPATCH_CYCLES + 5 * count;
}

/** SWI 0x0C — CpuFastSet(src=r0, dst=r1, control=r2).
 *  Always 32-bit. Count is rounded up to the next multiple of 8
 *  (the routine copies in 8-word bursts on real hardware). bit 24
 *  is fill flag; bit 26 is ignored.
 *
 *  Register clobber (verified 2026-05-24 against real Nintendo BIOS
 *  via per-SWI trace of Bee Game): r0 and r1 are post-incremented past
 *  the copy (src += count*4 in copy mode, dst += count*4 always); r3
 *  holds the second word of the last 8-word burst (`src[count-7]` in
 *  copy mode, the fill value itself in fill mode) — real BIOS uses
 *  `LDMIA src!, {r2, r3, r4, r5, r6, r7, r8, lr}` so r3 gets the
 *  word at offset +4 within each burst; r2 is left at the input
 *  control word.
 *
 *  Cycle cost: BIOS uses LDM/STM with 8-word bursts — roughly 1.5
 *  cycles per word in IWRAM (1S + a bit of bookkeeping). The dispatch
 *  overhead is the same `SWI_DISPATCH_CYCLES` as every other handled
 *  SWI. */
function biosCpuFastSet(regs: ArmRegisters, bus: MemoryBus): void {
  const src = regs.r[0]! | 0;
  // Same source validation as CpuSet — real BIOS rejects src < EWRAM.
  if (src >>> 24 < 0x02) {
    bus.accessCycles += SWI_DISPATCH_CYCLES;
    return;
  }
  let dst = regs.r[1]! | 0;
  const control = regs.r[2]! | 0;
  const rawCount = control & 0x1fffff;
  const count = (rawCount + 7) & ~7; // round up to 8
  const fill = (control & CPUSET_FILL) !== 0;
  let cur = src;
  let r3Residue = 0;
  if (fill) {
    const value = bus.read32(cur >>> 0) | 0;
    r3Residue = value;
    for (let i = 0; i < count; i++) {
      bus.write32(dst >>> 0, value);
      dst = (dst + 4) | 0;
    }
  } else {
    for (let i = 0; i < count; i++) {
      const word = bus.read32(cur >>> 0) | 0;
      bus.write32(dst >>> 0, word);
      // r3 in the BIOS's LDMIA list lands on the second word of each
      // burst — record it once per 8-word group so the final value is
      // src[1] of the LAST burst.
      if ((i & 7) === 1) r3Residue = word;
      cur = (cur + 4) | 0;
      dst = (dst + 4) | 0;
    }
  }
  // Match real-BIOS register clobber so carts that read r0/r1 across
  // chained CpuFastSet calls observe the post-copy pointers, and r3 =
  // BIOS's LDM/STM scratch residue.
  regs.r[0] = cur | 0;
  regs.r[1] = dst | 0;
  regs.r[3] = r3Residue | 0;
  bus.accessCycles += SWI_DISPATCH_CYCLES + ((count * 3) >>> 2);
}

// ─── Halt / IRQ wait ─────────────────────────────────────────────────

/** SWI 0x02 — Halt. Stops the CPU until any enabled IRQ fires. The
 *  step loop releases the halt when `(IE & IF) != 0`. */
function biosHalt(cpu: ArmCpu): void {
  cpu.halted = true;
  cpu.intrWaitMask = 0;
}

/** SWI 0x1E — SoundChannelClear. Clears both Direct Sound FIFOs and
 *  the held samples; PSG channels and SOUNDCNT_H volume/routing bits
 *  are left untouched. Carts call this when restarting their audio
 *  engine. Implemented by setting the FIFO-reset bits in SOUNDCNT_H,
 *  which the APU handler honours by emptying the FIFOs and zeroing
 *  the held DS samples (then self-clearing the reset bits, so the
 *  cart's subsequent SOUNDCNT_H reads stay clean). */
function biosSoundChannelClear(bus: MemoryBus): void {
  const FIFO_RESET_BITS = (1 << 11) | (1 << 15);
  const current = bus.read16(0x04000082) & 0xffff;
  bus.write16(0x04000082, current | FIFO_RESET_BITS);
}

/** SWI 0x04 — IntrWait(r0=clearFirst, r1=waitMask). Halts the CPU
 *  until any of the IRQ bits in `waitMask` have been recorded in the
 *  BIOS interrupt-check flag at 0x03007FF8. The standard libtonc
 *  IRQ-handler template ORs consumed IF bits into that location, so
 *  this works for programs following the convention.
 *
 *  When clearFirst is 1, we also clear the matching bits in the BIOS
 *  flag and in IF first — otherwise a stale flag from before the
 *  call would cause IntrWait to return immediately. */
function biosIntrWait(regs: ArmRegisters, bus: MemoryBus, cpu: ArmCpu, interrupts: InterruptController): void {
  const clearFirst = (regs.r[0]! & 1) !== 0;
  const mask = regs.r[1]! & 0x3fff;
  if (clearFirst) {
    const cur = bus.read16(BIOS_INTR_CHECK) & 0xffff;
    bus.write16(BIOS_INTR_CHECK, cur & ~mask);
    interrupts.if_ &= ~mask;
  }
  // Real BIOS IntrWait ORs the wait mask into IE so the requested IRQs
  // are enabled before halting; otherwise carts that disabled an IRQ
  // bit and then re-issue IntrWait (Dead to Rights does this on the
  // licensing-splash → title transition) would hang forever waiting on
  // an IRQ that can no longer deliver. Also forces IME=1 per GBATEK,
  // for carts that called IntrWait with IME left at 0.
  interrupts.ie = (interrupts.ie | mask) & 0x3fff;
  interrupts.ime = 1;
  cpu.halted = true;
  cpu.intrWaitMask = mask;
  // Reset the accumulator so stale bits from IRQs that fired before
  // this wait don't satisfy the new wait spuriously.
  cpu.lastIrqServiced = 0;
}

/** SWI 0x05 — VBlankIntrWait. Equivalent to IntrWait(1, 1), but the
 *  real BIOS also ORs DISPSTAT.VBlank-IRQ-enable (bit 3) before
 *  halting — verified from the Nintendo BIOS disassembly at 0x3C4:
 *    LDR r0, [r12, #4]     ; r0 = DISPSTAT
 *    ORR r0, r0, #0x8       ; r0 |= 0x08
 *    STR r0, [r12, #4]      ; DISPSTAT = r0
 *  Drill Dozer (and other Nintendo first-party carts) relies on this:
 *  it calls VBlankIntrWait without ever writing DISPSTAT itself. With
 *  bit 3 cleared the PPU never raises the VBlank IRQ, the cart halts
 *  forever, and the screen stays at the boot backdrop. */
function biosVBlankIntrWait(regs: ArmRegisters, bus: MemoryBus, cpu: ArmCpu, interrupts: InterruptController): void {
  const dispstat = bus.read16(0x04000004) & 0xffff;
  bus.write16(0x04000004, dispstat | 0x8);
  regs.r[0] = 1;
  regs.r[1] = 1;
  biosIntrWait(regs, bus, cpu, interrupts);
}

// ─── Affine matrix setup ────────────────────────────────────────────

/** SWI 0x0E — BgAffineSet(src=r0, dst=r1, count=r2). For each entry:
 *  reads a BgAffineSource struct (20 bytes) and writes a BgAffineDest
 *  struct (16 bytes — the four matrix coefficients + 8-byte reference
 *  point).
 *
 *  BgAffineSource layout (per GBATEK):
 *    +0  s32 origin_x  (Q19.8 — fixed point)
 *    +4  s32 origin_y  (Q19.8)
 *    +8  s16 disp_x    (screen origin in pixels)
 *   +10  s16 disp_y
 *   +12  s16 scale_x   (Q7.8 fixed-point scale; 0x100 = 1.0)
 *   +14  s16 scale_y
 *   +16  u16 angle     (Q15 angle; 0..0xFFFF = 0..2*pi)
 *
 *  BgAffineDest layout:
 *    +0  s16 pa
 *    +2  s16 pb
 *    +4  s16 pc
 *    +6  s16 pd
 *    +8  s32 ref_x     (Q19.8)
 *   +12  s32 ref_y     (Q19.8)
 */
function biosBgAffineSet(regs: ArmRegisters, bus: MemoryBus): void {
  let src = regs.r[0]! | 0;
  let dst = regs.r[1]! | 0;
  const count = regs.r[2]! | 0;
  for (let i = 0; i < count; i++) {
    const originX = bus.read32(src >>> 0) | 0;
    const originY = bus.read32((src + 4) >>> 0) | 0;
    const dispX = (bus.read16((src + 8) >>> 0) << 16) >> 16;
    const dispY = (bus.read16((src + 10) >>> 0) << 16) >> 16;
    const scaleX = (bus.read16((src + 12) >>> 0) << 16) >> 16;
    const scaleY = (bus.read16((src + 14) >>> 0) << 16) >> 16;
    const angle = bus.read16((src + 16) >>> 0) & 0xffff;
    const theta = (angle / 0x10000) * 2 * Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // Matrix coefficients in Q7.8.
    const pa = Math.round(scaleX * cos) | 0;
    const pb = Math.round(-scaleX * sin) | 0;
    const pc = Math.round(scaleY * sin) | 0;
    const pd = Math.round(scaleY * cos) | 0;
    bus.write16(dst >>> 0, pa & 0xffff);
    bus.write16((dst + 2) >>> 0, pb & 0xffff);
    bus.write16((dst + 4) >>> 0, pc & 0xffff);
    bus.write16((dst + 6) >>> 0, pd & 0xffff);
    // Reference point: origin - (pa * disp_x + pb * disp_y) in Q19.8.
    const refX = (originX - (pa * dispX + pb * dispY)) | 0;
    const refY = (originY - (pc * dispX + pd * dispY)) | 0;
    bus.write32((dst + 8) >>> 0, refX);
    bus.write32((dst + 12) >>> 0, refY);
    src = (src + 20) | 0;
    dst = (dst + 16) | 0;
  }
}

/** SWI 0x0F — ObjAffineSet(src=r0, dst=r1, count=r2, stride=r3).
 *  Like BgAffineSet but reads an ObjAffineSource (8 bytes: scale_x,
 *  scale_y, angle, pad) and writes 4 × s16 coefficients spaced by
 *  `stride` bytes (8 for "PA/PB/PC/PD packed" or 16 for "scattered
 *  in OAM matrix slots"). */
function biosObjAffineSet(regs: ArmRegisters, bus: MemoryBus): void {
  let src = regs.r[0]! | 0;
  let dst = regs.r[1]! | 0;
  const count = regs.r[2]! | 0;
  const stride = regs.r[3]! | 0;
  for (let i = 0; i < count; i++) {
    const scaleX = (bus.read16(src >>> 0) << 16) >> 16;
    const scaleY = (bus.read16((src + 2) >>> 0) << 16) >> 16;
    const angle = bus.read16((src + 4) >>> 0) & 0xffff;
    const theta = (angle / 0x10000) * 2 * Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const pa = Math.round(scaleX * cos) | 0;
    const pb = Math.round(-scaleX * sin) | 0;
    const pc = Math.round(scaleY * sin) | 0;
    const pd = Math.round(scaleY * cos) | 0;
    bus.write16(dst >>> 0, pa & 0xffff);
    bus.write16((dst + stride) >>> 0, pb & 0xffff);
    bus.write16((dst + stride * 2) >>> 0, pc & 0xffff);
    bus.write16((dst + stride * 3) >>> 0, pd & 0xffff);
    src = (src + 8) | 0;
    dst = (dst + stride * 4) | 0;
  }
}

// ─── Bit unpacking ───────────────────────────────────────────────────

/** SWI 0x10 — BitUnPack(src=r0, dst=r1, info=r2).
 *
 *  Expands a packed bitmap (1/2/4/8-bit source units) to wider
 *  destination units (1/2/4/8/16/32-bit). The classic use case is
 *  inflating a 1bpp font into 4bpp GBA tiles in one BIOS call: each
 *  set source bit becomes a non-zero palette index in the output, and
 *  clear bits become palette-0 transparency (or, when the zero-flag
 *  is set, they pick up the same offset and stay opaque).
 *
 *  Info struct (at r2):
 *    +0 u16 srcLen     bytes of source data
 *    +2 u8  srcWidth   1, 2, 4, or 8
 *    +3 u8  dstWidth   1, 2, 4, 8, 16, or 32
 *    +4 u32 control    bits 0..30 = offset added to each non-zero unit
 *                      bit 31 = "also add offset to zero units"
 *
 *  Source bits are read LSB-first within each byte. Output units are
 *  packed LSB-first into 32-bit words and written word-aligned at dst. */
function biosBitUnPack(regs: ArmRegisters, bus: MemoryBus): void {
  let src = regs.r[0]! | 0;
  let dst = regs.r[1]! | 0;
  const info = regs.r[2]! | 0;
  const srcLen = bus.read16(info >>> 0) & 0xffff;
  const srcWidth = bus.read8((info + 2) >>> 0) & 0xff;
  const dstWidth = bus.read8((info + 3) >>> 0) & 0xff;
  const control = bus.read32((info + 4) >>> 0) >>> 0;
  const offset = control & 0x7fffffff;
  const zeroFlag = (control >>> 31) & 1;

  const srcMask = (1 << srcWidth) - 1;
  const unitsPerByte = (8 / srcWidth) | 0;

  let outBuffer = 0;
  let outBits = 0;
  for (let i = 0; i < srcLen; i++) {
    const byte = bus.read8(src >>> 0) & 0xff;
    src = (src + 1) | 0;
    for (let u = 0; u < unitsPerByte; u++) {
      const value = (byte >>> (u * srcWidth)) & srcMask;
      const unit = value === 0 && zeroFlag === 0 ? 0 : (value + offset) | 0;
      // No need to mask `unit` against dstWidth — values that exceed
      // the slot just wrap when the next OR-shift overlaps, which
      // matches what real BIOS does. dstWidth always divides 32
      // (it's in {1,2,4,8,16,32}) so outBits hits 32 exactly.
      outBuffer = (outBuffer | (unit << outBits)) >>> 0;
      outBits += dstWidth;
      if (outBits === 32) {
        bus.write32(dst >>> 0, outBuffer | 0);
        dst = (dst + 4) | 0;
        outBuffer = 0;
        outBits = 0;
      }
    }
  }
  // Trailing partial word — real BIOS still emits it (zero-padded by
  // the way `outBuffer` accumulates).
  if (outBits > 0) bus.write32(dst >>> 0, outBuffer | 0);
}

// ─── Decompression ──────────────────────────────────────────────────
//
// Every decompression SWI takes r0 = src (compressed data start, points
// at the 4-byte header) and r1 = dst. The header layout is:
//
//   bits  0..3   reserved / data unit size (some variants)
//   bits  4..7   compression type (1=LZ77, 2=Huff, 3=RLE, ...)
//   bits  8..31  decompressed length in bytes
//
// The *Vram variants exist because VRAM, palette, and OAM only accept
// 16/32-bit writes — byte writes are dropped on real hardware. The
// VRAM-safe routines buffer up two output bytes and emit one halfword
// at a time. Our `MappedBus.write8` happens to update one byte of the
// underlying region without rotation, so the Wram routines would
// *appear* to work to VRAM in tests too, but we keep the distinction
// to stay protocol-correct for ROMs that switch behaviour based on the
// SWI number (rare but happens).

/** Writes one byte's worth of decompressed output. For VRAM, buffers
 *  two bytes into a halfword. Returns the new destination pointer. */
interface WriteSink {
  push(byte: number): void;
  flush(): void;
}

function makeSink(bus: MemoryBus, dst: number, vram: boolean): WriteSink & { dst: () => number } {
  let cur = dst | 0;
  let buffer = 0;
  let haveLow = false;
  if (!vram) {
    return {
      push(byte: number): void {
        bus.write8(cur >>> 0, byte & 0xff);
        cur = (cur + 1) | 0;
      },
      flush(): void {},
      dst: () => cur
    };
  }
  return {
    push(byte: number): void {
      if (!haveLow) {
        buffer = byte & 0xff;
        haveLow = true;
      } else {
        bus.write16(cur >>> 0, buffer | ((byte & 0xff) << 8));
        cur = (cur + 2) | 0;
        haveLow = false;
      }
    },
    flush(): void {
      if (haveLow) {
        // Trailing odd byte: real BIOS still emits the halfword (high
        // byte left as whatever the buffer was, often 0).
        bus.write16(cur >>> 0, buffer);
        cur = (cur + 2) | 0;
        haveLow = false;
      }
    },
    dst: () => cur
  };
}

/** SWI 0x11 (Wram) / 0x12 (Vram) — LZ77UnComp. Block-based LZSS:
 *  for each 8-bit flag byte, MSB-first; 0 = copy 1 literal byte, 1 =
 *  back-reference. A reference is 2 bytes:
 *    byte0 = (len-3) << 4 | (dist-1 >> 8)
 *    byte1 = (dist-1) & 0xFF
 *  Copy `len` bytes from `dst - (dist-1) - 1` to `dst`. Both `len`
 *  and `dist` are biased by GBATEK's well-known +3 / +1 offsets. */
function biosLz77UnComp(regs: ArmRegisters, bus: MemoryBus, vram: boolean): void {
  let src = regs.r[0]! | 0;
  const header = bus.read32(src >>> 0) | 0;
  src = (src + 4) | 0;
  // Validate the compression-type marker (high nibble of byte 0 must
  // be 1 for LZ77 per GBATEK). Real Nintendo BIOS refuses to decompress
  // when this doesn't match the SWI's expected type and returns
  // without touching the destination. Without this check our HLE
  // would blindly read the 24-bit "size" field and run an LZ77 decode
  // on whatever bytes follow, blasting VRAM with garbage. Observed on
  // Yoshi's Island (SMA3) intro: cart calls SWI 0x12 with a source
  // whose header is 0x4C 0x30 0x02 0x88 (not LZ77 — that's a Diff-
  // filter-shaped marker, and the size field is 0x880230 = ~8.5 MB).
  const typeMarker = header & 0xf0;
  if (typeMarker !== 0x10) {
    bus.accessCycles += SWI_DISPATCH_CYCLES;
    return;
  }
  const size = (header >>> 8) & 0xffffff;
  const sink = makeSink(bus, regs.r[1]! | 0, vram);
  // Output buffer for back-references — we can't reliably read back
  // from `dst` in VRAM (we may not have flushed the trailing byte
  // yet), so we track every emitted byte in a JS array.
  const out: number[] = [];
  while (out.length < size) {
    const flags = bus.read8(src >>> 0) & 0xff;
    src = (src + 1) | 0;
    for (let bit = 0; bit < 8 && out.length < size; bit++) {
      if ((flags & (0x80 >>> bit)) !== 0) {
        const b0 = bus.read8(src >>> 0) & 0xff;
        const b1 = bus.read8((src + 1) >>> 0) & 0xff;
        src = (src + 2) | 0;
        const len = (b0 >>> 4) + 3;
        const dist = (((b0 & 0x0f) << 8) | b1) + 1;
        for (let i = 0; i < len && out.length < size; i++) {
          const refIdx = out.length - dist;
          const byte = refIdx >= 0 ? out[refIdx]! : 0;
          sink.push(byte);
          out.push(byte);
        }
      } else {
        const byte = bus.read8(src >>> 0) & 0xff;
        src = (src + 1) | 0;
        sink.push(byte);
        out.push(byte);
      }
    }
  }
  sink.flush();
  // Real BIOS cost: 20 cycles initial + ~10 cycles per decompressed
  // byte (the bit-by-bit flag decode + LDRB/STRB) — approximates well
  // enough.
  bus.accessCycles += SWI_DISPATCH_CYCLES + 20 + 10 * size;
}

/** SWI 0x14 (Wram) / 0x15 (Vram) — RLUnComp. Run-length encoding.
 *  Each chunk starts with a flag byte:
 *    bit 7 = 1 → run: length = (flag & 0x7F) + 3, next byte repeated.
 *    bit 7 = 0 → literal: length = (flag & 0x7F) + 1, copy next len bytes. */
function biosRleUnComp(regs: ArmRegisters, bus: MemoryBus, vram: boolean): void {
  let src = regs.r[0]! | 0;
  const header = bus.read32(src >>> 0) | 0;
  src = (src + 4) | 0;
  const size = (header >>> 8) & 0xffffff;
  const sink = makeSink(bus, regs.r[1]! | 0, vram);
  let written = 0;
  while (written < size) {
    const flag = bus.read8(src >>> 0) & 0xff;
    src = (src + 1) | 0;
    if ((flag & 0x80) !== 0) {
      const len = (flag & 0x7f) + 3;
      const byte = bus.read8(src >>> 0) & 0xff;
      src = (src + 1) | 0;
      for (let i = 0; i < len && written < size; i++) {
        sink.push(byte);
        written++;
      }
    } else {
      const len = (flag & 0x7f) + 1;
      for (let i = 0; i < len && written < size; i++) {
        sink.push(bus.read8(src >>> 0) & 0xff);
        src = (src + 1) | 0;
        written++;
      }
    }
  }
  sink.flush();
}

/** SWI 0x16 (Wram) / 0x17 (Vram) — Diff8bitUnFilter. The compressed
 *  stream is a difference filter: out[0] = src[0], out[i] = out[i-1]
 *  + src[i] (mod 256). Inverse of `Diff8bitFilter`. */
function biosDiff8bitUnFilter(regs: ArmRegisters, bus: MemoryBus, vram: boolean): void {
  let src = regs.r[0]! | 0;
  const header = bus.read32(src >>> 0) | 0;
  src = (src + 4) | 0;
  const size = (header >>> 8) & 0xffffff;
  const sink = makeSink(bus, regs.r[1]! | 0, vram);
  let acc = 0;
  for (let i = 0; i < size; i++) {
    acc = (acc + (bus.read8(src >>> 0) & 0xff)) & 0xff;
    src = (src + 1) | 0;
    sink.push(acc);
  }
  sink.flush();
}

/** SWI 0x18 — Diff16bitUnFilter. Same as Diff8bit but operates on
 *  halfwords. Output is always halfword-aligned (VRAM-safe). */
function biosDiff16bitUnFilter(regs: ArmRegisters, bus: MemoryBus): void {
  let src = regs.r[0]! | 0;
  let dst = regs.r[1]! | 0;
  const header = bus.read32(src >>> 0) | 0;
  src = (src + 4) | 0;
  const size = (header >>> 8) & 0xffffff;
  const halfwords = size >>> 1;
  let acc = 0;
  for (let i = 0; i < halfwords; i++) {
    acc = (acc + (bus.read16(src >>> 0) & 0xffff)) & 0xffff;
    src = (src + 2) | 0;
    bus.write16(dst >>> 0, acc);
    dst = (dst + 2) | 0;
  }
}

/** SWI 0x13 — HuffUnComp. Decompresses a Huffman-encoded stream.
 *
 *  Header (4 bytes):
 *    bits 0..3  bits per decompressed symbol (4 or 8)
 *    bits 4..7  type — always 2 for Huffman
 *    bits 8..31 decompressed size in bytes
 *
 *  Then a 1-byte tree-table size (in halfword units), followed by the
 *  tree nodes packed as bytes, then the bitstream as 32-bit little-
 *  endian words read MSB-first.
 *
 *  Tree-walk: start at `treeBase + 1` (the root data byte). For each
 *  bit, the current node's offset (low 6 bits) plus the post-rounding
 *  step gives the next pair of nodes. Bit 6 / bit 7 of the *current*
 *  node mark whether the *next* left / right child is a leaf (so we
 *  emit its symbol instead of descending). Output halfwords are
 *  packed from 4-bit symbols low-nibble-first; 8-bit symbols are
 *  emitted four-at-a-time into 32-bit words. The real BIOS writes 4
 *  bytes at a time; we buffer accordingly. */
function biosHuffUnComp(regs: ArmRegisters, bus: MemoryBus): void {
  let src = regs.r[0]! | 0;
  let dst = regs.r[1]! | 0;
  const header = bus.read32(src >>> 0) | 0;
  src = (src + 4) | 0;
  const symbolBits = header & 0x0f;
  // GBATEK: header `size` is the decompressed BYTE count. For 4-bit
  // symbols (the common case for tile data), two symbols pack into one
  // byte — so we need `size * 2` symbols to fill `size` bytes. Previous
  // logic used `size` as the symbol count, which terminated after only
  // size/2 bytes for 4-bit symbols. That left VRAM block 1 unloaded in
  // Bomberman / Batman (and any other cart whose post-Start title tile
  // stream is 4-bit Huff): the title would render with the tile-data
  // half missing, showing as the backdrop colour where graphics should
  // be (green floor in Bomberman; broken city skyline in Batman).
  const size = (header >>> 8) & 0xffffff;
  const targetSymbols = symbolBits === 8 ? size : size * 2;
  const treeBase = src;
  const treeSize = ((bus.read8(treeBase >>> 0) & 0xff) + 1) * 2;
  const bitstream = (treeBase + treeSize) >>> 0;
  let bitWord = 0;
  let bitsLeft = 0;
  let streamOff = 0;
  // Tree walk state. `nodeAddr` is the address of the byte we're
  // currently *standing on*; descending follows GBATEK's "round down
  // to even, add (offset+1)*2" rule.
  let nodeAddr = (treeBase + 1) >>> 0;
  let isLeaf = false; // root is always an internal node
  let outWord = 0;
  let outBits = 0;
  let written = 0;
  while (written < targetSymbols) {
    if (bitsLeft === 0) {
      bitWord = bus.read32((bitstream + streamOff) >>> 0) >>> 0;
      streamOff = (streamOff + 4) | 0;
      bitsLeft = 32;
    }
    const bit = (bitWord >>> 31) & 1;
    bitWord = (bitWord << 1) >>> 0;
    bitsLeft--;
    const parentByte = bus.read8(nodeAddr >>> 0) & 0xff;
    const offset = parentByte & 0x3f;
    const leafFlag = bit === 0 ? 0x80 : 0x40;
    const nextLeaf = (parentByte & leafFlag) !== 0;
    const pairBase = (nodeAddr & ~1) + (offset + 1) * 2;
    nodeAddr = (pairBase + bit) >>> 0;
    isLeaf = nextLeaf;
    if (isLeaf) {
      const symbol = bus.read8(nodeAddr >>> 0) & 0xff;
      if (symbolBits === 8) {
        outWord = (outWord | (symbol << outBits)) >>> 0;
        outBits += 8;
      } else {
        // 4-bit symbol — low nibble of the byte.
        outWord = (outWord | ((symbol & 0x0f) << outBits)) >>> 0;
        outBits += 4;
      }
      written++;
      if (outBits === 32) {
        bus.write32(dst >>> 0, outWord | 0);
        dst = (dst + 4) | 0;
        outWord = 0;
        outBits = 0;
      }
      nodeAddr = (treeBase + 1) >>> 0;
      isLeaf = false;
    }
  }
  // Flush any partial word — real BIOS pads with zeros (already done
  // by the way `outWord` accumulates).
  if (outBits > 0) {
    bus.write32(dst >>> 0, outWord | 0);
  }
}
