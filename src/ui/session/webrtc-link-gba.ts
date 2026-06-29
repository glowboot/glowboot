import type { GbaSioLink } from "../../gba";
import { toast } from "../hud/toast.js";
import { state } from "../state.js";
import { dispatchLinkStatus } from "./link-status.js";

/**
 * Cross-device GBA Multiplayer-mode link cable. Mirrors the GB
 * `WebRTCLink` byte-shift implementation but with 16-bit halfwords
 * and a 4-slot result, so two physical GBAs across the internet can
 * trade Pokémon, race Mario Kart, etc.
 *
 * Protocol architecture (same as the GB cable):
 *   1. WebSocket to the room-coded relay (Cloudflare Worker — repo
 *      lives separately, URL comes in via `VITE_LINK_RELAY_URL`).
 *   2. Relay pairs us with another peer in the same room. Bytes flow
 *      over the WebSocket while we negotiate WebRTC.
 *   3. Once `RTCDataChannel` opens, halfword traffic upgrades to P2P
 *      and the relay only carries signalling. Bytes drop from
 *      ~50 ms round-trip to ~10-20 ms.
 *   4. If the DataChannel never opens (NAT punch-through failure),
 *      we keep using the WebSocket — Pokémon trades are mid-second
 *      affairs and the user won't notice the extra hop.
 *
 * Room-code namespace: prefixed with `gba-` so a GB peer entering the
 * same room code never accidentally pairs with a GBA peer. The two
 * protocols are incompatible byte-vs-halfword anyway, so silent
 * cross-pairing would just look like a broken cable.
 */

type RelayMsg =
  { type: "multi-start"; seq: number; masterData: number } | { type: "multi-reply"; seq: number; slaveData: number };

type SignalMsg =
  | { type: "rtc-offer"; sdp: string }
  | { type: "rtc-answer"; sdp: string }
  | { type: "rtc-ice"; candidate: RTCIceCandidateInit | null };

type RoomMsg =
  { type: "joined"; paired: boolean } | { type: "peer-joined" } | { type: "peer-left" } | { type: "room-full" };

type WireMsg = RoomMsg | RelayMsg | SignalMsg;

/** Same 8 s budget as the GB cable. Past this we keep flowing
 *  halfwords over the WebSocket — slower but still works. */
const DC_UPGRADE_BUDGET_MS = 8000;

/** Master-transfer fallback timeout. Wider than the same-machine
 *  500 ms because internet RTT varies wildly; the cart's spin-on-IRQ
 *  loop tolerates the wait. Real GBA Pokémon trade negotiation has
 *  multi-second pauses anyway. */
const TRANSFER_TIMEOUT_MS = 2000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Prefix that keeps the GBA room-namespace disjoint from the GB
 *  one. A user typing the same room code into both a GB tab and a
 *  GBA tab on different devices will get separate rooms — no
 *  protocol-mismatch silent failures. */
const GBA_ROOM_PREFIX = "gba-";

export class WebRtcGbaLink implements GbaSioLink {
  private socket: WebSocket | null = null;
  private wsPaired = false;

  /** `true` from construction so the SIO controller routes transfers
   *  through us even while the WebSocket is still connecting; the
   *  in-flight transfer just gets the 0xFFFF-fallback if no peer is
   *  there yet. Matches the GB WebRTCLink pattern. */
  readonly paired = true;

  private readonly pending = new Map<number, (peerSends: readonly [number, number, number]) => void>();
  private nextSeq = 1;
  private closed = false;

  private generation = 0;
  private reconnectTimer: number | null = null;

  /** Slave-side handlers wired by Sio.setLink(). null until set. */
  private onMasterStart: ((masterData: number) => number) | null = null;
  private onTransferComplete: ((s0: number, s1: number, s2: number, s3: number) => void) | null = null;

  // ─── RTC state ─────────────────────────────────────────────────────
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private dcOpen = false;
  private isOfferer = false;
  private upgradeTimer: number | null = null;

  constructor(
    private readonly roomCode: string,
    private readonly relayBaseUrl: string
  ) {
    dispatchLinkStatus("idle");
    this.open();
  }

  // ─── GbaSioLink implementation ─────────────────────────────────────

  setHandlers(handlers: {
    onMasterStart: (masterData: number) => number;
    onTransferComplete: (s0: number, s1: number, s2: number, s3: number) => void;
  }): void {
    this.onMasterStart = handlers.onMasterStart;
    this.onTransferComplete = handlers.onTransferComplete;
  }

  sendAsMaster(masterSend: number, resolve: (peerSends: readonly [number, number, number]) => void): void {
    if (!this.wsPaired) {
      resolve([0xffff, 0xffff, 0xffff]); // not yet paired — mimic unplugged cable
      return;
    }
    const seq = this.nextSeq++;
    this.pending.set(seq, resolve);
    this.sendRelay({ type: "multi-start", seq, masterData: masterSend & 0xffff });
    setTimeout(() => {
      const r = this.pending.get(seq);
      if (r) {
        this.pending.delete(seq);
        r([0xffff, 0xffff, 0xffff]);
      }
    }, TRANSFER_TIMEOUT_MS);
  }

  notifySiomltSendChange(_value: number): void {
    // No-op — cross-device WebRTC link still uses the legacy
    // request/reply round-trip and doesn't broadcast cached state
    // yet. Adopting the BroadcastChannel link's cached-state model
    // here is a future change; same-machine pairing is what
    // typically benefits.
  }

  resyncSlot(): void {
    // WebRTC link's slot is derived from WebRTC SDP role: the
    // offerer is slot 0 (master), the answerer is slot 1.
    // Re-push that slot ID into the freshly-wired Sio so a cart
    // reload doesn't leave the new Sio at default slot 0.
    state.gba?.sio.setMultiplayerSlotId(this.isOfferer ? 0 : 1);
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
      r([0xffff, 0xffff, 0xffff]);
      this.pending.delete(seq);
    }
  }

  // ─── Signalling socket ─────────────────────────────────────────────

  private open(): void {
    if (this.closed) return;
    this.generation++;
    const gen = this.generation;
    const wss = this.relayBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
    const room = `${GBA_ROOM_PREFIX}${this.roomCode}`;
    const url = `${wss}/link/${encodeURIComponent(room)}`;
    let s: WebSocket;
    try {
      s = new WebSocket(url);
    } catch (err) {
      console.warn("[GBA Link/RTC] socket construct failed:", err);
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
        console.warn("[GBA Link/RTC] bad message:", err);
      }
    });
    s.addEventListener("close", () => {
      if (gen !== this.generation) return;
      if (this.wsPaired) {
        this.wsPaired = false;
        toast("GBA link cable disconnected");
        dispatchLinkStatus("idle");
      }
      this.teardownRtc();
      for (const [seq, r] of this.pending) {
        r([0xffff, 0xffff, 0xffff]);
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
        this.wsPaired = msg.paired;
        this.isOfferer = !msg.paired;
        // Slot ID: offerer (first peer in the room) is the parent
        // (slot 0); the second arrival is child 1. Stays stable for
        // the lifetime of the pairing.
        state.gba?.sio.setMultiplayerSlotId(this.isOfferer ? 0 : 1);
        if (msg.paired) {
          toast("GBA link cable connected");
          dispatchLinkStatus("connected");
          this.beginRtcUpgrade();
        }
        return;
      case "peer-joined":
        this.wsPaired = true;
        state.gba?.sio.setMultiplayerSlotId(this.isOfferer ? 0 : 1);
        toast("GBA link cable connected");
        dispatchLinkStatus("connected");
        this.beginRtcUpgrade();
        return;
      case "peer-left":
        this.wsPaired = false;
        toast("GBA link cable disconnected");
        dispatchLinkStatus("idle");
        this.teardownRtc();
        for (const [seq, r] of this.pending) {
          r([0xffff, 0xffff, 0xffff]);
          this.pending.delete(seq);
        }
        return;
      case "room-full":
        toast("GBA link room is full (2 players already connected)");
        dispatchLinkStatus("error");
        this.closed = true;
        return;
      case "multi-start":
      case "multi-reply":
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
      case "multi-start": {
        const slaveData = this.onMasterStart?.(msg.masterData & 0xffff) ?? 0xffff;
        // Both sides latch the 4-slot result locally on each transfer.
        // For 2-player, slots 2/3 stay at 0xFFFF.
        this.onTransferComplete?.(msg.masterData & 0xffff, slaveData & 0xffff, 0xffff, 0xffff);
        this.sendRelay({ type: "multi-reply", seq: msg.seq, slaveData: slaveData & 0xffff });
        return;
      }
      case "multi-reply": {
        const resolver = this.pending.get(msg.seq);
        if (!resolver) return;
        this.pending.delete(msg.seq);
        resolver([msg.slaveData & 0xffff, 0xffff, 0xffff]);
        return;
      }
    }
  }

  // ─── RTC negotiation ───────────────────────────────────────────────

  private beginRtcUpgrade(): void {
    if (this.pc || typeof RTCPeerConnection === "undefined") return;
    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    this.pc.addEventListener("icecandidate", (e) => {
      this.safeSocketSend({ type: "rtc-ice", candidate: e.candidate?.toJSON() ?? null });
    });
    this.pc.addEventListener("connectionstatechange", () => {
      const st = this.pc?.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        this.demoteRtc();
      }
    });
    this.pc.addEventListener("datachannel", (e) => {
      if (this.isOfferer) return;
      this.attachDataChannel(e.channel);
    });

    if (this.isOfferer) {
      const dc = this.pc.createDataChannel("gba-link", { ordered: true });
      this.attachDataChannel(dc);
      void this.makeOffer();
    }

    this.upgradeTimer = window.setTimeout(() => {
      this.upgradeTimer = null;
      if (!this.dcOpen) {
        console.debug("[GBA Link/RTC] upgrade budget elapsed — staying on WS relay");
      }
    }, DC_UPGRADE_BUDGET_MS);
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.addEventListener("open", () => {
      this.dcOpen = true;
      if (this.upgradeTimer !== null) {
        clearTimeout(this.upgradeTimer);
        this.upgradeTimer = null;
      }
      console.debug("[GBA Link/RTC] DataChannel open — halfwords now flowing P2P");
    });
    dc.addEventListener("close", () => {
      this.dcOpen = false;
    });
    dc.addEventListener("message", (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as RelayMsg;
        this.handleRelay(msg);
      } catch (err) {
        console.warn("[GBA Link/RTC] bad DC message:", err);
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
      console.warn("[GBA Link/RTC] offer failed:", err);
    }
  }

  private async handleSignal(msg: SignalMsg): Promise<void> {
    if (!this.pc) {
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
      console.warn("[GBA Link/RTC] signal apply failed:", err);
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
