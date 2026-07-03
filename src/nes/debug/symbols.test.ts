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

beforeEach(() => clearSymbols());

describe("symbol loader", () => {
  it("parses the plain `AAAA name` form", () => {
    const n = loadSymbols("0300 player_x\n8000 reset\n", "test.sym");
    expect(n).toBe(2);
    expect(symbolFor(0x0300)).toBe("player_x");
    expect(symbolFor(0x8000)).toBe("reset");
    expect(symbolFor(0x0301)).toBeNull();
  });

  it("parses `$AAAA name` and `.nl` `$AAAA#name#comment`", () => {
    loadSymbols("$00 temp\n$C123#nmi_handler#fires each vblank\n", "x");
    expect(symbolFor(0x00)).toBe("temp");
    expect(symbolFor(0xc123)).toBe("nmi_handler");
  });

  it("ignores blank lines, comments, and unparseable lines", () => {
    const n = loadSymbols("; a banner\n\n[symbols]\nnot a symbol line\n0010 score\n", "x");
    expect(n).toBe(1);
    expect(symbolFor(0x10)).toBe("score");
  });

  it("reverse lookup resolves a name to its entry (first wins)", () => {
    loadSymbols("0200 sprite\n0300 sprite\n", "x");
    expect(addressFor("sprite")).toEqual({ addr: 0x0200, name: "sprite" });
    expect(addressFor("missing")).toBeNull();
  });

  it("last write wins for a duplicated address", () => {
    loadSymbols("0400 first\n0400 second\n", "x");
    expect(symbolFor(0x0400)).toBe("second");
  });

  it("tracks count, source label, and clears", () => {
    loadSymbols("0010 a\n0020 b\n", "game.nl");
    expect(hasSymbols()).toBe(true);
    expect(symbolCount()).toBe(2);
    expect(sourceLabel()).toBe("game.nl");
    expect(allSymbols().map((s) => s.addr)).toEqual([0x10, 0x20]);
    clearSymbols();
    expect(hasSymbols()).toBe(false);
    expect(symbolFor(0x10)).toBeNull();
  });
});
