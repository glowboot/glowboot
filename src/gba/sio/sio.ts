/**
 * Serial I/O (SIO) — mode-aware register file at 0x04000120-0x0400015F
 * plus a Multiplayer-mode state machine that moves 16-bit data between
 * two GBAs over a host-provided transport. Multiplayer is the only mode
 * that exchanges data with a peer. Normal-8 / Normal-32 have no peer
 * transport, but an internally-clocked transfer still self-completes —
 * BUSY clears and the Serial IRQ fires (the wire reads back all-1s) —
 * so single-unit serial self-tests work. UART / JOY-bus just round-trip
 * their register bits to satisfy the mgba-suite read tests.
 *
 * The GBA has six serial modes selected by RCNT bit 15 / bit 14 and
 * SIOCNT bits 12-13:
 *   - RCNT[15:14] = 10  → General-purpose (G)
 *   - RCNT[15:14] = 11  → JOY-bus         (J)
 *   - RCNT[15]    = 0  → SIOCNT[13:12] selects:
 *       00 → Normal-8   (N8)
 *       01 → Normal-32  (N32)
 *       10 → Multiplayer (M)
 *       11 → UART        (U)
 *
 * Real hardware: the same register address responds with different
 * bits depending on the active mode. mgba-suite-sio-read probes every
 * SIO register slot in every mode and compares against the published
 * mode-keyed constants — a naive store-on-write stub fails most of
 * them because the same write maps to a different read value per mode.
 *
 * Reads are modelled as constant-table lookups keyed by (address,
 * mode), with two narrow exceptions where the test relies on the
 * write going through:
 *   - SIODATA32 (0x120/0x122): echoes the stored value only in N32.
 *   - SIOMLT_SEND / SIODATA8 (0x12A): echoes the stored value in every
 *     mode except UART (which forces 0).
 *
 * Multiplayer-mode transfer flow (2-player; 3/4-player slots latch as
 * 0xFFFF for the unconnected ring):
 *   1. Both clients have written SIOCNT to enter Multiplayer mode and
 *      have set their SIOMLT_SEND (offset 0x12A) to whatever they want
 *      the peer to receive.
 *   2. Whichever client pulses SIOCNT bit 7 (START) first becomes the
 *      master for THIS transfer. The slave's state machine receives
 *      the broadcast via the transport's `onMasterStart` handler.
 *   3. Master sends its SIOMLT_SEND → slave responds with its own.
 *      Both clients latch the four-slot result into SIOMULTI0..3
 *      (slot 0 = master, slot 1 = slave 1, slots 2/3 = 0xFFFF for an
 *      unconnected 3-/4-player ring).
 *   4. SIOCNT bit 7 clears on both sides; if SIOCNT bit 14 is set,
 *      the SIO IRQ fires.
 */

import { type InterruptController, IRQ_SERIAL } from "../memory/interrupts.js";
import { BaseIoHandler } from "../memory/io-handler-base.js";
import type { GbaSioLink } from "./sio-link.js";

/** Register offsets within the SIO handler (base 0x04000120). The
 *  same byte addresses serve two roles in different modes — e.g.
 *  0x00/0x02 is SIODATA32 LO/HI in Normal-32 and SIOMULTI0/1 in
 *  Multiplayer. We keep one set of constants (the Normal-32 names);
 *  the dispatch logic in read16 / write16 branches on the active
 *  mode where the meaning differs. */
const SIODATA32_L = 0x00;
const SIODATA32_H = 0x02;
const SIOMULTI2 = 0x04;
const SIOMULTI3 = 0x06;
const SIOCNT = 0x08;
const SIOMLT_SEND = 0x0a;
const RCNT = 0x14;
const JOYCNT = 0x20;
const JOY_RECV_L = 0x30;
const JOY_RECV_H = 0x32;
const JOY_TRANS_L = 0x34;
const JOY_TRANS_H = 0x36;
const JOYSTAT = 0x38;

/** SIOCNT bits in Multiplayer mode. Bits 4-5 (slot ID) are written
 *  inline by the SIOCNT read path from `this.slotId`; the error flag
 *  (bit 6) isn't surfaced yet but a real cable rarely sets it. Only
 *  BUSY + IRQ need named constants. */
const SIOCNT_BUSY = 1 << 7;
const SIOCNT_IRQ = 1 << 14;

/** CPU-cycle cost of one 2-player Multiplayer transfer at the
 *  fastest baud rate (115200) — ~360 µs on 16.78 MHz silicon.
 *  Scheduling completion this far in the future when the master
 *  cart pulses BUSY=1 keeps the observable BUSY window close to
 *  real-cable timing and throttles the cart's pulse rate so the
 *  BroadcastChannel isn't flooded with `multi-result` messages. */
const MULTI_TRANSFER_CYCLES = 6044;

export type SioMode = "M" | "N8" | "N32" | "U" | "G" | "J";

export class Sio extends BaseIoHandler {
  /** SIODATA32 storage (32 bits, addressable as two halfwords). */
  private siodata32 = 0;
  /** SIOCNT — mode-setting register at offset 0x08. */
  private siocnt = 0;
  /** SIOMLT_SEND / SIODATA8 storage at offset 0x0A. Power-on default
   *  is 0 — cable-detect carts write their own SIOMLT_SEND before
   *  any transfer fires, so the default never reaches the wire in
   *  the cart-driven happy path. */
  private siomltSend = 0;
  /** RCNT — outer mode-select register at offset 0x14. */
  private rcnt = 0;

  /** Multiplayer-mode result slots (SIOMULTI0..3). Power-on default
   *  is 0 — mgba-suite-sio-read's "M: SIOMULTIn" subtests probe
   *  this contract (write 0xFFFF, read back 0 because the slots are
   *  read-only and haven't been latched yet). Latched to per-peer
   *  values (or 0xFFFF for unconnected slots) after each completed
   *  Multiplayer transfer. */
  private siomulti: [number, number, number, number] = [0, 0, 0, 0];

  /** Pending Multiplayer transfer state — cart pulsed START and we
   *  scheduled completion `pendingCycles` ahead. `tick()` decrements
   *  the counter; when it reaches 0 the cached slave values latch
   *  into SIOMULTI, BUSY clears, and IRQ fires (if enabled). Real
   *  hardware's 2-player @ 115200 baud transfer takes ~6000 CPU
   *  cycles — using anything close to that throttles the cart's
   *  pulse rate to a real-cable cadence and stops us from flooding
   *  the BroadcastChannel with thousands of `multi-result` messages
   *  per frame. */
  private pendingCycles = 0;
  private pendingSlots: [number, number, number, number] = [0, 0, 0, 0];

  /** Internally-clocked Normal-mode (Normal-8 / Normal-32) transfer
   *  scheduled to complete `pendingSerialCycles` ahead. There's no
   *  transport for these modes, so the line floats high and the
   *  received word reads back all-1s; on completion BUSY clears and the
   *  Serial IRQ fires (if armed). Scheduled rather than synchronous so
   *  BUSY survives the read-back mgba-suite-sio-read does right after
   *  the START write. */
  private pendingSerialCycles = 0;
  private pendingSerial32 = false;

  /** Slave-side queue of multi-results delivered by the transport
   *  faster than the cart could consume them. Each entry is a four-
   *  slot snapshot; `tick()` pops one per `MULTI_TRANSFER_CYCLES`
   *  window so the cart's IRQ handler runs once per transfer (not
   *  once per "burst of transfers"). Without this, when the master
   *  fires N transfers in rapid succession during its frame, all N
   *  multi-results arrive at the slave at once: latching them
   *  individually would clobber the intermediate SIOMULTI values
   *  and the cart's handler would only ever see the final transfer.
   *  Real silicon paces transfers by the wire's baud rate; this
   *  queue paces the slave's view of them by the same window. */
  private slaveQueue: Array<[number, number, number, number]> = [];
  private slaveDeliveryCycles = 0;

  /** Active link transport, or null when running unpaired. Set by
   *  the host via `setLink()`; null means "no peer" and SIOMULTIn
   *  reads return 0xFFFF on transfer completion. */
  private link: GbaSioLink | null = null;

  /** Player slot ID for Multiplayer-mode transfers (0 = master /
   *  parent, 1-3 = slave / child). Wired by the link transport when
   *  the peer roster is established. Cart reads this back through
   *  SIOCNT bits 4-5 to know its role; staying 0 with no link means
   *  "unpaired master" which is what a disconnected cable looks like. */
  private slotId = 0;

  /** Interrupt controller — Sio raises IRQ_SERIAL when a Multiplayer
   *  transfer completes and SIOCNT.IRQ is set. Wired by Gba. */
  interrupts: InterruptController | null = null;

  /** Flips true on actual SIO transfer activity — master pulsing
   *  BUSY 0→1 (initiating a transfer) or slave receiving a multi-
   *  result delivery from the transport. The browser runtime
   *  reads + clears this once per chunk to decide whether to yield
   *  to the task queue (drains BC for the peer tab) or skip the
   *  yield (peer has nothing time-sensitive to deliver, so spending
   *  ~ms on yielding is pure overhead).
   *
   *  Deliberately NOT set on cart writes to SIOCNT-without-BUSY-
   *  pulse, SIOMLT_SEND, or RCNT — cable-detect carts poll those
   *  registers many times per frame even when the link is idle
   *  (e.g. menu screens). The flag should mean "real transfer
   *  activity", not "cart looked at the SIO register file". */
  activityFlag = false;

  /** Decide the active SIO mode from RCNT bits 14-15 and (when RCNT
   *  bit 15 is clear) SIOCNT bits 12-13. */
  private get mode(): SioMode {
    const rcntHi = (this.rcnt >>> 14) & 3;
    if (rcntHi === 2) return "G";
    if (rcntHi === 3) return "J";
    switch ((this.siocnt >>> 12) & 3) {
      case 0:
        return "N8";
      case 1:
        return "N32";
      case 2:
        return "M";
      default:
        return "U";
    }
  }

  /** Wire (or unwire) the host-side transport. The transport calls
   *  back into the Sio via `onMasterStart` / `onTransferComplete`
   *  when peer events arrive. */
  setLink(link: GbaSioLink | null): void {
    if (this.link) this.link.close();
    this.link = link;
    if (link === null) {
      this.slotId = 0;
      return;
    }
    link.setHandlers({
      onMasterStart: (masterSend) => this.onPeerMasterStart(masterSend),
      onTransferComplete: (s0, s1, s2, s3) => this.onTransferComplete(s0, s1, s2, s3)
    });
    // Pull the link's current slot ID into our fresh Sio. Without
    // this, a cart reload that re-wires an already-paired link
    // leaves slotId at the default 0 — the link only pushes it on
    // roster changes, and the new Sio missed every prior change.
    // Both peers then read SIOCNT as slot 0 and the cart's
    // master/slave branch decision desyncs (cable detect succeeds,
    // game-start shows "COMMUNICATION ERROR — TRY AGAIN").
    link.resyncSlot();
  }

  /** Called by the transport whenever the peer roster changes and
   *  the player's slot ID gets reassigned. Cart sees the new value
   *  on its next SIOCNT read. Values: 0 = parent (master), 1-3 = the
   *  three child slots. */
  setMultiplayerSlotId(slotId: number): void {
    this.slotId = slotId & 3;
    // Pairing state just changed (this is how the link tells us a
    // peer joined or left). Push our current SIOMLT_SEND so the
    // peer's master-side cache picks up our value even if the cart
    // never actually writes the register — slave carts that just
    // sit on the default 0 and respond via IRQ are the common case.
    this.link?.notifySiomltSendChange(this.siomltSend);
  }

  read16(offset: number): number {
    const aligned = offset & ~1;
    const mode = this.mode;
    // In Multiplayer mode the same address range that's "SIODATA32"
    // in Normal-32 is "SIOMULTI0..1" — both read from `siomulti`.
    if (mode === "M") {
      switch (aligned) {
        case SIODATA32_L:
          return this.siomulti[0]!;
        case SIODATA32_H:
          return this.siomulti[1]!;
        case SIOMULTI2:
          return this.siomulti[2]!;
        case SIOMULTI3:
          return this.siomulti[3]!;
      }
    }
    switch (aligned) {
      case SIODATA32_L:
        // Only Normal-32 exposes the stored 32-bit value; every other
        // non-Multiplayer mode treats the read as a closed bus.
        return mode === "N32" ? this.siodata32 & 0xffff : 0;
      case SIODATA32_H:
        return mode === "N32" ? (this.siodata32 >>> 16) & 0xffff : 0;
      case SIOMULTI2:
      case SIOMULTI3:
        return 0;
      case SIOCNT: {
        // Writable mask 0x7F8F (bits 4-6, 8-13 are R/W; bit 14 = IRQ
        // enable, bit 15 reserved). UART mode forces bit 5 (FIFO empty).
        // Multiplayer mode always overlays the slot ID (bits 4-5) read-
        // only; when a peer is paired we additionally synthesise SI
        // (bit 2, 0=parent / 1=child) and SD (bit 3, 1=all GBAs ready)
        // so the cart can detect cable presence. With no peer we leave
        // those two bits at whatever the cart wrote — preserves
        // mgba-suite-sio-read's expectation that bits 2-3 are part of
        // the writable mask in single-GBA mode.
        // NOTE: do NOT force bit 14 here — it's the cart's IRQ-enable
        // bit, R/W. Forcing it to 1 makes carts that polled (Mario Kart
        // Super Circuit, Tetris Worlds, ...) read back IRQ-enabled and
        // wait forever for an IRQ they never armed.
        let v = this.siocnt & 0x7f8f;
        if (mode === "U") v |= 0x0020;
        if (mode === "M") {
          v = (v & ~0x0030) | ((this.slotId & 3) << 4);
          if (this.link?.paired === true) {
            v = (v & ~0x000c) | 0x0008;
            if (this.slotId !== 0) v |= 0x0004;
          }
        }
        return v;
      }
      case SIOMLT_SEND:
        return mode === "U" ? 0 : this.siomltSend & 0xffff;
      case RCNT: {
        // Bits 14-15 reflect the stored mode-select; the low half is a
        // mode-specific constant.
        const hi = this.rcnt & 0xc000;
        switch (mode) {
          case "N8":
          case "N32":
            return hi | 0x01f5;
          case "J":
            return hi | 0x01fc;
          case "M":
          case "U":
          case "G":
          default:
            return hi | 0x01ff;
        }
      }
      case JOYCNT:
        // JOY-bus control: bit 6 ("device ID inverter") reads as 1.
        return 0x0040;
      case JOY_RECV_L:
      case JOY_RECV_H:
      case JOY_TRANS_L:
      case JOY_TRANS_H:
      case JOYSTAT:
        return 0;
      default:
        return 0;
    }
  }

  write16(offset: number, value: number): void {
    const aligned = offset & ~1;
    const v = value & 0xffff;
    const mode = this.mode;
    switch (aligned) {
      case SIODATA32_L:
        // In Multiplayer mode this slot is read-only (SIOMULTI0);
        // writes only do something in Normal-32.
        if (mode === "N32") this.siodata32 = (this.siodata32 & 0xffff0000) | v;
        return;
      case SIODATA32_H:
        if (mode === "N32") this.siodata32 = (this.siodata32 & 0xffff) | ((v << 16) >>> 0);
        return;
      case SIOCNT: {
        const wasBusy = (this.siocnt & SIOCNT_BUSY) !== 0;
        this.siocnt = v;
        // Multiplayer mode: a 0→1 transition of START (= BUSY) on the
        // master triggers a fresh transfer. If no link or no peer,
        // the transfer immediately "completes" with all-0xFFFF in
        // unconnected slots, matching a disconnected cable.
        // Re-read `mode` after the write: carts can switch to Multi
        // mode AND pulse BUSY in a single 16-bit write (`SIOCNT =
        // 0x2080`); using the pre-write mode would miss that case.
        const newMode = this.mode;
        if (newMode === "M" && !wasBusy && (v & SIOCNT_BUSY) !== 0) {
          // Real transfer activity — set the flag the host runtime
          // polls to decide whether to yield to the task queue this
          // chunk. (See `activityFlag` doc.)
          this.activityFlag = true;
          this.startMultiplayerTransfer();
        }
        // Normal-8 / Normal-32 with an INTERNAL clock (bit 0 = 1): on
        // real silicon the shift register clocks itself, so the transfer
        // always completes after the shift duration even with nothing
        // connected — the line floats high (received word all-1s) — then
        // clears BUSY and raises the Serial IRQ if armed. Schedule it via
        // tick() so BUSY is still set for the immediate read-back that
        // mgba-suite-sio-read performs. Used by carts that self-test the
        // serial IRQ on a single unit (e.g. the AGB aging cartridge).
        // External clock (bit 0 = 0) has no internal timer, so BUSY stays
        // set until a partner clocks it — matching a disconnected port.
        // UART / JOY-bus still have no transport (GameCube / e-Reader),
        // so they keep the disconnected-hang behaviour.
        if ((newMode === "N8" || newMode === "N32") && !wasBusy && (v & SIOCNT_BUSY) !== 0 && (v & 0x0001) !== 0) {
          this.pendingSerial32 = newMode === "N32";
          const cyclesPerBit = (v & 0x0002) !== 0 ? 8 : 64; // SIOCNT bit 1: 2 MHz vs 256 KHz
          this.pendingSerialCycles = cyclesPerBit * (newMode === "N32" ? 32 : 8);
        }
        return;
      }
      case SIOMLT_SEND:
        this.siomltSend = v;
        // Tell the transport so it can broadcast this slot's current
        // outgoing value to peers — that cache is what every other
        // peer's master path reads from when its transfer fires.
        this.link?.notifySiomltSendChange(v);
        return;
      case RCNT:
        this.rcnt = v;
        return;
      default:
        return;
    }
  }

  /** Master-side transfer kick-off. Called when the cart writes
   *  SIOCNT.BUSY=1 in Multiplayer mode. */
  private startMultiplayerTransfer(): void {
    // Force the result slots to 0xFFFF during the in-flight transfer —
    // real hardware does this between START and IRQ.
    this.siomulti = [0xffff, 0xffff, 0xffff, 0xffff];

    if (this.link === null || !this.link.paired) {
      // No peer to respond: BUSY stays set, no IRQ, no result-slot
      // latch. The cart's spin-on-IRQ wait hangs — same observable
      // behaviour as a disconnected cable on real silicon. (mgba-
      // suite-sio-read probes the register-readback contract in this
      // exact state; auto-completing the transfer here would clear
      // BUSY before the test reads it back and the suite would
      // regress 90 → 89.)
      return;
    }

    // Only the cable's parent (slot 0) drives the wire. A slave that
    // writes START is a no-op on real silicon — BUSY stays set until
    // the master pulses START, at which point onPeerMasterStart
    // delivers the transfer to this slave. Without this guard the
    // slave's own START pulse "completes" locally with all-0xFFFF
    // slaves, the cart reads SIOMULTI1 = 0xFFFF and concludes no
    // peer is connected.
    if (this.slotId !== 0) return;

    this.link.sendAsMaster(this.siomltSend, ([s1, s2, s3]) => {
      // Don't latch yet — stash the snapshot and schedule completion
      // ~6000 cycles ahead so the cart sees BUSY=1 for a realistic
      // duration. tick() will fire onTransferComplete when the
      // counter expires. The 6044-cycle figure tracks 2-player @
      // 115200 baud and keeps the master from pulsing BUSY
      // thousands of times per frame.
      this.pendingSlots = [this.siomltSend, s1, s2, s3];
      this.pendingCycles = MULTI_TRANSFER_CYCLES;
    });
  }

  /** Called from `Gba.runFrame()` for every chunk of CPU cycles
   *  advanced. Drives the pending-Multiplayer-transfer timer so
   *  BUSY/SIOMULTI/IRQ all fire on a real-cable cadence rather than
   *  synchronously with the cart's BUSY=1 write. */
  tick(cycles: number): void {
    // Let SAB-backed transports check their shared-memory state for
    // any incoming transfers. No-op on push-based transports
    // (BroadcastChannel, WebRTC) — they deliver via their own event
    // handlers.
    this.link?.poll?.();
    if (this.pendingCycles > 0) {
      this.pendingCycles -= cycles;
      if (this.pendingCycles <= 0) {
        this.pendingCycles = 0;
        const [s0, s1, s2, s3] = this.pendingSlots;
        this.latchTransfer(s0, s1, s2, s3);
      }
    }
    if (this.pendingSerialCycles > 0) {
      this.pendingSerialCycles -= cycles;
      if (this.pendingSerialCycles <= 0) {
        this.pendingSerialCycles = 0;
        this.completeNormalTransfer();
      }
    }
    if (this.slaveQueue.length > 0) {
      this.slaveDeliveryCycles -= cycles;
      if (this.slaveDeliveryCycles <= 0) {
        this.slaveDeliveryCycles = MULTI_TRANSFER_CYCLES;
        const [s0, s1, s2, s3] = this.slaveQueue.shift()!;
        this.latchTransfer(s0, s1, s2, s3);
      }
    }
  }

  /** Cycles until the next scheduled transfer completion (master
   *  `pendingCycles` or queued slave delivery) — both latch registers
   *  and can raise IRQ_SERIAL, so `Gba.runFrame`'s batched peripheral
   *  ticking must flush at exactly that boundary. Returns a large
   *  sentinel when nothing is scheduled. Queue entries that arrive
   *  asynchronously mid-batch are bounded by the batcher's 256-cycle
   *  cap, well under cross-tab transport jitter. */
  cyclesToNextEvent(): number {
    let min = 0x7fffffff;
    if (this.pendingCycles > 0) min = this.pendingCycles;
    if (this.pendingSerialCycles > 0 && this.pendingSerialCycles < min) min = this.pendingSerialCycles;
    if (this.slaveQueue.length > 0 && this.slaveDeliveryCycles < min) min = this.slaveDeliveryCycles;
    return min < 1 ? 1 : min;
  }

  /** Final latch step shared by master (fires from `tick()`) and slave
   *  (fires from `tick()` after the multi-result broadcast scheduled
   *  its own pendingCycles countdown). Writes SIOMULTI, clears BUSY,
   *  raises the SIO IRQ when enabled. */
  private latchTransfer(slot0: number, slot1: number, slot2: number, slot3: number): void {
    this.siomulti = [slot0 & 0xffff, slot1 & 0xffff, slot2 & 0xffff, slot3 & 0xffff];
    this.siocnt &= ~SIOCNT_BUSY;
    // Real transfer activity — IRQ handler about to fire on the
    // slave (or master polls BUSY=0 and reads SIOMULTI on the
    // master). The host runtime's yield-on-activity gate uses this
    // to decide whether this chunk needs a BC drain before the next
    // one. Without flagging here, slave-side broadcasts from the
    // IRQ handler's SIOMLT_SEND write don't reach the master tab
    // until the next time something else flips the flag.
    this.activityFlag = true;
    if ((this.siocnt & SIOCNT_IRQ) !== 0) this.interrupts?.raise(IRQ_SERIAL);
  }

  /** Finish an internally-clocked Normal-mode transfer. Nothing is
   *  connected, so the received word reads back all-1s; clear BUSY and
   *  raise the Serial IRQ when armed — the Normal-mode counterpart of
   *  `latchTransfer`. */
  private completeNormalTransfer(): void {
    if (this.pendingSerial32) this.siodata32 = 0xffffffff;
    else this.siomltSend = 0xff; // SIODATA8 holds the received (high) line
    this.siocnt &= ~SIOCNT_BUSY;
    this.activityFlag = true;
    if ((this.siocnt & SIOCNT_IRQ) !== 0) this.interrupts?.raise(IRQ_SERIAL);
  }

  /** Slave-side: transport delivered a peer-master-start. Respond
   *  with our current `SIOMLT_SEND`. The transport will follow up
   *  with `onTransferComplete` once it has gathered all responses. */
  private onPeerMasterStart(_masterSend: number): number {
    // The slave participates with its currently-staged value. The
    // peer's master-send value is delivered to us via the eventual
    // `onTransferComplete(slot0=master, slot1=ours, ...)` call, so we
    // don't need to act on it here directly.
    // Mark the slave's BUSY bit set during the transfer so the cart's
    // polled wait-for-busy loop sees the in-flight state.
    this.siocnt |= SIOCNT_BUSY;
    this.siomulti = [0xffff, 0xffff, 0xffff, 0xffff];
    return this.siomltSend;
  }

  /** Called when the transport delivers a `multi-result` from the
   *  master. The master fires its own latch directly from `tick()`
   *  when its `pendingCycles` counter expires (the START→IRQ
   *  window), but for a slave we queue the result so `tick()` can
   *  pace the deliveries one-per-transfer-window. Without that
   *  pacing, when the master pulses BUSY N times in rapid
   *  succession during its frame, all N multi-results arrive at
   *  the slave at once and only the final one's SIOMULTI snapshot
   *  survives — the cart's IRQ handler sees the last transfer but
   *  not the N−1 intermediate ones. */
  private onTransferComplete(slot0: number, slot1: number, slot2: number, slot3: number): void {
    this.activityFlag = true;
    if (this.slotId !== 0) {
      this.slaveQueue.push([slot0 & 0xffff, slot1 & 0xffff, slot2 & 0xffff, slot3 & 0xffff]);
      if (this.slaveDeliveryCycles <= 0) this.slaveDeliveryCycles = MULTI_TRANSFER_CYCLES;
      return;
    }
    this.latchTransfer(slot0, slot1, slot2, slot3);
  }

  // ─── Multiplayer-mode helpers exposed for the transport ─────────
  // The transport sometimes needs to peek at the cart's currently-
  // staged outgoing value (so it can answer a peer-master-start
  // synchronously). The Sio's `onMasterStart` handler already returns
  // this, but the helpers below make it queryable for tests.

  /** Currently-staged outgoing value for the next Multiplayer slot
   *  (master if this client initiates, slave-1 if a peer does). */
  get currentSendData(): number {
    return this.siomltSend;
  }

  /** True if the cart has selected Multiplayer mode and is ready to
   *  participate (paired and not mid-error). */
  get inMultiplayerMode(): boolean {
    return this.mode === "M";
  }
}
