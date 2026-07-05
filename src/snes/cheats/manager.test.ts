import { describe, expect, it } from "vitest";

import { decodeCheat } from "./codec.js";
import { type CheatEntry, CheatManager, newCheatId } from "./manager.js";

function entry(code: string, enabled = true): CheatEntry {
  const d = decodeCheat(code)!;
  return {
    id: newCheatId(),
    name: code,
    code,
    format: d.format,
    enabled,
    address: d.address,
    value: d.value
  };
}

describe("SNES CheatManager", () => {
  it("patches ROM reads for Game Genie codes (normalised banks)", () => {
    // Hand-derived vector: value $AB = letters C,8; address $018000 packs to
    // nibbles n2..n7 = 8,0,0,0,1,0 = letters 6,D,D,D,F,D -> "C86D-DDFD".
    const d = decodeCheat("C86D-DDFD")!;
    expect(d).toEqual({ format: "game-genie", address: 0x018000, value: 0xab });

    const m = new CheatManager();
    m.add(entry("C86D-DDFD"));
    expect(m.patchRomRead(0x018000, 0x12)).toBe(0xab);
    expect(m.patchRomRead(0x018001, 0x12)).toBe(0x12);

    // Raw ROM-range PAR behaves as a patch too, normalised from bank $81.
    const m2 = new CheatManager();
    m2.add(entry("818000CD"));
    expect(m2.patchRomRead(0x018000, 0x12)).toBe(0xcd);
  });

  it("re-applies RAM freezes and honours enable/remove", () => {
    const m = new CheatManager();
    const e = entry("7E004BFF");
    m.add(e);
    const writes: [number, number][] = [];
    m.applyRamWrites((a, v) => writes.push([a, v]));
    expect(writes).toEqual([[0x7e004b, 0xff]]);

    m.setEnabled(e.id, false);
    writes.length = 0;
    m.applyRamWrites((a, v) => writes.push([a, v]));
    expect(writes).toEqual([]);

    m.setEnabled(e.id, true);
    m.remove(e.id);
    m.applyRamWrites((a, v) => writes.push([a, v]));
    expect(writes).toEqual([]);
  });

  it("no-ops on the hot path with no cheats", () => {
    const m = new CheatManager();
    expect(m.patchRomRead(0x008000, 0x42)).toBe(0x42);
  });
});
