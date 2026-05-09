/**
 * Public entry point for the engine published on npm as `glowboot/gb`.
 *
 * The engine is host-agnostic: zero dependencies, no DOM access, no
 * timers, no I/O. Embed it by constructing a `GameBoy` from raw ROM
 * bytes, calling `runFrame()` at whatever cadence your host can
 * provide, and reading the framebuffer / audio ring out of `gb.ppu`
 * and `gb.apu` as needed.
 *
 * Minimal hello-world:
 *
 *   import { GameBoy, FRAMES_PER_SEC } from "glowboot/gb";
 *
 *   const rom = await (await fetch("tetris.gb")).arrayBuffer();
 *   const gb = new GameBoy(new Uint8Array(rom));
 *   setInterval(() => gb.runFrame(), 1000 / FRAMES_PER_SEC);
 *   // …draw `gb.ppu.framebuffer` to a canvas, schedule audio, etc.
 */

// Core
export { GameBoy, CPU_CLOCK_HZ, FRAMES_PER_SEC } from "./gameboy.js";

// Cartridge
export { Cartridge, type MBCType } from "./cartridge/cartridge.js";

// Display
export { SCREEN_WIDTH, SCREEN_HEIGHT } from "./ppu/ppu.js";

// Input
export { Joypad, type Button } from "./joypad/joypad.js";

// Serial / link cable
export { NO_LINK, type SerialLink } from "./memory/serial-link.js";

// Memory bus (advanced — exposed for tooling that needs to peek/poke)
export type { MMU } from "./memory/mmu.js";

// Printer
export { Printer, type PrintedPage } from "./printer/printer.js";

// Cheats
export { decodeCheat, formatCode } from "./cheats/codec.js";
export { newCheatId, type CheatEntry } from "./cheats/manager.js";

// Debugger — breakpoints / watchpoints
export {
  addPcBreakpoint,
  removePcBreakpoint,
  togglePcBreakpoint,
  hasPcBreakpoint,
  listPcBreakpoints,
  addReadWatchpoint,
  removeReadWatchpoint,
  listReadWatchpoints,
  addWriteWatchpoint,
  removeWriteWatchpoint,
  listWriteWatchpoints,
  clearAll,
  peekHit,
  takeHit,
  type BreakpointHit
} from "./debug/breakpoints.js";

// Debugger — disassembly, symbols, call stack
export { decode } from "./debug/disassembler.js";
export { frameList } from "./debug/call-stack.js";
export {
  addressFor,
  symbolFor,
  loadSymbols,
  clearSymbols,
  hasSymbols,
  symbolCount,
  sourceLabel,
  allSymbols
} from "./debug/symbols.js";

// State serialization
export { StateReader, StateWriter, STATE_VERSION } from "./serialization/serialization.js";
