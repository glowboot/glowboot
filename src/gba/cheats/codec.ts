/**
 * GBA cheat-code decoder. Two formats are accepted:
 *
 *   1. Raw RAM-poke   `AAAAAAAA:VV[VV[VVVV]]` — Glowboot-native
 *      format used by the memory scanner, .cht imports we generated
 *      ourselves, and copy-paste from cheat sites that already
 *      decoded the published codes. `AAAAAAAA` is the 32-bit target
 *      (usually inside EWRAM `0x02xxxxxx` or IWRAM `0x03xxxxxx`),
 *      followed by an 8 / 16 / 32-bit value. Multiple codes can
 *      live on the cart but each entry stores ONE.
 *
 *   2. CodeBreaker     `AAAAAAAA VVVV` (or `AAAAAAAA+VVVV`) —
 *      libretro DB's GBA format. A 32-bit "op1" carrying a 4-bit
 *      type in the high nibble plus a 28-bit address, and a 16-bit
 *      "op2" carrying the operand. Most cheats in the libretro
 *      database are these; we decode the supported subset:
 *        - type 3   → 8-bit RAM write
 *        - type 4/8 → 16-bit RAM write
 *        - type 0   → game-ID metadata, accepted as a no-op
 *        - type 1   → instruction-pointer hook; libretro DB ships
 *                     these as pre-decoded "enable codes" that
 *                     accompany every cheat, so we also accept them
 *                     as no-ops to keep multi-code imports clean
 *      Conditional / AND-OR / encrypted types we don't model return
 *      null and surface as a "skipped N codes" toast in the importer.
 *
 * Encrypted formats (Action Replay v1/v2/v3, GameShark, raw CodeBreaker
 * with the cart's encryption key in play) are NOT supported because
 * the libretro database — the main source for published GBA cheats —
 * stores them already decrypted. Codes copied from forum sites are
 * almost always in one of the two formats above already; a user with
 * raw-encrypted AR codes can decrypt them with any of the published
 * online tools and paste the result.
 *
 * Address normalisation: leading `0x` is allowed, whitespace + dashes
 * stripped. Width is inferred from the value half — users can paste
 * codes copied from forums without re-typing.
 */

export type GbaCheatWidth = 8 | 16 | 32;

export interface DecodedGbaCheat {
  address: number;
  value: number;
  width: GbaCheatWidth;
}

/** A no-op decoded cheat — emitted by CodeBreaker type 0 (game ID)
 *  codes so the import flow doesn't reject them. Skipped at apply
 *  time. */
const NOOP: DecodedGbaCheat = { address: 0, value: 0, width: 8 };

/** True if a decoded entry is the placeholder no-op the type-0 game-
 *  ID code emits. The cheat manager filters these out before each
 *  per-frame apply pass. */
export function isNoopGbaCheat(d: DecodedGbaCheat): boolean {
  return d.address === 0 && d.value === 0 && d.width === 8;
}

function normalise(code: string): string {
  return code.replace(/0x/gi, "").replace(/[\s-]/g, "").toUpperCase();
}

/** Parse a single cheat code. Returns null on any parse error so the
 *  UI shows one "bad code" message regardless of which half was wrong.
 *  Tries raw `:` format first, then CodeBreaker `+` / unseparated
 *  12-hex-char form. */
export function decodeGbaCheat(code: string): DecodedGbaCheat | null {
  return decodeRaw(code) ?? decodeCodeBreaker(code);
}

/** Canonical display form for raw codes: zero-pad the address to 8
 *  hex digits, the value to its width, and join with a colon. Lets
 *  the popover render user-typed codes consistently regardless of
 *  input spacing. */
export function formatGbaCheat(decoded: DecodedGbaCheat): string {
  const a = decoded.address.toString(16).toUpperCase().padStart(8, "0");
  const vDigits = decoded.width / 4;
  const v = decoded.value.toString(16).toUpperCase().padStart(vDigits, "0");
  return `${a}:${v}`;
}

// ─── Raw format (Glowboot native) ─────────────────────────────────

function decodeRaw(code: string): DecodedGbaCheat | null {
  if (!code.includes(":")) return null;
  const clean = normalise(code);
  const colon = clean.indexOf(":");
  if (colon < 0) return null;
  const addrPart = clean.slice(0, colon);
  const valPart = clean.slice(colon + 1);
  if (addrPart.length === 0 || valPart.length === 0) return null;
  if (addrPart.length > 8 || !/^[0-9A-F]+$/.test(addrPart)) return null;
  const address = parseInt(addrPart, 16);
  if (!Number.isFinite(address)) return null;
  let width: GbaCheatWidth;
  if (valPart.length === 2) width = 8;
  else if (valPart.length === 4) width = 16;
  else if (valPart.length === 8) width = 32;
  else return null;
  if (!/^[0-9A-F]+$/.test(valPart)) return null;
  const value = parseInt(valPart, 16);
  if (!Number.isFinite(value)) return null;
  return { address: address >>> 0, value: value >>> 0, width };
}

// ─── CodeBreaker (libretro DB GBA format) ──────────────────────────

/** Type byte (high nibble of op1) for the CodeBreaker opcodes we
 *  decode into Glowboot's per-frame RAM-write cheat model. Anything
 *  else returns null and is logged by the importer. */
const CB_TYPE_GAME_ID = 0x0; // metadata; emit NOOP
const CB_TYPE_HOOK = 0x1; // instruction-pointer hook; NOOP for pre-decoded codes
const CB_TYPE_ASSIGN_1 = 0x3; // 8-bit RAM write
const CB_TYPE_FILL = 0x4; // 16-bit fill — treated as ASSIGN_2 (single-shot)
const CB_TYPE_ASSIGN_2 = 0x8; // 16-bit RAM write

function decodeCodeBreaker(code: string): DecodedGbaCheat | null {
  // Strip 0x prefixes and any whitespace / dash / plus separator. The
  // libretro DB joins multi-line cheats with `+`; the .cht parser has
  // already split those into individual `AAAAAAAA+VVVV` chunks where
  // the inner `+` separates op1 from op2.
  const clean = code
    .replace(/0x/gi, "")
    .replace(/[\s\-+]/g, "")
    .toUpperCase();
  if (clean.length !== 12 || !/^[0-9A-F]+$/.test(clean)) return null;
  const op1 = parseInt(clean.slice(0, 8), 16);
  const op2 = parseInt(clean.slice(8, 12), 16);
  if (!Number.isFinite(op1) || !Number.isFinite(op2)) return null;
  const type = (op1 >>> 28) & 0xf;
  const address = op1 & 0x0fffffff;
  switch (type) {
    case CB_TYPE_GAME_ID:
    case CB_TYPE_HOOK:
      // Game-ID / master / hook codes — real CodeBreaker hardware
      // uses them to set the encryption key and the instruction-
      // pointer hook for conditional execution. For libretro's pre-
      // decrypted codes these are pure metadata: they verify the
      // right cart is loaded but don't write anything to RAM. Both
      // codes accompany every published cheat as the "enable code",
      // so accepting them as NOOPs lets multi-code imports succeed
      // without spurious "skipped N codes" messages.
      return NOOP;
    case CB_TYPE_ASSIGN_1:
      return { address: address >>> 0, value: op2 & 0xff, width: 8 };
    case CB_TYPE_ASSIGN_2:
    case CB_TYPE_FILL:
      return { address: address >>> 0, value: op2 & 0xffff, width: 16 };
    default:
      // Conditional, AND/OR, encrypted — not supported. Caller
      // surfaces a "skipped N codes" toast.
      return null;
  }
}
