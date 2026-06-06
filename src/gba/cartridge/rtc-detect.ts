/**
 * GBA RTC cart detection table.
 *
 * Carts that ship the Seiko S-3511A real-time-clock chip on their
 * GPIO port. Match is a strict gamecode-prefix check against the
 * 4-character code from the cart header — the per-region suffixes
 * (E/D/S/F/I/J for USA/Germany/Spain/France/Italy/Japan, plus K for
 * Korea on Pokémon) all share the same three-letter franchise tag,
 * so a 3-character prefix gates every region of every shipping
 * version with no false positives across the rest of the GBA library.
 *
 * Carts covered:
 *   • Pokémon Ruby      / Sapphire   — AXVx / AXPx
 *   • Pokémon Emerald                — BPEx
 *   • Pokémon FireRed   / LeafGreen  — BPRx / BPGx
 *   • Boktai 1 / 2 / 3               — U3Ix / U32x / U33x
 *
 * Pokémon use the RTC for berry growth, day/night cycles, and the
 * daily lottery; Boktai uses it together with the solar sensor to
 * gate the in-game time-of-day mechanics. The chip is on the cart
 * either way; whether it's actually consulted is up to the game.
 */

import type { GbaHeader } from "./header.js";

const RTC_PREFIXES: readonly string[] = [
  // Pokémon Gen 3 mainline
  "AXV", // Ruby
  "AXP", // Sapphire
  "BPE", // Emerald
  "BPR", // FireRed
  "BPG", // LeafGreen
  // Boktai trilogy. Konami's `U` series codes for solar carts share
  // the same chip; we include them so the time-of-day mechanic ticks
  // even if a future commit wires the solar sensor separately.
  "U3I", // Boktai: The Sun is in Your Hand
  "U32", // Boktai 2: Solar Boy Django
  "U33" // Shin Bokura no Taiyou: Gyakushuu no Sabata (Boktai 3)
];

/** True for cart gamecodes that ship an S-3511A on their GPIO. */
export function cartHasGpioRtc(header: GbaHeader): boolean {
  return RTC_PREFIXES.some((p) => header.gameCode.startsWith(p));
}
