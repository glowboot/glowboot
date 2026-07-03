/**
 * Mapper 65 (Irem H3001) — Daiku no Gen-san 2, Spartan X 2, Kaiketsu Yanchamaru
 * 3, … 8 KiB PRG banks ($8000/$A000/$C000 switchable, $E000 fixed last), eight
 * 1 KiB CHR banks, and a 16-bit down-counter IRQ clocked per CPU cycle.
 *
 * Registers: $8000/$A000/$C000 PRG; $9001 mirroring; $9003 IRQ enable; $9004
 * IRQ reload; $9005/$9006 IRQ counter high/low; $B000-$B007 CHR.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_065.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

export class IremH3001Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly prgBankCount8k: number;
  private readonly chrBankCount1k: number;
  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000 (set at power-on below)
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqEnabled = false;
  private irqCounter = 0;
  private irqLatch = 0;
  private irqPending = false;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.prgBankCount8k = Math.max(1, rom.prgRom.length / 0x2000);
    this.chrBankCount1k = Math.max(1, rom.chrRom.length / 0x400);
    this.mirror = rom.mirroring;
    // Power-on maps the top 32 KiB of PRG contiguously into the three switchable
    // slots (the fourth, $E000, is always the fixed last bank). Several games —
    // Daiku no Gen-san 2, Spartan X 2, Kaiketsu Yanchamaru 3 — JSR into $C000
    // space during reset before they ever write the $C000 bank register, so the
    // slot must already hold bank N-2 rather than 0.
    const n = this.prgBankCount8k;
    this.prgBanks[0] = Math.max(0, n - 4);
    this.prgBanks[1] = Math.max(0, n - 3);
    this.prgBanks[2] = Math.max(0, n - 2);
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount8k - 1 : this.prgBanks[region]!;
    return this.prg[(bank % this.prgBankCount8k) * 0x2000 + (addr & 0x1fff)]!;
  }

  prgWrite(addr: number, value: number): void {
    switch (addr & 0xf007) {
      case 0x8000:
        this.prgBanks[0] = value;
        break;
      case 0xa000:
        this.prgBanks[1] = value;
        break;
      case 0xc000:
        this.prgBanks[2] = value;
        break;
      case 0x9001:
        this.mirror = value & 0x80 ? "horizontal" : "vertical";
        break;
      case 0x9003:
        this.irqEnabled = (value & 0x80) !== 0;
        this.irqPending = false;
        break;
      case 0x9004:
        this.irqCounter = this.irqLatch;
        this.irqPending = false;
        break;
      case 0x9005:
        this.irqLatch = (this.irqLatch & 0x00ff) | (value << 8);
        break;
      case 0x9006:
        this.irqLatch = (this.irqLatch & 0xff00) | value;
        break;
      default:
        if ((addr & 0xf008) === 0xb000) this.chrBanks[addr & 7] = value;
        break;
    }
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return this.chr[(bank % this.chrBankCount1k) * 0x400 + (addr & 0x3ff)]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCounter === 0) {
        this.irqPending = true;
      } else {
        this.irqCounter--;
        if (this.irqCounter === 0) this.irqPending = true;
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
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    w.bool(this.irqEnabled);
    w.u16(this.irqCounter);
    w.u16(this.irqLatch);
    w.bool(this.irqPending);
  }
  deserialize(r: NesStateReader): void {
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqEnabled = r.bool();
    this.irqCounter = r.u16();
    this.irqLatch = r.u16();
    this.irqPending = r.bool();
  }
}
