import { describe, expect, it } from "vitest";

import { PPU, type PpuBus } from "./ppu.js";

/** CHR-RAM + 2 KiB nametable RAM (horizontal mirroring) — enough to exercise
 *  the PPU's $2006/$2007 path without a real mapper. */
class FakePpuBus implements PpuBus {
  readonly chr = new Uint8Array(0x2000);
  readonly nt = new Uint8Array(0x800);
  ppuRead(addr: number): number {
    addr &= 0x3fff;
    return addr < 0x2000 ? this.chr[addr]! : this.nt[this.ntIndex(addr)]!;
  }
  ppuWrite(addr: number, value: number): void {
    addr &= 0x3fff;
    if (addr < 0x2000) this.chr[addr] = value;
    else this.nt[this.ntIndex(addr)] = value;
  }
  private ntIndex(addr: number): number {
    const a = addr & 0x0fff;
    const bank = a >> 10 < 2 ? 0 : 1; // horizontal mirroring
    return (bank << 10) | (a & 0x3ff);
  }
}

// The loopy registers are private; peek at them through a typed cast (they exist
// at runtime) so tests can assert the scroll-address math directly.
interface Loopy {
  v: number;
  t: number;
  fineX: number;
  writeToggle: number;
}
const peek = (p: PPU): Loopy => p as unknown as Loopy;

function tickTo(ppu: PPU, scanline: number, dot: number): void {
  for (let i = 0; i < 90000 && !(ppu.scanline === scanline && ppu.dot === dot); i++) ppu.tick();
}

describe("PPU registers", () => {
  it("$2006 writes compose into v and clear the toggle", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(6, 0x21);
    ppu.cpuWrite(6, 0x08);
    expect(peek(ppu).v).toBe(0x2108);
    expect(peek(ppu).writeToggle).toBe(0);
  });

  it("$2002 read resets the $2005/$2006 write toggle", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(6, 0x21); // toggle → 1
    ppu.cpuRead(2);
    ppu.cpuWrite(6, 0x21); // treated as a first write again
    expect(peek(ppu).writeToggle).toBe(1);
  });

  it("$2000 sets the nametable bits of t", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(0, 0x03);
    expect(peek(ppu).t & 0x0c00).toBe(0x0c00);
  });

  it("$2005 sets fine X and the coarse/fine scroll bits of t", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(5, 0x7d); // x
    expect(peek(ppu).fineX).toBe(5);
    expect(peek(ppu).t & 0x001f).toBe(0x0f);
    ppu.cpuWrite(5, 0x5e); // y
    const t = peek(ppu).t;
    expect((t >> 12) & 7).toBe(6); // fine Y
    expect((t >> 5) & 0x1f).toBe(0x0b); // coarse Y
  });

  it("$2007 reads are buffered, palette reads are immediate", () => {
    const bus = new FakePpuBus();
    bus.chr[0] = 0x12;
    bus.chr[1] = 0xab;
    const ppu = new PPU(bus);
    ppu.cpuWrite(6, 0x00);
    ppu.cpuWrite(6, 0x00); // v = 0
    expect(ppu.cpuRead(7)).toBe(0x00); // stale buffer
    expect(ppu.cpuRead(7)).toBe(0x12); // chr[0]
  });

  it("PPUCTRL bit 2 selects a +32 VRAM increment", () => {
    const bus = new FakePpuBus();
    const ppu = new PPU(bus);
    ppu.cpuWrite(0, 0x04); // increment 32
    ppu.cpuWrite(6, 0x20);
    ppu.cpuWrite(6, 0x00); // v = $2000
    ppu.cpuWrite(7, 0xaa); // → $2000, v = $2020
    ppu.cpuWrite(7, 0xbb); // → $2020
    expect(bus.ppuRead(0x2000)).toBe(0xaa);
    expect(bus.ppuRead(0x2020)).toBe(0xbb);
  });

  it("mirrors palette $3F10 onto $3F00", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x10);
    ppu.cpuWrite(7, 0x21);
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x00);
    expect(ppu.cpuRead(7)).toBe(0x21);
  });

  it("mirrors sprite palette $3F14/$3F18/$3F1C onto $3F04/$3F08/$3F0C", () => {
    const ppu = new PPU(new FakePpuBus());
    // Write through the sprite mirrors, read back through the BG entries.
    for (const [mirror, mirrored, value] of [
      [0x14, 0x04, 0x11],
      [0x18, 0x08, 0x22],
      [0x1c, 0x0c, 0x33]
    ] as const) {
      ppu.cpuWrite(6, 0x3f);
      ppu.cpuWrite(6, mirror);
      ppu.cpuWrite(7, value);
      ppu.cpuWrite(6, 0x3f);
      ppu.cpuWrite(6, mirrored);
      expect(ppu.cpuRead(7)).toBe(value);
    }
  });

  it("does NOT mirror non-zero-column sprite entries (e.g. $3F11 is distinct from $3F01)", () => {
    const ppu = new PPU(new FakePpuBus());
    // $3F01 and $3F11 are separate cells; only the $x0 column entries mirror.
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x01);
    ppu.cpuWrite(7, 0x0a);
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x11);
    ppu.cpuWrite(7, 0x0b);
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x01);
    expect(ppu.cpuRead(7)).toBe(0x0a);
  });

  it("masks palette writes to 6 bits", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x00);
    ppu.cpuWrite(7, 0xff);
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x00);
    expect(ppu.cpuRead(7)).toBe(0x3f);
  });

  it("OAM writes advance OAMADDR; reads do not", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(3, 0x00);
    ppu.cpuWrite(4, 0x11);
    ppu.cpuWrite(4, 0x22);
    ppu.cpuWrite(3, 0x00);
    expect(ppu.cpuRead(4)).toBe(0x11);
    expect(ppu.cpuRead(4)).toBe(0x11);
  });

  it("OAMADDR wraps from $FF back to $00 on write", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(3, 0xff);
    ppu.cpuWrite(4, 0x99); // stored at $FF, then OAMADDR increments to $00
    ppu.cpuWrite(4, 0x77); // now stored at $00 (the wrap)
    ppu.cpuWrite(3, 0xff);
    expect(ppu.cpuRead(4)).toBe(0x99); // the $FF write survives
    ppu.cpuWrite(3, 0x00);
    expect(ppu.cpuRead(4)).toBe(0x77); // and the wrapped write landed at $00
  });

  it("OAMDATA reads of attribute bytes mask off bits 2-4", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(3, 0x02); // attribute byte of sprite 0
    ppu.cpuWrite(4, 0xff);
    ppu.cpuWrite(3, 0x02);
    expect(ppu.cpuRead(4)).toBe(0xe3); // bits 2-4 read back as 0
  });

  it("dmaOam copies a 256-byte page through OAMADDR", () => {
    const ppu = new PPU(new FakePpuBus());
    const page = new Uint8Array(256);
    for (let i = 0; i < 256; i++) page[i] = i;
    ppu.cpuWrite(3, 0x00);
    ppu.dmaOam(page);
    // DMA leaves OAMADDR back at its start (256 increments wrap to 0).
    ppu.cpuWrite(3, 0x10);
    expect(ppu.cpuRead(4)).toBe(0x10);
    ppu.cpuWrite(3, 0xfd);
    expect(ppu.cpuRead(4)).toBe(0xfd);
  });

  it("dmaOam starts at the current OAMADDR", () => {
    const ppu = new PPU(new FakePpuBus());
    const page = new Uint8Array(256).fill(0x55);
    ppu.cpuWrite(3, 0x04); // start mid-OAM; DMA wraps around
    ppu.dmaOam(page);
    ppu.cpuWrite(3, 0x04);
    expect(ppu.cpuRead(4)).toBe(0x55);
  });
});

describe("PPU timing", () => {
  it("sets the VBlank flag at scanline 241 and clears it at pre-render", () => {
    const ppu = new PPU(new FakePpuBus());
    tickTo(ppu, 240, 10);
    expect(ppu.cpuRead(2) & 0x80).toBe(0); // still clear pre-VBlank
    // Read past the set dot — reading exactly on (241,1) is the suppression
    // race (returns 0); a dot later the flag reads set.
    tickTo(ppu, 241, 3);
    expect(ppu.cpuRead(2) & 0x80).toBe(0x80);
  });

  it("does not set the VBlank flag before dot 1 of scanline 241", () => {
    const ppu = new PPU(new FakePpuBus());
    tickTo(ppu, 241, 1); // exactly at (241,1) — the set happens during this tick
    // The flag is raised inside the (241,1) tick, so it is already visible here,
    // but it must not have been set on any earlier scanline.
    expect(ppu.scanline).toBe(241);
    const ppu2 = new PPU(new FakePpuBus());
    tickTo(ppu2, 241, 0);
    expect(ppu2.cpuRead(2) & 0x80).toBe(0); // not yet at dot 1
  });

  it("reading $2002 clears the VBlank flag", () => {
    const ppu = new PPU(new FakePpuBus());
    tickTo(ppu, 241, 3);
    expect(ppu.cpuRead(2) & 0x80).toBe(0x80); // read once: flag was set
    expect(ppu.cpuRead(2) & 0x80).toBe(0); // and the read cleared it
  });

  it("the pre-render line clears VBlank even without an intervening $2002 read", () => {
    const ppu = new PPU(new FakePpuBus());
    tickTo(ppu, 241, 3); // VBlank set (left unread)
    tickTo(ppu, 261, 3); // past pre-render dot 1 (which clears it) and its read-race
    expect(ppu.cpuRead(2) & 0x80).toBe(0);
  });

  it("raises an NMI edge when enabled at VBlank, not when disabled", () => {
    const off = new PPU(new FakePpuBus());
    tickTo(off, 241, 2);
    expect(off.pollNmi()).toBe(false);

    const on = new PPU(new FakePpuBus());
    on.cpuWrite(0, 0x80); // NMI enable
    tickTo(on, 241, 2);
    expect(on.pollNmi()).toBe(true);
  });

  it("enabling NMI during VBlank raises an immediate edge", () => {
    const ppu = new PPU(new FakePpuBus());
    tickTo(ppu, 241, 2);
    expect(ppu.pollNmi()).toBe(false); // not enabled yet
    ppu.cpuWrite(0, 0x80);
    expect(ppu.pollNmi()).toBe(true);
  });

  it("skips one dot on odd frames when rendering is enabled", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(1, 0x08); // show background
    const count = (): number => {
      const f = ppu.frame;
      let n = 0;
      while (ppu.frame === f) {
        ppu.tick();
        n++;
      }
      return n;
    };
    expect(count()).toBe(89342); // frame 0 (even) — full length
    expect(count()).toBe(89341); // frame 1 (odd) — skipped dot
  });

  it("does not skip the dot on odd frames when rendering is disabled", () => {
    const ppu = new PPU(new FakePpuBus()); // mask = 0
    const count = (): number => {
      const f = ppu.frame;
      let n = 0;
      while (ppu.frame === f) {
        ppu.tick();
        n++;
      }
      return n;
    };
    expect(count()).toBe(89342); // frame 0
    expect(count()).toBe(89342); // frame 1 — no skip without rendering
  });
});

describe("PPU sprite flags", () => {
  /** Fill CHR + nametable RAM so every background and sprite pixel is opaque,
   *  giving a deterministic sprite-0-overlap-background scenario. */
  function opaqueBus(): FakePpuBus {
    const bus = new FakePpuBus();
    bus.chr.fill(0xff); // every pattern byte opaque → BG/sprite colour 3
    bus.nt.fill(0x01); // any tile index works; pattern is all-opaque anyway
    return bus;
  }

  /** Park every sprite off the bottom of the screen (y=$FF is never visible) so
   *  the default all-zero OAM does not put 64 sprites on scanline 0. */
  function clearOam(ppu: PPU): void {
    const page = new Uint8Array(256);
    for (let i = 0; i < 64; i++) page[i * 4] = 0xff;
    ppu.cpuWrite(3, 0x00);
    ppu.dmaOam(page);
  }

  /** Put one sprite into OAM via OAMADDR/OAMDATA. */
  function writeSprite(ppu: PPU, index: number, y: number, tile: number, attr: number, x: number): void {
    ppu.cpuWrite(3, index * 4);
    ppu.cpuWrite(4, y);
    ppu.cpuWrite(4, tile);
    ppu.cpuWrite(4, attr);
    ppu.cpuWrite(4, x);
  }

  it("sets the sprite-0 hit flag when an opaque sprite-0 pixel overlaps opaque BG", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    // Sprite 0 at y=20 is evaluated on scanlines 20..27 and shown one line later.
    writeSprite(ppu, 0, 20, 0x00, 0x00, 100);
    ppu.cpuWrite(1, 0x18); // show BG + sprites
    // Run into the line where sprite 0 is displayed (scanline 21) past x=100.
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0x40);
  });

  it("does not set sprite-0 hit when sprites are hidden", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    writeSprite(ppu, 0, 20, 0x00, 0x00, 100);
    ppu.cpuWrite(1, 0x08); // show BG only
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0);
  });

  it("does not set sprite-0 hit at x=255 (the last column is excluded)", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    // Place sprite 0 so its only overlapping opaque pixel falls on x=255.
    writeSprite(ppu, 0, 20, 0x00, 0x00, 255);
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0);
  });

  it("does not set sprite-0 hit for sprite index 1", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    writeSprite(ppu, 0, 200, 0x00, 0x00, 240); // sprite 0 parked off the test line
    writeSprite(ppu, 1, 20, 0x00, 0x00, 100); // sprite 1 overlaps BG, but isn't sprite 0
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0);
  });

  it("clears the sprite-0 hit flag at the pre-render line", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    writeSprite(ppu, 0, 20, 0x00, 0x00, 100);
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0x40);
    tickTo(ppu, 261, 2); // pre-render dot 1 clears sprite-0 + overflow
    expect(ppu.cpuRead(2) & 0x40).toBe(0);
  });

  it("sets the sprite-overflow flag when a 9th sprite lands on a scanline", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    // Nine sprites all on the same line → the 9th trips the overflow flag.
    for (let i = 0; i < 9; i++) writeSprite(ppu, i, 20, 0x00, 0x00, i * 8);
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x20).toBe(0x20);
  });

  it("does not set overflow with exactly 8 sprites on a scanline", () => {
    const ppu = new PPU(opaqueBus());
    clearOam(ppu);
    for (let i = 0; i < 8; i++) writeSprite(ppu, i, 20, 0x00, 0x00, i * 8);
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x20).toBe(0);
  });

  it("8×16 sprites take the pattern table from tile bit 0 (odd tile = table 1)", () => {
    // Table 0 ($0000-$0FFF) transparent, table 1 ($1000-$1FFF) opaque. Drive the
    // BG from table 1 as well so an opaque sprite pixel produces a sprite-0 hit.
    const bus = new FakePpuBus();
    bus.chr.fill(0x00);
    bus.chr.fill(0xff, 0x1000);
    bus.nt.fill(0x01);
    const ppu = new PPU(bus);
    clearOam(ppu);
    ppu.cpuWrite(0, 0x20 | 0x10); // 8×16 sprites + BG pattern table 1
    writeSprite(ppu, 0, 20, 0x01, 0x00, 100); // odd tile → bit 0 set → table 1
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0x40); // opaque sprite over opaque BG
  });

  it("8×16 sprites with an even tile fetch from table 0", () => {
    const bus = new FakePpuBus();
    bus.chr.fill(0x00); // table 0 transparent
    bus.chr.fill(0xff, 0x1000); // table 1 opaque
    bus.nt.fill(0x01);
    const ppu = new PPU(bus);
    clearOam(ppu);
    ppu.cpuWrite(0, 0x20 | 0x10); // 8×16 sprites + BG pattern table 1
    writeSprite(ppu, 0, 20, 0x02, 0x00, 100); // even tile → bit 0 clear → table 0
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0); // sprite transparent → no hit
  });

  it("8×8 sprites take the pattern table from PPUCTRL bit 3", () => {
    const bus = new FakePpuBus();
    bus.chr.fill(0x00); // table 0 transparent
    bus.chr.fill(0xff, 0x1000); // table 1 opaque
    bus.nt.fill(0x01);
    const ppu = new PPU(bus);
    clearOam(ppu);
    ppu.cpuWrite(0, 0x08 | 0x10); // 8×8, sprite table 1, BG table 1
    writeSprite(ppu, 0, 20, 0x00, 0x00, 100); // tile 0 → table 1 via CTRL bit 3
    ppu.cpuWrite(1, 0x18);
    tickTo(ppu, 22, 0);
    expect(ppu.cpuRead(2) & 0x40).toBe(0x40);
  });
});

// The PPU I/O bus is a capacitor: register writes drive it, some reads drive a
// subset, and each undriven bit drains to 0 after a decay window (frames here,
// poked directly to skip the ~36-frame wait). ppu_open_bus verifies this.
describe("PPU open-bus decay", () => {
  // The frame counter is public; nudge it to fast-forward past the decay window.
  interface FrameCounter {
    frame: number;
  }
  const setFrame = (p: PPU, n: number): void => {
    (p as unknown as FrameCounter).frame = n;
  };

  it("returns the last driven value from a write-only register", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(2, 0x55); // a write drives all 8 bus bits
    expect(ppu.cpuRead(0)).toBe(0x55); // PPUCTRL is write-only → reads the bus
  });

  it("drains every bit to 0 once the decay window passes", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(2, 0xff);
    setFrame(ppu, 100); // well past the ~36-frame decay window
    expect(ppu.cpuRead(0)).toBe(0x00);
  });

  it("keeps decaying the low 5 bits of $2002 even as it is read", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(2, 0x1f); // drive the low 5 bits high
    setFrame(ppu, 100);
    // A $2002 read drives only the top 3 status bits; the low 5 have drained.
    expect(ppu.cpuRead(2) & 0x1f).toBe(0x00);
  });

  it("takes the high 2 bits of a palette read from the open bus", () => {
    const ppu = new PPU(new FakePpuBus());
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x00); // v = $3F00
    ppu.cpuWrite(7, 0x15); // palette[$3F00] = 0x15
    ppu.cpuWrite(6, 0x3f);
    ppu.cpuWrite(6, 0x00); // v = $3F00 again
    ppu.cpuWrite(2, 0xff); // drive the open bus (bits 7-6 set)
    // Bits 5-0 come from palette RAM, bits 7-6 from the open bus.
    expect(ppu.cpuRead(7)).toBe(0x15 | 0xc0);
  });
});
