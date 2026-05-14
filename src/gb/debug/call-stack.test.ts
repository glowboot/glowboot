import { beforeEach, describe, expect, it } from "vitest";

import { clear, frameList, notePop, notePush } from "./call-stack.js";

describe("call-stack tracker", () => {
  beforeEach(() => {
    clear();
  });

  it("starts empty", () => {
    expect(frameList()).toEqual([]);
  });

  it("push then pop returns the popped frame", () => {
    notePush({ callSite: 0x0150, returnAddr: 0x0153, kind: "call" });
    expect(frameList()).toHaveLength(1);
    const popped = notePop();
    expect(popped).toEqual({ callSite: 0x0150, returnAddr: 0x0153, kind: "call" });
    expect(frameList()).toEqual([]);
  });

  it("pop on an empty stack returns null", () => {
    expect(notePop()).toBeNull();
  });

  it("preserves push order (LIFO)", () => {
    notePush({ callSite: 0x0150, returnAddr: 0x0153, kind: "call" });
    notePush({ callSite: 0x4000, returnAddr: 0x4003, kind: "call" });
    notePush({ callSite: 0x0040, returnAddr: 0x0040, kind: "irq" });
    const list = frameList();
    expect(list).toHaveLength(3);
    expect(list[0]!.callSite).toBe(0x0150);
    expect(list[1]!.callSite).toBe(0x4000);
    expect(list[2]!.callSite).toBe(0x0040);
    // Pop goes in reverse order.
    expect(notePop()!.kind).toBe("irq");
    expect(notePop()!.callSite).toBe(0x4000);
    expect(notePop()!.callSite).toBe(0x0150);
  });

  it("records all three kinds", () => {
    notePush({ callSite: 0x0150, returnAddr: 0x0153, kind: "call" });
    notePush({ callSite: 0x0020, returnAddr: 0x0151, kind: "rst" });
    notePush({ callSite: 0x0040, returnAddr: 0x0151, kind: "irq" });
    const kinds = frameList().map((f) => f.kind);
    expect(kinds).toEqual(["call", "rst", "irq"]);
  });

  it("caps depth at 256 frames by shifting out the oldest push", () => {
    for (let i = 0; i < 300; i++) {
      notePush({ callSite: i, returnAddr: i + 3, kind: "call" });
    }
    const list = frameList();
    expect(list).toHaveLength(256);
    // Innermost (top) frame is the most recent push.
    expect(list[list.length - 1]!.callSite).toBe(299);
    // Oldest surviving entry is 300 - 256 = 44, not 0.
    expect(list[0]!.callSite).toBe(44);
  });

  it("clear wipes every frame", () => {
    notePush({ callSite: 0x0150, returnAddr: 0x0153, kind: "call" });
    notePush({ callSite: 0x4000, returnAddr: 0x4003, kind: "call" });
    clear();
    expect(frameList()).toEqual([]);
    expect(notePop()).toBeNull();
  });
});
