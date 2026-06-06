import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { GbaCheatManager, newGbaCheatId } from "./manager.js";

function freshMap() {
  return makeGbaMemoryMap(0x10000, { type: "none", size: 0 });
}

describe("GbaCheatManager", () => {
  it("applies enabled 8-bit writes to EWRAM each frame", () => {
    const map = freshMap();
    const mgr = new GbaCheatManager();
    mgr.add({
      id: newGbaCheatId(),
      name: "8-bit",
      code: "02000000:42",
      enabled: true,
      address: 0x02000000,
      value: 0x42,
      width: 8
    });
    map.bus.write8(0x02000000, 0); // game reset value
    mgr.apply(map.bus);
    expect(map.bus.read8(0x02000000)).toBe(0x42);
  });

  it("16-bit and 32-bit writes hit consecutive bytes", () => {
    const map = freshMap();
    const mgr = new GbaCheatManager();
    mgr.add({
      id: newGbaCheatId(),
      name: "16-bit",
      code: "03000000:1234",
      enabled: true,
      address: 0x03000000,
      value: 0x1234,
      width: 16
    });
    mgr.add({
      id: newGbaCheatId(),
      name: "32-bit",
      code: "03000010:DEADBEEF",
      enabled: true,
      address: 0x03000010,
      value: 0xdeadbeef,
      width: 32
    });
    mgr.apply(map.bus);
    expect(map.bus.read16(0x03000000)).toBe(0x1234);
    expect(map.bus.read32(0x03000010) >>> 0).toBe(0xdeadbeef);
  });

  it("skips disabled entries", () => {
    const map = freshMap();
    const mgr = new GbaCheatManager();
    mgr.add({
      id: newGbaCheatId(),
      name: "off",
      code: "02000000:42",
      enabled: false,
      address: 0x02000000,
      value: 0x42,
      width: 8
    });
    map.bus.write8(0x02000000, 0);
    mgr.apply(map.bus);
    expect(map.bus.read8(0x02000000)).toBe(0);
  });

  it("setEnabled rebuilds the active list", () => {
    const map = freshMap();
    const mgr = new GbaCheatManager();
    const id = newGbaCheatId();
    mgr.add({
      id,
      name: "toggle",
      code: "02000000:42",
      enabled: false,
      address: 0x02000000,
      value: 0x42,
      width: 8
    });
    mgr.apply(map.bus);
    expect(map.bus.read8(0x02000000)).toBe(0);
    mgr.setEnabled(id, true);
    mgr.apply(map.bus);
    expect(map.bus.read8(0x02000000)).toBe(0x42);
  });

  it("remove drops the entry", () => {
    const mgr = new GbaCheatManager();
    const id = newGbaCheatId();
    mgr.add({
      id,
      name: "x",
      code: "02000000:42",
      enabled: true,
      address: 0x02000000,
      value: 0x42,
      width: 8
    });
    expect(mgr.entries).toHaveLength(1);
    mgr.remove(id);
    expect(mgr.entries).toHaveLength(0);
  });

  it("setEntries replaces the whole list", () => {
    const mgr = new GbaCheatManager();
    mgr.add({
      id: newGbaCheatId(),
      name: "a",
      code: "02000000:01",
      enabled: true,
      address: 0x02000000,
      value: 0x01,
      width: 8
    });
    mgr.setEntries([
      {
        id: newGbaCheatId(),
        name: "b",
        code: "02000004:02",
        enabled: true,
        address: 0x02000004,
        value: 0x02,
        width: 8
      }
    ]);
    expect(mgr.entries).toHaveLength(1);
    expect(mgr.entries[0]!.name).toBe("b");
  });
});
