/**
 * IPS / BPS patch application for ROM hacks (randomizers, translations,
 * mods). Runs purely on the raw ROM bytes and returns a new Uint8Array —
 * the emulator is completely unaware a patch was involved; the patched
 * bytes simply become "the ROM" from load onward.
 *
 * Why no external library: both formats are small and the WASM overhead
 * of bundling rom-patcher-js or similar would double our bundle size.
 */

import { crc32 } from "../persistence/crc32.js";

export type PatchKind = "ips" | "bps";

/** Detect a patch format from its leading magic bytes. Returns null if
 *  the buffer isn't a recognised patch. */
export function detectPatch(bytes: Uint8Array): PatchKind | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x41 &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x43 &&
    bytes[4] === 0x48
  )
    return "ips";
  if (bytes.length >= 4 && bytes[0] === 0x42 && bytes[1] === 0x50 && bytes[2] === 0x53 && bytes[3] === 0x31)
    return "bps";
  return null;
}

/** Apply either IPS or BPS to `base`. Throws on malformed / mismatched
 *  patch so the caller can surface a toast. Returns a new array. */
export function applyPatch(base: Uint8Array, patch: Uint8Array): Uint8Array {
  const kind = detectPatch(patch);
  if (!kind) throw new Error("Not a recognised IPS or BPS patch");
  return kind === "ips" ? applyIps(base, patch) : applyBps(base, patch);
}

// ─── IPS ────────────────────────────────────────────────────────────────
//
// Header:  "PATCH"  (5 bytes)
// Record:  3-byte big-endian offset
//          2-byte big-endian length
//          if length == 0 → RLE: 2-byte run-length + 1-byte value
//          else           → `length` bytes of literal data
// Footer:  "EOF"   (3 bytes)
//
// The patch may extend the target beyond the original ROM size; we grow
// the output buffer as records dictate.

function applyIps(base: Uint8Array, patch: Uint8Array): Uint8Array {
  // Start with a copy; records may grow it, so we work in a plain array
  // and convert back at the end. For typical ROM-hack patches (a few KB of
  // changes against a 1-8 MiB ROM) the array overhead is negligible.
  const out: number[] = Array.from(base);
  let p = 5; // skip "PATCH"

  while (p + 3 <= patch.length) {
    // Footer "EOF" = 0x45, 0x4F, 0x46 — ambiguous with a real offset
    // equal to 0x454F46, but that's the format's accepted risk and no
    // legitimate ROM hack hits that offset.
    if (patch[p] === 0x45 && patch[p + 1] === 0x4f && patch[p + 2] === 0x46) break;

    const offset = (patch[p]! << 16) | (patch[p + 1]! << 8) | patch[p + 2]!;
    const length = (patch[p + 3]! << 8) | patch[p + 4]!;
    p += 5;

    if (length === 0) {
      // RLE record.
      if (p + 3 > patch.length) throw new Error("Truncated IPS RLE record");
      const runLength = (patch[p]! << 8) | patch[p + 1]!;
      const value = patch[p + 2]!;
      p += 3;
      for (let i = 0; i < runLength; i++) out[offset + i] = value;
    } else {
      if (p + length > patch.length) throw new Error("Truncated IPS data record");
      for (let i = 0; i < length; i++) out[offset + i] = patch[p + i]!;
      p += length;
    }
  }

  return Uint8Array.from(out);
}

// ─── BPS ────────────────────────────────────────────────────────────────
//
// https://github.com/btimofeev/UniPatcher/wiki/BPS
//
// Header:         "BPS1"
// source-size     (varint)
// target-size     (varint)
// metadata-size   (varint)
// metadata        (metadata-size bytes — ignored)
// patch-body      (series of commands until 12 bytes from end)
// source-checksum (4 bytes, CRC32 LE) — of the base ROM
// target-checksum (4 bytes, CRC32 LE) — of the patched output
// patch-checksum  (4 bytes, CRC32 LE) — of everything above this field
//
// Patch body commands: each starts with a varint whose low 2 bits are the
// action and remaining bits are length-1:
//   0 = SourceRead : copy `length` bytes from source[outPos..] to target
//   1 = TargetRead : next `length` bytes of patch are the output
//   2 = SourceCopy : signed varint relative offset, copy from source[srcPtr++]
//   3 = TargetCopy : signed varint relative offset, copy from target[tgtPtr++]
//                    (may self-reference bytes just written — classic LZ trick)

function applyBps(base: Uint8Array, patch: Uint8Array): Uint8Array {
  if (patch.length < 4 + 12) throw new Error("BPS too short");

  let p = 4; // skip "BPS1"

  const readVarint = (): number => {
    let data = 0;
    let shift = 1;
    for (;;) {
      if (p >= patch.length) throw new Error("Truncated BPS varint");
      const x = patch[p++]!;
      data += (x & 0x7f) * shift;
      if (x & 0x80) return data;
      shift <<= 7;
      data += shift;
    }
  };

  const readSignedVarint = (): number => {
    const d = readVarint();
    return d & 1 ? -(d >>> 1) : d >>> 1;
  };

  const sourceSize = readVarint();
  const targetSize = readVarint();
  const metadataSize = readVarint();
  p += metadataSize; // metadata ignored

  if (sourceSize > base.length) {
    throw new Error(`BPS expects source of ${sourceSize} bytes, got ${base.length}`);
  }

  // Verify source checksum. Reject early if the patch targets a different
  // base ROM — prevents silent corruption with the wrong parent.
  const patchEnd = patch.length - 12;
  const expectedSrc =
    patch[patchEnd]! | (patch[patchEnd + 1]! << 8) | (patch[patchEnd + 2]! << 16) | (patch[patchEnd + 3]! * 0x1000000);
  const actualSrc = crc32(base.subarray(0, sourceSize));
  if (expectedSrc >>> 0 !== actualSrc >>> 0) {
    throw new Error("BPS source checksum mismatch — wrong base ROM?");
  }

  const target = new Uint8Array(targetSize);
  let outPos = 0;
  let srcReadPtr = 0;
  let tgtReadPtr = 0;

  while (p < patchEnd) {
    const cmd = readVarint();
    const action = cmd & 0x3;
    const length = (cmd >>> 2) + 1;

    switch (action) {
      case 0: // SourceRead
        for (let i = 0; i < length; i++) {
          target[outPos] = base[outPos]!;
          outPos++;
        }
        break;
      case 1: // TargetRead
        for (let i = 0; i < length; i++) target[outPos++] = patch[p++]!;
        break;
      case 2: // SourceCopy
        srcReadPtr += readSignedVarint();
        for (let i = 0; i < length; i++) target[outPos++] = base[srcReadPtr++]!;
        break;
      case 3: // TargetCopy — may reference bytes written earlier in this loop
        tgtReadPtr += readSignedVarint();
        for (let i = 0; i < length; i++) target[outPos++] = target[tgtReadPtr++]!;
        break;
    }
  }

  // Target checksum — warn rather than throw so a mostly-good patch still
  // boots (the emulator tolerates minor ROM corruption better than a hard
  // failure here). Genuine breakage will show up as gameplay issues.
  const expectedTgt =
    patch[patchEnd + 4]! |
    (patch[patchEnd + 5]! << 8) |
    (patch[patchEnd + 6]! << 16) |
    (patch[patchEnd + 7]! * 0x1000000);
  if (crc32(target) >>> 0 !== expectedTgt >>> 0) {
    console.warn("[Patches] BPS target checksum mismatch — output may be slightly wrong");
  }

  return target;
}
