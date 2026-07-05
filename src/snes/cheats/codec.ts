/**
 * SNES cheat-code decoders.
 *
 * Two formats are supported:
 *
 *   Game Genie (Galoob) — `XXXX-YYYY`, eight characters from the 16-letter
 *     alphabet `DF4709156BC8A23E` (each character is one hex nibble; the
 *     alphabet position IS the nibble value). The first two nibbles are the
 *     replacement byte; the remaining six form a bit-scrambled 24-bit SNES
 *     bus address: with the raw nibbles read as `ijkl qrst uvwx abcd efgh
 *     mnop`, the real address is `abcd efgh ijkl mnop qrst uvwx`. Game Genie
 *     codes always patch ROM reads.
 *
 *   Raw (Pro Action Replay style) — `AAAAAAVV` (8 hex digits, an optional
 *     `:` or `-` before the value byte). A 24-bit SNES bus address plus the
 *     value. Addresses in WRAM or cartridge SRAM become per-frame RAM
 *     freezes; ROM-range addresses behave as read patches, matching how
 *     cartridge devices intercepted the bus.
 */

export type CheatFormat = "game-genie" | "pro-action-replay";

export interface DecodedCheat {
  format: CheatFormat;
  /** 24-bit SNES bus address. */
  address: number;
  value: number;
}

/** Game Genie character set — the string position is the hex value. */
const GG_ALPHABET = "DF4709156BC8A23E";

function decodeGameGenie(code: string): DecodedCheat | null {
  const compact = code.replace(/-/g, "");
  if (compact.length !== 8) return null;
  const n: number[] = [];
  for (const ch of compact) {
    const v = GG_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n.push(v);
  }
  const value = (n[0]! << 4) | n[1]!;
  // Raw nibbles n2..n7 = ijkl qrst uvwx abcd efgh mnop → abcdefgh ijklmnop qrstuvwx
  const address = (n[5]! << 20) | (n[6]! << 16) | (n[2]! << 12) | (n[7]! << 8) | (n[3]! << 4) | n[4]!;
  return { format: "game-genie", address, value };
}

function decodeRaw(code: string): DecodedCheat | null {
  const compact = code.replace(/[:\-\s]/g, "");
  if (!/^[0-9A-F]{8}$/.test(compact)) return null;
  const address = parseInt(compact.slice(0, 6), 16);
  const value = parseInt(compact.slice(6), 16);
  return { format: "pro-action-replay", address, value };
}

/** Whether a decoded address targets writable memory (WRAM / SRAM windows)
 *  — a per-frame freeze — as opposed to a ROM read patch. */
export function isRamAddress(address: number): boolean {
  const bank = (address >> 16) & 0xff;
  const off = address & 0xffff;
  if (bank === 0x7e || bank === 0x7f) return true;
  const sysBank = bank & 0x7f;
  if (sysBank <= 0x3f && off < 0x2000) return true; // WRAM mirror
  if (sysBank <= 0x3f && off >= 0x6000 && off < 0x8000) return true; // HiROM SRAM window
  if (sysBank >= 0x70 && sysBank <= 0x7d && off < 0x8000) return true; // LoROM SRAM
  return false;
}

/** Decode a user-typed cheat string. The Game Genie alphabet consists
 *  entirely of hex characters, so the `XXXX-YYYY` dash shape is the only
 *  reliable discriminator — exactly the convention cheat databases use.
 *  Undashed 8-digit codes are raw Pro-Action-Replay `AAAAAAVV`. */
export function decodeCheat(input: string): DecodedCheat | null {
  const code = input.trim().toUpperCase();
  if (code.length === 0) return null;
  if (/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(code)) return decodeGameGenie(code);
  return decodeRaw(code);
}

/** Normalise a code string for display (keep the GG dash, strip other
 *  separators). */
export function formatCode(input: string): string {
  const code = input.trim().toUpperCase().replace(/\s+/g, "");
  if (/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(code)) return code;
  return code.replace(/[:\-]/g, "");
}
