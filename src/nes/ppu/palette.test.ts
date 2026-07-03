import { describe, expect, it } from "vitest";

import { NES_PALETTE } from "./palette.js";

/** Unpack a little-endian RGBA u32 (R | G<<8 | B<<16 | A<<24) back into
 *  channels, matching the packing the framebuffer store relies on. */
function unpack(packed: number): { r: number; g: number; b: number; a: number } {
  return {
    r: packed & 0xff,
    g: (packed >>> 8) & 0xff,
    b: (packed >>> 16) & 0xff,
    a: (packed >>> 24) & 0xff
  };
}

describe("NES master palette", () => {
  it("holds the 2C02's 64 fixed colours", () => {
    expect(NES_PALETTE).toBeInstanceOf(Uint32Array);
    expect(NES_PALETTE.length).toBe(64);
  });

  it("packs every entry as fully-opaque RGBA u32", () => {
    for (let i = 0; i < NES_PALETTE.length; i++) {
      const packed = NES_PALETTE[i]!;
      // Uint32Array already guarantees an unsigned 32-bit value.
      expect(packed).toBe(packed >>> 0);
      expect(unpack(packed).a).toBe(0xff);
    }
  });

  it("packs R in the low byte so a pixel store lands the right colour", () => {
    // Index 0x00 is the canonical mid grey 0x626262 — equal channels make the
    // byte order ambiguous, so cross-check an asymmetric reference colour too.
    expect(unpack(NES_PALETTE[0x00]!)).toMatchObject({ r: 0x62, g: 0x62, b: 0x62 });
    // Index 0x01 is a deep blue: little blue dominance pins R<G<B ordering.
    const blue = unpack(NES_PALETTE[0x01]!);
    expect(blue).toMatchObject({ r: 0x00, g: 0x1f, b: 0xb2 });
    expect(blue.b).toBeGreaterThan(blue.g);
    expect(blue.g).toBeGreaterThan(blue.r);
  });

  it("renders the blacker-than-black entries 0x0D and 0x1D as black", () => {
    for (const idx of [0x0d, 0x1d]) {
      const c = unpack(NES_PALETTE[idx]!);
      expect(c).toMatchObject({ r: 0x00, g: 0x00, b: 0x00, a: 0xff });
    }
  });

  it("renders the canonical black entries (0x0E/0x0F and column 0xE/0xF) as black", () => {
    for (const idx of [0x0e, 0x0f, 0x1e, 0x1f, 0x2e, 0x2f, 0x3e, 0x3f]) {
      const c = unpack(NES_PALETTE[idx]!);
      expect(c.r).toBe(0x00);
      expect(c.g).toBe(0x00);
      expect(c.b).toBe(0x00);
    }
  });

  it("renders the brightest column (0x20 and 0x30) as white", () => {
    for (const idx of [0x20, 0x30]) {
      const c = unpack(NES_PALETTE[idx]!);
      expect(c).toMatchObject({ r: 0xff, g: 0xff, b: 0xff, a: 0xff });
    }
  });

  it("keeps the high rows brighter than their low-row counterparts", () => {
    // Luma of a hue's bright variant (row 2/3) should exceed its dim variant
    // (row 0/1); spot-check the same hue (column 1) across rows.
    const luma = (idx: number): number => {
      const { r, g, b } = unpack(NES_PALETTE[idx]!);
      return r + g + b;
    };
    expect(luma(0x11)).toBeGreaterThan(luma(0x01));
    expect(luma(0x21)).toBeGreaterThan(luma(0x11));
    expect(luma(0x31)).toBeGreaterThan(luma(0x21));
  });

  it("matches the calibrated reference RGB for a few known colours", () => {
    expect(unpack(NES_PALETTE[0x16]!)).toMatchObject({ r: 0xc7, g: 0x2e, b: 0x00 }); // red
    expect(unpack(NES_PALETTE[0x2a]!)).toMatchObject({ r: 0x43, g: 0xf6, b: 0x11 }); // green
    expect(unpack(NES_PALETTE[0x3d]!)).toMatchObject({ r: 0xb8, g: 0xb8, b: 0xb8 }); // light grey
  });
});
