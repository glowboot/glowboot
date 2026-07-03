/**
 * Ricoh 2C02 PPU — register interface, internal scroll/address state, memory,
 * and frame timing.
 *
 * Ported from the NESdev reference model (https://www.nesdev.org/wiki/PPU,
 * /PPU_scrolling, /PPU_rendering): the "loopy" registers v (current VRAM
 * address, 15-bit), t (temporary VRAM address), x (fine X scroll), and w (the
 * write toggle) drive both scrolling and $2006/$2007 access.
 *
 * The PPU owns palette RAM and OAM; pattern tables ($0000-$1FFF) and nametables
 * ($2000-$2FFF, whose mirroring the mapper controls) are reached through the
 * injected {@link PpuBus} so cartridge banking/mirroring stays in the mapper.
 *
 * Renders per-dot: the background fetch pipeline (NT/AT/pattern → shift
 * registers, muxed by fine X) and per-scanline sprite evaluation (8-sprite
 * limit, priority, flipping, 8×16, sprite-0 hit) compose into the RGBA
 * framebuffer.
 */

import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { NES_PALETTE } from "./palette.js";

/** The PPU's view of cartridge space: CHR ($0000-$1FFF) plus nametables
 *  ($2000-$2FFF) with mapper-controlled mirroring. Palettes are internal. */
export interface PpuBus {
  ppuRead(addr: number): number;
  ppuWrite(addr: number, value: number): void;
  /** MMC5 ExRAM extended-attribute mode (null when inactive): the per-BG-tile
   *  CHR bank + palette for the tile at nametable position `ntPos`. */
  extAttrTile?(ntPos: number): { bank: number; palette: number } | null;
  /** Whether {@link extAttrTile} routes to a real mapper hook. A bus that
   *  always exposes the method (the cartridge) sets this so non-MMC5 mappers
   *  skip the per-tile call; when absent, method presence decides. */
  hasExtAttr?: boolean;
  /** Direct 4 KiB-bank CHR fetch for an ext-attr BG pattern byte. */
  extAttrPattern?(bank: number, offset: number): number;
  /** Sprite-pattern CHR read — MMC5 banks sprites separately in 8×16 mode. */
  chrReadSprite?(addr: number): number;
  /** Notify the mapper of the sprite height (PPUCTRL bit 5). */
  setLargeSprites?(large: boolean): void;
}

export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 240;

const DOTS_PER_SCANLINE = 341;
const PRE_RENDER_SCANLINE = 261;
const VBLANK_START_SCANLINE = 241;

// PPUCTRL ($2000)
const CTRL_VRAM_INCREMENT = 0x04;
const CTRL_SPRITE_TABLE = 0x08; // 8×8 sprite pattern table
const CTRL_BG_TABLE = 0x10; // background pattern table
const CTRL_SPRITE_16 = 0x20; // 8×16 sprites
const CTRL_NMI_ENABLE = 0x80;

// PPUMASK ($2001)
const MASK_GREYSCALE = 0x01;
const MASK_BG_LEFT = 0x02; // show BG in leftmost 8 px
const MASK_SPRITE_LEFT = 0x04; // show sprites in leftmost 8 px
const MASK_SHOW_BG = 0x08;
const MASK_SHOW_SPRITES = 0x10;

// PPUSTATUS ($2002)
const STATUS_OVERFLOW = 0x20;
const STATUS_SPRITE0 = 0x40;
const STATUS_VBLANK = 0x80;

// OAM sprite attribute byte.
const OAM_ATTR_PALETTE = 0x03;
const OAM_ATTR_BEHIND = 0x20; // priority: sprite behind background
const OAM_ATTR_FLIP_H = 0x40;
const OAM_ATTR_FLIP_V = 0x80;

const MAX_SPRITES_PER_LINE = 8;

// An MMC3-style A12 rising edge only counts once A12 has been low for a few PPU
// dots — long enough to ignore the rapid toggles within a single tile fetch.
const A12_FILTER_DOTS = 8;

// The PPU I/O bus behaves like a capacitor: reads of write-only registers (and
// the unimplemented bits of $2002/$2004/$2007) return the last value driven
// onto it, and each bit decays back to 0 after roughly 600 ms if it isn't
// re-driven. blargg's ppu_open_bus requires the latch to reach 0 within one
// second, while a partial read (e.g. $2002 drives only bits 7-5) leaves the
// other bits decaying — so every bit is timed on its own frame stamp. ~36
// frames ≈ 600 ms at the NTSC frame rate, safely inside the one-second bound.
const OPEN_BUS_DECAY_FRAMES = 36;

export class PPU {
  /** RGBA8888 framebuffer — 256 × 240 × 4 bytes. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  private readonly fb32 = new Uint32Array(
    this.framebuffer.buffer,
    this.framebuffer.byteOffset,
    SCREEN_WIDTH * SCREEN_HEIGHT
  );

  /** Called once per rendered scanline at the A12-rise point, for mappers with
   *  a scanline IRQ counter (MMC3). Null when the cartridge has no such IRQ. */
  mapperClock: (() => void) | null = null;

  /** Completed-frame counter; bumped at the start of each new frame. */
  frame = 0;
  /** Current scanline (0-239 visible, 240 post-render, 241-260 VBlank, 261
   *  pre-render on NTSC; PAL adds 50 VBlank lines and ends at 311) and dot
   *  (0-340). */
  scanline = 0;
  dot = 0;

  // Regional frame geometry — NTSC by default; the owning Nes applies the
  // cart's region via setTiming. PAL has 312 lines (pre-render 311) and never
  // drops the odd-frame dot.
  private preRenderScanline = PRE_RENDER_SCANLINE;
  private oddFrameSkip = true;

  private ctrl = 0;
  private mask = 0;
  private status = 0;
  private oamAddr = 0;

  // Loopy scroll/address registers.
  private v = 0; // current VRAM address (15-bit)
  private t = 0; // temporary VRAM address
  private fineX = 0; // 3-bit fine X scroll
  private writeToggle = 0; // shared $2005/$2006 latch (w)

  private readBuffer = 0; // $2007 read is delayed by one fetch
  private openBus = 0; // PPU I/O open-bus latch (drives write-only-register reads)
  private readonly openBusDecay = new Int32Array(8); // per-bit frame of last refresh

  private oddFrame = false;
  private prevNmiLine = false;
  /** Global dot count when the VBlank flag was last set. A $2002 read in the
   *  same CPU cycle (within this 3-dot batch) races the set: it reads VBlank as
   *  clear and cancels the pending NMI edge — the /NMI line never falls.
   *  Transient (only meaningful for ~2 dots), so it isn't serialized. */
  private vblSetDots = -10;
  /** Global dot count of the pre-render clear, recorded only when the flag was
   *  still set there. Symmetric to {@link vblSetDots}: a $2002 read landing on
   *  this exact dot samples the pre-clear value (set), while the flag itself is
   *  genuinely cleared so the /NMI line falls on time. Transient, not serialized. */
  private vblClearDots = -10;

  // PPU address line A12 tracking for the mapper scanline IRQ.
  private ppuDots = 0; // monotonic dot counter
  /** Absolute {@link ppuDots} value at which the sprite-overflow flag rises
   *  this scanline (−1 = none). Armed at dot 65 from the evaluation-timing
   *  model; the monotonic counter makes a stale target unmatchable. */
  private overflowAtPpuDot = -1;
  private a12 = false;
  private a12LowAt = 0;

  private readonly palette = new Uint8Array(32);
  private readonly oam = new Uint8Array(256);

  // Background fetch latches (next tile) + 16-bit shift registers.
  private ntLatch = 0;
  private atLatch = 0;
  private bgLoLatch = 0;
  private bgHiLatch = 0;
  // MMC5 ExRAM extended-attribute override for the current BG tile (null = off).
  private extTile: { bank: number; palette: number } | null = null;
  private bgShiftLo = 0;
  private bgShiftHi = 0;
  private bgAttrShiftLo = 0;
  private bgAttrShiftHi = 0;

  /** Sprite line buffer for the scanline being displayed, packed per x:
   *  bits 0-1 colour (0 = no sprite), 2-3 palette, 4 behind-background,
   *  5 sprite-zero. */
  private readonly sprLine = new Uint8Array(SCREEN_WIDTH);
  /** The eight sprite fetch slots for dots 257-320, staged at dot 257: each
   *  slot's pattern address (unused slots fetch the tile-$FF dummy) and packed
   *  metadata — bits 0-7 X, 8-15 attributes, 16 valid, 17 sprite-zero. */
  private readonly sprSlotAddr = new Int32Array(8);
  private readonly sprSlotMeta = new Int32Array(8);
  private sprLoLatch = 0; // pattern-low byte between a slot's two fetches

  /** Whether the bus routes MMC5 extended attributes — resolved once so the
   *  per-tile fetch skips the probe on the other mappers. */
  private readonly busHasExtAttr: boolean;
  /** Palette RAM resolved to packed RGBA — maintained on every palette write
   *  (and state load) so the per-pixel composite is a single lookup. */
  private readonly paletteRgb = new Uint32Array(32).fill(NES_PALETTE[0]!);

  constructor(private readonly bus: PpuBus) {
    this.busHasExtAttr = bus.hasExtAttr ?? bus.extAttrTile !== undefined;
  }

  reset(): void {
    this.ctrl = 0;
    this.mask = 0;
    this.writeToggle = 0;
    this.scanline = 0;
    this.dot = 0;
    this.oddFrame = false;
    this.frame = 0;
    this.openBus = 0;
    this.openBusDecay.fill(0);
  }

  // ─── Debugger peeks (side-effect-free) ──────────────────────────────────
  /** A palette-RAM byte ($3F00-$3F1F), an index into the 64-colour master
   *  palette (side-effect-free peek). */
  peekPalette(i: number): number {
    return this.palette[i & 0x1f]!;
  }
  /** The 256-byte OAM (64 sprites × 4 bytes: Y, tile, attr, X). Live array —
   *  the caller must not mutate it. */
  get debugOam(): Uint8Array {
    return this.oam;
  }
  /** Current PPUCTRL / PPUMASK / PPUSTATUS latches for the debugger's PPU
   *  register readout (no read side effects, unlike `cpuRead(2)`). */
  get debugRegs(): { ctrl: number; mask: number; status: number } {
    return { ctrl: this.ctrl, mask: this.mask, status: this.status };
  }

  /** Registers, scroll/loopy state, the A12-filter counters, palette + OAM, and
   *  the BG fetch latches/shifters + sprite line buffers. The framebuffer is
   *  excluded — it is re-rendered, matching the other engines. */
  serialize(w: NesStateWriter): void {
    w.u32(this.frame);
    w.u16(this.scanline);
    w.u16(this.dot);
    w.u8(this.ctrl);
    w.u8(this.mask);
    w.u8(this.status);
    w.u8(this.oamAddr);
    w.u16(this.v);
    w.u16(this.t);
    w.u8(this.fineX);
    w.u8(this.writeToggle);
    w.u8(this.readBuffer);
    w.u8(this.openBus);
    for (let i = 0; i < 8; i++) w.u32(this.openBusDecay[i]!);
    w.bool(this.oddFrame);
    w.bool(this.prevNmiLine);
    w.f64(this.ppuDots);
    w.f64(this.overflowAtPpuDot);
    w.bool(this.a12);
    w.f64(this.a12LowAt);
    w.u8(this.ntLatch);
    w.u8(this.atLatch);
    w.u8(this.bgLoLatch);
    w.u8(this.bgHiLatch);
    w.bool(this.extTile !== null);
    w.u16(this.extTile?.bank ?? 0);
    w.u8(this.extTile?.palette ?? 0);
    w.u16(this.bgShiftLo);
    w.u16(this.bgShiftHi);
    w.u16(this.bgAttrShiftLo);
    w.u16(this.bgAttrShiftHi);
    w.bytes(this.palette);
    w.bytes(this.oam);
    w.bytes(this.sprLine);
    for (let s = 0; s < MAX_SPRITES_PER_LINE; s++) {
      w.u32(this.sprSlotAddr[s]!);
      w.u32(this.sprSlotMeta[s]!);
    }
    w.u8(this.sprLoLatch);
  }
  deserialize(r: NesStateReader): void {
    this.frame = r.u32();
    this.scanline = r.u16();
    this.dot = r.u16();
    this.ctrl = r.u8();
    this.mask = r.u8();
    this.status = r.u8();
    this.oamAddr = r.u8();
    this.v = r.u16();
    this.t = r.u16();
    this.fineX = r.u8();
    this.writeToggle = r.u8();
    this.readBuffer = r.u8();
    this.openBus = r.u8();
    for (let i = 0; i < 8; i++) this.openBusDecay[i] = r.u32();
    this.oddFrame = r.bool();
    this.prevNmiLine = r.bool();
    this.ppuDots = r.f64();
    this.overflowAtPpuDot = r.f64();
    this.a12 = r.bool();
    this.a12LowAt = r.f64();
    this.ntLatch = r.u8();
    this.atLatch = r.u8();
    this.bgLoLatch = r.u8();
    this.bgHiLatch = r.u8();
    const hasExt = r.bool();
    const extBank = r.u16();
    const extPalette = r.u8();
    this.extTile = hasExt ? { bank: extBank, palette: extPalette } : null;
    this.bgShiftLo = r.u16();
    this.bgShiftHi = r.u16();
    this.bgAttrShiftLo = r.u16();
    this.bgAttrShiftHi = r.u16();
    r.bytes(this.palette);
    r.bytes(this.oam);
    r.bytes(this.sprLine);
    for (let s = 0; s < MAX_SPRITES_PER_LINE; s++) {
      this.sprSlotAddr[s] = r.u32();
      this.sprSlotMeta[s] = r.u32();
    }
    this.sprLoLatch = r.u8();
    for (let i = 0; i < 32; i++) this.paletteRgb[i] = NES_PALETTE[this.palette[i]! & 0x3f]!;
  }

  private renderingEnabled(): boolean {
    return (this.mask & (MASK_SHOW_BG | MASK_SHOW_SPRITES)) !== 0;
  }

  // ── CPU-facing register ports ($2000-$2007) ─────────────────────────────
  /** Read register `reg` (the low 3 bits of the CPU address). */
  cpuRead(reg: number): number {
    switch (reg & 7) {
      case 2: {
        // PPUSTATUS: top 3 bits are real status, low 5 come from the open bus.
        // VBlank read race: a read landing exactly on the set dot reads the
        // pre-set (clear) value — keeping the /NMI line from falling so pollNmi
        // sees no edge and the NMI is suppressed; one on the clear dot reads the
        // pre-clear (set) value while the flag still clears on time.
        let status = this.status;
        if (this.ppuDots === this.vblSetDots) status &= ~STATUS_VBLANK;
        else if (this.ppuDots === this.vblClearDots) status |= STATUS_VBLANK;
        const value = (status & 0xe0) | (this.readOpenBus() & 0x1f);
        this.status &= ~STATUS_VBLANK;
        this.writeToggle = 0;
        // The read drives only the three status lines onto the bus; bits 4-0
        // keep decaying on their own clock.
        this.refreshOpenBus(status, 0xe0);
        return value;
      }
      case 4: {
        // OAMDATA. Attribute byte (every 4th, offset 2) reads back bits 2-4 as
        // 0; the read drives all 8 bits of the bus.
        let value = this.oam[this.oamAddr]!;
        if ((this.oamAddr & 3) === 2) value &= 0xe3;
        this.refreshOpenBus(value, 0xff);
        return value;
      }
      case 7: {
        const addr = this.v & 0x3fff;
        this.signalA12(addr);
        let value: number;
        if (addr >= 0x3f00) {
          // Palette reads are immediate: bits 5-0 come from palette RAM and
          // drive the bus, bits 7-6 come from the (undriven, decaying) open bus.
          // The buffer is filled with the nametable byte "underneath".
          const pal = this.readPalette(addr) & 0x3f;
          value = pal | (this.readOpenBus() & 0xc0);
          this.readBuffer = this.bus.ppuRead(addr & 0x2fff);
          this.refreshOpenBus(pal, 0x3f);
        } else {
          value = this.readBuffer;
          this.readBuffer = this.bus.ppuRead(addr);
          this.refreshOpenBus(value, 0xff);
        }
        this.incrementV();
        // The incremented address lands on the PPU bus — an increment across
        // $0FFF->$1000 is an A12 rise that clocks the MMC3 counter.
        this.signalA12(this.v & 0x3fff);
        return value;
      }
      default:
        // Write-only registers return the open-bus latch without driving it.
        return this.readOpenBus();
    }
  }

  /** Drive the open-bus latch: set the bits selected by `mask` to `value` and
   *  reset their decay clock; unselected bits keep their value and keep aging.
   *  Every register write drives all 8 bits; some reads drive only a subset. */
  private refreshOpenBus(value: number, mask: number): void {
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (mask & bit) {
        this.openBus = (this.openBus & ~bit) | (value & bit);
        this.openBusDecay[i] = this.frame;
      }
    }
  }

  /** The open-bus value with any bit not re-driven within the decay window read
   *  back as 0 (its capacitor has drained). */
  private readOpenBus(): number {
    for (let i = 0; i < 8; i++) {
      if (this.frame - this.openBusDecay[i]! > OPEN_BUS_DECAY_FRAMES) {
        this.openBus &= ~(1 << i);
      }
    }
    return this.openBus;
  }

  /** Write `value` to register `reg` (the low 3 bits of the CPU address). */
  cpuWrite(reg: number, value: number): void {
    value &= 0xff;
    this.refreshOpenBus(value, 0xff); // any register write drives all 8 bus bits
    switch (reg & 7) {
      case 0: // PPUCTRL
        this.ctrl = value;
        this.bus.setLargeSprites?.((value & CTRL_SPRITE_16) !== 0);
        this.t = (this.t & ~0x0c00) | ((value & 0x03) << 10);
        break;
      case 1: // PPUMASK
        this.mask = value;
        break;
      case 3: // OAMADDR
        this.oamAddr = value;
        break;
      case 4: // OAMDATA
        this.oam[this.oamAddr] = value;
        this.oamAddr = (this.oamAddr + 1) & 0xff;
        break;
      case 5: // PPUSCROLL
        if (this.writeToggle === 0) {
          this.t = (this.t & ~0x001f) | (value >> 3);
          this.fineX = value & 0x07;
          this.writeToggle = 1;
        } else {
          this.t = (this.t & ~0x73e0) | ((value & 0x07) << 12) | ((value & 0xf8) << 2);
          this.writeToggle = 0;
        }
        break;
      case 6: // PPUADDR
        if (this.writeToggle === 0) {
          this.t = (this.t & ~0x7f00) | ((value & 0x3f) << 8); // clears bit 14
          this.writeToggle = 1;
        } else {
          this.t = (this.t & ~0x00ff) | value;
          this.v = this.t;
          this.writeToggle = 0;
          this.signalA12(this.v & 0x3fff); // v now drives the PPU address bus
        }
        break;
      case 7: // PPUDATA
        this.signalA12(this.v & 0x3fff);
        this.writeVram(this.v & 0x3fff, value);
        this.incrementV();
        // See the $2007 read: the post-increment address drives A12 too.
        this.signalA12(this.v & 0x3fff);
        break;
    }
  }

  /** Copy 256 bytes into OAM through OAMDATA semantics ($4014 DMA). */
  dmaOam(page: Uint8Array): void {
    for (let i = 0; i < 256; i++) {
      this.oam[this.oamAddr] = page[i]!;
      this.oamAddr = (this.oamAddr + 1) & 0xff;
    }
  }

  // ── memory helpers ──────────────────────────────────────────────────────
  private incrementV(): void {
    this.v = (this.v + (this.ctrl & CTRL_VRAM_INCREMENT ? 32 : 1)) & 0x7fff;
  }

  private writeVram(addr: number, value: number): void {
    if (addr >= 0x3f00) this.writePalette(addr, value);
    else this.bus.ppuWrite(addr, value);
  }

  /** Palette RAM index for `addr`, folding the $3F10/$14/$18/$1C sprite mirrors
   *  onto the universal-background entries. */
  private paletteIndex(addr: number): number {
    let i = addr & 0x1f;
    if ((i & 0x13) === 0x10) i &= ~0x10;
    return i;
  }
  private readPalette(addr: number): number {
    const v = this.palette[this.paletteIndex(addr)]!;
    return (this.mask & MASK_GREYSCALE) !== 0 ? v & 0x30 : v; // greyscale mask
  }
  private writePalette(addr: number, value: number): void {
    const i = this.paletteIndex(addr);
    this.palette[i] = value & 0x3f;
    this.paletteRgb[i] = NES_PALETTE[value & 0x3f]!;
  }

  // ── timing + rendering ───────────────────────────────────────────────────
  /** Put `addr` on the PPU bus, feeding the mapper's A12 IRQ clock on a filtered
   *  rising edge of address bit 12 (low for at least a few dots). */
  private signalA12(addr: number): void {
    if (addr & 0x1000) {
      if (!this.a12 && this.ppuDots - this.a12LowAt >= A12_FILTER_DOTS) this.mapperClock?.();
      this.a12 = true;
    } else {
      if (this.a12) this.a12LowAt = this.ppuDots;
      this.a12 = false;
    }
  }
  /** A12-signalled PPU read, used by the rendering fetch pipeline. */
  private fetch8(addr: number): number {
    this.signalA12(addr);
    return this.bus.ppuRead(addr);
  }
  /** A sprite-pattern fetch, routed to the mapper's sprite CHR set (MMC5). */
  private fetchSprite(addr: number): number {
    this.signalA12(addr);
    return this.bus.chrReadSprite ? this.bus.chrReadSprite(addr) : this.bus.ppuRead(addr);
  }

  /** Advance `dots` PPU dots. Runs of eventless dots — the VBlank body, the
   *  post-render line, and the idle stretches of visible scanlines — advance
   *  the counters in bulk; every dot with observable work (fetches, pixel
   *  output, flag edges) steps through {@link tickOne} unchanged. Callers only
   *  batch dots that fit inside one CPU access window, so no register write
   *  can land mid-batch. */
  tick(dots = 1): void {
    while (dots > 0) {
      // Idle regions all lie past the pixel field (dot > 255) or below the
      // visible lines, so active render dots skip the run computation with
      // two integer compares.
      if (this.dot > 255 || this.scanline >= SCREEN_HEIGHT) {
        const run = this.idleRun();
        if (run > 0) {
          const step = run < dots ? run : dots;
          this.dot += step;
          this.ppuDots += step;
          dots -= step;
          if (this.dot >= DOTS_PER_SCANLINE) {
            // Idle runs only occur on lines before the pre-render line, so
            // the wrap never needs end-of-frame / odd-frame-skip handling.
            this.dot = 0;
            this.scanline++;
          }
          continue;
        }
      }
      this.tickOne();
      dots--;
    }
  }

  /** Dots from the current position to the next one with observable work, or
   *  0 when the current dot must be stepped singly. */
  private idleRun(): number {
    const line = this.scanline;
    const dot = this.dot;
    // Post-render line + the VBlank body: nothing until the next line.
    if (line === SCREEN_HEIGHT || (line > VBLANK_START_SCANLINE && line < this.preRenderScanline)) {
      return DOTS_PER_SCANLINE - dot;
    }
    if (line === VBLANK_START_SCANLINE) {
      // Idle once the dot-1 VBlank-set event has passed.
      return dot >= 2 ? DOTS_PER_SCANLINE - dot : 0;
    }
    if (line < SCREEN_HEIGHT) {
      // Visible line. With rendering disabled, everything after the last
      // pixel (dot 256) is idle; with rendering on, only dots 338-340 are
      // (the sprite fetch slots occupy 257-320, the prefetch 321-337).
      if (!this.renderingEnabled()) return dot >= 257 ? DOTS_PER_SCANLINE - dot : 0;
      if (dot >= 338) return DOTS_PER_SCANLINE - dot;
      return 0;
    }
    return 0; // pre-render line: every dot is exact
  }

  /** Advance one PPU dot. */
  private tickOne(): void {
    this.ppuDots++;
    const visible = this.scanline < SCREEN_HEIGHT;
    const preRender = this.scanline === this.preRenderScanline;

    if (this.scanline === VBLANK_START_SCANLINE && this.dot === 1) {
      this.status |= STATUS_VBLANK;
      this.vblSetDots = this.ppuDots;
    } else if (preRender && this.dot === 1) {
      // Arm the read-race only when the flag is actually set going into the
      // clear — if it was already read-cleared this frame, a read here sees
      // clear (so a wait-for-VBL poll isn't fooled at the pre-render line).
      if (this.status & STATUS_VBLANK) this.vblClearDots = this.ppuDots;
      this.status &= ~(STATUS_VBLANK | STATUS_SPRITE0 | STATUS_OVERFLOW);
    }

    if ((visible || preRender) && this.renderingEnabled()) {
      this.renderTick(visible, preRender);
    }
    if (visible && this.dot >= 1 && this.dot <= SCREEN_WIDTH) {
      this.outputPixel(this.dot - 1, this.scanline);
    }

    this.dot++;
    if (
      this.dot === DOTS_PER_SCANLINE - 1 &&
      this.oddFrameSkip &&
      this.scanline === this.preRenderScanline &&
      this.oddFrame &&
      this.renderingEnabled()
    ) {
      // NTSC odd frames with rendering on skip the pre-render line's last dot.
      this.endFrame();
    } else if (this.dot >= DOTS_PER_SCANLINE) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline > this.preRenderScanline) this.endFrame();
    }
  }

  /** Apply NTSC / PAL frame geometry. Resets to the top of a frame so a live
   *  region switch can't strand the scanline counter past the new last line. */
  setTiming(preRenderScanline: number, oddFrameSkip: boolean): void {
    this.preRenderScanline = preRenderScanline;
    this.oddFrameSkip = oddFrameSkip;
    this.scanline = 0;
    this.dot = 0;
  }

  private endFrame(): void {
    this.dot = 0;
    this.scanline = 0;
    this.frame++;
    this.oddFrame = !this.oddFrame;
  }

  /** Background fetch pipeline + scroll-address updates for one rendering dot,
   *  per the NESdev cycle reference. */
  private renderTick(visible: boolean, preRender: boolean): void {
    const dot = this.dot;

    // Sprite-overflow flag, cycle-exact: hardware evaluation starts at dot 65,
    // and the flag rises on the exact dot the ninth in-range Y byte is read.
    if (visible) {
      if (dot === 65) this.armOverflowFlag();
      else if (this.ppuDots === this.overflowAtPpuDot) this.status |= STATUS_OVERFLOW;
    }

    // The prefetch window MUST start at dot 321 (not 322): its `case 0` at
    // dot 321 latches the first tile of the next scanline and is what
    // `loadBackgroundShifters` at dot 329 reloads. Starting at 322 skips it,
    // so the shifter reloads a stale tile and the leftmost on-screen column
    // renders wrong (visible as a left-edge seam in scrolling games).
    if ((dot >= 2 && dot <= 257) || (dot >= 321 && dot <= 337)) {
      this.shiftBackground();
      switch ((dot - 1) & 7) {
        case 0:
          this.loadBackgroundShifters();
          this.ntLatch = this.fetch8(0x2000 | (this.v & 0x0fff));
          this.extTile = this.busHasExtAttr ? this.bus.extAttrTile!(this.v & 0x03ff) : null;
          break;
        case 2: {
          const addr = 0x23c0 | (this.v & 0x0c00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07);
          const shift = ((this.v >> 4) & 4) | (this.v & 2);
          this.atLatch = this.extTile ? this.extTile.palette : (this.fetch8(addr) >> shift) & 3;
          break;
        }
        case 4:
          this.bgLoLatch = this.bgPatternByte(0);
          break;
        case 6:
          this.bgHiLatch = this.bgPatternByte(8);
          break;
        case 7:
          this.incrementCoarseX();
          break;
      }
    } else if (dot >= 258 && dot <= 320) {
      // Sprite fetch slots (dots 257-320, eight dots per slot): two garbage
      // nametable fetches (A12 low), then the pattern pair. The dot-257 NT
      // fetch above doubles as slot 0's first garbage fetch. The first
      // sprite-table pattern fetch (dot 261) is the A12 rise that clocks the
      // MMC3 scanline IRQ — on the pre-render line too.
      const phase = (dot - 257) & 7;
      if (phase === 0 || phase === 2) {
        this.fetch8(0x2000 | (this.v & 0x0fff));
      } else if (phase === 4) {
        this.sprLoLatch = this.fetchSprite(this.sprSlotAddr[(dot - 257) >> 3]!);
      } else if (phase === 6) {
        const s = (dot - 257) >> 3;
        this.writeSpritePixels(s, this.sprLoLatch, this.fetchSprite(this.sprSlotAddr[s]! + 8));
      }
    }

    if (dot === 256) this.incrementY();
    if (dot === 257) {
      this.loadBackgroundShifters();
      this.copyHorizontal();
      // Stage the fetch slots for the NEXT scanline (display is one line
      // delayed); the pre-render line fetches all-dummy slots.
      if (visible) {
        this.evaluateSprites(this.scanline);
      } else {
        this.clearSpriteLine();
        this.stageDummySpriteSlots(0);
      }
    }
    if (preRender && dot >= 280 && dot <= 304) this.copyVertical();
  }

  private bgPatternAddr(): number {
    const fineY = (this.v >> 12) & 7;
    return ((this.ctrl & CTRL_BG_TABLE) << 8) | (this.ntLatch << 4) | fineY;
  }

  /** A background pattern byte (plane 0 = low, 8 = high). In MMC5 ext-attr mode
   *  the tile is fetched directly from its ExRAM-selected 4 KiB CHR bank. */
  private bgPatternByte(plane: number): number {
    const fineY = (this.v >> 12) & 7;
    if (this.extTile && this.bus.extAttrPattern) {
      return this.bus.extAttrPattern(this.extTile.bank, (this.ntLatch << 4) | plane | fineY);
    }
    return this.fetch8(this.bgPatternAddr() + plane);
  }

  private shiftBackground(): void {
    this.bgShiftLo = (this.bgShiftLo << 1) & 0xffff;
    this.bgShiftHi = (this.bgShiftHi << 1) & 0xffff;
    this.bgAttrShiftLo = (this.bgAttrShiftLo << 1) & 0xffff;
    this.bgAttrShiftHi = (this.bgAttrShiftHi << 1) & 0xffff;
  }

  private loadBackgroundShifters(): void {
    this.bgShiftLo = (this.bgShiftLo & 0xff00) | this.bgLoLatch;
    this.bgShiftHi = (this.bgShiftHi & 0xff00) | this.bgHiLatch;
    this.bgAttrShiftLo = (this.bgAttrShiftLo & 0xff00) | (this.atLatch & 1 ? 0xff : 0);
    this.bgAttrShiftHi = (this.bgAttrShiftHi & 0xff00) | (this.atLatch & 2 ? 0xff : 0);
  }

  // Loopy scroll increments (NESdev "PPU scrolling").
  private incrementCoarseX(): void {
    if ((this.v & 0x001f) === 31) this.v = (this.v & ~0x001f) ^ 0x0400;
    else this.v++;
  }
  private incrementY(): void {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
    } else {
      this.v &= ~0x7000;
      let y = (this.v & 0x03e0) >> 5;
      if (y === 29) {
        y = 0;
        this.v ^= 0x0800;
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      this.v = (this.v & ~0x03e0) | (y << 5);
    }
  }
  private copyHorizontal(): void {
    this.v = (this.v & ~0x041f) | (this.t & 0x041f);
  }
  private copyVertical(): void {
    this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
  }

  /** Compute the dot at which this scanline's sprite evaluation reads a ninth
   *  in-range Y — the exact rise of the overflow flag. Evaluation reads one
   *  OAM byte pair every two dots from dot 65: an in-range sprite copies four
   *  bytes (8 dots), a miss costs one pair (2 dots), and after eight sprites
   *  the buggy diagonal scan advances the byte index with the sprite index
   *  (misreading pattern/attribute/X bytes as Y — same scan as
   *  {@link evaluateSprites}). Sprite X positions never affect the timing, so
   *  the whole line's schedule is fixed once evaluation starts, and OAM can't
   *  change mid-line ($2004 writes are blocked while rendering; OAM DMA
   *  stalls the CPU past the line). Runs at dot 65; the flag itself is set by
   *  {@link renderTick} when the armed dot arrives. */
  private armOverflowFlag(): void {
    this.overflowAtPpuDot = -1;
    const line = this.scanline;
    const height = this.ctrl & CTRL_SPRITE_16 ? 16 : 8;
    let rel = 65; // Y reads land on odd dots: 65, 67, …
    let n = 0;
    let found = 0;
    for (; n < 64 && found < 8; n++) {
      const row = line - this.oam[n * 4]!;
      if (row >= 0 && row < height) {
        found++;
        rel += 8;
      } else {
        rel += 2;
      }
    }
    if (found < 8) return;
    for (let m = 0; n < 64; n++, m = (m + 1) & 3) {
      const row = line - this.oam[n * 4 + m]!;
      if (row >= 0 && row < height) {
        // Only a read inside the evaluation window (dots 65-256) can fire.
        if (rel <= 256) this.overflowAtPpuDot = this.ppuDots + (rel - 65);
        return;
      }
      rel += 2;
    }
  }

  /** Sprite evaluation at dot 257 for display scanline `forLine + 1`: pick the
   *  line's (up to 8) sprites and stage each fetch slot's pattern address and
   *  metadata. The pattern reads, their A12 edges, and the line-buffer pixel
   *  writes all happen at the slots' hardware dots (257-320) in
   *  {@link renderTick}. The overflow flag (incl. the buggy diagonal scan) is
   *  handled cycle-exactly by {@link armOverflowFlag}, not here. */
  private evaluateSprites(forLine: number): void {
    this.clearSpriteLine();
    const height = this.ctrl & CTRL_SPRITE_16 ? 16 : 8;
    let count = 0;

    for (let i = 0; i < 64 && count < MAX_SPRITES_PER_LINE; i++) {
      const y = this.oam[i * 4]!;
      const row = forLine - y;
      if (row < 0 || row >= height) continue;

      const tile = this.oam[i * 4 + 1]!;
      const attr = this.oam[i * 4 + 2]!;
      const flipV = (attr & OAM_ATTR_FLIP_V) !== 0;

      let patternRow = flipV ? height - 1 - row : row;
      let addr: number;
      if (height === 16) {
        addr = ((tile & 1) << 12) | ((tile & 0xfe) << 4);
        if (patternRow >= 8) {
          addr += 16;
          patternRow -= 8;
        }
        addr += patternRow;
      } else {
        addr = ((this.ctrl & CTRL_SPRITE_TABLE) << 9) | (tile << 4) | patternRow;
      }
      this.sprSlotAddr[count] = addr;
      this.sprSlotMeta[count] = this.oam[i * 4 + 3]! | (attr << 8) | 0x10000 | (i === 0 ? 0x20000 : 0);
      count++;
    }
    this.stageDummySpriteSlots(count);
  }

  /** Fill fetch slots `from`..7 with the dummy tile-$FF pattern address. Real
   *  hardware fetches all eight slots every rendering line (incl. pre-render,
   *  where no sprites are evaluated at all) — the data is discarded, but the
   *  fetches toggle PPU A12, which is what clocks the MMC3 scanline IRQ even
   *  on sprite-less lines. */
  private stageDummySpriteSlots(from: number): void {
    const dummy = this.ctrl & CTRL_SPRITE_16 ? 0x1fe0 : ((this.ctrl & CTRL_SPRITE_TABLE) << 9) | 0xff0;
    for (let s = from; s < MAX_SPRITES_PER_LINE; s++) {
      this.sprSlotAddr[s] = dummy;
      this.sprSlotMeta[s] = 0;
    }
  }

  /** Decode a slot's fetched pattern pair into the sprite line buffer (the
   *  first non-transparent pixel per x wins — OAM order is priority). */
  private writeSpritePixels(slot: number, lo: number, hi: number): void {
    const meta = this.sprSlotMeta[slot]!;
    if ((meta & 0x10000) === 0) return; // dummy slot
    const spriteX = meta & 0xff;
    const attr = (meta >> 8) & 0xff;
    const flipH = (attr & OAM_ATTR_FLIP_H) !== 0;
    const attrBits =
      ((attr & OAM_ATTR_PALETTE) << 2) | (attr & OAM_ATTR_BEHIND ? 0x10 : 0) | (meta & 0x20000 ? 0x20 : 0);
    for (let px = 0; px < 8; px++) {
      const bit = flipH ? px : 7 - px;
      const color = ((hi >> bit) & 1) * 2 + ((lo >> bit) & 1);
      if (color === 0) continue;
      const x = spriteX + px;
      // A written entry always has colour bits set, so nonzero = occupied.
      if (x >= SCREEN_WIDTH || this.sprLine[x] !== 0) continue;
      this.sprLine[x] = color | attrBits;
    }
  }

  private clearSpriteLine(): void {
    this.sprLine.fill(0);
  }

  /** Compose the background and sprite pixel at (x, scanline) into the frame. */
  private outputPixel(x: number, y: number): void {
    let bgColor = 0;
    let bgPalette = 0;
    if (this.mask & MASK_SHOW_BG && (x >= 8 || this.mask & MASK_BG_LEFT)) {
      const bit = 0x8000 >> this.fineX;
      bgColor = ((this.bgShiftHi & bit ? 1 : 0) << 1) | (this.bgShiftLo & bit ? 1 : 0);
      bgPalette = ((this.bgAttrShiftHi & bit ? 1 : 0) << 1) | (this.bgAttrShiftLo & bit ? 1 : 0);
    }

    let spr = 0; // packed sprite pixel (see sprLine); colour 0 = none
    if (this.mask & MASK_SHOW_SPRITES && (x >= 8 || this.mask & MASK_SPRITE_LEFT)) {
      spr = this.sprLine[x]!;
      if ((spr & 3) !== 0 && bgColor !== 0 && spr & 0x20 && x !== 255) {
        this.status |= STATUS_SPRITE0;
      }
    }

    let paletteAddr = 0; // backdrop ($3F00)
    if ((spr & 3) !== 0 && (bgColor === 0 || (spr & 0x10) === 0)) {
      paletteAddr = 0x10 | (spr & 0x0f);
    } else if (bgColor !== 0) {
      paletteAddr = (bgPalette << 2) | bgColor;
    }
    this.fb32[y * SCREEN_WIDTH + x] = this.paletteRgb[paletteAddr]!;
  }

  /** Sample the /NMI line — (NMI-enable AND VBlank) — once per CPU cycle and
   *  report its falling edge (the line going active). The owning Nes calls this
   *  at the start of each cycle, so the line reflects the PREVIOUS cycle's $2002
   *  read / $2000 write: clearing VBlank or NMI-enable in the same cycle the
   *  flag set keeps the line from ever staying low, suppressing the NMI with no
   *  explicit edge-cancellation needed. */
  pollNmi(): boolean {
    const line = (this.ctrl & CTRL_NMI_ENABLE) !== 0 && (this.status & STATUS_VBLANK) !== 0;
    const edge = line && !this.prevNmiLine;
    this.prevNmiLine = line;
    return edge;
  }
}
