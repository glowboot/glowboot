/**
 * Cartridge / ROM loader.
 *
 * Parses the cartridge header and exposes read/write for the
 * Memory Bank Controller (MBC).
 *
 * Header offsets:
 *   0x0134–0x0143  Title
 *   0x0147         Cartridge type (MBC type)
 *   0x0148         ROM size code
 *   0x0149         RAM size code
 */

import type { StateReader, StateWriter } from "../serialization/serialization.js";

const ROM_SIZE_TABLE: Record<number, number> = {
  0x00: 2, // 32 KiB  – no banking
  0x01: 4, // 64 KiB
  0x02: 8, // 128 KiB
  0x03: 16, // 256 KiB
  0x04: 32, // 512 KiB
  0x05: 64, // 1 MiB
  0x06: 128, // 2 MiB
  0x07: 256, // 4 MiB
  0x08: 512 // 8 MiB
};

const RAM_SIZE_TABLE: Record<number, number> = {
  0x00: 0,
  0x01: 0, // Unused (2 KiB in some docs)
  0x02: 1, // 8 KiB  – 1 bank
  0x03: 4, // 32 KiB – 4 banks
  0x04: 16, // 128 KiB
  0x05: 8 // 64 KiB
};

export type MBCType = "ROM_ONLY" | "MBC1" | "MBC2" | "MBC3" | "MBC5" | "MBC7" | "CAMERA" | "HUC1";

/** Map a host-side tilt input in roughly `[-1, +1]` g-units to the
 *  16-bit raw value MBC7's accelerometer reports. The cart calibrates
 *  against `0x81D0` as the rest-flat value and treats `±0x70` as one
 *  Earth gravity along that axis. The result is clamped to a safe band
 *  so freak host inputs (e.g. a 4 g shake) don't roll past the cart's
 *  dead-zone interpretation. */
function mbc7ScaleAxis(g: number): number {
  const clamped = g < -2 ? -2 : g > 2 ? 2 : g;
  return (0x81d0 + Math.round(0x70 * clamped)) & 0xffff;
}

/** Cart type codes whose cartridges include a battery for RAM persistence. */
const BATTERY_TYPES = new Set([0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff]);

/** CRC32 (IEEE polynomial) of the 48-byte logo region at cart offsets
 *  0x0104–0x0133. Real hardware checks this region byte-for-byte before
 *  running a cart; comparing a 32-bit fingerprint instead keeps the
 *  same "is this even a ROM?" gate. */
const LOGO_CRC32 = 0x46195417;

/** Minimal CRC32 (IEEE polynomial) inlined so the engine stays
 *  self-contained. Table is built lazily on first call; validation is
 *  the only code path that uses it. */
let crcTable: Int32Array | null = null;
function crc32Range(data: Uint8Array, start: number, endExclusive: number): number {
  if (!crcTable) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crcTable = t;
  }
  let c = 0 ^ -1;
  for (let i = start; i < endExclusive; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]!) & 0xff]!;
  return (c ^ -1) >>> 0;
}

export class Cartridge {
  readonly rom: Uint8Array;
  readonly ram: Uint8Array;
  readonly title: string;
  readonly mbcType: MBCType;
  readonly romBanks: number;
  readonly ramBanks: number;

  /** True for CGB-compatible or CGB-only carts (header byte 0x143 bit 7). */
  readonly cgb: boolean;
  /** Cart has a battery-backed RAM (needs persistence across sessions). */
  readonly hasBattery: boolean;
  /** 16-bit global ROM checksum (header bytes 0x14E–0x14F), big-endian. */
  readonly globalChecksum: number;
  /** Raw cart-type byte at 0x0147 — useful for deep diagnostics. */
  readonly typeCode: number;
  /** CGB flag byte at 0x0143 (0x80 = CGB-enhanced, 0xC0 = CGB-only). */
  readonly cgbFlag: number;
  /** 0x0150 destination code (0x00 = Japan, 0x01 = overseas). */
  readonly destinationCode: number;
  /** Old licensee byte at 0x014B. 0x33 means "see new licensee bytes". */
  readonly licenseeCode: number;
  /** New licensee code as 2 ASCII chars, or null if the old code isn't 0x33. */
  readonly newLicensee: string | null;
  /** Header checksum (byte 0x014D) as written by the manufacturer. */
  readonly headerChecksum: number;
  /** Title bytes including the manufacturer/CGB-flag tail, trimmed of NULs. */
  readonly rawTitle: string;

  private romBank = 1;
  private ramBank = 0;

  /** Current ROM bank mapped at 0x4000–0x7FFF, masked to the cart's physical
   *  bank count. Read-only public surface for the debugger's symbol lookup. */
  get currentRomBank(): number {
    return this.romBank & (this.romBanks - 1);
  }
  private ramEnabled = false;
  private mbc1Mode = false; // false = ROM banking, true = RAM banking

  /** Flips to `true` on any external-RAM write; cleared by `clearDirty()`. */
  private _ramDirty = false;
  get ramDirty(): boolean {
    return this._ramDirty;
  }
  clearDirty(): void {
    this._ramDirty = false;
  }

  // ─── MBC3 RTC ─────────────────────────────────────────────────────────────
  // Registers S (0x08), M (0x09), H (0x0A), DL (0x0B), DH (0x0C). Each is
  // a separate hardware counter, not derived from a monotonic seconds
  // total. This matters because real HW wraps at the register's *used*
  // bit width (6-bit for S/M, 5-bit for H, 9-bit for D) but only
  // propagates a carry when the counter hits its "natural" overflow value
  // (60 for S/M, 24 for H, 512 for D). Writing 63 to S and ticking goes
  // 63→0 with NO carry to M — something the rtc3test "invalid time"
  // subtests probe directly.
  private rtcRegister = -1;

  /** Live register bytes — advance via `catchUpRtc()` before any operation. */
  private rtcS = 0;
  private rtcM = 0;
  private rtcH = 0;
  private rtcDL = 0;
  private rtcDH = 0;

  /** Latched snapshot returned by reads (populated by the 0→1 latch). */
  private rtcLS = 0;
  private rtcLM = 0;
  private rtcLH = 0;
  private rtcLDL = 0;
  private rtcLDH = 0;

  /** T-cycle accumulator toward the next 1-Hz RTC tick. Driven by
   *  `tickRtc(tCycles)` from the frame pacer — so the RTC ticks at one
   *  second of *emulated* time, aligning it with whatever CPU-cycle-based
   *  timing the game (or a test ROM) uses to measure elapsed seconds. */
  private rtcTickAccum = 0;
  private rtcLatchStage = -1;

  /** Wall-clock at the moment this instance was constructed / restored.
   *  Only used by `serializeRtc`/`deserializeRtc` to fast-forward the RTC
   *  by real time elapsed between sessions (so games see the actual
   *  calendar drift while the tab was closed). */
  private rtcSavedAtMs = Date.now();
  /** MBC3 with battery and timer bit (header codes 0x0F/0x10) can persist RTC. */
  readonly hasRtc: boolean;
  /** MBC5 rumble variants (cart type codes 0x1C / 0x1D / 0x1E). The
   *  cart wires its RAM-bank register's bit 3 to a vibration motor —
   *  games like Pokémon Pinball, Perfect Dark (GBC), and Shantae
   *  toggle it during impacts / explosions. */
  readonly hasRumble: boolean;
  /** Live rumble signal reflected in writes to the RAM-bank register
   *  for rumble carts. Read-only from outside; the MBC5 write path
   *  updates it and fires `onRumbleChange`. */
  rumbleOn = false;
  /** Optional host hook invoked when the rumble bit flips. Typically
   *  wired to a Gamepad-API vibration actuator by the UI layer. */
  onRumbleChange: ((on: boolean) => void) | null = null;

  // ─── Game Boy Camera (MBC 0xFC) ────────────────────────────────────────
  // MBC5-shaped (8-bit ROM bank, 4-bit RAM bank) with a "camera mode"
  // bit (bit 4 of the bank-register write at 0x4000) layered on top.
  // When camera mode is on, A000-BFFF mirrors a 128-byte sensor register
  // file (the cart masks the address with 0x7F). Only register 0 is
  // readable — every other offset returns 0, regardless of what the ROM
  // previously wrote. Register 0's bit 0 is the busy flag: the ROM
  // writes 1 to trigger capture, polls until bit 0 clears. The captured
  // 128×112 frame lands in cart RAM bank 0 at offset 0x100 (3584 bytes,
  // GB 2bpp tile-row-major layout), which the ROM reads back via the
  // regular A000-AFFF window after toggling camera mode off. Live-view
  // is just "trigger every frame and blit cart RAM bank 0 to VRAM" — no
  // separate streaming path.
  private cameraMode = false;

  /** M64283FP register file. ROM writes via `writeCamera`; the host
   *  capture pipeline reads exposure (regs 2-3) and the 4×4 dither
   *  matrix (regs 6-0x35) when synthesising a frame. Public for the
   *  webcam capture path; `readonly` prevents reassignment but the
   *  underlying bytes are mutated freely. */
  readonly cameraRegs = new Uint8Array(128);
  /** Host callback invoked when the ROM kicks off a capture by writing
   *  1 to bit 0 of A000. The host (UI layer) fills the camera image
   *  area with a fresh 128×112 dithered frame from the webcam, then
   *  the cart synchronously clears the busy bit so the polling ROM
   *  sees "done" on its next read. Null when no webcam is wired up —
   *  in that case captures complete instantly with whatever bytes
   *  already lived in the image area (typically zeros). */
  onCameraCapture: ((cart: Cartridge) => void) | null = null;

  // ─── MBC7 (cart type 0x22 — Kirby Tilt 'n' Tumble) ────────────────────
  // MBC5-shaped ROM banking with two extras layered on top:
  //  - 2-axis ADXL202 accelerometer mapped into A000-AFFF, with a
  //    `0x55 → 0xAA` write handshake to latch a fresh sample.
  //  - 256-byte 93C46-class serial EEPROM at A080, accessed by bit-
  //    banging CS / CLK / DI through a single byte register.
  // The register window decodes by bits 4-7 of the address (`addr >> 4`
  // & 0xF), so all of A0_0_x mirror, all of A0_1_x mirror, etc.
  /** MBC7 needs a second RAM-enable handshake on top of the standard
   *  one — both must be set before A000-AFFF reads/writes are honoured. */
  private mbc7SecondaryEnable = false;
  /** True after a `0x55` write to register 0; required before a `0xAA`
   *  write to register 1 will sample a fresh tilt reading. */
  private mbc7LatchReady = false;
  /** Latched X / Y readings in the cart's native scale (`0x81D0 ± 0x70`).
   *  Initial value `0x8000` is the "no sample yet" sentinel real
   *  hardware reports before the first latch. */
  private mbc7XLatch = 0x8000;
  private mbc7YLatch = 0x8000;

  /** EEPROM control-line state, mirrored into bits 0/1/6/7 of A080. */
  private mbc7EepCS = 0;
  private mbc7EepCLK = 0;
  private mbc7EepDI = 0;
  private mbc7EepDO = 1;

  /** Set to `true` by the `EWEN` (erase/write enable) command and
   *  cleared by `EWDS`. Programming ops (WRITE/ERASE/WRAL/ERAL) only
   *  succeed when this flag is on; otherwise they're silently dropped. */
  private mbc7EepWriteEnabled = false;
  /** Bit-stream shift register collecting the command frame the cart
   *  is clocking in. Top bit is the start sentinel (`1` once seen). */
  private mbc7EepShift = 0;
  private mbc7EepShiftBits = 0;

  /** When non-zero, the EEPROM is in the data-output phase of a READ
   *  command; bits are clocked out of `mbc7EepReadBits` MSB-first. */
  private mbc7EepReadBits = 0;
  /** What the EEPROM is currently doing: idle (waiting for start bit),
   *  collecting a command frame, collecting 16 data bits for a
   *  WRITE/WRAL, or streaming data after a READ. */
  private mbc7EepState: "idle" | "command" | "data-in" | "reading" = "idle";
  /** Buffered command waiting for its 16 data bits. WRITE carries an
   *  address; WRAL writes the same word to every slot. */
  private mbc7EepPending: { kind: "write"; address: number } | { kind: "wral" } | null = null;

  /** Host callback returning the current tilt as `{x, y}` in roughly
   *  `[-1, +1]` g-units (where `+1` represents one Earth gravity along
   *  the cart's east / north axis respectively). The MBC7 read path
   *  multiplies these by the cart's `0x70`-per-g scale and adds the
   *  `0x81D0` rest value. Null when no tilt source is wired (returns
   *  the rest value, so the cart sees a perfectly flat sensor). */
  tiltSource: (() => { x: number; y: number }) | null = null;

  constructor(data: Uint8Array, opts?: { skipLogoCheck?: boolean }) {
    // Pre-flight: reject non-ROM files before we start interpreting
    // bytes at specific header offsets.
    //
    //   1. Size — a valid cart is at least 32 KiB (no MBC, single
    //      bank pair), so anything shorter can't carry a valid header.
    //   2. Logo fingerprint — CRC32 of 0x0104–0x0133 must match the
    //      known hash. Functionally equivalent to real hardware's
    //      byte-for-byte logo check. Collision probability on random
    //      input is ~1 in 2³².
    if (data.length < 0x8000) {
      throw new Error("File is too small to be a Game Boy ROM");
    }
    if (!opts?.skipLogoCheck && crc32Range(data, 0x0104, 0x0134) !== LOGO_CRC32) {
      throw new Error("Not a valid Game Boy ROM (logo fingerprint mismatch)");
    }

    this.rom = data;
    this.rawTitle = String.fromCharCode(...data.slice(0x0134, 0x0144))
      .replace(/\0/g, "")
      .trim();
    this.title = String.fromCharCode(...data.slice(0x0134, 0x0143))
      .replace(/\0/g, "")
      .trim();
    this.cgbFlag = data[0x0143]!;
    this.cgb = (this.cgbFlag & 0x80) !== 0;
    this.romBanks = ROM_SIZE_TABLE[data[0x0148]!] ?? 2;
    this.ramBanks = RAM_SIZE_TABLE[data[0x0149]!] ?? 0;
    this.typeCode = data[0x0147]!;
    this.mbcType = Cartridge.parseMBCType(this.typeCode);
    this.hasBattery = BATTERY_TYPES.has(this.typeCode);
    // MBC3 cart types 0x0F and 0x10 include an RTC (with battery).
    this.hasRtc = this.typeCode === 0x0f || this.typeCode === 0x10;
    // MBC5 rumble variants — the cart wires bit 3 of the RAM-bank
    // register to a vibration motor. Only three cart type codes carry
    // the motor; everything else writes the full nibble as bank bits.
    this.hasRumble = this.typeCode === 0x1c || this.typeCode === 0x1d || this.typeCode === 0x1e;
    this.globalChecksum = (data[0x014e]! << 8) | data[0x014f]!;
    this.destinationCode = data[0x014a]!;
    this.licenseeCode = data[0x014b]!;
    this.newLicensee =
      this.licenseeCode === 0x33 ? String.fromCharCode(data[0x0144]!, data[0x0145]!).replace(/\0/g, "") : null;
    this.headerChecksum = data[0x014d]!;
    // MBC7 disregards the header RAM-size byte: every shipped MBC7 cart
    // has a fixed 256-byte 93C46-class serial EEPROM accessed bit-by-bit
    // through a dedicated register (see `writeMBC7`), not the standard
    // 8 KiB-bank cart RAM. Allocate just enough storage to hold its
    // contents so the persistence pipeline (which writes whatever's in
    // `ram` to IndexedDB) round-trips the EEPROM correctly.
    this.ram = this.mbcType === "MBC7" ? new Uint8Array(0x100) : new Uint8Array(Math.max(1, this.ramBanks) * 0x2000);
    // Camera flash + MBC7 EEPROM both default to 0xFF on a never-written
    // cart. The Camera ROM uses that as its "first run" sentinel; MBC7
    // carts (Kirby Tilt 'n' Tumble) interpret it as an unprogrammed
    // chip and run their first-time-setup flow.
    if (this.mbcType === "CAMERA" || this.mbcType === "MBC7") this.ram.fill(0xff);
    // HuC1 maps RAM by default; the 0x0000 register only toggles it off to
    // expose the IR port. Start enabled so RAM works before any register write.
    if (this.mbcType === "HUC1") this.ramEnabled = true;
    console.info(
      `[Cartridge] "${this.title}" – ${this.mbcType}, ROM banks: ${this.romBanks}, ` +
        `RAM banks: ${this.ramBanks}, battery: ${this.hasBattery}, CGB: ${this.cgb}`
    );
  }

  /** Restore previously-saved external-RAM contents. Size-tolerant: any
   *  mismatch is truncated or zero-padded rather than rejected. */
  loadRam(data: Uint8Array): void {
    const len = Math.min(data.length, this.ram.length);
    this.ram.set(data.subarray(0, len));
    this._ramDirty = false;
  }

  // ─── Bus interface ────────────────────────────────────────────────────────

  read(addr: number): number {
    // ROM bank 0 and the current switchable bank. For MBC1 in RAM-banking
    // mode the low bank can be remapped by the high bits of the bank
    // register; for other MBCs the low half is always bank 0.
    if (addr < 0x4000) {
      const bank = this.mbcType === "MBC1" && this.mbc1Mode ? this.romBank & 0x60 & (this.romBanks - 1) : 0;
      return this.rom[bank * 0x4000 + addr] ?? 0xff;
    }
    if (addr < 0x8000) {
      const bank = this.romBank & (this.romBanks - 1);
      return this.rom[bank * 0x4000 + (addr - 0x4000)] ?? 0xff;
    }
    // External RAM 0xA000–0xBFFF — MBC-specific handling below.
    // Camera mode is the one exception that bypasses the RAM-enable
    // gate: the sensor register file at A000 isn't cart RAM (it's a
    // separate I/O surface routed through the M64283FP), and real
    // hardware lets the CPU read it without first writing 0x0A to
    // RAM-enable. Forgetting this leaves the busy-bit poll reading
    // 0xFF (RAM-disabled fallback) and the ROM hangs forever.
    if (this.mbcType === "CAMERA") {
      // Camera cart's flash bypasses the standard MBC RAM-enable gate
      // on reads — the cart's MBC routes A000-BFFF reads through the
      // sensor-register / cart-RAM dispatch unconditionally, ignoring
      // whether the ROM has written 0x0A to 0x0000. Without this
      // bypass the live-view ROM reads 0xFF for every pixel byte and
      // the screen shows all-black tiles (ID 3 in default palettes).
      // Writes are still gated below in `writeCamera` — the register
      // window must
      // accept writes at all times so the M64283FP can be configured.
      if (this.cameraMode) {
        if ((addr & 0x7f) === 0) return this.cameraRegs[0]!;
        return 0;
      }
      return this.readRamBank(this.ramBank, addr);
    }
    if (this.mbcType === "MBC7") return this.readMBC7(addr);
    if (this.mbcType === "HUC1") {
      // HuC1 RAM is always mapped; writing 0x0E to 0x0000–0x1FFF instead
      // selects the IR receiver (tracked via ramEnabled). With no IR peer
      // the receiver reports no incoming light — real HuC1 returns 0xC0.
      if (!this.ramEnabled) return 0xc0;
      return this.readRamBank(this.ramBank, addr);
    }
    if (!this.ramEnabled) return 0xff;
    switch (this.mbcType) {
      case "MBC2": {
        // 512 × 4-bit nibbles addressed at 0xA000–0xA1FF, mirrored
        // throughout 0xA200–0xBFFF. Upper nibble of each byte reads as 1.
        const v = this.ram[addr & 0x1ff] ?? 0;
        return (v & 0x0f) | 0xf0;
      }
      case "MBC3":
        // RAM bank selector 0x08–0x0C selects an RTC register instead of RAM.
        if (this.rtcRegister >= 0) return this.readRtc();
        return this.readRamBank(this.ramBank, addr);
      default: {
        // MBC1 only switches RAM bank while in RAM-banking mode; otherwise
        // the read targets bank 0 regardless of the high bits.
        const rb = this.mbcType === "MBC1" && !this.mbc1Mode ? 0 : this.ramBank;
        return this.readRamBank(rb, addr);
      }
    }
  }

  write(addr: number, value: number): void {
    switch (this.mbcType) {
      case "ROM_ONLY":
        return;
      case "MBC1":
        this.writeMBC1(addr, value);
        return;
      case "MBC2":
        this.writeMBC2(addr, value);
        return;
      case "MBC3":
        this.writeMBC3(addr, value);
        return;
      case "MBC5":
        this.writeMBC5(addr, value);
        return;
      case "MBC7":
        this.writeMBC7(addr, value);
        return;
      case "CAMERA":
        this.writeCamera(addr, value);
        return;
      case "HUC1":
        this.writeHuC1(addr, value);
        return;
      default:
        return;
    }
  }

  // ─── Shared RAM bank accessors ────────────────────────────────────────────
  // Every MBC that exposes external RAM indexes into `this.ram` the same way
  // (bank × 8 KiB + offset within bank); only the derivation of `bank` and
  // the surrounding gating (RAM-enable, RTC overlay, MBC1 mode) differ. The
  // helpers fold the common arithmetic + empty-RAM guard in one place.

  /** Read one byte from the given RAM bank. `0xff` if RAM is empty. */
  private readRamBank(bank: number, addr: number): number {
    if (this.ramBanks === 0) return 0xff;
    return this.ram[(bank & (this.ramBanks - 1)) * 0x2000 + (addr - 0xa000)] ?? 0xff;
  }

  /** Write one byte to the given RAM bank and mark the buffer dirty so the
   *  autosaver flushes it. No-op if the cart has no RAM banks. */
  private writeRamBank(bank: number, addr: number, value: number): void {
    if (this.ramBanks === 0) return;
    this.ram[(bank & (this.ramBanks - 1)) * 0x2000 + (addr - 0xa000)] = value;
    this._ramDirty = true;
  }

  // ─── MBC implementations ──────────────────────────────────────────────────

  private writeMBC1(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
    } else if (addr < 0x4000) {
      // 5-bit BANK1 register. Value 0 remaps to 1 — the classic MBC1
      // "zero-bank" behaviour (so writing 0 never selects bank 0).
      const bank = value & 0x1f;
      this.romBank = (this.romBank & 0x60) | (bank === 0 ? 1 : bank);
    } else if (addr < 0x6000) {
      // 2-bit BANK2 register — lives in bits 5–6 of `romBank` regardless
      // of mode. In ROM-banking mode it extends ROM bank; in RAM-banking
      // mode it also selects the RAM bank. Keeping it in `romBank` means
      // the RAM path derives the bank from `this.ramBank` separately.
      this.romBank = (this.romBank & 0x1f) | ((value & 0x03) << 5);
      this.ramBank = value & 0x03;
    } else if (addr < 0x8000) {
      this.mbc1Mode = (value & 0x01) !== 0;
    } else if (addr >= 0xa000 && addr < 0xc000 && this.ramEnabled) {
      this.writeRamBank(this.mbc1Mode ? this.ramBank : 0, addr, value);
    }
  }

  private writeHuC1(addr: number, value: number): void {
    if (addr < 0x2000) {
      // 0x0E selects the IR register; any other value exposes cart RAM.
      // Modelled through ramEnabled so the IR/RAM select rides the existing
      // save-state field — no format change, no version bump.
      this.ramEnabled = (value & 0x0f) !== 0x0e;
    } else if (addr < 0x4000) {
      // Single 6-bit ROM-bank register (no BANK1/BANK2 split like MBC1).
      // 0 remaps to 1 — bank 0 can't sit in the switchable slot.
      const bank = value & 0x3f;
      this.romBank = bank === 0 ? 1 : bank;
    } else if (addr < 0x6000) {
      this.ramBank = value & 0x03;
    } else if (addr < 0x8000) {
      // No mode register on HuC1.
    } else if (addr >= 0xa000 && addr < 0xc000) {
      // In IR mode this is the IR LED — no peer to receive it, so drop it.
      if (this.ramEnabled) this.writeRamBank(this.ramBank, addr, value);
    }
  }

  private writeMBC2(addr: number, value: number): void {
    if (addr < 0x4000) {
      // The register select is disambiguated by address bit 8:
      //   bit 8 clear → RAM enable/disable (value 0x0A enables)
      //   bit 8 set   → ROM bank select (lower 4 bits; 0 becomes 1)
      if ((addr & 0x0100) === 0) {
        this.ramEnabled = (value & 0x0f) === 0x0a;
      } else {
        const bank = value & 0x0f;
        this.romBank = bank === 0 ? 1 : bank;
      }
    } else if (addr >= 0xa000 && addr < 0xc000 && this.ramEnabled) {
      // Only the low 9 address bits index into the 512-nibble RAM; higher
      // bits fold back via mirroring. Only the lower 4 bits of `value` are
      // stored — the top four read back as 1.
      this.ram[addr & 0x1ff] = value & 0x0f;
      this._ramDirty = true;
    }
  }

  private writeMBC3(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
    } else if (addr < 0x4000) {
      const bank = value & 0x7f;
      this.romBank = bank === 0 ? 1 : bank;
    } else if (addr < 0x6000) {
      if (value <= 0x03) {
        this.ramBank = value;
        this.rtcRegister = -1;
      } else if (value >= 0x08 && value <= 0x0c) {
        this.rtcRegister = value - 0x08;
      }
    } else if (addr < 0x8000) {
      // Latch clock: write 0x00 then 0x01 to snapshot live RTC into the
      // readable latched registers.
      if (value === 0x00) {
        this.rtcLatchStage = 0;
      } else if (value === 0x01 && this.rtcLatchStage === 0) {
        this.latchRtc();
        this.rtcLatchStage = 1;
      } else {
        this.rtcLatchStage = -1;
      }
    } else if (addr >= 0xa000 && addr < 0xc000 && this.ramEnabled) {
      if (this.rtcRegister >= 0) {
        this.writeRtc(value);
        this._ramDirty = true;
      } else {
        this.writeRamBank(this.ramBank, addr, value);
      }
    }
  }

  // ─── RTC helpers ─────────────────────────────────────────────────────────

  /** Is the RTC currently halted (DH bit 6 set)? */
  private get rtcHalted(): boolean {
    return (this.rtcDH & 0x40) !== 0;
  }

  /** Advance the RTC's sub-second accumulator by `tCycles` T-cycles of
   *  emulated time and apply any full 1-Hz ticks that have elapsed.
   *  Called from the GameBoy runFrame loop per CPU step so the RTC
   *  advances against emulated wall-time rather than `Date.now()` — the
   *  rtc3test "Tick timing" subtest measures tick intervals via CPU
   *  cycles, so any drift between real and emulated clocks would show
   *  up as non-1000ms ticks. */
  tickRtc(tCycles: number): void {
    if (!this.hasRtc || this.rtcHalted) return;
    this.rtcTickAccum += tCycles;
    // 4194304 T-cycles = 1 second of emulated wall time.
    while (this.rtcTickAccum >= 4_194_304) {
      this.rtcTickAccum -= 4_194_304;
      this.tickRtcOnce();
    }
  }

  /** Apply one 1-Hz tick to the live registers, honouring the real-HW
   *  rule that a register's "overflow to next register" is triggered
   *  ONLY when the previous value was the register's natural max (59 /
   *  59 / 23 / 511). Writing an invalid value like 63 into S and
   *  ticking rolls to 0 via the 6-bit mask without carrying to M. */
  private tickRtcOnce(): void {
    const prevS = this.rtcS;
    if (prevS !== 59) {
      this.rtcS = (prevS + 1) & 0x3f;
      return;
    }
    this.rtcS = 0;

    const prevM = this.rtcM;
    if (prevM !== 59) {
      this.rtcM = (prevM + 1) & 0x3f;
      return;
    }
    this.rtcM = 0;

    const prevH = this.rtcH;
    if (prevH !== 23) {
      this.rtcH = (prevH + 1) & 0x1f;
      return;
    }
    this.rtcH = 0;

    const prevD = ((this.rtcDH & 0x01) << 8) | this.rtcDL;
    const nextD = (prevD + 1) & 0x1ff;
    this.rtcDL = nextD & 0xff;
    this.rtcDH = (this.rtcDH & 0xfe) | ((nextD >> 8) & 0x01);
    // Day counter wrapped 511 → 0: sticky carry flag in DH bit 7.
    if (prevD === 0x1ff) this.rtcDH |= 0x80;
  }

  /** Advance the RTC by `elapsedMs` of real wall-clock time. Intended for
   *  use by the host when emulation has been paused or tab-hidden — a real
   *  MBC3 cart keeps its on-board clock ticking while the console is off,
   *  so the in-game RTC should too. Whole seconds only; sub-second drift
   *  is negligible at user-perceivable timescales and keeping the T-cycle
   *  accumulator untouched preserves emulated sub-second alignment for
   *  anything that was mid-tick when we paused. No-op if the RTC is
   *  halted (DH bit 6) or the cart has no RTC. */
  advanceRtcByWallMs(elapsedMs: number): void {
    if (!this.hasRtc || this.rtcHalted || elapsedMs <= 0) return;
    let seconds = Math.floor(elapsedMs / 1000);
    while (seconds-- > 0) this.tickRtcOnce();
  }

  /** Snapshot the live clock into the readable latched registers. */
  private latchRtc(): void {
    this.rtcLS = this.rtcS;
    this.rtcLM = this.rtcM;
    this.rtcLH = this.rtcH;
    this.rtcLDL = this.rtcDL;
    this.rtcLDH = this.rtcDH;
  }

  /** Read the currently-selected RTC register (the latched value). */
  private readRtc(): number {
    switch (this.rtcRegister) {
      case 0:
        return this.rtcLS;
      case 1:
        return this.rtcLM;
      case 2:
        return this.rtcLH;
      case 3:
        return this.rtcLDL;
      case 4:
        return this.rtcLDH;
      default:
        return 0xff;
    }
  }

  /** Write to the currently-selected RTC register. Updates the live
   *  register (not the latched snapshot — reads return the latched
   *  value until the next 0→1 latch pulse). Writing DH bit 6 toggles
   *  the halt state; writing DH bit 7 is how software clears the
   *  day-counter carry. */
  private writeRtc(value: number): void {
    const reg = this.rtcRegister;
    if (reg < 0 || reg > 4) return;
    switch (reg) {
      case 0:
        this.rtcS = value & 0x3f;
        // Writing to seconds resets the sub-second counter too — otherwise
        // a pending fractional second would immediately push the register
        // forward. rtc3test's "Sub-second writes" subtests rely on this.
        this.rtcTickAccum = 0;
        break;
      case 1:
        this.rtcM = value & 0x3f;
        break;
      case 2:
        this.rtcH = value & 0x1f;
        break;
      case 3:
        this.rtcDL = value & 0xff;
        break;
      case 4:
        this.rtcDH = value & 0xc1;
        break;
    }
    // Latched mirror is refreshed so a re-read without a new 0→1 latch
    // pulse sees the just-written value.
    this.rtcLS = this.rtcS;
    this.rtcLM = this.rtcM;
    this.rtcLH = this.rtcH;
    this.rtcLDL = this.rtcDL;
    this.rtcLDH = this.rtcDH;
  }

  private writeMBC5(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
    } else if (addr < 0x3000) {
      this.romBank = (this.romBank & 0x100) | (value & 0xff);
    } else if (addr < 0x4000) {
      this.romBank = (this.romBank & 0x0ff) | ((value & 0x01) << 8);
    } else if (addr < 0x6000) {
      if (this.hasRumble) {
        // Rumble variants use bit 3 as the motor on/off, leaving only
        // bits 0–2 for the RAM-bank index (max 8 banks). Firing the
        // change hook on transition lets the host debounce / schedule
        // the actual vibration without polling from the hot path.
        this.ramBank = value & 0x07;
        const nextRumble = (value & 0x08) !== 0;
        if (nextRumble !== this.rumbleOn) {
          this.rumbleOn = nextRumble;
          this.onRumbleChange?.(nextRumble);
        }
      } else {
        this.ramBank = value & 0x0f;
      }
    } else if (addr >= 0xa000 && addr < 0xc000 && this.ramEnabled) {
      this.writeRamBank(this.ramBank, addr, value);
    }
  }

  // ─── MBC7 — Kirby Tilt 'n' Tumble ──────────────────────────────────────

  /** A000-AFFF read decode. Both RAM-enable latches must be set or
   *  the whole window reads `0xFF`. Otherwise the address's bits 4-7
   *  pick a register: tilt latch readouts at `Ax2x..Ax5x`, EEPROM
   *  status at `Ax8x`, and a couple of constant slots used by the
   *  cart for sanity checks. The `B000-BFFF` half of the window is
   *  unmapped and reads `0xFF`. */
  private readMBC7(addr: number): number {
    if (!this.ramEnabled || !this.mbc7SecondaryEnable) return 0xff;
    if (addr >= 0xb000) return 0xff;
    switch ((addr >> 4) & 0xf) {
      case 0x2:
        return this.mbc7XLatch & 0xff;
      case 0x3:
        return (this.mbc7XLatch >> 8) & 0xff;
      case 0x4:
        return this.mbc7YLatch & 0xff;
      case 0x5:
        return (this.mbc7YLatch >> 8) & 0xff;
      case 0x6:
        // Two constants the cart probes during init — quirks of the
        // physical sensor IC that became part of the protocol.
        return 0x00;
      case 0x7:
        return 0xff;
      case 0x8:
        // EEPROM control register — DO in bit 0, DI in bit 1, CLK in
        // bit 6, CS in bit 7. The cart polls bit 0 to read serial data
        // out of the EEPROM during a READ command.
        return (
          (this.mbc7EepDO & 1) |
          ((this.mbc7EepDI & 1) << 1) |
          ((this.mbc7EepCLK & 1) << 6) |
          ((this.mbc7EepCS & 1) << 7)
        );
      default:
        return 0xff;
    }
  }

  /** A000-AFFF + 0x0000-0x5FFF write decode. Banking + the dual RAM-
   *  enable handshake live in the lower half; the register window
   *  handles the latch protocol and EEPROM bit-bang. */
  private writeMBC7(addr: number, value: number): void {
    if (addr < 0x2000) {
      // Primary RAM-enable: standard 0x0A handshake.
      this.ramEnabled = (value & 0x0f) === 0x0a;
      return;
    }
    if (addr < 0x4000) {
      // 7-bit ROM bank. Bank 0 selectable (no MBC1-style auto-bump).
      this.romBank = value & 0x7f;
      if (this.romBank === 0) this.romBank = 1;
      return;
    }
    if (addr < 0x6000) {
      // Secondary RAM-enable: only the exact byte 0x40 unlocks the
      // window. Any other value disables. This is on top of the
      // primary 0x0A enable — both are required.
      this.mbc7SecondaryEnable = value === 0x40;
      return;
    }
    if (addr < 0x8000) return; // 6000-7FFF is unused on MBC7
    if (addr >= 0xa000 && addr < 0xb000) {
      if (!this.ramEnabled || !this.mbc7SecondaryEnable) return;
      switch ((addr >> 4) & 0xf) {
        case 0x0:
          // First half of the tilt-latch handshake. `0x55` arms the
          // latch and resets X/Y to the "no sample" sentinel. Any
          // other value is ignored.
          if (value === 0x55) {
            this.mbc7LatchReady = true;
            this.mbc7XLatch = 0x8000;
            this.mbc7YLatch = 0x8000;
          }
          return;
        case 0x1:
          // Second half of the handshake. `0xAA` after `0x55` samples
          // the live tilt source and stores it scaled into the latch.
          // Without the prior arm, this write does nothing — matches
          // the chip's own "you must clear before re-latching" rule.
          if (value === 0xaa && this.mbc7LatchReady) {
            this.mbc7LatchReady = false;
            const raw = this.tiltSource ? this.tiltSource() : { x: 0, y: 0 };
            // X axis is inverted relative to intuitive "tilt right = +x":
            // the accelerometer is mounted with its X output pointing
            // west on the cart, so a host-side +1g east must produce a
            // *decrease* from the rest value for Kirby to roll east.
            this.mbc7XLatch = mbc7ScaleAxis(-raw.x);
            this.mbc7YLatch = mbc7ScaleAxis(raw.y);
          }
          return;
        case 0x8:
          // EEPROM control register. Bits 0/1/6/7 are DO/DI/CLK/CS;
          // the rising edge of CLK shifts a bit in or out depending on
          // which command phase the chip is in.
          this.writeMBC7Eeprom(value);
          return;
        default:
          return;
      }
    }
  }

  /** EEPROM bit-bang state machine. The cart drives CS / CLK / DI and
   *  reads DO back through the same register. Each rising edge of CLK
   *  shifts one bit into the chip's command register; a complete
   *  10-bit frame (start + 2-bit opcode + 7-bit address) selects an
   *  operation, and 16 more bits supply data when needed. */
  private writeMBC7Eeprom(value: number): void {
    const cs = (value >> 7) & 1;
    const clk = (value >> 6) & 1;
    const di = (value >> 1) & 1;

    // CS going low ends the current command. The chip latches whatever
    // it was doing, returns to idle, and the read shift register
    // resets to "ready" (DO = 1) — which the cart polls as the
    // "operation complete" signal during programming.
    if (this.mbc7EepCS && !cs) {
      this.mbc7EepState = "idle";
      this.mbc7EepShift = 0;
      this.mbc7EepShiftBits = 0;
      this.mbc7EepReadBits = 0;
      this.mbc7EepDO = 1;
    }

    if (cs) {
      // Rising CLK clocks one bit. Falling CLK is decorative.
      if (!this.mbc7EepCLK && clk) {
        if (this.mbc7EepState === "reading") {
          // Output phase: shift `read_bits` MSB-first onto DO. After
          // the 16 data bits drain, `read_bits` is replenished with 1s
          // so the cart sees the chip's idle "RDY" signal forever
          // until it lowers CS.
          this.mbc7EepDO = (this.mbc7EepReadBits >> 15) & 1;
          this.mbc7EepReadBits = ((this.mbc7EepReadBits << 1) | 1) & 0xffff;
        } else if (this.mbc7EepState === "data-in") {
          // 16-bit data field for a buffered WRITE / WRAL. Shift DI
          // in until full, then commit through the EWEN gate.
          this.mbc7EepShift = ((this.mbc7EepShift << 1) | di) & 0xffff;
          this.mbc7EepShiftBits++;
          if (this.mbc7EepShiftBits === 16) {
            const word = this.mbc7EepShift & 0xffff;
            const pending = this.mbc7EepPending;
            if (pending && this.mbc7EepWriteEnabled) {
              const hi = (word >> 8) & 0xff;
              const lo = word & 0xff;
              if (pending.kind === "write") {
                this.ram[pending.address * 2] = hi;
                this.ram[pending.address * 2 + 1] = lo;
              } else {
                for (let i = 0; i < 128; i++) {
                  this.ram[i * 2] = hi;
                  this.ram[i * 2 + 1] = lo;
                }
              }
              this._ramDirty = true;
            }
            this.mbc7EepPending = null;
            this.mbc7EepShift = 0;
            this.mbc7EepShiftBits = 0;
            // Flip to "busy" → "ready" by streaming 0s briefly. The
            // cart's RDY-poll loop tolerates either timing.
            this.mbc7EepReadBits = 0;
            this.mbc7EepState = "reading";
          }
        } else if (this.mbc7EepState === "command") {
          // 9-bit command frame: 2-bit opcode (MSB-first) followed by
          // 7-bit address / extended-op selector. Dispatch as soon as
          // the 9th bit lands.
          this.mbc7EepShift = ((this.mbc7EepShift << 1) | di) & 0x1ff;
          this.mbc7EepShiftBits++;
          if (this.mbc7EepShiftBits === 9) {
            const opcode = (this.mbc7EepShift >> 7) & 0x3;
            const arg = this.mbc7EepShift & 0x7f;
            this.mbc7EepShift = 0;
            this.mbc7EepShiftBits = 0;
            this.runMBC7EepromCommand(opcode, arg);
          }
        } else {
          // Idle: any DI=1 with CS high is the frame's start bit and
          // moves us into the command-input state. DI=0 in idle just
          // keeps the chip waiting (real hardware allows arbitrary
          // dummy clocks before a frame begins).
          if (di === 1) {
            this.mbc7EepState = "command";
            this.mbc7EepShift = 0;
            this.mbc7EepShiftBits = 0;
          }
        }
      }
    }

    this.mbc7EepCS = cs;
    this.mbc7EepCLK = clk;
    this.mbc7EepDI = di;
  }

  /** Dispatch an EEPROM command frame. Standard 93C46 opcodes:
   *  `01` = WRITE (16 data bits follow), `10` = READ (DO streams 16
   *  bits), `11` = ERASE (single word ← 0xFFFF), `00` = extended ops
   *  whose top two address bits select EWDS / WRAL / ERAL / EWEN. */
  private runMBC7EepromCommand(opcode: number, arg: number): void {
    if (opcode === 0b10) {
      // READ: load the addressed 16-bit word into the read shift
      // register. EEPROM uses 16-bit-word addresses, so byte offset
      // is `address * 2`. Big-endian on disk for compatibility with
      // existing MBC7 .sav files in the wild.
      const address = arg & 0x7f;
      const hi = this.ram[address * 2] ?? 0xff;
      const lo = this.ram[address * 2 + 1] ?? 0xff;
      this.mbc7EepReadBits = ((hi << 8) | lo) & 0xffff;
      this.mbc7EepState = "reading";
      return;
    }
    if (opcode === 0b01) {
      // WRITE: clock 16 more bits into the shift register, then
      // commit. Re-enter command state with `mbc7EepWritePending`-ish
      // semantics — we collect the data bits before dispatching.
      this.mbc7EepPending = { kind: "write", address: arg & 0x7f };
      this.mbc7EepShift = 0;
      this.mbc7EepShiftBits = 0;
      this.mbc7EepState = "data-in";
      return;
    }
    if (opcode === 0b11) {
      // ERASE one word: write 0xFFFF at the addressed slot. Gated by
      // EWEN — silently drops if write isn't enabled (matches real
      // chip behaviour, which requires EWEN before any programming).
      if (this.mbc7EepWriteEnabled) {
        const address = arg & 0x7f;
        this.ram[address * 2] = 0xff;
        this.ram[address * 2 + 1] = 0xff;
        this._ramDirty = true;
      }
      // Brief "busy" stall so the cart's RDY-poll loop sees a `0`
      // for a few clocks before the chip reports done.
      this.mbc7EepReadBits = 0;
      this.mbc7EepState = "reading";
      return;
    }
    // opcode == 0b00: extended ops, distinguished by the top 2 bits
    // of the address field.
    const ext = (arg >> 5) & 0x3;
    if (ext === 0b00) {
      // EWDS — disable subsequent writes / erases.
      this.mbc7EepWriteEnabled = false;
    } else if (ext === 0b01) {
      // WRAL — write all 128 words to the same value (16 bits to
      // follow). Same data-collection flow as WRITE.
      this.mbc7EepPending = { kind: "wral" };
      this.mbc7EepShift = 0;
      this.mbc7EepShiftBits = 0;
      this.mbc7EepState = "data-in";
    } else if (ext === 0b10) {
      // ERAL — fill the entire chip with 0xFFFF.
      if (this.mbc7EepWriteEnabled) {
        this.ram.fill(0xff);
        this._ramDirty = true;
      }
      this.mbc7EepReadBits = 0;
      this.mbc7EepState = "reading";
    } else {
      // EWEN — enable write/erase ops until the next EWDS.
      this.mbc7EepWriteEnabled = true;
    }
  }

  /**
   * MBC for the Game Boy Camera cart. MBC5-shaped (RAM enable, 8-bit
   * ROM bank, 4-bit RAM bank) with a "camera mode" bit on top.
   *
   * Bank register at 0x4000-0x5FFF:
   *   - value < 0x10: select RAM bank, exit camera mode
   *   - value & 0x10: enter camera mode (bank latch unchanged — the
   *     Camera ROM toggles the mode bit constantly between register
   *     writes and SRAM reads, and clobbering the bank to 0 every
   *     toggle silently breaks photo-album access)
   *
   * In camera mode the sensor register file is visible at A000-BFFF
   * (128-byte mirror). Writes to register 0 with bit 0 set fire
   * `onCameraCapture` synchronously; the host pulls a webcam frame,
   * runs the sensor pipeline, and lands the result in cart RAM bank 0
   * at offset 0x100 (3584 bytes, GB 2bpp tile-row-major). The trigger
   * write masks `value &= 6` so bit 0 (the busy flag) is already clear
   * when the polling ROM reads register 0 next.
   */
  private writeCamera(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
      return;
    }
    if (addr < 0x4000) {
      this.romBank = value & 0x3f;
      return;
    }
    if (addr < 0x6000) {
      if (value < 0x10) {
        this.ramBank = value & 0x0f;
        this.cameraMode = false;
      } else {
        this.cameraMode = true;
      }
      return;
    }
    if (addr >= 0xa000 && addr < 0xc000) {
      if (this.cameraMode) {
        // Sensor I/O bypasses RAM-enable. Trigger handling: mask
        // `value &= 6` (clears the busy bit + any high bits) before
        // storing, fire the capture synchronously, then store the
        // masked value. The polling ROM reads "done" on its next read.
        const off = addr & 0x7f;
        let v = value & 0xff;
        if (off === 0 && (v & 0x01) !== 0) {
          v &= 0x06;
          this.onCameraCapture?.(this);
        }
        this.cameraRegs[off] = v;
      } else if (this.ramEnabled) {
        this.writeRamBank(this.ramBank, addr, value);
      }
    }
  }

  /** Host-side capture target: deposits a 3584-byte 2bpp tile buffer
   *  at cart RAM bank 0 offset 0x100, where the Camera ROM expects
   *  the sensor's output to land. Called from `onCameraCapture` after
   *  the host pulls a webcam frame and runs the sensor pipeline. The
   *  first 0x100 bytes of bank 0 hold album metadata and are left
   *  untouched. Doesn't mark RAM dirty — capture writes happen ~30×/s
   *  and would thrash IndexedDB persistence; only photo *saves* (which
   *  go through `writeRamBank`) need to persist. */
  writeCameraImage(buffer: Uint8Array): void {
    if (this.mbcType !== "CAMERA") return;
    const len = Math.min(buffer.length, 0x0e00);
    this.ram.set(buffer.subarray(0, len), 0x100);
  }

  // ─── Header parsing ───────────────────────────────────────────────────────

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    w.u16(this.romBank);
    w.u8(this.ramBank);
    w.bool(this.ramEnabled);
    w.bool(this.mbc1Mode);
    w.bool(this._ramDirty);
    w.bytes(this.ram);
    // RTC state (unconditional — 32 bytes of header noise for non-RTC
    // carts is cheaper than branching the format).
    w.i8(this.rtcRegister);
    w.i8(this.rtcLatchStage);
    w.u8(this.rtcS);
    w.u8(this.rtcM);
    w.u8(this.rtcH);
    w.u8(this.rtcDL);
    w.u8(this.rtcDH);
    w.u8(this.rtcLS);
    w.u8(this.rtcLM);
    w.u8(this.rtcLH);
    w.u8(this.rtcLDL);
    w.u8(this.rtcLDH);
    w.f64(this.rtcTickAccum);
    w.f64(this.rtcSavedAtMs);
    // Camera state — appended unconditionally (128 bytes + 1 flag) so
    // every save format stays positionally identical regardless of
    // mbcType. Cheap header noise on non-camera carts; necessary on
    // camera carts so an in-flight capture survives a state restore.
    w.bool(this.cameraMode);
    w.bytes(this.cameraRegs);
    // MBC7 latch + EEPROM-enable. The bit-bang shift register and any
    // half-clocked command frame are intentionally not persisted —
    // saves happen at frame boundaries and restoring an in-flight
    // serial transaction would just race the cart's continuation.
    w.bool(this.mbc7SecondaryEnable);
    w.bool(this.mbc7LatchReady);
    w.u16(this.mbc7XLatch);
    w.u16(this.mbc7YLatch);
    w.bool(this.mbc7EepWriteEnabled);
  }
  deserialize(r: StateReader): void {
    this.romBank = r.u16();
    this.ramBank = r.u8();
    this.ramEnabled = r.bool();
    this.mbc1Mode = r.bool();
    this._ramDirty = r.bool();
    r.bytes(this.ram);
    this.rtcRegister = r.i8();
    this.rtcLatchStage = r.i8();
    this.rtcS = r.u8();
    this.rtcM = r.u8();
    this.rtcH = r.u8();
    this.rtcDL = r.u8();
    this.rtcDH = r.u8();
    this.rtcLS = r.u8();
    this.rtcLM = r.u8();
    this.rtcLH = r.u8();
    this.rtcLDL = r.u8();
    this.rtcLDH = r.u8();
    this.rtcTickAccum = r.f64();
    this.rtcSavedAtMs = r.f64();
    this.cameraMode = r.bool();
    r.bytes(this.cameraRegs);
    this.mbc7SecondaryEnable = r.bool();
    this.mbc7LatchReady = r.bool();
    this.mbc7XLatch = r.u16();
    this.mbc7YLatch = r.u16();
    this.mbc7EepWriteEnabled = r.bool();
    // Drop any in-flight EEPROM frame — keeps the chip's serial
    // protocol out of the save format. The cart will start a fresh
    // frame on its next CS-low → CS-high handshake.
    this.mbc7EepState = "idle";
    this.mbc7EepShift = 0;
    this.mbc7EepShiftBits = 0;
    this.mbc7EepReadBits = 0;
    this.mbc7EepPending = null;
    this.mbc7EepCS = 0;
    this.mbc7EepCLK = 0;
    this.mbc7EepDI = 0;
    this.mbc7EepDO = 1;
  }

  // ─── RTC persistence (battery-backed saves) ───────────────────────────────

  /** Serialise the RTC state for the battery-save sidecar. Returns null
   *  when the cart has no RTC. */
  serializeRtc(): string | null {
    if (!this.hasRtc) return null;
    return JSON.stringify({
      v: 3,
      s: this.rtcS,
      m: this.rtcM,
      h: this.rtcH,
      dl: this.rtcDL,
      dh: this.rtcDH,
      accum: this.rtcTickAccum,
      savedAt: Date.now()
    });
  }

  /** Restore an RTC sidecar produced by `serializeRtc()`. Silently ignores
   *  malformed input so a corrupted save doesn't block the ROM from running.
   *  Fast-forwards by real-world seconds elapsed since the save so the
   *  in-game clock reflects actual time passed between sessions. */
  deserializeRtc(json: string): void {
    if (!this.hasRtc) return;
    try {
      const o = JSON.parse(json);
      if (!o || typeof o !== "object" || o.v !== 3) return;
      this.rtcS = Number(o.s) & 0x3f;
      this.rtcM = Number(o.m) & 0x3f;
      this.rtcH = Number(o.h) & 0x1f;
      this.rtcDL = Number(o.dl) & 0xff;
      this.rtcDH = Number(o.dh) & 0xc1;
      this.rtcTickAccum = Number(o.accum) || 0;
      // Apply real-time drift while the emulator was off: the cart should
      // see the actual calendar moving on, not freeze when you close the
      // tab. Only if the RTC wasn't halted when saved.
      const savedAt = Number(o.savedAt) || 0;
      const drift = savedAt > 0 ? Math.max(0, Math.floor((Date.now() - savedAt) / 1000)) : 0;
      if (drift > 0 && !this.rtcHalted) {
        for (let i = 0; i < drift; i++) this.tickRtcOnce();
      }
      this.rtcLS = this.rtcS;
      this.rtcLM = this.rtcM;
      this.rtcLH = this.rtcH;
      this.rtcLDL = this.rtcDL;
      this.rtcLDH = this.rtcDH;
    } catch {
      /* leave defaults in place */
    }
  }

  /** Map a cart-type header byte (0x0147) to an MBCType. Pure helper —
   *  exported so the table can be exercised by the test suite without
   *  constructing a full `Cartridge`. */
  static parseMBCType(typeCode: number): MBCType {
    if (typeCode === 0x00) return "ROM_ONLY";
    if (typeCode >= 0x01 && typeCode <= 0x03) return "MBC1";
    if (typeCode >= 0x05 && typeCode <= 0x06) return "MBC2";
    if (typeCode >= 0x0f && typeCode <= 0x13) return "MBC3";
    if (typeCode >= 0x19 && typeCode <= 0x1e) return "MBC5";
    if (typeCode === 0x22) return "MBC7";
    if (typeCode === 0xfc) return "CAMERA";
    if (typeCode === 0xff) return "HUC1";
    console.warn(`[Cartridge] Unknown MBC type 0x${typeCode.toString(16)}, defaulting to ROM_ONLY`);
    return "ROM_ONLY";
  }
}
