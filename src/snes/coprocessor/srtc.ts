/**
 * S-RTC — the Sharp real-time clock used by Dai Kaijuu Monogatari II. Two
 * ports live at $2800 (read) / $2801 (command+write) of banks $00-$3F /
 * $80-$BF; the game reads a 13-nibble BCD calendar (second, minute, hour,
 * day, month, year, weekday) and can rewrite it. The clock is seeded from
 * the host's wall-clock at power-on — the emulator surfaces real time rather
 * than a battery-persisted value — and holds whatever the game last wrote.
 *
 * Read/write protocol and the nibble register layout follow fullsnes
 * "SNES Cart S-RTC"; ported from the established open-source reference.
 */

const enum State {
  Ready,
  Command,
  Read,
  Write
}

export class Srtc {
  private state = State.Read;
  private index = -1;

  // BCD-decoded calendar. `year` is the RTC epoch-1000 offset (the chip's own
  // encoding: 1026 renders as 2026), matching the reference.
  private second = 0;
  private minute = 0;
  private hour = 0;
  private day = 1;
  private month = 1;
  private year = 1000;
  private weekday = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.state = State.Read;
    this.index = -1;
    const d = new Date();
    this.second = Math.min(59, d.getSeconds());
    this.minute = d.getMinutes();
    this.hour = d.getHours();
    this.day = d.getDate();
    this.month = 1 + d.getMonth();
    this.year = d.getFullYear() - 1000;
    this.weekday = d.getDay();
  }

  /** `off` is $2800 (read data) or $2801 (returns open bus on read). */
  read(off: number): number {
    if ((off & 1) === 0) {
      if (this.state !== State.Read) return 0;
      if (this.index < 0) {
        this.index++;
        return 15;
      }
      if (this.index > 12) {
        this.index = -1;
        return 15;
      }
      return this.rtcRead(this.index++);
    }
    return 0;
  }

  write(off: number, data: number): void {
    if ((off & 1) !== 1) return;
    data &= 15;

    if (data === 0x0d) {
      this.state = State.Read;
      this.index = -1;
      return;
    }
    if (data === 0x0e) {
      this.state = State.Command;
      return;
    }
    if (data === 0x0f) return; // unknown behaviour

    if (this.state === State.Command) {
      if (data === 0) {
        this.state = State.Write;
        this.index = 0;
      } else if (data === 4) {
        this.state = State.Ready;
        this.index = -1;
        this.second = this.minute = this.hour = this.day = this.month = this.year = this.weekday = 0;
      } else {
        this.state = State.Ready;
      }
      return;
    }

    if (this.state === State.Write) {
      if (this.index >= 0 && this.index < 12) {
        this.rtcWrite(this.index++, data);
        if (this.index === 12) {
          // Weekday is derived, not streamed by the game.
          this.weekday = new Date(1000 + this.year, this.month - 1, this.day).getDay();
        }
      }
    }
  }

  private rtcRead(addr: number): number {
    switch (addr) {
      case 0:
        return this.second % 10;
      case 1:
        return (this.second / 10) | 0;
      case 2:
        return this.minute % 10;
      case 3:
        return (this.minute / 10) | 0;
      case 4:
        return this.hour % 10;
      case 5:
        return (this.hour / 10) | 0;
      case 6:
        return this.day % 10;
      case 7:
        return (this.day / 10) | 0;
      case 8:
        return this.month;
      case 9:
        return this.year % 10;
      case 10:
        return ((this.year / 10) | 0) % 10;
      case 11:
        return (this.year / 100) | 0;
      case 12:
        return this.weekday;
      default:
        return 0;
    }
  }

  private rtcWrite(addr: number, data: number): void {
    switch (addr) {
      case 0:
        this.second = ((this.second / 10) | 0) * 10 + data;
        break;
      case 1:
        this.second = data * 10 + (this.second % 10);
        break;
      case 2:
        this.minute = ((this.minute / 10) | 0) * 10 + data;
        break;
      case 3:
        this.minute = data * 10 + (this.minute % 10);
        break;
      case 4:
        this.hour = ((this.hour / 10) | 0) * 10 + data;
        break;
      case 5:
        this.hour = data * 10 + (this.hour % 10);
        break;
      case 6:
        this.day = ((this.day / 10) | 0) * 10 + data;
        break;
      case 7:
        this.day = data * 10 + (this.day % 10);
        break;
      case 8:
        this.month = data;
        break;
      case 9:
        this.year = ((this.year / 10) | 0) * 10 + data;
        break;
      case 10:
        this.year = ((this.year / 100) | 0) * 100 + data * 10 + (this.year % 10);
        break;
      case 11:
        this.year = data * 100 + (this.year % 100);
        break;
      case 12:
        this.weekday = data;
        break;
    }
  }
}
