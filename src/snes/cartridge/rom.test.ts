import { describe, expect, it } from "vitest";

import { parseSnesRom, UnsupportedSnesRomError } from "./rom.js";

/** Build a synthetic image with a valid internal header at `headerOffset`. */
function image(opts: {
  size: number;
  headerOffset: number;
  mode: number;
  chipset?: number;
  ramExponent?: number;
  country?: number;
  title?: string;
  copierHeader?: boolean;
}): Uint8Array {
  const rom = new Uint8Array(opts.size);
  const h = opts.headerOffset;
  const title = (opts.title ?? "ROUND TRIP TEST").padEnd(21, " ");
  for (let i = 0; i < 21; i++) rom[h + i] = title.charCodeAt(i);
  rom[h + 0x15] = opts.mode;
  rom[h + 0x16] = opts.chipset ?? 0x00;
  rom[h + 0x17] = 0x08; // 256 KiB claimed
  rom[h + 0x18] = opts.ramExponent ?? 0;
  rom[h + 0x19] = opts.country ?? 0x01; // USA
  rom[h + 0x1b] = 0x00; // version
  // Checksum/complement pair — the parser only checks that they XOR to $FFFF.
  rom[h + 0x1c] = 0xaa;
  rom[h + 0x1d] = 0xaa;
  rom[h + 0x1e] = 0x55;
  rom[h + 0x1f] = 0x55;
  // Emulation-mode RESET vector into ROM space.
  rom[h + 0x3c] = 0x00;
  rom[h + 0x3d] = 0x80;
  if (!opts.copierHeader) return rom;
  const smc = new Uint8Array(opts.size + 512);
  smc.set(rom, 512);
  return smc;
}

describe("parseSnesRom", () => {
  it("detects a LoROM header at $7FC0", () => {
    const r = parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20 }));
    expect(r.mapping).toBe("lorom");
    expect(r.fastRom).toBe(false);
    expect(r.title).toBe("ROUND TRIP TEST");
    expect(r.region).toBe("ntsc");
    expect(r.headerOffset).toBe(0x7fc0);
  });

  it("detects a HiROM header at $FFC0 and the FastROM bit", () => {
    const r = parseSnesRom(image({ size: 0x100000, headerOffset: 0xffc0, mode: 0x31 }));
    expect(r.mapping).toBe("hirom");
    expect(r.fastRom).toBe(true);
  });

  it("detects ExHiROM at $40FFC0", () => {
    const r = parseSnesRom(image({ size: 0x600000, headerOffset: 0x40ffc0, mode: 0x25 }));
    expect(r.mapping).toBe("exhirom");
  });

  it("strips a 512-byte copier header before locating the header", () => {
    const r = parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, copierHeader: true }));
    expect(r.mapping).toBe("lorom");
    expect(r.rom.length).toBe(0x40000);
  });

  it("decodes SRAM size, battery, and PAL region", () => {
    const r = parseSnesRom(
      image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0x02, ramExponent: 3, country: 0x09 })
    );
    expect(r.sramSize).toBe(8 * 1024);
    expect(r.battery).toBe(true);
    expect(r.region).toBe("pal");
  });

  it("rejects unsupported coprocessor carts loudly", () => {
    // Chipset high nibble $F is the "custom" bucket (SPC7110 / ST01x), still
    // unemulated.
    expect(() => parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0xf5 }))).toThrowError(
      UnsupportedSnesRomError
    );
    expect(() => parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0xf5 }))).toThrowError(
      /custom/
    );
  });

  it("accepts DSP, SA-1 and SuperFX carts (emulated coprocessors)", () => {
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0x13 })).coprocessor).toBe(
      "superfx"
    );
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0x43 })).coprocessor).toBe(
      "sdd1"
    );
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0xf3 })).coprocessor).toBe(
      "cx4"
    );
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0x23 })).coprocessor).toBe(
      "obc1"
    );
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x23, chipset: 0x33 })).coprocessor).toBe(
      "sa1"
    );
    expect(parseSnesRom(image({ size: 0x40000, headerOffset: 0x7fc0, mode: 0x20, chipset: 0x03 })).coprocessor).toBe(
      "dsp"
    );
  });

  it("rejects files with no plausible internal header", () => {
    const junk = new Uint8Array(0x40000).fill(0x37);
    expect(() => parseSnesRom(junk)).toThrowError(UnsupportedSnesRomError);
  });

  it("accepts a blank-header cart whose reset vector points at a CLC/XCE entry", () => {
    // Unlicensed Wisdom Tree boards (Super Noah's Ark 3D) carry no checksum
    // or title, so header scoring stays below threshold; a reset vector that
    // lands on a native-mode entry ($18 $FB) is the signal it's a real ROM.
    const rom = new Uint8Array(0x100000); // all zeros → blank header
    rom[0xfffc] = 0xb0; // HiROM emulation RESET vector → $FFB0
    rom[0xfffd] = 0xff;
    rom[0xffb0] = 0x18; // CLC
    rom[0xffb1] = 0xfb; // XCE
    const r = parseSnesRom(rom);
    expect(r.mapping).toBe("hirom");
    expect(r.coprocessor).toBeNull();
  });

  it("still rejects a blank-header image whose reset target is not code", () => {
    const rom = new Uint8Array(0x100000);
    rom[0xfffc] = 0x00; // reset $8000 — in range, but the target is all $00
    rom[0xfffd] = 0x80;
    expect(() => parseSnesRom(rom)).toThrowError(/no plausible/);
  });

  it("prefers the better-scoring candidate when both locations hold data", () => {
    // Valid HiROM header; the LoROM offset holds garbage that happens to
    // have printable bytes but no checksum pair or mode byte.
    const img = image({ size: 0x100000, headerOffset: 0xffc0, mode: 0x21 });
    for (let i = 0; i < 32; i++) img[0x7fc0 + i] = 0x41;
    expect(parseSnesRom(img).mapping).toBe("hirom");
  });

  it("overrides a checksum-valid header's mapping when only another mapping reaches boot code", () => {
    // Batman - Revenge of the Joker: HiROM-located header on LoROM wiring.
    // The HiROM header validates but its reset vector lands mid-routine;
    // the LoROM vector at $7FFC reaches a SEI/CLD/CLC/XCE entry.
    const img = image({ size: 0x100000, headerOffset: 0xffc0, mode: 0x31 });
    img[0xfffc] = 0x11; // HiROM reset $8011 → rom[$8011] = junk
    img[0xfffd] = 0x80;
    img[0x7ffc] = 0x00; // LoROM reset $8000 → rom[$0000]
    img[0x7ffd] = 0x80;
    img[0x0000] = 0x78; // SEI
    img[0x0001] = 0xd8; // CLD
    img[0x0002] = 0x18; // CLC
    img[0x0003] = 0xfb; // XCE
    const r = parseSnesRom(img);
    expect(r.mapping).toBe("lorom");
    expect(r.headerOffset).toBe(0xffc0); // metadata stays with the real block
    expect(r.title).toBe("ROUND TRIP TEST");
  });

  it("keeps the header's mapping when its entry jumps before CLC/XCE", () => {
    // Super Shanghai enters via JMP $C116; the target holds the CLC/XCE.
    const img = image({ size: 0x100000, headerOffset: 0x7fc0, mode: 0x20 });
    img[0x7ffc] = 0x03; // reset $C003 → lorom file $4003
    img[0x7ffd] = 0xc0;
    img[0x4003] = 0x4c; // JMP $C116
    img[0x4004] = 0x16;
    img[0x4005] = 0xc1;
    img[0x4116] = 0x18; // CLC
    img[0x4117] = 0xfb; // XCE
    // decoy CLC/XCE reachable under hirom so an (incorrect) override would fire
    img[0xfffc] = 0x00;
    img[0xfffd] = 0x90;
    img[0x9000] = 0x18;
    img[0x9001] = 0xfb;
    expect(parseSnesRom(img).mapping).toBe("lorom");
  });

  it("flags the memory-pak slot board by header title", () => {
    const big = image({ size: 0x300000, headerOffset: 0x7fc0, mode: 0x30, title: "SOUND NOVEL-TCOOL" });
    expect(parseSnesRom(big).extendedHighBanks).toBe(true);
    const plain = image({ size: 0x300000, headerOffset: 0x7fc0, mode: 0x30 });
    expect(parseSnesRom(plain).extendedHighBanks).toBe(false);
  });
});
