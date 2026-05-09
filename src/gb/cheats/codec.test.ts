import { describe, expect, it } from "vitest";

import { decodeCheat, formatCode } from "./codec.js";

describe("decodeCheat", () => {
  describe("Game Genie (9-digit)", () => {
    it("decodes a canonical 9-digit code with a compare byte", () => {
      // 00A-17B-C49, applying the documented bit layout:
      //   value   = d[0..1] = 0x00
      //   address = ((d[5]<<12)|(d[2]<<8)|(d[3]<<4)|d[4]) ^ 0xF000
      //           = 0xBA17 ^ 0xF000 = 0x4A17
      //   compare = ror8(0xC9, 2) ^ 0xBA = 0x72 ^ 0xBA = 0xC8
      const r = decodeCheat("00A-17B-C49");
      expect(r).not.toBeNull();
      expect(r!.format).toBe("game-genie");
      expect(r!.address).toBe(0x4a17);
      expect(r!.value).toBe(0x00);
      expect(r!.compare).toBe(0xc8);
    });

    it("accepts the same code without dashes or with mixed case", () => {
      const a = decodeCheat("00A-17B-C49");
      const b = decodeCheat("00a17bc49");
      const c = decodeCheat("00A 17B C49");
      expect(a).toEqual(b);
      expect(a).toEqual(c);
    });
  });

  describe("Game Genie (6-digit)", () => {
    it("decodes a 6-digit code without compare byte", () => {
      const r = decodeCheat("00A-17B");
      expect(r).not.toBeNull();
      expect(r!.format).toBe("game-genie");
      expect(r!.address).toBe(0x4a17);
      expect(r!.value).toBe(0x00);
      expect(r!.compare).toBeUndefined();
    });

    it("rejects an address outside the ROM range ($8000+)", () => {
      // `000-000` decodes to address 0xF000 (XOR shifts all-zero nibbles to
      // 0xF000), which is WRAM — out of range for Game Genie (ROM patches only).
      expect(decodeCheat("000-000")).toBeNull();
    });
  });

  describe("Game Shark (8-digit)", () => {
    it("decodes a standard 8-bit write", () => {
      // 01-7F-00-D0: type 0x01, value 0x7F, address bytes 0x00 (lo) 0xD0 (hi)
      // → 0xD000 (WRAM). The last four hex chars store the address
      // little-endian so low-byte-first is the memory location.
      const r = decodeCheat("017F00D0");
      expect(r).not.toBeNull();
      expect(r!.format).toBe("game-shark");
      expect(r!.type).toBe(0x01);
      expect(r!.value).toBe(0x7f);
      expect(r!.address).toBe(0xd000);
    });

    it("reads the address as little-endian (low byte first)", () => {
      // 01-FF-34-12 → low=0x34, high=0x12, address=0x1234 (NOT 0x3412).
      const r = decodeCheat("01FF3412");
      expect(r!.address).toBe(0x1234);
    });
  });

  describe("malformed input", () => {
    it.each([
      ["empty string", ""],
      ["too short", "ABC"],
      ["7 digits (between GG and GS lengths)", "0102030"],
      ["10 digits", "0102030405"],
      ["non-hex characters", "GGG-HHH-III"]
    ])("returns null for %s", (_name, code) => {
      expect(decodeCheat(code)).toBeNull();
    });
  });
});

describe("formatCode", () => {
  it("dashes a 9-digit Game Genie code into 3-3-3 groups", () => {
    expect(formatCode("00a17bc49")).toBe("00A-17B-C49");
  });

  it("dashes a 6-digit Game Genie code into 3-3 groups", () => {
    expect(formatCode("00a17b")).toBe("00A-17B");
  });

  it("leaves an 8-digit Game Shark code unformatted (but capitalised)", () => {
    expect(formatCode("01ff3412")).toBe("01FF3412");
  });

  it("strips whitespace and dashes before reformatting", () => {
    expect(formatCode("00a - 17b - c49")).toBe("00A-17B-C49");
  });
});
