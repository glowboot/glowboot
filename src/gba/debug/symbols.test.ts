import { beforeEach, describe, expect, it } from "vitest";

import {
  allGbaSymbols,
  clearGbaSymbols,
  gbaAddressFor,
  gbaSymbolCount,
  gbaSymbolFor,
  gbaSymbolSourceLabel,
  hasGbaSymbols,
  loadGbaSymbols
} from "./symbols.js";

describe("GBA symbols", () => {
  beforeEach(() => {
    clearGbaSymbols();
  });

  describe("loadGbaSymbols / parsing", () => {
    it("parses simple `AAAAAAAA NAME` lines (nm / .sym style)", () => {
      const n = loadGbaSymbols(["08000000 cart_entry", "080000c0 main", "03007ff0 stack_top"].join("\n"), "test.sym");
      expect(n).toBe(3);
      expect(gbaSymbolCount()).toBe(3);
      expect(gbaSymbolSourceLabel()).toBe("test.sym");
      expect(hasGbaSymbols()).toBe(true);
    });

    it("accepts `0x`-prefixed addresses (gcc map / build-log style)", () => {
      const n = loadGbaSymbols(["0x08000000 cart_entry", "0x080000C0 main"].join("\n"), "build.map");
      expect(n).toBe(2);
      expect(gbaAddressFor("main")?.addr).toBe(0x080000c0);
    });

    it("accepts `$`-prefixed addresses (assembly listing style)", () => {
      const n = loadGbaSymbols("$08000000 cart_entry", "asm.lst");
      expect(n).toBe(1);
      expect(gbaAddressFor("cart_entry")?.addr).toBe(0x08000000);
    });

    it("accepts optional trailing colon after the address", () => {
      const n = loadGbaSymbols("08000000: cart_entry", "sym");
      expect(n).toBe(1);
      expect(gbaAddressFor("cart_entry")?.addr).toBe(0x08000000);
    });

    it("ignores blank lines and `;` comments", () => {
      const n = loadGbaSymbols(
        ["; banner comment", "", "08000000 cart_entry ; inline comment", "   ", "080000c0 main"].join("\n"),
        "sym"
      );
      expect(n).toBe(2);
      expect(gbaAddressFor("cart_entry")?.addr).toBe(0x08000000);
      expect(gbaAddressFor("main")?.addr).toBe(0x080000c0);
    });

    it("ignores section headers like `[symbols]`", () => {
      const n = loadGbaSymbols(
        ["[symbols]", "08000000 cart_entry", "[definitions]", "080000c0 main"].join("\n"),
        "sym"
      );
      expect(n).toBe(2);
    });

    it("ignores unparseable lines", () => {
      const n = loadGbaSymbols(["random garbage line", "08000000 cart_entry", "not:a:sym line"].join("\n"), "sym");
      expect(n).toBe(1);
    });

    it("accepts mixed-case hex digits", () => {
      loadGbaSymbols("08000c0F LoadTilemap", "sym");
      expect(gbaAddressFor("LoadTilemap")?.addr).toBe(0x08000c0f);
    });

    it("allows dot / underscore in identifiers", () => {
      const n = loadGbaSymbols(["08000000 .loop", "080000c0 _helper", "08001000 Entry.inner"].join("\n"), "sym");
      expect(n).toBe(3);
      expect(gbaAddressFor(".loop")?.addr).toBe(0x08000000);
      expect(gbaAddressFor("_helper")?.addr).toBe(0x080000c0);
      expect(gbaAddressFor("Entry.inner")?.addr).toBe(0x08001000);
    });

    it("replaces the previous table on reload", () => {
      loadGbaSymbols("08000000 OldName", "old.sym");
      expect(gbaAddressFor("OldName")).not.toBeNull();
      loadGbaSymbols("08000200 NewName", "new.sym");
      expect(gbaAddressFor("OldName")).toBeNull();
      expect(gbaAddressFor("NewName")?.addr).toBe(0x08000200);
      expect(gbaSymbolSourceLabel()).toBe("new.sym");
    });

    it("last-wins on duplicate addr for byAddr; first-wins for byName", () => {
      loadGbaSymbols(
        [
          "08000150 FirstName",
          "08000150 SecondName" // same addr, different name
        ].join("\n"),
        "sym"
      );
      // Second line overwrote the byAddr entry; lookup returns the latest name.
      expect(gbaSymbolFor(0x08000150)).toBe("SecondName");
      // byName still has both — each lookup finds its own entry.
      expect(gbaAddressFor("FirstName")).not.toBeNull();
      expect(gbaAddressFor("SecondName")).not.toBeNull();
    });
  });

  describe("gbaSymbolFor — lookup", () => {
    beforeEach(() => {
      loadGbaSymbols(
        [
          "08000000 cart_entry", // ROM start
          "080000c0 main", // ROM
          "02000000 ewram_start", // EWRAM
          "03000000 iwram_start", // IWRAM
          "04000000 reg_dispcnt" // I/O
        ].join("\n"),
        "sym"
      );
    });

    it("resolves known addresses", () => {
      expect(gbaSymbolFor(0x08000000)).toBe("cart_entry");
      expect(gbaSymbolFor(0x080000c0)).toBe("main");
      expect(gbaSymbolFor(0x02000000)).toBe("ewram_start");
      expect(gbaSymbolFor(0x03000000)).toBe("iwram_start");
      expect(gbaSymbolFor(0x04000000)).toBe("reg_dispcnt");
    });

    it("returns null when no symbol exists at the address", () => {
      expect(gbaSymbolFor(0x08000004)).toBeNull();
      expect(gbaSymbolFor(0x09999999)).toBeNull();
    });

    it("normalises signed addresses to unsigned uint32", () => {
      // gbaSymbolFor's caller might pass a negative number from the
      // engine; the registry's `>>> 0` keeps the lookup consistent.
      loadGbaSymbols("ffffffff at_end", "sym");
      expect(gbaSymbolFor(-1)).toBe("at_end");
    });

    it("returns null on empty store (fast path)", () => {
      clearGbaSymbols();
      expect(gbaSymbolFor(0x08000000)).toBeNull();
    });
  });

  describe("gbaAddressFor", () => {
    it("returns the entry for a known symbol", () => {
      loadGbaSymbols("080000c0 main", "sym");
      expect(gbaAddressFor("main")).toEqual({ addr: 0x080000c0, name: "main" });
    });

    it("is case-sensitive", () => {
      loadGbaSymbols("08000000 cart_entry", "sym");
      expect(gbaAddressFor("cart_entry")).not.toBeNull();
      expect(gbaAddressFor("CART_ENTRY")).toBeNull();
    });

    it("returns null for an unknown name", () => {
      expect(gbaAddressFor("Nope")).toBeNull();
    });
  });

  describe("allGbaSymbols", () => {
    it("returns entries sorted by address ascending", () => {
      loadGbaSymbols(["080000c0 main", "08000200 second", "08000000 first", "03000000 iwram_var"].join("\n"), "sym");
      const names = allGbaSymbols().map((e) => e.name);
      expect(names).toEqual(["iwram_var", "first", "main", "second"]);
    });

    it("returns an empty array when nothing is loaded", () => {
      expect(allGbaSymbols()).toEqual([]);
    });
  });

  describe("clearGbaSymbols", () => {
    it("wipes store and source label", () => {
      loadGbaSymbols("08000000 cart_entry", "sym");
      clearGbaSymbols();
      expect(hasGbaSymbols()).toBe(false);
      expect(gbaSymbolCount()).toBe(0);
      expect(gbaSymbolSourceLabel()).toBe("");
      expect(allGbaSymbols()).toEqual([]);
    });
  });
});
