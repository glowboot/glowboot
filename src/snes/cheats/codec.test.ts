import { describe, expect, it } from "vitest";

import { decodeCheat, formatCode, isRamAddress } from "./codec.js";

describe("SNES cheat codec", () => {
  it("maps the Game Genie alphabet position to the nibble value", () => {
    // "DDDD-DDDD": every nibble 0 -> value 0, address 0.
    const zero = decodeCheat("DDDD-DDDD");
    expect(zero).toEqual({ format: "game-genie", address: 0, value: 0 });
    // "FDDD-DDDD": first nibble 1 -> value $10.
    expect(decodeCheat("FDDD-DDDD")!.value).toBe(0x10);
    // "EEEE-EEEE": every nibble F.
    const all = decodeCheat("EEEE-EEEE")!;
    expect(all.value).toBe(0xff);
    expect(all.address).toBe(0xffffff);
  });

  it("descrambles the Game Genie address bits per the documented layout", () => {
    // Raw nibbles n2..n7 read as ijkl qrst uvwx abcd efgh mnop;
    // address = abcd efgh ijkl mnop qrst uvwx. Set exactly one nibble to $F
    // (letter E) and check where it lands.
    expect(decodeCheat("DDED-DDDD")!.address).toBe(0x00f000); // n2=ijkl
    expect(decodeCheat("DDDE-DDDD")!.address).toBe(0x0000f0); // n3=qrst
    expect(decodeCheat("DDDD-EDDD")!.address).toBe(0x00000f); // n4=uvwx
    expect(decodeCheat("DDDD-DEDD")!.address).toBe(0xf00000); // n5=abcd
    expect(decodeCheat("DDDD-DDED")!.address).toBe(0x0f0000); // n6=efgh
    expect(decodeCheat("DDDD-DDDE")!.address).toBe(0x000f00); // n7=mnop
  });

  it("decodes raw Pro Action Replay codes", () => {
    expect(decodeCheat("7E004BFF")).toEqual({
      format: "pro-action-replay",
      address: 0x7e004b,
      value: 0xff
    });
    expect(decodeCheat("7e004b:ff")!.value).toBe(0xff);
    expect(decodeCheat("81834AAD")!.address).toBe(0x81834a);
  });

  it("rejects garbage", () => {
    expect(decodeCheat("")).toBeNull();
    expect(decodeCheat("XYZ")).toBeNull();
    expect(decodeCheat("GGGG-GGGG")).toBeNull(); // G not in the alphabet
    expect(decodeCheat("7E004B")).toBeNull(); // missing value byte
  });

  it("classifies WRAM and SRAM as freeze targets, ROM as patches", () => {
    expect(isRamAddress(0x7e004b)).toBe(true); // WRAM
    expect(isRamAddress(0x7f1234)).toBe(true);
    expect(isRamAddress(0x000100)).toBe(true); // WRAM mirror
    expect(isRamAddress(0x700000)).toBe(true); // LoROM SRAM
    expect(isRamAddress(0x306100)).toBe(true); // HiROM SRAM window
    expect(isRamAddress(0x008000)).toBe(false); // ROM
    expect(isRamAddress(0xc01234)).toBe(false); // HiROM ROM
  });

  it("formats codes for display", () => {
    expect(formatCode(" dd64-3b6f ")).toBe("DD64-3B6F");
    expect(formatCode("7e004b:ff")).toBe("7E004BFF");
  });
});
