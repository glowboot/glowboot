/**
 * Top-level GBA emulator. Pure runtime, host-agnostic — the
 * `requestAnimationFrame` loop and canvas wiring live in the UI layer.
 *
 * Usage:
 *   const gba = new Gba(romData);
 *   gba.onFrame = (fb) => putImageData(...);
 *   const stop = startGbaPacing(gba); // UI-side rAF loop
 *
 * Subsystem coverage:
 *
 *   • CPU — ARM7TDMI with full ARM and Thumb decoders, every
 *     instruction class (data-processing, branches, multiplies
 *     including long-multiply carry-flag, single + multi-word
 *     loads/stores incl. misaligned LDR/LDRH quirks, SWI, BX),
 *     seven CPU modes with banked R8-R14 + SPSR, pipeline-aware
 *     open-bus reads. Passes jsmolka's full arm/thumb/memory/unsafe
 *     suites and fuzzarm.
 *
 *   • PPU — All six BG modes (tile 0/1/2 + bitmap 3/4/5), four BGs,
 *     OBJ engine (128 sprites, 12 size/shape combos, normal + affine
 *     incl. double-size), three windows (WIN0/WIN1/OBJWIN) under
 *     WININ/WINOUT, alpha blending (BLDCNT modes 0-3) with semi-
 *     transparent OBJ alpha preservation, BG/OBJ mosaic, the BG2/BG3
 *     affine reference-point per-line accumulators, 2-line DISPCNT
 *     BG-enable latching.
 *
 *   • APU — Four PSG channels (square A/B with sweep + envelope,
 *     wave, noise LFSR) + two Direct Sound FIFOs pumped by
 *     timer-overflow IRQs and refilled via DMA on half-full.
 *     SOUNDCNT_H volume / panning controls; SOUNDBIAS amplitude
 *     resolution; stereo mixer.
 *
 *   • DMA — All four channels (DMA0 internal + DMA1/2 sound +
 *     DMA3 general). Every start-timing mode: Immediate, VBlank,
 *     HBlank, Special (DMA1/2's Sound-FIFO + DMA3's video-capture).
 *     16/32-bit transfers, all address-control modes including
 *     Increment-with-reload, channel priority ordering, cart-bus
 *     latch + open-bus quirks the mgba-suite-dma test ROM exercises.
 *
 *   • Timers — Four 16-bit countup timers, four prescaler divisors
 *     (1/64/256/1024 CPU cycles), cascade mode, IRQ-on-overflow,
 *     deferred-write semantics (control writes apply at next tick,
 *     reload latches at overflow).
 *
 *   • BIOS — High-Level Emulation at the SWI vector. Math (Div /
 *     DivArm / Sqrt / ArcTan / ArcTan2), memory (CpuSet / CpuFastSet
 *     / RegisterRamReset), affine (BgAffineSet / ObjAffineSet),
 *     Halt / IntrWait / VBlankIntrWait with the polling-loop +
 *     re-OR-IE semantics real BIOS exhibits, decompression
 *     (LZ77UnCompWRam/VRam, RLUnCompWRam/VRam, HuffUnComp,
 *     Diff8/16bitUnFilter, BitUnPack). A real Nintendo BIOS image
 *     can be supplied via the `biosData` constructor argument; HLE
 *     is the default and covers every shipping cart we've tested.
 *
 *   • Cart backup — Auto-detection from the ROM image: SRAM (32 KiB),
 *     Flash 64 KiB (Atmel + SST + Panasonic chip IDs), Flash 128 KiB
 *     (Macronix + SST + Sanyo, with erase + bank switching), EEPROM
 *     (512 B / 8 KiB autodetected from the first DMA3 transfer).
 *     Persisted to IndexedDB through `src/ui/persistence/save-ram-gba.ts`.
 *
 *   • Cart GPIO — Plug-in feature port for the 4-pin bank at
 *     0x080000C4 / C6 / C8. Hosts the rumble actuator (Drill Dozer,
 *     WarioWare Twisted), Seiko S-3511A real-time clock (Pokémon
 *     Gen 3, Boktai), ADXRS300 Z-axis gyroscope (WarioWare Twisted),
 *     and Konami photodiode solar sensor (Boktai trilogy) — all on
 *     the same 4-pin bank, composed via the GpioFeature interface.
 *     The Yoshi-family ADXL202E accelerometer is wired separately
 *     in the SRAM register window, not GPIO.
 *
 *   • Save states + cheats — full subsystem-by-subsystem serialise
 *     prefixed with `GBA_STATE_VERSION`; older blobs walk a v(N) →
 *     v(N+1) migrator chain on load (mirrors the GB engine's
 *     `upgradeState` discipline). Cheats accept raw `AAAAAAAA:VV`
 *     and CodeBreaker `AAAAAAAA+VVVV` codes (per-frame RAM writes)
 *     plus the online libretro-DB lookup the GB popover uses.
 *
 *   • SIO link cable — Multiplayer-mode state machine (2-4 players
 *     same-machine via BroadcastChannel, 2-player cross-device via
 *     WebRTC + relay). Normal-8 / Normal-32 / UART / JOY-bus
 *     intentionally left as no-transport stubs — they only matter
 *     for GameCube / e-Reader hardware Glowboot doesn't emulate.
 *
 * See README's "GBA accuracy and known limitations" for the test-suite
 * coverage details.
 */

import type { Apu } from "./apu/apu.js";
import { cartHasTiltSensor, TiltSensor } from "./cartridge/accelerometer.js";
import { type BackupSpec, detectBackup } from "./cartridge/backup.js";
import { GbaCartGpio } from "./cartridge/gpio.js";
import { cartHasGyroscope, GpioGyroscope } from "./cartridge/gyroscope.js";
import { type GbaHeader, parseGbaHeader } from "./cartridge/header.js";
import { S3511ARtc } from "./cartridge/rtc.js";
import { cartHasGpioRtc } from "./cartridge/rtc-detect.js";
import { cartHasGpioRumble, GpioRumble } from "./cartridge/rumble.js";
import { cartHasSolarSensor, GpioSolarSensor } from "./cartridge/solar.js";
import { GbaCheatManager } from "./cheats/manager.js";
import { ArmCpu } from "./cpu/cpu.js";
import { CPSR_F, CPSR_I, MODE_IRQ, MODE_SYS } from "./cpu/registers.js";
import { armGbaPassThrough, peekGbaHit } from "./debug/breakpoints.js";
import { clearAllGbaFrames } from "./debug/call-stack.js";
import type { Joypad } from "./joypad/joypad.js";
import type { InterruptController } from "./memory/interrupts.js";
import { type GbaMemoryMap, makeGbaMemoryMap } from "./memory/mapped-bus.js";
import { DOTS_PER_SCANLINE, SCANLINES_PER_FRAME, VISIBLE_SCANLINES } from "./ppu/ppu.js";
import { GBA_STATE_VERSION, GbaStateReader, GbaStateWriter, upgradeGbaState } from "./serialization/serialization.js";
import type { Sio } from "./sio/sio.js";

/** One full PPU frame in dots — 308 dots/scanline × 228 scanlines.
 *  Multiplied by `APU_CYCLES_PER_DOT` (4) below to get the per-frame
 *  CPU cycle budget that runFrame's main loop ticks. */
const DOTS_PER_FRAME = DOTS_PER_SCANLINE * SCANLINES_PER_FRAME;

/** APU / CPU cycles per PPU dot on real hardware: the CPU runs at
 *  16.78 MHz and the dot clock at 4.19 MHz, so the ratio is 4. CPU
 *  cycles are accumulated by the step loop (per-instruction costs in
 *  cpu.ts + WAITCNT N/S accounting in the bus) and divided by 4 to
 *  drive the PPU's dot tick. The host wall clock and the APU sample
 *  clock stay aligned because runFrame ticks exactly one PPU frame's
 *  worth of CPU cycles per call. */
const APU_CYCLES_PER_DOT = 4;

/** GBA CPU clock — 16 × 1024 × 1024 = 16,777,216 Hz, per GBATEK.
 *  The frame budget that runFrame ticks is exactly
 *  `DOTS_PER_FRAME × APU_CYCLES_PER_DOT = 280,896` cycles, so the
 *  hardware-correct frame rate is `CYCLES_PER_SEC / CYCLES_PER_FRAME
 *  = 16,777,216 / 280,896 ≈ 59.7275 Hz` — same as the Game Boy. */
const CYCLES_PER_SEC = 16 * 1024 * 1024;
const CYCLES_PER_FRAME = DOTS_PER_FRAME * APU_CYCLES_PER_DOT;
export const FRAMES_PER_SEC = CYCLES_PER_SEC / CYCLES_PER_FRAME;

/** Post-BIOS stack-pointer bank initialisation, per GBATEK boot
 *  description. Real BIOS sets all three SPs and switches to SYS mode
 *  before jumping to the cart. */
const SP_USR = 0x03007f00; // shared by USR/SYS
const SP_IRQ = 0x03007fa0;
const SP_SVC = 0x03007fe0;

/** GBA cart entry point — the first instruction the BIOS jumps to. */
const CART_ENTRY = 0x08000000;

export class Gba {
  readonly mem: GbaMemoryMap;
  readonly cpu: ArmCpu;
  /** Shortcut to the APU instance owned by `mem`. Matches the
   *  `GameBoy.apu` shape so UI code can read the engine's APU through
   *  the same field on either core. */
  readonly apu: Apu;
  /** Shortcut to the Joypad instance owned by `mem`. Matches the
   *  `GameBoy.joypad` shape so UI code can drive `press` / `release`
   *  through the same field on either core. */
  readonly joypad: Joypad;
  /** Shortcut to the interrupt controller owned by `mem`. The CPU
   *  polls it before each instruction; cart code reads / writes IE,
   *  IF, IME through the bus to manage delivery. */
  readonly interrupts: InterruptController;
  /** Shortcut to the SIO controller owned by `mem`. Host UI plugs a
   *  link transport (BroadcastChannel / WebRTC) into `sio.setLink()`
   *  to enable cross-cart byte movement. Only Multiplayer mode moves
   *  data; the other SIO modes round-trip register bits but don't
   *  transfer (see `sio/sio.ts`). */
  readonly sio: Sio;
  /** Backup type discovered by scanning the ROM at construction.
   *  `"none"` means no marker was found — writes to the SRAM region
   *  return 0xFF and stores vanish (the OpenBus convention). */
  readonly backup: BackupSpec;

  /** Per-cart cheat engine. Cheats are applied once at end of each
   *  `runFrame` by writing the enabled entries' values into RAM via
   *  the bus — the GBA equivalent of GB's Game Shark mode. Mirrors
   *  `GameBoy.cheats` so the cheats popover can drive either core
   *  through the same field. */
  readonly cheats = new GbaCheatManager();

  /** Called at the end of each `runFrame` with the rendered framebuffer.
   *  Mirrors `GameBoy.onFrame` so UI code can be shape-polymorphic. */
  onFrame: ((framebuffer: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;

  /** Called once per `runFrame` with the APU's stereo sample buffer and
   *  the number of samples it contains. The host typically pushes these
   *  into an AudioContext; the buffer is owned by the APU and reused on
   *  the next frame, so callers must either consume synchronously or
   *  copy. Mirrors `GameBoy.onAudioFrame`. */
  onAudioFrame: ((left: Float32Array, right: Float32Array, count: number) => void) | null = null;

  /** True for carts that drive a rumble actuator through the cart's
   *  GPIO data register (Drill Dozer family). Hosted UI checks this to
   *  decide whether to wire `onRumbleChange` to its haptics. */
  readonly hasRumble: boolean;

  /** Called whenever the cart toggles the GPIO rumble bit. Wire to
   *  `gamepad.setRumble()` / `safeVibrate()` from the host UI to
   *  forward the cart's motor state to the user's device. Mirrors
   *  `GameBoy.cart.onRumbleChange`. */
  onRumbleChange: ((on: boolean) => void) | null = null;

  /** True for carts that ship a Seiko S-3511A real-time clock on
   *  their GPIO port (Pokémon Gen 3, Boktai trilogy). Hosted UI can
   *  surface this for status indicators / save-state metadata; the
   *  RTC itself reads from system wall-clock time, no extra wiring
   *  required for normal play. */
  readonly hasRtc: boolean;
  /** Live S-3511A instance when `hasRtc` is true; `null` otherwise.
   *  The hosted UI persists `rtc.chipState` alongside the cart's save
   *  RAM so a cart-set clock survives power cycles like the real
   *  chip's battery backing. */
  readonly rtc: S3511ARtc | null;

  /** True for carts that ship the ADXL202E 2-axis accelerometer (Yoshi
   *  Topsy-Turvy, Koro Koro Puzzle). The hosted UI wires the sensor's
   *  `tiltSource` to its keyboard / DeviceMotion reader at cart-load
   *  time, otherwise the chip stays at its neutral "GBA is level"
   *  reading. */
  readonly hasTilt: boolean;
  /** Live tilt-sensor instance when `hasTilt` is true; `null` otherwise.
   *  Exposed so the UI can plug a tilt source in without having to
   *  reach into the bus. */
  readonly tilt: TiltSensor | null;

  /** True for carts that ship the ADXRS300 single-axis Z-rotation
   *  gyroscope (WarioWare: Twisted!). Hosted UI plugs an angular-
   *  velocity reader into `gyroscope.angularVelocitySource` at cart-
   *  load time; without one the chip reports steady "no rotation". */
  readonly hasGyroscope: boolean;
  /** Live gyroscope instance when `hasGyroscope` is true; `null`
   *  otherwise. */
  readonly gyroscope: GpioGyroscope | null;

  /** True for carts that ship the Konami photodiode + ADC solar
   *  sensor (Boktai trilogy). Hosted UI plugs a brightness reader
   *  into `solarSensor.brightnessSource` at cart-load time; without
   *  one the chip reports steady "pitch black" so the player can
   *  still navigate the cart's calibration menu. */
  readonly hasSolarSensor: boolean;
  /** Live solar-sensor instance when `hasSolarSensor` is true;
   *  `null` otherwise. */
  readonly solarSensor: GpioSolarSensor | null;

  /** Wall-clock pacing multiplier honoured by the rAF loop in
   *  `runtime-gba.ts`. 1 = real-time (default), 2/4 = turbo, 0.5 =
   *  slow-mo. Mirrors `GameBoy.speedMultiplier` so the shared
   *  `cycleSpeed` hotkey wiring can target either engine through the
   *  same field. Audio is suspended at any speed other than 1×
   *  because the sample scheduler pins to wall time. */
  speedMultiplier = 1;

  /** True once a BIOS image has been supplied. SWI dispatch checks
   *  this to decide between routing through the real SWI vector at
   *  0x08 (BIOS executes) and HLE-ing the call directly. */
  readonly hasBios: boolean;

  /** Sub-frame cycle / dot carry. The last instruction of a frame
   *  straddles the 280896-cycle boundary, overshooting by 1-3 cycles.
   *  Discarding that overshoot makes the timer / APU run a few cycles
   *  fast every frame, so over thousands of frames the cart's
   *  timer-driven clocks (e.g. an audio sample-rate timer tuned to be
   *  frame-aligned) drift. Carrying the overshoot — and the <1-dot PPU
   *  remainder — into the next frame keeps the CPU / timer / APU / PPU
   *  locked to exactly 280896 cycles per frame on average. Not
   *  serialised: it's <1 instruction of state, so a save/load at worst
   *  re-introduces a few cycles of one-time error. */
  private frameCycleCarry = 0;
  private frameDotRemainder = 0;

  /** Batched peripheral-tick state. `runFrame` accumulates each step's
   *  cycles here instead of ticking timer / APU / SIO per instruction
   *  (per-call overhead was ~20% of frame time), and flushes when the
   *  backlog reaches `peripheralHorizon` — the exact cycle distance to
   *  the next observable peripheral event (timer overflow, SIO transfer
   *  completion), capped at 256 to preserve `tickPeripherals`' audio
   *  interleave granularity. A flush triggered by the horizon lands on
   *  the same instruction boundary where per-instruction ticking would
   *  have processed the event, so IRQ timing is unchanged. Reads /
   *  writes of peripheral registers drain the backlog first via the
   *  bus's `onPeripheralAccess` hook (see PeripheralAccessNotifier),
   *  and mark the horizon dirty since the access may reconfigure the
   *  event schedule. Always drained by the end of `runFrame`, so saved
   *  state never carries a backlog. */
  private peripheralDebt = 0;
  private peripheralHorizon = 1;
  private peripheralHorizonDirty = true;

  constructor(romData: Uint8Array, biosData?: Uint8Array) {
    // ROM region sized to the cart bytes; reads past the end fall
    // through to the cart open-bus handler in mapped-bus.ts, which
    // returns `(addr >> 1) & 0xFFFF` per halfword — what real GBA
    // hardware drives when no cart memory backs the address.
    this.backup = detectBackup(romData);
    this.mem = makeGbaMemoryMap(romData.length, this.backup, romData);
    this.mem.rom.set(romData);
    // Detect GPIO peripherals the cart needs: rumble actuator (Drill
    // Dozer's GPIO bit 3) and / or the Seiko S-3511A RTC (Pokémon
    // Gen 3, Boktai trilogy). They share the same four GPIO pins, so
    // a single controller hosts both as plug-in features. The header
    // parse is wrapped because unit-test fixtures legitimately
    // construct Gba with non-GBA byte sequences (just enough to
    // exercise the engine's invariants); a malformed header simply
    // means "no GPIO peripherals", not "refuse to boot".
    let header: GbaHeader | null = null;
    try {
      header = parseGbaHeader(romData);
    } catch {
      /* malformed header → no GPIO detection */
    }
    this.hasRumble = header !== null && cartHasGpioRumble(header);
    this.hasRtc = header !== null && cartHasGpioRtc(header);
    this.rtc = this.hasRtc ? new S3511ARtc() : null;
    this.hasGyroscope = header !== null && cartHasGyroscope(header);
    this.gyroscope = this.hasGyroscope ? new GpioGyroscope() : null;
    this.hasSolarSensor = header !== null && cartHasSolarSensor(header);
    this.solarSensor = this.hasSolarSensor ? new GpioSolarSensor() : null;
    if (this.hasRumble || this.rtc !== null || this.gyroscope !== null || this.solarSensor !== null) {
      const gpio = new GbaCartGpio();
      if (this.hasRumble) gpio.addFeature(new GpioRumble((on) => this.onRumbleChange?.(on)));
      if (this.rtc !== null) gpio.addFeature(this.rtc);
      if (this.gyroscope !== null) gpio.addFeature(this.gyroscope);
      if (this.solarSensor !== null) gpio.addFeature(this.solarSensor);
      this.mem.bus.cartGpio = gpio;
    }
    // Tilt sensor sits in its own cart-ROM register window (not on the
    // GPIO bus), so the controller is a separate plug-in on the bus.
    this.hasTilt = header !== null && cartHasTiltSensor(header);
    this.tilt = this.hasTilt ? new TiltSensor() : null;
    if (this.tilt !== null) this.mem.bus.cartTilt = this.tilt;
    // Optional BIOS image — the 16 KiB block at 0x00000000. Without
    // it, reads from the BIOS region return zero and SWIs are HLE'd.
    // With it, byte-read tests that probe the BIOS (e.g. jsmolka-bios
    // #1, which expects 0xE129F000 at addr 0) work, and SWIs can be
    // dispatched through the real handler (see ArmCpu's SWI path).
    this.hasBios = biosData !== undefined && biosData.length > 0;
    if (biosData !== undefined) this.mem.bios.set(biosData.subarray(0, this.mem.bios.length));
    this.apu = this.mem.apu;
    this.joypad = this.mem.joypad;
    this.sio = this.mem.sio;
    this.interrupts = this.mem.interrupts;
    // RTC /INT line → GamePak IRQ (IF bit 13). Wired here rather than
    // at chip construction because the interrupt controller doesn't
    // exist yet when the GPIO features are built.
    if (this.rtc) this.rtc.onForceIrq = () => this.interrupts.raise(13);
    // Wire the SIO module's IRQ source so Multiplayer-mode transfer-
    // complete events can fire IRQ_SERIAL. Without this the cart's
    // spin-on-IRQ pattern after START never wakes up.
    this.mem.sio.interrupts = this.interrupts;
    this.cpu = new ArmCpu(this.mem.bus, CART_ENTRY);
    this.cpu.interrupts = this.interrupts;
    this.cpu.hasBios = this.hasBios;
    this.cpu.biosHandler = this.mem.biosHandler;
    // PC-gated BIOS reads: the handler asks the CPU for its PC to
    // decide between real bytes (PC in BIOS) and the open-bus latch.
    this.mem.biosHandler.pcSource = () => this.cpu.regs.r[15]! | 0;
    // Write-only PPU register reads return the CPU's current open-bus
    // value (prefetched ARM opcode at PC+8) per real ARM7TDMI — the
    // mgba-suite io-read test plants a `.word 0xDEADDEAD` after each
    // probe and checks the read returns the literal, not the value
    // written to the register.
    this.mem.ppu.openBusSource = () => this.cpu.currentOpenBus();
    // Same open-bus contract for the DMA controller's write-only
    // registers (SAD / DAD / CNT_L). Reads of these slots return the
    // prefetched ARM opcode rather than the stored register state.
    this.mem.dma.openBusSource = () => this.cpu.currentOpenBus();
    // And for the APU's write-only FIFO_A / FIFO_B push slots.
    this.mem.apu.openBusSource = () => this.cpu.currentOpenBus();
    // And for the catch-all MMIO open-bus handler covering
    // 0x04000400-0x04FFFFFF (the "Not used" half of the I/O region).
    this.mem.ioOpenBus.source = () => this.cpu.currentOpenBus();
    // HALTCNT writes flip the CPU to halted; release follows the same
    // (IE & IF) != 0 path as biosHalt.
    this.mem.power.onHalt = () => {
      this.cpu.halted = true;
      this.cpu.intrWaitMask = 0;
    };
    // Immediate DMA triggers fire synchronously inside the CPU step's
    // bus write. The DMA reads its source register before the periphery
    // tick at end of step has run, so without intervention TM*CNT_L
    // reads would observe stale timer state. The DMA charges its
    // hardware-spec startup cycles via this callback so timer / APU
    // catch up before the read; the runFrame loop subtracts the
    // pre-ticked count from the end-of-step tick to keep totals in
    // balance.
    this.mem.dma.onCyclesElapsed = (cycles: number) => {
      // Catch the timer / APU up on the batched backlog first so the
      // pre-ticked startup cycles land on current state, in order.
      this.flushPeripheralDebt();
      this.mem.timer.tick(cycles);
      this.mem.apu.tick(cycles);
    };
    // Peripheral register accesses observe batched timer / APU / SIO
    // state — drain the backlog so they see exactly what
    // per-instruction ticking would have produced (see peripheralDebt).
    this.mem.bus.onPeripheralAccess = () => this.flushPeripheralDebt();
    // Real BIOS sets POSTFLG=1 right before handing control to the
    // cart. nba-hw-test haltcnt's POSTFLG sub-test reads back 1
    // (and checks CpuSet doesn't clear it).
    this.mem.power.postflg = 1;
    // Real BIOS also writes WAITCNT=0x4317 (WS0 N=3/S=1, WS1 N=4/S=4,
    // WS2 N=8/S=8, SRAM N=3, prefetch enabled). The bus's hardware-
    // reset default is 0x0000 (all WS slots = 4 cycles, no prefetch),
    // which doesn't match what cart code expects after BIOS boot. Seed
    // post-BIOS state for both real-BIOS and HLE-BIOS paths since we
    // skip-boot directly to the cart entry rather than running the
    // BIOS reset sequence.
    this.interrupts.write16(0x04, 0x4317);
    // GBA hardware reset value of DISPCNT is 0x0080 (FORCED_BLANK on,
    // mode 0). The real BIOS doesn't write DISPCNT during boot, so this
    // value persists into cart entry. Class default is 0, which means
    // carts that read DISPCNT before writing observe a different state
    // than real hardware.
    this.mem.ppu.dispcnt = 0x0080;
    if (this.hasBios) {
      // Skip-boot seed for the BIOS prefetch latch. After a real BIOS
      // boot ends with `BX LR` at offset 0xDC, the latch holds the
      // word at 0xDC+8 = 0xE4 (Nintendo BIOS: `MSR CPSR_fc, r0` =
      // 0xE129F000). Pre-populate so cart code that reads [0] before
      // touching a SWI sees the post-boot value — jsmolka-bios #1
      // verifies this exact byte.
      const b = this.mem.bios;
      this.mem.biosHandler.biosOpenBus =
        (b[0xe4] ?? 0) | ((b[0xe5] ?? 0) << 8) | ((b[0xe6] ?? 0) << 16) | ((b[0xe7] ?? 0) << 24) | 0;
    } else {
      // HLE mode: pre-seed the open-bus latch with the same post-boot
      // value real Nintendo BIOS leaves on it (`MSR CPSR_fc, r0` at
      // 0xE4, encoded 0xE129F000). Several commercial carts probe a
      // BIOS address from cart-ROM PC at startup as a "BIOS present?"
      // check — without a real BIOS, the read falls through to this
      // latch. Returning the canonical post-boot value lets Legends of
      // Wrestling II, Motocross Maniacs Advance, both Frogger Advance
      // games, and the Konami Collector's Series get past their startup
      // gate.
      this.mem.biosHandler.biosOpenBus = 0xe129f000 | 0;
    }
    // BIOS-equivalent stack-pointer setup. ArmRegisters starts in SVC
    // mode, so we visit each mode in turn to seed its banked SP, then
    // land in SYS mode (which is what real BIOS leaves the cart in).
    this.cpu.regs.r[13] = SP_SVC;
    this.cpu.regs.setMode(MODE_IRQ);
    this.cpu.regs.r[13] = SP_IRQ;
    this.cpu.regs.setMode(MODE_SYS);
    this.cpu.regs.r[13] = SP_USR;
    // Real BIOS hands control to the cart in SYS mode with CPSR.I=0
    // (IRQs unmasked at the CPU level) and CPSR.F=0. IRQ delivery is
    // then gated entirely by IME/IE/IF — the cart writes IME=1 when
    // it's ready. ArmRegisters defaults to I=1/F=1 (real reset state),
    // so we clear them here to match what carts observe in practice;
    // jsmolka-bios #3 relies on default-CPSR IRQ delivery.
    this.cpu.regs.cpsr = (this.cpu.regs.cpsr & ~(CPSR_I | CPSR_F)) | 0;
    // Real BIOS spends ~126 visible scanlines on its boot path (logo
    // display + RAM clear + cart-region checksum) before BX-ing to the
    // cart at 0x08000000 — observed by reading VCOUNT at the cart-
    // entry breakpoint under GDB. Our HLE skips that work entirely,
    // so without compensation we'd hand the cart vcount=0. Polarium
    // Advance's init runs a long EWRAM-clear DMA
    // (~190 scanlines worth of cycles) immediately after entry; with
    // vcount=0 the DMA finishes at line ~190 (past VBlank), the cart
    // misses its VCount=150 IRQ window, and the IRQ that does fire
    // (VBlank=160) routes the cart down a different code path that
    // wedges.
    //
    // A 100-line pre-tick was the empirical sweep winner across the
    // five carts wedged at this gate (Robot Wars, SimCity 2000,
    // Polarium, Bratz Babyz, Justice League Chronicles). At 100,
    // Polarium reaches the Health & Safety screen, SimCity reaches
    // "Licensed by Nintendo", and Justice League starts drawing
    // pixels. Higher values (125-180) regress Justice League; lower
    // values fail to land Polarium past its first IRQ. The 26-line
    // offset from the 126 real BIOS actually leaves at cart entry is
    // because HLE skips subtle bus / cycle work the real BIOS does —
    // our cart races forward faster once it starts.
    this.mem.ppu.tick(100 * DOTS_PER_SCANLINE);
  }

  /** Advance one PPU frame's worth of CPU work, render the result, and
   *  fire `onFrame` (and `onAudioFrame` if wired). Returns the number
   *  of instructions executed.
   *
   *  When `skipRender` is true, the PPU advances all DISPSTAT/IRQ/HDMA
   *  state normally but bypasses per-scanline pixel painting, and the
   *  `onFrame` callback is not fired (the framebuffer stays at whatever
   *  the previous rendered frame produced). Audio still flushes —
   *  audio fidelity is more user-noticeable than animation smoothness,
   *  so the UI's adaptive frame-skip policy keeps audio at real-time.
   *
   *  Cycle plumbing: the CPU sets `lastCycles` on every `step()` and
   *  we tick the periphery (PPU / APU / timer) by that amount. Each
   *  step is sized from its instruction's S/N/I components (cpu.ts) +
   *  WAITCNT-aware fetch / access cycles (mapped-bus.ts), so the
   *  scheduler advances real-time-correct on average over a frame. */
  runFrame(skipRender = false): number {
    const cyclesPerFrame = DOTS_PER_FRAME * APU_CYCLES_PER_DOT;
    // Let the user single-step off a PC breakpoint: the PC at frame
    // entry is allowed through once before the registry re-arms the
    // same address. Mirrors the GB armPassThrough wired into
    // GameBoy.runFrame for the same reason.
    armGbaPassThrough(this.cpu.regs.r[15]! >>> 0);
    this.mem.ppu.skipRender = skipRender;
    // Continue from the previous frame's overshoot so the periphery
    // stays locked to exactly cyclesPerFrame per frame on average
    // (see frameCycleCarry).
    let cycles = this.frameCycleCarry;
    let dotRemainder = this.frameDotRemainder;
    // Reset per-frame HALT counter so the pacer's CPU-load metric
    // reads `cpu.haltedCycles` over a known window. Mirrors GB.
    this.cpu.haltedCycles = 0;
    // Two-condition exit: at least cyclesPerFrame cycles consumed AND
    // the PPU is currently in VBlank (vcount ≥ VISIBLE_SCANLINES).
    // Without the second condition, a call that enters mid-visible
    // (constructor leaves vcount=100, save-state loads can leave any
    // value) ticks exactly DOTS_PER_FRAME dots and exits at the same
    // mid-visible vcount — the framebuffer's top half then comes from
    // one VBlank-handler output, the bottom half from the next, and
    // the resulting horizontal seam at row=entry_vcount is visible
    // any time the cart updates scroll during VBlank (i.e. most
    // platformers). Ending in VBlank means the visible 0..159 the
    // call just rendered all comes from one VBlank-handler output.
    const ppu = this.mem.ppu;
    while (cycles < cyclesPerFrame || ppu.vcount < VISIBLE_SCANLINES) {
      this.mem.dma.preTickedThisStep = 0;
      if (this.cpu.halted) {
        // Exact-wake halt: a halted step consumes cycles up to the
        // nearer of the timer/SIO horizon (whose flush raises the IRQ
        // on its exact cycle) or the next PPU event dot (VBlank /
        // HBlank / VCount IRQs, HDMA). The wake then lands on the
        // event's cycle with no no-op quantization — and halt-heavy
        // frames advance in scanline-sized jumps instead of 4-cycle
        // steps. A dirty horizon falls back to one legacy-width step;
        // the flush below recomputes it for the next iteration.
        const toHorizon = this.peripheralHorizonDirty ? 4 : this.peripheralHorizon - this.peripheralDebt;
        const toPpu = ppu.dotsToNextEvent() * APU_CYCLES_PER_DOT - dotRemainder;
        let chunk = toHorizon < toPpu ? toHorizon : toPpu;
        if (chunk < 1) chunk = 1;
        this.cpu.haltCycleBudget = chunk;
      }
      this.cpu.step();
      const stepCycles = this.cpu.lastCycles | 0;
      cycles += stepCycles;
      // An immediate DMA inside this step may have already advanced
      // timer / APU via the onCyclesElapsed callback so its bus reads
      // see fresh counter state. Subtract that here so we don't tick
      // those cycles a second time.
      const preTicked = this.mem.dma.preTickedThisStep | 0;
      const peripheryCycles = stepCycles - preTicked;
      if (peripheryCycles > 0) this.peripheralDebt += peripheryCycles;
      if (this.peripheralHorizonDirty || this.peripheralDebt >= this.peripheralHorizon) {
        this.flushPeripheralDebt();
        this.recomputePeripheralHorizon();
      }
      dotRemainder += stepCycles;
      // PPU ticks in whole dots (one dot = APU_CYCLES_PER_DOT cycles).
      // Accumulate fractional cycles across steps so we don't lose a
      // dot to truncation when instructions return non-multiple-of-4
      // cycle counts.
      const dots = dotRemainder >>> 2; // ÷ APU_CYCLES_PER_DOT (= 4); dotRemainder is never negative
      if (dots > 0) {
        this.mem.ppu.tick(dots);
        dotRemainder &= 3;
      }
      // Bail out as soon as a breakpoint / watchpoint latches a hit.
      // The CPU sets lastCycles=0 on PC hits so the loop usually exits
      // on the cycle-count check; this extra peek catches read/write
      // watchpoints that fire inside a normal-cost instruction.
      if (peekGbaHit()) break;
    }
    this.cpu.haltCycleBudget = 4;
    this.flushPeripheralDebt();
    // Carry the boundary overshoot (and sub-dot remainder) into the next
    // frame. clamp >= 0 so an early breakpoint break (cycles < frame)
    // doesn't lend the next frame extra time.
    this.frameCycleCarry = cycles > cyclesPerFrame ? cycles - cyclesPerFrame : 0;
    this.frameDotRemainder = dotRemainder;
    this.finishFrame(skipRender);
    return cycles;
  }

  /** Drain the batched peripheral-tick backlog. Clears the debt BEFORE
   *  ticking: a timer overflow inside the flush can pop a Direct Sound
   *  FIFO, trigger its refill DMA, and re-enter through the DMA's
   *  pre-tick callback — the cleared debt makes that re-entry a no-op
   *  instead of a double-tick. */
  private flushPeripheralDebt(): void {
    const debt = this.peripheralDebt;
    if (debt > 0) {
      this.peripheralDebt = 0;
      this.tickPeripherals(debt);
    }
    this.peripheralHorizonDirty = true;
  }

  private recomputePeripheralHorizon(): void {
    const t = this.mem.timer.cyclesToNextEvent();
    const s = this.sio.cyclesToNextEvent();
    let horizon = t < s ? t : s;
    if (horizon > 256) horizon = 256;
    this.peripheralHorizon = horizon;
    this.peripheralHorizonDirty = false;
  }

  /** Interleave timer / APU / SIO ticks in ≤256-cycle chunks. A long
   *  halt step (50 k+ cycles for a VBlankIntrWait) would otherwise emit
   *  all its host audio samples reading one frozen Direct-Sound-held
   *  value while the timer overflows dozens of times during the same
   *  window — the cart's DS stream gets decimated to ~1-in-40 samples
   *  per halt boundary and the music's timbre collapses to tinny
   *  stair-step junk. With 256-cycle chunks each chunk covers ≤1
   *  host-sample emit and ≤1 timer overflow, so the DS sample update
   *  lands BEFORE the host sample that should observe it. */
  private tickPeripherals(cycles: number): void {
    let remaining = cycles;
    while (remaining > 0) {
      let chunk = remaining > 256 ? 256 : remaining;
      // End the chunk exactly at the APU's next host-sample emission
      // so the sample observes FIFO pops / PSG state advanced to its
      // own emission cycle — not state from later in the chunk.
      const toSample = this.mem.apu.cyclesToNextSample();
      if (toSample < chunk) chunk = toSample;
      this.mem.timer.tick(chunk);
      this.mem.apu.tick(chunk);
      this.sio.tick(chunk);
      remaining -= chunk;
    }
  }

  get framebuffer(): Uint8ClampedArray<ArrayBuffer> {
    return this.mem.ppu.framebuffer;
  }

  /** Run one full frame. Alias of {@link runFrame} matching the GB
   *  engine's debugger-step contract — the GBA core has no breakpoint
   *  pass-through machinery to coordinate with yet, so this is a plain
   *  forwarder. Kept as a distinct entry point so the UI's
   *  `frameAdvance` action can call into either engine uniformly. */
  stepFrame(): number {
    return this.runFrame();
  }

  /** Run CPU + subsystems up to ~`budget` cycles. Unlike {@link runFrame}
   *  this does NOT loop until a frame boundary and does NOT fire
   *  `onFrame` / `onAudioFrame` — it's the partial-step primitive used
   *  to interleave two engines (e.g. cross-tab Multi-Pak) at sub-frame
   *  granularity, so master/slave SIO transfers can pair within a
   *  single transfer window instead of one full frame apart.
   *
   *  Uses the shared `frameDotRemainder` so a sequence of small
   *  `runForCycles` calls covering one frame's worth of cycles ticks
   *  the PPU identically to one `runFrame` call. Caller is responsible
   *  for invoking {@link finishFrame} once total cycles ~= one frame to
   *  fire `onFrame` / `onAudioFrame` and apply per-frame cheats.
   *
   *  Returns the actual cycle count consumed (one instruction can
   *  overshoot `budget` slightly). */
  runForCycles(budget: number): number {
    let totalCycles = 0;
    let dotRemainder = this.frameDotRemainder;
    while (totalCycles < budget) {
      this.mem.dma.preTickedThisStep = 0;
      this.cpu.step();
      const stepCycles = this.cpu.lastCycles | 0;
      if (stepCycles === 0) break;
      totalCycles += stepCycles;
      const preTicked = this.mem.dma.preTickedThisStep | 0;
      const peripheryCycles = stepCycles - preTicked;
      if (peripheryCycles > 0) this.tickPeripherals(peripheryCycles);
      dotRemainder += stepCycles;
      const dots = dotRemainder >>> 2; // ÷ APU_CYCLES_PER_DOT (= 4); dotRemainder is never negative
      if (dots > 0) {
        this.mem.ppu.tick(dots);
        dotRemainder &= 3;
      }
    }
    this.frameDotRemainder = dotRemainder;
    return totalCycles;
  }

  /** Frame-end housekeeping that {@link runFrame} runs after its inner
   *  step loop. Exposed for callers that build a frame out of multiple
   *  {@link runForCycles} calls (e.g. the chunked sub-frame interleave
   *  used by paired-Multi-Pak sessions): once ~one frame's cycles have
   *  accumulated, call this to fire `onFrame`, push audio, and apply
   *  per-frame cheat writes. `skipRender` mirrors `runFrame`'s param. */
  finishFrame(skipRender = false): void {
    this.cheats.apply(this.mem.bus);
    if (!skipRender) this.onFrame?.(this.framebuffer);
    this.mem.ppu.skipRender = false;
    this.apu.recordFrameSampleCount(this.apu.outPos);
    if (this.onAudioFrame && this.apu.outPos > 0) {
      this.onAudioFrame(this.apu.outLeft, this.apu.outRight, this.apu.outPos);
    }
    this.apu.outPos = 0;
  }

  /** Run exactly one CPU instruction (or one interrupt-dispatch cycle)
   *  plus the proportional subsystem work that normally happens inside
   *  {@link runFrame}. Returns the cycle count consumed. Used by the
   *  UI's instruction-step action — gives single-instruction resolution
   *  over PC movement so a user can walk through ARM/Thumb code.
   *
   *  Intentionally does NOT fire `onFrame` / `onAudioFrame` (those are
   *  runFrame-cadence concerns); the host repaints the partial
   *  framebuffer separately. Halt handling mirrors GB: when entering
   *  halted, keep ticking until the CPU wakes, capped at one frame so
   *  a halt with no live IRQ source can't lock the main thread. */
  stepInstruction(): number {
    const cap = DOTS_PER_FRAME * APU_CYCLES_PER_DOT;
    // Arm the current PC for pass-through so Step at a breakpointed
    // address advances instead of re-firing the same break and
    // bailing out of the inner loop on cycles=0.
    armGbaPassThrough(this.cpu.regs.r[15]! >>> 0);
    let totalCycles = 0;
    let dotRemainder = 0;
    while (totalCycles < cap) {
      this.cpu.step();
      const stepCycles = this.cpu.lastCycles | 0;
      if (stepCycles === 0) break;
      totalCycles += stepCycles;
      this.mem.apu.tick(stepCycles);
      this.mem.timer.tick(stepCycles);
      this.sio.tick(stepCycles);
      dotRemainder += stepCycles;
      const dots = dotRemainder >>> 2; // ÷ APU_CYCLES_PER_DOT (= 4); dotRemainder is never negative
      if (dots > 0) {
        this.mem.ppu.tick(dots);
        dotRemainder &= 3;
      }
      if (!this.cpu.halted) break;
    }
    return totalCycles;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  /**
   * Snapshot the entire emulator state — CPU, all subsystems, all
   * mutable memory regions, and the cartridge's backup chip (if any) —
   * into a self-contained byte buffer prefixed with the current
   * `GBA_STATE_VERSION`. Pair with {@link loadState} to restore.
   *
   * Not serialised: the ROM bytes (the cart is the source of truth on
   * reload) and the BIOS region (zero-filled by us).
   */
  saveState(): Uint8Array {
    const w = new GbaStateWriter();
    w.u8(GBA_STATE_VERSION);
    this.cpu.serialize(w);
    this.interrupts.serialize(w);
    this.mem.ppu.serialize(w);
    this.mem.apu.serialize(w);
    this.mem.timer.serialize(w);
    this.mem.dma.serialize(w);
    this.joypad.serialize(w);
    // Mutable memory regions. EWRAM and IWRAM are CPU-visible RAM;
    // VRAM / palette / OAM are PPU-visible RAM owned by the bus.
    w.bytes(this.mem.ewram);
    w.bytes(this.mem.iwram);
    w.bytes(this.mem.vram);
    w.bytes(this.mem.palette);
    w.bytes(this.mem.oam);
    // Cartridge backup — at most one of sram / flash / eeprom is non-null
    // for a given cart. The kind is determined at construction from the
    // ROM marker, so we don't need a tag byte; the loader has already
    // wired the matching backup instance.
    if (this.mem.sram) this.mem.sram.serialize(w);
    if (this.mem.flash) this.mem.flash.serialize(w);
    if (this.mem.eeprom) this.mem.eeprom.serialize(w);
    if (this.tilt !== null) this.tilt.serialize(w);
    if (this.gyroscope !== null) this.gyroscope.serialize(w);
    if (this.solarSensor !== null) this.solarSensor.serialize(w);
    return w.finalize();
  }

  loadState(bytes: Uint8Array): void {
    // Mid-execution restore: blow away the call-stack tracker. The new
    // CPU state has no history with the frames currently in the
    // module — keeping them would show a chain that never existed.
    clearAllGbaFrames();
    // Walk the migrator chain to the current GBA_STATE_VERSION before
    // touching any subsystem state. Older blobs migrate up; newer-
    // than-build or older-than-oldest-migrator throws so a stale
    // snapshot results in a fresh boot rather than partial corruption.
    const upgraded = upgradeGbaState(bytes);
    const r = new GbaStateReader(upgraded);
    r.u8(); // consume the version byte
    this.cpu.deserialize(r);
    this.interrupts.deserialize(r);
    this.mem.ppu.deserialize(r);
    this.mem.apu.deserialize(r);
    this.mem.timer.deserialize(r);
    this.mem.dma.deserialize(r);
    this.joypad.deserialize(r);
    r.bytes(this.mem.ewram);
    r.bytes(this.mem.iwram);
    r.bytes(this.mem.vram);
    r.bytes(this.mem.palette);
    r.bytes(this.mem.oam);
    if (this.mem.sram) this.mem.sram.deserialize(r);
    if (this.mem.flash) this.mem.flash.deserialize(r);
    if (this.mem.eeprom) this.mem.eeprom.deserialize(r);
    if (this.tilt !== null) this.tilt.deserialize(r);
    if (this.gyroscope !== null) this.gyroscope.deserialize(r);
    if (this.solarSensor !== null) this.solarSensor.deserialize(r);
  }
}
