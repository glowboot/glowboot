/**
 * Text-BG (tile-mode) layer renderer.
 *
 * Given a BG's config (charblock / screen-block bases, color depth,
 * screen-size code, scroll x/y), reads tile data + tilemap entries
 * from VRAM and paints an RGBA layer. Transparent pixels are left as
 * `0x00000000` (alpha=0) — the compositor in `ppu.ts` blends this
 * layer with the others.
 *
 * Two flavours of entry point:
 *   • `renderTextBgLine(sy, …, out240)` — paint one scanline into a
 *      240-wide row buffer. Used by the per-scanline pipeline in
 *      `ppu.ts`; the PPU samples scroll / control registers anew for
 *      each line so mid-frame HBlank writes take effect.
 *   • `renderTextBg(config, …, fullOut)` — paint a full 240×160
 *      layer. Thin wrapper around the per-line renderer for tests
 *      and callers that just want a complete frame.
 *
 * VRAM layout (per GBATEK §LCD VRAM):
 *   Charblocks 0-3:   tile pixel data, 16 KiB each, at VRAM offsets
 *                     0x0000 / 0x4000 / 0x8000 / 0xC000.
 *   Charblocks 4-5:   sprite tiles, not used by BGs.
 *   Screen blocks 0-31: tilemap entries, 2 KiB each, at offsets
 *                       0x0000 / 0x0800 / ... / 0xF800. They alias on
 *                       top of charblocks 0-3 — the caller chooses how
 *                       to lay out the two by picking non-overlapping
 *                       blocks per BGCNT.
 *
 * Tilemap entry (16 bits per 8×8 tile):
 *   bits 0-9   tile index within the charblock
 *   bit  10    horizontal flip
 *   bit  11    vertical flip
 *   bits 12-15 palette bank (4bpp only; ignored in 8bpp)
 *
 * Tile pixel data:
 *   4bpp — 32 bytes/tile, 2 pixels/byte (low nibble = left pixel,
 *          high nibble = right). Each nibble is the index into a
 *          16-colour sub-palette selected by `palBank`. Nibble 0 in
 *          any sub-palette is transparent.
 *   8bpp — 64 bytes/tile, 1 byte/pixel = direct index into the full
 *          256-colour palette. Byte 0 is transparent.
 *
 * Screen-size codes (from BGCNT bits 14-15):
 *   0 = 256×256  (32×32 tiles, 1 screen block)
 *   1 = 512×256  (64×32 tiles, 2 screen blocks, side by side)
 *   2 = 256×512  (32×64 tiles, 2 screen blocks, top + bottom)
 *   3 = 512×512  (64×64 tiles, 4 screen blocks: TL, TR, BL, BR)
 */

import { bgr555ToRgba } from "./ppu.js";

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;
const CHARBLOCK_SIZE = 0x4000;
const SCREENBLOCK_SIZE = 0x0800;
const TILE_BYTES_4BPP = 32;
const TILE_BYTES_8BPP = 64;

const BG_WIDTHS_PX = [256, 512, 256, 512];
const BG_HEIGHTS_PX = [256, 256, 512, 512];

export interface TextBgConfig {
  /** Charblock index for tile pixel data (0-3, ×16 KiB). */
  characterBaseBlock: number;
  /** Screen-block index for tilemap entries (0-31, ×2 KiB). */
  screenBaseBlock: number;
  /** false = 4 bits per pixel (16 colours × 16 sub-palettes);
   *  true  = 8 bits per pixel (full 256-colour palette). */
  colorMode8bpp: boolean;
  /** 0-3 — see screen-size table in the module doc-comment. */
  screenSize: number;
  /** Horizontal scroll (0-511, masked into BG width). */
  hofs: number;
  /** Vertical scroll (0-511, masked into BG height). */
  vofs: number;
}

/** Render one scanline (`sy`, 0..159) of the BG into `out` — a
 *  240-element u32 row buffer. Transparent pixels are written as
 *  `0x00000000` so the compositor can use the alpha byte to skip
 *  them. The caller is responsible for clearing the row first if it
 *  reuses the buffer; this renderer overwrites every pixel. */
export function renderTextBgLine(
  sy: number,
  config: TextBgConfig,
  vram: Uint8Array,
  palette: Uint8Array,
  out: Uint32Array
): void {
  // Pre-extract config to locals so V8 doesn't reload through the
  // property IC on every pixel of the hot loop. Same for the two
  // typed-array references — `palette` and `vram` are stable for the
  // duration of the line, but as object-property reads they'd pay the
  // load each access.
  const hofs = config.hofs | 0;
  const vofs = config.vofs | 0;
  const colorMode8bpp = config.colorMode8bpp;
  const charBase = (config.characterBaseBlock & 0x3) * CHARBLOCK_SIZE;
  const screenBase = (config.screenBaseBlock & 0x1f) * SCREENBLOCK_SIZE;
  const size = config.screenSize & 0x3;
  const widthMask = (BG_WIDTHS_PX[size] ?? 256) - 1;
  const heightMask = (BG_HEIGHTS_PX[size] ?? 256) - 1;

  const wy = (sy + vofs) & heightMask;
  const ty = wy >>> 3;
  const py = wy & 7;
  const tyInBlock = ty & 31;
  const tyBlockBit = (ty >>> 5) & 1;

  // Tile-entry decode is hoisted out of the per-pixel loop: the entry
  // for (tx, ty) only changes when `tx` advances, which happens once
  // every 8 pixels. Previously we re-fetched + re-decoded for every
  // pixel — 8× the screen-block math, 8× the VRAM reads for the entry,
  // 8× the bit-extracts for hflip/vflip/palBank. The branch is taken
  // ~30 times per line vs 240, well within V8's branch-predictor
  // sweet spot.
  let lastTx = -1;
  let tileIndex = 0;
  let hflip = false;
  let vflip = false;
  let palBank = 0;

  for (let sx = 0; sx < SCREEN_WIDTH; sx++) {
    const wx = (sx + hofs) & widthMask;
    const tx = wx >>> 3;
    const px = wx & 7;

    if (tx !== lastTx) {
      const txInBlock = tx & 31;
      const txBlockBit = (tx >>> 5) & 1;
      const sbOffset = pickScreenBlockOffset(size, txBlockBit, tyBlockBit);
      const entryAddr = screenBase + sbOffset * SCREENBLOCK_SIZE + (tyInBlock * 32 + txInBlock) * 2;
      const entry = vram[entryAddr]! | (vram[entryAddr + 1]! << 8);
      tileIndex = entry & 0x3ff;
      hflip = (entry & 0x400) !== 0;
      vflip = (entry & 0x800) !== 0;
      palBank = (entry >>> 12) & 0xf;
      lastTx = tx;
    }

    const effPx = hflip ? 7 - px : px;
    const effPy = vflip ? 7 - py : py;

    let palIndex: number;
    if (colorMode8bpp) {
      const byteAddr = charBase + tileIndex * TILE_BYTES_8BPP + effPy * 8 + effPx;
      palIndex = vram[byteAddr]!;
      if (palIndex === 0) {
        out[sx] = 0;
        continue;
      }
    } else {
      const byteAddr = charBase + tileIndex * TILE_BYTES_4BPP + effPy * 4 + (effPx >>> 1);
      const byte = vram[byteAddr]!;
      const nibble = (effPx & 1) === 0 ? byte & 0xf : (byte >>> 4) & 0xf;
      if (nibble === 0) {
        out[sx] = 0;
        continue;
      }
      palIndex = (palBank << 4) | nibble;
    }

    const palByte = palIndex * 2;
    const bgr555 = palette[palByte]! | (palette[palByte + 1]! << 8);
    out[sx] = bgr555ToRgba(bgr555);
  }
}

/** Render a full 240×160 layer. Thin wrapper that loops over
 *  `renderTextBgLine` — useful for tests and any caller that wants
 *  the whole frame in one buffer. The PPU's per-scanline pipeline
 *  uses the per-line entry point directly. */
export function renderTextBg(config: TextBgConfig, vram: Uint8Array, palette: Uint8Array, out: Uint32Array): void {
  for (let sy = 0; sy < SCREEN_HEIGHT; sy++) {
    const row = out.subarray(sy * SCREEN_WIDTH, sy * SCREEN_WIDTH + SCREEN_WIDTH);
    renderTextBgLine(sy, config, vram, palette, row);
  }
}

/** Map a tile coordinate's 32-tile-block bit to a screen-block offset
 *  within the BG's tilemap. Larger BGs tile multiple 32×32-tile screen
 *  blocks; the offset selects which one contains (tx, ty). */
function pickScreenBlockOffset(size: number, txBlockBit: number, tyBlockBit: number): number {
  switch (size) {
    case 1:
      return txBlockBit;
    case 2:
      return tyBlockBit;
    case 3:
      return (tyBlockBit << 1) | txBlockBit;
    default:
      return 0;
  }
}

const AFFINE_BG_SIZE_PX = [128, 256, 512, 1024];
const TILE_BYTES_8BPP_AFFINE = 64;

export interface AffineBgConfig {
  /** Charblock index for 8bpp tile pixel data (0-3, ×16 KiB). */
  characterBaseBlock: number;
  /** Screen-block index for the byte-per-entry tilemap (0-31, ×2 KiB). */
  screenBaseBlock: number;
  /** 0-3 → 128/256/512/1024 pixels square. */
  screenSize: number;
  /** BGCNT bit 13 — when true, off-map samples wrap; when false they
   *  read transparent. */
  wraparound: boolean;
  /** Signed 28-bit reference point at frame start, kept in 32-bit
   *  (8.8 fixed-point with the integer pixel coord in bits 8-31). */
  refX: number;
  refY: number;
  /** Signed 8.8 fixed-point matrix coefficients (16-bit on-bus). */
  pa: number;
  pb: number;
  pc: number;
  pd: number;
}

/** Render one scanline of an affine BG into `out` (240-element u32
 *  row). `lineX` / `lineY` are the affine reference point at the
 *  start of this row — the PPU maintains these per-line (initialised
 *  to refX/refY at frame start and incremented by PB / PD between
 *  rows). The renderer accumulates `+= PA` / `+= PC` along the row.
 *
 *  Sampling: out-of-map (texX, texY) reads transparent when
 *  `wraparound` is false; with wraparound on, sample coordinates
 *  fold modulo the BG size. */
export function renderAffineBgLine(
  lineX: number,
  lineY: number,
  config: AffineBgConfig,
  vram: Uint8Array,
  palette: Uint8Array,
  out: Uint32Array
): void {
  const size = AFFINE_BG_SIZE_PX[config.screenSize & 0x3] ?? 128;
  const tileGrid = size >>> 3;
  const charBase = (config.characterBaseBlock & 0x3) * CHARBLOCK_SIZE;
  const screenBase = (config.screenBaseBlock & 0x1f) * SCREENBLOCK_SIZE;

  let texFracX = lineX | 0;
  let texFracY = lineY | 0;

  for (let sx = 0; sx < SCREEN_WIDTH; sx++) {
    const texX = texFracX >> 8;
    const texY = texFracY >> 8;
    let sampleX = texX;
    let sampleY = texY;

    let inMap = sampleX >= 0 && sampleX < size && sampleY >= 0 && sampleY < size;
    if (!inMap && config.wraparound) {
      sampleX = ((sampleX % size) + size) % size;
      sampleY = ((sampleY % size) + size) % size;
      inMap = true;
    }

    if (inMap) {
      const tx = sampleX >>> 3;
      const ty = sampleY >>> 3;
      const tileIndex = vram[screenBase + ty * tileGrid + tx] ?? 0;
      const inTileX = sampleX & 7;
      const inTileY = sampleY & 7;
      const palIndex = vram[charBase + tileIndex * TILE_BYTES_8BPP_AFFINE + inTileY * 8 + inTileX] ?? 0;
      if (palIndex !== 0) {
        const palByte = palIndex * 2;
        const bgr555 = (palette[palByte] ?? 0) | ((palette[palByte + 1] ?? 0) << 8);
        out[sx] = bgr555ToRgba(bgr555);
      } else {
        out[sx] = 0;
      }
    } else {
      out[sx] = 0;
    }

    texFracX = (texFracX + config.pa) | 0;
    texFracY = (texFracY + config.pc) | 0;
  }
}

/** Render a full 240×160 affine BG into `out`. Walks the affine
 *  reference from `(refX, refY)` at line 0 and accumulates `+= pb`
 *  / `+= pd` between rows — equivalent to the per-line entry point
 *  invoked with the same accumulator. Kept for tests and full-frame
 *  callers; the PPU's per-scanline pipeline manages the line state
 *  itself. */
export function renderAffineBg(config: AffineBgConfig, vram: Uint8Array, palette: Uint8Array, out: Uint32Array): void {
  let lineX = config.refX | 0;
  let lineY = config.refY | 0;
  for (let sy = 0; sy < SCREEN_HEIGHT; sy++) {
    const row = out.subarray(sy * SCREEN_WIDTH, sy * SCREEN_WIDTH + SCREEN_WIDTH);
    renderAffineBgLine(lineX, lineY, config, vram, palette, row);
    lineX = (lineX + config.pb) | 0;
    lineY = (lineY + config.pd) | 0;
  }
}
