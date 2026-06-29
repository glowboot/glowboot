/**
 * Game Boy Printer emulation — passive serial-link device.
 *
 * Each byte the cart shifts out advances a per-byte state machine; the
 * printer's reply lands in SB by the time the SIO transfer completes.
 * Body bytes return 0x00, the keepalive byte returns 0x81, the status
 * byte returns the current status flags. Status mutations and the
 * print-fire callback happen in a "post-state" block that runs after
 * every byte — the precise ordering matters because the GB Camera ROM
 * is sensitive to it (e.g. the PRINT-packet status trailer reads the
 * *prior* status, and PRINTING|PRINT_REQ get set after the trailer).
 *
 * Protocol layout (each byte the guest shifts out is paired with a byte
 * the printer shifts back):
 *
 *   0x88 0x33  CMD COMP LENLO LENHI  DATA…  CKLO CKHI  0x00 0x00
 *   ▲ magic    ▲ 4-byte header        ▲ payload  ▲ ck  ▲ ack ▲ status
 */

const PRINTER_WIDTH_PX = 160;

/** One DATA band = 0x280 bytes = 640. 8 rows × 160 px × 2 bpp / 8. The
 *  printer asserts READY on its STATUS byte when the buffer has
 *  accumulated at least this much. */
export const PRINTER_BAND_BYTES = 0x280;
/** Minimum buffer size for the PRINT command to actually fire — one
 *  printer band of 8 scanlines (160 px × 2 bpp / 8 px/byte = 320 bytes).
 *  PRINT with less than this is silently ignored. */
const PRINT_MIN_BYTES = 320;
const TILE_BYTES = 16;
const TILES_PER_ROW = PRINTER_WIDTH_PX / 8;
const BAND_HEIGHT_PX = 8;

export const CMD_INIT = 0x01;
export const CMD_PRINT = 0x02;
export const CMD_DATA = 0x04;
export const CMD_NUL = 0x0f;

/** Status flag bits (gbdev wiki). We only ever set bits 1, 2, 3 — the
 *  upper bits (LOW_BATTERY / PAPER_JAM / TEMPERATURE / CHECKSUM_ERROR)
 *  represent failure modes a virtual printer never produces. */
const STATUS_BIT_PRINTING = 0x02; // bit 1: print in progress
const STATUS_BIT_PRINT_REQ = 0x04; // bit 2: print queued / done
const STATUS_BIT_READY = 0x08; // bit 3: full image band accumulated

const RESPONSE_BODY = 0x00;
const RESPONSE_ALIVE = 0x81;

/** Wall-clock duration the printer holds PRINTING|PRINT_REQ (0x06)
 *  before clearing those bits and signalling "done". Real hardware
 *  prints take ~1.5 s per band; carts that wait for printing-complete
 *  expect to observe several polls of 0x06 first. ~150 ms is long
 *  enough for the cart to see that across T-cycle-paced polls and
 *  short enough to feel snappy. */
const PRINT_DURATION_MS = 150;

type PrinterState =
  "magic1" | "magic2" | "cmd" | "comp" | "lenLo" | "lenHi" | "data" | "ckLo" | "ckHi" | "alive" | "status";

export interface PrintedPage {
  /** Always 160 — matches the Game Boy screen width. */
  readonly width: number;
  /** Number of scanlines accumulated since the last INIT, capped only
   *  by what the guest sent (typically 16, 32, …, 144). */
  readonly height: number;
  /** Greyscale pixels, one byte per pixel, value 0..3 mapped through
   *  the palette param in the PRINT command (already applied here so
   *  the consumer just sees the final 2-bit luminance). */
  readonly pixels: Uint8Array;
  /** PRINT command parameters in case the consumer wants exposure,
   *  margin, or sheet-count for fancy rendering. */
  readonly sheets: number;
  readonly marginBefore: number;
  readonly marginAfter: number;
  readonly palette: number;
  readonly exposure: number;
}

export type PagePrintedCallback = (page: PrintedPage) => void;

export class Printer {
  private state: PrinterState = "magic1";
  private cmd = 0;
  private compressed = false;
  private length = 0;
  private payload: number[] = [];
  private payloadIdx = 0;

  /** Status flag register. Bits are toggled at specific protocol
   *  points; never assigned wholesale to a constant — always OR'd in
   *  or AND-NOT'd out so the parts of the byte owned by other paths
   *  (e.g. PRINTING set by the post-state block, READY set on DATA)
   *  don't get clobbered. */
  private status = 0;

  /** Decoded tile bytes (post-RLE if the packet was compressed). The
   *  cursor is implicitly `imageBytes.length`; the printer commits
   *  the buffer when PRINT fires and clears it in the post-state
   *  block, ready for the next page. */
  private imageBytes: number[] = [];

  /** Print-fire sentinel: -1 = idle, 0 = "fire print now" (set in
   *  STATUS state, consumed in the post-state block on the same byte). */
  private printWait = -1;

  /** Wall-clock deadline at which the "done" trigger fires and clears
   *  bits 1+2 of status, signalling print-complete to the cart. 0 =
   *  no print in flight. */
  private printDoneAtMs = 0;

  /** Last PRINT command's parameter bytes (sheets / margin / palette /
   *  exposure), captured for the post-state print-fire callback. */
  private printParams: { sheets: number; marginByte: number; palette: number; exposure: number } | null = null;

  onPagePrinted: PagePrintedCallback | null = null;

  /** Wall-clock source — injectable for deterministic tests. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Process one byte from the guest's serial port. Returns the byte the
   * printer would shift back during the same transfer.
   *
   * Two-phase: first a per-byte state-machine step (advances `state`,
   * accumulates payload, picks a reply), then a post-state block that
   * fires the print callback if the STATUS state armed `printWait = 0`
   * during this byte. The split matters: the reply for the STATUS byte
   * has to capture the *prior* status value before the print-fire
   * block updates it to PRINTING|PRINT_REQ.
   */
  receiveByte(b: number): number {
    b &= 0xff;
    // Default reply for body bytes. Keepalive (0x81) and STATUS (current
    // status flags) overwrite this where applicable.
    let response: number = RESPONSE_BODY;

    switch (this.state) {
      case "magic1":
        if (b === 0x88) this.state = "magic2";
        break;
      case "magic2":
        // Only 0x33 advances; anything else aborts the packet and
        // re-syncs to the next 0x88 0x33 pair.
        this.state = b === 0x33 ? "cmd" : "magic1";
        break;
      case "cmd":
        this.cmd = b;
        this.state = "comp";
        break;
      case "comp":
        this.compressed = (b & 1) !== 0;
        this.state = "lenLo";
        break;
      case "lenLo":
        this.length = b;
        this.state = "lenHi";
        break;
      case "lenHi":
        this.length |= b << 8;
        this.payload = [];
        this.payloadIdx = 0;
        this.state = this.length > 0 ? "data" : "ckLo";
        // The `lenHi` state is also where INIT runs its side effect:
        // clear bits 2+3 of status (NOT bit 1 — that's only cleared
        // by the wall-clock "done" trigger) and reset the buffer.
        if (this.cmd === CMD_INIT) {
          this.imageBytes.length = 0;
          this.status &= ~(STATUS_BIT_PRINT_REQ | STATUS_BIT_READY);
        }
        break;
      case "data":
        this.payload.push(b);
        this.payloadIdx++;
        if (this.payloadIdx >= this.length) this.state = "ckLo";
        break;
      case "ckLo":
        this.state = "ckHi";
        break;
      case "ckHi":
        this.state = "alive";
        // For DATA: decompress (if compressed) and append to imageBytes.
        // For PRINT: stash the params for the post-state callback.
        // Status is NOT touched here — that's done in the STATUS state.
        if (this.cmd === CMD_DATA && this.payload.length > 0) {
          const bytes = this.compressed ? decompressRle(this.payload) : this.payload.slice();
          for (const v of bytes) this.imageBytes.push(v);
        } else if (this.cmd === CMD_PRINT && this.payload.length >= 4) {
          this.printParams = {
            sheets: this.payload[0]!,
            marginByte: this.payload[1]!,
            palette: this.payload[2]!,
            exposure: this.payload[3]!
          };
        }
        break;
      case "alive":
        this.state = "status";
        response = RESPONSE_ALIVE;
        break;
      case "status": {
        // Command-specific side effects fire on the STATUS byte's
        // delivery — DATA sets READY if the buffer is full enough,
        // PRINT arms `printWait` if there's enough data to print.
        // The reply itself is the *current* status (so the PRINT
        // trailer reads 0x08 from the prior DATA's READY, not 0x06 —
        // the 0x06 transition happens in the post-state block that
        // runs *after* this case).
        switch (this.cmd) {
          case CMD_DATA:
            if (this.imageBytes.length >= PRINTER_BAND_BYTES) {
              this.status |= STATUS_BIT_READY;
            }
            break;
          case CMD_PRINT:
            if (this.imageBytes.length >= PRINT_MIN_BYTES) {
              this.printWait = 0;
            }
            break;
        }
        response = this.status;
        this.state = "magic1";
        break;
      }
    }

    // Post-state block: runs after every byte. Fires the print
    // callback when `printWait == 0` (set by the STATUS state of a
    // PRINT packet), then resets the buffer and arms the wall-clock
    // "done" deadline.
    if (this.printWait === 0) {
      this.status &= ~STATUS_BIT_READY;
      this.status |= STATUS_BIT_PRINTING | STATUS_BIT_PRINT_REQ;
      if (this.printParams && this.onPagePrinted) {
        const { sheets, marginByte, palette, exposure } = this.printParams;
        const page = renderPage(this.imageBytes, palette, sheets, marginByte, exposure);
        this.onPagePrinted(page);
      }
      this.imageBytes.length = 0;
      this.printWait = -1;
      this.printParams = null;
      this.printDoneAtMs = this.now() + PRINT_DURATION_MS;
    }

    // Wall-clock "done" trigger: clears bits 1+2 of status so the
    // cart's wait-for-done loop observes the 0x06 → 0x00 transition.
    if (this.printDoneAtMs > 0 && this.now() >= this.printDoneAtMs) {
      this.status &= ~(STATUS_BIT_PRINTING | STATUS_BIT_PRINT_REQ);
      this.printDoneAtMs = 0;
    }

    return response;
  }
}

/**
 * Game Boy Printer RLE: top bit of length byte chooses literal-run
 * vs. repeat. High bit clear → literal run of (n + 1) bytes follows.
 * High bit set → repeat next byte (n & 0x7F) + 2 times. Stops when
 * the source is exhausted.
 */
export function decompressRle(src: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const head = src[i++]!;
    if ((head & 0x80) === 0) {
      const run = (head & 0x7f) + 1;
      for (let k = 0; k < run && i < src.length; k++) out.push(src[i++]!);
    } else {
      const run = (head & 0x7f) + 2;
      const v = src[i++] ?? 0;
      for (let k = 0; k < run; k++) out.push(v);
    }
  }
  return out;
}

/**
 * Render the accumulated 2bpp tile data into a flat luminance buffer.
 * The printer arranges tiles top-to-bottom, left-to-right within each
 * 8-pixel band of 20 tiles (so band 0 = scanlines 0–7, band 1 = 8–15,
 * etc.). Inside a tile the GB 2bpp format is 16 bytes: pairs of bytes
 * carry the lo and hi bit-planes of one row, MSB = leftmost pixel.
 */
function renderPage(
  tileBytes: number[],
  palette: number,
  sheets: number,
  marginByte: number,
  exposure: number
): PrintedPage {
  const totalTiles = Math.floor(tileBytes.length / TILE_BYTES);
  const bandCount = Math.floor(totalTiles / TILES_PER_ROW);
  const height = bandCount * BAND_HEIGHT_PX;
  const pixels = new Uint8Array(PRINTER_WIDTH_PX * height);
  // 4 entries × 2 bits each, packed lo→hi: source value 0..3 → palette
  // index. Default palette 0xE4 = identity (00→0, 01→1, 10→2, 11→3).
  const lut = [palette & 0x03, (palette >> 2) & 0x03, (palette >> 4) & 0x03, (palette >> 6) & 0x03];
  for (let band = 0; band < bandCount; band++) {
    for (let tx = 0; tx < TILES_PER_ROW; tx++) {
      const tileBase = (band * TILES_PER_ROW + tx) * TILE_BYTES;
      for (let row = 0; row < 8; row++) {
        const lo = tileBytes[tileBase + row * 2] ?? 0;
        const hi = tileBytes[tileBase + row * 2 + 1] ?? 0;
        const y = band * BAND_HEIGHT_PX + row;
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          const v = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          pixels[y * PRINTER_WIDTH_PX + tx * 8 + col] = lut[v]!;
        }
      }
    }
  }
  // marginByte is split: high nibble = before margin (lines), low = after.
  return {
    width: PRINTER_WIDTH_PX,
    height,
    pixels,
    sheets,
    marginBefore: (marginByte >> 4) & 0x0f,
    marginAfter: marginByte & 0x0f,
    palette,
    exposure
  };
}
