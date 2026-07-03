/**
 * Mapper 4 (MMC3 / TxROM) — the most common mapper: Super Mario Bros. 3, Mega
 * Man 3-6, Kirby's Adventure, Super Contra, and ~a quarter of the library.
 *
 * Banks PRG in 8 KiB and CHR in 1/2 KiB windows, and provides a scanline IRQ
 * counter clocked by PPU A12 rising edges (used for mid-screen status-bar
 * splits). Registers (https://www.nesdev.org/wiki/MMC3):
 *   $8000/$8001  bank select / bank data
 *   $A000/$A001  mirroring / PRG-RAM protect
 *   $C000/$C001  IRQ latch / IRQ reload
 *   $E000/$E001  IRQ disable+ack / IRQ enable
 *
 * The IRQ counter is clocked from filtered PPU A12 rising edges — the per-dot
 * background/sprite fetch stream plus $2006/$2007 bus activity — so it lands
 * on the hardware dot (~261 with the standard BG $0000 / sprite $1000 split),
 * including the pre-render line's clock.
 *
 * This class is also the base for the many MMC3 clones (mappers 119/189/245/…),
 * which override a small protected hook — PRG bank resolution, the CHR fetch, or
 * an extra register — while reusing the bank registers and the A12 IRQ.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const PRG_BANK = 0x2000; // 8 KiB
const CHR_BANK = 0x400; // 1 KiB

export class Mmc3Mapper implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly chrWritable: boolean;
  protected readonly prgBankCount: number;

  protected bankSelect = 0; // $8000: low 3 bits target, bit 6 PRG mode, bit 7 CHR mode
  protected readonly regs = new Uint8Array(8); // R0-R7
  protected mirror: Mirroring;

  protected irqLatch = 0;
  protected irqCounter = 0;
  protected irqReload = false;
  protected irqEnabled = false;
  protected irqPending = false;

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

  /** The 8 KiB PRG bank for region 0-3 ($8000/$A000/$C000/$E000). Overridden by
   *  clones whose PRG banking differs (e.g. a single 32 KiB outer bank). */
  protected prgBank8k(region: number): number {
    const last = this.prgBankCount - 1;
    const penult = this.prgBankCount - 2;
    const swap = (this.bankSelect & 0x40) !== 0;
    switch (region) {
      case 0:
        return swap ? penult : this.regs[6]!;
      case 1:
        return this.regs[7]!;
      case 2:
        return swap ? this.regs[6]! : penult;
      default:
        return last;
    }
  }

  prgRead(addr: number): number {
    const bank = this.prgBank8k((addr >> 13) & 3);
    return this.prg[((bank % this.prgBankCount) * PRG_BANK + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    this.writeRegister(addr, value);
  }

  /** The standard MMC3 $8000-$FFFF register decode. Clones override to add their
   *  own registers (calling super for the inherited ones). */
  protected writeRegister(addr: number, value: number): void {
    const even = (addr & 1) === 0;
    if (addr < 0xa000) {
      if (even) this.bankSelect = value;
      else this.regs[this.bankSelect & 7] = value;
    } else if (addr < 0xc000) {
      if (even) this.mirror = value & 1 ? "horizontal" : "vertical";
      // odd: PRG-RAM protect — not modelled
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
    return this.fetchChr(this.chrBankFor(addr), addr & 0x3ff);
  }
  chrWrite(addr: number, value: number): void {
    this.storeChr(this.chrBankFor(addr), addr & 0x3ff, value);
  }

  /** The raw 1 KiB CHR bank register selected for `addr` (with the mode-1 half
   *  swap applied). Clones read its high bits (e.g. a CHR-RAM select). */
  protected chrBankFor(addr: number): number {
    const a = addr & 0x1fff;
    let region = a >> 10; // 0-7 (1 KiB)
    if (this.bankSelect & 0x80) region ^= 4; // CHR mode 1 swaps the halves
    switch (region) {
      case 0:
        return this.regs[0]! & 0xfe;
      case 1:
        return this.regs[0]! | 1;
      case 2:
        return this.regs[1]! & 0xfe;
      case 3:
        return this.regs[1]! | 1;
      case 4:
        return this.regs[2]!;
      case 5:
        return this.regs[3]!;
      case 6:
        return this.regs[4]!;
      default:
        return this.regs[5]!;
    }
  }

  protected fetchChr(bank: number, offset: number): number {
    return this.chr[(bank * CHR_BANK + offset) % this.chr.length]!;
  }
  protected storeChr(bank: number, offset: number, value: number): void {
    if (this.chrWritable) this.chr[(bank * CHR_BANK + offset) % this.chr.length] = value;
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
    w.u8(this.bankSelect);
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
    this.bankSelect = r.u8();
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
