import { toastEl, toastErrorEl } from "../dom.js";

/** Transient status messages shown in the lower-right corner. Two
 *  elements back the two severities so screen readers get the right
 *  urgency level on each:
 *    - `toast`       → `role="status"` + `aria-live="polite"` — informational
 *                      confirmations ("Saved slot 3", "Library exported").
 *    - `errorToast`  → `role="alert"` + `aria-live="assertive"`   — errors
 *                      and validation failures ("Invalid cheat code").
 *  Both share the same visual pill; only the alert variant is tinted red.
 *
 *  Messages queue rather than clobber: rapid actions (save + screenshot
 *  + save) show in sequence instead of overwriting each other mid-read.
 *  Queue is capped so a runaway caller can't build an unbounded backlog.
 */

const VISIBLE_MS_INFO = 1400;
const VISIBLE_MS_ERROR = 2000;
const GAP_MS = 160;
const QUEUE_LIMIT = 3;

interface Channel {
  el: HTMLElement | null;
  queue: string[];
  visibleMs: number;
  timer: number;
  showing: boolean;
}

const info: Channel = { el: toastEl, queue: [], visibleMs: VISIBLE_MS_INFO, timer: 0, showing: false };
const error: Channel = { el: toastErrorEl, queue: [], visibleMs: VISIBLE_MS_ERROR, timer: 0, showing: false };

function push(ch: Channel, msg: string): void {
  if (!ch.el) return;
  // Dedupe against the currently-displayed message so hammering the
  // same action ("save slot 3, save slot 3") doesn't echo through
  // the queue. Non-adjacent duplicates (save 3, save 4, save 3)
  // still go through — those reflect real user intent.
  if (ch.showing && ch.el.textContent === msg) return;
  ch.queue.push(msg);
  if (ch.queue.length > QUEUE_LIMIT) ch.queue.splice(0, ch.queue.length - QUEUE_LIMIT);
  if (!ch.showing) pump(ch);
}

function pump(ch: Channel): void {
  if (!ch.el) return;
  const next = ch.queue.shift();
  if (next === undefined) {
    ch.showing = false;
    return;
  }
  ch.showing = true;
  ch.el.textContent = next;
  ch.el.classList.add("active");
  clearTimeout(ch.timer);
  ch.timer = window.setTimeout(() => {
    if (!ch.el) return;
    ch.el.classList.remove("active");
    // Small gap between messages so the eye registers the change
    // (without it, queued messages look like one long flicker).
    ch.timer = window.setTimeout(() => pump(ch), GAP_MS);
  }, ch.visibleMs);
}

export function toast(msg: string): void {
  push(info, msg);
}

export function errorToast(msg: string): void {
  push(error, msg);
}
