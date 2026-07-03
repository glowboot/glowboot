import { describe, expect, it } from "vitest";

import { parseNesRom } from "../cartridge/rom.js";
import { Nes } from "../nes.js";
import { NES_STATE_VERSION } from "./serialization.js";

/** A minimal NROM image whose reset routine continuously pokes evolving values
 *  into the PPU scroll/address latch, an APU register, and zero-page RAM — so
 *  the machine state genuinely diverges frame to frame. A field left out of the
 *  serializer then shows up as a save-blob mismatch in the determinism test. */
function syntheticRom(): Uint8Array {
  const prg = new Uint8Array(0x4000);
  // prettier-ignore
  const code = [
    0x78,             // SEI
    0xa2, 0x00,       // LDX #$00
    // loop ($8003):
    0xe8,             // INX
    0x86, 0x00,       // STX $00
    0x8e, 0x05, 0x20, // STX $2005  (scroll latch — toggles w, sets t/fineX)
    0x8e, 0x00, 0x40, // STX $4000  (APU pulse1 control)
    0x8e, 0x06, 0x20, // STX $2006  (address latch)
    0x4c, 0x03, 0x80  // JMP $8003
  ];
  prg.set(code, 0);
  prg[0x20] = 0x40; // RTI at $8020, target of the NMI/IRQ vectors
  // PRG is mirrored into $C000-$FFFF, so offset $3FFx holds the $FFFx vectors.
  prg[0x3ffa] = 0x20; // NMI  → $8020
  prg[0x3ffb] = 0x80;
  prg[0x3ffc] = 0x00; // RESET → $8000
  prg[0x3ffd] = 0x80;
  prg[0x3ffe] = 0x20; // IRQ  → $8020
  prg[0x3fff] = 0x80;

  const chr = new Uint8Array(0x2000);
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}

function runFrames(nes: Nes, n: number): void {
  for (let i = 0; i < n; i++) nes.runFrame();
}

describe("NES save states", () => {
  it("prefixes the blob with the current state version", () => {
    const nes = new Nes(parseNesRom(syntheticRom()));
    runFrames(nes, 3);
    expect(nes.saveState()[0]).toBe(NES_STATE_VERSION);
  });

  it("captures enough state for deterministic continuation", () => {
    const romBytes = syntheticRom();

    // Original: run 10 frames, snapshot, then run 10 more and snapshot again.
    const a = new Nes(parseNesRom(romBytes));
    runFrames(a, 10);
    const snapshot = a.saveState();
    runFrames(a, 10);
    const continued = a.saveState();

    // Fresh machine driven out of sync first, then loaded from the snapshot and
    // advanced the same 10 frames — its state must match the original's.
    const b = new Nes(parseNesRom(romBytes));
    runFrames(b, 3);
    b.loadState(snapshot);
    runFrames(b, 10);

    expect(b.saveState()).toEqual(continued);
  });

  it("rejects a save state newer than this build", () => {
    const nes = new Nes(parseNesRom(syntheticRom()));
    const blob = nes.saveState();
    blob[0] = NES_STATE_VERSION + 1;
    expect(() => nes.loadState(blob)).toThrow();
  });
});

/** Every mapper number `createMapper` dispatches. Each gets a symmetry check so
 *  no per-mapper serializer can silently mismatch its reader's field order/width. */
const SUPPORTED_MAPPERS = [
  0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 13, 18, 19, 21, 22, 23, 24, 25, 26, 34, 64, 65, 66, 67, 68, 69, 70, 71, 73, 75, 79,
  85, 87, 113, 119, 152, 185, 189, 206, 210, 232, 245
];

/** A 32 KiB-PRG / CHR-RAM image tagged for `mapper` (iNES number split across
 *  flags6/flags7), with valid reset/IRQ vectors and a harmless reset loop. */
function mapperRom(mapper: number): Uint8Array {
  const prg = new Uint8Array(0x8000);
  prg.set([0x78, 0x4c, 0x00, 0x80], 0); // SEI; JMP $8000
  for (const off of [0x7ffa, 0x7ffc, 0x7ffe]) {
    prg[off] = 0x00;
    prg[off + 1] = 0x80; // vectors → $8000
  }
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 0], 0); // 2×16 KiB PRG, 0 CHR ⇒ CHR-RAM
  header[6] = (mapper & 0x0f) << 4;
  header[7] = mapper & 0xf0;
  const rom = new Uint8Array(16 + prg.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  return rom;
}

/** Drive a mapper's registers, PRG-RAM, and CHR-RAM into a non-default state
 *  with a deterministic pseudo-random sequence, then advance a few frames so
 *  scanline/CPU-cycle IRQ counters move. */
function exercise(nes: Nes): void {
  let seed = 0x1234;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) & 0xff;
  };
  const cart = nes.cartridge;
  for (let addr = 0x4020; addr <= 0xffff; addr += 0x13) cart.cpuWrite(addr, next());
  for (let addr = 0x0000; addr <= 0x1fff; addr += 0x07) cart.ppuWrite(addr, next());
  for (let f = 0; f < 3; f++) nes.runFrame();
}

describe.each(SUPPORTED_MAPPERS)("mapper %i save-state symmetry", (mapper) => {
  it("round-trips its state byte-for-byte", () => {
    const rom = mapperRom(mapper);
    const a = new Nes(parseNesRom(rom));
    exercise(a);
    const blob = a.saveState();

    // Restoring into a fresh machine and re-serializing must reproduce the blob
    // exactly — any serialize/deserialize order or width mismatch shows here.
    const b = new Nes(parseNesRom(rom));
    b.loadState(blob);
    expect(b.saveState()).toEqual(blob);
  });
});
