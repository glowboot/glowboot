import { describe, expect, it } from "vitest";

import { decodeGbaCheat, formatGbaCheat, isNoopGbaCheat } from "./codec.js";

describe("decodeGbaCheat", () => {
  it("decodes an 8-bit code targeting EWRAM", () => {
    expect(decodeGbaCheat("02000000:01")).toEqual({ address: 0x02000000, value: 0x01, width: 8 });
  });

  it("decodes a 16-bit code", () => {
    expect(decodeGbaCheat("030003A4:00FF")).toEqual({ address: 0x030003a4, value: 0x00ff, width: 16 });
  });

  it("decodes a 32-bit code", () => {
    expect(decodeGbaCheat("02000010:DEADBEEF")).toEqual({ address: 0x02000010, value: 0xdeadbeef, width: 32 });
  });

  it("strips dashes, spaces, and 0x prefixes", () => {
    expect(decodeGbaCheat("0x02000000 : 0x01")).toEqual({ address: 0x02000000, value: 0x01, width: 8 });
    expect(decodeGbaCheat("02-00-00-00:0F")).toEqual({ address: 0x02000000, value: 0x0f, width: 8 });
  });

  it("rejects malformed input", () => {
    expect(decodeGbaCheat("")).toBeNull();
    expect(decodeGbaCheat("02000000")).toBeNull(); // missing colon
    expect(decodeGbaCheat("02000000:")).toBeNull(); // missing value
    expect(decodeGbaCheat(":01")).toBeNull(); // missing address
    expect(decodeGbaCheat("02000000:1")).toBeNull(); // odd value width
    expect(decodeGbaCheat("02000000:123")).toBeNull(); // 12-bit value not allowed
    expect(decodeGbaCheat("020000000:01")).toBeNull(); // 9-digit address
  });

  it("rejects non-hex characters", () => {
    expect(decodeGbaCheat("0200000G:01")).toBeNull();
    expect(decodeGbaCheat("02000000:GG")).toBeNull();
  });
});

describe("formatGbaCheat", () => {
  it("zero-pads address and value to canonical width", () => {
    expect(formatGbaCheat({ address: 0x100, value: 0xa, width: 8 })).toBe("00000100:0A");
    expect(formatGbaCheat({ address: 0x02000000, value: 0xff, width: 16 })).toBe("02000000:00FF");
    expect(formatGbaCheat({ address: 0x03000000, value: 1, width: 32 })).toBe("03000000:00000001");
  });

  it("round-trips with decodeGbaCheat", () => {
    for (const raw of ["02000000:01", "030003A4:00FF", "02000010:DEADBEEF"]) {
      const decoded = decodeGbaCheat(raw);
      expect(decoded).not.toBeNull();
      expect(formatGbaCheat(decoded!)).toBe(raw);
    }
  });
});

describe("decodeGbaCheat — CodeBreaker (libretro DB format)", () => {
  // Real codes pulled from libretro's GBA .cht files. Type byte is
  // the top nibble of op1: 3 = ASSIGN_1 (8-bit), 8 = ASSIGN_2 (16-bit),
  // 0 = game ID (decodes to a NOOP placeholder the importer skips).

  it("decodes a type-3 (8-bit write) code from a .cht file", () => {
    // "3200074A+0008" — Infinite Health, NightFire (USA)
    expect(decodeGbaCheat("3200074A+0008")).toEqual({
      address: 0x0200074a,
      value: 0x08,
      width: 8
    });
  });

  it("decodes a type-8 (16-bit write) code", () => {
    // "8201ED74+0FFF" — Have All Weapons, NightFire
    expect(decodeGbaCheat("8201ED74+0FFF")).toEqual({
      address: 0x0201ed74,
      value: 0x0fff,
      width: 16
    });
  });

  it("accepts space separators alongside +", () => {
    expect(decodeGbaCheat("3200074A 0008")).toEqual({
      address: 0x0200074a,
      value: 0x08,
      width: 8
    });
  });

  it("type-0 (game ID / master code) decodes to a no-op the importer skips", () => {
    const noop = decodeGbaCheat("00007358+000A");
    expect(noop).not.toBeNull();
    expect(isNoopGbaCheat(noop!)).toBe(true);
  });

  it("type-1 (hook) also decodes to a no-op — pre-decoded libretro codes don't need the hook", () => {
    // Real Mario Kart Super Circuit (USA) "Enable Code (Must Be On)"
    // master decodes to two CodeBreaker codes: a type-0 game ID and a
    // type-1 hook. For libretro's pre-decrypted codes both are pure
    // metadata; treating them as NOOPs lets the import succeed cleanly
    // without spurious "skipped N codes" warnings.
    const hook = decodeGbaCheat("1002D80A+0007");
    expect(hook).not.toBeNull();
    expect(isNoopGbaCheat(hook!)).toBe(true);
  });

  it("rejects unsupported CodeBreaker types (conditionals / encrypted)", () => {
    // Type 7 = IF_EQ — conditional cheat, not modelled.
    expect(decodeGbaCheat("7200074A+0001")).toBeNull();
    // Type A = IF_NE — another conditional.
    expect(decodeGbaCheat("A200074A+0001")).toBeNull();
  });

  it("decodes real Mario Kart Super Circuit cheats from the libretro DB", () => {
    // Each of these is a single CodeBreaker code from the actual
    // published .cht — exercises the full type-3 + type-8 path with
    // real cart RAM addresses.
    expect(decodeGbaCheat("3300000C+0003")).toEqual({
      // "Infinite Retries"
      address: 0x0300000c,
      value: 0x03,
      width: 8
    });
    expect(decodeGbaCheat("33003D10+0063")).toEqual({
      // "Max Coins"
      address: 0x03003d10,
      value: 0x63,
      width: 8
    });
    expect(decodeGbaCheat("83003D12+1004")).toEqual({
      // "Always Have Blue Shell"
      address: 0x03003d12,
      value: 0x1004,
      width: 16
    });
  });

  it("rejects garbage that's neither raw nor 12-hex-char CodeBreaker", () => {
    expect(decodeGbaCheat("not a cheat")).toBeNull();
    expect(decodeGbaCheat("12345")).toBeNull(); // wrong length
    expect(decodeGbaCheat("ZZZZZZZZ+0000")).toBeNull(); // not hex
  });
});

describe("isNoopGbaCheat", () => {
  it("returns true only for the {0, 0, 8} sentinel", () => {
    expect(isNoopGbaCheat({ address: 0, value: 0, width: 8 })).toBe(true);
    expect(isNoopGbaCheat({ address: 0, value: 0, width: 16 })).toBe(false);
    expect(isNoopGbaCheat({ address: 0, value: 1, width: 8 })).toBe(false);
    expect(isNoopGbaCheat({ address: 1, value: 0, width: 8 })).toBe(false);
  });
});
