/**
 * 2C02 master palette — the 64 fixed colours the PPU can emit, as RGB. The NES
 * has no programmable colour; a palette entry selects one of these. The exact
 * RGB is analog and console/TV dependent; this is a widely-used calibrated set.
 *
 * Stored pre-packed as little-endian RGBA u32 (R | G<<8 | B<<16 | 0xFF<<24) so a
 * rendered pixel is a single store into the framebuffer's Uint32 view, matching
 * the GB/GBA PPUs.
 */

// prettier-ignore
const RGB: readonly number[] = [
  0x626262, 0x001fb2, 0x2404c8, 0x5200b2, 0x730076, 0x800024, 0x730b00, 0x522800,
  0x244400, 0x005700, 0x005c00, 0x005324, 0x003c76, 0x000000, 0x000000, 0x000000,
  0xababab, 0x0d57ff, 0x4b30ff, 0x8a13ff, 0xbc08d6, 0xd21269, 0xc72e00, 0x9d5400,
  0x607b00, 0x209800, 0x00a300, 0x009942, 0x007db4, 0x000000, 0x000000, 0x000000,
  0xffffff, 0x53aeff, 0x9085ff, 0xd365ff, 0xff57ff, 0xff5dcf, 0xff7757, 0xfa9e00,
  0xbdc700, 0x7ae700, 0x43f611, 0x26ef7e, 0x2cd5f6, 0x4e4e4e, 0x000000, 0x000000,
  0xffffff, 0xb6e1ff, 0xced1ff, 0xe9c3ff, 0xffbcff, 0xffbdf4, 0xffc6c3, 0xffd59a,
  0xe9e681, 0xcef481, 0xb6fb9a, 0xa9fac3, 0xa9f0f4, 0xb8b8b8, 0x000000, 0x000000
];

/** 64 master colours, pre-packed as little-endian RGBA u32. */
export const NES_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    const rgb = RGB[i]!;
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;
    out[i] = (r | (g << 8) | (b << 16) | 0xff000000) >>> 0;
  }
  return out;
})();
