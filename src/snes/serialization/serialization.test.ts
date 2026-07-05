import { describe, expect, it } from "vitest";

import { Snes } from "../snes.js";
import { SNES_STATE_VERSION, UnsupportedSnesSaveStateError, upgradeSnesState } from "./serialization.js";

function bytesEqual(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bootable LoROM cart with battery SRAM: a counter loop that increments
 *  WRAM, writes VRAM through the port, and touches SRAM — enough churn that
 *  divergence after a bad restore shows up everywhere. */
function makeSnes(): Snes {
  const img = new Uint8Array(0x80000);
  const program = [
    // enable screen: INIDISP = $0F
    0xa9, 0x0f, 0x8d, 0x00, 0x21,
    // loop: INC $7E2000 (counter)
    0xee, 0x00, 0x20,
    // VMADD = counter, VMDATA = counter (VRAM churn)
    0xad, 0x00, 0x20, 0x8d, 0x16, 0x21, 0x8d, 0x18, 0x21,
    // SRAM churn at $70:0000
    0x8f, 0x00, 0x00, 0x70,
    // JMP loop
    0x4c, 0x05, 0x80
  ];
  img.set(program, 0);
  const h = 0x7fc0;
  const title = "SERIALIZE TEST".padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x20;
  img[h + 0x16] = 0x02; // ROM+RAM+battery
  img[h + 0x17] = 0x09;
  img[h + 0x18] = 0x03; // 8 KiB SRAM
  img[h + 0x19] = 0x01;
  img[h + 0x1c] = 0xaa;
  img[h + 0x1d] = 0xaa;
  img[h + 0x1e] = 0x55;
  img[h + 0x1f] = 0x55;
  img[h + 0x3c] = 0x00;
  img[h + 0x3d] = 0x80;
  return new Snes(img);
}

describe("SNES save states", () => {
  it("round-trips: restore + run N === run N without interruption", () => {
    const a = makeSnes();
    for (let f = 0; f < 30; f++) a.runFrame();
    const blob = a.saveState();

    // Continue the original for 30 more frames — the ground truth.
    for (let f = 0; f < 30; f++) a.runFrame();
    const truth = a.saveState();

    // Restore into a FRESH console and run the same 30 frames.
    const b = makeSnes();
    b.loadState(blob);
    for (let f = 0; f < 30; f++) b.runFrame();
    expect(bytesEqual(b.saveState(), truth)).toBe(true);
  });

  it("save -> load -> save is byte-identical (encoding symmetry)", () => {
    const a = makeSnes();
    for (let f = 0; f < 25; f++) a.runFrame();
    const blob = a.saveState();
    const b = makeSnes();
    b.loadState(blob);
    expect(bytesEqual(b.saveState(), blob)).toBe(true);
  });

  it("restores the framebuffer contents after one rendered frame", () => {
    const a = makeSnes();
    for (let f = 0; f < 40; f++) a.runFrame();
    const blob = a.saveState();
    a.runFrame();
    const truthFb = new Uint8ClampedArray(a.framebuffer);
    const b = makeSnes();
    b.loadState(blob);
    b.runFrame();
    expect(bytesEqual(b.framebuffer, truthFb)).toBe(true);
  });

  it("rejects newer-version blobs before mutating anything", () => {
    const a = makeSnes();
    for (let f = 0; f < 5; f++) a.runFrame();
    const blob = a.saveState();
    blob[0] = SNES_STATE_VERSION + 1;
    const b = makeSnes();
    const before = b.saveState();
    expect(() => b.loadState(blob)).toThrowError(UnsupportedSnesSaveStateError);
    expect(bytesEqual(b.saveState(), before)).toBe(true);
  });

  it("upgradeSnesState rejects empty blobs", () => {
    expect(() => upgradeSnesState(new Uint8Array(0))).toThrowError(UnsupportedSnesSaveStateError);
  });

  it("exposes and restores battery SRAM", () => {
    const a = makeSnes();
    for (let f = 0; f < 10; f++) a.runFrame();
    expect(a.hasBattery).toBe(true);
    expect(a.batteryRam![0]).not.toBe(0); // the loop wrote the counter there
    const saved = new Uint8Array(a.batteryRam!);
    const b = makeSnes();
    b.loadBatteryRam(saved);
    expect(bytesEqual(b.batteryRam!, saved)).toBe(true);
  });
});
