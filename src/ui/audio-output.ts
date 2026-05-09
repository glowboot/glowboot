/**
 * Web Audio API output component.
 *
 * Uses the "scheduled AudioBuffer" technique: the APU fills `apu.outLeft` /
 * `apu.outRight` with samples each frame, then the caller invokes
 * `AudioOutput.schedule(left, right, count)` to push those samples into the
 * audio graph.  Buffers are scheduled slightly ahead of real time so a late
 * frame does not cause glitches.
 *
 * Usage:
 *   const audio = new AudioOutput();
 *   await audio.resume(); // must be called inside a user-gesture handler
 *   // In the per-frame callback:
 *   audio.schedule(gb.apu.outLeft, gb.apu.outRight, gb.apu.outPos);
 *   gb.apu.outPos = 0;
 */
export class AudioOutput {
  private readonly ctx: AudioContext;

  /** Master-volume gain node sitting between every buffer source and the
   *  AudioContext destination. Owned here so the host can control volume
   *  without reaching into the graph. */
  private readonly gain: GainNode;

  /** Seconds of look-ahead to keep in the audio graph. */
  private readonly lookAhead = 0.05;
  /** If the queue drifts further ahead than this, realign to prevent growing latency. */
  private readonly maxLead = 0.15;

  /**
   * Wall-clock time (AudioContext seconds) at which the next scheduled
   * buffer should start playing.
   */
  private nextStart = 0;

  constructor(requestedSampleRate = 44100) {
    this.ctx = new AudioContext({ sampleRate: requestedSampleRate });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
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
   * the same stereo mix the speakers get, so a canvas recording can be
   * muxed with emulator audio. Created lazily — a fresh destination node
   * per call is fine because they're cheap and the caller owns teardown.
   */
  createRecordingTap(): MediaStream {
    const dest = this.ctx.createMediaStreamDestination();
    this.gain.connect(dest);
    return dest.stream;
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
