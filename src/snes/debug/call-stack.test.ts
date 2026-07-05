import { beforeEach, describe, expect, it } from "vitest";

import { clearAllSnesFrames, frameListSnes, notePopSnes, notePushSnes, type SnesCallFrame } from "./call-stack.js";

function frame(from: number, to: number, kind: "jsr" | "jsl" = "jsr"): SnesCallFrame {
  return { from, to, e: 0, kind };
}

describe("SNES call-stack tracker", () => {
  beforeEach(() => clearAllSnesFrames());

  it("pushes and pops in LIFO order", () => {
    notePushSnes(frame(0x008000, 0x008100));
    notePushSnes(frame(0x008103, 0x01c000, "jsl"));
    expect(frameListSnes().length).toBe(2);
    expect(notePopSnes()!.to).toBe(0x01c000);
    expect(notePopSnes()!.to).toBe(0x008100);
    expect(notePopSnes()).toBeNull();
  });

  it("drops the oldest frame past the depth cap", () => {
    for (let i = 0; i < 70; i++) notePushSnes(frame(0x008000 + i, 0x009000 + i));
    const list = frameListSnes();
    expect(list.length).toBe(64);
    expect(list[0]!.from).toBe(0x008000 + 6); // first six shifted out
    expect(list[63]!.from).toBe(0x008000 + 69);
  });

  it("clears on demand", () => {
    notePushSnes(frame(0x008000, 0x008100));
    clearAllSnesFrames();
    expect(frameListSnes().length).toBe(0);
    expect(notePopSnes()).toBeNull();
  });
});
