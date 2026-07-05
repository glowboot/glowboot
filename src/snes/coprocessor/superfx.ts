/**
 * SuperFX (GSU-1/GSU-2) — the in-cart RISC coprocessor behind Star Fox,
 * Yoshi's Island, Doom, Stunt Race FX and ~40 other carts. A custom CPU
 * with sixteen 16-bit registers, prefix-modified opcodes (ALT1/ALT2 and
 * the TO/FROM/WITH register plumbing), a 512-byte instruction cache, and
 * a bitplane plot pipeline (pixel caches + PLOT/RPIX/COLOR/CMODE) that
 * renders polygons directly into game-pak RAM as SNES character data.
 *
 * Ported from the established open-source reference implementation of
 * the chip (interface documented in fullsnes "SNES Cart GSU"). Timing
 * follows the reference: costs are expressed in 21.4 MHz GSU clocks
 * (≈ SNES master cycles); at CLSR=0 the chip runs at half speed so
 * every cost doubles. Cache hits cost 1 clock, memory fetches 5, and
 * the ROM/RAM buffers complete asynchronously via countdown timers.
 *
 * The S-CPU sees the GSU register file at $3000-$301F, control at
 * $3030-$303F, the cache window at $3100-$32FF — and, while the GSU
 * owns the ROM (GO+RON), every cart-ROM read returns a fixed 16-byte
 * vector stub so console interrupts stay serviceable.
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

const FLAG_Z = 0x0002;
const FLAG_CY = 0x0004;
const FLAG_S = 0x0008;
const FLAG_OV = 0x0010;
const FLAG_G = 0x0020;
const FLAG_R = 0x0040;
const FLAG_ALT1 = 0x0100;
const FLAG_ALT2 = 0x0200;
const FLAG_B = 0x1000;
const FLAG_IRQ = 0x8000;

/** S-CPU cart-ROM reads while the GSU owns the bus return this stub
 *  (NMI/IRQ vectors pointing at a tight loop). */
// prettier-ignore
const GSU_VECTOR_STUB = [
  0x00, 0x01, 0x00, 0x01, 0x04, 0x01, 0x00, 0x01,
  0x00, 0x01, 0x08, 0x01, 0x00, 0x01, 0x0c, 0x01
];

export class SuperFx {
  private readonly rom: Uint8Array;
  private readonly romMask: number;
  private readonly ram: Uint8Array;
  private readonly ramMask: number;

  private readonly r = new Uint16Array(16);
  private r14Modified = false;
  private r15Modified = false;
  private sfr = 0;
  private pbr = 0;
  private rombr = 0;
  private rambr = 0;
  private cbr = 0;
  private scbr = 0;
  private colr = 0;
  private bramr = 0;
  private readonly vcr = 0x04;
  private clsr = 0;
  private pipeline = 0x01; // nop
  private ramaddr = 0;
  private sreg = 0;
  private dreg = 0;

  // SCMR ($303A)
  private scmrHt = 0;
  private scmrRon = false;
  private scmrRan = false;
  private scmrMd = 0;

  // POR (plot options)
  private porObj = false;
  private porFreezehigh = false;
  private porHighnibble = false;
  private porDither = false;
  private porTransparent = false;

  // CFGR ($3037)
  private cfgrIrq = false;
  private cfgrMs0 = false;

  // ROM / RAM buffers (asynchronous, countdown in GSU clocks)
  private romcl = 0;
  private romdr = 0;
  private ramcl = 0;
  private ramar = 0;
  private ramdr = 0;

  // instruction cache
  private readonly cacheBuffer = new Uint8Array(512);
  private readonly cacheValid = new Uint8Array(32);

  // pixel caches (primary + secondary)
  private readonly pcOffset = new Int32Array([-1, -1]);
  private readonly pcBitpend = new Uint8Array(2);
  private readonly pcData = [new Uint8Array(8), new Uint8Array(8)];

  /** Absolute master cycle the GSU has advanced to. The GSU runs at one
   *  clock per master cycle (the CLSR speed difference is already baked
   *  into the per-operation step costs, as on hardware). Kept in lockstep
   *  with the S-CPU's cycle counter so the chip can be caught up to the
   *  exact cycle of any shared-resource access. */
  private clock = 0;

  /** Returns the S-CPU's current master cycle. Wired by the console so a
   *  register/RAM access can catch the GSU up to "now" before it reads or
   *  writes (cycle-accurate GSU↔S-CPU interleaving). Null in unit tests,
   *  which drive the clock directly through {@link tick}. */
  hostClock: (() => number) | null = null;

  onSnesIrq: (() => void) | null = null;

  constructor(rom: Uint8Array, ram: Uint8Array) {
    this.rom = rom;
    this.romMask = rom.length - 1;
    this.ram = ram;
    this.ramMask = ram.length > 0 ? ram.length - 1 : 0;
    this.reset();
  }

  reset(): void {
    this.r.fill(0);
    this.r14Modified = false;
    this.r15Modified = false;
    this.sfr = 0;
    this.pbr = 0;
    this.rombr = 0;
    this.rambr = 0;
    this.cbr = 0;
    this.scbr = 0;
    this.colr = 0;
    this.bramr = 0;
    this.clsr = 0;
    this.pipeline = 0x01;
    this.ramaddr = 0;
    this.sreg = 0;
    this.dreg = 0;
    this.scmrHt = 0;
    this.scmrRon = false;
    this.scmrRan = false;
    this.scmrMd = 0;
    this.porObj = this.porFreezehigh = this.porHighnibble = false;
    this.porDither = this.porTransparent = false;
    this.cfgrIrq = this.cfgrMs0 = false;
    this.romcl = 0;
    this.romdr = 0;
    this.ramcl = 0;
    this.ramar = 0;
    this.ramdr = 0;
    this.cacheBuffer.fill(0);
    this.cacheValid.fill(0);
    this.pcOffset[0] = this.pcOffset[1] = -1;
    this.pcBitpend.fill(0);
    this.pcData[0]!.fill(0);
    this.pcData[1]!.fill(0);
    this.clock = 0;
  }

  /** SNES IRQ line: raised by STOP (unless masked), dropped by reading
   *  the SFR high byte. */
  snesIrqAsserted(): boolean {
    return (this.sfr & FLAG_IRQ) !== 0;
  }

  private get going(): boolean {
    return (this.sfr & FLAG_G) !== 0;
  }

  /** Advance the GSU up to master cycle `target`. Runs whole GSU
   *  instructions while the chip is going and still behind; when idle it
   *  services any pending ROM/RAM buffer, then jumps the clock forward
   *  (idle time carries no work). A single instruction may overshoot
   *  `target` by its own length — the chip is then at most one instruction
   *  ahead, and the next catch-up returns immediately until the S-CPU
   *  reaches it. */
  catchUp(target: number): void {
    while (this.clock < target) {
      if (!this.going) {
        if (this.romcl > 0 || this.ramcl > 0) {
          this.step(Math.min(target - this.clock, Math.max(this.romcl, this.ramcl)));
          continue;
        }
        this.clock = target;
        return;
      }
      this.runInstruction();
    }
  }

  /** Test entry point: advance the GSU by `masterDelta` clocks. The console
   *  drives the chip through {@link catchUp} against the S-CPU clock. */
  tick(masterDelta: number): void {
    this.catchUp(this.clock + masterDelta);
  }

  private runInstruction(): void {
    // The GSU may fall behind by a full instruction and never advance the
    // clock (a plain register op with a cache hit still costs ≥1); floor
    // the cost so catch-up always makes progress.
    const before = this.clock;
    this.instruction(this.peekpipe());
    if (this.r14Modified) {
      this.r14Modified = false;
      this.updateRomBuffer();
    }
    if (this.r15Modified) {
      this.r15Modified = false;
    } else {
      this.r[15] = (this.r[15]! + 1) & 0xffff;
    }
    if (this.clock === before) this.clock++;
  }

  private setR(n: number, value: number): void {
    this.r[n] = value & 0xffff;
    if (n === 14) this.r14Modified = true;
    if (n === 15) this.r15Modified = true;
  }

  private get srVal(): number {
    return this.r[this.sreg]!;
  }

  private setDr(value: number): void {
    this.setR(this.dreg, value);
  }

  private get drVal(): number {
    return this.r[this.dreg]!;
  }

  private regReset(): void {
    this.sfr &= ~(FLAG_B | FLAG_ALT1 | FLAG_ALT2);
    this.sreg = 0;
    this.dreg = 0;
  }

  private setFlag(flag: number, on: boolean | number): void {
    if (on) this.sfr |= flag;
    else this.sfr &= ~flag;
  }

  private get alt1(): boolean {
    return (this.sfr & FLAG_ALT1) !== 0;
  }

  private get alt2(): boolean {
    return (this.sfr & FLAG_ALT2) !== 0;
  }

  // ── clocks + buffers ───────────────────────────────────────────────

  private step(clocks: number): void {
    if (this.romcl > 0) {
      this.romcl -= Math.min(clocks, this.romcl);
      if (this.romcl === 0) {
        this.sfr &= ~FLAG_R;
        this.romdr = this.gsuRead((this.rombr << 16) + this.r[14]!);
      }
    }
    if (this.ramcl > 0) {
      this.ramcl -= Math.min(clocks, this.ramcl);
      if (this.ramcl === 0) {
        this.gsuWrite(0x700000 + (this.rambr << 16) + this.ramar, this.ramdr);
      }
    }
    this.clock += clocks;
  }

  private syncRomBuffer(): void {
    if (this.romcl > 0) this.step(this.romcl);
  }

  private readRomBuffer(): number {
    this.syncRomBuffer();
    return this.romdr;
  }

  private updateRomBuffer(): void {
    this.sfr |= FLAG_R;
    this.romcl = this.clsr ? 5 : 6;
  }

  private syncRamBuffer(): void {
    if (this.ramcl > 0) this.step(this.ramcl);
  }

  private readRamBuffer(addr: number): number {
    this.syncRamBuffer();
    return this.gsuRead(0x700000 + (this.rambr << 16) + (addr & 0xffff));
  }

  private writeRamBuffer(addr: number, data: number): void {
    this.syncRamBuffer();
    this.ramcl = this.clsr ? 5 : 6;
    this.ramar = addr & 0xffff;
    this.ramdr = data & 0xff;
  }

  // ── GSU-side memory ────────────────────────────────────────────────

  private gsuRead(addr: number): number {
    addr &= 0xffffff;
    if ((addr & 0xc00000) === 0x000000) {
      // $00-3F: 32 KiB pages fold to the LoROM image layout
      return this.rom[(((addr & 0x3f0000) >> 1) | (addr & 0x7fff)) & this.romMask]!;
    }
    if ((addr & 0xe00000) === 0x400000) {
      return this.rom[addr & this.romMask]!; // $40-5F linear
    }
    if ((addr & 0xe00000) === 0x600000) {
      if (this.ramMask === 0) return 0;
      return this.ram[addr & this.ramMask]!; // $60-7F RAM
    }
    return 0;
  }

  private gsuWrite(addr: number, data: number): void {
    addr &= 0xffffff;
    if ((addr & 0xe00000) === 0x600000 && this.ramMask !== 0) {
      this.ram[addr & this.ramMask] = data & 0xff;
    }
  }

  // ── instruction fetch (cache + pipeline) ───────────────────────────

  private readOpcode(addr: number): number {
    const offset = (addr - this.cbr) & 0xffff;
    if (offset < 512) {
      if (!this.cacheValid[offset >> 4]) {
        let dp = offset & 0xfff0;
        let sp = (this.pbr << 16) + ((this.cbr + dp) & 0xfff0);
        for (let n = 0; n < 16; n++) {
          this.step(this.clsr ? 5 : 6);
          this.cacheBuffer[dp++] = this.gsuRead(sp++);
        }
        this.cacheValid[offset >> 4] = 1;
      } else {
        this.step(this.clsr ? 1 : 2);
      }
      return this.cacheBuffer[offset]!;
    }
    if (this.pbr <= 0x5f) this.syncRomBuffer();
    else this.syncRamBuffer();
    this.step(this.clsr ? 5 : 6);
    return this.gsuRead((this.pbr << 16) | addr);
  }

  private peekpipe(): number {
    const result = this.pipeline;
    this.pipeline = this.readOpcode(this.r[15]!);
    this.r15Modified = false;
    return result;
  }

  private pipe(): number {
    const result = this.pipeline;
    this.r[15] = (this.r[15]! + 1) & 0xffff;
    this.pipeline = this.readOpcode(this.r[15]!);
    this.r15Modified = false;
    return result;
  }

  private flushCache(): void {
    this.cacheValid.fill(0);
  }

  private readCache(addr: number): number {
    return this.cacheBuffer[(addr + this.cbr) & 511]!;
  }

  private writeCache(addr: number, data: number): void {
    const a = (addr + this.cbr) & 511;
    this.cacheBuffer[a] = data;
    if ((a & 15) === 15) this.cacheValid[a >> 4] = 1;
  }

  // ── plot pipeline ──────────────────────────────────────────────────

  private colorOp(source: number): number {
    if (this.porHighnibble) return (this.colr & 0xf0) | (source >> 4);
    if (this.porFreezehigh) return (this.colr & 0xf0) | (source & 0x0f);
    return source & 0xff;
  }

  private bppOf(): number {
    return 2 << (this.scmrMd - (this.scmrMd >> 1)); // md 0-3 → 2,4,4,8
  }

  private charNumber(x: number, y: number): number {
    switch (this.porObj ? 3 : this.scmrHt) {
      case 0:
        return ((x & 0xf8) << 1) + ((y & 0xf8) >> 3);
      case 1:
        return ((x & 0xf8) << 1) + ((x & 0xf8) >> 1) + ((y & 0xf8) >> 3);
      case 2:
        return ((x & 0xf8) << 1) + ((x & 0xf8) << 0) + ((y & 0xf8) >> 3);
      default:
        return ((y & 0x80) << 2) + ((x & 0x80) << 1) + ((y & 0x78) << 1) + ((x & 0x78) >> 3);
    }
  }

  private plot(x: number, y: number): void {
    x &= 0xff;
    y &= 0xff;
    if (!this.porTransparent) {
      if (this.scmrMd === 3) {
        if (this.porFreezehigh) {
          if ((this.colr & 0x0f) === 0) return;
        } else {
          if (this.colr === 0) return;
        }
      } else {
        if ((this.colr & 0x0f) === 0) return;
      }
    }
    let color = this.colr;
    if (this.porDither && this.scmrMd !== 3) {
      if ((x ^ y) & 1) color >>= 4;
      color &= 0x0f;
    }
    const offset = ((y << 5) + (x >> 3)) & 0xffff;
    if (offset !== this.pcOffset[0]) {
      this.flushPixelCache(1);
      this.copyPixelCache(1, 0);
      this.pcBitpend[0] = 0;
      this.pcOffset[0] = offset;
    }
    const px = (x & 7) ^ 7;
    this.pcData[0]![px] = color;
    this.pcBitpend[0] = this.pcBitpend[0]! | (1 << px);
    if (this.pcBitpend[0] === 0xff) {
      this.flushPixelCache(1);
      this.copyPixelCache(1, 0);
      this.pcBitpend[0] = 0;
    }
  }

  private copyPixelCache(dst: number, src: number): void {
    this.pcOffset[dst] = this.pcOffset[src]!;
    this.pcBitpend[dst] = this.pcBitpend[src]!;
    this.pcData[dst]!.set(this.pcData[src]!);
  }

  private rpix(x: number, y: number): number {
    x &= 0xff;
    y &= 0xff;
    this.flushPixelCache(1);
    this.flushPixelCache(0);
    const cn = this.charNumber(x, y);
    const bpp = this.bppOf();
    const addr = 0x700000 + cn * (bpp << 3) + (this.scbr << 10) + (y & 7) * 2;
    let data = 0;
    const px = (x & 7) ^ 7;
    for (let n = 0; n < bpp; n++) {
      const byte = ((n >> 1) << 4) + (n & 1);
      this.step(this.clsr ? 5 : 6);
      data |= ((this.gsuRead(addr + byte) >> px) & 1) << n;
    }
    return data;
  }

  private flushPixelCache(index: number): void {
    const bitpend = this.pcBitpend[index]!;
    if (bitpend === 0) return;
    const offset = this.pcOffset[index]!;
    const x = (offset << 3) & 0xff;
    const y = (offset >> 5) & 0xff;
    const cn = this.charNumber(x, y);
    const bpp = this.bppOf();
    const addr = 0x700000 + cn * (bpp << 3) + (this.scbr << 10) + (y & 7) * 2;
    const cache = this.pcData[index]!;
    for (let n = 0; n < bpp; n++) {
      const byte = ((n >> 1) << 4) + (n & 1);
      let data = 0;
      for (let px = 0; px < 8; px++) data |= ((cache[px]! >> n) & 1) << px;
      if (bitpend !== 0xff) {
        this.step(this.clsr ? 5 : 6);
        data &= bitpend;
        data |= this.gsuRead(addr + byte) & ~bitpend;
      }
      this.step(this.clsr ? 5 : 6);
      this.gsuWrite(addr + byte, data);
    }
    this.pcBitpend[index] = 0;
  }

  // ── instruction set ────────────────────────────────────────────────

  private setSZ(v: number): void {
    this.setFlag(FLAG_S, v & 0x8000);
    this.setFlag(FLAG_Z, (v & 0xffff) === 0);
  }

  // prettier-ignore
  private instruction(op: number): void {
    switch (op) {
      case 0x00: { // stop
        if (!this.cfgrIrq) {
          this.sfr |= FLAG_IRQ;
          this.onSnesIrq?.();
        }
        this.sfr &= ~FLAG_G;
        this.pipeline = 0x01;
        this.regReset();
        break;
      }
      case 0x01: this.regReset(); break; // nop
      case 0x02: { // cache
        if (this.cbr !== (this.r[15]! & 0xfff0)) {
          this.cbr = this.r[15]! & 0xfff0;
          this.flushCache();
        }
        this.regReset();
        break;
      }
      case 0x03: { // lsr
        this.setFlag(FLAG_CY, this.srVal & 1);
        this.setDr(this.srVal >> 1);
        this.setSZ(this.drVal);
        this.regReset();
        break;
      }
      case 0x04: { // rol
        const carry = (this.srVal & 0x8000) !== 0;
        this.setDr((this.srVal << 1) | ((this.sfr & FLAG_CY) !== 0 ? 1 : 0));
        this.setFlag(FLAG_S, this.drVal & 0x8000);
        this.setFlag(FLAG_CY, carry);
        this.setFlag(FLAG_Z, this.drVal === 0);
        this.regReset();
        break;
      }
      case 0x05: this.branch(true); break;
      case 0x06: this.branch((((this.sfr & FLAG_S) !== 0 ? 1 : 0) ^ ((this.sfr & FLAG_OV) !== 0 ? 1 : 0)) === 0); break;
      case 0x07: this.branch((((this.sfr & FLAG_S) !== 0 ? 1 : 0) ^ ((this.sfr & FLAG_OV) !== 0 ? 1 : 0)) === 1); break;
      case 0x08: this.branch((this.sfr & FLAG_Z) === 0); break;
      case 0x09: this.branch((this.sfr & FLAG_Z) !== 0); break;
      case 0x0a: this.branch((this.sfr & FLAG_S) === 0); break;
      case 0x0b: this.branch((this.sfr & FLAG_S) !== 0); break;
      case 0x0c: this.branch((this.sfr & FLAG_CY) === 0); break;
      case 0x0d: this.branch((this.sfr & FLAG_CY) !== 0); break;
      case 0x0e: this.branch((this.sfr & FLAG_OV) === 0); break;
      case 0x0f: this.branch((this.sfr & FLAG_OV) !== 0); break;
      default:
        if (op < 0x20) { // to/move
          const n = op & 15;
          if ((this.sfr & FLAG_B) === 0) {
            this.dreg = n;
          } else {
            this.setR(n, this.srVal);
            this.regReset();
          }
        } else if (op < 0x30) { // with
          const n = op & 15;
          this.sreg = n;
          this.dreg = n;
          this.sfr |= FLAG_B;
        } else if (op < 0x3c) { // stw/stb
          const n = op & 15;
          this.ramaddr = this.r[n]!;
          this.writeRamBuffer(this.ramaddr, this.srVal & 0xff);
          if (!this.alt1) this.writeRamBuffer(this.ramaddr ^ 1, this.srVal >> 8);
          this.regReset();
        } else if (op === 0x3c) { // loop
          this.r[12] = (this.r[12]! - 1) & 0xffff;
          this.setFlag(FLAG_S, this.r[12]! & 0x8000);
          this.setFlag(FLAG_Z, this.r[12] === 0);
          if ((this.sfr & FLAG_Z) === 0) this.setR(15, this.r[13]!);
          this.regReset();
        } else if (op === 0x3d) { // alt1
          this.sfr &= ~FLAG_B;
          this.sfr |= FLAG_ALT1;
        } else if (op === 0x3e) { // alt2
          this.sfr &= ~FLAG_B;
          this.sfr |= FLAG_ALT2;
        } else if (op === 0x3f) { // alt3
          this.sfr &= ~FLAG_B;
          this.sfr |= FLAG_ALT1 | FLAG_ALT2;
        } else if (op < 0x4c) { // ldw/ldb
          const n = op & 15;
          this.ramaddr = this.r[n]!;
          let v = this.readRamBuffer(this.ramaddr);
          if (!this.alt1) v |= this.readRamBuffer(this.ramaddr ^ 1) << 8;
          this.setDr(v);
          this.regReset();
        } else if (op === 0x4c) { // plot/rpix
          if (!this.alt1) {
            this.plot(this.r[1]!, this.r[2]!);
            this.r[1] = (this.r[1]! + 1) & 0xffff;
          } else {
            this.setDr(this.rpix(this.r[1]!, this.r[2]!));
            this.setSZ(this.drVal);
          }
          this.regReset();
        } else if (op === 0x4d) { // swap
          this.setDr((this.srVal >> 8) | (this.srVal << 8));
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op === 0x4e) { // color/cmode
          if (!this.alt1) {
            this.colr = this.colorOp(this.srVal & 0xff);
          } else {
            const v = this.srVal;
            this.porObj = (v & 0x10) !== 0;
            this.porFreezehigh = (v & 0x08) !== 0;
            this.porHighnibble = (v & 0x04) !== 0;
            this.porDither = (v & 0x02) !== 0;
            this.porTransparent = (v & 0x01) !== 0;
          }
          this.regReset();
        } else if (op === 0x4f) { // not
          this.setDr(~this.srVal);
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op < 0x60) { // add/adc
          let n = op & 15;
          if (!this.alt2) n = this.r[n]!;
          const carryIn = this.alt1 && (this.sfr & FLAG_CY) !== 0 ? 1 : 0;
          const result = this.srVal + n + carryIn;
          this.setFlag(FLAG_OV, ~(this.srVal ^ n) & (n ^ result) & 0x8000);
          this.setFlag(FLAG_S, result & 0x8000);
          this.setFlag(FLAG_CY, result >= 0x10000);
          this.setFlag(FLAG_Z, (result & 0xffff) === 0);
          this.setDr(result);
          this.regReset();
        } else if (op < 0x70) { // sub/sbc/cmp
          let n = op & 15;
          if (!this.alt2 || this.alt1) n = this.r[n]!;
          const borrow = !this.alt2 && this.alt1 && (this.sfr & FLAG_CY) === 0 ? 1 : 0;
          const result = this.srVal - n - borrow;
          this.setFlag(FLAG_OV, (this.srVal ^ n) & (this.srVal ^ result) & 0x8000);
          this.setFlag(FLAG_S, result & 0x8000);
          this.setFlag(FLAG_CY, result >= 0);
          this.setFlag(FLAG_Z, (result & 0xffff) === 0);
          if (!this.alt2 || !this.alt1) this.setDr(result);
          this.regReset();
        } else if (op === 0x70) { // merge
          this.setDr((this.r[7]! & 0xff00) | (this.r[8]! >> 8));
          this.setFlag(FLAG_OV, this.drVal & 0xc0c0);
          this.setFlag(FLAG_S, this.drVal & 0x8080);
          this.setFlag(FLAG_CY, this.drVal & 0xe0e0);
          this.setFlag(FLAG_Z, this.drVal & 0xf0f0);
          this.regReset();
        } else if (op < 0x80) { // and/bic
          let n = op & 15;
          if (!this.alt2) n = this.r[n]!;
          this.setDr(this.srVal & (this.alt1 ? ~n : n));
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op < 0x90) { // mult/umult
          let n = op & 15;
          if (!this.alt2) n = this.r[n]!;
          const result = !this.alt1
            ? (((this.srVal << 24) >> 24) * ((n << 24) >> 24)) & 0xffff
            : ((this.srVal & 0xff) * (n & 0xff)) & 0xffff;
          this.setDr(result);
          this.setSZ(this.drVal);
          this.regReset();
          if (!this.cfgrMs0) this.step(this.clsr ? 1 : 2);
        } else if (op === 0x90) { // sbk
          this.writeRamBuffer(this.ramaddr ^ 0, this.srVal & 0xff);
          this.writeRamBuffer(this.ramaddr ^ 1, this.srVal >> 8);
          this.regReset();
        } else if (op < 0x95) { // link #n (0x91-0x94)
          this.setR(11, this.r[15]! + (op & 15));
          this.regReset();
        } else if (op === 0x95) { // sex
          this.setDr(((this.srVal & 0xff) << 24) >> 24);
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op === 0x96) { // asr/div2
          this.setFlag(FLAG_CY, this.srVal & 1);
          const signed = (this.srVal << 16) >> 16;
          this.setDr((signed >> 1) + (this.alt1 ? (this.srVal + 1) >> 16 : 0));
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op === 0x97) { // ror
          const carry = (this.srVal & 1) !== 0;
          this.setDr((((this.sfr & FLAG_CY) !== 0 ? 1 : 0) << 15) | (this.srVal >> 1));
          this.setFlag(FLAG_S, this.drVal & 0x8000);
          this.setFlag(FLAG_CY, carry);
          this.setFlag(FLAG_Z, this.drVal === 0);
          this.regReset();
        } else if (op < 0x9e) { // jmp/ljmp (0x98-0x9d)
          const n = op & 15;
          if (!this.alt1) {
            this.setR(15, this.r[n]!);
          } else {
            this.pbr = this.r[n]! & 0x7f;
            this.setR(15, this.srVal);
            this.cbr = this.r[15]! & 0xfff0;
            this.flushCache();
          }
          this.regReset();
        } else if (op === 0x9e) { // lob
          this.setDr(this.srVal & 0xff);
          this.setFlag(FLAG_S, this.drVal & 0x80);
          this.setFlag(FLAG_Z, this.drVal === 0);
          this.regReset();
        } else if (op === 0x9f) { // fmult/lmult
          const result = (((this.srVal << 16) >> 16) * ((this.r[6]! << 16) >> 16)) | 0;
          if (this.alt1) this.setR(4, result & 0xffff);
          this.setDr(result >>> 16);
          this.setFlag(FLAG_S, this.drVal & 0x8000);
          this.setFlag(FLAG_CY, result & 0x8000);
          this.setFlag(FLAG_Z, this.drVal === 0);
          this.regReset();
          this.step((this.cfgrMs0 ? 3 : 7) * (this.clsr ? 1 : 2));
        } else if (op < 0xb0) { // ibt/lms/sms (0xa0-0xaf)
          const n = op & 15;
          if (this.alt1) {
            this.ramaddr = (this.pipe() << 1) & 0xffff;
            const lo = this.readRamBuffer(this.ramaddr ^ 0);
            this.setR(n, (this.readRamBuffer(this.ramaddr ^ 1) << 8) | lo);
          } else if (this.alt2) {
            this.ramaddr = (this.pipe() << 1) & 0xffff;
            this.writeRamBuffer(this.ramaddr ^ 0, this.r[n]! & 0xff);
            this.writeRamBuffer(this.ramaddr ^ 1, this.r[n]! >> 8);
          } else {
            this.setR(n, (this.pipe() << 24) >> 24);
          }
          this.regReset();
        } else if (op < 0xc0) { // from/moves (0xb0-0xbf)
          const n = op & 15;
          if ((this.sfr & FLAG_B) === 0) {
            this.sreg = n;
          } else {
            this.setDr(this.r[n]!);
            this.setFlag(FLAG_OV, this.drVal & 0x80);
            this.setSZ(this.drVal);
            this.regReset();
          }
        } else if (op === 0xc0) { // hib
          this.setDr(this.srVal >> 8);
          this.setFlag(FLAG_S, this.drVal & 0x80);
          this.setFlag(FLAG_Z, this.drVal === 0);
          this.regReset();
        } else if (op < 0xd0) { // or/xor (0xc1-0xcf)
          let n = op & 15;
          if (!this.alt2) n = this.r[n]!;
          this.setDr(!this.alt1 ? this.srVal | n : this.srVal ^ n);
          this.setSZ(this.drVal);
          this.regReset();
        } else if (op < 0xdf) { // inc (0xd0-0xde)
          const n = op & 15;
          this.setR(n, this.r[n]! + 1);
          this.setFlag(FLAG_S, this.r[n]! & 0x8000);
          this.setFlag(FLAG_Z, this.r[n] === 0);
          this.regReset();
        } else if (op === 0xdf) { // getc/ramb/romb
          if (!this.alt2) {
            this.colr = this.colorOp(this.readRomBuffer());
          } else if (!this.alt1) {
            this.syncRamBuffer();
            this.rambr = this.srVal & 0x01;
          } else {
            this.syncRomBuffer();
            this.rombr = this.srVal & 0x7f;
          }
          this.regReset();
        } else if (op < 0xef) { // dec (0xe0-0xee)
          const n = op & 15;
          this.setR(n, this.r[n]! - 1);
          this.setFlag(FLAG_S, this.r[n]! & 0x8000);
          this.setFlag(FLAG_Z, this.r[n] === 0);
          this.regReset();
        } else if (op === 0xef) { // getb/getbh/getbl/getbs
          const mode = ((this.alt2 ? 1 : 0) << 1) | (this.alt1 ? 1 : 0);
          switch (mode) {
            case 0: this.setDr(this.readRomBuffer()); break;
            case 1: this.setDr((this.readRomBuffer() << 8) | (this.srVal & 0xff)); break;
            case 2: this.setDr((this.srVal & 0xff00) | this.readRomBuffer()); break;
            case 3: this.setDr((this.readRomBuffer() << 24) >> 24); break;
          }
          this.regReset();
        } else { // iwt/lm/sm (0xf0-0xff)
          const n = op & 15;
          if (this.alt1) {
            this.ramaddr = this.pipe() | (this.pipe() << 8);
            const lo = this.readRamBuffer(this.ramaddr ^ 0);
            this.setR(n, (this.readRamBuffer(this.ramaddr ^ 1) << 8) | lo);
          } else if (this.alt2) {
            this.ramaddr = this.pipe() | (this.pipe() << 8);
            this.writeRamBuffer(this.ramaddr ^ 0, this.r[n]! & 0xff);
            this.writeRamBuffer(this.ramaddr ^ 1, this.r[n]! >> 8);
          } else {
            const lo = this.pipe();
            this.setR(n, (this.pipe() << 8) | lo);
          }
          this.regReset();
        }
        break;
    }
  }

  private branch(take: boolean): void {
    const displacement = (this.pipe() << 24) >> 24;
    if (take) this.setR(15, this.r[15]! + displacement);
  }

  // ── S-CPU side ─────────────────────────────────────────────────────

  /** Catch the GSU up to the S-CPU's current cycle. Called before every
   *  S-CPU-side board access so register/RAM/ownership state, and any
   *  graphics the GSU has plotted, reflect exactly "now". */
  private sync(): void {
    if (this.hostClock !== null) this.catchUp(this.hostClock());
  }

  /** S-CPU read of a SuperFX board region; null = not ours. */
  readCpu(bank: number, off: number): number | null {
    this.sync();
    const sysBank = bank & 0x7f;
    if (sysBank <= 0x3f) {
      if (off >= 0x8000) {
        // While the GSU owns ROM, the console sees the vector stub.
        if (this.going && this.scmrRon) return GSU_VECTOR_STUB[off & 15]!;
        return this.rom[((sysBank << 15) | (off & 0x7fff)) & this.romMask]!;
      }
      if (off >= 0x6000) {
        if (this.ramMask === 0) return null;
        if (this.going && this.scmrRan) return null; // GSU owns RAM
        return this.ram[(off - 0x6000) & this.ramMask]!;
      }
      if (off >= 0x3000 && off <= 0x33ff) return this.readIo(0x3000 | (off & 0x3ff));
      return null;
    }
    if (sysBank >= 0x40 && sysBank <= 0x5f) {
      if (this.going && this.scmrRon) return GSU_VECTOR_STUB[off & 15]!;
      return this.rom[(((sysBank - 0x40) << 16) | off) & this.romMask]!;
    }
    if (sysBank >= 0x70 && sysBank <= 0x71) {
      if (this.ramMask === 0) return null;
      if (this.going && this.scmrRan) return null;
      return this.ram[(((sysBank - 0x70) << 16) | off) & this.ramMask]!;
    }
    return null;
  }

  /** S-CPU write; returns true when the address belongs to the board. */
  writeCpu(bank: number, off: number, value: number): boolean {
    this.sync();
    const sysBank = bank & 0x7f;
    if (sysBank <= 0x3f) {
      if (off >= 0x8000) return true; // ROM
      if (off >= 0x6000) {
        if (this.ramMask !== 0) this.ram[(off - 0x6000) & this.ramMask] = value;
        return true;
      }
      if (off >= 0x3000 && off <= 0x33ff) {
        this.writeIo(0x3000 | (off & 0x3ff), value);
        return true;
      }
      return false;
    }
    if (sysBank >= 0x40 && sysBank <= 0x5f) return true; // ROM
    if (sysBank >= 0x70 && sysBank <= 0x71) {
      if (this.ramMask !== 0) this.ram[(((sysBank - 0x70) << 16) | off) & this.ramMask] = value;
      return true;
    }
    return false;
  }

  private readIo(addr: number): number {
    if (addr >= 0x3100 && addr <= 0x32ff) return this.readCache(addr - 0x3100);
    if (addr <= 0x301f) {
      return (this.r[(addr >> 1) & 15]! >> ((addr & 1) << 3)) & 0xff;
    }
    switch (addr) {
      case 0x3030:
        return this.sfr & 0x7e; // low byte, masked
      case 0x3031: {
        const v = (this.sfr >> 8) & 0x9f;
        this.sfr &= ~FLAG_IRQ;
        return v;
      }
      case 0x3034:
        return this.pbr;
      case 0x3036:
        return this.rombr;
      case 0x303b:
        return this.vcr;
      case 0x303c:
        return this.rambr;
      case 0x303e:
        return this.cbr & 0xff;
      case 0x303f:
        return this.cbr >> 8;
    }
    return 0x00;
  }

  private writeIo(addr: number, data: number): void {
    if (addr >= 0x3100 && addr <= 0x32ff) {
      this.writeCache(addr - 0x3100, data);
      return;
    }
    if (addr <= 0x301f) {
      const n = (addr >> 1) & 15;
      if ((addr & 1) === 0) this.r[n] = (this.r[n]! & 0xff00) | data;
      else this.r[n] = (data << 8) | (this.r[n]! & 0xff);
      if (n === 14) this.updateRomBuffer();
      if (addr === 0x301f) this.sfr |= FLAG_G; // writing r15 high starts the GSU
      return;
    }
    switch (addr) {
      case 0x3030: {
        const wasGoing = this.going;
        this.sfr = (this.sfr & 0xff00) | data;
        if (wasGoing && !this.going) {
          this.cbr = 0;
          this.flushCache();
        }
        break;
      }
      case 0x3031:
        this.sfr = (data << 8) | (this.sfr & 0x00ff);
        break;
      case 0x3033:
        this.bramr = data & 0x01;
        break;
      case 0x3034:
        this.pbr = data & 0x7f;
        this.flushCache();
        break;
      case 0x3037:
        this.cfgrIrq = (data & 0x80) !== 0;
        this.cfgrMs0 = (data & 0x20) !== 0;
        break;
      case 0x3038:
        this.scbr = data;
        break;
      case 0x3039:
        this.clsr = data & 0x01;
        break;
      case 0x303a:
        this.scmrHt = ((data & 0x20) !== 0 ? 2 : 0) | ((data & 0x04) !== 0 ? 1 : 0);
        this.scmrRon = (data & 0x10) !== 0;
        this.scmrRan = (data & 0x08) !== 0;
        this.scmrMd = data & 0x03;
        break;
    }
  }

  // ── persistence ────────────────────────────────────────────────────

  serialize(w: SnesStateWriter): void {
    for (let i = 0; i < 16; i++) w.u16(this.r[i]!);
    w.bool(this.r14Modified);
    w.bool(this.r15Modified);
    w.u16(this.sfr);
    w.u8(this.pbr);
    w.u8(this.rombr);
    w.u8(this.rambr);
    w.u16(this.cbr);
    w.u8(this.scbr);
    w.u8(this.colr);
    w.u8(this.bramr);
    w.u8(this.clsr);
    w.u8(this.pipeline);
    w.u16(this.ramaddr);
    w.u8(this.sreg);
    w.u8(this.dreg);
    w.u8((this.scmrHt << 5) | ((this.scmrRon ? 1 : 0) << 4) | ((this.scmrRan ? 1 : 0) << 3) | this.scmrMd);
    w.u8(
      ((this.porObj ? 1 : 0) << 4) |
        ((this.porFreezehigh ? 1 : 0) << 3) |
        ((this.porHighnibble ? 1 : 0) << 2) |
        ((this.porDither ? 1 : 0) << 1) |
        (this.porTransparent ? 1 : 0)
    );
    w.u8(((this.cfgrIrq ? 1 : 0) << 7) | ((this.cfgrMs0 ? 1 : 0) << 5));
    w.u16(this.romcl);
    w.u8(this.romdr);
    w.u16(this.ramcl);
    w.u16(this.ramar);
    w.u8(this.ramdr);
    w.bytes(this.cacheBuffer);
    w.bytes(this.cacheValid);
    for (let i = 0; i < 2; i++) {
      w.u32(this.pcOffset[i]! >>> 0);
      w.u8(this.pcBitpend[i]!);
      w.bytes(this.pcData[i]!);
    }
    w.f64(this.clock);
  }

  deserialize(r: SnesStateReader): void {
    for (let i = 0; i < 16; i++) this.r[i] = r.u16();
    this.r14Modified = r.bool();
    this.r15Modified = r.bool();
    this.sfr = r.u16();
    this.pbr = r.u8();
    this.rombr = r.u8();
    this.rambr = r.u8();
    this.cbr = r.u16();
    this.scbr = r.u8();
    this.colr = r.u8();
    this.bramr = r.u8();
    this.clsr = r.u8();
    this.pipeline = r.u8();
    this.ramaddr = r.u16();
    this.sreg = r.u8();
    this.dreg = r.u8();
    let b = r.u8();
    this.scmrHt = (b >> 5) & 3;
    this.scmrRon = (b & 0x10) !== 0;
    this.scmrRan = (b & 0x08) !== 0;
    this.scmrMd = b & 3;
    b = r.u8();
    this.porObj = (b & 0x10) !== 0;
    this.porFreezehigh = (b & 0x08) !== 0;
    this.porHighnibble = (b & 0x04) !== 0;
    this.porDither = (b & 0x02) !== 0;
    this.porTransparent = (b & 0x01) !== 0;
    b = r.u8();
    this.cfgrIrq = (b & 0x80) !== 0;
    this.cfgrMs0 = (b & 0x20) !== 0;
    this.romcl = r.u16();
    this.romdr = r.u8();
    this.ramcl = r.u16();
    this.ramar = r.u16();
    this.ramdr = r.u8();
    r.bytes(this.cacheBuffer);
    r.bytes(this.cacheValid);
    for (let i = 0; i < 2; i++) {
      this.pcOffset[i] = r.u32() | 0;
      this.pcBitpend[i] = r.u8();
      r.bytes(this.pcData[i]!);
    }
    this.clock = r.f64();
  }
}
