/**
 * S-SMP — the audio subsystem's computer: an SPC700, 64 KiB ARAM, three
 * timers, four mailbox ports to the main CPU, and the S-DSP behind the
 * $F2/$F3 register pair.
 *
 * The 64-byte IPL boot ROM is not embedded; its externally visible
 * protocol is HLE'd instead (like the GBA BIOS): after reset the SMP
 * answers $AA/$BB on the ports, accepts the standard block-upload
 * handshake ($CC kick, per-byte counter acks, address/execute records),
 * writes the blocks into ARAM, and on the execute record starts the
 * SPC700 at the given entry with the boot-ROM's documented register
 * state. From that point on, everything that runs is the game's own
 * uploaded driver on the real core.
 *
 * Timers: T0/T1 divide the 1.024 MHz clock by 128 (8 kHz), T2 by 16
 * (64 kHz); each counts up to its $FAx target into a 4-bit read-to-clear
 * counter at $FDx.
 *
 * Reference: fullsnes "SNES APU" (SMP registers, IPL boot ROM protocol).
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";
import { Spc700 } from "./cpu.js";
import { SnesDsp } from "./dsp.js";

/** Boot-loader states, one per loop of the documented 64-byte IPL ROM.
 *  The machine POLLS the port latches in emulated SPC time (it never
 *  reacts to main-CPU writes directly) — that polling is what resolves
 *  every write-order race the same way hardware does: however many port
 *  writes land between two polls, the loader only ever sees the settled
 *  latches. */
const enum IplState {
  Init, // reset / re-entry housekeeping (zero-page clear) before announcing
  Announce, // ports show $AA/$BB; polling for the $CC kick on port 0
  AwaitZero, // block entry (MOV Y,$F4 / BNE): poll until port 0 reads 0
  Data, // byte loop: port0==Y -> store+ack; port0>Y -> Record; else wait
  Record, // read dest from ports 2/3, echo port 0; port1 selects data/exec
  Handoff, // register setup + indirect jump before the driver's first fetch
  Running // uploaded driver executing on the core
}

// Per-iteration SPC-cycle costs of the ROM's loops (sums of the documented
// instruction timings; exactness matters less than being nonzero and
// plausible — the main CPU runs thousands of cycles between these).
const IPL_CYCLES_POLL = 9;
const IPL_CYCLES_BYTE = 25;
const IPL_CYCLES_RECORD = 26;
const IPL_CYCLES_EXEC = 40;
const IPL_CYCLES_FULL_INIT = 2400; // SP setup + zero-page clear loop

/** The documented S-SMP timer pipeline, clocked in the 2048 kHz domain
 *  (2 clocks per SPC cycle). Stage 1 keeps
 *  toggling while the timer is disabled — phase continuity is what the
 *  formula timer this replaces could not express — and the enable gates sit
 *  at stage 2. The TEST-register enable/disable bits force the stage-1 level
 *  low, so toggling them manufactures falling edges (counted ticks). */
class ApuTimer {
  stage0 = 0;
  stage1 = 0;
  stage2 = 0; // 8-bit; wraps, so target 0 divides by 256
  stage3 = 0; // 4-bit read-to-clear output
  line = false;
  enable = false;
  target = 0;

  constructor(private readonly frequency: number) {}

  serialize(w: SnesStateWriter): void {
    w.u16(this.stage0);
    w.u8(this.stage1);
    w.u8(this.stage2);
    w.u8(this.stage3);
    w.bool(this.line);
    w.bool(this.enable);
    w.u8(this.target);
  }

  deserialize(r: SnesStateReader): void {
    this.stage0 = r.u16();
    this.stage1 = r.u8();
    this.stage2 = r.u8();
    this.stage3 = r.u8();
    this.line = r.bool();
    this.enable = r.bool();
    this.target = r.u8();
  }

  step(clocks: number, host: SnesApu): void {
    this.stage0 += clocks;
    while (this.stage0 >= this.frequency) {
      this.stage0 -= this.frequency;
      this.stage1 ^= 1;
      this.synchronizeStage1(host);
    }
  }

  synchronizeStage1(host: SnesApu): void {
    let level = this.stage1 === 1;
    if (!host.timersEnable) level = false;
    if (host.timersDisable) level = false;
    const falling = this.line && !level;
    this.line = level;
    if (!falling) return; // stage 2 pulses on 1->0 transitions only
    if (!this.enable) return;
    this.stage2 = (this.stage2 + 1) & 0xff;
    if (this.stage2 !== this.target) return;
    this.stage2 = 0;
    this.stage3 = (this.stage3 + 1) & 0x0f;
  }

  read(): number {
    const v = this.stage3;
    this.stage3 = 0;
    return v;
  }
}

// TEST-register waitstate dividers (reference `cycleWaitStates` /
// `timerWaitStates`): clocks consumed per opcode cycle, and clocks fed to
// the timers per opcode cycle. Settings 2-3 are the glitchy 10/20 modes.
const CYCLE_WAIT_STATES = [2, 4, 10, 20] as const;
const TIMER_WAIT_STATES = [2, 4, 8, 16] as const;

/** Interleave-granularity margin (SPC cycles): the core only starts an
 *  instruction when at least this much budget remains, bounding both how far
 *  a port access can commit past the main CPU's position (overshoot) and how
 *  stale the SPC's outbound port writes can be when the CPU reads them
 *  (lag). Hardware interleaves per cycle with zero lag — unreachable with
 *  whole-instruction stepping — and the two failure modes pull opposite
 *  ways: Kishin Douji Zenki's rendezvous needs enough gating that its
 *  clear-then-check pass doesn't burst past pending-write stamps, while
 *  Clock Tower's streaming loader desyncs (a false end-of-block zero read)
 *  when the driver's echo reaches the main CPU more than ~4 cycles late.
 *  4 satisfies both; calibrate against those carts before changing it. */
const SPC_STEP_MARGIN = 4;

export class SnesApu {
  readonly aram = new Uint8Array(0x10000);
  readonly cpu: Spc700;
  readonly dsp = new SnesDsp(this.aram);

  /** Mailbox as seen by the main CPU ($2140-$2143): what the SPC drove. */
  readonly portsToCpu = new Uint8Array(4);
  /** Mailbox as seen by the SPC ($F4-$F7): what the CPU drove. */
  readonly portsToSpc = new Uint8Array(4);

  private readonly timers = [new ApuTimer(128), new ApuTimer(128), new ApuTimer(16)];

  // TEST register ($F0) state — reference defaults.
  timersEnable = true;
  timersDisable = false;
  private ramWritable = true;
  private ramDisable = false;
  private externalWaitStates = 0;

  private iplState = IplState.Init;
  /** Destination pointer (the ROM's $00/$01 word) and byte counter Y. */
  private iplPointer = 0;
  private iplY = 0;
  /** Cycle budget owed before the current state acts again. */
  private iplDelay = 0;
  /** Whether this loader pass entered through $FFC0-$FFC2 (reset or a jump
   *  to the very start), whose MOV X,#$EF / MOV SP,X runs. Mid-ROM
   *  re-entries skip it, keeping the driver's stack — multi-stage uploaders
   *  (Champions World Class Soccer) exec a bare RET that returns into the
   *  stage-1 code via the stack the driver prepared. */
  private iplSetsSp = true;

  private cycleRemainder = 0;
  /** Absolute wall-clock budget (SPC cycles) the core may consume up to.
   *  Persistent across tick calls: an instruction that overshoots one
   *  call's budget starts the next call in debt, so the SPC runs at true
   *  1.024 MHz instead of racing ahead of small per-call budgets. */
  private cpuTarget = 0;
  /** SPC cycles already converted into timer clocks — timers are fed up to
   *  the CPU's progress (phase lock for timer reads) but never past the
   *  wall budget, and always catch up to it by the end of a tick. */
  private timerFed = 0;

  constructor() {
    this.cpu = new Spc700({
      read: (a) => this.busRead(a),
      write: (a, v) => this.busWrite(a, v)
    });
    this.reset();
  }

  reset(): void {
    this.control = 0x80; // IPL ROM mapped at $FFC0
    this.iplState = IplState.Init;
    this.iplDelay = IPL_CYCLES_FULL_INIT;
    this.iplSetsSp = true;
    this.portsToCpu.fill(0);
    this.portsToSpc.fill(0);
    this.cpu.stopped = true; // held until the IPL upload hands over
  }

  /** Uploaded code jumped back into the IPL ROM region: on hardware the
   *  boot ROM's loader loop runs again and re-announces $AA/$BB. Multi-stage
   *  uploaders (stub first, real driver second) rely on this round trip.
   *  A jump to the very start replays the full init (zero-page clear);
   *  mid-ROM entries skip it. */
  private reenterIpl(): void {
    // Back to the polled loader, which reads settled latches directly.
    this.drainPendingWrites(Infinity);
    this.iplState = IplState.Init;
    this.iplSetsSp = this.cpu.pc <= 0xffc2;
    this.iplDelay = this.iplSetsSp ? IPL_CYCLES_FULL_INIT : IPL_CYCLES_POLL;
    this.cpu.stopped = true;
  }

  /** Main-CPU side: $2140-$2143 reads. */
  cpuReadPort(port: number): number {
    return this.portsToCpu[port & 3]!;
  }

  /** Pending main-CPU port writes while the uploaded driver runs, as flat
   *  (spc-cycle stamp, port, value) triples. The SPC's own port reads (and
   *  CONTROL port-clears) at exact cycle c observe only writes that landed
   *  early enough to be sampled, which reproduces hardware event ordering:
   *  a write the main CPU issues after the SPC's read must not be visible
   *  to that read even though the emulator executes the two cores in
   *  turns. The IPL loader states poll in budget time instead and keep the
   *  direct-latch path. */
  private pendingWrites: number[] = [];

  /** Main-CPU side: $2140-$2143 writes only latch — the boot loader reads
   *  the latches when its polling loops come around, never synchronously.
   *  The host must sync the APU to the write's master-cycle time first
   *  (snes.ts syncApu) so the stamp taken here is exact. */
  cpuWritePort(port: number, v: number): void {
    if (this.iplState === IplState.Running) {
      // Sub-cycle stamp: the accumulator's residue places the write at its
      // true fractional position between SPC cycles, so poll loops whose
      // periods are integer in one clock domain can't form standing ties
      // against the other domain's cycle grid.
      const t = this.cpuTarget + this.cycleRemainder / 2684659;
      this.pendingWrites.push(t, port & 3, v & 0xff);
    } else {
      this.portsToSpc[port & 3] = v & 0xff;
    }
  }

  /** Apply pending main-CPU port writes visible to an observation at SPC
   *  cycle `upTo`. A read's bus cycle spans (upTo-1, upTo] and samples
   *  mid-cycle, so a write must land at least half a cycle earlier to be
   *  seen — the fullsnes "data may be garbled, always re-fetch" simultaneity
   *  resolves to the old value. That hold-off shortens tight clear-then-read
   *  windows enough that Kishin Douji Zenki's rendezvous escapes through the
   *  DRAM-refresh gap like hardware. */
  private drainPendingWrites(upTo: number): void {
    this.drainPendingBefore(upTo - 0.5);
  }

  /** The SPC's own port-clearing CONTROL write takes effect at the END of
   *  its bus cycle (no mid-cycle sampling discount): main-CPU writes landing
   *  during that same cycle are erased, ones after it survive. The half-
   *  cycle asymmetry against reads is what makes the clear-then-read window
   *  fractionally shorter than its instruction span, as on hardware. */
  private drainPendingBefore(limit: number): void {
    const q = this.pendingWrites;
    let i = 0;
    while (i < q.length && q[i]! < limit) {
      this.portsToSpc[q[i + 1]!] = q[i + 2]!;
      i += 3;
    }
    if (i > 0) q.splice(0, i);
  }

  /** Advance the boot loader by `spcCycles` of emulated time. Each state is
   *  one loop of the documented IPL ROM, with matching per-iteration cost. */
  private iplTick(spcCycles: number): void {
    let budget = spcCycles;
    while (budget > 0) {
      if (this.iplDelay > budget) {
        this.iplDelay -= budget;
        return;
      }
      budget -= this.iplDelay;
      this.iplDelay = 0;
      switch (this.iplState) {
        case IplState.Init:
          this.portsToCpu[0] = 0xaa;
          this.portsToCpu[1] = 0xbb;
          this.iplState = IplState.Announce;
          this.iplDelay = IPL_CYCLES_POLL;
          break;
        case IplState.Announce:
          // CMP $F4,#$CC / BNE — the kick, handled by the shared record
          // path (which is why the kick needs port 1 nonzero).
          if (this.portsToSpc[0] === 0xcc) {
            this.iplState = IplState.Record;
            this.iplDelay = IPL_CYCLES_RECORD;
          } else {
            this.iplDelay = IPL_CYCLES_POLL;
          }
          break;
        case IplState.Record: {
          // MOVW YA,$F6 / MOVW $00,YA / MOVW YA,$F4 / MOV $F4,A — read the
          // destination pointer (which the ROM keeps in zero page $00/$01,
          // where drivers can see it), echo port 0, dispatch on port 1.
          this.iplPointer = this.portsToSpc[2]! | (this.portsToSpc[3]! << 8);
          this.aram[0] = this.iplPointer & 0xff;
          this.aram[1] = this.iplPointer >> 8;
          const selector = this.portsToSpc[1]!;
          this.portsToCpu[0] = this.portsToSpc[0]!;
          if (selector !== 0) {
            this.iplState = IplState.AwaitZero;
            this.iplDelay = IPL_CYCLES_POLL;
          } else {
            this.iplState = IplState.Handoff;
            this.iplDelay = IPL_CYCLES_EXEC;
          }
          break;
        }
        case IplState.AwaitZero:
          // MOV Y,$F4 / BNE — the block's byte counter starts at 0.
          if (this.portsToSpc[0] === 0) {
            this.iplY = 0;
            this.iplState = IplState.Data;
          }
          this.iplDelay = IPL_CYCLES_POLL;
          break;
        case IplState.Data: {
          const diff = (this.portsToSpc[0]! - this.iplY) & 0xff;
          if (diff === 0) {
            // store [$00]+Y, echo Y, INC Y (page-crossing bumps the
            // pointer's high byte, so the stream is linear).
            this.aram[(this.iplPointer + this.iplY) & 0xffff] = this.portsToSpc[1]!;
            this.portsToCpu[0] = this.iplY;
            this.iplY = (this.iplY + 1) & 0xff;
            if (this.iplY === 0) {
              // INC $01 — the ROM's pointer high byte crosses pages in place.
              this.iplPointer = (this.iplPointer + 0x100) & 0xffff;
              this.aram[1] = this.iplPointer >> 8;
            }
            this.iplDelay = IPL_CYCLES_BYTE;
          } else if (diff < 0x80) {
            // Any positive skip ends the block (the ROM branches on the
            // sign of port0 - Y; "+2 or more" is main-CPU-side advice).
            this.iplState = IplState.Record;
            this.iplDelay = IPL_CYCLES_RECORD;
          } else {
            this.iplDelay = IPL_CYCLES_POLL;
          }
          break;
        }
        case IplState.Handoff:
          this.start(this.iplPointer);
          return;
        default:
          return;
      }
    }
  }

  /** Hand control to the uploaded driver — the boot ROM's documented exit
   *  register state (A/X/Y zeroed via the final MOV A,Y / MOV X,A when the
   *  execute record's port 1 is 0). SP is only $EF when this loader pass ran
   *  the ROM's entry code; a re-entered loader keeps the driver's stack. */
  private start(entry: number): void {
    this.cpu.pc = entry;
    this.cpu.a = 0;
    this.cpu.x = 0;
    this.cpu.y = 0;
    if (this.iplSetsSp) this.cpu.sp = 0xef;
    this.cpu.psw = 0x02;
    this.cpu.stopped = false;
    // Discard the HLE-era cycle backlog: the core never stepped while the
    // loader state machine ran, so without this the first Running tick
    // executes the whole gap in one burst — the driver races past the
    // S-CPU and reads stale port bytes (the exec record's kick value) as
    // its first command.
    this.cpu.cycles = this.cpuTarget;
    this.iplState = IplState.Running;
  }

  serialize(w: SnesStateWriter): void {
    w.bytes(this.aram);
    w.bytes(this.portsToCpu);
    w.bytes(this.portsToSpc);
    for (const t of this.timers) t.serialize(w);
    w.bool(this.timersEnable);
    w.bool(this.timersDisable);
    w.bool(this.ramWritable);
    w.bool(this.ramDisable);
    w.u8(this.externalWaitStates);
    w.u8(this.iplState);
    w.u16(this.iplPointer);
    w.u8(this.iplY);
    w.u32(this.iplDelay);
    w.bool(this.iplSetsSp);
    w.u8(this.control);
    w.u32(this.cycleRemainder);
    w.f64(this.cpuTarget);
    w.f64(this.timerFed);
    w.u16(this.pendingWrites.length / 3);
    for (let i = 0; i < this.pendingWrites.length; i += 3) {
      w.f64(this.pendingWrites[i]!);
      w.u8(this.pendingWrites[i + 1]!);
      w.u8(this.pendingWrites[i + 2]!);
    }
    this.cpu.serialize(w);
    this.dsp.serialize(w);
  }

  deserialize(r: SnesStateReader): void {
    r.bytes(this.aram);
    r.bytes(this.portsToCpu);
    r.bytes(this.portsToSpc);
    for (const t of this.timers) t.deserialize(r);
    this.timersEnable = r.bool();
    this.timersDisable = r.bool();
    this.ramWritable = r.bool();
    this.ramDisable = r.bool();
    this.externalWaitStates = r.u8();
    this.iplState = r.u8();
    this.iplPointer = r.u16();
    this.iplY = r.u8();
    this.iplDelay = r.u32();
    this.iplSetsSp = r.bool();
    this.control = r.u8();
    this.cycleRemainder = r.u32();
    this.cpuTarget = r.f64();
    this.timerFed = r.f64();
    const pending = r.u16();
    this.pendingWrites.length = 0;
    for (let i = 0; i < pending; i++) {
      this.pendingWrites.push(r.f64(), r.u8(), r.u8());
    }
    this.cpu.deserialize(r);
    this.dsp.deserialize(r);
  }

  /** Advance the SMP by main-system master cycles. The APU runs from its
   *  own crystal — nominally 24.576 MHz but measured ~24.607 MHz on real
   *  units — so SPC cycles are 24606720/24 = 1.02528 MHz against the
   *  21.47727 MHz master clock (fixed-point accumulator; the reduced ratio
   *  128160/2684659 is coprime). The clocks being non-commensurate is
   *  load-bearing: main-CPU↔SPC port-polling loops phase-drift past each
   *  other like hardware instead of locking into a standing pattern (Super
   *  Bomberman 4 / Rendering Ranger R2 hang on any ratio-locked clock). */
  tick(masterCycles: number): void {
    this.cycleRemainder += masterCycles * 128160;
    let spcCycles = Math.floor(this.cycleRemainder / 2684659);
    this.cycleRemainder -= spcCycles * 2684659;
    if (spcCycles === 0) return;

    // Timers live in the 2048 kHz clock domain (2 clocks per SPC cycle) and
    // advance in step with the CPU — blargg's precision tests read the timer
    // output at exact instruction offsets — but never past wall time, and
    // always catch up to it: the CPU budget is a persistent absolute target
    // (an overshooting instruction starts the next call in debt), so both
    // the core and the timers hold true 1.024 MHz long-run. Non-default
    // TEST waitstates slow the CPU (10/20-clock glitch modes) while timers
    // keep nominal rates — approximated uniformly against wall time.
    const cycleWs = CYCLE_WAIT_STATES[this.externalWaitStates]!;
    this.dsp.tick(spcCycles);
    spcCycles = (spcCycles * 2) / cycleWs;
    this.cpuTarget += spcCycles;

    if (this.iplState !== IplState.Running) {
      this.feedTimers(this.cpuTarget);
      this.iplTick(spcCycles);
      return;
    }

    if (this.cpu.stopped || this.cpu.sleeping) {
      this.drainPendingWrites(this.cpuTarget);
      this.feedTimers(this.cpuTarget);
      return;
    }
    // Margin-gated stepping (see SPC_STEP_MARGIN): bounds how far port
    // accesses commit past the main CPU's position without suspending the
    // core mid-instruction.
    while (this.cpu.cycles + SPC_STEP_MARGIN <= this.cpuTarget && !this.cpu.stopped && !this.cpu.sleeping) {
      this.cpu.step();
      this.feedTimers(Math.min(this.cpu.cycles, this.cpuTarget));
      // PC entering $FFC0-$FFFF with the boot ROM mapped = return to loader.
      if (this.cpu.pc >= 0xffc0 && (this.control & 0x80) !== 0 && this.iplState === IplState.Running) {
        this.reenterIpl();
        return;
      }
    }
    // Writes the SPC ran past without reading settle into the latches.
    this.drainPendingWrites(this.cpu.cycles);
    this.feedTimers(this.cpuTarget);
  }

  /** Advance the timers up to `uptoSpc` (absolute SPC-cycle time). */
  private feedTimers(uptoSpc: number): void {
    const d = uptoSpc - this.timerFed;
    if (d <= 0) return;
    this.timerFed = uptoSpc;
    const ratio = TIMER_WAIT_STATES[this.externalWaitStates]! / CYCLE_WAIT_STATES[this.externalWaitStates]!;
    const clocks = d * 2 * ratio;
    for (const t of this.timers) t.step(clocks, this);
  }

  /** Readable stand-in for the boot ROM window ($FFC0-$FFFF when CONTROL
   *  bit 7 maps it): programs fingerprint the region — blargg's harness
   *  checks the first opcode ($CD, MOV X,#$EF) before jumping back into the
   *  loader — but never need to EXECUTE these bytes, because any jump into
   *  the window re-enters the polled loader state machine. Only the
   *  documented entry bytes and the reset vector are populated; a test that
   *  checksums the full 64 bytes will fail loudly rather than silently. */
  private static readonly IPL_WINDOW = (() => {
    const w = new Uint8Array(64).fill(0xff);
    w[0] = 0xcd; // mov x,#$ef
    w[1] = 0xef;
    w[2] = 0xbd; // mov sp,x
    w[62] = 0xc0; // reset vector -> $ffc0
    w[63] = 0xff;
    return w;
  })();

  private busRead(addr: number): number {
    if (addr >= 0xf0 && addr <= 0xff) return this.ioRead(addr);
    if (addr >= 0xffc0 && (this.control & 0x80) !== 0) return SnesApu.IPL_WINDOW[addr - 0xffc0]!;
    if (this.ramDisable) return 0x5a;
    return this.aram[addr]!;
  }

  private busWrite(addr: number, v: number): void {
    if (addr >= 0xf0 && addr <= 0xff) {
      this.ioWrite(addr, v);
      return;
    }
    // Writes land in ARAM even under the boot-ROM window, but the TEST
    // register can write-protect or disconnect the RAM entirely.
    if (this.ramWritable && !this.ramDisable) this.aram[addr] = v;
  }

  private control = 0x80;

  private ioRead(addr: number): number {
    switch (addr) {
      case 0xf0: // TEST — write-only
      case 0xf1: // CONTROL — write-only
      case 0xfa: // TnTARGET — write-only
      case 0xfb:
      case 0xfc:
        return 0x00;
      case 0xf2:
        return this.dsp.addr;
      case 0xf3:
        return this.dsp.readData();
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        // Observe exactly the main-CPU writes that precede this read's cycle.
        this.drainPendingWrites(this.cpu.cycles);
        return this.portsToSpc[addr - 0xf4]!;
      case 0xfd:
      case 0xfe:
      case 0xff:
        return this.timers[addr - 0xfd]!.read();
      default:
        return this.aram[addr]!;
    }
  }

  private ioWrite(addr: number, v: number): void {
    switch (addr) {
      case 0xf0: {
        // TEST — writes only take effect with the P flag clear. The
        // enable/disable bits gate the stage-1 level, so flipping them
        // synthesizes falling edges the timers count.
        if ((this.cpu.psw & 0x20) !== 0) break;
        this.timersDisable = (v & 0x01) !== 0;
        this.ramWritable = (v & 0x02) !== 0;
        this.ramDisable = (v & 0x04) !== 0;
        this.timersEnable = (v & 0x08) !== 0;
        this.externalWaitStates = (v >> 4) & 3;
        for (const t of this.timers) t.synchronizeStage1(this);
        break;
      }
      case 0xf1: {
        // CONTROL — a 0->1 enable transition resets timers 0/1; timer 2
        // resets on every write EXCEPT a 0->1 transition (asymmetry shared
        // by the reference implementations, i.e. hardware-verified).
        const t0 = this.timers[0]!;
        const t1 = this.timers[1]!;
        const t2 = this.timers[2]!;
        const rose0 = !t0.enable && (v & 0x01) !== 0;
        const rose1 = !t1.enable && (v & 0x02) !== 0;
        const rose2 = !t2.enable && (v & 0x04) !== 0;
        t0.enable = (v & 0x01) !== 0;
        t1.enable = (v & 0x02) !== 0;
        t2.enable = (v & 0x04) !== 0;
        if (rose0) {
          t0.stage2 = 0;
          t0.stage3 = 0;
        }
        if (rose1) {
          t1.stage2 = 0;
          t1.stage3 = 0;
        }
        if (!rose2) {
          t2.stage2 = 0;
          t2.stage3 = 0;
        }
        this.control = v;
        // The port-clear erases exactly the writes that have landed by the
        // end of this write cycle; a main-CPU write stamped later survives
        // into the latch.
        if (v & 0x30) this.drainPendingBefore(this.cpu.cycles);
        if (v & 0x10) {
          this.portsToSpc[0] = 0;
          this.portsToSpc[1] = 0;
        }
        if (v & 0x20) {
          this.portsToSpc[2] = 0;
          this.portsToSpc[3] = 0;
        }
        break;
      }
      case 0xf2:
        this.dsp.addr = v;
        break;
      case 0xf3:
        this.dsp.writeData(v);
        break;
      case 0xf4:
      case 0xf5:
      case 0xf6:
      case 0xf7:
        this.portsToCpu[addr - 0xf4] = v;
        break;
      case 0xfa:
      case 0xfb:
      case 0xfc:
        this.timers[addr - 0xfa]!.target = v;
        break;
      default:
        this.aram[addr] = v;
    }
  }
}
