/**
 * Konami VRC7 (iNES mapper 85) — Lagrange Point. VRC4-style banking (three
 * switchable 8 KiB PRG banks + fixed last, eight 1 KiB CHR banks, VRC4
 * latch/prescaler IRQ, runtime mirroring) plus the OPLL (YM2413-derived) FM
 * sound chip: six two-operator FM channels with a fixed 15-instrument patch ROM.
 *
 * The FM core is a float-domain port of the OPLL algorithm (correct pitch,
 * 2-operator modulation, feedback, and ADSR envelopes) rather than the chip's
 * exact integer log/exp pipeline — there is no VRC7 test ROM to validate
 * against bit-for-bit, and the result is musically faithful.
 * References: https://www.nesdev.org/wiki/VRC7_audio and /VRC7.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB
const SINE = (() => {
  const t = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) t[i] = Math.sin((2 * Math.PI * i) / 1024);
  return t;
})();
const MULT = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // ×0.5

/** VRC7 fixed instrument patches 1-15, eight bytes each (patch 0 is the user
 *  patch programmed via $00-$07). Nuke.YKT-verified dump. */
// prettier-ignore
const PATCHES = [
  [0x03,0x21,0x05,0x06,0xe8,0x81,0x42,0x27], [0x13,0x41,0x14,0x0d,0xd8,0xf6,0x23,0x12],
  [0x11,0x11,0x08,0x08,0xfa,0xb2,0x20,0x12], [0x31,0x61,0x0c,0x07,0xa8,0x64,0x61,0x27],
  [0x32,0x21,0x1e,0x06,0xe1,0x76,0x01,0x28], [0x02,0x01,0x06,0x00,0xa3,0xe2,0xf4,0xf4],
  [0x21,0x61,0x1d,0x07,0x82,0x81,0x11,0x07], [0x23,0x21,0x22,0x17,0xa2,0x72,0x01,0x17],
  [0x35,0x11,0x25,0x00,0x40,0x73,0x72,0x01], [0xb5,0x01,0x0f,0x0f,0xa8,0xa5,0x51,0x02],
  [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], [0x71,0x23,0x11,0x06,0x65,0x74,0x18,0x16],
  [0x01,0x02,0xd3,0x05,0xc9,0x95,0x03,0x02], [0x61,0x63,0x0c,0x00,0x94,0xc0,0x33,0xf6],
  [0x21,0x72,0x0d,0x00,0xc1,0xd5,0x56,0x06],
];

const enum Eg {
  Idle,
  Attack,
  Decay,
  Sustain,
  Release
}

/** One FM operator: a phase generator plus a dB-domain ADSR envelope. */
class Op {
  mult = 0.5;
  totalLevel = 0; // dB attenuation
  ar = 0;
  dr = 0;
  sl = 0;
  rr = 0;
  egType = false; // true = sustained, false = percussive
  ksr = false;
  feedback = 0;
  phase = 0;
  att = 48; // current dB attenuation (48 = silence)
  state = Eg.Idle;
  out = 0;
  prev = 0;

  keyOn(): void {
    this.state = Eg.Attack;
    this.phase = 0;
  }
  keyOff(): void {
    if (this.state !== Eg.Idle) this.state = Eg.Release;
  }

  private rateStep(rate: number, scale: number): number {
    if (rate === 0) return 0;
    return scale * Math.pow(1.6, rate);
  }

  envelope(): number {
    switch (this.state) {
      case Eg.Attack:
        this.att -= this.rateStep(this.ar, 0.5);
        if (this.att <= 0) {
          this.att = 0;
          this.state = Eg.Decay;
        }
        break;
      case Eg.Decay:
        this.att += this.rateStep(this.dr, 0.12);
        if (this.att >= this.sl) {
          this.att = this.sl;
          this.state = this.egType ? Eg.Sustain : Eg.Release;
        }
        break;
      case Eg.Release:
        this.att += this.rateStep(this.rr, 0.12);
        if (this.att >= 48) {
          this.att = 48;
          this.state = Eg.Idle;
        }
        break;
    }
    const total = this.att + this.totalLevel;
    return total >= 48 ? 0 : Math.pow(10, -total / 20);
  }

  serialize(w: NesStateWriter): void {
    w.f64(this.mult);
    w.f64(this.totalLevel);
    w.f64(this.ar);
    w.f64(this.dr);
    w.f64(this.sl);
    w.f64(this.rr);
    w.bool(this.egType);
    w.bool(this.ksr);
    w.f64(this.feedback);
    w.f64(this.phase);
    w.f64(this.att);
    w.u8(this.state);
    w.f64(this.out);
    w.f64(this.prev);
  }
  deserialize(r: NesStateReader): void {
    this.mult = r.f64();
    this.totalLevel = r.f64();
    this.ar = r.f64();
    this.dr = r.f64();
    this.sl = r.f64();
    this.rr = r.f64();
    this.egType = r.bool();
    this.ksr = r.bool();
    this.feedback = r.f64();
    this.phase = r.f64();
    this.att = r.f64();
    this.state = r.u8() as Eg;
    this.out = r.f64();
    this.prev = r.f64();
  }
}

class Channel {
  readonly mod = new Op();
  readonly car = new Op();
  fnum = 0;
  block = 0;
  keyed = false;
  out = 0;

  serialize(w: NesStateWriter): void {
    this.mod.serialize(w);
    this.car.serialize(w);
    w.u16(this.fnum);
    w.u8(this.block);
    w.bool(this.keyed);
    w.f64(this.out);
  }
  deserialize(r: NesStateReader): void {
    this.mod.deserialize(r);
    this.car.deserialize(r);
    this.fnum = r.u16();
    this.block = r.u8();
    this.keyed = r.bool();
    this.out = r.f64();
  }
}

class Vrc7Audio implements ExpansionAudio {
  private readonly regs = new Uint8Array(0x40);
  private readonly userPatch = new Uint8Array(8);
  private readonly ch = [new Channel(), new Channel(), new Channel(), new Channel(), new Channel(), new Channel()];
  private addr = 0;
  private prescaler = 0;
  private mix = 0;

  writeAddr(value: number): void {
    this.addr = value & 0x3f;
  }
  writeData(value: number): void {
    this.regs[this.addr] = value;
    if (this.addr < 0x08) {
      this.userPatch[this.addr] = value;
      for (let i = 0; i < 6; i++) if (this.regs[0x30 + i]! >> 4 === 0) this.loadPatch(i);
    } else if (this.addr >= 0x10 && this.addr <= 0x15) {
      this.ch[this.addr - 0x10]!.fnum = (this.ch[this.addr - 0x10]!.fnum & 0x100) | value;
    } else if (this.addr >= 0x20 && this.addr <= 0x25) {
      const c = this.ch[this.addr - 0x20]!;
      c.fnum = (c.fnum & 0xff) | ((value & 1) << 8);
      c.block = (value >> 1) & 7;
      const key = (value & 0x10) !== 0;
      if (key && !c.keyed) {
        c.mod.keyOn();
        c.car.keyOn();
      } else if (!key && c.keyed) {
        c.mod.keyOff();
        c.car.keyOff();
      }
      c.keyed = key;
      c.mod.egType = c.car.egType = (value & 0x20) !== 0;
    } else if (this.addr >= 0x30 && this.addr <= 0x35) {
      this.loadPatch(this.addr - 0x30);
    }
  }

  private loadPatch(i: number): void {
    const reg = this.regs[0x30 + i]!;
    const inst = reg >> 4;
    const vol = reg & 0x0f;
    const p = inst === 0 ? this.userPatch : PATCHES[inst - 1]!;
    const c = this.ch[i]!;
    this.applyOp(c.mod, p[0]!, p[2]!, p[4]!, p[6]!);
    this.applyOp(c.car, p[1]!, p[3]!, p[5]!, p[7]!);
    c.mod.feedback = p[3]! & 0x07;
    c.mod.totalLevel = (p[2]! & 0x3f) * 0.75;
    c.car.totalLevel = vol * 3; // 3 dB per volume step
  }

  private applyOp(op: Op, b0: number, b1: number, b2: number, b3: number): void {
    op.mult = MULT[b0 & 0x0f]! * 0.5;
    op.egType = (b0 & 0x20) !== 0;
    op.ksr = (b0 & 0x10) !== 0;
    op.ar = (b2 >> 4) & 0x0f;
    op.dr = b2 & 0x0f;
    op.sl = ((b3 >> 4) & 0x0f) * 3;
    op.rr = b3 & 0x0f;
    void b1;
  }

  clock(): void {
    if (++this.prescaler < 36) return;
    this.prescaler = 0;
    let mix = 0;
    for (let i = 0; i < 6; i++) {
      const c = this.ch[i]!;
      // Phase increment in 1024-step table units per 49716 Hz sample.
      const base = (c.fnum * (1 << c.block) * 1024) / (1 << 19);
      // Modulator with self-feedback.
      const fb = c.mod.feedback === 0 ? 0 : ((c.mod.prev + c.mod.out) / 2) * (1 << c.mod.feedback);
      c.mod.phase = (c.mod.phase + base * c.mod.mult) % 1024;
      const modEnv = c.mod.envelope();
      c.mod.prev = c.mod.out;
      c.mod.out = SINE[Math.floor(c.mod.phase + fb) & 1023]! * modEnv;
      // Carrier phase-modulated by the modulator output (±~256 steps full scale).
      c.car.phase = (c.car.phase + base * c.car.mult) % 1024;
      const carEnv = c.car.envelope();
      c.out = SINE[Math.floor(c.car.phase + c.mod.out * 256) & 1023]! * carEnv;
      mix += c.out;
    }
    this.mix = mix;
  }

  output(): number {
    return this.mix * 0.08;
  }

  serialize(w: NesStateWriter): void {
    w.bytes(this.regs);
    w.bytes(this.userPatch);
    for (const c of this.ch) c.serialize(w);
    w.u8(this.addr);
    w.u8(this.prescaler);
    w.f64(this.mix);
  }
  deserialize(r: NesStateReader): void {
    r.bytes(this.regs);
    r.bytes(this.userPatch);
    for (const c of this.ch) c.deserialize(r);
    this.addr = r.u8();
    this.prescaler = r.u8();
    this.mix = r.f64();
  }
}

export class Vrc7Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;
  private readonly sound = new Vrc7Audio();

  private readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqLatch = 0;
  private irqCounter = 0;
  private irqPrescaler = 0;
  private irqEnabled = false;
  private irqEnableAfterAck = false;
  private irqCycleMode = false;
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

  audio(): ExpansionAudio {
    return this.sound;
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region === 3 ? this.prgBankCount - 1 : this.prgBanks[region]!;
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const block = addr & 0xf000;
    const sub = addr & 0x10 ? 1 : 0;
    switch (block) {
      case 0x8000:
        this.prgBanks[sub] = value; // $8000 → bank0, $8010 → bank1
        break;
      case 0x9000:
        if ((addr & 0x30) === 0x10)
          this.sound.writeAddr(value); // $9010
        else if ((addr & 0x30) === 0x30)
          this.sound.writeData(value); // $9030
        else this.prgBanks[2] = value; // $9000
        break;
      case 0xa000:
        this.chrBanks[sub] = value; // $A000/$A010 → CHR 0/1
        break;
      case 0xb000:
        this.chrBanks[2 + sub] = value;
        break;
      case 0xc000:
        this.chrBanks[4 + sub] = value;
        break;
      case 0xd000:
        this.chrBanks[6 + sub] = value;
        break;
      case 0xe000:
        if (sub === 0) {
          this.mirror = (["vertical", "horizontal", "single-lower", "single-upper"] as const)[value & 3]!;
        } else {
          this.irqLatch = value;
        }
        break;
      case 0xf000:
        if (sub === 0) {
          this.irqEnableAfterAck = (value & 0x01) !== 0;
          this.irqEnabled = (value & 0x02) !== 0;
          this.irqCycleMode = (value & 0x04) !== 0;
          this.irqPending = false;
          if (this.irqEnabled) {
            this.irqCounter = this.irqLatch;
            this.irqPrescaler = 0;
          }
        } else {
          this.irqPending = false;
          this.irqEnabled = this.irqEnableAfterAck;
        }
        break;
    }
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

  mirroring(): Mirroring {
    return this.mirror;
  }

  private clockCounter(): void {
    if (this.irqCounter === 0xff) {
      this.irqCounter = this.irqLatch;
      this.irqPending = true;
    } else {
      this.irqCounter++;
    }
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCycleMode) {
        this.clockCounter();
      } else {
        this.irqPrescaler += 3;
        if (this.irqPrescaler >= 341) {
          this.irqPrescaler -= 341;
          this.clockCounter();
        }
      }
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  serialize(w: NesStateWriter): void {
    this.sound.serialize(w);
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chrBanks) w.u8(b);
    writeMirroring(w, this.mirror);
    w.u8(this.irqLatch);
    w.u8(this.irqCounter);
    w.u16(this.irqPrescaler);
    w.bool(this.irqEnabled);
    w.bool(this.irqEnableAfterAck);
    w.bool(this.irqCycleMode);
    w.bool(this.irqPending);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.sound.deserialize(r);
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = readMirroring(r);
    this.irqLatch = r.u8();
    this.irqCounter = r.u8();
    this.irqPrescaler = r.u16();
    this.irqEnabled = r.bool();
    this.irqEnableAfterAck = r.bool();
    this.irqCycleMode = r.bool();
    this.irqPending = r.bool();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
