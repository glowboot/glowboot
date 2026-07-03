/**
 * Mapper 87 (Jaleco/Konami discrete CHR-latch) — Argus, City Connection (J),
 * The Goonies (J), Ninja-kun. A simple CHR latch in the $6000-$7FFF range whose
 * two low bits select the 8 KiB CHR bank — but bit-swapped (D0→high, D1→low),
 * which is the only thing distinguishing it from plain CNROM. PRG is fixed,
 * mirroring is header-wired. Reference: https://www.nesdev.org/wiki/INES_Mapper_087.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class Jaleco87Mapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrBankCount: number;
  private readonly mirror: Mirroring;
  private chrBank = 0;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.chrRom;
    this.chrBankCount = Math.max(1, rom.chrRom.length / 0x2000);
    this.mirror = rom.mirroring;
  }

  prgRead(addr: number): number {
    return this.prg[(addr & 0x7fff) % this.prg.length]!;
  }
  prgWrite(): void {
    /* the bank latch lives in $6000-$7FFF (see lowWrite) */
  }
  lowWrite(addr: number, value: number): void {
    if (addr >= 0x6000) this.chrBank = ((value & 1) << 1) | ((value & 2) >> 1);
  }

  chrRead(addr: number): number {
    return this.chr[((this.chrBank % this.chrBankCount) * 0x2000 + (addr & 0x1fff)) % this.chr.length]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.chrBank);
  }
  deserialize(r: NesStateReader): void {
    this.chrBank = r.u8();
  }
}
