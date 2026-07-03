/**
 * Mapper 1 (MMC1 / SxROM) — Zelda, Metroid, Mega Man 2, Final Fantasy, and a
 * large slice of the library.
 *
 * Configured through a serial port: writes to $8000-$FFFF shift in one bit at a
 * time (LSB first); a write with bit 7 set resets the shift register and forces
 * PRG mode 3. After five bit-writes the 5-bit value lands in one of four
 * registers chosen by address bits 14-13 — control (mirroring + PRG/CHR modes),
 * CHR bank 0, CHR bank 1, PRG bank.
 *
 * Reference: https://www.nesdev.org/wiki/MMC1. 512 KiB SUROM carts (Dragon
 * Warrior 3/4, Final Fantasy 1&2…) reach their upper 256 KiB via PRG A18, taken
 * from bit 4 of the CHR bank 0 register — modelled below, gated on PRG size so
 * ordinary carts that use that bit for CHR banking are unaffected.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const PRG_BANK = 0x4000; // 16 KiB
const CHR_BANK = 0x1000; // 4 KiB

export class Mmc1Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number; // in 16 KiB units

  private shift = 0x10; // bit 4 is the marker that reaches bit 0 on the 5th write
  private control = 0x0c; // power-on: PRG mode 3 (last bank fixed at $C000)
  private chrBank0 = 0;
  private chrBank1 = 0;
  private prgBank = 0;
  private gap = 2; // CPU cycles since the last register write, capped at 2

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = rom.prgRom.length / PRG_BANK;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
  }

  prgRead(addr: number): number {
    const mode = (this.control >> 2) & 3;
    const high = (addr & 0x4000) !== 0; // $C000-$FFFF half
    // SUROM (>256 KiB): CHR bank 0 bit 4 is PRG A18, selecting which 256 KiB
    // page the 16 KiB banks index into — including the fixed bank, which is the
    // last bank *of the current page*, not the last physical bank.
    const surom = this.prgBankCount > 16;
    const a18 = surom ? this.chrBank0 & 0x10 : 0;
    let bank: number;
    switch (mode) {
      case 0:
      case 1: // 32 KiB switch (low bit of prgBank ignored)
        bank = (this.prgBank & 0x0e) | (high ? 1 : 0);
        break;
      case 2: // fix first bank at $8000, switch $C000
        bank = high ? this.prgBank & 0x0f : 0;
        break;
      default: // mode 3: switch $8000, fix last bank at $C000
        bank = high ? (surom ? 0x0f : this.prgBankCount - 1) : this.prgBank & 0x0f;
        break;
    }
    bank |= a18;
    return this.prg[(bank % this.prgBankCount) * PRG_BANK + (addr & 0x3fff)]!;
  }

  /** CPU-cycle clock, used only to spot back-to-back register writes. */
  tick(cpuCycles: number): void {
    this.gap = Math.min(this.gap + cpuCycles, 2);
  }

  prgWrite(_addr: number, value: number): void {
    // The MMC1 ignores a write on the CPU cycle immediately after another: a
    // read-modify-write op (INC/DEC/ASL/…) on a register writes the old value
    // then the new value on consecutive cycles, and only the first is seen.
    // Some games exploit this — an INC on $8000-$FFFF resets the shift register
    // in one instruction (the old value's bit 7 triggers the reset).
    const consecutive = this.gap === 1;
    this.gap = 0;
    if (consecutive) return;
    if (value & 0x80) {
      this.shift = 0x10;
      this.control |= 0x0c;
      return;
    }
    if (this.shift & 1) {
      // Marker has reached bit 0: this is the 5th write — commit.
      const data = (((value & 1) << 4) | (this.shift >> 1)) & 0x1f;
      switch ((_addr >> 13) & 3) {
        case 0:
          this.control = data;
          break;
        case 1:
          this.chrBank0 = data;
          break;
        case 2:
          this.chrBank1 = data;
          break;
        default:
          this.prgBank = data;
          break;
      }
      this.shift = 0x10;
    } else {
      this.shift = ((value & 1) << 4) | (this.shift >> 1);
    }
  }

  chrRead(addr: number): number {
    return this.chr[this.chrOffset(addr)]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr)] = value;
  }

  private chrOffset(addr: number): number {
    let offset: number;
    if (this.control & 0x10) {
      // 4 KiB mode: independent banks at $0000 and $1000.
      const bank = addr < 0x1000 ? this.chrBank0 : this.chrBank1;
      offset = bank * CHR_BANK + (addr & 0x0fff);
    } else {
      // 8 KiB mode: low bit of CHR bank 0 ignored.
      offset = (this.chrBank0 & 0x1e) * CHR_BANK + (addr & 0x1fff);
    }
    return offset % this.chr.length;
  }

  mirroring(): Mirroring {
    switch (this.control & 3) {
      case 0:
        return "single-lower";
      case 1:
        return "single-upper";
      case 2:
        return "vertical";
      default:
        return "horizontal";
    }
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.shift);
    w.u8(this.control);
    w.u8(this.chrBank0);
    w.u8(this.chrBank1);
    w.u8(this.prgBank);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.shift = r.u8();
    this.control = r.u8();
    this.chrBank0 = r.u8();
    this.chrBank1 = r.u8();
    this.prgBank = r.u8();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
