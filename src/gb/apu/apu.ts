import type { StateReader, StateWriter } from "../serialization/serialization.js";
import { NoiseChannel, SquareChannel, WaveChannel } from "./channels.js";

/**
 * Audio Processing Unit.
 *
 * Drives four channels, a frame sequencer, and a simple stereo mixer.
 * Samples are written into `outLeft` / `outRight` (0–1 range) as they are
 * generated. The caller should drain `outPos` samples after each frame and
 * reset `outPos` to 0.
 *
 * Register map (via MMU 0xFF10–0xFF3F):
 *   CH1  Sweep+Square  0xFF10–0xFF14  NR10–NR14
 *   CH2  Square        0xFF16–0xFF19  NR21–NR24
 *   CH3  Wave          0xFF1A–0xFF1E  NR30–NR34
 *   CH4  Noise         0xFF20–0xFF23  NR41–NR44
 *   Ctrl               0xFF24–0xFF26  NR50–NR52
 *   Wave RAM           0xFF30–0xFF3F
 *
 * Frame sequencer (512 Hz, one step every 8192 T-cycles):
 *   Step  0  2  4  6  →  length counter clock (256 Hz)
 *   Step  2  6        →  sweep clock          (128 Hz)
 *   Step  7           →  envelope clock       ( 64 Hz)
 */

const CPU_CLOCK = 4_194_304;

/** DC-blocking filter coefficient (~60 Hz cutoff at 44.1 kHz). */
const HP_COEFF = 0.9914;

export class APU {
  // ─── Channels ─────────────────────────────────────────────────────────────
  readonly ch1 = new SquareChannel(true); // CH1: sweep + square
  readonly ch2 = new SquareChannel(false); // CH2: square
  readonly ch3 = new WaveChannel(); // CH3: wave
  readonly ch4 = new NoiseChannel(); // CH4: noise

  // ─── Control registers ────────────────────────────────────────────────────
  private nr50 = 0x77; // master volume: SO2 (L) bits 6-4, SO1 (R) bits 2-0
  private nr51 = 0xf3; // panning: bits 7-4 → L channels 4-1, bits 3-0 → R
  private nr52 = 0xf1; // bit 7 = APU on/off; bits 3-0 = channel status (r/o)

  private get apuOn(): boolean {
    return (this.nr52 & 0x80) !== 0;
  }

  // ─── Frame sequencer ──────────────────────────────────────────────────────
  private fsTimer = 0;
  private fsStep = 0;
  private static readonly FS_PERIOD = 8192; // T-cycles per step

  // ─── Sample generation ────────────────────────────────────────────────────
  /** Sample rate used to size the output buffer and compute timing.
   *  Write-only externally — the host installs the AudioContext rate
   *  once at boot via `gb.apu.sampleRate = audio.sampleRate`. */
  set sampleRate(v: number) {
    this.cyclesPerSample = CPU_CLOCK / v;
    // Reset the accumulator so cycles already banked against the old period
    // don't immediately fire a spurious sample at the new rate.
    this.sampleTimer = 0;
  }
  private cyclesPerSample = CPU_CLOCK / 44100;
  private sampleTimer = 0.0;

  // DC-blocking filter state (high-pass, removes DC offset from mixed output)
  private hpL = 0.0;
  private hpR = 0.0;
  private prevRawL = 0.0;
  private prevRawR = 0.0;

  /** Output sample buffers — drain after each frame and reset outPos to 0. */
  readonly outLeft = new Float32Array(2048);
  readonly outRight = new Float32Array(2048);
  outPos = 0;

  // ─── Bus interface ────────────────────────────────────────────────────────

  readByte(addr: number): number {
    // Wave RAM. On CGB, reads while CH3 is active return the byte at
    // the position currently being played, regardless of which
    // $FF30-$FF3F address the CPU hit. The DMG has a narrow timing
    // window around a sample fetch where this also works and returns
    // $FF otherwise — we present as CGB everywhere, so the simpler
    // always-redirect rule matches what games (and Blargg `cgb_sound
    // 09 / 12`) expect.
    if (addr >= 0xff30 && addr <= 0xff3f) {
      const idx = this.ch3.enabled ? this.ch3.currentByteIndex : addr - 0xff30;
      return this.ch3.waveRam[idx]!;
    }

    switch (addr) {
      // CH1
      case 0xff10:
        return this.ch1.readByte(0);
      case 0xff11:
        return this.ch1.readByte(1);
      case 0xff12:
        return this.ch1.readByte(2);
      case 0xff13:
        return this.ch1.readByte(3);
      case 0xff14:
        return this.ch1.readByte(4);
      // CH2 (0xFF15 unused)
      case 0xff16:
        return this.ch2.readByte(1);
      case 0xff17:
        return this.ch2.readByte(2);
      case 0xff18:
        return this.ch2.readByte(3);
      case 0xff19:
        return this.ch2.readByte(4);
      // CH3
      case 0xff1a:
        return this.ch3.readByte(0);
      case 0xff1b:
        return this.ch3.readByte(1);
      case 0xff1c:
        return this.ch3.readByte(2);
      case 0xff1d:
        return this.ch3.readByte(3);
      case 0xff1e:
        return this.ch3.readByte(4);
      // CH4 (0xFF1F unused)
      case 0xff20:
        return this.ch4.readByte(1);
      case 0xff21:
        return this.ch4.readByte(2);
      case 0xff22:
        return this.ch4.readByte(3);
      case 0xff23:
        return this.ch4.readByte(4);
      // Control
      case 0xff24:
        return this.nr50;
      case 0xff25:
        return this.nr51;
      case 0xff26:
        return this.readNR52();
      // CGB-only PCM amplitude readouts. PCM12 / PCM34 expose the current
      // 4-bit DAC output of channels 1+2 / 3+4 respectively. Pan Docs
      // labels these "undocumented" but Mooneye `unused_hwio-C` verifies
      // they read as 0 when channels are silent.
      case 0xff76:
        return (this.ch1.sample() & 0x0f) | ((this.ch2.sample() & 0x0f) << 4);
      case 0xff77:
        return (this.ch3.sample() & 0x0f) | ((this.ch4.sample() & 0x0f) << 4);
      default:
        return 0xff;
    }
  }

  writeByte(addr: number, v: number): void {
    // Wave RAM is always writable, but on CGB a write while CH3 is
    // active lands at the byte currently being played rather than
    // the requested address — mirror of the read-intercept above.
    // Needed for Blargg `cgb_sound 12` "write test".
    if (addr >= 0xff30 && addr <= 0xff3f) {
      const idx = this.ch3.enabled ? this.ch3.currentByteIndex : addr - 0xff30;
      this.ch3.waveRam[idx] = v;
      return;
    }

    // NR52 (power) always writable
    if (addr === 0xff26) {
      const wasOn = this.apuOn;
      this.nr52 = v & 0x80;
      if (wasOn && !this.apuOn) this.powerOff();
      return;
    }

    // Everything else requires APU on
    if (!this.apuOn) return;

    switch (addr) {
      // CH1
      case 0xff10:
        this.ch1.writeByte(0, v, true, this.fsStep);
        break;
      case 0xff11:
        this.ch1.writeByte(1, v, true, this.fsStep);
        break;
      case 0xff12:
        this.ch1.writeByte(2, v, true, this.fsStep);
        break;
      case 0xff13:
        this.ch1.writeByte(3, v, true, this.fsStep);
        break;
      case 0xff14:
        this.ch1.writeByte(4, v, true, this.fsStep);
        break;
      // CH2
      case 0xff16:
        this.ch2.writeByte(1, v, true, this.fsStep);
        break;
      case 0xff17:
        this.ch2.writeByte(2, v, true, this.fsStep);
        break;
      case 0xff18:
        this.ch2.writeByte(3, v, true, this.fsStep);
        break;
      case 0xff19:
        this.ch2.writeByte(4, v, true, this.fsStep);
        break;
      // CH3
      case 0xff1a:
        this.ch3.writeByte(0, v, true, this.fsStep);
        break;
      case 0xff1b:
        this.ch3.writeByte(1, v, true, this.fsStep);
        break;
      case 0xff1c:
        this.ch3.writeByte(2, v, true, this.fsStep);
        break;
      case 0xff1d:
        this.ch3.writeByte(3, v, true, this.fsStep);
        break;
      case 0xff1e:
        this.ch3.writeByte(4, v, true, this.fsStep);
        break;
      // CH4
      case 0xff20:
        this.ch4.writeByte(1, v, true, this.fsStep);
        break;
      case 0xff21:
        this.ch4.writeByte(2, v, true, this.fsStep);
        break;
      case 0xff22:
        this.ch4.writeByte(3, v, true, this.fsStep);
        break;
      case 0xff23:
        this.ch4.writeByte(4, v, true, this.fsStep);
        break;
      // Control
      case 0xff24:
        this.nr50 = v;
        break;
      case 0xff25:
        this.nr51 = v;
        break;
    }
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  /** Advance APU by `t` real-time T-cycles. Called per bus access from
   *  the CPU so wave-channel-RAM reads land at the M-cycle the access
   *  actually happens on — required for Blargg `cgb_sound 09` to pass. */
  tickTCycles(t: number): void {
    if (!this.apuOn || t <= 0) return;

    // Frame sequencer
    this.fsTimer += t;
    while (this.fsTimer >= APU.FS_PERIOD) {
      this.fsTimer -= APU.FS_PERIOD;
      this.stepFrameSequencer();
    }

    // Channel timers
    this.ch1.tick(t);
    this.ch2.tick(t);
    this.ch3.tick(t);
    this.ch4.tick(t);

    // Sample generation
    this.sampleTimer += t;
    while (this.sampleTimer >= this.cyclesPerSample) {
      this.sampleTimer -= this.cyclesPerSample;
      if (this.outPos < this.outLeft.length) this.pushSample();
    }
  }

  // ─── Frame sequencer ──────────────────────────────────────────────────────

  /**
   * Advance one step (called at ~512 Hz).
   *
   *  Step  0  2  4  6 → length
   *  Step  2  6       → sweep
   *  Step  7          → envelope
   */
  private stepFrameSequencer(): void {
    const s = this.fsStep;

    if ((s & 1) === 0) {
      // length: steps 0, 2, 4, 6
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (s === 2 || s === 6) {
      // sweep: steps 2, 6
      this.ch1.clockSweep();
    }
    if (s === 7) {
      // envelope: step 7
      this.ch1.clockEnvelope();
      this.ch2.clockEnvelope();
      this.ch4.clockEnvelope();
    }

    this.fsStep = (s + 1) & 7;
  }

  // ─── Mixing ───────────────────────────────────────────────────────────────

  /**
   * Mix one sample and append to `outLeft`/`outRight`.
   *
   * NR51 panning (bits 7-4 = CH4–CH1 to SO2/Left,
   *               bits 3-0 = CH4–CH1 to SO1/Right).
   * NR50 volume: SO2 = bits 6-4 (+1 = 1–8), SO1 = bits 2-0 (+1 = 1–8).
   *
   * Output is normalised to approximately –1..1 then DC-blocked.
   */
  /**
   * Per-channel mute mask (indices: 0=CH1 pulse, 1=CH2 pulse, 2=CH3 wave,
   * 3=CH4 noise). Toggled from the UI settings panel. Muted channels
   * still tick normally — their timers/length counters keep advancing —
   * but their `sample()` output is skipped and their contribution to the
   * stereo mix is zeroed, so the rest of the engine is unchanged.
   */
  readonly muteChannel: [boolean, boolean, boolean, boolean] = [false, false, false, false];

  /** Peak-tracking envelope follower per channel. Updated every sample
   *  in `pushSample`. The audio-reactive rumble subscribes to whichever
   *  channel the user has configured — different games distribute
   *  melody / bass / SFX across the four channels differently, and
   *  there's no universally "correct" channel to watch. Decay
   *  coefficient is tuned to a ~60 ms half-life at 44.1 kHz so a sharp
   *  hit holds briefly before fading. */
  private ch1Env = 0;
  private ch2Env = 0;
  private ch3Env = 0;
  private ch4Env = 0;
  private static readonly CHAN_RELEASE = 0.9998;

  /** Per-channel raw-sample ring buffers (4096 samples ≈ 93 ms at
   *  44.1 kHz). Written once per audio sample in `pushSample`; read
   *  by the debugger's audio pane to render an oscilloscope-style
   *  waveform view. Ring size is a power of two so the wrap is a
   *  single bitwise `& DEBUG_BUFFER_MASK`. */
  private static readonly DEBUG_BUFFER_SIZE = 4096;
  private static readonly DEBUG_BUFFER_MASK = 4095;
  readonly debugCh1 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugCh2 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugCh3 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  readonly debugCh4 = new Uint8Array(APU.DEBUG_BUFFER_SIZE);
  private debugSamplePos = 0;

  /** Current write position into the per-channel debug buffers. The
   *  scope view reads the last N samples ending here. */
  get debugBufferPos(): number {
    return this.debugSamplePos;
  }
  get debugBufferSize(): number {
    return APU.DEBUG_BUFFER_SIZE;
  }

  /** Per-channel envelope normalized to 0..1. */
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

  private pushSample(): void {
    const s1 = this.muteChannel[0] ? 0 : this.ch1.sample(); // 0–15
    const s2 = this.muteChannel[1] ? 0 : this.ch2.sample();
    const s3 = this.muteChannel[2] ? 0 : this.ch3.sample();
    const s4 = this.muteChannel[3] ? 0 : this.ch4.sample();

    // Track per-channel peaks with exponential release. Attack is
    // instant (`Math.max`), release decays each sample — so a burst
    // spikes the envelope and lingers for a moment, steady silence
    // bleeds it down toward zero.
    const r = APU.CHAN_RELEASE;
    this.ch1Env = Math.max(s1, this.ch1Env * r);
    this.ch2Env = Math.max(s2, this.ch2Env * r);
    this.ch3Env = Math.max(s3, this.ch3Env * r);
    this.ch4Env = Math.max(s4, this.ch4Env * r);

    // Capture raw samples into debug ring buffers for the scope view.
    // Four byte writes per sample — cheap enough to leave always on,
    // and the buffer is only read when the debugger pane is open.
    const dpos = this.debugSamplePos;
    this.debugCh1[dpos] = s1;
    this.debugCh2[dpos] = s2;
    this.debugCh3[dpos] = s3;
    this.debugCh4[dpos] = s4;
    this.debugSamplePos = (dpos + 1) & APU.DEBUG_BUFFER_MASK;

    const volL =
      ((this.nr51 & 0x80) !== 0 ? s4 : 0) +
      ((this.nr51 & 0x40) !== 0 ? s3 : 0) +
      ((this.nr51 & 0x20) !== 0 ? s2 : 0) +
      ((this.nr51 & 0x10) !== 0 ? s1 : 0);

    const volR =
      ((this.nr51 & 0x08) !== 0 ? s4 : 0) +
      ((this.nr51 & 0x04) !== 0 ? s3 : 0) +
      ((this.nr51 & 0x02) !== 0 ? s2 : 0) +
      ((this.nr51 & 0x01) !== 0 ? s1 : 0);

    const masterL = ((this.nr50 >> 4) & 7) + 1; // 1–8
    const masterR = (this.nr50 & 7) + 1;

    // Scale to 0..1:  max = 4 channels × 15 amplitude × 8 master = 480
    const scale = 1.0 / 480.0;
    const rawL = volL * masterL * scale;
    const rawR = volR * masterR * scale;

    // First-order IIR high-pass filter to remove DC offset
    const filtL = rawL - this.prevRawL + HP_COEFF * this.hpL;
    const filtR = rawR - this.prevRawR + HP_COEFF * this.hpR;
    this.prevRawL = rawL;
    this.prevRawR = rawR;
    this.hpL = filtL;
    this.hpR = filtR;

    this.outLeft[this.outPos] = filtL;
    this.outRight[this.outPos] = filtR;
    this.outPos++;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private readNR52(): number {
    const status =
      (this.ch1.enabled ? 0x01 : 0) |
      (this.ch2.enabled ? 0x02 : 0) |
      (this.ch3.enabled ? 0x04 : 0) |
      (this.ch4.enabled ? 0x08 : 0);
    return 0x70 | (this.nr52 & 0x80) | status;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    w.u8(this.nr50);
    w.u8(this.nr51);
    w.u8(this.nr52);
    w.u32(this.fsTimer);
    w.u8(this.fsStep);
    w.f64(this.sampleTimer);
    this.ch1.serialize(w);
    this.ch2.serialize(w);
    this.ch3.serialize(w);
    this.ch4.serialize(w);
  }
  deserialize(r: StateReader): void {
    this.nr50 = r.u8();
    this.nr51 = r.u8();
    this.nr52 = r.u8();
    this.fsTimer = r.u32();
    this.fsStep = r.u8();
    this.sampleTimer = r.f64();
    this.ch1.deserialize(r);
    this.ch2.deserialize(r);
    this.ch3.deserialize(r);
    this.ch4.deserialize(r);
    // Clear whatever samples were in flight before the snapshot — the audio
    // graph will be re-seeded by the next frame.
    this.outPos = 0;
    this.hpL = this.hpR = this.prevRawL = this.prevRawR = 0;
  }

  /** Reset all registers to 0 when APU is powered off (NR52 bit 7 cleared). */
  private powerOff(): void {
    this.ch1.reset();
    this.ch2.reset();
    this.ch3.reset();
    this.ch4.reset();
    this.nr50 = 0;
    this.nr51 = 0;
    this.fsStep = 0;
    this.fsTimer = 0;
  }
}
