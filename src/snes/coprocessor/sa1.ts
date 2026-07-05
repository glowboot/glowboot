/**
 * SA-1 (Super Accelerator 1) — the in-cart second 65C816 running at
 * 10.74 MHz used by Super Mario RPG, Kirby Super Star, Kirby's Dream
 * Land 3 and ~30 other carts. This unit owns:
 *
 *  - a second `Cpu65816` core on its own bus view (game-pak ROM through
 *    the Super MMC, 2 KiB I-RAM, battery BW-RAM, its own MMIO at
 *    $2200-$23FF; no access to the console's PPU/APU),
 *  - the Super MMC bank registers (CXB/DXB/EXB/FXB) that remap the four
 *    1 MiB ROM views both CPUs share,
 *  - the mailbox interrupt fabric (S-CPU→SA-1 IRQ/NMI via $2200, SA-1→
 *    S-CPU IRQ via $2209, with SNV/SIV able to hijack the console's
 *    NMI/IRQ vectors),
 *  - the arithmetic unit (signed 16×16 multiply, 16÷16 divide with
 *    floor rounding, 40-bit cumulative sum),
 *  - DMA: normal (ROM/BW-RAM/I-RAM → I-RAM/BW-RAM), type-1 character
 *    conversion (BW-RAM bitmap → planar tiles served on-the-fly through
 *    the S-CPU's $6000 window), type-2 (BRF register file → I-RAM),
 *  - the H/V + linear timer, and the variable-length bit reader.
 *
 * Ported from the established open-source reference implementation of
 * the chip; interface documented in fullsnes "SNES Cart SA-1". Bus
 * conflict stalls between the two CPUs are not modelled (the reference
 * offers the same simplification as an option); each SA-1 access costs
 * 2 master cycles (4 for BW-RAM).
 */

import { Cpu65816, type SnesCpuBus } from "../cpu/cpu.js";
import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

const VEC_NATIVE_NMI = 0xffea;
const VEC_NATIVE_IRQ = 0xffee;
const VEC_EMU_NMI = 0xfffa;
const VEC_EMU_IRQ = 0xfffe;

class Sa1SideBus implements SnesCpuBus {
  constructor(private readonly sa1: Sa1) {}

  cost(addr: number): number {
    // SA-1 runs at half the master clock; BW-RAM takes two chip cycles.
    if ((addr & 0x40e000) === 0x006000 || (addr & 0xe00000) === 0x400000 || (addr & 0xf00000) === 0x600000) {
      return 4;
    }
    return 2;
  }

  read(addr: number): number {
    return this.sa1.readSa1Bus(addr);
  }

  write(addr: number, value: number): void {
    this.sa1.writeSa1Bus(addr, value);
  }
}

export class Sa1 {
  readonly cpu: Cpu65816;
  readonly iram = new Uint8Array(0x800);
  private readonly bwram: Uint8Array;
  private readonly bwramMask: number;
  private readonly rom: Uint8Array;

  /** Master-cycle budget the SA-1 still has to run (carries residue). */
  private budget = 0;
  private openBus = 0;

  // ── timer ($2210-$2215) ─────────────────────────────────────────────
  private readonly scanlines: number;
  private hcounter = 0;
  private vcounter = 0;
  private hvselb = false;
  private ven = false;
  private hen = false;
  private hcnt = 0;
  private vcnt = 0;
  private hcrLatch = 0;
  private vcrLatch = 0;

  // ── $2200 CCNT / $2209 SCNT message + control ───────────────────────
  private sa1Irq = false;
  private sa1Rdyb = false;
  private sa1Resb = true;
  private sa1Nmi = false;
  private smeg = 0;
  private cpuIrq = false;
  private cpuIvsw = false;
  private cpuNvsw = false;
  private cmeg = 0;

  // ── interrupt enables/acks/flags ────────────────────────────────────
  private cpuIrqEn = false;
  private chdmaIrqEn = false;
  private cpuIrqCl = false;
  private chdmaIrqCl = false;
  private cpuIrqFl = false;
  private chdmaIrqFl = false;
  private sa1IrqEn = false;
  private timerIrqEn = false;
  private dmaIrqEn = false;
  private sa1NmiEn = false;
  private sa1IrqCl = false;
  private timerIrqCl = false;
  private dmaIrqCl = false;
  private sa1NmiCl = false;
  private sa1IrqFl = false;
  private timerIrqFl = false;
  private dmaIrqFl = false;
  private sa1NmiFl = false;

  // ── vectors ─────────────────────────────────────────────────────────
  private crv = 0;
  private cnv = 0;
  private civ = 0;
  private snv = 0;
  private siv = 0;

  // ── Super MMC ($2220-$2223) ─────────────────────────────────────────
  private cbMode = false;
  private cb = 0;
  private dbMode = false;
  private db = 1;
  private ebMode = false;
  private eb = 2;
  private fbMode = false;
  private fb = 3;

  // ── BW-RAM / I-RAM mapping + protection ($2224-$222A) ───────────────
  private sbm = 0;
  private sw46 = false;
  private cbm = 0;
  private swen = false;
  private cwen = false;
  private bwp = 0;
  private siwp = 0;
  private ciwp = 0;

  // ── DMA ($2230-$223F) ───────────────────────────────────────────────
  private dmaEn = false;
  private dprio = false;
  private cden = false;
  private cdsel = false;
  private dd = 0;
  private sd = 0;
  private chdend = false;
  private dmaSize = 0;
  private dmaCb = 0;
  private dsa = 0;
  private dda = 0;
  private dtc = 0;
  private bbf = false;
  private readonly brf = new Uint8Array(16);
  private dmaLine = 0;
  private bwramCc1 = false;

  // ── arithmetic ($2250-$2254, $2306-$230B) ───────────────────────────
  private acm = false;
  private md = false;
  private ma = 0;
  private mb = 0;
  private mr = 0; // 40-bit result as a plain number
  private overflow = false;

  // ── variable-length bit reader ($2258-$225B, $230C-$230D) ───────────
  private vbHl = false;
  private vb = 16;
  private va = 0;
  private vbit = 0;

  /** Serving a vector fetch: reads of the CPU vector addresses return
   *  this value instead of ROM (CRV/CNV/CIV live in registers). */
  private vectorValue = -1;

  /** Notifies the console that the SA-1→S-CPU IRQ line may have risen. */
  onSnesIrq: (() => void) | null = null;

  constructor(rom: Uint8Array, bwram: Uint8Array, pal: boolean) {
    this.rom = rom;
    this.bwram = bwram;
    // BW-RAM sizes are powers of two (2-32 KiB per the header).
    this.bwramMask = bwram.length > 0 ? bwram.length - 1 : 0;
    this.scanlines = pal ? 312 : 262;
    this.cpu = new Cpu65816(new Sa1SideBus(this));
    this.cpu.debugHooks = false;
    this.cpu.idleCost = 2;
    this.reset();
  }

  reset(): void {
    this.cpu.a = this.cpu.x = this.cpu.y = 0;
    this.cpu.s = 0x01ff;
    this.cpu.d = 0;
    this.cpu.dbr = 0;
    this.cpu.pbr = 0;
    this.cpu.pc = 0;
    this.cpu.p = 0x34;
    this.cpu.e = 1;
    this.cpu.cycles = 0;
    this.cpu.stopped = false;
    this.cpu.waiting = false;
    this.budget = 0;
    this.openBus = 0;
    this.iram.fill(0);
    this.hcounter = this.vcounter = 0;
    this.hvselb = this.ven = this.hen = false;
    this.hcnt = this.vcnt = 0;
    this.hcrLatch = this.vcrLatch = 0;
    this.sa1Irq = this.sa1Rdyb = this.sa1Nmi = false;
    this.sa1Resb = true;
    this.smeg = this.cmeg = 0;
    this.cpuIrq = this.cpuIvsw = this.cpuNvsw = false;
    this.cpuIrqEn = this.chdmaIrqEn = this.cpuIrqCl = this.chdmaIrqCl = false;
    this.cpuIrqFl = this.chdmaIrqFl = false;
    this.sa1IrqEn = this.timerIrqEn = this.dmaIrqEn = this.sa1NmiEn = false;
    this.sa1IrqCl = this.timerIrqCl = this.dmaIrqCl = this.sa1NmiCl = false;
    this.sa1IrqFl = this.timerIrqFl = this.dmaIrqFl = this.sa1NmiFl = false;
    this.crv = this.cnv = this.civ = this.snv = this.siv = 0;
    this.cbMode = this.dbMode = this.ebMode = this.fbMode = false;
    this.cb = 0;
    this.db = 1;
    this.eb = 2;
    this.fb = 3;
    this.sbm = 0;
    this.sw46 = false;
    this.cbm = 0;
    this.swen = this.cwen = false;
    this.bwp = 0;
    this.siwp = this.ciwp = 0;
    this.dmaEn = this.dprio = this.cden = this.cdsel = false;
    this.dd = this.sd = 0;
    this.chdend = false;
    this.dmaSize = this.dmaCb = 0;
    this.dsa = this.dda = this.dtc = 0;
    this.bbf = false;
    this.brf.fill(0);
    this.dmaLine = 0;
    this.bwramCc1 = false;
    this.acm = this.md = false;
    this.ma = this.mb = this.mr = 0;
    this.overflow = false;
    this.vbHl = false;
    this.vb = 16;
    this.va = this.vbit = 0;
    this.vectorValue = -1;
  }

  /** S-CPU→SNES IRQ line state (ORed into the console's IRQ dispatch). */
  snesIrqAsserted(): boolean {
    return (this.cpuIrqFl && this.cpuIrqEn) || (this.chdmaIrqFl && this.chdmaIrqEn);
  }

  /** Run the SA-1 for `masterDelta` master cycles' worth of work. */
  tick(masterDelta: number): void {
    this.budget += masterDelta;
    if (this.sa1Resb || this.sa1Rdyb) {
      // Held in reset / not ready: the chip idles but its timer runs.
      this.advanceTimer(this.budget);
      this.budget = 0;
      return;
    }
    while (this.budget > 0) {
      const before = this.cpu.cycles;
      this.dispatchInterrupts();
      this.cpu.step();
      const delta = this.cpu.cycles - before;
      if (delta === 0) {
        // Defensive: nothing consumed (cannot normally happen with
        // debugHooks off) — drop the slice rather than spin.
        this.budget = 0;
        break;
      }
      this.budget -= delta;
      this.advanceTimer(delta);
      if (this.sa1Resb || this.sa1Rdyb) {
        this.advanceTimer(Math.max(0, this.budget));
        this.budget = 0;
        break;
      }
    }
  }

  private dispatchInterrupts(): void {
    if (this.sa1Nmi && !this.sa1NmiCl) {
      this.sa1NmiFl = true;
      this.sa1NmiCl = true;
      this.hwInterrupt(this.cnv, this.cpu.e ? VEC_EMU_NMI : VEC_NATIVE_NMI);
      return;
    }
    if (this.cpu.irqDisabled) return;
    if ((this.timerIrqEn && !this.timerIrqCl) || (this.dmaIrqEn && !this.dmaIrqCl) || (this.sa1Irq && !this.sa1IrqCl)) {
      if (this.timerIrqEn && !this.timerIrqCl) this.timerIrqFl = true;
      if (this.dmaIrqEn && !this.dmaIrqCl) this.dmaIrqFl = true;
      if (this.sa1Irq && !this.sa1IrqCl) this.sa1IrqFl = true;
      this.hwInterrupt(this.civ, this.cpu.e ? VEC_EMU_IRQ : VEC_NATIVE_IRQ);
    }
  }

  /** The core reads the vector through the bus; serve it from the SA-1's
   *  vector registers by intercepting the fetch addresses. */
  private hwInterrupt(vector: number, vectorAddr: number): void {
    this.vectorValue = vector;
    this.cpu.hwInterrupt(vectorAddr);
    this.vectorValue = -1;
  }

  private advanceTimer(masterDelta: number): void {
    if (!this.hen && !this.ven) {
      // Counters still advance (they're readable via HCR/VCR).
      if (!this.hvselb) {
        this.hcounter += masterDelta;
        while (this.hcounter >= 1364) {
          this.hcounter -= 1364;
          if (++this.vcounter >= this.scanlines) this.vcounter = 0;
        }
      } else {
        this.hcounter += masterDelta;
        this.vcounter = (this.vcounter + (this.hcounter >> 11)) & 0x1ff;
        this.hcounter &= 0x7ff;
      }
      return;
    }
    // Fire-on-crossing (the reference checks equality every 2 cycles;
    // batching per instruction requires window checks instead).
    let remaining = masterDelta;
    while (remaining > 0) {
      const step = Math.min(remaining, this.hvselb ? 0x800 - this.hcounter : 1364 - this.hcounter);
      const oldH = this.hcounter;
      const newH = oldH + step;
      const hTarget = this.hcnt << 2;
      const mode = (this.hen ? 1 : 0) | (this.ven ? 2 : 0);
      if (mode === 1) {
        if (oldH <= hTarget && hTarget < newH) this.triggerTimerIrq();
      } else if (mode === 2) {
        if (this.vcounter === this.vcnt && oldH === 0) this.triggerTimerIrq();
      } else if (mode === 3) {
        if (this.vcounter === this.vcnt && oldH <= hTarget && hTarget < newH) this.triggerTimerIrq();
      }
      this.hcounter = newH;
      if (!this.hvselb) {
        if (this.hcounter >= 1364) {
          this.hcounter = 0;
          if (++this.vcounter >= this.scanlines) this.vcounter = 0;
        }
      } else {
        this.vcounter = (this.vcounter + (this.hcounter >> 11)) & 0x1ff;
        this.hcounter &= 0x7ff;
      }
      remaining -= step;
    }
  }

  private triggerTimerIrq(): void {
    this.timerIrqFl = true;
    if (this.timerIrqEn) this.timerIrqCl = false;
  }

  // ── ROM through the Super MMC ───────────────────────────────────────

  private romByte(index: number): number {
    return this.rom[index % this.rom.length]!;
  }

  /** Translated-space ROM read (see the reference's address notes):
   *  $00-$3F,$80-$BF:8000-FFFF fold to a 4 MiB "lo" space; $C0-$FF pass
   *  through as the linear "hi" space. Each 1 MiB chunk either mirrors
   *  the image linearly or follows its MMC bank register. */
  private romReadTranslated(address: number, lo: boolean): number {
    address &= 0x3fffff;
    if (address < 0x100000) {
      if (lo && !this.cbMode) return this.romByte(address);
      return this.romByte((this.cb << 20) | (address & 0x0fffff));
    }
    if (address < 0x200000) {
      if (lo && !this.dbMode) return this.romByte(address);
      return this.romByte((this.db << 20) | (address & 0x0fffff));
    }
    if (address < 0x300000) {
      if (lo && !this.ebMode) return this.romByte(address);
      return this.romByte((this.eb << 20) | (address & 0x0fffff));
    }
    if (lo && !this.fbMode) return this.romByte(address);
    return this.romByte((this.fb << 20) | (address & 0x0fffff));
  }

  private romReadLoHalf(bank: number, off: number): number {
    // 00-3f,80-bf:8000-ffff → ((bank7)<<21) | (bank&3f)<<15 | off&7fff
    const translated = ((bank & 0x80) << 14) | ((bank & 0x3f) << 15) | (off & 0x7fff);
    return this.romReadTranslated(translated, true);
  }

  /** S-CPU ROM read, including the SNV/SIV vector hijack. */
  romReadCpu(bank: number, off: number): number {
    if (bank === 0x00 && off >= 0xffe0 && off <= 0xffef) {
      if (off === 0xffea && this.cpuNvsw) return this.snv & 0xff;
      if (off === 0xffeb && this.cpuNvsw) return this.snv >> 8;
      if (off === 0xffee && this.cpuIvsw) return this.siv & 0xff;
      if (off === 0xffef && this.cpuIvsw) return this.siv >> 8;
    }
    if (bank >= 0xc0) return this.romReadTranslated(((bank - 0xc0) << 16) | off, false);
    return this.romReadLoHalf(bank, off);
  }

  // ── BW-RAM views ────────────────────────────────────────────────────

  private bwRead(index: number): number {
    if (this.bwramMask === 0) return this.openBus;
    return this.bwram[index & this.bwramMask]!;
  }

  private bwWrite(index: number, value: number): void {
    if (this.bwramMask === 0) return;
    this.bwram[index & this.bwramMask] = value;
  }

  /** Write-protection: active only while BOTH write-enables are off
   *  (hardware quirk the reference documents — carts rely on it). */
  private bwProtected(index: number): boolean {
    return !this.swen && !this.cwen && (index & 0x3ffff) < 0x100 << this.bwp;
  }

  private bwWriteLinear(index: number, value: number): void {
    if (this.bwProtected(index)) return;
    this.bwWrite(index, value);
  }

  private bwReadBitmap(address: number): number {
    if (!this.bbf) {
      const shift = (address & 1) << 2;
      return (this.bwRead(address >> 1) >> shift) & 15;
    }
    const shift = (address & 3) << 1;
    return (this.bwRead(address >> 2) >> shift) & 3;
  }

  private bwWriteBitmap(address: number, data: number): void {
    if (!this.bbf) {
      const shift = (address & 1) << 2;
      const index = address >> 1;
      this.bwWrite(index, (this.bwRead(index) & (0xf0 >> shift)) | ((data & 0x0f) << shift));
    } else {
      const shift = (address & 3) << 1;
      const index = address >> 2;
      this.bwWrite(index, (this.bwRead(index) & ~(0x03 << shift)) | ((data & 0x03) << shift));
    }
  }

  // ── main-bus (S-CPU) side ───────────────────────────────────────────

  /** S-CPU read of an SA-1 board region; null = not an SA-1 address
   *  (open bus on these boards — the console falls back to its MDR). */
  readCpu(bank: number, off: number): number | null {
    const sysBank = bank & 0x7f;
    if (sysBank <= 0x3f) {
      if (off >= 0x8000) return this.romReadCpu(bank, off);
      if (off >= 0x6000) {
        const index = this.sbm * 0x2000 + (off & 0x1fff);
        if (this.bwramCc1) return this.dmaCc1Read(index);
        return this.bwRead(index);
      }
      if (off >= 0x3000 && off <= 0x37ff) return this.iram[off & 0x7ff]!;
      if (off >= 0x2200 && off <= 0x23ff) return this.readIoCpu(0x2200 | (off & 0x1ff));
      return null;
    }
    if (bank >= 0xc0) return this.romReadCpu(bank, off);
    if (bank >= 0x40 && bank <= 0x4f) return this.bwRead(((bank - 0x40) << 16) | off);
    return null;
  }

  /** S-CPU write; returns true when the address belongs to the board. */
  writeCpu(bank: number, off: number, value: number): boolean {
    const sysBank = bank & 0x7f;
    if (sysBank <= 0x3f) {
      if (off >= 0x8000) return true; // ROM
      if (off >= 0x6000) {
        const index = this.sbm * 0x2000 + (off & 0x1fff);
        if (!this.bwProtected(index)) this.bwWrite(index, value);
        return true;
      }
      if (off >= 0x3000 && off <= 0x37ff) {
        if (this.siwp & (1 << ((off >> 8) & 7))) this.iram[off & 0x7ff] = value;
        return true;
      }
      if (off >= 0x2200 && off <= 0x23ff) {
        this.writeIoCpu(0x2200 | (off & 0x1ff), value);
        return true;
      }
      return false;
    }
    if (bank >= 0xc0) return true; // ROM
    if (bank >= 0x40 && bank <= 0x4f) {
      this.bwWriteLinear(((bank - 0x40) << 16) | off, value);
      return true;
    }
    return false;
  }

  // ── SA-1 side bus ───────────────────────────────────────────────────

  readSa1Bus(addr: number): number {
    if (this.vectorValue >= 0 && addr >= 0x00ffe0 && addr <= 0x00ffff) {
      return (addr & 1) === 0 ? this.vectorValue & 0xff : this.vectorValue >> 8;
    }
    let v: number;
    if ((addr & 0x40fe00) === 0x002200) {
      v = this.readIoSa1(0x2200 | (addr & 0x1ff));
    } else if ((addr & 0x408000) === 0x008000) {
      v = this.romReadLoHalf((addr >> 16) & 0xff, addr & 0xffff);
    } else if ((addr & 0xc00000) === 0xc00000) {
      v = this.romReadTranslated(addr, false);
    } else if ((addr & 0x40e000) === 0x006000) {
      // $6000-$7FFF window: CBM block, linear or bitmap per SW46
      if (!this.sw46) v = this.bwRead((this.cbm & 0x1f) * 0x2000 + (addr & 0x1fff));
      else v = this.bwReadBitmap(((this.cbm * 0x2000) & 0xfffff) + (addr & 0x1fff));
    } else if ((addr & 0xe00000) === 0x400000) {
      v = this.bwRead(addr & 0x1fffff);
    } else if ((addr & 0xf00000) === 0x600000) {
      v = this.bwReadBitmap(addr & 0xfffff);
    } else if ((addr & 0x40f800) === 0x000000 || (addr & 0x40f800) === 0x003000) {
      v = this.iram[addr & 0x7ff]!;
    } else {
      v = this.openBus;
    }
    this.openBus = v;
    return v;
  }

  writeSa1Bus(addr: number, value: number): void {
    this.openBus = value;
    if ((addr & 0x40fe00) === 0x002200) {
      this.writeIoSa1(0x2200 | (addr & 0x1ff), value);
      return;
    }
    if ((addr & 0x408000) === 0x008000 || (addr & 0xc00000) === 0xc00000) return; // ROM
    if ((addr & 0x40e000) === 0x006000) {
      if (!this.sw46) this.bwWriteLinear((this.cbm & 0x1f) * 0x2000 + (addr & 0x1fff), value);
      else this.bwWriteBitmap(((this.cbm * 0x2000) & 0xfffff) + (addr & 0x1fff), value);
      return;
    }
    if ((addr & 0xe00000) === 0x400000) {
      this.bwWriteLinear(addr & 0x1fffff, value);
      return;
    }
    if ((addr & 0xf00000) === 0x600000) {
      this.bwWriteBitmap(addr & 0xfffff, value);
      return;
    }
    if ((addr & 0x40f800) === 0x000000 || (addr & 0x40f800) === 0x003000) {
      if (this.ciwp & (1 << ((addr >> 8) & 7))) this.iram[addr & 0x7ff] = value;
    }
  }

  // ── MMIO: S-CPU side ────────────────────────────────────────────────

  private readIoCpu(reg: number): number | null {
    if (reg === 0x2300) {
      // (SFR) S-CPU flag read
      return (
        ((this.cpuIrqFl ? 1 : 0) << 7) |
        ((this.cpuIvsw ? 1 : 0) << 6) |
        ((this.chdmaIrqFl ? 1 : 0) << 5) |
        ((this.cpuNvsw ? 1 : 0) << 4) |
        this.cmeg
      );
    }
    return null;
  }

  private writeIoCpu(reg: number, data: number): void {
    switch (reg) {
      case 0x2200: {
        // (CCNT) SA-1 control
        if (this.sa1Resb && !(data & 0x20)) {
          // release reset: PC from CRV, bank registers to 0
          this.cpu.pc = this.crv;
          this.cpu.pbr = 0;
          this.cpu.dbr = 0;
          this.cpu.stopped = false;
          this.ciwp = 0x00;
        }
        this.sa1Irq = (data & 0x80) !== 0;
        this.sa1Rdyb = (data & 0x40) !== 0;
        this.sa1Resb = (data & 0x20) !== 0;
        this.sa1Nmi = (data & 0x10) !== 0;
        this.smeg = data & 0x0f;
        if (this.sa1Irq) {
          this.sa1IrqFl = true;
          if (this.sa1IrqEn) this.sa1IrqCl = false;
        }
        if (this.sa1Nmi) {
          this.sa1NmiFl = true;
          if (this.sa1NmiEn) this.sa1NmiCl = false;
        }
        break;
      }
      case 0x2201: {
        // (SIE) S-CPU interrupt enable
        if (!this.cpuIrqEn && data & 0x80 && this.cpuIrqFl) this.cpuIrqCl = false;
        if (!this.chdmaIrqEn && data & 0x20 && this.chdmaIrqFl) this.chdmaIrqCl = false;
        this.cpuIrqEn = (data & 0x80) !== 0;
        this.chdmaIrqEn = (data & 0x20) !== 0;
        if (this.snesIrqAsserted()) this.onSnesIrq?.();
        break;
      }
      case 0x2202: {
        // (SIC) S-CPU interrupt clear
        this.cpuIrqCl = (data & 0x80) !== 0;
        this.chdmaIrqCl = (data & 0x20) !== 0;
        if (this.cpuIrqCl) this.cpuIrqFl = false;
        if (this.chdmaIrqCl) this.chdmaIrqFl = false;
        break;
      }
      case 0x2203:
        this.crv = (this.crv & 0xff00) | data;
        break;
      case 0x2204:
        this.crv = (data << 8) | (this.crv & 0xff);
        break;
      case 0x2205:
        this.cnv = (this.cnv & 0xff00) | data;
        break;
      case 0x2206:
        this.cnv = (data << 8) | (this.cnv & 0xff);
        break;
      case 0x2207:
        this.civ = (this.civ & 0xff00) | data;
        break;
      case 0x2208:
        this.civ = (data << 8) | (this.civ & 0xff);
        break;
      case 0x2220:
        this.cbMode = (data & 0x80) !== 0;
        this.cb = data & 0x07;
        break;
      case 0x2221:
        this.dbMode = (data & 0x80) !== 0;
        this.db = data & 0x07;
        break;
      case 0x2222:
        this.ebMode = (data & 0x80) !== 0;
        this.eb = data & 0x07;
        break;
      case 0x2223:
        this.fbMode = (data & 0x80) !== 0;
        this.fb = data & 0x07;
        break;
      case 0x2224:
        this.sbm = data & 0x1f;
        break;
      case 0x2226:
        this.swen = (data & 0x80) !== 0;
        break;
      case 0x2228:
        this.bwp = data & 0x0f;
        break;
      case 0x2229:
        this.siwp = data;
        break;
      case 0x2231:
      case 0x2232:
      case 0x2233:
      case 0x2234:
      case 0x2235:
      case 0x2236:
      case 0x2237:
        this.writeIoShared(reg, data);
        break;
    }
  }

  // ── MMIO: SA-1 side ─────────────────────────────────────────────────

  private readIoSa1(reg: number): number {
    switch (reg) {
      case 0x2301:
        // (CFR) SA-1 flag read
        return (
          ((this.sa1IrqFl ? 1 : 0) << 7) |
          ((this.timerIrqFl ? 1 : 0) << 6) |
          ((this.dmaIrqFl ? 1 : 0) << 5) |
          ((this.sa1NmiFl ? 1 : 0) << 4) |
          this.smeg
        );
      case 0x2302:
        // (HCR) latches both counters; hcounter is in clocks, HCR in dots
        this.hcrLatch = this.hcounter >> 2;
        this.vcrLatch = this.vcounter;
        return this.hcrLatch & 0xff;
      case 0x2303:
        return this.hcrLatch >> 8;
      case 0x2304:
        return this.vcrLatch & 0xff;
      case 0x2305:
        return this.vcrLatch >> 8;
      case 0x2306:
        return this.mr & 0xff;
      case 0x2307:
        return Math.floor(this.mr / 0x100) & 0xff;
      case 0x2308:
        return Math.floor(this.mr / 0x10000) & 0xff;
      case 0x2309:
        return Math.floor(this.mr / 0x1000000) & 0xff;
      case 0x230a:
        return Math.floor(this.mr / 0x100000000) & 0xff;
      case 0x230b:
        return this.overflow ? 0x80 : 0;
      case 0x230c: {
        return this.vbrData() & 0xff;
      }
      case 0x230d: {
        const v = this.vbrData();
        if (this.vbHl) this.vbrAdvance();
        return (v >> 8) & 0xff;
      }
    }
    return 0xff;
  }

  private writeIoSa1(reg: number, data: number): void {
    switch (reg) {
      case 0x2209: {
        // (SCNT) S-CPU control
        this.cpuIrq = (data & 0x80) !== 0;
        this.cpuIvsw = (data & 0x40) !== 0;
        this.cpuNvsw = (data & 0x10) !== 0;
        this.cmeg = data & 0x0f;
        if (this.cpuIrq) {
          this.cpuIrqFl = true;
          if (this.cpuIrqEn) {
            this.cpuIrqCl = false;
            this.onSnesIrq?.();
          }
        }
        break;
      }
      case 0x220a: {
        // (CIE) SA-1 interrupt enable
        if (!this.sa1IrqEn && data & 0x80 && this.sa1IrqFl) this.sa1IrqCl = false;
        if (!this.timerIrqEn && data & 0x40 && this.timerIrqFl) this.timerIrqCl = false;
        if (!this.dmaIrqEn && data & 0x20 && this.dmaIrqFl) this.dmaIrqCl = false;
        if (!this.sa1NmiEn && data & 0x10 && this.sa1NmiFl) this.sa1NmiCl = false;
        this.sa1IrqEn = (data & 0x80) !== 0;
        this.timerIrqEn = (data & 0x40) !== 0;
        this.dmaIrqEn = (data & 0x20) !== 0;
        this.sa1NmiEn = (data & 0x10) !== 0;
        break;
      }
      case 0x220b: {
        // (CIC) SA-1 interrupt clear
        this.sa1IrqCl = (data & 0x80) !== 0;
        this.timerIrqCl = (data & 0x40) !== 0;
        this.dmaIrqCl = (data & 0x20) !== 0;
        this.sa1NmiCl = (data & 0x10) !== 0;
        if (this.sa1IrqCl) this.sa1IrqFl = false;
        if (this.timerIrqCl) this.timerIrqFl = false;
        if (this.dmaIrqCl) this.dmaIrqFl = false;
        if (this.sa1NmiCl) this.sa1NmiFl = false;
        break;
      }
      case 0x220c:
        this.snv = (this.snv & 0xff00) | data;
        break;
      case 0x220d:
        this.snv = (data << 8) | (this.snv & 0xff);
        break;
      case 0x220e:
        this.siv = (this.siv & 0xff00) | data;
        break;
      case 0x220f:
        this.siv = (data << 8) | (this.siv & 0xff);
        break;
      case 0x2210:
        this.hvselb = (data & 0x80) !== 0;
        this.ven = (data & 0x02) !== 0;
        this.hen = (data & 0x01) !== 0;
        break;
      case 0x2211:
        this.hcounter = 0;
        this.vcounter = 0;
        break;
      case 0x2212:
        this.hcnt = (this.hcnt & 0xff00) | data;
        break;
      case 0x2213:
        this.hcnt = (this.hcnt & 0x00ff) | (data << 8);
        break;
      case 0x2214:
        this.vcnt = (this.vcnt & 0xff00) | data;
        break;
      case 0x2215:
        this.vcnt = (this.vcnt & 0x00ff) | (data << 8);
        break;
      case 0x2225:
        this.sw46 = (data & 0x80) !== 0;
        this.cbm = data & 0x7f;
        break;
      case 0x2227:
        this.cwen = (data & 0x80) !== 0;
        break;
      case 0x222a:
        this.ciwp = data;
        break;
      case 0x2230:
        this.dmaEn = (data & 0x80) !== 0;
        this.dprio = (data & 0x40) !== 0;
        this.cden = (data & 0x20) !== 0;
        this.cdsel = (data & 0x10) !== 0;
        this.dd = (data >> 2) & 1;
        this.sd = data & 0x03;
        if (!this.dmaEn) this.dmaLine = 0;
        break;
      case 0x2231:
      case 0x2232:
      case 0x2233:
      case 0x2234:
      case 0x2235:
      case 0x2236:
      case 0x2237:
        this.writeIoShared(reg, data);
        break;
      case 0x2238:
        this.dtc = (this.dtc & 0xff00) | data;
        break;
      case 0x2239:
        this.dtc = (this.dtc & 0x00ff) | (data << 8);
        break;
      case 0x223f:
        this.bbf = (data & 0x80) !== 0;
        break;
      case 0x2250:
        this.acm = (data & 0x02) !== 0;
        this.md = (data & 0x01) !== 0;
        if (this.acm) {
          this.mr = 0;
          this.overflow = false;
        }
        break;
      case 0x2251:
        this.ma = (this.ma & 0xff00) | data;
        break;
      case 0x2252:
        this.ma = (this.ma & 0x00ff) | (data << 8);
        break;
      case 0x2253:
        this.mb = (this.mb & 0xff00) | data;
        break;
      case 0x2254:
        this.mb = (this.mb & 0x00ff) | (data << 8);
        this.runArithmetic();
        break;
      case 0x2258: {
        // (VBD) variable-length bit control
        this.vbHl = (data & 0x80) !== 0;
        this.vb = data & 0x0f;
        if (this.vb === 0) this.vb = 16;
        if (!this.vbHl) this.vbrAdvance();
        break;
      }
      case 0x2259:
        this.va = (this.va & 0xffff00) | data;
        break;
      case 0x225a:
        this.va = (this.va & 0xff00ff) | (data << 8);
        break;
      case 0x225b:
        this.va = (this.va & 0x00ffff) | (data << 16);
        this.vbit = 0;
        break;
      default:
        if (reg >= 0x2240 && reg <= 0x224f) {
          this.brf[reg - 0x2240] = data;
          if ((reg === 0x2247 || reg === 0x224f) && this.dmaEn && this.cden && !this.cdsel) {
            this.dmaCc2();
          }
        }
        break;
    }
  }

  private writeIoShared(reg: number, data: number): void {
    switch (reg) {
      case 0x2231:
        // (CDMA) character conversion parameters
        this.chdend = (data & 0x80) !== 0;
        this.dmaSize = Math.min((data >> 2) & 7, 5);
        this.dmaCb = Math.min(data & 0x03, 2);
        if (this.chdend) this.bwramCc1 = false;
        break;
      case 0x2232:
        this.dsa = (this.dsa & 0xffff00) | data;
        break;
      case 0x2233:
        this.dsa = (this.dsa & 0xff00ff) | (data << 8);
        break;
      case 0x2234:
        this.dsa = (this.dsa & 0x00ffff) | (data << 16);
        break;
      case 0x2235:
        this.dda = (this.dda & 0xffff00) | data;
        break;
      case 0x2236:
        this.dda = (this.dda & 0xff00ff) | (data << 8);
        if (this.dmaEn) {
          if (!this.cden && this.dd === 0) this.dmaNormal();
          else if (this.cden && this.cdsel) this.dmaCc1();
        }
        break;
      case 0x2237:
        this.dda = (this.dda & 0x00ffff) | (data << 16);
        if (this.dmaEn && !this.cden && this.dd === 1) this.dmaNormal();
        break;
    }
  }

  // ── arithmetic unit ─────────────────────────────────────────────────

  private runArithmetic(): void {
    const maS = (this.ma << 16) >> 16;
    const mbS = (this.mb << 16) >> 16;
    if (!this.acm) {
      if (!this.md) {
        // signed multiply (result as unsigned 32-bit)
        this.mr = (maS * mbS) >>> 0;
        this.mb = 0;
      } else {
        // signed ÷ unsigned divide, rounding toward negative infinity
        if (this.mb === 0) {
          this.mr = 0;
        } else {
          const dividendExt = maS + this.mb * 65536;
          const remainder = dividendExt % this.mb;
          const quotient = Math.floor(dividendExt / this.mb) - 65536;
          this.mr = (remainder * 0x10000 + (quotient & 0xffff)) >>> 0;
        }
        this.ma = 0;
        this.mb = 0;
      }
    } else {
      // cumulative sum: 40-bit accumulator with overflow flag
      const sum = this.mr + maS * mbS;
      this.overflow = sum < 0 || sum >= 0x10000000000;
      this.mr = ((sum % 0x10000000000) + 0x10000000000) % 0x10000000000;
      this.mb = 0;
    }
  }

  // ── variable-length bit reader ──────────────────────────────────────

  private readVbr(address: number): number {
    const addr = address & 0xffffff;
    if ((addr & 0x408000) === 0x008000) return this.romReadLoHalf((addr >> 16) & 0xff, addr & 0xffff);
    if ((addr & 0xc00000) === 0xc00000) return this.romReadTranslated(addr, false);
    if ((addr & 0x40e000) === 0x006000) return this.bwRead(addr & 0xffff);
    if ((addr & 0xf00000) === 0x400000) return this.bwRead(addr & 0xfffff);
    if ((addr & 0x40f800) === 0x000000 || (addr & 0x40f800) === 0x003000) return this.iram[addr & 0x7ff]!;
    return 0xff;
  }

  private vbrData(): number {
    const b0 = this.readVbr(this.va);
    const b1 = this.readVbr(this.va + 1);
    const b2 = this.readVbr(this.va + 2);
    return ((b0 | (b1 << 8) | (b2 << 16)) >> this.vbit) & 0xffff;
  }

  private vbrAdvance(): void {
    this.vbit += this.vb;
    this.va = (this.va + (this.vbit >> 3)) & 0xffffff;
    this.vbit &= 7;
  }

  // ── DMA ─────────────────────────────────────────────────────────────

  private dmaNormal(): void {
    let count = this.dtc;
    // Charge the transfer to the SA-1's clock (≈1 chip cycle per byte,
    // 2 for BW-RAM endpoints).
    const perByte = this.sd === 0 && this.dd === 0 ? 2 : 4;
    this.cpu.cycles += count * perByte;
    while (count-- > 0) {
      const source = this.dsa;
      const target = this.dda;
      this.dsa = (this.dsa + 1) & 0xffffff;
      this.dda = (this.dda + 1) & 0xffffff;
      let data = this.openBus;
      if (this.sd === 0) {
        // ROM source (addresses use the SA-1 bus views)
        if ((source & 0x408000) === 0x008000) data = this.romReadLoHalf((source >> 16) & 0xff, source & 0xffff);
        else if ((source & 0xc00000) === 0xc00000) data = this.romReadTranslated(source, false);
        else data = 0;
      } else if (this.sd === 1) {
        data = this.bwRead(source);
      } else if (this.sd === 2) {
        data = this.iram[source & 0x7ff]!;
      } else {
        continue; // reserved source
      }
      if (this.dd === 0) this.iram[target & 0x7ff] = data;
      else this.bwWrite(target, data);
    }
    this.dtc = 0;
    this.dmaIrqFl = true;
    if (this.dmaIrqEn) this.dmaIrqCl = false;
  }

  private dmaCc1(): void {
    this.bwramCc1 = true;
    this.chdmaIrqFl = true;
    if (this.chdmaIrqEn) {
      this.chdmaIrqCl = false;
      this.onSnesIrq?.();
    }
  }

  /** Serve the S-CPU's $6000-window reads while type-1 character
   *  conversion is armed: convert one bitmap tile to planar on demand. */
  private dmaCc1Read(addr: number): number {
    const charmask = (1 << (6 - this.dmaCb)) - 1;
    if ((addr & charmask) === 0) {
      const bpp = 2 << (2 - this.dmaCb);
      const bpl = (8 << this.dmaSize) >> this.dmaCb;
      const bwmask = this.bwramMask;
      const tile = ((addr - this.dsa) & bwmask) >> (6 - this.dmaCb);
      const ty = tile >> this.dmaSize;
      const tx = tile & ((1 << this.dmaSize) - 1);
      let bwaddr = this.dsa + ty * 8 * bpl + tx * bpp;
      for (let y = 0; y < 8; y++) {
        // Collect up to 8 source bytes (64 bits): keep them as an array
        // of bytes and walk bits explicitly to avoid 2^53 pitfalls.
        const src: number[] = [];
        for (let byte = 0; byte < bpp; byte++) src.push(this.bwRead((bwaddr + byte) & bwmask));
        bwaddr += bpl;
        const out = [0, 0, 0, 0, 0, 0, 0, 0];
        let bitIndex = 0;
        for (let x = 0; x < 8; x++) {
          for (let plane = 0; plane < bpp; plane++) {
            const bit = (src[bitIndex >> 3]! >> (bitIndex & 7)) & 1;
            bitIndex++;
            out[plane]! |= bit << (7 - x);
          }
        }
        for (let byte = 0; byte < bpp; byte++) {
          const p = this.dda + (y << 1) + ((byte & 6) << 3) + (byte & 1);
          this.iram[p & 0x7ff] = out[byte]!;
        }
      }
    }
    return this.iram[(this.dda + (addr & charmask)) & 0x7ff]!;
  }

  /** Type-2 character conversion: 8 BRF bytes → one bitplane row. */
  private dmaCc2(): void {
    const base = (this.dmaLine & 1) << 3;
    const bpp = 2 << (2 - this.dmaCb);
    let addr = this.dda & 0x7ff;
    addr &= ~((1 << (7 - this.dmaCb)) - 1);
    addr += (this.dmaLine & 8) * bpp;
    addr += (this.dmaLine & 7) * 2;
    for (let byte = 0; byte < bpp; byte++) {
      let output = 0;
      for (let bit = 0; bit < 8; bit++) {
        output |= ((this.brf[base + bit]! >> byte) & 1) << (7 - bit);
      }
      this.iram[(addr + ((byte & 6) << 3) + (byte & 1)) & 0x7ff] = output;
    }
    this.dmaLine = (this.dmaLine + 1) & 15;
  }

  // ── persistence ─────────────────────────────────────────────────────

  serialize(w: SnesStateWriter): void {
    this.cpu.serialize(w);
    w.bytes(this.iram);
    w.f64(this.budget);
    w.u8(this.openBus);
    w.u16(this.hcounter);
    w.u16(this.vcounter);
    w.u8((this.hvselb ? 4 : 0) | (this.ven ? 2 : 0) | (this.hen ? 1 : 0));
    w.u16(this.hcnt);
    w.u16(this.vcnt);
    w.u16(this.hcrLatch);
    w.u16(this.vcrLatch);
    w.u8(
      (this.sa1Irq ? 1 : 0) |
        ((this.sa1Rdyb ? 1 : 0) << 1) |
        ((this.sa1Resb ? 1 : 0) << 2) |
        ((this.sa1Nmi ? 1 : 0) << 3) |
        ((this.cpuIrq ? 1 : 0) << 4) |
        ((this.cpuIvsw ? 1 : 0) << 5) |
        ((this.cpuNvsw ? 1 : 0) << 6)
    );
    w.u8(this.smeg);
    w.u8(this.cmeg);
    w.u8(
      (this.cpuIrqEn ? 1 : 0) |
        ((this.chdmaIrqEn ? 1 : 0) << 1) |
        ((this.cpuIrqCl ? 1 : 0) << 2) |
        ((this.chdmaIrqCl ? 1 : 0) << 3) |
        ((this.cpuIrqFl ? 1 : 0) << 4) |
        ((this.chdmaIrqFl ? 1 : 0) << 5)
    );
    w.u8(
      (this.sa1IrqEn ? 1 : 0) |
        ((this.timerIrqEn ? 1 : 0) << 1) |
        ((this.dmaIrqEn ? 1 : 0) << 2) |
        ((this.sa1NmiEn ? 1 : 0) << 3) |
        ((this.sa1IrqCl ? 1 : 0) << 4) |
        ((this.timerIrqCl ? 1 : 0) << 5) |
        ((this.dmaIrqCl ? 1 : 0) << 6) |
        ((this.sa1NmiCl ? 1 : 0) << 7)
    );
    w.u8(
      (this.sa1IrqFl ? 1 : 0) |
        ((this.timerIrqFl ? 1 : 0) << 1) |
        ((this.dmaIrqFl ? 1 : 0) << 2) |
        ((this.sa1NmiFl ? 1 : 0) << 3)
    );
    w.u16(this.crv);
    w.u16(this.cnv);
    w.u16(this.civ);
    w.u16(this.snv);
    w.u16(this.siv);
    w.u8((this.cbMode ? 8 : 0) | this.cb);
    w.u8((this.dbMode ? 8 : 0) | this.db);
    w.u8((this.ebMode ? 8 : 0) | this.eb);
    w.u8((this.fbMode ? 8 : 0) | this.fb);
    w.u8(this.sbm);
    w.u8((this.sw46 ? 0x80 : 0) | this.cbm);
    w.u8((this.swen ? 1 : 0) | ((this.cwen ? 1 : 0) << 1));
    w.u8(this.bwp);
    w.u8(this.siwp);
    w.u8(this.ciwp);
    w.u8(
      (this.dmaEn ? 1 : 0) |
        ((this.dprio ? 1 : 0) << 1) |
        ((this.cden ? 1 : 0) << 2) |
        ((this.cdsel ? 1 : 0) << 3) |
        ((this.dd ? 1 : 0) << 4) |
        (this.sd << 5) |
        ((this.chdend ? 1 : 0) << 7)
    );
    w.u8(this.dmaSize);
    w.u8(this.dmaCb);
    w.u32(this.dsa);
    w.u32(this.dda);
    w.u16(this.dtc);
    w.bool(this.bbf);
    w.bytes(this.brf);
    w.u8(this.dmaLine);
    w.bool(this.bwramCc1);
    w.u8((this.acm ? 1 : 0) | ((this.md ? 1 : 0) << 1) | ((this.overflow ? 1 : 0) << 2));
    w.u16(this.ma);
    w.u16(this.mb);
    w.f64(this.mr);
    w.u8((this.vbHl ? 0x80 : 0) | (this.vb & 0x1f));
    w.u32(this.va);
    w.u8(this.vbit);
  }

  deserialize(r: SnesStateReader): void {
    this.cpu.deserialize(r);
    r.bytes(this.iram);
    this.budget = r.f64();
    this.openBus = r.u8();
    this.hcounter = r.u16();
    this.vcounter = r.u16();
    let b = r.u8();
    this.hvselb = (b & 4) !== 0;
    this.ven = (b & 2) !== 0;
    this.hen = (b & 1) !== 0;
    this.hcnt = r.u16();
    this.vcnt = r.u16();
    this.hcrLatch = r.u16();
    this.vcrLatch = r.u16();
    b = r.u8();
    this.sa1Irq = (b & 1) !== 0;
    this.sa1Rdyb = (b & 2) !== 0;
    this.sa1Resb = (b & 4) !== 0;
    this.sa1Nmi = (b & 8) !== 0;
    this.cpuIrq = (b & 16) !== 0;
    this.cpuIvsw = (b & 32) !== 0;
    this.cpuNvsw = (b & 64) !== 0;
    this.smeg = r.u8();
    this.cmeg = r.u8();
    b = r.u8();
    this.cpuIrqEn = (b & 1) !== 0;
    this.chdmaIrqEn = (b & 2) !== 0;
    this.cpuIrqCl = (b & 4) !== 0;
    this.chdmaIrqCl = (b & 8) !== 0;
    this.cpuIrqFl = (b & 16) !== 0;
    this.chdmaIrqFl = (b & 32) !== 0;
    b = r.u8();
    this.sa1IrqEn = (b & 1) !== 0;
    this.timerIrqEn = (b & 2) !== 0;
    this.dmaIrqEn = (b & 4) !== 0;
    this.sa1NmiEn = (b & 8) !== 0;
    this.sa1IrqCl = (b & 16) !== 0;
    this.timerIrqCl = (b & 32) !== 0;
    this.dmaIrqCl = (b & 64) !== 0;
    this.sa1NmiCl = (b & 128) !== 0;
    b = r.u8();
    this.sa1IrqFl = (b & 1) !== 0;
    this.timerIrqFl = (b & 2) !== 0;
    this.dmaIrqFl = (b & 4) !== 0;
    this.sa1NmiFl = (b & 8) !== 0;
    this.crv = r.u16();
    this.cnv = r.u16();
    this.civ = r.u16();
    this.snv = r.u16();
    this.siv = r.u16();
    b = r.u8();
    this.cbMode = (b & 8) !== 0;
    this.cb = b & 7;
    b = r.u8();
    this.dbMode = (b & 8) !== 0;
    this.db = b & 7;
    b = r.u8();
    this.ebMode = (b & 8) !== 0;
    this.eb = b & 7;
    b = r.u8();
    this.fbMode = (b & 8) !== 0;
    this.fb = b & 7;
    this.sbm = r.u8();
    b = r.u8();
    this.sw46 = (b & 0x80) !== 0;
    this.cbm = b & 0x7f;
    b = r.u8();
    this.swen = (b & 1) !== 0;
    this.cwen = (b & 2) !== 0;
    this.bwp = r.u8();
    this.siwp = r.u8();
    this.ciwp = r.u8();
    b = r.u8();
    this.dmaEn = (b & 1) !== 0;
    this.dprio = (b & 2) !== 0;
    this.cden = (b & 4) !== 0;
    this.cdsel = (b & 8) !== 0;
    this.dd = (b >> 4) & 1;
    this.sd = (b >> 5) & 3;
    this.chdend = (b & 0x80) !== 0;
    this.dmaSize = r.u8();
    this.dmaCb = r.u8();
    this.dsa = r.u32();
    this.dda = r.u32();
    this.dtc = r.u16();
    this.bbf = r.bool();
    r.bytes(this.brf);
    this.dmaLine = r.u8();
    this.bwramCc1 = r.bool();
    b = r.u8();
    this.acm = (b & 1) !== 0;
    this.md = (b & 2) !== 0;
    this.overflow = (b & 4) !== 0;
    this.ma = r.u16();
    this.mb = r.u16();
    this.mr = r.f64();
    b = r.u8();
    this.vbHl = (b & 0x80) !== 0;
    this.vb = b & 0x1f;
    this.va = r.u32();
    this.vbit = r.u8();
    this.vectorValue = -1;
  }
}
