/**
 * Konami VRC3 (iNES mapper 73) — Salamander.
 *
 * 16 KiB switchable PRG at $8000 (selected by $F000), fixed last 16 KiB at
 * $C000, and 8 KiB CHR RAM. A 16-bit (or 8-bit) cycle-clocked IRQ counter with
 * the same enable/ack/mode control scheme as VRC4.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_073.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const PRG_BANK = 0x4000; // 16 KiB

export class Vrc3Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount: number;
  private readonly mirror: Mirroring;
  private prgBank = 0;

  private irqLatch = 0;
  private irqCounter = 0;
  private irqEnabled = false;
  private irqEnableAfterAck = false;
  private irqEightBit = false;
  private irqPending = false;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    this.chr = new Uint8Array(rom.usesChrRam ? rom.chrRamSize || 0x2000 : rom.chrRom.length);
    if (!rom.usesChrRam) this.chr.set(rom.chrRom);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    const bank = addr < 0xc000 ? this.prgBank : this.prgBankCount - 1;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x3fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf000) {
      case 0x8000:
        this.irqLatch = (this.irqLatch & 0xfff0) | (value & 0x0f);
        break;
      case 0x9000:
        this.irqLatch = (this.irqLatch & 0xff0f) | ((value & 0x0f) << 4);
        break;
      case 0xa000:
        this.irqLatch = (this.irqLatch & 0xf0ff) | ((value & 0x0f) << 8);
        break;
      case 0xb000:
        this.irqLatch = (this.irqLatch & 0x0fff) | ((value & 0x0f) << 12);
        break;
      case 0xc000:
        this.irqEnableAfterAck = (value & 0x01) !== 0;
        this.irqEnabled = (value & 0x02) !== 0;
        this.irqEightBit = (value & 0x04) !== 0;
        this.irqPending = false;
        if (this.irqEnabled) this.irqCounter = this.irqLatch;
        break;
      case 0xd000:
        this.irqPending = false;
        this.irqEnabled = this.irqEnableAfterAck;
        break;
      case 0xf000:
        this.prgBank = value & 0x07;
        break;
    }
  }

  chrRead(addr: number): number {
    return this.chr[addr & (this.chr.length - 1)]!;
  }
  chrWrite(addr: number, value: number): void {
    this.chr[addr & (this.chr.length - 1)] = value;
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqEightBit) {
        if ((this.irqCounter & 0xff) === 0xff) {
          this.irqCounter = (this.irqCounter & 0xff00) | (this.irqLatch & 0xff);
          this.irqPending = true;
        } else {
          this.irqCounter++;
        }
      } else if (this.irqCounter === 0xffff) {
        this.irqCounter = this.irqLatch;
        this.irqPending = true;
      } else {
        this.irqCounter++;
      }
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    w.u16(this.irqLatch);
    w.u16(this.irqCounter);
    w.bool(this.irqEnabled);
    w.bool(this.irqEnableAfterAck);
    w.bool(this.irqEightBit);
    w.bool(this.irqPending);
    w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    this.irqLatch = r.u16();
    this.irqCounter = r.u16();
    this.irqEnabled = r.bool();
    this.irqEnableAfterAck = r.bool();
    this.irqEightBit = r.bool();
    this.irqPending = r.bool();
    r.bytes(this.chr);
  }
}
