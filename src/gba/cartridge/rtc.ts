/**
 * Seiko S-3511A real-time-clock chip emulation, wired through the
 * GBA cart GPIO port.
 *
 * The S-3511A is what every Pokémon Gen 3 cart and the Boktai trilogy
 * use for in-game timekeeping (berry growth in Ruby/Sapphire/Emerald,
 * the daily Lottery Corner in Pokémon FireRed/LeafGreen, day/night
 * cycles, real-time enemy schedules in Boktai). The cart talks to the
 * chip over three GPIO pins:
 *
 *   SCK (bit 0): serial clock — cart drives, RTC samples on rising edge
 *   SIO (bit 1): serial data — bidirectional; cart drives during writes,
 *                 chip drives during reads
 *   CS  (bit 2): chip select — high asserts, low ends a transaction
 *
 * Transaction shape:
 *   1. CS low → high asserts the chip.
 *   2. Cart shifts in an 8-bit command byte, LSB-first. Assembled that
 *      way, bits 0-3 are the `0110` magic, bits 4-6 the command code,
 *      bit 7 the read/write select (1 = read).
 *   3. For read commands, the cart flips SIO to input and pulses SCK;
 *      the chip presents one bit per rising edge, LSB-first per byte.
 *   4. For write commands, the cart keeps SIO as output and shifts the
 *      payload in (LSB-first). The chip samples on rising edges.
 *   5. Cart pulls CS low to end the transaction.
 *
 * Command codes (payload bytes in parens):
 *   0 = force reset (0) — clears the control register, clock keeps
 *       running (Boktai issues this on every cold boot; a reset that
 *       wiped the time would lose the player's clock per power cycle)
 *   2 = full date+time (7 BCD: year, month, day, dow, h, m, s)
 *   3 = force IRQ (0) — pulses /INT, wired to the GamePak IRQ
 *   4 = control register (1)
 *   6 = time-only (3 BCD: h, m, s)
 *   1 / 5 / 7 = unused on this chip (no payload)
 *
 * Time source: host wall clock plus `offsetMs`. The offset starts at 0
 * (cart sees real time) and moves when the cart writes the DateTime /
 * Time registers — the chip is battery-backed on real hardware, so a
 * cart-set clock has to stick and keep advancing. The host persists
 * `chipState` (status + offset) alongside the cart's save RAM so the
 * set clock also survives power cycles, exactly like the real battery
 * does. Tests inject a deterministic `now()` callback through the
 * constructor.
 */

import { GPIO_CS, GPIO_SCK, GPIO_SIO, type GpioFeature } from "./gpio.js";

/** Magic nibble in the low 4 bits of every LSB-first-assembled S-3511A
 *  command byte. The chip ignores commands whose nibble doesn't match. */
const COMMAND_MAGIC = 0x6;

/** Command codes (bits 4-6 of the LSB-first-assembled command byte). */
const enum Cmd {
  Reset = 0,
  DateTime = 2,
  ForceIrq = 3,
  Control = 4,
  Time = 6
}

/** Internal transaction phase. CS = low → `Idle`; CS = high → walk
 *  through Command (shifting in 8 bits) → either Read (chip drives
 *  payload) or Write (cart drives payload) until CS falls again. */
const enum Phase {
  Idle,
  Command,
  Read,
  Write
}

/** Pack a 0-99 decimal value as a single BCD byte. */
function bcd(n: number): number {
  return ((Math.floor(n / 10) % 10) << 4) | (n % 10);
}

/** Reverse the bit order of one byte (MSB-first ↔ LSB-first). */
function bitrev8(b: number): number {
  b = ((b & 0xf0) >>> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >>> 2) | ((b & 0x33) << 2);
  return ((b & 0xaa) >>> 1) | ((b & 0x55) << 1);
}

/** Decode a single BCD byte, or null when either nibble is not a
 *  decimal digit (garbage from a desynced transfer must not move the
 *  clock). */
function unbcd(b: number): number | null {
  const hi = (b >>> 4) & 0xf;
  const lo = b & 0xf;
  return hi > 9 || lo > 9 ? null : hi * 10 + lo;
}

/** Build a Date from the chip's BCD register layout, or null when any
 *  field is malformed / out of range. The hour byte's bit 7 is the
 *  chip's AM/PM indicator — masked off, the remaining BCD value is the
 *  24-hour count either way. Years are 2000-based per the datasheet. */
function dateFromBcd(yy: number, mm: number, dd: number, hh: number, mi: number, ss: number): Date | null {
  const year = unbcd(yy);
  const month = unbcd(mm);
  const day = unbcd(dd);
  const hour = unbcd(hh & 0x7f);
  const minute = unbcd(mi);
  const second = unbcd(ss);
  if (year === null || month === null || day === null || hour === null || minute === null || second === null)
    return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(2000 + year, month - 1, day, hour, minute, second);
}

export class S3511ARtc implements GpioFeature {
  /** Status register. Pokémon writes 0x40 (24-hour-mode bit) after
   *  power-on; we expose it back unchanged on subsequent reads. */
  private status = 0x40;

  /** Milliseconds between the host clock and the cart-set clock. 0
   *  until the cart writes DateTime / Time; the host persists it with
   *  the save RAM so a cart-set clock survives power cycles. */
  private offsetMs = 0;

  /** Current transaction phase. */
  private phase: Phase = Phase.Idle;

  /** Latest CS / SCK levels from the CPU, for edge detection. */
  private lastCs = 0;
  private lastSck = 0;

  /** Command byte being shifted in (during Phase.Command) or having
   *  been decoded (during Phase.Read / Phase.Write). */
  private cmdByte = 0;
  /** Number of command bits received so far in Phase.Command. */
  private cmdBitsReceived = 0;

  /** Payload bytes for the current read or write — populated when the
   *  command transitions out of Phase.Command. */
  private payload: number[] = [];
  /** Index of the byte currently being transferred. */
  private payloadByteIdx = 0;
  /** Index of the bit within that byte (0 = LSB). */
  private payloadBitIdx = 0;
  /** Output latch driven onto SIO. The chip presents each read bit at
   *  an SCK edge and the cart samples the level afterwards — serving
   *  bits straight from an index that advances on the same edge would
   *  shift the whole response by one bit from the cart's perspective. */
  private sioLatch = 0;

  /** Raised by the ForceIrq command — the chip's /INT line, wired to
   *  the GamePak IRQ (IF bit 13) by the engine. Boktai uses it. */
  onForceIrq: (() => void) | null = null;

  /** Optional time source override for tests. Defaults to wall clock. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  // ── GpioFeature contract ─────────────────────────────────────────

  onDataWrite(cpuData: number, direction: number): void {
    const cs = (cpuData & GPIO_CS) !== 0 ? 1 : 0;
    const sck = (cpuData & GPIO_SCK) !== 0 ? 1 : 0;
    const sioOut = (cpuData & GPIO_SIO) !== 0 ? 1 : 0;
    const sioIsCpuDriven = (direction & GPIO_SIO) !== 0;

    // CS edge — start / end a transaction.
    if (cs !== this.lastCs) {
      if (cs === 1) {
        this.phase = Phase.Command;
        this.cmdByte = 0;
        this.cmdBitsReceived = 0;
        this.sioLatch = 0;
      } else {
        // CS low — abandon any in-flight transaction. The chip's
        // protocol allows the cart to drop CS at any point to abort.
        this.phase = Phase.Idle;
      }
      this.lastCs = cs;
    }

    // Rising SCK edge — clock data in (Command / Write) or out (Read).
    if (sck === 1 && this.lastSck === 0 && this.phase !== Phase.Idle) {
      if (this.phase === Phase.Command) {
        if (sioIsCpuDriven) {
          this.cmdByte |= sioOut << this.cmdBitsReceived;
        }
        this.cmdBitsReceived++;
        if (this.cmdBitsReceived === 8) this.decodeCommand();
      } else if (this.phase === Phase.Write && sioIsCpuDriven) {
        const byte = this.payload[this.payloadByteIdx] ?? 0;
        this.payload[this.payloadByteIdx] = byte | (sioOut << this.payloadBitIdx);
        this.advancePayloadIndex();
        if (this.payloadByteIdx >= this.payload.length) {
          this.commitWrite();
          this.phase = Phase.Idle;
        }
      } else if (this.phase === Phase.Read) {
        // Latch the current bit onto SIO, THEN advance — the cart
        // samples the data register after this edge and must see the
        // bit the edge presented (bit 0 lands on the first edge).
        if (this.payloadByteIdx < this.payload.length) {
          this.sioLatch = (this.payload[this.payloadByteIdx]! >>> this.payloadBitIdx) & 1;
        }
        this.advancePayloadIndex();
        if (this.payloadByteIdx >= this.payload.length) this.phase = Phase.Idle;
      }
    }
    this.lastSck = sck;
  }

  readData(direction: number): number {
    // We only drive SIO, and only when SIO is configured as cart-input
    // (direction bit 1 = 0). The latch holds the bit presented at the
    // last SCK edge; it survives the transition out of Phase.Read so
    // the final bit of a response stays readable after the edge that
    // completed the transfer.
    if ((direction & GPIO_SIO) !== 0) return 0;
    if (this.phase !== Phase.Read && (this.phase !== Phase.Idle || this.lastCs === 0)) return 0;
    return this.sioLatch << 1;
  }

  // ── Internal protocol decoder ────────────────────────────────────

  private decodeCommand(): void {
    // Commands travel in either bit order — carts differ. Assembled
    // LSB-first: the `0110` magic lands in the LOW nibble when the
    // cart transmitted LSB-first, and in the HIGH nibble when it
    // transmitted MSB-first (then the whole byte reads bit-reversed).
    // Bytes that show the magic in neither nibble are ignored like
    // real silicon ignores them.
    if (this.cmdByte >>> 4 === COMMAND_MAGIC) {
      this.cmdByte = bitrev8(this.cmdByte);
    } else if ((this.cmdByte & 0xf) !== COMMAND_MAGIC) {
      this.phase = Phase.Idle;
      return;
    }

    const cmd = (this.cmdByte >>> 4) & 0x7;
    const isRead = (this.cmdByte & 0x80) !== 0;

    switch (cmd) {
      case Cmd.Reset:
        // Clears the control register but NOT the running clock —
        // Boktai issues a Reset on every cold boot (control read →
        // Reset → control write → time reads), and its clock survives
        // power cycles on real hardware, so the chip's Reset provably
        // leaves the time registers ticking.
        this.status = 0;
        this.phase = Phase.Idle;
        return;

      case Cmd.Control:
        if (isRead) {
          this.payload = [this.status & 0xff];
        } else {
          this.payload = [0];
        }
        this.beginPayload(isRead);
        return;

      case Cmd.DateTime:
        if (isRead) {
          this.payload = this.snapshotDateTime();
        } else {
          this.payload = [0, 0, 0, 0, 0, 0, 0];
        }
        this.beginPayload(isRead);
        return;

      case Cmd.Time:
        if (isRead) {
          this.payload = this.snapshotDateTime().slice(4);
        } else {
          this.payload = [0, 0, 0];
        }
        this.beginPayload(isRead);
        return;

      case Cmd.ForceIrq:
        // No payload — pulses the chip's /INT line, which the cart
        // wires to the GamePak IRQ.
        this.onForceIrq?.();
        this.phase = Phase.Idle;
        return;

      default:
        // 1 / 5 / 7 — unused on this chip, no payload.
        this.phase = Phase.Idle;
    }
  }

  private beginPayload(isRead: boolean): void {
    this.payloadByteIdx = 0;
    this.payloadBitIdx = 0;
    this.phase = isRead ? Phase.Read : Phase.Write;
  }

  private advancePayloadIndex(): void {
    this.payloadBitIdx++;
    if (this.payloadBitIdx === 8) {
      this.payloadBitIdx = 0;
      this.payloadByteIdx++;
    }
  }

  private commitWrite(): void {
    const cmd = (this.cmdByte >>> 4) & 0x7;
    if (cmd === Cmd.Control && this.payload.length >= 1) {
      this.status = this.payload[0]! & 0xff;
    } else if (cmd === Cmd.DateTime && this.payload.length >= 7) {
      // [yy, mm, dd, dow, hh, mi, ss] — dow is chip-internal, the
      // wall-clock instant alone determines it on our side.
      const [yy, mm, dd, , hh, mi, ss] = this.payload;
      const target = dateFromBcd(yy!, mm!, dd!, hh!, mi!, ss!);
      if (target) this.offsetMs = target.getTime() - this.now().getTime();
    } else if (cmd === Cmd.Time && this.payload.length >= 3) {
      // Time-of-day only — keep the chip's current date.
      const cur = this.chipNow();
      const [hh, mi, ss] = this.payload;
      const target = dateFromBcd(
        bcd(cur.getFullYear() % 100),
        bcd(cur.getMonth() + 1),
        bcd(cur.getDate()),
        hh!,
        mi!,
        ss!
      );
      if (target) this.offsetMs = target.getTime() - this.now().getTime();
    }
  }

  /** The instant the chip currently shows: host clock + cart-set offset. */
  private chipNow(): Date {
    return new Date(this.now().getTime() + this.offsetMs);
  }

  private snapshotDateTime(): number[] {
    const d = this.chipNow();
    return [
      bcd(d.getFullYear() % 100),
      bcd(d.getMonth() + 1),
      bcd(d.getDate()),
      d.getDay() & 0x7,
      bcd(d.getHours()),
      bcd(d.getMinutes()),
      bcd(d.getSeconds())
    ];
  }

  /** Battery-backed chip state for host-side persistence — saved and
   *  restored alongside the cart's save RAM so a cart-set clock and the
   *  cart's status configuration survive power cycles like the real
   *  chip's button cell. */
  get chipState(): { status: number; offsetMs: number } {
    return { status: this.status, offsetMs: this.offsetMs };
  }

  set chipState(state: { status: number; offsetMs: number }) {
    this.status = state.status & 0xff;
    this.offsetMs = Number.isFinite(state.offsetMs) ? state.offsetMs : 0;
  }
}
