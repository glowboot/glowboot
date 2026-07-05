import { describe, expect, it } from "vitest";

import { parseSnesRom } from "../cartridge/rom.js";
import { SnesBus } from "./bus.js";

function makeBus(mapping: "lorom" | "hirom", romSize = 0x100000, sram = 3): SnesBus {
  const img = new Uint8Array(romSize);
  for (let i = 0; i < img.length; i++) img[i] = (i * 31 + (i >> 11)) & 0xff;
  const h = mapping === "lorom" ? 0x7fc0 : 0xffc0;
  const title = "BUS TEST".padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = mapping === "lorom" ? 0x20 : 0x21;
  img[h + 0x16] = sram > 0 ? 0x02 : 0x00;
  img[h + 0x17] = 0x0a;
  img[h + 0x18] = sram;
  img[h + 0x19] = 0x01;
  img[h + 0x1c] = 0xaa;
  img[h + 0x1d] = 0xaa;
  img[h + 0x1e] = 0x55;
  img[h + 0x1f] = 0x55;
  img[h + 0x3c] = 0x00;
  img[h + 0x3d] = 0x80;
  return new SnesBus(parseSnesRom(img));
}

describe("SnesBus mapping", () => {
  it("maps LoROM 32 KiB pages into $8000-$FFFF of each bank", () => {
    const bus = makeBus("lorom");
    const rom = (i: number): number => (i * 31 + (i >> 11)) & 0xff;
    expect(bus.read(0x008000)).toBe(rom(0x0000));
    expect(bus.read(0x00ffff)).toBe(rom(0x7fff));
    expect(bus.read(0x018000)).toBe(rom(0x8000));
    expect(bus.read(0x1fabcd)).toBe(rom(0x1f * 0x8000 + 0x2bcd));
    // banks $80+ mirror
    expect(bus.read(0x808000)).toBe(rom(0x0000));
    expect(bus.read(0x81ffff)).toBe(rom(0xffff));
  });

  it("maps HiROM banks $40-$7D linearly and upper halves into $00-$3F", () => {
    const bus = makeBus("hirom");
    const rom = (i: number): number => (i * 31 + (i >> 11)) & 0xff;
    expect(bus.read(0x400000)).toBe(rom(0x0000));
    expect(bus.read(0x40ffff)).toBe(rom(0xffff));
    expect(bus.read(0x418000)).toBe(rom(0x18000));
    expect(bus.read(0x008000)).toBe(rom(0x8000));
    expect(bus.read(0x01c123)).toBe(rom(0x1c123));
    expect(bus.read(0xc00000)).toBe(rom(0x0000)); // mirror
  });

  it("reads and writes WRAM at $7E/$7F with the bank-0 low mirror", () => {
    const bus = makeBus("lorom");
    bus.write(0x7e1234, 0x42);
    bus.write(0x7f0007, 0x99);
    expect(bus.read(0x7e1234)).toBe(0x42);
    expect(bus.read(0x7f0007)).toBe(0x99);
    bus.write(0x000456, 0x77); // mirror of 7E:0456
    expect(bus.read(0x7e0456)).toBe(0x77);
    expect(bus.read(0x800456)).toBe(0x77);
  });

  it("streams WRAM through the $2180 data port with auto-increment", () => {
    const bus = makeBus("lorom");
    bus.write(0x002181, 0x00);
    bus.write(0x002182, 0x40);
    bus.write(0x002183, 0x01); // 1:4000
    bus.write(0x002180, 0xaa);
    bus.write(0x002180, 0xbb);
    expect(bus.wram[0x14000]).toBe(0xaa);
    expect(bus.wram[0x14001]).toBe(0xbb);
    bus.write(0x002181, 0x00);
    bus.write(0x002182, 0x40);
    expect(bus.read(0x002180)).toBe(0xaa);
    expect(bus.read(0x002180)).toBe(0xbb);
  });

  it("maps LoROM SRAM into banks $70-$7D", () => {
    const bus = makeBus("lorom");
    bus.write(0x700000, 0x5a);
    bus.write(0x701fff, 0xa5);
    expect(bus.read(0x700000)).toBe(0x5a);
    expect(bus.read(0x701fff)).toBe(0xa5);
    expect(bus.sram[0]).toBe(0x5a);
    // 8 KiB SRAM mirrors through the window
    expect(bus.read(0x702000)).toBe(0x5a);
  });

  it("maps HiROM SRAM into the $6000-$7FFF windows of banks $20-$3F", () => {
    const bus = makeBus("hirom");
    bus.write(0x206000, 0x3c);
    expect(bus.read(0x206000)).toBe(0x3c);
    expect(bus.read(0xa06000)).toBe(0x3c); // mirror bank
    expect(bus.sram[0]).toBe(0x3c);
  });

  it("returns open bus (last bus byte) for unmapped reads", () => {
    const bus = makeBus("lorom", 0x100000, 0);
    bus.read(0x008000); // drives MDR with rom(0)
    const rom0 = (0 * 31) & 0xff;
    expect(bus.read(0x005000)).toBe(rom0);
  });

  it("dispatches MMIO to registered handlers with open-bus fallback", () => {
    const bus = makeBus("lorom");
    const writes: [number, number][] = [];
    bus.onIoRead = (addr) => (addr === 0x2139 ? 0x77 : null);
    bus.onIoWrite = (addr, v) => writes.push([addr, v]);
    expect(bus.read(0x002139)).toBe(0x77);
    bus.write(0x004200, 0x81);
    expect(writes).toEqual([[0x4200, 0x81]]);
    bus.read(0x008000);
    expect(bus.read(0x002140)).toBe((0 * 31) & 0xff); // unclaimed -> open bus
  });
});
