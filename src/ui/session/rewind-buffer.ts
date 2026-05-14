import type { GameBoy } from "../../gb";

/**
 * Rolling save-state buffer for the rewind feature. Captures the full
 * emulator state at a fixed wall-clock cadence; `step()` pops the most
 * recent entry so repeated calls walk backwards through recent play.
 *
 * Each snapshot carries a caller-supplied `meta` payload (typed `M`) that
 * rides alongside the emulator bytes — used by the UI to restore
 * non-engine state like the frame counter and elapsed-time clock so they
 * also track backwards.
 *
 * Memory footprint is bounded by `capacity × avg-state-size`. At the
 * defaults (60 entries × ~80 KB) that's ~4.8 MB — a reasonable cap for
 * ~60 s of rewind history.
 */
export class RewindBuffer<M = undefined> {
  private readonly items: { bytes: Uint8Array; meta: M }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private capacity: number;

  constructor(
    private readonly gb: GameBoy,
    private readonly getMeta: () => M,
    private readonly intervalMs = 1000,
    capacity = 60
  ) {
    this.capacity = capacity;
  }

  /** Resize the ring. Shrinking drops oldest entries so the current
   *  tail (most recent states) is preserved — callers that want the
   *  new size in effect on the next capture and nothing else. */
  setCapacity(capacity: number): void {
    this.capacity = capacity;
    while (this.items.length > this.capacity) this.items.shift();
  }

  /** Begin sampling the emulator state once per `intervalMs`. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.capture(), this.intervalMs);
  }

  /** Stop sampling. Does NOT clear the buffer — call `reset()` for that. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Drop all captured states. Call before loading a new ROM. */
  reset(): void {
    this.items.length = 0;
  }

  /** Snapshot the current emulator state + metadata. Usually driven by
   *  `start()`'s interval, but can also be invoked manually. Silently
   *  swallows errors so a failed snapshot never crashes the emulator. */
  capture(): void {
    try {
      const bytes = this.gb.saveState();
      this.items.push({ bytes, meta: this.getMeta() });
      if (this.items.length > this.capacity) this.items.shift();
    } catch (err) {
      console.warn("[Rewind] capture failed:", err);
    }
  }

  /** Restore the most-recent captured state and drop it from the buffer.
   *  Returns the snapshot's `meta` payload so the caller can rewind any
   *  non-engine UI state that was captured alongside. Returns `null`
   *  when the buffer is empty or a restore fails. */
  step(): { meta: M } | null {
    const entry = this.items.pop();
    if (!entry) return null;
    try {
      this.gb.loadState(entry.bytes);
      return { meta: entry.meta };
    } catch (err) {
      console.warn("[Rewind] restore failed:", err);
      return null;
    }
  }

  /** How many states are currently buffered. Useful for debug overlays. */
  get size(): number {
    return this.items.length;
  }
}
