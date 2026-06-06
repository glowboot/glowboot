/**
 * Transport-side interface the GBA SIO controller talks to for
 * actual cross-cart data movement. The cart-facing register file
 * (`Sio`) only knows about local state; everything that needs to
 * cross a wire (BroadcastChannel, WebRTC, local-bus stub) implements
 * this interface and gets `setLink()`-ed in by the host.
 *
 * Only Multiplayer mode is wired through here. Normal-8 / Normal-32 /
 * UART / JOY-bus would plug into the same shape if a use case appeared
 * — none of the carts Glowboot targets need them.
 *
 * Role model: the GBA Multiplayer protocol does not assign master /
 * slave roles statically — whichever GBA writes `SIOCNT.START=1`
 * first is the master for that transfer; the others respond. Each
 * side therefore registers BOTH a master-initiate path (called from
 * `Sio.write16` when the cart pulses START) and a slave-response
 * handler (called when the peer pulses START). Whoever initiates
 * wins the race; the other(s) become slaves implicitly.
 */

export interface GbaSioLink {
  /** True when at least one peer is paired and ready to participate
   *  in transfers. The SIO controller checks this to decide whether
   *  to short-circuit cart writes (no peer → `SIOMULTIn` fills with
   *  `0xFFFF` for unconnected slots, matching real hardware). */
  readonly paired: boolean;

  /** Re-emit the link's current player slot ID into the Sio. The
   *  link assigns slot IDs internally based on roster order (the
   *  lowest UUID is slot 0, etc.) and pushes them to Sio whenever
   *  the roster changes. But cart-reload paths wire a fresh Sio to
   *  an already-paired link — at that moment the new Sio's slotId
   *  is the default 0 and the link doesn't know to re-push. The Sio
   *  calls this in `setLink` so the new Sio inherits the current
   *  pairing's slot assignment immediately. */
  resyncSlot(): void;

  /** Cart pulsed `SIOCNT.START=1` — this client is the master for
   *  this transfer. Resolve with the latest cached peer responses
   *  (slot 1..3, unconnected slots = 0xFFFF). For 2-player only
   *  slot 1 carries a real value.
   *
   *  Cached-state model: the resolver fires **synchronously** using
   *  whatever peer SIOMLT_SEND values were last received via
   *  `notifySiomltSendChange()` broadcasts. The transport then
   *  broadcasts the four-slot result so peers latch the same snapshot
   *  asynchronously (their `onTransferComplete` fires when the
   *  message arrives). Cart-side polling on the master sees BUSY
   *  clear in the very next instruction, matching the µs-scale
   *  transfer duration carts expect. */
  sendAsMaster(masterSend: number, resolve: (peerSends: readonly [number, number, number]) => void): void;

  /** Sio calls this on every write to `SIOMLT_SEND` so the transport
   *  can broadcast the new value to peers. Master's `sendAsMaster`
   *  uses the cache of these broadcasts to complete transfers
   *  synchronously. */
  notifySiomltSendChange(value: number): void;

  /** Register the slave-side handler. Fired when a peer-as-master
   *  pulses START. Handler is called with the master's send value;
   *  returns this client's current `SIOMLT_SEND` as the slave-1
   *  response. The transport is expected to drive the local Sio
   *  controller's own SIOMULTI0..3 latch and IRQ via the
   *  `onTransferComplete` callback so all peers update in sync. */
  setHandlers(handlers: {
    onMasterStart: (masterSend: number) => number;
    onTransferComplete: (slot0: number, slot1: number, slot2: number, slot3: number) => void;
  }): void;

  /** Tear down — called when the cart unloads or the user picks a
   *  different link mode. Idempotent. */
  close(): void;

  /** Called from `Sio.tick()` so the link can check shared state
   *  for incoming transfers. The BroadcastChannel link doesn't need
   *  this (peer messages arrive asynchronously via the BC event
   *  handler), but the SharedArrayBuffer-backed link uses it to
   *  poll the transfer-sequence counter — Atomics has no event
   *  callback, so the slave side has to look for new transfers
   *  itself. Optional; absent on transports that push events. */
  poll?(): void;
}
