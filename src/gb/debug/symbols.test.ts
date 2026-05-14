import { beforeEach, describe, expect, it } from "vitest";

import {
  addressFor,
  allSymbols,
  clearSymbols,
  hasSymbols,
  loadSymbols,
  sourceLabel,
  symbolCount,
  symbolFor
} from "./symbols.js";

describe("symbols", () => {
  beforeEach(() => {
    clearSymbols();
  });

  describe("loadSymbols / parsing", () => {
    it("parses simple RGBDS-style lines", () => {
      const n = loadSymbols(
        ["00:0150 EntryPoint", "00:017d InitDisplay", "01:4a8c LoadTilemap"].join("\n"),
        "test.sym"
      );
      expect(n).toBe(3);
      expect(symbolCount()).toBe(3);
      expect(sourceLabel()).toBe("test.sym");
      expect(hasSymbols()).toBe(true);
    });

    it("ignores blank lines and `;` comments", () => {
      const n = loadSymbols(
        ["; banner comment", "", "00:0150 EntryPoint ; inline comment", "   ", "00:0200 Second"].join("\n"),
        "sym"
      );
      expect(n).toBe(2);
      expect(addressFor("EntryPoint")).toEqual({ bank: 0, addr: 0x0150, name: "EntryPoint" });
      expect(addressFor("Second")).toEqual({ bank: 0, addr: 0x0200, name: "Second" });
    });

    it("ignores section headers like `[labels]`", () => {
      const n = loadSymbols(["[labels]", "00:0150 EntryPoint", "[definitions]", "00:0160 Other"].join("\n"), "sym");
      expect(n).toBe(2);
    });

    it("ignores unparseable lines", () => {
      const n = loadSymbols(["random garbage line", "00:0150 EntryPoint", "not:a:sym line"].join("\n"), "sym");
      expect(n).toBe(1);
    });

    it("accepts uppercase hex digits", () => {
      loadSymbols("00:4A8C LoadTilemap", "sym");
      expect(addressFor("LoadTilemap")?.addr).toBe(0x4a8c);
    });

    it("allows dot / underscore in identifiers (RGBDS local labels)", () => {
      const n = loadSymbols(["00:0150 .loop", "00:0160 _helper", "00:0170 Entry.inner"].join("\n"), "sym");
      expect(n).toBe(3);
      expect(addressFor(".loop")?.addr).toBe(0x0150);
      expect(addressFor("_helper")?.addr).toBe(0x0160);
      expect(addressFor("Entry.inner")?.addr).toBe(0x0170);
    });

    it("replaces the previous table on reload", () => {
      loadSymbols("00:0150 OldName", "old.sym");
      expect(addressFor("OldName")).not.toBeNull();
      loadSymbols("00:0200 NewName", "new.sym");
      expect(addressFor("OldName")).toBeNull();
      expect(addressFor("NewName")?.addr).toBe(0x0200);
      expect(sourceLabel()).toBe("new.sym");
    });

    it("last-wins on duplicate addr for byKey; first-wins for byName", () => {
      loadSymbols(
        [
          "00:0150 FirstName",
          "00:0150 SecondName" // same addr, different names
        ].join("\n"),
        "sym"
      );
      // Second line overwrote the byKey entry, so the lookup at that
      // address now returns the later name.
      expect(symbolFor(0x0150, 0)).toBe("SecondName");
      // But byName still has both names — lookup finds the second's
      // entry by its own name, and the first's entry is still mapped
      // (it was added first into byName).
      expect(addressFor("FirstName")).not.toBeNull();
      expect(addressFor("SecondName")).not.toBeNull();
    });
  });

  describe("symbolFor — banked lookup", () => {
    beforeEach(() => {
      loadSymbols(
        [
          "00:0150 EntryPoint", // bank 0 ROM
          "01:4a8c LoadTilemap", // bank 1 ROM
          "03:4a8c Pikachu_Pic", // same addr, bank 3
          "00:c000 WRAM_Start", // WRAM (non-banked by MBC)
          "00:ff44 LCDY" // HRAM / IO
        ].join("\n"),
        "sym"
      );
    });

    it("routes bank-0 ROM addresses to bank 0 regardless of currentBank", () => {
      expect(symbolFor(0x0150, 0)).toBe("EntryPoint");
      expect(symbolFor(0x0150, 5)).toBe("EntryPoint");
    });

    it("routes banked ROM addresses using currentBank", () => {
      expect(symbolFor(0x4a8c, 1)).toBe("LoadTilemap");
      expect(symbolFor(0x4a8c, 3)).toBe("Pikachu_Pic");
    });

    it("returns null when no symbol exists for (addr, bank)", () => {
      expect(symbolFor(0x4a8c, 2)).toBeNull();
      expect(symbolFor(0x9999, 0)).toBeNull();
    });

    it("falls back to bank-agnostic scan for non-ROM addresses >= 0x8000", () => {
      // Even if caller passes bank=7, a WRAM symbol recorded under bank
      // 0 is still found.
      expect(symbolFor(0xc000, 7)).toBe("WRAM_Start");
      expect(symbolFor(0xff44, 7)).toBe("LCDY");
    });

    it("returns null on empty store (fast path)", () => {
      clearSymbols();
      expect(symbolFor(0x0150, 0)).toBeNull();
    });
  });

  describe("addressFor", () => {
    it("returns the bank/addr/name for a known symbol", () => {
      loadSymbols("01:4a8c LoadTilemap", "sym");
      expect(addressFor("LoadTilemap")).toEqual({ bank: 1, addr: 0x4a8c, name: "LoadTilemap" });
    });

    it("is case-sensitive (RGBDS identifiers are)", () => {
      loadSymbols("00:0150 EntryPoint", "sym");
      expect(addressFor("EntryPoint")).not.toBeNull();
      expect(addressFor("entrypoint")).toBeNull();
    });

    it("returns null for an unknown name", () => {
      expect(addressFor("Nope")).toBeNull();
    });
  });

  describe("allSymbols", () => {
    it("returns entries sorted by (bank, addr)", () => {
      loadSymbols(["01:4a8c LoadTilemap", "00:0200 Second", "00:0150 First", "03:4000 Deeper"].join("\n"), "sym");
      const names = allSymbols().map((e) => e.name);
      expect(names).toEqual(["First", "Second", "LoadTilemap", "Deeper"]);
    });

    it("returns an empty array when nothing is loaded", () => {
      expect(allSymbols()).toEqual([]);
    });
  });

  describe("clearSymbols", () => {
    it("wipes store and source label", () => {
      loadSymbols("00:0150 Entry", "sym");
      clearSymbols();
      expect(hasSymbols()).toBe(false);
      expect(symbolCount()).toBe(0);
      expect(sourceLabel()).toBe("");
      expect(allSymbols()).toEqual([]);
    });
  });
});
