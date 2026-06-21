import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap, MappedBus } from "./mapped-bus.js";

describe("prefetchCovers — short-forward branch coverage", () => {
  it("covers the active prefetch unit's reach, but nothing on a cold unit", () => {
    const bus = new MappedBus();
    bus.prefetchEnabled = true;

    // Cold unit: a forward branch off it still reloads.
    expect(bus.prefetchCovers(0x08000002)).toBe(false);

    // Engage the unit via a Thumb ROM fetch miss. Head = addr + width
    // (0x08000002); reach = capacity(8) * width(2) = 16 bytes.
    bus.fetchCycleCost(0x08000000, 16);
    expect(bus.prefetchCovers(0x08000002)).toBe(true); // head
    expect(bus.prefetchCovers(0x08000010)).toBe(true); // last in reach
    expect(bus.prefetchCovers(0x08000012)).toBe(false); // beyond reach
    expect(bus.prefetchCovers(0x08000003)).toBe(false); // misaligned
    expect(bus.prefetchCovers(0x03000000)).toBe(false); // different region

    // A long / backward branch flushes the unit → covers nothing again.
    bus.flushPrefetchFifo();
    expect(bus.prefetchCovers(0x08000002)).toBe(false);
  });
});

describe("MappedBus regions", () => {
  it("reads and writes within a single region", () => {
    const bus = new MappedBus();
    bus.addRegion(0x1000, 0x100);
    bus.write32(0x1010, 0xdeadbeef | 0);
    expect(bus.read32(0x1010) >>> 0).toBe(0xdeadbeef);
  });

  it("respects readOnly: CPU writes are silently dropped", () => {
    const bus = new MappedBus();
    const rom = bus.addRegion(0x08000000, 0x100, { readOnly: true });
    bus.write32(0x08000010, 0xabcdef00 | 0);
    expect(bus.read32(0x08000010)).toBe(0);
    // Direct underlying-array writes still work — tests use this to load ROM.
    rom[0x10] = 0x42;
    expect(bus.read8(0x08000010)).toBe(0x42);
  });

  it("reads from unmapped addresses return zero", () => {
    const bus = new MappedBus();
    bus.addRegion(0x1000, 0x100);
    expect(bus.read32(0x9999_0000)).toBe(0);
    expect(bus.read8(0x9999_0000)).toBe(0);
  });

  it("writes to unmapped addresses are silently dropped", () => {
    const bus = new MappedBus();
    bus.addRegion(0x1000, 0x100);
    bus.write32(0x9999_0000, 0xff);
    expect(bus.read32(0x9999_0000)).toBe(0);
  });

  it("multi-region addressing decodes correctly", () => {
    const bus = new MappedBus();
    bus.addRegion(0x1000, 0x100);
    bus.addRegion(0x2000, 0x100);
    bus.write32(0x1004, 0xaa);
    bus.write32(0x2004, 0xbb);
    expect(bus.read32(0x1004)).toBe(0xaa);
    expect(bus.read32(0x2004)).toBe(0xbb);
    // Gap between regions is unmapped.
    expect(bus.read32(0x1800)).toBe(0);
  });
});

describe("makeGbaMemoryMap", () => {
  it("exposes every GBA region with correct sizes", () => {
    const mem = makeGbaMemoryMap();
    expect(mem.bios.length).toBe(0x4000);
    expect(mem.ewram.length).toBe(0x40000);
    expect(mem.iwram.length).toBe(0x8000);
    expect(mem.palette.length).toBe(0x400);
    expect(mem.vram.length).toBe(0x18000);
    expect(mem.oam.length).toBe(0x400);
  });

  it("writes through the bus reach the corresponding region's Uint8Array", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write32(0x03000010, 0x12345678);
    expect(mem.iwram[0x10]).toBe(0x78);
    expect(mem.iwram[0x13]).toBe(0x12);
  });

  it("BIOS is read-only via the bus but writable via the direct ref", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write32(0x00000020, 0xdeadbeef | 0);
    expect(mem.bus.read32(0x00000020)).toBe(0);
    mem.bios[0x20] = 0x42;
    expect(mem.bus.read8(0x00000020)).toBe(0x42);
  });

  it("ROM is read-only via the bus but loadable via the direct ref", () => {
    const mem = makeGbaMemoryMap(0x1000);
    mem.bus.write32(0x08000000, 0xdeadbeef | 0);
    expect(mem.bus.read32(0x08000000)).toBe(0);
    mem.rom[0x00] = 0xa5;
    expect(mem.bus.read8(0x08000000)).toBe(0xa5);
  });

  it("HBlank-triggered DMA fires only during visible scanlines (vcount < 160)", () => {
    // Mode-7 racers (F-Zero Climax, ATV Quad Power Racing) set up an
    // HBlank repeat-DMA that walks a per-scanline matrix scratch
    // buffer. Per GBATEK the HBlank trigger only fires for visible
    // scanlines (vcount 0..159) — without this gate, the DMA also
    // fires during VBlank scanlines, SAD advances past the buffer,
    // and the next frame's matrix corrupts.
    const mem = makeGbaMemoryMap(0x1000);
    mem.bus.write16(0x02000000, 0xbeef);
    // Configure DMA0: SAD=0x02000000, DAD=0x02001000, count=1,
    // control=enable + HBlank trigger + halfword + no-repeat.
    mem.bus.write32(0x040000b0, 0x02000000);
    mem.bus.write32(0x040000b4, 0x02001000);
    mem.bus.write32(0x040000b8, 0x80001 | (2 << 28)); // count=1, enable+HBlank+halfword
    // Re-write CNT_H explicitly so the enable+timing latches.
    mem.bus.write16(0x040000ba, 0xa000); // enable + HBlank
    mem.ppu.vcount = 200; // VBlank scanline
    expect(mem.bus.read16(0x02001000)).toBe(0);
    mem.ppu.onHBlank?.();
    // Should NOT have fired — vcount >= 160.
    expect(mem.bus.read16(0x02001000)).toBe(0);
    mem.ppu.vcount = 80;
    mem.ppu.onHBlank?.();
    // Should fire now.
    expect(mem.bus.read16(0x02001000)).toBe(0xbeef);
  });
});
