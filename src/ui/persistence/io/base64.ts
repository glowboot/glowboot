/**
 * Binary-safe base64 helpers used by the export/import pipelines.
 *
 * `btoa` only accepts strings of Latin-1 code points and tops out at
 * a few hundred KB before the `String.fromCharCode(...spread)` pattern
 * blows the call stack. We chunk through `subarray` slices of 32 KiB to
 * keep both limits at bay; ROMs and save bundles routinely hit a few
 * megabytes and would otherwise crash the export.
 */

const CHUNK = 0x8000;

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
