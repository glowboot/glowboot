import { APU } from "./apu/apu.js";
import { Cartridge } from "./cartridge/cartridge.js";
import { CheatManager } from "./cheats/manager.js";
import { CPU } from "./cpu/cpu.js";
import { armPassThrough, peekHit } from "./debug/breakpoints.js";
import { clear as clearCallStack } from "./debug/call-stack.js";
import { Joypad } from "./joypad/joypad.js";
import { InterruptController } from "./memory/interrupts.js";
import { MMU } from "./memory/mmu.js";
import { PPU } from "./ppu/ppu.js";
import {
  STATE_VERSION,
  StateReader,
  StateWriter,
  UnsupportedSaveStateError,
  upgradeState
} from "./serialization/serialization.js";
import { Timer } from "./timer/timer.js";

/** Target CPU clock speed in Hz (T-cycle rate). */
export const CPU_CLOCK_HZ = 4_194_304;
/** Game Boy refresh rate in Hz. */
export const FRAMES_PER_SEC = 59.73;
/** M-cycles per frame (1 M-cycle = 4 T-cycles). */
const CYCLES_PER_FRAME = Math.round(CPU_CLOCK_HZ / 4 / FRAMES_PER_SEC);

/**
 * Top-level Game Boy emulator — pure runtime, host-agnostic. Exposes
 * `runFrame()` which advances exactly one VBlank of emulation; the
 * scheduler that calls it at the right wall-clock cadence lives in
 * the UI layer (`src/ui/session/pacing.ts`), so the engine has no dependency
 * on `requestAnimationFrame` or any other host timing API.
 *
 * Usage (via shell):
 *   const gb = new GameBoy(romData);
 *   startPacing(gb);
 *   // later: stopPacing();
 */
export class GameBoy {
  readonly interrupts = new InterruptController();
  readonly cheats = new CheatManager();
  readonly ppu: PPU;
  readonly apu = new APU();
  readonly timer: Timer;
  readonly joypad: Joypad;
  readonly cart: Cartridge;
  readonly mmu: MMU;
  readonly cpu: CPU;

  /**
   * Emulation speed multiplier. Set to 2/4/… to run the emulator that
   * many times faster than real time (turbo); stays at 1 for normal play.
   * The pacer (in the UI layer) reads this each tick to scale how many
   * `runFrame` calls fit into a wall-clock frame.
   */
  speedMultiplier = 1;

  /** Called after each VBlank with the completed framebuffer. */
  onFrame: ((framebuffer: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;

  /**
   * Called at the end of every `runFrame` with the APU's accumulated sample
   * buffer. Decoupled from VBlank so audio keeps flowing even when the LCD
   * is off (during which the PPU freezes and no VBlanks fire). The callee
   * is expected to drain the samples and leave `apu.outPos` reset to 0.
   */
  onAudioFrame: ((left: Float32Array, right: Float32Array, count: number) => void) | null = null;

  constructor(romData: Uint8Array, bootRom: Uint8Array | null = null) {
    const preBoot = bootRom !== null;
    this.cart = new Cartridge(romData);
    // Always emulate a CGB console so DMG carts get CGB "compatibility mode"
    // colourisation just like they do on real hardware.
    this.ppu = new PPU(this.interrupts, /* cgb */ true, /* cgbGame */ this.cart.cgb, preBoot);
    this.timer = new Timer(this.interrupts, preBoot);
    this.joypad = new Joypad(this.interrupts);
    this.mmu = new MMU(
      this.cart,
      this.ppu,
      this.apu,
      this.timer,
      this.joypad,
      this.interrupts,
      /* cgb console */ true,
      bootRom
    );
    this.cpu = new CPU(this.mmu, this.interrupts, this.timer, /* cgb */ true, /* preBoot */ preBoot);
    this.mmu.cpu = this.cpu; // break the constructor cycle so KEY1 can reach CPU.
    this.cpu.apu = this.apu; // per-bus-access APU ticking — see CPU.busRead
    this.cpu.ppu = this.ppu; // per-bus-access PPU ticking — register writes settle at the M-cycle of the write
    this.timer.apu = this.apu; // APU FS is clocked by DIV bit 12/13 falling edges.
    this.timer.cpu = this.cpu; // …and the bit selector flips with double-speed.
    this.mmu.cheats = this.cheats; // attach cheat engine for Game Genie ROM patches.

    this.ppu.onVBlank = () => this.onFrame?.(this.ppu.framebuffer);
    this.ppu.onHBlank = () => this.mmu.hdmaHBlankStep();

    // DMG-compat palette is applied by the boot ROM itself based on the
    // cart-title hash. Skip our shortcut when a real boot ROM is loaded.
    if (!this.cart.cgb && !bootRom) this.applyDmgCompatPalette();
  }

  /**
   * Mimic the CGB boot ROM's DMG-compatibility colourisation. The real boot
   * ROM hashes the cart title (bytes 0x0134–0x0143) and looks up a 3×4 colour
   * scheme. We don't ship the boot ROM, so we apply a single reasonable
   * default (a muted amber/teal scheme inspired by the "None"/fallback entry
   * in the boot-ROM table) which visibly distinguishes CGB output from the
   * pure-DMG green shades.
   */
  private applyDmgCompatPalette(): void {
    // LE u32 values = 0xAABBGGRR. Chosen to evoke the CGB default look.
    const BG: readonly number[] = [0xffffffff, 0xff7bb8ff, 0xff2963a9, 0xff000000];
    const OBP0: readonly number[] = [0xffffffff, 0xff8383ff, 0xff2929a9, 0xff000000];
    const OBP1: readonly number[] = [0xffffffff, 0xff83ff83, 0xff29a929, 0xff000000];
    this.ppu.setDmgCompatPalette(BG, OBP0, OBP1);
  }

  // ─── Main loop ────────────────────────────────────────────────────────────

  /**
   * Run one full frame's worth of wall-clock time.
   *
   * In CGB double-speed mode the CPU runs at 2× the PPU/APU dot/sample
   * clock. Rather than accumulate CPU M-cycles directly (which would
   * need a fractional carry), we track PPU/APU progress in half-M-cycles
   * so a mid-frame STOP-triggered speed switch takes effect immediately
   * rather than waiting for the next frame boundary. Timer + DMA follow
   * the CPU's clock directly.
   */
  runFrame(): number {
    let ppuDots = 0;
    let cpuCycles = 0;
    // Reset the per-frame HALT counter so callers can read
    // `cpu.haltedCycles` after this returns and divide by `cpuCycles`
    // to get the GB CPU load fraction for the visible frame.
    this.cpu.haltedCycles = 0;
    const DOTS_PER_FRAME = CYCLES_PER_FRAME * 4;

    while (ppuDots < DOTS_PER_FRAME) {
      const stepped = this.cpu.step();
      // `stepped === 0` means a PC breakpoint fired before the fetch;
      // bail out of the frame loop so the scheduler can drain the hit
      // and auto-pause.
      if (stepped === 0) break;
      // Timer, OAM DMA, APU **and PPU** are driven from inside CPU.step
      // (per-bus-access ticking), so reads of TIMA / register writes mid-
      // mode-3 / wave-RAM reads etc. all observe the cycle-accurate
      // state required by mem_timing / Mealybug / cgb_sound 09. The RTC
      // oscillator runs at a fixed 32768 Hz independent of CGB double-
      // speed mode, so convert CPU M-cycles → T-cycles of real emulated
      // time: single-speed = 4 T/M, double-speed = 2 T/M.
      const tCycles = this.cpu.doubleSpeed ? stepped * 2 : stepped * 4;
      this.cart.tickRtc(tCycles);
      this.mmu.tickSerial(tCycles);
      cpuCycles += stepped;
      ppuDots += tCycles; // 1 T-cycle = 1 PPU dot
      // Watchpoint latched during this step's bus accesses — finish the
      // step cleanly (already done) then bail so the frame ends early.
      if (peekHit() !== null) break;
    }
    this.cheats.applyRamWrites(this.mmu);
    if (this.onAudioFrame && this.apu.outPos > 0) {
      this.onAudioFrame(this.apu.outLeft, this.apu.outRight, this.apu.outPos);
      this.apu.outPos = 0;
    }
    return cpuCycles;
  }

  /**
   * Like `runFrame`, but arms pass-through for the current PC first so a
   * Step-Frame press at a breakpointed address advances into the frame
   * instead of immediately re-firing the same breakpoint and bailing out
   * before any work happens. The pacing loop calls `runFrame` directly
   * because resumed play wants breakpoints to fire on the very first
   * instruction; the debugger's Step-Frame button calls this instead.
   */
  stepFrame(): number {
    armPassThrough(this.cpu.regs.pc);
    return this.runFrame();
  }

  /**
   * Run exactly one CPU instruction (or one interrupt-dispatch cycle)
   * plus the per-step subsystem work that normally happens inside
   * `runFrame`. Returns the number of M-cycles consumed. Used by the
   * debugger's "step instruction" button — gives single-instruction
   * resolution over PC movement so a user can walk through a routine.
   *
   * Intentionally does NOT flush audio or apply once-per-frame cheats
   * (both are runFrame-cadence concerns). The PPU still advances
   * proportionally to the cycles consumed so the display keeps up.
   *
   * Halt handling: a halted CPU consumes 1 M-cycle per `cpu.step()`
   * without advancing PC, so a literal one-step would tick subsystems
   * forward without any visible progress. Instead, when entering this
   * method halted, keep ticking until the CPU wakes (interrupt service
   * dispatches or HALT-with-IME=0 falls through). Capped at two frames
   * so a halt with no live IRQ source (IE=0) can't lock the main thread.
   */
  stepInstruction(): number {
    // Step is the user's "move past this" button — arm the current PC
    // for pass-through so a Step press at a breakpointed address
    // advances instead of re-triggering the same breakpoint and
    // making no progress.
    armPassThrough(this.cpu.regs.pc);
    const cap = CYCLES_PER_FRAME * 2;
    let totalCycles = 0;
    while (totalCycles < cap) {
      const stepped = this.cpu.step();
      if (stepped === 0) break;
      const tCycles = this.cpu.doubleSpeed ? stepped * 2 : stepped * 4;
      this.cart.tickRtc(tCycles);
      this.mmu.tickSerial(tCycles);
      // PPU is ticked from inside CPU.step now; nothing to top up here.
      totalCycles += stepped;
      if (!this.cpu.halted && !this.cpu.stopped) break;
    }
    return totalCycles;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  /**
   * Snapshot the entire emulator state (CPU + MMU + PPU + APU + timer +
   * joypad + cart MBC state + external RAM) into a self-contained byte
   * buffer. Pair with `loadState` to restore.
   */
  saveState(): Uint8Array {
    const w = new StateWriter();
    w.u8(STATE_VERSION);
    this.cart.serialize(w);
    this.interrupts.serialize(w);
    this.cpu.serialize(w);
    this.mmu.serialize(w);
    this.ppu.serialize(w);
    this.apu.serialize(w);
    this.timer.serialize(w);
    this.joypad.serialize(w);
    return w.finalize();
  }

  loadState(bytes: Uint8Array): void {
    // `upgradeState` walks any registered v(N) → v(N+1) migrators so older
    // blobs are silently brought up to the current layout. Throws
    // `UnsupportedSaveStateError` for blobs older than the oldest migrator
    // or newer than this build — caller surfaces both as friendly UI.
    const upgraded = upgradeState(bytes);
    const r = new StateReader(upgraded);
    const version = r.u8();
    if (version !== STATE_VERSION) {
      throw new UnsupportedSaveStateError(version, STATE_VERSION);
    }
    this.cart.deserialize(r);
    this.interrupts.deserialize(r);
    this.cpu.deserialize(r);
    this.mmu.deserialize(r);
    this.ppu.deserialize(r);
    this.apu.deserialize(r);
    this.timer.deserialize(r);
    this.joypad.deserialize(r);
    // The loaded state has a valid SP but we have no history to match
    // it against. Reset the synthesized call stack; it will repopulate
    // organically as the game continues to CALL/RET.
    clearCallStack();
  }
}
