import { describe, expect, it } from "vitest";

import { parseNesRom } from "../cartridge/rom.js";
import { Nes } from "../nes.js";
import { decodeCheat } from "./codec.js";
import { type CheatEntry, CheatManager, newCheatId } from "./manager.js";

function entry(code: string, name = "t"): CheatEntry {
  const d = decodeCheat(code)!;
  return {
    id: newCheatId(),
    name,
    code,
    format: d.format,
    enabled: true,
    address: d.address,
    value: d.value,
    ...(d.compare !== undefined ? { compare: d.compare } : {})
  };
}

describe("NES CheatManager", () => {
  it("patches a PRG read and honours the compare byte", () => {
    const m = new CheatManager();
    m.setEntries([entry("9000:99")]);
    expect(m.patchRomRead(0x9000, 0x11)).toBe(0x99);
    expect(m.patchRomRead(0x9001, 0x11)).toBe(0x11); // other address untouched

    m.setEntries([entry("9000:99:11")]); // compare = 0x11
    expect(m.patchRomRead(0x9000, 0x11)).toBe(0x99); // bank matches → patched
    expect(m.patchRomRead(0x9000, 0x22)).toBe(0x22); // bank differs → original
  });

  it("collects RAM freezes and leaves PRG patches out of the RAM map", () => {
    const m = new CheatManager();
    m.setEntries([entry("0010:42"), entry("9000:99")]);
    const writes: [number, number][] = [];
    m.applyRamWrites((a, v) => writes.push([a, v]));
    expect(writes).toEqual([[0x0010, 0x42]]); // only the < $8000 cheat
  });

  it("respects enabled/remove/clear", () => {
    const m = new CheatManager();
    const e = entry("9000:99");
    m.setEntries([e]);
    m.setEnabled(e.id, false);
    expect(m.patchRomRead(0x9000, 0x11)).toBe(0x11);
    m.setEnabled(e.id, true);
    expect(m.patchRomRead(0x9000, 0x11)).toBe(0x99);
    m.remove(e.id);
    expect(m.patchRomRead(0x9000, 0x11)).toBe(0x11);
  });
});

/** NROM image: `LDA $9000; STA $6000; JMP $8000`, with $9000 holding 0x11 and
 *  PRG-RAM at $6000. The CPU's view of $9000 (and what it stores at $6000) is
 *  observable through the public `cartridge.cpuRead($6000)`. */
function probeRom(): Uint8Array {
  const prg = new Uint8Array(0x4000);
  prg.set([0xad, 0x00, 0x90, 0x8d, 0x00, 0x60, 0x4c, 0x00, 0x80], 0);
  prg[0x1000] = 0x11; // value at $9000
  prg[0x3ffc] = 0x00; // reset vector → $8000
  prg[0x3ffd] = 0x80;
  const chr = new Uint8Array(0x2000);
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]);
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set(header, 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}

describe("NES cheats end-to-end", () => {
  it("feeds a Game Genie ROM patch to the running CPU", () => {
    const baseline = new Nes(parseNesRom(probeRom()));
    baseline.runFrame();
    expect(baseline.cartridge.cpuRead(0x6000)).toBe(0x11); // unpatched

    const cheated = new Nes(parseNesRom(probeRom()));
    cheated.cheats.setEntries([entry("9000:99")]);
    cheated.runFrame();
    // The CPU read $9000 as 0x99 and stored it at $6000.
    expect(cheated.cartridge.cpuRead(0x6000)).toBe(0x99);
  });

  it("re-freezes a RAM cheat every frame", () => {
    const nes = new Nes(parseNesRom(probeRom()));
    nes.cheats.setEntries([entry("6000:55")]); // freeze PRG-RAM $6000
    nes.runFrame();
    // The program writes 0x11 to $6000 each loop, but the end-of-frame freeze
    // overrides it.
    expect(nes.cartridge.cpuRead(0x6000)).toBe(0x55);
  });
});
