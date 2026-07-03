/**
 * NES — the assembled console: wires the 6502, the 2C02 PPU, and the cartridge
 * together, implements the CPU memory map, and drives the master clock.
 *
 * Host-agnostic (no DOM / timers / I/O); the browser shell calls {@link runFrame}
 * once per displayed frame and draws {@link framebuffer}. Three PPU dots tick per
 * CPU cycle (3.2 on PAL, carried fractionally); the PPU's /NMI edge is routed to
 * the CPU between instructions.
 */

import { APU } from "./apu/apu.js";
import { Cartridge } from "./cartridge/cartridge.js";
import type { NesRom } from "./cartridge/rom.js";
import { CheatManager } from "./cheats/manager.js";
import { type Bus, CPU } from "./cpu/cpu.js";
import { armPassThrough, peekHit } from "./debug/breakpoints.js";
import { clear as clearCallStack } from "./debug/call-stack.js";
import { Joypad } from "./joypad/joypad.js";
import { PPU } from "./ppu/ppu.js";
import { type Region, REGION_TIMING, type RegionTiming } from "./region/region.js";
import {
  NES_STATE_VERSION,
  NesStateReader,
  NesStateWriter,
  UnsupportedNesSaveStateError,
  upgradeNesState
} from "./serialization/serialization.js";

/** CPU (Ricoh 2A03, NTSC) clock — master / 12. PAL (2A07) runs slower; per-cart
 *  rates live in {@link RegionTiming}. Kept as the NTSC default for callers that
 *  predate region support. */
export const CPU_CLOCK_HZ = 1_789_773;
export const FRAMES_PER_SEC = 60.0988;

export class Nes {
  readonly cpu: CPU;
  readonly ppu: PPU;
  readonly apu: APU;
  readonly cartridge: Cartridge;
  readonly joypad = new Joypad();
  /** Active Game Genie / RAM cheats. Patches PRG reads + freezes RAM per frame. */
  readonly cheats = new CheatManager();

  /** Called with the completed framebuffer after each frame (browser shell). */
  onFrame: ((framebuffer: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;
  /** Called after each frame with the frame's audio samples (mono, duplicated
   *  into both channels). Null until the host sets it. */
  onAudioFrame: ((left: Float32Array, right: Float32Array, count: number) => void) | null = null;
  /** Turbo / slow-motion multiplier read by the UI pacer (1 = real speed). */
  speedMultiplier = 1;

  private readonly ram = new Uint8Array(0x800);

  private controllerShift = 0;
  private strobe = false;
  // 2A03 CPU data-bus open-bus latch: the last value driven on the bus. Reads of
  // write-only APU ports and unallocated I/O ($4018-$40FF) return it — which is
  // how executing code from that region (cpu_exec_space) fetches the opcode that
  // was last on the bus (the high address byte).
  private cpuBus = 0;

  /** The cart's resolved default TV system — what "Auto" reports and what a
   *  cleared manual override falls back to. Defaults to the header flag, but
   *  the host can pass a better guess (the iNES flag is unreliable, so the
   *  loader also reads the ROM filename's region tag). */
  readonly defaultRegion: Region;
  /** Active NTSC / PAL timing. Set from the cart's header (or the host's
   *  override) in the constructor; switchable live via {@link setRegion}. */
  private timing: RegionTiming = REGION_TIMING.ntsc;
  /** Fractional carry for the PPU-dot clock — PAL runs 3.2 dots per CPU cycle,
   *  so whole dots are emitted and the remainder rolls into the next batch. */
  private ppuDotRemainder = 0;
  /** Whether the mapper implements the per-CPU-cycle hooks — resolved once so
   *  the per-cycle tick path skips the optional-chained calls entirely. */
  private readonly cartHasTick: boolean;
  private readonly cartHasIrq: boolean;

  /** @param defaultRegion the cart's resolved default TV system (header flag
   *  refined by host heuristics such as the ROM filename's region tag). Omit
   *  to use the header. A manual per-game override is layered on by the host
   *  afterwards via {@link setRegion}. */
  constructor(rom: NesRom, defaultRegion?: Region) {
    this.defaultRegion = defaultRegion ?? rom.region;
    this.cartridge = new Cartridge(rom);
    this.cartHasTick = this.cartridge.hasMapperTick;
    this.cartHasIrq = this.cartridge.hasMapperIrq;
    this.ppu = new PPU(this.cartridge);
    const bus: Bus = {
      read: (addr) => this.cpuRead(addr),
      write: (addr, value) => this.cpuWrite(addr, value)
    };
    this.cpu = new CPU(bus);
    // The DMC fetches its samples from CPU space (PRG ROM at $8000-$FFFF).
    this.apu = new APU((addr) => this.cpuRead(addr));
    this.apu.expansion = this.cartridge.expansionAudio();
    this.cpu.reset(); // before onTick is wired, so reset doesn't clock the PPU
    this.ppu.reset();
    this.apu.reset();
    this.setRegion(this.defaultRegion);
    this.cpu.onTick = (cycles) => this.tickPpu(cycles);
    this.ppu.mapperClock = () => this.cartridge.clockIrq();
    // DMC sample DMA: the request edge arms the CPU's read-cycle stall; the
    // stall's get cycle calls back to deliver the byte.
    this.apu.onDmcDmaRequest = (reload) => {
      if (!this.cpu.dmcDmaPending) {
        this.cpu.dmcDmaPending = true;
        this.cpu.dmcDmaReload = reload;
        this.cpu.dmcDmaRequestCycle = this.cpu.cycles;
      }
    };
    this.cpu.onDmcFetch = () => this.apu.dmcDmaFetch();
  }

  /** Cart's active TV system. */
  get region(): Region {
    return this.timing.region;
  }

  /** Host pacer's target frame rate (60.0988 NTSC / 50.0070 PAL). */
  get framesPerSec(): number {
    return this.timing.framesPerSec;
  }

  /** Switch NTSC / PAL timing across the PPU (scanline count), APU (clock,
   *  frame sequencer, period tables), and the PPU-dot ratio. Safe to call
   *  live; the PPU restarts its current frame to stay in range. */
  setRegion(region: Region): void {
    this.timing = REGION_TIMING[region];
    this.ppu.setTiming(this.timing.preRenderScanline, this.timing.oddFrameSkip);
    this.apu.setTiming(this.timing);
    this.ppuDotRemainder = 0;
  }

  /** Press the RESET button: re-vector the CPU and reset the APU, preserving all
   *  RAM (internal + PRG-RAM), A/X/Y, and PPU/cartridge state — the cart's reset
   *  handler re-initialises what it needs. (Power-on is the constructor.) */
  softReset(): void {
    this.cpu.softReset();
    this.apu.softReset();
  }

  /** Run until the PPU completes the next frame. The PPU is clocked inside
   *  `cpu.step()` via the onTick hook, so each instruction's memory accesses
   *  land at the right dot. Returns the CPU cycles consumed this frame (for the
   *  pacer's CPU-load / turbo accounting, mirroring the GB/GBA cores). */
  runFrame(): number {
    const startFrame = this.ppu.frame;
    const startCycles = this.cpu.cycles;
    while (this.ppu.frame === startFrame) {
      // `stepped === 0` means a PC breakpoint fired before the fetch — bail so
      // the session loop can drain the hit and auto-pause at the stopped PC.
      const stepped = this.cpu.step();
      if (stepped === 0) break;
      if (peekHit() !== null) break; // read/write watchpoint latched this step
    }
    // Re-freeze RAM cheats once per frame so "infinite X" sticks.
    this.cheats.applyRamWrites((a, v) => this.cpuWrite(a, v));
    this.onFrame?.(this.ppu.framebuffer);
    if (this.onAudioFrame && this.apu.outPos > 0) {
      this.onAudioFrame(this.apu.outLeft, this.apu.outRight, this.apu.outPos);
    }
    this.apu.outPos = 0;
    return this.cpu.cycles - startCycles;
  }

  // ─── Debugger stepping ──────────────────────────────────────────────────
  /** Run a frame, but allow the current PC to pass through its own breakpoint
   *  once — so the debugger's Step-Frame button advances instead of immediately
   *  re-firing the breakpoint it's parked on. */
  stepFrame(): number {
    armPassThrough(this.cpu.pc);
    return this.runFrame();
  }

  /** Execute exactly one CPU instruction (or one interrupt dispatch), advancing
   *  the PPU/APU proportionally via the per-step onTick hook. Arms pass-through
   *  so a Step press at a breakpointed PC makes progress. Returns cycles used. */
  stepInstruction(): number {
    armPassThrough(this.cpu.pc);
    const startCycles = this.cpu.cycles;
    this.cpu.step();
    this.cpu.setIrq(this.cartridge.irqState() || this.apu.irqState());
    return this.cpu.cycles - startCycles;
  }

  /** Side-effect-free read for the debugger's memory / disassembly views. RAM
   *  and cartridge space read truthfully; the PPU/APU/IO register window
   *  ($2000-$401F) returns 0 rather than triggering a read side effect (e.g.
   *  clearing the $2002 VBlank flag or bumping the $2007 address). */
  peek(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x2000) return this.ram[addr & 0x07ff]!;
    if (addr < 0x4020) return 0;
    return this.cartridge.cpuRead(addr);
  }

  /** Debugger memory-edit write — goes through the normal bus so register
   *  writes ($2000-$401F) take effect, matching a real CPU store. */
  poke(addr: number, value: number): void {
    this.cpuWrite(addr & 0xffff, value & 0xff);
  }

  get framebuffer(): Uint8ClampedArray<ArrayBuffer> {
    return this.ppu.framebuffer;
  }

  // ─── Save states ──────────────────────────────────────────────────────────
  /** Serialize the full machine state to a versioned binary blob. Pair with
   *  {@link loadState} to restore. The framebuffer and the host audio ring are
   *  not included (both are re-derived). */
  saveState(): Uint8Array {
    const w = new NesStateWriter();
    w.u8(NES_STATE_VERSION);
    this.cpu.serialize(w);
    this.ppu.serialize(w);
    this.apu.serialize(w);
    this.cartridge.serialize(w);
    w.bytes(this.ram);
    w.u8(this.controllerShift);
    w.bool(this.strobe);
    w.u8(this.cpuBus);
    return w.finalize();
  }

  /** Restore a blob produced by {@link saveState}. Throws
   *  {@link UnsupportedNesSaveStateError} (before mutating any state) for a blob
   *  too old to migrate or newer than this build. */
  loadState(bytes: Uint8Array): void {
    const upgraded = upgradeNesState(bytes);
    const version = upgraded[0]!;
    if (version !== NES_STATE_VERSION) {
      throw new UnsupportedNesSaveStateError(version, NES_STATE_VERSION);
    }
    const r = new NesStateReader(upgraded);
    r.u8(); // version prefix
    this.cpu.deserialize(r);
    this.ppu.deserialize(r);
    this.apu.deserialize(r);
    this.cartridge.deserialize(r);
    r.bytes(this.ram);
    this.controllerShift = r.u8();
    this.strobe = r.bool();
    this.cpuBus = r.u8();
    // The restored SP is valid but our synthesized call-stack history isn't.
    clearCallStack();
  }

  // ─── Battery-backed save RAM ────────────────────────────────────────────────
  /** Whether the cart persists an in-game save in battery-backed PRG-RAM. */
  get hasBattery(): boolean {
    return this.cartridge.hasBattery;
  }
  /** The battery-backed PRG-RAM slice to persist, or null if the cart has none. */
  get batteryRam(): Uint8Array | null {
    return this.cartridge.batteryRam;
  }
  /** Restore a persisted battery save into PRG-RAM. */
  loadBatteryRam(bytes: Uint8Array): void {
    this.cartridge.loadBatteryRam(bytes);
  }

  private tickPpu(cpuCycles: number): void {
    // Sample the /NMI line at the cycle boundary (after the previous cycle's
    // dots + $2002/$2000 access). A falling edge dispatches the NMI; a same-cycle
    // VBlank clear / NMI-disable keeps the line from falling, suppressing it.
    if (this.ppu.pollNmi()) this.cpu.nmi();
    this.apu.tick(cpuCycles);
    // CPU-cycle mapper IRQ counters — skipped entirely for the many mappers
    // without them (this hook runs every CPU cycle).
    if (this.cartHasTick) this.cartridge.tick(cpuCycles);
    // NTSC is an exact 3 dots/cycle; PAL is 3.2, so accumulate and emit whole
    // dots, carrying the fraction. The NTSC path stays integer (no float math).
    const ratio = this.timing.ppuDotsPerCpuCycle;
    if (ratio === 3) {
      this.ppu.tick(cpuCycles * 3);
    } else {
      this.ppuDotRemainder += cpuCycles * ratio;
      const dots = Math.floor(this.ppuDotRemainder);
      this.ppuDotRemainder -= dots;
      this.ppu.tick(dots);
    }
    // Sample the level-sensitive IRQ line every CPU cycle (the CPU ticks this
    // hook once per cycle) so its poll point sees cycle-accurate assertions:
    // mapper (MMC3 scanline) + APU (frame-counter / DMC). The APU frame IRQ is
    // enabled at power-on; a cart that doesn't use it disables it via $4017.
    this.cpu.setIrq((this.cartHasIrq && this.cartridge.irqState()) || this.apu.irqState());
  }

  // ─── CPU memory map ─────────────────────────────────────────────────────
  private cpuRead(addr: number): number {
    this.cpuBus = this.readBus(addr);
    return this.cpuBus;
  }

  private readBus(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x07ff]!;
    if (addr < 0x4000) return this.ppu.cpuRead(addr & 7);
    if (addr === 0x4015) return this.apu.readStatus();
    if (addr === 0x4016) return this.readController();
    // Write-only APU ports ($4000-$4013, $4017) and unallocated I/O
    // ($4018-$401F) aren't driven on a read, so the bus keeps its last value.
    if (addr < 0x4020) return this.cpuBus;
    const value = this.cartridge.cpuRead(addr, this.cpuBus);
    // Game Genie sits on the cart bus and patches PRG-ROM reads ($8000-$FFFF).
    return addr >= 0x8000 ? this.cheats.patchRomRead(addr, value) : value;
  }

  private cpuWrite(addr: number, value: number): void {
    this.cpuBus = value; // a write drives the value onto the CPU data bus
    if (addr < 0x2000) {
      this.ram[addr & 0x07ff] = value;
    } else if (addr < 0x4000) {
      this.ppu.cpuWrite(addr & 7, value);
    } else if (addr === 0x4014) {
      this.oamDma(value);
    } else if (addr === 0x4016) {
      this.writeController(value);
    } else if (addr < 0x4018) {
      this.apu.writeRegister(addr, value); // $4000-$4013, $4015, $4017
    } else if (addr >= 0x4020) {
      this.cartridge.cpuWrite(addr, value);
    }
  }

  private oamDma(page: number): void {
    const base = page << 8;
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = this.cpuRead((base + i) & 0xffff);
    this.ppu.dmaOam(data);
    // The CPU is stalled 513 cycles during the transfer, plus an alignment
    // cycle when the $4014 write lands on a "put" phase. The write already
    // advanced cpu.cycles, so the write cycle's parity is the opposite of the
    // current value — hence 514 on even (cpu_interrupts_v2/4-irq_and_dma).
    const stall = 514 - (this.cpu.cycles & 1);
    this.cpu.cycles += stall;
    this.tickPpu(stall);
  }

  // ─── Standard controller ($4016) ────────────────────────────────────────
  private writeController(value: number): void {
    this.strobe = (value & 1) !== 0;
    if (this.strobe) this.controllerShift = this.joypad.buttons;
  }
  private readController(): number {
    if (this.strobe) this.controllerShift = this.joypad.buttons;
    const bit = this.controllerShift & 1;
    this.controllerShift = (this.controllerShift >> 1) | 0x80; // 1s after 8 reads
    return 0x40 | bit; // open-bus high bits
  }
}
