/**
 * SNES cartridge image parser.
 *
 * Unlike iNES, SNES dumps carry no file-format header — the console's own
 * internal cartridge header (title, map mode, chipset, sizes, region,
 * checksum) sits inside the ROM at a bank-dependent offset: $7FC0 for LoROM,
 * $FFC0 for HiROM, $40FFC0 for ExHiROM. Detection therefore scores every
 * candidate location on internal consistency (checksum/complement pair, a
 * map-mode byte that agrees with the location, a printable title, a sane
 * emulation-mode RESET vector) and picks the best. Copier tools of the era
 * prepended a 512-byte junk header ("SMC header"), detected by file size
 * modulo 32 KiB and stripped.
 *
 * Reference: fullsnes "SNES Cartridge" (https://problemkaputt.de/fullsnes.htm).
 */

export type SnesMapping = "lorom" | "hirom" | "exhirom";
export type SnesRegion = "ntsc" | "pal";

/** Coprocessor family from the chipset byte's high nibble (only meaningful
 *  when the low nibble is >= 3). None of these are emulated yet — the parser
 *  reports them so unsupported carts fail loudly instead of half-booting. */
export type SnesCoprocessor = "dsp" | "superfx" | "obc1" | "sa1" | "sdd1" | "srtc" | "cx4" | "other" | "custom";

export interface SnesRom {
  /** ROM image with any 512-byte copier header stripped. */
  readonly rom: Uint8Array;
  readonly mapping: SnesMapping;
  /** 3.58 MHz-capable ROM (map-mode bit 4); affects access timing only. */
  readonly fastRom: boolean;
  /** Internal header title ($FFC0-$FFD4), trimmed. */
  readonly title: string;
  /** Raw chipset byte ($FFD6). */
  readonly chipset: number;
  readonly coprocessor: SnesCoprocessor | null;
  /** Cartridge SRAM size in bytes (0 = none). */
  readonly sramSize: number;
  readonly battery: boolean;
  /** ROM size claimed by the header, in bytes (informational — the file is
   *  authoritative). */
  readonly headerRomSize: number;
  readonly region: SnesRegion;
  /** Raw country code ($FFD9). */
  readonly country: number;
  readonly version: number;
  /** File offset of the internal header block ($xxC0). */
  readonly headerOffset: number;
  /** Memory-pak slot board (BSC-1A5M family, e.g. Sound Novel Tsukuru):
   *  LoROM whose banks $80-$9F carry ROM pages $40-$5F (the part beyond
   *  2 MiB) instead of mirroring $00-$1F. */
  readonly extendedHighBanks: boolean;
}

const HEADER_CANDIDATES: { offset: number; mapping: SnesMapping }[] = [
  { offset: 0x7fc0, mapping: "lorom" },
  { offset: 0xffc0, mapping: "hirom" },
  { offset: 0x40ffc0, mapping: "exhirom" }
];

/** Map-mode low nibbles that are legitimate for each header location. */
const MODE_NIBBLES: Record<SnesMapping, readonly number[]> = {
  lorom: [0x0, 0x2, 0x3], // plain, S-DD1, SA-1 boards present as LoROM-located
  hirom: [0x1, 0xa],
  exhirom: [0x5]
};

/** NTSC country codes ($FFD9): Japan, USA, Korea, Canada, Brazil (PAL-M runs
 *  at 60 Hz). Everything in the 0x02-0x0C European block is PAL. */
const NTSC_COUNTRIES = new Set([0x00, 0x01, 0x0d, 0x0f, 0x10]);

const COPROCESSORS: readonly SnesCoprocessor[] = ["dsp", "superfx", "obc1", "sa1", "sdd1", "srtc"];

/** Header titles of the games running the DSP-2/3/4 program variants
 *  (matched on raw bytes — SD Gundam GX's title is half-width katakana). */
const ascii = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0));
/** Header titles of memory-pak slot carts (BSC-1A5M family) that carry more
 *  than 2 MiB of ROM and bank the excess at $80-$9F. */
const EXTENDED_HIGH_BANK_TITLES: readonly (readonly number[])[] = [ascii("SOUND NOVEL-TCOOL")];

const DSP_VARIANT_TITLES: readonly { variant: number; bytes: readonly number[] }[] = [
  { variant: 2, bytes: ascii("DUNGEON MASTER") },
  { variant: 3, bytes: [0x53, 0x44, 0xb6, 0xde, 0xdd, 0xc0, 0xde, 0xd1, 0x47, 0x58] }, // SD Gundam GX
  { variant: 4, bytes: ascii("TOP GEAR 3000") },
  { variant: 4, bytes: ascii("PLANETS CHAMP TG3000") }
];

function dspVariantOf(rom: Uint8Array, headerOffset: number): number | null {
  for (const { variant, bytes } of DSP_VARIANT_TITLES) {
    let match = true;
    for (let i = 0; i < bytes.length; i++) {
      if (rom[headerOffset + i] !== bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return variant;
  }
  return null;
}

export class UnsupportedSnesRomError extends Error {}

/** File offset the emulation RESET vector points at, for a bank-0 target in
 *  the given mapping (each mapping places ROM in bank 0's upper half). */
function resetFileOffset(reset: number, mapping: SnesMapping): number {
  switch (mapping) {
    case "lorom":
      return reset & 0x7fff;
    case "hirom":
      return reset;
    case "exhirom":
      // System banks read the upper chip (ExHiROM's A23 inversion).
      return 0x400000 + reset;
  }
}

/** File offset a 24-bit address decodes to under the given mapping (ROM
 *  regions only; returns -1 for non-ROM targets like bank 0's lower half). */
function addrFileOffset(bank: number, addr: number, mapping: SnesMapping): number {
  switch (mapping) {
    case "lorom":
      return addr >= 0x8000 || (bank & 0x7f) >= 0x40 ? ((bank & 0x7f) << 15) | (addr & 0x7fff) : -1;
    case "hirom":
      return addr >= 0x8000 || (bank & 0x7f) >= 0x40 ? ((bank & 0x3f) << 16) | addr : -1;
    case "exhirom": {
      if (addr < 0x8000 && (bank & 0x7f) < 0x40) return -1;
      const linear = ((bank & 0x3f) << 16) | addr;
      return bank & 0x80 ? linear : 0x400000 + linear;
    }
  }
}

/** True when the RESET vector points at a plausible native-mode entry — a
 *  CLC/XCE pair ($18 $FB) within the first few bytes, following at most one
 *  leading JMP/JML/BRA hop (some entries jump before switching modes). Lets
 *  a cart whose internal header is otherwise blank (unlicensed Wisdom Tree
 *  boards such as Super Noah's Ark 3D carry no checksum or title) still be
 *  recognised, and distinguishes the wiring when a valid header sits at a
 *  location that contradicts the board (Batman - Revenge of the Joker). */
function hasResetRoutine(rom: Uint8Array, offset: number, mapping: SnesMapping): boolean {
  if (offset + 0x40 > rom.length) return false;
  const reset = rom[offset + 0x3c]! | (rom[offset + 0x3d]! << 8);
  if (reset < 0x8000) return false;
  return hasClcXce(rom, resetFileOffset(reset, mapping), mapping, 1);
}

function hasClcXce(rom: Uint8Array, base: number, mapping: SnesMapping, hops: number): boolean {
  if (base < 0 || base + 48 > rom.length) return false;
  for (let i = 0; i < 46; i++) {
    if (rom[base + i] === 0x18 && rom[base + i + 1] === 0xfb) return true;
  }
  if (hops <= 0) return false;
  const op = rom[base]!;
  if (op === 0x4c) {
    // JMP abs — stays in the entry bank (0 for the reset vector)
    return hasClcXce(rom, addrFileOffset(0, rom[base + 1]! | (rom[base + 2]! << 8), mapping), mapping, hops - 1);
  }
  if (op === 0x5c) {
    // JML long
    const addr = rom[base + 1]! | (rom[base + 2]! << 8);
    return hasClcXce(rom, addrFileOffset(rom[base + 3]!, addr, mapping), mapping, hops - 1);
  }
  if (op === 0x80) {
    // BRA — relative within the same file region
    return hasClcXce(rom, base + 2 + ((rom[base + 1]! << 24) >> 24), mapping, hops - 1);
  }
  return false;
}

/** Score one candidate header location on internal consistency. */
function scoreHeader(rom: Uint8Array, offset: number, mapping: SnesMapping): number {
  if (offset + 0x40 > rom.length) return -1;
  let score = 0;

  const checksum = rom[offset + 0x1e]! | (rom[offset + 0x1f]! << 8);
  const complement = rom[offset + 0x1c]! | (rom[offset + 0x1d]! << 8);
  if ((checksum ^ complement) === 0xffff) score += 8;

  const mode = rom[offset + 0x15]!;
  if (MODE_NIBBLES[mapping].includes(mode & 0x0f)) score += 4;
  if ((mode & 0xe0) === 0x20) score += 1; // fixed 001x pattern of the mode byte

  // Emulation-mode RESET vector (header base + $3C) must point into the
  // upper half of bank 0, where every mapping places ROM.
  const reset = rom[offset + 0x3c]! | (rom[offset + 0x3d]! << 8);
  if (reset >= 0x8000) score += 2;

  let printable = 0;
  for (let i = 0; i < 21; i++) {
    const c = rom[offset + i]!;
    if (c >= 0x20 && c <= 0x7e) printable++;
  }
  if (printable === 21) score += 2;

  const romSize = rom[offset + 0x17]!;
  if (romSize >= 0x05 && romSize <= 0x0f) score += 1;

  return score;
}

/** Parse a `.sfc` / `.smc` image. Throws {@link UnsupportedSnesRomError} when
 *  no plausible internal header exists (not an SNES ROM) or the cart needs a
 *  coprocessor that isn't emulated. */
export function parseSnesRom(bytes: Uint8Array): SnesRom {
  if (bytes.length < 0x8000) throw new UnsupportedSnesRomError("file too small for an SNES ROM");

  // 512-byte copier header: dumps are otherwise 32 KiB multiples (or at
  // least land on a 1 KiB boundary; the +512 offset is unambiguous).
  const rom = bytes.length % 0x8000 === 512 ? bytes.subarray(512) : bytes;

  let best: { offset: number; mapping: SnesMapping; score: number } | null = null;
  for (const { offset, mapping } of HEADER_CANDIDATES) {
    const score = scoreHeader(rom, offset, mapping);
    // Strictly-greater keeps the earlier candidate on ties — LoROM is the
    // more common board and the tie means the evidence didn't disambiguate.
    if (score > (best?.score ?? -1)) best = { offset, mapping, score };
  }
  // A checksum-valid header block proves where the header data lives, not
  // how the board decodes addresses: a few boards carry a header at a
  // location that contradicts their wiring (Batman - Revenge of the Joker is
  // LoROM with a HiROM-located header). When the winning candidate's own
  // reset vector doesn't reach boot code but exactly one other mapping's
  // does, trust the executable mapping and keep the header block's metadata.
  if (best && best.score >= 8 && !hasResetRoutine(rom, best.offset, best.mapping)) {
    const executable = HEADER_CANDIDATES.filter(
      (c) => c.mapping !== best!.mapping && hasResetRoutine(rom, c.offset, c.mapping)
    );
    if (executable.length === 1) {
      best = { offset: best.offset, mapping: executable[0]!.mapping, score: best.score };
    }
  }
  if (!best || best.score < 8) {
    // Scoring was inconclusive (unlicensed carts like Super Noah's Ark 3D
    // carry no checksum or title). Fall back to the candidate whose RESET
    // vector lands on a native-mode entry routine — a real ROM has one, and
    // this ignores the low-nibble mode bonus that an all-zero header earns.
    const withRoutine = HEADER_CANDIDATES.find((c) => hasResetRoutine(rom, c.offset, c.mapping));
    if (!withRoutine) {
      throw new UnsupportedSnesRomError("no plausible SNES internal header found");
    }
    best = { offset: withRoutine.offset, mapping: withRoutine.mapping, score: best?.score ?? 0 };
  }

  const h = best.offset;
  let title = "";
  for (let i = 0; i < 21; i++) {
    const c = rom[h + i]!;
    title += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : " ";
  }
  title = title.trim();

  const mode = rom[h + 0x15]!;
  const chipset = rom[h + 0x16]!;
  const ramExponent = rom[h + 0x18]!;
  const country = rom[h + 0x19]!;

  const hasCoprocessor = (chipset & 0x0f) >= 0x03;
  // $F3 is the Capcom Cx4 (Mega Man X2/X3); it otherwise falls in the broad
  // "custom" high-nibble bucket alongside SPC7110 / ST01x.
  const coprocessor: SnesCoprocessor | null = hasCoprocessor
    ? chipset === 0xf3
      ? "cx4"
      : (COPROCESSORS[chipset >> 4] ?? (chipset >> 4 === 0xf ? "custom" : "other"))
    : null;
  if (coprocessor === "dsp") {
    // DSP-1 is emulated; the header can't distinguish the four DSP program
    // variants, so the handful of DSP-2/3/4 games (different programs on
    // the same chip) are identified by their known header titles.
    const variant = dspVariantOf(rom, h);
    if (variant !== null) {
      throw new UnsupportedSnesRomError(`cart needs an unemulated coprocessor (dsp${variant})`);
    }
  } else if (
    coprocessor &&
    coprocessor !== "sa1" &&
    coprocessor !== "superfx" &&
    coprocessor !== "sdd1" &&
    coprocessor !== "cx4" &&
    coprocessor !== "obc1" &&
    coprocessor !== "srtc"
  ) {
    throw new UnsupportedSnesRomError(`cart needs an unemulated coprocessor (${coprocessor})`);
  }

  // Chipset low nibble: 2 = ROM+RAM+battery, 5 = +coprocessor variant,
  // 6 = battery without RAM (RTC-style), 9/A = battery variants.
  const battery = [0x02, 0x05, 0x06, 0x09, 0x0a].includes(chipset & 0x0f);

  // SuperFX boards declare their game-pak RAM in the expansion-RAM byte
  // ($FFBD); early carts (Star Fox) leave it unset — they carry 32 KiB.
  let sramSize = ramExponent > 0 ? 1024 << ramExponent : 0;
  if (coprocessor === "superfx") {
    const exram = rom[h - 3]!;
    sramSize = exram > 0 && exram <= 7 ? 1024 << exram : 0x8000;
  }
  // The OBC1's register file lives at $1FF0-$1FF6 of its 8 KiB SRAM window
  // and scatters into $1800/$1C00; the chip always carries the full 8 KiB
  // regardless of what the header's RAM byte claims.
  if (coprocessor === "obc1" && sramSize < 0x2000) sramSize = 0x2000;

  const matchesTitle = (bytes: readonly number[]): boolean => {
    for (let i = 0; i < bytes.length; i++) if (rom[h + i] !== bytes[i]) return false;
    return true;
  };
  const extendedHighBanks =
    best.mapping === "lorom" && rom.length > 0x200000 && EXTENDED_HIGH_BANK_TITLES.some(matchesTitle);

  return {
    rom,
    mapping: best.mapping,
    fastRom: (mode & 0x10) !== 0,
    title,
    chipset,
    coprocessor,
    sramSize,
    battery,
    headerRomSize: 1024 << rom[h + 0x17]!,
    region: NTSC_COUNTRIES.has(country) ? "ntsc" : "pal",
    country,
    version: rom[h + 0x1b]!,
    headerOffset: h,
    extendedHighBanks
  };
}
