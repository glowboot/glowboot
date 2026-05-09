/**
 * Serial-port link interface.
 *
 * The MMU uses this to push bytes to a connected peer and receive their
 * response. The default implementation in this file is a no-op — transfers
 * complete with `0xFF` as if nothing were connected, matching how an
 * unplugged Game Boy behaves on real hardware. The browser-side link
 * cable ({@link ../../ui/session/link-cable.ts}) implements the same
 * interface over `BroadcastChannel`, letting two tabs pair up.
 *
 * Kept in the engine tree so save-states and headless test runners can
 * plug in their own mock without importing browser code.
 */

export interface SerialLink {
  /**
   * Invoked when the guest starts a transfer with internal clock
   * (SC = 0x81 / 0x83). `byte` is the value the guest is shifting out.
   * When the peer responds, call `resolve` with the byte we received.
   * The MMU tolerates a delayed `resolve` — a fallback timer latches
   * `0xFF` + fires the serial interrupt if the response doesn't arrive
   * within the link's expected RTT, so games don't hang when the peer
   * is slow or absent.
   */
  sendAsMaster(byte: number, resolve: (peerByte: number) => void): void;

  /**
   * Register the callback invoked when the peer initiates a transfer
   * and we're the slave. Handler receives the peer's byte and returns
   * OUR current SB register for them — on real hardware, both sides'
   * shift registers are wired together so a clock pulse exchanges one
   * bit between them.
   */
  onPeerInitiated(handler: (peerByte: number) => number): void;

  /**
   * `true` when a remote peer is connected and may take many T-cycles
   * to respond (network round-trip ≫ Game Boy byte time). The MMU
   * uses this to widen the master-transfer timeout — a fixed 1 ms
   * deadline works for instant local links but always times out before
   * a WebRTC reply arrives. Implementations that resolve synchronously
   * (NO_LINK, virtual printer, idle BroadcastChannel) leave it `false`
   * so single-player games don't pay the wider deadline.
   */
  readonly paired: boolean;

  /** Disconnect cleanly. Pending master-transfer resolvers are dropped
   *  (the MMU's fallback timer will time them out). */
  close(): void;
}

/** Disconnected-cable default: master transfers complete with 0xFF and
 *  no peer can initiate. Used whenever the host hasn't installed a
 *  real link (most sessions). */
export const NO_LINK: SerialLink = {
  sendAsMaster(_byte, resolve) {
    resolve(0xff);
  },
  onPeerInitiated() {
    /* no peer */
  },
  paired: false,
  close() {
    /* nothing to tear down */
  }
};
