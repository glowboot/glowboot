/**
 * Barrel export for the GBA engine half.
 *
 * The directory mirrors `src/gb/` and is held to the same no-DOM /
 * no-network / no-storage contract (enforced by `src/gba/tsconfig.json`).
 */

export { type GbaHeader, HEADER_LEN, isGbaRom, parseGbaHeader } from "./cartridge/header.js";
export { decodeGbaCheat, formatGbaCheat, type GbaCheatWidth, isNoopGbaCheat } from "./cheats/codec.js";
export { type GbaCheatEntry, GbaCheatManager, newGbaCheatId } from "./cheats/manager.js";
export {
  addGbaPcBreakpoint,
  addGbaReadWatchpoint,
  addGbaWriteWatchpoint,
  armGbaPassThrough,
  type GbaBreakpointHit,
  type GbaBreakpointKind,
  clearAllGbaBreakpoints,
  hasGbaPcBreakpoint,
  hasGbaReadWatchpoint,
  hasGbaWriteWatchpoint,
  listGbaPcBreakpoints,
  listGbaReadWatchpoints,
  listGbaWriteWatchpoints,
  peekGbaHit,
  removeGbaPcBreakpoint,
  removeGbaReadWatchpoint,
  removeGbaWriteWatchpoint,
  takeGbaHit,
  toggleGbaPcBreakpoint
} from "./debug/breakpoints.js";
export { clearAllGbaFrames, frameListGba, type GbaCallFrame, type GbaFrameKind } from "./debug/call-stack.js";
export { combineThumbBl, decodeArm, type DecodedGbaInstruction, decodeThumb } from "./debug/disassembler.js";
export {
  allGbaSymbols,
  clearGbaSymbols,
  gbaAddressFor,
  gbaSymbolCount,
  gbaSymbolFor,
  gbaSymbolSourceLabel,
  type GbaSymbolEntry,
  hasGbaSymbols,
  loadGbaSymbols
} from "./debug/symbols.js";
export { FRAMES_PER_SEC, Gba } from "./gba.js";
export type { GbaButton } from "./joypad/joypad.js";
export type { MemoryBus } from "./memory/bus.js";
export { SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu/ppu.js";
export { UnsupportedGbaSaveStateError } from "./serialization/serialization.js";
export type { GbaSioLink } from "./sio/sio-link.js";
