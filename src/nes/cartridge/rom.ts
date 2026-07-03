/**
 * iNES / NES 2.0 ROM image parser.
 *
 * A `.nes` file is a 16-byte header followed by an optional 512-byte trainer,
 * the PRG ROM, and the CHR ROM. Two header dialects exist:
 *
 *   - iNES (the original): byte counts are 8-bit, mapper is 8 bits split across
 *     flags 6/7, RAM sizes are barely specified.
 *   - NES 2.0 (the modern extension, signalled by flags-7 bits 2-3 == 0b10):
 *     adds high bits for the mapper, sub-mapper, larger ROM counts, and
 *     explicit RAM/NVRAM sizes.
 *
 * Reference: https://www.nesdev.org/wiki/INES and /NES_2.0. We parse both into
 * one normalized {@link NesRom} so the rest of the engine never re-reads the
 * header.
 */

import type { Region } from "../region/region.js";

/** Nametable arrangement. The header only encodes the first three; mappers
 *  (e.g. MMC1) switch to the single-screen modes at runtime. */
export type Mirroring = "horizontal" | "vertical" | "four-screen" | "single-lower" | "single-upper";

export interface NesRom {
  /** PRG ROM, a multiple of 16 KiB. Mapper-banked into CPU $8000-$FFFF. */
  prgRom: Uint8Array;
  /** CHR ROM, a multiple of 8 KiB. Empty when the cart uses CHR RAM. */
  chrRom: Uint8Array;
  /** True when CHR ROM size is 0 — the PPU pattern tables are RAM. */
  usesChrRam: boolean;
  /** CHR RAM size in bytes (0 if CHR ROM is present). iNES carts with no CHR
   *  ROM default to 8 KiB; NES 2.0 states it explicitly. */
  chrRamSize: number;
  /** Cartridge work-RAM size in bytes (CPU $6000-$7FFF window). */
  prgRamSize: number;
  /** Battery-backed save RAM size in bytes (subset of the work RAM on iNES;
   *  a distinct NVRAM bank on NES 2.0). */
  prgNvramSize: number;
  /** Mapper number (iNES 0-255; NES 2.0 0-4095). */
  mapper: number;
  /** NES 2.0 sub-mapper (0 on iNES). */
  submapper: number;
  /** Nametable mirroring. `four-screen` overrides the horizontal/vertical bit. */
  mirroring: Mirroring;
  /** Battery / non-volatile RAM present. */
  battery: boolean;
  /** TV system the cart was authored for, from the header's region flag.
   *  Notoriously unreliable on iNES 1.0 dumps (usually left 0 = NTSC), so the
   *  UI offers a manual per-game override; "both" / Dendy resolve to NTSC. */
  region: Region;
  /** Whether the header was parsed as NES 2.0. */
  nes2: boolean;
}

const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;
const PRG_BANK = 16 * 1024;
const CHR_BANK = 8 * 1024;
const MAGIC = [0x4e, 0x45, 0x53, 0x1a]; // "NES\x1A"

/** NES 2.0 size fields: when the 4-bit high nibble is 0xF the low byte is an
 *  exponent/multiplier (`2^exponent * (multiplier*2 + 1)` units); otherwise the
 *  two nibbles form a plain little-endian count of banks. */
function nes2RomSize(lowByte: number, highNibble: number, bankBytes: number): number {
  if (highNibble === 0xf) {
    const exponent = (lowByte >> 2) & 0x3f;
    const multiplier = lowByte & 0x3;
    return (1 << exponent) * (multiplier * 2 + 1);
  }
  return ((highNibble << 8) | lowByte) * bankBytes;
}

/** NES 2.0 RAM size shift count → bytes: `0` means none, else `64 << shift`. */
function nes2RamSize(shift: number): number {
  return shift === 0 ? 0 : 64 << shift;
}

export function parseNesRom(data: Uint8Array): NesRom {
  if (data.length < HEADER_SIZE || MAGIC.some((b, i) => data[i] !== b)) {
    throw new Error("Not an iNES / NES 2.0 ROM (bad magic)");
  }

  const flags6 = data[6]!;
  const flags7 = data[7]!;
  const nes2 = (flags7 & 0x0c) === 0x08; // bits 2-3 == 0b10

  const battery = (flags6 & 0x02) !== 0;
  const hasTrainer = (flags6 & 0x04) !== 0;
  const mirroring: Mirroring =
    (flags6 & 0x08) !== 0 ? "four-screen" : (flags6 & 0x01) !== 0 ? "vertical" : "horizontal";

  // Region: NES 2.0 byte 12 bits 0-1 (0=NTSC, 1=PAL, 2=both, 3=Dendy); iNES 1.0
  // byte 9 bit 0 (0=NTSC, 1=PAL). Anything that isn't unambiguously PAL → NTSC.
  const region: Region = (nes2 ? (data[12]! & 0x03) === 1 : (data[9]! & 0x01) === 1) ? "pal" : "ntsc";

  // Byte 7's upper nibble holds the mapper's high 4 bits — but archaic dumps,
  // most infamously the "DiskDude!" header writer, left ASCII text in bytes
  // 7-15, corrupting it (byte 7 becomes 'D' = $44, forcing a bogus mapper such
  // as 65/66 and breaking dozens of common carts: Mega Man, Blaster Master,
  // Crystalis…). Trust byte 7's nibble only for NES 2.0 or a genuinely clean
  // iNES header (bits 2-3 clear and the padding bytes 12-15 all zero); else the
  // mapper comes from byte 6 alone.
  const cleanHeader = nes2 || ((flags7 & 0x0c) === 0 && (data[12]! | data[13]! | data[14]! | data[15]!) === 0);
  let mapper = (flags6 >> 4) | (cleanHeader ? flags7 & 0xf0 : 0);
  let submapper = 0;
  let prgRomSize: number;
  let chrRomSize: number;
  let prgRamSize: number;
  let prgNvramSize: number;
  let chrRamSize: number;

  if (nes2) {
    const byte8 = data[8]!;
    const byte9 = data[9]!;
    const byte10 = data[10]!;
    const byte11 = data[11]!;
    mapper |= (byte8 & 0x0f) << 8;
    submapper = byte8 >> 4;
    prgRomSize = nes2RomSize(data[4]!, byte9 & 0x0f, PRG_BANK);
    chrRomSize = nes2RomSize(data[5]!, byte9 >> 4, CHR_BANK);
    prgRamSize = nes2RamSize(byte10 & 0x0f);
    prgNvramSize = nes2RamSize(byte10 >> 4);
    chrRamSize = nes2RamSize(byte11 & 0x0f);
  } else {
    prgRomSize = data[4]! * PRG_BANK;
    chrRomSize = data[5]! * CHR_BANK;
    // iNES byte 8 is the PRG RAM size in 8 KiB units; 0 means 8 KiB for
    // backwards compatibility. Battery RAM, when present, is the whole bank.
    prgRamSize = (data[8]! || 1) * 8 * 1024;
    prgNvramSize = battery ? prgRamSize : 0;
    // iNES has no CHR RAM size; the de-facto default is 8 KiB when CHR ROM is
    // absent.
    chrRamSize = chrRomSize === 0 ? 8 * 1024 : 0;
  }

  let offset = HEADER_SIZE + (hasTrainer ? TRAINER_SIZE : 0);
  const prgRom = data.slice(offset, offset + prgRomSize);
  offset += prgRomSize;
  const chrRom = data.slice(offset, offset + chrRomSize);

  return {
    prgRom,
    chrRom,
    usesChrRam: chrRomSize === 0,
    chrRamSize,
    prgRamSize,
    prgNvramSize,
    mapper,
    submapper,
    mirroring,
    battery,
    region,
    nes2
  };
}
