import type { Region } from "../../nes";

/**
 * Best-guess NES TV system for a freshly loaded cart, in priority order:
 *
 *   1. iNES PAL header flag (when a dump actually sets it)
 *   2. ROM filename region tag — "(Europe)" / "(E)" / "(Australia)" → PAL
 *      (No-Intro / GoodNES convention)
 *   3. NTSC
 *
 * NTSC is the default because the overwhelming majority of NES software (and
 * essentially all homebrew / test ROMs) is 60 Hz, and the iNES header's *NTSC*
 * flag is just the unset default (0), not a positive signal — so an untagged
 * cart is far more likely NTSC than PAL even on a PAL-region browser. Real PAL
 * releases set the header flag or carry a "(Europe)"-style tag. The cart-info
 * per-game override is the authoritative backstop when the guess is wrong.
 */

/** Parenthesised filename tags that imply 50 Hz PAL hardware. */
const PAL_FILENAME_TAG =
  /\((?:E|EU|Europe|PAL|A|Australia|UK|Germany|France|Italy|Spain|Sweden|Netherlands|Finland|Denmark|Norway)\)/i;

export function detectNesRegion(headerRegion: Region, filename: string | undefined): Region {
  if (headerRegion === "pal") return "pal";
  if (filename && PAL_FILENAME_TAG.test(filename)) return "pal";
  return "ntsc";
}
