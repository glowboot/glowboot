import type { SerialLink } from "../../gb";
import { toast } from "../hud/toast.js";
import { dispatchLinkStatus } from "./link-status.js";

/**
 * Link-cable implementation over `BroadcastChannel`. Two tabs on the
 * same origin (e.g. the deployed glowboot.pages.dev) can pair up and
 * exchange serial bytes, which is enough to play 2-player Tetris or
 * trade Pokémon between two copies of the same ROM.
 *
 * Protocol is deliberately minimal — a single channel carries every
 * message type, with UUIDs scoping "is this for me?" and "which
 * transfer is this a reply to?" checks. No heartbeat; the `close`
 * handler fires a goodbye on pagehide so the partner UI can clear.
 */

const CHANNEL_NAME = "gameboy-emulator-link";

type Message =
  | { type: "hello"; from: string }
  | { type: "hello-ack"; from: string; to: string }
  | { type: "goodbye"; from: string }
  | { type: "transfer"; from: string; to: string; seq: number; byte: number }
  | { type: "transfer-reply"; from: string; to: string; seq: number; byte: number };

export class BroadcastChannelLink implements SerialLink {
  private readonly channel: BroadcastChannel;
  private readonly selfId: string;
  private peerId: string | null = null;

  /** Local same-origin pairing — the channel posts run on the main
   *  thread's microtask queue, so RTT is sub-millisecond. The MMU's
   *  default 1 ms transfer timeout is plenty; no need to widen it. */
  readonly paired = false;
  private peerHandler: ((peerByte: number) => number) | null = null;

  /** Pending master-transfer resolvers keyed by sequence id. Populated
   *  when we send; fired when the peer replies. Dropped on disconnect
   *  (MMU's fallback timer then times them out with 0xFF). */
  private readonly pending = new Map<number, (peerByte: number) => void>();
  private nextSeq = 1;
  private closed = false;

  constructor() {
    this.selfId = crypto.randomUUID();
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.addEventListener("message", (e: MessageEvent<Message>) => this.handle(e.data));
    window.addEventListener("pagehide", () => this.close());
    this.post({ type: "hello", from: this.selfId });
    dispatchLinkStatus("idle");
  }

  // ─── SerialLink implementation ─────────────────────────────────────

  sendAsMaster(byte: number, resolve: (peerByte: number) => void): void {
    if (!this.peerId) {
      resolve(0xff); // unpaired — mimic unplugged cable
      return;
    }
    const seq = this.nextSeq++;
    this.pending.set(seq, resolve);
    this.post({ type: "transfer", from: this.selfId, to: this.peerId, seq, byte });
    // Safety net: if the peer disappears between sending and replying,
    // drop the resolver after a generous timeout so we don't leak —
    // MMU's own timer (4096 T ≈ 1 ms game-time) will have already
    // fired 0xFF by then.
    setTimeout(() => {
      const r = this.pending.get(seq);
      if (r) {
        this.pending.delete(seq);
        r(0xff);
      }
    }, 500);
  }

  onPeerInitiated(handler: (peerByte: number) => number): void {
    this.peerHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "goodbye", from: this.selfId });
    // Resolve any outstanding master transfers so the engine unsticks.
    for (const [seq, r] of this.pending) {
      r(0xff);
      this.pending.delete(seq);
    }
    this.channel.close();
    this.peerId = null;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private handle(msg: Message): void {
    if (this.closed) return;
    switch (msg.type) {
      case "hello":
        // Someone's looking for a partner. Don't steal an existing
        // pairing; if we already have a peer, ignore. Otherwise reply
        // with hello-ack — first to respond wins the pairing.
        if (msg.from === this.selfId) return;
        if (this.peerId) return;
        this.peerId = msg.from;
        this.post({ type: "hello-ack", from: this.selfId, to: msg.from });
        toast("Link cable connected");
        dispatchLinkStatus("connected");
        return;
      case "hello-ack":
        if (msg.to !== this.selfId) return;
        if (this.peerId) return; // already paired via a concurrent hello
        this.peerId = msg.from;
        toast("Link cable connected");
        dispatchLinkStatus("connected");
        return;
      case "goodbye":
        if (msg.from !== this.peerId) return;
        this.peerId = null;
        toast("Link cable disconnected");
        dispatchLinkStatus("idle");
        return;
      case "transfer": {
        if (msg.to !== this.selfId) return;
        if (msg.from !== this.peerId) return; // stray message from a different pair
        const handler = this.peerHandler;
        const reply = handler ? handler(msg.byte & 0xff) : 0xff;
        this.post({
          type: "transfer-reply",
          from: this.selfId,
          to: msg.from,
          seq: msg.seq,
          byte: reply & 0xff
        });
        return;
      }
      case "transfer-reply": {
        if (msg.to !== this.selfId) return;
        const resolver = this.pending.get(msg.seq);
        if (!resolver) return;
        this.pending.delete(msg.seq);
        resolver(msg.byte & 0xff);
        return;
      }
    }
  }

  private post(msg: Message): void {
    try {
      this.channel.postMessage(msg);
    } catch {
      /* channel closed mid-send */
    }
  }
}
