/**
 * CPROM (iNES mapper 13) — Videomation.
 *
 * Fixed 32 KiB PRG and 16 KiB CHR RAM: PPU $0000-$0FFF is fixed to CHR bank 0,
 * while $8000-$FFFF writes select one of four 4 KiB CHR-RAM banks for PPU
 * $1000-$1FFF. Reference: https://www.nesdev.org/wiki/INES_Mapper_013.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

const CHR_BANK = 0x1000; // 4 KiB

export class CpromMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr = new Uint8Array(0x4000); // 16 KiB CHR RAM
  private readonly mirror: Mirroring;
  private chrBank = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(addr & 0x7fff) % this.prg.length]!;
  }
  prgWrite(_addr: number, value: number): void {
    this.chrBank = value & 0x03;
  }

  chrRead(addr: number): number {
    const bank = addr < 0x1000 ? 0 : this.chrBank;
    return this.chr[bank * CHR_BANK + (addr & 0xfff)]!;
  }
  chrWrite(addr: number, value: number): void {
    const bank = addr < 0x1000 ? 0 : this.chrBank;
    this.chr[bank * CHR_BANK + (addr & 0xfff)] = value;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.chrBank);
    w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.chrBank = r.u8();
    r.bytes(this.chr);
  }
}
