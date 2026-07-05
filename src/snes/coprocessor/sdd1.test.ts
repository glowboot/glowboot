import { describe, expect, it } from "vitest";

import { Sdd1 } from "./sdd1.js";

/** Build an Sdd1 over an 8 MiB ROM whose bytes encode their own offset,
 *  so reads are self-identifying. */
function makeSdd1(): { sdd1: Sdd1; rom: Uint8Array } {
  const rom = new Uint8Array(0x800000);
  for (let i = 0; i < rom.length; i++) rom[i] = (i ^ (i >> 8) ^ (i >> 16)) & 0xff;
  return { sdd1: new Sdd1(rom), rom };
}

describe("S-DD1 coprocessor", () => {
  it("reads and masks the $4800-$4807 registers", () => {
    const { sdd1 } = makeSdd1();
    sdd1.ioWrite(0x4800, 0x81);
    sdd1.ioWrite(0x4801, 0x0f);
    sdd1.ioWrite(0x4804, 0xff); // MMC bank regs mask to $8f
    sdd1.ioWrite(0x4805, 0x7a);
    expect(sdd1.ioRead(0x4800)).toBe(0x81);
    expect(sdd1.ioRead(0x4801)).toBe(0x0f);
    expect(sdd1.ioRead(0x4804)).toBe(0x8f);
    expect(sdd1.ioRead(0x4805)).toBe(0x0a);
    // defaults for the two untouched bank regs
    expect(sdd1.ioRead(0x4806)).toBe(0x02);
    expect(sdd1.ioRead(0x4807)).toBe(0x03);
  });

  it("banks $C0-$FF through the MMC bank registers", () => {
    const { sdd1, rom } = makeSdd1();
    // Default: r4804=0,r4805=1,r4806=2,r4807=3 → chunks map to 1 MiB slices.
    expect(sdd1.mmcRead(0xc00010)).toBe(rom[0x000010]!); // C0-CF → r4804(0)
    expect(sdd1.mmcRead(0xd00010)).toBe(rom[0x100010]!); // D0-DF → r4805(1)
    expect(sdd1.mmcRead(0xe00010)).toBe(rom[0x200010]!); // E0-EF → r4806(2)
    expect(sdd1.mmcRead(0xf00010)).toBe(rom[0x300010]!); // F0-FF → r4807(3)
    // Re-point chunk 0 (C0-CF) at ROM slice 5.
    sdd1.ioWrite(0x4804, 0x05);
    expect(sdd1.mmcRead(0xc00010)).toBe(rom[0x500010]!);
  });

  it("folds $00-3F/$80-BF:8000+ as LoROM via mcuRead", () => {
    const { sdd1, rom } = makeSdd1();
    expect(sdd1.mcuRead(0x008000, 0)).toBe(rom[0x000000]!); // bank 0 :8000 → offset 0
    expect(sdd1.mcuRead(0x018000, 0)).toBe(rom[0x008000]!); // bank 1 :8000 → 0x8000
    expect(sdd1.mcuRead(0x028123, 0)).toBe(rom[0x010123]!); // bank 2 :8123
    // $C0-FF read (no active decompression) falls through to the MMC.
    expect(sdd1.mcuRead(0xc00010, 0)).toBe(rom[0x000010]!);
  });

  it("streams decompressed bytes for a fixed-address DMA and disables the channel", () => {
    const { sdd1 } = makeSdd1();
    // Point channel 3's source at a $C0-FF address, enable hard+soft for it.
    const addr = 0xc12340;
    // snoop the DMA address ($43x2-4) and a small size ($43x5-6) for channel 3.
    sdd1.snoopDma(0x4332, addr & 0xff);
    sdd1.snoopDma(0x4333, (addr >> 8) & 0xff);
    sdd1.snoopDma(0x4334, (addr >> 16) & 0xff);
    sdd1.snoopDma(0x4335, 4); // size = 4
    sdd1.snoopDma(0x4336, 0);
    sdd1.ioWrite(0x4800, 1 << 3); // hard enable ch3
    sdd1.ioWrite(0x4801, 1 << 3); // soft enable ch3
    // Four fixed-address reads should each return a byte and the channel
    // should disable itself once the size counts down.
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push(sdd1.mcuRead(addr, 0));
    expect(out.every((b) => b >= 0 && b <= 255)).toBe(true);
    expect(sdd1.ioRead(0x4801) & (1 << 3)).toBe(0); // soft-enable cleared at end
    // A subsequent read (no active channel) now returns raw MMC ROM.
    expect(sdd1.mcuRead(addr, 0)).toBe(sdd1.mmcRead(addr));
  });

  it("decompresses deterministically (same input → same output)", () => {
    const a = makeSdd1().sdd1;
    const b = makeSdd1().sdd1;
    function run(sdd1: Sdd1): number[] {
      sdd1.snoopDma(0x4302, 0x00);
      sdd1.snoopDma(0x4303, 0x40);
      sdd1.snoopDma(0x4304, 0xc0); // addr = $C04000
      sdd1.snoopDma(0x4305, 32);
      sdd1.snoopDma(0x4306, 0);
      sdd1.ioWrite(0x4800, 1);
      sdd1.ioWrite(0x4801, 1);
      const out: number[] = [];
      for (let i = 0; i < 32; i++) out.push(sdd1.mcuRead(0xc04000, 0));
      return out;
    }
    expect(run(a)).toEqual(run(b));
  });
});
