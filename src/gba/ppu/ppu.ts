/**
 * GBA PPU: LCD I/O register block + dot/scanline state machine +
 * per-scanline renderer.
 *
 * Register coverage at 0x04000000:
 *   0x00  DISPCNT      mode + BG/sprite/window enables (RW)
 *   0x04  DISPSTAT     V-blank / H-blank / V-count flags + IRQ enables
 *                      (RW; bits 0-2 are status flags driven by the
 *                      PPU state machine and are read-only from the bus)
 *   0x06  VCOUNT       current scanline (RO)
 *   0x08+ BG0CNT-BG3CNT (RW)
 *   0x10+ BG0HOFS-BG3VOFS (write-only on hardware; we allow read-back
 *                          as a stored value so cart code that probes
 *                          its own writes sees them round-trip)
 *   0x20+ BG2PA-BG3DY    (affine BG matrix coefficients + reference points)
 *   0x40+ WIN0H/WIN1H/WIN0V/WIN1V (write-only on hw; we round-trip)
 *   0x48  WININ        per-window layer enables (low: WIN0, high: WIN1)
 *   0x4A  WINOUT       outside enables (low) + OBJ-window enables (high)
 *   0x4C  MOSAIC       BG h/v + OBJ h/v block sizes
 *   0x50  BLDCNT       top-A and bottom-B layer flags + blend mode
 *   0x52  BLDALPHA     EVA / EVB blend coefficients
 *   0x54  BLDY         EVY brighten / darken coefficient
 *
 * Rendering shape: each visible scanline is rendered at HBlank entry
 * for that line (dot 240 of vcount 0..159). Each call to
 * `renderScanline(y)` samples scroll / window / BLDCNT / affine matrix
 * registers anew — so a game's HBlank IRQ or HBlank DMA writes for
 * line N+1 take effect on line N+1's render. The affine reference
 * accumulators live on the PPU between scanlines (initialised to
 * `affineRefX/Y` at the start of each frame).
 *
 * Window masking (WIN0 / WIN1 / OBJWIN / WINOUT) gates per-layer
 * visibility pixel by pixel. Mode-2 OBJ-window sprites stamp a
 * 240-byte cover row consumed by the window pass. Color effects
 * (BLDCNT alpha / brighten / darken) run in the tile-mode
 * compositor's front-to-back pixel walk, gated by the active
 * window's color-effect bit. Semi-transparent OBJ pixels (attr-0
 * mode 1) carry a marker through the compositor and force alpha
 * blending regardless of BLDCNT mode. Mosaic snaps BG screen-space
 * pixels to their block top-left within the line (gated by BGnCNT
 * bit 6) and OBJ source-space samples inside the sprite renderer
 * (gated by OAM attr-0 bit 12).
 *
 * State machine: real GBA timing is 4 CPU cycles per dot, 308 dots per
 * scanline, 228 scanlines per frame (160 visible + 68 V-blank). `tick`
 * accepts a dot count — the Gba host derives that from accumulated
 * CPU cycles at 4 cycles/dot, so absolute timing aligns with real
 * hardware to within whatever each instruction's cycle model captures
 * (per-instruction costs in cpu.ts + WAITCNT-driven N/S accounting in
 * the bus). HBlank/VBlank IRQs and DMA triggers fire on the right
 * dots; vcount transitions land exactly where real hardware would.
 */

import type { IoHandler } from "../memory/mapped-bus.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import { type AffineBgConfig, renderAffineBgLine, renderTextBgLine, type TextBgConfig } from "./bg.js";
import { parseSprite, renderObjWindowSpriteLine, renderSpriteLine, SEMI_TRANS_ALPHA } from "./obj.js";
import { buildWindowMaskLine, windowsActive } from "./window.js";

const REG_DISPCNT = 0x00;
const REG_DISPSTAT = 0x04;
const REG_VCOUNT = 0x06;
const REG_BG0CNT = 0x08;
const REG_BG3CNT = 0x0e;
const REG_BG0HOFS = 0x10;
const REG_BG3VOFS = 0x1e;
const REG_BG2PA = 0x20;
const REG_BG3Y_HI = 0x3e;
const REG_WIN0H = 0x40;
const REG_WIN1H = 0x42;
const REG_WIN0V = 0x44;
const REG_WIN1V = 0x46;
const REG_WININ = 0x48;
const REG_WINOUT = 0x4a;
const REG_MOSAIC = 0x4c;
const REG_BLDCNT = 0x50;
const REG_BLDALPHA = 0x52;
const REG_BLDY = 0x54;

/** Mask for WININ / WINOUT — only bits 0-5 (and 8-13 in the other
 *  half) are valid layer / color-effect enable bits. The unused
 *  bits 6-7 / 14-15 read back zero on hardware. */
const WIN_ENABLE_MASK = 0x3f3f;
/** BLDCNT uses bits 0-13 — bits 14-15 read zero. */
const BLDCNT_MASK = 0x3fff;
/** BLDALPHA uses 5-bit EVA in bits 0-4 and 5-bit EVB in bits 8-12. */
const BLDALPHA_MASK = 0x1f1f;
/** BLDY uses 5-bit EVY in bits 0-4. */
const BLDY_MASK = 0x001f;

const DISPSTAT_STATUS_MASK = 0x0007;

const DISPSTAT_VBLANK = 1 << 0;
const DISPSTAT_HBLANK = 1 << 1;
const DISPSTAT_VCOUNT_MATCH = 1 << 2;
const DISPSTAT_VBLANK_IRQ_ENABLE = 1 << 3;
const DISPSTAT_HBLANK_IRQ_ENABLE = 1 << 4;
const DISPSTAT_VCOUNT_IRQ_ENABLE = 1 << 5;

export const DOTS_PER_SCANLINE = 308;
const VISIBLE_DOTS = 240;
/** Dot at which the H-blank flag (DISPSTAT bit 1) transitions 0→1 on
 *  real hardware. GBATEK: "the H-Blank flag is '0' for a total of 1006
 *  cycles" — that's cycle 1006 of a 1232-cycle scanline = dot ~251.5.
 *  H-blank IRQ + HDMA fire at this same edge. Drawing finishes at dot
 *  240 (cycle 960), so there's an ~11-dot gap between pixel-output end
 *  and the HBlank flag asserting. The mgba-suite misc-edge "H-blank
 *  bit start" test probes this exact dot via a DISPSTAT poll loop. */
export const HBLANK_FLAG_DOT = 252;
export const SCANLINES_PER_FRAME = 228;
export const VISIBLE_SCANLINES = 160;

export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;
export const FRAMEBUFFER_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT * 4;
const SCREEN_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;

const DISPCNT_MODE_MASK = 0x0007;
const DISPCNT_PAGE_SELECT = 1 << 4;
const DISPCNT_FORCED_BLANK = 1 << 7;
const DISPCNT_BG2_ENABLE = 1 << 10;
const DISPCNT_OBJ_ENABLE = 1 << 12;
const DISPCNT_OBJWIN_ENABLE = 1 << 15;

const MODE4_PAGE_SIZE = 0xa000;
/** Mode-5 bitmap dimensions. Frame 0 starts at VRAM 0x00000 and
 *  occupies 160×128×2 = 40 960 bytes (= MODE4_PAGE_SIZE — the page
 *  size coincides with mode 4's frame stride even though mode 4 only
 *  fills 38 400 bytes per page). */
const MODE5_WIDTH = 160;
const MODE5_HEIGHT = 128;

/** Layer enum used by the blend pass. The bit positions match the
 *  per-layer enable bits in BLDCNT (top in bits 0-5, bottom in 8-13)
 *  so `1 << LAYER_*` indexes both halves of BLDCNT directly. */
const LAYER_BG0 = 0;
const LAYER_OBJ = 4;
const LAYER_BACKDROP = 5;

/** Blend modes encoded in BLDCNT bits 6-7. Mode 0 (no effect) falls
 *  out implicitly — none of the BLEND_ALPHA / BRIGHTEN / DARKEN
 *  branches match, so top passes through unchanged. */
const BLEND_ALPHA = 1;
const BLEND_BRIGHTEN = 2;
const BLEND_DARKEN = 3;

/** Bit position of the color-effect enable inside each window's
 *  6-bit enable byte (bit 5 of the byte, matching GBATEK). */
const WIN_BIT_COLOR_EFFECT = 5;

/** Per-scanline layer descriptor used by the compositor. `layerEnum`
 *  matches BLDCNT bit positions so `1 << layerEnum` indexes the
 *  top-A / bottom-B enable halves directly. `winBit` is the bit
 *  inside the window enable byte (BG: bg index; OBJ: 4). */
interface LayerRowRef {
  kind: "BG" | "OBJ";
  priority: number;
  index: number;
  layerEnum: number;
  winBit: number;
  /** 240-element scratch row for this layer's pixels. */
  row: Uint32Array;
}

export class Ppu implements IoHandler {
  dispcnt = 0;
  dispstat = 0;
  vcount = 0;
  /** Position within the current scanline, 0..DOTS_PER_SCANLINE-1. */
  dot = 0;

  /** 3-deep DISPCNT BG-enable-bit latch pipeline. Real ARM7TDMI hardware
   *  delays BG-enable-bit changes by ~2-3 scanlines before they affect
   *  rendering — a BG layer that gets newly enabled doesn't display
   *  until the latch catches up. Slot [2] receives the current DISPCNT
   *  on each scanline boundary, then values cascade [2]→[1]→[0]. The
   *  renderer ANDs slot [0] with current DISPCNT for the enable check,
   *  so DISABLES take effect immediately while ENABLES are delayed.
   *  Verified against Batman/F-Zero/Bomberman which write DISPCNT mid-
   *  frame across many vcounts. Initialised to 0 (all BG bits "off in
   *  latch") matching real-hw reset state; the cart's pre-VDraw setup
   *  shifts the latch hundreds of times so any DISPCNT writes during
   *  boot have fully propagated by the time rendering matters. */
  private bgEnableLatch: number[] = [0, 0, 0];

  /** Open-bus source for reads of write-only PPU registers (BG scroll,
   *  affine matrix + reference points, window edges, MOSAIC, BLDY).
   *  Real ARM7TDMI returns the prefetched opcode word at PC+8 on the
   *  data bus when the I/O target doesn't drive bits for reads; the
   *  Gba constructor wires this to {@link ArmCpu.currentOpenBus} after
   *  the CPU exists. Null = default 0 (acceptable for unit tests that
   *  exercise the PPU in isolation). */
  openBusSource: (() => number) | null = null;

  /** Per-BG control + scroll registers (indices 0..3). */
  readonly bgcnt: Uint16Array = new Uint16Array(4);
  readonly bgHofs: Uint16Array = new Uint16Array(4);
  readonly bgVofs: Uint16Array = new Uint16Array(4);

  /** Affine matrix coefficients for BG2/BG3 (indices 0 = BG2, 1 = BG3),
   *  stored as signed 16-bit 8.8 fixed-point. */
  readonly affinePa: Int16Array = new Int16Array(2);
  readonly affinePb: Int16Array = new Int16Array(2);
  readonly affinePc: Int16Array = new Int16Array(2);
  readonly affinePd: Int16Array = new Int16Array(2);

  /** Affine reference point — signed 28-bit (held in a 32-bit Int with
   *  sign-extended high bits) so the renderer can shift and accumulate
   *  in native ints. This is the *register* value as the bus sees it. */
  readonly affineRefX: Int32Array = new Int32Array(2);
  readonly affineRefY: Int32Array = new Int32Array(2);

  /** Per-line affine accumulators — the actual reference point used
   *  to render the current scanline. Initialised from `affineRefX/Y`
   *  at frame start (`vcount → 0`), incremented by PB / PD after each
   *  scanline, and re-latched from the register on every BG2X/Y/
   *  BG3X/Y write (matching the hardware's internal-counter behaviour
   *  that Mode-7 floor effects rely on). */
  readonly affineLineX: Int32Array = new Int32Array(2);
  readonly affineLineY: Int32Array = new Int32Array(2);

  /** WIN0H / WIN1H — high byte = left X (inclusive), low byte = right X
   *  (exclusive). WIN0V / WIN1V follow the same shape with top/bottom Y.
   *  Stored raw; the windowing pass interprets the high/low halves and
   *  handles the hardware quirks (X2 > 240 → clamped to 240; X1 > X2 →
   *  the window wraps and is treated as empty per hardware). */
  win0h = 0;
  win1h = 0;
  win0v = 0;
  win1v = 0;
  /** WININ low byte = WIN0 enable bits, high byte = WIN1. Each byte:
   *  bit 0-3 = BG0-3 enable, bit 4 = OBJ enable, bit 5 = color-effect
   *  enable. Bits 6-7 are unused (read back zero). */
  winin = 0;
  /** WINOUT low byte = outside-of-windows enables, high byte = OBJ
   *  window enables. Same per-bit layout as WININ. */
  winout = 0;
  /** MOSAIC: bits 0-3 BG h-size, 4-7 BG v-size, 8-11 OBJ h-size,
   *  12-15 OBJ v-size. Each field stores `block-size - 1`. Consumed
   *  by the BG row mosaic snap (per-row) and the OBJ renderer
   *  (sample-time snap inside `renderSpriteLine`). */
  mosaic = 0;
  /** BLDCNT: bits 0-5 top-layer-A flags (BG0/1/2/3/OBJ/BD),
   *  bits 6-7 blend mode (0=off/1=alpha/2=brighten/3=darken),
   *  bits 8-13 bottom-layer-B flags. Bits 14-15 unused. */
  bldcnt = 0;
  /** BLDALPHA: 5-bit EVA in bits 0-4, 5-bit EVB in bits 8-12. */
  bldalpha = 0;
  /** BLDY: 5-bit EVY in bits 0-4. */
  bldy = 0;

  /** Lazy per-BG row scratches for tile-mode rendering. Each holds
   *  one 240-pixel RGBA row with alpha=0 for transparent pixels. */
  private bgRow: Uint32Array[] | null = null;
  /** Lazy cached "top-of-vertical-mosaic-block" row per BG. When
   *  BG mosaic is active and the current scanline is not at a block
   *  top, the row is copied from this cache instead of being
   *  re-rendered (per GBATEK, BG mosaic samples source(floor(x/h)*h,
   *  floor(y/v)*v)). */
  private bgMosaicCache: Uint32Array[] | null = null;
  /** Lazy per-priority OBJ row scratches (240 u32 each). */
  private objRow: (Uint32Array | null)[] | null = null;
  /** Lazy 240-byte per-line OBJ-window cover row. */
  private objWindowMaskRow: Uint8Array | null = null;
  /** Lazy 240-byte per-line window enable mask row. */
  private windowMaskRow: Uint8Array | null = null;

  /** RGBA8888 framebuffer the host displays — 240 × 160 × 4 bytes.
   *  Mirrors the work buffer; updated at VBlank entry by a single
   *  `set()` so the host always sees a complete frame's rendering
   *  (rows 0..159 all produced from one VBlank-to-VBlank scroll/
   *  blend/window/etc state). Without this snapshot, a runFrame
   *  call whose cycle-budget straddles a VBlank — typical because
   *  the constructor's pre-tick(100) leaves vcount=100 and the
   *  carry mechanism preserves that offset — would deliver a
   *  half-rendered work buffer with a horizontal seam at the entry
   *  vcount. */
  readonly framebuffer: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(FRAMEBUFFER_BYTES);

  /** Internal render target. Each visible scanline is written by
   *  `renderScanline(y)` at HBlank entry. Copied to `framebuffer` at
   *  VBlank entry — see the field doc above. */
  private readonly workFramebuffer: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(FRAMEBUFFER_BYTES);

  /** LE u32 view over `workFramebuffer` so each pixel is a single store. */
  private readonly framebufferU32: Uint32Array = new Uint32Array(
    this.workFramebuffer.buffer,
    this.workFramebuffer.byteOffset,
    SCREEN_PIXELS
  );

  readonly vram: Uint8Array;
  readonly palette: Uint8Array;
  readonly oam: Uint8Array;
  /** When true, `tick()` skips per-scanline rendering — DISPSTAT
   *  flags, IRQs, HBlank/VBlank edges, and the affine line accumulator
   *  all still tick normally so cart-observable state is unchanged.
   *  The framebuffer stays at whatever the previous rendered frame
   *  produced. Set this from the UI's adaptive-frame-skip policy. */
  skipRender = false;

  /** Fired when the PPU enters VBlank (vcount 159→160). Always fires
   *  the event regardless of DISPSTAT.VBLANK_IRQ_ENABLE — the listener
   *  decides whether to raise the IRQ (DMA also wants the event for
   *  VBlank-mode transfers). */
  onVBlank: (() => void) | null = null;
  /** Fired when HBlank starts on each visible scanline (dot 240).
   *  HBlank IRQ also fires during V-blank lines on real hardware; we
   *  follow that convention. */
  onHBlank: (() => void) | null = null;
  /** Fired when VCOUNT matches DISPSTAT bits 8-15. */
  onVCount: (() => void) | null = null;

  constructor(
    vram: Uint8Array = new Uint8Array(0x18000),
    palette: Uint8Array = new Uint8Array(0x400),
    oam: Uint8Array = new Uint8Array(0x400)
  ) {
    this.vram = vram;
    this.palette = palette;
    this.oam = oam;
    // Real GBA hardware resets BG2/BG3 affine PA/PD to 0x0100 (= 1.0 in
    // 8.8 fixed-point — the identity matrix), with PB/PC = 0. Carts that
    // enable Mode 1 / Mode 2 without first writing the matrix (F-Zero
    // Climax's race view is the canonical case) rely on this default;
    // with PA=PD=0 every screen pixel samples the same BG point and the
    // affine BG renders as a single tile / mostly backdrop.
    this.affinePa[0] = 0x0100;
    this.affinePa[1] = 0x0100;
    this.affinePd[0] = 0x0100;
    this.affinePd[1] = 0x0100;
  }

  /** True iff DISPSTAT bit 3 (V-blank IRQ enable) is set. */
  get vblankIrqEnabled(): boolean {
    return (this.dispstat & DISPSTAT_VBLANK_IRQ_ENABLE) !== 0;
  }
  get hblankIrqEnabled(): boolean {
    return (this.dispstat & DISPSTAT_HBLANK_IRQ_ENABLE) !== 0;
  }
  get vcountIrqEnabled(): boolean {
    return (this.dispstat & DISPSTAT_VCOUNT_IRQ_ENABLE) !== 0;
  }

  /** Advance the PPU clock by `dots` units. The Gba host derives the
   *  count from accumulated CPU cycles at 4 cycles/dot, so absolute
   *  frame duration aligns with real hardware to within each
   *  instruction's cycle model. Drives DISPSTAT flag transitions,
   *  HBlank / VBlank / VCount IRQs, and per-scanline rendering on
   *  dot 240 of each visible vcount. */
  /** Dots until the next internal event (render at 240, HBlank flag at
   *  252, scanline wrap at 308) — the boundaries where `tick` can fire
   *  IRQs or HDMA. `Gba.runFrame` uses this to fast-forward halted CPU
   *  time exactly to the next IRQ-capable moment. Always >= 1. */
  dotsToNextEvent(): number {
    const d = this.dot;
    const next = d < VISIBLE_DOTS ? VISIBLE_DOTS : d < HBLANK_FLAG_DOT ? HBLANK_FLAG_DOT : DOTS_PER_SCANLINE;
    return next - d;
  }

  tick(dots: number): void {
    let remaining = dots | 0;
    // Events only exist at three dot positions per scanline (render at
    // 240, HBlank flag at 252, wrap at 308) — fast-forward between
    // them instead of stepping dot-by-dot. Events still fire at
    // exactly the same dot, in the same order, as the per-dot loop
    // this replaces; calls that stay between events (the per-
    // instruction common case) reduce to one compare and an add.
    while (remaining > 0) {
      const d = this.dot;
      const next = d < VISIBLE_DOTS ? VISIBLE_DOTS : d < HBLANK_FLAG_DOT ? HBLANK_FLAG_DOT : DOTS_PER_SCANLINE;
      const stride = next - d;
      if (remaining < stride) {
        this.dot = d + remaining;
        return;
      }
      remaining -= stride;
      this.dot = next;

      if (next === VISIBLE_DOTS) {
        // Pixel output ends at dot 240. Render the visible scanline
        // here so the framebuffer reflects the just-completed line
        // before any HBlank-stage game code runs. The skip-render
        // gate lets the UI's adaptive frame-skip policy bypass the
        // renderer while still advancing all CPU-observable state
        // (DISPSTAT flags + IRQs fire below regardless).
        if (!this.skipRender && this.vcount < VISIBLE_SCANLINES) this.renderScanline(this.vcount);
        continue;
      }

      if (this.dot === HBLANK_FLAG_DOT) {
        // DISPSTAT.HBLANK + the H-blank IRQ / HDMA edge happen ~11
        // dots after pixel output ends, not at dot 240. Real hardware
        // leaves a gap during which the cart can still write display
        // regs without an IRQ firing yet — see the HBLANK_FLAG_DOT doc.
        this.dispstat |= DISPSTAT_HBLANK;
        this.onHBlank?.();
        continue;
      }

      if (this.dot >= DOTS_PER_SCANLINE) {
        this.dot = 0;
        this.dispstat &= ~DISPSTAT_HBLANK;
        this.vcount = (this.vcount + 1) % SCANLINES_PER_FRAME;
        // Shift the BG-enable latch pipeline. New DISPCNT writes go
        // into slot [2]; values cascade [2]→[1]→[0] over 2 scanlines,
        // so a freshly-enabled BG bit isn't visible to the renderer
        // until 2 scanlines later. Disables take effect immediately
        // because the renderer ANDs the latch with current DISPCNT.
        this.bgEnableLatch[0] = this.bgEnableLatch[1]!;
        this.bgEnableLatch[1] = this.bgEnableLatch[2]!;
        this.bgEnableLatch[2] = this.dispcnt;

        if (this.vcount === 0) {
          // Frame start — latch affine reference registers into the
          // per-line accumulators. (Register writes also re-latch
          // mid-frame; this resets the per-line PB/PD step
          // accumulation at the boundary between frames.)
          this.affineLineX[0] = this.affineRefX[0]!;
          this.affineLineX[1] = this.affineRefX[1]!;
          this.affineLineY[0] = this.affineRefY[0]!;
          this.affineLineY[1] = this.affineRefY[1]!;
        }

        if (this.vcount === VISIBLE_SCANLINES) {
          this.dispstat |= DISPSTAT_VBLANK;
          // Snapshot the just-rendered visible region for the host.
          // See the `framebuffer` field doc for why this exists.
          if (!this.skipRender) this.framebuffer.set(this.workFramebuffer);
          this.onVBlank?.();
        } else if (this.vcount === 0) {
          this.dispstat &= ~DISPSTAT_VBLANK;
        }

        const match = (this.dispstat >>> 8) & 0xff;
        if (this.vcount === match) {
          // Edge: only fire onVCount on the 0→1 transition of the match
          // flag, not every scanline (the flag is sticky for the whole
          // matched line, but the IRQ fires once).
          const wasMatched = (this.dispstat & DISPSTAT_VCOUNT_MATCH) !== 0;
          this.dispstat |= DISPSTAT_VCOUNT_MATCH;
          if (!wasMatched) this.onVCount?.();
        } else {
          this.dispstat &= ~DISPSTAT_VCOUNT_MATCH;
        }
      }
    }
  }

  read16(offset: number): number {
    const aligned = offset & ~1;
    switch (aligned) {
      case REG_DISPCNT:
        return this.dispcnt & 0xffff;
      case REG_DISPSTAT:
        return this.dispstat & 0xffff;
      case REG_VCOUNT:
        return this.vcount & 0xffff;
      default:
        if (aligned >= REG_BG0CNT && aligned <= REG_BG3CNT) {
          const slot = (aligned - REG_BG0CNT) >>> 1;
          const v = this.bgcnt[slot]! & 0xffff;
          // BG0/BG1 have no display-area-overflow bit (only BG2/BG3
          // are affine-capable) — bit 13 always reads 0. mgba-suite
          // io-read verifies the mask.
          return slot < 2 ? v & 0xdfff : v;
        }
        // All registers below are write-only on real hardware — reads
        // return open-bus (the prefetched ARM opcode at PC+8) sliced to
        // the requested halfword. Tests that don't wire `openBusSource`
        // get the default 0, which matches an idle bus.
        if (aligned >= REG_BG0HOFS && aligned <= REG_BG3VOFS) return this.readOpenBus(aligned);
        if (aligned >= REG_BG2PA && aligned <= REG_BG3Y_HI) return this.readOpenBus(aligned);
        switch (aligned) {
          case REG_WIN0H:
          case REG_WIN1H:
          case REG_WIN0V:
          case REG_WIN1V:
            return this.readOpenBus(aligned);
          case REG_WININ:
            return this.winin;
          case REG_WINOUT:
            return this.winout;
          case REG_MOSAIC:
            return this.readOpenBus(aligned);
          case REG_BLDCNT:
            return this.bldcnt;
          case REG_BLDALPHA:
            return this.bldalpha;
          case REG_BLDY:
            return this.readOpenBus(aligned);
          default:
            // 0x4E (after MOSAIC), 0x56-0x5E (after BLDY) sit between
            // PPU registers and have no backing field. Real hardware
            // leaves these slots off the LCD bus, so reads land on CPU
            // open-bus — mgba-suite io-read expects 0xDEAD here.
            if (aligned === 0x4e || (aligned >= 0x56 && aligned < 0x60)) {
              return this.readOpenBus(aligned);
            }
            return 0;
        }
    }
  }

  /** Halfword open-bus value for the given aligned offset — the high
   *  or low half of the CPU's prefetch word depending on the address's
   *  bit-1 alignment. */
  private readOpenBus(aligned: number): number {
    const word = this.openBusSource?.() ?? 0;
    return ((aligned & 2) === 0 ? word & 0xffff : (word >>> 16) & 0xffff) | 0;
  }

  write16(offset: number, value: number): void {
    const v = value & 0xffff;
    const aligned = offset & ~1;
    switch (aligned) {
      case REG_DISPCNT:
        this.dispcnt = v;
        return;
      case REG_DISPSTAT: {
        // Bits 0-2 are status flags owned by the PPU; bus writes don't
        // affect them.
        const prevMatched = (this.dispstat & DISPSTAT_VCOUNT_MATCH) !== 0;
        this.dispstat = (this.dispstat & DISPSTAT_STATUS_MASK) | (v & ~DISPSTAT_STATUS_MASK);
        // The VCount-match flag is combinatorial on hardware:
        // `flag = (vcount == match-setting)`. When the cart updates the
        // match value mid-scanline, the flag immediately re-evaluates,
        // and an IRQ fires on the 0→1 edge. F-Zero Climax (and other
        // Mode-7 carts) cascade per-scanline VCount-match IRQs to drive
        // their matrix DMA — if we miss the re-evaluation here, the
        // cascade stops after a single iteration and BG2 flickers.
        const newMatch = (this.dispstat >>> 8) & 0xff;
        const nowMatched = this.vcount === newMatch;
        if (nowMatched) {
          this.dispstat |= DISPSTAT_VCOUNT_MATCH;
          if (!prevMatched && this.vcountIrqEnabled) this.onVCount?.();
        } else {
          this.dispstat &= ~DISPSTAT_VCOUNT_MATCH;
        }
        return;
      }
      case REG_VCOUNT:
        return; // read-only
      default:
        if (aligned >= REG_BG0CNT && aligned <= REG_BG3CNT) {
          this.bgcnt[(aligned - REG_BG0CNT) >>> 1] = v;
          return;
        }
        if (aligned >= REG_BG0HOFS && aligned <= REG_BG3VOFS) {
          const slot = (aligned - REG_BG0HOFS) >>> 2;
          // Scroll regs are 9-bit on real hardware; bits 9-15 are
          // documented as "unused". We mask at store time rather than
          // on every read — same observable behaviour with less work
          // in the renderer.
          if ((aligned & 2) === 0) this.bgHofs[slot] = v & 0x1ff;
          else this.bgVofs[slot] = v & 0x1ff;
          return;
        }
        if (aligned >= REG_BG2PA && aligned <= REG_BG3Y_HI) {
          this.writeAffineReg(aligned, v);
          return;
        }
        switch (aligned) {
          case REG_WIN0H:
            this.win0h = v;
            return;
          case REG_WIN1H:
            this.win1h = v;
            return;
          case REG_WIN0V:
            this.win0v = v;
            return;
          case REG_WIN1V:
            this.win1v = v;
            return;
          case REG_WININ:
            this.winin = v & WIN_ENABLE_MASK;
            return;
          case REG_WINOUT:
            this.winout = v & WIN_ENABLE_MASK;
            return;
          case REG_MOSAIC:
            this.mosaic = v;
            return;
          case REG_BLDCNT:
            this.bldcnt = v & BLDCNT_MASK;
            return;
          case REG_BLDALPHA:
            this.bldalpha = v & BLDALPHA_MASK;
            return;
          case REG_BLDY:
            this.bldy = v & BLDY_MASK;
            return;
          default:
            return;
        }
    }
  }

  /** Affine BG register block at 0x20-0x3F.
   *
   *  Layout per BG (BG2 at 0x20, BG3 at 0x30):
   *    +0x00  PA (16-bit signed 8.8)
   *    +0x02  PB
   *    +0x04  PC
   *    +0x06  PD
   *    +0x08  X reference (32-bit, signed 28-bit; bus writes either
   *           the low halfword at +0x08 or the high halfword at +0x0A)
   *    +0x0C  Y reference (32-bit, same convention)
   *
   *  Reference-point writes are split into low/high halfword stores by
   *  most compilers; we reassemble the 32-bit value on each halfword
   *  write, sign-extending bit 27 so the stored Int32 is ready for the
   *  renderer to consume without further masking. */
  private writeAffineReg(aligned: number, v: number): void {
    const bg = aligned < 0x30 ? 0 : 1;
    const local = aligned - (bg === 0 ? 0x20 : 0x30);
    const signed = (v << 16) >> 16; // sign-extend 16-bit
    switch (local) {
      case 0x00:
        this.affinePa[bg] = signed;
        return;
      case 0x02:
        this.affinePb[bg] = signed;
        return;
      case 0x04:
        this.affinePc[bg] = signed;
        return;
      case 0x06:
        this.affinePd[bg] = signed;
        return;
      case 0x08: {
        const current = this.affineRefX[bg]!;
        const next = (current & ~0xffff) | (v & 0xffff);
        this.affineRefX[bg] = signExtend28(next);
        // Hardware re-latches the internal BG2X/BG3X counter on every
        // register write (both halfwords), discarding any per-line
        // PB-steps that have accumulated since the last latch. Without
        // this, an HBlank IRQ that re-bases the affine ref mid-frame
        // (the standard Mode 7 floor pattern) would have its new value
        // immediately overwritten on the next scanline by the old
        // accumulator value + PB.
        this.affineLineX[bg] = this.affineRefX[bg]!;
        return;
      }
      case 0x0a: {
        const current = this.affineRefX[bg]!;
        const next = (current & 0xffff) | ((v & 0xffff) << 16);
        this.affineRefX[bg] = signExtend28(next);
        this.affineLineX[bg] = this.affineRefX[bg]!;
        return;
      }
      case 0x0c: {
        const current = this.affineRefY[bg]!;
        const next = (current & ~0xffff) | (v & 0xffff);
        this.affineRefY[bg] = signExtend28(next);
        this.affineLineY[bg] = this.affineRefY[bg]!;
        return;
      }
      case 0x0e: {
        const current = this.affineRefY[bg]!;
        const next = (current & 0xffff) | ((v & 0xffff) << 16);
        this.affineRefY[bg] = signExtend28(next);
        this.affineLineY[bg] = this.affineRefY[bg]!;
        return;
      }
      default:
        return;
    }
  }

  read8(offset: number): number {
    const word = this.read16(offset & ~1);
    return (offset & 1) === 0 ? word & 0xff : (word >>> 8) & 0xff;
  }

  write8(offset: number, value: number): void {
    // GBA hardware widens 8-bit I/O writes to a 16-bit RMW pair on the
    // addressed halfword.
    const aligned = offset & ~1;
    const current = this.read16(aligned);
    const v = value & 0xff;
    const merged = (offset & 1) === 0 ? (current & 0xff00) | v : (current & 0x00ff) | (v << 8);
    this.write16(aligned, merged);
  }

  read32(offset: number): number {
    const lo = this.read16(offset);
    const hi = this.read16(offset + 2);
    return lo | (hi << 16) | 0;
  }

  write32(offset: number, value: number): void {
    this.write16(offset, value & 0xffff);
    this.write16(offset + 2, (value >>> 16) & 0xffff);
  }

  serialize(w: GbaStateWriter): void {
    w.u16(this.dispcnt);
    w.u16(this.dispstat);
    w.u16(this.vcount);
    w.u16(this.dot);
    for (let i = 0; i < 4; i++) w.u16(this.bgcnt[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.bgHofs[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.bgVofs[i]!);
    for (let i = 0; i < 2; i++) w.i16(this.affinePa[i]!);
    for (let i = 0; i < 2; i++) w.i16(this.affinePb[i]!);
    for (let i = 0; i < 2; i++) w.i16(this.affinePc[i]!);
    for (let i = 0; i < 2; i++) w.i16(this.affinePd[i]!);
    for (let i = 0; i < 2; i++) w.i32(this.affineRefX[i]!);
    for (let i = 0; i < 2; i++) w.i32(this.affineRefY[i]!);
    w.u16(this.win0h);
    w.u16(this.win1h);
    w.u16(this.win0v);
    w.u16(this.win1v);
    w.u16(this.winin);
    w.u16(this.winout);
    w.u16(this.mosaic);
    w.u16(this.bldcnt);
    w.u16(this.bldalpha);
    w.u16(this.bldy);
  }

  deserialize(r: GbaStateReader): void {
    this.dispcnt = r.u16();
    this.dispstat = r.u16();
    this.vcount = r.u16();
    this.dot = r.u16();
    for (let i = 0; i < 4; i++) this.bgcnt[i] = r.u16();
    for (let i = 0; i < 4; i++) this.bgHofs[i] = r.u16();
    for (let i = 0; i < 4; i++) this.bgVofs[i] = r.u16();
    for (let i = 0; i < 2; i++) this.affinePa[i] = r.i16();
    for (let i = 0; i < 2; i++) this.affinePb[i] = r.i16();
    for (let i = 0; i < 2; i++) this.affinePc[i] = r.i16();
    for (let i = 0; i < 2; i++) this.affinePd[i] = r.i16();
    for (let i = 0; i < 2; i++) this.affineRefX[i] = r.i32();
    for (let i = 0; i < 2; i++) this.affineRefY[i] = r.i32();
    this.win0h = r.u16();
    this.win1h = r.u16();
    this.win0v = r.u16();
    this.win1v = r.u16();
    this.winin = r.u16();
    this.winout = r.u16();
    this.mosaic = r.u16();
    this.bldcnt = r.u16();
    this.bldalpha = r.u16();
    this.bldy = r.u16();
    // Mirror the register values into the per-line accumulators on
    // load — the snapshot doesn't store them separately. Acceptable
    // because save-state captures occur at frame boundaries where the
    // per-line accumulators have already been reset from refX/refY
    // for the new frame.
    this.affineLineX[0] = this.affineRefX[0]!;
    this.affineLineX[1] = this.affineRefX[1]!;
    this.affineLineY[0] = this.affineRefY[0]!;
    this.affineLineY[1] = this.affineRefY[1]!;
  }

  /** Render every visible scanline into `framebuffer` based on
   *  DISPCNT. Convenience wrapper around `renderScanline(y)`. The
   *  engine's normal frame path runs scanlines via `tick()`; this
   *  whole-frame entry point exists for tests and callers that want
   *  to render a static frame without ticking the clock. */
  renderFrame(): void {
    // Latch the affine accumulators so the first scanline uses the
    // current register values (in tick-driven mode this happens at
    // the vcount→0 transition).
    this.affineLineX[0] = this.affineRefX[0]!;
    this.affineLineX[1] = this.affineRefX[1]!;
    this.affineLineY[0] = this.affineRefY[0]!;
    this.affineLineY[1] = this.affineRefY[1]!;
    // Seed the BG-enable latch with the current DISPCNT so a static
    // renderFrame() (no preceding ticks) honours the cart's enable
    // bits. The latch's 2-3 scanline delay only matters for ticks
    // driven by the wall-clock engine; tests and one-shot renders
    // expect the bits they just wrote to apply immediately.
    this.bgEnableLatch[0] = this.dispcnt;
    this.bgEnableLatch[1] = this.dispcnt;
    this.bgEnableLatch[2] = this.dispcnt;
    for (let y = 0; y < VISIBLE_SCANLINES; y++) this.renderScanline(y);
    // Whole-frame path: publish the work buffer immediately so callers
    // that just want a static render don't depend on a VBlank tick.
    this.framebuffer.set(this.workFramebuffer);
  }

  /** Render one visible scanline (`y`, 0..159) into `framebuffer`.
   *  Called by `tick()` at HBlank entry of each visible line and by
   *  `renderFrame()` for whole-frame rendering. After painting the
   *  line, advances the affine reference accumulators by PB / PD so
   *  the next line uses the rotated reference (Mode-7-style floor
   *  effect). */
  renderScanline(y: number): void {
    if ((this.dispcnt & DISPCNT_FORCED_BLANK) !== 0) {
      this.fillRowU32(y, 0xffffffff);
      this.advanceAffineLine();
      return;
    }

    const mode = this.dispcnt & DISPCNT_MODE_MASK;
    switch (mode) {
      case 0:
      case 1:
      case 2:
        this.renderTileModeLine(y, mode);
        break;
      case 3:
      case 4:
      case 5:
        // Bitmap modes still composite OBJ sprites over the bitmap (BG2),
        // respecting priority / windows / blend — handled inside.
        this.renderBitmapModeLine(y, mode);
        break;
      default:
        this.fillBackdropLine(y);
        break;
    }

    this.advanceAffineLine();
  }

  private advanceAffineLine(): void {
    // After rendering a line, step the per-line accumulators by the
    // current PB / PD coefficients so the next scanline samples one
    // texture-row down (or wherever the matrix points).
    this.affineLineX[0] = (this.affineLineX[0]! + this.affinePb[0]!) | 0;
    this.affineLineX[1] = (this.affineLineX[1]! + this.affinePb[1]!) | 0;
    this.affineLineY[0] = (this.affineLineY[0]! + this.affinePd[0]!) | 0;
    this.affineLineY[1] = (this.affineLineY[1]! + this.affinePd[1]!) | 0;
  }

  /** Per-mode BG type table.
   *
   *    Mode 0 — BG0/1/2/3 all text.
   *    Mode 1 — BG0/1 text, BG2 affine, BG3 disabled.
   *    Mode 2 — BG2/3 affine, BG0/1 disabled.
   *
   *  Bits are: ((affine ? 1 : 0) << bg) into the low nibble for affine
   *  flags, and ((enabled ? 1 : 0) << bg) into the high nibble. */
  private static readonly MODE_BG_TABLE: ReadonlyArray<readonly [enabled: number, affine: number]> = [
    [0b1111, 0b0000], // mode 0
    [0b0111, 0b0100], // mode 1
    [0b1100, 0b1100], // mode 2
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0]
  ];

  private renderTileModeLine(y: number, mode: number): void {
    // MOSAIC: bits 0-3 BG h-size, 4-7 BG v-size, 8-11 OBJ h-size,
    // 12-15 OBJ v-size. Each field stores `block-size - 1`; a value
    // of 0 means a 1×1 "block" (no mosaic).
    const mosaicBgH = (this.mosaic & 0x0f) + 1;
    const mosaicBgV = ((this.mosaic >>> 4) & 0x0f) + 1;
    const mosaicObjH = ((this.mosaic >>> 8) & 0x0f) + 1;
    const mosaicObjV = ((this.mosaic >>> 12) & 0x0f) + 1;

    const layers: LayerRowRef[] = [];

    // Render OBJ first so the windowing pass can consult the OBJ-window
    // cover row (populated by mode-2 sprites).
    let usedPriorities = 0;
    if ((this.dispcnt & DISPCNT_OBJ_ENABLE) !== 0) {
      const objWinNeeded = (this.dispcnt & DISPCNT_OBJWIN_ENABLE) !== 0;
      const objWindowRow = objWinNeeded ? this.getObjWindowMaskRow() : null;
      if (objWindowRow) objWindowRow.fill(0);
      usedPriorities = this.renderObjLine(y, objWindowRow, mosaicObjH, mosaicObjV);
    }

    // Build the per-line window mask if any window is active. The
    // mask is consulted pixel-by-pixel by the compositor.
    const maskRow = windowsActive(this.dispcnt) ? this.getWindowMaskRow() : null;
    if (maskRow) {
      const objWinRowForMask = (this.dispcnt & DISPCNT_OBJWIN_ENABLE) !== 0 ? this.objWindowMaskRow : null;
      buildWindowMaskLine(
        y,
        this.dispcnt,
        this.win0h,
        this.win1h,
        this.win0v,
        this.win1v,
        this.winin,
        this.winout,
        objWinRowForMask,
        maskRow
      );
    }

    const [enableMask, affineMask] = Ppu.MODE_BG_TABLE[mode]!;
    // BG enable bits go through a 2-scanline latch. ANDing latch[0]
    // with current DISPCNT means enables take 2 scanlines to display
    // but disables apply immediately — matches real HW behaviour for
    // games that toggle DISPCNT mid-frame.
    const bgEnable = this.dispcnt & this.bgEnableLatch[0]!;

    // Pre-render enabled BG row scratches and collect their priorities.
    for (let bg = 0; bg < 4; bg++) {
      if ((bgEnable & (1 << (8 + bg))) === 0) continue;
      if ((enableMask & (1 << bg)) === 0) continue; // mode forbids this BG
      const row = this.getBgRow(bg);

      const bgMosaicOn = (this.bgcnt[bg]! & 0x40) !== 0 && (mosaicBgH > 1 || mosaicBgV > 1);
      const blockY = bgMosaicOn ? Math.floor(y / mosaicBgV) * mosaicBgV : y;

      if (bgMosaicOn && y !== blockY) {
        // Mid-block row — replay the cached top-of-block row instead
        // of re-rendering. The cached row already has its horizontal
        // mosaic snap baked in.
        const cache = this.getBgMosaicCache(bg);
        row.set(cache);
      } else {
        row.fill(0);
        if ((affineMask & (1 << bg)) !== 0) {
          // Affine BGs (BG2 / BG3) use the per-line accumulator.
          const slot = bg - 2;
          renderAffineBgLine(
            this.affineLineX[slot]!,
            this.affineLineY[slot]!,
            this.buildAffineConfig(bg),
            this.vram,
            this.palette,
            row
          );
        } else {
          renderTextBgLine(y, this.buildBgConfig(bg), this.vram, this.palette, row);
        }
        if (bgMosaicOn) {
          // Apply horizontal snap, then cache the result so the next
          // (mosaicBgV - 1) lines can copy it cheaply.
          applyHMosaicRow(row, mosaicBgH);
          const cache = this.getBgMosaicCache(bg);
          cache.set(row);
        }
      }

      layers.push({
        kind: "BG",
        priority: this.bgcnt[bg]! & 0x3,
        index: bg,
        layerEnum: LAYER_BG0 + bg,
        winBit: bg,
        row
      });
    }

    // Append OBJ layers (already rendered above) in priority order so
    // the front-to-back sort below picks them up alongside BG layers.
    if ((this.dispcnt & DISPCNT_OBJ_ENABLE) !== 0) {
      for (let p = 0; p < 4; p++) {
        if (usedPriorities & (1 << p)) {
          layers.push({
            kind: "OBJ",
            priority: p,
            index: 0,
            layerEnum: LAYER_OBJ,
            winBit: 4,
            row: this.getObjRowUnsafe(p)
          });
        }
      }
    }

    // Front-to-back sort. Lower priority number → in front.
    // At equal priority, OBJ wins over BG (per hardware tie-break).
    // Within BGs at equal priority, lower BG index sits on top.
    layers.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.kind !== b.kind) return a.kind === "OBJ" ? -1 : 1;
      return a.index - b.index;
    });

    this.composeLine(y, layers, maskRow);
  }

  /** Walk the layers front-to-back per pixel for one scanline, picking
   *  the topmost non-transparent (and window-allowed) layer and — for
   *  alpha-blend mode — the second-topmost as the bottom. Apply
   *  BLDCNT / BLDALPHA / BLDY and write the result to the framebuffer
   *  row. */
  private composeLine(y: number, layers: ReadonlyArray<LayerRowRef>, maskRow: Uint8Array | null): void {
    const blendMode = (this.bldcnt >>> 6) & 0x3;
    const blendA = this.bldcnt & 0x3f;
    const blendB = (this.bldcnt >>> 8) & 0x3f;
    // EVA / EVB / EVY are 5-bit registers but cap at 16 — values 17-31
    // clip to 16 inside the blend math, matching real-hardware behaviour
    // (the blend output otherwise can't exceed 100 % of the source).
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, (this.bldalpha >>> 8) & 0x1f);
    const evy = Math.min(16, this.bldy & 0x1f);
    const backdrop = this.readPaletteRgba(0);
    const fb = this.framebufferU32;
    const fbRowBase = y * SCREEN_WIDTH;
    const numLayers = layers.length;
    const colorFxBit = 1 << WIN_BIT_COLOR_EFFECT;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      let topPx = 0;
      let topLayer = LAYER_BACKDROP;
      let bottomPx = 0;
      let bottomLayer = LAYER_BACKDROP;
      let foundTop = false;
      let foundBottom = false;

      for (let li = 0; li < numLayers; li++) {
        const L = layers[li]!;
        if (maskRow !== null && (maskRow[x]! & (1 << L.winBit)) === 0) continue;
        const px = L.row[x]!;
        if ((px & 0xff000000) === 0) continue;
        if (!foundTop) {
          topPx = px;
          topLayer = L.layerEnum;
          foundTop = true;
        } else {
          bottomPx = px;
          bottomLayer = L.layerEnum;
          foundBottom = true;
          break;
        }
      }
      if (!foundTop) topPx = backdrop;
      if (!foundBottom) bottomPx = backdrop;
      // (topLayer / bottomLayer were already initialised to LAYER_BACKDROP)

      // Semi-transparent OBJ (OAM attr-0 mode 1): the sprite renderer
      // stamps `SEMI_TRANS_ALPHA` into the priority row's alpha byte
      // for these pixels. When such a pixel is on top, alpha blending
      // is forced regardless of BLDCNT mode — top is treated as if
      // it were in BLDCNT-A, and the existing bottom-B check still
      // gates whether the blend math runs.
      const topIsSemiTrans = topLayer === LAYER_OBJ && ((topPx >>> 24) & 0xff) === SEMI_TRANS_ALPHA;

      let out = topPx;
      const colorFxAllowed = maskRow === null || (maskRow[x]! & colorFxBit) !== 0;
      if (colorFxAllowed) {
        const topInA = topIsSemiTrans || (blendA & (1 << topLayer)) !== 0;
        const effectiveMode = topIsSemiTrans ? BLEND_ALPHA : blendMode;
        if (effectiveMode === BLEND_ALPHA && topInA) {
          const bottomInB = (blendB & (1 << bottomLayer)) !== 0;
          if (bottomInB) out = blendAlpha(topPx, bottomPx, eva, evb);
        } else if (effectiveMode === BLEND_BRIGHTEN && topInA) {
          out = brighten(topPx, evy);
        } else if (effectiveMode === BLEND_DARKEN && topInA) {
          out = darken(topPx, evy);
        }
      }
      // Strip the semi-trans marker from the final framebuffer write —
      // it's an internal flag, the framebuffer must always be opaque.
      fb[fbRowBase + x] = topIsSemiTrans ? ((out & 0x00ffffff) | 0xff000000) >>> 0 : out;
    }
  }

  /** Render every sprite covering scanline `y` into the per-priority
   *  OBJ rows, returning a bitmask of priorities that received any
   *  pixels. Sprites are walked in reverse OAM order so sprite 0 ends
   *  up on top within its priority.
   *
   *  When `objWindowRow` is non-null, mode-2 OBJ-window sprites
   *  contribute their tile-opaque pixels into that row rather than
   *  the priority row — they don't draw visibly, they just mark the
   *  OBJWIN region for the windowing pass. */
  private renderObjLine(y: number, objWindowRow: Uint8Array | null, mosaicH: number, mosaicV: number): number {
    let used = 0;
    // 4-priority bitmask for "row scratch already cleared this line" —
    // replaces a per-scanline `new Set<number>()` allocation (160 sets
    // per frame). Priority is always 0..3, so a 4-bit number is the
    // perfect-fit shape.
    let cleared = 0;
    // Bitmap modes (3/4/5) overlay the framebuffer onto VRAM charblocks
    // 0-3 (slots 0-511 in OBJ-tile-space), so OBJ entries referencing
    // those slots are NOT renderable in those modes. This invalid-tile
    // gate ("do not display invalid tile numbers in bitmap modes")
    // matches real hardware and fixes the DOOM cart, which would
    // otherwise let OBJs with tile < 512 in mode 3/4/5 read framebuffer
    // bytes as tile data and paint garbage on top of the bitmap.
    const inBitmapMode = (this.dispcnt & DISPCNT_MODE_MASK) >= 3;
    for (let i = 127; i >= 0; i--) {
      const sprite = parseSprite(i, this.oam);
      if (!sprite) continue;
      if (inBitmapMode && sprite.tile < 512) continue;
      if (sprite.objMode === 2) {
        // OBJ-window sprite — only contributes if OBJWIN is active.
        // Doesn't allocate / clear a priority row and doesn't appear
        // in the `used` bitmask. Mosaic does not affect the OBJ-window
        // cover path.
        if (objWindowRow !== null) {
          renderObjWindowSpriteLine(y, sprite, this.vram, this.dispcnt, objWindowRow);
        }
        continue;
      }
      const priorityBit = 1 << sprite.priority;
      if ((cleared & priorityBit) === 0) {
        this.getObjRow(sprite.priority).fill(0);
        cleared |= priorityBit;
      }
      const painted = renderSpriteLine(
        y,
        sprite,
        this.vram,
        this.palette,
        this.dispcnt,
        this.getObjRow(sprite.priority),
        mosaicH,
        mosaicV
      );
      if (painted) used |= 1 << sprite.priority;
    }
    return used;
  }

  private getObjRow(priority: number): Uint32Array {
    if (!this.objRow) this.objRow = [null, null, null, null];
    if (!this.objRow[priority]) this.objRow[priority] = new Uint32Array(SCREEN_WIDTH);
    return this.objRow[priority]!;
  }

  private getObjRowUnsafe(priority: number): Uint32Array {
    // Caller has already established the priority is in use (and thus
    // allocated), so this skips the null check on the hot composite path.
    return this.objRow![priority]!;
  }

  /** Bitmap modes (3/4/5): render the bitmap as the BG2 layer, render
   *  OBJ sprites, then composite through the same priority / window /
   *  blend pipeline as tile mode. Previously the bitmap was blitted
   *  straight to the framebuffer and OBJ sprites were never drawn — so
   *  any bitmap-mode game with sprites (e.g. Tom and Jerry Tales' title
   *  screen) lost them entirely. */
  private renderBitmapModeLine(y: number, mode: number): void {
    const mosaicObjH = ((this.mosaic >>> 8) & 0x0f) + 1;
    const mosaicObjV = ((this.mosaic >>> 12) & 0x0f) + 1;

    // OBJ first so OBJWIN sprites can populate the OBJ-window mask.
    let usedPriorities = 0;
    if ((this.dispcnt & DISPCNT_OBJ_ENABLE) !== 0) {
      const objWindowRow = (this.dispcnt & DISPCNT_OBJWIN_ENABLE) !== 0 ? this.getObjWindowMaskRow() : null;
      if (objWindowRow) objWindowRow.fill(0);
      usedPriorities = this.renderObjLine(y, objWindowRow, mosaicObjH, mosaicObjV);
    }

    const maskRow = windowsActive(this.dispcnt) ? this.getWindowMaskRow() : null;
    if (maskRow) {
      const objWinRowForMask = (this.dispcnt & DISPCNT_OBJWIN_ENABLE) !== 0 ? this.objWindowMaskRow : null;
      buildWindowMaskLine(
        y,
        this.dispcnt,
        this.win0h,
        this.win1h,
        this.win0v,
        this.win1v,
        this.winin,
        this.winout,
        objWinRowForMask,
        maskRow
      );
    }

    const layers: LayerRowRef[] = [];
    // BG2 holds the bitmap. Enable bit goes through the same 2-scanline
    // latch as tile-mode BGs.
    if ((this.dispcnt & this.bgEnableLatch[0]! & DISPCNT_BG2_ENABLE) !== 0) {
      const row = this.getBgRow(2);
      this.renderBitmapRow(y, mode, row);
      layers.push({ kind: "BG", priority: this.bgcnt[2]! & 0x3, index: 2, layerEnum: LAYER_BG0 + 2, winBit: 2, row });
    }
    if ((this.dispcnt & DISPCNT_OBJ_ENABLE) !== 0) {
      for (let p = 0; p < 4; p++) {
        if (usedPriorities & (1 << p)) {
          layers.push({
            kind: "OBJ",
            priority: p,
            index: 0,
            layerEnum: LAYER_OBJ,
            winBit: 4,
            row: this.getObjRowUnsafe(p)
          });
        }
      }
    }
    layers.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.kind !== b.kind) return a.kind === "OBJ" ? -1 : 1;
      return a.index - b.index;
    });
    this.composeLine(y, layers, maskRow);
  }

  /** Render one scanline of the active bitmap mode into `row` as RGBA,
   *  using alpha=0 for transparent pixels (mode-4 palette index 0, and
   *  the off-bitmap region in mode 5) so the compositor lets OBJ /
   *  backdrop show through. Mode 3/5 are direct-colour and always
   *  opaque within their region. */
  private renderBitmapRow(y: number, mode: number, row: Uint32Array): void {
    const vram = this.vram;
    if (mode === 3) {
      const rowBase = y * SCREEN_WIDTH;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const b = (rowBase + x) * 2;
        row[x] = bgr555ToRgba((vram[b] ?? 0) | ((vram[b + 1] ?? 0) << 8));
      }
    } else if (mode === 4) {
      const pageBase = (this.dispcnt & DISPCNT_PAGE_SELECT) !== 0 ? MODE4_PAGE_SIZE : 0;
      const rowBase = y * SCREEN_WIDTH;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const index = vram[pageBase + rowBase + x] ?? 0;
        row[x] = index === 0 ? 0 : this.readPaletteRgba(index);
      }
    } else {
      // Mode 5 — 160×128 direct-colour bitmap top-left; outside = transparent.
      const pageBase = (this.dispcnt & DISPCNT_PAGE_SELECT) !== 0 ? MODE4_PAGE_SIZE : 0;
      const inRow = y < MODE5_HEIGHT;
      const srcRowBase = pageBase + y * MODE5_WIDTH * 2;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        if (inRow && x < MODE5_WIDTH) {
          const b = srcRowBase + x * 2;
          row[x] = bgr555ToRgba((vram[b] ?? 0) | ((vram[b + 1] ?? 0) << 8));
        } else {
          row[x] = 0;
        }
      }
    }
  }

  /** Decode BGn's control + scroll registers into a TextBgConfig that
   *  the tile renderer consumes. */
  private buildBgConfig(bg: number): TextBgConfig {
    const cnt = this.bgcnt[bg]! | 0;
    return {
      characterBaseBlock: (cnt >>> 2) & 0x3,
      screenBaseBlock: (cnt >>> 8) & 0x1f,
      colorMode8bpp: (cnt & 0x80) !== 0,
      screenSize: (cnt >>> 14) & 0x3,
      hofs: this.bgHofs[bg]! & 0x1ff,
      vofs: this.bgVofs[bg]! & 0x1ff
    };
  }

  /** Decode BG2/BG3's affine state into an AffineBgConfig. Indexing:
   *  bg=2 → slot 0 (BG2), bg=3 → slot 1 (BG3). The reference fields
   *  carry the *register* value — the renderer uses the PPU's per-
   *  line accumulator (`affineLineX/Y`), not the config's refX/Y. */
  private buildAffineConfig(bg: number): AffineBgConfig {
    const slot = bg - 2;
    const cnt = this.bgcnt[bg]! | 0;
    return {
      characterBaseBlock: (cnt >>> 2) & 0x3,
      screenBaseBlock: (cnt >>> 8) & 0x1f,
      screenSize: (cnt >>> 14) & 0x3,
      wraparound: (cnt & (1 << 13)) !== 0,
      refX: this.affineRefX[slot]! | 0,
      refY: this.affineRefY[slot]! | 0,
      pa: this.affinePa[slot]! | 0,
      pb: this.affinePb[slot]! | 0,
      pc: this.affinePc[slot]! | 0,
      pd: this.affinePd[slot]! | 0
    };
  }

  /** Fill one framebuffer row with palette[0] — the GBA's backdrop
   *  colour, visible wherever every enabled layer is transparent. */
  private fillBackdropLine(y: number): void {
    this.fillRowU32(y, this.readPaletteRgba(0));
  }

  private fillRowU32(y: number, value: number): void {
    const rowBase = y * SCREEN_WIDTH;
    const fb = this.framebufferU32;
    for (let x = 0; x < SCREEN_WIDTH; x++) fb[rowBase + x] = value;
  }

  private getWindowMaskRow(): Uint8Array {
    if (!this.windowMaskRow) this.windowMaskRow = new Uint8Array(SCREEN_WIDTH);
    return this.windowMaskRow;
  }

  private getObjWindowMaskRow(): Uint8Array {
    if (!this.objWindowMaskRow) this.objWindowMaskRow = new Uint8Array(SCREEN_WIDTH);
    return this.objWindowMaskRow;
  }

  private getBgRow(bg: number): Uint32Array {
    if (!this.bgRow) {
      this.bgRow = [
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH)
      ];
    }
    return this.bgRow[bg]!;
  }

  private getBgMosaicCache(bg: number): Uint32Array {
    if (!this.bgMosaicCache) {
      this.bgMosaicCache = [
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH),
        new Uint32Array(SCREEN_WIDTH)
      ];
    }
    return this.bgMosaicCache[bg]!;
  }

  /** Read a 16-bit BGR555 palette entry and return it as little-endian
   *  RGBA8888 (matching the framebuffer pixel format). */
  private readPaletteRgba(index: number): number {
    const b = (index & 0xff) * 2;
    const bgr555 = (this.palette[b] ?? 0) | ((this.palette[b + 1] ?? 0) << 8);
    return bgr555ToRgba(bgr555);
  }
}

/** Sign-extend a 28-bit signed value held in the low 28 bits of a
 *  32-bit integer. Shifts bit 27 into bit 31 and arithmetically back
 *  so the upper four bits mirror the sign. Used by the affine
 *  reference-point register block, which is documented as 28-bit
 *  signed despite living in a 32-bit MMIO slot. */
function signExtend28(v: number): number {
  return (v << 4) >> 4;
}

/** Horizontal BG mosaic snap on a 240-pixel row, in-place. After this
 *  pass, every pixel x reads the source at `floor(x / hSize) * hSize`.
 *  Safe in-place because reads stay at or left of the write cursor,
 *  and the leftmost-column cell of each block is self-assigned. */
function applyHMosaicRow(row: Uint32Array, hSize: number): void {
  if (hSize <= 1) return;
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const blockX = Math.floor(x / hSize) * hSize;
    row[x] = row[blockX]!;
  }
}

/** Convert a 16-bit BGR555 colour (R5/G5/B5 in bits 0-4/5-9/10-14) to
 *  a little-endian 0xAA_BB_GG_RR pixel for direct u32 framebuffer
 *  writes. The 5→8 bit expansion replicates the high bits into the
 *  low bits (`(c << 3) | (c >> 2)`) so pure-white BGR555 (0x7FFF) maps
 *  to 0xFF white instead of 0xF8. */
export function bgr555ToRgba(bgr555: number): number {
  const r5 = bgr555 & 0x1f;
  const g5 = (bgr555 >>> 5) & 0x1f;
  const b5 = (bgr555 >>> 10) & 0x1f;
  const r = (r5 << 3) | (r5 >>> 2);
  const g = (g5 << 3) | (g5 >>> 2);
  const b = (b5 << 3) | (b5 >>> 2);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** BLDCNT mode 1 — alpha-blend two RGBA8888 pixels with coefficients
 *  EVA / EVB (each 0..16). Per-channel: `(top * EVA + bottom * EVB) >> 4`,
 *  saturating at 255. Real hardware operates on 5-bit BGR555 channels;
 *  doing the math in the 8-bit RGBA8888 already-expanded domain
 *  produces visually-identical results (the 5→8 expansion is linear)
 *  while keeping the renderer in one colour space. */
export function blendAlpha(top: number, bottom: number, eva: number, evb: number): number {
  const tr = top & 0xff;
  const tg = (top >>> 8) & 0xff;
  const tb = (top >>> 16) & 0xff;
  const br = bottom & 0xff;
  const bg = (bottom >>> 8) & 0xff;
  const bb = (bottom >>> 16) & 0xff;
  let r = (tr * eva + br * evb) >> 4;
  let g = (tg * eva + bg * evb) >> 4;
  let b = (tb * eva + bb * evb) >> 4;
  if (r > 255) r = 255;
  if (g > 255) g = 255;
  if (b > 255) b = 255;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** BLDCNT mode 2 — fade the top pixel towards white by EVY/16.
 *  Per-channel: `top + ((255 - top) * EVY) >> 4`. */
export function brighten(top: number, evy: number): number {
  const tr = top & 0xff;
  const tg = (top >>> 8) & 0xff;
  const tb = (top >>> 16) & 0xff;
  const r = tr + (((255 - tr) * evy) >> 4);
  const g = tg + (((255 - tg) * evy) >> 4);
  const b = tb + (((255 - tb) * evy) >> 4);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** BLDCNT mode 3 — fade the top pixel towards black by EVY/16.
 *  Per-channel: `top - (top * EVY) >> 4`. */
export function darken(top: number, evy: number): number {
  const tr = top & 0xff;
  const tg = (top >>> 8) & 0xff;
  const tb = (top >>> 16) & 0xff;
  const r = tr - ((tr * evy) >> 4);
  const g = tg - ((tg * evy) >> 4);
  const b = tb - ((tb * evy) >> 4);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}
