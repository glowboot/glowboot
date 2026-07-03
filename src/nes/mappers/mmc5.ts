/**
 * MMC5 / ExROM (iNES mapper 5) — Castlevania III (US), Just Breed, Laser
 * Invasion, Metal Slader Glory, Uncharted Waters, Gemfire. Nintendo's most
 * complex mapper: flexible 8/16/32 KiB PRG and 1-8 KiB CHR banking, 1 KiB
 * ExRAM, an 8×8 multiplier, a scanline-compare IRQ, and a sound unit of two
 * 2A03-style pulse channels plus an 8-bit PCM DAC.
 *
 * Implemented: flexible PRG/CHR banking with the separate sprite ($5120-$5127)
 * and background ($5128-$512B) CHR sets in 8×16-sprite mode; per-nametable
 * mapping ($5105) to CIRAM, ExRAM, or fill mode; ExRAM as extended attributes
 * (per-tile CHR bank + palette) or a nametable; the multiplier; the scanline
 * IRQ; and the pulse + PCM sound unit. The vertical split ($5200-$5202) is
 * omitted (rare; used by a handful of status-bar effects).
 * Reference: https://www.nesdev.org/wiki/MMC5.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const LENGTH_TABLE = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28,
  32, 30
];
const DUTY = [0.125, 0.25, 0.5, 0.75];
const CPU_HZ = 1_789_773;

/** A 2A03-style pulse channel (no sweep), as used by the MMC5 sound unit. */
class Mmc5Pulse {
  private duty = 0;
  private halt = false;
  private volume = 0;
  private timerPeriod = 0;
  private timer = 0;
  private phase = 0;
  enabled = false;
  length = 0;

  write(reg: number, value: number): void {
    switch (reg & 3) {
      case 0:
        this.duty = (value >> 6) & 3;
        this.halt = (value & 0x20) !== 0;
        this.volume = value & 0x0f;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | value;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((value & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[(value >> 3) & 0x1f]!;
        this.phase = 0;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  clockTimer(): void {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      this.phase = (this.phase + 1) & 7;
    } else {
      this.timer--;
    }
  }

  clockLength(): void {
    if (!this.halt && this.length > 0) this.length--;
  }

  output(): number {
    if (this.length === 0 || this.timerPeriod < 8) return 0;
    // Envelope mode is approximated as constant volume.
    return this.phase / 8 < DUTY[this.duty]! ? this.volume : 0;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.duty);
    w.bool(this.halt);
    w.u8(this.volume);
    w.u16(this.timerPeriod);
    w.u16(this.timer);
    w.u8(this.phase);
    w.bool(this.enabled);
    w.u8(this.length);
  }
  deserialize(r: NesStateReader): void {
    this.duty = r.u8();
    this.halt = r.bool();
    this.volume = r.u8();
    this.timerPeriod = r.u16();
    this.timer = r.u16();
    this.phase = r.u8();
    this.enabled = r.bool();
    this.length = r.u8();
  }
}

class Mmc5Audio implements ExpansionAudio {
  readonly pulse1 = new Mmc5Pulse();
  readonly pulse2 = new Mmc5Pulse();
  pcm = 0;
  private frameCounter = 0;

  clock(): void {
    this.pulse1.clockTimer();
    this.pulse2.clockTimer();
    // Quarter-frame length clock at ~240 Hz.
    if (++this.frameCounter >= CPU_HZ / 240) {
      this.frameCounter = 0;
      this.pulse1.clockLength();
      this.pulse2.clockLength();
    }
  }

  output(): number {
    const pulses = (this.pulse1.output() + this.pulse2.output()) * 0.00845;
    return pulses + this.pcm * 0.00035;
  }

  serialize(w: NesStateWriter): void {
    this.pulse1.serialize(w);
    this.pulse2.serialize(w);
    w.u8(this.pcm);
    w.u16(this.frameCounter);
  }
  deserialize(r: NesStateReader): void {
    this.pulse1.deserialize(r);
    this.pulse2.deserialize(r);
    this.pcm = r.u8();
    this.frameCounter = r.u16();
  }
}

export class Mmc5Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prg8kCount: number;
  private readonly chr1kCount: number;
  private readonly exram = new Uint8Array(0x400);
  private readonly sound = new Mmc5Audio();

  private prgMode = 3;
  private chrMode = 0;
  private exramMode = 0; // $5104: 1 = extended-attribute mode
  private readonly prgBanks = [0, 0, 0, 0, 0]; // $5113-$5117
  private readonly chrBanks = new Int32Array(8); // $5120-$5127 (sprite set)
  private readonly chrBanksB = new Int32Array(4); // $5128-$512B (background set)
  private largeSprites = false; // PPUCTRL bit 5 — selects the background CHR set
  private chrUpper = 0; // $5130 bits 0-1
  private ntMapping = 0; // $5105
  private fillTile = 0;
  private fillColor = 0; // $5107 (2 bits)
  private mult1 = 0;
  private mult2 = 0;

  private irqScanline = 0;
  private irqEnabled = false;
  private irqPending = false;
  private inFrame = false;
  private scanlineCounter = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prg8kCount = Math.max(1, rom.prgRom.length / 0x2000);
    this.prgBanks[4] = this.prg8kCount - 1; // $5117 powers on at the last bank
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chr1kCount = Math.max(1, this.chr.length / 0x400);
  }

  audio(): ExpansionAudio {
    return this.sound;
  }

  // ── PRG ($8000-$FFFF; RAM/ROM select bit ignored — treated as ROM) ────────
  prgRead(addr: number): number {
    const region = (addr - 0x8000) >> 13; // 0:$8000 1:$A000 2:$C000 3:$E000 (8 KiB)
    let bank: number;
    switch (this.prgMode) {
      case 0: // 32 KiB
        bank = (this.prgBanks[4]! & 0x7c) | region;
        break;
      case 1: // 16 KiB
        bank = region < 2 ? (this.prgBanks[2]! & 0x7e) | region : (this.prgBanks[4]! & 0x7e) | (region & 1);
        break;
      case 2: // 16 KiB + 8 KiB
        if (region < 2) bank = (this.prgBanks[2]! & 0x7e) | region;
        else bank = region === 2 ? this.prgBanks[3]! & 0x7f : this.prgBanks[4]! & 0x7f;
        break;
      default: // 8 KiB
        bank = this.prgBanks[1 + region]! & 0x7f;
        break;
    }
    return this.prg[((bank % this.prg8kCount) * 0x2000 + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(): void {
    /* $8000-$FFFF is banked ROM; all MMC5 registers live below $6000. */
  }

  lowWrite(addr: number, value: number): void {
    if (addr >= 0x5c00 && addr <= 0x5fff) {
      this.exram[addr - 0x5c00] = value;
      return;
    }
    switch (addr) {
      case 0x5000:
      case 0x5001:
      case 0x5002:
      case 0x5003:
        this.sound.pulse1.write(addr, value);
        break;
      case 0x5004:
      case 0x5005:
      case 0x5006:
      case 0x5007:
        this.sound.pulse2.write(addr, value);
        break;
      case 0x5011:
        this.sound.pcm = value;
        break;
      case 0x5015:
        this.sound.pulse1.setEnabled((value & 1) !== 0);
        this.sound.pulse2.setEnabled((value & 2) !== 0);
        break;
      case 0x5100:
        this.prgMode = value & 3;
        break;
      case 0x5101:
        this.chrMode = value & 3;
        break;
      case 0x5104:
        this.exramMode = value & 3;
        break;
      case 0x5105:
        this.ntMapping = value;
        break;
      case 0x5106:
        this.fillTile = value;
        break;
      case 0x5107:
        this.fillColor = value & 3;
        break;
      case 0x5113:
      case 0x5114:
      case 0x5115:
      case 0x5116:
      case 0x5117:
        this.prgBanks[addr - 0x5113] = value;
        break;
      case 0x5120:
      case 0x5121:
      case 0x5122:
      case 0x5123:
      case 0x5124:
      case 0x5125:
      case 0x5126:
      case 0x5127:
        this.chrBanks[addr - 0x5120] = value | (this.chrUpper << 8);
        break;
      case 0x5128:
      case 0x5129:
      case 0x512a:
      case 0x512b:
        this.chrBanksB[addr - 0x5128] = value | (this.chrUpper << 8);
        break;
      case 0x5130:
        this.chrUpper = value & 3;
        break;
      case 0x5203:
        this.irqScanline = value;
        break;
      case 0x5204:
        this.irqEnabled = (value & 0x80) !== 0;
        break;
      case 0x5205:
        this.mult1 = value;
        break;
      case 0x5206:
        this.mult2 = value;
        break;
    }
  }

  lowRead(addr: number): number | null {
    if (addr >= 0x5c00 && addr <= 0x5fff) return this.exram[addr - 0x5c00]!;
    if (addr === 0x5204) {
      const v = (this.irqPending ? 0x80 : 0) | (this.inFrame ? 0x40 : 0);
      this.irqPending = false;
      return v;
    }
    if (addr === 0x5205) return (this.mult1 * this.mult2) & 0xff;
    if (addr === 0x5206) return ((this.mult1 * this.mult2) >> 8) & 0xff;
    return null;
  }

  // ── ExRAM extended-attribute mode ($5104 == 1) ────────────────────────────
  // Each background tile takes its 4 KiB CHR bank and 2-bit palette from the
  // ExRAM byte at the tile's nametable position; sprites keep normal banking.
  extAttrTile(ntPos: number): { bank: number; palette: number } | null {
    if (this.exramMode !== 1) return null;
    const ex = this.exram[ntPos & 0x3ff]!;
    return { bank: (ex & 0x3f) | (this.chrUpper << 6), palette: ex >> 6 };
  }
  extAttrPattern(bank: number, offset: number): number {
    return this.chr[(bank * 0x1000 + (offset & 0xfff)) % this.chr.length]!;
  }

  // ── CHR (single bank set) ─────────────────────────────────────────────────
  chrRead(addr: number): number {
    // In 8×16-sprite mode the background is fetched from the separate $5128-$512B
    // bank set; sprites (chrReadSprite) always use the $5120-$5127 set.
    const off = this.largeSprites ? this.chrOffsetB(addr) : this.chrOffset(addr);
    return this.chr[off % this.chr.length]!;
  }
  chrReadSprite(addr: number): number {
    return this.chr[this.chrOffset(addr) % this.chr.length]!;
  }
  setLargeSprites(large: boolean): void {
    this.largeSprites = large;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr) % this.chr.length] = value;
  }

  private chrOffset(addr: number): number {
    const a = addr & 0x1fff;
    switch (this.chrMode) {
      case 0: // 8 KiB
        return (this.chrBanks[7]! % this.chr1kCount) * 0x2000 + a;
      case 1: // 4 KiB
        return ((this.chrBanks[a < 0x1000 ? 3 : 7]! * 0x1000) % this.chr.length) + (a & 0xfff);
      case 2: // 2 KiB
        return ((this.chrBanks[((a >> 11) & 3) * 2 + 1]! * 0x800) % this.chr.length) + (a & 0x7ff);
      default: // 1 KiB
        return ((this.chrBanks[(a >> 10) & 7]! * 0x400) % this.chr.length) + (a & 0x3ff);
    }
  }

  /** Background bank set ($5128-$512B). The 4 KiB pattern table mirrors across
   *  both halves, so bit 12 is ignored except in the 8 KiB single-bank mode. */
  private chrOffsetB(addr: number): number {
    switch (this.chrMode) {
      case 0: // 8 KiB
        return (this.chrBanksB[3]! % this.chr1kCount) * 0x2000 + (addr & 0x1fff);
      case 1: // 4 KiB
        return ((this.chrBanksB[3]! * 0x1000) % this.chr.length) + (addr & 0xfff);
      case 2: {
        // 2 KiB
        const a = addr & 0xfff;
        return ((this.chrBanksB[a < 0x800 ? 1 : 3]! * 0x800) % this.chr.length) + (a & 0x7ff);
      }
      default: {
        // 1 KiB
        const a = addr & 0xfff;
        return ((this.chrBanksB[(a >> 10) & 3]! * 0x400) % this.chr.length) + (a & 0x3ff);
      }
    }
  }

  // ── nametable mapping ($5105) ─────────────────────────────────────────────
  // Each of the four nametables independently selects CIRAM page 0/1, the
  // mapper's own ExRAM, or fill mode. This is richer than the standard mirroring
  // modes, so the cartridge routes nametable access through the two hooks below
  // instead of mirroring(); mirroring() is only a coarse fallback.
  mirroring(): Mirroring {
    const nt = (i: number) => (this.ntMapping >> (i * 2)) & 3;
    if (nt(0) === nt(2) && nt(1) === nt(3) && nt(0) !== nt(1)) return "vertical";
    return "horizontal";
  }

  /** $5105 nametable read: `ciram` is the console's 2 KiB nametable RAM (page 0
   *  at offset 0, page 1 at offset $400). */
  ppuNametableByte(addr: number, ciram: Uint8Array): number {
    const off = addr & 0x3ff;
    switch ((this.ntMapping >> (((addr >> 10) & 3) * 2)) & 3) {
      case 0:
        return ciram[off]!;
      case 1:
        return ciram[0x400 + off]!;
      case 2:
        return this.exramMode < 2 ? this.exram[off]! : 0; // ExRAM as a nametable
      default:
        // Fill mode: a solid tile ($5106) with a single attribute colour ($5107).
        return off < 0x3c0 ? this.fillTile : this.fillColor * 0x55;
    }
  }
  ppuNametableWrite(addr: number, value: number, ciram: Uint8Array): void {
    const off = addr & 0x3ff;
    switch ((this.ntMapping >> (((addr >> 10) & 3) * 2)) & 3) {
      case 0:
        ciram[off] = value;
        break;
      case 1:
        ciram[0x400 + off] = value;
        break;
      case 2:
        if (this.exramMode < 2) this.exram[off] = value;
        break;
      // Fill mode has no backing store — writes are dropped.
    }
  }

  // ── scanline-compare IRQ (driven by the PPU's per-scanline clock) ─────────
  clockIrq(): void {
    this.inFrame = true;
    this.scanlineCounter++;
    if (this.scanlineCounter > 240) {
      this.scanlineCounter = 0;
      this.inFrame = false;
    }
    if (this.scanlineCounter === this.irqScanline && this.irqEnabled) this.irqPending = true;
  }
  irqState(): boolean {
    return this.irqPending && this.irqEnabled;
  }

  serialize(w: NesStateWriter): void {
    this.sound.serialize(w);
    w.bytes(this.exram);
    w.u8(this.prgMode);
    w.u8(this.chrMode);
    w.u8(this.exramMode);
    for (const b of this.prgBanks) w.u8(b);
    for (let i = 0; i < 8; i++) w.u16(this.chrBanks[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.chrBanksB[i]!);
    w.bool(this.largeSprites);
    w.u8(this.chrUpper);
    w.u8(this.ntMapping);
    w.u8(this.fillTile);
    w.u8(this.fillColor);
    w.u8(this.mult1);
    w.u8(this.mult2);
    w.u8(this.irqScanline);
    w.bool(this.irqEnabled);
    w.bool(this.irqPending);
    w.bool(this.inFrame);
    w.u16(this.scanlineCounter);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.sound.deserialize(r);
    r.bytes(this.exram);
    this.prgMode = r.u8();
    this.chrMode = r.u8();
    this.exramMode = r.u8();
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < 8; i++) this.chrBanks[i] = r.u16();
    for (let i = 0; i < 4; i++) this.chrBanksB[i] = r.u16();
    this.largeSprites = r.bool();
    this.chrUpper = r.u8();
    this.ntMapping = r.u8();
    this.fillTile = r.u8();
    this.fillColor = r.u8();
    this.mult1 = r.u8();
    this.mult2 = r.u8();
    this.irqScanline = r.u8();
    this.irqEnabled = r.bool();
    this.irqPending = r.bool();
    this.inFrame = r.bool();
    this.scanlineCounter = r.u16();
    if (this.chrWritable) r.bytes(this.chr);
  }
}
