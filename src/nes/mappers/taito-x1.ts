/**
 * Taito X1-005 (mapper 80) and X1-017 (mapper 82).
 *
 * Both put their bank registers in the $7EF0-$7EFF window (reached via the
 * cartridge's low-write path) and keep a fixed last 8 KiB PRG bank at $E000; the
 * cartridge's PRG-RAM covers their small battery-backed RAM. X1-005 (Bakushou!!
 * Jinsei Gekijou, Kyonshiizu 2, Minelvaton Saga) banks CHR as two 2 KiB + four
 * 1 KiB windows with mirroring at $7EF6. X1-017 (Kyuukyoku Harikiri Koushien,
 * SD Keiji) is the same shape but its PRG bank values are shifted (>>2) and its
 * six CHR windows ($7EF0-$7EF5) can swap between the two halves via $7EF6 bit 1.
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_080 / _082.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";
import { readMirroring, writeMirroring } from "./mirroring.js";

class TaitoX1Base implements Mapper {
  protected readonly prg: Uint8Array;
  protected readonly chr: Uint8Array;
  protected readonly chrWritable: boolean;
  protected readonly prgBankCount: number; // 8 KiB units
  protected readonly chrBankCount: number; // 1 KiB units

  protected readonly prgBanks = [0, 0, 0]; // $8000, $A000, $C000
  protected readonly chr2k = [0, 0]; // PPU $0000, $0800
  protected readonly chr1k = [0, 0, 0, 0]; // PPU $1000/$1400/$1800/$1C00
  protected mirror: Mirroring;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x2000);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / 0x400);
  }

  prgRead(addr: number): number {
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    const bank = region < 3 ? this.prgBanks[region]! : this.prgBankCount - 1;
    return this.prg[((bank % this.prgBankCount) * 0x2000 + (addr & 0x1fff)) % this.prg.length]!;
  }

  prgWrite(): void {
    /* registers live at $7EF0-$7EFF, handled by lowWrite */
  }

  chrRead(addr: number): number {
    return this.chr[this.chrOffset(addr)]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr)] = value;
  }
  protected chrOffset(addr: number): number {
    const a = addr & 0x1fff;
    const bank = a < 0x1000 ? this.chr2k[a >> 11]! * 2 + ((a >> 10) & 1) : this.chr1k[(a >> 10) & 3]!;
    return ((bank % this.chrBankCount) * 0x400 + (a & 0x3ff)) % this.chr.length;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  serialize(w: NesStateWriter): void {
    for (const b of this.prgBanks) w.u8(b);
    for (const b of this.chr2k) w.u8(b);
    for (const b of this.chr1k) w.u8(b);
    writeMirroring(w, this.mirror);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    for (let i = 0; i < this.prgBanks.length; i++) this.prgBanks[i] = r.u8();
    for (let i = 0; i < this.chr2k.length; i++) this.chr2k[i] = r.u8();
    for (let i = 0; i < this.chr1k.length; i++) this.chr1k[i] = r.u8();
    this.mirror = readMirroring(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}

/** Mapper 80 (Taito X1-005). */
export class TaitoX1005Mapper extends TaitoX1Base {
  lowWrite(addr: number, value: number): void {
    if ((addr & 0xfff0) !== 0x7ef0) return; // registers occupy $7EF0-$7EFF only
    switch (addr & 0x0f) {
      case 0x0:
        this.chr2k[0] = value >> 1;
        break;
      case 0x1:
        this.chr2k[1] = value >> 1;
        break;
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x5:
        this.chr1k[(addr & 0x0f) - 2] = value;
        break;
      case 0x6:
        this.mirror = value & 1 ? "horizontal" : "vertical";
        break;
      case 0xa:
      case 0xb:
        this.prgBanks[0] = value;
        break;
      case 0xc:
      case 0xd:
        this.prgBanks[1] = value;
        break;
      case 0xe:
      case 0xf:
        this.prgBanks[2] = value;
        break;
    }
  }
}

/** Mapper 82 (Taito X1-017) — like X1-005 but the PRG bank values are shifted
 *  right by 2, and a CHR-mode bit ($7EF6 bit 1) swaps whether the 2 KiB banks
 *  sit low or high. Uses the simplest common layout. */
export class TaitoX1017Mapper extends TaitoX1Base {
  private chrHigh = false; // $7EF0-1 (2 KiB) map $1000-$1FFF when set

  lowWrite(addr: number, value: number): void {
    if ((addr & 0xfff0) !== 0x7ef0) return;
    switch (addr & 0x0f) {
      case 0x0:
        this.chr2k[0] = value >> 1;
        break;
      case 0x1:
        this.chr2k[1] = value >> 1;
        break;
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x5:
        this.chr1k[(addr & 0x0f) - 2] = value;
        break;
      case 0x6:
        this.mirror = value & 1 ? "horizontal" : "vertical";
        this.chrHigh = (value & 2) !== 0;
        break;
      case 0xa:
        this.prgBanks[0] = value >> 2;
        break;
      case 0xb:
        this.prgBanks[1] = value >> 2;
        break;
      case 0xc:
        this.prgBanks[2] = value >> 2;
        break;
    }
  }

  protected override chrOffset(addr: number): number {
    // The two 2 KiB banks sit at $0000-$0FFF, the four 1 KiB banks at
    // $1000-$1FFF; the $7EF6 bit swaps those halves.
    const a = (addr & 0x1fff) ^ (this.chrHigh ? 0x1000 : 0);
    const bank = a < 0x1000 ? this.chr2k[a >> 11]! * 2 + ((a >> 10) & 1) : this.chr1k[(a >> 10) & 3]!;
    return ((bank % this.chrBankCount) * 0x400 + (a & 0x3ff)) % this.chr.length;
  }

  override serialize(w: NesStateWriter): void {
    super.serialize(w);
    w.bool(this.chrHigh);
  }
  override deserialize(r: NesStateReader): void {
    super.deserialize(r);
    this.chrHigh = r.bool();
  }
}
