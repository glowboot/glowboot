import { beforeEach, describe, expect, it } from "vitest";

import {
  CMD_DATA,
  CMD_INIT,
  CMD_NUL,
  CMD_PRINT,
  decompressRle,
  type PrintedPage,
  Printer,
  PRINTER_BAND_BYTES
} from "./printer.js";

/**
 * Build a complete Game Boy Printer packet: magic 0x88 0x33, header
 * (cmd, comp, length lo/hi), payload, checksum, and the two trailer
 * bytes the guest sends to receive the alive marker + status. The
 * checksum is just sum-of-bytes over header + payload, truncated to
 * 16 bits — exactly what the printer expects (and ignores in our
 * implementation, but real packets always include it).
 */
function packet(cmd: number, payload: number[] = [], compressed = false): number[] {
  const header = [cmd, compressed ? 1 : 0, payload.length & 0xff, (payload.length >> 8) & 0xff];
  const body = [...header, ...payload];
  const sum = body.reduce((a, b) => (a + b) & 0xffff, 0);
  return [0x88, 0x33, ...body, sum & 0xff, (sum >> 8) & 0xff, 0x00, 0x00];
}

/** Drive a packet through `receiveByte` and collect the printer's
 *  responses for caller-side checks. */
function drive(printer: Printer, packetBytes: number[]): number[] {
  return packetBytes.map((b) => printer.receiveByte(b));
}

describe("Printer", () => {
  let printer: Printer;
  let pages: PrintedPage[];

  beforeEach(() => {
    printer = new Printer();
    pages = [];
    printer.onPagePrinted = (p) => pages.push(p);
  });

  describe("packet handshake", () => {
    it("responds with 0x00 during the body, 0x81 + status on the trailer", () => {
      const responses = drive(printer, packet(CMD_INIT));
      // Body bytes (everything except the last two) → 0x00.
      const body = responses.slice(0, -2);
      expect(body.every((r) => r === 0x00)).toBe(true);
      // Penultimate byte → 0x81 alive marker.
      expect(responses[responses.length - 2]).toBe(0x81);
      // Final byte → status (0x00 after INIT).
      expect(responses[responses.length - 1]).toBe(0x00);
    });

    it("ignores garbage bytes between packets and re-syncs on next 0x88 0x33", () => {
      drive(printer, [0x12, 0x34, 0xff, 0x00]);
      const responses = drive(printer, packet(CMD_INIT));
      // Same shape as a clean run.
      expect(responses[responses.length - 2]).toBe(0x81);
    });

    it("resets the state machine if the byte after 0x88 isn't 0x33", () => {
      // 0x88 0x77 0x88 0x33 ... should still parse the second magic pair.
      const garbage = [0x88, 0x77];
      const responses = [...drive(printer, garbage), ...drive(printer, packet(CMD_INIT))];
      expect(responses[responses.length - 2]).toBe(0x81);
    });
  });

  describe("INIT / NUL", () => {
    it("INIT clears any accumulated data so a stale buffer doesn't leak into the next page", () => {
      // Send a partial DATA packet, then INIT, then PRINT — should not fire onPagePrinted.
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0xff);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_INIT));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pages).toHaveLength(0);
    });

    it("NUL is a status-poll only — no buffer mutation, no page emitted", () => {
      drive(printer, packet(CMD_NUL));
      expect(pages).toHaveLength(0);
    });
  });

  describe("DATA + PRINT", () => {
    it("emits a page after one band + PRINT, with width=160 and height=16", () => {
      // One DATA band = 0x280 bytes = 40 tiles laid out as 20 × 2 in
      // the printer's column → 16 scanlines tall.
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pages).toHaveLength(1);
      expect(pages[0]!.width).toBe(160);
      expect(pages[0]!.height).toBe(16);
      expect(pages[0]!.pixels.length).toBe(160 * 16);
    });

    it("accumulates multiple DATA bands into a taller page (3 bands → 48 scanlines)", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pages[0]!.height).toBe(48);
    });

    it("forwards PRINT parameters (sheets / margins / palette / exposure)", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [3, 0x21, 0xe4, 0x7f]));
      const p = pages[0]!;
      expect(p.sheets).toBe(3);
      expect(p.marginBefore).toBe(2);
      expect(p.marginAfter).toBe(1);
      expect(p.palette).toBe(0xe4);
      expect(p.exposure).toBe(0x7f);
    });

    it("PRINT with no buffered data does not emit a page", () => {
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pages).toHaveLength(0);
    });
  });

  describe("tile rendering", () => {
    it("renders an all-0x00 tile band as all-0 pixels (palette 0xE4 identity)", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(Array.from(pages[0]!.pixels.slice(0, 16))).toEqual(new Array(16).fill(0));
    });

    it("renders an all-0xFF tile band as all-3 pixels (both bit-planes set)", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0xff);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      // A full row of pixels at value 3 (white-on-DMG = darkest on the
      // printer's inverted thermal output, but the engine just stores
      // the 0..3 luminance).
      expect(Array.from(pages[0]!.pixels.slice(0, 160))).toEqual(new Array(160).fill(3));
    });

    it("decodes 2bpp lo/hi-plane pairs correctly inside a tile (a single tile pattern)", () => {
      // Build one tile: row 0 has lo=0xAA hi=0x00, all other rows zeroed.
      // 0xAA = 1010_1010 → odd-indexed pixels (within this row) get value 1,
      // others 0. Pad to a full band with empty tiles.
      const tile = [0xaa, 0x00, ...new Array(14).fill(0)];
      const restEmpty = new Array((20 - 1) * 16).fill(0);
      const band = [...tile, ...restEmpty];
      drive(printer, packet(CMD_DATA, band));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      const row = Array.from(pages[0]!.pixels.slice(0, 8));
      // Bit 7 = leftmost. 0xAA = 10101010, so columns 0,2,4,6 are 1; 1,3,5,7 are 0.
      expect(row).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    });

    it("applies a non-identity palette to remap the 0..3 source values", () => {
      // Palette 0x1B remaps: 00→3, 01→2, 10→1, 11→0 (full inverse).
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0x1b, 0x40]));
      expect(pages[0]!.pixels[0]).toBe(3);
    });
  });

  describe("compressed DATA packets", () => {
    it("decompresses an RLE band before appending it to the buffer", () => {
      // 640 bytes of 0xFF → one repeat-run of 0xFF can encode at most 129
      // bytes per byte-pair (high bit + length 0..0x7F + 2 = up to 129).
      // Use multiple repeats to reach 640.
      const compressed: number[] = [];
      let remaining = PRINTER_BAND_BYTES;
      while (remaining > 0) {
        const run = Math.min(remaining, 129);
        compressed.push(0x80 | (run - 2), 0xff);
        remaining -= run;
      }
      drive(printer, packet(CMD_DATA, compressed, true));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      // Should land identical to an uncompressed all-0xFF band.
      expect(pages[0]!.height).toBe(16);
      expect(Array.from(pages[0]!.pixels.slice(0, 160))).toEqual(new Array(160).fill(3));
    });
  });

  describe("decompressRle (unit)", () => {
    it("expands a literal run", () => {
      // 0x02 = high bit clear, length 0x02 → next 3 bytes are literal.
      expect(decompressRle([0x02, 0xaa, 0xbb, 0xcc])).toEqual([0xaa, 0xbb, 0xcc]);
    });

    it("expands a repeat run", () => {
      // 0x80 = high bit set, length 0x00 → repeat next byte 2 times.
      expect(decompressRle([0x80, 0x42])).toEqual([0x42, 0x42]);
      // 0x82 = high bit set, length 0x02 → repeat 4 times.
      expect(decompressRle([0x82, 0x42])).toEqual([0x42, 0x42, 0x42, 0x42]);
    });

    it("interleaves literal and repeat runs", () => {
      // Literal [0x11], then repeat 0x22 three times, then literal [0x33, 0x44].
      const src = [0x00, 0x11, 0x81, 0x22, 0x01, 0x33, 0x44];
      expect(decompressRle(src)).toEqual([0x11, 0x22, 0x22, 0x22, 0x33, 0x44]);
    });

    it("returns an empty array on empty input", () => {
      expect(decompressRle([])).toEqual([]);
    });

    it("tolerates a truncated literal run by emitting only what it has", () => {
      // 0x05 promises 6 bytes, only 2 follow.
      expect(decompressRle([0x05, 0xaa, 0xbb])).toEqual([0xaa, 0xbb]);
    });
  });

  describe("status sequence after PRINT", () => {
    /** Build a printer with a controllable wall-clock so we can
     *  observe the wall-clock-gated 0x06 → 0x00 transition deterministically. */
    function withFakeClock(): { printer: Printer; pages: PrintedPage[]; clock: { ms: number } } {
      const clock = { ms: 0 };
      const p = new Printer(() => clock.ms);
      const pgs: PrintedPage[] = [];
      p.onPagePrinted = (page) => pgs.push(page);
      return { printer: p, pages: pgs, clock };
    }

    it("PRINT-packet trailer reads the *prior* status (0x08 from DATA's READY), not 0x06", () => {
      // In the STATUS state, the PRINT case sets `printWait = 0`,
      // but the reply is the current (pre-PRINT) status. The 0x06
      // transition happens in the post-state block that runs *after*
      // the status byte is delivered. So: PRINT trailer reads
      // whatever DATA left behind (0x08 = READY), and the cart's
      // next NUL reads 0x06.
      const { printer: p } = withFakeClock();
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(p, packet(CMD_DATA, oneBand));
      const printResp = drive(p, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(printResp.at(-1)).toBe(0x08);
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x06);
    });

    it("status holds 0x06 until the wall-clock 'done' deadline, then drops to 0x00", () => {
      // The cart's wait-for-done loop expects 0x06 (printing) for
      // multiple polls, then a transition straight to 0x00. No
      // intermediate 0x04 — sticky-0x04 paths cause the GB Camera
      // ROM to retry PRINT instead of exiting.
      const { printer: p, clock } = withFakeClock();
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(p, packet(CMD_DATA, oneBand));
      drive(p, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      // Many polls before the deadline — all 0x06.
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x06);
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x06);
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x06);
      // Jump past the deadline. The post-state block in this byte's
      // receive call clears bits 1+2 → 0x00. Subsequent polls see 0x00.
      clock.ms = 10_000;
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x00);
      expect(drive(p, packet(CMD_NUL)).at(-1)).toBe(0x00);
    });

    it("retried PRINT with empty buffer does not render a duplicate page (< 320-byte gate)", () => {
      // PRINT only fires the print-trigger if the buffer holds at
      // least 320 bytes (one band of 8 scanlines). The post-state
      // print block then clears the buffer. So a PRINT retried
      // without intervening DATA hits the < 320 gate and is silently
      // ignored — no duplicate page, no status change.
      const { printer: p, pages: pgs } = withFakeClock();
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(p, packet(CMD_DATA, oneBand));
      drive(p, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pgs).toHaveLength(1);
      drive(p, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      expect(pgs).toHaveLength(1);
    });
  });

  describe("STATUS_READY (0x08) after DATA", () => {
    it("sets the READY bit on the DATA packet's status trailer once the buffer crosses 0x280 bytes", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      // READY is set in the STATUS state of the DATA packet itself,
      // so the DATA packet's own trailer reads 0x08 — no need for a
      // separate NUL poll.
      const dataResp = drive(printer, packet(CMD_DATA, oneBand));
      expect(dataResp.at(-1)).toBe(0x08);
      // Persists across NUL polls.
      expect(drive(printer, packet(CMD_NUL)).at(-1)).toBe(0x08);
    });

    it("does not set READY for a partial DATA packet (under 0x280 bytes)", () => {
      const partial = new Array<number>(0x100).fill(0); // less than one band
      drive(printer, packet(CMD_DATA, partial));
      expect(drive(printer, packet(CMD_NUL)).at(-1)).toBe(0x00);
    });

    it("INIT clears READY (bit 3) but does NOT clear PRINTING (bit 1) — only the wall-clock done trigger does", () => {
      // INIT runs `status &= ~(PRINT_REQ | READY)`. It explicitly
      // does *not* touch PRINTING (bit 1) — that bit is owned by the
      // wall-clock done-trigger path. Verify the standard "INIT
      // after DATA" case clears READY here.
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      expect(drive(printer, packet(CMD_NUL)).at(-1)).toBe(0x08);
      drive(printer, packet(CMD_INIT));
      expect(drive(printer, packet(CMD_NUL)).at(-1)).toBe(0x00);
    });

    it("PRINT clears READY and sets PRINTING|PRINT_REQ in the post-state block (visible on next NUL)", () => {
      const oneBand = new Array<number>(PRINTER_BAND_BYTES).fill(0);
      drive(printer, packet(CMD_DATA, oneBand));
      drive(printer, packet(CMD_PRINT, [1, 0, 0xe4, 0x40]));
      // First NUL after PRINT reads the post-PRINT status: bit 3
      // cleared, bits 1+2 set → 0x06.
      expect(drive(printer, packet(CMD_NUL)).at(-1)).toBe(0x06);
    });
  });
});
