/**
 * Mapper interface + factory.
 *
 * A mapper is the cartridge's banking hardware: it maps CPU $8000-$FFFF onto PRG
 * ROM, PPU $0000-$1FFF onto CHR ROM/RAM, and reports the nametable mirroring
 * (which some mappers switch at runtime). PRG-RAM, the nametable VRAM, and the
 * mirroring application live in {@link Cartridge}; the mapper only decides which
 * bank each address sees.
 */

import type { ExpansionAudio } from "../apu/expansion.js";
import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { AxromMapper } from "./axrom.js";
import { BandaiFcgMapper } from "./bandai-fcg.js";
import { Bandai74Mapper } from "./bandai74.js";
import { BnromMapper } from "./bnrom.js";
import { CamericaMapper } from "./camerica.js";
import { CnromMapper } from "./cnrom.js";
import { Mapper185 } from "./cnrom185.js";
import { ColorDreamsMapper } from "./colordreams.js";
import { CpromMapper } from "./cprom.js";
import { IremTamS1Mapper, Nichibutsu180Mapper, Sunsoft1Mapper, Sunsoft2Mapper, Un1romMapper } from "./discrete.js";
import { Fme7Mapper } from "./fme7.js";
import { GxromMapper } from "./gxrom.js";
import { IremG101Mapper } from "./irem-g101.js";
import { IremH3001Mapper } from "./irem-h3001.js";
import { Jaleco72Mapper, Jaleco86Mapper, Jaleco92Mapper, Jaleco140Mapper } from "./jaleco-simple.js";
import { JalecoSs88006Mapper } from "./jaleco-ss88006.js";
import { Jaleco87Mapper } from "./jaleco87.js";
import { Mmc1Mapper } from "./mmc1.js";
import { Mmc2Mapper, Mmc4Mapper } from "./mmc2.js";
import { Mmc3Mapper } from "./mmc3.js";
import { Mapper189, Mapper206, TqromMapper, TxSromMapper, Waixing245Mapper } from "./mmc3-clones.js";
import { Mmc5Mapper } from "./mmc5.js";
import { Mapper76, Mapper88, Mapper95, Mapper154 } from "./namco108.js";
import { Namco163Mapper } from "./namco163.js";
import { Namco210Mapper } from "./namco210.js";
import { Nina03Mapper, Nina113Mapper } from "./nina.js";
import { NromMapper } from "./nrom.js";
import { QuattroMapper } from "./quattro.js";
import { Rambo1Mapper } from "./rambo1.js";
import { Sunsoft3Mapper } from "./sunsoft3.js";
import { Sunsoft4Mapper } from "./sunsoft4.js";
import { TaitoTc0190Mapper, TaitoTc0690Mapper } from "./taito-tc0190.js";
import { TaitoX1005Mapper, TaitoX1017Mapper } from "./taito-x1.js";
import { UxromMapper } from "./uxrom.js";
import { Vrc1Mapper } from "./vrc1.js";
import { Vrc3Mapper } from "./vrc3.js";
import { Vrc6Mapper } from "./vrc6.js";
import { Vrc7Mapper } from "./vrc7.js";
import { Vrc24Mapper } from "./vrc24.js";

export interface Mapper {
  /** CPU read of $8000-$FFFF (banked PRG ROM). */
  prgRead(addr: number): number;
  /** CPU write of $8000-$FFFF (bank-select registers; no-op on fixed mappers). */
  prgWrite(addr: number, value: number): void;
  /** PPU read of $0000-$1FFF (banked CHR). */
  chrRead(addr: number): number;
  /** PPU read of a sprite pattern ($0000-$1FFF). MMC5 banks sprites from a
   *  separate register set in 8×16 mode; absent means "same as chrRead". */
  chrReadSprite?(addr: number): number;
  /** Tell the mapper the current sprite height (PPUCTRL bit 5); MMC5 uses it to
   *  choose the background CHR bank set. */
  setLargeSprites?(large: boolean): void;
  /** PPU write of $0000-$1FFF (CHR RAM, if writable). */
  chrWrite(addr: number, value: number): void;
  /** CPU write below the $8000 bank window ($4020-$7FFF) — for mappers with
   *  registers there (NINA-03 at $4100, NINA-001 at $7FFD-$7FFF). Most mappers
   *  omit this. */
  lowWrite?(addr: number, value: number): void;
  /** CPU read of $4020-$5FFF — for mappers with readable registers there
   *  (e.g. Namco 163's sound RAM at $4800 and IRQ counter at $5000/$5800).
   *  Returns null to fall through to open bus. */
  lowRead?(addr: number): number | null;
  /** Current nametable mirroring. */
  mirroring(): Mirroring;
  /** Per-nametable routing for boards that map each of the four logical
   *  nametables independently — TxSROM (118) / Namco 95 drive CIRAM A10 from a
   *  CHR bank bit. Returns the physical nametable (0 or 1) for logical table
   *  0-3. When present the cartridge uses it in place of {@link mirroring}. */
  nametable?(table: number): number;
  /** MMC5 per-nametable mapping ($5105): return the nametable byte at `addr`
   *  ($2000-$2FFF), which may come from the console's CIRAM (passed in), the
   *  mapper's own ExRAM, or fill mode. When present the cartridge routes all
   *  nametable reads/writes through these instead of the mirroring path. */
  ppuNametableByte?(addr: number, ciram: Uint8Array): number;
  ppuNametableWrite?(addr: number, value: number, ciram: Uint8Array): void;
  /** Clock the scanline counter (MMC3-style A12-rise IRQ). */
  clockIrq?(): void;
  /** Advance a per-CPU-cycle counter — VRC / Irem / Sunsoft IRQ timers, and
   *  MMC1's consecutive-write detection. */
  tick?(cpuCycles: number): void;
  /** Whether the mapper is currently asserting the CPU IRQ line. */
  irqState?(): boolean;
  /** Cartridge expansion sound chip, if any (VRC6, VRC7, N163, 5B, MMC5). */
  audio?(): ExpansionAudio | null;
  /** MMC5 ExRAM extended-attribute mode: per-BG-tile CHR bank + palette for the
   *  tile at nametable position `ntPos` (0-959), or null when inactive. */
  extAttrTile?(ntPos: number): { bank: number; palette: number } | null;
  /** Direct 4 KiB-bank CHR fetch for ext-attr BG patterns (bypasses banking). */
  extAttrPattern?(bank: number, offset: number): number;
  /** Write the mapper's mutable state (bank/IRQ registers, latches, CHR-RAM
   *  when writable, any expansion-audio chip) for a save state. PRG/CHR ROM and
   *  the cartridge's PRG-RAM/VRAM are serialized elsewhere. */
  serialize(w: NesStateWriter): void;
  /** Restore the state written by {@link serialize}. */
  deserialize(r: NesStateReader): void;
}

export function createMapper(rom: NesRom): Mapper {
  switch (rom.mapper) {
    case 0:
      return new NromMapper(rom);
    case 1:
      return new Mmc1Mapper(rom);
    case 2:
      return new UxromMapper(rom);
    case 3:
      return new CnromMapper(rom);
    case 4:
      return new Mmc3Mapper(rom);
    case 5:
      return new Mmc5Mapper(rom);
    case 32:
      return new IremG101Mapper(rom);
    case 93:
      return new Sunsoft2Mapper(rom);
    case 94:
      return new Un1romMapper(rom);
    case 97:
      return new IremTamS1Mapper(rom);
    case 180:
      return new Nichibutsu180Mapper(rom);
    case 184:
      return new Sunsoft1Mapper(rom);
    case 33:
      return new TaitoTc0190Mapper(rom);
    case 48:
      return new TaitoTc0690Mapper(rom);
    case 64:
      return new Rambo1Mapper(rom);
    case 7:
      return new AxromMapper(rom);
    case 9:
      return new Mmc2Mapper(rom);
    case 10:
      return new Mmc4Mapper(rom);
    case 11:
      return new ColorDreamsMapper(rom);
    case 13:
      return new CpromMapper(rom);
    case 16:
      return new BandaiFcgMapper(rom);
    case 18:
      return new JalecoSs88006Mapper(rom);
    case 19:
      return new Namco163Mapper(rom);
    case 21:
    case 22:
    case 23:
    case 25:
      return new Vrc24Mapper(rom);
    case 24:
    case 26:
      return new Vrc6Mapper(rom);
    case 34:
      return new BnromMapper(rom);
    case 65:
      return new IremH3001Mapper(rom);
    case 66:
      return new GxromMapper(rom);
    case 67:
      return new Sunsoft3Mapper(rom);
    case 68:
      return new Sunsoft4Mapper(rom);
    case 69:
      return new Fme7Mapper(rom);
    case 70:
      return new Bandai74Mapper(rom, false);
    case 71:
      return new CamericaMapper(rom);
    case 72:
      return new Jaleco72Mapper(rom);
    case 73:
      return new Vrc3Mapper(rom);
    case 76:
      return new Mapper76(rom);
    case 75:
      return new Vrc1Mapper(rom);
    case 79:
      return new Nina03Mapper(rom);
    case 80:
      return new TaitoX1005Mapper(rom);
    case 82:
      return new TaitoX1017Mapper(rom);
    case 85:
      return new Vrc7Mapper(rom);
    case 87:
      return new Jaleco87Mapper(rom);
    case 86:
      return new Jaleco86Mapper(rom);
    case 88:
      return new Mapper88(rom);
    case 92:
      return new Jaleco92Mapper(rom);
    case 95:
      return new Mapper95(rom);
    case 113:
      return new Nina113Mapper(rom);
    case 118:
      return new TxSromMapper(rom);
    case 119:
      return new TqromMapper(rom);
    case 140:
      return new Jaleco140Mapper(rom);
    case 152:
      return new Bandai74Mapper(rom, true);
    case 154:
      return new Mapper154(rom);
    case 185:
      return new Mapper185(rom);
    case 189:
      return new Mapper189(rom);
    case 206:
      return new Mapper206(rom);
    case 210:
      return new Namco210Mapper(rom);
    case 232:
      return new QuattroMapper(rom);
    case 245:
      return new Waixing245Mapper(rom);
    default:
      throw new Error(`unsupported mapper ${rom.mapper}`);
  }
}
