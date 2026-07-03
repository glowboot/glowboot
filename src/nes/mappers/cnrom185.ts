/**
 * Mapper 185 (CNROM with copy protection) — Bird Week, B-Wings, Mighty Bomb
 * Jack (J), Seicross, Spy vs Spy (J). A single 8 KiB CHR-ROM whose chip-select
 * pins double as a security check: a write to $8000-$FFFF puts its low two bits
 * on CS1/CS2, and CHR reads only return ROM when those bits match the board's
 * wired value (given by the NES 2.0 submapper); otherwise the pattern tables
 * read open bus, so an unauthorised copy sees garbage and hangs.
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_185.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

export class Mapper185 implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly mirror: Mirroring;
  private readonly enableCs: number; // CS value that unlocks CHR; -1 = unknown
  private chrEnabled = true;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.chr = rom.usesChrRam ? new Uint8Array(rom.chrRamSize || 0x2000) : rom.chrRom;
    this.mirror = rom.mirroring;
    this.enableCs = rom.submapper >= 4 && rom.submapper <= 7 ? rom.submapper - 4 : -1;
  }

  prgRead(addr: number): number {
    return this.prg[(addr & 0x7fff) % this.prg.length]!;
  }
  prgWrite(_addr: number, value: number): void {
    const cs = value & 3;
    // Known submapper: exact match unlocks. Unknown iNES: any non-zero CS — the
    // de-facto heuristic, since the unlock value carries set bits on every board.
    this.chrEnabled = this.enableCs >= 0 ? cs === this.enableCs : cs !== 0;
  }

  chrRead(addr: number): number {
    if (!this.chrEnabled) return 0xff; // open bus (data lines pulled high)
    return this.chr[(addr & 0x1fff) % this.chr.length]!;
  }
  chrWrite(): void {
    /* CHR ROM */
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    w.bool(this.chrEnabled);
  }
  deserialize(r: NesStateReader): void {
    this.chrEnabled = r.bool();
  }
}
