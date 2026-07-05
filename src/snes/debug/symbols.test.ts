import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSnesSymbols,
  hasSnesSymbols,
  loadSnesSymbols,
  snesAddressFor,
  snesSymbolCount,
  snesSymbolFor,
  snesSymbolSourceLabel
} from "./symbols.js";

describe("SNES symbol table", () => {
  beforeEach(() => clearSnesSymbols());

  it("parses bank:offset and flat-hex lines, skipping garbage", () => {
    const n = loadSnesSymbols(
      [
        "80:8000 Reset",
        "$00:816A NmiHandler",
        "0x7e0dbf coin_count",
        "018000: SubRoutine.local",
        "this line is a banner",
        "SIZE 32768 bytes"
      ].join("\n"),
      "test.sym"
    );
    expect(n).toBe(4);
    expect(snesSymbolFor(0x808000)).toBe("Reset");
    expect(snesSymbolFor(0x00816a)).toBe("NmiHandler");
    expect(snesSymbolFor(0x7e0dbf)).toBe("coin_count");
    expect(snesSymbolFor(0x018000)).toBe("SubRoutine.local");
    expect(snesSymbolFor(0x123456)).toBeNull();
    expect(snesSymbolSourceLabel()).toBe("test.sym");
    expect(hasSnesSymbols()).toBe(true);
    expect(snesSymbolCount()).toBe(4);
  });

  it("looks up addresses by name (exact, case-sensitive)", () => {
    loadSnesSymbols("00:816A NmiHandler", "s");
    expect(snesAddressFor("NmiHandler")!.addr).toBe(0x00816a);
    expect(snesAddressFor("nmihandler")).toBeNull();
  });

  it("replaces the table on reload and clears cleanly", () => {
    loadSnesSymbols("00:8000 A", "one");
    loadSnesSymbols("00:9000 B", "two");
    expect(snesSymbolFor(0x008000)).toBeNull(); // old table replaced
    expect(snesSymbolFor(0x009000)).toBe("B");
    clearSnesSymbols();
    expect(hasSnesSymbols()).toBe(false);
    expect(snesSymbolCount()).toBe(0);
  });
});
