/**
 * GBA cartridge header (192 bytes at ROM start).
 *
 *   0x000–0x003  ROM entry point (ARM branch)
 *   0x004–0x09F  Nintendo logo (156 bytes, fixed copyright pattern)
 *   0x0A0–0x0AB  Game title (12 ASCII chars, NUL-padded)
 *   0x0AC–0x0AF  Game code (4 ASCII chars, e.g. "BPEE")
 *   0x0B0–0x0B1  Maker code (2 ASCII chars)
 *   0x0B2        Fixed byte 0x96 — the cheapest "is this a GBA ROM?" gate
 *   0x0B3        Main unit code
 *   0x0B4        Device type
 *   0x0B5–0x0BB  Reserved (zero)
 *   0x0BC        Software version
 *   0x0BD        Header checksum: -(0x19 + sum(rom[0xA0..=0xBC])) & 0xFF
 *   0x0BE–0x0BF  Reserved (zero)
 */

export const HEADER_LEN = 192;

const FIXED_BYTE_OFFSET = 0xb2;
const FIXED_BYTE_VALUE = 0x96;
const TITLE_OFFSET = 0xa0;
const TITLE_LEN = 12;
const GAME_CODE_OFFSET = 0xac;
const GAME_CODE_LEN = 4;
const MAKER_CODE_OFFSET = 0xb0;
const MAKER_CODE_LEN = 2;
const VERSION_OFFSET = 0xbc;
const CHECKSUM_OFFSET = 0xbd;
const CHECKSUM_RANGE_START = 0xa0;
const CHECKSUM_RANGE_END = 0xbc;

export interface GbaHeader {
  title: string;
  gameCode: string;
  makerCode: string;
  version: number;
  headerChecksum: number;
  headerChecksumValid: boolean;
}

export function isGbaRom(rom: Uint8Array): boolean {
  return rom.length >= HEADER_LEN && rom[FIXED_BYTE_OFFSET] === FIXED_BYTE_VALUE;
}

function decodeAscii(rom: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const b = rom[offset + i] ?? 0;
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

function computeHeaderChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let i = CHECKSUM_RANGE_START; i <= CHECKSUM_RANGE_END; i++) {
    sum += rom[i] ?? 0;
  }
  return -(sum + 0x19) & 0xff;
}

export function parseGbaHeader(rom: Uint8Array): GbaHeader {
  if (rom.length < HEADER_LEN) {
    throw new Error(`ROM is too small to contain a GBA header (got ${rom.length} bytes, need ${HEADER_LEN})`);
  }
  if (rom[FIXED_BYTE_OFFSET] !== FIXED_BYTE_VALUE) {
    const got = (rom[FIXED_BYTE_OFFSET] ?? 0).toString(16).padStart(2, "0");
    throw new Error(`Not a GBA ROM (fixed byte at 0xB2 is 0x${got}, expected 0x96)`);
  }
  const recordedChecksum = rom[CHECKSUM_OFFSET] ?? 0;
  return {
    title: decodeAscii(rom, TITLE_OFFSET, TITLE_LEN).trim(),
    gameCode: decodeAscii(rom, GAME_CODE_OFFSET, GAME_CODE_LEN),
    makerCode: decodeAscii(rom, MAKER_CODE_OFFSET, MAKER_CODE_LEN),
    version: rom[VERSION_OFFSET] ?? 0,
    headerChecksum: recordedChecksum,
    headerChecksumValid: recordedChecksum === computeHeaderChecksum(rom)
  };
}
