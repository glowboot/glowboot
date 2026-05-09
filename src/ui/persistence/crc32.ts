/**
 * CRC32 (IEEE 802.3 polynomial, reflected). Used by the cart-id content
 * hash and by BPS patch checksum verification. Table is built lazily so
 * callers that never touch either path don't pay the 1 KiB cost.
 */

let table: Int32Array | null = null;

function buildTable(): Int32Array {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}

export function crc32(bytes: Uint8Array): number {
  if (!table) table = buildTable();
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ table[(c ^ bytes[i]!) & 0xff]!;
  }
  return (c ^ -1) >>> 0;
}
