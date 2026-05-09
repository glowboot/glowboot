import { saveBlobNative } from "../save-blob.js";

/**
 * Export the current emulator framebuffer to a PNG. The canvas is
 * 160×144 internally (see CanvasRenderer) so the saved PNG is the raw,
 * unscaled Game Boy frame — crisp at native resolution for gifs /
 * social media.
 *
 * On phones the blob routes through the Web Share API so the OS share
 * sheet appears — iOS Safari ignores `<a download>`, which would
 * otherwise silently swallow the file. Desktop falls back to the
 * classic invisible-anchor download.
 */
export async function captureTo(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
  if (!blob) {
    console.warn("[Screenshot] toBlob returned null");
    return;
  }
  const handled = await saveBlobNative(blob, filename);
  if (handled) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke asynchronously so the click has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
