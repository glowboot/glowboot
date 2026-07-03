/**
 * Taito TC0190 / TC0350 (mapper 33) and TC0690 (mapper 48).
 *
 * Both bank PRG as two switchable 8 KiB windows ($8000/$A000) with $C000/$E000
 * fixed to the last two banks, and CHR as two 2 KiB + four 1 KiB banks. Mapper
 * 33 (TC0190, no IRQ — Akira, Don Doko Don, Insector X) takes its mirroring from
 * $8000 bit 6. Mapper 48 (TC0690 — Flintstones 2, Bubble Bobble 2, Jetsons)
 * moves mirroring to $E000 bit 6 and adds an MMC3-style A12 scanline IRQ.
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_033 / _048.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class TaitoTc0190Mapper implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly chrWritable: boolean;
  protected readonly prgBankCount: number; // 8 KiB units
  protected readonly chrBankCount: number; // 1 KiB units

  protected readonly prgBanks = [0, 0]; // $8000, $A000
  protected readonly chr2k = [0, 0]; // PPU $0000, $0800
  protected readonly chr1k = [0, 0, 0, 0]; // PPU $1000/$1400/$1800/$1C00
  protected mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x2000);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / 0x400);
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank =
      region === 0
        ? this.prgBanks[0]!
        : region === 1
          ? this.prgBanks[1]!
          : region === 2
            ? this.prgBankCount - 2
            : this.prgBankCount - 1;
    return this.prg[((bank % this.prgBankCount) * 0x2000 + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    this.bankWrite(addr, value);
  }

  /** The shared $8000/$A000 banking. TC0190 also latches mirroring from $8000. */
  protected bankWrite(addr: number, value: number): void {
    const reg = addr & 3;
    if (addr < 0xa000) {
      switch (reg) {
        case 0:
          this.prgBanks[0] = value & 0x3f;
          this.mirror = value & 0x40 ? "horizontal" : "vertical";
          break;
        case 1:
          this.prgBanks[1] = value & 0x3f;
          break;
        case 2:
          this.chr2k[0] = value;
          break;
        case 3:
          this.chr2k[1] = value;
          break;
      }
    } else if (addr < 0xc000) {
      this.chr1k[reg] = value;
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
    let bank: number;
    if (a < 0x1000) bank = this.chr2k[a >> 11]! * 2 + ((a >> 10) & 1);
    else bank = this.chr1k[(a >> 10) & 3]!;
    return ((bank % this.chrBankCount) * 0x400 + (a & 0x3ff)) % this.chr.length;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chr2k) w.u8(b);
    for (const b of this.chr1k) w.u8(b);
    writeMirroring(w, this.mirror);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chr2k.length; i++) this.chr2k[i] = r.u8();
    for (let i = 0; i < this.chr1k.length; i++) this.chr1k[i] = r.u8();
    this.mirror = readMirroring(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}

/** Mapper 48 (Taito TC0690) — TC0190 banking without the $8000 mirroring bit,
 *  plus mirroring at $E000 and an MMC3-style A12 scanline IRQ ($C000 latch,
 *  $C001 reload, $C002 enable, $C003 disable+ack). Modelled with the MMC3
 *  counter; the TC0690's exact ~1-scanline offset only shifts the raster split. */
export class TaitoTc0690Mapper extends TaitoTc0190Mapper {
  private irqLatch = 0;
  private irqCounter = 0;
  private irqReload = false;
  private irqEnabled = false;
  private irqPending = false;

  protected override bankWrite(addr: number, value: number): void {
    const reg = addr & 3;
    if (addr < 0xa000) {
      // Same as TC0190 but $8000 (reg 0) is a plain PRG bank — no mirroring bit.
      if (reg === 0) this.prgBanks[0] = value & 0x3f;
      else super.bankWrite(addr, value);
    } else if (addr < 0xc000) {
      super.bankWrite(addr, value);
    } else if (addr < 0xe000) {
      switch (reg) {
        case 0:
          this.irqLatch = value;
          break;
        case 1:
          this.irqReload = true;
          break;
        case 2:
          this.irqEnabled = true;
          break;
        case 3:
          this.irqEnabled = false;
          this.irqPending = false;
          break;
      }
    } else {
      this.mirror = value & 0x40 ? "horizontal" : "vertical";
    }
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

  override serialize(w: NesStateWriter): void {
    super.serialize(w);
    w.u8(this.irqLatch);
    w.u8(this.irqCounter);
    w.bool(this.irqReload);
    w.bool(this.irqEnabled);
    w.bool(this.irqPending);
  }
  override deserialize(r: NesStateReader): void {
    super.deserialize(r);
    this.irqLatch = r.u8();
    this.irqCounter = r.u8();
    this.irqReload = r.bool();
    this.irqEnabled = r.bool();
    this.irqPending = r.bool();
  }
}
