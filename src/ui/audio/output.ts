/**
 * Web Audio API output component.
 *
 * Uses the "scheduled AudioBuffer" technique: the APU fills `apu.outLeft` /
 * `apu.outRight` with samples each frame, then the caller invokes
 * `AudioOutput.schedule(left, right, count)` to push those samples into the
 * audio graph.  Buffers are scheduled slightly ahead of real time so a late
 * frame does not cause glitches.
 *
 * Signal flow:
 *   sources → gain → [audio-mode filter chain] → [calibrated trim] → tail → destination
 *
 * The audio-mode chain (filters / saturation / reverb, see `setAudioMode`)
 * sits between the master gain and the fixed `tail` node. A calibrated
 * trim node lives at the end of every non-studio chain so each mode
 * sits at the same perceived loudness as studio (see `calibrateLoudness`).
 * The recording tap connects from `tail` so canvas recordings hear
 * exactly what the user hears.
 *
 * Usage:
 *   const audio = new AudioOutput();
 *   await audio.resume(); // must be called inside a user-gesture handler
 *   // In the per-frame callback:
 *   audio.schedule(gb.apu.outLeft, gb.apu.outRight, gb.apu.outPos);
 *   gb.apu.outPos = 0;
 */
export type AudioMode = "studio" | "gb-speaker" | "warm-headphones" | "bright" | "boombox" | "cassette" | "hall-reverb";

// Sorted alphabetically by display name to match the render-mode
// dropdown convention. Ids mirror their display names (kebab-case)
// for a uniform pattern; "studio" is the no-op pass-through default,
// using the listening-context metaphor the other names follow
// (studio reference monitors = flat frequency response, no colour).
export const AUDIO_MODES: readonly { id: AudioMode; name: string }[] = [
  { id: "boombox", name: "Boombox" },
  { id: "bright", name: "Bright & crisp" },
  { id: "cassette", name: "Cassette tape" },
  { id: "gb-speaker", name: "Game Boy speaker" },
  { id: "hall-reverb", name: "Hall reverb" },
  { id: "studio", name: "Studio" },
  { id: "warm-headphones", name: "Warm headphones" }
];

/** Shape returned by each mode's builder. The chain may be serial
 *  (`entry === nodes[0]`, `exit === nodes[nodes.length - 1]`) or branch
 *  internally (reverb uses a dry/wet split). The outer code only cares
 *  about which node it connects upstream input into and which one feeds
 *  the tail. `nodes` tracks the full set for teardown. */
interface AudioModeGraph {
  entry: AudioNode;
  exit: AudioNode;
  nodes: AudioNode[];
}

export class AudioOutput {
  private readonly ctx: AudioContext;

  /** Master-volume gain node sitting between every buffer source and the
   *  audio-mode chain. Owned here so the host can control volume
   *  without reaching into the graph. */
  private readonly gain: GainNode;

  /** Fixed terminal node downstream of the audio-mode chain. The
   *  recording tap and destination connect here, so rebuilding the
   *  chain (`setAudioMode`) never disturbs either. */
  private readonly tail: GainNode;

  /** Currently-installed filter nodes between `gain` and `tail`. Empty
   *  when the mode is "studio" (pass-through). Tracked so we can
   *  disconnect them cleanly before building the next chain. */
  private chainNodes: AudioNode[] = [];

  private currentAudioMode: AudioMode = "studio";

  /** Per-mode trim gain that makes every chain output at the same RMS
   *  as the studio pass-through. Populated by `calibrateLoudness`
   *  asynchronously; until each mode's entry lands, `setAudioMode`
   *  uses 1.0 as a safe fallback (slightly hotter than calibrated for
   *  most modes, but never silent). */
  private calibratedTrims = new Map<AudioMode, number>();

  /** Shared reverb impulse. Lazily generated on first use so the cost
   *  is paid once whether hall-reverb is selected at runtime or hit
   *  during calibration. Reused across live and offline contexts —
   *  AudioBuffers are portable as long as the sample rate matches. */
  private reverbImpulse: AudioBuffer | null = null;

  /** Seconds of look-ahead to keep in the audio graph. */
  private readonly lookAhead = 0.05;
  /** If the queue drifts further ahead than this, realign to prevent growing latency. */
  private readonly maxLead = 0.15;

  /** True once we've played a silent buffer to unlock iOS Safari's audio
   *  output. Some iOS versions resume the AudioContext but won't route
   *  audio to the speakers until a buffer has actually been played from
   *  inside a user-gesture frame. The one-shot is harmless on other
   *  platforms — playing a 1-frame silent buffer is a no-op. */
  private outputUnlocked = false;

  /**
   * Wall-clock time (AudioContext seconds) at which the next scheduled
   * buffer should start playing.
   */
  private nextStart = 0;

  constructor(requestedSampleRate = 44100) {
    this.ctx = new AudioContext({ sampleRate: requestedSampleRate });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.tail = this.ctx.createGain();
    this.tail.gain.value = 1.0;
    // Default: pass-through (the "studio" mode). `setAudioMode` rewires
    // this when a non-studio mode is selected.
    this.gain.connect(this.tail);
    this.tail.connect(this.ctx.destination);
    // Fire-and-forget: render each preset through OfflineAudioContext to
    // discover its actual gain vs. studio. While this runs (a few ms to
    // ~100 ms depending on hardware), modes fall back to trim 1.0; once
    // it lands, the current mode is re-applied so its calibrated trim
    // takes effect.
    void this.calibrateLoudness();
  }

  /** Nominal sample rate of the AudioContext (may differ from requested). */
  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Master volume in the 0..1 range. Clamped on set. Applies
   *  instantaneously via the GainNode on the audio graph. */
  get volume(): number {
    return this.gain.gain.value;
  }
  set volume(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    this.gain.gain.value = clamped;
  }

  /**
   * Resume a suspended AudioContext.
   * Call this from inside a user-gesture event handler (click, keydown, etc.)
   * before the first frame, because browsers require a user gesture before
   * audio playback can start.
   */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    if (!this.outputUnlocked) {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.start(0);
      this.outputUnlocked = true;
    }
    // Bootstrap the next-start pointer with a small initial lead
    this.nextStart = this.ctx.currentTime + this.lookAhead;
  }

  /**
   * Suspend audio playback. Any already-scheduled buffers stop emitting
   * immediately. Call `resume()` to continue.
   */
  async suspend(): Promise<void> {
    if (this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  /**
   * Tap the audio graph for `MediaRecorder`. Returns a MediaStream carrying
   * the same stereo mix the speakers get (audio mode included), so a
   * canvas recording can be muxed with emulator audio. Created lazily — a
   * fresh destination node per call is fine because they're cheap and the
   * caller owns teardown.
   */
  createRecordingTap(): MediaStream {
    const dest = this.ctx.createMediaStreamDestination();
    this.tail.connect(dest);
    return dest.stream;
  }

  /** Currently-selected audio mode. */
  get audioMode(): AudioMode {
    return this.currentAudioMode;
  }

  /**
   * Swap the audio-mode filter chain. "studio" routes the master gain
   * straight to `tail` (and onwards to destination); other modes insert
   * filter / saturation nodes that colour the output, followed by a
   * calibrated trim gain so every mode matches studio loudness. Safe
   * to call at any time — scheduled audio keeps playing through the
   * rebuild because `gain` and `tail` are preserved.
   */
  setAudioMode(mode: AudioMode): void {
    // `disconnect()` with no arg kills every outgoing edge. `gain`
    // only feeds the chain (or `tail` directly in studio mode), so
    // this is safe; chain nodes likewise only feed the next link.
    // `tail` is never disconnected, so its destination + recording-
    // tap edges survive.
    try {
      this.gain.disconnect();
    } catch {
      /* no current connection */
    }
    for (const n of this.chainNodes) {
      try {
        n.disconnect();
      } catch {
        /* node already detached */
      }
    }
    const graph = this.buildAudioModeGraph(this.ctx, mode);
    if (graph === null) {
      this.chainNodes = [];
      this.gain.connect(this.tail);
    } else {
      // Wrap with the calibrated trim so every mode lands at studio
      // loudness. Until calibration completes, fall back to 1.0.
      const trim = this.ctx.createGain();
      trim.gain.value = this.calibratedTrims.get(mode) ?? 1;
      this.gain.connect(graph.entry);
      graph.exit.connect(trim);
      trim.connect(this.tail);
      this.chainNodes = [...graph.nodes, trim];
    }
    this.currentAudioMode = mode;
  }

  /** Build the audio graph for a mode. Returns `null` for the no-op
   *  "studio" mode (the caller wires `gain → tail` directly). For
   *  every other mode, the returned `entry` is the first node fed by
   *  the master gain and `exit` is the last node before the trim /
   *  tail; the chain may branch internally (reverb uses parallel
   *  dry/wet paths). All internal connections are made inside this
   *  method — the caller wires only the entry / exit. The `ctx`
   *  parameter accepts either the live `AudioContext` or an
   *  `OfflineAudioContext` used during calibration. */
  private buildAudioModeGraph(ctx: BaseAudioContext, mode: AudioMode): AudioModeGraph | null {
    switch (mode) {
      case "studio":
        return null;
      case "gb-speaker":
        return this.buildGbSpeakerGraph(ctx);
      case "warm-headphones":
        return this.buildWarmHeadphonesGraph(ctx);
      case "bright":
        return this.buildBrightGraph(ctx);
      case "boombox":
        return this.buildBoomboxGraph(ctx);
      case "cassette":
        return this.buildCassetteGraph(ctx);
      case "hall-reverb":
        return this.buildHallReverbGraph(ctx);
    }
  }

  // ─── Mode builders ─────────────────────────────────────────────────────
  // Loudness compensation lives in `calibratedTrims`, applied as a
  // single gain node after each chain by `setAudioMode`. The builders
  // here describe character only — filter shapes, EQ, saturation.

  /** Tiny mono Game Boy speaker: band-pass around the midrange (no low
   *  end from a 1-inch cone, limited high end), a mid-peak for the
   *  "tinny" character, and soft-clip for the saturation a small driver
   *  adds at the upper end of its travel. */
  private buildGbSpeakerGraph(ctx: BaseAudioContext): AudioModeGraph {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 280;
    hp.Q.value = 0.7;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4500;
    lp.Q.value = 0.7;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1800;
    mid.Q.value = 1.0;
    mid.gain.value = 4;

    const sat = ctx.createWaveShaper();
    sat.curve = makeSoftClipCurve(2.5);
    sat.oversample = "2x";

    hp.connect(lp);
    lp.connect(mid);
    mid.connect(sat);
    return { entry: hp, exit: sat, nodes: [hp, lp, mid, sat] };
  }

  /** Line-out / headphones EQ: warmer bass + tame the harsh upper
   *  midrange of square waves + roll off the brittle top. The Game Boy's
   *  spectrum sits almost entirely between 100 Hz and 4 kHz, so subtle
   *  shelves at the spectrum edges are inaudible — the cut needs to
   *  land inside the band. */
  private buildWarmHeadphonesGraph(ctx: BaseAudioContext): AudioModeGraph {
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 300;
    lowShelf.gain.value = 6;

    const midCut = ctx.createBiquadFilter();
    midCut.type = "peaking";
    midCut.frequency.value = 2500;
    midCut.Q.value = 0.9;
    midCut.gain.value = -4;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 4000;
    highShelf.gain.value = -5;

    lowShelf.connect(midCut);
    midCut.connect(highShelf);
    return { entry: lowShelf, exit: highShelf, nodes: [lowShelf, midCut, highShelf] };
  }

  /** Treble-forward "crisp" EQ — opposite of warm. Pulls the low-end
   *  weight back, lifts the upper-mid presence range, and adds high-end
   *  air. */
  private buildBrightGraph(ctx: BaseAudioContext): AudioModeGraph {
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 250;
    lowShelf.gain.value = -3;

    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2200;
    presence.Q.value = 1.0;
    presence.gain.value = 3;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 4500;
    highShelf.gain.value = 6;

    lowShelf.connect(presence);
    presence.connect(highShelf);
    return { entry: lowShelf, exit: highShelf, nodes: [lowShelf, presence, highShelf] };
  }

  /** V-shape "loudness" curve like a consumer boombox: pronounced bass
   *  boost, scooped midrange, lifted treble. */
  private buildBoomboxGraph(ctx: BaseAudioContext): AudioModeGraph {
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 120;
    lowShelf.gain.value = 7;

    const midScoop = ctx.createBiquadFilter();
    midScoop.type = "peaking";
    midScoop.frequency.value = 1000;
    midScoop.Q.value = 0.8;
    midScoop.gain.value = -4;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 6000;
    highShelf.gain.value = 6;

    lowShelf.connect(midScoop);
    midScoop.connect(highShelf);
    return { entry: lowShelf, exit: highShelf, nodes: [lowShelf, midScoop, highShelf] };
  }

  /** Dark, slightly compressed cassette-tape character: aggressive HF
   *  roll-off + tape-style soft saturation. Distinguished from
   *  gb-speaker by keeping the low end intact (cassette has full bass,
   *  the GB driver doesn't). */
  private buildCassetteGraph(ctx: BaseAudioContext): AudioModeGraph {
    const lowPass = ctx.createBiquadFilter();
    lowPass.type = "lowpass";
    lowPass.frequency.value = 5000;
    lowPass.Q.value = 0.7;

    const airCut = ctx.createBiquadFilter();
    airCut.type = "highshelf";
    airCut.frequency.value = 7000;
    airCut.gain.value = -6;

    const sat = ctx.createWaveShaper();
    sat.curve = makeSoftClipCurve(1.8);
    sat.oversample = "2x";

    lowPass.connect(airCut);
    airCut.connect(sat);
    return { entry: lowPass, exit: sat, nodes: [lowPass, airCut, sat] };
  }

  /** Medium-sized hall reverb. Wet/dry parallel split: the input gain
   *  fans out to a dry path and a convolver-fed wet path, both summed
   *  into a mix node. The impulse is a stereo exponentially-decaying
   *  white-noise burst — cheap to generate and gives a credible diffuse
   *  reverb tail without shipping an IR file. The dry/wet/mix gains
   *  describe the reverb character; final loudness alignment vs studio
   *  is handled by the calibrated trim. */
  private buildHallReverbGraph(ctx: BaseAudioContext): AudioModeGraph {
    const input = ctx.createGain();

    const dry = ctx.createGain();
    dry.gain.value = 0.75;

    const convolver = ctx.createConvolver();
    this.reverbImpulse ??= makeReverbImpulse(ctx, /* seconds */ 1.4, /* decay */ 2.4);
    convolver.buffer = this.reverbImpulse;

    const wet = ctx.createGain();
    wet.gain.value = 0.35;

    const mix = ctx.createGain();

    input.connect(dry);
    input.connect(convolver);
    convolver.connect(wet);
    dry.connect(mix);
    wet.connect(mix);
    return { entry: input, exit: mix, nodes: [input, dry, convolver, wet, mix] };
  }

  // ─── Loudness calibration ──────────────────────────────────────────────

  /** Render each non-studio mode through `OfflineAudioContext` with a
   *  band-limited noise reference signal, measure RMS, and compute the
   *  per-mode trim gain that brings its output level to match studio
   *  (pass-through). The result is stable across sessions (depends only
   *  on the chain definitions + sample rate), but the cost is small
   *  enough that recomputing on every load avoids the staleness risk
   *  of caching it across releases. */
  private async calibrateLoudness(): Promise<void> {
    const sampleRate = this.ctx.sampleRate;
    // 1.5 s total: 0.3 s settle for transients (reverb tail in
    // particular needs ~1.4 s to fill), then 1.2 s of steady-state to
    // average over. Total render is well under 100 ms wall-clock.
    const totalLen = Math.floor(sampleRate * 1.5);
    const settleLen = Math.floor(sampleRate * 0.3);

    const testSignal = makeCalibrationSignal(totalLen);
    const studioRms = rms(testSignal.subarray(settleLen));
    this.calibratedTrims.set("studio", 1);
    if (studioRms < 1e-6) return; // pathological test signal

    for (const { id } of AUDIO_MODES) {
      if (id === "studio") continue;
      try {
        const measured = await this.measureModeRms(id, testSignal, totalLen, sampleRate, settleLen);
        // Clamp to a sane range. A degenerate measurement (e.g., the
        // chain accidentally outputs silence) shouldn't blow the user's
        // ears or mute them entirely.
        const trim = measured > 1e-6 ? Math.max(0.05, Math.min(5, studioRms / measured)) : 1;
        this.calibratedTrims.set(id, trim);
      } catch (err) {
        console.warn(`[Audio] Calibration failed for ${id}:`, err);
        this.calibratedTrims.set(id, 1);
      }
    }

    // Re-apply the current mode so its newly-known trim takes effect.
    // The user may have switched away from "studio" during calibration;
    // re-applying is cheap (a couple of disconnect/connect ops).
    if (this.currentAudioMode !== "studio") this.setAudioMode(this.currentAudioMode);
  }

  /** Render a single mode through `OfflineAudioContext` and return the
   *  RMS of the steady-state portion. */
  private async measureModeRms(
    mode: AudioMode,
    testSignal: Float32Array,
    totalLen: number,
    sampleRate: number,
    settleLen: number
  ): Promise<number> {
    const offline = new OfflineAudioContext(2, totalLen, sampleRate);
    const buf = offline.createBuffer(2, totalLen, sampleRate);
    buf.getChannelData(0).set(testSignal);
    buf.getChannelData(1).set(testSignal);
    const src = offline.createBufferSource();
    src.buffer = buf;
    const graph = this.buildAudioModeGraph(offline, mode);
    if (graph) {
      src.connect(graph.entry);
      graph.exit.connect(offline.destination);
    } else {
      src.connect(offline.destination);
    }
    src.start(0);
    const rendered = await offline.startRendering();
    return rms(rendered.getChannelData(0).subarray(settleLen));
  }

  /**
   * Schedule `count` samples from `left` / `right` for playback.
   *
   * If the emulator is running faster or slower than real time, realign the
   * scheduling pointer to keep latency bounded (drops or duplicates a small
   * chunk of audio rather than letting delay grow without bound).
   */
  schedule(left: Float32Array, right: Float32Array, count: number): void {
    if (count === 0 || this.ctx.state !== "running") return;

    const now = this.ctx.currentTime;

    // Realign if we've fallen behind or drifted too far ahead.
    if (this.nextStart < now || this.nextStart > now + this.maxLead) {
      this.nextStart = now + this.lookAhead;
    }

    const buffer = this.ctx.createBuffer(2, count, this.ctx.sampleRate);
    buffer.getChannelData(0).set(left.subarray(0, count));
    buffer.getChannelData(1).set(right.subarray(0, count));

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.start(this.nextStart);

    this.nextStart += count / this.ctx.sampleRate;
  }
}

/** tanh-based soft-clipping curve for WaveShaperNode. `amount` controls
 *  how hard the curve squashes — higher = more saturation. Normalised so
 *  unity input still maps to roughly unity output. Constructed on a real
 *  ArrayBuffer (not the default ArrayBufferLike) so the result matches
 *  WaveShaperNode.curve's strict-mode type. */
function makeSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / norm;
  }
  return curve;
}

/** Synthesise a stereo reverb impulse for ConvolverNode: white noise
 *  envelope-shaped by `(1 - t)^decay`. Cheap to generate and produces a
 *  credible diffuse tail — no IR file needed in the bundle. Per-channel
 *  noise is independent so the wet signal stays stereo even on a mono
 *  source. */
function makeReverbImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** RMS of a sample buffer. Used by `calibrateLoudness` as a stand-in
 *  for perceived loudness — not as precise as LUFS but fast, dependency-
 *  free, and accurate enough to match presets within a couple of dB. */
function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Generate a band-limited noise reference signal for `calibrateLoudness`.
 *  Two pole low-pass filters approximate a 1/f-ish spectrum focused on
 *  the GB band (~80 Hz to ~5 kHz at 44.1 kHz). RMS-normalised to 0.3
 *  so peaks hit the soft-clip nonlinearity at roughly the same drive
 *  level real GB content does — a calibration signal that stays below
 *  every saturator's threshold would systematically under-measure the
 *  modes that use soft-clip. */
function makeCalibrationSignal(length: number): Float32Array {
  const buf = new Float32Array(length);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < length; i++) {
    const noise = Math.random() * 2 - 1;
    lp1 = lp1 * 0.85 + noise * 0.15;
    lp2 = lp2 * 0.85 + lp1 * 0.15;
    buf[i] = lp2;
  }
  const currentRms = rms(buf);
  if (currentRms > 0) {
    const scale = 0.3 / currentRms;
    for (let i = 0; i < length; i++) buf[i] = buf[i]! * scale;
  }
  return buf;
}
