/**
 * "Save this blob" helper for mobile browsers.
 *
 * On the web, the standard `<a download>` trick is what most call sites
 * fall back to. This helper handles the one platform where it doesn't
 * work: iOS Safari (and the bulk of mobile browsers in general), where
 * the right experience is the OS share sheet — Photos / Messages /
 * AirDrop / Files — surfaced via the Web Share API.
 *
 * Result codes:
 *   "shared"      — user picked an action in the share sheet (file is
 *                   in their hands)
 *   "cancelled"   — user dismissed the share sheet without picking
 *                   anything (toast should say so rather than lie)
 *   "unsupported" — share isn't available or we're on desktop; caller
 *                   should run its own download path
 */

export type ShareResult = "shared" | "cancelled" | "unsupported";

/** Detect iOS / iPadOS — the only platform where `<a download>` is
 *  unreliable enough that we need to route through Web Share instead.
 *  Android Chrome, desktop browsers (incl. DevTools mobile emulation),
 *  and even macOS Safari all handle `<a download>` fine. A `(pointer:
 *  coarse)` media query is too broad — DevTools' device toolbar reports
 *  coarse on a desktop machine where downloads work normally, and the
 *  Web Share menu on macOS is a worse UX than a plain download. */
function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS 13+ identifies as desktop Mac in the UA, but still has touch.
  if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

export async function saveBlobNative(blob: Blob, filename: string): Promise<ShareResult> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  ) {
    return "unsupported";
  }
  if (!isIosLike()) return "unsupported";
  try {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    if (!navigator.canShare({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file], title: filename });
    return "shared";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    console.warn("[saveBlobNative] web share failed:", err);
    return "unsupported";
  }
}
