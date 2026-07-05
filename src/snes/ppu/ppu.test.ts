import { describe, expect, it } from "vitest";

import { SnesPpu } from "./ppu.js";

function pixel(ppu: SnesPpu, x: number, y: number): [number, number, number] {
  const o = (y * 256 + x) * 4;
  return [ppu.framebuffer[o]!, ppu.framebuffer[o + 1]!, ppu.framebuffer[o + 2]!];
}

/** Render every visible line by ticking a full frame's worth of cycles. */
function renderFrame(ppu: SnesPpu): void {
  ppu.tick(262 * 1364);
}

/** Minimal mode-0 scene: one solid 8×8 tile at the top-left, red palette. */
function sceneMode0(ppu: SnesPpu): void {
  ppu.writeReg(0x2100, 0x0f); // full brightness, blanking off
  ppu.writeReg(0x2105, 0x00); // mode 0
  ppu.writeReg(0x2107, 0x04); // BG1 tilemap at word $0400
  ppu.writeReg(0x210b, 0x01); // BG1 chr at word $1000
  ppu.writeReg(0x212c, 0x01); // main screen: BG1

  // tile 1: solid colour 1 (plane 0 all ones)
  ppu.writeReg(0x2115, 0x80);
  ppu.writeReg(0x2116, 0x08); // words $1000 + tile1*8 = $1008
  ppu.writeReg(0x2117, 0x10);
  for (let row = 0; row < 8; row++) {
    ppu.writeReg(0x2118, 0xff);
    ppu.writeReg(0x2119, 0x00);
  }
  // tilemap entry (0,0) = tile 1
  ppu.writeReg(0x2116, 0x00);
  ppu.writeReg(0x2117, 0x04);
  ppu.writeReg(0x2118, 0x01);
  ppu.writeReg(0x2119, 0x00);

  // CGRAM: colour 0 = black, colour 1 = pure red
  ppu.writeReg(0x2121, 0);
  ppu.writeReg(0x2122, 0x00);
  ppu.writeReg(0x2122, 0x00);
  ppu.writeReg(0x2122, 0x1f); // red low
  ppu.writeReg(0x2122, 0x00);
}

describe("SnesPpu ports", () => {
  it("VRAM port honours the increment-on-high/low select", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2115, 0x80); // step after $2119
    ppu.writeReg(0x2116, 0x10);
    ppu.writeReg(0x2117, 0x00);
    ppu.writeReg(0x2118, 0xaa);
    ppu.writeReg(0x2119, 0xbb); // now steps
    ppu.writeReg(0x2118, 0xcc);
    expect(ppu.vram[0x20]).toBe(0xaa);
    expect(ppu.vram[0x21]).toBe(0xbb);
    expect(ppu.vram[0x22]).toBe(0xcc);
  });

  it("VRAM reads come from the prefetch latch (first word twice — the dummy-read quirk)", () => {
    const ppu = new SnesPpu();
    ppu.vram[0x40] = 0x12;
    ppu.vram[0x41] = 0x34;
    ppu.vram[0x42] = 0x56;
    ppu.vram[0x43] = 0x78;
    ppu.writeReg(0x2115, 0x80);
    ppu.writeReg(0x2116, 0x20);
    ppu.writeReg(0x2117, 0x00); // loads prefetch from word $20
    // The trigger read reloads the latch from the CURRENT address before
    // incrementing, so the first word comes back twice — the reason games
    // do a dummy read after setting VMADD.
    expect(ppu.readReg(0x2139)).toBe(0x12);
    expect(ppu.readReg(0x213a)).toBe(0x34);
    expect(ppu.readReg(0x2139)).toBe(0x12);
    expect(ppu.readReg(0x213a)).toBe(0x34);
    expect(ppu.readReg(0x2139)).toBe(0x56);
    expect(ppu.readReg(0x213a)).toBe(0x78);
  });

  it("applies the VMAIN 8-bit address remap", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2115, 0x04); // remap mode 1
    ppu.writeReg(0x2116, 0x01); // a = $0001 -> remapped word (1<<3)
    ppu.writeReg(0x2117, 0x00);
    ppu.writeReg(0x2118, 0x99);
    expect(ppu.vram[(1 << 3) << 1]).toBe(0x99);
  });

  it("CGRAM dual-write latch commits on the second byte", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2121, 5);
    ppu.writeReg(0x2122, 0x34);
    expect(ppu.cgram[10]).toBe(0); // latched, not committed
    ppu.writeReg(0x2122, 0x12);
    expect(ppu.cgram[10]).toBe(0x34);
    expect(ppu.cgram[11]).toBe(0x12);
    expect(ppu.readReg(0x213b)).toBe(0); // read reset to addr 6 low... addr advanced
  });

  it("OAM dual-write latch pairs low/high table writes", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2102, 0x02); // word addr 2 -> byte 4
    ppu.writeReg(0x2103, 0x00);
    ppu.writeReg(0x2104, 0x11);
    ppu.writeReg(0x2104, 0x22);
    expect(ppu.oam[4]).toBe(0x11);
    expect(ppu.oam[5]).toBe(0x22);
  });
});

describe("SnesPpu rendering", () => {
  it("renders black while force-blanked", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2100, 0x80);
    renderFrame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([0, 0, 0]);
  });

  it("renders a mode-0 tile with the backdrop around it", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    renderFrame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([248, 0, 0]); // tile colour 1 = red
    expect(pixel(ppu, 20, 4)).toEqual([0, 0, 0]); // backdrop
  });

  it("applies horizontal and vertical scroll", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x210d, 0x04); // BG1HOFS = 4 (dual write)
    ppu.writeReg(0x210d, 0x00);
    renderFrame(ppu);
    expect(pixel(ppu, 3, 4)).toEqual([248, 0, 0]); // tile shifted left
    expect(pixel(ppu, 4, 4)).toEqual([0, 0, 0]);
  });

  it("scales output by INIDISP brightness", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2100, 0x07); // half brightness
    renderFrame(ppu);
    const [r] = pixel(ppu, 4, 4);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(140);
  });

  it("raises the VBlank NMI flag at line 225 and clears at wrap", () => {
    const ppu = new SnesPpu();
    let vblanks = 0;
    ppu.onVBlankStart = () => vblanks++;
    ppu.tick(226 * 1364);
    expect(ppu.inVBlank).toBe(true);
    expect(ppu.nmiFlag).toBe(true);
    ppu.nmiFlag = false;
    ppu.tick((262 - 226) * 1364 + 10 * 1364);
    expect(ppu.inVBlank).toBe(false);
    expect(vblanks).toBe(1);
  });

  it("renders an OBJ sprite above a lower-priority background", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    // sprite tile 1 in OBJ chr at word $2000 (OBSEL name base 1)
    ppu.writeReg(0x2101, 0x01);
    for (let row = 0; row < 8; row++) {
      const addr = (0x2010 + row) << 1; // tile 1 (16 words each at 4bpp)
      ppu.vram[addr] = 0xff;
      ppu.vram[addr + 1] = 0x00;
    }
    // OAM sprite 0: x=2, y=1, tile 1, palette 0, priority 3
    ppu.writeReg(0x2102, 0x00);
    ppu.writeReg(0x2103, 0x00);
    ppu.writeReg(0x2104, 0x02);
    ppu.writeReg(0x2104, 0x01);
    ppu.writeReg(0x2104, 0x01);
    ppu.writeReg(0x2104, 0x30);
    // OBJ palette colour 129 = green
    ppu.writeReg(0x2121, 129);
    ppu.writeReg(0x2122, 0xe0);
    ppu.writeReg(0x2122, 0x03);
    ppu.writeReg(0x212c, 0x11); // BG1 + OBJ
    renderFrame(ppu);
    expect(pixel(ppu, 3, 2)).toEqual([0, 248, 0]); // sprite over tile
    expect(pixel(ppu, 4, 1)).toEqual([248, 0, 0]); // above sprite top: BG
  });
});

describe("SnesPpu windows and colour math", () => {
  it("masks a main-screen layer inside window 1", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2123, 0x02); // BG1: window 1 enabled, not inverted
    ppu.writeReg(0x2126, 0x02); // W1 left = 2
    ppu.writeReg(0x2127, 0x05); // W1 right = 5
    ppu.writeReg(0x212e, 0x01); // main-screen window mask: BG1
    renderFrame(ppu);
    expect(pixel(ppu, 1, 4)).toEqual([248, 0, 0]); // outside window: tile
    expect(pixel(ppu, 3, 4)).toEqual([0, 0, 0]); // inside window: masked
    expect(pixel(ppu, 6, 4)).toEqual([248, 0, 0]);
  });

  it("inverts the window when the invert bit is set", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2123, 0x03); // BG1: window 1 enabled + inverted
    ppu.writeReg(0x2126, 0x02);
    ppu.writeReg(0x2127, 0x05);
    ppu.writeReg(0x212e, 0x01);
    renderFrame(ppu);
    expect(pixel(ppu, 3, 4)).toEqual([248, 0, 0]); // inside range: kept
    expect(pixel(ppu, 6, 4)).toEqual([0, 0, 0]); // outside: masked
  });

  it("adds the fixed colour to enabled layers", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2131, 0x01); // math on BG1, add, full
    ppu.writeReg(0x2132, 0x40 | 0x10); // fixed green = 16
    renderFrame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([248, 128, 0]); // red + green/16
    expect(pixel(ppu, 20, 4)).toEqual([0, 0, 0]); // backdrop unaffected
  });

  it("subtracts with halving", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2131, 0xc1); // subtract + half, BG1
    ppu.writeReg(0x2132, 0x20 | 0x0f); // fixed red = 15
    renderFrame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([64, 0, 0]); // (31-15)/2 = 8 -> 64
  });

  it("uses the sub screen as the math operand when CGWSEL selects it", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    // BG2 tile on the sub screen: reuse tile 1 with a green palette 1
    ppu.writeReg(0x2108, 0x04); // BG2 same tilemap
    ppu.writeReg(0x210b, 0x11); // BG2 chr same as BG1
    ppu.writeReg(0x212d, 0x02); // sub screen: BG2
    ppu.writeReg(0x2130, 0x02); // math operand = sub screen
    ppu.writeReg(0x2131, 0x01); // add on BG1
    // BG2 uses palette base bg*32 = 32 -> colour 33; make it green
    ppu.writeReg(0x2121, 33);
    ppu.writeReg(0x2122, 0xe0);
    ppu.writeReg(0x2122, 0x03);
    renderFrame(ppu);
    expect(pixel(ppu, 4, 4)).toEqual([248, 248, 0]); // red + green
  });

  it("clips the main screen to black inside the colour window", () => {
    const ppu = new SnesPpu();
    sceneMode0(ppu);
    ppu.writeReg(0x2125, 0x20); // colour window: window 1 enabled
    ppu.writeReg(0x2126, 0x00);
    ppu.writeReg(0x2127, 0x03);
    ppu.writeReg(0x2130, 0x80); // clip to black inside
    renderFrame(ppu);
    expect(pixel(ppu, 2, 4)).toEqual([0, 0, 0]);
    expect(pixel(ppu, 5, 4)).toEqual([248, 0, 0]);
  });
});

describe("SnesPpu Mode 7", () => {
  function sceneMode7(ppu: SnesPpu): void {
    ppu.writeReg(0x2100, 0x0f);
    ppu.writeReg(0x2105, 0x07); // mode 7
    ppu.writeReg(0x212c, 0x01);
    // tilemap: all zeros -> tile 0 everywhere; tile 0 chr = solid colour 5
    for (let i = 0; i < 64; i++) ppu.vram[(i << 1) + 1] = 5;
    // colour 5 = blue
    ppu.writeReg(0x2121, 5);
    ppu.writeReg(0x2122, 0x00);
    ppu.writeReg(0x2122, 0x7c);
    // identity matrix (1.0 = $0100)
    ppu.writeReg(0x211b, 0x00);
    ppu.writeReg(0x211b, 0x01);
    ppu.writeReg(0x211e, 0x00);
    ppu.writeReg(0x211e, 0x01);
  }

  it("renders the affine playfield with an identity matrix", () => {
    const ppu = new SnesPpu();
    sceneMode7(ppu);
    renderFrame(ppu);
    expect(pixel(ppu, 10, 10)).toEqual([0, 0, 248]);
    expect(pixel(ppu, 200, 100)).toEqual([0, 0, 248]);
  });

  it("supports the transparent screen-over mode outside the playfield", () => {
    const ppu = new SnesPpu();
    sceneMode7(ppu);
    ppu.writeReg(0x211a, 0x80); // screen-over: transparent
    // scroll far off the 1024x1024 field
    ppu.writeReg(0x210d, 0x00);
    ppu.writeReg(0x210d, 0x18); // hofs = $1800 (negative 13-bit -> -2048)
    renderFrame(ppu);
    expect(pixel(ppu, 10, 10)).toEqual([0, 0, 0]); // backdrop
  });

  it("computes the M7A*M7B product in $2134-$2136", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x211b, 0x00); // M7A = $0200 (512)
    ppu.writeReg(0x211b, 0x02);
    ppu.writeReg(0x211c, 0xfe); // M7B last byte = -2
    const product = ppu.readReg(0x2134)! | (ppu.readReg(0x2135)! << 8) | (ppu.readReg(0x2136)! << 16);
    expect(((product << 8) >> 8) | 0).toBe(512 * -2);
  });
});

describe("SnesPpu H/V latch counters", () => {
  it("latches on $2137 and reads out with the low/high toggle", () => {
    const ppu = new SnesPpu();
    ppu.tick(100 * 1364 + 600); // line 100, mid-line
    ppu.readReg(0x2137); // latch
    const vLow = ppu.readReg(0x213d)!;
    const vHigh = ppu.readReg(0x213d)!;
    expect(vLow | (vHigh << 8)).toBe(100);
    const hLow = ppu.readReg(0x213c)!;
    const hHigh = ppu.readReg(0x213c)!;
    expect(hLow | (hHigh << 8)).toBe(150); // 600 master / 4
  });

  it("STAT78 reports and clears the latch flag and resets the toggles", () => {
    const ppu = new SnesPpu();
    ppu.tick(50 * 1364);
    ppu.readReg(0x2137);
    ppu.readReg(0x213d); // consume low
    expect(ppu.readReg(0x213f)! & 0x40).toBe(0x40);
    expect(ppu.readReg(0x213f)! & 0x40).toBe(0); // cleared
    const low = ppu.readReg(0x213d)!; // toggle reset -> low again
    expect(low).toBe(50);
  });
});

describe("SnesPpu PAL", () => {
  it("runs 312 lines per field and reports the STAT78 PAL bit", () => {
    const ppu = new SnesPpu("pal");
    expect(ppu.totalLines).toBe(312);
    expect(ppu.readReg(0x213f)! & 0x10).toBe(0x10);
    let vblanks = 0;
    ppu.onVBlankStart = () => vblanks++;
    ppu.tick(312 * 1364 * 3);
    expect(vblanks).toBe(3);
  });

  it("defaults to NTSC (262 lines, PAL bit clear)", () => {
    const ppu = new SnesPpu();
    expect(ppu.totalLines).toBe(262);
    expect(ppu.readReg(0x213f)! & 0x10).toBe(0);
  });
});

describe("SnesPpu mosaic", () => {
  /** sceneMode0 variant with tile 1 as vertical 1px stripes (colour 1 on
   *  even columns) tiled across the whole top row. */
  function stripeScene(ppu: SnesPpu): void {
    sceneMode0(ppu);
    // rewrite tile 1: plane 0 = 10101010 per row
    ppu.writeReg(0x2115, 0x80);
    ppu.writeReg(0x2116, 0x08);
    ppu.writeReg(0x2117, 0x10);
    for (let row = 0; row < 8; row++) {
      ppu.writeReg(0x2118, 0xaa);
      ppu.writeReg(0x2119, 0x00);
    }
    // fill the top tilemap row with tile 1
    ppu.writeReg(0x2116, 0x00);
    ppu.writeReg(0x2117, 0x04);
    for (let tx = 0; tx < 32; tx++) {
      ppu.writeReg(0x2118, 0x01);
      ppu.writeReg(0x2119, 0x00);
    }
  }

  it("quantizes BG sampling to the block grid", () => {
    const a = new SnesPpu();
    stripeScene(a);
    renderFrame(a);
    const fbA = a.framebuffer;
    expect(fbA[0]).toBeGreaterThan(200); // x=0 red
    expect(fbA[4]).toBeLessThan(50); // x=1 black

    const b = new SnesPpu();
    stripeScene(b);
    b.writeReg(0x2106, 0x31); // 4x4 blocks, BG1 enabled
    renderFrame(b);
    const fbB = b.framebuffer;
    expect(fbB[0]).toBeGreaterThan(200); // block 0 samples x=0 -> red
    expect(fbB[1 * 4]).toBeGreaterThan(200); // block-filled
    expect(fbB[3 * 4]).toBeGreaterThan(200);
    expect(fbB[4 * 4]).toBeGreaterThan(200); // block 1 samples x=4 -> red? x=4 even -> red
    expect(fbB[(3 * 256 + 1) * 4]).toBeGreaterThan(200); // row 3 same block row
  });

  it("mosaic blocks pick up the sampled pixel across odd offsets", () => {
    const ppu = new SnesPpu();
    stripeScene(ppu);
    ppu.writeReg(0x2106, 0x21); // 3x3 blocks
    renderFrame(ppu);
    const fb = ppu.framebuffer;
    // block starting at x=3 samples x=3 (odd column -> black)
    expect(fb[3 * 4]).toBeLessThan(50);
    expect(fb[4 * 4]).toBeLessThan(50);
    expect(fb[5 * 4]).toBeLessThan(50);
    // block starting at x=6 samples x=6 (even -> red)
    expect(fb[6 * 4]).toBeGreaterThan(200);
  });
});

describe("SnesPpu hires (modes 5/6)", () => {
  it("renders mode-5 backgrounds by blending hires pixel pairs", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2100, 0x0f);
    ppu.writeReg(0x2105, 0x05); // mode 5
    ppu.writeReg(0x2107, 0x04); // BG1 tilemap at word $0400
    ppu.writeReg(0x210b, 0x01); // BG1 chr at word $1000
    ppu.writeReg(0x212c, 0x01);
    // tile 1 solid colour 1, tile 2 empty (4bpp: planes 0/1 then 2/3)
    ppu.writeReg(0x2115, 0x80);
    ppu.writeReg(0x2116, 0x10); // word $1000 + tile1*16 = $1010
    ppu.writeReg(0x2117, 0x10);
    for (let row = 0; row < 8; row++) {
      ppu.writeReg(0x2118, 0xff); // plane 0
      ppu.writeReg(0x2119, 0x00);
    }
    // tilemap (0,0) = tile 1 -> its 16 hires px cover screen x 0-7
    ppu.writeReg(0x2116, 0x00);
    ppu.writeReg(0x2117, 0x04);
    ppu.writeReg(0x2118, 0x01);
    ppu.writeReg(0x2119, 0x00);
    // colour 1 = red
    ppu.writeReg(0x2121, 1);
    ppu.writeReg(0x2122, 0x1f);
    ppu.writeReg(0x2122, 0x00);
    ppu.tick(1364 * 2);
    const fb = ppu.framebuffer;
    // tile 1's CHR pair is (tile1, tile2): even hires px red, odd from the
    // EMPTY tile 2 -> blended halves still carry red at half intensity.
    expect(fb[0]).toBeGreaterThan(60); // x=0 has red content
    expect(fb[10 * 4]).toBe(0); // x=10 beyond the tile: black
  });
});

describe("SnesPpu offset-per-tile", () => {
  it("applies BG3-supplied vertical offsets per column in mode 2", () => {
    const ppu = new SnesPpu();
    ppu.writeReg(0x2100, 0x0f);
    ppu.writeReg(0x2105, 0x02); // mode 2
    ppu.writeReg(0x2107, 0x04); // BG1 map at $0400
    ppu.writeReg(0x2109, 0x08); // BG3 (OPT table) map at $0800
    ppu.writeReg(0x210b, 0x01); // BG1 chr at $1000
    ppu.writeReg(0x212c, 0x01);
    // tile 1 solid colour 1 (4bpp)
    ppu.writeReg(0x2115, 0x80);
    ppu.writeReg(0x2116, 0x10);
    ppu.writeReg(0x2117, 0x10);
    for (let row = 0; row < 8; row++) {
      ppu.writeReg(0x2118, 0xff);
      ppu.writeReg(0x2119, 0x00);
    }
    // BG1 map row 1 (y 8-15) = tile 1 in columns 0-3; row 0 empty
    ppu.writeReg(0x2116, 0x20); // word $0400 + 32
    ppu.writeReg(0x2117, 0x04);
    for (let t = 0; t < 4; t++) {
      ppu.writeReg(0x2118, 0x01);
      ppu.writeReg(0x2119, 0x00);
    }
    // OPT: column 2's H-entry -> apply-to-BG1 vertical offset +8 (mode 2:
    // V entry lives one map row below; H entry at row 0)
    ppu.writeReg(0x2116, 0x21 + 0x400 - 0x21); // word $0800... set precisely below
    ppu.writeReg(0x2116, 0x00);
    ppu.writeReg(0x2117, 0x08); // $0800 row 0 = H entries (none)
    // V entries at map row 1 ($0800+32): column index 1 -> screen column 2
    ppu.writeReg(0x2116, 0x21); // $0800+32+1
    ppu.writeReg(0x2117, 0x08);
    ppu.writeReg(0x2118, 0x08); // offset value 8
    ppu.writeReg(0x2119, 0x20); // bit13: apply to BG1
    // colour 1 red
    ppu.writeReg(0x2121, 1);
    ppu.writeReg(0x2122, 0x1f);
    ppu.writeReg(0x2122, 0x00);

    ppu.tick(1364); // render line 0
    const fb = ppu.framebuffer;
    // line 0 without OPT shows nothing (tiles live at y 8-15). Column 2
    // (x 16-23) is shifted down 8 -> shows tile row 1 -> red.
    expect(fb[(0 * 256 + 4) * 4]).toBe(0); // column 0: no override
    expect(fb[(0 * 256 + 18) * 4]).toBeGreaterThan(200); // column 2: red
    expect(fb[(0 * 256 + 30) * 4]).toBe(0); // column 3: no override
  });
});
