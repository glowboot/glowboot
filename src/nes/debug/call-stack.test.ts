import { beforeEach, describe, expect, it } from "vitest";

import { type CallFrame, clear, frameList, notePop, notePush } from "./call-stack.js";

beforeEach(() => clear());

const frame = (callSite: number, returnAddr: number, kind: CallFrame["kind"]): CallFrame => ({
  callSite,
  returnAddr,
  kind
});

describe("call-stack tracker", () => {
  it("pushes and pops frames LIFO", () => {
    notePush(frame(0x8000, 0x8003, "jsr"));
    notePush(frame(0x9000, 0x9003, "jsr"));
    expect(frameList().map((f) => f.callSite)).toEqual([0x8000, 0x9000]);
    const popped = notePop();
    expect(popped).toEqual(frame(0x9000, 0x9003, "jsr"));
    expect(frameList().map((f) => f.callSite)).toEqual([0x8000]);
  });

  it("records the frame kind (jsr / brk / irq / nmi)", () => {
    notePush(frame(0x8000, 0x8003, "jsr"));
    notePush(frame(0xfffa, 0x8003, "nmi"));
    notePush(frame(0xfffe, 0x8003, "irq"));
    expect(frameList().map((f) => f.kind)).toEqual(["jsr", "nmi", "irq"]);
  });

  it("returns null when popping an empty stack", () => {
    expect(notePop()).toBeNull();
  });

  it("clear empties the stack", () => {
    notePush(frame(0x8000, 0x8003, "jsr"));
    clear();
    expect(frameList()).toEqual([]);
  });

  it("caps depth at 256, shifting out the oldest frame", () => {
    for (let i = 0; i < 300; i++) notePush(frame(0x8000 + i, 0, "jsr"));
    const frames = frameList();
    expect(frames.length).toBe(256);
    // The newest entries are retained; the oldest were shifted out.
    expect(frames[frames.length - 1]!.callSite).toBe(0x8000 + 299);
    expect(frames[0]!.callSite).toBe(0x8000 + (300 - 256));
  });
});
