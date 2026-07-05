import { describe, expect, it } from "vitest";

import { Srtc } from "./srtc.js";

// Read the 13-nibble calendar via the $2800/$2801 protocol: enter read mode,
// then read the leading 15 sentinel followed by nibbles 0-12.
function readCalendar(rtc: Srtc): number[] {
  rtc.write(0x2801, 0x0d); // enter read mode
  const out: number[] = [];
  expect(rtc.read(0x2800)).toBe(15); // leading sentinel
  for (let i = 0; i < 13; i++) out.push(rtc.read(0x2800));
  expect(rtc.read(0x2800)).toBe(15); // trailing sentinel, resets index
  return out;
}

describe("Srtc", () => {
  it("streams a settable BCD calendar round-trip", () => {
    const rtc = new Srtc();
    // Program 1996-07-04 12:34:56, via command mode → write mode.
    rtc.write(0x2801, 0x0e); // command
    rtc.write(0x2801, 0x00); // write mode, index 0
    // sec 56, min 34, hr 12, day 04, month 7, year field 996 (= 1996, the
    // chip's epoch-1000 encoding).
    const nibbles = [6, 5, 4, 3, 2, 1, 4, 0, 7, 6, 9, 9];
    for (const n of nibbles) rtc.write(0x2801, n);

    const cal = readCalendar(rtc);
    expect(cal.slice(0, 12)).toEqual(nibbles);
    // Weekday is derived from the written date (1996-07-04 was a Thursday = 4).
    expect(cal[12]).toBe(4);
  });

  it("returns 0 when read outside read mode", () => {
    const rtc = new Srtc();
    rtc.write(0x2801, 0x0e); // command mode
    expect(rtc.read(0x2800)).toBe(0);
  });

  it("resets the calendar to zero on command 4", () => {
    const rtc = new Srtc();
    rtc.write(0x2801, 0x0e);
    rtc.write(0x2801, 0x04); // reset time
    const cal = readCalendar(rtc);
    expect(cal).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("ignores writes to the read port and reads from the write port", () => {
    const rtc = new Srtc();
    rtc.write(0x2800, 0x0e); // even port → not a command
    // Still in the default read mode: a real command must go through $2801.
    expect(rtc.read(0x2801)).toBe(0); // odd port read is open bus
  });
});
