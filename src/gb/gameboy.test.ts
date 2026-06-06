import { describe, expect, it } from "vitest";

import { GameBoy } from "./gameboy.js";
import { STATE_VERSION, UnsupportedSaveStateError } from "./serialization/serialization.js";

/** Build a minimal 32 KiB ROM that constructs without errors. Pairs
 *  with the `skipLogoCheck` option so we don't need to embed the
 *  Nintendo logo fingerprint that real hardware checks at boot.
 *  Type code 0x00 = ROM ONLY (no MBC, no battery, no RAM). The body
 *  defaults to 0x00 = NOP, so the CPU walks NOPs from the post-boot
 *  entry point (0x0100) safely through every frame. */
function makeStubRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x00; // MBC type: ROM ONLY
  rom[0x0148] = 0x00; // ROM size code: 32 KiB
  rom[0x0149] = 0x00; // RAM size code: none
  return rom;
}

function makeGb(): GameBoy {
  return new GameBoy(makeStubRom(), null, { skipLogoCheck: true });
}

describe("GameBoy — top-level facade", () => {
  it("seeds PC at the post-boot DMG entry point (0x0100)", () => {
    const gb = makeGb();
    expect(gb.cpu.regs.pc).toBe(0x0100);
  });

  it("seeds SP at 0xFFFE (top of HRAM, post-boot default)", () => {
    const gb = makeGb();
    expect(gb.cpu.regs.sp).toBe(0xfffe);
  });

  it("reads cart bytes through the MMU at 0x0000-0x7FFF", () => {
    const rom = makeStubRom();
    rom[0x0200] = 0xab;
    rom[0x0201] = 0xcd;
    const gb = new GameBoy(rom, null, { skipLogoCheck: true });
    expect(gb.mmu.readByte(0x0200)).toBe(0xab);
    expect(gb.mmu.readByte(0x0201)).toBe(0xcd);
  });

  it("framebuffer accessor returns the PPU's framebuffer (shape-compatible)", () => {
    const gb = makeGb();
    expect(gb.framebuffer).toBe(gb.ppu.framebuffer);
  });

  it("runFrame fires onFrame exactly once with the rendered framebuffer", () => {
    const gb = makeGb();
    let callCount = 0;
    let received: Uint8ClampedArray<ArrayBuffer> | null = null;
    gb.onFrame = (fb) => {
      callCount++;
      received = fb;
    };
    gb.runFrame();
    expect(callCount).toBe(1);
    expect(received).toBe(gb.ppu.framebuffer);
  });

  it("runFrame fires onAudioFrame with the APU's sample buffers", () => {
    const gb = makeGb();
    let count = 0;
    let leftSeen: Float32Array | null = null;
    gb.onAudioFrame = (left, _right, n) => {
      count = n;
      leftSeen = left;
    };
    gb.runFrame();
    // One frame at 59.73 Hz produces ~735 samples at 44.1 kHz; the APU
    // is host-fed so the exact count depends on `apu.sampleRate`, which
    // defaults to 44100. The check is loose — the contract is just
    // "non-empty buffer with N <= buffer length".
    expect(count).toBeGreaterThan(0);
    expect(leftSeen!.length).toBeGreaterThanOrEqual(count);
  });

  it("joypad presses are visible to the cart through P1 (0xFF00)", () => {
    const gb = makeGb();
    // Select the action buttons by clearing bit 5 (P15 low = select).
    gb.mmu.writeByte(0xff00, 0x10);
    expect(gb.mmu.readByte(0xff00) & 0x0f).toBe(0x0f); // nothing pressed
    gb.joypad.press("a");
    gb.joypad.press("start");
    // A = bit 0, START = bit 3. Active-low: pressed bits read as 0.
    expect(gb.mmu.readByte(0xff00) & 0x0f).toBe(0x0f & ~((1 << 0) | (1 << 3)));
    gb.joypad.release("a");
    expect(gb.mmu.readByte(0xff00) & 0x01).toBe(0x01); // A bit back high
  });

  it("CheatManager is wired to the MMU on construction", () => {
    const gb = makeGb();
    expect(gb.mmu.cheats).toBe(gb.cheats);
  });

  it("LCD is on after post-boot init (LCDC = 0x91)", () => {
    const gb = makeGb();
    expect(gb.mmu.readByte(0xff40)).toBe(0x91);
  });
});

describe("GameBoy.saveState / loadState", () => {
  it("blob starts with STATE_VERSION", () => {
    const gb = makeGb();
    const blob = gb.saveState();
    expect(blob[0]).toBe(STATE_VERSION);
    expect(blob.length).toBeGreaterThan(1);
  });

  it("round-trips a fresh boot — identical state-blob across save → load → save", () => {
    const gb = makeGb();
    const blob1 = gb.saveState();
    gb.loadState(blob1);
    const blob2 = gb.saveState();
    expect(blob2.length).toBe(blob1.length);
    for (let i = 0; i < blob1.length; i++) {
      if (blob1[i] !== blob2[i]) {
        throw new Error(`byte ${i} differs after round-trip: ${blob1[i]} vs ${blob2[i]}`);
      }
    }
  });

  it("round-trips after running a few frames — re-load reproduces the same next-frame state", () => {
    const a = makeGb();
    for (let f = 0; f < 3; f++) a.runFrame();

    const snapshot = a.saveState();

    // Run another frame on `a` so the snapshot differs from the
    // current state.
    a.runFrame();
    const aAfter = a.saveState();
    expect(aAfter).not.toEqual(snapshot);

    // A fresh engine that loads the snapshot, then runs one more
    // frame, should land on the same state as `a` after that extra
    // frame.
    const b = makeGb();
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

  it("preserves joypad select-line byte across save/load", () => {
    const gb = makeGb();
    // Select the direction-pad lines (bit 4 low). The pressed-button
    // set is transient input state and isn't part of the snapshot —
    // only the last byte written to 0xFF00 (the select mask) is.
    gb.mmu.writeByte(0xff00, 0x20);
    const blob = gb.saveState();

    const other = makeGb();
    other.loadState(blob);
    // Reading 0xFF00 returns the select bits in the high nibble + the
    // active-low pressed bits in the low nibble. With no buttons held
    // the low nibble is 0xF; the select bits we wrote (0x20) are
    // mirrored back along with the always-set 0xC0 top bits.
    expect(other.mmu.readByte(0xff00) & 0x30).toBe(0x20);
  });

  it("preserves PPU register state across save/load", () => {
    const gb = makeGb();
    gb.mmu.writeByte(0xff40, 0x00); // LCDC = 0 (LCD off, lifts mode-3 VRAM lock)
    gb.mmu.writeByte(0xff42, 0x33); // SCY
    gb.mmu.writeByte(0xff43, 0x55); // SCX
    gb.mmu.writeByte(0xff45, 0x77); // LYC
    gb.mmu.writeByte(0xff47, 0xe4); // BGP — classic 0/1/2/3 mapping
    gb.mmu.writeByte(0xff4a, 0x10); // WY
    gb.mmu.writeByte(0xff4b, 0x20); // WX
    const blob = gb.saveState();

    const other = makeGb();
    other.loadState(blob);
    expect(other.mmu.readByte(0xff40)).toBe(0x00);
    expect(other.mmu.readByte(0xff42)).toBe(0x33);
    expect(other.mmu.readByte(0xff43)).toBe(0x55);
    expect(other.mmu.readByte(0xff45)).toBe(0x77);
    expect(other.mmu.readByte(0xff47)).toBe(0xe4);
    expect(other.mmu.readByte(0xff4a)).toBe(0x10);
    expect(other.mmu.readByte(0xff4b)).toBe(0x20);
  });

  it("preserves WRAM / VRAM / OAM / HRAM bytes across save/load", () => {
    const gb = makeGb();
    // LCD off so VRAM/OAM writes through the MMU aren't gated by the
    // PPU's mode-3 lock.
    gb.mmu.writeByte(0xff40, 0x00);
    gb.mmu.writeByte(0x8000, 0x11); // VRAM
    gb.mmu.writeByte(0x9fff, 0x22); // VRAM tail
    gb.mmu.writeByte(0xc000, 0x33); // WRAM bank 0
    gb.mmu.writeByte(0xdfff, 0x44); // WRAM bank 1 tail
    gb.mmu.writeByte(0xfe00, 0x55); // OAM
    gb.mmu.writeByte(0xfe9f, 0x66); // OAM tail
    gb.mmu.writeByte(0xff80, 0x77); // HRAM
    gb.mmu.writeByte(0xfffe, 0x88); // HRAM tail
    const blob = gb.saveState();

    const other = makeGb();
    other.loadState(blob);
    // Mirror the LCD-off precondition so the reads aren't blocked
    // either — loadState restored LCDC = 0 from the snapshot.
    expect(other.mmu.readByte(0x8000)).toBe(0x11);
    expect(other.mmu.readByte(0x9fff)).toBe(0x22);
    expect(other.mmu.readByte(0xc000)).toBe(0x33);
    expect(other.mmu.readByte(0xdfff)).toBe(0x44);
    expect(other.mmu.readByte(0xfe00)).toBe(0x55);
    expect(other.mmu.readByte(0xfe9f)).toBe(0x66);
    expect(other.mmu.readByte(0xff80)).toBe(0x77);
    expect(other.mmu.readByte(0xfffe)).toBe(0x88);
  });

  it("preserves cart save-RAM bytes across save/load on an MBC1 cart", () => {
    // Type code 0x02 = MBC1 + RAM. 8 KiB RAM at size code 2 — single
    // bank, no bank-switching juggling needed for the test.
    const rom = new Uint8Array(0x8000);
    rom[0x0147] = 0x02;
    rom[0x0148] = 0x00; // 32 KiB ROM
    rom[0x0149] = 0x02; // 8 KiB RAM
    const gb = new GameBoy(rom, null, { skipLogoCheck: true });
    // MBC1 RAM is disabled at boot — enable it by writing 0x0A to the
    // RAM-enable register (any address in 0x0000-0x1FFF).
    gb.mmu.writeByte(0x0000, 0x0a);
    gb.mmu.writeByte(0xa000, 0xab);
    gb.mmu.writeByte(0xbfff, 0xcd);
    const blob = gb.saveState();

    const other = new GameBoy(rom, null, { skipLogoCheck: true });
    other.loadState(blob);
    // RAM-enable bit is part of the MBC1 serialised state, so the
    // restored cart should still expose the RAM region for reads.
    expect(other.mmu.readByte(0xa000)).toBe(0xab);
    expect(other.mmu.readByte(0xbfff)).toBe(0xcd);
  });

  it("rejects a blob with a newer version than the current build", () => {
    const blob = new Uint8Array([STATE_VERSION + 1, 0xff]);
    const gb = makeGb();
    expect(() => gb.loadState(blob)).toThrow(UnsupportedSaveStateError);
  });

  it("rejects an empty blob", () => {
    const gb = makeGb();
    expect(() => gb.loadState(new Uint8Array())).toThrow(UnsupportedSaveStateError);
  });
});
