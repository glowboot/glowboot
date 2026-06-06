/**
 * GBA backup memory — detection + SRAM / Flash / OpenBus backings.
 *
 * GBA carts use one of four save technologies, each picked at design
 * time and identified at runtime by an ASCII marker the SDK / compiler
 * embeds somewhere in ROM. We scan for the marker; the type then
 * selects which device sits at the SRAM/Flash region (0x0E000000) or
 * the EEPROM window (0x0D000000+).
 *
 * Markers (aligned to a 4-byte boundary in real ROMs):
 *   "EEPROM_V"     → EEPROM (size 512 B or 8 KB; differentiated at
 *                    runtime by inspecting the DMA bit-stream length).
 *   "SRAM_V"       → 32 KB battery-backed SRAM.
 *   "SRAM_F_V"     → 32 KB SRAM (Atmel / "FRAM" variant; identical
 *                    behaviour for our purposes).
 *   "FLASH_V"      → 64 KB Flash.
 *   "FLASH512_V"   → 64 KB Flash (synonym).
 *   "FLASH1M_V"    → 128 KB Flash.
 *
 * SRAM, Flash (both sizes), and EEPROM are all implemented in this
 * file. Carts without a marker get an `OpenBusBackup` that reads 0xFF
 * and drops writes. EEPROM has its own bit-serial protocol driven by
 * DMA3 — see `EepromBackup` below.
 */
import type { IoHandler } from "../memory/mapped-bus.js";
import type { GbaStateReader, GbaStateWriter } from "../serialization/serialization.js";

type BackupType = "none" | "sram" | "flash64" | "flash128" | "eeprom";

export interface BackupSpec {
  type: BackupType;
  /** Size in bytes of the backup memory. 0 when type === "none".
   *  EEPROM is 512 B by default; 8 KB carts are detected at runtime by
   *  watching the DMA transfer length on the first access. */
  size: number;
  /** JEDEC manufacturer/device IDs reported by Flash chip-ID mode.
   *  Selected per save-type tag because carts written for one chip
   *  family poll for that exact ID and spin forever on mismatch.
   *  Tagless or non-Flash specs leave these at 0. */
  flashManufacturerId?: number;
  flashDeviceId?: number;
}

const MARKERS: readonly { needle: string; spec: BackupSpec }[] = [
  { needle: "EEPROM_V", spec: { type: "eeprom", size: 0x0200 } },
  { needle: "SRAM_F_V", spec: { type: "sram", size: 0x8000 } },
  { needle: "SRAM_V", spec: { type: "sram", size: 0x8000 } },
  // FLASH1M_V: Sanyo LE26FV10N1TS — Pokémon Emerald polls this exact pair.
  {
    needle: "FLASH1M_V",
    spec: { type: "flash128", size: 0x20000, flashManufacturerId: 0x62, flashDeviceId: 0x13 }
  },
  // FLASH512_V: Macronix MX29L512 — Super Robot Taisen OG/OG2 spin on this.
  {
    needle: "FLASH512_V",
    spec: { type: "flash64", size: 0x10000, flashManufacturerId: 0xc2, flashDeviceId: 0x1c }
  },
  // Generic FLASH_V: Panasonic MN63F805MNP — common 64 KB default.
  {
    needle: "FLASH_V",
    spec: { type: "flash64", size: 0x10000, flashManufacturerId: 0x1b, flashDeviceId: 0x32 }
  }
];

/** Scan a ROM for backup-type markers. Returns the first match found
 *  (longest-needle-first to disambiguate FLASH_V vs FLASH1M_V) or
 *  `{ type: "none", size: 0 }` if none is present. Markers must be
 *  4-byte aligned in real ROMs; we honour that to avoid false hits
 *  inside compressed graphics data that happens to contain "SRAM"
 *  as part of a longer byte run. */
export function detectBackup(rom: Uint8Array): BackupSpec {
  for (const { needle, spec } of MARKERS) {
    if (containsAlignedAscii(rom, needle)) return spec;
  }
  return { type: "none", size: 0 };
}

function containsAlignedAscii(rom: Uint8Array, needle: string): boolean {
  const needleLen = needle.length;
  const last = rom.length - needleLen;
  for (let i = 0; i <= last; i += 4) {
    let match = true;
    for (let j = 0; j < needleLen; j++) {
      if (rom[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/** SRAM backup at 0x0E000000. Byte-addressed; reads past the 32 KB
 *  boundary mirror back to the start (real hardware shows bus
 *  open-bus-ish behaviour there, but mirroring is what makes the
 *  jsmolka SRAM test ROM happy and what carts in practice expect).
 *  16- and 32-bit reads pull only the low byte — the SRAM data lines
 *  are 8 bits wide and the upper bus bytes are undefined; we
 *  broadcast the byte across the word, which keeps memcpy-via-LDM
 *  happy. */
export class SramBackup implements IoHandler {
  readonly bytes: Uint8Array;
  /** True if any byte has been written since the last `clearDirty` —
   *  the UI persistence layer watches this to throttle autosaves. */
  dirty = false;

  constructor(size: number) {
    // Fresh-cart SRAM is logically uninitialised, but the jsmolka
    // SRAM test ROMs expect unwritten SRAM to read as 0xFF — which is
    // what battery-backed chips drift to over time and what fresh
    // Flash always reads as. We follow suit.
    this.bytes = new Uint8Array(size).fill(0xff);
  }

  loadFrom(source: Uint8Array): void {
    this.bytes.set(source.subarray(0, this.bytes.length));
    this.dirty = false;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  read8(offset: number): number {
    return this.bytes[offset & (this.bytes.length - 1)] ?? 0;
  }

  read16(offset: number): number {
    const b = this.read8(offset);
    return (b << 8) | b;
  }

  read32(offset: number): number {
    const b = this.read8(offset);
    return (b << 24) | (b << 16) | (b << 8) | b | 0;
  }

  write8(offset: number, value: number): void {
    const idx = offset & (this.bytes.length - 1);
    const v = value & 0xff;
    if (this.bytes[idx] !== v) {
      this.bytes[idx] = v;
      this.dirty = true;
    }
  }

  write16(offset: number, value: number): void {
    // 8-bit SRAM data path. The bus rotates the halfword by
    // (offset & 1) * 8 bits before extracting the low byte, so the
    // byte that lands at `offset` is `value >> ((offset & 1) * 8)`.
    // That gives the low byte for aligned writes and the high byte
    // for an unaligned halfword store at an odd address — matches
    // real-cart behaviour and the jsmolka "store half position" test.
    this.write8(offset, value >>> ((offset & 1) * 8));
  }

  write32(offset: number, value: number): void {
    // Same idea as write16, generalised to word stores: byte at
    // `offset` is `value >> ((offset & 3) * 8)`.
    this.write8(offset, value >>> ((offset & 3) * 8));
  }

  serialize(w: GbaStateWriter): void {
    w.u32(this.bytes.length);
    w.bytes(this.bytes);
    w.bool(this.dirty);
  }

  deserialize(r: GbaStateReader): void {
    const len = r.u32();
    if (len !== this.bytes.length) {
      throw new Error(`SRAM save-state size mismatch: blob ${len} vs chip ${this.bytes.length}`);
    }
    r.bytes(this.bytes);
    this.dirty = r.bool();
  }
}

/** Open-bus handler for the cart-RAM region (0x0E000000-0x0FFFFFFF)
 *  when no backup chip is present. Real carts without a save device
 *  leave the data lines floating — pull-ups + bus state combine to
 *  produce 0xFF on reads, and writes vanish. Matches the expected
 *  result of jsmolka's `none.gba` test ROM. */
export class OpenBusBackup implements IoHandler {
  read8(): number {
    return 0xff;
  }

  read16(): number {
    return 0xffff;
  }

  read32(): number {
    return 0xffffffff | 0;
  }

  write8(): void {}
  write16(): void {}
  write32(): void {}
}

/** Flash backup at 0x0E000000 — 64 KB (single bank) or 128 KB (two
 *  banks, swapped via a bank-switch command).
 *
 *  Software talks to Flash through a 5-byte command sequence — the
 *  same protocol used by the bare chips on real carts. Each command
 *  starts with:
 *
 *    write 0xAA to offset 0x5555
 *    write 0x55 to offset 0x2AAA
 *    write CMD  to offset 0x5555   (or, for sector erase, to the sector)
 *
 *  The CMD byte selects what the next event does:
 *
 *    0x90 — enter Chip ID mode (reads at 0x00/0x01 return mfr/device)
 *    0xF0 — leave Chip ID mode
 *    0x80 — arm an erase (the second command sequence picks chip vs sector)
 *    0xA0 — arm a single-byte write (the next write to any offset lands)
 *    0xB0 — arm a bank switch (128 KB only; next write at 0x0000 sets bank)
 *
 *  Erased state is all 0xFF (Flash hardware constraint — you can flip
 *  1→0 with a byte program but only 0→1 via erase).
 *
 *  Chip IDs are vendor/device pairs that homebrew sometimes inspects
 *  to choose an erase strategy. We report Panasonic (0x1B/0x32) for
 *  64 KB carts and Sanyo (0x62/0x13) for 128 KB carts — the most
 *  common combinations on real production cartridges. */
export class FlashBackup implements IoHandler {
  readonly bytes: Uint8Array;
  readonly size: 0x10000 | 0x20000;
  dirty = false;

  /** Chip identification bytes. Returned from offset 0/1 only while
   *  the chip is in identification mode. */
  private readonly manufacturerId: number;
  private readonly deviceId: number;

  /** Active bank for 128 KB Flash (each bank is 64 KB; the bus window
   *  always shows the current bank). Always 0 on 64 KB Flash. */
  private bank = 0;

  // Five-state command parser. The parser tolerates bad command bytes
  // by silently returning to READY rather than locking up.
  private cmdPhase: "ready" | "got-aa" | "got-55" = "ready";
  private chipIdMode = false;
  private armed: "none" | "erase" | "write-byte" | "bank-switch" = "none";

  constructor(size: 0x10000 | 0x20000, manufacturerId?: number, deviceId?: number) {
    this.bytes = new Uint8Array(size).fill(0xff);
    this.size = size;
    if (manufacturerId !== undefined && deviceId !== undefined) {
      this.manufacturerId = manufacturerId;
      this.deviceId = deviceId;
    } else if (size === 0x10000) {
      this.manufacturerId = 0x1b; // Panasonic
      this.deviceId = 0x32;
    } else {
      this.manufacturerId = 0x62; // Sanyo
      this.deviceId = 0x13;
    }
  }

  loadFrom(source: Uint8Array): void {
    this.bytes.fill(0xff);
    this.bytes.set(source.subarray(0, this.bytes.length));
    this.dirty = false;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  read8(offset: number): number {
    const masked = offset & 0xffff;
    if (this.chipIdMode) {
      if (masked === 0x0000) return this.manufacturerId;
      if (masked === 0x0001) return this.deviceId;
    }
    return this.bytes[this.bank * 0x10000 + masked] ?? 0xff;
  }

  read16(offset: number): number {
    const b = this.read8(offset);
    return (b << 8) | b;
  }

  read32(offset: number): number {
    const b = this.read8(offset);
    return (b << 24) | (b << 16) | (b << 8) | b;
  }

  write8(offset: number, value: number): void {
    const masked = offset & 0xffff;
    const v = value & 0xff;

    // Armed single-byte write lands at any offset, regardless of the
    // command-sequence-prefix addresses. This is what 0xA0 sets up.
    if (this.armed === "write-byte") {
      const idx = this.bank * 0x10000 + masked;
      // Flash can only program bits 1→0. Real chips would require an
      // erase to flip 0→1; we approximate by AND-ing the existing
      // byte with the new value (so writing 0x00 always works, but
      // writing 0xFF over a byte that's been programmed to 0x00 still
      // reads as 0x00 until the sector / chip is erased). Carts
      // respect this in practice — they always erase before
      // programming — so the AND model is observably equivalent to
      // real silicon for every shipping ROM.
      const existing = this.bytes[idx] ?? 0xff;
      const next = existing & v;
      if (existing !== next) {
        this.bytes[idx] = next;
        this.dirty = true;
      }
      this.armed = "none";
      this.cmdPhase = "ready";
      return;
    }

    // Armed bank switch — only on 128 KB. The bank target byte is
    // written to offset 0x0000.
    if (this.armed === "bank-switch" && masked === 0x0000) {
      if (this.size === 0x20000) this.bank = v & 1;
      this.armed = "none";
      this.cmdPhase = "ready";
      return;
    }

    // Sector erase: after a 0x80 command, a second AA/55 sequence
    // followed by 0x30 at a sector address erases that 4 KB sector.
    // We accept the sector-erase command at the sector address, not
    // at 0x5555. (Chip erase still uses 0x5555.)
    if (this.armed === "erase" && this.cmdPhase === "got-55" && v === 0x30) {
      const sectorBase = (this.bank * 0x10000 + masked) & ~0x0fff;
      for (let i = 0; i < 0x1000; i++) this.bytes[sectorBase + i] = 0xff;
      this.dirty = true;
      this.armed = "none";
      this.cmdPhase = "ready";
      return;
    }

    // Otherwise we expect the canonical AA→55→CMD sequence at the
    // unlock addresses.
    if (this.cmdPhase === "ready" && masked === 0x5555 && v === 0xaa) {
      this.cmdPhase = "got-aa";
      return;
    }
    if (this.cmdPhase === "got-aa" && masked === 0x2aaa && v === 0x55) {
      this.cmdPhase = "got-55";
      return;
    }
    if (this.cmdPhase === "got-55" && masked === 0x5555) {
      this.applyCommand(v);
      return;
    }

    // Anything off-script resets the parser. (Real chips do this too —
    // bad sequences fail safe.)
    this.cmdPhase = "ready";
  }

  write16(offset: number, value: number): void {
    // Flash, like SRAM, has an 8-bit data path. The byte that hits the
    // chip on an unaligned halfword store is `value >> ((offset & 1) * 8)`.
    this.write8(offset, value >>> ((offset & 1) * 8));
  }

  write32(offset: number, value: number): void {
    this.write8(offset, value >>> ((offset & 3) * 8));
  }

  private applyCommand(cmd: number): void {
    switch (cmd) {
      case 0x90:
        this.chipIdMode = true;
        this.armed = "none";
        this.cmdPhase = "ready";
        return;
      case 0xf0:
        this.chipIdMode = false;
        this.armed = "none";
        this.cmdPhase = "ready";
        return;
      case 0x80:
        // First half of the erase command — we stay armed and wait for
        // the second AA/55 prefix to come in, then the actual erase
        // command (0x10 = chip, 0x30 = sector).
        this.armed = "erase";
        this.cmdPhase = "ready";
        return;
      case 0x10:
        // Chip erase — only valid as the third byte of the second
        // erase command sequence (armed && in got-55 phase).
        if (this.armed === "erase") {
          this.bytes.fill(0xff);
          this.dirty = true;
        }
        this.armed = "none";
        this.cmdPhase = "ready";
        return;
      case 0xa0:
        this.armed = "write-byte";
        this.cmdPhase = "ready";
        return;
      case 0xb0:
        this.armed = "bank-switch";
        this.cmdPhase = "ready";
        return;
      default:
        this.armed = "none";
        this.cmdPhase = "ready";
        return;
    }
  }

  serialize(w: GbaStateWriter): void {
    w.u32(this.bytes.length);
    w.bytes(this.bytes);
    w.bool(this.dirty);
    w.u8(this.bank);
    // String enums encoded as tags so the on-wire format is stable
    // even if internal naming changes.
    w.u8(this.cmdPhase === "ready" ? 0 : this.cmdPhase === "got-aa" ? 1 : 2);
    w.bool(this.chipIdMode);
    w.u8(this.armed === "none" ? 0 : this.armed === "erase" ? 1 : this.armed === "write-byte" ? 2 : 3);
  }

  deserialize(r: GbaStateReader): void {
    const len = r.u32();
    if (len !== this.bytes.length) {
      throw new Error(`Flash save-state size mismatch: blob ${len} vs chip ${this.bytes.length}`);
    }
    r.bytes(this.bytes);
    this.dirty = r.bool();
    this.bank = r.u8();
    const phase = r.u8();
    this.cmdPhase = phase === 0 ? "ready" : phase === 1 ? "got-aa" : "got-55";
    this.chipIdMode = r.bool();
    const armed = r.u8();
    this.armed = armed === 0 ? "none" : armed === 1 ? "erase" : armed === 2 ? "write-byte" : "bank-switch";
  }
}

/** EEPROM backup at 0x0D000000.
 *
 *  Unlike SRAM/Flash, EEPROM is bit-serial: each DMA3 halfword carries
 *  one bit (the low bit) of the command or response stream. There are
 *  two chip sizes (4 Kbit / 512 B and 64 Kbit / 8 KB) differentiated
 *  by address width (6 vs 14 bits). Carts don't advertise the size at
 *  build time, so the device auto-detects on its first DMA3 transfer
 *  by inspecting the transfer length:
 *
 *    9 halfwords  → 6-bit read  → 4 Kbit
 *    17 halfwords → 14-bit read → 64 Kbit
 *    73 halfwords → 6-bit write → 4 Kbit
 *    81 halfwords → 14-bit write → 64 Kbit
 *
 *  After autodetect the chip is locked to that size for the session.
 *
 *  Command frames (cart → EEPROM, written one bit per halfword, MSB
 *  first by convention):
 *
 *    READ    : "11" + addr[A-1..0] + "0"        (3 + A bits, padded to 9/17)
 *    WRITE   : "10" + addr[A-1..0] + data[63..0] + "0"  (3 + A + 64 bits)
 *
 *  Response frame (EEPROM → cart, served via DMA3 reads from 0x0D000000):
 *    4 ignored bits, then 64 data bits MSB first  (68 bits total).
 *  After a WRITE the chip returns a single "ready" bit (we just return 1
 *  on every read until the next command).
 *
 *  Storage is laid out as 8-byte blocks. Block N occupies bytes
 *  [N*8 .. N*8+7], byte 0 = data[63..56].
 *
 *  Reference: GBATEK "Cartridge Backup IDs / EEPROM Memory". The
 *  protocol details GBATEK leaves under-specified (per-block layout,
 *  DMA3 bit-serial timing) are exercised by the EEPROM subtests in
 *  the mgba-suite memory test ROM, which is what this implementation
 *  is verified against. */
export class EepromBackup implements IoHandler {
  /** Backing bytes. Lazily sized — until the first DMA3 transfer's
   *  length tells us 4-Kbit vs 64-Kbit, this is an empty array and
   *  `addressBits` is 0. Once sized, the array stays at that size for
   *  the rest of the session. */
  bytes: Uint8Array = new Uint8Array(0);
  /** 0 until autodetect, then 0x200 or 0x2000. */
  size: 0 | 0x200 | 0x2000 = 0;
  dirty = false;

  /** 6 (4 Kbit) or 14 (64 Kbit). 0 until autodetect. */
  private addressBits: 0 | 6 | 14 = 0;

  /** Input bits accumulated during the current DMA3 write transfer
   *  (cart → EEPROM). Cleared at the start of each write transfer; the
   *  full sequence is parsed at the end (when DMA3 signals completion). */
  private input: number[] = [];
  /** Response bits prepared after a READ command, consumed one per
   *  DMA3 halfword read. After a WRITE the output is just `[0]`
   *  followed by infinite "1"s ("ready") — we model that by returning
   *  1 once the array is exhausted. */
  private output: number[] = [];
  private outputPos = 0;

  /** True between `beginDmaTransfer(true)` and `endDmaTransfer(true)`.
   *  Reads outside this window aren't accumulated (the cart's CPU
   *  shouldn't be doing word loads from the EEPROM region; if it does,
   *  it gets `1` per GBATEK's "ready" convention). */
  private receiving = false;

  loadFrom(source: Uint8Array): void {
    // The persistence record carries the byte count; infer the chip
    // size from it so a restore on a fresh boot doesn't have to wait
    // for the cart to re-issue its sizing command.
    if (source.length === 0x200) this.lockSize(0x200);
    else if (source.length === 0x2000) this.lockSize(0x2000);
    else return; // unknown size — leave fresh
    this.bytes.set(source.subarray(0, this.bytes.length));
    this.dirty = false;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  /** DMA3 calls this just before transferring `count` halfwords. For
   *  the first transfer of the session, the count tells us the
   *  address width (and so the chip size); thereafter it's only
   *  needed to delimit command frames. */
  beginDmaTransfer(count: number, write: boolean): void {
    if (this.size === 0) {
      // 73/81 = write command bit length; 9/17 = read command bit
      // length; 68 = post-read response readback (only possible if a
      // size-determining write already happened, but we tolerate it
      // anyway by defaulting to 4 Kbit).
      if (count === 17 || count === 81) this.lockSize(0x2000);
      else this.lockSize(0x200);
    }
    if (write) {
      this.input = [];
      this.receiving = true;
    }
  }

  /** DMA3 calls this after the last halfword of the transfer. For a
   *  WRITE direction, the accumulated bits are now the complete
   *  command frame and we parse them. For a READ direction this is a
   *  no-op (the chip just stops streaming response bits). */
  endDmaTransfer(write: boolean): void {
    if (!write) return;
    this.receiving = false;
    this.parseCommand();
  }

  // ─── IoHandler ─────────────────────────────────────────────────────

  read8(offset: number): number {
    return this.read16(offset) & 0xff;
  }

  read16(_offset: number): number {
    if (this.outputPos < this.output.length) return this.output[this.outputPos++]! & 1;
    // After a WRITE (or before the first READ response is queued) the
    // chip drives "1" continuously to signal ready.
    return 1;
  }

  read32(offset: number): number {
    const lo = this.read16(offset) & 0xffff;
    const hi = this.read16(offset + 2) & 0xffff;
    return lo | (hi << 16) | 0;
  }

  write8(offset: number, value: number): void {
    this.write16(offset, value & 0xff);
  }

  write16(_offset: number, value: number): void {
    if (!this.receiving) return;
    this.input.push(value & 1);
  }

  write32(offset: number, value: number): void {
    this.write16(offset, value & 0xffff);
    this.write16(offset + 2, (value >>> 16) & 0xffff);
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private lockSize(size: 0x200 | 0x2000): void {
    if (this.size === size) return;
    this.size = size;
    this.addressBits = size === 0x200 ? 6 : 14;
    this.bytes = new Uint8Array(size).fill(0xff);
  }

  private parseCommand(): void {
    const bits = this.input;
    if (bits.length < 2 || this.addressBits === 0) return;
    // Header bit 0 must be 1 (start). Header bit 1 selects READ (1) or
    // WRITE (0). Anything else is a malformed frame; drop it.
    if (bits[0] !== 1) return;
    const isRead = bits[1] === 1;
    const addrStart = 2;
    let addr = 0;
    for (let i = 0; i < this.addressBits; i++) {
      addr = (addr << 1) | (bits[addrStart + i] ?? 0);
    }
    const blockOffset = (addr * 8) & (this.size - 1);
    if (isRead) {
      // Prepare 4 dummy bits + 64 data bits (MSB first per byte).
      const out: number[] = [0, 0, 0, 0];
      for (let i = 0; i < 8; i++) {
        const byte = this.bytes[blockOffset + i] ?? 0xff;
        for (let b = 7; b >= 0; b--) out.push((byte >>> b) & 1);
      }
      this.output = out;
      this.outputPos = 0;
    } else {
      const dataStart = addrStart + this.addressBits;
      // Data is 64 bits, MSB first; first 8 bits → byte 0, etc.
      for (let i = 0; i < 8; i++) {
        let byte = 0;
        for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[dataStart + i * 8 + b] ?? 0);
        if (this.bytes[blockOffset + i] !== byte) {
          this.bytes[blockOffset + i] = byte;
          this.dirty = true;
        }
      }
      // After a write the cart polls reads looking for "1" (ready). The
      // read fall-through in `read16` returns 1 by default, so just
      // clear the queued response.
      this.output = [];
      this.outputPos = 0;
    }
  }

  serialize(w: GbaStateWriter): void {
    w.u32(this.size);
    w.u8(this.addressBits);
    if (this.size !== 0) w.bytes(this.bytes);
    w.bool(this.dirty);
    w.u32(this.input.length);
    for (const bit of this.input) w.u8(bit);
    w.u32(this.output.length);
    for (const bit of this.output) w.u8(bit);
    w.u32(this.outputPos);
    w.bool(this.receiving);
  }

  deserialize(r: GbaStateReader): void {
    const size = r.u32();
    const addressBits = r.u8();
    if (size !== 0) {
      // Late-load: a save state captured after autodetect arrives at an
      // EEPROM that may not have been sized yet on this run. Re-size to
      // match the snapshot so subsequent commands address the right
      // number of bits.
      if (this.size === 0) this.lockSize(size as 0x200 | 0x2000);
      if (size !== this.size) {
        throw new Error(`EEPROM save-state size mismatch: blob ${size} vs chip ${this.size}`);
      }
      r.bytes(this.bytes);
    } else if (this.size !== 0) {
      throw new Error(`EEPROM save-state has unsized backup but chip is ${this.size}`);
    }
    this.addressBits = addressBits as 0 | 6 | 14;
    this.dirty = r.bool();
    const inLen = r.u32();
    this.input = [];
    for (let i = 0; i < inLen; i++) this.input.push(r.u8());
    const outLen = r.u32();
    this.output = [];
    for (let i = 0; i < outLen; i++) this.output.push(r.u8());
    this.outputPos = r.u32();
    this.receiving = r.bool();
  }
}
