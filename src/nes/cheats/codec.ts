/**
 * NES cheat-code decoders.
 *
 * Two formats are supported:
 *
 *   Game Genie (Galoob) — patches PRG-ROM reads at $8000-$FFFF. The classic
 *     NES code is six or eight LETTERS drawn from the 16-letter alphabet
 *     `APZLGITYEOXUKSVN` (each letter is one hex nibble). The nibbles are
 *     bit-scrambled into a 15-bit address (always in $8000-$FFFF) plus an 8-bit
 *     replacement value; the eight-letter variant adds a compare byte so the
 *     patch only fires when the bank currently mapped there holds that value
 *     (lets a code target one bank of a multi-bank game). Decode validated
 *     against the documented SMB code `SXIOPO` → $91D9 / $AD.
 *
 *   Raw (Game Shark / Pro Action Replay style) — `AAAA:VV` or `AAAA:VV:CC`
 *     (hex). An address in $8000-$FFFF is a ROM patch (compare honoured); a
 *     lower address is a RAM freeze written every frame (internal RAM at
 *     $0000-$07FF, cart PRG-RAM at $6000-$7FFF).
 */

export type CheatFormat = "game-genie" | "game-shark";

export interface DecodedCheat {
  format: CheatFormat;
  address: number;
  value: number;
  compare?: number;
}

/** Game Genie letter alphabet — index is the hex nibble (A=0 … N=15). */
const GG_ALPHABET = "APZLGITYEOXUKSVN";

function decodeGameGenie(letters: string): DecodedCheat | null {
  if (letters.length !== 6 && letters.length !== 8) return null;
  const n: number[] = [];
  for (const ch of letters) {
    const v = GG_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n.push(v);
  }

  const address =
    0x8000 |
    ((n[3]! & 7) << 12) |
    ((n[5]! & 7) << 8) |
    ((n[4]! & 8) << 8) |
    ((n[2]! & 7) << 4) |
    ((n[1]! & 8) << 4) |
    (n[4]! & 7) |
    (n[3]! & 8);

  if (letters.length === 6) {
    const value = ((n[1]! & 7) << 4) | ((n[0]! & 8) << 4) | (n[0]! & 7) | (n[5]! & 8);
    return { format: "game-genie", address, value };
  }

  const value = ((n[1]! & 7) << 4) | ((n[0]! & 8) << 4) | (n[0]! & 7) | (n[7]! & 8);
  const compare = ((n[7]! & 7) << 4) | ((n[6]! & 8) << 4) | (n[6]! & 7) | (n[5]! & 8);
  return { format: "game-genie", address, value, compare };
}

function decodeRaw(code: string): DecodedCheat | null {
  const m = /^([0-9A-F]{4}):([0-9A-F]{2})(?::([0-9A-F]{2}))?$/.exec(code);
  if (!m) return null;
  const address = parseInt(m[1]!, 16);
  const value = parseInt(m[2]!, 16);
  const compare = m[3] !== undefined ? parseInt(m[3], 16) : undefined;
  // $8000+ is a ROM patch (compare honoured); below it is a RAM freeze.
  const format: CheatFormat = address >= 0x8000 ? "game-genie" : "game-shark";
  return compare !== undefined ? { format, address, value, compare } : { format, address, value };
}

/**
 * Decode a user-typed NES cheat. Accepts a Game Genie letter code (6 or 8
 * letters, dashes/spaces ignored) or a raw `AAAA:VV[:CC]` hex code. Returns
 * null on any parse error so callers can show a single "bad code" message.
 */
export function decodeCheat(code: string): DecodedCheat | null {
  const trimmed = code.trim().toUpperCase();
  if (trimmed.includes(":")) return decodeRaw(trimmed.replace(/\s/g, ""));
  const letters = trimmed.replace(/[^A-Z]/g, "");
  return decodeGameGenie(letters);
}

/** Canonical display form — Game Genie letters upper-cased with no dashes (the
 *  NES convention), raw codes upper-cased. */
export function formatCode(code: string): string {
  const trimmed = code.trim().toUpperCase();
  if (trimmed.includes(":")) return trimmed.replace(/\s/g, "");
  return trimmed.replace(/[^A-Z]/g, "");
}
