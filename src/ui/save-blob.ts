/**
 * "Save this blob" helper for mobile browsers.
 *
 * On the web, the standard `<a download>` trick is what most call sites
 * fall back to. This helper handles the one platform where it doesn't
 * work: iOS Safari (and the bulk of mobile browsers in general), where
 * the right experience is the OS share sheet — Photos / Messages /
 * AirDrop / Files — surfaced via the Web Share API.
 *
 * Returns `true` when the share sheet handled the blob (or the user
 * dismissed it), `false` when the caller should run its own download
 * path. Desktop browsers always return `false` because their users
 * already expect a file in Downloads.
 */

export async function saveBlobNative(blob: Blob, filename: string): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  ) {
    return false;
  }
  // A coarse pointer is the cleanest signal that we're on a phone or
  // tablet where a system share sheet is the right answer; on desktop
  // even a Safari that supports `navigator.share` routes through an
  // awkward sheet UI that's worse than a plain download.
  if (typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches) return false;
  try {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    if (!navigator.canShare({ files: [file] })) return false;
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch (err) {
    // AbortError = user cancelled the sheet. We still return `true`
    // because the user's intent was "decide what to do with this
    // file" and they decided "not now" — kicking off a download
    // afterwards would override their choice.
    if (err instanceof DOMException && err.name === "AbortError") return true;
    console.warn("[saveBlobNative] web share failed:", err);
    return false;
  }
}
