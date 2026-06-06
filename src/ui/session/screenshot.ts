import { saveBlobNative } from "../save-blob.js";

/**
 * Export the current emulator framebuffer to a PNG. The canvas is
 * 160×144 (GB) or 240×160 (GBA) internally so the saved PNG is the
 * raw, unscaled frame — crisp at native resolution for gifs / social
 * media.
 *
 * On phones the blob routes through the Web Share API so the OS share
 * sheet appears — iOS Safari ignores `<a download>`, which would
 * otherwise silently swallow the file. Desktop falls back to the
 * classic invisible-anchor download.
 *
 * Result tells the caller what to toast: `"saved"` for the desktop
 * download or a completed share, `"shared"` for share-sheet success,
 * `"cancelled"` when the user dismissed the share sheet, `"failed"`
 * when `toBlob` returned null (typically a WebGL canvas without
 * `preserveDrawingBuffer`).
 */
export type CaptureResult = "saved" | "shared" | "cancelled" | "failed";

export async function captureTo(canvas: HTMLCanvasElement, filename: string): Promise<CaptureResult> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
  if (!blob) {
    console.warn("[Screenshot] toBlob returned null");
    return "failed";
  }
  const handled = await saveBlobNative(blob, filename);
  if (handled === "shared") return "shared";
  if (handled === "cancelled") return "cancelled";
  // Fall through to the classic <a download> path for desktop and any
  // mobile browser that can't share files.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke asynchronously so the click has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "saved";
}

/** Build a filesystem-safe filename stem from a cart title. */
export function sanitize(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 _.-]/g, "_")
      .trim()
      .replace(/\s+/g, "_") || "gameboy"
  );
}
