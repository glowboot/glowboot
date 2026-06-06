import type { GbaSioLink } from "../../gba";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { dispatchLinkStatus } from "./link-status.js";

/**
 * GBA Multiplayer-mode link implementation over `BroadcastChannel`.
 * Two to four tabs on the same origin pair up and exchange 16-bit
 * halfwords — enough to trade Pokémon between two copies of
 * Ruby/Sapphire (2P) or play Mario Kart Super Circuit / Bomberman /
 * FFTA at full 4P.
 *
 * Roster + slot allocation:
 *   - Every peer joining the channel announces itself with `hello`
 *     carrying its UUID. Existing peers reply with `hello-ack`,
 *     building a roster shared across all participants.
 *   - Slot IDs are deterministic: peers sort by UUID (lexicographic);
 *     the lowest UUID is slot 0 (parent / master role), the next
 *     three are slots 1-3 (children). A 5th peer is rejected with
 *     a `room-full` message and stays unpaired.
 *   - When the roster mutates, every peer pushes its new slot ID
 *     into Sio via `setMultiplayerSlotId()` so the cart's SIOCNT
 *     read reflects current state.
 *
 * Transfer protocol (cached-state model):
 *   1. Every peer continuously broadcasts its current SIOMLT_SEND
 *      via `state` messages whenever the cart writes that register.
 *      All peers maintain a per-slot cache of the latest received
 *      values.
 *   2. When the master cart pulses SIOCNT.START, `sendAsMaster()`
 *      reads the cache and resolves **synchronously** with the last
 *      known slave SIOMLT_SEND values — the master's cart sees BUSY
 *      clear on its next read, matching the µs-scale completion real
 *      hardware delivers. Lockstep CPU coordination isn't required.
 *   3. After resolving locally, the master broadcasts `multi-result`
 *      with the four-slot snapshot so every slave latches identical
 *      SIOMULTI values via `onTransferComplete()` when the message
 *      lands (asynchronous on slaves; the carts on slave side
 *      typically poll SIOMULTI rather than BUSY).
 *
 * Compared with the original "request/reply round-trip" design that
 * went out as part of the first link-cable cut, this swaps the
 * per-transfer message exchange for a continuous state broadcast.
 * Cartridge polling loops that timed out before the BC round-trip
 * finished (Mario Kart Super Circuit, Tetris Worlds, Bomberman
 * Tournament...) now see synchronous completion on the master.
 */

const CHANNEL_NAME = "glowboot-gba-link";
/** Maximum slots in a Multiplayer ring (= peers in a session). */
const MAX_SLOTS = 4;

type Message =
  | { type: "hello"; from: string }
  | { type: "hello-ack"; from: string; to: string; roster: readonly string[] }
  | { type: "goodbye"; from: string }
  | { type: "room-full"; to: string }
  | { type: "state"; from: string; slot: number; send: number }
  | { type: "multi-result"; from: string; slots: readonly [number, number, number, number] };

export class BroadcastChannelGbaLink implements GbaSioLink {
  private readonly channel: BroadcastChannel;
  private readonly selfId: string;
  /** Roster of all known peers (including self), kept sorted so slot
   *  IDs are stable across all participants for the same membership. */
  private roster: string[];
  private closed = false;

  /** True once we've discovered at least one peer in the channel.
   *  Sio uses this to decide between sending via the transport and
   *  taking the unpaired-hang path. */
  get paired(): boolean {
    return this.roster.length > 1 && this.roster.length <= MAX_SLOTS;
  }

  /** Per-slot queue of peer SIOMLT_SEND broadcasts received since
   *  the master last consumed one. `sendAsMaster` pops one per
   *  transfer so master's N transfers within a packet pair with
   *  the slave's N consecutive SIOMLT_SEND writes in order.
   *  Falls back to `peerLastSeen` when the queue is empty (real
   *  silicon's slave SIOMLT_SEND register stays at its last write
   *  until rewritten; the master keeps reading that value).
   *
   *  A latest-write-wins cache would skip intermediate slave
   *  values when BC delivers a burst (master reads only the final
   *  one), breaking cart handshakes that expect each transfer to
   *  pair with the slave's response written in that step. The
   *  queue preserves ordering; some misalignment can still occur
   *  if slave skips writes between transfers, but matches the
   *  cart's protocol expectations more often. */
  private readonly peerSend = new Map<number, number[]>();
  private readonly peerLastSeen = new Map<number, number>();
  /** Diagnostic counters — bumped from BC dispatch. Exposed via the
   *  `__glowbootGbaLink` window global so a dev-tools session can
   *  read the live state without us having to add UI plumbing. */
  readonly stats = {
    msgsRecv: 0,
    stateMsgs: 0,
    multiResultMsgs: 0,
    msgsSent: 0,
    helloMsgs: 0
  };
  /** Our own most-recent broadcast — dedup so a cart that keeps
   *  re-writing the same value doesn't spam BC. */
  private lastBroadcastSend = -1;

  /** Slave-side handler wired by Sio.setLink(). null until set. */
  private onTransferComplete: ((slot0: number, slot1: number, slot2: number, slot3: number) => void) | null = null;

  constructor() {
    this.selfId = crypto.randomUUID();
    this.roster = [this.selfId];
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.addEventListener("message", (e: MessageEvent<Message>) => this.handle(e.data));
    window.addEventListener("pagehide", () => this.close());
    this.post({ type: "hello", from: this.selfId });
    dispatchLinkStatus("idle");
    this.applySlot();
    // Hang the link on `window.__glowbootGbaLink` so a dev-tools
    // session can inspect roster / counters / cache without UI
    // plumbing. Last-write-wins is fine — only one link exists per tab.
    (window as unknown as { __glowbootGbaLink: BroadcastChannelGbaLink }).__glowbootGbaLink = this;
  }

  // ─── GbaSioLink implementation ─────────────────────────────────────

  setHandlers(handlers: {
    onMasterStart: (masterData: number) => number;
    onTransferComplete: (slot0: number, slot1: number, slot2: number, slot3: number) => void;
  }): void {
    // onMasterStart is unused in the cached-state model — the master
    // resolves synchronously from `peerSend` and the slave latches via
    // the `multi-result` broadcast handler below.
    this.onTransferComplete = handlers.onTransferComplete;
  }

  sendAsMaster(masterSend: number, resolve: (peerSends: readonly [number, number, number]) => void): void {
    if (!this.paired) {
      resolve([0xffff, 0xffff, 0xffff]);
      return;
    }
    // Only slot 0 drives the wire; other peers can't initiate.
    if (this.localSlotId() !== 0) {
      resolve([0xffff, 0xffff, 0xffff]);
      return;
    }
    const s1 = this.popPeer(1);
    const s2 = this.popPeer(2);
    const s3 = this.popPeer(3);
    // Broadcast result so slaves latch the same snapshot. Slaves see
    // this asynchronously when BC delivers the message; master
    // resolves immediately below.
    this.post({
      type: "multi-result",
      from: this.selfId,
      slots: [masterSend & 0xffff, s1, s2, s3]
    });
    resolve([s1, s2, s3]);
  }

  notifySiomltSendChange(value: number): void {
    if (!this.paired) return;
    // Master's SIOMLT_SEND value reaches slaves through slot 0 of
    // every `multi-result` snapshot — slaves don't need separate
    // state broadcasts. Skipping them halves cross-tab BC traffic.
    if (this.localSlotId() === 0) return;
    const v = value & 0xffff;
    // No dedup: the master's per-transfer pop model needs every
    // slave write broadcast so the queue preserves the slave's
    // exact response sequence (the cart's handshake expects each
    // transfer to pair with the slave write that came before it).
    this.lastBroadcastSend = v;
    this.post({ type: "state", from: this.selfId, slot: this.localSlotId(), send: v });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "goodbye", from: this.selfId });
    this.channel.close();
    this.roster = [this.selfId];
    this.peerSend.clear();
    this.peerLastSeen.clear();
  }

  resyncSlot(): void {
    this.applySlot();
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /** Pop next queued slave broadcast for a slot. Falls back to the
   *  last popped value (real silicon's slave SIOMLT_SEND register
   *  retains its last write across multiple transfers; the master
   *  keeps sampling the same value until the slave writes a new
   *  one). Initial fallback is 0xFFFF — "unconnected slot" sentinel. */
  private popPeer(slot: number): number {
    const q = this.peerSend.get(slot);
    if (q && q.length > 0) {
      const v = q.shift()!;
      this.peerLastSeen.set(slot, v);
      return v;
    }
    return this.peerLastSeen.get(slot) ?? 0xffff;
  }

  private localSlotId(): number {
    const idx = this.roster.indexOf(this.selfId);
    return idx < 0 ? 0 : idx;
  }

  /** Push the current slot ID into the active Gba's SIO. The cart
   *  reads it back through SIOCNT bits 4-5. */
  private applySlot(): void {
    state.gba?.sio.setMultiplayerSlotId(this.localSlotId());
  }

  private addPeer(id: string): void {
    if (this.roster.includes(id)) return;
    if (this.roster.length >= MAX_SLOTS) {
      this.post({ type: "room-full", to: id });
      return;
    }
    this.roster = [...this.roster, id].sort();
    this.applySlot();
    if (this.roster.length === 2) {
      toast("GBA link cable connected");
      dispatchLinkStatus("connected");
    } else if (this.roster.length > 2) {
      toast(`GBA link: ${this.roster.length} players paired`);
    }
  }

  private removePeer(id: string): void {
    const idx = this.roster.indexOf(id);
    if (idx < 0) return;
    this.roster.splice(idx, 1);
    this.applySlot();
    if (this.roster.length === 1) {
      toast("GBA link cable disconnected");
      dispatchLinkStatus("idle");
    } else if (this.roster.length >= 2) {
      toast(`GBA link: peer left (${this.roster.length} remaining)`);
    }
  }

  private handle(msg: Message): void {
    if (this.closed) return;
    this.stats.msgsRecv++;
    switch (msg.type) {
      case "hello":
        if (msg.from === this.selfId) return;
        this.stats.helloMsgs++;
        this.addPeer(msg.from);
        // Reply with the full roster so the newcomer can learn about
        // every existing peer at once.
        this.post({ type: "hello-ack", from: this.selfId, to: msg.from, roster: this.roster });
        return;
      case "hello-ack":
        if (msg.to !== this.selfId) return;
        // Merge the sender's roster with ours; sort to stay
        // deterministic across all participants.
        for (const id of msg.roster) this.addPeer(id);
        return;
      case "goodbye":
        this.removePeer(msg.from);
        return;
      case "room-full":
        if (msg.to !== this.selfId) return;
        toast("GBA link room is full (4 players already paired)");
        dispatchLinkStatus("error");
        this.closed = true;
        return;
      case "state": {
        this.stats.stateMsgs++;
        // Peer broadcast its current SIOMLT_SEND. Append to the
        // per-slot queue so master's `sendAsMaster` consumes them
        // in order (see `peerSend` doc).
        if (msg.from === this.selfId) return;
        if (msg.slot < 0 || msg.slot >= MAX_SLOTS) return;
        const v = msg.send & 0xffff;
        const q = this.peerSend.get(msg.slot);
        if (q) q.push(v);
        else this.peerSend.set(msg.slot, [v]);
        return;
      }
      case "multi-result": {
        this.stats.multiResultMsgs++;
        // Slaves latch the master's snapshot. Master ignores (it
        // already resolved synchronously in sendAsMaster).
        if (msg.from === this.selfId) return;
        if (this.roster[0] !== msg.from) return;
        this.onTransferComplete?.(
          msg.slots[0] & 0xffff,
          msg.slots[1] & 0xffff,
          msg.slots[2] & 0xffff,
          msg.slots[3] & 0xffff
        );
        return;
      }
    }
  }

  private post(msg: Message): void {
    this.stats.msgsSent++;
    try {
      this.channel.postMessage(msg);
    } catch {
      /* channel closed mid-send */
    }
  }
}
