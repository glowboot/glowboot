/**
 * SNES system bus — the 24-bit address space the 65C816 sees.
 *
 * Memory map (banks $80-$FF mirror $00-$7F apart from WRAM):
 *   $00-$3F / $80-$BF  system banks:
 *     $0000-$1FFF  mirror of the first 8 KiB of WRAM
 *     $2100-$21FF  B-bus MMIO (PPU, APU ports, WRAM data port)
 *     $4000-$41FF  joypad I/O
 *     $4200-$43FF  CPU MMIO (interrupts, timers, DMA registers)
 *     $6000-$7FFF  cartridge expansion (HiROM SRAM windows)
 *     $8000-$FFFF  cartridge ROM
 *   $40-$7D / $C0-$FF  cartridge ROM (HiROM banks; LoROM mirrors)
 *   $70-$7D            LoROM SRAM ($0000-$7FFF windows)
 *   $7E-$7F            128 KiB WRAM
 *
 * Reads from unmapped space return the memory data register (open bus —
 * the last byte that crossed the bus). MMIO outside the WRAM port is
 * dispatched to handlers the owning subsystems register; unclaimed MMIO
 * reads are open bus too.
 *
 * Reference: fullsnes "SNES Memory Map".
 */

import type { SnesRom } from "../cartridge/rom.js";
import type { Cx4 } from "../coprocessor/cx4.js";
import type { Dsp1 } from "../coprocessor/dsp1.js";
import type { Obc1 } from "../coprocessor/obc1.js";
import type { Sa1 } from "../coprocessor/sa1.js";
import type { Sdd1 } from "../coprocessor/sdd1.js";
import type { Srtc } from "../coprocessor/srtc.js";
import type { SuperFx } from "../coprocessor/superfx.js";
import type { SnesCpuBus } from "../cpu/cpu.js";
import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

export type MmioReadHandler = (addr: number) => number | null;
export type MmioWriteHandler = (addr: number, value: number) => void;

export class SnesBus implements SnesCpuBus {
  readonly wram = new Uint8Array(0x20000);
  readonly sram: Uint8Array;

  /** Memory data register — the last byte driven onto the bus (open bus). */
  mdr = 0;

  /** MEMSEL ($420D bit 0): FastROM — banks $80+ ROM at 6 master cycles. */
  fastRom = false;

  /** B-bus + CPU MMIO handlers, registered by the owning subsystems (PPU,
   *  APU, DMA, joypads). Return null from a read handler for open bus. */
  onIoRead: MmioReadHandler | null = null;
  onIoWrite: MmioWriteHandler | null = null;
  /** Cart-ROM read intercept (Game Genie patches). Receives the normalised
   *  bus address ((bank & 0x7f) << 16 | offset) and the original byte. */
  patchRomRead: ((addr: number, orig: number) => number) | null = null;

  /** DSP-1 coprocessor and its board window (set by the console when the
   *  cart carries the chip). Window per fullsnes "DSP Mapping":
   *  lorom  — banks $20-$3F: DR $8000-$BFFF, SR $C000-$FFFF
   *  lorom2 — banks $60-$6F: DR $0000-$3FFF, SR $4000-$7FFF (>1 MiB boards)
   *  hirom  — banks $00-$1F: DR $6000-$6FFF, SR $7000-$7FFF */
  dsp1: Dsp1 | null = null;
  dsp1Window: "lorom" | "lorom2" | "hirom" = "lorom";

  /** SA-1 unit (set by the console when the cart carries the chip). On
   *  these boards the SA-1 owns everything outside the console's system
   *  regions — ROM (through its Super MMC), BW-RAM windows, I-RAM and
   *  the $2200-$23FF register file. */
  sa1: Sa1 | null = null;

  /** SuperFX unit — like the SA-1, the board decodes everything outside
   *  the console's system regions (its ROM/RAM visibility depends on
   *  who owns the bus per SCMR). */
  superfx: SuperFx | null = null;

  /** S-DD1 unit — passive: the console keeps WRAM/MMIO/DMA/SRAM; the chip
   *  only remaps ROM banks $C0-$FF, decompresses DMA reads, and adds the
   *  $4800-$480F registers. */
  sdd1: Sdd1 | null = null;

  /** Cx4 unit — claims only $00-3F/$80-BF:6000-7FFF (its 8 KiB RAM +
   *  command registers); everything else is a normal LoROM cart. */
  cx4: Cx4 | null = null;

  /** OBC1 unit (Metal Combat) — claims only $00-3F/$80-BF:6000-7FFF (its
   *  8 KiB SRAM + OBJ-scatter registers); everything else is normal LoROM. */
  obc1: Obc1 | null = null;

  /** S-RTC clock (Dai Kaijuu Monogatari II) — claims only $00-3F/$80-BF:2800
   *  (read) / $2801 (command+write). */
  srtc: Srtc | null = null;

  /** DSP-1 port decode for `addr`: "dr" | "sr" | null (not a DSP address). */
  private dsp1Port(sysBank: number, off: number): "dr" | "sr" | null {
    if (this.dsp1 === null) return null;
    switch (this.dsp1Window) {
      case "lorom":
        if (sysBank >= 0x20 && sysBank <= 0x3f && off >= 0x8000) return off < 0xc000 ? "dr" : "sr";
        return null;
      case "lorom2":
        if (sysBank >= 0x60 && sysBank <= 0x6f && off < 0x8000) return off < 0x4000 ? "dr" : "sr";
        return null;
      case "hirom":
        if (sysBank <= 0x1f && off >= 0x6000 && off < 0x8000) return off < 0x7000 ? "dr" : "sr";
        return null;
    }
  }

  private readonly rom: Uint8Array;
  private readonly hirom: boolean;
  private readonly exhirom: boolean;
  private readonly extendedHighBanks: boolean;
  /** Size of the ExHiROM upper chip (ROM beyond the first 4 MiB); the two
   *  chips mirror independently, so it isn't just `rom.length`. */
  private readonly exUpperSize: number;
  private readonly sramMask: number;

  /** WRAM data-port address ($2181-$2183), 17 bits. */
  private wmadd = 0;

  constructor(cart: SnesRom) {
    this.rom = cart.rom;
    this.hirom = cart.mapping !== "lorom";
    this.exhirom = cart.mapping === "exhirom";
    this.extendedHighBanks = cart.extendedHighBanks;
    this.exUpperSize = Math.max(1, cart.rom.length - 0x400000);
    this.sram = new Uint8Array(cart.sramSize);
    this.sramMask = cart.sramSize > 0 ? cart.sramSize - 1 : 0;
  }

  serialize(w: SnesStateWriter): void {
    w.bytes(this.wram);
    w.bytes(this.sram);
    w.u8(this.mdr);
    w.u32(this.wmadd);
    w.bool(this.fastRom);
  }

  deserialize(r: SnesStateReader): void {
    r.bytes(this.wram);
    r.bytes(this.sram);
    this.mdr = r.u8();
    this.wmadd = r.u32();
    this.fastRom = r.bool();
  }

  /** Master-cycle cost of one CPU access to `addr` (fullsnes "Memory
   *  Access Cycles"): WRAM and cart regions in $00-$3F/$80-$BF and all of
   *  $40-$7D are SlowROM speed (8); MMIO at $2000-$5FFF is fast (6) except
   *  the $4000-$41FF joypad ports (12); banks $80+ cart ROM run fast when
   *  MEMSEL enables FastROM. */
  cost(addr: number): number {
    const bank = (addr >> 16) & 0xff;
    const off = addr & 0xffff;
    if (bank >= 0x7e && bank <= 0x7f) return 8; // WRAM
    if (bank >= 0x80) {
      if (off >= 0x8000 || bank >= 0xc0) return this.fastRom ? 6 : 8; // cart ROM
      if (off < 0x2000) return 8; // WRAM mirror
      if (off < 0x4000) return 6; // B-bus MMIO
      if (off < 0x4200) return 12; // joypad
      if (off < 0x6000) return 6; // CPU MMIO
      return 8; // expansion
    }
    if (bank >= 0x40) return 8; // SlowROM banks
    if (off >= 0x8000) return 8; // SlowROM
    if (off < 0x2000) return 8; // WRAM mirror
    if (off < 0x4000) return 6;
    if (off < 0x4200) return 12;
    if (off < 0x6000) return 6;
    return 8;
  }

  read(addr: number): number {
    const v = this.readRaw(addr);
    this.mdr = v;
    return v;
  }

  write(addr: number, value: number): void {
    this.mdr = value & 0xff;
    this.writeRaw(addr, value & 0xff);
  }

  private readRaw(addr: number): number {
    const bank = (addr >> 16) & 0xff;
    const off = addr & 0xffff;

    if (bank === 0x7e || bank === 0x7f) return this.wram[((bank - 0x7e) << 16) | off]!;

    const sysBank = bank & 0x7f;
    const dspPort = this.dsp1Port(sysBank, off);
    if (dspPort !== null) return dspPort === "dr" ? this.dsp1!.getDr() : this.dsp1!.getSr();
    if (this.cx4 && (bank & 0x40) === 0 && off >= 0x6000 && off < 0x8000) {
      return this.cx4.getC4(off);
    }
    if (this.obc1 && (bank & 0x40) === 0 && off >= 0x6000 && off < 0x8000) {
      return this.obc1.read(off);
    }
    if (this.srtc && (bank & 0x40) === 0 && (off === 0x2800 || off === 0x2801)) {
      return this.srtc.read(off);
    }
    if (this.sa1) {
      // System regions stay with the console; the SA-1 board decodes
      // the rest (unclaimed addresses are open bus on these carts).
      if (sysBank <= 0x3f && off < 0x8000) {
        if (off < 0x2000) return this.wram[off]!;
        if (off >= 0x2180 && off <= 0x2183) return this.readWmPort(off);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          return this.onIoRead?.(off) ?? this.mdr;
        }
      }
      return this.sa1.readCpu(bank, off) ?? this.mdr;
    }
    if (this.superfx) {
      if (sysBank <= 0x3f && off < 0x8000) {
        if (off < 0x2000) return this.wram[off]!;
        if (off >= 0x2180 && off <= 0x2183) return this.readWmPort(off);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          return this.onIoRead?.(off) ?? this.mdr;
        }
      }
      return this.superfx.readCpu(bank, off) ?? this.mdr;
    }
    if (this.sdd1) {
      // System half of $00-3F/$80-BF stays with the console.
      if ((bank & 0x40) === 0 && off < 0x8000) {
        if (off < 0x2000) return this.wram[off]!;
        if (off >= 0x2180 && off <= 0x2183) return this.readWmPort(off);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          return this.onIoRead?.(off) ?? this.mdr;
        }
        if (off >= 0x4800 && off <= 0x480f) return this.sdd1.ioRead(off);
        return this.mdr;
      }
      // LoROM SRAM at $70-$7D:0000-7FFF.
      if (bank >= 0x70 && bank <= 0x7d && off < 0x8000) {
        if (this.sramMask) return this.sram[((bank - 0x70) * 0x8000 + off) & this.sramMask]!;
        return this.mdr;
      }
      // ROM: $00-3F/$80-BF:8000+ (LoROM fold) and $C0-FF (MMC + decompress).
      return this.sdd1.mcuRead(addr, this.mdr);
    }
    if (sysBank <= 0x3f) {
      if (off < 0x2000) return this.wram[off]!;
      if (off < 0x8000) {
        if (off >= 0x2180 && off <= 0x2183) return this.readWmPort(off);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          return this.onIoRead?.(off) ?? this.mdr;
        }
        if (off >= 0x6000 && this.hirom && this.sramMask) {
          return this.sram[((sysBank & 0x1f) * 0x2000 + (off - 0x6000)) & this.sramMask]!;
        }
        return this.mdr;
      }
      return this.readRom(bank, off);
    }

    // banks $40-$7D / $C0-$FF
    if (!this.hirom && sysBank >= 0x70 && sysBank <= 0x7d && off < 0x8000) {
      if (this.sramMask) return this.sram[((sysBank - 0x70) * 0x8000 + off) & this.sramMask]!;
      return this.mdr;
    }
    return this.readRom(bank, off);
  }

  private writeRaw(addr: number, value: number): void {
    const bank = (addr >> 16) & 0xff;
    const off = addr & 0xffff;

    if (bank === 0x7e || bank === 0x7f) {
      this.wram[((bank - 0x7e) << 16) | off] = value;
      return;
    }

    const sysBank = bank & 0x7f;
    const dspPort = this.dsp1Port(sysBank, off);
    if (dspPort !== null) {
      if (dspPort === "dr") this.dsp1!.setDr(value);
      return; // SR writes are ignored
    }
    if (this.cx4 && (bank & 0x40) === 0 && off >= 0x6000 && off < 0x8000) {
      this.cx4.setC4(value, off);
      return;
    }
    if (this.obc1 && (bank & 0x40) === 0 && off >= 0x6000 && off < 0x8000) {
      this.obc1.write(off, value);
      return;
    }
    if (this.srtc && (bank & 0x40) === 0 && (off === 0x2800 || off === 0x2801)) {
      this.srtc.write(off, value);
      return;
    }
    if (this.sa1) {
      if (sysBank <= 0x3f && off < 0x8000) {
        if (off < 0x2000) {
          this.wram[off] = value;
          return;
        }
        if (off >= 0x2180 && off <= 0x2183) return this.writeWmPort(off, value);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          this.onIoWrite?.(off, value);
          return;
        }
      }
      this.sa1.writeCpu(bank, off, value);
      return;
    }
    if (this.superfx) {
      if (sysBank <= 0x3f && off < 0x8000) {
        if (off < 0x2000) {
          this.wram[off] = value;
          return;
        }
        if (off >= 0x2180 && off <= 0x2183) return this.writeWmPort(off, value);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          this.onIoWrite?.(off, value);
          return;
        }
      }
      this.superfx.writeCpu(bank, off, value);
      return;
    }
    if (this.sdd1) {
      if ((bank & 0x40) === 0 && off < 0x8000) {
        if (off < 0x2000) {
          this.wram[off] = value;
          return;
        }
        if (off >= 0x2180 && off <= 0x2183) return this.writeWmPort(off, value);
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          // Snoop the DMA-register writes so the chip can recognise its own
          // compressed stream, then let the console apply them.
          if (off >= 0x4300 && off <= 0x437f) this.sdd1.snoopDma(off, value);
          this.onIoWrite?.(off, value);
          return;
        }
        if (off >= 0x4800 && off <= 0x480f) {
          this.sdd1.ioWrite(off, value);
          return;
        }
        return;
      }
      if (bank >= 0x70 && bank <= 0x7d && off < 0x8000 && this.sramMask) {
        this.sram[((bank - 0x70) * 0x8000 + off) & this.sramMask] = value;
      }
      return; // ROM writes ignored
    }
    if (sysBank <= 0x3f) {
      if (off < 0x2000) {
        this.wram[off] = value;
        return;
      }
      if (off < 0x8000) {
        if (off >= 0x2180 && off <= 0x2183) {
          this.writeWmPort(off, value);
          return;
        }
        if ((off >= 0x2100 && off <= 0x21ff) || (off >= 0x4000 && off <= 0x43ff)) {
          this.onIoWrite?.(off, value);
          return;
        }
        if (off >= 0x6000 && this.hirom && this.sramMask) {
          this.sram[((sysBank & 0x1f) * 0x2000 + (off - 0x6000)) & this.sramMask] = value;
        }
        return;
      }
      return; // ROM
    }

    if (!this.hirom && sysBank >= 0x70 && sysBank <= 0x7d && off < 0x8000 && this.sramMask) {
      this.sram[((sysBank - 0x70) * 0x8000 + off) & this.sramMask] = value;
    }
  }

  private readRom(bank: number, off: number): number {
    const v = this.readRomRaw(bank, off);
    return this.patchRomRead ? this.patchRomRead(((bank & 0x7f) << 16) | off, v) : v;
  }

  private readRomRaw(bank: number, off: number): number {
    const sysBank = bank & 0x7f;
    let index: number;
    if (this.exhirom) {
      // ExHiROM: A23 (bank bit 7) inverted picks the chip — banks $80-$FF
      // read the lower 4 MiB (where the vectors' JML targets live), $00-$7D
      // the upper chip (the real header/vectors at $40FFC0). A22 is
      // unconnected, so within a chip it addresses like HiROM and mirrors to
      // that chip's own size (a 40 Mbit cart is a 32 Mbit + 8 Mbit pair).
      const linear = ((sysBank & 0x3f) << 16) | off;
      return this.rom[bank & 0x80 ? linear % 0x400000 : 0x400000 + (linear % this.exUpperSize)]!;
    } else if (this.hirom) {
      // HiROM: banks $40-$7D map the image linearly; $00-$3F expose the
      // upper halves at $8000-$FFFF.
      index = sysBank >= 0x40 ? ((sysBank - 0x40) << 16) | off : (sysBank << 16) | off;
    } else if (this.extendedHighBanks && bank >= 0x80 && bank <= 0x9f) {
      // Memory-pak slot boards (BSC-1A5M family): $80-$9F carry the ROM
      // beyond 2 MiB instead of mirroring $00-$1F.
      index = (bank - 0x80 + 0x40) * 0x8000 + (off & 0x7fff);
    } else {
      // LoROM: 32 KiB pages; $8000-$FFFF of every bank, low halves of
      // $40-$7D mirror the same pages.
      index = sysBank * 0x8000 + (off & 0x7fff);
    }
    return this.rom[index % this.rom.length]!;
  }

  // WRAM data port: $2180 read/write auto-increments the 17-bit address at
  // $2181-$2183.
  private readWmPort(off: number): number {
    if (off === 0x2180) {
      const v = this.wram[this.wmadd]!;
      this.wmadd = (this.wmadd + 1) & 0x1ffff;
      return v;
    }
    return this.mdr;
  }

  private writeWmPort(off: number, value: number): void {
    switch (off) {
      case 0x2180:
        this.wram[this.wmadd] = value;
        this.wmadd = (this.wmadd + 1) & 0x1ffff;
        break;
      case 0x2181:
        this.wmadd = (this.wmadd & 0x1ff00) | value;
        break;
      case 0x2182:
        this.wmadd = (this.wmadd & 0x100ff) | (value << 8);
        break;
      case 0x2183:
        this.wmadd = (this.wmadd & 0x0ffff) | ((value & 1) << 16);
        break;
    }
  }
}
