/**
 * Cx4 (Capcom Custom, Hitachi HG51B169) — the math/graphics coprocessor
 * used by Mega Man X2 and X3 for their wireframe-boss intros, sprite
 * scale/rotate effects and vector math. High-level emulation of the
 * command set: the chip exposes 8 KiB of RAM at $6000-$7FFF; the game
 * writes operands there, then writes a command number to $7F4F (or a
 * sprite sub-command via $7F4D) or triggers a ROM→RAM load via $7F47.
 *
 * Ported from the community HLE reconstruction of the chip; the interface
 * follows fullsnes "SNES Cart CX4". Operations run instantly (the $7F5E
 * ready flag always reads 0),
 * which is faithful enough for the games — they poll for completion.
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";
import { C4_COS, C4_SIN } from "./cx4-tables.js";

const PI = 3.14159265;

// prettier-ignore
const TEST_PATTERN = new Uint8Array([
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff,
  0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x80, 0xff, 0xff, 0x7f,
  0x00, 0x80, 0x00, 0xff, 0x7f, 0x00, 0xff, 0x7f, 0xff, 0x7f, 0xff, 0xff,
  0x00, 0x00, 0x01, 0xff, 0xff, 0xfe, 0x00, 0x01, 0x00, 0xff, 0xfe, 0x00
]);

// prettier-ignore
const BMP_DATA = new Uint16Array([
  0x0000, 0x0002, 0x0004, 0x0006, 0x0008, 0x000a, 0x000c, 0x000e,
  0x0200, 0x0202, 0x0204, 0x0206, 0x0208, 0x020a, 0x020c, 0x020e,
  0x0400, 0x0402, 0x0404, 0x0406, 0x0408, 0x040a, 0x040c, 0x040e,
  0x0600, 0x0602, 0x0604, 0x0606, 0x0608, 0x060a, 0x060c, 0x060e,
  0x0800, 0x0802, 0x0804, 0x0806, 0x0808, 0x080a, 0x080c, 0x080e
]);

const s16 = (v: number): number => (v << 16) >> 16;
const s8 = (v: number): number => (v << 24) >> 24;

export class Cx4 {
  private readonly rom: Uint8Array;
  /** 8 KiB of chip RAM, mapped at $6000-$7FFF (index = addr - $6000). */
  readonly ram = new Uint8Array(0x2000);

  // wireframe transform scratch registers (the reference's globals)
  private wfx = 0;
  private wfy = 0;
  private wfz = 0;
  private wfx2 = 0;
  private wfy2 = 0;
  private wfDist = 0;
  private wfScale = 0;
  private f1x = 0;
  private f1y = 0;
  private f1angle = 0;
  private f1distVal = 0;

  constructor(rom: Uint8Array) {
    this.rom = rom;
  }

  reset(): void {
    this.ram.fill(0);
  }

  // ── little-endian RAM accessors (offset = $7Fxx → 0x1Fxx) ─────────────

  private rd16(o: number): number {
    return this.ram[o]! | (this.ram[o + 1]! << 8);
  }

  private rd16s(o: number): number {
    return s16(this.rd16(o));
  }

  private rd24(o: number): number {
    return this.ram[o]! | (this.ram[o + 1]! << 8) | (this.ram[o + 2]! << 16);
  }

  private wr16(o: number, v: number): void {
    this.ram[o] = v & 0xff;
    this.ram[o + 1] = (v >> 8) & 0xff;
  }

  private wr24(o: number, v: number): void {
    this.ram[o] = v & 0xff;
    this.ram[o + 1] = (v >> 8) & 0xff;
    this.ram[o + 2] = (v >> 16) & 0xff;
  }

  /** LoROM fold for the chip's ROM pointer; returns a byte at `+i`. */
  private romAt(addr: number, i: number): number {
    const base = ((addr & 0xff0000) >> 1) + (addr & 0x7fff) + i;
    return this.rom[base % this.rom.length]!;
  }

  // ── math primitives ──────────────────────────────────────────────────

  private transfWireFrame(): void {
    let c4x = this.wfx;
    let c4y = this.wfy;
    let c4z = this.wfz - 0x95;
    let t = (-this.wfx2 * PI * 2) / 128;
    const c4y2 = c4y * Math.cos(t) - c4z * Math.sin(t);
    const c4z2 = c4y * Math.sin(t) + c4z * Math.cos(t);
    t = (-this.wfy2 * PI * 2) / 128;
    const c4x2 = c4x * Math.cos(t) + c4z2 * Math.sin(t);
    c4z = c4x * -Math.sin(t) + c4z2 * Math.cos(t);
    t = (-this.wfDist * PI * 2) / 128;
    c4x = c4x2 * Math.cos(t) - c4y2 * Math.sin(t);
    c4y = c4x2 * Math.sin(t) + c4y2 * Math.cos(t);
    this.wfx = s16(Math.trunc(((c4x * this.wfScale) / (0x90 * (c4z + 0x95))) * 0x95));
    this.wfy = s16(Math.trunc(((c4y * this.wfScale) / (0x90 * (c4z + 0x95))) * 0x95));
  }

  private transfWireFrame2(): void {
    let c4x = this.wfx;
    let c4y = this.wfy;
    let c4z = this.wfz;
    let t = (-this.wfx2 * PI * 2) / 128;
    const c4y2 = c4y * Math.cos(t) - c4z * Math.sin(t);
    const c4z2 = c4y * Math.sin(t) + c4z * Math.cos(t);
    t = (-this.wfy2 * PI * 2) / 128;
    const c4x2 = c4x * Math.cos(t) + c4z2 * Math.sin(t);
    c4z = c4x * -Math.sin(t) + c4z2 * Math.cos(t);
    t = (-this.wfDist * PI * 2) / 128;
    c4x = c4x2 * Math.cos(t) - c4y2 * Math.sin(t);
    c4y = c4x2 * Math.sin(t) + c4y2 * Math.cos(t);
    this.wfx = s16(Math.trunc((c4x * this.wfScale) / 0x100));
    this.wfy = s16(Math.trunc((c4y * this.wfScale) / 0x100));
  }

  private calcWireFrame(): void {
    this.wfx = s16(this.wfx2 - this.wfx);
    this.wfy = s16(this.wfy2 - this.wfy);
    if (Math.abs(this.wfx) > Math.abs(this.wfy)) {
      this.wfDist = s16(Math.abs(this.wfx) + 1);
      this.wfy = s16(Math.trunc((256 * this.wfy) / Math.abs(this.wfx)));
      this.wfx = this.wfx < 0 ? -256 : 256;
    } else if (this.wfy !== 0) {
      this.wfDist = s16(Math.abs(this.wfy) + 1);
      this.wfx = s16(Math.trunc((256 * this.wfx) / Math.abs(this.wfy)));
      this.wfy = this.wfy < 0 ? -256 : 256;
    } else {
      this.wfDist = 0;
    }
  }

  private op1F(): void {
    if (this.f1x === 0) {
      this.f1angle = this.f1y > 0 ? 0x80 : 0x180;
    } else {
      let a = Math.trunc((Math.atan(this.f1y / this.f1x) / (PI * 2)) * 512);
      if (this.f1x < 0) a += 0x100;
      this.f1angle = a & 0x1ff;
    }
  }

  private op0D(): void {
    let t = Math.sqrt(this.f1y * this.f1y + this.f1x * this.f1x);
    t = this.f1distVal / t;
    this.f1y = s16(Math.trunc(this.f1y * t * 0.99));
    this.f1x = s16(Math.trunc(this.f1x * t * 0.98));
  }

  // ── drawing / sprite ops ─────────────────────────────────────────────

  private convOAM(): void {
    let oamPtr = this.ram[0x626]! << 2;
    for (let i = 0x1fd; i > oamPtr; i -= 4) this.ram[i] = 0xe0;

    const globalX = this.rd16(0x0621);
    const globalY = this.rd16(0x0623);
    let oam2 = 0x200 + (this.ram[0x626]! >> 2);

    if (this.ram[0x0620] === 0) return;
    let sprCount = 128 - this.ram[0x626]!;
    let offset = (this.ram[0x626]! & 3) * 2;
    let src = 0x220;

    for (let i = this.ram[0x0620]!; i > 0 && sprCount > 0; i--, src += 16) {
      const sprX = s16(this.rd16(src) - globalX);
      const sprY = s16(this.rd16(src + 2) - globalY);
      const sprName = this.ram[src + 5]!;
      const sprAttr = this.ram[src + 4]! | this.ram[src + 6]!;

      const spr = this.rd24(src + 7);
      const cnt = this.romAt(spr, 0);
      if (cnt !== 0) {
        let sp = 1;
        for (let c = cnt; c > 0 && sprCount > 0; c--, sp += 4) {
          let x = s8(this.romAt(spr, sp + 1));
          if (sprAttr & 0x40) x = -x - (this.romAt(spr, sp) & 0x20 ? 16 : 8);
          x = s16(x + sprX);
          if (x >= -16 && x <= 272) {
            let y = s8(this.romAt(spr, sp + 2));
            if (sprAttr & 0x80) y = -y - (this.romAt(spr, sp) & 0x20 ? 16 : 8);
            y = s16(y + sprY);
            if (y >= -16 && y <= 224) {
              this.ram[oamPtr] = x & 0xff;
              this.ram[oamPtr + 1] = y & 0xff;
              this.ram[oamPtr + 2] = (sprName + this.romAt(spr, sp + 3)) & 0xff;
              this.ram[oamPtr + 3] = (sprAttr ^ (this.romAt(spr, sp) & 0xc0)) & 0xff;
              this.ram[oam2] = this.ram[oam2]! & ~(3 << offset);
              if (x & 0x100) this.ram[oam2] = this.ram[oam2]! | (1 << offset);
              if (this.romAt(spr, sp) & 0x20) this.ram[oam2] = this.ram[oam2]! | (2 << offset);
              oamPtr += 4;
              sprCount--;
              offset = (offset + 2) & 6;
              if (offset === 0) oam2++;
            }
          }
        }
      } else if (sprCount > 0) {
        this.ram[oamPtr] = sprX & 0xff;
        this.ram[oamPtr + 1] = sprY & 0xff;
        this.ram[oamPtr + 2] = sprName;
        this.ram[oamPtr + 3] = sprAttr;
        this.ram[oam2] = this.ram[oam2]! & ~(3 << offset);
        this.ram[oam2] = this.ram[oam2]! | ((sprX & 0x100 ? 3 : 2) << offset);
        oamPtr += 4;
        sprCount--;
        offset = (offset + 2) & 6;
        if (offset === 0) oam2++;
      }
    }
  }

  private doScaleRotate(rowPadding: number): void {
    let a: number;
    let b: number;
    let c: number;
    let d: number;
    let xScale = this.rd16(0x1f8f);
    if (xScale & 0x8000) xScale = 0x7fff;
    let yScale = this.rd16(0x1f92);
    if (yScale & 0x8000) yScale = 0x7fff;

    const angle = this.rd16(0x1f80);
    if (angle === 0) {
      a = s16(xScale);
      b = 0;
      c = 0;
      d = s16(yScale);
    } else if (angle === 128) {
      a = 0;
      b = s16(-yScale);
      c = s16(xScale);
      d = 0;
    } else if (angle === 256) {
      a = s16(-xScale);
      b = 0;
      c = 0;
      d = s16(-yScale);
    } else if (angle === 384) {
      a = 0;
      b = s16(yScale);
      c = s16(-xScale);
      d = 0;
    } else {
      const idx = angle & 0x1ff;
      a = s16((C4_COS[idx]! * xScale) >> 15);
      b = s16(-((C4_SIN[idx]! * yScale) >> 15));
      c = s16((C4_SIN[idx]! * xScale) >> 15);
      d = s16((C4_COS[idx]! * yScale) >> 15);
    }

    const w = this.ram[0x1f89]! & ~7;
    const h = this.ram[0x1f8c]! & ~7;
    this.ram.fill(0, 0, (((w + rowPadding / 4) * h) / 2) | 0);

    const cx = this.rd16s(0x1f83);
    const cy = this.rd16s(0x1f86);
    let lineX = (cx << 12) - cx * a - cx * b;
    let lineY = (cy << 12) - cy * c - cy * d;

    let outidx = 0;
    let bit = 0x80;
    for (let y = 0; y < h; y++) {
      let x = lineX | 0;
      let yy = lineY | 0;
      for (let px = 0; px < w; px++) {
        let byte: number;
        if (x >>> 12 >= w || yy >>> 12 >= h) {
          byte = 0;
        } else {
          const addr = (yy >>> 12) * w + (x >>> 12);
          byte = this.ram[0x600 + (addr >> 1)]!;
          if (addr & 1) byte >>= 4;
        }
        if (byte & 1) this.ram[outidx] = this.ram[outidx]! | bit;
        if (byte & 2) this.ram[outidx + 1] = this.ram[outidx + 1]! | bit;
        if (byte & 4) this.ram[outidx + 16] = this.ram[outidx + 16]! | bit;
        if (byte & 8) this.ram[outidx + 17] = this.ram[outidx + 17]! | bit;
        bit >>= 1;
        if (bit === 0) {
          bit = 0x80;
          outidx += 32;
        }
        x = (x + a) | 0;
        yy = (yy + c) | 0;
      }
      outidx += 2 + rowPadding;
      if (outidx & 0x10) outidx &= ~0x10;
      else outidx -= w * 4 + rowPadding;
      lineX = (lineX + b) | 0;
      lineY = (lineY + d) | 0;
    }
  }

  private drawLine(x1i: number, y1i: number, z1: number, x2i: number, y2i: number, z2: number, color: number): void {
    this.wfx = s16(x1i);
    this.wfy = s16(y1i);
    this.wfz = z1;
    this.wfScale = this.ram[0x1f90]!;
    this.wfx2 = this.ram[0x1f86]!;
    this.wfy2 = this.ram[0x1f87]!;
    this.wfDist = this.ram[0x1f88]!;
    this.transfWireFrame2();
    let x1 = (this.wfx + 48) << 8;
    let y1 = (this.wfy + 48) << 8;

    this.wfx = s16(x2i);
    this.wfy = s16(y2i);
    this.wfz = z2;
    this.transfWireFrame2();
    let x2 = (this.wfx + 48) << 8;
    let y2 = (this.wfy + 48) << 8;

    this.wfx = s16(x1 >> 8);
    this.wfy = s16(y1 >> 8);
    this.wfx2 = s16(x2 >> 8);
    this.wfy2 = s16(y2 >> 8);
    this.calcWireFrame();
    x2 = s16(this.wfx);
    y2 = s16(this.wfy);

    for (let i = this.wfDist ? this.wfDist : 1; i > 0; i--) {
      if (x1 > 0xff && y1 > 0xff && x1 < 0x6000 && y1 < 0x6000) {
        const addr =
          ((((y1 >> 8) >> 3) << 8) - (((y1 >> 8) >> 3) << 6) + (((x1 >> 8) >> 3) << 4) + ((y1 >> 8) & 7) * 2) & 0xffff;
        const bit = 0x80 >> ((x1 >> 8) & 7);
        this.ram[addr + 0x300] = this.ram[addr + 0x300]! & ~bit;
        this.ram[addr + 0x301] = this.ram[addr + 0x301]! & ~bit;
        if (color & 1) this.ram[addr + 0x300] = this.ram[addr + 0x300]! | bit;
        if (color & 2) this.ram[addr + 0x301] = this.ram[addr + 0x301]! | bit;
      }
      x1 += x2;
      y1 += y2;
    }
  }

  private drawWireFrame(): void {
    let line = this.rd24(0x1f80);
    const bankBase = this.ram[0x1f82]! << 16;
    for (let i = this.ram[0x0295]!; i > 0; i--, line += 5) {
      let p1: number;
      if (this.romAt(line, 0) === 0xff && this.romAt(line, 1) === 0xff) {
        let tmp = line - 5;
        while (this.romAt(tmp, 2) === 0xff && this.romAt(tmp, 3) === 0xff) tmp -= 5;
        p1 = bankBase | (this.romAt(tmp, 2) << 8) | this.romAt(tmp, 3);
      } else {
        p1 = bankBase | (this.romAt(line, 0) << 8) | this.romAt(line, 1);
      }
      const p2 = bankBase | (this.romAt(line, 2) << 8) | this.romAt(line, 3);

      const x1 = s16((this.romAt(p1, 0) << 8) | this.romAt(p1, 1));
      const y1 = s16((this.romAt(p1, 2) << 8) | this.romAt(p1, 3));
      const z1 = s16((this.romAt(p1, 4) << 8) | this.romAt(p1, 5));
      const x2 = s16((this.romAt(p2, 0) << 8) | this.romAt(p2, 1));
      const y2 = s16((this.romAt(p2, 2) << 8) | this.romAt(p2, 3));
      const z2 = s16((this.romAt(p2, 4) << 8) | this.romAt(p2, 5));
      this.drawLine(x1, y1, z1, x2, y2, z2, this.romAt(line, 4));
    }
  }

  private transformLines(): void {
    this.wfx2 = this.ram[0x1f83]!;
    this.wfy2 = this.ram[0x1f86]!;
    this.wfDist = this.ram[0x1f89]!;
    this.wfScale = this.ram[0x1f8c]!;

    let ptr = 0;
    for (let i = this.rd16(0x1f80); i > 0; i--, ptr += 0x10) {
      this.wfx = this.rd16s(ptr + 1);
      this.wfy = this.rd16s(ptr + 5);
      this.wfz = this.rd16s(ptr + 9);
      this.transfWireFrame();
      this.wr16(ptr + 1, this.wfx + 0x80);
      this.wr16(ptr + 5, this.wfy + 0x50);
    }

    this.wr16(0x600, 23);
    this.wr16(0x602, 0x60);
    this.wr16(0x605, 0x40);
    this.wr16(0x608, 23);
    this.wr16(0x60a, 0x60);
    this.wr16(0x60d, 0x40);

    ptr = 0xb02;
    let ptr2 = 0;
    for (let i = this.rd16(0xb00); i > 0; i--, ptr += 2, ptr2 += 8) {
      this.wfx = this.rd16s((this.ram[ptr]! << 4) + 1);
      this.wfy = this.rd16s((this.ram[ptr]! << 4) + 5);
      this.wfx2 = this.rd16s((this.ram[ptr + 1]! << 4) + 1);
      this.wfy2 = this.rd16s((this.ram[ptr + 1]! << 4) + 5);
      this.calcWireFrame();
      this.wr16(ptr2 + 0x600, this.wfDist ? this.wfDist : 1);
      this.wr16(ptr2 + 0x602, this.wfx);
      this.wr16(ptr2 + 0x605, this.wfy);
    }
  }

  private bitPlaneWave(): void {
    let waveptr = this.ram[0x1f83]!;
    let mask1 = 0xc0c0;
    let mask2 = 0x3f3f;
    let dst = 0;
    for (let j = 0; j < 0x10; j++) {
      do {
        let height = -s8(this.ram[waveptr + 0xb00]!) - 16;
        for (let i = 0; i < 40; i++) {
          let tmp = this.rd16(dst + BMP_DATA[i]!) & mask2;
          if (height >= 0) {
            if (height < 8) tmp |= mask1 & this.rd16(0xa00 + height * 2);
            else tmp |= mask1 & 0xff00;
          }
          this.wr16(dst + BMP_DATA[i]!, tmp);
          height++;
        }
        waveptr = (waveptr + 1) & 0x7f;
        mask1 = ((mask1 >> 2) | (mask1 << 6)) & 0xffff;
        mask2 = ((mask2 >> 2) | (mask2 << 6)) & 0xffff;
      } while (mask1 !== 0xc0c0);
      dst += 16;

      do {
        let height = -s8(this.ram[waveptr + 0xb00]!) - 16;
        for (let i = 0; i < 40; i++) {
          let tmp = this.rd16(dst + BMP_DATA[i]!) & mask2;
          if (height >= 0) {
            if (height < 8) tmp |= mask1 & this.rd16(0xa10 + height * 2);
            else tmp |= mask1 & 0xff00;
          }
          this.wr16(dst + BMP_DATA[i]!, tmp);
          height++;
        }
        waveptr = (waveptr + 1) & 0x7f;
        mask1 = ((mask1 >> 2) | (mask1 << 6)) & 0xffff;
        mask2 = ((mask2 >> 2) | (mask2 << 6)) & 0xffff;
      } while (mask1 !== 0xc0c0);
      dst += 16;
    }
  }

  private sprDisintegrate(): void {
    const width = this.ram[0x1f89]!;
    const height = this.ram[0x1f8c]!;
    const cx = this.rd16s(0x1f80);
    const cy = this.rd16s(0x1f83);
    const scaleX = this.rd16s(0x1f86);
    const scaleY = this.rd16s(0x1f8f);
    const startX = -cx * scaleX + (cx << 8);
    const startY = -cy * scaleY + (cy << 8);
    let src = 0x600;
    this.ram.fill(0, 0, ((width * height) / 2) | 0);

    let y = startY;
    for (let i = 0; i < height; i++, y += scaleY) {
      let x = startX;
      for (let j = 0; j < width; j++, x += scaleX) {
        if (x >> 8 < width && y >> 8 < height && (y >> 8) * width + (x >> 8) < 0x2000) {
          const pixel = j & 1 ? this.ram[src]! >> 4 : this.ram[src]!;
          const idx = (y >> 11) * width * 4 + (x >> 11) * 32 + ((y >> 8) & 7) * 2;
          const mask = 0x80 >> ((x >> 8) & 7);
          if (pixel & 1) this.ram[idx] = this.ram[idx]! | mask;
          if (pixel & 2) this.ram[idx + 1] = this.ram[idx + 1]! | mask;
          if (pixel & 4) this.ram[idx + 16] = this.ram[idx + 16]! | mask;
          if (pixel & 8) this.ram[idx + 17] = this.ram[idx + 17]! | mask;
        }
        if (j & 1) src++;
      }
    }
  }

  private processSprites(): void {
    switch (this.ram[0x1f4d]) {
      case 0x00:
        this.convOAM();
        break;
      case 0x03:
        this.doScaleRotate(0);
        break;
      case 0x05:
        this.transformLines();
        break;
      case 0x07:
        this.doScaleRotate(64);
        break;
      case 0x08:
        this.drawWireFrame();
        break;
      case 0x0b:
        this.sprDisintegrate();
        break;
      case 0x0c:
        this.bitPlaneWave();
        break;
    }
  }

  // ── S-CPU interface ($6000-$7FFF) ────────────────────────────────────

  getC4(addr: number): number {
    if (addr === 0x7f5e) return 0;
    return this.ram[addr - 0x6000]!;
  }

  setC4(byte: number, addr: number): void {
    this.ram[addr - 0x6000] = byte;

    if (addr === 0x7f4f) {
      if (this.ram[0x1f4d] === 0x0e && byte < 0x40 && (byte & 3) === 0) {
        this.ram[0x1f80] = byte >> 2;
        return;
      }
      this.runCommand(byte);
    } else if (addr === 0x7f47) {
      // ROM → C4RAM load ($1F40 source, $1F45 dest, $1F43 size).
      const src = this.rd24(0x1f40);
      const dest = this.rd16(0x1f45) & 0x1fff;
      const size = this.rd16(0x1f43);
      for (let i = 0; i < size; i++) this.ram[(dest + i) & 0x1fff] = this.romAt(src, i);
    }
  }

  private runCommand(byte: number): void {
    switch (byte) {
      case 0x00: // sprite
        this.processSprites();
        break;
      case 0x01: // draw wireframe
        this.ram.fill(0, 0x300, 0x300 + 16 * 12 * 3 * 4);
        this.drawWireFrame();
        break;
      case 0x05: {
        // propulsion
        let tmp = 0x10000;
        const d = this.rd16(0x1f83);
        if (d) tmp = ((((tmp / d) | 0) * this.rd16(0x1f81)) | 0) >> 8;
        this.wr16(0x1f80, tmp & 0xffff);
        break;
      }
      case 0x0d: // set vector length
        this.f1x = this.rd16s(0x1f80);
        this.f1y = this.rd16s(0x1f83);
        this.f1distVal = this.rd16s(0x1f86);
        this.op0D();
        this.wr16(0x1f89, this.f1x);
        this.wr16(0x1f8c, this.f1y);
        break;
      case 0x10: {
        // polar → rectangular
        let r1 = this.rd16(0x1f83);
        r1 = r1 & 0x8000 ? r1 | ~0x7fff : r1 & 0x7fff;
        const idx = this.rd16(0x1f80) & 0x1ff;
        let tmp = (r1 * C4_COS[idx]! * 2) >> 16;
        this.wr24(0x1f86, tmp);
        tmp = (r1 * C4_SIN[idx]! * 2) >> 16;
        this.wr24(0x1f89, tmp - (tmp >> 6));
        break;
      }
      case 0x13: {
        // polar → rectangular (variant)
        const idx = this.rd16(0x1f80) & 0x1ff;
        let tmp = (this.rd16s(0x1f83) * C4_COS[idx]! * 2) >> 8;
        this.wr24(0x1f86, tmp);
        tmp = (this.rd16s(0x1f83) * C4_SIN[idx]! * 2) >> 8;
        this.wr24(0x1f89, tmp);
        break;
      }
      case 0x15: {
        // pythagorean
        const x = this.rd16s(0x1f80);
        const y = this.rd16s(0x1f83);
        this.wr16(0x1f80, s16(Math.trunc(Math.sqrt(x * x + y * y))));
        break;
      }
      case 0x1f: // atan
        this.f1x = this.rd16s(0x1f80);
        this.f1y = this.rd16s(0x1f83);
        this.op1F();
        this.wr16(0x1f86, this.f1angle);
        break;
      case 0x22: {
        // trapezoid
        const angle1 = this.rd16(0x1f8c) & 0x1ff;
        const angle2 = this.rd16(0x1f8f) & 0x1ff;
        const tan1 = C4_COS[angle1] !== 0 ? Math.trunc((C4_SIN[angle1]! << 16) / C4_COS[angle1]!) : -0x80000000;
        const tan2 = C4_COS[angle2] !== 0 ? Math.trunc((C4_SIN[angle2]! << 16) / C4_COS[angle2]!) : -0x80000000;
        let y = s16(this.rd16(0x1f83) - this.rd16(0x1f89));
        for (let j = 0; j < 225; j++) {
          let left: number;
          let right: number;
          if (y >= 0) {
            left = ((tan1 * y) >> 16) - this.rd16(0x1f80) + this.rd16(0x1f86);
            right = ((tan2 * y) >> 16) - this.rd16(0x1f80) + this.rd16(0x1f86) + this.rd16(0x1f93);
            if (left < 0 && right < 0) {
              left = 1;
              right = 0;
            } else if (left < 0) left = 0;
            else if (right < 0) right = 0;
            if (left > 255 && right > 255) {
              left = 255;
              right = 254;
            } else if (left > 255) left = 255;
            else if (right > 255) right = 255;
          } else {
            left = 1;
            right = 0;
          }
          this.ram[j + 0x800] = left & 0xff;
          this.ram[j + 0x900] = right & 0xff;
          y = s16(y + 1);
        }
        break;
      }
      case 0x25: {
        // multiply
        const foo = this.rd24signed(0x1f80) * this.rd24signed(0x1f83);
        this.wr24(0x1f80, foo);
        break;
      }
      case 0x2d: // transform coords
        this.wfx = this.rd16s(0x1f81);
        this.wfy = this.rd16s(0x1f84);
        this.wfz = this.rd16s(0x1f87);
        this.wfx2 = this.ram[0x1f89]!;
        this.wfy2 = this.ram[0x1f8a]!;
        this.wfDist = this.ram[0x1f8b]!;
        this.wfScale = this.rd16(0x1f90);
        this.transfWireFrame2();
        this.wr16(0x1f80, this.wfx);
        this.wr16(0x1f83, this.wfy);
        break;
      case 0x40: {
        // sum
        let sum = 0;
        for (let i = 0; i < 0x800; i++) sum += this.ram[i]!;
        this.wr16(0x1f80, sum & 0xffff);
        break;
      }
      case 0x54: {
        // square
        let a = this.rd24signed(0x1f80);
        a = a * a;
        this.wr24(0x1f83, a);
        this.wr24(0x1f86, Math.trunc(a / 0x1000000));
        break;
      }
      case 0x5c: // immediate reg (test pattern)
        this.ram.set(TEST_PATTERN, 0);
        break;
      case 0x89: // immediate ROM (version id)
        this.ram[0x1f80] = 0x36;
        this.ram[0x1f81] = 0x43;
        this.ram[0x1f82] = 0x05;
        break;
    }
  }

  /** 24-bit RAM read, sign-extended from bit 23. */
  private rd24signed(o: number): number {
    const v = this.rd24(o);
    return v & 0x800000 ? v - 0x1000000 : v;
  }

  serialize(w: SnesStateWriter): void {
    w.bytes(this.ram);
  }

  deserialize(r: SnesStateReader): void {
    r.bytes(this.ram);
  }
}
