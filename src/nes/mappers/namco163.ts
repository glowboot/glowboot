/**
 * Namco 163 (iNES mapper 19) — Megami Tensei II, Rolling Thunder, Mappy-Land,
 * Final Lap. PRG/CHR banking, a 15-bit cycle IRQ, and a wavetable sound chip:
 * up to eight channels reading 4-bit samples from 128 bytes of internal RAM,
 * time-multiplexed one channel per 15 CPU cycles.
 *
 * Nametable control routes each table to CIRAM here (the alternate
 * CHR-ROM-as-nametable mode is approximated as CIRAM), so a few titles that
 * page graphics into the nametables render imperfectly; the audio is faithful.
 * References: https://www.nesdev.org/wiki/INES_Mapper_019 and /Namco_163_audio.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB

class Namco163Audio implements ExpansionAudio {
  readonly ram = new Uint8Array(0x80);
  private addr = 0;
  private autoInc = false;
  private prescaler = 0;
  private cur = 0;
  private readonly phase = new Int32Array(8); // 24-bit accumulator per channel slot
  private readonly sample = new Int32Array(8); // last (nibble-8)*volume per slot

  writeAddr(value: number): void {
    this.addr = value & 0x7f;
    this.autoInc = (value & 0x80) !== 0;
  }
  writeData(value: number): void {
    this.ram[this.addr] = value;
    if (this.autoInc) this.addr = (this.addr + 1) & 0x7f;
  }
  readData(): number {
    const v = this.ram[this.addr]!;
    if (this.autoInc) this.addr = (this.addr + 1) & 0x7f;
    return v;
  }

  private numChannels(): number {
    return ((this.ram[0x7f]! >> 4) & 7) + 1;
  }

  clock(): void {
    if (++this.prescaler < 15) return;
    this.prescaler = 0;
    const n = this.numChannels();
    this.updateChannel(7 - this.cur);
    this.cur = this.cur + 1 >= n ? 0 : this.cur + 1;
  }

  private updateChannel(slot: number): void {
    const base = 0x40 + slot * 8;
    const ram = this.ram;
    const freq = ram[base]! | (ram[base + 2]! << 8) | ((ram[base + 4]! & 0x03) << 16);
    const length = 256 - (ram[base + 4]! & 0xfc);
    const waveAddr = ram[base + 6]!;
    const volume = ram[base + 7]! & 0x0f;
    let ph = this.phase[slot]! + freq;
    const span = length << 16;
    if (span > 0) ph %= span;
    this.phase[slot] = ph;
    const pos = ((ph >> 16) + waveAddr) & 0xff;
    const byte = ram[pos >> 1]!;
    const nibble = pos & 1 ? byte >> 4 : byte & 0x0f;
    this.sample[slot] = (nibble - 8) * volume;
  }

  output(): number {
    const n = this.numChannels();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.sample[7 - i]!;
    return sum * 0.0006;
  }

  serialize(w: NesStateWriter): void {
    w.bytes(this.ram);
    w.u8(this.addr);
    w.bool(this.autoInc);
    w.u8(this.prescaler);
    w.u8(this.cur);
    for (let i = 0; i < 8; i++) w.i32(this.phase[i]!);
    for (let i = 0; i < 8; i++) w.i32(this.sample[i]!);
  }
  deserialize(r: NesStateReader): void {
    r.bytes(this.ram);
    this.addr = r.u8();
    this.autoInc = r.bool();
    this.prescaler = r.u8();
    this.cur = r.u8();
    for (let i = 0; i < 8; i++) this.phase[i] = r.i32();
    for (let i = 0; i < 8; i++) this.sample[i] = r.i32();
  }
}

export class Namco163Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly sound = new Namco163Audio();

  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private readonly nt = [0, 0, 0, 0]; // nametable source registers

  private irqCounter = 0;
  private irqEnabled = false;
  private irqPending = false;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / PRG_BANK);
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / CHR_BANK);
  }

  audio(): ExpansionAudio {
    return this.sound;
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount - 1 : this.prgBanks[region]!;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const block = addr & 0xf800;
    if (block >= 0x8000 && block <= 0xb800) {
      this.chrBanks[(block - 0x8000) >> 11] = value;
    } else if (block >= 0xc000 && block <= 0xd800) {
      this.nt[(block - 0xc000) >> 11] = value;
    } else if (block === 0xe000) {
      this.prgBanks[0] = value & 0x3f;
    } else if (block === 0xe800) {
      this.prgBanks[1] = value & 0x3f;
    } else if (block === 0xf000) {
      this.prgBanks[2] = value & 0x3f;
    } else if (block === 0xf800) {
      this.sound.writeAddr(value);
    }
  }

  lowWrite(addr: number, value: number): void {
    const reg = addr & 0xf800;
    if (reg === 0x4800) this.sound.writeData(value);
    else if (reg === 0x5000) {
      this.irqCounter = (this.irqCounter & 0x7f00) | value;
      this.irqPending = false;
    } else if (reg === 0x5800) {
      this.irqCounter = (this.irqCounter & 0x00ff) | ((value & 0x7f) << 8);
      this.irqEnabled = (value & 0x80) !== 0;
      this.irqPending = false;
    }
  }

  lowRead(addr: number): number | null {
    const reg = addr & 0xf800;
    if (reg === 0x4800) return this.sound.readData();
    if (reg === 0x5000) return this.irqCounter & 0xff;
    if (reg === 0x5800) return (this.irqCounter >> 8) & 0x7f;
    return null;
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
    if (!this.irqEnabled || this.irqCounter >= 0x7fff) return;
    this.irqCounter += cpuCycles;
    if (this.irqCounter >= 0x7fff) {
      this.irqCounter = 0x7fff;
      this.irqPending = true;
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  mirroring(): Mirroring {
    const page = (i: number): number => (this.nt[i]! >= 0xe0 ? this.nt[i]! & 1 : 0);
    const p0 = page(0);
    const p1 = page(1);
    const p2 = page(2);
    const p3 = page(3);
    if (p0 === p1 && p1 === p2 && p2 === p3) return p0 ? "single-upper" : "single-lower";
    if (p0 === p1 && p2 === p3) return "horizontal";
    return "vertical";
  }

  serialize(w: NesStateWriter): void {
    this.sound.serialize(w);
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chrBanks) w.u8(b);
    for (const b of this.nt) w.u8(b);
    w.u16(this.irqCounter);
    w.bool(this.irqEnabled);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.sound.deserialize(r);
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    for (let i = 0; i < this.nt.length; i++) this.nt[i] = r.u8();
    this.irqCounter = r.u16();
    this.irqEnabled = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
