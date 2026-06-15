/**
 * Minimal memory bus interface for the ARM7TDMI core.
 *
 * The CPU only knows about reads and writes at three widths; address
 * decoding, MMIO behaviour, wait-states, and the GBA-specific memory
 * map all live behind concrete implementations. Two concretes ship:
 * `FlatBus` (defined below) — a flat Uint8Array suitable for headless
 * instruction-level tests; and `MappedBus` in `./mapped-bus.ts` — the
 * full GBA memory map (BIOS, EWRAM, IWRAM, VRAM, OAM, palette, ROM,
 * SRAM/Flash/EEPROM, MMIO handlers, WAITCNT cycle accounting) that the
 * engine boots against.
 *
 * Little-endian byte order matches the GBA. Addresses are masked
 * inside the implementation; callers may pass either signed (`| 0`)
 * or unsigned (`>>> 0`) numbers.
 */

export interface MemoryBus {
  read32(address: number): number;
  read16(address: number): number;
  read8(address: number): number;
  write32(address: number, value: number): void;
  write16(address: number, value: number): void;
  write8(address: number, value: number): void;

  /** Raw instruction-fetch read — same data as `read32`/`read16` for
   *  byte-backed regions, but with no side effects: no watchpoint
   *  check, no cycle accounting via `chargeAccess`, no VRAM-bitmap
   *  block. The CPU's prefetch FIFO refill discards access cycles
   *  anyway (they fall outside the step's lastCycles window) and
   *  instruction fetches don't fire read watchpoints. Implementations
   *  that don't have a meaningful fast path can delegate to read*. */
  fetchWord(address: number): number;
  fetchHalfword(address: number): number;

  /** Cycles consumed by data accesses since the last `resetAccessCycles`
   *  call. The CPU resets this before each instruction's dispatch and
   *  reads it after, folding the result into `lastCycles`. Buses that
   *  don't model wait states (the test FlatBus) leave this at 0. */
  accessCycles: number;
  /** Reset the access-cycle accumulator and the "previous access
   *  address" used for sequential-access detection. Called by
   *  `ArmCpu.step` at the start of each instruction so a fresh
   *  N-cycle is charged for the first memory touch. */
  resetAccessCycles(): void;
  /** Reset ONLY the data-access tracking (not `cartBusBusyCycles`).
   *  The CPU calls this after capturing `cacheMissCost` so subsequent
   *  data accesses don't appear sequential to the prefetch reads. */
  resetDataAccessTracking(): void;
  /** Last instruction-fetch address — used by `fetchCycleCost` to
   *  detect sequential vs non-sequential fetches. ArmCpu writes this
   *  on every step and resets it to -1 on prefetch invalidation. */
  lastInstrFetchAddr: number;
  /** Real bus time of the pipeline fetches a cart cache-miss refill
   *  prepaid. The CPU's fill-credit accounting drains it from idle
   *  cycles before banking prefetcher look-ahead. Buses without a
   *  prefetch model (FlatBus) leave it at 0. */
  refillStreamDebt: number;
  /** Cycle cost of fetching one instruction at `addr` of the given
   *  width. Bus implementations that don't model wait states (FlatBus)
   *  can return 1. */
  fetchCycleCost(addr: number, width: 16 | 32): number;
  /** Cycle cost of a pipeline-refill (3 instruction fetches starting
   *  at `pc`). The CPU calls this on a cache miss after using
   *  `fetchWord`/`fetchHalfword` for the raw data — those skip
   *  `chargeAccess`, so cacheMissCost is what folds the bus timing
   *  back in. For cart-ROM regions the implementation also adds the
   *  refill's bus-busy cycles to `cartBusBusyCycles` so the step's
   *  prefetch-fill credit model stays accurate. */
  cacheMissCost(pc: number, isThumb: boolean): number;
  /** Cycles charged to the cart bus this step (cart-region data
   *  accesses tie up the bus and pause the prefetch FIFO). Buses that
   *  don't model the prefetcher leave this at 0. */
  cartBusBusyCycles: number;
  /** Credit the cart-ROM prefetch FIFO with `cycles` of free time.
   *  No-op on buses without a prefetcher. */
  addCartFillCycles(cycles: number): void;
  /** Drain the cart-ROM prefetch FIFO. Called on any non-linear PC
   *  change. No-op on buses without a prefetcher. */
  flushPrefetchFifo(): void;
  /** Charge cart-bus cycles for a DMA-dropped write to cart-ROM (the
   *  "32-bit burst" the bus cycles even though the write goes nowhere).
   *  Doesn't update the cart-bus sequentiality tracker. No-op on buses
   *  without a wait-state model. */
  addCartBusyCycles(addr: number, cycles: number): void;
}

/** A flat Uint8Array masquerading as a memory bus. Reads past the end
 *  return zeroes (the typed-array indexing already does this); writes
 *  past the end are silently dropped. Useful as a test fixture and as
 *  the eventual implementation backing each contiguous GBA memory
 *  region (BIOS, EWRAM, IWRAM, VRAM, OAM, ROM mirrors). */
export class FlatBus implements MemoryBus {
  readonly bytes: Uint8Array;
  /** No wait-state model on FlatBus — tests don't care about cycle
   *  costs. The field exists to satisfy the MemoryBus interface. */
  accessCycles = 0;
  cartBusBusyCycles = 0;
  /** Stub for the prefetch FIFO model — FlatBus reports every fetch
   *  as 1 cycle and never tracks sequentiality. */
  lastInstrFetchAddr = -1;
  refillStreamDebt = 0;

  constructor(size = 0x10000) {
    this.bytes = new Uint8Array(size);
  }

  resetAccessCycles(): void {
    this.accessCycles = 0;
    this.cartBusBusyCycles = 0;
  }

  resetDataAccessTracking(): void {
    this.accessCycles = 0;
  }

  fetchCycleCost(): number {
    return 1;
  }

  cacheMissCost(_pc: number, isThumb: boolean): number {
    // 3 instruction fetches × 1 cycle each on a flat (no-wait-state)
    // bus. ARM costs 6 cycles (3 × 2 halfwords); Thumb costs 3.
    return isThumb ? 3 : 6;
  }

  addCartFillCycles(): void {}

  flushPrefetchFifo(): void {}

  addCartBusyCycles(): void {}

  read32(address: number): number {
    // Aligns like the real bus: CPU load paths pass the RAW address
    // (the low bits only matter to MappedBus's byte-bus SRAM region);
    // the bus transaction itself is word-aligned.
    const a = (address & ~3) >>> 0;
    const b = this.bytes;
    return (b[a] ?? 0) | ((b[a + 1] ?? 0) << 8) | ((b[a + 2] ?? 0) << 16) | ((b[a + 3] ?? 0) << 24) | 0;
  }

  read16(address: number): number {
    const a = (address & ~1) >>> 0;
    const b = this.bytes;
    return (b[a] ?? 0) | ((b[a + 1] ?? 0) << 8);
  }

  fetchWord(address: number): number {
    return this.read32(address);
  }

  fetchHalfword(address: number): number {
    return this.read16(address);
  }

  read8(address: number): number {
    return this.bytes[address >>> 0] ?? 0;
  }

  write32(address: number, value: number): void {
    const a = address >>> 0;
    const v = value | 0;
    this.bytes[a] = v & 0xff;
    this.bytes[a + 1] = (v >>> 8) & 0xff;
    this.bytes[a + 2] = (v >>> 16) & 0xff;
    this.bytes[a + 3] = (v >>> 24) & 0xff;
  }

  write16(address: number, value: number): void {
    const a = address >>> 0;
    this.bytes[a] = value & 0xff;
    this.bytes[a + 1] = (value >>> 8) & 0xff;
  }

  write8(address: number, value: number): void {
    this.bytes[address >>> 0] = value & 0xff;
  }
}
