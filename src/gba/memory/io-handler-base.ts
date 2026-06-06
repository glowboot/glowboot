/**
 * Default 8/32-bit width adapters for an `IoHandler` that only cares
 * about 16-bit transfers natively.
 *
 * Every GBA MMIO peripheral in this codebase models its register file
 * as 16-bit halfwords — the hardware data path to peripherals is 16
 * bits wide, and the register catalogue (DISPCNT, IE/IF, TM0CNT_*,
 * DMA*, KEYINPUT/KEYCNT, …) is defined in halfword pairs. The bus,
 * though, routes 8-bit STRB and 32-bit STR / LDR transfers through
 * `read8` / `write8` / `read32` / `write32` too, so every handler
 * needs all four widths.
 *
 * The byte and word adapters are mechanical:
 *   - 8-bit read: load the aligned halfword, return the addressed byte.
 *   - 8-bit write: load-modify-store the addressed byte into the
 *                  containing halfword (the bus has no byte-write
 *                  strobe for these regions; the modify-side cycle is
 *                  what real silicon does too).
 *   - 32-bit read: two halfword reads, low-then-high.
 *   - 32-bit write: two halfword writes, low-then-high.
 *
 * Five handlers in this tree implemented all four byte-identically:
 * InterruptController, Dma, Timer, Sio, and Joypad (the last with
 * read-only overrides on its writes). Extracting the common shape
 * here removes ~80 lines of duplication and keeps the byte-rotation
 * rules in one place so any future quirk (e.g. an 8-bit "bias" lane)
 * has one site to fix.
 *
 * Subclasses MUST implement `read16` / `write16`. They MAY override
 * any of the byte/word methods — `Joypad` does, because KEYINPUT is
 * read-only and the byte/word write paths can't go through the
 * canonical load-modify-store.
 */

import type { IoHandler } from "./mapped-bus.js";

export abstract class BaseIoHandler implements IoHandler {
  abstract read16(offset: number): number;
  abstract write16(offset: number, value: number): void;

  read8(offset: number): number {
    const word = this.read16(offset & ~1);
    return (offset & 1) === 0 ? word & 0xff : (word >>> 8) & 0xff;
  }

  write8(offset: number, value: number): void {
    const aligned = offset & ~1;
    const current = this.read16(aligned);
    const v = value & 0xff;
    const merged = (offset & 1) === 0 ? (current & 0xff00) | v : (current & 0x00ff) | (v << 8);
    this.write16(aligned, merged);
  }

  read32(offset: number): number {
    const aligned = offset & ~3;
    return this.read16(aligned) | (this.read16(aligned + 2) << 16) | 0;
  }

  write32(offset: number, value: number): void {
    const aligned = offset & ~3;
    this.write16(aligned, value & 0xffff);
    this.write16(aligned + 2, (value >>> 16) & 0xffff);
  }
}
