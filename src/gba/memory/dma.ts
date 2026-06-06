/**
 * GBA DMA — 4 channels at 0x040000B0..0x040000DF.
 *
 * Each channel has four registers (12 bytes total):
 *   +0  DMAxSAD    32-bit source address
 *   +4  DMAxDAD    32-bit destination address
 *   +8  DMAxCNT_L  16-bit transfer count (units = halfword or word)
 *   +A  DMAxCNT_H  16-bit control:
 *                    5-6   dest address control (0=inc, 1=dec, 2=fixed, 3=inc + reload)
 *                    7-8   source address control (0=inc, 1=dec, 2=fixed)
 *                    9     repeat flag
 *                    10    transfer width (0=halfword, 1=word)
 *                    12-13 timing mode (see Timing enum)
 *                    14    IRQ on transfer complete
 *                    15    enable
 *
 * Channel-specific limits (per GBATEK):
 *   DMA0    SAD: internal RAM, DAD: internal RAM, CNT_L: 14-bit (0=0x4000)
 *   DMA1/2  SAD: internal RAM + ROM, DAD: internal RAM, CNT_L: 14-bit
 *   DMA3    SAD: internal RAM + ROM, DAD: any, CNT_L: 16-bit (0=0x10000)
 *
 * Address validation is light — high bits aren't masked, and we trust
 * the cart to write addresses inside each channel's documented window
 * with the exception of DMA0, which can't drive the cart bus (reads
 * from cart-ROM/SRAM return the channel latch or 0; writes are dropped).
 * Transfers run synchronously from the CPU step's POV (no inter-frame
 * yielding), but peripherals are advanced mid-DMA via `onCyclesElapsed`
 * so timer/APU reads inside the burst see the right counter values —
 * see `advanceForImmediateStartup` + `advanceForTransfer` for the
 * per-burst and per-word cycle costs.
 *
 * Trigger semantics:
 *   - Writing CNT_H with enable=1 latches SAD / DAD / CNT into a
 *     shadow copy and (when timing=Immediate) fires the transfer
 *     right away.
 *   - VBlank / HBlank / Sound-FIFO triggers come from external hooks
 *     (`onVBlank`, `onHBlank`, `onSoundFifoRequest`) which fire any
 *     channel currently armed for that timing.
 *   - After a non-repeat transfer the enable bit clears in CNT_H.
 *     Repeat-mode transfers leave enable set and re-arm on the next
 *     external trigger; SAD/CNT are re-latched if appropriate.
 */

import type { EepromBackup } from "../cartridge/backup.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";
import { type InterruptController, IRQ_DMA0, IRQ_DMA1, IRQ_DMA2, IRQ_DMA3 } from "./interrupts.js";
import { BaseIoHandler } from "./io-handler-base.js";
import type { MappedBus } from "./mapped-bus.js";

/** EEPROM address window (chip mirrors throughout this 16 MB region;
 *  the high address bit is the only signal that reaches the chip). */
const EEPROM_REGION_START = 0x0d000000;
const EEPROM_REGION_END = 0x0e000000;

function inEepromRegion(addr: number): boolean {
  const a = addr >>> 0;
  return a >= EEPROM_REGION_START && a < EEPROM_REGION_END;
}

/** Cart bus region (WS0/WS1/WS2 ROM + SRAM/Flash). DMA0 cannot drive
 *  this bus on real hardware — the cart connector has no direct path
 *  to that channel's controller, so reads from there return 0 rather
 *  than the cart byte. */
const CART_REGION_START = 0x08000000;
const CART_REGION_END = 0x10000000;

function inCartRegion(addr: number): boolean {
  const a = addr >>> 0;
  return a >= CART_REGION_START && a < CART_REGION_END;
}

export enum DmaTiming {
  Immediate = 0,
  VBlank = 1,
  HBlank = 2,
  Special = 3
}

/** Per-channel layout: 12 bytes (3 × 32-bit + 16-bit + 16-bit packed). */
const CH_SIZE = 12;

/** Number of DMA channels. */
const NUM_CHANNELS = 4;

/** Control bits. */
const CNT_DEST_CONTROL_SHIFT = 5;
const CNT_SRC_CONTROL_SHIFT = 7;
const CNT_REPEAT = 1 << 9;
const CNT_WORD = 1 << 10;
const CNT_TIMING_SHIFT = 12;
const CNT_IRQ = 1 << 14;
const CNT_ENABLE = 1 << 15;

const IRQ_FOR_CHANNEL = [IRQ_DMA0, IRQ_DMA1, IRQ_DMA2, IRQ_DMA3] as const;

class DmaChannel {
  /** SAD / DAD / CNT_L / CNT_H are the bus-visible registers. */
  sad = 0;
  dad = 0;
  cnt = 0;
  control = 0;

  /** Latched (active) values used during the running transfer. The
   *  bus-visible SAD / DAD / CNT may keep their original values per
   *  GBATEK — the channel works off the shadow copy. */
  shadowSad = 0;
  shadowDad = 0;
  shadowCnt = 0;

  /** 32-bit data-bus latch — the last value this channel saw on the
   *  bus. Halfword reads from a valid source store the halfword
   *  mirrored into both halves ((v << 16) | v); word reads store the
   *  full 32-bit value. When the channel reads from an invalid region
   *  (BIOS at 0x00000000-0x01FFFFFF, where the bus delivers no real
   *  data), the latch supplies the value: word reads return it whole,
   *  halfword reads return the half selected by (dst & 2). Per channel
   *  — DMA0..DMA3 each have their own. nba-hw-test dma/latch
   *  verifies the (dst & 2) selection and that DMA2's latch isn't
   *  shared with DMA1's. */
  latch = 0;

  constructor(readonly index: 0 | 1 | 2 | 3) {}

  get enabled(): boolean {
    return (this.control & CNT_ENABLE) !== 0;
  }
  get repeat(): boolean {
    return (this.control & CNT_REPEAT) !== 0;
  }
  get word(): boolean {
    return (this.control & CNT_WORD) !== 0;
  }
  get irqOnDone(): boolean {
    return (this.control & CNT_IRQ) !== 0;
  }
  get timing(): DmaTiming {
    return ((this.control >>> CNT_TIMING_SHIFT) & 0x3) as DmaTiming;
  }
  /** 0 = inc, 1 = dec, 2 = fixed, 3 = inc with reload (dest only). */
  get destControl(): number {
    return (this.control >>> CNT_DEST_CONTROL_SHIFT) & 0x3;
  }
  /** 0 = inc, 1 = dec, 2 = fixed, 3 = prohibited. */
  get srcControl(): number {
    return (this.control >>> CNT_SRC_CONTROL_SHIFT) & 0x3;
  }

  /** Word count = CNT_L treated as 14-bit for DMA0/1/2, 16-bit for
   *  DMA3. Zero maps to the max (0x4000 or 0x10000). */
  unitCount(): number {
    const mask = this.index === 3 ? 0xffff : 0x3fff;
    const raw = this.cnt & mask;
    return raw === 0 ? mask + 1 : raw;
  }
}

export class Dma extends BaseIoHandler {
  readonly channels: readonly [DmaChannel, DmaChannel, DmaChannel, DmaChannel] = [
    new DmaChannel(0),
    new DmaChannel(1),
    new DmaChannel(2),
    new DmaChannel(3)
  ];

  constructor(
    private readonly bus: MappedBus,
    private readonly interrupts: InterruptController,
    /** Optional EEPROM device. When DMA3 transfers to/from the
     *  0x0D000000 region the controller calls into this device to
     *  bracket the bit-serial transfer; non-EEPROM carts pass null. */
    private readonly eeprom: EepromBackup | null = null
  ) {
    super();
  }

  /** Open-bus source for reads of write-only DMA registers (SAD,
   *  DAD, CNT_L per GBATEK — all marked "W"). Wired by the Gba
   *  constructor to {@link ArmCpu.currentOpenBus} so reads of these
   *  slots return the prefetched ARM opcode at PC+8, matching real
   *  ARM7TDMI. Null in unit tests = returns 0. */
  openBusSource: (() => number) | null = null;

  /** Optional callback wired by Gba: when an immediate-trigger DMA
   *  fires synchronously inside a CPU instruction's bus write, the
   *  hardware-spec 2-cycle DMA startup delay (and the trailing edge
   *  of the triggering STR) elapses before the DMA's first bus read.
   *  Without advancing the peripherals mid-step, DMA reads of
   *  cycle-counting registers (TM*CNT_L) observe stale values from
   *  the end of the previous step. The callback advances timer / APU
   *  by `cycles` cycles; the Gba host tracks how much was pre-ticked
   *  and subtracts it from the end-of-step periphery tick to keep
   *  total cycle accounting balanced. nba-hw-test
   *  dma/start-delay verifies the 4-cycle effective gap (2 cycles
   *  STR completion + 2 cycles DMA startup) on real silicon. */
  onCyclesElapsed: ((cycles: number) => void) | null = null;
  /** Cycles pre-ticked through `onCyclesElapsed` during the current
   *  CPU step. The Gba host resets this to 0 before each step and
   *  subtracts it from the end-of-step `timer.tick` / `apu.tick`. */
  preTickedThisStep = 0;

  // ─── Bus I/O ────────────────────────────────────────────────────────

  read16(offset: number): number {
    // The DMA handler is registered with size 0x50 so it covers the
    // post-channel tail at 0x040000E0-0x040000FE — that range is
    // unhandled in the silicon (no DMA channel reaches it), so reads
    // land on CPU open-bus rather than module zero. mgba-suite io-read
    // verifies the 16 slots in the tail.
    if (offset >= NUM_CHANNELS * CH_SIZE) return this.readOpenBus(offset & ~1);
    const ch = this.channels[(offset / CH_SIZE) | 0];
    if (!ch) return 0;
    const within = offset - ch.index * CH_SIZE;
    switch (within & ~1) {
      case 0x0:
      case 0x2:
      case 0x4:
      case 0x6:
        // SAD and DAD are write-only per GBATEK — reads return the
        // CPU's open-bus latch (prefetched ARM opcode at PC+8). The
        // mgba-suite io-read test verifies the literal `0xDEAD…`
        // planted after each ldrh, not the stored register value.
        return this.readOpenBus(within & ~1);
      case 0x8:
        // CNT_L (DMA word count) is also write-only, but mgba-suite
        // expects reads to return 0 rather than open-bus — likely
        // because the DMA controller drives the bus low on this slot
        // instead of leaving it floating. Empirically the test passes
        // when we return 0 here and fails when we return open-bus.
        return 0;
      case 0xa: {
        // DMA CNT_H read-back masks (per GBATEK + mgba-suite io-read):
        // DMA0-2 have no game-pak DRQ bit → mask 0xF7E0; DMA3 has it
        // → mask 0xFFE0. Bits 0-4 are reserved (the LOW half holds
        // word-count) and always read 0.
        const ctlMask = ch.index === 3 ? 0xffe0 : 0xf7e0;
        return ch.control & ctlMask;
      }
      default:
        return 0;
    }
  }

  private readOpenBus(aligned: number): number {
    const word = this.openBusSource?.() ?? 0;
    return ((aligned & 2) === 0 ? word & 0xffff : (word >>> 16) & 0xffff) | 0;
  }

  write16(offset: number, value: number): void {
    const ch = this.channels[(offset / CH_SIZE) | 0];
    if (!ch) return;
    const within = offset - ch.index * CH_SIZE;
    const v = value & 0xffff;
    switch (within & ~1) {
      case 0x0:
        ch.sad = (ch.sad & 0xffff0000) | v;
        return;
      case 0x2:
        ch.sad = (ch.sad & 0xffff) | (v << 16);
        return;
      case 0x4:
        ch.dad = (ch.dad & 0xffff0000) | v;
        return;
      case 0x6:
        ch.dad = (ch.dad & 0xffff) | (v << 16);
        return;
      case 0x8:
        ch.cnt = v;
        return;
      case 0xa: {
        const wasEnabled = ch.enabled;
        ch.control = v;
        // Any CNT_H write with the enable bit set re-latches the
        // channel's SAD/DAD/CNT into the shadow copy and (for
        // immediate mode) runs the transfer. Real silicon re-arms on
        // every write with bit 15 set, not only on the 0→1 transition:
        // Casper's intro re-arms DMA3 immediately while the previous
        // repeat-mode transfer (ctrl=0x8300) had left enable latched,
        // and the new ctrl=0xc400 immediate transfer must still fire.
        if (ch.enabled) {
          // Real DMA forces source/destination address alignment down
          // to the transfer width (~1 for halfword, ~3 for word). The
          // bus accesses themselves don't realign, so the cart code's
          // misaligned register write would otherwise read/write the
          // wrong bytes — see mgba-suite memory test's DMA1/2/3
          // subtests where `src = base + N` is expected to behave as
          // `src = base & ~(width-1)`.
          const alignMask = ch.word ? ~3 : ~1;
          ch.shadowSad = (ch.sad & alignMask) | 0;
          ch.shadowDad = (ch.dad & alignMask) | 0;
          ch.shadowCnt = ch.unitCount();
          if (ch.timing === DmaTiming.Immediate) {
            if (!wasEnabled) this.advanceForImmediateStartup();
            this.runChannel(ch);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  // ─── External triggers ─────────────────────────────────────────────

  /** Fire any channel currently armed for VBlank. */
  onVBlank(): void {
    for (const ch of this.channels) {
      if (ch.enabled && ch.timing === DmaTiming.VBlank) this.runChannel(ch);
    }
  }

  /** Fire any channel currently armed for HBlank. (DMA0 only on
   *  visible scanlines on hardware; we don't gate on that.) */
  onHBlank(): void {
    for (const ch of this.channels) {
      if (ch.enabled && ch.timing === DmaTiming.HBlank) this.runChannel(ch);
    }
  }

  /** Signalled by the APU when FIFO A or B drops to half-full. The
   *  cart hard-binds one of DMA1/2 to each FIFO via the channel's
   *  DAD (= 0x040000A0 for FIFO_A, 0x040000A4 for FIFO_B); we run
   *  whichever channel matches the requesting FIFO's address. The
   *  burst is always 4 × 32-bit regardless of CNT_L / word-bit. */
  onSoundFifoRequest(fifo: "A" | "B"): void {
    const fifoAddr = (fifo === "A" ? 0x040000a0 : 0x040000a4) | 0;
    for (const ch of [this.channels[1], this.channels[2]] as const) {
      if (!ch.enabled || ch.timing !== DmaTiming.Special) continue;
      if ((ch.shadowDad | 0) !== fifoAddr) continue;
      this.runSoundDma(ch);
    }
  }

  // ─── Transfer engine ───────────────────────────────────────────────

  /** Charge the cycle gap between the STR that triggered an immediate
   *  DMA and the DMA controller's first bus read. nba-hw-test
   *  dma/start-delay expects TM0CNT_L=20 when read by an immediate
   *  DMA whose trigger STR sits 16 free-running cycles after TM0
   *  enable — accounting for 4 extra cycles inside the trigger step
   *  itself (2 to finish the STR data phase, 2 DMA startup per
   *  GBATEK). Charged to bus.accessCycles so step total stays
   *  correct, and surfaced via `onCyclesElapsed` so peripherals see
   *  the pre-DMA cycle advance immediately rather than at the next
   *  end-of-step tick. */
  private advanceForImmediateStartup(): void {
    const cycles = 4;
    this.bus.accessCycles += cycles;
    this.preTickedThisStep += cycles;
    this.onCyclesElapsed?.(cycles);
  }

  /** Per-transfer internal cycle charged after each word/halfword copy.
   *  Pays 2I per word for each transfer — what real HW actually
   *  charges empirically, despite GBATEK's misleading "2I total"
   *  wording. Without these per-word ticks nba-bus-128kb-boundary
   *  scores <10/18; with them we clear ≥10/18 on that test ROM.
   *  Fires onCyclesElapsed so peripherals see the tick at the moment
   *  of the (logical) transfer completion, not at end of
   *  step. Called AFTER each bus.read/write so the first transfer's
   *  read sees the pre-DMA timer value (nba-dma-start-delay
   *  invariant). */
  private advanceForTransfer(): void {
    const cycles = 2;
    this.bus.accessCycles += cycles;
    this.preTickedThisStep += cycles;
    this.onCyclesElapsed?.(cycles);
  }

  private runChannel(ch: DmaChannel): void {
    const wordSize = ch.word ? 4 : 2;
    const srcStep = stepFor(ch.srcControl, wordSize);
    const destStep = stepFor(ch.destControl, wordSize);
    let src = ch.shadowSad | 0;
    let dst = ch.shadowDad | 0;
    const count = ch.shadowCnt | 0;
    this.bus.dmaActive = true;
    this.bus.dmaFirstCartAccess = true;
    // EEPROM transfers (DMA3 only) bracket the loop so the device can
    // see the transfer length (needed for chip-size autodetect on the
    // first frame, and to know when a write-direction command is
    // complete and should be parsed).
    const eepromWrite = ch.index === 3 && this.eeprom !== null && inEepromRegion(dst);
    const eepromRead = ch.index === 3 && this.eeprom !== null && inEepromRegion(src);
    if (eepromWrite) this.eeprom!.beginDmaTransfer(count, /* write */ true);
    else if (eepromRead) this.eeprom!.beginDmaTransfer(count, /* write */ false);
    // DMA0 cannot drive the cart bus on real hardware — reads sourced
    // from cart-ROM/SRAM return 0, and writes targeting that region
    // are dropped (the cart controller never sees the access).
    const blockCart = ch.index === 0;
    for (let i = 0; i < count; i++) {
      const srcBlocked = blockCart && inCartRegion(src);
      const dstBlocked = blockCart && inCartRegion(dst);
      const srcInvalid = src >>> 0 < 0x02000000;
      // Halfword DMA writes to cart-ROM are dropped (cart is RO), but
      // real silicon still cycles the cart bus for a 32-bit burst (two
      // halfword cycles). The source therefore advances by 2× width on
      // these steps — verified on real hardware by nba-hw-test
      // dma/burst-into-tears (subt=2/3 after this; the 3rd assertion is
      // a cycle-count check that needs orthogonal accounting). DMA0 is
      // already handled by `blockCart` (read+write both forced to
      // no-op), so this rule applies to DMA1/2/3 only. Excludes SRAM/
      // Flash (0x0E000000+, writable) and EEPROM (routed through
      // `eepromWrite` via the EEPROM device).
      const dstCartRom = dst >>> 0 >= 0x08000000 && dst >>> 0 < 0x0e000000;
      const dstCartBurst = !ch.word && !blockCart && dstCartRom && !eepromWrite;
      if (dstCartBurst) {
        // Skip the actual read+write so the channel latch stays
        // untouched, but real silicon still cycles the cart bus for
        // the dropped write (= the "32-bit burst" the source advance
        // implies). Without these cycles, nba-dma-burst-into-tears's
        // DMA TIME subtest is 4 cycles short per dropped slot. We
        // charge the cycles directly (= 2 halfwords at the dst region
        // wait state) rather than via bus.write16, so the dropped slot
        // doesn't pollute the cart-bus prev-address tracker — the
        // FOLLOWING legitimate read at the new src should still pay
        // its full non-sequential cost.
        this.bus.addCartBusyCycles(dst >>> 0, 4);
        src = (src + srcStep) | 0;
      } else if (ch.word) {
        let v: number;
        if (srcInvalid) {
          v = ch.latch | 0;
        } else if (srcBlocked) {
          // DMA0 can't drive the external (cart-region) bus. mgba-suite
          // distinguishes two sub-cases: cart-ROM source returns the
          // channel latch (priming DMA's tail), while SRAM source
          // returns 0 (the SRAM byte-bus contributes nothing because
          // the channel doesn't even reach the cart controller).
          v = src >>> 0 >= 0x0e000000 ? 0 : ch.latch | 0;
        } else {
          v = this.bus.read32(src >>> 0) | 0;
          ch.latch = v;
        }
        if (!dstBlocked) this.bus.write32(dst >>> 0, v);
      } else {
        let v: number;
        if (srcInvalid) {
          v = (dst & 2) !== 0 ? (ch.latch >>> 16) & 0xffff : ch.latch & 0xffff;
        } else if (srcBlocked) {
          if (src >>> 0 >= 0x0e000000) v = 0;
          else v = (dst & 2) !== 0 ? (ch.latch >>> 16) & 0xffff : ch.latch & 0xffff;
        } else {
          v = this.bus.read16(src >>> 0) & 0xffff;
          ch.latch = (v << 16) | v | 0;
        }
        if (!dstBlocked) this.bus.write16(dst >>> 0, v);
      }
      const touchesCart = inCartRegion(src) || inCartRegion(dst);
      src = (src + srcStep) | 0;
      dst = (dst + destStep) | 0;
      if (ch.word && touchesCart) this.advanceForTransfer();
    }
    if (eepromWrite) this.eeprom!.endDmaTransfer(/* write */ true);
    else if (eepromRead) this.eeprom!.endDmaTransfer(/* write */ false);
    this.bus.dmaActive = false;
    this.finishChannel(ch, src, dst);
  }

  private runSoundDma(ch: DmaChannel): void {
    // 4 × 32-bit words; SAD increments, DAD fixed.
    let src = ch.shadowSad | 0;
    const dst = ch.shadowDad | 0;
    this.bus.dmaActive = true;
    this.bus.dmaFirstCartAccess = true;
    for (let i = 0; i < 4; i++) {
      const touchesCart = inCartRegion(src) || inCartRegion(dst);
      this.bus.write32(dst >>> 0, this.bus.read32(src >>> 0));
      src = (src + 4) | 0;
      if (touchesCart) this.advanceForTransfer();
    }
    this.bus.dmaActive = false;
    this.finishChannel(ch, src, dst);
  }

  private finishChannel(ch: DmaChannel, finalSrc: number, finalDst: number): void {
    ch.shadowSad = finalSrc;
    // Dest-control mode 3 = "increment and reload on repeat"; the
    // shadow dst is re-latched from `dad` for the next pass.
    if (ch.destControl !== 3) ch.shadowDad = finalDst;
    if (ch.irqOnDone) this.interrupts.raise(IRQ_FOR_CHANNEL[ch.index]!);
    if (!ch.repeat) {
      // Clear enable in CNT_H so the channel reports completion to
      // the cart's polled read.
      ch.control &= ~CNT_ENABLE;
      return;
    }
    // Repeat: count register reloads every cycle (GBATEK: "The word
    // count gets reloaded for all settings of the Repeat bit"). The
    // destination only reloads when destControl===3.
    ch.shadowCnt = ch.unitCount();
    if (ch.destControl === 3) {
      const alignMask = ch.word ? ~3 : ~1;
      ch.shadowDad = (ch.dad & alignMask) | 0;
    }
  }

  serialize(w: GbaStateWriter): void {
    for (const ch of this.channels) {
      w.u32(ch.sad);
      w.u32(ch.dad);
      w.u32(ch.cnt);
      w.u16(ch.control);
      w.u32(ch.shadowSad);
      w.u32(ch.shadowDad);
      w.u32(ch.shadowCnt);
      w.u32(ch.latch);
    }
  }

  deserialize(r: GbaStateReader): void {
    for (const ch of this.channels) {
      ch.sad = r.u32();
      ch.dad = r.u32();
      ch.cnt = r.u32();
      ch.control = r.u16();
      ch.shadowSad = r.u32();
      ch.shadowDad = r.u32();
      ch.shadowCnt = r.u32();
      ch.latch = r.u32();
    }
  }
}

function stepFor(controlBits: number, wordSize: number): number {
  switch (controlBits) {
    case 0:
      return wordSize; // increment
    case 1:
      return -wordSize; // decrement
    case 2:
      return 0; // fixed
    case 3:
      return wordSize; // increment + reload (destination only)
    default:
      return wordSize;
  }
}
