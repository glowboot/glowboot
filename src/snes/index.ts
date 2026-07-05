/**
 * SNES engine — public entry point.
 *
 * Pure TypeScript, host-agnostic (no DOM / fetch / storage — enforced by
 * `src/snes/tsconfig.json`), parallel to `src/gb/`, `src/gba/`, and
 * `src/nes/`. The browser shell in `src/ui/` will bridge it through the
 * Platform/adapter registry once the core boots games.
 *
 * Build order (oracle-driven, each stage gated on its reference suite):
 *   1. cartridge/  — .sfc/.smc parsing, LoROM/HiROM header scoring   ← done
 *   2. cpu/        — 65C816 vs SingleStepTests JSON (20k tests/opcode,
 *                    native + emulation mode)                        ← done
 *                    (5.12M vectors pass: final state + cycle counts;
 *                    per-cycle bus-signal order is a later phase)
 *   3. memory/     — system bus, WRAM, DMA, MMIO dispatch          ← done
 *                    (HDMA lands with the PPU's scanline machinery)
 *   4. ppu/        — scanline renderer: modes 0-7 + OBJ + windows +   ← done
 *                    colour math + sub screen + HDMA (mosaic, OPT,
 *                    true hires, interlace, EXTBG pending)
 *   5. apu/        — SPC700 core + S-SMP + IPL-protocol HLE       ← running
 *                    (S-DSP synthesis — the audible part — pending)
 *   6. browser     — Platform record + adapter (README "Adding a console")
 *   7. serialization — save states (SNES_STATE_VERSION) + battery SRAM ← done
 *
 * Coprocessor carts (SA-1, SuperFX, DSP-1, …) are detected and rejected
 * loudly; they are out of scope until the base console is solid.
 */

export { SnesApu } from "./apu/apu.js";
export { Spc700, type Spc700Bus } from "./apu/cpu.js";
export { SnesDsp } from "./apu/dsp.js";
export { Cpu65816, type SnesCpuBus } from "./cpu/cpu.js";
export { type SnesButton, SnesJoypad } from "./joypad/joypad.js";
export { SnesPpu, TOTAL_LINES, VISIBLE_LINES } from "./ppu/ppu.js";
export {
  SNES_STATE_VERSION,
  SnesStateReader,
  SnesStateWriter,
  UnsupportedSnesSaveStateError,
  upgradeSnesState
} from "./serialization/serialization.js";
export {
  addSnesPcBreakpoint,
  armSnesPassThrough,
  checkSnesPc,
  clearAllSnesBreakpoints,
  hasSnesPcBreakpoint,
  listSnesPcBreakpoints,
  peekSnesHit,
  removeSnesPcBreakpoint,
  type SnesBreakpointHit,
  type SnesBreakpointKind,
  takeSnesHit,
  toggleSnesPcBreakpoint
} from "./debug/breakpoints.js";
export { clearAllSnesFrames, frameListSnes, type SnesCallFrame, type SnesFrameKind } from "./debug/call-stack.js";
export {
  allSnesSymbols,
  clearSnesSymbols,
  hasSnesSymbols,
  loadSnesSymbols,
  snesAddressFor,
  snesSymbolCount,
  type SnesSymbolEntry,
  snesSymbolFor,
  snesSymbolSourceLabel
} from "./debug/symbols.js";
export { type CheatFormat, decodeCheat, type DecodedCheat, formatCode } from "./cheats/codec.js";
export { type CheatEntry, CheatManager, newCheatId } from "./cheats/manager.js";
export { Snes } from "./snes.js";
export { type MmioReadHandler, type MmioWriteHandler, SnesBus } from "./memory/bus.js";
export { SnesDma } from "./memory/dma.js";
export {
  parseSnesRom,
  type SnesCoprocessor,
  type SnesMapping,
  type SnesRegion,
  type SnesRom,
  UnsupportedSnesRomError
} from "./cartridge/rom.js";
