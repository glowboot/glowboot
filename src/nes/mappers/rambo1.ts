/**
 * Tengen RAMBO-1 (iNES mapper 64) — Klax, Skull & Crossbones, Rolling Thunder,
 * Shinobi, Road Runner. An MMC3 relative with a different bank layout: three
 * switchable 8 KiB PRG banks (+ fixed last) and either MMC3-style 2 KiB+1 KiB
 * CHR or a fully 1 KiB mode (the K bit), driven by a 16-entry command set. The
 * scanline-compare IRQ is modelled MMC3-style (the optional CPU-cycle IRQ mode
 * is not). Reference: https://www.nesdev.org/wiki/INES_Mapper_064.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB

export class Rambo1Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;

  private command = 0; // bits 0-3 register, bit 5 K (1 KiB CHR), bit 6 P (PRG mode)
  private readonly regs = new Uint8Array(16);
  private mirror: Mirroring;

  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private irqPending = false;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const last = this.prgBankCount - 1;
    const p = (this.command & 0x40) !== 0;
    let bank: number;
    switch (region) {
      case 0:
        bank = p ? this.regs[15]! : this.regs[6]!;
        break;
      case 1:
        bank = p ? this.regs[6]! : this.regs[7]!;
        break;
      case 2:
        bank = p ? this.regs[7]! : this.regs[15]!;
        break;
      default:
        bank = last;
        break;
    }
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const even = (addr & 1) === 0;
    if (addr < 0xa000) {
      if (even) this.command = value;
      else this.regs[this.command & 0x0f] = value;
    } else if (addr < 0xc000) {
      if (even) this.mirror = value & 1 ? "horizontal" : "vertical";
    } else if (addr < 0xe000) {
      if (even) this.irqLatch = value;
      else this.irqReload = true;
    } else {
      if (even) {
        this.irqEnabled = false;
        this.irqPending = false;
      } else {
        this.irqEnabled = true;
      }
    }
  }

  chrRead(addr: number): number {
    return this.chr[this.chrOffset(addr)]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr)] = value;
  }

  private chrOffset(addr: number): number {
    const a = addr & 0x1fff;
    const slot = a >> 10; // 0-7 (1 KiB)
    let bank: number;
    if (this.command & 0x20) {
      // K = 1: eight independent 1 KiB banks.
      bank = this.regs[[0, 8, 1, 9, 2, 3, 4, 5][slot]!]!;
    } else {
      // K = 0: R0/R1 are 2 KiB, R2-R5 are 1 KiB (MMC3-style).
      switch (slot) {
        case 0:
          bank = this.regs[0]! & 0xfe;
          break;
        case 1:
          bank = this.regs[0]! | 1;
          break;
        case 2:
          bank = this.regs[1]! & 0xfe;
          break;
        case 3:
          bank = this.regs[1]! | 1;
          break;
        default:
          bank = this.regs[slot - 2]!; // slots 4-7 → R2-R5
          break;
      }
    }
    return (bank * CHR_BANK + (a & 0x3ff)) % this.chr.length;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  clockIrq(): void {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnabled) this.irqPending = true;
  }

  irqState(): boolean {
    return this.irqPending;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.command);
    w.bytes(this.regs);
    writeMirroring(w, this.mirror);
    w.u8(this.irqLatch);
    w.u8(this.irqCounter);
    w.bool(this.irqReload);
    w.bool(this.irqEnabled);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.command = r.u8();
    r.bytes(this.regs);
    this.mirror = readMirroring(r);
    this.irqLatch = r.u8();
    this.irqCounter = r.u8();
    this.irqReload = r.bool();
    this.irqEnabled = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
