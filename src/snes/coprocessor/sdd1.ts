/**
 * S-DD1 — graphics decompression coprocessor used by Star Ocean and
 * Street Fighter Alpha 2 (Zero 2). It sits on the ROM read path: four
 * configurable 1 MiB MMC bank registers map banks $C0-$FF, and when the
 * S-CPU runs a fixed-address DMA out of an S-DD1-enabled channel, the chip
 * decompresses the cart's graphics stream on the fly (one byte per read).
 *
 * The decompression algorithm is Andreas Naive's public-domain
 * reconstruction of the chip (a Golomb-coded, context-modelled binary
 * arithmetic scheme); the register/DMA interface follows fullsnes
 * "SNES Cart S-DD1". Ported from the established open-source reference.
 *
 * The decompressor state is transient (it only runs mid-DMA, and this
 * emulator completes DMA synchronously), so only the registers and the
 * per-channel DMA address/size latches are serialized.
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

// prettier-ignore
const RUN_COUNT = new Uint8Array([
  0x00, 0x00, 0x01, 0x00, 0x03, 0x01, 0x02, 0x00, 0x07, 0x03, 0x05, 0x01, 0x06, 0x02, 0x04, 0x00,
  0x0f, 0x07, 0x0b, 0x03, 0x0d, 0x05, 0x09, 0x01, 0x0e, 0x06, 0x0a, 0x02, 0x0c, 0x04, 0x08, 0x00,
  0x1f, 0x0f, 0x17, 0x07, 0x1b, 0x0b, 0x13, 0x03, 0x1d, 0x0d, 0x15, 0x05, 0x19, 0x09, 0x11, 0x01,
  0x1e, 0x0e, 0x16, 0x06, 0x1a, 0x0a, 0x12, 0x02, 0x1c, 0x0c, 0x14, 0x04, 0x18, 0x08, 0x10, 0x00,
  0x3f, 0x1f, 0x2f, 0x0f, 0x37, 0x17, 0x27, 0x07, 0x3b, 0x1b, 0x2b, 0x0b, 0x33, 0x13, 0x23, 0x03,
  0x3d, 0x1d, 0x2d, 0x0d, 0x35, 0x15, 0x25, 0x05, 0x39, 0x19, 0x29, 0x09, 0x31, 0x11, 0x21, 0x01,
  0x3e, 0x1e, 0x2e, 0x0e, 0x36, 0x16, 0x26, 0x06, 0x3a, 0x1a, 0x2a, 0x0a, 0x32, 0x12, 0x22, 0x02,
  0x3c, 0x1c, 0x2c, 0x0c, 0x34, 0x14, 0x24, 0x04, 0x38, 0x18, 0x28, 0x08, 0x30, 0x10, 0x20, 0x00,
  0x7f, 0x3f, 0x5f, 0x1f, 0x6f, 0x2f, 0x4f, 0x0f, 0x77, 0x37, 0x57, 0x17, 0x67, 0x27, 0x47, 0x07,
  0x7b, 0x3b, 0x5b, 0x1b, 0x6b, 0x2b, 0x4b, 0x0b, 0x73, 0x33, 0x53, 0x13, 0x63, 0x23, 0x43, 0x03,
  0x7d, 0x3d, 0x5d, 0x1d, 0x6d, 0x2d, 0x4d, 0x0d, 0x75, 0x35, 0x55, 0x15, 0x65, 0x25, 0x45, 0x05,
  0x79, 0x39, 0x59, 0x19, 0x69, 0x29, 0x49, 0x09, 0x71, 0x31, 0x51, 0x11, 0x61, 0x21, 0x41, 0x01,
  0x7e, 0x3e, 0x5e, 0x1e, 0x6e, 0x2e, 0x4e, 0x0e, 0x76, 0x36, 0x56, 0x16, 0x66, 0x26, 0x46, 0x06,
  0x7a, 0x3a, 0x5a, 0x1a, 0x6a, 0x2a, 0x4a, 0x0a, 0x72, 0x32, 0x52, 0x12, 0x62, 0x22, 0x42, 0x02,
  0x7c, 0x3c, 0x5c, 0x1c, 0x6c, 0x2c, 0x4c, 0x0c, 0x74, 0x34, 0x54, 0x14, 0x64, 0x24, 0x44, 0x04,
  0x78, 0x38, 0x58, 0x18, 0x68, 0x28, 0x48, 0x08, 0x70, 0x30, 0x50, 0x10, 0x60, 0x20, 0x40, 0x00
]);

// evolutionTable[33]: { codeNumber, nextIfMps, nextIfLps }
// prettier-ignore
const EVO_CODE = new Uint8Array([0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,5,5,6,6,7,7,0,1,2,3,4,5,6,7]);
// prettier-ignore
const EVO_MPS  = new Uint8Array([25,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,24,26,27,28,29,30,31,32,24]);
// prettier-ignore
const EVO_LPS  = new Uint8Array([25,1,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,1,2,4,8,12,16,18,22]);

export class Sdd1 {
  private readonly rom: Uint8Array;
  private readonly romMask: number;

  private r4800 = 0; // hard DMA enable
  private r4801 = 0; // soft DMA enable
  private r4804 = 0; // MMC bank 0
  private r4805 = 1; // MMC bank 1
  private r4806 = 2; // MMC bank 2
  private r4807 = 3; // MMC bank 3

  private readonly dmaAddr = new Uint32Array(8);
  private readonly dmaSize = new Uint16Array(8);
  private dmaReady = false;

  // ── decompressor state ──────────────────────────────────────────────
  // input manager
  private imOffset = 0;
  private imBitCount = 0;
  // bits generators (one per code number 0-7)
  private readonly bgMpsCount = new Uint8Array(8);
  private readonly bgLpsIndex = new Uint8Array(8);
  // probability estimation module
  private readonly pemStatus = new Uint8Array(32);
  private readonly pemMps = new Uint8Array(32);
  // context model
  private cmBitplanesInfo = 0;
  private cmContextBitsInfo = 0;
  private cmBitNumber = 0;
  private cmCurrentBitplane = 0;
  private readonly cmPrevBits = new Uint16Array(8);
  // output logic
  private olBitplanesInfo = 0;
  private olR0 = 0;
  private olR1 = 0;
  private olR2 = 0;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.romMask = rom.length - 1;
  }

  reset(): void {
    this.r4800 = 0;
    this.r4801 = 0;
    this.r4804 = 0;
    this.r4805 = 1;
    this.r4806 = 2;
    this.r4807 = 3;
    this.dmaAddr.fill(0);
    this.dmaSize.fill(0);
    this.dmaReady = false;
  }

  private romRead(index: number): number {
    return this.rom[index & this.romMask]!;
  }

  /** MMC-banked read for $C0-$FF:0000-FFFF and the decompressor's stream. */
  mmcRead(addr: number): number {
    const chunk = (addr >> 20) & 3;
    const bank = (chunk === 0 ? this.r4804 : chunk === 1 ? this.r4805 : chunk === 2 ? this.r4806 : this.r4807) & 0xf;
    return this.romRead((bank << 20) | (addr & 0xfffff));
  }

  // ── $4800-$480F registers ───────────────────────────────────────────

  ioRead(addr: number): number {
    switch (0x4800 | (addr & 0xf)) {
      case 0x4800:
        return this.r4800;
      case 0x4801:
        return this.r4801;
      case 0x4804:
        return this.r4804;
      case 0x4805:
        return this.r4805;
      case 0x4806:
        return this.r4806;
      case 0x4807:
        return this.r4807;
    }
    // $4802-4803,4808-480F fall through to ROM
    return this.romRead(0x4800 | (addr & 0xf));
  }

  ioWrite(addr: number, data: number): void {
    switch (0x4800 | (addr & 0xf)) {
      case 0x4800:
        this.r4800 = data;
        break;
      case 0x4801:
        this.r4801 = data;
        break;
      case 0x4804:
        this.r4804 = data & 0x8f;
        break;
      case 0x4805:
        this.r4805 = data & 0x8f;
        break;
      case 0x4806:
        this.r4806 = data & 0x8f;
        break;
      case 0x4807:
        this.r4807 = data & 0x8f;
        break;
    }
  }

  /** Snoop a $4300-$437F DMA-register write to latch the per-channel source
   *  address and transfer size (the chip needs them to know when a read is
   *  its own compressed stream). Call before the console applies the write. */
  snoopDma(off: number, data: number): void {
    const channel = (off >> 4) & 7;
    switch (off & 15) {
      case 2:
        this.dmaAddr[channel] = (this.dmaAddr[channel]! & 0xffff00) | data;
        break;
      case 3:
        this.dmaAddr[channel] = (this.dmaAddr[channel]! & 0xff00ff) | (data << 8);
        break;
      case 4:
        this.dmaAddr[channel] = (this.dmaAddr[channel]! & 0x00ffff) | (data << 16);
        break;
      case 5:
        this.dmaSize[channel] = (this.dmaSize[channel]! & 0xff00) | data;
        break;
      case 6:
        this.dmaSize[channel] = (this.dmaSize[channel]! & 0x00ff) | (data << 8);
        break;
    }
  }

  /** Cart-ROM read for $00-3F/$80-BF:8000-FFFF and $C0-FF:0000-FFFF. The
   *  `_data` open-bus fallback is accepted for interface parity but every
   *  path resolves to real ROM or a decompressed byte. */
  mcuRead(addr: number, _data: number): number {
    if ((addr & (1 << 22)) === 0) {
      // $00-3F/$80-BF:8000-FFFF — LoROM fold, with the $20-3F/$A0-BF
      // high-bank remap the MMC bank-1/3 bit-7 flags select.
      let a = addr;
      if ((a & (1 << 23)) === 0 && (a & (1 << 21)) !== 0 && (this.r4805 & 0x80) !== 0) a &= ~(1 << 21);
      if ((a & (1 << 23)) !== 0 && (a & (1 << 21)) !== 0 && (this.r4807 & 0x80) !== 0) a &= ~(1 << 21);
      a = ((a >> 1) & 0x1f8000) | (a & 0x7fff);
      return this.romRead(a);
    }

    // $C0-FF:0000-FFFF — decompression when a fixed-address DMA on an
    // S-DD1-enabled channel is streaming from this address.
    if ((this.r4800 & this.r4801) !== 0) {
      for (let n = 0; n < 8; n++) {
        if ((this.r4800 & (1 << n)) !== 0 && (this.r4801 & (1 << n)) !== 0 && addr === this.dmaAddr[n]) {
          if (!this.dmaReady) {
            this.decompressInit(addr);
            this.dmaReady = true;
          }
          const out = this.decompressRead();
          this.dmaSize[n] = (this.dmaSize[n]! - 1) & 0xffff;
          if (this.dmaSize[n] === 0) {
            this.dmaReady = false;
            this.r4801 &= ~(1 << n);
          }
          return out;
        }
      }
    }
    return this.mmcRead(addr);
  }

  // ── decompressor ────────────────────────────────────────────────────

  private decompressInit(offset: number): void {
    // input manager
    this.imOffset = offset;
    this.imBitCount = 4;
    // bits generators
    this.bgMpsCount.fill(0);
    this.bgLpsIndex.fill(0);
    // probability estimation
    this.pemStatus.fill(0);
    this.pemMps.fill(0);
    // context model
    this.cmBitplanesInfo = this.mmcRead(offset) & 0xc0;
    this.cmContextBitsInfo = this.mmcRead(offset) & 0x30;
    this.cmBitNumber = 0;
    this.cmPrevBits.fill(0);
    switch (this.cmBitplanesInfo) {
      case 0x00:
        this.cmCurrentBitplane = 1;
        break;
      case 0x40:
        this.cmCurrentBitplane = 7;
        break;
      case 0x80:
        this.cmCurrentBitplane = 3;
        break;
    }
    // output logic
    this.olBitplanesInfo = this.mmcRead(offset) & 0xc0;
    this.olR0 = 0x01;
  }

  private decompressRead(): number {
    return this.olDecompress();
  }

  private imGetCodeWord(codeLength: number): number {
    let codeWord = (this.mmcRead(this.imOffset) << this.imBitCount) & 0xff;
    this.imBitCount++;
    if (codeWord & 0x80) {
      codeWord = (codeWord | (this.mmcRead(this.imOffset + 1) >> (9 - this.imBitCount))) & 0xff;
      this.imBitCount += codeLength;
    }
    if (this.imBitCount & 0x08) {
      this.imOffset++;
      this.imBitCount &= 0x07;
    }
    return codeWord;
  }

  /** Golomb-code run-count decode into the given bits generator. */
  private gcdGetRunCount(n: number, codeNumber: number): void {
    const codeWord = this.imGetCodeWord(codeNumber);
    if (codeWord & 0x80) {
      this.bgLpsIndex[n] = 1;
      this.bgMpsCount[n] = RUN_COUNT[codeWord >> (codeNumber ^ 0x07)]!;
    } else {
      this.bgMpsCount[n] = (1 << codeNumber) & 0xff;
    }
  }

  /** Returns the decoded bit; sets this.bgEndOfRun as a side channel. */
  private bgEndOfRun = false;

  private bgGetBit(n: number): number {
    if (!(this.bgMpsCount[n] || this.bgLpsIndex[n])) this.gcdGetRunCount(n, n);
    let bit: number;
    if (this.bgMpsCount[n]) {
      bit = 0;
      this.bgMpsCount[n]--;
    } else {
      bit = 1;
      this.bgLpsIndex[n] = 0;
    }
    this.bgEndOfRun = !(this.bgMpsCount[n] || this.bgLpsIndex[n]);
    return bit;
  }

  private pemGetBit(context: number): number {
    const currentStatus = this.pemStatus[context]!;
    const currentMps = this.pemMps[context]!;
    const codeNumber = EVO_CODE[currentStatus]!;
    const bit = this.bgGetBit(codeNumber);
    if (this.bgEndOfRun) {
      if (bit) {
        if (!(currentStatus & 0xfe)) this.pemMps[context] = currentMps ^ 0x01;
        this.pemStatus[context] = EVO_LPS[currentStatus]!;
      } else {
        this.pemStatus[context] = EVO_MPS[currentStatus]!;
      }
    }
    return bit ^ currentMps;
  }

  private cmGetBit(): number {
    switch (this.cmBitplanesInfo) {
      case 0x00:
        this.cmCurrentBitplane ^= 0x01;
        break;
      case 0x40:
        this.cmCurrentBitplane ^= 0x01;
        if (!(this.cmBitNumber & 0x7f)) this.cmCurrentBitplane = (this.cmCurrentBitplane + 2) & 0x07;
        break;
      case 0x80:
        this.cmCurrentBitplane ^= 0x01;
        if (!(this.cmBitNumber & 0x7f)) this.cmCurrentBitplane ^= 0x02;
        break;
      case 0xc0:
        this.cmCurrentBitplane = this.cmBitNumber & 0x07;
        break;
    }

    const contextBits = this.cmPrevBits[this.cmCurrentBitplane]!;
    let currentContext = (this.cmCurrentBitplane & 0x01) << 4;
    switch (this.cmContextBitsInfo) {
      case 0x00:
        currentContext |= ((contextBits & 0x01c0) >> 5) | (contextBits & 0x0001);
        break;
      case 0x10:
        currentContext |= ((contextBits & 0x0180) >> 5) | (contextBits & 0x0001);
        break;
      case 0x20:
        currentContext |= ((contextBits & 0x00c0) >> 5) | (contextBits & 0x0001);
        break;
      case 0x30:
        currentContext |= ((contextBits & 0x0180) >> 5) | (contextBits & 0x0003);
        break;
    }

    const bit = this.pemGetBit(currentContext);
    this.cmPrevBits[this.cmCurrentBitplane] = ((contextBits << 1) | bit) & 0xffff;
    this.cmBitNumber++;
    return bit;
  }

  private olDecompress(): number {
    switch (this.olBitplanesInfo) {
      case 0x00:
      case 0x40:
      case 0x80:
        if (this.olR0 === 0) {
          this.olR0 = ~this.olR0 & 0xff;
          return this.olR2;
        }
        this.olR1 = 0;
        this.olR2 = 0;
        for (this.olR0 = 0x80; this.olR0; this.olR0 >>= 1) {
          if (this.cmGetBit()) this.olR1 |= this.olR0;
          if (this.cmGetBit()) this.olR2 |= this.olR0;
        }
        return this.olR1;
      case 0xc0:
        this.olR1 = 0;
        for (this.olR0 = 0x01; this.olR0; this.olR0 = (this.olR0 << 1) & 0xff) {
          if (this.cmGetBit()) this.olR1 |= this.olR0;
        }
        return this.olR1;
    }
    return 0;
  }

  // ── persistence (registers + DMA latches only; decompressor is transient) ─

  serialize(w: SnesStateWriter): void {
    w.u8(this.r4800);
    w.u8(this.r4801);
    w.u8(this.r4804);
    w.u8(this.r4805);
    w.u8(this.r4806);
    w.u8(this.r4807);
    for (let i = 0; i < 8; i++) w.u32(this.dmaAddr[i]!);
    for (let i = 0; i < 8; i++) w.u16(this.dmaSize[i]!);
    w.bool(this.dmaReady);
  }

  deserialize(r: SnesStateReader): void {
    this.r4800 = r.u8();
    this.r4801 = r.u8();
    this.r4804 = r.u8();
    this.r4805 = r.u8();
    this.r4806 = r.u8();
    this.r4807 = r.u8();
    for (let i = 0; i < 8; i++) this.dmaAddr[i] = r.u32();
    for (let i = 0; i < 8; i++) this.dmaSize[i] = r.u16();
    this.dmaReady = r.bool();
  }
}
