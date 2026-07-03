import { describe, expect, it } from "vitest";

import type { Mirroring } from "../cartridge/rom.js";
import { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

const ALL_MIRRORINGS: readonly Mirroring[] = ["horizontal", "vertical", "single-lower", "single-upper", "four-screen"];

function roundTrip(m: Mirroring): { value: Mirroring; byte: number } {
  const w = new NesStateWriter();
  writeMirroring(w, m);
  const bytes = w.finalize();
  const value = readMirroring(new NesStateReader(bytes));
  return { value, byte: bytes[0]! };
}

describe("mirroring save-state encoding", () => {
  it("writes exactly one byte per mirroring", () => {
    for (const m of ALL_MIRRORINGS) {
      const w = new NesStateWriter();
      writeMirroring(w, m);
      expect(w.finalize()).toHaveLength(1);
    }
  });

  it.each(ALL_MIRRORINGS)("round-trips %s", (m) => {
    expect(roundTrip(m).value).toBe(m);
  });

  it("maps each mirroring to a distinct, stable byte (append-only index)", () => {
    // Frozen wire bytes — reordering MIRRORINGS would decode old saves wrong.
    const expectedBytes: Record<Mirroring, number> = {
      horizontal: 0,
      vertical: 1,
      "single-lower": 2,
      "single-upper": 3,
      "four-screen": 4
    };
    const seen = new Set<number>();
    for (const m of ALL_MIRRORINGS) {
      const { byte } = roundTrip(m);
      expect(byte).toBe(expectedBytes[m]);
      expect(seen.has(byte)).toBe(false);
      seen.add(byte);
    }
    expect(seen.size).toBe(ALL_MIRRORINGS.length);
  });

  it("decodes an out-of-range index to horizontal", () => {
    const r = new NesStateReader(Uint8Array.of(0xff));
    expect(readMirroring(r)).toBe("horizontal");
  });

  it("decodes byte 0 to horizontal", () => {
    const r = new NesStateReader(Uint8Array.of(0));
    expect(readMirroring(r)).toBe("horizontal");
  });
});
