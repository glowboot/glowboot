import { describe, expect, it } from "vitest";

import { parseNesRom } from "../cartridge/rom.js";
import { createMapper } from "./mapper.js";

/**
 * Build a minimal iNES image and parse it, with the mapper number split across
 * the flags-6 high nibble (bits 4-7) and the flags-7 high nibble (bits 4-7) the
 * way the iNES header encodes it. CHR ROM is present so CHR-ROM mappers have a
 * bank to point at.
 */
function romForMapper(mapper: number) {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a]);
  header[4] = 2; // 2×16 KiB PRG
  header[5] = 1; // 1×8 KiB CHR ROM
  header[6] = (mapper & 0x0f) << 4; // low nibble in flags6 bits 4-7
  header[7] = mapper & 0xf0; // high nibble in flags7 bits 4-7
  const prg = new Uint8Array(2 * 16 * 1024).fill(0xa5);
  const chr = new Uint8Array(8 * 1024).fill(0x5a);
  const image = new Uint8Array(header.length + prg.length + chr.length);
  image.set(header, 0);
  image.set(prg, header.length);
  image.set(chr, header.length + prg.length);
  const rom = parseNesRom(image);
  // Sanity: the header round-trip must reproduce the requested mapper, otherwise
  // the case below would silently test the wrong routing.
  expect(rom.mapper).toBe(mapper);
  return rom;
}

// Mirrors the switch in createMapper exactly: iNES number → constructor name.
const cases: ReadonlyArray<readonly [number, string]> = [
  [0, "NromMapper"],
  [1, "Mmc1Mapper"],
  [2, "UxromMapper"],
  [3, "CnromMapper"],
  [4, "Mmc3Mapper"],
  [5, "Mmc5Mapper"],
  [7, "AxromMapper"],
  [9, "Mmc2Mapper"],
  [10, "Mmc4Mapper"],
  [11, "ColorDreamsMapper"],
  [13, "CpromMapper"],
  [18, "JalecoSs88006Mapper"],
  [19, "Namco163Mapper"],
  [21, "Vrc24Mapper"],
  [22, "Vrc24Mapper"],
  [23, "Vrc24Mapper"],
  [25, "Vrc24Mapper"],
  [24, "Vrc6Mapper"],
  [26, "Vrc6Mapper"],
  [34, "BnromMapper"],
  [64, "Rambo1Mapper"],
  [65, "IremH3001Mapper"],
  [66, "GxromMapper"],
  [67, "Sunsoft3Mapper"],
  [68, "Sunsoft4Mapper"],
  [69, "Fme7Mapper"],
  [70, "Bandai74Mapper"],
  [71, "CamericaMapper"],
  [73, "Vrc3Mapper"],
  [75, "Vrc1Mapper"],
  [79, "Nina03Mapper"],
  [85, "Vrc7Mapper"],
  [87, "Jaleco87Mapper"],
  [113, "Nina113Mapper"],
  [119, "TqromMapper"],
  [152, "Bandai74Mapper"],
  [185, "Mapper185"],
  [189, "Mapper189"],
  [206, "Mapper206"],
  [210, "Namco210Mapper"],
  [232, "QuattroMapper"],
  [245, "Waixing245Mapper"]
];

describe("createMapper — iNES number routing", () => {
  it.each(cases)("mapper %i → %s", (mapper, expectedClass) => {
    const m = createMapper(romForMapper(mapper));
    expect(m.constructor.name).toBe(expectedClass);
  });

  it("implements the core Mapper interface for every routed mapper", () => {
    for (const [mapper] of cases) {
      const m = createMapper(romForMapper(mapper));
      expect(typeof m.prgRead).toBe("function");
      expect(typeof m.prgWrite).toBe("function");
      expect(typeof m.chrRead).toBe("function");
      expect(typeof m.chrWrite).toBe("function");
      expect(typeof m.mirroring).toBe("function");
      expect(typeof m.serialize).toBe("function");
      expect(typeof m.deserialize).toBe("function");
    }
  });

  it("throws on an unsupported mapper number", () => {
    expect(() => createMapper(romForMapper(99))).toThrow(/unsupported mapper 99/);
  });
});
