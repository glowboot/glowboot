/**
 * GBA APU — register file, frame sequencer, PSG mixer, Direct Sound
 * FIFOs, and stereo sample output.
 *
 * The APU is hybrid: four PSG channels (essentially the CGB APU —
 * channels 1+2 square, 3 wave-RAM, 4 noise; see `./channels.ts`)
 * plus two Direct Sound channels (8-bit signed PCM fed from FIFOs
 * that are drained on timer overflow). All six channels mix through
 * SOUNDCNT_H with per-side L/R routing before landing in
 * `outLeft` / `outRight` for the host audio callback.
 *
 * Register block (per GBATEK, mapped at 0x04000060):
 *   0x60 SOUND1CNT_L    sweep
 *   0x62 SOUND1CNT_H    length + duty + envelope
 *   0x64 SOUND1CNT_X    frequency + trigger + length-enable
 *   0x68 SOUND2CNT_L    length + duty + envelope
 *   0x6C SOUND2CNT_H    frequency + trigger + length-enable
 *   0x70 SOUND3CNT_L    enable + bank select + bank count
 *   0x72 SOUND3CNT_H    length + volume
 *   0x74 SOUND3CNT_X    frequency + trigger + length-enable
 *   0x78 SOUND4CNT_L    length + envelope
 *   0x7C SOUND4CNT_H    divisor + LFSR width + frequency + trigger
 *   0x80 SOUNDCNT_L     PSG L/R master volume + per-channel enable
 *   0x82 SOUNDCNT_H     Direct Sound config + PSG/DS volume + timer select
 *   0x84 SOUNDCNT_X     master sound enable + channel-on status (read)
 *   0x88 SOUNDBIAS      output bias + amplitude resolution
 *   0x90-0x9F WAVE_RAM  32 4-bit samples × 2 banks (only the inactive
 *                       bank is visible to the bus; the active bank
 *                       feeds the wave channel).
 *   0xA0 FIFO_A         Direct Sound A push (write-only; 32-bit pushes
 *                       four 8-bit samples)
 *   0xA4 FIFO_B         Direct Sound B push
 */

import type { IoHandler } from "../memory/mapped-bus.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import { NoiseChannel, SquareChannel, WaveChannel } from "./channels.js";

/** CPU cycles per frame-sequencer tick. The FS runs at 512 Hz off the
 *  16.78 MHz CPU clock → 16,777,216 / 512 = 32,768. */
const FS_PERIOD_CYCLES = 32768;

/** Default APU sample-output rate when the host hasn't picked one. */
const DEFAULT_SAMPLE_RATE_HZ = 32768;

/** GBA CPU clock in Hz (16.78 MHz). Used to compute cycles-per-sample. */
const CPU_CLOCK_HZ = 16_777_216;

/** GBA refresh rate: 280,896 CPU cycles per frame → 59.7275 Hz, per
 *  GBATEK. Local copy of the constant `gba.ts` exports so the APU
 *  diagnostics' `expectedSamplesPerFrame` divisor matches the host
 *  runtime's frame cadence without requiring a circular import back
 *  to `gba.ts`. */
const FRAMES_PER_SEC = CPU_CLOCK_HZ / 280_896;

/** Size of the stereo output ring buffer in samples per channel. ~62 ms
 *  at 32 KHz — enough for the rAF loop to drain without underrun. */
const OUTPUT_BUFFER_SIZE = 2048;

/** PSG volume scaler from SOUNDCNT_H bits 0-1. 00=25%, 01=50%, 10=100%,
 *  11=prohibited (we treat as 100%). */
const PSG_VOLUME_SHIFTS = [2, 1, 0, 0] as const;

/** Output low-pass corner in Hz. Anti-aliases the zero-order-hold
 *  Direct Sound samples — see the `lpL` / `lpR` doc on `Apu` for the
 *  full rationale. 10 kHz lines up with the rolloff of the real GBA's
 *  analog audio path (op-amp + RC). */
const LP_CUTOFF_HZ = 10000;

// Register offsets are relative to the APU's MMIO base (0x4000060). The
// IoHandler contract passes the bus-resolved offset, not the absolute
// MMIO address, so e.g. SOUND1CNT_L at 0x4000060 arrives here as 0.
const REG_SOUND1CNT_L = 0x00;
const REG_SOUND1CNT_H = 0x02;
const REG_SOUND1CNT_X = 0x04;
const REG_SOUND2CNT_L = 0x08;
const REG_SOUND2CNT_H = 0x0c;
const REG_SOUND3CNT_L = 0x10;
const REG_SOUND3CNT_H = 0x12;
const REG_SOUND3CNT_X = 0x14;
const REG_SOUND4CNT_L = 0x18;
const REG_SOUND4CNT_H = 0x1c;
const REG_SOUNDCNT_L = 0x20;
const REG_SOUNDCNT_H = 0x22;
const REG_SOUNDCNT_X = 0x24;
const REG_SOUNDBIAS = 0x28;
const REG_WAVE_RAM_BASE = 0x30;
const REG_WAVE_RAM_END = 0x40; // exclusive
const REG_FIFO_A_LO = 0x40;
const REG_FIFO_B_LO = 0x44;

const SOUNDCNT_X_MASTER_ENABLE = 1 << 7;
/** SOUNDCNT_H bit layout (per GBATEK):
 *   0-1 PSG volume       4-7  unused
 *   2   DSA volume       8    DSA enable right
 *   3   DSB volume       9    DSA enable left
 *                        10   DSA timer select (0=Timer 0, 1=Timer 1)
 *                        11   DSA FIFO reset (self-clearing)
 *                        12   DSB enable right
 *                        13   DSB enable left
 *                        14   DSB timer select
 *                        15   DSB FIFO reset (self-clearing) */
const SOUNDCNT_H_DSA_VOLUME = 1 << 2;
const SOUNDCNT_H_DSB_VOLUME = 1 << 3;
const SOUNDCNT_H_DSA_ENABLE_RIGHT = 1 << 8;
const SOUNDCNT_H_DSA_ENABLE_LEFT = 1 << 9;
const SOUNDCNT_H_DSA_TIMER = 1 << 10;
const SOUNDCNT_H_FIFO_A_RESET = 1 << 11;
const SOUNDCNT_H_DSB_ENABLE_RIGHT = 1 << 12;
const SOUNDCNT_H_DSB_ENABLE_LEFT = 1 << 13;
const SOUNDCNT_H_DSB_TIMER = 1 << 14;
const SOUNDCNT_H_FIFO_B_RESET = 1 << 15;
/** Bits that the PSG owns in SOUNDCNT_X: bits 0-3 report each PSG
 *  channel's "currently on" status. Bit 7 (master enable) is writable
 *  by software. */
const SOUNDCNT_X_PSG_STATUS_MASK = 0x000f;

/** Per-channel register state for the four PSG channels. Stored
 *  verbatim from the bus side; channel implementations (5b-5d) read
 *  these to drive their sample generators. */
export interface PsgChannelRegs {
  /** Low CNT register — sweep for ch1, length+duty+envelope for ch2,
   *  bank/DAC control for ch3, length+envelope for ch4. */
  cntL: number;
  /** High CNT register — length+duty+envelope for ch1, frequency+
   *  trigger+length-enable for ch2, length+volume for ch3,
   *  divisor+LFSR+frequency+trigger for ch4. */
  cntH: number;
  /** X register — frequency+trigger+length-enable for ch1/ch3
   *  (ch2/ch4 leave it 0; their frequency/trigger live in cntH). */
  cntX: number;
}

/** Direct-sound FIFO holding 8-bit signed PCM values.
 *
 *  Real GBA hardware sizes each FIFO at **8 × 32-bit words = 32 bytes
 *  = 32 samples** (one 32-bit DMA word carries 4 8-bit samples). Game
 *  code drives the DMA in 4-word bursts (16 bytes) triggered when the
 *  FIFO drops below half-full; with a 32-byte capacity and a 16-byte
 *  refill watermark, each burst exactly tops the FIFO back up.
 *
 *  Earlier versions of this class sized `samples` at 8 bytes, which
 *  meant the 16-byte DMA burst overflowed every time and the upper 12
 *  bytes were silently discarded by the `size < length` guard inside
 *  `push32`. The DMA source-address register advanced 16 bytes anyway,
 *  so the played stream was decimated 4:1 — every commercial GBA ROM
 *  sounded ~2 octaves pitched up. See the GBA APU comparison report
 *  (2026-05-16) for the full citation chain.
 *
 *  Pushed via 32-bit writes to FIFO_A/B (4 samples per push); popped
 *  by `Apu.onTimerOverflow` for whichever timer SOUNDCNT_H assigns to
 *  the channel. */
const FIFO_CAPACITY = 32;
const FIFO_CAPACITY_MASK = FIFO_CAPACITY - 1;

export class DirectSoundFifo {
  private readonly samples: Int8Array = new Int8Array(FIFO_CAPACITY);
  private head = 0;
  private size = 0;

  /** Push four 8-bit signed samples from a 32-bit write. The GBA
   *  pushes least-significant byte first. When the FIFO is full,
   *  excess samples are silently dropped — matches real hardware. In
   *  normal game programming the refill watermark prevents the drop
   *  path from ever firing; it stays here as a defensive guard. */
  push32(value: number): void {
    for (let i = 0; i < 4; i++) {
      const byte = (value >>> (i * 8)) & 0xff;
      const sample = (byte << 24) >> 24; // sign-extend
      if (this.size < FIFO_CAPACITY) {
        const idx = (this.head + this.size) & FIFO_CAPACITY_MASK;
        this.samples[idx] = sample;
        this.size++;
      }
    }
  }

  /** Pop the oldest sample, or 0 if empty. */
  pop(): number {
    if (this.size === 0) return 0;
    const sample = this.samples[this.head]!;
    this.head = (this.head + 1) & FIFO_CAPACITY_MASK;
    this.size--;
    return sample;
  }

  /** Number of samples currently in the FIFO (0–32). */
  get fill(): number {
    return this.size;
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
    this.samples.fill(0);
  }

  serialize(w: GbaStateWriter): void {
    for (let i = 0; i < FIFO_CAPACITY; i++) w.i8(this.samples[i]!);
    w.u8(this.head);
    w.u8(this.size);
  }

  deserialize(r: GbaStateReader): void {
    for (let i = 0; i < FIFO_CAPACITY; i++) this.samples[i] = r.i8();
    this.head = r.u8();
    this.size = r.u8();
  }
}

export class Apu implements IoHandler {
  /** Open-bus source for reads of write-only APU slots (FIFO_A/B at
   *  0xA0-0xA7). Wired by the Gba constructor to `ArmCpu.currentOpenBus`
   *  so reads return the prefetched ARM opcode at PC+8, matching real
   *  hardware. Null in unit tests = returns 0. */
  openBusSource: (() => number) | null = null;

  readonly psg: PsgChannelRegs[] = [
    { cntL: 0, cntH: 0, cntX: 0 },
    { cntL: 0, cntH: 0, cntX: 0 },
    { cntL: 0, cntH: 0, cntX: 0 },
    { cntL: 0, cntH: 0, cntX: 0 }
  ];

  /** Live PSG channel state — squares (ch1+ch2), wave (ch3), noise
   *  (ch4). */
  readonly ch1: SquareChannel = new SquareChannel();
  readonly ch2: SquareChannel = new SquareChannel();
  readonly ch3: WaveChannel = new WaveChannel();
  readonly ch4: NoiseChannel = new NoiseChannel();

  /** Per-channel mute flags for the four PSG channels (CH1..CH4).
   *  Same shape as `gb/apu/apu.ts`'s `muteChannel` so the settings
   *  wiring can write to both. */
  readonly muteChannel: [boolean, boolean, boolean, boolean] = [false, false, false, false];

  /** Mute flags for the two Direct Sound (FIFO-driven) channels —
   *  the streamed-PCM path that carries the actual music in most
   *  commercial GBA ROMs. Independent: GBA games typically use DSA
   *  for music and DSB for sound effects (or vice versa), and the
   *  Settings UI exposes the two as separate buttons so you can mute
   *  one without the other. PSG mute alone doesn't silence a GBA
   *  game; these are the ones that do. */
  muteDirectSoundA = false;
  muteDirectSoundB = false;

  // ─── Debug ring buffers ─────────────────────────────────────────────
  // Per-channel raw-sample rings used by the audio scope pane. Four
  // PSG channels store samples 0..15 (matches the GB convention); two
  // Direct Sound channels store signed 8-bit samples shifted into 0..255
  // (128 = silence) so the same byte-array machinery works for both.
  // Updated once per audio sample inside `sampleStereo`; the cost is six
  // byte writes + six envelope updates per output sample, negligible
  // next to the mixer work.
  private static readonly DEBUG_BUFFER_SIZE = 4096;
  private static readonly DEBUG_BUFFER_MASK = 4095;
  readonly debugCh1 = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  readonly debugCh2 = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  readonly debugCh3 = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  readonly debugCh4 = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  readonly debugDsa = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  readonly debugDsb = new Uint8Array(Apu.DEBUG_BUFFER_SIZE);
  private debugSamplePos = 0;
  /** Per-channel envelope followers (instant attack, exponential release).
   *  Normalised to 0..1 via the matching getters below. */
  private ch1Env = 0;
  private ch2Env = 0;
  private ch3Env = 0;
  private ch4Env = 0;
  private dsaEnv = 0;
  private dsbEnv = 0;
  private static readonly CHAN_RELEASE = 0.9998;

  get debugBufferPos(): number {
    return this.debugSamplePos;
  }
  get debugBufferSize(): number {
    return Apu.DEBUG_BUFFER_SIZE;
  }
  get ch1Envelope(): number {
    return this.ch1Env / 15;
  }
  get ch2Envelope(): number {
    return this.ch2Env / 15;
  }
  get ch3Envelope(): number {
    return this.ch3Env / 15;
  }
  get ch4Envelope(): number {
    return this.ch4Env / 15;
  }
  get dsaEnvelope(): number {
    return this.dsaEnv / 127;
  }
  get dsbEnvelope(): number {
    return this.dsbEnv / 127;
  }

  /** Frame-sequencer step (0-7) and the cycle countdown to the next
   *  step. The FS clocks length / sweep / envelope at predictable
   *  fractions of 512 Hz. */
  private fsStep = 0;
  private fsTimer = FS_PERIOD_CYCLES;

  /** Host audio sample rate (Hz). Write-only externally — the host
   *  installs the AudioContext rate once at boot via
   *  `gba.apu.sampleRate = audio.sampleRate`. Matches the GB engine's
   *  shape so UI code that wires audio doesn't have to branch. */
  set sampleRate(v: number) {
    if (v <= 0) return;
    this.cyclesPerSample = CPU_CLOCK_HZ / v;
    // Reset the fractional accumulator so cycles already banked
    // against the old rate don't immediately fire a spurious sample.
    this.sampleAccumulator = 0;
    // Re-tune the output low-pass to match the new host sample rate.
    this.lpAlpha = 1 - Math.exp((-2 * Math.PI * LP_CUTOFF_HZ) / v);
  }
  /** Cycles per output sample at the current sample rate. */
  private cyclesPerSample = CPU_CLOCK_HZ / DEFAULT_SAMPLE_RATE_HZ;
  /** Fractional cycle accumulator for sample timing. */
  private sampleAccumulator = 0;

  /** One-pole IIR low-pass state — anti-aliases the zero-order-hold
   *  Direct Sound output. Each FIFO sample is held for several host
   *  samples (DS plays at 8-32 kHz; host runs at 44.1+ kHz), and the
   *  step transitions between consecutive 8-bit samples carry a lot
   *  of high-frequency aliasing energy that sounds tinny without
   *  filtering. Real GBA hardware applies an analog reconstruction
   *  low-pass after the DAC; we emulate it digitally on the mixed
   *  output. Cutoff ≈ 10 kHz approximates the rolloff of the cart's
   *  TLV272 op-amp + RC filter chain on real silicon. */
  private lpL = 0;
  private lpR = 0;
  private lpAlpha = 1 - Math.exp((-2 * Math.PI * LP_CUTOFF_HZ) / DEFAULT_SAMPLE_RATE_HZ);

  /** Per-frame sample-count history. The host loop's `runFrame` drains
   *  the ring and resets `outPos`; on each drain we push the count
   *  here so `diagnostics` can show what's actually being emitted.
   *  Last 64 frames kept (~1.07 s at 59.7275 Hz). */
  private readonly recentSampleCounts: number[] = [];

  /** Snapshot the most recent frame's sample count. Called from
   *  `Gba.runFrame` right before `onAudioFrame` so the count we record
   *  is exactly what gets handed to the audio scheduler. */
  recordFrameSampleCount(count: number): void {
    this.recentSampleCounts.push(count);
    if (this.recentSampleCounts.length > 64) this.recentSampleCounts.shift();
  }

  /** Console-debug accessor for the audio plumbing. The browser
   *  console can do `state.gba.mem.apu.diagnostics` to read the
   *  configured sample rate, the channel enables, and a rolling
   *  average of samples emitted per frame.
   *
   *  If `expectedSamplesPerFrame` (= sampleRate / 59.7275) differs
   *  from the rolling average by more than ~1 sample, the engine is
   *  drifting against real-time — pitch-up if avg > expected, pitch-
   *  down if avg < expected. */
  get diagnostics(): {
    sampleRate: number;
    cyclesPerSample: number;
    expectedSamplesPerFrame: number;
    avgSamplesPerFrame: number;
    framesObserved: number;
    masterEnabled: boolean;
    psgEnables: { ch1: boolean; ch2: boolean; ch3: boolean; ch4: boolean };
    dsEnables: { dsaL: boolean; dsaR: boolean; dsbL: boolean; dsbR: boolean };
    fifoFill: { a: number; b: number };
  } {
    const sampleRate = this.cyclesPerSample > 0 ? CPU_CLOCK_HZ / this.cyclesPerSample : 0;
    const sum = this.recentSampleCounts.reduce((a, b) => a + b, 0);
    const avg = this.recentSampleCounts.length > 0 ? sum / this.recentSampleCounts.length : 0;
    const cntL = this.soundcntL;
    const cntH = this.soundcntH;
    return {
      sampleRate,
      cyclesPerSample: this.cyclesPerSample,
      expectedSamplesPerFrame: sampleRate / FRAMES_PER_SEC,
      avgSamplesPerFrame: avg,
      framesObserved: this.recentSampleCounts.length,
      masterEnabled: this.masterEnabled,
      psgEnables: {
        ch1: ((cntL >>> 8) & 1) !== 0 || ((cntL >>> 12) & 1) !== 0,
        ch2: ((cntL >>> 9) & 1) !== 0 || ((cntL >>> 13) & 1) !== 0,
        ch3: ((cntL >>> 10) & 1) !== 0 || ((cntL >>> 14) & 1) !== 0,
        ch4: ((cntL >>> 11) & 1) !== 0 || ((cntL >>> 15) & 1) !== 0
      },
      dsEnables: {
        dsaL: (cntH & (1 << 9)) !== 0,
        dsaR: (cntH & (1 << 8)) !== 0,
        dsbL: (cntH & (1 << 13)) !== 0,
        dsbR: (cntH & (1 << 12)) !== 0
      },
      fifoFill: { a: this.fifoA.fill, b: this.fifoB.fill }
    };
  }

  /** Stereo output ring buffer. `outPos` is the write index; the
   *  caller drains [0, outPos) and resets `outPos` to 0. Float32
   *  matches the Web Audio API's expected format. */
  readonly outLeft: Float32Array = new Float32Array(OUTPUT_BUFFER_SIZE);
  readonly outRight: Float32Array = new Float32Array(OUTPUT_BUFFER_SIZE);
  outPos = 0;

  /** SOUNDCNT_L — PSG L/R master volume (bits 0-2 L, 4-6 R) + per-
   *  channel L/R enable bits (bits 8-15: 4 left, 4 right). */
  soundcntL = 0;
  /** SOUNDCNT_H — Direct Sound volume + L/R routing + timer select +
   *  PSG/DSA/DSB output volume bits. */
  soundcntH = 0;
  /** SOUNDCNT_X — bit 7 master enable; bits 0-3 are PSG channel-on
   *  status (read-only; written by the channel implementations as
   *  they trigger / time out). */
  soundcntX = 0;
  /** SOUNDBIAS — DAC bias + sample-rate select. Defaults to 0x200
   *  (centered bias, 32 KHz output). */
  soundbias = 0x0200;

  /** Wave-RAM bytes (two banks × 16 nibbles). The wave channel reads
   *  the "active" bank (selected by SOUND3CNT_L bit 6); both banks are
   *  visible to the bus here — the GBATEK rule of hiding the active
   *  bank from the bus isn't enforced because no shipped ROM relies
   *  on it and faking it would mean tracking a per-write shadow. */
  readonly waveRam: Uint8Array = new Uint8Array(16);

  readonly fifoA: DirectSoundFifo = new DirectSoundFifo();
  readonly fifoB: DirectSoundFifo = new DirectSoundFifo();

  /** Sample currently held by each Direct Sound channel. Updated on the
   *  timer overflow that drains the FIFO; emitted continuously between
   *  pops so the DS playback rate is determined by the timer reload
   *  value, not the host sample rate. */
  private dsaSample = 0;
  private dsbSample = 0;

  constructor() {
    this.ch3.attachWaveRam(this.waveRam);
  }

  /** True when SOUNDCNT_X.master-enable is set. When clear, `tick`
   *  emits silence without advancing channel state — the host audio
   *  callback keeps getting samples so the AudioContext doesn't
   *  underrun. (Real hardware would also force-reset each channel's
   *  registers; we don't, since no shipped ROM relies on it.) */
  get masterEnabled(): boolean {
    return (this.soundcntX & SOUNDCNT_X_MASTER_ENABLE) !== 0;
  }

  read16(offset: number): number {
    const aligned = offset & ~1;
    switch (aligned) {
      // Bit-level read masks below come from GBATEK + mgba-suite io-read.
      // Unused bits in each PSG/Direct-Sound register read as 0 even when
      // the test writes 0xFFFF first, so the read returns only the bits
      // that survive the hardware's input mask.
      case REG_SOUND1CNT_L:
        return this.psg[0]!.cntL & 0x007f;
      case REG_SOUND1CNT_H:
        return this.psg[0]!.cntH & 0xffc0;
      case REG_SOUND1CNT_X:
        return this.psg[0]!.cntX & 0x4000;
      case REG_SOUND2CNT_L:
        return this.psg[1]!.cntL & 0xffc0;
      case REG_SOUND2CNT_H:
        return this.psg[1]!.cntH & 0x4000;
      case REG_SOUND3CNT_L:
        return this.psg[2]!.cntL & 0x00e0;
      case REG_SOUND3CNT_H:
        return this.psg[2]!.cntH & 0xe000;
      case REG_SOUND3CNT_X:
        return this.psg[2]!.cntX & 0x4000;
      case REG_SOUND4CNT_L:
        return this.psg[3]!.cntL & 0xff00;
      case REG_SOUND4CNT_H:
        return this.psg[3]!.cntH & 0x40ff;
      case REG_SOUNDCNT_L:
        return this.soundcntL & 0xff77;
      case REG_SOUNDCNT_H:
        return this.soundcntH & 0x770f;
      case REG_SOUNDCNT_X:
        // Bits 0-3 are channel-on status (read-only, populated by the
        // PSG mixer); bit 7 is the master enable (R/W). Everything else
        // reads 0. Sync the status bits here rather than inside every
        // `tick()` — carts hit this register a handful of times per
        // frame at most, while tick fires hundreds of thousands of
        // times.
        this.syncChannelStatus();
        return this.soundcntX & 0x008f;
      case REG_SOUNDBIAS:
        return this.soundbias & 0xc3fe;
      default:
        if (aligned >= REG_WAVE_RAM_BASE && aligned < REG_WAVE_RAM_END) {
          const i = aligned - REG_WAVE_RAM_BASE;
          return (this.waveRam[i]! | (this.waveRam[i + 1]! << 8)) & 0xffff;
        }
        // FIFO_A (0xA0-0xA3) and FIFO_B (0xA4-0xA7) are write-only —
        // reads return the CPU's open-bus latch (prefetched opcode at
        // PC+8), matching real ARM7TDMI.
        if (aligned >= REG_FIFO_A_LO && aligned < REG_FIFO_B_LO + 4) {
          return this.readOpenBus(aligned);
        }
        // 0x8C-0x8F sit between SOUNDBIAS (last live APU register at
        // 0x88) and WAVE_RAM (0x90). Real hardware leaves those slots
        // off the APU bus, so reads land on CPU open-bus, not the APU's
        // internal zeroes.
        if (aligned >= 0x2c && aligned < 0x30) {
          return this.readOpenBus(aligned);
        }
        // 0xA8-0xAF (offsets 0x48-0x4F) — past the last live APU
        // register and inside the handler region we own (the
        // MappedBus registers the APU for size 0x50 to scoop these
        // up so they answer with open-bus instead of bus-default 0).
        if (aligned >= 0x48 && aligned < 0x50) {
          return this.readOpenBus(aligned);
        }
        return 0;
    }
  }

  private readOpenBus(aligned: number): number {
    const word = this.openBusSource?.() ?? 0;
    return ((aligned & 2) === 0 ? word & 0xffff : (word >>> 16) & 0xffff) | 0;
  }

  write16(offset: number, value: number): void {
    const v = value & 0xffff;
    const aligned = offset & ~1;
    switch (aligned) {
      case REG_SOUND1CNT_L:
        this.psg[0]!.cntL = v;
        this.ch1.setSweep(v);
        return;
      case REG_SOUND1CNT_H:
        this.psg[0]!.cntH = v;
        this.ch1.setEnvelopeAndDuty(v);
        return;
      case REG_SOUND1CNT_X:
        this.psg[0]!.cntX = v;
        this.ch1.setFrequencyControl(v);
        return;
      case REG_SOUND2CNT_L:
        this.psg[1]!.cntL = v;
        this.ch2.setEnvelopeAndDuty(v);
        return;
      case REG_SOUND2CNT_H:
        this.psg[1]!.cntH = v;
        this.ch2.setFrequencyControl(v);
        return;
      case REG_SOUND3CNT_L:
        this.psg[2]!.cntL = v;
        this.ch3.setControl(v);
        return;
      case REG_SOUND3CNT_H:
        this.psg[2]!.cntH = v;
        this.ch3.setLengthAndVolume(v);
        return;
      case REG_SOUND3CNT_X:
        this.psg[2]!.cntX = v;
        this.ch3.setFrequencyControl(v);
        return;
      case REG_SOUND4CNT_L:
        this.psg[3]!.cntL = v;
        this.ch4.setEnvelope(v);
        return;
      case REG_SOUND4CNT_H:
        this.psg[3]!.cntH = v;
        this.ch4.setFrequencyControl(v);
        return;
      case REG_SOUNDCNT_L:
        this.soundcntL = v;
        return;
      case REG_SOUNDCNT_H:
        // Bits 11 / 15 are FIFO reset triggers — they clear the FIFO
        // (and the held sample) and self-clear on write.
        if ((v & SOUNDCNT_H_FIFO_A_RESET) !== 0) {
          this.fifoA.reset();
          this.dsaSample = 0;
        }
        if ((v & SOUNDCNT_H_FIFO_B_RESET) !== 0) {
          this.fifoB.reset();
          this.dsbSample = 0;
        }
        this.soundcntH = v & ~(SOUNDCNT_H_FIFO_A_RESET | SOUNDCNT_H_FIFO_B_RESET);
        return;
      case REG_SOUNDCNT_X:
        // Bits 0-3 are read-only PSG channel-on status. Bit 7 is the
        // master enable. The rest is reserved.
        this.soundcntX = (this.soundcntX & SOUNDCNT_X_PSG_STATUS_MASK) | (v & ~SOUNDCNT_X_PSG_STATUS_MASK);
        return;
      case REG_SOUNDBIAS:
        this.soundbias = v;
        return;
      default:
        if (aligned >= REG_WAVE_RAM_BASE && aligned < REG_WAVE_RAM_END) {
          const i = aligned - REG_WAVE_RAM_BASE;
          this.waveRam[i] = v & 0xff;
          this.waveRam[i + 1] = (v >>> 8) & 0xff;
          return;
        }
        // FIFO_A / FIFO_B at 0xA0-0xA7. Canonical writes are 32-bit
        // (handled by write32), but the bus may decompose a 32-bit
        // store into two halfwords or a ROM may write a halfword
        // directly. We push the 16-bit value as the low half of the
        // FIFO word (the upper bytes are zero-padded by push32, which
        // is fine — real Direct Sound code uses 32-bit DMA pushes).
        if (aligned === REG_FIFO_A_LO || aligned === REG_FIFO_A_LO + 2) {
          this.fifoA.push32(v & 0xffff);
          return;
        }
        if (aligned === REG_FIFO_B_LO || aligned === REG_FIFO_B_LO + 2) {
          this.fifoB.push32(v & 0xffff);
          return;
        }
        return;
    }
  }

  read8(offset: number): number {
    const word = this.read16(offset & ~1);
    return (offset & 1) === 0 ? word & 0xff : (word >>> 8) & 0xff;
  }

  write8(offset: number, value: number): void {
    const aligned = offset & ~1;
    // For FIFO byte writes, push a single sample with zero-padding for
    // the other lanes — atypical but functionally safe.
    if (aligned >= REG_FIFO_A_LO && aligned < REG_FIFO_A_LO + 4) {
      this.fifoA.push32(value & 0xff);
      return;
    }
    if (aligned >= REG_FIFO_B_LO && aligned < REG_FIFO_B_LO + 4) {
      this.fifoB.push32(value & 0xff);
      return;
    }
    const current = this.read16(aligned);
    const v = value & 0xff;
    const merged = (offset & 1) === 0 ? (current & 0xff00) | v : (current & 0x00ff) | (v << 8);
    this.write16(aligned, merged);
  }

  read32(offset: number): number {
    const lo = this.read16(offset);
    const hi = this.read16(offset + 2);
    return lo | (hi << 16) | 0;
  }

  write32(offset: number, value: number): void {
    const aligned = offset & ~3;
    // 32-bit FIFO write pushes 4 samples in one shot. This is the
    // canonical Direct Sound DMA target.
    if (aligned === REG_FIFO_A_LO) {
      this.fifoA.push32(value | 0);
      return;
    }
    if (aligned === REG_FIFO_B_LO) {
      this.fifoB.push32(value | 0);
      return;
    }
    this.write16(offset, value & 0xffff);
    this.write16(offset + 2, (value >>> 16) & 0xffff);
  }

  /** Advance APU state by `cycles` CPU cycles. Runs the channel duty
   *  timers and the frame sequencer; the latter clocks length, sweep,
   *  and envelope on the right step boundaries.
   *
   *  Frame sequencer pattern (every 1/512 s):
   *    step 0,4 — length
   *    step 2,6 — length + sweep
   *    step 7   — envelope
   *  Steps 1, 3, 5 are silent.
   *
   *  When the master enable bit is clear, the channels are held in
   *  reset (no sample output, no timer progress). */
  tick(cycles: number): void {
    if (!this.masterEnabled) {
      // Master off: still advance the sample clock so the UI sees
      // silence, otherwise the audio queue underruns.
      this.advanceSampleClock(cycles, /* silent */ true);
      return;
    }
    // Gate each channel's tick on `enabled` at the call site — most
    // carts (especially those using Direct Sound for music, like THPS4)
    // leave the PSG channels disabled, and the per-method enabled-guard
    // still costs a function-dispatch round trip on millions of ticks
    // per second.
    if (this.ch1.enabled) this.ch1.tickDuty(cycles);
    if (this.ch2.enabled) this.ch2.tickDuty(cycles);
    if (this.ch3.enabled) this.ch3.tickWave(cycles);
    if (this.ch4.enabled) this.ch4.tickLfsr(cycles);
    this.tickFrameSequencer(cycles);
    // syncChannelStatus is now called lazily on read of SOUNDCNT_X
    // rather than every tick — see read16(REG_SOUNDCNT_X). Saves
    // ~500 k field-accesses per frame on a hot apu.tick (called once
    // per CPU step).
    this.advanceSampleClock(cycles, false);
  }

  /** Most-recent stereo sample written by `sampleStereo()` /
   *  `mixStereoInto()`. The hot path (`advanceSampleClock`) reads
   *  these directly so it doesn't pay a `{left, right}` allocation
   *  per sample; the public `sampleStereo()` form wraps them for the
   *  test API. */
  lastStereoLeft = 0;
  lastStereoRight = 0;

  /** Mix one stereo sample at the current channel state. Returns a
   *  pair of floats in approximately [-1, +1]. Object-return form for
   *  the test API — the engine's hot path uses `mixStereoInto()` to
   *  avoid the per-sample object allocation. */
  sampleStereo(): { left: number; right: number } {
    this.mixStereoInto();
    return { left: this.lastStereoLeft, right: this.lastStereoRight };
  }

  /** Mix one stereo sample at the current channel state, leaving the
   *  result in `lastStereoLeft` / `lastStereoRight`. The engine's
   *  audio path calls this directly to avoid the per-sample object
   *  allocation that `sampleStereo()` would do for its return value,
   *  and that adds up at ~770 calls/frame × 59.7 fps = ~46 k
   *  objects/s of GC pressure. */
  mixStereoInto(): void {
    if (!this.masterEnabled) {
      this.lastStereoLeft = 0;
      this.lastStereoRight = 0;
      return;
    }
    const cntL = this.soundcntL | 0;
    const cntH = this.soundcntH | 0;
    const masterRight = cntL & 0x7;
    const masterLeft = (cntL >>> 4) & 0x7;
    const enableMaskRight = (cntL >>> 8) & 0xf;
    const enableMaskLeft = (cntL >>> 12) & 0xf;
    const psgShift = PSG_VOLUME_SHIFTS[cntH & 0x3]!;

    // Per-channel sample held in locals, not a 4-element array —
    // skips the per-sample Array allocation and lets V8 keep these
    // in registers across the subsequent loads.
    const mute = this.muteChannel;
    const s0 = mute[0] ? 0 : this.ch1.sample();
    const s1 = mute[1] ? 0 : this.ch2.sample();
    const s2 = mute[2] ? 0 : this.ch3.sample();
    const s3 = mute[3] ? 0 : this.ch4.sample();

    // ─── Debug-scope taps (PSG) ────────────────────────────────────
    // Update envelope followers + ring buffers with the four PSG
    // samples we just computed. DS taps follow further down once the
    // DS branch decides on its per-channel values.
    const dpos = this.debugSamplePos;
    const r = Apu.CHAN_RELEASE;
    this.ch1Env = Math.max(s0, this.ch1Env * r);
    this.ch2Env = Math.max(s1, this.ch2Env * r);
    this.ch3Env = Math.max(s2, this.ch3Env * r);
    this.ch4Env = Math.max(s3, this.ch4Env * r);
    this.debugCh1[dpos] = s0;
    this.debugCh2[dpos] = s1;
    this.debugCh3[dpos] = s2;
    this.debugCh4[dpos] = s3;

    // Unrolled mix: four constant-bit tests beat the loop's
    // `1 << i` + bit-test pair, and the mute-zeroed samples make the
    // branches cheap on most carts (the disabled-channel `if` falls
    // through to `+= 0`). PSG master volume — bits 0-2 scale linearly
    // from 1× to 8×, then we apply the SOUNDCNT_H PSG shift.
    let left = 0;
    let right = 0;
    if ((enableMaskLeft & 0x1) !== 0) left += s0;
    if ((enableMaskLeft & 0x2) !== 0) left += s1;
    if ((enableMaskLeft & 0x4) !== 0) left += s2;
    if ((enableMaskLeft & 0x8) !== 0) left += s3;
    if ((enableMaskRight & 0x1) !== 0) right += s0;
    if ((enableMaskRight & 0x2) !== 0) right += s1;
    if ((enableMaskRight & 0x4) !== 0) right += s2;
    if ((enableMaskRight & 0x8) !== 0) right += s3;
    left = (left * (masterLeft + 1)) >> psgShift;
    right = (right * (masterRight + 1)) >> psgShift;

    // Direct Sound mix. Each DS channel emits 8-bit signed PCM. The
    // volume bit selects 50% (>>1) or 100% (>>0); the L/R enables
    // route the (possibly attenuated) sample to either side. Muted
    // channels zero their contribution but keep the held samples +
    // FIFO state advancing, so unmuting picks up live.
    const dsaActive = !this.muteDirectSoundA;
    const dsbActive = !this.muteDirectSoundB;
    if (dsaActive || dsbActive) {
      const dsa = dsaActive ? ((cntH & SOUNDCNT_H_DSA_VOLUME) !== 0 ? this.dsaSample : this.dsaSample >> 1) : 0;
      const dsb = dsbActive ? ((cntH & SOUNDCNT_H_DSB_VOLUME) !== 0 ? this.dsbSample : this.dsbSample >> 1) : 0;
      // PSG occupies roughly [-480, +480] after master volume +
      // shift; we upscale DS by 2 so a full-amplitude DS sample
      // (±127 × 2 ≈ ±254) sits at a similar order of magnitude
      // before the divide.
      let dsLeft = 0;
      let dsRight = 0;
      if ((cntH & SOUNDCNT_H_DSA_ENABLE_LEFT) !== 0) dsLeft += dsa;
      if ((cntH & SOUNDCNT_H_DSA_ENABLE_RIGHT) !== 0) dsRight += dsa;
      if ((cntH & SOUNDCNT_H_DSB_ENABLE_LEFT) !== 0) dsLeft += dsb;
      if ((cntH & SOUNDCNT_H_DSB_ENABLE_RIGHT) !== 0) dsRight += dsb;
      left += dsLeft << 1;
      right += dsRight << 1;
    }

    // ─── Debug-scope taps (DS) ─────────────────────────────────────
    // Sample the held DS values regardless of L/R routing or volume —
    // the scope shows what each channel is currently emitting at the
    // FIFO output, not the post-routing mix. Signed 8-bit (-128..127)
    // remapped into Uint8 (0..255, 128 = silence) so the ring buffers
    // share the byte-array type with the PSG channels.
    this.debugDsa[dpos] = (this.dsaSample + 128) & 0xff;
    this.debugDsb[dpos] = (this.dsbSample + 128) & 0xff;
    const dsaAbs = this.dsaSample < 0 ? -this.dsaSample : this.dsaSample;
    const dsbAbs = this.dsbSample < 0 ? -this.dsbSample : this.dsbSample;
    this.dsaEnv = Math.max(dsaAbs, this.dsaEnv * r);
    this.dsbEnv = Math.max(dsbAbs, this.dsbEnv * r);

    this.debugSamplePos = (dpos + 1) & Apu.DEBUG_BUFFER_MASK;

    // Headroom: max PSG ≈ ±480, max DS ≈ ±508 (2 channels × 127 × 2),
    // total ≈ ±988. Divide by 1024 to land safely inside [-1, +1].
    this.lastStereoLeft = left / 1024;
    this.lastStereoRight = right / 1024;
  }

  /** True when the FIFO is at or below half-fill (16 of 32 samples).
   *  The DMA engine watches this so it knows when to push more
   *  samples — a single 4-word burst is exactly 16 bytes, so refilling
   *  at the half-full watermark tops the FIFO back up to its full
   *  32-sample capacity with no overflow. */
  get fifoARequest(): boolean {
    return this.fifoA.fill <= 16;
  }
  get fifoBRequest(): boolean {
    return this.fifoB.fill <= 16;
  }

  /** Fired when FIFO A drops to or below the half-full mark (16 of
   *  32 samples — see `fifoARequest`). The DMA engine watches this
   *  and refills the FIFO via a 16-byte burst from whichever DMA1/2
   *  channel is bound to FIFO_A's address. */
  onFifoARequest: (() => void) | null = null;
  /** Same as {@link onFifoARequest} but for FIFO B. */
  onFifoBRequest: (() => void) | null = null;

  /** Called by the timer subsystem when timer 0 or 1 overflows. Each
   *  Direct Sound channel has a `timer select` bit in SOUNDCNT_H that
   *  picks one of those timers; on overflow we pop a sample from that
   *  channel's FIFO and latch it as the next held sample. Also fires
   *  the FIFO-request callbacks when the post-pop fill drops to the
   *  refill watermark. */
  onTimerOverflow(timerIndex: 0 | 1): void {
    if (!this.masterEnabled) return;
    const cntH = this.soundcntH;
    const dsaTimer = (cntH & SOUNDCNT_H_DSA_TIMER) !== 0 ? 1 : 0;
    const dsbTimer = (cntH & SOUNDCNT_H_DSB_TIMER) !== 0 ? 1 : 0;
    if (dsaTimer === timerIndex) {
      this.dsaSample = this.fifoA.pop();
      if (this.fifoARequest) this.onFifoARequest?.();
    }
    if (dsbTimer === timerIndex) {
      this.dsbSample = this.fifoB.pop();
      if (this.fifoBRequest) this.onFifoBRequest?.();
    }
  }

  private advanceSampleClock(cycles: number, silent: boolean): void {
    this.sampleAccumulator += cycles;
    while (this.sampleAccumulator >= this.cyclesPerSample) {
      this.sampleAccumulator -= this.cyclesPerSample;
      if (this.outPos >= this.outLeft.length) {
        // Ring full — let the caller drain. Drop the sample rather
        // than overwrite history.
        continue;
      }
      if (silent) {
        this.outLeft[this.outPos] = 0;
        this.outRight[this.outPos] = 0;
        // Bleed the LP state toward zero during silence too — otherwise
        // a long master-off stretch would leave the filter holding the
        // last sample and emit a click when audio resumes.
        this.lpL += this.lpAlpha * (0 - this.lpL);
        this.lpR += this.lpAlpha * (0 - this.lpR);
      } else {
        this.mixStereoInto();
        this.lpL += this.lpAlpha * (this.lastStereoLeft - this.lpL);
        this.lpR += this.lpAlpha * (this.lastStereoRight - this.lpR);
        this.outLeft[this.outPos] = this.lpL;
        this.outRight[this.outPos] = this.lpR;
      }
      this.outPos++;
    }
  }

  private tickFrameSequencer(cycles: number): void {
    let remaining = cycles | 0;
    while (remaining > 0) {
      if (this.fsTimer > remaining) {
        this.fsTimer -= remaining;
        return;
      }
      remaining -= this.fsTimer;
      this.fsTimer = FS_PERIOD_CYCLES;
      this.fsStep = (this.fsStep + 1) & 7;
      this.runFrameSequencerStep(this.fsStep);
    }
  }

  private runFrameSequencerStep(step: number): void {
    if (step === 0 || step === 2 || step === 4 || step === 6) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (step === 2 || step === 6) {
      this.ch1.clockSweep();
    }
    if (step === 7) {
      this.ch1.clockEnvelope();
      this.ch2.clockEnvelope();
      this.ch4.clockEnvelope();
    }
  }

  private syncChannelStatus(): void {
    // Bits 0-3 of SOUNDCNT_X are read-only PSG channel-on flags.
    let status = 0;
    if (this.ch1.enabled) status |= 0x01;
    if (this.ch2.enabled) status |= 0x02;
    if (this.ch3.enabled) status |= 0x04;
    if (this.ch4.enabled) status |= 0x08;
    this.soundcntX = (this.soundcntX & ~0x000f) | status;
  }

  /** Sum of the four PSG channels as a signed amplitude, before any
   *  L/R routing or master-volume scaling. Each channel clamps around
   *  [-15, +15] so the sum sits in [-60, +60]. Used by tests and
   *  diagnostic visualisations; the production mix goes through
   *  `sampleStereo()`. */
  samplePsg(): number {
    return (
      (this.muteChannel[0] ? 0 : this.ch1.sample()) +
      (this.muteChannel[1] ? 0 : this.ch2.sample()) +
      (this.muteChannel[2] ? 0 : this.ch3.sample()) +
      (this.muteChannel[3] ? 0 : this.ch4.sample())
    );
  }

  // ─── Save state ────────────────────────────────────────────────────
  //
  // `outLeft`/`outRight`/`outPos` (host audio ring) and `cyclesPerSample`
  // (set from the host AudioContext at boot) are deliberately NOT
  // serialised. The audio callback regenerates the ring next frame and
  // the UI re-applies the host sample rate on load.

  serialize(w: GbaStateWriter): void {
    for (const psg of this.psg) {
      w.u16(psg.cntL);
      w.u16(psg.cntH);
      w.u16(psg.cntX);
    }
    this.ch1.serialize(w);
    this.ch2.serialize(w);
    this.ch3.serialize(w);
    this.ch4.serialize(w);
    w.u8(this.fsStep);
    w.i32(this.fsTimer);
    w.f64(this.sampleAccumulator);
    w.u16(this.soundcntL);
    w.u16(this.soundcntH);
    w.u16(this.soundcntX);
    w.u16(this.soundbias);
    w.bytes(this.waveRam);
    this.fifoA.serialize(w);
    this.fifoB.serialize(w);
    w.i8(this.dsaSample);
    w.i8(this.dsbSample);
  }

  deserialize(r: GbaStateReader): void {
    for (const psg of this.psg) {
      psg.cntL = r.u16();
      psg.cntH = r.u16();
      psg.cntX = r.u16();
    }
    this.ch1.deserialize(r);
    this.ch2.deserialize(r);
    this.ch3.deserialize(r);
    this.ch4.deserialize(r);
    this.fsStep = r.u8();
    this.fsTimer = r.i32();
    this.sampleAccumulator = r.f64();
    this.soundcntL = r.u16();
    this.soundcntH = r.u16();
    this.soundcntX = r.u16();
    this.soundbias = r.u16();
    r.bytes(this.waveRam);
    this.fifoA.deserialize(r);
    this.fifoB.deserialize(r);
    this.dsaSample = r.i8();
    this.dsbSample = r.i8();
  }
}
