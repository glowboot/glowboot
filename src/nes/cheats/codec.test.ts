import { describe, expect, it } from "vitest";

import { decodeCheat, formatCode } from "./codec.js";

describe("NES cheat codec", () => {
  describe("Game Genie (letter codes)", () => {
    it("decodes the documented SMB code SXIOPO → $91D9 / $AD", () => {
      expect(decodeCheat("SXIOPO")).toEqual({ format: "game-genie", address: 0x91d9, value: 0xad });
    });

    it("ignores case, spaces, and dashes", () => {
      expect(decodeCheat("  sx-io-po ")).toEqual({
        format: "game-genie",
        address: 0x91d9,
        value: 0xad
      });
    });

    it("decodes the all-A code to the base of ROM with zero value", () => {
      expect(decodeCheat("AAAAAA")).toEqual({ format: "game-genie", address: 0x8000, value: 0x00 });
      expect(decodeCheat("AAAAAAAA")).toEqual({
        format: "game-genie",
        address: 0x8000,
        value: 0x00,
        compare: 0x00
      });
    });

    it("routes the value nibbles to the right bits", () => {
      // First letter carries value bits 0-2 + bit 7; second carries bits 4-6.
      expect(decodeCheat("PAAAAA")?.value).toBe(0x01);
      expect(decodeCheat("APAAAA")?.value).toBe(0x10);
    });

    it("produces an address in $8000-$FFFF and a compare for 8-letter codes", () => {
      const d = decodeCheat("ZEXPYGLA");
      expect(d).not.toBeNull();
      expect(d!.format).toBe("game-genie");
      expect(d!.address).toBeGreaterThanOrEqual(0x8000);
      expect(d!.compare).toBeTypeOf("number");
    });

    it("rejects codes with letters outside the alphabet or a bad length", () => {
      expect(decodeCheat("HELLO!")).toBeNull(); // H/B/etc. not in the alphabet
      expect(decodeCheat("SXIOP")).toBeNull(); // 5 letters
      expect(decodeCheat("SXIOPOX")).toBeNull(); // 7 letters
      expect(decodeCheat("")).toBeNull();
    });
  });

  describe("raw codes", () => {
    it("treats a $8000+ raw code as a ROM patch matching the Game Genie decode", () => {
      expect(decodeCheat("91D9:AD")).toEqual({
        format: "game-genie",
        address: 0x91d9,
        value: 0xad
      });
    });

    it("treats a low-address raw code as a RAM freeze", () => {
      expect(decodeCheat("0420:FF")).toEqual({ format: "game-shark", address: 0x0420, value: 0xff });
    });

    it("parses an optional compare byte", () => {
      expect(decodeCheat("91D9:AD:0C")).toEqual({
        format: "game-genie",
        address: 0x91d9,
        value: 0xad,
        compare: 0x0c
      });
    });

    it("rejects malformed raw codes", () => {
      expect(decodeCheat("ZZ:99")).toBeNull(); // address too short
      expect(decodeCheat("1234:9")).toBeNull(); // value not two digits
    });
  });

  describe("formatCode", () => {
    it("upper-cases and strips separators", () => {
      expect(formatCode(" sx-io-po ")).toBe("SXIOPO");
      expect(formatCode("91d9:ad")).toBe("91D9:AD");
    });
  });
});
