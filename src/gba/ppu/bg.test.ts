import { describe, expect, it } from "vitest";

import { type AffineBgConfig, renderAffineBg, renderTextBg, type TextBgConfig } from "./bg.js";

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;

function makeBuffers() {
  return {
    vram: new Uint8Array(0x18000),
    palette: new Uint8Array(0x400),
    out: new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT)
  };
}

function defaultConfig(overrides: Partial<TextBgConfig> = {}): TextBgConfig {
  return {
    characterBaseBlock: 0,
    screenBaseBlock: 1,
    colorMode8bpp: false,
    screenSize: 0,
    hofs: 0,
    vofs: 0,
    ...overrides
  };
}

function pixelAt(out: Uint32Array, x: number, y: number): number {
  return out[y * SCREEN_WIDTH + x]! >>> 0;
}

/** Write a 16-bit tilemap entry into VRAM at the given screen-block
 *  base + tile coordinate within that block (32×32 layout). */
function writeTilemapEntry(
  vram: Uint8Array,
  screenBaseBlock: number,
  tx: number,
  ty: number,
  tileIndex: number,
  opts: { hflip?: boolean; vflip?: boolean; palBank?: number } = {}
): void {
  const screenBase = screenBaseBlock * 0x800;
  const entry =
    (tileIndex & 0x3ff) | (opts.hflip ? 0x400 : 0) | (opts.vflip ? 0x800 : 0) | (((opts.palBank ?? 0) & 0xf) << 12);
  const addr = screenBase + (ty * 32 + tx) * 2;
  vram[addr] = entry & 0xff;
  vram[addr + 1] = (entry >>> 8) & 0xff;
}

/** Write a 4bpp tile (8 rows × 4 bytes/row = 32 bytes) into the given
 *  charblock at the given tile index. `pixels` is an 8×8 array of
 *  4-bit palette-sub-index values (0-15); index 0 will render as
 *  transparent. */
function write4bppTile(vram: Uint8Array, characterBaseBlock: number, tileIndex: number, pixels: number[][]): void {
  const charBase = characterBaseBlock * 0x4000;
  const tileBase = charBase + tileIndex * 32;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col += 2) {
      const lo = pixels[row]![col]! & 0xf;
      const hi = pixels[row]![col + 1]! & 0xf;
      vram[tileBase + row * 4 + col / 2] = lo | (hi << 4);
    }
  }
}

/** Write an 8bpp tile (8 rows × 8 bytes/row = 64 bytes). */
function write8bppTile(vram: Uint8Array, characterBaseBlock: number, tileIndex: number, pixels: number[][]): void {
  const charBase = characterBaseBlock * 0x4000;
  const tileBase = charBase + tileIndex * 64;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      vram[tileBase + row * 8 + col] = pixels[row]![col]! & 0xff;
    }
  }
}

/** Write a BGR555 colour into the palette at index `palIndex`. */
function writePalette(palette: Uint8Array, palIndex: number, bgr555: number): void {
  palette[palIndex * 2] = bgr555 & 0xff;
  palette[palIndex * 2 + 1] = (bgr555 >>> 8) & 0xff;
}

const RED_BGR555 = 0x001f;
const GREEN_BGR555 = 0x03e0;
const BLUE_BGR555 = 0x7c00;
const RED_RGBA = 0xff0000ff;
const GREEN_RGBA = 0xff00ff00;
const BLUE_RGBA = 0xffff0000;

describe("renderTextBg — 4bpp text BG", () => {
  it("renders a single tile at (0,0) using palette bank 0", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();

    // Sub-palette 0: index 1 = red.
    writePalette(palette, 1, RED_BGR555);

    // Tile 0 in charblock 0: pixel (0,0) is index 1, others index 0.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppTile(vram, 0, 0, tile);

    // Screen block 1, tilemap entry (0,0): tile 0, no flip, palette bank 0.
    writeTilemapEntry(vram, 1, 0, 0, 0);

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
    expect(pixelAt(out, 1, 0)).toBe(0); // index 0 → transparent
  });

  it("palette bank selects the sub-palette in 4bpp", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();

    // Sub-palette 5: index 1 lives at global palette index (5<<4)|1 = 0x51.
    writePalette(palette, 0x51, GREEN_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0, { palBank: 5 });

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(GREEN_RGBA);
  });

  it("horizontal flip mirrors a tile left↔right", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();
    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1; // left edge of row 0
    write4bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0, { hflip: true });

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
    expect(pixelAt(out, 7, 0)).toBe(RED_RGBA);
  });

  it("vertical flip mirrors a tile top↔bottom", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();
    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1; // top-left
    write4bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0, { vflip: true });

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
    expect(pixelAt(out, 0, 7)).toBe(RED_RGBA);
  });

  it("hflip + vflip rotates a tile 180°", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();
    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1; // top-left
    write4bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0, { hflip: true, vflip: true });

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 7, 7)).toBe(RED_RGBA);
  });

  it("horizontal scroll shifts the BG and wraps at 256", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig({ hofs: 256 - 1 }); // 1 pixel of last column visible at left
    writePalette(palette, 1, RED_BGR555);

    // Fill tilemap with tile 0; tile 0 has its rightmost-column entirely red.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let r = 0; r < 8; r++) tile[r]![7] = 1;
    write4bppTile(vram, 0, 0, tile);
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) writeTilemapEntry(vram, 1, tx, ty, 0);
    }

    renderTextBg(config, vram, palette, out);
    // hofs=255 → world x for screen x=0 is 255 (= rightmost column of last tile).
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
    // screen x=1 → world x=0 (wrap) → leftmost column of tile 0 (index 0, transparent).
    expect(pixelAt(out, 1, 0)).toBe(0);
  });

  it("screen-size 1 (512×256) crosses into the second screen block at tx=32", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig({ screenSize: 1, hofs: 256 });
    writePalette(palette, 1, BLUE_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppTile(vram, 0, 0, tile);

    // Tile (0,0) of the SECOND screen block (= world tile (32, 0)) → SB 2.
    writeTilemapEntry(vram, 2, 0, 0, 0);

    renderTextBg(config, vram, palette, out);
    // hofs=256 means screen-x 0 is world-x 256 = first column of the
    // first tile in the right-hand screen block.
    expect(pixelAt(out, 0, 0)).toBe(BLUE_RGBA);
  });

  it("screen-size 3 (512×512) picks the bottom-right screen block for (tx=32, ty=32)", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig({ screenSize: 3, hofs: 256, vofs: 256 });
    writePalette(palette, 1, GREEN_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppTile(vram, 0, 0, tile);

    // BR screen block is SB+3 = 4.
    writeTilemapEntry(vram, 4, 0, 0, 0);

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(GREEN_RGBA);
  });
});

describe("renderTextBg — 8bpp text BG", () => {
  it("reads a full byte per pixel and indexes the 256-colour palette directly", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig({ colorMode8bpp: true });

    writePalette(palette, 0x42, BLUE_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[3]![5] = 0x42;
    write8bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0);

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 5, 3)).toBe(BLUE_RGBA);
    expect(pixelAt(out, 0, 0)).toBe(0); // index 0 = transparent
  });

  it("ignores the tilemap's palette-bank field in 8bpp mode", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig({ colorMode8bpp: true });

    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write8bppTile(vram, 0, 0, tile);

    writeTilemapEntry(vram, 1, 0, 0, 0, { palBank: 7 });

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
  });
});

describe("renderTextBg — transparency", () => {
  it("palette index 0 is transparent in 4bpp, regardless of palette bank", () => {
    const { vram, palette, out } = makeBuffers();
    const config = defaultConfig();

    // Even if palette entry 0 is opaque-red, an in-tile nibble of 0
    // is transparent (the GBA's "colour 0 is transparent" rule).
    writePalette(palette, 0, RED_BGR555);
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    renderTextBg(config, vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
  });
});

/** Default identity-ish affine config: PA=PD=1.0 (in 8.8 = 0x100),
 *  PB=PC=0, ref at origin, BG size = 128×128, charblock 0, screen
 *  block 16 (so its 256-byte tilemap doesn't collide with tile 0). */
function defaultAffineConfig(overrides: Partial<AffineBgConfig> = {}): AffineBgConfig {
  return {
    characterBaseBlock: 0,
    screenBaseBlock: 16,
    screenSize: 0,
    wraparound: false,
    refX: 0,
    refY: 0,
    pa: 0x100,
    pb: 0,
    pc: 0,
    pd: 0x100,
    ...overrides
  };
}

/** Write an 8bpp tile (64 bytes) into the given charblock + tile
 *  index. Affine BGs always use 8bpp tiles. */
function write8bppTileAffine(
  vram: Uint8Array,
  characterBaseBlock: number,
  tileIndex: number,
  pixels: number[][]
): void {
  const charBase = characterBaseBlock * 0x4000;
  const tileBase = charBase + tileIndex * 64;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      vram[tileBase + r * 8 + c] = pixels[r]![c]! & 0xff;
    }
  }
}

/** Write a one-byte tilemap entry for an affine BG: tilemap is a flat
 *  byte array `tileGrid × tileGrid` from screenBaseBlock. */
function writeAffineTilemap(
  vram: Uint8Array,
  screenBaseBlock: number,
  tileGrid: number,
  tx: number,
  ty: number,
  tileIndex: number
): void {
  const base = screenBaseBlock * 0x800;
  vram[base + ty * tileGrid + tx] = tileIndex & 0xff;
}

describe("renderAffineBg", () => {
  it("identity matrix (PA=PD=1.0) reads tile (0,0)→pixel(0,0)", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 5, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 5;
    write8bppTileAffine(vram, 0, 1, tile); // tile index 1 (slot 1, not 0 to avoid screen-block collision)
    writeAffineTilemap(vram, 16, 16, 0, 0, 1);

    renderAffineBg(defaultAffineConfig(), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
  });

  it("palette index 0 in the affine tile renders transparent", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 5, RED_BGR555);

    // Tile is all zeros → entirely transparent.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    write8bppTileAffine(vram, 0, 1, tile);
    writeAffineTilemap(vram, 16, 16, 0, 0, 1);

    renderAffineBg(defaultAffineConfig(), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
  });

  it("translation by refX/refY shifts the sampled point", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 7, GREEN_BGR555);

    // Tile 1: (0,0) is index 7 (green).
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 7;
    write8bppTileAffine(vram, 0, 1, tile);
    // Place the tile at map (1, 0) so it occupies screen pixels (8..15, 0..7).
    writeAffineTilemap(vram, 16, 16, 1, 0, 1);

    // refX = +8 (in 8.8 fixed point = 8 * 256 = 2048): with identity
    // matrix texX at screen x=0 is 8, which lands inside the tile we
    // placed at map (1, 0).
    renderAffineBg(defaultAffineConfig({ refX: 8 * 256 }), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(GREEN_RGBA);
  });

  it("PA=0x200 (2.0 zoom) doubles sample x-step → halves the apparent tile", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 1, BLUE_BGR555);

    // Tile 1: row 0 pixels (0..7) are all index 1 (blue), nothing else.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let c = 0; c < 8; c++) tile[0]![c] = 1;
    write8bppTileAffine(vram, 0, 1, tile);
    writeAffineTilemap(vram, 16, 16, 0, 0, 1);

    // PA=0x200 means each screen x step advances 2 in tex space. So
    // 8 source pixels cover screen x 0..3 (then they're past the tile
    // row but still on the map). And vertical step stays 1 per row.
    renderAffineBg(defaultAffineConfig({ pa: 0x200 }), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(BLUE_RGBA);
    expect(pixelAt(out, 3, 0)).toBe(BLUE_RGBA);
    // Screen x=4 samples tex x=8 (tile row 0 stops at tex x=7) → transparent.
    expect(pixelAt(out, 4, 0)).toBe(0);
  });

  it("wraparound off — out-of-map samples are transparent", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write8bppTileAffine(vram, 0, 1, tile);
    writeAffineTilemap(vram, 16, 16, 0, 0, 1);

    // BG size 0 = 128×128. refX = 128*256 starts the sample at tex x=128
    // (just past the right edge); with wrap off everything is transparent.
    renderAffineBg(defaultAffineConfig({ refX: 128 * 256, wraparound: false }), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(0);
  });

  it("wraparound on — out-of-map samples wrap modulo BG size", () => {
    const { vram, palette, out } = makeBuffers();
    writePalette(palette, 1, RED_BGR555);

    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write8bppTileAffine(vram, 0, 1, tile);
    writeAffineTilemap(vram, 16, 16, 0, 0, 1);

    // refX = 128*256 wraps to tex x=0 — first pixel hits tile 1 (solid red).
    renderAffineBg(defaultAffineConfig({ refX: 128 * 256, wraparound: true }), vram, palette, out);
    expect(pixelAt(out, 0, 0)).toBe(RED_RGBA);
  });
});
