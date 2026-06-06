import { describe, expect, it } from "vitest";

import { type AffineSprite, type NormalSprite, parseSprite, renderSprite } from "./obj.js";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu.js";

/** Helper that fills in the `affine: false` discriminator + the
 *  display-size fields so the test sites stay focused on the
 *  per-test data. */
function normal(
  overrides: Partial<NormalSprite> & { x: number; y: number; width: number; height: number }
): NormalSprite {
  return {
    tile: 0,
    priority: 0,
    palBank: 0,
    mode8bpp: false,
    hflip: false,
    vflip: false,
    objMode: 0,
    mosaic: false,
    displayWidth: overrides.width,
    displayHeight: overrides.height,
    ...overrides,
    affine: false
  };
}

function affine(
  overrides: Partial<AffineSprite> & {
    x: number;
    y: number;
    width: number;
    height: number;
    displayWidth: number;
    displayHeight: number;
    pa: number;
    pd: number;
  }
): AffineSprite {
  return {
    tile: 0,
    priority: 0,
    palBank: 0,
    mode8bpp: false,
    objMode: 0,
    mosaic: false,
    pb: 0,
    pc: 0,
    ...overrides,
    affine: true
  };
}

function makeBuffers() {
  return {
    vram: new Uint8Array(0x18000),
    palette: new Uint8Array(0x400),
    oam: new Uint8Array(0x400),
    out: new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT)
  };
}

/** Write attributes 0/1/2 for sprite `index` into OAM. */
function writeSpriteAttrs(oam: Uint8Array, index: number, attr0: number, attr1: number, attr2: number): void {
  const base = index * 8;
  oam[base] = attr0 & 0xff;
  oam[base + 1] = (attr0 >>> 8) & 0xff;
  oam[base + 2] = attr1 & 0xff;
  oam[base + 3] = (attr1 >>> 8) & 0xff;
  oam[base + 4] = attr2 & 0xff;
  oam[base + 5] = (attr2 >>> 8) & 0xff;
}

/** Write a single 4bpp sprite tile (32 bytes) starting at VRAM
 *  charblock 4 (offset 0x10000) at the given tile slot. */
function write4bppSpriteTile(vram: Uint8Array, tileSlot: number, pixels: number[][]): void {
  const base = 0x10000 + tileSlot * 32;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c += 2) {
      const lo = pixels[r]![c]! & 0xf;
      const hi = pixels[r]![c + 1]! & 0xf;
      vram[base + r * 4 + c / 2] = lo | (hi << 4);
    }
  }
}

/** Write an 8bpp sprite tile (64 bytes, occupies 2 slot indices). */
function write8bppSpriteTile(vram: Uint8Array, tileSlot: number, pixels: number[][]): void {
  const base = 0x10000 + tileSlot * 32;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      vram[base + r * 8 + c] = pixels[r]![c]! & 0xff;
    }
  }
}

function writeSpritePalette(palette: Uint8Array, idx: number, bgr555: number): void {
  const base = 0x200 + idx * 2;
  palette[base] = bgr555 & 0xff;
  palette[base + 1] = (bgr555 >>> 8) & 0xff;
}

function pixelAt(out: Uint32Array, x: number, y: number): number {
  return out[y * SCREEN_WIDTH + x]! >>> 0;
}

const RED_BGR555 = 0x001f;
const GREEN_BGR555 = 0x03e0;
const BLUE_BGR555 = 0x7c00;
const RED_RGBA = 0xff0000ff;
const GREEN_RGBA = 0xff00ff00;
const BLUE_RGBA = 0xffff0000;

describe("parseSprite — OAM decoding", () => {
  it("decodes a minimal 8×8 sprite at (10, 20)", () => {
    const { oam } = makeBuffers();
    // attr0: y=20, shape=square(0)
    // attr1: x=10, size=0
    // attr2: tile=5, priority=2, palBank=3
    writeSpriteAttrs(oam, 0, 20, 10, 5 | (2 << 10) | (3 << 12));
    const sprite = parseSprite(0, oam);
    if (!sprite || sprite.affine) throw new Error("expected a normal sprite");
    expect(sprite.x).toBe(10);
    expect(sprite.y).toBe(20);
    expect(sprite.width).toBe(8);
    expect(sprite.height).toBe(8);
    expect(sprite.tile).toBe(5);
    expect(sprite.priority).toBe(2);
    expect(sprite.palBank).toBe(3);
    expect(sprite.mode8bpp).toBe(false);
    expect(sprite.hflip).toBe(false);
    expect(sprite.vflip).toBe(false);
  });

  it("size + shape produce the right dimensions (horizontal 64×32)", () => {
    const { oam } = makeBuffers();
    // shape=1 (horizontal), size=3 → 64×32
    const attr0 = 0 | (1 << 14);
    const attr1 = 0 | (3 << 14);
    writeSpriteAttrs(oam, 0, attr0, attr1, 0);
    const sprite = parseSprite(0, oam)!;
    expect(sprite.width).toBe(64);
    expect(sprite.height).toBe(32);
  });

  it("x is sign-extended from 9 bits (256-511 → negative)", () => {
    const { oam } = makeBuffers();
    writeSpriteAttrs(oam, 0, 0, 0x1ff, 0); // x = 0x1ff = 511 → -1
    expect(parseSprite(0, oam)!.x).toBe(-1);
    writeSpriteAttrs(oam, 0, 0, 0x100, 0); // x = 256 → -256
    expect(parseSprite(0, oam)!.x).toBe(-256);
    writeSpriteAttrs(oam, 0, 0, 0x0ff, 0); // x = 255 (positive)
    expect(parseSprite(0, oam)!.x).toBe(255);
  });

  it("disabled flag (affine=0, doubleOrDisable=1) returns null", () => {
    const { oam } = makeBuffers();
    writeSpriteAttrs(oam, 0, 1 << 9, 0, 0);
    expect(parseSprite(0, oam)).toBeNull();
  });

  it("affine sprites are decoded with their 2×2 matrix", () => {
    const { oam } = makeBuffers();
    // Sprite 0: affine flag (attr0 bit 8), matrix index 1 in attr1 bits 9-13.
    writeSpriteAttrs(oam, 0, 1 << 8, 1 << 9, 0);
    // Matrix 1 lives at OAM offset 32 (1 * 32). PA at +0x06, PB at +0x0E,
    // PC at +0x16, PD at +0x1E.
    oam[32 + 0x06] = 0x00;
    oam[32 + 0x07] = 0x01; // PA = 0x0100 = 1.0
    oam[32 + 0x0e] = 0xff;
    oam[32 + 0x0f] = 0xff; // PB = -1
    oam[32 + 0x16] = 0x80;
    oam[32 + 0x17] = 0x00; // PC = 128
    oam[32 + 0x1e] = 0x00;
    oam[32 + 0x1f] = 0x01; // PD = 0x0100

    const s = parseSprite(0, oam);
    if (!s || !s.affine) throw new Error("expected an affine sprite");
    expect(s.pa).toBe(0x0100);
    expect(s.pb).toBe(-1);
    expect(s.pc).toBe(128);
    expect(s.pd).toBe(0x0100);
  });

  it("double-size affine sprite doubles the display box", () => {
    const { oam } = makeBuffers();
    // affine + double-size: attr0 bits 8 and 9 both set. Shape = 0
    // (square), size = 0 (8×8 source).
    writeSpriteAttrs(oam, 0, (1 << 8) | (1 << 9), 0, 0);
    const s = parseSprite(0, oam);
    expect(s).not.toBeNull();
    expect(s!.affine).toBe(true);
    expect(s!.width).toBe(8);
    expect(s!.displayWidth).toBe(16);
    expect(s!.displayHeight).toBe(16);
  });

  it("prohibited obj mode (=3) returns null", () => {
    const { oam } = makeBuffers();
    writeSpriteAttrs(oam, 0, 3 << 10, 0, 0);
    expect(parseSprite(0, oam)).toBeNull();
  });

  it("hflip / vflip / 8bpp flags are decoded for a normal sprite", () => {
    const { oam } = makeBuffers();
    writeSpriteAttrs(oam, 0, 1 << 13, (1 << 12) | (1 << 13), 0);
    const s = parseSprite(0, oam);
    if (!s || s.affine) throw new Error("expected a normal sprite");
    expect(s.mode8bpp).toBe(true);
    expect(s.hflip).toBe(true);
    expect(s.vflip).toBe(true);
  });
});

describe("renderSprite — normal 4bpp sprite", () => {
  it("paints an 8×8 sprite at (10, 20) with a single red corner pixel", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppSpriteTile(vram, 0, tile);

    renderSprite(normal({ x: 10, y: 20, width: 8, height: 8 }), vram, palette, 0, out);
    expect(pixelAt(out, 10, 20)).toBe(RED_RGBA);
    expect(pixelAt(out, 11, 20)).toBe(0); // transparent
  });

  it("respects palette-bank lookup in 4bpp", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, (5 << 4) | 1, GREEN_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppSpriteTile(vram, 0, tile);

    renderSprite(normal({ x: 0, y: 0, width: 8, height: 8, palBank: 5 }), vram, palette, 0, out);
    expect(pixelAt(out, 0, 0)).toBe(GREEN_RGBA);
  });

  it("hflip mirrors the sprite left/right", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppSpriteTile(vram, 0, tile);

    renderSprite(normal({ x: 0, y: 0, width: 8, height: 8, hflip: true }), vram, palette, 0, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
    expect(pixelAt(out, 7, 0)).toBe(RED_RGBA);
  });

  it("clips pixels off the left edge when x is negative", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1)); // solid
    write4bppSpriteTile(vram, 0, tile);

    renderSprite(normal({ x: -4, y: 0, width: 8, height: 8 }), vram, palette, 0, out);
    // Only screen pixels 0..3 of the sprite should be painted.
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
    expect(pixelAt(out, 3, 0)).toBe(RED_RGBA);
    // x=4 falls outside the 8×8 sprite footprint (4 + 8 = 12-clipped at width).
    // The screen x=4 is sprite-local px=8 which is past the right edge.
    expect(pixelAt(out, 4, 0)).toBe(0);
  });

  it("8bpp sprite reads a full byte per pixel and indexes the OBJ palette directly", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 0x42, BLUE_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[3]![5] = 0x42;
    write8bppSpriteTile(vram, 0, tile);

    renderSprite(normal({ x: 0, y: 0, width: 8, height: 8, mode8bpp: true }), vram, palette, 0, out);
    expect(pixelAt(out, 5, 3)).toBe(BLUE_RGBA);
  });

  it("1D tile mapping: a 16×8 sprite reads tiles N, N+1 horizontally", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);
    writeSpritePalette(palette, 2, BLUE_BGR555);

    // Tile 0: all red. Tile 1: all blue.
    const redTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    const blueTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    write4bppSpriteTile(vram, 0, redTile);
    write4bppSpriteTile(vram, 1, blueTile);

    // 1D mode is DISPCNT bit 6.
    renderSprite(normal({ x: 0, y: 0, width: 16, height: 8 }), vram, palette, 1 << 6, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA); // left tile = N
    expect(pixelAt(out, 8, 0)).toBe(BLUE_RGBA); // right tile = N+1
  });

  it("2D tile mapping: a 16×8 sprite jumps by +1 horizontally (same row in the 32-tile grid)", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);
    writeSpritePalette(palette, 2, BLUE_BGR555);

    const redTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    const blueTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    write4bppSpriteTile(vram, 0, redTile);
    write4bppSpriteTile(vram, 1, blueTile);

    // 2D mode (DISPCNT bit 6 = 0).
    renderSprite(normal({ x: 0, y: 0, width: 16, height: 8 }), vram, palette, 0, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
    expect(pixelAt(out, 8, 0)).toBe(BLUE_RGBA);
  });

  it("2D tile mapping: a 16×16 sprite uses the row-stride of 32 between tile rows", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);
    writeSpritePalette(palette, 2, BLUE_BGR555);

    const redTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    const blueTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    write4bppSpriteTile(vram, 0, redTile); // top-left
    write4bppSpriteTile(vram, 32, blueTile); // bottom-left (row stride = 32 slots)

    renderSprite(normal({ x: 0, y: 0, width: 16, height: 16 }), vram, palette, 0, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA); // top-left
    expect(pixelAt(out, 0, 8)).toBe(BLUE_RGBA); // bottom-left
  });
});

describe("renderSprite — affine", () => {
  it("identity matrix paints the same pixels as a normal sprite", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppSpriteTile(vram, 0, tile);

    renderSprite(
      affine({ x: 0, y: 0, width: 8, height: 8, displayWidth: 8, displayHeight: 8, pa: 0x100, pd: 0x100 }),
      vram,
      palette,
      0,
      out
    );
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
    expect(pixelAt(out, 1, 0)).toBe(0);
  });

  it("PA = 0x80 (0.5) zooms the source to twice screen size", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, BLUE_BGR555);

    // Tile row 0: every other source pixel red — produces a clear
    // before/after with halved x-step. Actually simpler: tile is all
    // blue at row 0 of the source.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let c = 0; c < 8; c++) tile[0]![c] = 1;
    write4bppSpriteTile(vram, 0, tile);

    // 8×8 source with double-size display = 16×16 box. PA=0x80 means
    // each display-pixel x step advances 0.5 in source space, so 16
    // display pixels cover the full 8-wide source row.
    renderSprite(
      affine({ x: 0, y: 0, width: 8, height: 8, displayWidth: 16, displayHeight: 16, pa: 0x80, pd: 0x80 }),
      vram,
      palette,
      0,
      out
    );
    // PA=PD=0x80 (0.5) maps display (0..15, 0) → source (0..7, 0). The
    // blue row stretches across the full top edge of the display box.
    expect(pixelAt(out, 0, 0)).toBe(BLUE_RGBA);
    expect(pixelAt(out, 15, 0)).toBe(BLUE_RGBA);
  });

  it("out-of-source samples render transparent (no wraparound)", () => {
    const { vram, palette, out } = makeBuffers();
    writeSpritePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppSpriteTile(vram, 0, tile);

    // 8×8 source in a 16×16 display box with identity matrix. With
    // PA=PD=0x100, the display center maps to source center; corners
    // map well outside [0,8). Only the central 8×8 region paints.
    renderSprite(
      affine({ x: 0, y: 0, width: 8, height: 8, displayWidth: 16, displayHeight: 16, pa: 0x100, pd: 0x100 }),
      vram,
      palette,
      0,
      out
    );
    // Center 8×8 region [4, 12) is opaque red.
    expect(pixelAt(out, 4, 4)).toBe(RED_RGBA);
    expect(pixelAt(out, 11, 11)).toBe(RED_RGBA);
    // Corners of the display box are off-source → transparent.
    expect(pixelAt(out, 0, 0)).toBe(0);
    expect(pixelAt(out, 15, 15)).toBe(0);
  });
});
