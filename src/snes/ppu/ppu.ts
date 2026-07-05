/**
 * S-PPU — scanline renderer.
 *
 * BG modes 0-7: tile modes with 2/4/8bpp planar characters, 8×8 and 16×16
 * tiles, all four tilemap layouts, scrolling, per-tile priority + flips;
 * Mode 7's affine-transformed 128×128 playfield with its screen-over
 * behaviours and the M7A×M7B hardware multiplier. OBJ sprites in all OBSEL
 * size pairs. Composition runs main screen and sub screen per scanline,
 * applies the two rectangular windows (per-layer enable/invert + combine
 * logic, main/sub masking, colour-window clip/prevent regions), and colour
 * math (add/subtract, half, per-layer enables, sub-screen or fixed-colour
 * operand) into a 256×224 RGBA framebuffer.
 *
 * Still pending: interlace, EXTBG, and a true 512-wide hires framebuffer
 * (modes 5/6 blend hires pairs into 256). Overscan (SETINI bit2) moves the
 * VBlank/NMI onset to line 240 but the frame stays cropped to 224 lines.
 * Ports: full VRAM/CGRAM/OAM behaviour incl. VMAIN
 * increment/remap modes and the read-prefetch dummy-read quirk.
 *
 * Reference: fullsnes "SNES PPU".
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

const CYCLES_PER_LINE = 1364;
export const VISIBLE_LINES = 224;
export const NTSC_TOTAL_LINES = 262;
export const PAL_TOTAL_LINES = 312;
/** @deprecated NTSC constant kept for callers that predate PAL support. */
export const TOTAL_LINES = NTSC_TOTAL_LINES;

/** Composition source indices. */
const enum Src {
  Bg1 = 0,
  Bg2 = 1,
  Bg3 = 2,
  Bg4 = 3,
  Obj = 4,
  ObjNoMath = 5,
  Backdrop = 6
}

interface Layer {
  readonly color: Uint16Array;
  readonly prio: Float64Array;
  readonly src: Int8Array;
}

function makeLayer(): Layer {
  return { color: new Uint16Array(256), prio: new Float64Array(256), src: new Int8Array(256) };
}

export class SnesPpu {
  /** Scanlines per field — 262 NTSC, 312 PAL. */
  readonly totalLines: number;
  private readonly pal: boolean;

  constructor(region: "ntsc" | "pal" = "ntsc") {
    this.pal = region === "pal";
    this.totalLines = this.pal ? PAL_TOTAL_LINES : NTSC_TOTAL_LINES;
  }

  readonly vram = new Uint8Array(0x10000);
  readonly cgram = new Uint8Array(0x200);
  readonly oam = new Uint8Array(0x220);

  /** 256×224 RGBA output. */
  readonly framebuffer = new Uint8ClampedArray(256 * VISIBLE_LINES * 4);

  // $2100 INIDISP
  forceBlank = true;
  brightness = 0;

  // $2101 OBSEL
  private obsel = 0;

  // $2102-$2104 OAM port
  private oamAddr = 0;
  private oamLatch = 0;

  // $2133 SETINI: bit3 pseudo-hires is honoured (blended); bit2 overscan
  // drives the VBlank/NMI onset (see activeDisplayLines) though the frame
  // stays 224 lines; interlace and EXTBG are stored but not yet rendered.
  private setini = 0;
  // Even/odd frame flag (STAT78 bit 7) — toggles every field regardless of
  // interlace mode; test ROMs spin on its edge to align with a frame.
  private field = 0;
  // $213E STAT77 bits 6/7: sprite time-over / range-over on the last line.
  private objRangeOver = false;
  private objTimeOver = false;

  // $2106 MOSAIC: per-BG enable bits + block size (1-16)
  private mosaicEnable = 0;
  private mosaicSize = 1;

  // $2105 BGMODE / $2106 MOSAIC
  bgMode = 0;
  private bg3Priority = false;
  private tileSize16 = [false, false, false, false];

  // $2107-$210C bases
  private tilemapBase = [0, 0, 0, 0];
  private tilemapSize = [0, 0, 0, 0];
  private chrBase = [0, 0, 0, 0];

  // $210D-$2114 scroll (dual-write via shared prev latch)
  private hofs = [0, 0, 0, 0];
  private vofs = [0, 0, 0, 0];
  private scrollPrev = 0;

  // Mode 7 ($211A-$2120 + $210D/$210E through the M7 latch)
  private m7sel = 0;
  private m7a = 0;
  private m7b = 0;
  private m7c = 0;
  private m7d = 0;
  private m7x = 0;
  private m7y = 0;
  private m7hofs = 0;
  private m7vofs = 0;
  private m7Prev = 0;
  private m7bLast = 0;

  // $2115-$2119 / $2139-$213A VRAM port
  private vmain = 0;
  private vmadd = 0;
  private vramPrefetch = 0;

  // $2137/$213C-$213F H/V latch counters
  private latchedH = 0;
  private latchedV = 0;
  private latchFlag = false;
  private ophctHigh = false;
  private opvctHigh = false;

  // $2121-$2122 / $213B CGRAM port
  private cgadd = 0;
  private cgLatch = 0;
  private cgSecond = false;

  // $2123-$212B windows
  private w12sel = 0;
  private w34sel = 0;
  private wobjsel = 0;
  private wh = [0, 0, 0, 0];
  private wbglog = 0;
  private wobjlog = 0;

  // $212C-$212F screens
  private mainScreen = 0;
  private subScreen = 0;
  private mainWindowMask = 0;
  private subWindowMask = 0;

  // $2130-$2132 colour math
  private cgwsel = 0;
  private cgadsub = 0;
  private fixedR = 0;
  private fixedG = 0;
  private fixedB = 0;

  private line = 0;
  private lineCycles = 0;

  nmiFlag = false;
  inVBlank = false;

  /** Fires when the tick span crosses into VBlank. `cyclesAgo` is how many
   *  master cycles before the span's end the edge actually rose — lets the
   *  console stamp the true NMI edge time for interrupt-sample ordering. */
  onVBlankStart: ((cyclesAgo: number) => void) | null = null;
  /** Fires when line N's cycle budget completes, just before N renders —
   *  HDMA writes must land before the whole-line renderer runs. Temporally
   *  this is the END of line N; use onLineBegin for wall-clock line starts. */
  onScanlineStart: ((line: number) => void) | null = null;
  /** Fires the moment a line begins (wall-clock accurate) — H/V IRQ. */
  onLineBegin: ((line: number) => void) | null = null;
  /** H/V timer: fires when the beam crosses `hTimerDot` on `hTimerLine`
   *  (-1 = every line). Disabled when hTimerDot < 0. */
  onHTimer: (() => void) | null = null;
  hTimerDot = -1;
  hTimerLine = -1;
  private hTimerDone = false;
  /** DRAM refresh already generated for the current scanline. */
  private refreshDone = false;
  private pendingRefreshes = 0;

  serialize(w: SnesStateWriter): void {
    w.bytes(this.vram);
    w.bytes(this.cgram);
    w.bytes(this.oam);
    w.bool(this.forceBlank);
    w.u8(this.brightness);
    w.u8(this.obsel);
    w.u16(this.oamAddr);
    w.u8(this.oamLatch);
    w.u8(this.bgMode);
    w.bool(this.bg3Priority);
    w.u8(this.mosaicEnable);
    w.u8(this.mosaicSize);
    w.u8(this.setini);
    w.u8(this.field);
    w.bool(this.hTimerDone);
    w.bool(this.refreshDone);
    w.bool(this.objRangeOver);
    w.bool(this.objTimeOver);
    for (let i = 0; i < 4; i++) w.bool(this.tileSize16[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.tilemapBase[i]!);
    for (let i = 0; i < 4; i++) w.u8(this.tilemapSize[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.chrBase[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.hofs[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.vofs[i]!);
    w.u8(this.scrollPrev);
    w.u8(this.m7sel);
    w.u16(this.m7a);
    w.u16(this.m7b);
    w.u16(this.m7c);
    w.u16(this.m7d);
    w.u16(this.m7x);
    w.u16(this.m7y);
    w.u16(this.m7hofs);
    w.u16(this.m7vofs);
    w.u8(this.m7Prev);
    w.u8(this.m7bLast);
    w.u16(this.latchedH);
    w.u16(this.latchedV);
    w.bool(this.latchFlag);
    w.bool(this.ophctHigh);
    w.bool(this.opvctHigh);
    w.u8(this.vmain);
    w.u16(this.vmadd);
    w.u16(this.vramPrefetch);
    w.u8(this.cgadd);
    w.u8(this.cgLatch);
    w.bool(this.cgSecond);
    w.u8(this.w12sel);
    w.u8(this.w34sel);
    w.u8(this.wobjsel);
    for (let i = 0; i < 4; i++) w.u8(this.wh[i]!);
    w.u8(this.wbglog);
    w.u8(this.wobjlog);
    w.u8(this.mainScreen);
    w.u8(this.subScreen);
    w.u8(this.mainWindowMask);
    w.u8(this.subWindowMask);
    w.u8(this.cgwsel);
    w.u8(this.cgadsub);
    w.u8(this.fixedR);
    w.u8(this.fixedG);
    w.u8(this.fixedB);
    w.u16(this.line);
    w.u16(this.lineCycles);
    w.bool(this.nmiFlag);
    w.bool(this.inVBlank);
  }

  deserialize(r: SnesStateReader): void {
    r.bytes(this.vram);
    r.bytes(this.cgram);
    r.bytes(this.oam);
    this.forceBlank = r.bool();
    this.brightness = r.u8();
    this.obsel = r.u8();
    this.oamAddr = r.u16();
    this.oamLatch = r.u8();
    this.bgMode = r.u8();
    this.bg3Priority = r.bool();
    this.mosaicEnable = r.u8();
    this.mosaicSize = r.u8();
    this.setini = r.u8();
    this.field = r.u8();
    this.hTimerDone = r.bool();
    this.refreshDone = r.bool();
    this.pendingRefreshes = 0;
    this.objRangeOver = r.bool();
    this.objTimeOver = r.bool();
    for (let i = 0; i < 4; i++) this.tileSize16[i] = r.bool();
    for (let i = 0; i < 4; i++) this.tilemapBase[i] = r.u16();
    for (let i = 0; i < 4; i++) this.tilemapSize[i] = r.u8();
    for (let i = 0; i < 4; i++) this.chrBase[i] = r.u16();
    for (let i = 0; i < 4; i++) this.hofs[i] = r.u16();
    for (let i = 0; i < 4; i++) this.vofs[i] = r.u16();
    this.scrollPrev = r.u8();
    this.m7sel = r.u8();
    this.m7a = r.u16();
    this.m7b = r.u16();
    this.m7c = r.u16();
    this.m7d = r.u16();
    this.m7x = r.u16();
    this.m7y = r.u16();
    this.m7hofs = r.u16();
    this.m7vofs = r.u16();
    this.m7Prev = r.u8();
    this.m7bLast = r.u8();
    this.latchedH = r.u16();
    this.latchedV = r.u16();
    this.latchFlag = r.bool();
    this.ophctHigh = r.bool();
    this.opvctHigh = r.bool();
    this.vmain = r.u8();
    this.vmadd = r.u16();
    this.vramPrefetch = r.u16();
    this.cgadd = r.u8();
    this.cgLatch = r.u8();
    this.cgSecond = r.bool();
    this.w12sel = r.u8();
    this.w34sel = r.u8();
    this.wobjsel = r.u8();
    for (let i = 0; i < 4; i++) this.wh[i] = r.u8();
    this.wbglog = r.u8();
    this.wobjlog = r.u8();
    this.mainScreen = r.u8();
    this.subScreen = r.u8();
    this.mainWindowMask = r.u8();
    this.subWindowMask = r.u8();
    this.cgwsel = r.u8();
    this.cgadsub = r.u8();
    this.fixedR = r.u8();
    this.fixedG = r.u8();
    this.fixedB = r.u8();
    this.line = r.u16();
    this.lineCycles = r.u16();
    this.nmiFlag = r.bool();
    this.inVBlank = r.bool();
  }

  tick(masterCycles: number): void {
    this.lineCycles += masterCycles;
    this.checkHTimer();
    this.checkRefresh();
    let len = this.currentLineLength();
    while (this.lineCycles >= len) {
      this.lineCycles -= len;
      this.onScanlineStart?.(this.line);
      if (this.line < VISIBLE_LINES) this.renderLine(this.line);
      this.line++;
      if (this.line === this.activeDisplayLines + 1) {
        this.inVBlank = true;
        this.nmiFlag = true;
        this.onVBlankStart?.(this.lineCycles);
      }
      if (this.line >= this.totalLines) {
        this.line = 0;
        this.inVBlank = false;
        this.objRangeOver = false;
        this.objTimeOver = false;
        this.field ^= 1;
        this.onLineBegin?.(0);
      } else {
        this.onLineBegin?.(this.line);
      }
      this.hTimerDone = false;
      this.refreshDone = false;
      this.checkHTimer();
      this.checkRefresh();
      len = this.currentLineLength();
    }
  }

  /** NTSC non-interlace: line 240 of every other field is 4 master cycles
   *  short (the source of the 60.0988 Hz field rate). The slippage is
   *  load-bearing beyond the frame rate: it decommensurates beam-position
   *  poll loops from the line period, so a loop whose sampling pattern
   *  aliases past a narrow H window (Star Fox's $5A-$63 wait) drifts into
   *  it like hardware instead of missing it forever. */
  private currentLineLength(): number {
    return !this.pal && this.field === 1 && this.line === 240 ? CYCLES_PER_LINE - 4 : CYCLES_PER_LINE;
  }

  /** DRAM refresh: the S-CPU stalls 40 master cycles at ~H=133 (master 538)
   *  of every scanline. The PPU generates the events since it owns line
   *  phase; the console applies the stall to the CPU. */
  private checkRefresh(): void {
    if (!this.refreshDone && this.lineCycles >= 538) {
      this.refreshDone = true;
      this.pendingRefreshes++;
    }
  }

  /** Consume DRAM-refresh stalls crossed since the last call (one per
   *  scanline; 40 master cycles each). */
  takeRefreshStalls(): number {
    const n = this.pendingRefreshes;
    this.pendingRefreshes = 0;
    return n;
  }

  /** Fire the H/V timer once per matching line when the beam position
   *  (master cycles into the line, 4 per dot) crosses the target dot. */
  private checkHTimer(): void {
    if (this.hTimerDone || this.hTimerDot < 0 || this.onHTimer === null) return;
    if (this.hTimerLine >= 0 && this.line !== this.hTimerLine) return;
    // Hardware triggers ~3.5 dots after the HTIME match point.
    const at = this.hTimerDot * 4 + 14;
    if (this.lineCycles >= at || this.lineCycles >= CYCLES_PER_LINE) {
      this.hTimerDone = true;
      this.onHTimer();
    }
  }

  get scanline(): number {
    return this.line;
  }

  /** Active display height: 224 lines normally, 239 when SETINI's overscan
   *  bit (bit2) is set. Overscan moves the VBlank/NMI onset down to line 240,
   *  which some carts (PAL Super Mario Kart) rely on: their end-of-frame IRQ
   *  fires at line ~234 and must run *before* the VBlank handler re-arms the
   *  next frame, not after it. */
  get activeDisplayLines(): number {
    return (this.setini & 0x04) !== 0 ? 239 : VISIBLE_LINES;
  }

  /** H-blank ($4212 bit 6): the tail of every scanline past the active
   *  display region (~dot 274 of 341). */
  get inHBlank(): boolean {
    return this.lineCycles >= 1096;
  }

  // ── MMIO ($21xx) ──────────────────────────────────────────────────────

  readReg(addr: number): number | null {
    switch (addr) {
      case 0x213e: // STAT77: PPU1 version 1, sprite overflow flags
        return 0x01 | (this.objRangeOver ? 0x40 : 0) | (this.objTimeOver ? 0x80 : 0);
      case 0x2137: // SLHV — software-latch the H/V counters
        this.latchedH = (this.lineCycles >> 2) & 0x1ff; // dot ≈ master/4
        this.latchedV = this.line & 0x1ff;
        this.latchFlag = true;
        return null; // open bus
      case 0x213c: {
        const v = this.ophctHigh ? (this.latchedH >> 8) & 1 : this.latchedH & 0xff;
        this.ophctHigh = !this.ophctHigh;
        return v;
      }
      case 0x213d: {
        const v = this.opvctHigh ? (this.latchedV >> 8) & 1 : this.latchedV & 0xff;
        this.opvctHigh = !this.opvctHigh;
        return v;
      }
      case 0x213f: {
        // STAT78: PPU2 version 2; bit4 = PAL console; bit6 = external-latch
        // flag (clears on read, which also resets the OPHCT/OPVCT toggles);
        // bit7 = even/odd field.
        const v = 0x02 | (this.pal ? 0x10 : 0) | (this.latchFlag ? 0x40 : 0) | (this.field ? 0x80 : 0);
        this.latchFlag = false;
        this.ophctHigh = false;
        this.opvctHigh = false;
        return v;
      }
      case 0x2134:
        return this.m7Product() & 0xff;
      case 0x2135:
        return (this.m7Product() >> 8) & 0xff;
      case 0x2136:
        return (this.m7Product() >> 16) & 0xff;
      case 0x2139: {
        const v = this.vramPrefetch & 0xff;
        if ((this.vmain & 0x80) === 0) this.vramStepRead();
        return v;
      }
      case 0x213a: {
        const v = this.vramPrefetch >> 8;
        if ((this.vmain & 0x80) !== 0) this.vramStepRead();
        return v;
      }
      case 0x213b: {
        const v = this.cgram[(this.cgadd << 1) | (this.cgSecond ? 1 : 0)]!;
        if (this.cgSecond) this.cgadd = (this.cgadd + 1) & 0xff;
        this.cgSecond = !this.cgSecond;
        return this.cgSecond ? v : v & 0x7f;
      }
      case 0x2138: {
        const v = this.oam[this.oamAddr < 0x200 ? this.oamAddr : 0x200 | (this.oamAddr & 0x1f)]!;
        this.oamAddr = (this.oamAddr + 1) & 0x3ff;
        return v;
      }
      default:
        return null;
    }
  }

  /** MPYL/M/H ($2134-$2136): M7A (16-bit signed) × the last M7B byte. */
  private m7Product(): number {
    const a = (this.m7a << 16) >> 16;
    const b = (this.m7bLast << 24) >> 24;
    return (a * b) & 0xffffff;
  }

  writeReg(addr: number, v: number): void {
    switch (addr) {
      case 0x2100:
        this.forceBlank = (v & 0x80) !== 0;
        this.brightness = v & 0x0f;
        break;
      case 0x2101:
        this.obsel = v;
        break;
      case 0x2102:
        this.oamAddr = ((this.oamAddr & 0x200) | (v << 1)) & 0x3ff;
        break;
      case 0x2103:
        this.oamAddr = (((v & 1) << 9) | (this.oamAddr & 0x1fe)) & 0x3ff;
        break;
      case 0x2104:
        if (this.oamAddr < 0x200) {
          if ((this.oamAddr & 1) === 0) {
            this.oamLatch = v;
          } else {
            this.oam[this.oamAddr - 1] = this.oamLatch;
            this.oam[this.oamAddr] = v;
          }
        } else {
          this.oam[0x200 | (this.oamAddr & 0x1f)] = v;
        }
        this.oamAddr = (this.oamAddr + 1) & 0x3ff;
        break;
      case 0x2105:
        this.bgMode = v & 7;
        this.bg3Priority = (v & 0x08) !== 0;
        for (let i = 0; i < 4; i++) this.tileSize16[i] = (v & (0x10 << i)) !== 0;
        break;
      case 0x2133:
        this.setini = v;
        break;
      case 0x2106:
        this.mosaicEnable = v & 0x0f;
        this.mosaicSize = ((v >> 4) & 0x0f) + 1;
        break;
      case 0x2107:
      case 0x2108:
      case 0x2109:
      case 0x210a: {
        const bg = addr - 0x2107;
        this.tilemapBase[bg] = (v & 0xfc) << 8;
        this.tilemapSize[bg] = v & 3;
        break;
      }
      case 0x210b:
        this.chrBase[0] = (v & 0x0f) << 12;
        this.chrBase[1] = (v & 0xf0) << 8;
        break;
      case 0x210c:
        this.chrBase[2] = (v & 0x0f) << 12;
        this.chrBase[3] = (v & 0xf0) << 8;
        break;
      case 0x210d: // BG1HOFS — also writes M7HOFS through the M7 latch
        this.m7hofs = ((v << 8) | this.m7Prev) & 0x1fff;
        this.m7Prev = v;
        this.hofs[0] = ((v << 8) | (this.scrollPrev & ~7) | ((this.hofs[0]! >> 8) & 7)) & 0xffff;
        this.scrollPrev = v;
        break;
      case 0x210e:
        this.m7vofs = ((v << 8) | this.m7Prev) & 0x1fff;
        this.m7Prev = v;
        this.vofs[0] = ((v << 8) | this.scrollPrev) & 0xffff;
        this.scrollPrev = v;
        break;
      case 0x210f:
      case 0x2111:
      case 0x2113: {
        const bg = (addr - 0x210d) >> 1;
        this.hofs[bg] = ((v << 8) | (this.scrollPrev & ~7) | ((this.hofs[bg]! >> 8) & 7)) & 0xffff;
        this.scrollPrev = v;
        break;
      }
      case 0x2110:
      case 0x2112:
      case 0x2114: {
        const bg = (addr - 0x210e) >> 1;
        this.vofs[bg] = ((v << 8) | this.scrollPrev) & 0xffff;
        this.scrollPrev = v;
        break;
      }
      case 0x2115:
        this.vmain = v;
        break;
      case 0x2116:
        this.vmadd = (this.vmadd & 0xff00) | v;
        this.vramPrefetchLoad();
        break;
      case 0x2117:
        this.vmadd = (this.vmadd & 0x00ff) | (v << 8);
        this.vramPrefetchLoad();
        break;
      case 0x2118: {
        const a = this.vramWordAddr() << 1;
        this.vram[a] = v;
        if ((this.vmain & 0x80) === 0) this.vramStepWrite();
        break;
      }
      case 0x2119: {
        const a = this.vramWordAddr() << 1;
        this.vram[a + 1] = v;
        if ((this.vmain & 0x80) !== 0) this.vramStepWrite();
        break;
      }
      case 0x211a:
        this.m7sel = v;
        break;
      case 0x211b:
        this.m7a = ((v << 8) | this.m7Prev) & 0xffff;
        this.m7Prev = v;
        break;
      case 0x211c:
        this.m7b = ((v << 8) | this.m7Prev) & 0xffff;
        this.m7bLast = v;
        this.m7Prev = v;
        break;
      case 0x211d:
        this.m7c = ((v << 8) | this.m7Prev) & 0xffff;
        this.m7Prev = v;
        break;
      case 0x211e:
        this.m7d = ((v << 8) | this.m7Prev) & 0xffff;
        this.m7Prev = v;
        break;
      case 0x211f:
        this.m7x = ((v << 8) | this.m7Prev) & 0x1fff;
        this.m7Prev = v;
        break;
      case 0x2120:
        this.m7y = ((v << 8) | this.m7Prev) & 0x1fff;
        this.m7Prev = v;
        break;
      case 0x2121:
        this.cgadd = v;
        this.cgSecond = false;
        break;
      case 0x2122:
        if (!this.cgSecond) {
          this.cgLatch = v;
        } else {
          this.cgram[this.cgadd << 1] = this.cgLatch;
          this.cgram[(this.cgadd << 1) | 1] = v & 0x7f;
          this.cgadd = (this.cgadd + 1) & 0xff;
        }
        this.cgSecond = !this.cgSecond;
        break;
      case 0x2123:
        this.w12sel = v;
        break;
      case 0x2124:
        this.w34sel = v;
        break;
      case 0x2125:
        this.wobjsel = v;
        break;
      case 0x2126:
      case 0x2127:
      case 0x2128:
      case 0x2129:
        this.wh[addr - 0x2126] = v;
        break;
      case 0x212a:
        this.wbglog = v;
        break;
      case 0x212b:
        this.wobjlog = v;
        break;
      case 0x212c:
        this.mainScreen = v & 0x1f;
        break;
      case 0x212d:
        this.subScreen = v & 0x1f;
        break;
      case 0x212e:
        this.mainWindowMask = v & 0x1f;
        break;
      case 0x212f:
        this.subWindowMask = v & 0x1f;
        break;
      case 0x2130:
        this.cgwsel = v;
        break;
      case 0x2131:
        this.cgadsub = v;
        break;
      case 0x2132:
        if (v & 0x20) this.fixedR = v & 0x1f;
        if (v & 0x40) this.fixedG = v & 0x1f;
        if (v & 0x80) this.fixedB = v & 0x1f;
        break;
      default:
        break;
    }
  }

  // ── VRAM port helpers ─────────────────────────────────────────────────

  private vramStep(): number {
    switch (this.vmain & 3) {
      case 0:
        return 1;
      case 1:
        return 32;
      default:
        return 128;
    }
  }

  private vramWordAddr(): number {
    const a = this.vmadd & 0x7fff;
    switch ((this.vmain >> 2) & 3) {
      case 1:
        return (a & 0x7f00) | ((a & 0x1f) << 3) | ((a >> 5) & 7);
      case 2:
        return (a & 0x7e00) | ((a & 0x3f) << 3) | ((a >> 6) & 7);
      case 3:
        return (a & 0x7c00) | ((a & 0x7f) << 3) | ((a >> 7) & 7);
      default:
        return a;
    }
  }

  private vramStepWrite(): void {
    this.vmadd = (this.vmadd + this.vramStep()) & 0xffff;
  }

  private vramPrefetchLoad(): void {
    const a = this.vramWordAddr() << 1;
    this.vramPrefetch = this.vram[a]! | (this.vram[a + 1]! << 8);
  }

  private vramStepRead(): void {
    this.vramPrefetchLoad();
    this.vmadd = (this.vmadd + this.vramStep()) & 0xffff;
  }

  // ── windows ───────────────────────────────────────────────────────────

  /** Per-layer window membership for one scanline. Index: 0-3 BG, 4 OBJ,
   *  5 the colour window. */
  private readonly windowFlags = [
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256)
  ];

  private computeWindows(): void {
    for (let layer = 0; layer < 6; layer++) {
      const sel =
        layer < 2
          ? this.w12sel >> (layer * 4)
          : layer < 4
            ? this.w34sel >> ((layer - 2) * 4)
            : this.wobjsel >> ((layer - 4) * 4);
      const w1Enable = (sel & 2) !== 0;
      const w1Invert = (sel & 1) !== 0;
      const w2Enable = (sel & 8) !== 0;
      const w2Invert = (sel & 4) !== 0;
      const flags = this.windowFlags[layer]!;
      if (!w1Enable && !w2Enable) {
        flags.fill(0);
        continue;
      }
      const logic = layer < 4 ? (this.wbglog >> (layer * 2)) & 3 : (this.wobjlog >> ((layer - 4) * 2)) & 3;
      const l1 = this.wh[0]!;
      const r1 = this.wh[1]!;
      const l2 = this.wh[2]!;
      const r2 = this.wh[3]!;
      for (let x = 0; x < 256; x++) {
        let inside: boolean;
        if (w1Enable && w2Enable) {
          const a = (x >= l1 && x <= r1) !== w1Invert;
          const b = (x >= l2 && x <= r2) !== w2Invert;
          inside = logic === 0 ? a || b : logic === 1 ? a && b : logic === 2 ? a !== b : a === b;
        } else if (w1Enable) {
          inside = (x >= l1 && x <= r1) !== w1Invert;
        } else {
          inside = (x >= l2 && x <= r2) !== w2Invert;
        }
        flags[x] = inside ? 1 : 0;
      }
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private readonly main = makeLayer();
  private readonly sub = makeLayer();

  private renderLine(y: number): void {
    const out = this.framebuffer;
    const base = y * 256 * 4;
    if (this.forceBlank) {
      for (let x = 0; x < 256; x++) {
        const o = base + x * 4;
        out[o] = out[o + 1] = out[o + 2] = 0;
        out[o + 3] = 255;
      }
      return;
    }

    this.computeWindows();

    const backdrop = this.cgram[0]! | (this.cgram[1]! << 8);
    this.main.color.fill(backdrop);
    this.main.prio.fill(-1);
    this.main.src.fill(Src.Backdrop);

    this.composeScreen(y, this.main, this.mainScreen, this.mainWindowMask);
    const useSub = (this.cgwsel & 0x02) !== 0;
    // Pseudo-hires ($2133 bit 3): the sub screen fills the odd hires
    // columns; on this 256-wide output the two screens blend per pixel.
    const pseudoHires = (this.setini & 0x08) !== 0;
    if (useSub || pseudoHires) {
      this.sub.color.fill(this.cgram[0]! | (this.cgram[1]! << 8));
      this.sub.prio.fill(-1);
      this.sub.src.fill(Src.Backdrop);
      this.composeScreen(y, this.sub, this.subScreen, this.subWindowMask);
    }

    const subtract = (this.cgadsub & 0x80) !== 0;
    const half = (this.cgadsub & 0x40) !== 0;
    const clipMode = (this.cgwsel >> 6) & 3;
    const preventMode = (this.cgwsel >> 4) & 3;
    const colorWin = this.windowFlags[5]!;
    const bright = this.brightness / 15;

    for (let x = 0; x < 256; x++) {
      const inColorWin = colorWin[x] === 1;
      const clip = clipMode === 3 || (clipMode === 1 && !inColorWin) || (clipMode === 2 && inColorWin);
      const prevent = preventMode === 3 || (preventMode === 1 && !inColorWin) || (preventMode === 2 && inColorWin);

      const c = clip ? 0 : this.main.color[x]!;
      let r = c & 0x1f;
      let g = (c >> 5) & 0x1f;
      let b = (c >> 10) & 0x1f;

      const src = this.main.src[x]!;
      const mathEnabled =
        !prevent &&
        (src === Src.Backdrop
          ? (this.cgadsub & 0x20) !== 0
          : src === Src.Obj
            ? (this.cgadsub & 0x10) !== 0
            : src <= Src.Bg4 && (this.cgadsub & (1 << src)) !== 0);

      if (mathEnabled) {
        let or: number;
        let og: number;
        let ob: number;
        let halve = half && !clip;
        if (useSub && this.sub.src[x]! !== Src.Backdrop) {
          const sc = this.sub.color[x]!;
          or = sc & 0x1f;
          og = (sc >> 5) & 0x1f;
          ob = (sc >> 10) & 0x1f;
        } else {
          or = this.fixedR;
          og = this.fixedG;
          ob = this.fixedB;
          if (useSub) halve = false; // fixed-colour fallback is never halved
        }
        if (subtract) {
          r -= or;
          g -= og;
          b -= ob;
        } else {
          r += or;
          g += og;
          b += ob;
        }
        if (halve) {
          r >>= 1;
          g >>= 1;
          b >>= 1;
        }
        r = Math.max(0, Math.min(31, r));
        g = Math.max(0, Math.min(31, g));
        b = Math.max(0, Math.min(31, b));
      }

      if (pseudoHires) {
        const sc = this.sub.color[x]!;
        r = (r + (sc & 0x1f)) >> 1;
        g = (g + ((sc >> 5) & 0x1f)) >> 1;
        b = (b + ((sc >> 10) & 0x1f)) >> 1;
      }

      const o = base + x * 4;
      out[o] = (r << 3) * bright;
      out[o + 1] = (g << 3) * bright;
      out[o + 2] = (b << 3) * bright;
      out[o + 3] = 255;
    }
  }

  /** Compose all enabled layers of one screen (main or sub). */
  private composeScreen(y: number, target: Layer, enables: number, windowMask: number): void {
    if (this.bgMode === 0) {
      this.drawBg(0, y, 2, [6, 9], target, enables, windowMask);
      this.drawBg(1, y, 2, [5, 8], target, enables, windowMask);
      this.drawBg(2, y, 2, [2, 4], target, enables, windowMask);
      this.drawBg(3, y, 2, [1, 3], target, enables, windowMask);
      this.drawObjLine(y, [0, 3.5, 7, 10], target, enables, windowMask);
    } else if (this.bgMode === 1) {
      this.drawBg(0, y, 4, [4, 7], target, enables, windowMask);
      this.drawBg(1, y, 4, [3, 6], target, enables, windowMask);
      this.drawBg(2, y, 2, this.bg3Priority ? [1, 10] : [1, 2], target, enables, windowMask);
      // OBJ priority-0 outranks low-priority BG3 tiles (hardware order is
      // BG3.pri1 > OBJ.pri0 > BG3.pri0); rank 1.5 sits it between BG3's two
      // ranks so sprites show over a BG3 backdrop panel (Super Mario Kart's
      // mode-select menu text is exactly this case).
      this.drawObjLine(y, [1.5, 2.5, 5, 8], target, enables, windowMask);
    } else if (this.bgMode === 7) {
      this.drawMode7(y, [2, 2], target, enables, windowMask);
      this.drawObjLine(y, [1, 3, 4, 5], target, enables, windowMask);
    } else {
      // Modes 2-6 share one priority shape; bpp per mode:
      //   2: 4/4   3: 8/4   4: 8/2   5: 4/2 (hires)   6: 4/- (hires)
      const bpp1 = this.bgMode === 3 || this.bgMode === 4 ? 8 : 4;
      const bpp2 = this.bgMode === 2 || this.bgMode === 3 ? 4 : 2;
      const hires = this.bgMode === 5 || this.bgMode === 6;
      if (hires) {
        this.drawBgHires(0, y, bpp1, [3, 7], target, enables, windowMask);
        if (this.bgMode !== 6) this.drawBgHires(1, y, bpp2, [1, 5], target, enables, windowMask);
      } else {
        this.drawBg(0, y, bpp1, [3, 7], target, enables, windowMask);
        if (this.bgMode !== 6) this.drawBg(1, y, bpp2, [1, 5], target, enables, windowMask);
      }
      this.drawObjLine(y, [2, 4, 6, 8], target, enables, windowMask);
    }
  }

  private readonly optH = new Int32Array(33);
  private readonly optV = new Int32Array(33);

  /** Fetch a BG3 tilemap entry (by tile coordinates) for offset-per-tile. */
  private optEntry(tx: number, ty: number): number {
    let mapBase = this.tilemapBase[2]!;
    const size = this.tilemapSize[2]!;
    const screensWide = (size & 1) !== 0;
    const screensTall = (size & 2) !== 0;
    if (screensWide && (tx & 0x20) !== 0) mapBase += 0x400;
    if (screensTall && (ty & 0x20) !== 0) mapBase += screensWide ? 0x800 : 0x400;
    const addr = ((mapBase + (ty & 0x1f) * 32 + (tx & 0x1f)) & 0x7fff) << 1;
    return this.vram[addr]! | (this.vram[addr + 1]! << 8);
  }

  private drawBg(
    bg: number,
    y: number,
    bpp: number,
    prioRank: number[],
    target: Layer,
    enables: number,
    windowMask: number
  ): void {
    if ((enables & (1 << bg)) === 0) return;
    const windowed = (windowMask & (1 << bg)) !== 0;
    const winFlags = this.windowFlags[bg]!;
    const size16 = this.tileSize16[bg]!;
    const tilePx = size16 ? 16 : 8;
    // Mosaic quantizes the SAMPLING position to the block grid (anchored at
    // the screen origin); windows and priority still apply at the real x.
    const mosaic = (this.mosaicEnable & (1 << bg)) !== 0 ? this.mosaicSize : 1;
    const effY = mosaic > 1 ? y - (y % mosaic) : y;
    const baseVScroll = (effY + (this.vofs[bg]! & 0x3ff)) & 0x3ff;
    const hScrollBase = this.hofs[bg]! & 0x3ff;

    // Offset-per-tile (modes 2/4, BG1/BG2): BG3's tilemap supplies per-
    // 8-px-column scroll overrides. The leftmost (partial) column is never
    // overridden; entry bits 13/14 select which BG the override applies to,
    // and in mode 4 bit 15 picks H or V (modes 2 fetches both, the V entry
    // one map row below the H entry).
    const opt = bg <= 1 && (this.bgMode === 2 || this.bgMode === 4);
    let hOver: Int32Array | null = null;
    let vOver: Int32Array | null = null;
    if (opt) {
      hOver = this.optH;
      vOver = this.optV;
      hOver.fill(-1);
      vOver.fill(-1);
      const applyBit = bg === 0 ? 0x2000 : 0x4000;
      const bg3h = this.hofs[2]! & 0x3ff;
      const bg3v = this.vofs[2]! & 0x3ff;
      for (let col = 1; col <= 32; col++) {
        const hEntry = this.optEntry(((bg3h >> 3) + col - 1) & 0x7f, (bg3v >> 3) & 0x7f);
        if (this.bgMode === 4) {
          if ((hEntry & applyBit) !== 0) {
            if ((hEntry & 0x8000) !== 0) vOver[col] = hEntry & 0x3ff;
            else hOver[col] = hEntry & 0x3ff;
          }
        } else {
          const vEntry = this.optEntry(((bg3h >> 3) + col - 1) & 0x7f, ((bg3v + 8) >> 3) & 0x7f);
          if ((hEntry & applyBit) !== 0) hOver[col] = hEntry & 0x3ff;
          if ((vEntry & applyBit) !== 0) vOver[col] = vEntry & 0x3ff;
        }
      }
    }

    for (let x = 0; x < 256; x++) {
      if (windowed && winFlags[x] === 1) continue;
      const sx = mosaic > 1 ? x - (x % mosaic) : x;
      let vScroll = baseVScroll;
      let hBase = hScrollBase;
      if (opt) {
        const col = (x + (hScrollBase & 7)) >> 3;
        if (col > 0 && col <= 32) {
          const ho = hOver![col]!;
          const vo = vOver![col]!;
          // H override replaces the coarse scroll; fine bits stay the BG's own.
          if (ho >= 0) hBase = (ho & 0x3f8) | (hScrollBase & 7);
          if (vo >= 0) vScroll = (effY + vo) & 0x3ff;
        }
      }
      const wx = (sx + hBase) & 0x3ff;
      const tileX = (wx / tilePx) | 0;
      const tileY = (vScroll / tilePx) | 0;

      let mapBase = this.tilemapBase[bg]!;
      const size = this.tilemapSize[bg]!;
      const tx = tileX & (size16 ? 0x3f : 0x7f);
      const ty = tileY & (size16 ? 0x3f : 0x7f);
      const screensWide = (size & 1) !== 0;
      const screensTall = (size & 2) !== 0;
      const txWrap = tx & 0x1f;
      const tyWrap = ty & 0x1f;
      if (screensWide && (tx & 0x20) !== 0) mapBase += 0x400;
      if (screensTall && (ty & 0x20) !== 0) mapBase += screensWide ? 0x800 : 0x400;

      const entryAddr = ((mapBase + tyWrap * 32 + txWrap) & 0x7fff) << 1;
      const entry = this.vram[entryAddr]! | (this.vram[entryAddr + 1]! << 8);
      const tileNum = entry & 0x3ff;
      const palette = (entry >> 10) & 7;
      const priority = (entry & 0x2000) !== 0 ? 1 : 0;
      const hFlip = (entry & 0x4000) !== 0;
      const vFlip = (entry & 0x8000) !== 0;

      const rank = prioRank[priority]!;
      if (target.prio[x]! >= rank) continue;

      let inTileX = wx % tilePx;
      let inTileY = vScroll % tilePx;
      if (hFlip) inTileX = tilePx - 1 - inTileX;
      if (vFlip) inTileY = tilePx - 1 - inTileY;

      let chr = tileNum;
      if (size16) {
        if (inTileX >= 8) chr += 1;
        if (inTileY >= 8) chr += 16;
        inTileX &= 7;
        inTileY &= 7;
      }

      const pix = this.tilePixel(this.chrBase[bg]!, chr, inTileX, inTileY, bpp);
      if (pix === 0) continue;

      const palBase = bpp === 8 ? 0 : bpp === 2 ? (this.bgMode === 0 ? bg * 32 : 0) + palette * 4 : palette * 16;
      const cg = (palBase + pix) << 1;
      target.color[x] = this.cgram[cg]! | (this.cgram[cg + 1]! << 8);
      target.prio[x] = rank;
      target.src[x] = bg as Src;
    }
  }

  private tilePixel(chrBase: number, tile: number, px: number, py: number, bpp: number): number {
    const wordsPerTile = bpp * 4;
    const addr = ((chrBase + tile * wordsPerTile) & 0x7fff) << 1;
    const shift = 7 - px;
    let pix = 0;
    for (let plane = 0; plane < bpp; plane++) {
      const byte = this.vram[addr + py * 2 + ((plane >> 1) << 4) + (plane & 1)]!;
      pix |= ((byte >> shift) & 1) << plane;
    }
    return pix;
  }

  /** Mode 7: affine playfield. VRAM low bytes hold the 128×128 tilemap,
   *  high bytes the 8bpp characters. */
  /** Modes 5/6: backgrounds render at 512 horizontal pixels; on this
   *  256-wide output each screen pixel blends its hires pair — the standard
   *  way to show hires detail (thin text) without doubling the framebuffer.
   *  Tiles are 16 hires pixels wide (8-px CHR fetched twice as 8+8 via the
   *  tile-number LSB), scroll counts hires pixels. */
  private drawBgHires(
    bg: number,
    y: number,
    bpp: number,
    prioRank: number[],
    target: Layer,
    enables: number,
    windowMask: number
  ): void {
    if ((enables & (1 << bg)) === 0) return;
    const windowed = (windowMask & (1 << bg)) !== 0;
    const winFlags = this.windowFlags[bg]!;
    const size16 = this.tileSize16[bg]!;
    const tilePxY = size16 ? 16 : 8;
    const tilePxX = size16 ? 32 : 16; // hires-pixel width of one map tile
    const vScroll = (y + (this.vofs[bg]! & 0x3ff)) & 0x3ff;
    const hScrollBase = (this.hofs[bg]! << 1) & 0x7ff;

    for (let x = 0; x < 256; x++) {
      if (windowed && winFlags[x] === 1) continue;
      let blendR = 0;
      let blendG = 0;
      let blendB = 0;
      let opaque = 0;
      let rankSeen = -1;
      for (let half = 0; half < 2; half++) {
        const wx = ((x << 1) + half + hScrollBase) & 0x7ff;
        const tileX = (wx / tilePxX) | 0;
        const tileY = (vScroll / tilePxY) | 0;

        let mapBase = this.tilemapBase[bg]!;
        const size = this.tilemapSize[bg]!;
        const tx = tileX & (size16 ? 0x3f : 0x7f);
        const ty = tileY & (size16 ? 0x3f : 0x7f);
        const screensWide = (size & 1) !== 0;
        const screensTall = (size & 2) !== 0;
        if (screensWide && (tx & 0x20) !== 0) mapBase += 0x400;
        if (screensTall && (ty & 0x20) !== 0) mapBase += screensWide ? 0x800 : 0x400;

        const entryAddr = ((mapBase + (ty & 0x1f) * 32 + (tx & 0x1f)) & 0x7fff) << 1;
        const entry = this.vram[entryAddr]! | (this.vram[entryAddr + 1]! << 8);
        const tileNum = entry & 0x3ff;
        const palette = (entry >> 10) & 7;
        const priority = (entry & 0x2000) !== 0 ? 1 : 0;
        const hFlip = (entry & 0x4000) !== 0;
        const vFlip = (entry & 0x8000) !== 0;

        const rank = prioRank[priority]!;
        let inTileX = wx % tilePxX;
        let inTileY = vScroll % tilePxY;
        if (hFlip) inTileX = tilePxX - 1 - inTileX;
        if (vFlip) inTileY = tilePxY - 1 - inTileY;

        let chr = tileNum;
        if (inTileX >= (size16 ? 16 : 8)) {
          chr += 1;
          inTileX -= size16 ? 16 : 8;
        }
        if (size16 && inTileY >= 8) {
          chr += 16;
          inTileY &= 7;
        }
        // A map tile spans 16 hires pixels: the left half comes from chr,
        // the right half from chr+1 (like a horizontal size-16 tile).
        const subChr = (chr + (inTileX >= 8 ? 1 : 0)) & 0x3ff;
        const chrCol = inTileX & 7;

        const pix = this.tilePixel(this.chrBase[bg]!, subChr, chrCol, inTileY, bpp);
        if (pix === 0) continue;
        const palBase = bpp === 2 ? palette * 4 : palette * 16;
        const cg = (palBase + pix) << 1;
        const color = this.cgram[cg]! | (this.cgram[cg + 1]! << 8);
        blendR += color & 0x1f;
        blendG += (color >> 5) & 0x1f;
        blendB += (color >> 10) & 0x1f;
        opaque++;
        if (rank > rankSeen) rankSeen = rank;
      }
      if (opaque === 0) continue;
      if (target.prio[x]! >= rankSeen) continue;
      const r = (blendR / opaque) | 0;
      const g = (blendG / opaque) | 0;
      const b = (blendB / opaque) | 0;
      target.color[x] = r | (g << 5) | (b << 10);
      target.prio[x] = rankSeen;
      target.src[x] = bg as Src;
    }
  }

  private drawMode7(y: number, prioRank: number[], target: Layer, enables: number, windowMask: number): void {
    if ((enables & 1) === 0) return;
    const windowed = (windowMask & 1) !== 0;
    const winFlags = this.windowFlags[0]!;
    const rank = prioRank[0]!;

    const sext13 = (v: number): number => ((v & 0x1fff) << 19) >> 19;
    const a = (this.m7a << 16) >> 16;
    const b = (this.m7b << 16) >> 16;
    const c = (this.m7c << 16) >> 16;
    const d = (this.m7d << 16) >> 16;
    const cx = sext13(this.m7x);
    const cy = sext13(this.m7y);
    const hofs = sext13(this.m7hofs);
    const vofs = sext13(this.m7vofs);
    const screenOver = (this.m7sel >> 6) & 3;
    const hFlip = (this.m7sel & 1) !== 0;
    const vFlip = (this.m7sel & 2) !== 0;

    const mosaic = (this.mosaicEnable & 1) !== 0 ? this.mosaicSize : 1;
    const effY = mosaic > 1 ? y - (y % mosaic) : y;
    const sy = vFlip ? 255 - effY : effY;
    const oy = sy + vofs - cy;

    for (let x = 0; x < 256; x++) {
      if (windowed && winFlags[x] === 1) continue;
      if (target.prio[x]! >= rank) continue;
      const mx = mosaic > 1 ? x - (x % mosaic) : x;
      const sx = hFlip ? 255 - mx : mx;
      const ox = sx + hofs - cx;

      let vx = ((a * ox + b * oy) >> 8) + cx;
      let vy = ((c * ox + d * oy) >> 8) + cy;

      let tile: number;
      if (vx < 0 || vx > 1023 || vy < 0 || vy > 1023) {
        if (screenOver === 2) continue; // transparent outside the playfield
        if (screenOver === 3) {
          tile = 0; // tile-0 fill
        } else {
          vx &= 1023;
          vy &= 1023;
          tile = this.vram[(((vy >> 3) & 0x7f) * 128 + ((vx >> 3) & 0x7f)) << 1]!;
        }
      } else {
        tile = this.vram[(((vy >> 3) & 0x7f) * 128 + ((vx >> 3) & 0x7f)) << 1]!;
      }

      const pix = this.vram[((tile * 64 + (vy & 7) * 8 + (vx & 7)) << 1) + 1]!;
      if (pix === 0) continue;

      const cg = pix << 1;
      target.color[x] = this.cgram[cg]! | (this.cgram[cg + 1]! << 8);
      target.prio[x] = rank;
      target.src[x] = Src.Bg1;
    }
  }

  private static readonly OBJ_SIZES: readonly (readonly [number, number])[][] = [
    [
      [8, 8],
      [16, 16]
    ],
    [
      [8, 8],
      [32, 32]
    ],
    [
      [8, 8],
      [64, 64]
    ],
    [
      [16, 16],
      [32, 32]
    ],
    [
      [16, 16],
      [64, 64]
    ],
    [
      [32, 32],
      [64, 64]
    ],
    [
      [16, 32],
      [32, 64]
    ],
    [
      [16, 32],
      [32, 32]
    ]
  ];

  private drawObjLine(y: number, prioRank: number[], target: Layer, enables: number, windowMask: number): void {
    if ((enables & 0x10) === 0) return;
    const windowed = (windowMask & 0x10) !== 0;
    const winFlags = this.windowFlags[4]!;
    const sizes = SnesPpu.OBJ_SIZES[(this.obsel >> 5) & 7]!;
    const chrBase = (this.obsel & 7) << 13;
    const nameGap = ((this.obsel >> 3) & 3) << 12;

    // Hardware evaluates sprites low-index-first and stops PAST 32 in-range
    // sprites per line (range over) and 34 8-px tile slivers (time over);
    // the flags are readable in STAT77. Evaluation order is index order, so
    // collect the line's sprites first, then draw them back-to-front.
    const lineSprites: number[] = [];
    let tileSlivers = 0;
    for (let i = 0; i < 128; i++) {
      const o4 = i * 4;
      const hi4 = this.oam[0x200 + (i >> 2)]!;
      const hiBits4 = (hi4 >> ((i & 3) * 2)) & 3;
      let sx4 = this.oam[o4]! | ((hiBits4 & 1) << 8);
      if (sx4 >= 256) sx4 -= 512;
      const sy4 = this.oam[o4 + 1]!;
      const [w4, h4] = sizes[(hiBits4 >> 1) & 1]!;
      const row4 = (y - sy4 - 1) & 0xff;
      if (row4 >= h4) continue;
      if (sx4 <= -w4) continue; // fully off-screen left never enters range
      if (lineSprites.length === 32) {
        this.objRangeOver = true;
        break;
      }
      const spanTiles = Math.min(w4, 256 - Math.max(0, sx4), sx4 < 0 ? w4 + sx4 : w4) >> 3;
      if (tileSlivers + Math.max(1, spanTiles) > 34) {
        this.objTimeOver = true;
        // sprites past the tile budget drop their overflowing tiles; keep
        // the whole-sprite approximation simple: stop evaluating.
        break;
      }
      tileSlivers += Math.max(1, spanTiles);
      lineSprites.push(i);
    }

    for (let li = lineSprites.length - 1; li >= 0; li--) {
      const i = lineSprites[li]!;
      const o = i * 4;
      const hi = this.oam[0x200 + (i >> 2)]!;
      const hiBits = (hi >> ((i & 3) * 2)) & 3;
      let sx = this.oam[o]! | ((hiBits & 1) << 8);
      if (sx >= 256) sx -= 512;
      const sy = this.oam[o + 1]!;
      const [w, h] = sizes[(hiBits >> 1) & 1]!;
      const attr = this.oam[o + 3]!;
      const tile = this.oam[o + 2]! | ((attr & 1) << 8);

      let row = (y - sy - 1) & 0xff; // OBJ shows from the line after OAM Y
      if ((attr & 0x80) !== 0) row = h - 1 - row;

      const palette = (attr >> 1) & 7;
      const rank = prioRank[(attr >> 4) & 3]!;
      const hFlipObj = (attr & 0x40) !== 0;
      // Colour math only applies to sprites using palettes 4-7.
      const src = palette < 4 ? Src.ObjNoMath : Src.Obj;

      for (let px = 0; px < w; px++) {
        const x = sx + px;
        if (x < 0 || x >= 256) continue;
        if (windowed && winFlags[x] === 1) continue;
        if (target.prio[x]! >= rank || target.src[x] === Src.Obj || target.src[x] === Src.ObjNoMath) continue;

        const col = hFlipObj ? w - 1 - px : px;
        const chr = (tile + ((row >> 3) << 4) + (col >> 3)) & 0x1ff;
        const base = chr < 0x100 ? chrBase : chrBase + 0x1000 + nameGap;
        const pix = this.tilePixel(base, chr & 0xff, col & 7, row & 7, 4);
        if (pix === 0) continue;

        const cg = (128 + palette * 16 + pix) << 1;
        target.color[x] = this.cgram[cg]! | (this.cgram[cg + 1]! << 8);
        target.prio[x] = rank;
        target.src[x] = src;
      }
    }
  }
}
