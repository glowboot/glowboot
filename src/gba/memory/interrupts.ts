/**
 * GBA interrupt controller — IE / IF / IME I/O at 0x04000200..0x0400020B.
 *
 * Register layout (per GBATEK):
 *   0x200 IE       Interrupt Enable mask (RW). Bit N enables source N.
 *   0x202 IF       Interrupt Flags (RW, write-1-to-clear). Bit N set =
 *                  source N has a pending request.
 *   0x204 WAITCNT  Wait-state config (RW). Stored here and forwarded
 *                  via `onWaitcntChange` so the bus rebuilds its N/S
 *                  cycle tables for cart-ROM / SRAM accesses.
 *   0x208 IME      Master IRQ enable (RW). Only bit 0 matters; the
 *                  upper bits round-trip but have no effect.
 *
 * Pending-IRQ rule:
 *   (IME & 1) != 0 AND (IE & IF) != 0 AND CPSR.I = 0
 *
 * The CPU step loop polls `pending` before each instruction and, when
 * true, performs the standard ARM exception entry (switch to IRQ mode,
 * SPSR_irq = CPSR, set I, clear T, LR_irq = return address, PC = 0x18).
 * The BIOS-vector-to-user-handler hop at 0x18 is HLE'd in cpu.ts.
 *
 * Sources (bit positions):
 *   0  VBlank        7   Serial
 *   1  HBlank        8   DMA0
 *   2  VCount match  9   DMA1
 *   3  Timer 0       10  DMA2
 *   4  Timer 1       11  DMA3
 *   5  Timer 2       12  Keypad
 *   6  Timer 3       13  GamePak (cart-removed)
 */

import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import { BaseIoHandler } from "./io-handler-base.js";

export const IRQ_VBLANK = 0;
export const IRQ_HBLANK = 1;
export const IRQ_VCOUNT = 2;
export const IRQ_TIMER0 = 3;
export const IRQ_TIMER1 = 4;
export const IRQ_TIMER2 = 5;
export const IRQ_TIMER3 = 6;
/** Raised by the SIO controller (`gba/sio/sio.ts`) when a Multiplayer
 *  transfer completes and SIOCNT bit 14 (IRQ enable) is set. Wired
 *  alongside the rest of the IRQ sources by the Gba constructor. */
export const IRQ_SERIAL = 7;
export const IRQ_DMA0 = 8;
export const IRQ_DMA1 = 9;
export const IRQ_DMA2 = 10;
export const IRQ_DMA3 = 11;
/** Raised by the joypad controller when the KEYCNT key-match condition
 *  is met and KEYCNT bit 14 (IRQ enable) is set. */
export const IRQ_KEYPAD = 12;
// IRQ_GAMEPAK (13, gamepak-removed IRQ) is omitted — not wired.

const REG_IE = 0x00;
const REG_IF = 0x02;
const REG_WAITCNT = 0x04;
const REG_IME = 0x08;

/** Bits that participate in IF / IE — 14 sources, bits 0..13. */
const IRQ_MASK = 0x3fff;

export class InterruptController extends BaseIoHandler {
  /** IE — which sources are allowed to interrupt. */
  ie = 0;
  /** IF — which sources have a pending request. Write-1-to-clear. */
  if_ = 0;
  /** IME — master IRQ enable. Bit 0 is the only functional bit. */
  ime = 0;
  /** WAITCNT — wait-state config. Stored here; the bus's N/S cycle
   *  tables are rebuilt via `onWaitcntChange` whenever this updates. */
  waitcnt = 0;
  /** Bus hook: gets called with the new WAITCNT value after a write
   *  so the cycle-cost tables can be rebuilt. Wired by makeGbaMemoryMap. */
  onWaitcntChange: ((value: number) => void) | null = null;

  /** Raise a pending request for `source` (a bit index). The CPU only
   *  delivers when IE has the bit set, IME bit 0 is set, and CPSR.I
   *  is clear; until then the bit just sits in IF. */
  raise(source: number): void {
    this.if_ = (this.if_ | (1 << source)) & IRQ_MASK;
  }

  /** True when an IRQ should be taken at the next CPU step. The CPU
   *  also checks CPSR.I separately (it's the ARM-side mask). */
  get pending(): boolean {
    return (this.ime & 1) !== 0 && (this.ie & this.if_ & IRQ_MASK) !== 0;
  }

  read16(offset: number): number {
    const aligned = offset & ~1;
    switch (aligned) {
      case REG_IE:
        return this.ie & IRQ_MASK;
      case REG_IF:
        return this.if_ & IRQ_MASK;
      case REG_WAITCNT:
        return this.waitcnt & 0xffff;
      case REG_IME:
        return this.ime & 0xffff;
      case REG_IME + 2:
        // 0x0400020A is the unused half of the IME register. Real
        // hardware reads it as 0; mgba-suite io-read's "INVALID (20A)"
        // subtest verifies this. Don't expose the upper half of `ime`
        // even if a 32-bit write to 0x208 happened to set it.
        return 0;
      default:
        return 0;
    }
  }

  write16(offset: number, value: number): void {
    const v = value & 0xffff;
    const aligned = offset & ~1;
    switch (aligned) {
      case REG_IE:
        this.ie = v & IRQ_MASK;
        return;
      case REG_IF:
        // Write-1-to-clear: each 1-bit in the write acknowledges that
        // pending bit and clears it from IF.
        this.if_ = this.if_ & ~v & IRQ_MASK;
        return;
      case REG_WAITCNT:
        this.waitcnt = v;
        this.onWaitcntChange?.(v);
        return;
      case REG_IME:
        // Only bit 0 of IME is functional; the rest is don't-care but
        // we keep the full halfword for symmetry with real hardware's
        // register latch (a 16-bit read of 0x208 returns whatever was
        // written there).
        this.ime = v;
        return;
      case REG_IME + 2:
        // Writes to the unused half of IME are dropped. See the read
        // path for the rationale.
        return;
      default:
        return;
    }
  }

  serialize(w: GbaStateWriter): void {
    w.u16(this.ie);
    w.u16(this.if_);
    w.u16(this.ime);
    w.u16(this.waitcnt);
  }

  deserialize(r: GbaStateReader): void {
    this.ie = r.u16();
    this.if_ = r.u16();
    this.ime = r.u16();
    this.waitcnt = r.u16();
  }
}
