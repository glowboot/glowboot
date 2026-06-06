import { describe, expect, it } from "vitest";

import { HEADER_LEN, isGbaRom, parseGbaHeader } from "./header.js";

interface BuildRomOpts {
  title?: string;
  gameCode?: string;
  makerCode?: string;
  version?: number;
  fixedByte?: number;
  checksumOverride?: number;
  size?: number;
}

function buildRom(opts: BuildRomOpts = {}): Uint8Array {
  const rom = new Uint8Array(opts.size ?? 0x200);
  const writeAscii = (s: string, offset: number, max: number): void => {
    for (let i = 0; i < Math.min(s.length, max); i++) rom[offset + i] = s.charCodeAt(i);
  };
  writeAscii(opts.title ?? "POKEMON EMER", 0xa0, 12);
  writeAscii(opts.gameCode ?? "BPEE", 0xac, 4);
  writeAscii(opts.makerCode ?? "01", 0xb0, 2);
  rom[0xb2] = opts.fixedByte ?? 0x96;
  rom[0xbc] = opts.version ?? 0;
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum += rom[i] ?? 0;
  rom[0xbd] = opts.checksumOverride ?? -(sum + 0x19) & 0xff;
  return rom;
}

describe("isGbaRom", () => {
  it("returns true for a valid GBA-shaped ROM", () => {
    expect(isGbaRom(buildRom())).toBe(true);
  });

  it("returns false for data smaller than the header", () => {
    expect(isGbaRom(new Uint8Array(HEADER_LEN - 1))).toBe(false);
  });

  it("returns false when the 0xB2 magic byte is wrong", () => {
    expect(isGbaRom(buildRom({ fixedByte: 0x00 }))).toBe(false);
  });
});

describe("parseGbaHeader", () => {
  it("decodes title, game code, maker code, and version", () => {
    const header = parseGbaHeader(buildRom({ version: 0x02 }));
    expect(header.title).toBe("POKEMON EMER");
    expect(header.gameCode).toBe("BPEE");
    expect(header.makerCode).toBe("01");
    expect(header.version).toBe(0x02);
  });

  it("strips trailing NUL padding from the title", () => {
    const header = parseGbaHeader(buildRom({ title: "TETRIS" }));
    expect(header.title).toBe("TETRIS");
  });

  it("validates a correct header checksum", () => {
    const header = parseGbaHeader(buildRom());
    expect(header.headerChecksumValid).toBe(true);
  });

  it("flags an incorrect header checksum", () => {
    const header = parseGbaHeader(buildRom({ checksumOverride: 0x00 }));
    expect(header.headerChecksumValid).toBe(false);
  });

  it("throws when the ROM is too small", () => {
    expect(() => parseGbaHeader(new Uint8Array(HEADER_LEN - 1))).toThrow(/too small/i);
  });

  it("throws when the 0xB2 magic byte is wrong", () => {
    expect(() => parseGbaHeader(buildRom({ fixedByte: 0x00 }))).toThrow(/not a gba rom/i);
  });
});
