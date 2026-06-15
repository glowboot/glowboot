/**
 * Multi-region memory bus.
 *
 * Each region maps a contiguous address range either to a Uint8Array
 * (RAM/ROM) or to an `IoHandler` (MMIO). Reads of unmapped byte
 * regions return zero; writes to unmapped or read-only byte regions
 * are silently dropped. The I/O space (0x04000400+) and the gaps in
 * BIOS / above-ROM windows route to an `IoOpenBusHandler` wired to
 * `ArmCpu.currentOpenBus`, so reads there return the CPU's prefetched
 * opcode at PC+8 — matching real ARM7TDMI. Write-only MMIO slots
 * (FIFO_A/B, DMA SAD/DAD/CNT_L, write-only PPU registers) plumb the
 * same open-bus source through their own handlers.
 *
 * Byte regions expose their backing Uint8Array via `addRegion` so
 * tests can pre-load ROM bytes directly without going through the
 * read-only-respecting bus interface.
 */

import { Apu } from "../apu/apu.js";
import { TiltSensor } from "../cartridge/accelerometer.js";
import { type BackupSpec, EepromBackup, FlashBackup, OpenBusBackup, SramBackup } from "../cartridge/backup.js";
import type { GbaCartGpio } from "../cartridge/gpio.js";
import { checkGbaRead, checkGbaWrite } from "../debug/breakpoints.js";
import { Joypad } from "../joypad/joypad.js";
import { Ppu } from "../ppu/ppu.js";
import { Sio } from "../sio/sio.js";
import { Timer } from "../timer/timer.js";
import type { MemoryBus } from "./bus.js";
import { Dma } from "./dma.js";
import { InterruptController, IRQ_HBLANK, IRQ_VBLANK, IRQ_VCOUNT } from "./interrupts.js";

/** Handler interface for MMIO regions. Width is significant — each
 *  register may have side effects on read, and 16-bit registers must
 *  be reachable as a single bus transaction rather than two byte
 *  reads. */
export interface IoHandler {
  read8(offset: number): number;
  read16(offset: number): number;
  read32(offset: number): number;
  write8(offset: number, value: number): void;
  write16(offset: number, value: number): void;
  write32(offset: number, value: number): void;
}

/** Wraps a peripheral's IoHandler so every register access first fires
 *  the bus's `onPeripheralAccess` hook. `Gba.runFrame` batches timer /
 *  APU / SIO ticks between observable events instead of ticking once
 *  per instruction; the hook drains that pending-cycle backlog so a
 *  register read observes exactly the state it would have seen under
 *  per-instruction ticking, and a register write applies to caught-up
 *  state. Only the handlers whose registers expose batched state are
 *  wrapped (APU / SIO / DMA / timer / interrupt controller) — PPU and
 *  joypad registers stay on the unwrapped fast path. */
class PeripheralAccessNotifier implements IoHandler {
  constructor(
    private readonly bus: MappedBus,
    private readonly inner: IoHandler
  ) {}
  read8(offset: number): number {
    this.bus.onPeripheralAccess?.();
    return this.inner.read8(offset);
  }
  read16(offset: number): number {
    this.bus.onPeripheralAccess?.();
    return this.inner.read16(offset);
  }
  read32(offset: number): number {
    this.bus.onPeripheralAccess?.();
    return this.inner.read32(offset);
  }
  write8(offset: number, value: number): void {
    this.bus.onPeripheralAccess?.();
    this.inner.write8(offset, value);
  }
  write16(offset: number, value: number): void {
    this.bus.onPeripheralAccess?.();
    this.inner.write16(offset, value);
  }
  write32(offset: number, value: number): void {
    this.bus.onPeripheralAccess?.();
    this.inner.write32(offset, value);
  }
}

/** How a region handles 8-bit writes.
 *
 *  - `normal`: store the byte as-is (RAM default).
 *  - `ignored`: silently drop (OAM; OBJ-VRAM in tile modes).
 *  - `duplicate`: write the byte into BOTH bytes of the containing
 *    halfword (palette RAM; BG-VRAM). The GBA's 16-bit memory bus
 *    has no narrow-write strobe for these regions — STRB widens to
 *    a 16-bit transaction with the byte mirrored across both lanes.
 *  - `vram-split`: BG / OBJ split — offsets below the OBJ boundary
 *    behave as `duplicate`, offsets at or above it behave as `ignored`.
 *    The boundary is DISPCNT-mode-aware (read via `vramBgModeProvider`):
 *    0x10000 in tile modes 0-2, 0x14000 in bitmap modes 3-5 — bitmap
 *    modes shrink the BG range so the rendered framebuffer in the
 *    upper 80 KiB of BG-VRAM still gets the byte-duplicate widening
 *    on STRB. */
type ByteWriteMode = "normal" | "ignored" | "duplicate" | "vram-split";

interface BytesBacking {
  kind: "bytes";
  bytes: Uint8Array;
  readOnly: boolean;
  byteWriteMode: ByteWriteMode;
}

interface HandlerBacking {
  kind: "handler";
  handler: IoHandler;
}

type Backing = BytesBacking | HandlerBacking;

interface Region {
  start: number;
  end: number;
  /** True for the 8-bit cart-RAM bus at 0x0E000000 — the only region
   *  whose chip decodes the full (unaligned) address. read16/read32
   *  forward the address low bits to the handler for these regions
   *  and strip them everywhere else. */
  byteBus?: boolean;
  /** Effective region size for offset modulo. Equals `end - start`
   *  for plain regions; smaller than that when the region mirrors
   *  itself across a larger address window (IWRAM, EWRAM, palette,
   *  OAM all mirror on real hardware). */
  size: number;
  /** Inner mirror granularity. Equals `size` for plain power-of-two
   *  regions. For VRAM the unit is 128 KiB but the physical storage
   *  is 96 KiB — the upper 32 KiB folds back into the second 16 KiB
   *  of OBJ VRAM, so we mod by `mirrorUnit` first then subtract
   *  `mirrorUnit - size` from offsets past the physical end. */
  mirrorUnit: number;
  backing: Backing;
}

/** WAITCNT-decoded first-access cycle counts. Per GBATEK: WS_N
 *  encodes the *wait* cycles (4/3/2/8), but the actual access also
 *  consumes 1 base cycle, so the total is 1+wait. nba-hw-test
 *  bus/128kb-boundary verifies this: cart-ROM LDM cycle counts come
 *  out 8 short on a 4-word LDM without the +1 base (1 short per
 *  halfword × 4 32-bit words × 2 halfwords each = 8 cycles missing).
 *  Bits 2-3 / 5-6 / 8-9 = WS0/WS1/WS2 first access. Bits 0-1 = SRAM. */
const FIRST_ACCESS_TABLE = [5, 4, 3, 9] as const;
/** WAITCNT bits 4 / 7 / 10 → WS0/WS1/WS2 second-access cycle counts
 *  (1 + GBATEK wait cycles, same logic as above). */
const WS0_S_TABLE = [3, 2] as const;
const WS1_S_TABLE = [5, 2] as const;
const WS2_S_TABLE = [9, 2] as const;
/** WAITCNT bit 14 — game-pak prefetch buffer enable. The bus drives a
 *  prefetch-FIFO model off this bit: when set, sequential cart-ROM
 *  fetches consume from the FIFO at 1 cycle each (filled in proportion
 *  to idle cart-bus time via `addCartFillCycles`); when clear, every
 *  fetch pays full WS_S/WS_N. Toggling the bit flushes the FIFO. */
const WAITCNT_PREFETCH = 1 << 14;

/** Per-region 16-bit access cycle costs (N = first access, S =
 *  sequential subsequent access). Indexed by `addr >> 24`. Filled
 *  at boot from WAITCNT 0x0000 (the hardware reset default — all
 *  WS slots at 4 cycles) and rebuilt each time the cart code writes
 *  WAITCNT. 32-bit accesses fold N + S since the GBA's 16-bit cart
 *  bus splits a word into two halfword fetches. Internal regions
 *  with 32-bit buses (BIOS / IWRAM / I/O / OAM) report 1 cycle
 *  regardless of WAITCNT. */
const REGION_N_CYCLES_16 = new Int8Array(16);
const REGION_S_CYCLES_16 = new Int8Array(16);
/** Extra cycles a 32-bit access pays beyond the 16-bit cost (the
 *  second halfword fetch). Rebuilt alongside the N/S tables. */
const REGION_S_BONUS_32 = new Int8Array(16);

/** Fixed cycle costs for the internal-bus regions (BIOS/IWRAM/etc.).
 *  WAITCNT writes leave these alone. */
const INTERNAL_N: Record<number, number> = { 0: 1, 1: 1, 2: 3, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 };
const INTERNAL_S: Record<number, number> = { 0: 1, 1: 1, 2: 3, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 };
const INTERNAL_BONUS: Record<number, number> = { 2: 3, 5: 1, 6: 1 };

function applyWaitcnt(value: number): void {
  const v = value & 0xffff;
  const ws0First = FIRST_ACCESS_TABLE[(v >>> 2) & 3]!;
  const ws0Second = WS0_S_TABLE[(v >>> 4) & 1]!;
  const ws1First = FIRST_ACCESS_TABLE[(v >>> 5) & 3]!;
  const ws1Second = WS1_S_TABLE[(v >>> 7) & 1]!;
  const ws2First = FIRST_ACCESS_TABLE[(v >>> 8) & 3]!;
  const ws2Second = WS2_S_TABLE[(v >>> 10) & 1]!;
  const sram = FIRST_ACCESS_TABLE[v & 3]!;
  for (let r = 0; r < 16; r++) {
    if (r <= 7) {
      // Internal regions — fixed cycle costs.
      REGION_N_CYCLES_16[r] = INTERNAL_N[r] ?? 1;
      REGION_S_CYCLES_16[r] = INTERNAL_S[r] ?? 1;
      REGION_S_BONUS_32[r] = INTERNAL_BONUS[r] ?? 0;
    } else if (r === 8 || r === 9) {
      REGION_N_CYCLES_16[r] = ws0First;
      REGION_S_CYCLES_16[r] = ws0Second;
      REGION_S_BONUS_32[r] = ws0Second;
    } else if (r === 0xa || r === 0xb) {
      REGION_N_CYCLES_16[r] = ws1First;
      REGION_S_CYCLES_16[r] = ws1Second;
      REGION_S_BONUS_32[r] = ws1Second;
    } else if (r === 0xc || r === 0xd) {
      REGION_N_CYCLES_16[r] = ws2First;
      REGION_S_CYCLES_16[r] = ws2Second;
      REGION_S_BONUS_32[r] = ws2Second;
    } else {
      // 0xE / 0xF — SRAM / cart-RAM. 8-bit bus; the same wait-state
      // applies to N and S, and 16/32-bit accesses are still served
      // one byte at a time (we still model it as one charged cycle).
      REGION_N_CYCLES_16[r] = sram;
      REGION_S_CYCLES_16[r] = sram;
      REGION_S_BONUS_32[r] = sram;
    }
  }
}

// Seed to the hardware reset default (WAITCNT = 0x0000 → all WS slots
// = 4 cycles). The Nintendo BIOS reprograms this to 0x4317 during
// boot; cart code can change it again at runtime.
applyWaitcnt(0x0000);

/** Game-Pak Prefetch Buffer depth on real ARM7TDMI. The chip holds
 *  up to 8 halfwords prefetched ahead of the executing instruction. */
const PREFETCH_FIFO_DEPTH = 8;

export class MappedBus implements MemoryBus {
  private readonly regions: Region[] = [];
  /** Top-nibble index for `resolve()`. Every CPU step does at least
   *  one memory access through `resolve`, and LDR/STR add data
   *  accesses. The legacy linear scan checked every region per call;
   *  a 16-bucket lookup keyed by `addr >>> 24` collapses that to one
   *  or two compares for the common nibble (one region per top nibble
   *  for RAM/ROM/VRAM/etc). Profiling Dead to Rights showed `resolve`
   *  at 4.5% of total time + `read32` at 17.3% before this change. */
  private readonly regionsByNibble: Region[][] = Array.from({ length: 16 }, () => []);
  /** Cycle-cost accumulator + previous-access tracker. Reset at the
   *  start of each instruction's dispatch via `resetAccessCycles`. */
  accessCycles = 0;
  private prevAccessAddr = -1;
  private prevAccessRegion = -1;
  /** Cart bus (regions 8-D) keeps its own sequentiality tracker
   *  independent of the internal bus. Real GBA: the cart bus and
   *  internal bus run in parallel, so a DMA that reads cart-ROM and
   *  writes IWRAM doesn't break the cart bus's sequential stream — the
   *  next cart read still sees the previous cart access as its
   *  predecessor. nba-hw-test bus/128kb-boundary's DMA INC/DEC
   *  cases pin this: the cycle counts assume sequential cart reads
   *  across the DMA's interleaved read/write pattern. */
  private prevCartAddr = -1;
  /** Cycles charged to the cart bus this step. When the cart bus is
   *  busy with a data access, the prefetcher pauses; non-cart data
   *  accesses leave the cart bus free, so they count as fill credit.
   *  Used by ArmCpu.step to compute how many cycles the prefetcher
   *  had available for FIFO fill since the previous cart instr fetch. */
  cartBusBusyCycles = 0;
  /** Game-Pak Prefetch Buffer enable state — mirrors WAITCNT bit 14. */
  prefetchEnabled = false;
  /** Halfwords currently in the prefetch FIFO (0..PREFETCH_FIFO_DEPTH).
   *  Each `addCartFillCycles` adds halfwords at WS_S/halfword. Each
   *  sequential cart instr fetch consumes halfwords (1 for Thumb, 2
   *  for ARM). Non-sequential fetches drain the FIFO. */
  prefetchCount = 0;
  /** Address of the next halfword to be consumed from the FIFO. After
   *  each consumed halfword this advances by 2. Used to detect FIFO
   *  hit (`prefetchNextAddr === addr` on a fetch) vs miss. */
  prefetchNextAddr = -1;
  /** Cart-fill cycle credit modulo WS_S — leftover cycles from previous
   *  step that didn't add a full halfword yet. Carried forward. */
  private prefetchCreditRemainder = 0;
  /** WS_S cycles for the cart region the prefetcher is currently
   *  reading from. Cached so we don't have to look up every call. */
  private prefetchHalfwordCost = 1;
  /** Last instruction-fetch address used by `fetchCycleCost` to detect
   *  sequential vs non-sequential cart fetches. ArmCpu invalidates
   *  this (to -1) whenever the prefetch FIFO is flushed (branches,
   *  exception entry, etc.). */
  lastInstrFetchAddr = -1;
  /** True while a DMA channel is mid-transfer. When set, cart-bus
   *  accesses bypass the contiguous-address sequentiality heuristic and
   *  are forced sequential after the first one — matching the GBATEK
   *  DMA formula `2N + 2(n-1)S` which signals N once at burst start
   *  then S on every subsequent transfer, regardless of address
   *  direction (INC/DEC). The 128KB boundary force-N rule still
   *  applies as an override. */
  dmaActive = false;
  /** True until the first cart access in the current DMA burst is
   *  charged (then `chargeAccess` flips it to false). Reset to true by
   *  the DMA on each new burst. */
  dmaFirstCartAccess = false;
  /** Cart-side GPIO controller. Set by the Gba constructor when the
   *  loaded cart needs the four GPIO pins (rumble, RTC, solar
   *  sensor — any combination); null for all other carts. The bus
   *  intercepts reads + writes at `0x080000C4` / `0xC6` / `0xC8`
   *  before the cart-ROM read-only region claims them and routes the
   *  access through this controller's feature plugins. Reads only
   *  go to the controller when its read-enable register has been set
   *  by the cart; otherwise reads fall through to the cart-ROM bytes
   *  at those addresses. */
  cartGpio: GbaCartGpio | null = null;
  /** Cart-side tilt sensor (Yoshi Topsy-Turvy, Koro Koro Puzzle). Wired
   *  here so the bus can intercept byte reads/writes at the six active
   *  SRAM-region slots (`0x0E008000` / `0x0E008100` / `0x0E008200` /
   *  `0x0E008300` / `0x0E008400` / `0x0E008500`) before the cart-RAM
   *  backup handler claims them. Null for all other carts. */
  cartTilt: TiltSensor | null = null;
  /** Real bus time of the two prepaid pipeline fetches from the most
   *  recent cart cache-miss refill — consumed by subsequent steps'
   *  idle cycles before FIFO fill credit accrues. */
  refillStreamDebt = 0;

  /** Fired before any access to a wrapped peripheral handler (see
   *  `PeripheralAccessNotifier`). Set by the Gba constructor to drain
   *  the batched peripheral-tick backlog. */
  onPeripheralAccess: (() => void) | null = null;
  /** Set when the most recent cart-bus bank entry landed at a 128 KiB
   *  boundary address (low 17 bits == 0). Used to gate the backward-
   *  cross +2 penalty: real HW only penalises a backward cross out of a
   *  bank that was entered AT its boundary. Forward crosses (entry at
   *  boundary) and backward crosses (exit from a bank previously
   *  entered at boundary) each get +2; backward exits from
   *  mid-bank-entered banks get nothing. Verified by nba-bus-128kb-
   *  boundary's DMA DEC 0801FFF0 (cross, +2) vs DMA DEC 0801FFF8
   *  (cross at iter 4, no +2 — bank entered mid-bank at 08020008). */
  prevCartBankEnteredAtBoundary = false;

  /** Provides the current BG mode (low 3 bits of DISPCNT). Used to
   *  gate the bitmap-mode VRAM mirror rule: in modes 3-5 reads from
   *  0x06018000-0x0601BFFF return 0 and writes are dropped, because
   *  that range mirrors the first 16 KiB of BG VRAM which the OBJ
   *  engine can't reach in bitmap modes (verified by nba-hw-test
   *  ppu/vram-mirror). Set by the bus builder after PPU construction.
   *  Default returns 0 (tile mode → no blocking) so unit tests that
   *  spin up a bare MappedBus stay correct. */
  vramBgModeProvider: () => number = () => 0;

  /** True when the address falls in the bitmap-mode-blocked VRAM
   *  mirror sub-range AND the PPU is currently in a bitmap mode. */
  private isVramBitmapBlocked(addr: number): boolean {
    if (addr >>> 24 !== 0x06) return false;
    const off = addr & 0x1ffff;
    if (off < 0x18000 || off >= 0x1c000) return false;
    const mode = this.vramBgModeProvider() & 0x7;
    return mode >= 3 && mode <= 5;
  }

  /** Cycle cost of fetching one instruction at `addr` of width `width`.
   *
   *  Internal regions cost 1 cycle (the prefetch is part of the CPU
   *  pipeline). Cart-ROM regions consult the prefetch FIFO state:
   *  every halfword still in the FIFO at fetch time costs 1 cycle
   *  (just the bus transfer from the prefetch latch to the CPU); any
   *  halfword that hasn't been prefetched yet costs the cart's WS_S
   *  (or WS_N for the first halfword of a non-sequential fetch).
   *
   *  As a side effect this method advances the FIFO state: consumed
   *  halfwords are removed, `prefetchNextAddr` advances, and the new
   *  halfword cost gets cached for subsequent fill-credit conversion. */
  fetchCycleCost(addr: number, width: 16 | 32): number {
    const region = (addr >>> 24) & 0xf;
    if (region < 8) {
      // Internal regions have no prefetch FIFO, but they're not all
      // 1-cycle: EWRAM sits on a 16-bit 3-wait bus, so a Thumb fetch
      // costs 3 and an ARM fetch 6 (two halfwords) — the same
      // table-based math cacheMissCost uses. IWRAM/BIOS/IO keep their
      // 1-cycle fetches (bonus 0). nba-hw-test irq-delay's EWRAM row
      // measures the ~20-cycle gap the flat `return 1` used to hide.
      const ws = REGION_S_CYCLES_16[region] ?? 1;
      const bonus = width === 32 ? (REGION_S_BONUS_32[region] ?? 0) : 0;
      return ws + bonus;
    }
    const halfwordsNeeded = width >>> 4; // 1 for Thumb, 2 for ARM
    const wsS = REGION_S_CYCLES_16[region] ?? 1;
    const wsN = REGION_N_CYCLES_16[region] ?? 1;
    // Sequential vs non-sequential to the previous instr fetch.
    const seq = addr === ((this.lastInstrFetchAddr + (width >>> 3)) | 0);
    // Hardware model, pinned per-row by mgba-suite timing's WAITCNT /
    // prefetch matrix: linear cart execution runs at the CART BUS
    // rate — every sequential halfword the FIFO doesn't already hold
    // costs WS_S, in BOTH prefetch modes (an ARM nop is S+S, a Thumb
    // nop is S). The prefetcher only gets AHEAD during cycles the
    // cart bus is idle (non-cart data accesses, internal cycles —
    // credited at step end via addCartFillCycles); halfwords it
    // banked that way cost 1 cycle each. A non-sequential fetch
    // (branch) flushes the FIFO and pays WS_N for its first halfword.
    let cost: number;
    if (seq) {
      const fromFifo = this.prefetchEnabled ? Math.min(this.prefetchCount, halfwordsNeeded) : 0;
      this.prefetchCount -= fromFifo;
      const missed = halfwordsNeeded - fromFifo;
      cost = fromFifo + missed * wsS;
      // FIFO-hit halfwords are a latch handoff — the cart bus stays
      // free for the prefetcher; demand-fetched halfwords tie it up.
      this.cartBusBusyCycles += cost - fromFifo;
      // A demand fetch consumes the prefetcher's in-flight progress.
      if (missed > 0) this.prefetchCreditRemainder = 0;
    } else {
      this.prefetchCount = 0;
      this.prefetchCreditRemainder = 0;
      cost = wsN + (halfwordsNeeded - 1) * wsS;
      this.cartBusBusyCycles += cost;
    }
    this.prefetchNextAddr = (addr + halfwordsNeeded * 2) | 0;
    this.prefetchHalfwordCost = wsS;
    return cost;
  }

  /** Notification from the CPU after a step completes: the prefetcher
   *  had `cycles` of free cart-bus time during the step. Convert to
   *  FIFO halfwords (carrying remainder forward) and cap at the
   *  hardware FIFO depth. Called by `ArmCpu.step`. */
  addCartFillCycles(cycles: number): void {
    if (!this.prefetchEnabled || cycles <= 0) return;
    if (this.prefetchHalfwordCost <= 0) return;
    const total = this.prefetchCreditRemainder + cycles;
    const halfwords = (total / this.prefetchHalfwordCost) | 0;
    this.prefetchCreditRemainder = total - halfwords * this.prefetchHalfwordCost;
    if (halfwords > 0) {
      this.prefetchCount = Math.min(this.prefetchCount + halfwords, PREFETCH_FIFO_DEPTH);
    }
  }

  /** Drain the prefetch FIFO — call this on any non-linear PC change
   *  (branch, exception, mode switch, PC-as-Rd). The next cart instr
   *  fetch will pay WS_N for the first halfword. */
  flushPrefetchFifo(): void {
    this.prefetchCount = 0;
    this.prefetchNextAddr = -1;
    this.prefetchCreditRemainder = 0;
  }

  resetAccessCycles(): void {
    this.accessCycles = 0;
    this.cartBusBusyCycles = 0;
    this.prevAccessAddr = -1;
    this.prevAccessRegion = -1;
    this.prevCartAddr = -1;
  }

  /** Charge `cycles` to the cart bus without going through `chargeAccess`
   *  — used by DMA-to-cart-RO dropped writes where real silicon still
   *  cycles the cart bus for the 32-bit burst but doesn't actually
   *  read/write anything, so the cart-bus sequentiality tracker should
   *  stay where it was. The caller passes the address purely for
   *  symmetry; only the cycle count is consumed. */
  addCartBusyCycles(_addr: number, cycles: number): void {
    this.accessCycles += cycles;
    this.cartBusBusyCycles += cycles;
  }

  /** Reset only the data-access tracking (`accessCycles` +
   *  prev-access registers) — used by the CPU after capturing
   *  `cacheMissCost` so the instruction's data accesses don't appear
   *  sequential to the prefetch reads. Leaves `cartBusBusyCycles`
   *  alone so the cache-miss fetches stay counted as cart-bus busy
   *  for the step. */
  resetDataAccessTracking(): void {
    this.accessCycles = 0;
    this.prevAccessAddr = -1;
    this.prevAccessRegion = -1;
    this.prevCartAddr = -1;
  }

  /** Apply a new WAITCNT value, rebuilding the per-region N/S cycle
   *  tables for the cart-ROM windows (WS0/WS1/WS2) and SRAM. The
   *  internal-bus regions (BIOS / EWRAM / IWRAM / I/O / palette /
   *  VRAM / OAM) keep their fixed costs regardless. The interrupt
   *  controller calls this from its write16 path on every WAITCNT
   *  store so cart code that re-tunes wait states for tight loops
   *  takes effect immediately. */
  setWaitcnt(value: number): void {
    applyWaitcnt(value);
    const wasEnabled = this.prefetchEnabled;
    this.prefetchEnabled = (value & WAITCNT_PREFETCH) !== 0;
    // Disabling the prefetcher drains the FIFO; enabling it from cold
    // starts with an empty FIFO too. Either way reset state.
    if (wasEnabled !== this.prefetchEnabled) this.flushPrefetchFifo();
  }

  /** Charge bus cycles for an access WITHOUT moving data. The DMA
   *  controller uses this for cart-region sources with a non-increment
   *  src control: the cart chip serves data from its auto-incrementing
   *  counter, but the DMA's internal address register follows the
   *  programmed direction — and the 128 KiB bank-boundary penalties
   *  key off the internal address (nba-hw-test bus/128kb-boundary's
   *  DMA DEC rows differ from the INC rows at the same address). */
  chargeDmaAccess(addr: number, width: 16 | 32): void {
    this.chargeAccess(addr, width);
  }

  private chargeAccess(addr: number, width: 8 | 16 | 32): void {
    const region = (addr >>> 24) & 0xf;
    const isCart = region >= 8 && region <= 0xd;
    // Sequential = address = last+width (in bytes) on the SAME bus.
    // Cart-region accesses (8-D) check against the cart-bus's own prev,
    // since the cart bus runs in parallel with the internal bus; an
    // internal access between two cart accesses doesn't break the
    // cart-bus sequential stream. Non-cart accesses use the
    // general-purpose prev tracker.
    //
    // The WS0/WS1/WS2 cart bus only decodes 17 address bits, so
    // crossing the 128 KiB boundary forces a non-sequential access
    // even when addresses are otherwise contiguous (verified by
    // nba-hw-test bus/128kb-boundary's LDM/DMA-at-0x0801FFF8).
    let isSequential: boolean;
    if (isCart) {
      if (this.dmaActive) {
        // Real DMA signals N for the first access of a burst and S for
        // all subsequent transfers (GBATEK DMA-Transfer-Times formula
        // `2N + 2(n-1)S`), independent of source-address direction. The
        // contiguous-address heuristic used for CPU accesses
        // misclassifies the DEC case's between-word halfword
        // transitions as N — overcounting cycles. nba-bus/128kb-boundary
        // DEC subtests verify the S-after-first behaviour.
        isSequential = !this.dmaFirstCartAccess;
        this.dmaFirstCartAccess = false;
      } else {
        isSequential = addr === ((this.prevCartAddr + (width >>> 3)) | 0);
      }
      // 128 KiB cart-bus address-line wrap. The cart bus has only 17
      // address lines; transitions between 128 KiB banks need the
      // address line to be re-asserted, which costs an extra N cycle.
      // The penalty fires asymmetrically:
      //   - Forward cross (entering new bank at boundary, low17=0):
      //     fire. INC DMAs hit this when their address rolls over.
      //   - Backward cross (exiting a bank entered at its boundary):
      //     fire. DEC DMAs hit this when the source's first access was
      //     at a boundary address.
      //   - Backward cross from a bank entered mid-bank: no fire (the
      //     cart bus didn't need a fresh address-line assertion to
      //     enter that bank, so it doesn't need one to leave either).
      // Verified by nba-bus-128kb-boundary DEC 0801FFF0 (+2, fires) vs
      // DEC 0801FFF8 (no +2, no fire).
      const prevBank = this.prevCartAddr >>> 17;
      const currBank = addr >>> 17;
      const prevRegion = (this.prevCartAddr >>> 24) & 0xf;
      const prevWasCart = this.prevCartAddr >= 0 && prevRegion >= 8 && prevRegion <= 0xd;
      const bankChanged = prevWasCart && prevBank !== currBank;
      const atBoundary = (addr & 0x1ffff) === 0;
      if (isSequential && bankChanged) {
        if (currBank > prevBank && atBoundary) isSequential = false;
        else if (currBank < prevBank && this.prevCartBankEnteredAtBoundary) isSequential = false;
      }
      // Update the bank-entry-boundary tracker: changes on bank entry.
      if (!prevWasCart || bankChanged) {
        this.prevCartBankEnteredAtBoundary = atBoundary;
      }
    } else {
      isSequential = region === this.prevAccessRegion && addr === ((this.prevAccessAddr + (width >>> 3)) | 0);
    }
    const halfCycles = isSequential ? (REGION_S_CYCLES_16[region] ?? 1) : (REGION_N_CYCLES_16[region] ?? 1);
    const bonus = width === 32 ? (REGION_S_BONUS_32[region] ?? 0) : 0;
    const cycles = halfCycles + bonus;
    this.accessCycles += cycles;
    // Cart-data accesses tie up the cart bus, pausing the prefetcher.
    // Track them so the CPU can subtract them from the step's free-time
    // budget when crediting the FIFO after the step.
    if (isCart) {
      this.cartBusBusyCycles += cycles;
      this.prevCartAddr = addr | 0;
    }
    this.prevAccessAddr = addr | 0;
    this.prevAccessRegion = region;
  }

  /** Index a region into `regionsByNibble` for fast lookup by top
   *  nibble. Region may span multiple nibbles (e.g. cart ROM with a
   *  32 MB mirror covers nibbles 0x8 and 0x9); add it to every bucket
   *  it overlaps. Order preserved per nibble so first-match semantics
   *  match the legacy linear scan. */
  private indexRegion(r: Region): void {
    const firstNibble = (r.start >>> 24) & 0xf;
    const lastNibble = ((r.end - 1) >>> 24) & 0xf;
    for (let n = firstNibble; n <= lastNibble; n++) this.regionsByNibble[n]!.push(r);
  }

  /** Add a byte-backed region. `size` is the underlying storage; the
   *  optional `mirrorWindow` makes the region visible across a larger
   *  address window (e.g. IWRAM is 32 KB at 0x03000000 but mirrors
   *  every 32 KB across the full 16 MB region 0x03000000-0x03FFFFFF).
   *  `mirrorUnit` (defaults to `size`) is the inner mirror granularity
   *  used for non-power-of-two regions like VRAM (96 KiB stored in a
   *  128 KiB unit, with the tail folded). */
  addRegion(
    start: number,
    size: number,
    options: { readOnly?: boolean; mirrorWindow?: number; mirrorUnit?: number; byteWriteMode?: ByteWriteMode } = {}
  ): Uint8Array {
    const bytes = new Uint8Array(size);
    const windowSize = options.mirrorWindow ?? size;
    const region: Region = {
      start: start >>> 0,
      end: (start + windowSize) >>> 0,
      size,
      mirrorUnit: options.mirrorUnit ?? size,
      backing: {
        kind: "bytes",
        bytes,
        readOnly: options.readOnly ?? false,
        byteWriteMode: options.byteWriteMode ?? "normal"
      }
    };
    this.regions.push(region);
    this.indexRegion(region);
    return bytes;
  }

  /** Add a second mapping that points at an existing region's backing
   *  array. Used for the cart-ROM wait-state mirrors at 0x0A000000
   *  (WS1) and 0x0C000000 (WS2): all three windows decode to the same
   *  physical ROM, only the bus timings differ. */
  addRegionAlias(
    start: number,
    bytes: Uint8Array,
    options: { readOnly?: boolean; mirrorWindow?: number; mirrorUnit?: number; byteWriteMode?: ByteWriteMode } = {}
  ): void {
    const windowSize = options.mirrorWindow ?? bytes.length;
    const region: Region = {
      start: start >>> 0,
      end: (start + windowSize) >>> 0,
      size: bytes.length,
      mirrorUnit: options.mirrorUnit ?? bytes.length,
      backing: {
        kind: "bytes",
        bytes,
        readOnly: options.readOnly ?? false,
        byteWriteMode: options.byteWriteMode ?? "normal"
      }
    };
    this.regions.push(region);
    this.indexRegion(region);
  }

  addHandler(start: number, size: number, handler: IoHandler, byteBus = false): void {
    const region: Region = {
      start: start >>> 0,
      end: (start + size) >>> 0,
      size,
      mirrorUnit: size,
      byteBus,
      backing: { kind: "handler", handler }
    };
    this.regions.push(region);
    this.indexRegion(region);
  }

  /** Output slots for `resolve()`. Returning a `{ region, offset }`
   *  object allocated ~500 k objects per frame on a busy cart (every
   *  CPU memory access calls resolve). Writing into instance fields
   *  instead keeps the API ergonomically the same — callers read
   *  `resolveRegion` / `resolveOffset` immediately after — while
   *  eliminating the per-access GC pressure. */
  private resolveRegion: Region | null = null;
  private resolveOffset = 0;

  private resolve(address: number): boolean {
    const a = address >>> 0;
    const bucket = this.regionsByNibble[(a >>> 24) & 0xf]!;
    for (let i = 0; i < bucket.length; i++) {
      const r = bucket[i]!;
      if (a >= r.start && a < r.end) {
        // Modulo wrap for mirrored byte regions; identity for plain
        // ones (where size === end-start). When mirrorUnit != size
        // (VRAM), wrap by mirrorUnit then fold the tail back into the
        // physical storage.
        let off = (a - r.start) % r.mirrorUnit;
        if (off >= r.size) off -= r.mirrorUnit - r.size;
        this.resolveRegion = r;
        this.resolveOffset = off;
        return true;
      }
    }
    return false;
  }

  read8(address: number): number {
    const addr = address >>> 0;
    checkGbaRead(addr);
    this.chargeAccess(addr, 8);
    if (this.isVramBitmapBlocked(addr)) return 0;
    // GPIO byte read — same gating as read16. The GPIO halfword is
    // 4-bit-valued so the high byte at C5/C7/C9 reads as 0.
    if (this.cartGpio !== null && this.cartGpio.readEnable && addr >= 0x080000c4 && addr <= 0x080000c9) {
      const half = this.cartGpio.read(addr & ~1);
      return (addr & 1) === 0 ? half & 0xff : (half >>> 8) & 0xff;
    }
    // Tilt-sensor byte intercept — Yoshi-family carts wire the ADXL202E
    // onto the 8-bit cart-RAM bus at six fixed slots in the SRAM
    // window. Sits before the backup handler so the sensor wins over
    // the open-bus / SRAM fall-through for those exact addresses.
    if (this.cartTilt !== null && TiltSensor.covers(addr)) {
      return this.cartTilt.read8(addr) & 0xff;
    }
    if (!this.resolve(addr)) return 0;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") return region.backing.handler.read8(off);
    return region.backing.bytes[off]!;
  }

  read16(address: number): number {
    // Normalize to the bus-transaction address: the GBA's 16-bit bus
    // ignores bit 0 for the transfer itself (CPU loads pass the RAW
    // address; rotation happens in the load path). Watchpoints, cycle
    // charging, and region resolution all see the aligned address —
    // identical to when callers pre-aligned. Only the 8-bit cart-RAM
    // bus (`byteBus` regions) sees the low bit: SRAM decodes the full
    // address, so an unaligned load reads the byte AT that address
    // replicated across the lanes (mgba-suite memory "SRAM load
    // unaligned").
    const rawAddr = address >>> 0;
    const addr = (rawAddr & ~1) >>> 0;
    checkGbaRead(addr);
    this.chargeAccess(addr, 16);
    if (this.isVramBitmapBlocked(addr)) return 0;
    // GPIO register intercept — only when the cart has enabled
    // GPIO reads. With read-enable off the cart-ROM bytes win.
    if (this.cartGpio !== null && this.cartGpio.readEnable && addr >= 0x080000c4 && addr <= 0x080000c9) {
      return this.cartGpio.read(addr) & 0xffff;
    }
    if (!this.resolve(addr)) return 0;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") {
      return region.backing.handler.read16(region.byteBus ? off | (rawAddr & 1) : off);
    }
    // The GBA bus only exchanges aligned halfwords — the LSB of the
    // address is consumed by the CPU's barrel-shifter for LDRH rotation
    // and never reaches the byte storage. Match write16's alignment.
    const b = region.backing.bytes;
    return b[off]! | (b[off + 1]! << 8);
  }

  read32(address: number): number {
    // Same normalization as read16 — bit 1:0 stripped for the bus
    // transaction, forwarded only to byte-bus (cart-RAM) regions.
    const rawAddr = address >>> 0;
    const addr = (rawAddr & ~3) >>> 0;
    checkGbaRead(addr);
    this.chargeAccess(addr, 32);
    if (this.isVramBitmapBlocked(addr)) return 0;
    // GPIO word read — joins two halfwords. Cart writes that span
    // GPIO + cart-ROM (an LDR at 0x080000C6 takes 0xC6 + 0xC8) need
    // both halves; the high half at 0xCA isn't a GPIO register, so
    // it falls through to cart-ROM via a separate read16 fetch.
    if (this.cartGpio !== null && this.cartGpio.readEnable && addr >= 0x080000c4 && addr <= 0x080000c8) {
      const lo = this.cartGpio.read(addr) & 0xffff;
      const hiAddr = addr + 2;
      const hi = hiAddr <= 0x080000c8 ? this.cartGpio.read(hiAddr) & 0xffff : this.read16(hiAddr) & 0xffff;
      return lo | (hi << 16) | 0;
    }
    if (!this.resolve(addr)) return 0;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") {
      return region.backing.handler.read32(region.byteBus ? off | (rawAddr & 3) : off) | 0;
    }
    // 32-bit bus reads are physically aligned; the address LSBs feed the
    // CPU's barrel-shifter for LDR's ROR-on-unaligned. Match write32.
    const b = region.backing.bytes;
    return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24) | 0;
  }

  /** Raw instruction fetch — no watchpoint, no cycle accounting, no
   *  bitmap-VRAM gate. The CPU's prefetch refill calls this on the
   *  hot path; the linear-PC-advance fetch's access cycles are reset
   *  by the next step's `resetAccessCycles` so charging them here is
   *  pure overhead. Handlers (MMIO) still go through the real reader
   *  in case cart code somehow executes from MMIO (real hardware
   *  returns open-bus garbage but we honour the handler's read32). */
  fetchWord(address: number): number {
    const addr = address >>> 0;
    if (!this.resolve(addr)) return 0;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") return region.backing.handler.read32(off) | 0;
    const aligned = off & ~3;
    const b = region.backing.bytes;
    return b[aligned]! | (b[aligned + 1]! << 8) | (b[aligned + 2]! << 16) | (b[aligned + 3]! << 24) | 0;
  }

  fetchHalfword(address: number): number {
    const addr = address >>> 0;
    if (!this.resolve(addr)) return 0;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") return region.backing.handler.read16(off);
    const aligned = off & ~1;
    const b = region.backing.bytes;
    return b[aligned]! | (b[aligned + 1]! << 8);
  }

  /** Pipeline-refill cost: 3 instructions starting at `pc`, paying
   *  WS_N for the first halfword and WS_S for the rest. Cart-ROM
   *  refills also accumulate into `cartBusBusyCycles` so the next
   *  step's prefetch-fill credit subtracts them — the raw fetches
   *  done via `fetchWord`/`fetchHalfword` skip `chargeAccess` so this
   *  is where the bus-busy accounting comes back in.
   *
   *  Approximations vs the per-call `chargeAccess` path: the 128 KiB
   *  cart-bank cross penalty is not applied here (rare — only when
   *  the burst straddles the last few bytes of a bank) and DMA-active
   *  is ignored (CPU is stalled during DMA, so a cache miss can't
   *  happen mid-DMA anyway). */
  cacheMissCost(pc: number, isThumb: boolean): number {
    const region = (pc >>> 24) & 0xf;
    const wsN = REGION_N_CYCLES_16[region] ?? 1;
    const wsS = REGION_S_CYCLES_16[region] ?? 1;
    // 32-bit access on a 16-bit cart bus splits into two halfword
    // fetches → REGION_S_BONUS_32 adds the second halfword's cost.
    // Internal regions with 32-bit buses (BIOS / IWRAM / OAM) have
    // bonus = 0 so a 32-bit access remains 1 cycle, matching the
    // per-call cost chargeAccess would have charged.
    const bonus = isThumb ? 0 : (REGION_S_BONUS_32[region] ?? 0);
    // 3 instruction fetches: first non-sequential (wsN), next two
    // sequential (wsS). Each access adds the 32-bit bonus once.
    const cost = wsN + bonus + 2 * (wsS + bonus);
    // Cart-ROM regions tie up the cart bus during refill — preserve
    // the same cartBusBusyCycles contribution chargeAccess would
    // have made via the original 3 read*() calls.
    if (region >= 8 && region <= 0xd) {
      this.cartBusBusyCycles += cost;
      // The two prepaid pipeline fetches (the refillFreeFetches the
      // CPU consumes at 1 cycle each) occupy the cart bus during the
      // FOLLOWING steps on real hardware. Record their real bus time
      // as a stream debt: upcoming idle cycles pay it off before any
      // prefetcher look-ahead credit can accrue (see ArmCpu's
      // fill-credit accounting). Without this, a spuriously banked
      // halfword makes the first post-branch instruction 2 cycles
      // faster than hardware — enough to flip Galidor's
      // callback-pointer race and send it through a null pointer.
      this.refillStreamDebt = 2 * (wsS + bonus);
    }
    return cost;
  }

  write8(address: number, value: number): void {
    const addr = address >>> 0;
    checkGbaWrite(addr);
    this.chargeAccess(addr, 8);
    if (this.isVramBitmapBlocked(addr)) return;
    // GPIO register intercept — same as write16 but for byte stores.
    // Pokémon and Drill Dozer drive GPIO with halfword stores in
    // practice; byte support is here for completeness so a cart that
    // pokes the data register through STRB still routes correctly.
    if (this.cartGpio && addr >= 0x080000c4 && addr <= 0x080000c9) {
      this.cartGpio.write(addr, value & 0xff);
      return;
    }
    // Tilt-sensor write intercept — same six SRAM-window slots as
    // read8. Sits before the resolve path so the cart's arm/trigger
    // bytes never get dropped by the read-only-region check on the
    // SRAM backup handler.
    if (this.cartTilt !== null && TiltSensor.covers(addr)) {
      this.cartTilt.write8(addr, value & 0xff);
      return;
    }
    if (!this.resolve(addr)) return;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") {
      region.backing.handler.write8(off, value & 0xff);
      return;
    }
    const b = region.backing;
    if (b.readOnly) return;
    if (b.byteWriteMode === "ignored") return;
    if (b.byteWriteMode === "vram-split") {
      // BG region (offsets below the boundary) widens STRB to a 16-bit
      // duplicate write; OBJ region (offsets at/above) silently drops
      // the byte (no narrow-write strobe on the OBJ-VRAM bus). The
      // boundary is mode-dependent — tile modes 0-2 split at 0x10000,
      // bitmap modes 3-5 split at 0x14000 (BG bitmap extends through
      // 0x13FFF, OBJ tiles begin at 0x14000). 007 NightFire's Mode-4
      // HUD relies on this: its STRB writes to page 1's bottom band
      // (0x11080-0x135FF) need to land via the duplicate path; with a
      // fixed 0x10000 boundary they were dropped and page 1 stayed
      // stale, producing the in-game flicker.
      const mode = this.vramBgModeProvider() & 0x7;
      const objBoundary = mode >= 3 && mode <= 5 ? 0x14000 : 0x10000;
      if (off >= objBoundary) return;
    }
    if (b.byteWriteMode === "duplicate" || b.byteWriteMode === "vram-split") {
      // GBA palette/VRAM have no narrow-write strobe — STRB widens to
      // a 16-bit transaction with the byte mirrored across both lanes.
      const aligned = off & ~1;
      b.bytes[aligned] = value & 0xff;
      b.bytes[aligned + 1] = value & 0xff;
      return;
    }
    b.bytes[off] = value & 0xff;
  }

  write16(address: number, value: number): void {
    // Same normalization as read16. Byte-bus (cart-RAM) stores narrow
    // to ONE byte at the raw address, lane-selected from the source
    // value — a 16-bit store to SRAM drives only the addressed byte
    // (mgba-suite memory "SRAM store" pins this via the
    // `value >> (8 * (addr & 1))` rule).
    const rawAddr = address >>> 0;
    const addr = (rawAddr & ~1) >>> 0;
    checkGbaWrite(addr);
    this.chargeAccess(addr, 16);
    if (this.isVramBitmapBlocked(addr)) return;
    // Cart GPIO register intercept. The three GPIO registers
    // (`0xC4` data, `0xC6` direction, `0xC8` read-enable) sit at
    // fixed cart-ROM addresses; the bus diverts writes to the cart's
    // GPIO controller (which fans out to its plug-in features —
    // rumble, RTC, …) before the read-only-region drop fires. The
    // narrow address range and the explicit-null hot-path check keep
    // the per-write cost negligible for non-GPIO carts.
    if (this.cartGpio && addr >= 0x080000c4 && addr <= 0x080000c9) {
      this.cartGpio.write(addr, value & 0xffff);
      return;
    }
    if (!this.resolve(addr)) return;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") {
      if (region.byteBus) {
        // 8-bit cart-RAM bus: a halfword store drives ONE byte at the
        // raw address, lane-selected from the source value.
        region.backing.handler.write8(off | (rawAddr & 1), (value >>> (8 * (rawAddr & 1))) & 0xff);
        return;
      }
      region.backing.handler.write16(off, value & 0xffff);
      return;
    }
    if (region.backing.readOnly) return;
    const b = region.backing.bytes;
    b[off] = value & 0xff;
    b[off + 1] = (value >>> 8) & 0xff;
  }

  write32(address: number, value: number): void {
    // Same normalization as read32; byte-bus stores narrow to one
    // byte: `value >> (8 * (addr & 3))` at the raw address.
    const rawAddr = address >>> 0;
    const addr = (rawAddr & ~3) >>> 0;
    checkGbaWrite(addr);
    this.chargeAccess(addr, 32);
    if (this.isVramBitmapBlocked(addr)) return;
    // GPIO register intercept — 32-bit stores split across two GPIO
    // halfwords. STR at 0x080000C4 writes data + direction together
    // (low half → 0xC4, high half → 0xC6); STR at 0x080000C8 writes
    // read-enable + a slot beyond GPIO (high half is ignored).
    if (this.cartGpio && addr >= 0x080000c4 && addr <= 0x080000c8 && (addr & 1) === 0) {
      this.cartGpio.write(addr, value & 0xffff);
      this.cartGpio.write(addr + 2, (value >>> 16) & 0xffff);
      return;
    }
    if (!this.resolve(addr)) return;
    const region = this.resolveRegion!;
    const off = this.resolveOffset;
    if (region.backing.kind === "handler") {
      if (region.byteBus) {
        // 8-bit cart-RAM bus: a word store drives ONE byte at the raw
        // address, lane-selected from the source value.
        region.backing.handler.write8(off | (rawAddr & 3), (value >>> (8 * (rawAddr & 3))) & 0xff);
        return;
      }
      region.backing.handler.write32(off, value | 0);
      return;
    }
    if (region.backing.readOnly) return;
    const b = region.backing.bytes;
    b[off] = value & 0xff;
    b[off + 1] = (value >>> 8) & 0xff;
    b[off + 2] = (value >>> 16) & 0xff;
    b[off + 3] = (value >>> 24) & 0xff;
  }
}

/** BIOS region with PC-gated reads.
 *
 *  Real ARM7TDMI: the BIOS ROM is "protected" — reads from the BIOS
 *  address range (0x00000000-0x00003FFF) return the actual bytes only
 *  when the CPU is currently fetching from BIOS (i.e. executing BIOS
 *  code). When PC is outside BIOS, reads return the last value the
 *  CPU's prefetch latch held from a BIOS fetch.
 *
 *  We model this by holding the byte array + a PC source + a single
 *  `biosOpenBus` register the CPU updates on each BIOS fetch. Reads
 *  while PC is in BIOS return real bytes; otherwise return the open-
 *  bus value. Writes are ignored (BIOS is read-only).
 *
 *  Without a BIOS image loaded, the byte array is zero-filled and
 *  `biosOpenBus` is zero — the legacy "no BIOS" behaviour. */
export class BiosHandler implements IoHandler {
  /** Last word fetched from BIOS by the CPU. Tracks the prefetch
   *  latch state; the CPU updates this in the instruction-fetch path
   *  whenever it loads from a BIOS address. */
  biosOpenBus = 0;

  /** Callback returning the CPU's current PC. The bus calls this on
   *  every BIOS read to decide between real bytes and open-bus. */
  pcSource: () => number = () => 0;

  constructor(public readonly bytes: Uint8Array) {}

  private inBios(): boolean {
    return this.pcSource() >>> 0 < this.bytes.length;
  }

  read8(offset: number): number {
    if (this.inBios()) return this.bytes[offset] ?? 0;
    return (this.biosOpenBus >>> ((offset & 3) * 8)) & 0xff;
  }

  read16(offset: number): number {
    if (this.inBios()) {
      return (this.bytes[offset] ?? 0) | ((this.bytes[offset + 1] ?? 0) << 8);
    }
    return (offset & 2) === 0 ? this.biosOpenBus & 0xffff : (this.biosOpenBus >>> 16) & 0xffff;
  }

  read32(offset: number): number {
    if (this.inBios()) {
      return (
        (this.bytes[offset] ?? 0) |
        ((this.bytes[offset + 1] ?? 0) << 8) |
        ((this.bytes[offset + 2] ?? 0) << 16) |
        ((this.bytes[offset + 3] ?? 0) << 24) |
        0
      );
    }
    return this.biosOpenBus | 0;
  }

  write8(): void {}
  write16(): void {}
  write32(): void {}
}

/** Unmapped MMIO open-bus filler — covers everything past the live
 *  I/O register region (0x04000400-0x04FFFFFF per GBATEK) where reads
 *  return the CPU's recently-prefetched opcode. Registered AFTER the
 *  specific MMIO handlers so first-match leaves all real registers
 *  untouched and only this catches the tail. mgba-suite io-read's
 *  `INVALID(0x100C)` subtest reads from 0x0400100C and expects 0xDEAD
 *  (the CPU prefetch literal). */
class IoOpenBusHandler implements IoHandler {
  source: (() => number) | null = null;

  private current(): number {
    return this.source?.() ?? 0;
  }

  read8(offset: number): number {
    return (this.current() >>> ((offset & 3) * 8)) & 0xff;
  }

  read16(offset: number): number {
    return (offset & 2) === 0 ? this.current() & 0xffff : (this.current() >>> 16) & 0xffff;
  }

  read32(): number {
    return this.current() | 0;
  }

  write8(): void {}
  write16(): void {}
  write32(): void {}
}

/** Fallback handler for cart-ROM reads past the cart's physical
 *  end. The GBA's cart bus has no internal pull-down — when a read
 *  targets an unmapped address inside a wait-state window, the bus
 *  returns the address-bus pattern itself: each halfword decodes as
 *  `(addr >> 1) & 0xFFFF`. Writes are ignored. jsmolka-unsafe t2
 *  verifies the formula by sweeping `[romEnd, romEnd + 0x1000)` and
 *  comparing against a pre-computed expected-byte table. */
class CartOpenBusHandler implements IoHandler {
  constructor(private readonly base: number) {}

  read8(offset: number): number {
    const addr = (this.base + offset) >>> 0;
    const half = (addr >>> 1) & 0xffff;
    return (addr & 1) !== 0 ? (half >>> 8) & 0xff : half & 0xff;
  }

  read16(offset: number): number {
    const addr = (this.base + offset) >>> 0;
    return (addr >>> 1) & 0xffff;
  }

  read32(offset: number): number {
    const addr = (this.base + offset) >>> 0;
    const lo = (addr >>> 1) & 0xffff;
    const hi = ((addr + 2) >>> 1) & 0xffff;
    return lo | (hi << 16) | 0;
  }

  write8(): void {}
  write16(): void {}
  write32(): void {}
}

/** 0x04000300-0x04000303 — POSTFLG (byte 0) and HALTCNT (byte 1).
 *  POSTFLG bit 0 latches "first boot complete" — set by the real BIOS
 *  on entry to user code, can be set by software but NOT cleared
 *  (writing 0 is a no-op). HALTCNT bit 7 selects HALT (0) or STOP (1);
 *  ANY write triggers the selected mode. We model only HALT (the
 *  common case; STOP enters a lower-power state not exercised by
 *  tests). nba-hw-test haltcnt exercises both via byte writes
 *  AND via a halfword STRH at 0x04000300 (the CpuSet HALT-via-bus
 *  trick — the STRH's high byte lands on HALTCNT). */
class PowerHandler implements IoHandler {
  postflg = 0;
  haltcnt = 0;
  onHalt: (() => void) | null = null;

  read8(offset: number): number {
    if (offset === 0) return this.postflg & 0xff;
    if (offset === 1) return this.haltcnt & 0xff;
    return 0;
  }
  read16(offset: number): number {
    if ((offset & ~1) === 0) return (this.postflg & 0xff) | ((this.haltcnt & 0xff) << 8);
    return 0;
  }
  read32(offset: number): number {
    if ((offset & ~3) === 0) return (this.postflg & 0xff) | ((this.haltcnt & 0xff) << 8);
    return 0;
  }
  write8(offset: number, value: number): void {
    if (offset === 0) {
      // POSTFLG: bit 0 can only be SET by software, not cleared.
      this.postflg = (this.postflg | (value & 1)) & 0xff;
    } else if (offset === 1) {
      // STRB to HALTCNT with HALT mode (bit 7 = 0) triggers halt —
      // the GBA BIOS IntrWait routine uses this byte-write path, so a
      // cart that calls SWI 0x04/0x05 spends the wait actually halted
      // instead of in a CPU-burning poll loop (Bubble Bobble's BIOS
      // shows ~30k STRB-to-HALTCNT calls per frame without this).
      //
      // STOP mode (bit 7 = 1) we don't model — store the value but
      // don't halt. nba-hw-test haltcnt's DIRECT probe writes
      // 0x80 and expects TM0=12 with no halt; that path is preserved.
      this.haltcnt = value & 0xff;
      if ((value & 0x80) === 0) this.onHalt?.();
    }
  }
  write16(offset: number, value: number): void {
    if ((offset & ~1) === 0) {
      // POSTFLG byte stored via the byte path.
      this.postflg = (this.postflg | (value & 1)) & 0xff;
      // HALTCNT byte latches via the halfword path AND triggers HALT.
      this.haltcnt = (value >>> 8) & 0xff;
      this.onHalt?.();
    }
  }
  write32(offset: number, value: number): void {
    if ((offset & ~3) === 0) this.write16(0, value & 0xffff);
  }
}

/** GBA memory map factory. Allocates each region the hardware exposes
 *  and returns the bus plus direct refs to every region. Byte regions
 *  are zero-initialised; tests load ROM bytes by writing into the
 *  returned `rom` array directly. Currently-mapped MMIO blocks: the
 *  PPU (LCD registers at 0x04000000), the APU (sound registers at
 *  0x04000060), the joypad (KEYINPUT/KEYCNT at 0x04000130), the IRQ
 *  controller (0x04000200), DMA (0x040000B0), timers (0x04000100),
 *  the cart-RAM region (SRAM/Flash/OpenBus at 0x0E000000), and EEPROM
 *  (at 0x0D000000) if the cart uses an EEPROM backup. */
export interface GbaMemoryMap {
  bus: MappedBus;
  /** BIOS bytes (16 KiB). Backed by a PC-gated handler that returns
   *  real bytes only while the CPU is executing in BIOS — otherwise
   *  reads return `biosHandler.biosOpenBus`. Write to `mem.bios` to
   *  load a BIOS image; the handler picks the bytes up automatically. */
  bios: Uint8Array;
  /** The PC-gated handler that backs the BIOS region. The Gba owner
   *  plumbs `pcSource` and keeps `biosOpenBus` updated from the CPU's
   *  fetch path. */
  biosHandler: BiosHandler;
  ewram: Uint8Array;
  iwram: Uint8Array;
  palette: Uint8Array;
  vram: Uint8Array;
  oam: Uint8Array;
  rom: Uint8Array;
  ppu: Ppu;
  apu: Apu;
  joypad: Joypad;
  interrupts: InterruptController;
  dma: Dma;
  timer: Timer;
  sio: Sio;
  /** POSTFLG (0x04000300) and HALTCNT (0x04000301). Wire `onHalt` to
   *  set `cpu.halted = true` so HALTCNT byte writes (including the
   *  CpuSet halfword-to-POSTFLG trick that bleeds onto HALTCNT) halt
   *  the CPU until any enabled IRQ fires. */
  power: PowerHandler;
  /** Catch-all open-bus handler for unmapped MMIO past 0x04000400.
   *  Wire `source` to `ArmCpu.currentOpenBus` so reads return the
   *  prefetched ARM opcode. */
  ioOpenBus: IoOpenBusHandler;
  /** SRAM backup at 0x0E000000, or `null` if the cart uses Flash /
   *  EEPROM / no backup. */
  sram: SramBackup | null;
  /** Flash backup at 0x0E000000 (64 KB or 128 KB), or `null`. SRAM
   *  and Flash share an address window — exactly one of `sram` /
   *  `flash` can be non-null. */
  flash: FlashBackup | null;
  /** EEPROM backup at 0x0D000000, or `null` for non-EEPROM carts.
   *  Independent from SRAM/Flash — the chips live at different
   *  address windows so a cart could in principle have both, though
   *  no commercial cart does. */
  eeprom: EepromBackup | null;
}

/** First 8 bytes of the mandatory Nintendo boot logo at header offset
 *  0x04. Licensed carts (and the flashcarts test-ROM expectations were
 *  measured on) always carry the full 156-byte pattern; unlicensed
 *  PCBs (GameShark GBA) don't bother — the prefix is enough to tell
 *  them apart for the ROM-mirroring heuristic below. */
const NINTENDO_LOGO_PREFIX = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21] as const;

function hasNintendoLogo(romData: Uint8Array | undefined): boolean {
  if (romData === undefined || romData.length < 0x0c) return true;
  for (let i = 0; i < NINTENDO_LOGO_PREFIX.length; i++) {
    if (romData[0x04 + i] !== NINTENDO_LOGO_PREFIX[i]) return false;
  }
  return true;
}

export function makeGbaMemoryMap(
  romSize = 0x2000,
  backup: BackupSpec = { type: "none", size: 0 },
  romData?: Uint8Array
): GbaMemoryMap {
  const bus = new MappedBus();
  // BIOS region — handler-backed so reads can fall through to
  // `biosOpenBus` when the CPU is outside BIOS. The handler owns the
  // byte array; we expose it as `mem.bios` for the Gba to fill.
  const biosHandler = new BiosHandler(new Uint8Array(0x4000));
  bus.addHandler(0x00000000, 0x4000, biosHandler);
  const bios = biosHandler.bytes;
  // On-hardware mirroring: EWRAM (256 KB) and IWRAM (32 KB) each
  // mirror across their full 16 MB address windows. libgba's IRQ
  // dispatcher writes the BIOS interrupt-check flag through the
  // IWRAM mirror at 0x03FFFFF8 (canonical 0x03007FF8) — `VBlankIntrWait`
  // HLE deadlocks unless that write reaches the same byte the BIOS
  // reads, which means IWRAM has to be addressable through both the
  // canonical and mirrored windows. Same shape for EWRAM (real carts
  // sometimes touch 0x02FFFFFx). Palette and OAM also mirror but
  // games rarely poke their mirrors and the wrap is power-of-two; we
  // mirror them too for symmetry. VRAM is 96 KiB physical but the
  // hardware addresses it in a 128 KiB unit — the upper 32 KiB
  // (0x18000-0x1FFFF) folds back into the second 16 KiB of OBJ VRAM
  // (0x10000-0x17FFF). The whole 128 KiB unit then repeats across
  // the full 16 MB region 0x06000000-0x06FFFFFF.
  // Byte-write quirks: Palette and VRAM widen STRB to a halfword
  // (byte duplicated across both lanes); OAM silently drops STRB
  // entirely — there's no narrow-write strobe on the OAM bus. VRAM's
  // OBJ region (0x06010000+ in tile modes, 0x06014000+ in bitmap
  // modes) ALSO ignores STRB, but that quirk depends on the current
  // BG mode and is enforced separately (see PPU/PpuVramByteGuard).
  const ewram = bus.addRegion(0x02000000, 0x40000, { mirrorWindow: 0x01000000 });
  const iwram = bus.addRegion(0x03000000, 0x8000, { mirrorWindow: 0x01000000 });
  const palette = bus.addRegion(0x05000000, 0x400, { mirrorWindow: 0x01000000, byteWriteMode: "duplicate" });
  const vram = bus.addRegion(0x06000000, 0x18000, {
    mirrorWindow: 0x01000000,
    mirrorUnit: 0x20000,
    byteWriteMode: "vram-split"
  });
  const oam = bus.addRegion(0x07000000, 0x400, { mirrorWindow: 0x01000000, byteWriteMode: "ignored" });
  // Cart ROM is exposed through three address windows (WS0/WS1/WS2),
  // each 32 MB, that decode to the same physical ROM — only the
  // hardware bus timings differ. We map WS0 explicitly and alias WS1
  // and WS2 onto the same backing array further down (after EEPROM,
  // so EEPROM at 0x0D000000 wins over the WS2 mirror when present).
  // No modulo mirroring within the 32 MB window: real cart hardware
  // returns open-bus for in-window reads past
  // the ROM end — `(addr >> 1) & 0xFFFF` per halfword, served by the
  // CartOpenBusHandler fall-through below. mgba-suite memory's "ROM
  // out-of-bounds load" pins this. Carts that branch into the upper
  // window (Dead to Rights, Bruce Lee, Bubble Bobble) target offsets
  // that are in-range for their ROM size, so the linear region covers
  // them without a mirror.
  // Licensed carts (and flashcarts, which the test-ROM expectations
  // were measured on) decode enough address lines that in-window reads
  // past the ROM end return open-bus — `(addr >> 1) & 0xFFFF` per
  // halfword via the CartOpenBusHandler fall-through, as the hardware
  // model returns and mgba-suite memory's "ROM out-of-bounds load" pins.
  // Unlicensed PCBs (GameShark GBA) decode only as many lines as
  // their small ROM needs, so the image mirrors across the window —
  // without it both GameShark carts freeze at a static splash. The
  // dump can't expose the PCB wiring, so gate the mirror on the
  // unlicensed-hardware proxy: a power-of-two ROM whose header lacks
  // the valid Nintendo boot logo.
  const isPowerOfTwo = romSize > 0 && (romSize & (romSize - 1)) === 0;
  const romRegionOpts: { readOnly: boolean; mirrorWindow?: number } = { readOnly: true };
  if (isPowerOfTwo && !hasNintendoLogo(romData)) romRegionOpts.mirrorWindow = 0x02000000;
  const rom = bus.addRegion(0x08000000, romSize, romRegionOpts);
  const ppu = new Ppu(vram, palette, oam);
  bus.addHandler(0x04000000, 0x60, ppu);
  // Gate the bitmap-mode VRAM mirror block (0x06018000-0x0601BFFF in
  // BG modes 3/4/5) on the PPU's current dispcnt mode bits.
  bus.vramBgModeProvider = () => ppu.dispcnt & 0x7;
  const apu = new Apu();
  // APU live registers occupy 0x60-0xA7 (size 0x48); the 0xA8-0xAF
  // tail is unmapped on real silicon and reads land on CPU open-bus.
  // Extend the handler region by 8 bytes so the APU's read16 fallback
  // (which returns open-bus for offset >= 0x48) catches those slots.
  bus.addHandler(0x04000060, 0x50, new PeripheralAccessNotifier(bus, apu));
  const joypad = new Joypad();
  // KEYINPUT (0x130) + KEYCNT (0x132) — 4-byte handler window covers
  // both 16-bit registers and the half-word slot beyond them.
  bus.addHandler(0x04000130, 0x4, joypad);
  // SIO mode-aware register file at 0x120-0x15F (64 bytes). Registered
  // AFTER joypad so the joypad's 4-byte window at 0x130-0x133 wins
  // first-match for those slots; SIO catches everything else in its
  // range, including the RCNT mode-select register at 0x134.
  const sio = new Sio();
  bus.addHandler(0x04000120, 0x40, new PeripheralAccessNotifier(bus, sio));
  const interrupts = new InterruptController();
  // IE/IF/WAITCNT/IME occupy 0x200..0x20B; 12-byte handler window.
  bus.addHandler(0x04000200, 0x0c, new PeripheralAccessNotifier(bus, interrupts));
  // Cart-code WAITCNT writes rebuild the bus's per-region N/S cycle
  // tables (WS0/WS1/WS2/SRAM). Internal-bus regions keep their fixed
  // costs. Default seed (WAITCNT 0x0000) was applied at module load.
  interrupts.onWaitcntChange = (v) => bus.setWaitcnt(v);
  // EEPROM (if present) is mapped at 0x0D000000 and reached only via
  // DMA3 — its bit-serial protocol relies on DMA3 supplying the
  // transfer length to disambiguate read/write commands and chip
  // sizes. Built before Dma so we can hand it to the controller.
  // IMPORTANT: register before the WS2 ROM alias below — a 32 MB cart
  // ROM mirrored into WS2 (0x0C000000-0x0DFFFFFF) would otherwise
  // shadow the EEPROM window, since resolve() takes the first match.
  let eeprom: EepromBackup | null = null;
  if (backup.type === "eeprom") {
    eeprom = new EepromBackup();
    // Real carts decode only the high address bit of the 0x0D window;
    // the chip mirrors throughout. We map the whole 16 MB window so
    // any in-window address hits the device.
    bus.addHandler(0x0d000000, 0x01000000, eeprom);
  }
  // WS1 (0x0A000000) and WS2 (0x0C000000) aliases of the same ROM.
  // jsmolka memory test 7/8 verify these mirrors by ADR-ing into ROM
  // then offsetting by +0x02000000 / +0x04000000 and checking the
  // value reads back identically.
  bus.addRegionAlias(0x0a000000, rom, romRegionOpts);
  bus.addRegionAlias(0x0c000000, rom, romRegionOpts);
  const dma = new Dma(bus, interrupts, eeprom);
  // 4 channels × 12 bytes (0xB0-0xDF) + 0x20-byte tail (0xE0-0xFF) the
  // handler answers with CPU open-bus, matching real hardware's
  // post-DMA unhandled MMIO. Total 0x50 bytes.
  bus.addHandler(0x040000b0, 0x50, new PeripheralAccessNotifier(bus, dma));
  const timer = new Timer(interrupts, apu);
  // 4 timers × 4 bytes = 16 bytes starting at 0x100.
  bus.addHandler(0x04000100, 0x10, new PeripheralAccessNotifier(bus, timer));
  // POSTFLG + HALTCNT (4 bytes at 0x04000300). Wired into Gba so a
  // write to HALTCNT (direct STRB or via a halfword STRH whose high
  // byte lands at 0x04000301 — the CpuSet HALT-via-bus trick) flips
  // cpu.halted to true. Same release path as biosHalt.
  const power = new PowerHandler();
  bus.addHandler(0x04000300, 0x4, power);
  // half-empty watermark → DMA1/2 (whichever is bound to that FIFO)
  // bursts 4 × 32-bit samples into it.
  apu.onFifoARequest = () => dma.onSoundFifoRequest("A");
  apu.onFifoBRequest = () => dma.onSoundFifoRequest("B");
  // PPU drives VBlank / HBlank / VCount IRQs AND DMA triggers from the
  // same events. The listener checks DISPSTAT before raising so
  // disabled IRQs stay silent; DMA channels run unconditionally when
  // armed for that timing.
  ppu.onVBlank = () => {
    if (ppu.vblankIrqEnabled) interrupts.raise(IRQ_VBLANK);
    dma.onVBlank();
  };
  ppu.onHBlank = () => {
    if (ppu.hblankIrqEnabled) interrupts.raise(IRQ_HBLANK);
    // HBlank-triggered DMA on real hardware only fires during visible
    // scanlines (vcount 0..159). Mode-7 carts (F-Zero Climax, ATV Quad
    // Power Racing, Mario Kart Super Circuit) set up an HBlank repeat-
    // DMA that walks a per-scanline matrix scratch buffer; if we also
    // fire during VBlank, SAD advances past the buffer, the next
    // frame's first fires read garbage, and the BG affine matrix
    // corrupts. GBATEK explicitly notes the visible-only restriction.
    if (ppu.vcount < 160) dma.onHBlank();
  };
  ppu.onVCount = () => {
    if (ppu.vcountIrqEnabled) interrupts.raise(IRQ_VCOUNT);
  };
  // SRAM + Flash share the 0x0E000000 window. The hardware maps the
  // backup chip across the full 32 MB cart-RAM region (0x0E000000-
  // 0x0FFFFFFF) — the data lines only carry A0..A14/A15/A16 to the
  // chip, so higher address bits are ignored and the chip mirrors
  // throughout the window. Always map the full window: SRAM/Flash if
  // present, OpenBus (returns 0xFF) otherwise. EEPROM (6d) lives at
  // 0x0D000000 instead and is wired separately.
  let sram: SramBackup | null = null;
  let flash: FlashBackup | null = null;
  let handler: SramBackup | FlashBackup | OpenBusBackup;
  if (backup.type === "sram") {
    sram = new SramBackup(backup.size);
    handler = sram;
  } else if (backup.type === "flash64" || backup.type === "flash128") {
    flash = new FlashBackup(
      backup.type === "flash64" ? 0x10000 : 0x20000,
      backup.flashManufacturerId,
      backup.flashDeviceId
    );
    handler = flash;
  } else {
    handler = new OpenBusBackup();
  }
  bus.addHandler(0x0e000000, 0x02000000, handler, /* byteBus */ true);
  // Unmapped MMIO catch-all from 0x04000400 onwards. Registered after
  // every real I/O handler so first-match leaves the live registers
  // untouched. mgba-suite io-read's `INVALID(0x100C)` probes a slot
  // inside this range and expects CPU open-bus, not 0. `source` is
  // wired to ArmCpu.currentOpenBus by the Gba constructor — null in
  // unit tests means reads return 0 (same as before this handler).
  const ioOpenBus = new IoOpenBusHandler();
  // 0x04000400-0x04FFFFFF: unmapped MMIO (the "Not used" half of the
  // I/O region per GBATEK).
  bus.addHandler(0x04000400, 0x00fffc00, ioOpenBus);
  // 0x00004000-0x01FFFFFF: gap between BIOS (0x00000000-0x00003FFF)
  // and EWRAM (0x02000000). mgba-suite memory test verifies that
  // reads in this range return CPU open-bus, not 0.
  bus.addHandler(0x00004000, 0x01ffc000, ioOpenBus);
  // 0x10000000-0xFFFFFFFF: above the cart bus / future-expansion
  // unused range. Same open-bus behaviour.
  bus.addHandler(0x10000000, 0xf0000000, ioOpenBus);
  // Cart open-bus fallback for each wait-state window. Registered
  // last so all real regions (ROM, EEPROM, SRAM/Flash) win the
  // first-match check; only addresses past the cart's physical end
  // fall through here. Each window is 32 MB; the handler returns
  // `(addr >> 1) & 0xFFFF` per halfword and ignores writes.
  bus.addHandler(0x08000000, 0x02000000, new CartOpenBusHandler(0x08000000));
  bus.addHandler(0x0a000000, 0x02000000, new CartOpenBusHandler(0x0a000000));
  bus.addHandler(0x0c000000, 0x02000000, new CartOpenBusHandler(0x0c000000));
  return {
    bus,
    bios,
    biosHandler,
    ewram,
    iwram,
    palette,
    vram,
    oam,
    rom,
    ppu,
    apu,
    joypad,
    interrupts,
    dma,
    timer,
    sio,
    power,
    ioOpenBus,
    sram,
    flash,
    eeprom
  };
}
