/**
 * Game Boy cheat-code decoders.
 *
 * Two formats are supported, both widely used on classic DMG / CGB games:
 *
 *   Game Genie (Galoob, 1991) — patches ROM reads.
 *     Code layout: `ghi-jkl-mno` where each letter is a hex digit.
 *       - `gh`      → replacement byte
 *       - `lijk`    → address, XOR 0xF000 (the top nibble is complemented)
 *       - `mo`      → compare byte, rotated right by 2, XOR 0xBA
 *       - `n`       → unused "mystery" check digit, ignored by real hardware
 *     6-digit variant (`ghi-jkl`) skips the compare check. Addresses outside
 *     0x0000..0x7FFF are rejected because Game Genie sits between the cart
 *     ROM and the CPU — it cannot patch RAM.
 *
 *   Game Shark / Pro Action Replay — writes RAM once per frame.
 *     Code layout: `ttvvaaaa` (8 hex digits).
 *       - `tt`      → type byte (0x01 = standard 8-bit write; we accept all)
 *       - `vv`      → value written
 *       - `aaaa`    → address, little-endian (low byte first)
 */

export type CheatFormat = "game-genie" | "game-shark";

export interface DecodedCheat {
  format: CheatFormat;
  address: number;
  value: number;
  compare?: number; // Game Genie only, when 9-digit code supplied
  type?: number; // Game Shark type byte (informational)
}

/** Rotate an 8-bit value right by n bits. */
function ror8(v: number, n: number): number {
  return ((v >> n) | (v << (8 - n))) & 0xff;
}

/** Normalise a user-typed code: strip whitespace/dashes, uppercase hex. */
function normalise(code: string): string {
  return code.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

function decodeGameGenie(clean: string): DecodedCheat | null {
  if (clean.length !== 6 && clean.length !== 9) return null;
  const digits: number[] = [];
  for (const ch of clean) {
    const n = parseInt(ch, 16);
    if (Number.isNaN(n)) return null;
    digits.push(n);
  }
  const d = digits as [number, number, number, number, number, number, number?, number?, number?];

  const value = ((d[0] << 4) | d[1]) & 0xff;
  const address = (((d[5] << 12) | (d[2] << 8) | (d[3] << 4) | d[4]) ^ 0xf000) & 0xffff;
  if (address >= 0x8000) return null; // Game Genie only patches ROM reads.

  if (clean.length === 6) return { format: "game-genie", address, value };

  const m = d[6]!,
    o = d[8]!;
  const raw = ((m << 4) | o) & 0xff;
  const compare = ror8(raw, 2) ^ 0xba;
  return { format: "game-genie", address, value, compare };
}

function decodeGameShark(clean: string): DecodedCheat | null {
  if (clean.length !== 8) return null;
  const type = parseInt(clean.slice(0, 2), 16);
  const value = parseInt(clean.slice(2, 4), 16);
  const aLo = parseInt(clean.slice(4, 6), 16);
  const aHi = parseInt(clean.slice(6, 8), 16);
  if ([type, value, aLo, aHi].some(Number.isNaN)) return null;
  const address = ((aHi << 8) | aLo) & 0xffff;
  return { format: "game-shark", address, value, type };
}

/**
 * Decode a user-typed code. Accepts Game Genie (6 or 9 hex chars after
 * stripping dashes/spaces) or Game Shark (8 hex chars). Returns null on
 * any parse error so callers can show a single "bad code" message.
 */
export function decodeCheat(code: string): DecodedCheat | null {
  const clean = normalise(code);
  switch (clean.length) {
    case 6:
    case 9:
      return decodeGameGenie(clean);
    case 8:
      return decodeGameShark(clean);
    default:
      return null;
  }
}

/** Canonical display form: add dashes in the Game Genie pattern for
 *  9-digit codes, leave Game Shark / 6-digit as-is (capitalised). */
export function formatCode(code: string): string {
  const clean = normalise(code);
  if (clean.length === 9) return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6, 9)}`;
  if (clean.length === 6) return `${clean.slice(0, 3)}-${clean.slice(3, 6)}`;
  return clean;
}
