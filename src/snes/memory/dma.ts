/**
 * SNES DMA — 8 channels moving data between the A bus (CPU address space)
 * and the B bus (the $21xx MMIO page), configured at $43x0-$43xB per
 * channel and fired by MDMAEN ($420B). Each byte costs 8 master-clock
 * cycles; the CPU is stalled for the duration.
 *
 * The transfer-unit mode picks how consecutive bytes spread across B-bus
 * registers (e.g. mode 1 alternates $2118/$2119 for VRAM words). HDMA
 * (per-scanline table-driven transfers, $420C) shares this register file
 * and lands with the PPU's scanline machinery.
 *
 * Reference: fullsnes "SNES DMA and HDMA".
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";
import type { SnesBus } from "./bus.js";

/** B-bus register offset pattern per transfer-unit mode. */
const UNIT_PATTERNS: readonly (readonly number[])[] = [
  [0],
  [0, 1],
  [0, 0],
  [0, 0, 1, 1],
  [0, 1, 2, 3],
  [0, 1, 0, 1],
  [0, 0],
  [0, 0, 1, 1]
];

class DmaChannel {
  // HDMA runtime state
  hdmaActive = false;
  hdmaDoTransfer = false;
  hdmaFinished = false;

  /** DMAP $43x0: transfer mode, A-step, indirect (HDMA), direction. */
  control = 0xff;
  /** BBAD $43x1: B-bus register ($21xx low byte). */
  bAddr = 0xff;
  /** A1T $43x2-$43x4: A-bus start address (bank latched separately). */
  aAddr = 0xffff;
  aBank = 0xff;
  /** DAS $43x5-$43x6: byte count for general DMA (0 = 65536). */
  size = 0xffff;
  /** DASB $43x7: HDMA indirect bank. */
  indirectBank = 0xff;
  /** A2A $43x8-$43x9, NTRL $43xA: HDMA table state. */
  tableAddr = 0xffff;
  lineCounter = 0xff;
  /** $43xB/$43xF: spare byte, read/write. */
  unused = 0xff;
}

const CHANNEL_FIELDS = [
  "control",
  "bAddr",
  "aAddr",
  "aBank",
  "size",
  "indirectBank",
  "tableAddr",
  "lineCounter",
  "unused"
] as const;

export class SnesDma {
  private readonly channels: DmaChannel[] = Array.from({ length: 8 }, () => new DmaChannel());

  /** Master cycles consumed by the last MDMAEN run (CPU stall time). */
  lastRunMasterCycles = 0;

  constructor(private readonly bus: SnesBus) {}

  serialize(w: SnesStateWriter): void {
    for (const ch of this.channels) {
      for (const f of CHANNEL_FIELDS) w.u16(ch[f]);
      w.bool(ch.hdmaActive);
      w.bool(ch.hdmaDoTransfer);
      w.bool(ch.hdmaFinished);
    }
    w.u8(this.hdmaEnabled);
  }

  deserialize(r: SnesStateReader): void {
    for (const ch of this.channels) {
      for (const f of CHANNEL_FIELDS) ch[f] = r.u16();
      ch.hdmaActive = r.bool();
      ch.hdmaDoTransfer = r.bool();
      ch.hdmaFinished = r.bool();
    }
    this.hdmaEnabled = r.u8();
  }

  /** $43x0-$43xF reads. Returns null (open bus) for the unmapped slots. */
  readReg(addr: number): number | null {
    const ch = this.channels[(addr >> 4) & 7]!;
    switch (addr & 0xf) {
      case 0x0:
        return ch.control;
      case 0x1:
        return ch.bAddr;
      case 0x2:
        return ch.aAddr & 0xff;
      case 0x3:
        return ch.aAddr >> 8;
      case 0x4:
        return ch.aBank;
      case 0x5:
        return ch.size & 0xff;
      case 0x6:
        return ch.size >> 8;
      case 0x7:
        return ch.indirectBank;
      case 0x8:
        return ch.tableAddr & 0xff;
      case 0x9:
        return ch.tableAddr >> 8;
      case 0xa:
        return ch.lineCounter;
      case 0xb:
      case 0xf:
        return ch.unused;
      default:
        return null;
    }
  }

  writeReg(addr: number, v: number): void {
    const ch = this.channels[(addr >> 4) & 7]!;
    switch (addr & 0xf) {
      case 0x0:
        ch.control = v;
        break;
      case 0x1:
        ch.bAddr = v;
        break;
      case 0x2:
        ch.aAddr = (ch.aAddr & 0xff00) | v;
        break;
      case 0x3:
        ch.aAddr = (ch.aAddr & 0x00ff) | (v << 8);
        break;
      case 0x4:
        ch.aBank = v;
        break;
      case 0x5:
        ch.size = (ch.size & 0xff00) | v;
        break;
      case 0x6:
        ch.size = (ch.size & 0x00ff) | (v << 8);
        break;
      case 0x7:
        ch.indirectBank = v;
        break;
      case 0x8:
        ch.tableAddr = (ch.tableAddr & 0xff00) | v;
        break;
      case 0x9:
        ch.tableAddr = (ch.tableAddr & 0x00ff) | (v << 8);
        break;
      case 0xa:
        ch.lineCounter = v;
        break;
      case 0xb:
      case 0xf:
        ch.unused = v;
        break;
    }
  }

  /** HDMAEN ($420C) latch — which channels run per-scanline this frame. */
  hdmaEnabled = 0;

  /** Frame start: (re)load every enabled channel's table state and perform
   *  the first entry's setup + transfer. */
  hdmaInit(): void {
    for (let i = 0; i < 8; i++) {
      const ch = this.channels[i]!;
      ch.hdmaActive = (this.hdmaEnabled & (1 << i)) !== 0;
      ch.hdmaFinished = false;
      ch.hdmaDoTransfer = false;
      if (!ch.hdmaActive) continue;
      ch.tableAddr = ch.aAddr;
      this.hdmaReloadEntry(ch);
    }
  }

  /** Per-scanline HDMA step (start of each visible line). */
  hdmaRun(): void {
    for (let i = 0; i < 8; i++) {
      const ch = this.channels[i]!;
      if (!ch.hdmaActive || ch.hdmaFinished) continue;
      if (ch.hdmaDoTransfer) this.hdmaTransferUnit(ch);
      ch.lineCounter = (ch.lineCounter - 1) & 0xff;
      if ((ch.lineCounter & 0x7f) === 0) {
        this.hdmaReloadEntry(ch);
      } else {
        ch.hdmaDoTransfer = (ch.lineCounter & 0x80) !== 0;
      }
    }
  }

  /** Read the next table entry: line count byte (0 terminates the channel;
   *  bit 7 = transfer-every-line), plus the indirect pointer if configured. */
  private hdmaReloadEntry(ch: DmaChannel): void {
    ch.lineCounter = this.bus.read((ch.aBank << 16) | ch.tableAddr);
    ch.tableAddr = (ch.tableAddr + 1) & 0xffff;
    if (ch.lineCounter === 0) {
      ch.hdmaFinished = true;
      ch.hdmaDoTransfer = false;
      return;
    }
    if ((ch.control & 0x40) !== 0) {
      const lo = this.bus.read((ch.aBank << 16) | ch.tableAddr);
      ch.tableAddr = (ch.tableAddr + 1) & 0xffff;
      const hi = this.bus.read((ch.aBank << 16) | ch.tableAddr);
      ch.tableAddr = (ch.tableAddr + 1) & 0xffff;
      ch.size = lo | (hi << 8); // indirect address lives in DAS
    }
    ch.hdmaDoTransfer = true;
  }

  /** Move one transfer unit (1/2/4 bytes per the DMAP mode). */
  private hdmaTransferUnit(ch: DmaChannel): void {
    const pattern = UNIT_PATTERNS[ch.control & 7]!;
    const bToA = (ch.control & 0x80) !== 0;
    const indirect = (ch.control & 0x40) !== 0;
    for (let u = 0; u < pattern.length; u++) {
      const bBus = 0x2100 | ((ch.bAddr + pattern[u]!) & 0xff);
      let aBus: number;
      if (indirect) {
        aBus = (ch.indirectBank << 16) | ch.size;
        ch.size = (ch.size + 1) & 0xffff;
      } else {
        aBus = (ch.aBank << 16) | ch.tableAddr;
        ch.tableAddr = (ch.tableAddr + 1) & 0xffff;
      }
      if (bToA) this.bus.write(aBus, this.bus.read(bBus));
      else this.bus.write(bBus, this.bus.read(aBus));
    }
  }

  private running = false;

  /** MDMAEN ($420B): run general DMA on the set channels, lowest first. A
   *  transfer whose A-bus range covers $420B must not retrigger recursively
   *  (the write lands, but the nested start is ignored). */
  run(mask: number): void {
    if (this.running) return;
    this.running = true;
    try {
      this.runAll(mask);
    } finally {
      this.running = false;
    }
  }

  private runAll(mask: number): void {
    this.lastRunMasterCycles = mask !== 0 ? 12 + 12 : 0; // setup overhead
    for (let i = 0; i < 8; i++) {
      if ((mask & (1 << i)) === 0) continue;
      this.lastRunMasterCycles += 8; // per-channel overhead
      this.runChannel(this.channels[i]!);
    }
  }

  private runChannel(ch: DmaChannel): void {
    const pattern = UNIT_PATTERNS[ch.control & 7]!;
    const bToA = (ch.control & 0x80) !== 0;
    // A-address step: 0 = increment, 2 = decrement, 1/3 = fixed.
    const step = (ch.control & 0x08) !== 0 ? 0 : (ch.control & 0x10) !== 0 ? -1 : 1;

    let count = ch.size === 0 ? 0x10000 : ch.size;
    let unitIndex = 0;
    while (count > 0) {
      const bBus = 0x2100 | ((ch.bAddr + pattern[unitIndex % pattern.length]!) & 0xff);
      const aBus = (ch.aBank << 16) | ch.aAddr;
      if (bToA) this.bus.write(aBus, this.bus.read(bBus));
      else this.bus.write(bBus, this.bus.read(aBus));
      ch.aAddr = (ch.aAddr + step) & 0xffff;
      unitIndex++;
      count--;
      this.lastRunMasterCycles += 8;
    }
    ch.size = 0;
  }
}
