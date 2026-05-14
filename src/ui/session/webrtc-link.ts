import type { SerialLink } from "../../gb";
import { toast } from "../hud/toast.js";
import { dispatchLinkStatus } from "./link-status.js";

/**
 * Remote link-cable implementation. Two peers connect a WebSocket to a
 * room-coded relay (separate repo / Worker; URL comes in via
 * `VITE_LINK_RELAY_URL`); the relay pairs them and forwards messages
 * verbatim. We use the WebSocket for signalling only — once
 * the peers exchange SDP offer/answer + ICE candidates, an
 * `RTCDataChannel` opens and serial bytes flow peer-to-peer over UDP.
 *
 * The class degrades gracefully:
 *   - If signalling stalls or the DataChannel never opens (~8 s budget,
 *     covers most NAT-traversal failures), we keep routing bytes
 *     through the WebSocket relay — guest's `SerialLink` never sees
 *     the difference, just higher latency.
 *   - If the DataChannel opens, every transfer thereafter routes
 *     through it, dropping the per-byte server hop.
 *
 * The relay is protocol-agnostic — it forwards arbitrary JSON. So the
 * `rtc-offer`/`rtc-answer`/`rtc-ice` signalling payloads coexist with
 * the relay-mode `transfer`/`transfer-reply` traffic on the same
 * socket without any server-side parsing.
 */

type RelayMsg = { type: "transfer"; seq: number; byte: number } | { type: "transfer-reply"; seq: number; byte: number };

type SignalMsg =
  | { type: "rtc-offer"; sdp: string }
  | { type: "rtc-answer"; sdp: string }
  | { type: "rtc-ice"; candidate: RTCIceCandidateInit | null };

type RoomMsg =
  | { type: "joined"; paired: boolean }
  | { type: "peer-joined" }
  | { type: "peer-left" }
  | { type: "room-full" };

type WireMsg = RoomMsg | RelayMsg | SignalMsg;

/** Time we wait for the DataChannel to open after both peers are
 *  signalling-paired. If the deadline elapses we just keep using the
 *  WebSocket relay — bytes still flow, latency is just higher. */
const DC_UPGRADE_BUDGET_MS = 8000;

/** Default ICE-server set: Google's free STUN. Most home / mobile
 *  connections punch through with just this; adding TURN would catch
 *  the remaining ~5-10 % behind symmetric NATs but costs bandwidth. */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class WebRTCLink implements SerialLink {
  private socket: WebSocket | null = null;
  private wsPaired = false;

  /** Network link — RTT is 5-50 ms even peer-to-peer, far longer than
   *  the Game Boy's nominal 1 ms byte time. Tells the MMU to widen its
   *  master-transfer timeout so the peer's reply arrives before we
   *  fall back to 0xFF. */
  readonly paired = true;
  private peerHandler: ((peerByte: number) => number) | null = null;
  private readonly pending = new Map<number, (peerByte: number) => void>();
  private nextSeq = 1;
  private closed = false;

  /** Bumped on every reconnect attempt so a slow `open` callback from
   *  an earlier socket can't mutate state belonging to the new one. */
  private generation = 0;
  private reconnectTimer: number | null = null;

  // ─── RTC state ─────────────────────────────────────────────────────
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private dcOpen = false;

  /** True if we're the SDP offerer (the peer that was already in the
   *  room when the second one joined). The second peer creates an
   *  answer in response. */
  private isOfferer = false;
  private upgradeTimer: number | null = null;

  constructor(
    private readonly roomCode: string,
    private readonly relayBaseUrl: string
  ) {
    dispatchLinkStatus("idle");
    this.open();
  }

  // ─── SerialLink implementation ─────────────────────────────────────

  sendAsMaster(byte: number, resolve: (peerByte: number) => void): void {
    if (!this.wsPaired) {
      resolve(0xff); // not yet paired — mimic unplugged cable
      return;
    }
    const seq = this.nextSeq++;
    this.pending.set(seq, resolve);
    this.sendRelay({ type: "transfer", seq, byte });
    // Wall-clock safety net: if the relay drops our message or the
    // peer vanishes between send and reply, we resolve with 0xFF after
    // two seconds. Generous — internet round-trips vary wildly. The
    // game's serial IRQ has already fired by then; guest just sees an
    // empty exchange.
    setTimeout(() => {
      const r = this.pending.get(seq);
      if (r) {
        this.pending.delete(seq);
        r(0xff);
      }
    }, 2000);
  }

  onPeerInitiated(handler: (peerByte: number) => number): void {
    this.peerHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.upgradeTimer !== null) {
      clearTimeout(this.upgradeTimer);
      this.upgradeTimer = null;
    }
    this.teardownRtc();
    try {
      this.socket?.close(1000, "client closing");
    } catch {
      /* already closed */
    }
    this.socket = null;
    for (const [seq, r] of this.pending) {
      r(0xff);
      this.pending.delete(seq);
    }
  }

  // ─── Signalling socket ─────────────────────────────────────────────

  private open(): void {
    if (this.closed) return;
    this.generation++;
    const gen = this.generation;
    const wss = this.relayBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
    const url = `${wss}/link/${encodeURIComponent(this.roomCode)}`;
    let s: WebSocket;
    try {
      s = new WebSocket(url);
    } catch (err) {
      console.warn("[Link/RTC] socket construct failed:", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = s;
    s.addEventListener("message", (e: MessageEvent<string>) => {
      if (gen !== this.generation) return;
      try {
        const msg = JSON.parse(e.data) as WireMsg;
        this.handleWire(msg);
      } catch (err) {
        console.warn("[Link/RTC] bad message:", err);
      }
    });
    s.addEventListener("close", () => {
      if (gen !== this.generation) return;
      if (this.wsPaired) {
        this.wsPaired = false;
        toast("Link cable disconnected");
        dispatchLinkStatus("idle");
      }
      this.teardownRtc();
      for (const [seq, r] of this.pending) {
        r(0xff);
        this.pending.delete(seq);
      }
      this.scheduleReconnect();
    });
    s.addEventListener("error", () => {
      /* close handler does cleanup */
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 2000);
  }

  // ─── Wire-message dispatch ─────────────────────────────────────────

  private handleWire(msg: WireMsg): void {
    switch (msg.type) {
      case "joined":
        // `paired` is true when we're the second arrival — the room
        // already had a peer waiting. By convention the *first* peer
        // (paired: false) becomes the offerer; we wait for their offer.
        this.wsPaired = msg.paired;
        this.isOfferer = !msg.paired;
        if (msg.paired) {
          toast("Link cable connected");
          dispatchLinkStatus("connected");
          // Joining a paired room → spin up RTC; the existing peer
          // (offerer) will start the SDP exchange when they receive
          // their `peer-joined`.
          this.beginRtcUpgrade();
        }
        return;
      case "peer-joined":
        this.wsPaired = true;
        toast("Link cable connected");
        dispatchLinkStatus("connected");
        // Peer just arrived → we're the offerer; kick off the SDP
        // exchange.
        this.beginRtcUpgrade();
        return;
      case "peer-left":
        this.wsPaired = false;
        toast("Link cable disconnected");
        dispatchLinkStatus("idle");
        this.teardownRtc();
        for (const [seq, r] of this.pending) {
          r(0xff);
          this.pending.delete(seq);
        }
        return;
      case "room-full":
        toast("Link room is full (2 players already connected)");
        dispatchLinkStatus("error");
        this.closed = true; // don't reconnect into a full room
        return;
      case "transfer":
      case "transfer-reply":
        // Relay-mode transfers — used before the DataChannel upgrades
        // or after it drops. Same handler as the DC path below.
        this.handleRelay(msg);
        return;
      case "rtc-offer":
      case "rtc-answer":
      case "rtc-ice":
        void this.handleSignal(msg);
        return;
    }
  }

  private handleRelay(msg: RelayMsg): void {
    switch (msg.type) {
      case "transfer": {
        const reply = this.peerHandler ? this.peerHandler(msg.byte & 0xff) : 0xff;
        this.sendRelay({ type: "transfer-reply", seq: msg.seq, byte: reply & 0xff });
        return;
      }
      case "transfer-reply": {
        const resolver = this.pending.get(msg.seq);
        if (!resolver) return;
        this.pending.delete(msg.seq);
        resolver(msg.byte & 0xff);
        return;
      }
    }
  }

  // ─── RTC negotiation ───────────────────────────────────────────────

  private beginRtcUpgrade(): void {
    if (this.pc || typeof RTCPeerConnection === "undefined") return;
    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    this.pc.addEventListener("icecandidate", (e) => {
      // `null` candidate fires when ICE gathering is done. Forwarding
      // it lets the peer end-of-candidates correctly; some browsers
      // need that to finalise their connection state.
      this.safeSocketSend({ type: "rtc-ice", candidate: e.candidate?.toJSON() ?? null });
    });
    this.pc.addEventListener("connectionstatechange", () => {
      const st = this.pc?.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        // Drop the channel so byte traffic falls back to the WS relay.
        // We do *not* close the WebSocket — the user's still paired.
        this.demoteRtc();
      }
    });
    this.pc.addEventListener("datachannel", (e) => {
      if (this.isOfferer) return; // we created our own
      this.attachDataChannel(e.channel);
    });

    if (this.isOfferer) {
      // Offerer creates the DC + initial offer. Reliable + ordered
      // (`ordered: true` is the default) so the per-byte
      // request/response protocol works without retransmit logic.
      const dc = this.pc.createDataChannel("link", { ordered: true });
      this.attachDataChannel(dc);
      void this.makeOffer();
    }

    // Whether or not the DC opens, give it a fixed budget — after that
    // we'll keep using the WS relay regardless. No need to tear down
    // the PC; if it eventually connects later we'll happily upgrade.
    this.upgradeTimer = window.setTimeout(() => {
      this.upgradeTimer = null;
      if (!this.dcOpen) {
        console.debug("[Link/RTC] upgrade budget elapsed — staying on WS relay");
      }
    }, DC_UPGRADE_BUDGET_MS);
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.addEventListener("open", () => {
      this.dcOpen = true;
      // Cancel the upgrade-budget warning — we made it.
      if (this.upgradeTimer !== null) {
        clearTimeout(this.upgradeTimer);
        this.upgradeTimer = null;
      }
      console.debug("[Link/RTC] DataChannel open — bytes now flowing P2P");
    });
    dc.addEventListener("close", () => {
      this.dcOpen = false;
    });
    dc.addEventListener("message", (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as RelayMsg;
        // Same relay-side handling — the message shape is identical
        // to what flows over the WS. Only the transport is different.
        this.handleRelay(msg);
      } catch (err) {
        console.warn("[Link/RTC] bad DC message:", err);
      }
    });
  }

  private async makeOffer(): Promise<void> {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.safeSocketSend({ type: "rtc-offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      console.warn("[Link/RTC] offer failed:", err);
    }
  }

  private async handleSignal(msg: SignalMsg): Promise<void> {
    if (!this.pc) {
      // Spin up the PC lazily if a signal arrives before our own
      // `peer-joined`/`joined-paired` (timing race on slow networks).
      this.beginRtcUpgrade();
      if (!this.pc) return;
    }
    try {
      switch (msg.type) {
        case "rtc-offer":
          await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          {
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.safeSocketSend({ type: "rtc-answer", sdp: answer.sdp ?? "" });
          }
          return;
        case "rtc-answer":
          await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          return;
        case "rtc-ice":
          if (msg.candidate) await this.pc.addIceCandidate(msg.candidate);
          return;
      }
    } catch (err) {
      console.warn("[Link/RTC] signal apply failed:", err);
    }
  }

  private demoteRtc(): void {
    this.dcOpen = false;
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
    this.dc = null;
  }

  private teardownRtc(): void {
    if (this.upgradeTimer !== null) {
      clearTimeout(this.upgradeTimer);
      this.upgradeTimer = null;
    }
    this.demoteRtc();
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.pc = null;
    this.isOfferer = false;
  }

  // ─── Send helpers ──────────────────────────────────────────────────

  private sendRelay(msg: RelayMsg): void {
    // Prefer DC when open; fall back to WS otherwise. Both transports
    // carry identical JSON, so the peer-side handlers don't care which
    // one delivered it.
    if (this.dcOpen && this.dc?.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(msg));
        return;
      } catch {
        /* DC died mid-send — fall through to WS */
      }
    }
    this.safeSocketSend(msg);
  }

  private safeSocketSend(msg: RelayMsg | SignalMsg): void {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    try {
      s.send(JSON.stringify(msg));
    } catch {
      /* socket closing mid-send */
    }
  }
}
