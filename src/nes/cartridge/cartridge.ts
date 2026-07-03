/**
 * Cartridge — binds a parsed ROM to its mapper and provides the console's view
 * of cartridge space.
 *
 * Owns the console-side state the mapper doesn't: PRG work-RAM ($6000-$7FFF) and
 * the nametable VRAM, applying the mapper's mirroring for $2000-$2FFF. Implements
 * {@link PpuBus} so it can be handed straight to the PPU.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mapper } from "../mappers/mapper.js";
import { createMapper } from "../mappers/mapper.js";
import type { PpuBus } from "../ppu/ppu.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { NesRom } from "./rom.js";

export class Cartridge implements PpuBus {
  private readonly mapper: Mapper;
  private readonly prgRam: Uint8Array;
  // 4 KiB so four-screen carts get four distinct nametables; two-screen
  // mirroring uses only the low 2 KiB.
  private readonly vram = new Uint8Array(0x1000);
  /** Whether the mapper implements the per-CPU-cycle tick / IRQ-line hooks —
   *  the console consults these once so its per-cycle path can skip the calls. */
  readonly hasMapperTick: boolean;
  readonly hasMapperIrq: boolean;
  /** {@link PpuBus.hasExtAttr} — this class always exposes the method, so the
   *  PPU needs the flag to skip the per-tile call on non-MMC5 mappers. */
  readonly hasExtAttr: boolean;

  constructor(readonly rom: NesRom) {
    this.mapper = createMapper(rom);
    this.prgRam = new Uint8Array(Math.max(rom.prgRamSize, 0x2000));
    this.hasMapperTick = typeof this.mapper.tick === "function";
    this.hasMapperIrq = typeof this.mapper.irqState === "function";
    this.hasExtAttr = typeof this.mapper.extAttrTile === "function";
  }

  // ── CPU side ($4020-$FFFF) ──────────────────────────────────────────────
  /** `openBus` is the last value on the CPU data bus; the expansion region
   *  ($4020-$5FFF) returns it when the mapper doesn't drive the read. */
  cpuRead(addr: number, openBus = 0): number {
    if (addr >= 0x8000) return this.mapper.prgRead(addr);
    if (addr >= 0x6000) {
      // A few boards drive $6000-$7FFF themselves (Bandai FCG's serial EEPROM);
      // otherwise it is the cartridge's PRG-RAM.
      const driven = this.mapper.lowRead?.(addr);
      return driven ?? this.prgRam[addr - 0x6000]!;
    }
    if (addr >= 0x4020) return this.mapper.lowRead?.(addr) ?? openBus;
    return openBus;
  }
  cpuWrite(addr: number, value: number): void {
    if (addr >= 0x8000) this.mapper.prgWrite(addr, value);
    else if (addr >= 0x6000) {
      this.prgRam[addr - 0x6000] = value;
      this.mapper.lowWrite?.(addr, value); // some carts register here too (NINA-001 $7FFD-$7FFF)
    } else this.mapper.lowWrite?.(addr, value); // $4020-$5FFF (e.g. NINA-03 registers)
  }

  // ── PPU side ($0000-$3EFF) ──────────────────────────────────────────────
  ppuRead(addr: number): number {
    addr &= 0x3fff;
    if (addr < 0x2000) return this.mapper.chrRead(addr);
    if (this.mapper.ppuNametableByte) return this.mapper.ppuNametableByte(addr, this.vram);
    return this.vram[this.nametableIndex(addr)]!;
  }
  ppuWrite(addr: number, value: number): void {
    addr &= 0x3fff;
    if (addr < 0x2000) this.mapper.chrWrite(addr, value);
    else if (this.mapper.ppuNametableWrite) this.mapper.ppuNametableWrite(addr, value, this.vram);
    else this.vram[this.nametableIndex(addr)] = value;
  }
  /** PPU sprite-pattern read — MMC5 banks sprites separately from the background
   *  in 8×16 mode; other mappers fall back to the shared CHR read. */
  chrReadSprite(addr: number): number {
    addr &= 0x3fff;
    return this.mapper.chrReadSprite?.(addr) ?? this.mapper.chrRead(addr);
  }
  setLargeSprites(large: boolean): void {
    this.mapper.setLargeSprites?.(large);
  }

  /** MMC5 ExRAM extended-attribute mode, delegated to the mapper. */
  extAttrTile(ntPos: number): { bank: number; palette: number } | null {
    return this.mapper.extAttrTile?.(ntPos) ?? null;
  }
  extAttrPattern(bank: number, offset: number): number {
    return this.mapper.extAttrPattern?.(bank, offset) ?? 0;
  }

  /** Clock the mapper's scanline IRQ counter (called by the PPU per scanline). */
  clockIrq(): void {
    this.mapper.clockIrq?.();
  }
  /** Advance the mapper's CPU-cycle IRQ counter. */
  tick(cpuCycles: number): void {
    this.mapper.tick?.(cpuCycles);
  }
  /** Whether the mapper is asserting the CPU IRQ line. */
  irqState(): boolean {
    return this.mapper.irqState?.() ?? false;
  }
  /** The cartridge's expansion sound chip, if it has one. */
  expansionAudio(): ExpansionAudio | null {
    return this.mapper.audio?.() ?? null;
  }

  // ── battery-backed save RAM ($6000-$7FFF persistence) ───────────────────
  /** Whether the cart has battery-backed PRG-RAM (a persistent in-game save). */
  get hasBattery(): boolean {
    return this.rom.battery;
  }
  /** The battery-backed slice of PRG-RAM, or null when the cart has no battery.
   *  Only the first `prgNvramSize` bytes persist; any RAM beyond that is
   *  volatile work RAM. */
  get batteryRam(): Uint8Array | null {
    if (!this.rom.battery) return null;
    const size = this.rom.prgNvramSize || this.prgRam.length;
    return this.prgRam.subarray(0, size);
  }
  /** Restore a previously-persisted battery save into PRG-RAM. */
  loadBatteryRam(bytes: Uint8Array): void {
    if (!this.rom.battery) return;
    this.prgRam.set(bytes.subarray(0, Math.min(bytes.length, this.prgRam.length)));
  }

  /** Console-side cartridge state (PRG-RAM + nametable VRAM) plus the mapper's
   *  own banking/IRQ/CHR-RAM state. PRG/CHR ROM is reconstructed from the ROM. */
  serialize(w: NesStateWriter): void {
    w.bytes(this.prgRam);
    w.bytes(this.vram);
    this.mapper.serialize(w);
  }
  deserialize(r: NesStateReader): void {
    r.bytes(this.prgRam);
    r.bytes(this.vram);
    this.mapper.deserialize(r);
  }

  private nametableIndex(addr: number): number {
    const offset = addr & 0x0fff;
    const table = offset >> 10; // 0-3
    // TxSROM-style boards route each nametable independently from a CHR bank bit.
    if (this.mapper.nametable) return (this.mapper.nametable(table) << 10) | (offset & 0x3ff);
    let bank: number;
    switch (this.mapper.mirroring()) {
      case "vertical":
        bank = table & 1;
        break;
      case "horizontal":
        bank = table >> 1;
        break;
      case "four-screen":
        bank = table;
        break;
      case "single-lower":
        bank = 0;
        break;
      case "single-upper":
        bank = 1;
        break;
    }
    return (bank << 10) | (offset & 0x3ff);
  }
}
