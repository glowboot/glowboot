import { describe, expect, it } from "vitest";

import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { detectBackup, EepromBackup, FlashBackup, SramBackup } from "./backup.js";

function romWithMarker(marker: string, offsetDivBy4 = 256): Uint8Array {
  // Build a ROM with the marker embedded at a 4-byte aligned offset.
  // 64 KiB is plenty — larger than the marker itself, well past the
  // 192-byte header range where false hits would also be aligned.
  const rom = new Uint8Array(64 * 1024);
  for (let i = 0; i < marker.length; i++) rom[offsetDivBy4 * 4 + i] = marker.charCodeAt(i);
  return rom;
}

describe("detectBackup", () => {
  it("returns 'none' when the ROM contains no marker", () => {
    const rom = new Uint8Array(0x10000);
    expect(detectBackup(rom)).toEqual({ type: "none", size: 0 });
  });

  it("detects SRAM_V marker", () => {
    const rom = romWithMarker("SRAM_V");
    expect(detectBackup(rom)).toEqual({ type: "sram", size: 0x8000 });
  });

  it("detects SRAM_F_V marker as SRAM", () => {
    const rom = romWithMarker("SRAM_F_V");
    expect(detectBackup(rom)).toEqual({ type: "sram", size: 0x8000 });
  });

  it("detects FLASH_V marker as 64K Flash with Panasonic chip IDs", () => {
    const rom = romWithMarker("FLASH_V");
    expect(detectBackup(rom)).toEqual({
      type: "flash64",
      size: 0x10000,
      flashManufacturerId: 0x1b,
      flashDeviceId: 0x32
    });
  });

  it("detects FLASH512_V marker as 64K Flash with Macronix chip IDs", () => {
    const rom = romWithMarker("FLASH512_V");
    expect(detectBackup(rom)).toEqual({
      type: "flash64",
      size: 0x10000,
      flashManufacturerId: 0xc2,
      flashDeviceId: 0x1c
    });
  });

  it("detects FLASH1M_V marker as 128K Flash with Sanyo chip IDs (not confused with FLASH_V)", () => {
    const rom = romWithMarker("FLASH1M_V");
    expect(detectBackup(rom)).toEqual({
      type: "flash128",
      size: 0x20000,
      flashManufacturerId: 0x62,
      flashDeviceId: 0x13
    });
  });

  it("detects EEPROM_V marker", () => {
    const rom = romWithMarker("EEPROM_V");
    expect(detectBackup(rom)).toEqual({ type: "eeprom", size: 0x0200 });
  });

  it("ignores markers placed at non-aligned offsets (would be in middle of data)", () => {
    const rom = new Uint8Array(0x10000);
    const marker = "SRAM_V";
    // Place at offset 5 (not 4-byte aligned) — should not be picked up.
    for (let i = 0; i < marker.length; i++) rom[5 + i] = marker.charCodeAt(i);
    expect(detectBackup(rom)).toEqual({ type: "none", size: 0 });
  });

  it("picks the longest-matching marker when ambiguity could arise", () => {
    // A ROM with both "FLASH1M_V" and "FLASH_V" at separate aligned
    // offsets — the 1M variant must win (it's a real cart whose toolchain
    // embedded both for ID reasons).
    const rom = new Uint8Array(0x10000);
    const m1 = "FLASH1M_V";
    for (let i = 0; i < m1.length; i++) rom[256 + i] = m1.charCodeAt(i);
    const m2 = "FLASH_V";
    for (let i = 0; i < m2.length; i++) rom[1024 + i] = m2.charCodeAt(i);
    expect(detectBackup(rom).type).toBe("flash128");
  });
});

describe("SramBackup", () => {
  it("read8 returns the stored byte and write8 sets the dirty flag", () => {
    const sram = new SramBackup(0x8000);
    expect(sram.dirty).toBe(false);
    expect(sram.read8(0)).toBe(0xff); // fresh-cart convention
    sram.write8(0x100, 0xab);
    expect(sram.read8(0x100)).toBe(0xab);
    expect(sram.dirty).toBe(true);
  });

  it("writing the same byte twice does not re-flag dirty after clearDirty", () => {
    const sram = new SramBackup(0x8000);
    sram.write8(0x10, 0x42);
    sram.clearDirty();
    expect(sram.dirty).toBe(false);
    sram.write8(0x10, 0x42); // same value
    expect(sram.dirty).toBe(false);
    sram.write8(0x10, 0x43); // new value
    expect(sram.dirty).toBe(true);
  });

  it("addresses past the 32 KB boundary mirror back to the start", () => {
    const sram = new SramBackup(0x8000);
    sram.write8(0x10, 0x55);
    expect(sram.read8(0x10 + 0x8000)).toBe(0x55);
    expect(sram.read8(0x10 + 0x10000)).toBe(0x55);
  });

  it("16-bit and 32-bit reads broadcast the byte across the word", () => {
    const sram = new SramBackup(0x8000);
    sram.write8(0, 0xab);
    expect(sram.read16(0)).toBe(0xabab);
    expect(sram.read32(0)).toBe(0xabababab | 0);
  });

  it("halfword / word writes deliver the byte selected by address-rotation", () => {
    // 8-bit data path: byte at `offset` = `value >> ((offset & 3) * 8)`.
    const sram = new SramBackup(0x8000);
    sram.write32(0, 0xdeadbeef);
    expect(sram.read8(0)).toBe(0xef); // low byte at aligned address
    expect(sram.read8(1)).toBe(0xff); // unwritten — no upper byte fan-out
    sram.write16(0x10, 0x1234);
    expect(sram.read8(0x10)).toBe(0x34);
    // Unaligned halfword store delivers the HIGH byte to the unaligned address.
    sram.write16(0x21, 0xaabb);
    expect(sram.read8(0x21)).toBe(0xaa);
    // Unaligned word store delivers byte (value >> (offset&3)*8).
    sram.write32(0x33, 0xaabbccdd);
    expect(sram.read8(0x33)).toBe(0xaa); // offset 3 → byte 3
  });

  it("loadFrom copies bytes and clears dirty", () => {
    const sram = new SramBackup(0x8000);
    sram.write8(0, 0x42);
    expect(sram.dirty).toBe(true);
    const fresh = new Uint8Array(0x8000);
    fresh[0] = 0xaa;
    fresh[1] = 0xbb;
    sram.loadFrom(fresh);
    expect(sram.read8(0)).toBe(0xaa);
    expect(sram.read8(1)).toBe(0xbb);
    expect(sram.dirty).toBe(false);
  });
});

describe("FlashBackup", () => {
  function unlock(flash: FlashBackup): void {
    flash.write8(0x5555, 0xaa);
    flash.write8(0x2aaa, 0x55);
  }

  it("starts erased (all 0xFF)", () => {
    const flash = new FlashBackup(0x10000);
    for (let i = 0; i < 0x10000; i += 0x1000) {
      expect(flash.read8(i)).toBe(0xff);
    }
  });

  it("Chip ID command 0x90 returns Panasonic (0x1B/0x32) on 64 KB Flash", () => {
    const flash = new FlashBackup(0x10000);
    unlock(flash);
    flash.write8(0x5555, 0x90);
    expect(flash.read8(0x0000)).toBe(0x1b);
    expect(flash.read8(0x0001)).toBe(0x32);
    // Exit Chip ID mode — reads should fall back to memory contents.
    unlock(flash);
    flash.write8(0x5555, 0xf0);
    expect(flash.read8(0x0000)).toBe(0xff);
  });

  it("Chip ID command 0x90 returns Sanyo (0x62/0x13) on 128 KB Flash", () => {
    const flash = new FlashBackup(0x20000);
    unlock(flash);
    flash.write8(0x5555, 0x90);
    expect(flash.read8(0x0000)).toBe(0x62);
    expect(flash.read8(0x0001)).toBe(0x13);
  });

  it("byte program (0xA0) writes a single byte at any offset", () => {
    const flash = new FlashBackup(0x10000);
    unlock(flash);
    flash.write8(0x5555, 0xa0); // arm byte-program
    flash.write8(0x1234, 0x42);
    expect(flash.read8(0x1234)).toBe(0x42);
    expect(flash.dirty).toBe(true);
  });

  it("byte program only flips 1→0 bits (Flash semantics; erase to flip 0→1)", () => {
    const flash = new FlashBackup(0x10000);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x100, 0x0f); // 0xFF & 0x0F = 0x0F
    expect(flash.read8(0x100)).toBe(0x0f);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x100, 0xf0); // 0x0F & 0xF0 = 0x00 (can't restore the lost 1s)
    expect(flash.read8(0x100)).toBe(0x00);
  });

  it("chip erase (0x80 / unlock / 0x10) restores all 0xFF", () => {
    const flash = new FlashBackup(0x10000);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x100, 0x00);
    expect(flash.read8(0x100)).toBe(0x00);
    unlock(flash);
    flash.write8(0x5555, 0x80);
    unlock(flash);
    flash.write8(0x5555, 0x10);
    expect(flash.read8(0x100)).toBe(0xff);
    expect(flash.read8(0xfff0)).toBe(0xff);
  });

  it("sector erase (0x80 / unlock / 0x30 at sector) clears only that 4 KB sector", () => {
    const flash = new FlashBackup(0x10000);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x1000, 0x00);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x3000, 0x55);
    // Erase the sector containing 0x1000.
    unlock(flash);
    flash.write8(0x5555, 0x80);
    unlock(flash);
    flash.write8(0x1000, 0x30);
    expect(flash.read8(0x1000)).toBe(0xff); // erased
    expect(flash.read8(0x3000)).toBe(0x55); // other sector untouched
  });

  it("128 KB Flash bank switch (0xB0) selects the upper bank", () => {
    const flash = new FlashBackup(0x20000);
    // Program offset 0x100 in bank 0 to 0x11.
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x100, 0x11);
    // Switch to bank 1 and program the same offset to 0x22.
    unlock(flash);
    flash.write8(0x5555, 0xb0);
    flash.write8(0x0000, 0x01);
    unlock(flash);
    flash.write8(0x5555, 0xa0);
    flash.write8(0x100, 0x22);
    expect(flash.read8(0x100)).toBe(0x22);
    // Switch back to bank 0 — the 0x11 value should still be there.
    unlock(flash);
    flash.write8(0x5555, 0xb0);
    flash.write8(0x0000, 0x00);
    expect(flash.read8(0x100)).toBe(0x11);
  });

  it("ignores commands when the AA→55→CMD unlock sequence is not honored", () => {
    const flash = new FlashBackup(0x10000);
    // Bogus prefix (missing 0xAA at 0x5555).
    flash.write8(0x2aaa, 0x55);
    flash.write8(0x5555, 0x90);
    // No chip-ID mode entered — reads should still be 0xFF (memory).
    expect(flash.read8(0x0000)).toBe(0xff);
  });

  it("loadFrom restores state and clears dirty", () => {
    const flash = new FlashBackup(0x10000);
    const seed = new Uint8Array(0x10000).fill(0x42);
    flash.loadFrom(seed);
    expect(flash.read8(0)).toBe(0x42);
    expect(flash.read8(0x8000)).toBe(0x42);
    expect(flash.dirty).toBe(false);
  });
});

describe("memory map — SRAM region", () => {
  it("cart-RAM window reads 0xFF and discards writes when backup type is 'none'", () => {
    const mem = makeGbaMemoryMap(0x10000);
    expect(mem.sram).toBeNull();
    expect(mem.flash).toBeNull();
    // Open-bus convention: reads return 0xFF, writes vanish.
    expect(mem.bus.read8(0x0e000000)).toBe(0xff);
    expect(mem.bus.read8(0x0fffffff)).toBe(0xff);
    mem.bus.write8(0x0e000000, 0x42);
    expect(mem.bus.read8(0x0e000000)).toBe(0xff);
  });

  it("SRAM mirrors across the full 32 MB cart-RAM window", () => {
    const mem = makeGbaMemoryMap(0x10000, { type: "sram", size: 0x8000 });
    mem.bus.write8(0x0e000000, 0xaa);
    expect(mem.bus.read8(0x0e000000 + 0x10000)).toBe(0xaa); // +64K mirror
    expect(mem.bus.read8(0x0f000000)).toBe(0xaa); // +16M mirror
  });

  it("SRAM region is mapped at 0x0E000000 when backup type is 'sram'", () => {
    const mem = makeGbaMemoryMap(0x10000, { type: "sram", size: 0x8000 });
    expect(mem.sram).not.toBeNull();
    mem.bus.write8(0x0e000000, 0x42);
    mem.bus.write8(0x0e000001, 0x69);
    expect(mem.bus.read8(0x0e000000)).toBe(0x42);
    expect(mem.bus.read8(0x0e000001)).toBe(0x69);
    expect(mem.sram!.dirty).toBe(true);
  });

  it("Flash 64K is mapped at 0x0E000000 when backup is 'flash64' (chip ID via bus)", () => {
    const mem = makeGbaMemoryMap(0x10000, { type: "flash64", size: 0x10000 });
    expect(mem.flash).not.toBeNull();
    expect(mem.sram).toBeNull();
    // Drive the chip-ID command through the bus and confirm we read
    // back Panasonic.
    mem.bus.write8(0x0e005555, 0xaa);
    mem.bus.write8(0x0e002aaa, 0x55);
    mem.bus.write8(0x0e005555, 0x90);
    expect(mem.bus.read8(0x0e000000)).toBe(0x1b);
    expect(mem.bus.read8(0x0e000001)).toBe(0x32);
  });

  it("EEPROM region is mapped at 0x0D000000 when backup type is 'eeprom'", () => {
    const mem = makeGbaMemoryMap(0x10000, { type: "eeprom", size: 0x200 });
    expect(mem.eeprom).not.toBeNull();
    expect(mem.sram).toBeNull();
    expect(mem.flash).toBeNull();
  });
});

/** Helper: drive an EEPROM write command directly through the device's
 *  IoHandler interface (matching what DMA3 does halfword-by-halfword). */
function eepromWriteCommand(eep: EepromBackup, addrBits: 6 | 14, addr: number, data: bigint): void {
  const bits: number[] = [1, 0]; // header "10" = write
  for (let i = addrBits - 1; i >= 0; i--) bits.push((addr >>> i) & 1);
  for (let i = 63; i >= 0; i--) bits.push(Number((data >> BigInt(i)) & 1n));
  bits.push(0); // stop
  eep.beginDmaTransfer(bits.length, true);
  for (const b of bits) eep.write16(0, b);
  eep.endDmaTransfer(true);
}

function eepromReadCommand(eep: EepromBackup, addrBits: 6 | 14, addr: number): bigint {
  const bits: number[] = [1, 1]; // header "11" = read
  for (let i = addrBits - 1; i >= 0; i--) bits.push((addr >>> i) & 1);
  bits.push(0); // stop
  eep.beginDmaTransfer(bits.length, true);
  for (const b of bits) eep.write16(0, b);
  eep.endDmaTransfer(true);
  // Now read 68 bits: 4 ignored + 64 data MSB-first.
  eep.beginDmaTransfer(68, false);
  for (let i = 0; i < 4; i++) eep.read16(0);
  let data = 0n;
  for (let i = 0; i < 64; i++) data = (data << 1n) | BigInt(eep.read16(0) & 1);
  eep.endDmaTransfer(false);
  return data;
}

describe("EepromBackup — bit-serial protocol", () => {
  it("autodetects 4-Kbit chip from a 9-halfword read command and a 73-halfword write command", () => {
    const e = new EepromBackup();
    // First transfer is a 9-halfword read → 6-bit address → 4 Kbit.
    e.beginDmaTransfer(9, true);
    e.write16(0, 1);
    e.write16(0, 1); // read header "11"
    for (let i = 0; i < 6; i++) e.write16(0, 0); // addr 0
    e.write16(0, 0); // stop
    e.endDmaTransfer(true);
    expect(e.size).toBe(0x200);
    expect(e.bytes.length).toBe(0x200);

    // Subsequent write command of 73 halfwords still works at 6-bit.
    const e2 = new EepromBackup();
    eepromWriteCommand(e2, 6, 0, 0n);
    expect(e2.size).toBe(0x200);
  });

  it("autodetects 64-Kbit chip from a 17-halfword read command", () => {
    const e = new EepromBackup();
    e.beginDmaTransfer(17, true);
    e.write16(0, 1);
    e.write16(0, 1);
    for (let i = 0; i < 14; i++) e.write16(0, 0);
    e.write16(0, 0);
    e.endDmaTransfer(true);
    expect(e.size).toBe(0x2000);
    expect(e.bytes.length).toBe(0x2000);
  });

  it("round-trips a write/read for block 0 of a 4-Kbit chip", () => {
    const e = new EepromBackup();
    // Force-detect 4-Kbit so we don't have to issue a read first.
    eepromWriteCommand(e, 6, 0, 0x0123456789abcdefn);
    const data = eepromReadCommand(e, 6, 0);
    expect(data).toBe(0x0123456789abcdefn);
    expect(e.dirty).toBe(true);
  });

  it("stores blocks at independent 8-byte slots", () => {
    const e = new EepromBackup();
    eepromWriteCommand(e, 6, 0, 0x1111111111111111n);
    eepromWriteCommand(e, 6, 1, 0x2222222222222222n);
    eepromWriteCommand(e, 6, 63, 0x3333333333333333n);
    expect(eepromReadCommand(e, 6, 0)).toBe(0x1111111111111111n);
    expect(eepromReadCommand(e, 6, 1)).toBe(0x2222222222222222n);
    expect(eepromReadCommand(e, 6, 63)).toBe(0x3333333333333333n);
  });

  it("64-Kbit chip addresses 1024 blocks", () => {
    const e = new EepromBackup();
    eepromWriteCommand(e, 14, 1023, 0xfeedfacecafebeefn);
    expect(e.size).toBe(0x2000);
    expect(eepromReadCommand(e, 14, 1023)).toBe(0xfeedfacecafebeefn);
  });

  it("reads from an un-written block return 0xFF (fresh-chip erase state)", () => {
    const e = new EepromBackup();
    // Force-detect first by issuing a read; chip lazily allocates.
    expect(eepromReadCommand(e, 6, 5)).toBe(0xffffffffffffffffn);
  });

  it("returns 1 ('ready') on reads outside of a queued response", () => {
    const e = new EepromBackup();
    eepromWriteCommand(e, 6, 0, 0n);
    // After the write, the chip is in 'ready' mode — reads return 1.
    e.beginDmaTransfer(1, false);
    expect(e.read16(0) & 1).toBe(1);
    expect(e.read16(0) & 1).toBe(1);
    e.endDmaTransfer(false);
  });

  it("loadFrom infers chip size from byte length", () => {
    const e = new EepromBackup();
    const payload = new Uint8Array(0x2000).fill(0xab);
    e.loadFrom(payload);
    expect(e.size).toBe(0x2000);
    // Verify the bytes landed via a read command.
    expect(eepromReadCommand(e, 14, 0)).toBe(0xababababababababn);
  });
});

describe("EEPROM via DMA3 + mapped bus", () => {
  it("DMA3 from IWRAM to 0x0D000000 drives a complete write command, and IWRAM-from-0x0D000000 reads it back", () => {
    const mem = makeGbaMemoryMap(0x10000, { type: "eeprom", size: 0x200 });
    expect(mem.eeprom).not.toBeNull();
    // Lay out a 6-bit-address write command in IWRAM: header "10",
    // address (block 5), 64 data bits = 0xCAFEBABE_DEADBEEF, stop bit.
    // 1 bit per halfword (low bit). Total 73 halfwords.
    const src = 0x03000000;
    const bits: number[] = [1, 0];
    const addr = 5;
    for (let i = 5; i >= 0; i--) bits.push((addr >>> i) & 1);
    const data = 0xcafebabedeadbeefn;
    for (let i = 63; i >= 0; i--) bits.push(Number((data >> BigInt(i)) & 1n));
    bits.push(0);
    for (let i = 0; i < bits.length; i++) mem.bus.write16(src + i * 2, bits[i]!);

    // Configure DMA3: src=IWRAM, dst=0x0D000000, count=73, halfword,
    // immediate, enable.
    const dmaBase = 0x040000d4; // DMA3 SAD lives here? Actually DMA3 starts at 0xD4
    // Let's just write all four registers explicitly.
    mem.bus.write32(0x040000d4, src);
    mem.bus.write32(0x040000d8, 0x0d000000);
    mem.bus.write16(0x040000dc, bits.length); // CNT_L
    mem.bus.write16(0x040000de, 0x8000); // CNT_H: enable, immediate, halfword
    expect(mem.eeprom!.bytes[5 * 8]).toBe(0xca);
    expect(mem.eeprom!.bytes[5 * 8 + 7]).toBe(0xef);

    // Issue a read command, then a 68-halfword DMA3 read from 0x0D000000
    // back into IWRAM and verify the bits match the stored block.
    const readCmdBits: number[] = [1, 1];
    for (let i = 5; i >= 0; i--) readCmdBits.push((addr >>> i) & 1);
    readCmdBits.push(0);
    const cmdSrc = 0x03001000;
    for (let i = 0; i < readCmdBits.length; i++) mem.bus.write16(cmdSrc + i * 2, readCmdBits[i]!);
    mem.bus.write32(0x040000d4, cmdSrc);
    mem.bus.write32(0x040000d8, 0x0d000000);
    mem.bus.write16(0x040000dc, readCmdBits.length);
    mem.bus.write16(0x040000de, 0x8000);

    const dst = 0x03002000;
    mem.bus.write32(0x040000d4, 0x0d000000);
    mem.bus.write32(0x040000d8, dst);
    mem.bus.write16(0x040000dc, 68);
    mem.bus.write16(0x040000de, 0x8000);

    // Skip the 4 ignored bits, then read 64 data bits MSB-first.
    let out = 0n;
    for (let i = 4; i < 68; i++) out = (out << 1n) | BigInt(mem.bus.read16(dst + i * 2) & 1);
    expect(out).toBe(data);
    void dmaBase;
  });
});
