import { beforeEach, describe, expect, it } from "vitest";

import { clearAllGbaFrames, frameListGba, notePopGba, notePushGba } from "./call-stack.js";

describe("GBA call-stack tracker", () => {
  beforeEach(() => {
    clearAllGbaFrames();
  });

  it("starts empty", () => {
    expect(frameListGba()).toEqual([]);
  });

  it("push then pop returns the popped frame", () => {
    notePushGba({ callSite: 0x080000c0, returnAddr: 0x080000c4, kind: "call" });
    expect(frameListGba()).toHaveLength(1);
    const popped = notePopGba();
    expect(popped).toEqual({ callSite: 0x080000c0, returnAddr: 0x080000c4, kind: "call" });
    expect(frameListGba()).toEqual([]);
  });

  it("pop on an empty stack returns null", () => {
    expect(notePopGba()).toBeNull();
  });

  it("preserves push order (LIFO)", () => {
    notePushGba({ callSite: 0x080000c0, returnAddr: 0x080000c4, kind: "call" });
    notePushGba({ callSite: 0x08001000, returnAddr: 0x08001004, kind: "call" });
    notePushGba({ callSite: 0x03007ffc, returnAddr: 0x080000c8, kind: "irq" });
    const list = frameListGba();
    expect(list).toHaveLength(3);
    expect(list[0]!.callSite).toBe(0x080000c0);
    expect(list[1]!.callSite).toBe(0x08001000);
    expect(list[2]!.callSite).toBe(0x03007ffc);
    // Pop goes in reverse order.
    expect(notePopGba()!.kind).toBe("irq");
    expect(notePopGba()!.callSite).toBe(0x08001000);
    expect(notePopGba()!.callSite).toBe(0x080000c0);
  });

  it("records the two kinds (call, irq)", () => {
    notePushGba({ callSite: 0x080000c0, returnAddr: 0x080000c4, kind: "call" });
    notePushGba({ callSite: 0x08000018, returnAddr: 0x080000c8, kind: "irq" });
    const kinds = frameListGba().map((f) => f.kind);
    expect(kinds).toEqual(["call", "irq"]);
  });

  it("caps depth at 256 frames by shifting out the oldest push", () => {
    for (let i = 0; i < 300; i++) {
      notePushGba({ callSite: 0x08000000 + i * 4, returnAddr: 0x08000000 + i * 4 + 4, kind: "call" });
    }
    const list = frameListGba();
    expect(list).toHaveLength(256);
    // Innermost (top) frame is the most recent push (i=299).
    expect(list[list.length - 1]!.callSite).toBe(0x08000000 + 299 * 4);
    // Oldest surviving entry is i = 300 - 256 = 44.
    expect(list[0]!.callSite).toBe(0x08000000 + 44 * 4);
  });

  it("clearAllGbaFrames wipes every frame", () => {
    notePushGba({ callSite: 0x080000c0, returnAddr: 0x080000c4, kind: "call" });
    notePushGba({ callSite: 0x08001000, returnAddr: 0x08001004, kind: "call" });
    clearAllGbaFrames();
    expect(frameListGba()).toEqual([]);
    expect(notePopGba()).toBeNull();
  });
});
