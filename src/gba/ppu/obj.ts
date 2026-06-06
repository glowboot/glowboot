/**
 * OAM-driven sprite renderer.
 *
 * OAM (Object Attribute Memory) holds 128 sprite entries, each 8 bytes,
 * laid out as:
 *
 *   0x00-0x01  Attribute 0  (y, affine flag, mode, color depth, shape)
 *   0x02-0x03  Attribute 1  (x, hflip/vflip OR affine matrix index, size)
 *   0x04-0x05  Attribute 2  (tile index, priority, palette bank)
 *   0x06-0x07  Affine matrix fragment — four consecutive sprite entries
 *              share a 2×2 matrix: sprite 4N's fragment = PA, 4N+1 = PB,
 *              4N+2 = PC, 4N+3 = PD. Normal-mode sprites ignore the
 *              fragment in their own entry; it belongs to whichever
 *              4-sprite group it sits in.
 *
 * Shape × Size table — 12 valid dimensions, four shape codes (3 is
 * "prohibited" and gets clamped to 8×8 in real hardware):
 *
 *       size=0    size=1    size=2    size=3
 *   sq  8×8       16×16     32×32     64×64
 *   hr  16×8      32×8      32×16     64×32
 *   vt  8×16      8×32      16×32     32×64
 *
 * Tile pixel data lives in VRAM charblock 4 (0x10000) — in bitmap modes
 * (3/4/5) only charblock 5 is available, so slot indices 0-511 are
 * unusable. The renderer itself is mode-agnostic; the PPU gates
 * tile<512 sprites out before calling in when DISPCNT is in modes 3-5.
 *
 * Sprite palettes live in the second half of the palette region:
 * byte offset 0x200..0x3FF, 16 sub-palettes of 16 colours each (4bpp)
 * or one flat 256-colour palette (8bpp).
 *
 * Affine sprites add a 2×2 matrix and an optional "double-size" mode:
 * the rendered display box doubles in each direction so a 45°-rotated
 * sprite has room to draw past its source rectangle without being
 * clipped against its own edges. The matrix transforms display-box
 * coordinates back into the source (untransformed) sprite rectangle,
 * with out-of-source pixels reading transparent.
 *
 * Two flavours of public entry point:
 *   • `renderSpriteLine(sy, sprite, …, rowOut)` — paint one screen
 *      row's worth of the sprite into a 240-wide row buffer. The PPU's
 *      per-scanline pipeline drives this.
 *   • `renderSprite(sprite, …, fullOut)` — full 240×160 layer. Thin
 *      wrapper for tests + full-frame callers.
 */

import { bgr555ToRgba } from "./ppu.js";

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;
const SPRITE_TILE_BASE = 0x10000;
const SPRITE_PALETTE_BASE = 0x200;

const OAM_ENTRY_BYTES = 8;

const DISPCNT_OBJ_1D_MAPPING = 1 << 6;

const SPRITE_DIMS: ReadonlyArray<readonly [number, number]> = [
  // square — shape 0
  [8, 8],
  [16, 16],
  [32, 32],
  [64, 64],
  // horizontal — shape 1
  [16, 8],
  [32, 8],
  [32, 16],
  [64, 32],
  // vertical — shape 2
  [8, 16],
  [8, 32],
  [16, 32],
  [32, 64],
  // prohibited — shape 3 (real hardware clamps to 8×8)
  [8, 8],
  [8, 8],
  [8, 8],
  [8, 8]
];

interface BaseSprite {
  x: number; // sign-extended from 9-bit (-256..255)
  y: number; // 0..255 wraparound
  width: number; // source dimensions
  height: number;
  displayWidth: number; // = width for normal sprites; = 2×width in affine double-size
  displayHeight: number;
  tile: number; // base tile slot in the sprite tile region
  priority: number;
  palBank: number;
  mode8bpp: boolean;
  /** OAM attr-0 GFX mode:
   *    0 = normal opaque sprite
   *    1 = semi-transparent (always alpha-blended by the compositor,
   *        regardless of BLDCNT mode; written to the priority scratch
   *        with alpha=SEMI_TRANS_ALPHA so the compositor can detect it)
   *    2 = OBJ-window mask (doesn't draw; its tile-opaque pixels mark
   *        the OBJ-window region for the windowing pass) */
  objMode: 0 | 1 | 2;
  /** OAM attr-0 bit 12 — when set, this sprite is mosaic'd using the
   *  MOSAIC register's OBJ-h / OBJ-v block sizes. Block snapping
   *  applies to the source-space tile coordinates (so the mosaic
   *  pattern travels with the sprite when it moves). Only meaningful
   *  for objMode 0 and 1; the OBJ-window cover path ignores it. */
  mosaic: boolean;
}

/** Alpha byte stamped into the OBJ priority scratch for semi-transparent
 *  (objMode 1) sprite pixels. The composite stage detects this and
 *  forces alpha-blend math, then normalises the byte back to 0xFF
 *  before writing the framebuffer. */
export const SEMI_TRANS_ALPHA = 0xfe;

export interface NormalSprite extends BaseSprite {
  affine: false;
  hflip: boolean;
  vflip: boolean;
}

export interface AffineSprite extends BaseSprite {
  affine: true;
  /** Signed 8.8 fixed-point matrix coefficients read from OAM. */
  pa: number;
  pb: number;
  pc: number;
  pd: number;
}

export type Sprite = NormalSprite | AffineSprite;

/** Reusable scratch returned from `parseSprite()` for non-affine
 *  sprites. Mutated in place and handed back to the caller; consumers
 *  use the result before the next `parseSprite` call (the PPU's OBJ
 *  walk reads sprite, renders, then calls parseSprite again). This
 *  avoids allocating ~10-40 k Sprite objects per frame on sprite-heavy
 *  carts (128 OAM slots × 160 scanlines worst case) — the original
 *  shape constructed two fresh objects per call (one for the base
 *  fields, one for the spread-out return) and showed up as 2-3 % of
 *  frame time in GC. */
const normalScratch: NormalSprite = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  displayWidth: 0,
  displayHeight: 0,
  tile: 0,
  priority: 0,
  palBank: 0,
  mode8bpp: false,
  objMode: 0,
  mosaic: false,
  affine: false,
  hflip: false,
  vflip: false
};

/** Sibling scratch for the affine branch — separate so the discrim-
 *  inated-union types (`affine: false` vs `affine: true` literal)
 *  stay accurate without runtime reassignment. */
const affineScratch: AffineSprite = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  displayWidth: 0,
  displayHeight: 0,
  tile: 0,
  priority: 0,
  palBank: 0,
  mode8bpp: false,
  objMode: 0,
  mosaic: false,
  affine: true,
  pa: 0,
  pb: 0,
  pc: 0,
  pd: 0
};

/** Decode the sprite at `index` (0..127) from OAM, or return null if
 *  the entry is disabled or uses the prohibited (mode = 3) encoding
 *  that real hardware ignores. Returns one of two module-level scratch
 *  objects — mutated in place — to avoid per-call allocation. */
export function parseSprite(index: number, oam: Uint8Array): Sprite | null {
  const base = index * OAM_ENTRY_BYTES;
  const attr0 = oam[base]! | (oam[base + 1]! << 8);
  const attr1 = oam[base + 2]! | (oam[base + 3]! << 8);
  const attr2 = oam[base + 4]! | (oam[base + 5]! << 8);

  const affine = (attr0 & (1 << 8)) !== 0;
  const doubleOrDisable = (attr0 & (1 << 9)) !== 0;
  if (!affine && doubleOrDisable) return null; // disabled

  const objMode = (attr0 >>> 10) & 0x3;
  if (objMode === 3) return null; // prohibited
  const mosaic = (attr0 & (1 << 12)) !== 0;

  const y = attr0 & 0xff;
  const mode8bpp = (attr0 & (1 << 13)) !== 0;
  const shape = (attr0 >>> 14) & 0x3;

  const xRaw = attr1 & 0x1ff;
  const x = xRaw < 256 ? xRaw : xRaw - 512;
  const size = (attr1 >>> 14) & 0x3;

  const tile = attr2 & 0x3ff;
  const priority = (attr2 >>> 10) & 0x3;
  const palBank = (attr2 >>> 12) & 0xf;

  const dims = SPRITE_DIMS[shape * 4 + size]!;
  const width = dims[0]!;
  const height = dims[1]!;

  if (!affine) {
    normalScratch.x = x;
    normalScratch.y = y;
    normalScratch.width = width;
    normalScratch.height = height;
    normalScratch.displayWidth = width;
    normalScratch.displayHeight = height;
    normalScratch.tile = tile;
    normalScratch.priority = priority;
    normalScratch.palBank = palBank;
    normalScratch.mode8bpp = mode8bpp;
    normalScratch.objMode = objMode as 0 | 1 | 2;
    normalScratch.mosaic = mosaic;
    normalScratch.hflip = (attr1 & (1 << 12)) !== 0;
    normalScratch.vflip = (attr1 & (1 << 13)) !== 0;
    return normalScratch;
  }

  // Affine sprite. Display box doubles in each axis when the double-
  // size flag is set so a rotated sprite isn't clipped by its own
  // source rectangle.
  const doubleSize = doubleOrDisable;
  const matrixIndex = (attr1 >>> 9) & 0x1f;
  // Inline-read the 4 matrix halfwords — each matrix occupies the
  // high halfword of 4 consecutive OAM entries (offset N × 32, +0x06 /
  // +0x0E / +0x16 / +0x1E within that block). Skipping the helper
  // call lets us also avoid its `AffineMatrix` allocation.
  const mBase = (matrixIndex & 0x1f) * 32;
  affineScratch.x = x;
  affineScratch.y = y;
  affineScratch.width = width;
  affineScratch.height = height;
  affineScratch.displayWidth = doubleSize ? width * 2 : width;
  affineScratch.displayHeight = doubleSize ? height * 2 : height;
  affineScratch.tile = tile;
  affineScratch.priority = priority;
  affineScratch.palBank = palBank;
  affineScratch.mode8bpp = mode8bpp;
  affineScratch.objMode = objMode as 0 | 1 | 2;
  affineScratch.mosaic = mosaic;
  affineScratch.pa = signed16(oam[mBase + 0x06]! | (oam[mBase + 0x07]! << 8));
  affineScratch.pb = signed16(oam[mBase + 0x0e]! | (oam[mBase + 0x0f]! << 8));
  affineScratch.pc = signed16(oam[mBase + 0x16]! | (oam[mBase + 0x17]! << 8));
  affineScratch.pd = signed16(oam[mBase + 0x1e]! | (oam[mBase + 0x1f]! << 8));
  return affineScratch;
}

function signed16(v: number): number {
  return (v << 16) >> 16;
}

/** Vertical-range pre-check shared by every per-line dispatch: returns
 *  the in-sprite Y row corresponding to screen row `sy` (taking the
 *  Y-wraparound rule into account), or `-1` if this sprite doesn't
 *  cover `sy`. Sprite Y is 0..255 with the high values wrapping so a
 *  sprite anchored at y=240 with height=32 covers screen rows
 *  240..255 then 0..15. */
function spriteRowFor(sprite: BaseSprite, sy: number): number {
  // Y is the top of the sprite's display box modulo 256. Compute
  // `(sy - y) mod 256` and check it's within the display height.
  const rel = (sy - sprite.y) & 0xff;
  return rel < sprite.displayHeight ? rel : -1;
}

/** Paint one scanline (`sy`) of `sprite` into `rowOut` (length 240).
 *  Branches internally on `sprite.affine`. Pixels outside the sprite
 *  are left untouched so the caller can stack multiple sprites into
 *  the same priority row in front-to-back order. Mode-1 semi-
 *  transparent sprites stamp `SEMI_TRANS_ALPHA` instead of 0xFF so
 *  the compositor can detect them. Mode-2 sprites are handled by
 *  {@link renderObjWindowSpriteLine}, not this function.
 *
 *  Returns true if any pixel was painted on this row (the caller can
 *  use that to update the per-priority "active" bitmask cheaply). */
export function renderSpriteLine(
  sy: number,
  sprite: Sprite,
  vram: Uint8Array,
  palette: Uint8Array,
  dispcnt: number,
  rowOut: Uint32Array,
  mosaicH = 1,
  mosaicV = 1
): boolean {
  const dy = spriteRowFor(sprite, sy);
  if (dy < 0) return false;
  if (sprite.affine) {
    return renderAffineSpriteRow(dy, sprite, vram, palette, dispcnt, rowOut, mosaicH, mosaicV);
  }
  return renderNormalSpriteRow(dy, sprite, vram, palette, dispcnt, rowOut, mosaicH, mosaicV);
}

/** Paint mode-2 OBJ-window cover pixels for one scanline (`sy`) into
 *  `maskRow` (length 240, byte = 1 where covered). */
export function renderObjWindowSpriteLine(
  sy: number,
  sprite: Sprite,
  vram: Uint8Array,
  dispcnt: number,
  maskRow: Uint8Array
): boolean {
  const dy = spriteRowFor(sprite, sy);
  if (dy < 0) return false;
  if (sprite.affine) {
    return renderAffineObjWindowRow(dy, sprite, vram, dispcnt, maskRow);
  }
  return renderNormalObjWindowRow(dy, sprite, vram, dispcnt, maskRow);
}

/** Full-frame wrapper around {@link renderSpriteLine}. Used by tests
 *  and full-frame callers; the PPU's per-scanline pipeline calls the
 *  per-line entry point directly into a 240-element row scratch. */
export function renderSprite(
  sprite: Sprite,
  vram: Uint8Array,
  palette: Uint8Array,
  dispcnt: number,
  out: Uint32Array,
  mosaicH = 1,
  mosaicV = 1
): void {
  for (let sy = 0; sy < SCREEN_HEIGHT; sy++) {
    const row = out.subarray(sy * SCREEN_WIDTH, sy * SCREEN_WIDTH + SCREEN_WIDTH);
    renderSpriteLine(sy, sprite, vram, palette, dispcnt, row, mosaicH, mosaicV);
  }
}

/** Apply the semi-transparent alpha marker if this sprite is in
 *  attr-0 mode 1; otherwise return the original RGBA value. */
function markIfSemiTrans(sprite: BaseSprite, rgba: number): number {
  return sprite.objMode === 1 ? ((rgba & 0x00ffffff) | (SEMI_TRANS_ALPHA << 24)) >>> 0 : rgba;
}

function renderNormalSpriteRow(
  py: number,
  sprite: NormalSprite,
  vram: Uint8Array,
  palette: Uint8Array,
  dispcnt: number,
  rowOut: Uint32Array,
  mosaicH: number,
  mosaicV: number
): boolean {
  const obj1d = (dispcnt & DISPCNT_OBJ_1D_MAPPING) !== 0;
  const widthTiles = sprite.width >>> 3;
  const sliceStride = sprite.mode8bpp ? 2 : 1;
  const useMosaic = sprite.mosaic && (mosaicH > 1 || mosaicV > 1);
  const effPy = sprite.vflip ? sprite.height - 1 - py : py;
  let painted = false;

  for (let px = 0; px < sprite.width; px++) {
    const screenX = sprite.x + px;
    if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;
    const effPx = sprite.hflip ? sprite.width - 1 - px : px;
    // OBJ mosaic snaps the *source* coordinate to the block top-left
    // so the mosaic pattern moves with the sprite when it scrolls.
    // Reads stay inside the sprite's bounds because the snap can
    // only floor — never overshoot — toward (0, 0).
    const sampX = useMosaic ? Math.floor(effPx / mosaicH) * mosaicH : effPx;
    const sampY = useMosaic ? Math.floor(effPy / mosaicV) * mosaicV : effPy;
    const tileRow = sampY >>> 3;
    const inTileY = sampY & 7;
    const tileCol = sampX >>> 3;
    const inTileX = sampX & 7;

    const tileSlot = obj1d
      ? sprite.tile + (tileRow * widthTiles + tileCol) * sliceStride
      : sprite.tile + tileRow * 32 + tileCol * sliceStride;
    const colour = samplePixel(vram, palette, sprite, tileSlot, inTileX, inTileY);
    if (colour !== null) {
      rowOut[screenX] = markIfSemiTrans(sprite, colour);
      painted = true;
    }
  }
  return painted;
}

function renderAffineSpriteRow(
  dy: number,
  sprite: AffineSprite,
  vram: Uint8Array,
  palette: Uint8Array,
  dispcnt: number,
  rowOut: Uint32Array,
  mosaicH: number,
  mosaicV: number
): boolean {
  const obj1d = (dispcnt & DISPCNT_OBJ_1D_MAPPING) !== 0;
  const widthTiles = sprite.width >>> 3;
  const sliceStride = sprite.mode8bpp ? 2 : 1;
  const halfDisplayW = sprite.displayWidth >>> 1;
  const halfDisplayH = sprite.displayHeight >>> 1;
  const halfSourceW = sprite.width >>> 1;
  const halfSourceH = sprite.height >>> 1;
  const useMosaic = sprite.mosaic && (mosaicH > 1 || mosaicV > 1);
  const offsetY = dy - halfDisplayH;
  let painted = false;

  for (let dx = 0; dx < sprite.displayWidth; dx++) {
    const screenX = sprite.x + dx;
    if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;
    const offsetX = dx - halfDisplayW;

    // Apply 2×2 matrix (in 8.8 fixed-point) to recentred display
    // coords, then translate back to source-coordinate origin.
    const texXRaw = ((sprite.pa * offsetX + sprite.pb * offsetY) >> 8) + halfSourceW;
    const texYRaw = ((sprite.pc * offsetX + sprite.pd * offsetY) >> 8) + halfSourceH;
    // Mosaic snap happens in source-coord space *after* the matrix
    // multiply, so the mosaic pattern rotates / scales with the
    // sprite. The post-snap range stays inside [0, source-size).
    const texX = useMosaic ? Math.floor(texXRaw / mosaicH) * mosaicH : texXRaw;
    const texY = useMosaic ? Math.floor(texYRaw / mosaicV) * mosaicV : texYRaw;
    if (texX < 0 || texX >= sprite.width || texY < 0 || texY >= sprite.height) continue;

    const tileRow = texY >>> 3;
    const inTileY = texY & 7;
    const tileCol = texX >>> 3;
    const inTileX = texX & 7;
    const tileSlot = obj1d
      ? sprite.tile + (tileRow * widthTiles + tileCol) * sliceStride
      : sprite.tile + tileRow * 32 + tileCol * sliceStride;

    const colour = samplePixel(vram, palette, sprite, tileSlot, inTileX, inTileY);
    if (colour !== null) {
      rowOut[screenX] = markIfSemiTrans(sprite, colour);
      painted = true;
    }
  }
  return painted;
}

function renderNormalObjWindowRow(
  py: number,
  sprite: NormalSprite,
  vram: Uint8Array,
  dispcnt: number,
  maskRow: Uint8Array
): boolean {
  const obj1d = (dispcnt & DISPCNT_OBJ_1D_MAPPING) !== 0;
  const widthTiles = sprite.width >>> 3;
  const sliceStride = sprite.mode8bpp ? 2 : 1;
  const effPy = sprite.vflip ? sprite.height - 1 - py : py;
  const tileRow = effPy >>> 3;
  const inTileY = effPy & 7;
  let painted = false;

  for (let px = 0; px < sprite.width; px++) {
    const screenX = sprite.x + px;
    if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;
    const effPx = sprite.hflip ? sprite.width - 1 - px : px;
    const tileCol = effPx >>> 3;
    const inTileX = effPx & 7;

    const tileSlot = obj1d
      ? sprite.tile + (tileRow * widthTiles + tileCol) * sliceStride
      : sprite.tile + tileRow * 32 + tileCol * sliceStride;
    if (isSpritePixelOpaque(vram, sprite, tileSlot, inTileX, inTileY)) {
      maskRow[screenX] = 1;
      painted = true;
    }
  }
  return painted;
}

function renderAffineObjWindowRow(
  dy: number,
  sprite: AffineSprite,
  vram: Uint8Array,
  dispcnt: number,
  maskRow: Uint8Array
): boolean {
  const obj1d = (dispcnt & DISPCNT_OBJ_1D_MAPPING) !== 0;
  const widthTiles = sprite.width >>> 3;
  const sliceStride = sprite.mode8bpp ? 2 : 1;
  const halfDisplayW = sprite.displayWidth >>> 1;
  const halfDisplayH = sprite.displayHeight >>> 1;
  const halfSourceW = sprite.width >>> 1;
  const halfSourceH = sprite.height >>> 1;
  const offsetY = dy - halfDisplayH;
  let painted = false;

  for (let dx = 0; dx < sprite.displayWidth; dx++) {
    const screenX = sprite.x + dx;
    if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;
    const offsetX = dx - halfDisplayW;

    const texX = ((sprite.pa * offsetX + sprite.pb * offsetY) >> 8) + halfSourceW;
    const texY = ((sprite.pc * offsetX + sprite.pd * offsetY) >> 8) + halfSourceH;
    if (texX < 0 || texX >= sprite.width || texY < 0 || texY >= sprite.height) continue;

    const tileRow = texY >>> 3;
    const inTileY = texY & 7;
    const tileCol = texX >>> 3;
    const inTileX = texX & 7;
    const tileSlot = obj1d
      ? sprite.tile + (tileRow * widthTiles + tileCol) * sliceStride
      : sprite.tile + tileRow * 32 + tileCol * sliceStride;

    if (isSpritePixelOpaque(vram, sprite, tileSlot, inTileX, inTileY)) {
      maskRow[screenX] = 1;
      painted = true;
    }
  }
  return painted;
}

/** Cheaper "is this tile pixel non-transparent?" probe for the
 *  OBJ-window path — same tile decode as `samplePixel`, but without
 *  the palette lookup and BGR555 → RGBA conversion. */
function isSpritePixelOpaque(
  vram: Uint8Array,
  sprite: BaseSprite,
  tileSlot: number,
  inTileX: number,
  inTileY: number
): boolean {
  const tileBase = SPRITE_TILE_BASE + tileSlot * 32;
  if (sprite.mode8bpp) {
    return (vram[tileBase + inTileY * 8 + inTileX] ?? 0) !== 0;
  }
  const byte = vram[tileBase + inTileY * 4 + (inTileX >>> 1)] ?? 0;
  const nibble = (inTileX & 1) === 0 ? byte & 0xf : (byte >>> 4) & 0xf;
  return nibble !== 0;
}

/** Sample one pixel from a sprite tile. Returns the RGBA value or
 *  null for transparent (palette index 0). Shared between normal and
 *  affine rendering paths. */
function samplePixel(
  vram: Uint8Array,
  palette: Uint8Array,
  sprite: BaseSprite & { palBank: number; mode8bpp: boolean },
  tileSlot: number,
  inTileX: number,
  inTileY: number
): number | null {
  const tileBase = SPRITE_TILE_BASE + tileSlot * 32;
  let palIndex: number;
  if (sprite.mode8bpp) {
    palIndex = vram[tileBase + inTileY * 8 + inTileX] ?? 0;
    if (palIndex === 0) return null;
  } else {
    const byte = vram[tileBase + inTileY * 4 + (inTileX >>> 1)] ?? 0;
    const nibble = (inTileX & 1) === 0 ? byte & 0xf : (byte >>> 4) & 0xf;
    if (nibble === 0) return null;
    palIndex = (sprite.palBank << 4) | nibble;
  }
  const palByte = SPRITE_PALETTE_BASE + palIndex * 2;
  const bgr555 = (palette[palByte] ?? 0) | ((palette[palByte + 1] ?? 0) << 8);
  return bgr555ToRgba(bgr555);
}
