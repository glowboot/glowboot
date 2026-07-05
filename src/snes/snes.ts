/**
 * SNES system — wires the 65C816, bus, PPU, and DMA into a runnable
 * console. `runFrame()` executes one 262-line NTSC field and leaves the
 * PPU's framebuffer showing it.
 *
 * CPU I/O implemented: NMITIMEN/RDNMI VBlank NMI, the hardware
 * multiplier/divider, MDMAEN general DMA, auto-joypad read-out, and
 * HVBJOY's VBlank bit. The APU ports HLE the S-SMP IPL boot protocol just
 * far enough that cartridges' sound-driver upload loops complete (the real
 * SPC700 lands in a later stage). Cycle-to-master-clock conversion is a
 * flat 6 master cycles per CPU cycle for now — FastROM/SlowROM region
 * timing comes with the timing pass.
 */

import { SnesApu } from "./apu/apu.js";
import { parseSnesRom, type SnesRom } from "./cartridge/rom.js";
import { CheatManager } from "./cheats/manager.js";
import { Cx4 } from "./coprocessor/cx4.js";
import { Dsp1 } from "./coprocessor/dsp1.js";
import { Obc1 } from "./coprocessor/obc1.js";
import { Sa1 } from "./coprocessor/sa1.js";
import { Sdd1 } from "./coprocessor/sdd1.js";
import { Srtc } from "./coprocessor/srtc.js";
import { SuperFx } from "./coprocessor/superfx.js";
import { Cpu65816 } from "./cpu/cpu.js";
import { armSnesPassThrough, peekSnesHit } from "./debug/breakpoints.js";
import { SnesJoypad } from "./joypad/joypad.js";
import { SnesBus } from "./memory/bus.js";
import { SnesDma } from "./memory/dma.js";
import { SnesPpu } from "./ppu/ppu.js";
import {
  SNES_STATE_VERSION,
  SnesStateReader,
  SnesStateWriter,
  UnsupportedSnesSaveStateError,
  upgradeSnesState
} from "./serialization/serialization.js";

const VEC_EMU_RESET = 0xfffc;
const VEC_NATIVE_NMI = 0xffea;
const VEC_EMU_NMI = 0xfffa;
const VEC_NATIVE_IRQ = 0xffee;
const VEC_EMU_IRQ = 0xfffe;

export class Snes {
  readonly rom: SnesRom;
  readonly bus: SnesBus;
  readonly cpu: Cpu65816;
  readonly ppu: SnesPpu;
  readonly dma: SnesDma;
  readonly apu: SnesApu;

  readonly joypad = new SnesJoypad();

  /** Host-side turbo factor — the browser pacer multiplies wall-clock frame
   *  budget by this. Not serialized (a UI preference, not console state). */
  speedMultiplier = 1;

  /** Active Game Genie / PAR cheats. ROM patches hook the bus; RAM freezes
   *  re-apply once per frame. Not serialized (session/UI state). */
  readonly cheats = new CheatManager();

  /** DSP-1 coprocessor, present when the cart's chipset declares it. */
  readonly dsp1: Dsp1 | null = null;

  /** SA-1 coprocessor (in-cart second 65C816), likewise cart-declared. */
  readonly sa1: Sa1 | null = null;

  /** SuperFX coprocessor (in-cart GSU RISC core), likewise cart-declared. */
  readonly superfx: SuperFx | null = null;

  /** S-DD1 graphics-decompression coprocessor, likewise cart-declared. */
  readonly sdd1: Sdd1 | null = null;

  /** Cx4 math/graphics coprocessor (Mega Man X2/X3), likewise cart-declared. */
  readonly cx4: Cx4 | null = null;

  /** OBC1 OBJ controller (Metal Combat), likewise cart-declared. */
  readonly obc1: Obc1 | null = null;

  /** S-RTC clock (Dai Kaijuu Monogatari II), likewise cart-declared. */
  readonly srtc: Srtc | null = null;

  /** Master cycle at which a coprocessor's S-CPU IRQ line last rose. */
  private sa1IrqRoseAt = 0;

  /** Raw controller-1 mask overlay (headless drivers); see SnesJoypad. */
  get buttons1(): number {
    return this.joypad.buttons;
  }

  set buttons1(mask: number) {
    this.joypad.setRaw(mask);
  }

  private nmiEnabled = false;
  private hIrqEnabled = false;
  private vIrqEnabled = false;
  private hTime = 0x1ff;
  private vTime = 0x1ff;
  private irqFlag = false;
  private autoJoyEnabled = false;
  /** Master cycle at which the current VBlank's auto-joypad read began;
   *  $4212 bit0 reads busy for ~4224 cycles after this. */
  private autoJoyStartCycle = 0;
  private joy1Latched = 0;
  private joyStrobe = false;
  private joy1Shift = 0;

  private mulA = 0xff;
  private divA = 0xffff;
  private mulDivResult = 0; // $4214/$4215 (quotient / product low half)
  private mulDivRemainder = 0; // $4216/$4217 (remainder / product high half)

  constructor(romBytes: Uint8Array) {
    this.rom = parseSnesRom(romBytes);
    this.bus = new SnesBus(this.rom);
    this.cpu = new Cpu65816(this.bus);
    this.ppu = new SnesPpu(this.rom.region);
    this.dma = new SnesDma(this.bus);
    this.apu = new SnesApu();

    if (this.rom.coprocessor === "sa1") {
      this.sa1 = new Sa1(this.rom.rom, this.bus.sram, this.rom.region === "pal");
      this.sa1.onSnesIrq = () => {
        this.sa1IrqRoseAt = this.tickBaseCycles;
      };
      this.bus.sa1 = this.sa1;
    }
    if (this.rom.coprocessor === "sdd1") {
      this.sdd1 = new Sdd1(this.rom.rom);
      this.bus.sdd1 = this.sdd1;
    }
    if (this.rom.coprocessor === "cx4") {
      this.cx4 = new Cx4(this.rom.rom);
      this.bus.cx4 = this.cx4;
    }
    if (this.rom.coprocessor === "obc1") {
      this.obc1 = new Obc1(this.bus.sram);
      this.bus.obc1 = this.obc1;
    }
    if (this.rom.coprocessor === "srtc") {
      this.srtc = new Srtc();
      this.bus.srtc = this.srtc;
    }
    if (this.rom.coprocessor === "superfx") {
      this.superfx = new SuperFx(this.rom.rom, this.bus.sram);
      this.superfx.onSnesIrq = () => {
        this.sa1IrqRoseAt = this.tickBaseCycles;
      };
      // Cycle-accurate interleave: the GSU catches itself up to the S-CPU's
      // exact cycle before each shared-resource access and at every
      // instruction boundary, instead of running in a lump after the fact.
      this.superfx.hostClock = () => this.cpu.cycles;
      this.bus.superfx = this.superfx;
    }
    if (this.rom.coprocessor === "dsp") {
      this.dsp1 = new Dsp1();
      this.bus.dsp1 = this.dsp1;
      // Board window: HiROM carts use the $00-$1F:$6000/$7000 ports; LoROM
      // boards larger than 1 MiB move the ports into banks $60-$6F.
      this.bus.dsp1Window =
        this.rom.mapping !== "lorom" ? "hirom" : this.rom.rom.length > 0x100000 ? "lorom2" : "lorom";
    }

    this.bus.onIoRead = (addr) => this.ioRead(addr);
    this.bus.patchRomRead = (addr, orig) => this.cheats.patchRomRead(addr, orig);
    this.bus.onIoWrite = (addr, v) => this.ioWrite(addr, v);
    this.ppu.onScanlineStart = (line) => {
      if (line === 0) this.dma.hdmaInit();
      if (line < this.ppu.activeDisplayLines) this.dma.hdmaRun();
    };
    // H/V IRQ via the PPU's dot-position timer: V-only fires at (~dot 2,
    // VTIME); H-only fires at HTIME on every line; H+V at (HTIME, VTIME).
    this.ppu.onHTimer = () => {
      if (!this.irqFlag) this.irqRoseAt = this.tickBaseCycles;
      this.irqFlag = true;
    };
    this.ppu.onVBlankStart = (cyclesAgo) => {
      if (this.autoJoyEnabled) this.joy1Latched = this.buttons1;
      // Stamp the true edge time, not the instruction start: when VBlank
      // rises after the current instruction's interrupt-sample point,
      // hardware runs one more instruction before NMI entry — games that
      // poll $4210 bit 7 to wait for VBlank rely on that read winning the
      // race against their own NMI handler's acknowledge.
      const edge = this.cpu.cycles - cyclesAgo;
      // Auto-joypad read runs for ~4224 master cycles at the top of VBlank;
      // $4212 bit0 reads busy only during that window (games poll it).
      this.autoJoyStartCycle = edge;
      if (this.nmiEnabled) {
        this.nmiPending = true;
        this.nmiRoseAt = edge;
      }
    };

    this.reset();
  }

  reset(): void {
    this.sa1?.reset();
    this.superfx?.reset();
    this.sdd1?.reset();
    this.cx4?.reset();
    this.obc1?.reset();
    this.srtc?.reset();
    this.cpu.e = 1;
    this.cpu.s = 0x01ff;
    this.cpu.d = 0;
    this.cpu.dbr = 0;
    this.cpu.pbr = 0;
    this.cpu.p = 0x34;
    this.cpu.pc = this.bus.read(VEC_EMU_RESET) | (this.bus.read(VEC_EMU_RESET + 1) << 8);
  }

  /** Frames per second at the cart's region rate. */
  get framesPerSec(): number {
    return this.rom.region === "pal" ? 50.007 : 60.0988;
  }

  /** Run one field (262 scanlines NTSC / 312 PAL). All clocks are master
   *  cycles; the CPU accounts per-access region costs itself. */
  runFrame(): void {
    // Let the user resume off a PC breakpoint: the PC at frame entry
    // is allowed through once before the registry re-arms the same
    // address. Mirrors the GB/GBA runFrame wiring.
    armSnesPassThrough((this.cpu.pbr << 16) | this.cpu.pc);
    // Re-freeze RAM cheats once per frame so "infinite X" sticks.
    this.cheats.applyRamWrites((a, v) => this.bus.write(a, v));
    const target = this.cpu.cycles + this.ppu.totalLines * 1364;
    while (this.cpu.cycles < target) {
      const before = this.cpu.cycles;
      this.tickBaseCycles = before;
      // Re-anchor per instruction: interrupt-entry cycles (added after the
      // previous syncApu) stay out of the APU budget, as they always have.
      this.apuSynced = before;
      this.cpu.step();
      // A latched breakpoint hit consumed zero cycles — bail before
      // interrupt dispatch can mutate the paused state (and before the
      // stalled `cycles` counter spins this loop forever).
      if (peekSnesHit() !== null) break;
      if (this.pendingDmaMaster > 0) {
        this.cpu.cycles += this.pendingDmaMaster;
        // The stall occupies the timeline from the $420B write onwards; the
        // instruction's remaining cycles complete after it.
        this.intVisibleFloor = this.dmaTriggerCycle + this.pendingDmaMaster;
        this.pendingDmaMaster = 0;
      }
      const delta = this.cpu.cycles - before;
      this.ppu.tick(delta);
      this.sa1?.tick(delta);
      this.applyRefresh();
      this.syncApu();
      this.superfx?.catchUp(this.cpu.cycles);
      // The 65C816 samples its interrupt lines two CPU cycles before an
      // instruction boundary, and a DMA stall blocks sampling entirely — so
      // an interrupt is taken here only if it became visible before the
      // just-finished instruction's sample point (hardware-verified by
      // Sour's dma_irq_test: 1-2 instructions run after a DMA-straddling
      // IRQ/NMI before service).
      const horizon = this.cpu.cycles - this.cpu.intSampleOffset;
      if (this.nmiPending && Math.max(this.nmiRoseAt, this.intVisibleFloor) < horizon) {
        this.nmiPending = false;
        this.cpu.hwInterrupt(this.cpu.e ? VEC_EMU_NMI : VEC_NATIVE_NMI);
      } else if (
        this.irqFlag &&
        !this.cpu.irqMaskAtStart &&
        !this.cpu.irqDisabled &&
        Math.max(this.irqRoseAt, this.intVisibleFloor) < horizon
      ) {
        this.cpu.hwInterrupt(this.cpu.e ? VEC_EMU_IRQ : VEC_NATIVE_IRQ);
      } else if (
        (this.sa1?.snesIrqAsserted() === true || this.superfx?.snesIrqAsserted() === true) &&
        !this.cpu.irqMaskAtStart &&
        !this.cpu.irqDisabled &&
        Math.max(this.sa1IrqRoseAt, this.intVisibleFloor) < horizon
      ) {
        // Vector fetch goes through the bus, so the SA-1's SIV hijack
        // (SCNT bit 6) applies automatically.
        this.cpu.hwInterrupt(this.cpu.e ? VEC_EMU_IRQ : VEC_NATIVE_IRQ);
      } else if (
        this.cpu.waiting &&
        ((this.irqFlag && Math.max(this.irqRoseAt, this.intVisibleFloor) < horizon) ||
          ((this.sa1?.snesIrqAsserted() === true || this.superfx?.snesIrqAsserted() === true) &&
            Math.max(this.sa1IrqRoseAt, this.intVisibleFloor) < horizon))
      ) {
        // WAI with the I flag set: an asserted IRQ line ends the wait but is
        // not serviced — execution resumes at the instruction after WAI.
        this.cpu.waiting = false;
      }
    }
  }

  get framebuffer(): Uint8ClampedArray {
    return this.ppu.framebuffer;
  }

  /** Debugger single-step: one instruction plus proportional subsystem
   *  work (the runFrame loop body, once). Arms breakpoint pass-through so
   *  stepping at a breakpointed address advances instead of re-latching.
   *  Returns the master cycles consumed. */
  stepInstruction(): number {
    armSnesPassThrough((this.cpu.pbr << 16) | this.cpu.pc);
    const before = this.cpu.cycles;
    this.tickBaseCycles = before;
    this.apuSynced = before;
    this.cpu.step();
    if (this.pendingDmaMaster > 0) {
      this.cpu.cycles += this.pendingDmaMaster;
      this.intVisibleFloor = this.dmaTriggerCycle + this.pendingDmaMaster;
      this.pendingDmaMaster = 0;
    }
    const delta = this.cpu.cycles - before;
    this.ppu.tick(delta);
    this.sa1?.tick(delta);
    this.applyRefresh();
    this.syncApu();
    this.superfx?.catchUp(this.cpu.cycles);
    const horizon = this.cpu.cycles - this.cpu.intSampleOffset;
    if (this.nmiPending && Math.max(this.nmiRoseAt, this.intVisibleFloor) < horizon) {
      this.nmiPending = false;
      this.cpu.hwInterrupt(this.cpu.e ? VEC_EMU_NMI : VEC_NATIVE_NMI);
    } else if (
      this.irqFlag &&
      !this.cpu.irqMaskAtStart &&
      !this.cpu.irqDisabled &&
      Math.max(this.irqRoseAt, this.intVisibleFloor) < horizon
    ) {
      this.cpu.hwInterrupt(this.cpu.e ? VEC_EMU_IRQ : VEC_NATIVE_IRQ);
    } else if (this.cpu.waiting && this.irqFlag && Math.max(this.irqRoseAt, this.intVisibleFloor) < horizon) {
      this.cpu.waiting = false;
    }
    return delta;
  }

  /** Serialize the complete console state (framebuffer excluded — the next
   *  rendered frame re-derives it). */
  saveState(): Uint8Array {
    const w = new SnesStateWriter(2 * 1024 * 1024);
    w.u8(SNES_STATE_VERSION);
    this.cpu.serialize(w);
    this.bus.serialize(w);
    this.ppu.serialize(w);
    this.apu.serialize(w);
    this.dma.serialize(w);
    this.dsp1?.serialize(w);
    this.sa1?.serialize(w);
    this.superfx?.serialize(w);
    this.sdd1?.serialize(w);
    this.cx4?.serialize(w);
    w.bool(this.nmiEnabled);
    w.bool(this.vIrqEnabled);
    w.bool(this.hIrqEnabled);
    w.u16(this.hTime);
    w.u16(this.vTime);
    w.bool(this.irqFlag);
    w.bool(this.autoJoyEnabled);
    w.f64(this.autoJoyStartCycle);
    w.u16(this.joy1Latched);
    w.bool(this.joyStrobe);
    w.u16(this.joy1Shift);
    w.u8(this.mulA);
    w.u16(this.divA);
    w.u16(this.mulDivResult);
    w.u32(this.mulDivRemainder);
    w.u32(this.pendingDmaMaster);
    w.f64(this.dmaTriggerCycle);
    w.f64(this.intVisibleFloor);
    w.f64(this.irqRoseAt);
    w.bool(this.nmiPending);
    w.f64(this.nmiRoseAt);
    return w.finalize();
  }

  /** Restore a blob produced by {@link saveState}. Throws
   *  {@link UnsupportedSnesSaveStateError} (before mutating any state) for a
   *  blob with no migration path to this build's layout. */
  loadState(bytes: Uint8Array): void {
    const upgraded = upgradeSnesState(bytes);
    const version = upgraded[0]!;
    if (version !== SNES_STATE_VERSION) {
      throw new UnsupportedSnesSaveStateError(version, SNES_STATE_VERSION);
    }
    const r = new SnesStateReader(upgraded.subarray(1));
    this.cpu.deserialize(r);
    this.bus.deserialize(r);
    // OBC1 latches are pure functions of the just-restored SRAM ($7FF5/$7FF6),
    // so they carry no bytes in the stream — recompute them here.
    this.obc1?.reset();
    this.ppu.deserialize(r);
    this.apu.deserialize(r);
    this.dma.deserialize(r);
    this.dsp1?.deserialize(r);
    this.sa1?.deserialize(r);
    this.superfx?.deserialize(r);
    this.sdd1?.deserialize(r);
    this.cx4?.deserialize(r);
    this.nmiEnabled = r.bool();
    this.vIrqEnabled = r.bool();
    this.hIrqEnabled = r.bool();
    this.hTime = r.u16();
    this.vTime = r.u16();
    this.irqFlag = r.bool();
    this.autoJoyEnabled = r.bool();
    this.autoJoyStartCycle = r.f64();
    this.joy1Latched = r.u16();
    this.joyStrobe = r.bool();
    this.joy1Shift = r.u16();
    this.mulA = r.u8();
    this.divA = r.u16();
    this.mulDivResult = r.u16();
    this.mulDivRemainder = r.u32();
    this.pendingDmaMaster = r.u32();
    this.apuSynced = this.cpu.cycles;
    this.updateIrqTimer();
    this.dmaTriggerCycle = r.f64();
    this.intVisibleFloor = r.f64();
    this.irqRoseAt = r.f64();
    this.nmiPending = r.bool();
    this.nmiRoseAt = r.f64();
  }

  /** Whether the cart battery-backs its SRAM. */
  get hasBattery(): boolean {
    return this.rom.battery && this.bus.sram.length > 0;
  }

  /** The battery-backed SRAM (null when the cart has none). */
  get batteryRam(): Uint8Array | null {
    return this.hasBattery ? this.bus.sram : null;
  }

  /** Restore battery SRAM persisted by the host. */
  loadBatteryRam(bytes: Uint8Array): void {
    if (!this.hasBattery) return;
    this.bus.sram.set(bytes.subarray(0, this.bus.sram.length));
  }

  /** Pull buffered stereo audio (interleaved L/R int16 at 32 kHz). */
  drainAudio(out: Int16Array): number {
    return this.apu.dsp.drainSamples(out);
  }

  /** Push the H/V IRQ configuration into the PPU's dot timer. */
  private updateIrqTimer(): void {
    if (!this.vIrqEnabled && !this.hIrqEnabled) {
      this.ppu.hTimerDot = -1;
      this.ppu.hTimerLine = -1;
      return;
    }
    // V-only triggers near the start of the line (~dot 2.5 on hardware).
    this.ppu.hTimerDot = this.hIrqEnabled ? this.hTime & 0x1ff : 2;
    this.ppu.hTimerLine = this.vIrqEnabled ? this.vTime & 0x1ff : -1;
  }

  private pendingDmaMaster = 0;
  /** CPU-cycle timestamp of the $420B write that triggered the pending DMA —
   *  the stall is inserted at that point in the timeline, so interrupt
   *  visibility resumes at trigger + stall, not at the instruction end. */
  private dmaTriggerCycle = 0;
  /** CPU-cycle time before which interrupt lines are not sample-able (the
   *  end of the last DMA stall). */
  private intVisibleFloor = 0;
  /** When the IRQ line rose / the NMI edge latched (master-cycle time).
   *  PPU callbacks fire while a whole instruction's tick batch is being
   *  applied, so the rise is stamped with the batch START (the line rose at
   *  some point inside the batch; the DMA-stall floor gates visibility
   *  separately, and a start-of-batch stamp errs toward hardware, which
   *  takes an interrupt rising >=2 cycles before the boundary). */
  private irqRoseAt = Infinity;
  private nmiPending = false;
  private nmiRoseAt = Infinity;
  private tickBaseCycles = 0;
  /** Apply the DRAM-refresh stalls the PPU crossed: the S-CPU pauses 40
   *  master cycles at ~H=133 of every scanline while WRAM refreshes. The
   *  stall is load-bearing for main-CPU↔SPC handshakes: it is the only gap
   *  in a tight port-write loop long enough for the SPC's clear-then-check
   *  pass to see quiet ports (Super Bomberman 4's driver rendezvous). The
   *  beam keeps moving during the stall, so the added time feeds back into
   *  the PPU — which can cross the next line's refresh point in turn. */
  private applyRefresh(): void {
    let stalls = this.ppu.takeRefreshStalls();
    while (stalls > 0) {
      const add = stalls * 40;
      this.cpu.cycles += add;
      // Like a DMA stall, refresh blocks interrupt sampling: an edge landing
      // before the stall's end is not serviceable at this boundary, so a
      // $4210 poll racing its own NMI handler still wins (Lagoon, Popful
      // Mail, Super Ninja Boy and Zool hang if the handler acks first).
      this.intVisibleFloor = Math.max(this.intVisibleFloor, this.cpu.cycles);
      this.ppu.tick(add);
      this.sa1?.tick(add);
      stalls = this.ppu.takeRefreshStalls();
    }
  }
  /** Master-cycle position the APU has been fed up to within the current
   *  instruction (re-anchored at each instruction start). Port accesses
   *  sync the APU to their exact mid-instruction time through this. */
  private apuSynced = 0;

  /** Run the APU up to the CPU's current master-cycle position. Called at
   *  every $2140-$217F access so port reads/writes land at their true time,
   *  and after each instruction to keep the APU current. */
  private syncApu(): void {
    const d = this.cpu.cycles - this.apuSynced;
    if (d > 0) {
      this.apu.tick(d);
      this.apuSynced = this.cpu.cycles;
    }
  }

  private ioRead(addr: number): number | null {
    if (addr >= 0x2100 && addr <= 0x213f) return this.ppu.readReg(addr);
    if (addr >= 0x2140 && addr <= 0x217f) {
      return this.apu.cpuReadPort(addr & 3);
    }
    if (addr >= 0x4300 && addr <= 0x437f) return this.dma.readReg(addr);
    switch (addr) {
      case 0x4210: {
        const v = (this.ppu.nmiFlag ? 0x80 : 0) | 0x02; // CPU version 2
        this.ppu.nmiFlag = false;
        return v;
      }
      case 0x4211: {
        const v = this.irqFlag ? 0x80 : 0;
        this.irqFlag = false;
        this.irqRoseAt = Infinity;
        return v;
      }
      case 0x4212:
        return (
          (this.ppu.inVBlank ? 0x80 : 0) |
          (this.ppu.inHBlank ? 0x40 : 0) |
          (this.autoJoyEnabled && this.ppu.inVBlank && this.cpu.cycles - this.autoJoyStartCycle < 4224 ? 0x01 : 0)
        );
      case 0x4214:
        return this.mulDivResult & 0xff;
      case 0x4215:
        return this.mulDivResult >> 8;
      case 0x4216:
        return this.mulDivRemainder & 0xff;
      case 0x4217:
        return this.mulDivRemainder >> 8;
      case 0x4016: {
        // Serial joypad: returns B Y Select Start Up Down Left Right A X L R
        // then 1s, MSB first.
        if (this.joyStrobe) return (this.buttons1 >> 15) & 1;
        const bit = (this.joy1Shift >> 15) & 1;
        this.joy1Shift = ((this.joy1Shift << 1) | 1) & 0xffff;
        return bit;
      }
      case 0x4017:
        return 0x1c; // no controller 2 (open bits set)
      case 0x4218:
        return this.joy1Latched & 0xff;
      case 0x4219:
        return this.joy1Latched >> 8;
      case 0x421a:
      case 0x421b:
      case 0x421c:
      case 0x421d:
      case 0x421e:
      case 0x421f:
        return 0;
      default:
        return null;
    }
  }

  private ioWrite(addr: number, v: number): void {
    if (addr >= 0x2100 && addr <= 0x213f) {
      this.ppu.writeReg(addr, v);
      return;
    }
    if (addr >= 0x2140 && addr <= 0x217f) {
      this.apu.cpuWritePort(addr & 3, v);
      return;
    }
    if (addr >= 0x4300 && addr <= 0x437f) {
      this.dma.writeReg(addr, v);
      return;
    }
    switch (addr) {
      case 0x4016:
        if (v & 1) this.joyStrobe = true;
        else if (this.joyStrobe) {
          this.joyStrobe = false;
          this.joy1Shift = this.buttons1 & 0xffff;
        }
        break;
      case 0x4200:
        this.nmiEnabled = (v & 0x80) !== 0;
        this.vIrqEnabled = (v & 0x20) !== 0;
        this.hIrqEnabled = (v & 0x10) !== 0;
        this.autoJoyEnabled = (v & 0x01) !== 0;
        if (!this.vIrqEnabled && !this.hIrqEnabled) this.irqFlag = false;
        this.updateIrqTimer();
        break;
      case 0x4202:
        this.mulA = v;
        break;
      case 0x4207:
        this.hTime = (this.hTime & 0x100) | v;
        this.updateIrqTimer();
        break;
      case 0x4208:
        this.hTime = (this.hTime & 0xff) | ((v & 1) << 8);
        this.updateIrqTimer();
        break;
      case 0x4209:
        this.vTime = (this.vTime & 0x100) | v;
        this.updateIrqTimer();
        break;
      case 0x420a:
        this.vTime = (this.vTime & 0xff) | ((v & 1) << 8);
        this.updateIrqTimer();
        break;
      case 0x4203:
        // Product lands in RDMPY ($4216/17); RDDIV echoes the multiplier.
        this.mulDivRemainder = this.mulA * v;
        this.mulDivResult = v;
        break;
      case 0x4204:
        this.divA = (this.divA & 0xff00) | v;
        break;
      case 0x4205:
        this.divA = (this.divA & 0x00ff) | (v << 8);
        break;
      case 0x4206: {
        if (v === 0) {
          this.mulDivResult = 0xffff;
          this.mulDivRemainder = this.divA;
        } else {
          this.mulDivResult = (this.divA / v) | 0;
          this.mulDivRemainder = this.divA % v;
        }
        break;
      }
      case 0x420b:
        this.dmaTriggerCycle = this.cpu.cycles;
        this.dma.run(v);
        this.pendingDmaMaster = this.dma.lastRunMasterCycles;
        break;
      case 0x420c:
        this.dma.hdmaEnabled = v;
        break;
      case 0x420d:
        this.bus.fastRom = (v & 1) !== 0;
        break;
      default:
        break;
    }
  }
}
