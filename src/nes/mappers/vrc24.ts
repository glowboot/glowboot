/**
 * Konami VRC2 / VRC4 (iNES mappers 21, 22, 23, 25) — Gradius II, Crisis Force,
 * Wai Wai World, TMNT, Ganbare Goemon, Bio Miracle, …
 *
 * One chip family wired to different board layouts. The register *function* is
 * fixed by the high address nibble ($8/$9/$A/$B-$E/$F); which two CPU address
 * bits feed the chip's A0/A1 register-select pins varies per board, so the same
 * logical register sits at a different low address on each variant. NES 2.0
 * submappers name the exact wiring; bare iNES is disambiguated by OR-ing the
 * candidate pin masks (a cart only drives its own board's addresses).
 *
 * VRC2 has no IRQ and no PRG swap mode; VRC2a (mapper 22) additionally
 * right-shifts every CHR bank by one. VRC4 adds the latch/prescaler IRQ.
 * Reference: https://www.nesdev.org/wiki/VRC2_and_VRC4.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB

/** CPU address-bit masks feeding the chip's [A0, A1] register-select pins. */
function pinMasks(mapper: number, submapper: number): [number, number] {
  switch (mapper) {
    case 22: // VRC2a only
      return [0x02, 0x01];
    case 21:
      if (submapper === 1) return [0x02, 0x04]; // VRC4a
      if (submapper === 2) return [0x40, 0x80]; // VRC4c
      return [0x42, 0x84]; // iNES: VRC4a | VRC4c
    case 25:
      if (submapper === 1) return [0x02, 0x01]; // VRC4b
      if (submapper === 2) return [0x08, 0x04]; // VRC4d
      if (submapper === 3) return [0x02, 0x01]; // VRC2c
      return [0x0a, 0x05]; // iNES: VRC4b | VRC4d
    case 23:
    default:
      if (submapper === 1 || submapper === 3) return [0x01, 0x02]; // VRC4f / VRC2b
      if (submapper === 2) return [0x04, 0x08]; // VRC4e
      return [0x05, 0x0a]; // iNES: VRC4f | VRC4e
  }
}

export class Vrc24Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number;
  private readonly chrBankCount: number;

  private readonly a0Mask: number;
  private readonly a1Mask: number;
  private readonly isVrc2: boolean;
  private readonly chrShift: boolean; // VRC2a: every CHR bank >>1

  private prg0 = 0;
  private prg1 = 0;
  private swapMode = false; // VRC4: $8000 bank moves to $C000
  private readonly chrLow = new Uint8Array(8);
  private readonly chrHigh = new Uint8Array(8);
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
    [this.a0Mask, this.a1Mask] = pinMasks(rom.mapper, rom.submapper);
    this.isVrc2 = rom.mapper === 22;
    this.chrShift = rom.mapper === 22 && rom.submapper === 0;
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

  /** De-multiplex the two board-specific pins into register-select 0-3. */
  private regSel(addr: number): number {
    return ((addr & this.a0Mask ? 1 : 0) | (addr & this.a1Mask ? 2 : 0)) & 3;
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const last = this.prgBankCount - 1;
    const penult = this.prgBankCount - 2;
    let bank: number;
    switch (region) {
      case 0:
        bank = this.swapMode ? penult : this.prg0;
        break;
      case 1:
        bank = this.prg1;
        break;
      case 2:
        bank = this.swapMode ? this.prg0 : penult;
        break;
      default:
        bank = last;
        break;
    }
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    const block = addr & 0xf000;
    const sel = this.regSel(addr);
    switch (block) {
      case 0x8000:
        this.prg0 = value & 0x1f;
        break;
      case 0xa000:
        this.prg1 = value & 0x1f;
        break;
      case 0x9000:
        if (sel < 2) {
          const m = this.isVrc2 ? value & 1 : value & 3;
          this.mirror = (["vertical", "horizontal", "single-lower", "single-upper"] as const)[m]!;
        } else if (!this.isVrc2) {
          this.swapMode = (value & 0x02) !== 0;
        }
        break;
      case 0xb000:
      case 0xc000:
      case 0xd000:
      case 0xe000: {
        const bankIndex = ((block - 0xb000) >> 11) | (sel >> 1); // pair base + which of the pair
        if ((sel & 1) === 0) this.chrLow[bankIndex] = value & 0x0f;
        else this.chrHigh[bankIndex] = value & 0x1f;
        break;
      }
      case 0xf000:
        if (this.isVrc2) break;
        if (sel === 0) this.irqLatch = (this.irqLatch & 0xf0) | (value & 0x0f);
        else if (sel === 1) this.irqLatch = (this.irqLatch & 0x0f) | ((value & 0x0f) << 4);
        else if (sel === 2) {
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
    let bank = (this.chrHigh[(addr >> 10) & 7]! << 4) | this.chrLow[(addr >> 10) & 7]!;
    if (this.chrShift) bank >>= 1;
    return this.chr[((bank % this.chrBankCount) * CHR_BANK + (addr & 0x3ff)) % this.chr.length]!;
  }
  chrWrite(addr: number, value: number): void {
    if (!this.chrWritable) return;
    let bank = (this.chrHigh[(addr >> 10) & 7]! << 4) | this.chrLow[(addr >> 10) & 7]!;
    if (this.chrShift) bank >>= 1;
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
    if (this.isVrc2 || !this.irqEnabled) return;
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
    w.u8(this.prg0);
    w.u8(this.prg1);
    w.bool(this.swapMode);
    w.bytes(this.chrLow);
    w.bytes(this.chrHigh);
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
    this.prg0 = r.u8();
    this.prg1 = r.u8();
    this.swapMode = r.bool();
    r.bytes(this.chrLow);
    r.bytes(this.chrHigh);
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
