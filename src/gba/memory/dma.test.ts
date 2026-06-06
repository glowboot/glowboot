import { describe, expect, it } from "vitest";

import { Dma, DmaTiming } from "./dma.js";
import { InterruptController, IRQ_DMA0, IRQ_DMA3 } from "./interrupts.js";
import { makeGbaMemoryMap, MappedBus } from "./mapped-bus.js";

/** Per-channel base addresses on the bus (0x040000B0 + N * 12). */
const CHAN_BASE = [0x040000b0, 0x040000bc, 0x040000c8, 0x040000d4] as const;

function makeFixture(): { mem: ReturnType<typeof makeGbaMemoryMap>; dma: Dma } {
  const mem = makeGbaMemoryMap();
  return { mem, dma: mem.dma };
}

/** Write a complete DMA configuration through the bus, in the order
 *  real games do it: SAD → DAD → CNT_L → CNT_H (enable bit triggers
 *  the latch). */
function configure(
  mem: ReturnType<typeof makeGbaMemoryMap>,
  channel: 0 | 1 | 2 | 3,
  src: number,
  dst: number,
  count: number,
  control: number
): void {
  const base = CHAN_BASE[channel];
  mem.bus.write32(base, src);
  mem.bus.write32(base + 4, dst);
  mem.bus.write16(base + 8, count);
  mem.bus.write16(base + 10, control);
}

describe("DMA — immediate transfer", () => {
  it("DMA0 copies halfwords from source to destination", () => {
    const { mem } = makeFixture();
    // Stash 8 halfwords in EWRAM, then copy to a different EWRAM range.
    for (let i = 0; i < 8; i++) mem.bus.write16(0x02000000 + i * 2, 0x1100 + i);
    // Control: enable + immediate + halfword + src inc + dest inc.
    configure(mem, 0, 0x02000000, 0x02001000, 8, 0x8000);
    for (let i = 0; i < 8; i++) {
      expect(mem.bus.read16(0x02001000 + i * 2)).toBe(0x1100 + i);
    }
  });

  it("DMA0 copies words when CNT.WORD is set", () => {
    const { mem } = makeFixture();
    mem.bus.write32(0x02000000, 0xdeadbeef);
    mem.bus.write32(0x02000004, 0xcafef00d);
    // enable + immediate + word + src inc + dest inc.
    configure(mem, 0, 0x02000000, 0x02001000, 2, 0x8000 | 0x400);
    expect(mem.bus.read32(0x02001000)).toBe(0xdeadbeef | 0);
    expect(mem.bus.read32(0x02001004)).toBe(0xcafef00d | 0);
  });

  it("destination 'fixed' mode (mode 2) doesn't advance dst", () => {
    const { mem } = makeFixture();
    mem.bus.write16(0x02000000, 0x1234);
    mem.bus.write16(0x02000002, 0x5678);
    mem.bus.write16(0x02000004, 0x9abc);
    // dest control = 2 (fixed), src control = 0 (inc).
    const control = 0x8000 | (2 << 5);
    configure(mem, 0, 0x02000000, 0x02001000, 3, control);
    // Each transfer overwrote the same destination → only the last
    // value survives.
    expect(mem.bus.read16(0x02001000)).toBe(0x9abc);
  });

  it("source 'fixed' mode (mode 2) reads from the same source repeatedly", () => {
    const { mem } = makeFixture();
    mem.bus.write16(0x02000000, 0xaaaa);
    // src control = 2 (fixed); halfword; enable + immediate; dst inc.
    const control = 0x8000 | (2 << 7);
    configure(mem, 0, 0x02000000, 0x02001000, 3, control);
    expect(mem.bus.read16(0x02001000)).toBe(0xaaaa);
    expect(mem.bus.read16(0x02001002)).toBe(0xaaaa);
    expect(mem.bus.read16(0x02001004)).toBe(0xaaaa);
  });

  it("'decrement' mode walks backwards", () => {
    const { mem } = makeFixture();
    for (let i = 0; i < 4; i++) mem.bus.write16(0x02000000 + i * 2, 0x1100 + i);
    // src control = 1 (decrement); halfword; enable + immediate; dest inc.
    const control = 0x8000 | (1 << 7);
    configure(mem, 0, 0x02000006, 0x02001000, 4, control);
    expect(mem.bus.read16(0x02001000)).toBe(0x1103);
    expect(mem.bus.read16(0x02001002)).toBe(0x1102);
    expect(mem.bus.read16(0x02001004)).toBe(0x1101);
    expect(mem.bus.read16(0x02001006)).toBe(0x1100);
  });

  it("clears the enable bit after a non-repeat transfer", () => {
    const { mem } = makeFixture();
    configure(mem, 0, 0x02000000, 0x02001000, 1, 0x8000);
    // Read back CNT_H — enable bit should be cleared.
    expect(mem.bus.read16(CHAN_BASE[0] + 10) & 0x8000).toBe(0);
  });

  it("raises IRQ_DMA0 on completion when CNT.IRQ is set", () => {
    const { mem } = makeFixture();
    configure(mem, 0, 0x02000000, 0x02001000, 1, 0x8000 | 0x4000);
    expect(mem.interrupts.if_ & (1 << IRQ_DMA0)).toBe(1 << IRQ_DMA0);
  });

  it("does NOT raise an IRQ on completion when CNT.IRQ is clear", () => {
    const { mem } = makeFixture();
    configure(mem, 0, 0x02000000, 0x02001000, 1, 0x8000);
    expect(mem.interrupts.if_ & (1 << IRQ_DMA0)).toBe(0);
  });

  it("re-fires an immediate transfer when CNT_H is rewritten with enable=1, even if enable was already latched", () => {
    // Casper's intro hit this: a repeat-mode DMA from F0 leaves
    // enable=1 latched, then F4 reconfigures the same channel with
    // ctrl=0xc400 (immediate, 32-bit) — real silicon re-arms on the
    // new write, but a 0→1-only gate would silently drop the transfer.
    const { mem } = makeFixture();
    // First transfer: repeat-mode immediate. After completion the
    // enable bit stays set because repeat=1.
    mem.bus.write16(0x02000000, 0x1111);
    const repeatCtrl = 0x8000 | 0x200; // enable + repeat
    configure(mem, 3, 0x02000000, 0x02001000, 1, repeatCtrl);
    expect(mem.bus.read16(0x02001000)).toBe(0x1111);
    expect(mem.bus.read16(CHAN_BASE[3] + 10) & 0x8000).toBe(0x8000); // still enabled
    // Reconfigure the SAME channel with a fresh immediate transfer
    // from a different source. The 0→1 transition never happens
    // (enable was already 1), but the new write must still fire.
    mem.bus.write16(0x02000010, 0x2222);
    configure(mem, 3, 0x02000010, 0x02001002, 1, 0x8000); // enable, no repeat
    expect(mem.bus.read16(0x02001002)).toBe(0x2222);
  });
});

describe("DMA — VBlank / HBlank trigger modes", () => {
  it("VBlank-armed channel doesn't fire until VBlank arrives", () => {
    const { mem } = makeFixture();
    mem.bus.write16(0x02000000, 0xfeed);
    // enable + timing=VBlank + halfword.
    const control = 0x8000 | (DmaTiming.VBlank << 12);
    configure(mem, 0, 0x02000000, 0x02001000, 1, control);
    // Destination still untouched immediately after CNT_H write.
    expect(mem.bus.read16(0x02001000)).toBe(0);
    // Fire VBlank — channel should run now.
    mem.dma.onVBlank();
    expect(mem.bus.read16(0x02001000)).toBe(0xfeed);
  });

  it("HBlank-armed channel fires on HBlank only", () => {
    const { mem } = makeFixture();
    mem.bus.write16(0x02000000, 0x1234);
    const control = 0x8000 | (DmaTiming.HBlank << 12);
    configure(mem, 0, 0x02000000, 0x02001000, 1, control);
    mem.dma.onVBlank(); // wrong trigger; should be ignored
    expect(mem.bus.read16(0x02001000)).toBe(0);
    mem.dma.onHBlank();
    expect(mem.bus.read16(0x02001000)).toBe(0x1234);
  });

  it("repeat-mode channel stays enabled and re-fires on each trigger", () => {
    const { mem } = makeFixture();
    // Source increments through 3 distinct halfwords; dst with reload
    // (mode 3) so each VBlank writes from src[0..n] into the same dst.
    mem.bus.write16(0x02000000, 0xaaa1);
    mem.bus.write16(0x02000002, 0xaaa2);
    // enable + repeat + dst-control=3 (inc+reload) + halfword + VBlank.
    const control = 0x8000 | (DmaTiming.VBlank << 12) | 0x200 | (3 << 5);
    configure(mem, 0, 0x02000000, 0x02001000, 1, control);
    expect(mem.bus.read16(0x02001000)).toBe(0); // not yet fired
    mem.dma.onVBlank();
    expect(mem.bus.read16(0x02001000)).toBe(0xaaa1);
    // Channel still enabled; SAD has advanced. Refresh DAD via the
    // reload behaviour; second VBlank fires from src[1] → dst[0].
    mem.dma.onVBlank();
    expect(mem.bus.read16(0x02001000)).toBe(0xaaa2);
  });
});

describe("DMA — channel-specific quirks", () => {
  it("DMA3 supports a full 16-bit transfer count (0 = 0x10000)", () => {
    const dma = new Dma(new MappedBus(), new InterruptController());
    // Drive CNT_L through the channel-3 control register slot. The
    // 14-bit-vs-16-bit difference matters for unit counting only.
    const ch = dma.channels[3];
    ch.cnt = 0;
    expect(ch.unitCount()).toBe(0x10000);
    ch.cnt = 1;
    expect(ch.unitCount()).toBe(1);
  });

  it("DMA0..2 cap the transfer count at 14 bits (0 = 0x4000)", () => {
    const dma = new Dma(new MappedBus(), new InterruptController());
    for (const i of [0, 1, 2] as const) {
      dma.channels[i].cnt = 0;
      expect(dma.channels[i].unitCount()).toBe(0x4000);
      dma.channels[i].cnt = 0xffff;
      expect(dma.channels[i].unitCount()).toBe(0x3fff);
    }
  });

  it("each channel's IRQ source bit is correct", () => {
    const { mem } = makeFixture();
    configure(mem, 3, 0x02000000, 0x02001000, 1, 0x8000 | 0x4000);
    expect(mem.interrupts.if_ & (1 << IRQ_DMA3)).toBe(1 << IRQ_DMA3);
  });
});
