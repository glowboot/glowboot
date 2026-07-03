import { beforeEach, describe, expect, it } from "vitest";

import {
  addPcBreakpoint,
  addReadWatchpoint,
  addWriteWatchpoint,
  armPassThrough,
  checkPc,
  checkRead,
  checkWrite,
  clearAll,
  hasPcBreakpoint,
  hasReadWatchpoint,
  hasWriteWatchpoint,
  listPcBreakpoints,
  listReadWatchpoints,
  listWriteWatchpoints,
  peekHit,
  removePcBreakpoint,
  takeHit,
  togglePcBreakpoint
} from "./breakpoints.js";

beforeEach(() => clearAll());

describe("PC breakpoints", () => {
  it("adds, masks to 16 bits, queries, and lists sorted", () => {
    addPcBreakpoint(0x18000); // masks to 0x8000
    addPcBreakpoint(0xc000);
    expect(hasPcBreakpoint(0x8000)).toBe(true);
    expect(hasPcBreakpoint(0x8001)).toBe(false);
    expect(listPcBreakpoints()).toEqual([0x8000, 0xc000]);
    removePcBreakpoint(0x8000);
    expect(hasPcBreakpoint(0x8000)).toBe(false);
  });

  it("toggles on/off and returns the new state", () => {
    expect(togglePcBreakpoint(0x1234)).toBe(true);
    expect(hasPcBreakpoint(0x1234)).toBe(true);
    expect(togglePcBreakpoint(0x1234)).toBe(false);
    expect(hasPcBreakpoint(0x1234)).toBe(false);
  });

  it("checkPc latches a hit and returns true; empty set is a no-op", () => {
    expect(checkPc(0x8000)).toBe(false); // no breakpoints
    addPcBreakpoint(0x8000);
    expect(checkPc(0x8001)).toBe(false);
    expect(checkPc(0x8000)).toBe(true);
    expect(peekHit()).toEqual({ kind: "pc", addr: 0x8000 });
  });

  it("arms a single-shot pass-through so a Step can move past a breakpoint", () => {
    addPcBreakpoint(0x9000);
    armPassThrough(0x9000);
    expect(checkPc(0x9000)).toBe(false); // passes through once
    expect(checkPc(0x9000)).toBe(true); // re-triggers on the next visit
  });

  it("takeHit consumes the hit and arms its PC for pass-through", () => {
    addPcBreakpoint(0x9000);
    expect(checkPc(0x9000)).toBe(true);
    expect(takeHit()).toEqual({ kind: "pc", addr: 0x9000 });
    expect(peekHit()).toBeNull();
    expect(checkPc(0x9000)).toBe(false); // armed by takeHit
  });
});

describe("watchpoints", () => {
  it("read watchpoint latches a hit", () => {
    expect(listReadWatchpoints()).toEqual([]);
    addReadWatchpoint(0x0200);
    expect(hasReadWatchpoint(0x0200)).toBe(true);
    checkRead(0x0201);
    expect(peekHit()).toBeNull();
    checkRead(0x0200);
    expect(peekHit()).toEqual({ kind: "read", addr: 0x0200 });
  });

  it("write watchpoint latches a hit", () => {
    addWriteWatchpoint(0x0300);
    expect(hasWriteWatchpoint(0x0300)).toBe(true);
    expect(listWriteWatchpoints()).toEqual([0x0300]);
    checkWrite(0x0300);
    expect(peekHit()).toEqual({ kind: "write", addr: 0x0300 });
  });

  it("clearAll wipes every registry and the pending hit", () => {
    addPcBreakpoint(0x8000);
    addReadWatchpoint(0x10);
    checkRead(0x10);
    clearAll();
    expect(listPcBreakpoints()).toEqual([]);
    expect(listReadWatchpoints()).toEqual([]);
    expect(peekHit()).toBeNull();
  });
});
