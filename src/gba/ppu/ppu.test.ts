import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import {
  blendAlpha,
  brighten,
  darken,
  DOTS_PER_SCANLINE,
  FRAMEBUFFER_BYTES,
  HBLANK_FLAG_DOT,
  Ppu,
  SCANLINES_PER_FRAME,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  VISIBLE_SCANLINES
} from "./ppu.js";

describe("Ppu — I/O register block", () => {
  it("DISPCNT round-trips a 16-bit write", () => {
    const ppu = new Ppu();
    ppu.write16(0x00, 0x1234);
    expect(ppu.read16(0x00)).toBe(0x1234);
    expect(ppu.dispcnt).toBe(0x1234);
  });

  it("DISPSTAT writes preserve VBlank/HBlank flags; the VCount-match flag re-evaluates from the new match value", () => {
    // Bits 0 (VBlank) and 1 (HBlank) are pure PPU-owned status — writes
    // never affect them. Bit 2 (VCount-match) is a combinatorial
    // function of `vcount == match-setting`, so when the cart writes a
    // new match value the bit re-evaluates immediately. F-Zero Climax's
    // cascading Mode-7 matrix DMA depends on this hardware behaviour.
    const ppu = new Ppu();
    ppu.vcount = 0xab;
    ppu.dispstat = 0x0007;
    // Write match = 0xab (matches current vcount) and bits 3-7 high.
    ppu.write16(0x04, 0xabf8);
    // VBlank + HBlank bits preserved, VCount-match stays set (vcount == match).
    expect(ppu.read16(0x04)).toBe(0xabff);

    // Now write a new match that does NOT equal vcount — bit 2 clears.
    ppu.write16(0x04, 0x10f8);
    expect(ppu.read16(0x04) & 0x4).toBe(0); // bit 2 cleared
    expect(ppu.read16(0x04) & 0x3).toBe(0x3); // bits 0, 1 still preserved
  });

  it("VCOUNT writes are ignored", () => {
    const ppu = new Ppu();
    ppu.vcount = 50;
    ppu.write16(0x06, 0);
    expect(ppu.read16(0x06)).toBe(50);
  });

  it("32-bit read of 0x04 spans DISPSTAT (low) and VCOUNT (high)", () => {
    const ppu = new Ppu();
    ppu.dispstat = 0xaaaa;
    ppu.vcount = 0x55;
    expect(ppu.read32(0x04) >>> 0).toBe((0x55 << 16) | 0xaaaa);
  });

  it("8-bit write widens to a 16-bit RMW on the addressed halfword", () => {
    const ppu = new Ppu();
    ppu.write16(0x00, 0xabcd);
    ppu.write8(0x00, 0x12);
    expect(ppu.read16(0x00)).toBe(0xab12);
    ppu.write8(0x01, 0x34);
    expect(ppu.read16(0x00)).toBe(0x3412);
  });

  it("unmapped offsets in the I/O block read zero", () => {
    const ppu = new Ppu();
    expect(ppu.read16(0x08)).toBe(0);
    // 0x56-0x5F sits past BLDY in the mapped block but isn't a register.
    expect(ppu.read16(0x56)).toBe(0);
  });
});

describe("Ppu — window / blend / mosaic register coverage", () => {
  it("WIN0H / WIN1H / WIN0V / WIN1V store 16-bit writes (write-only on read)", () => {
    // These registers are write-only on real hardware; reads return
    // open-bus per the mgba-suite io-read test. Verify the writes
    // landed in the stored fields the renderer consumes — read-back
    // behaviour is covered by the open-bus test below.
    const ppu = new Ppu();
    ppu.write16(0x40, 0x10f0);
    ppu.write16(0x42, 0x20e0);
    ppu.write16(0x44, 0x30d0);
    ppu.write16(0x46, 0x40c0);
    expect(ppu.win0h).toBe(0x10f0);
    expect(ppu.win1h).toBe(0x20e0);
    expect(ppu.win0v).toBe(0x30d0);
    expect(ppu.win1v).toBe(0x40c0);
  });

  it("WININ / WINOUT mask out the unused bits 6-7 / 14-15", () => {
    const ppu = new Ppu();
    ppu.write16(0x48, 0xffff);
    expect(ppu.read16(0x48)).toBe(0x3f3f);
    ppu.write16(0x4a, 0xabcd);
    expect(ppu.read16(0x4a)).toBe(0xabcd & 0x3f3f);
  });

  it("MOSAIC stores a 16-bit write (write-only on read)", () => {
    const ppu = new Ppu();
    ppu.write16(0x4c, 0xfedc);
    expect(ppu.mosaic).toBe(0xfedc);
  });

  it("BLDCNT masks out the unused bits 14-15", () => {
    const ppu = new Ppu();
    ppu.write16(0x50, 0xffff);
    expect(ppu.read16(0x50)).toBe(0x3fff);
  });

  it("BLDALPHA keeps 5-bit EVA / EVB and zeros the in-between bits", () => {
    const ppu = new Ppu();
    ppu.write16(0x52, 0xffff);
    expect(ppu.read16(0x52)).toBe(0x1f1f);
  });

  it("BLDY keeps 5-bit EVY and zeros the rest (stored value)", () => {
    // BLDY is write-only — verify the masked value lands in the field
    // the renderer consumes. Bus reads return open-bus per real
    // hardware (covered separately).
    const ppu = new Ppu();
    ppu.write16(0x54, 0xffff);
    expect(ppu.bldy).toBe(0x001f);
  });

  it("write-only register reads return halfwords of the CPU open-bus word", () => {
    // Models the mgba-suite io-read test: after each probed write, the
    // ldrh's prefetched ARM literal pool holds 0xDEADBEEF (low half
    // 0xBEEF, high half 0xDEAD). The PPU's openBusSource callback
    // mirrors what ArmCpu exposes during instruction execution.
    const ppu = new Ppu();
    ppu.openBusSource = () => 0xdeadbeef;
    ppu.write16(0x10, 0xffff); // BG0HOFS
    ppu.write16(0x12, 0xffff); // BG0VOFS
    expect(ppu.read16(0x10)).toBe(0xbeef); // aligned bit 1 = 0 → low half
    expect(ppu.read16(0x12)).toBe(0xdead); // aligned bit 1 = 1 → high half
    ppu.write16(0x4c, 0xffff); // MOSAIC
    expect(ppu.read16(0x4c)).toBe(0xbeef);
    ppu.write16(0x54, 0xffff); // BLDY
    expect(ppu.read16(0x54)).toBe(0xbeef);
  });

  it("BG0CNT / BG1CNT force bit 13 to zero on read (no display-area-overflow)", () => {
    // mgba-suite io-read writes 0xFFFF to BGxCNT and expects 0xDFFF
    // for BG0/1 (bit 13 only valid on the affine-capable BG2/3).
    const ppu = new Ppu();
    ppu.write16(0x08, 0xffff); // BG0CNT
    ppu.write16(0x0a, 0xffff); // BG1CNT
    ppu.write16(0x0c, 0xffff); // BG2CNT
    ppu.write16(0x0e, 0xffff); // BG3CNT
    expect(ppu.read16(0x08)).toBe(0xdfff);
    expect(ppu.read16(0x0a)).toBe(0xdfff);
    expect(ppu.read16(0x0c)).toBe(0xffff);
    expect(ppu.read16(0x0e)).toBe(0xffff);
  });

  it("8-bit writes RMW into the window / blend block", () => {
    const ppu = new Ppu();
    ppu.write16(0x48, 0x1234);
    ppu.write8(0x48, 0xcd);
    // 0xCD AND 0x3F (WININ low byte mask) = 0x0D, but the read-modify-
    // write first reads back the masked 0x1234 = 0x1234 & 0x3F3F = 0x1234.
    expect(ppu.read16(0x48)).toBe(0x12cd & 0x3f3f);
  });
});

describe("Ppu — state machine", () => {
  it("H-blank flag asserts at dot 252, not at draw end (dot 240)", () => {
    // Real hardware: HBLANK flag goes 0→1 at cycle 1006 of each
    // scanline (dot ~251.5). Pixel output finishes at dot 240, leaving
    // an ~11-dot gap during which the flag stays clear. mgba-suite
    // misc-edge "H-blank bit start" probes this.
    const ppu = new Ppu();
    ppu.tick(HBLANK_FLAG_DOT - 1);
    expect(ppu.dispstat & 0b010).toBe(0);
    ppu.tick(1);
    expect(ppu.dispstat & 0b010).toBe(0b010);
  });

  it("H-blank flag clears at the start of the next scanline", () => {
    const ppu = new Ppu();
    ppu.tick(DOTS_PER_SCANLINE);
    expect(ppu.dispstat & 0b010).toBe(0);
    expect(ppu.vcount).toBe(1);
    expect(ppu.dot).toBe(0);
  });

  it("VCOUNT advances one per scanline", () => {
    const ppu = new Ppu();
    ppu.tick(DOTS_PER_SCANLINE * 5);
    expect(ppu.vcount).toBe(5);
  });

  it("V-blank flag asserts when VCOUNT reaches 160 and clears when it wraps to 0", () => {
    const ppu = new Ppu();
    ppu.tick(DOTS_PER_SCANLINE * VISIBLE_SCANLINES);
    expect(ppu.vcount).toBe(VISIBLE_SCANLINES);
    expect(ppu.dispstat & 0b001).toBe(0b001);

    // Advance through the rest of the V-blank back to scanline 0.
    ppu.tick(DOTS_PER_SCANLINE * (SCANLINES_PER_FRAME - VISIBLE_SCANLINES));
    expect(ppu.vcount).toBe(0);
    expect(ppu.dispstat & 0b001).toBe(0);
  });

  it("V-count match flag asserts when VCOUNT equals the user-set match value", () => {
    const ppu = new Ppu();
    // Write the match value (bits 15:8 of DISPSTAT) to 5; bus writes
    // preserve the status bits.
    ppu.write16(0x04, 5 << 8);
    ppu.tick(DOTS_PER_SCANLINE * 5);
    expect(ppu.vcount).toBe(5);
    expect(ppu.dispstat & 0b100).toBe(0b100);
    // Advance one more scanline: VCOUNT=6, match should clear.
    ppu.tick(DOTS_PER_SCANLINE);
    expect(ppu.dispstat & 0b100).toBe(0);
  });

  it("full frame wraps VCOUNT back to 0", () => {
    const ppu = new Ppu();
    ppu.tick(DOTS_PER_SCANLINE * SCANLINES_PER_FRAME);
    expect(ppu.vcount).toBe(0);
    expect(ppu.dot).toBe(0);
  });
});

describe("MappedBus + PPU I/O wiring", () => {
  it("CPU-style 32-bit read at 0x04000004 returns DISPSTAT|VCOUNT", () => {
    const mem = makeGbaMemoryMap();
    mem.ppu.dispstat = 0x1234;
    mem.ppu.vcount = 0x42;
    expect(mem.bus.read32(0x04000004) >>> 0).toBe((0x42 << 16) | 0x1234);
  });

  it("CPU-style 16-bit write to DISPCNT goes through the handler", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000000, 0x0403);
    expect(mem.ppu.dispcnt).toBe(0x0403);
  });

  it("I/O space sits in its own region, not in EWRAM/IWRAM", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000000, 0xbeef);
    expect(mem.ewram[0]).toBe(0);
    expect(mem.iwram[0]).toBe(0);
  });

  it("unmapped I/O offsets read zero (open-bus stand-in)", () => {
    const mem = makeGbaMemoryMap();
    expect(mem.bus.read16(0x04000050)).toBe(0);
  });

  it("PPU tick is observable through the bus DISPSTAT read", () => {
    const mem = makeGbaMemoryMap();
    mem.ppu.tick(DOTS_PER_SCANLINE * VISIBLE_SCANLINES);
    expect(mem.bus.read16(0x04000004) & 0b001).toBe(0b001);
    expect(mem.bus.read16(0x04000006)).toBe(VISIBLE_SCANLINES);
  });
});

/** Pull the RGBA pixel at (x, y) out of the framebuffer as a single
 *  little-endian u32, matching the renderer's storage format. */
function pixelAt(ppu: Ppu, x: number, y: number): number {
  const i = (y * SCREEN_WIDTH + x) * 4;
  return (
    ((ppu.framebuffer[i] ?? 0) |
      ((ppu.framebuffer[i + 1] ?? 0) << 8) |
      ((ppu.framebuffer[i + 2] ?? 0) << 16) |
      ((ppu.framebuffer[i + 3] ?? 0) << 24)) >>>
    0
  );
}

describe("Ppu — frame renderer", () => {
  it("allocates a 240×160×4 RGBA framebuffer", () => {
    const ppu = new Ppu();
    expect(ppu.framebuffer.length).toBe(FRAMEBUFFER_BYTES);
    expect(ppu.framebuffer.length).toBe(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  });

  it("forced blank renders white regardless of mode", () => {
    const ppu = new Ppu();
    ppu.dispcnt = 0x0083; // mode 3 + forced blank + BG2 enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffffffff);
    expect(pixelAt(ppu, SCREEN_WIDTH - 1, SCREEN_HEIGHT - 1)).toBe(0xffffffff);
  });

  it("BG2 disabled paints the backdrop (palette entry 0)", () => {
    const palette = new Uint8Array(0x400);
    // BGR555 pure red = R=31, G=0, B=0 → 0x001F.
    palette[0] = 0x1f;
    palette[1] = 0x00;
    const ppu = new Ppu(new Uint8Array(0x18000), palette);
    ppu.dispcnt = 0x0003; // mode 3, BG2 disabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 100, 100)).toBe(0xff0000ff);
  });

  it("mode 3 reads BGR555 directly from VRAM", () => {
    const vram = new Uint8Array(0x18000);
    // Pixel (0,0) = pure red (0x001F).
    vram[0] = 0x1f;
    vram[1] = 0x00;
    // Pixel (1,0) = pure green (0x03E0).
    vram[2] = 0xe0;
    vram[3] = 0x03;
    // Pixel (239,159) = pure blue (0x7C00).
    const last = (SCREEN_HEIGHT * SCREEN_WIDTH - 1) * 2;
    vram[last] = 0x00;
    vram[last + 1] = 0x7c;

    const ppu = new Ppu(vram);
    ppu.dispcnt = 0x0403; // mode 3 + BG2 enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff); // red
    expect(pixelAt(ppu, 1, 0)).toBe(0xff00ff00); // green
    expect(pixelAt(ppu, SCREEN_WIDTH - 1, SCREEN_HEIGHT - 1)).toBe(0xffff0000); // blue
  });

  it("BGR555 white (0x7FFF) round-trips to 0xFF white (no 0xF8 loss)", () => {
    const vram = new Uint8Array(0x18000);
    vram[0] = 0xff;
    vram[1] = 0x7f;
    const ppu = new Ppu(vram);
    ppu.dispcnt = 0x0403;
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffffffff);
  });

  it("mode 4 reads palette-indexed bytes from VRAM page 0", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    // Palette index 5 = pure green.
    palette[5 * 2] = 0xe0;
    palette[5 * 2 + 1] = 0x03;
    vram[0] = 5; // pixel (0,0) uses palette entry 5

    const ppu = new Ppu(vram, palette);
    ppu.dispcnt = 0x0404; // mode 4 + BG2 enabled, page 0
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff00ff00);
  });

  it("mode 4 page-select switches the VRAM base to 0xA000", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    palette[3 * 2] = 0x1f;
    palette[3 * 2 + 1] = 0x00;
    // Page-1 pixel (0,0) lives at VRAM offset 0xA000.
    vram[0xa000] = 3;

    const ppu = new Ppu(vram, palette);
    ppu.dispcnt = 0x0404 | (1 << 4); // mode 4 + BG2 + page 1
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
  });

  it("mode 1 with no BG content shows the backdrop colour", () => {
    const palette = new Uint8Array(0x400);
    palette[0] = 0xff;
    palette[1] = 0x7f;
    const ppu = new Ppu(new Uint8Array(0x18000), palette);
    ppu.dispcnt = 0x0401; // mode 1 + BG2 enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 50, 50)).toBe(0xffffffff);
  });

  it("mode 5 — 160×128 BGR555 bitmap renders into the top-left", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    // Backdrop = pure blue. Bitmap pixel (0, 0) = pure red.
    palette[0] = 0x00;
    palette[1] = 0x7c;
    vram[0] = 0x1f;
    vram[1] = 0x00;
    const ppu = new Ppu(vram, palette);
    ppu.dispcnt = 0x0405; // mode 5 + BG2 enabled
    ppu.renderFrame();
    // Inside the 160×128 region — red pixel from VRAM[0].
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    // Inside the bitmap's region but uninitialised → BGR555 0x0000 = black.
    expect(pixelAt(ppu, 100, 100)).toBe(0xff000000);
    // Outside the 160×128 region (x ≥ 160) → backdrop blue.
    expect(pixelAt(ppu, 200, 50)).toBe(0xffff0000);
    // Outside on the Y axis (y ≥ 128) → backdrop blue.
    expect(pixelAt(ppu, 50, 150)).toBe(0xffff0000);
  });

  it("mode 5 page-select (DISPCNT bit 4) sources frame 1 from VRAM 0x0A000", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    // Page 1 pixel (0, 0) = pure red.
    vram[0xa000] = 0x1f;
    vram[0xa001] = 0x00;
    const ppu = new Ppu(vram, palette);
    ppu.dispcnt = 0x0405 | (1 << 4); // mode 5 + BG2 + page 1
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
  });

  it("mode 5 with BG2 disabled falls through to the backdrop colour", () => {
    const palette = new Uint8Array(0x400);
    palette[0] = 0xff;
    palette[1] = 0x7f;
    const ppu = new Ppu(new Uint8Array(0x18000), palette);
    ppu.dispcnt = 0x0005; // mode 5, BG2 NOT enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffffffff);
    expect(pixelAt(ppu, 100, 100)).toBe(0xffffffff);
  });
});

describe("Ppu — BG register I/O", () => {
  it("BG0CNT/BG1CNT/BG2CNT/BG3CNT round-trip a 16-bit write", () => {
    const ppu = new Ppu();
    ppu.write16(0x08, 0x1234);
    ppu.write16(0x0a, 0x5678);
    ppu.write16(0x0c, 0x9abc);
    ppu.write16(0x0e, 0xdef0);
    expect(ppu.read16(0x08)).toBe(0x1234);
    expect(ppu.read16(0x0a)).toBe(0x5678);
    expect(ppu.read16(0x0c)).toBe(0x9abc);
    expect(ppu.read16(0x0e)).toBe(0xdef0);
    expect(ppu.bgcnt[0]).toBe(0x1234);
    expect(ppu.bgcnt[3]).toBe(0xdef0);
  });

  it("BG*HOFS/VOFS masks to 9 bits on write (write-only on read)", () => {
    const ppu = new Ppu();
    ppu.write16(0x10, 0xffff); // BG0HOFS
    ppu.write16(0x12, 0x01ff); // BG0VOFS
    expect(ppu.bgHofs[0]).toBe(0x1ff);
    expect(ppu.bgVofs[0]).toBe(0x1ff);
  });

  it("BG3VOFS at 0x1E lives on BG3", () => {
    const ppu = new Ppu();
    ppu.write16(0x1e, 0x100);
    expect(ppu.bgVofs[3]).toBe(0x100);
    expect(ppu.bgHofs[3]).toBe(0);
  });

  it("affine matrix PA-PD stores with sign extension (write-only on read)", () => {
    const ppu = new Ppu();
    ppu.write16(0x20, 0xffff); // BG2 PA = -1 (signed)
    ppu.write16(0x36, 0x8000); // BG3 PD = -32768
    expect(ppu.affinePa[0]).toBe(-1);
    expect(ppu.affinePd[1]).toBe(-32768);
  });

  it("BG2X 32-bit write sign-extends from bit 27", () => {
    const ppu = new Ppu();
    // Set bit 27 → low half written via lo+hi 16-bit pair.
    ppu.write16(0x28, 0x0000);
    ppu.write16(0x2a, 0x0800); // hi = 0x0800 → bit 27 of the 32-bit value
    expect(ppu.affineRefX[0]!).toBe((0x08000000 << 4) >> 4); // sign-extended
    expect(ppu.affineRefX[0]! >>> 0).toBe(0xf8000000);
  });

  it("BG3Y at 0x3C / 0x3E lives on BG3 slot", () => {
    const ppu = new Ppu();
    ppu.write16(0x3c, 0x1234);
    ppu.write16(0x3e, 0x0001);
    expect(ppu.affineRefY[1]! >>> 0).toBe(0x00011234);
  });
});

describe("Ppu — affine internal reference counters", () => {
  // The renderer reads the per-line accumulator (`affineLineX/Y`), not
  // the register pair (`affineRefX/Y`). Together with `renderScanline`
  // auto-stepping by PB/PD between lines, this is what makes Mode-7
  // floor effects (Mario Kart Super Circuit, F-Zero) work.

  it("BG2X register write re-latches the internal counter immediately", () => {
    const ppu = new Ppu();
    // Step the accumulator forwards by a few scanlines so it diverges
    // from the register (no register write yet, so both start at 0).
    ppu.affinePb[0] = 0x100; // +1.0 per scanline
    ppu.renderScanline(0);
    ppu.renderScanline(1);
    expect(ppu.affineLineX[0]).toBe(0x200); // 2 × PB
    expect(ppu.affineRefX[0]).toBe(0);

    // Mid-frame write to BG2X — internal counter snaps to the new
    // register value, discarding the prior +PB accumulation.
    ppu.write16(0x28, 0x4000);
    ppu.write16(0x2a, 0x0000);
    expect(ppu.affineRefX[0]).toBe(0x00004000);
    expect(ppu.affineLineX[0]).toBe(0x00004000);
  });

  it("BG3Y write re-latches BG3's internal counter independently of BG2", () => {
    const ppu = new Ppu();
    ppu.affinePd[0] = 0x080; // BG2 PD
    ppu.affinePd[1] = 0x100; // BG3 PD
    ppu.renderScanline(0);
    expect(ppu.affineLineY[0]).toBe(0x080);
    expect(ppu.affineLineY[1]).toBe(0x100);
    // BG3Y write should not touch BG2's accumulator.
    ppu.write16(0x3c, 0xabcd);
    expect(ppu.affineLineY[0]).toBe(0x080);
    expect(ppu.affineLineY[1] !== 0x100).toBe(true);
  });

  it("auto-step adds PB to X and PD to Y between scanlines", () => {
    const ppu = new Ppu();
    ppu.affinePb[0] = 0x40;
    ppu.affinePd[0] = -0x20;
    ppu.write16(0x28, 0x1000);
    ppu.write16(0x2c, 0x2000);
    expect(ppu.affineLineX[0]).toBe(0x1000);
    expect(ppu.affineLineY[0]).toBe(0x2000);
    ppu.renderScanline(0);
    expect(ppu.affineLineX[0]).toBe(0x1040);
    expect(ppu.affineLineY[0]).toBe(0x1fe0);
    ppu.renderScanline(1);
    expect(ppu.affineLineX[0]).toBe(0x1080);
    expect(ppu.affineLineY[0]).toBe(0x1fc0);
  });

  it("DISPSTAT match-value write fires VCount IRQ when new match == current vcount (mid-frame cascade)", () => {
    // F-Zero Climax cascades per-scanline VCount-match IRQs to drive
    // its Mode-7 matrix DMA: each IRQ writes a new match = vcount+N,
    // which fires the next IRQ later that frame. If our PPU doesn't
    // re-evaluate the match flag on DISPSTAT write, the cascade dies
    // after one iteration and BG2 flickers in/out.
    const ppu = new Ppu();
    let irqs = 0;
    ppu.onVCount = () => irqs++;
    ppu.vcount = 50;
    // Enable VCount IRQ + set match to a value != vcount → flag = 0, no IRQ.
    ppu.write16(0x04, (60 << 8) | (1 << 5));
    expect(irqs).toBe(0);
    expect((ppu.dispstat & 0x4) !== 0).toBe(false);

    // Update match to current vcount → flag 0 → 1 edge, IRQ fires.
    ppu.write16(0x04, (50 << 8) | (1 << 5));
    expect(irqs).toBe(1);
    expect((ppu.dispstat & 0x4) !== 0).toBe(true);

    // Same match again → flag stays 1, no second IRQ.
    ppu.write16(0x04, (50 << 8) | (1 << 5));
    expect(irqs).toBe(1);

    // Move match off — flag clears, no IRQ.
    ppu.write16(0x04, (100 << 8) | (1 << 5));
    expect(irqs).toBe(1);
    expect((ppu.dispstat & 0x4) !== 0).toBe(false);

    // Move match back to vcount — fresh edge, IRQ fires again.
    ppu.write16(0x04, (50 << 8) | (1 << 5));
    expect(irqs).toBe(2);
  });

  it("DISPSTAT match write does NOT fire VCount IRQ when bit 5 (irq-enable) is clear", () => {
    const ppu = new Ppu();
    let irqs = 0;
    ppu.onVCount = () => irqs++;
    ppu.vcount = 50;
    // Match = 50 but irq-enable bit (5) clear → flag set but no IRQ.
    ppu.write16(0x04, 50 << 8);
    expect(irqs).toBe(0);
    expect((ppu.dispstat & 0x4) !== 0).toBe(true);
  });

  it("vcount→0 transition resets the accumulator to the register", () => {
    const ppu = new Ppu();
    ppu.write16(0x28, 0x1000);
    ppu.affinePb[0] = 0x10;
    // Render two visible scanlines so the accumulator drifts.
    ppu.renderScanline(0);
    ppu.renderScanline(1);
    expect(ppu.affineLineX[0]).toBe(0x1020);
    // Park the PPU one dot before the vcount → 0 wrap, then take that
    // wrap. The internal counter must re-latch from the register.
    ppu.vcount = SCANLINES_PER_FRAME - 1;
    ppu.dot = DOTS_PER_SCANLINE - 1;
    ppu.tick(1);
    expect(ppu.vcount).toBe(0);
    expect(ppu.affineLineX[0]).toBe(0x1000);
  });
});

describe("Ppu — mode 0 (BG0)", () => {
  function writePalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[idx * 2] = bgr555 & 0xff;
    palette[idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function write4bppTile(vram: Uint8Array, charBase: number, tileIndex: number, pixels: number[][]): void {
    const base = charBase * 0x4000 + tileIndex * 32;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) {
        const lo = pixels[r]![c]! & 0xf;
        const hi = pixels[r]![c + 1]! & 0xf;
        vram[base + r * 4 + c / 2] = lo | (hi << 4);
      }
    }
  }
  function writeTilemapEntry(vram: Uint8Array, sb: number, tx: number, ty: number, tileIndex: number): void {
    const addr = sb * 0x800 + (ty * 32 + tx) * 2;
    vram[addr] = tileIndex & 0xff;
    vram[addr + 1] = (tileIndex >>> 8) & 0xff;
  }

  it("BG0 disabled in mode 0 → backdrop only", () => {
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x001f); // backdrop = red
    const ppu = new Ppu(new Uint8Array(0x18000), palette);
    ppu.dispcnt = 0x0000; // mode 0, all BGs disabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 100, 100)).toBe(0xff0000ff);
  });

  it("BG0 enabled paints its tile output over the backdrop", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x7c00); // backdrop = blue
    writePalette(palette, 1, 0x03e0); // pal[1] = green

    // BG0: charblock 0, screen block 1, 4bpp, size 0.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![0] = 1;
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, (1 << 8) | (0 << 2)); // BG0CNT: screen base = 1, char base = 0
    ppu.dispcnt = 0x0100; // mode 0 + BG0 enabled
    ppu.renderFrame();

    expect(pixelAt(ppu, 0, 0)).toBe(0xff00ff00); // BG0's red pixel
    expect(pixelAt(ppu, 1, 0)).toBe(0xffff0000); // transparent → backdrop blue
  });

  it("forced blank overrides mode 0 + BG0", () => {
    const ppu = new Ppu();
    ppu.dispcnt = (1 << 7) | (1 << 8); // forced blank + BG0 enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffffffff);
  });

  it("higher-priority BG wins over a lower-priority BG at the same pixel", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000); // backdrop black
    writePalette(palette, 1, 0x001f); // pal[1] = red (used by BG0)
    writePalette(palette, 2, 0x7c00); // pal[2] = blue (used by BG1)

    // BG0 tile (in charblock 0): solid red across the whole tile.
    const redTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 0, redTile);
    writeTilemapEntry(vram, 1, 0, 0, 0); // BG0 screen base = 1

    // BG1 tile (in charblock 0, tile 1): solid blue.
    const blueTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    write4bppTile(vram, 0, 1, blueTile);
    writeTilemapEntry(vram, 2, 0, 0, 1); // BG1 screen base = 2

    const ppu = new Ppu(vram, palette);
    // BG0: priority 1, screen base 1, char base 0, 4bpp.
    ppu.write16(0x08, (1 << 8) | (0 << 2) | 1);
    // BG1: priority 0 (higher), screen base 2, char base 0, 4bpp.
    ppu.write16(0x0a, (2 << 8) | (0 << 2) | 0);
    ppu.dispcnt = 0x0300; // mode 0 + BG0 + BG1 enabled
    ppu.renderFrame();
    // BG1 wins (priority 0 < priority 1).
    expect(pixelAt(ppu, 0, 0)).toBe(0xffff0000);
  });

  it("equal priorities tie-break by lower BG index", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x001f); // BG0 red
    writePalette(palette, 2, 0x7c00); // BG1 blue

    const redTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    const blueTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    write4bppTile(vram, 0, 0, redTile);
    write4bppTile(vram, 0, 1, blueTile);
    writeTilemapEntry(vram, 1, 0, 0, 0);
    writeTilemapEntry(vram, 2, 0, 0, 1);

    const ppu = new Ppu(vram, palette);
    // Both BGs at priority 2.
    ppu.write16(0x08, (1 << 8) | (0 << 2) | 2);
    ppu.write16(0x0a, (2 << 8) | (0 << 2) | 2);
    ppu.dispcnt = 0x0300;
    ppu.renderFrame();
    // BG0 wins (lower BG index breaks the priority tie).
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
  });

  it("transparency on the top BG falls through to the lower BG", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000); // backdrop
    writePalette(palette, 1, 0x001f); // pal[1] = red (BG1, bottom)
    writePalette(palette, 2, 0x7c00); // pal[2] = blue (BG0, top, but transparent here)

    // BG0 tile 0: a single transparent pixel at (0,0), blue elsewhere.
    const bg0Tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(2));
    bg0Tile[0]![0] = 0; // transparent
    write4bppTile(vram, 0, 0, bg0Tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    // BG1 tile 1: solid red.
    const bg1Tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 1, bg1Tile);
    writeTilemapEntry(vram, 2, 0, 0, 1);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, (1 << 8) | 0); // BG0 priority 0 (top)
    ppu.write16(0x0a, (2 << 8) | 1); // BG1 priority 1 (under)
    ppu.dispcnt = 0x0300;
    ppu.renderFrame();
    // Transparent on BG0 → red from BG1.
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    // Elsewhere BG0 wins.
    expect(pixelAt(ppu, 1, 0)).toBe(0xffff0000);
  });

  function disableAllSprites(oam: Uint8Array): void {
    // Without a BIOS, OAM is all-zero, which decodes as 128 valid 8×8
    // sprites at (0,0) with priority 0 — they'd cover the screen
    // before any test sprite gets a chance. Mark every entry as
    // "affine off + double-or-disable = 1" to disable.
    for (let i = 0; i < 128; i++) oam[i * 8 + 1] = 0x02; // attr0 high byte bit 1 = bit 9
  }

  it("sprite at priority P is drawn above BG at priority P (OBJ wins same-priority tie)", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x001f); // BG pal 1 = red

    const bgTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 0, bgTile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    // Sprite tile at slot 0 in charblock 4: solid index 1.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) vram[0x10000 + r * 4 + c / 2] = 0x11;
    }
    // OBJ palette index 1 = blue.
    palette[0x202] = 0x00;
    palette[0x203] = 0x7c;

    // Sprite 0: y=0, x=0, 8×8, tile=0, priority=2.
    oam[1] = 0; // re-enable
    oam[5] = 0x08; // attr2 high byte: priority=2

    const ppu = new Ppu(vram, palette, oam);
    ppu.write16(0x08, (1 << 8) | 2); // BG0 priority 2
    ppu.dispcnt = 0x1100; // mode 0 + BG0 + OBJ enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffff0000); // OBJ wins tie
  });

  it("sprite at priority 3 falls behind BG at priority 0", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x001f); // BG red

    const bgTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 0, bgTile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) vram[0x10000 + r * 4 + c / 2] = 0x11;
    }
    palette[0x202] = 0x00;
    palette[0x203] = 0x7c;

    oam[1] = 0; // sprite 0 enabled
    oam[5] = 0x0c; // priority 3

    const ppu = new Ppu(vram, palette, oam);
    ppu.write16(0x08, 1 << 8); // BG0 priority 0
    ppu.dispcnt = 0x1100;
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff); // BG wins
  });

  it("OBJ disabled — sprite is ignored even if OAM has one", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x001f); // backdrop red

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) vram[0x10000 + r * 4 + c / 2] = 0x11;
    }
    palette[0x202] = 0x00;
    palette[0x203] = 0x7c;

    oam[1] = 0; // sprite 0 would be enabled, but OBJ master enable is off
    oam[5] = 0;

    const ppu = new Ppu(vram, palette, oam);
    ppu.dispcnt = 0x0000; // mode 0, OBJ not enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff); // backdrop red
  });

  it("mode 1 — BG2 renders as an affine layer", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x7c00); // BG palette index 1 = blue

    // Affine 8bpp tile 1: top-left pixel = palette index 1.
    const aff = 0 * 0x4000 + 1 * 64;
    vram[aff] = 1;
    // Tilemap (size 0 = 128×128, 16×16 entries) at screen block 16.
    vram[16 * 0x800 + 0] = 1;

    const ppu = new Ppu(vram, palette);
    // BG2CNT: screen base 16, char base 0, screen size 0 (128×128).
    ppu.write16(0x0c, 16 << 8);
    // Identity matrix: PA=PD=0x100, PB=PC=0.
    ppu.write16(0x20, 0x100); // PA
    ppu.write16(0x26, 0x100); // PD
    ppu.dispcnt = 0x0401; // mode 1 + BG2 enabled
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xffff0000);
  });

  it("mode 2 — BG3 renders as a second affine layer", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 7, 0x03e0); // BG palette index 7 = green

    // Same set-up but for BG3: charblock 0 tile 2, screen block 17.
    const aff = 0 * 0x4000 + 2 * 64;
    vram[aff] = 7;
    vram[17 * 0x800 + 0] = 2;

    const ppu = new Ppu(vram, palette);
    // BG3CNT: screen base 17, char base 0, size 0.
    ppu.write16(0x0e, 17 << 8);
    // BG3 PA/PD = 0x100 (identity).
    ppu.write16(0x30, 0x100);
    ppu.write16(0x36, 0x100);
    ppu.dispcnt = 0x0802 | 0x0400; // mode 2 + BG2 + BG3 enabled
    // (DISPCNT bit 10 = BG2, bit 11 = BG3.)
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff00ff00);
  });

  it("BG0 scroll register propagates into the rendered output", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000); // backdrop black
    writePalette(palette, 1, 0x001f); // pal[1] red

    // Tile 0: one red pixel at column 4, row 0.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    tile[0]![4] = 1;
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, 1 << 8);
    ppu.dispcnt = 0x0100;

    // No scroll: red pixel sits at world (4, 0) → screen (4, 0).
    ppu.renderFrame();
    expect(pixelAt(ppu, 4, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 0, 0)).toBe(0xff000000);

    // hofs = 4: world x for screen x=0 is now 4, so the red pixel
    // slides to screen (0, 0).
    ppu.write16(0x10, 4);
    ppu.renderFrame();
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
  });
});

describe("Blend helpers (pure RGBA math)", () => {
  const RED = 0xff0000ff; // (r=FF, g=00, b=00, a=FF) — pure red
  const BLUE = 0xffff0000; // (r=00, g=00, b=FF, a=FF) — pure blue
  const BLACK = 0xff000000;
  const WHITE = 0xffffffff;

  it("blendAlpha with EVA=16 EVB=0 returns top unchanged", () => {
    expect(blendAlpha(RED, BLUE, 16, 0)).toBe(RED);
  });

  it("blendAlpha with EVA=0 EVB=16 returns bottom unchanged", () => {
    expect(blendAlpha(RED, BLUE, 0, 16)).toBe(BLUE);
  });

  it("blendAlpha saturates to 255 when coefficient sums overshoot", () => {
    // r = (FF * 16 + FF * 16) >> 4 = 510, clamped to 255.
    expect(blendAlpha(RED, RED, 16, 16)).toBe(RED);
  });

  it("brighten with EVY=16 turns any colour pure white", () => {
    expect(brighten(RED, 16)).toBe(WHITE);
    expect(brighten(BLACK, 16)).toBe(WHITE);
  });

  it("brighten with EVY=0 is a no-op", () => {
    expect(brighten(RED, 0)).toBe(RED);
  });

  it("darken with EVY=16 turns any colour pure black", () => {
    expect(darken(RED, 16)).toBe(BLACK);
    expect(darken(WHITE, 16)).toBe(BLACK);
  });

  it("darken with EVY=0 is a no-op", () => {
    expect(darken(RED, 0)).toBe(RED);
  });
});

describe("Ppu — blend (BLDCNT / BLDALPHA / BLDY)", () => {
  function writePalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[idx * 2] = bgr555 & 0xff;
    palette[idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function write4bppTile(vram: Uint8Array, charBase: number, tileIndex: number, pixels: number[][]): void {
    const base = charBase * 0x4000 + tileIndex * 32;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) {
        const lo = pixels[r]![c]! & 0xf;
        const hi = pixels[r]![c + 1]! & 0xf;
        vram[base + r * 4 + c / 2] = lo | (hi << 4);
      }
    }
  }
  function writeTilemapEntry(vram: Uint8Array, sb: number, tx: number, ty: number, tileIndex: number): void {
    const addr = sb * 0x800 + (ty * 32 + tx) * 2;
    vram[addr] = tileIndex & 0xff;
    vram[addr + 1] = (tileIndex >>> 8) & 0xff;
  }
  function pixelAt(ppu: Ppu, x: number, y: number): number {
    const i = (y * SCREEN_WIDTH + x) * 4;
    return (
      ((ppu.framebuffer[i + 3]! << 24) |
        (ppu.framebuffer[i + 2]! << 16) |
        (ppu.framebuffer[i + 1]! << 8) |
        ppu.framebuffer[i]!) >>>
      0
    );
  }

  /** Set up a frame with BG0 covering the screen in pure-red and a
   *  pure-blue backdrop. Both layers are present at every pixel so
   *  any per-pixel decision (top = BG0, bottom = BD) is observable. */
  function setupRedBg0OnBlueBackdrop(): Ppu {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x7c00); // backdrop = pure blue
    writePalette(palette, 1, 0x001f); // BG0 = pure red
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 0, tile);
    for (let ty = 0; ty < 32; ty++) {
      for (let tx = 0; tx < 32; tx++) writeTilemapEntry(vram, 1, tx, ty, 0);
    }
    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, 1 << 8); // BG0: screen base 1, priority 0
    ppu.dispcnt = 0x0100; // mode 0 + BG0
    return ppu;
  }

  it("BLDCNT mode 1 alpha-blends BG0 over the backdrop with EVA=8, EVB=8", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    // BLDCNT: top-A = BG0 (bit 0), bottom-B = backdrop (bit 13 = bit 5 of high byte), mode = alpha (1).
    ppu.write16(0x50, 0x01 | (1 << 6) | (0x20 << 8));
    // EVA = 8/16, EVB = 8/16 → half-half blend of red + blue.
    ppu.write16(0x52, 8 | (8 << 8));
    ppu.renderFrame();
    // Top BG0 red = 0xFF in low byte; bottom BD blue = 0xFF in third byte.
    // r = (255*8 + 0*8) >> 4 = 127
    // g = 0
    // b = (0*8 + 255*8) >> 4 = 127
    // Expected u32 = 0xFF_7F_00_7F (LE: 0x7F 0x00 0x7F 0xFF)
    expect(pixelAt(ppu, 5, 5)).toBe(0xff7f007f);
  });

  it("BLDCNT mode 1 falls back to top-as-is when bottom-B doesn't match", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    // Mode 1 alpha, top-A = BG0, bottom-B = OBJ only (no backdrop bit).
    ppu.write16(0x50, 0x01 | (1 << 6) | (0x10 << 8));
    ppu.write16(0x52, 8 | (8 << 8));
    ppu.renderFrame();
    // No blend partner → BG0 red passes through.
    expect(pixelAt(ppu, 5, 5)).toBe(0xff0000ff);
  });

  it("BLDCNT mode 2 brightens BG0 by EVY=16 → pure white", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    // Mode 2 (brighten), top-A = BG0.
    ppu.write16(0x50, 0x01 | (2 << 6));
    ppu.write16(0x54, 16); // EVY = full brighten
    ppu.renderFrame();
    // Brighten BG0 (FF, 00, 00) fully → (FF, FF, FF) white.
    expect(pixelAt(ppu, 5, 5)).toBe(0xffffffff);
  });

  it("BLDCNT mode 2 with EVY=8 brightens half-way to white", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    ppu.write16(0x50, 0x01 | (2 << 6));
    ppu.write16(0x54, 8);
    ppu.renderFrame();
    // r = 255 + ((0 * 8) >> 4) = 255
    // g = 0 + ((255 * 8) >> 4) = 127
    // b = 0 + ((255 * 8) >> 4) = 127
    expect(pixelAt(ppu, 5, 5)).toBe(0xff7f7fff);
  });

  it("BLDCNT mode 3 darkens BG0 by EVY=16 → pure black", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    ppu.write16(0x50, 0x01 | (3 << 6));
    ppu.write16(0x54, 16); // EVY = full darken
    ppu.renderFrame();
    expect(pixelAt(ppu, 5, 5)).toBe(0xff000000);
  });

  it("BLDCNT mode 2/3 leaves top untouched when topLayer isn't in BLDCNT-A", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    // Mode 2, top-A = OBJ only (BG0 is not in A).
    ppu.write16(0x50, 0x10 | (2 << 6));
    ppu.write16(0x54, 16);
    ppu.renderFrame();
    // BG0 not in BLDCNT-A → brighten skipped, raw red.
    expect(pixelAt(ppu, 5, 5)).toBe(0xff0000ff);
  });

  it("window color-effect bit off → blend skipped inside that window", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    // Mode 2 brighten, top-A = BG0, EVY = 16.
    ppu.write16(0x50, 0x01 | (2 << 6));
    ppu.write16(0x54, 16);
    // WIN0 covers (50..150) × (40..120). WININ low byte: BG0 + OBJ
    // enabled but color-effect bit OFF. WINOUT low byte: BG0 enabled
    // AND color-effect bit ON.
    ppu.dispcnt = 0x0100 | (1 << 13);
    ppu.write16(0x40, (50 << 8) | 150);
    ppu.write16(0x44, (40 << 8) | 120);
    ppu.write16(0x48, 0x11); // WININ low: BG0(0x01) + OBJ(0x10), no color FX (bit 5)
    ppu.write16(0x4a, 0x21); // WINOUT low: BG0(0x01) + color FX (0x20)
    ppu.renderFrame();
    // Inside WIN0 — blend disabled by window → raw BG0 red.
    expect(pixelAt(ppu, 75, 60)).toBe(0xff0000ff);
    // Outside — blend allowed → fully-brightened white.
    expect(pixelAt(ppu, 10, 10)).toBe(0xffffffff);
  });

  it("EVA / EVB values 17-31 cap at 16 (no over-blend)", () => {
    const ppu = setupRedBg0OnBlueBackdrop();
    ppu.write16(0x50, 0x01 | (1 << 6) | (0x20 << 8));
    ppu.write16(0x52, 31 | (31 << 8)); // 31/31 saturating to 16/16
    ppu.renderFrame();
    // 16/16 EVA/EVB = top + bottom (saturated). red + blue = magenta-ish.
    // r = (255*16 + 0*16) >> 4 = 255
    // g = 0
    // b = (0*16 + 255*16) >> 4 = 255
    expect(pixelAt(ppu, 5, 5)).toBe(0xffff00ff);
  });
});

describe("Ppu — window masking", () => {
  function writePalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[idx * 2] = bgr555 & 0xff;
    palette[idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function write4bppTile(vram: Uint8Array, charBase: number, tileIndex: number, pixels: number[][]): void {
    const base = charBase * 0x4000 + tileIndex * 32;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) {
        const lo = pixels[r]![c]! & 0xf;
        const hi = pixels[r]![c + 1]! & 0xf;
        vram[base + r * 4 + c / 2] = lo | (hi << 4);
      }
    }
  }
  function writeTilemapEntry(vram: Uint8Array, sb: number, tx: number, ty: number, tileIndex: number): void {
    const addr = sb * 0x800 + (ty * 32 + tx) * 2;
    vram[addr] = tileIndex & 0xff;
    vram[addr + 1] = (tileIndex >>> 8) & 0xff;
  }
  function pixelAt(ppu: Ppu, x: number, y: number): number {
    const i = (y * SCREEN_WIDTH + x) * 4;
    return (
      ((ppu.framebuffer[i + 3]! << 24) |
        (ppu.framebuffer[i + 2]! << 16) |
        (ppu.framebuffer[i + 1]! << 8) |
        ppu.framebuffer[i]!) >>>
      0
    );
  }

  function setupRedBg0(): Ppu {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x7c00); // backdrop blue
    writePalette(palette, 1, 0x001f); // BG0 red
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppTile(vram, 0, 0, tile);
    // Fill the visible tilemap region with tile 0 so the whole screen
    // reads red where BG0 is allowed to draw.
    for (let ty = 0; ty < 32; ty++) {
      for (let tx = 0; tx < 32; tx++) writeTilemapEntry(vram, 1, tx, ty, 0);
    }
    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, 1 << 8); // BG0: screen base 1, priority 0
    return ppu;
  }

  it("WIN0 enabled with BG0 in WININ → BG0 only visible inside the window", () => {
    const ppu = setupRedBg0();
    ppu.dispcnt = 0x0100 | (1 << 13); // mode 0 + BG0 + WIN0 enable
    // WIN0 = [50, 100) x [40, 80). WININ low byte = 0x01 (BG0 inside).
    // WINOUT low byte = 0x00 (nothing outside).
    ppu.write16(0x40, (50 << 8) | 100); // WIN0H: X1=50, X2=100
    ppu.write16(0x44, (40 << 8) | 80); // WIN0V: Y1=40, Y2=80
    ppu.write16(0x48, 0x01); // WININ low: BG0 only
    ppu.write16(0x4a, 0x00); // WINOUT low: nothing
    ppu.renderFrame();
    // Inside WIN0 — red.
    expect(pixelAt(ppu, 75, 60)).toBe(0xff0000ff);
    // Outside — BG0 hidden, backdrop shows through.
    expect(pixelAt(ppu, 10, 10)).toBe(0xffff0000);
  });

  it("WIN0 disabled in WININ → BG0 hidden inside even when enabled outside", () => {
    const ppu = setupRedBg0();
    ppu.dispcnt = 0x0100 | (1 << 13);
    ppu.write16(0x40, (50 << 8) | 100);
    ppu.write16(0x44, (40 << 8) | 80);
    ppu.write16(0x48, 0x00); // WININ low: nothing inside
    ppu.write16(0x4a, 0x01); // WINOUT low: BG0 only
    ppu.renderFrame();
    // Inside → backdrop (BG0 masked away).
    expect(pixelAt(ppu, 75, 60)).toBe(0xffff0000);
    // Outside → red.
    expect(pixelAt(ppu, 10, 10)).toBe(0xff0000ff);
  });

  it("DISPCNT window bits all off → no masking, BG0 covers everywhere", () => {
    const ppu = setupRedBg0();
    ppu.dispcnt = 0x0100; // no window-enable bits
    // Hostile WININ / WINOUT settings — should be ignored entirely.
    ppu.write16(0x40, (50 << 8) | 100);
    ppu.write16(0x44, (40 << 8) | 80);
    ppu.write16(0x48, 0x00);
    ppu.write16(0x4a, 0x00);
    ppu.renderFrame();
    expect(pixelAt(ppu, 75, 60)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 10, 10)).toBe(0xff0000ff);
  });
});

describe("Ppu — Phase D: semi-transparent OBJ + OBJ-window sprites", () => {
  function writePalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[idx * 2] = bgr555 & 0xff;
    palette[idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function writeObjPalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[0x200 + idx * 2] = bgr555 & 0xff;
    palette[0x200 + idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function write4bppBgTile(vram: Uint8Array, charBase: number, tileIndex: number, pixels: number[][]): void {
    const base = charBase * 0x4000 + tileIndex * 32;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) {
        const lo = pixels[r]![c]! & 0xf;
        const hi = pixels[r]![c + 1]! & 0xf;
        vram[base + r * 4 + c / 2] = lo | (hi << 4);
      }
    }
  }
  function writeTilemapEntry(vram: Uint8Array, sb: number, tx: number, ty: number, tileIndex: number): void {
    const addr = sb * 0x800 + (ty * 32 + tx) * 2;
    vram[addr] = tileIndex & 0xff;
    vram[addr + 1] = (tileIndex >>> 8) & 0xff;
  }
  function disableAllSprites(oam: Uint8Array): void {
    for (let i = 0; i < 128; i++) oam[i * 8 + 1] = 0x02;
  }
  /** Set up sprite N at (x, y) as 8×8 4bpp, palette bank 0, priority 0,
   *  GFX mode `objMode`. Tile data must already be present at slot 0. */
  function setSprite(oam: Uint8Array, slot: number, x: number, y: number, objMode: 0 | 1 | 2): void {
    const base = slot * 8;
    // attr0: y in low byte; objMode in bits 10-11; rest zero.
    oam[base + 0] = y & 0xff;
    oam[base + 1] = (objMode & 0x3) << 2; // mode bits 10-11 → high-byte bits 2-3
    // attr1: x in bits 0-8.
    oam[base + 2] = x & 0xff;
    oam[base + 3] = (x >>> 8) & 0x1;
    // attr2: tile 0, priority 0, palBank 0.
    oam[base + 4] = 0;
    oam[base + 5] = 0;
  }
  function pixelAt(ppu: Ppu, x: number, y: number): number {
    const i = (y * SCREEN_WIDTH + x) * 4;
    return (
      ((ppu.framebuffer[i + 3]! << 24) |
        (ppu.framebuffer[i + 2]! << 16) |
        (ppu.framebuffer[i + 1]! << 8) |
        ppu.framebuffer[i]!) >>>
      0
    );
  }

  /** BG0 covers everything in pure-red, with a solid blue 8×8 sprite
   *  tile (slot 0) ready in OBJ tile memory. */
  function setupBg0RedWithBlueSpriteTile(): { ppu: Ppu; oam: Uint8Array; vram: Uint8Array; palette: Uint8Array } {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x0000); // backdrop black
    writePalette(palette, 1, 0x001f); // BG palette index 1 = red
    writeObjPalette(palette, 1, 0x7c00); // OBJ palette index 1 = blue
    const bgTile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(1));
    write4bppBgTile(vram, 0, 0, bgTile);
    for (let ty = 0; ty < 32; ty++) {
      for (let tx = 0; tx < 32; tx++) writeTilemapEntry(vram, 1, tx, ty, 0);
    }
    // Sprite tile at slot 0 in charblock 4: solid index 1 (8×8 4bpp).
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) vram[0x10000 + r * 4 + c / 2] = 0x11;
    }
    const ppu = new Ppu(vram, palette, oam);
    ppu.write16(0x08, (1 << 8) | 1); // BG0: screen base 1, priority 1
    return { ppu, oam, vram, palette };
  }

  it("semi-transparent OBJ (mode 1) alpha-blends with the BG below regardless of BLDCNT mode", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    setSprite(oam, 0, 10, 10, 1); // mode 1 = semi-trans
    // OBJ at priority 0 (top), BG0 below at priority 1.
    // Force OBJ priority 0 by clearing attr2 high bits — default is already 0.
    ppu.dispcnt = 0x1100; // mode 0 + BG0 + OBJ enabled. No BLDCNT.
    // BLDALPHA: EVA=8, EVB=8 (50/50 blend). BLDCNT MODE bits stay 0 —
    // semi-trans OBJ overrides to alpha mode anyway. But we need a
    // bottom-B layer match: include BG0 in BLDCNT-B.
    ppu.write16(0x50, 0 | (0 << 6) | (0x01 << 8)); // top-A unused, mode 0, BG0 in bottom-B
    ppu.write16(0x52, 8 | (8 << 8));
    ppu.renderFrame();
    // Sprite pixel at (10,10) → blend OBJ blue with BG red.
    // r = (0*8 + 255*8) >> 4 = 127
    // g = 0
    // b = (255*8 + 0*8) >> 4 = 127
    expect(pixelAt(ppu, 10, 10)).toBe(0xff7f007f);
    // Adjacent uncovered pixel: BG0 red unmodified.
    expect(pixelAt(ppu, 50, 50)).toBe(0xff0000ff);
  });

  it("semi-transparent OBJ falls back to opaque draw when bottom-B doesn't match", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    setSprite(oam, 0, 10, 10, 1);
    ppu.dispcnt = 0x1100;
    // BLDCNT bottom-B = OBJ only (BG0 not in B) → no blend partner.
    ppu.write16(0x50, 0 | (0 << 6) | (0x10 << 8));
    ppu.write16(0x52, 8 | (8 << 8));
    ppu.renderFrame();
    // Sprite pixel = solid OBJ blue (no blend, semi-trans marker stripped).
    expect(pixelAt(ppu, 10, 10)).toBe(0xffff0000);
  });

  it("semi-transparent OBJ in mode 1 overrides BLDCNT mode 2 (brighten) to alpha", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    setSprite(oam, 0, 10, 10, 1);
    ppu.dispcnt = 0x1100;
    // BLDCNT: mode 2 brighten, top-A = OBJ. EVY = 16. Without the
    // semi-trans override this would brighten the OBJ blue to white.
    // With the override, it blends OBJ blue with BG red instead.
    ppu.write16(0x50, 0x10 | (2 << 6) | (0x01 << 8)); // top-A=OBJ (unused for mode 1 force), mode 2, bottom-B=BG0
    ppu.write16(0x52, 8 | (8 << 8));
    ppu.write16(0x54, 16); // EVY = 16 (would brighten to white if applied)
    ppu.renderFrame();
    // Forced alpha blend → 50/50 of red + blue, not brighten-to-white.
    expect(pixelAt(ppu, 10, 10)).toBe(0xff7f007f);
  });

  it("OBJ-window (mode 2) sprite carves a region where WINOUT-high enables apply", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    // Place a single mode-2 OBJ-window sprite covering an 8×8 box at
    // (16, 16). The sprite itself is invisible — only its cover counts.
    setSprite(oam, 0, 16, 16, 2);
    // DISPCNT: mode 0 + BG0 + OBJ + OBJWIN-enable.
    ppu.dispcnt = 0x0100 | (1 << 12) | (1 << 15);
    // Set WIN0 / WIN1 disabled (DISPCNT bits 13/14 stay 0) — only
    // OBJWIN matters. WINOUT low = 0x00 (outside OBJWIN hides BG0),
    // WINOUT high = 0x01 (inside OBJWIN shows BG0).
    ppu.write16(0x48, 0); // WININ doesn't matter
    ppu.write16(0x4a, 0x00 | (0x01 << 8));
    ppu.renderFrame();
    // Inside the sprite cover (e.g. (20, 20)) → BG0 red allowed.
    expect(pixelAt(ppu, 20, 20)).toBe(0xff0000ff);
    // Outside the sprite cover → BG0 hidden, backdrop black shows.
    expect(pixelAt(ppu, 100, 100)).toBe(0xff000000);
  });

  it("OBJWIN priority: WIN0 wins over OBJWIN where they overlap", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    setSprite(oam, 0, 0, 0, 2); // OBJ-window cover at top-left 8×8.
    ppu.dispcnt = 0x0100 | (1 << 12) | (1 << 13) | (1 << 15); // BG0 + OBJ + WIN0 + OBJWIN
    // WIN0 covers (0..240) × (0..160) — i.e. the entire screen.
    // WININ low byte = 0 (hide BG0 inside WIN0).
    // WINOUT low = 0x01 (would show BG0 outside, but there's no "outside").
    // WINOUT high = 0x01 (would show BG0 inside OBJWIN, but WIN0 claims first).
    ppu.write16(0x40, (0 << 8) | 240);
    ppu.write16(0x44, (0 << 8) | 160);
    ppu.write16(0x48, 0x00); // WININ low: nothing inside WIN0
    ppu.write16(0x4a, 0x01 | (0x01 << 8)); // WINOUT low + high both BG0
    ppu.renderFrame();
    // Even where the OBJ-window sprite covers (e.g. (3, 3)), WIN0
    // wins → BG0 hidden → backdrop.
    expect(pixelAt(ppu, 3, 3)).toBe(0xff000000);
  });

  it("mode-2 OBJ-window sprites don't appear in the OBJ priority scratch", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    // Mode-2 sprite covers (16, 16). If it leaked into the priority
    // scratch, it would draw blue here. The expected behavior is:
    // BG0 red shows through (sprite invisible).
    setSprite(oam, 0, 16, 16, 2);
    // No windowing → mode-2 sprite has no effect at all.
    ppu.dispcnt = 0x1100;
    ppu.renderFrame();
    expect(pixelAt(ppu, 20, 20)).toBe(0xff0000ff); // BG0 red, not OBJ blue
  });

  it("mode-1 semi-trans OBJ without color-effect window bit falls back to opaque", () => {
    const { ppu, oam } = setupBg0RedWithBlueSpriteTile();
    setSprite(oam, 0, 100, 100, 1);
    // BLDCNT setup that would otherwise blend.
    ppu.write16(0x50, 0 | (0 << 6) | (0x01 << 8));
    ppu.write16(0x52, 8 | (8 << 8));
    // WIN0 covering the sprite, WININ low byte enables BG0 + OBJ but
    // not color effects (no bit 5).
    ppu.dispcnt = 0x0100 | (1 << 12) | (1 << 13);
    ppu.write16(0x40, (90 << 8) | 130);
    ppu.write16(0x44, (90 << 8) | 130);
    ppu.write16(0x48, 0x11); // WININ low: BG0 + OBJ visible, color FX OFF
    ppu.write16(0x4a, 0x3f); // WINOUT permissive
    ppu.renderFrame();
    // Inside WIN0 with color-FX disabled: semi-trans treated as
    // opaque OBJ blue.
    expect(pixelAt(ppu, 100, 100)).toBe(0xffff0000);
  });
});

describe("Ppu — mosaic", () => {
  function writePalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[idx * 2] = bgr555 & 0xff;
    palette[idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function writeObjPalette(palette: Uint8Array, idx: number, bgr555: number): void {
    palette[0x200 + idx * 2] = bgr555 & 0xff;
    palette[0x200 + idx * 2 + 1] = (bgr555 >>> 8) & 0xff;
  }
  function write4bppTile(vram: Uint8Array, charBase: number, tileIndex: number, pixels: number[][]): void {
    const base = charBase * 0x4000 + tileIndex * 32;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c += 2) {
        const lo = pixels[r]![c]! & 0xf;
        const hi = pixels[r]![c + 1]! & 0xf;
        vram[base + r * 4 + c / 2] = lo | (hi << 4);
      }
    }
  }
  function writeTilemapEntry(vram: Uint8Array, sb: number, tx: number, ty: number, tileIndex: number): void {
    const addr = sb * 0x800 + (ty * 32 + tx) * 2;
    vram[addr] = tileIndex & 0xff;
    vram[addr + 1] = (tileIndex >>> 8) & 0xff;
  }
  function disableAllSprites(oam: Uint8Array): void {
    for (let i = 0; i < 128; i++) oam[i * 8 + 1] = 0x02;
  }
  function pixelAt(ppu: Ppu, x: number, y: number): number {
    const i = (y * SCREEN_WIDTH + x) * 4;
    return (
      ((ppu.framebuffer[i + 3]! << 24) |
        (ppu.framebuffer[i + 2]! << 16) |
        (ppu.framebuffer[i + 1]! << 8) |
        ppu.framebuffer[i]!) >>>
      0
    );
  }

  it("BG mosaic with 4×1 blocks replicates each block's leftmost source pixel", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000); // backdrop black
    // Use one tile whose row 0 has alternating colours every pixel:
    // r b r b r b r b. With 4×1 mosaic the row should resolve to
    // r r r r r r r r (block top-left repeated within each 4-pixel
    // span). We give the row two indices: 1 (red) at columns 0, 2, 4, 6
    // and 2 (blue) at columns 1, 3, 5, 7. Block top-lefts at columns
    // 0 and 4 both pick up red.
    writePalette(palette, 1, 0x001f); // red
    writePalette(palette, 2, 0x7c00); // blue
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let c = 0; c < 8; c++) tile[0]![c] = c % 2 === 0 ? 1 : 2;
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);

    const ppu = new Ppu(vram, palette);
    // BG0CNT: screen base 1 + bit 6 = mosaic enable.
    ppu.write16(0x08, (1 << 8) | (1 << 6));
    ppu.dispcnt = 0x0100; // mode 0 + BG0
    // MOSAIC: BG h-size = 4 (raw 3), v-size = 1 (raw 0).
    ppu.write16(0x4c, 3);
    ppu.renderFrame();
    // All four pixels in the first block share the top-left's red.
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 1, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 2, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 3, 0)).toBe(0xff0000ff);
    // Next block starts at column 4 — also red (column 4 was odd-
    // indexed red in the original).
    expect(pixelAt(ppu, 4, 0)).toBe(0xff0000ff);
  });

  it("BG mosaic is skipped when BGnCNT bit 6 is clear", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x001f); // red
    writePalette(palette, 2, 0x7c00); // blue
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let c = 0; c < 8; c++) tile[0]![c] = c % 2 === 0 ? 1 : 2;
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);
    const ppu = new Ppu(vram, palette);
    // BG0CNT: screen base 1, NO bit 6 — mosaic disabled.
    ppu.write16(0x08, 1 << 8);
    ppu.dispcnt = 0x0100;
    ppu.write16(0x4c, 3); // MOSAIC says BG-h = 4, but bit 6 is off.
    ppu.renderFrame();
    // Alternating colours preserved.
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 1, 0)).toBe(0xffff0000);
    expect(pixelAt(ppu, 2, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 3, 0)).toBe(0xffff0000);
  });

  it("BG mosaic v-size > 1 replicates rows from each block's top row", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    writePalette(palette, 0, 0x0000);
    writePalette(palette, 1, 0x001f); // row 0 colour
    writePalette(palette, 2, 0x7c00); // row 1 colour
    // Tile rows 0 and 1 are uniform but different colours.
    const tile: number[][] = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
    for (let c = 0; c < 8; c++) {
      tile[0]![c] = 1;
      tile[1]![c] = 2;
    }
    write4bppTile(vram, 0, 0, tile);
    writeTilemapEntry(vram, 1, 0, 0, 0);
    const ppu = new Ppu(vram, palette);
    ppu.write16(0x08, (1 << 8) | (1 << 6)); // BG0 with mosaic enable
    ppu.dispcnt = 0x0100;
    // MOSAIC: BG h-size = 1 (raw 0), v-size = 2 (raw 1).
    ppu.write16(0x4c, 0 | (1 << 4));
    ppu.renderFrame();
    // Row 0 and row 1 both read from row 0 (the block's top row → red).
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 0, 1)).toBe(0xff0000ff);
    // Row 2 starts the next vertical block (top row = original row 2,
    // which we left at colour 0 = backdrop).
    expect(pixelAt(ppu, 0, 2)).toBe(0xff000000);
  });

  it("OBJ mosaic snaps the sprite's source coords to block top-lefts", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x0000);
    writeObjPalette(palette, 1, 0x001f); // red
    writeObjPalette(palette, 2, 0x7c00); // blue
    // Sprite tile (8×8 4bpp): row 0 alternates red / blue every column.
    for (let c = 0; c < 8; c++) {
      const lo = c & 1 ? 2 : 1;
      const hi = (c + 1) & 1 ? 2 : 1;
      // c is 0..7. Each iteration writes one nibble pair.
      // Use a fresh inline writer for sprite tile 0.
      const byteIdx = 0x10000 + ((c >>> 1) | 0);
      // simpler: use a helper
      void lo;
      void hi;
      void byteIdx;
    }
    // Easier: write each byte directly. Row 0 of an 8×8 4bpp tile is 4
    // bytes at 0x10000..0x10003: each byte holds two pixels (low/high
    // nibble). Pixels 0..7 = 1, 2, 1, 2, 1, 2, 1, 2.
    vram[0x10000] = 0x21; // pixel0=1, pixel1=2
    vram[0x10001] = 0x21; // pixel2=1, pixel3=2
    vram[0x10002] = 0x21;
    vram[0x10003] = 0x21;

    // Sprite 0 at (0, 0), 8×8 4bpp tile 0, attr-0 bit 12 = mosaic enabled.
    oam[0] = 0;
    oam[1] = (1 << 4) >> 0; // attr0 high byte: bit 4 = bit 12 of attr0 (mosaic)
    oam[2] = 0;
    oam[3] = 0;
    oam[4] = 0;
    oam[5] = 0;

    const ppu = new Ppu(vram, palette, oam);
    ppu.dispcnt = 0x1000; // mode 0 + OBJ enabled, no BGs
    // MOSAIC: OBJ h-size = 4 (raw 3), v-size = 1 (raw 0).
    ppu.write16(0x4c, 3 << 8);
    ppu.renderFrame();
    // Original alternating pattern collapses to first-of-block colour
    // within each 4-pixel span. Pixel 0 in source = red (palette 1).
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 1, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 2, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 3, 0)).toBe(0xff0000ff);
    // Block 4..7 — top-left source pixel index at column 4 = red.
    expect(pixelAt(ppu, 4, 0)).toBe(0xff0000ff);
  });

  it("OBJ mosaic is skipped when attr-0 bit 12 is clear", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    const oam = new Uint8Array(0x400);
    disableAllSprites(oam);
    writePalette(palette, 0, 0x0000);
    writeObjPalette(palette, 1, 0x001f);
    writeObjPalette(palette, 2, 0x7c00);
    vram[0x10000] = 0x21;
    vram[0x10001] = 0x21;
    vram[0x10002] = 0x21;
    vram[0x10003] = 0x21;
    // Sprite 0 — attr-0 bit 12 NOT set.
    oam[0] = 0;
    oam[1] = 0;
    oam[2] = 0;
    oam[3] = 0;
    oam[4] = 0;
    oam[5] = 0;
    const ppu = new Ppu(vram, palette, oam);
    ppu.dispcnt = 0x1000;
    ppu.write16(0x4c, 3 << 8); // MOSAIC asserts OBJ-h = 4, but flag is off.
    ppu.renderFrame();
    // Original alternating pattern preserved.
    expect(pixelAt(ppu, 0, 0)).toBe(0xff0000ff);
    expect(pixelAt(ppu, 1, 0)).toBe(0xffff0000);
    expect(pixelAt(ppu, 2, 0)).toBe(0xff0000ff);
  });
});

describe("Ppu — BG2 affine without per-scanline matrix updates (F-Zero scenario)", () => {
  // F-Zero Climax arms an HBlank-DMA into BG2PA-PD for one frame every 33
  // frames; in between the cart leaves the registers untouched. Hardware
  // (and reference emulators) treats BG2PA-PD as sticky — last-written
  // values keep driving the affine renderer until the next write. The cart
  // relies
  // on this to keep painting the track during the 32 "no-DMA" frames.
  //
  // These tests pin that behaviour by exercising the renderer with NO
  // per-scanline register writes, only a matrix loaded up-front.

  function fillAffineTile(vram: Uint8Array, charBlock: number, tileIndex: number, palIndex: number): void {
    const base = charBlock * 0x4000 + tileIndex * 64; // 8bpp affine tile = 64 bytes
    for (let i = 0; i < 64; i++) vram[base + i] = palIndex;
  }

  function fillAffineTilemap(vram: Uint8Array, screenBlock: number, sizePx: number, tileIndex: number): void {
    const tiles = sizePx >>> 3;
    const base = screenBlock * 0x800;
    for (let i = 0; i < tiles * tiles; i++) vram[base + i] = tileIndex;
  }

  it("identity matrix written once renders the whole BG without per-line writes", () => {
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    palette[0] = 0x00;
    palette[1] = 0x00; // backdrop = black
    palette[2 * 5] = 0xe0;
    palette[2 * 5 + 1] = 0x03; // pal[5] = green
    fillAffineTile(vram, 0, 1, 5);
    fillAffineTilemap(vram, 16, 128, 1);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x0c, 16 << 8); // BG2CNT: screen base 16, size 0 (128×128)
    ppu.write16(0x20, 0x100); // BG2PA = identity
    ppu.write16(0x26, 0x100); // BG2PD = identity
    ppu.dispcnt = 0x0402; // mode 2 + BG2 enabled

    ppu.renderFrame();
    // Every visible pixel inside the 128×128 BG should be green.
    expect(pixelAt(ppu, 0, 0)).toBe(0xff00ff00);
    expect(pixelAt(ppu, 100, 100)).toBe(0xff00ff00);
    expect(pixelAt(ppu, 127, 127)).toBe(0xff00ff00);
  });

  it("matrix written once persists across multiple frames (the F-Zero stale-matrix case)", () => {
    // Render TWO frames back-to-back with no writes between them. If our
    // PPU silently clears PA-PD on VBlank or otherwise stops painting BG2
    // when no DMA is firing, frame 2 would be backdrop.
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    palette[0] = 0x1f;
    palette[1] = 0x00; // backdrop = red
    palette[2 * 3] = 0x00;
    palette[2 * 3 + 1] = 0x7c; // pal[3] = blue
    fillAffineTile(vram, 0, 7, 3);
    fillAffineTilemap(vram, 20, 128, 7);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x0c, 20 << 8);
    ppu.write16(0x20, 0x100);
    ppu.write16(0x26, 0x100);
    ppu.dispcnt = 0x0402;

    ppu.renderFrame();
    expect(pixelAt(ppu, 64, 64)).toBe(0xffff0000); // blue mid-frame 1

    // No writes between frames. PA-PD must persist.
    ppu.renderFrame();
    expect(pixelAt(ppu, 64, 64)).toBe(0xffff0000); // STILL blue
    expect(ppu.affinePa[0]).toBe(0x100);
    expect(ppu.affinePd[0]).toBe(0x100);
  });

  it("F-Zero matrix shape with wraparound enabled produces non-backdrop pixels", () => {
    // Real PA-PD values observed at frame 1680 of a reference-emulator
    // register trace — the matrix
    // the cart computes for race-active state. PA=0 is unusual: it means
    // no per-pixel x-step within a scanline, only per-scanline movement
    // via PB. The cart compensates by writing fresh PA-PD per scanline
    // via HBlank DMA in DMA-armed frames.
    //
    // This test uses BG2CNT bit 13 = 1 (wraparound) so the sample point
    // is always in-map regardless of refX/refY drift — isolating "does
    // the renderer produce ANY output" from "is the camera in-map".
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    palette[0] = 0x00;
    palette[1] = 0x00; // backdrop black
    palette[2 * 1] = 0xff;
    palette[2 * 1 + 1] = 0x7f; // pal[1] = white
    fillAffineTile(vram, 0, 0, 1);
    fillAffineTilemap(vram, 24, 1024, 0);

    const ppu = new Ppu(vram, palette);
    // BG2CNT: screen base 24, char base 0, size 3 (1024×1024), 8bpp (bit 7),
    // **wraparound** (bit 13).
    ppu.write16(0x0c, (24 << 8) | (3 << 14) | (1 << 7) | (1 << 13));
    ppu.write16(0x20, 0x0000); // PA
    ppu.write16(0x22, 0xe347); // PB
    ppu.write16(0x24, 0x0425); // PC
    ppu.write16(0x26, 0x2124); // PD
    ppu.write16(0x28, 0x0000);
    ppu.write16(0x2a, 0x0000); // BG2X = 0
    ppu.write16(0x2c, 0x0000);
    ppu.write16(0x2e, 0x0000); // BG2Y = 0
    ppu.dispcnt = 0x0402;

    ppu.renderFrame();
    let nonBackdrop = 0;
    const backdrop = 0xff000000;
    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        if (pixelAt(ppu, x, y) !== backdrop) nonBackdrop++;
      }
    }
    expect(nonBackdrop).toBeGreaterThan(0);
  });

  it("matrix from frame N continues to drive rendering on frame N+1 with no writes", () => {
    // The most direct simulation of F-Zero's no-DMA frame: write a
    // matrix once (as if frame N's last HBlank DMA had set it), advance
    // to a hypothetical frame N+1 without doing ANYTHING in between
    // (no register writes, no DMA), and re-render. The pixel output
    // must be byte-identical between the two frames.
    const vram = new Uint8Array(0x18000);
    const palette = new Uint8Array(0x400);
    palette[0] = 0x1f;
    palette[1] = 0x00; // backdrop red
    palette[2 * 2] = 0xe0;
    palette[2 * 2 + 1] = 0x03; // pal[2] = green
    fillAffineTile(vram, 0, 4, 2);
    fillAffineTilemap(vram, 24, 256, 4);

    const ppu = new Ppu(vram, palette);
    ppu.write16(0x0c, (24 << 8) | (1 << 14) | (1 << 7)); // size 1 (256×256), 256-col
    // Non-identity matrix with rotation/scale (close to real Mode-7 use).
    ppu.write16(0x20, 0x00b5); // PA = cos(45°) * 256
    ppu.write16(0x22, 0xff4b); // PB = -sin(45°) * 256
    ppu.write16(0x24, 0x00b5); // PC = sin(45°) * 256
    ppu.write16(0x26, 0x00b5); // PD = cos(45°) * 256
    ppu.write16(0x28, 0x0000);
    ppu.write16(0x2a, 0x0000);
    ppu.write16(0x2c, 0x0000);
    ppu.write16(0x2e, 0x0000);
    ppu.dispcnt = 0x0402;

    ppu.renderFrame();
    const frame1 = new Uint8Array(ppu.framebuffer);

    // Critical: no writes between renders. Matrix must persist.
    ppu.renderFrame();
    const frame2 = new Uint8Array(ppu.framebuffer);

    expect(frame2).toEqual(frame1);
    // Sanity: at least one pixel actually used the matrix.
    let greenPixels = 0;
    for (let i = 0; i < frame1.length; i += 4) {
      if (frame1[i] === 0 && frame1[i + 1] === 0xff && frame1[i + 2] === 0) greenPixels++;
    }
    expect(greenPixels).toBeGreaterThan(100);
  });
});
