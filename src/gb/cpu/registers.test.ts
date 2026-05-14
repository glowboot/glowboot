import { describe, expect, it } from "vitest";

import { StateReader, StateWriter } from "../serialization/serialization.js";
import { FLAG_C, FLAG_H, FLAG_N, FLAG_Z, Registers } from "./registers.js";

describe("Registers", () => {
  describe("post-boot state", () => {
    it("seeds DMG values when cgb=false", () => {
      const r = new Registers(false);
      expect(r.a).toBe(0x01);
      expect(r.f).toBe(0xb0);
      expect(r.bc).toBe(0x0013);
      expect(r.de).toBe(0x00d8);
      expect(r.hl).toBe(0x014d);
      expect(r.sp).toBe(0xfffe);
      expect(r.pc).toBe(0x0100);
    });

    it("seeds CGB values when cgb=true — games detect the console via A", () => {
      const r = new Registers(true);
      expect(r.a).toBe(0x11);
      expect(r.de).toBe(0xff56);
      expect(r.hl).toBe(0x000d);
    });
  });

  describe("16-bit pair accessors", () => {
    it("reads AF with the low nibble of F masked (only upper nibble is real)", () => {
      const r = new Registers();
      r.a = 0xab;
      r.f = 0xff; // low nibble of F is always 0 on real hardware
      expect(r.af).toBe(0xabf0);
    });

    it("write to AF masks F's low nibble on store", () => {
      const r = new Registers();
      r.af = 0x1234; // would set F to 0x34
      expect(r.a).toBe(0x12);
      expect(r.f).toBe(0x30); // low nibble stripped
    });

    it.each<[keyof Registers & ("bc" | "de" | "hl"), keyof Registers, keyof Registers]>([
      ["bc", "b", "c"],
      ["de", "d", "e"],
      ["hl", "h", "l"]
    ])("round-trips %s through its component registers", (pair, hi, lo) => {
      const r = new Registers();
      (r as unknown as Record<string, number>)[pair] = 0xcafe;
      expect(r[hi]).toBe(0xca);
      expect(r[lo]).toBe(0xfe);
    });
  });

  describe("flag helpers", () => {
    it("set/get of individual flags survives masking", () => {
      const r = new Registers();
      r.f = 0;
      r.zf = true;
      expect(r.zf).toBe(true);
      expect(r.f & FLAG_Z).toBe(FLAG_Z);
      r.zf = false;
      expect(r.zf).toBe(false);
    });

    it("setFlag never leaks into the low nibble of F", () => {
      const r = new Registers();
      r.f = 0x0f; // garbage in the unused low nibble
      r.setFlag(FLAG_C, true);
      expect(r.f & 0x0f).toBe(0); // low nibble should be cleared
      expect(r.f & FLAG_C).toBe(FLAG_C);
    });

    it("each flag bit is independent", () => {
      const r = new Registers();
      r.f = 0;
      r.zf = true;
      r.nf = true;
      r.hf = true;
      r.cf = true;
      expect(r.zf && r.nf && r.hf && r.cf).toBe(true);
      r.hf = false;
      expect(r.zf && r.nf && !r.hf && r.cf).toBe(true);
    });
  });

  describe("serialization", () => {
    it("round-trips every register through a StateWriter/Reader", () => {
      const src = new Registers(true);
      src.a = 0x11;
      src.bc = 0x2233;
      src.de = 0x4455;
      src.hl = 0x6677;
      src.f = 0xa0;
      src.sp = 0xfffe;
      src.pc = 0x0100;

      const w = new StateWriter();
      src.serialize(w);
      const dst = new Registers();
      dst.deserialize(new StateReader(w.finalize()));

      expect(dst.a).toBe(0x11);
      expect(dst.bc).toBe(0x2233);
      expect(dst.de).toBe(0x4455);
      expect(dst.hl).toBe(0x6677);
      expect(dst.f).toBe(0xa0);
      expect(dst.sp).toBe(0xfffe);
      expect(dst.pc).toBe(0x0100);
    });
  });

  describe("flag constants", () => {
    it("match the documented bit positions", () => {
      // These are baked into 250+ opcode implementations — a rename here
      // would silently break the whole CPU.
      expect(FLAG_Z).toBe(0x80);
      expect(FLAG_N).toBe(0x40);
      expect(FLAG_H).toBe(0x20);
      expect(FLAG_C).toBe(0x10);
    });
  });
});
