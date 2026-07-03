/**
 * Save-state encoding for a runtime-switchable nametable {@link Mirroring}.
 *
 * Kept in its own leaf module (no mapper imports) so the mappers that switch
 * mirroring can use it without importing `mapper.ts` — which imports every
 * mapper class and would form an import cycle that breaks subclass extension.
 */

import type { Mirroring } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";

/** Stable index ↔ Mirroring map. Append-only — never reorder, or old NES save
 *  states would decode the wrong mirroring. */
const MIRRORINGS: readonly Mirroring[] = ["horizontal", "vertical", "single-lower", "single-upper", "four-screen"];

export function writeMirroring(w: NesStateWriter, m: Mirroring): void {
  w.u8(MIRRORINGS.indexOf(m));
}
export function readMirroring(r: NesStateReader): Mirroring {
  return MIRRORINGS[r.u8()] ?? "horizontal";
}
