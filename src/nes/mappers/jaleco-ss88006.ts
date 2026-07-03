/**
 * Jaleco SS88006 (iNES mapper 18) — Goal!, The Lord of King, Pizza Pop!,
 * Moe Pro! baseball series. Three switchable 8 KiB PRG banks (+ fixed last) and
 * eight 1 KiB CHR banks, each programmed a nibble at a time, plus a runtime
 * mirroring register and a 16-bit down-counter IRQ whose active width (4/8/12/16
 * bits) is selectable — the IRQ fires when the masked low bits underflow.
 *
 * The chip's rarely-used expansion audio is not emulated.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_018.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB
const MIRROR = ["horizontal", "vertical", "single-lower", "single-upper"] as const;

export class JalecoSs88006Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqLatch = 0;
  private irqCounter = 0;
  private irqMask = 0xffff;
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
    this.chrBankCount = Math.max(1, this.chr.length / CHR_BANK);
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount - 1 : this.prgBanks[region]!;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  /** Merge `value`'s low nibble into `bank` at the given nibble (0-3). */
  private static nibble(bank: number, value: number, idx: number): number {
    const shift = idx * 4;
    return (bank & ~(0x0f << shift)) | ((value & 0x0f) << shift);
  }

  prgWrite(addr: number, value: number): void {
    const reg = addr & 0xf003;
    switch (reg) {
      case 0x8000:
      case 0x8001:
        this.prgBanks[0] = JalecoSs88006Mapper.nibble(this.prgBanks[0]!, value, reg & 1);
        break;
      case 0x8002:
      case 0x8003:
        this.prgBanks[1] = JalecoSs88006Mapper.nibble(this.prgBanks[1]!, value, reg & 1);
        break;
      case 0x9000:
      case 0x9001:
        this.prgBanks[2] = JalecoSs88006Mapper.nibble(this.prgBanks[2]!, value, reg & 1);
        break;
      case 0xf002:
        this.mirror = MIRROR[value & 3]!;
        break;
      case 0xe000:
      case 0xe001:
      case 0xe002:
      case 0xe003:
        this.irqLatch = JalecoSs88006Mapper.nibble(this.irqLatch, value, reg & 3);
        break;
      case 0xf000:
        this.irqCounter = this.irqLatch;
        this.irqPending = false;
        break;
      case 0xf001:
        this.irqMask = value & 0x08 ? 0x000f : value & 0x04 ? 0x00ff : value & 0x02 ? 0x0fff : 0xffff;
        this.irqEnabled = (value & 0x01) !== 0;
        this.irqPending = false;
        break;
      default:
        if ((reg & 0xf003) >= 0xa000 && (reg & 0xf003) <= 0xd003) this.writeChr(reg, value);
        break;
    }
  }

  private writeChr(reg: number, value: number): void {
    const slot = (((reg & 0xf000) - 0xa000) >> 11) | ((reg & 0x02) >> 1); // 0-7
    const nibble = reg & 1; // 0 = low, 1 = high
    this.chrBanks[slot] = JalecoSs88006Mapper.nibble(this.chrBanks[slot]!, value, nibble);
  }

  chrRead(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length] = value;
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    const m = this.irqMask;
    for (let i = 0; i < cpuCycles; i++) {
      if ((this.irqCounter & m) === 0) this.irqPending = true; // masked low bits underflow
      this.irqCounter = (this.irqCounter & ~m) | (((this.irqCounter & m) - 1) & m);
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
    w.u16(this.irqLatch);
    w.u16(this.irqCounter);
    w.u16(this.irqMask);
    w.bool(this.irqEnabled);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqLatch = r.u16();
    this.irqCounter = r.u16();
    this.irqMask = r.u16();
    this.irqEnabled = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
