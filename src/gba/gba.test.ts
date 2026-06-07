import { describe, expect, it } from "vitest";

import { Gba } from "./gba.js";
import { GBA_STATE_VERSION, UnsupportedGbaSaveStateError } from "./serialization/serialization.js";

/** 64 KiB blank ROM with an ARM `B .` (0xEAFFFFFE) at offset 0 so a
 *  runFrame() call has somewhere safe to spin — without it the CPU
 *  walks past the cart end into open-bus pattern bytes that decode
 *  to "unpredictable" ARM opcodes (e.g. R15-as-mul-dest), which the
 *  CPU rejects with a throw. Real cart ROMs always have a branch
 *  here as part of the Nintendo-prescribed header. */
function makeBlankRom(): Uint8Array {
  const rom = new Uint8Array(0x10000);
  rom[0] = 0xfe;
  rom[1] = 0xff;
  rom[2] = 0xff;
  rom[3] = 0xea;
  return rom;
}

describe("Gba — top-level facade", () => {
  it("seeds PC at the cart entry point (0x08000000)", () => {
    const gba = new Gba(new Uint8Array(0x10000));
    expect(gba.cpu.regs.r[15]! >>> 0).toBe(0x08000000);
  });

  it("seeds user-mode SP at the top of IWRAM (0x03007F00)", () => {
    const gba = new Gba(new Uint8Array(0x10000));
    expect(gba.cpu.regs.r[13]! >>> 0).toBe(0x03007f00);
  });

  it("loads ROM bytes into the cart region at 0x08000000", () => {
    const rom = new Uint8Array(0x10000);
    rom[0] = 0xaa;
    rom[1] = 0xbb;
    const gba = new Gba(rom);
    expect(gba.mem.bus.read16(0x08000000)).toBe(0xbbaa);
  });

  it("framebuffer is the PPU's framebuffer (shape-compatible accessor)", () => {
    const gba = new Gba(new Uint8Array(0x10000));
    expect(gba.framebuffer).toBe(gba.mem.ppu.framebuffer);
  });

  it("runFrame fires onFrame exactly once with the rendered framebuffer", () => {
    const gba = new Gba(makeBlankRom());
    let callCount = 0;
    let received: Uint8ClampedArray<ArrayBuffer> | null = null;
    gba.onFrame = (fb) => {
      callCount++;
      received = fb;
    };
    gba.runFrame();
    expect(callCount).toBe(1);
    expect(received).toBe(gba.framebuffer);
  });

  it("runFrame with forced blank renders white", () => {
    const gba = new Gba(makeBlankRom());
    gba.mem.ppu.dispcnt = 0x80; // forced blank — overrides anything in VRAM
    gba.runFrame();
    expect(gba.framebuffer[0]).toBe(0xff); // R
    expect(gba.framebuffer[1]).toBe(0xff); // G
    expect(gba.framebuffer[2]).toBe(0xff); // B
    expect(gba.framebuffer[3]).toBe(0xff); // A
  });

  it("scans the cart for a backup marker on construction and wires SRAM when found", () => {
    const rom = new Uint8Array(0x10000);
    const marker = "SRAM_V";
    // Embed marker at a 4-byte aligned offset well past the header.
    for (let i = 0; i < marker.length; i++) rom[0x400 + i] = marker.charCodeAt(i);
    const gba = new Gba(rom);
    expect(gba.backup).toEqual({ type: "sram", size: 0x8000 });
    expect(gba.mem.sram).not.toBeNull();
    // Verify the SRAM region is reachable via the bus.
    gba.mem.bus.write8(0x0e000000, 0xa5);
    expect(gba.mem.bus.read8(0x0e000000)).toBe(0xa5);
  });

  it("leaves SRAM unmapped when no backup marker is present", () => {
    const gba = new Gba(new Uint8Array(0x10000));
    expect(gba.backup.type).toBe("none");
    expect(gba.mem.sram).toBeNull();
  });

  it("joypad presses are visible to the cart through KEYINPUT (0x04000130)", () => {
    const gba = new Gba(new Uint8Array(0x10000));
    // Power-on: every button released → KEYINPUT = 0x03FF (only the 10 button
    // bits 0-9 are high; unused bits 10-15 read as 0 on hardware).
    expect(gba.mem.bus.read16(0x04000130)).toBe(0x03ff);
    gba.joypad.press("a");
    gba.joypad.press("start");
    // Bit 0 (A) and bit 3 (START) cleared; the other button bits still high.
    const expected = 0x03ff & ~((1 << 0) | (1 << 3));
    expect(gba.mem.bus.read16(0x04000130)).toBe(expected);
    gba.joypad.release("a");
    expect(gba.mem.bus.read16(0x04000130) & 0x0001).toBe(0x0001); // A bit back high
  });
});

describe("Gba.saveState / loadState", () => {
  it("blob starts with GBA_STATE_VERSION", () => {
    const gba = new Gba(makeBlankRom());
    const blob = gba.saveState();
    expect(blob[0]).toBe(GBA_STATE_VERSION);
    expect(blob.length).toBeGreaterThan(1);
  });

  it("round-trips a fresh boot — identical state-blob across save → load → save", () => {
    const gba = new Gba(makeBlankRom());
    const blob1 = gba.saveState();
    gba.loadState(blob1);
    const blob2 = gba.saveState();
    expect(blob2.length).toBe(blob1.length);
    for (let i = 0; i < blob1.length; i++) {
      if (blob1[i] !== blob2[i]) {
        throw new Error(`byte ${i} differs after round-trip: ${blob1[i]} vs ${blob2[i]}`);
      }
    }
  });

  it("round-trips after running a few frames — re-load reproduces the same next-frame state", () => {
    const a = new Gba(makeBlankRom());
    for (let f = 0; f < 3; f++) a.runFrame();

    const snapshot = a.saveState();

    // Run another frame on `a` to advance further so the snapshot
    // differs from the current state.
    a.runFrame();
    const aAfter = a.saveState();
    expect(aAfter).not.toEqual(snapshot);

    // A fresh engine that loads the snapshot, then runs one more frame,
    // should land on the same state as `a` after that extra frame.
    const b = new Gba(makeBlankRom());
    b.loadState(snapshot);
    b.runFrame();
    const bAfter = b.saveState();

    expect(bAfter.length).toBe(aAfter.length);
    for (let i = 0; i < aAfter.length; i++) {
      if (aAfter[i] !== bAfter[i]) {
        throw new Error(`byte ${i} differs after reload + run: ${aAfter[i]} vs ${bAfter[i]}`);
      }
    }
  });

  it("restores KEYCNT but NOT held buttons across save/load", () => {
    const gba = new Gba(makeBlankRom());
    gba.joypad.press("a");
    gba.joypad.press("l");
    gba.mem.bus.write16(0x04000132, 0x4321);
    const blob = gba.saveState();

    const other = new Gba(makeBlankRom());
    other.loadState(blob);
    // Held buttons are live input, not part of a restored game — clearing
    // them on load prevents a key held at save time from staying stuck down
    // (which made the game move on its own after a reload).
    expect(other.joypad.isPressed("a")).toBe(false);
    expect(other.joypad.isPressed("l")).toBe(false);
    // KEYCNT (the interrupt-control register) still round-trips.
    expect(other.mem.bus.read16(0x04000132)).toBe(0x4321);
  });

  it("preserves PPU register state across save/load", () => {
    const gba = new Gba(makeBlankRom());
    gba.mem.ppu.write16(0x00, 0x0405); // DISPCNT — mode 5 + BG2 enable
    gba.mem.ppu.write16(0x40, (50 << 8) | 100); // WIN0H
    gba.mem.ppu.write16(0x50, 0x01 | (2 << 6)); // BLDCNT
    gba.mem.ppu.write16(0x54, 13); // BLDY
    const blob = gba.saveState();

    const other = new Gba(makeBlankRom());
    other.loadState(blob);
    expect(other.mem.ppu.dispcnt).toBe(0x0405);
    expect(other.mem.ppu.win0h).toBe((50 << 8) | 100);
    expect(other.mem.ppu.bldcnt).toBe(0x01 | (2 << 6));
    expect(other.mem.ppu.bldy).toBe(13);
  });

  it("preserves EWRAM / IWRAM / VRAM / palette / OAM bytes across save/load", () => {
    const gba = new Gba(makeBlankRom());
    gba.mem.ewram[0x100] = 0xab;
    gba.mem.iwram[0x200] = 0xcd;
    gba.mem.vram[0x300] = 0xef;
    gba.mem.palette[0x10] = 0x12;
    gba.mem.oam[0x20] = 0x34;
    const blob = gba.saveState();

    const other = new Gba(makeBlankRom());
    other.loadState(blob);
    expect(other.mem.ewram[0x100]).toBe(0xab);
    expect(other.mem.iwram[0x200]).toBe(0xcd);
    expect(other.mem.vram[0x300]).toBe(0xef);
    expect(other.mem.palette[0x10]).toBe(0x12);
    expect(other.mem.oam[0x20]).toBe(0x34);
  });

  it("preserves SRAM bytes when the cart has an SRAM marker", () => {
    // Build a ROM with the SRAM marker so the cart wires SramBackup.
    const rom = makeBlankRom();
    const marker = "SRAM_V";
    for (let i = 0; i < marker.length; i++) rom[0x1000 + i] = marker.charCodeAt(i);
    const gba = new Gba(rom);
    expect(gba.mem.sram).not.toBeNull();
    gba.mem.sram!.bytes[0] = 0x55;
    gba.mem.sram!.bytes[0x7fff] = 0xaa;
    const blob = gba.saveState();

    const other = new Gba(rom);
    other.loadState(blob);
    expect(other.mem.sram!.bytes[0]).toBe(0x55);
    expect(other.mem.sram!.bytes[0x7fff]).toBe(0xaa);
  });

  it("rejects a blob with a newer version than the current build", () => {
    const blob = new Uint8Array([GBA_STATE_VERSION + 1, 0xff]);
    const gba = new Gba(makeBlankRom());
    expect(() => gba.loadState(blob)).toThrow(UnsupportedGbaSaveStateError);
  });

  it("rejects an empty blob", () => {
    const gba = new Gba(makeBlankRom());
    expect(() => gba.loadState(new Uint8Array())).toThrow(UnsupportedGbaSaveStateError);
  });
});
