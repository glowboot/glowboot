/**
 * Link-cable status channel — one-way broadcast from the link
 * implementations (local `BroadcastChannelLink`, remote `WebRTCLink`)
 * to the Settings → Link cable UI row, which shows a small status
 * indicator reflecting the current connection state.
 *
 * Uses a DOM `CustomEvent` rather than an explicit subscriber API so
 * the link classes stay decoupled from the panel module — they just
 * fire events, the UI listens at its own leisure.
 *
 * Status values:
 *   - `off`       — user has toggled the link cable off
 *   - `idle`      — enabled, waiting for a peer to join
 *   - `connected` — paired with a peer; transfers will route through
 *   - `error`     — relay URL failed validation (remote mode only)
 */

export type LinkStatus = "off" | "idle" | "connected" | "error";

export const LINK_STATUS_EVENT = "gb-link-status";

export function dispatchLinkStatus(status: LinkStatus): void {
  document.dispatchEvent(new CustomEvent<LinkStatus>(LINK_STATUS_EVENT, { detail: status }));
}
