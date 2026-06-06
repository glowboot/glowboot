import { describe, expect, it } from "vitest";

import { GPIO_CS, GPIO_SCK, GPIO_SIO } from "./gpio.js";
import { S3511ARtc } from "./rtc.js";

/** All-outputs direction for the write side of a transaction (CPU
 *  drives SCK, CS, SIO). Used while the cart is clocking command
 *  bits and write-payload bits into the chip. */
const WRITE_DIR = GPIO_SCK | GPIO_CS | GPIO_SIO;

/** Direction with SIO flipped to cart-input — the cart pulses SCK
 *  and samples SIO from the chip. SCK + CS remain output. */
const READ_DIR = GPIO_SCK | GPIO_CS;

/** Begin a transaction: assert CS and shift in the 8-bit command
 *  byte LSB-first. Leaves CS asserted so a follow-up read or write
 *  payload can run on the same transaction. */
function beginCommand(rtc: S3511ARtc, cmd: number): void {
  rtc.onDataWrite(0, WRITE_DIR);
  rtc.onDataWrite(GPIO_CS, WRITE_DIR);
  for (let i = 0; i < 8; i++) {
    const sio = (cmd >>> i) & 1 ? GPIO_SIO : 0;
    rtc.onDataWrite(GPIO_CS | sio, WRITE_DIR);
    rtc.onDataWrite(GPIO_CS | sio | GPIO_SCK, WRITE_DIR);
  }
}

/** Clock a write payload (one or more LSB-first bytes) into the
 *  chip. Reuses the same WRITE_DIR direction (SIO output). */
function writePayload(rtc: S3511ARtc, bytes: number[]): void {
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      const sio = (byte >>> i) & 1 ? GPIO_SIO : 0;
      rtc.onDataWrite(GPIO_CS | sio, WRITE_DIR);
      rtc.onDataWrite(GPIO_CS | sio | GPIO_SCK, WRITE_DIR);
    }
  }
}

/** Drop CS, ending the transaction. The chip transitions to Idle. */
function endTransaction(rtc: S3511ARtc): void {
  rtc.onDataWrite(0, WRITE_DIR);
}

/** Drive `bitCount` clock edges with SIO as input and harvest the
 *  bits the chip drives on SIO. Mirrors real cart drivers: pulse SCK
 *  low → high, then sample — the chip presents each bit AT the rising
 *  edge, so the post-edge level is the bit. */
function readBits(rtc: S3511ARtc, bitCount: number): number[] {
  const bits: number[] = [];
  for (let i = 0; i < bitCount; i++) {
    rtc.onDataWrite(GPIO_CS, READ_DIR);
    rtc.onDataWrite(GPIO_CS | GPIO_SCK, READ_DIR);
    const sio = (rtc.readData(READ_DIR) & GPIO_SIO) !== 0 ? 1 : 0;
    bits.push(sio);
  }
  return bits;
}

/** Reassemble an LSB-first bit sequence into bytes. */
function bitsToBytes(bits: number[]): number[] {
  const bytes: number[] = [];
  for (let b = 0; b + 7 < bits.length; b += 8) {
    let byte = 0;
    for (let i = 0; i < 8; i++) byte |= bits[b + i]! << i;
    bytes.push(byte);
  }
  return bytes;
}

/** Build a command byte as it appears after LSB-first assembly: the
 *  `0110` magic in the low nibble (it travels first on the wire), the
 *  3-bit cmd in bits 4-6, the R/W select in bit 7 (1 = read). */
function makeCommand(cmd: number, isRead: boolean): number {
  return 0x06 | ((cmd & 0x7) << 4) | (isRead ? 0x80 : 0);
}

/** Control register is command 4 (NOT 1 — 1/5/7 are unused). */
const CMD_CONTROL = 4;

/** Full write-command transaction: begin command, write payload,
 *  end. Suitable for Status writes etc. that don't need a held-CS
 *  read phase afterwards. */
function writeCommand(rtc: S3511ARtc, cmd: number, payload: number[]): void {
  beginCommand(rtc, cmd);
  writePayload(rtc, payload);
  endTransaction(rtc);
}

/** Full read-command transaction: begin command, harvest the
 *  requested bit count, end. */
function readCommand(rtc: S3511ARtc, cmd: number, byteCount: number): number[] {
  beginCommand(rtc, cmd);
  const bits = readBits(rtc, byteCount * 8);
  endTransaction(rtc);
  return bitsToBytes(bits);
}

describe("S3511ARtc — protocol", () => {
  it("ignores commands whose low nibble isn't the magic 0x6", () => {
    const rtc = new S3511ARtc();
    // Low nibble 0x3 — not the magic. Chip should silently abort.
    beginCommand(rtc, 0x73);
    const bits = readBits(rtc, 8);
    endTransaction(rtc);
    expect(bits.every((b) => b === 0)).toBe(true);
  });

  it("Reset command zeroes the status register", () => {
    const rtc = new S3511ARtc();
    // Seed the status register so the post-reset zero is observable.
    writeCommand(rtc, makeCommand(CMD_CONTROL, /* read */ false), [0x40]);
    expect(readCommand(rtc, makeCommand(CMD_CONTROL, true), 1)).toEqual([0x40]);
    // Reset.
    writeCommand(rtc, makeCommand(0, false), []);
    expect(readCommand(rtc, makeCommand(CMD_CONTROL, true), 1)).toEqual([0]);
  });

  it("Status round-trips a cart write through a subsequent read", () => {
    const rtc = new S3511ARtc();
    writeCommand(rtc, makeCommand(CMD_CONTROL, false), [0x40]);
    expect(readCommand(rtc, makeCommand(CMD_CONTROL, true), 1)).toEqual([0x40]);
  });

  it("DateTime read produces 7 BCD bytes from the injected time", () => {
    // 2026-05-29 (Friday) at 14:30:45.
    const fixed = new Date(2026, 4, 29, 14, 30, 45); // month is 0-indexed
    const rtc = new S3511ARtc(() => fixed);
    expect(readCommand(rtc, makeCommand(2, true), 7)).toEqual([
      0x26, // year (2026 % 100 BCD)
      0x05, // month
      0x29, // day
      5, // day-of-week (Friday)
      0x14, // hours (BCD 24h)
      0x30, // minutes
      0x45 // seconds
    ]);
  });

  it("Time read produces 3 BCD bytes (h/m/s)", () => {
    const fixed = new Date(2026, 4, 29, 14, 30, 45);
    const rtc = new S3511ARtc(() => fixed);
    expect(readCommand(rtc, makeCommand(6, true), 3)).toEqual([0x14, 0x30, 0x45]);
  });

  it("CS deassert mid-transaction resets the state machine", () => {
    const rtc = new S3511ARtc();
    // Start a Control-read but drop CS halfway through the command byte.
    rtc.onDataWrite(0, WRITE_DIR);
    rtc.onDataWrite(GPIO_CS, WRITE_DIR);
    for (let i = 0; i < 4; i++) {
      const bit = (0x63 >>> i) & 1;
      rtc.onDataWrite(GPIO_CS | (bit ? GPIO_SIO : 0), WRITE_DIR);
      rtc.onDataWrite(GPIO_CS | (bit ? GPIO_SIO : 0) | GPIO_SCK, WRITE_DIR);
    }
    rtc.onDataWrite(0, WRITE_DIR); // CS low — abort
    // A fresh Control read should now show the post-power-on default.
    expect(readCommand(rtc, makeCommand(CMD_CONTROL, true), 1)).toEqual([0x40]);
  });

  it("BCD encoding handles two-digit values correctly", () => {
    const fixed = new Date(2099, 11, 31, 23, 59, 59);
    const rtc = new S3511ARtc(() => fixed);
    const bytes = readCommand(rtc, makeCommand(2, true), 7);
    expect(bytes[0]).toBe(0x99); // year
    expect(bytes[1]).toBe(0x12); // month
    expect(bytes[2]).toBe(0x31); // day
    expect(bytes[4]).toBe(0x23); // hours
    expect(bytes[5]).toBe(0x59); // minutes
    expect(bytes[6]).toBe(0x59); // seconds
  });

  it("DateTime write moves the chip clock and keeps it advancing with host time", () => {
    let host = new Date(2026, 5, 5, 10, 0, 0);
    const rtc = new S3511ARtc(() => host);
    // Cart sets 2026-01-02 20:30:00 (Friday) — chip-internal dow byte is ignored.
    writeCommand(rtc, makeCommand(2, false), [0x26, 0x01, 0x02, 0x05, 0x20, 0x30, 0x00]);
    expect(readCommand(rtc, makeCommand(2, true), 7)).toEqual([0x26, 0x01, 0x02, 0x05, 0x20, 0x30, 0x00]);
    // One host minute later the set clock has advanced by one minute.
    host = new Date(2026, 5, 5, 10, 1, 0);
    expect(readCommand(rtc, makeCommand(6, true), 3)).toEqual([0x20, 0x31, 0x00]);
  });

  it("Time write changes time-of-day but keeps the chip's current date", () => {
    const rtc = new S3511ARtc(() => new Date(2026, 5, 5, 10, 0, 0));
    writeCommand(rtc, makeCommand(6, false), [0x07, 0x15, 0x30]);
    const bytes = readCommand(rtc, makeCommand(2, true), 7);
    expect(bytes).toEqual([0x26, 0x06, 0x05, 0x05, 0x07, 0x15, 0x30]);
  });

  it("malformed BCD in a time write is rejected without moving the clock", () => {
    const rtc = new S3511ARtc(() => new Date(2026, 5, 5, 10, 0, 0));
    writeCommand(rtc, makeCommand(6, false), [0xaa, 0xbb, 0xcc]);
    expect(readCommand(rtc, makeCommand(6, true), 3)).toEqual([0x10, 0x00, 0x00]);
  });

  it("chipState round-trips a set clock + status through a fresh chip (battery backing)", () => {
    const host = new Date(2026, 5, 5, 10, 0, 0);
    const rtc = new S3511ARtc(() => host);
    writeCommand(rtc, makeCommand(CMD_CONTROL, false), [0x40]);
    writeCommand(rtc, makeCommand(2, false), [0x26, 0x01, 0x02, 0x05, 0x20, 0x30, 0x00]);
    const persisted = rtc.chipState;

    const fresh = new S3511ARtc(() => host);
    fresh.chipState = persisted;
    expect(readCommand(fresh, makeCommand(CMD_CONTROL, true), 1)).toEqual([0x40]);
    expect(readCommand(fresh, makeCommand(2, true), 7)).toEqual([0x26, 0x01, 0x02, 0x05, 0x20, 0x30, 0x00]);
  });

  it("Reset clears status but preserves the cart-set clock", () => {
    // Boktai resets the chip on every cold boot; a Reset that wiped
    // the time would lose the player's clock on each power cycle.
    const rtc = new S3511ARtc(() => new Date(2026, 5, 5, 10, 0, 0));
    writeCommand(rtc, makeCommand(CMD_CONTROL, false), [0x40]);
    writeCommand(rtc, makeCommand(6, false), [0x07, 0x15, 0x30]);
    beginCommand(rtc, makeCommand(0, false));
    endTransaction(rtc);
    expect(readCommand(rtc, makeCommand(CMD_CONTROL, true), 1)).toEqual([0x00]);
    expect(readCommand(rtc, makeCommand(6, true), 3)).toEqual([0x07, 0x15, 0x30]);
  });
});
