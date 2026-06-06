/**
 * ARM7TDMI register file.
 *
 * Physical registers (37 total): R0–R7 shared across all modes, R8–R12
 * banked between FIQ and "everything else", R13/R14 banked per-mode
 * (User/System share one bank), R15 (PC) shared, CPSR shared, SPSR
 * banked per privileged mode.
 *
 * The 16 currently-visible registers live in `r` as a contiguous
 * Int32Array — instruction decoders index it directly. `setMode`
 * swaps the appropriate banked copies in and out when the processor
 * changes mode.
 *
 * Mode encoding (CPSR[4:0]):
 *   0x10 usr (User)         0x13 svc (Supervisor)
 *   0x11 fiq (FIQ)          0x17 abt (Abort)
 *   0x12 irq (IRQ)          0x1B und (Undefined)
 *                           0x1F sys (System — privileged user)
 *
 * CPSR layout:
 *   [4:0]  mode bits
 *   [5]    T (Thumb state)
 *   [6]    F (FIQ disable)
 *   [7]    I (IRQ disable)
 *   [28]   V (overflow)     [30]   Z (zero)
 *   [29]   C (carry)        [31]   N (negative)
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";

export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

export const CPSR_T = 1 << 5;
export const CPSR_F = 1 << 6;
export const CPSR_I = 1 << 7;
export const CPSR_V = 1 << 28;
export const CPSR_C = 1 << 29;
export const CPSR_Z = 1 << 30;
export const CPSR_N = 1 << 31;

const CPSR_MODE_MASK = 0x1f;

type BankName = "usr" | "fiq" | "irq" | "svc" | "abt" | "und";

/** Map an ARM mode (5-bit) to its register bank. Reserved mode
 *  encodings (0x14, 0x15, 0x16, 0x18-0x1A, 0x1C-0x1E) share USR's
 *  bank — that's what real ARM7TDMI silicon does. Without this, a
 *  cart that MSR's CPSR to a reserved mode (MMBN
 *  uses 0x14 between IRQ-window guards) would see IRQ-mode r13 leak
 *  into its user stack on the next IRQ entry, corrupting the cart's
 *  IRQ-mode SP across frames. */
function bankFromMode(mode: number): BankName {
  switch (mode & CPSR_MODE_MASK) {
    case MODE_FIQ:
      return "fiq";
    case MODE_IRQ:
      return "irq";
    case MODE_SVC:
      return "svc";
    case MODE_ABT:
      return "abt";
    case MODE_UND:
      return "und";
    default:
      return "usr";
  }
}

export class ArmRegisters {
  readonly r = new Int32Array(16);
  cpsr: number;

  private readonly r13Bank: Record<BankName, number> = { usr: 0, fiq: 0, irq: 0, svc: 0, abt: 0, und: 0 };
  private readonly r14Bank: Record<BankName, number> = { usr: 0, fiq: 0, irq: 0, svc: 0, abt: 0, und: 0 };

  // R8–R12 banking is FIQ-vs-everything-else, not per-mode. Two
  // 5-element slots is enough.
  private readonly nonFiqR8to12 = new Int32Array(5);
  private readonly fiqR8to12 = new Int32Array(5);

  // No SPSR in usr/sys; access returns the CPSR by convention. The
  // spec leaves it undefined, but reading the CPSR is what real-world
  // cart code (which probes SPSR from SYS mode at boot) ends up
  // observing.
  private readonly spsrBank: Record<Exclude<BankName, "usr">, number> = {
    fiq: 0,
    irq: 0,
    svc: 0,
    abt: 0,
    und: 0
  };

  /** ARM7TDMI reset state: SVC mode, IRQs + FIQs masked, ARM state.
   *  The Gba constructor walks through the modes seeding each bank's
   *  SP and then switches to SYS mode with IRQs unmasked — that's the
   *  state real BIOS hands the cart, not this one. */
  constructor() {
    this.cpsr = MODE_SVC | CPSR_I | CPSR_F;
  }

  get mode(): number {
    return this.cpsr & CPSR_MODE_MASK;
  }

  setMode(newMode: number): void {
    const masked = newMode & CPSR_MODE_MASK;
    const oldMode = this.mode;
    if (masked === oldMode) {
      this.cpsr = (this.cpsr & ~CPSR_MODE_MASK) | masked;
      return;
    }
    const oldBank = bankFromMode(oldMode);
    const newBank = bankFromMode(masked);

    if (oldBank !== newBank) {
      this.r13Bank[oldBank] = this.r[13]!;
      this.r14Bank[oldBank] = this.r[14]!;
      this.r[13] = this.r13Bank[newBank];
      this.r[14] = this.r14Bank[newBank];
    }

    const oldIsFiq = oldMode === MODE_FIQ;
    const newIsFiq = masked === MODE_FIQ;
    if (oldIsFiq !== newIsFiq) {
      const saveTarget = oldIsFiq ? this.fiqR8to12 : this.nonFiqR8to12;
      const loadSource = newIsFiq ? this.fiqR8to12 : this.nonFiqR8to12;
      for (let i = 0; i < 5; i++) {
        saveTarget[i] = this.r[8 + i]!;
        this.r[8 + i] = loadSource[i]!;
      }
    }

    this.cpsr = (this.cpsr & ~CPSR_MODE_MASK) | masked;
  }

  /** SPSR for the current mode. In usr/sys/reserved modes there is no
   *  SPSR — return the CPSR so callers don't have to special-case it. */
  get spsr(): number {
    const bank = bankFromMode(this.mode);
    return bank === "usr" ? this.cpsr : this.spsrBank[bank];
  }
  set spsr(v: number) {
    const bank = bankFromMode(this.mode);
    if (bank === "usr") return;
    this.spsrBank[bank] = v | 0;
  }

  get nFlag(): boolean {
    return (this.cpsr & CPSR_N) !== 0;
  }
  set nFlag(on: boolean) {
    this.cpsr = on ? this.cpsr | CPSR_N : this.cpsr & ~CPSR_N;
  }
  get zFlag(): boolean {
    return (this.cpsr & CPSR_Z) !== 0;
  }
  set zFlag(on: boolean) {
    this.cpsr = on ? this.cpsr | CPSR_Z : this.cpsr & ~CPSR_Z;
  }
  get cFlag(): boolean {
    return (this.cpsr & CPSR_C) !== 0;
  }
  set cFlag(on: boolean) {
    this.cpsr = on ? this.cpsr | CPSR_C : this.cpsr & ~CPSR_C;
  }
  get vFlag(): boolean {
    return (this.cpsr & CPSR_V) !== 0;
  }
  set vFlag(on: boolean) {
    this.cpsr = on ? this.cpsr | CPSR_V : this.cpsr & ~CPSR_V;
  }
  get tFlag(): boolean {
    return (this.cpsr & CPSR_T) !== 0;
  }
  get iFlag(): boolean {
    return (this.cpsr & CPSR_I) !== 0;
  }
  get fFlag(): boolean {
    return (this.cpsr & CPSR_F) !== 0;
  }

  // ─── Save state ───────────────────────────────────────────────────────────
  //
  // Banks are serialized verbatim; we don't sync the currently-active
  // r[13] / r[14] into the bank slot for the running mode (real silicon
  // doesn't either — the bank slot is stale until setMode swaps it out).
  // As long as save + load mirror the same shape, the system stays
  // self-consistent.

  serialize(w: GbaStateWriter): void {
    for (let i = 0; i < 16; i++) w.i32(this.r[i]!);
    w.u32(this.cpsr >>> 0);
    for (const bank of BANK_ORDER) w.i32(this.r13Bank[bank]);
    for (const bank of BANK_ORDER) w.i32(this.r14Bank[bank]);
    for (let i = 0; i < 5; i++) w.i32(this.nonFiqR8to12[i]!);
    for (let i = 0; i < 5; i++) w.i32(this.fiqR8to12[i]!);
    for (const bank of SPSR_BANK_ORDER) w.i32(this.spsrBank[bank]);
  }

  deserialize(r: GbaStateReader): void {
    for (let i = 0; i < 16; i++) this.r[i] = r.i32();
    this.cpsr = r.u32() | 0;
    for (const bank of BANK_ORDER) this.r13Bank[bank] = r.i32();
    for (const bank of BANK_ORDER) this.r14Bank[bank] = r.i32();
    for (let i = 0; i < 5; i++) this.nonFiqR8to12[i] = r.i32();
    for (let i = 0; i < 5; i++) this.fiqR8to12[i] = r.i32();
    for (const bank of SPSR_BANK_ORDER) this.spsrBank[bank] = r.i32();
  }
}

const BANK_ORDER: readonly BankName[] = ["usr", "fiq", "irq", "svc", "abt", "und"];
const SPSR_BANK_ORDER: readonly Exclude<BankName, "usr">[] = ["fiq", "irq", "svc", "abt", "und"];
