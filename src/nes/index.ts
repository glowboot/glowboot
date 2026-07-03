/**
 * NES engine — public entry point.
 *
 * Pure TypeScript, host-agnostic (no DOM / fetch / storage — enforced by
 * `src/nes/tsconfig.json`), parallel to `src/gb/` and `src/gba/`. The browser
 * shell in `src/ui/` bridges it to the page (load / render / input / pacing,
 * save states, save RAM, cheats, debugger).
 *
 * Build order (test-ROM-driven, each stage gated on its reference suite):
 *   1. cartridge/  — iNES / NES 2.0 parsing + mapper dispatch        ← done
 *   2. cpu/        — 6502 (Ricoh 2A03), nestest + instr_test-v5      ← done
 *   3. ppu/        — 2C02: registers, scroll, timing, BG + sprite
 *                    pipeline (sprite-hit suite passes)              ← done
 *   4. mappers/    — NROM, MMC1, UxROM, CNROM, AxROM, MMC3, and the
 *                    rest of the mainstream library (~57 mappers)    ← done
 *   5. browser     — src/ui bridge: load/render/input/pace .nes       ← done
 *   6. apu/        — 2A03 audio, validated against blargg apu tests  ← done
 *   7. serialization — save states (NES_STATE_VERSION) + battery RAM ← done
 *
 * The console is assembled in nes.ts (CPU + PPU + APU + cartridge + clock);
 * playable in the browser via src/ui (joypad + onFrame + speedMultiplier).
 */

export { parseNesRom } from "./cartridge/rom.js";
export type { Mirroring, NesRom } from "./cartridge/rom.js";
export { type CheatFormat, decodeCheat, type DecodedCheat, formatCode } from "./cheats/codec.js";
export { type CheatEntry, CheatManager, newCheatId } from "./cheats/manager.js";
// Debugger — breakpoints / watchpoints
export {
  addPcBreakpoint,
  addReadWatchpoint,
  addWriteWatchpoint,
  type BreakpointHit,
  clearAll as clearBreakpoints,
  hasPcBreakpoint,
  hasReadWatchpoint,
  hasWriteWatchpoint,
  listPcBreakpoints,
  listReadWatchpoints,
  listWriteWatchpoints,
  peekHit,
  removePcBreakpoint,
  removeReadWatchpoint,
  removeWriteWatchpoint,
  takeHit,
  togglePcBreakpoint
} from "./debug/breakpoints.js";
// Debugger — disassembly, call stack, symbols
export { type CallFrame, frameList } from "./debug/call-stack.js";
export { type DecodedInstruction, decode } from "./debug/disassembler.js";
export {
  addressFor,
  allSymbols,
  clearSymbols,
  hasSymbols,
  loadSymbols,
  type SymbolEntry,
  sourceLabel,
  symbolCount,
  symbolFor
} from "./debug/symbols.js";
export { Joypad, type NesButton } from "./joypad/joypad.js";
export { CPU_CLOCK_HZ, FRAMES_PER_SEC, Nes } from "./nes.js";
export { NES_PALETTE } from "./ppu/palette.js";
export { SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu/ppu.js";
export { type Region, REGION_TIMING, type RegionTiming } from "./region/region.js";
export { NES_STATE_VERSION, UnsupportedNesSaveStateError } from "./serialization/serialization.js";
