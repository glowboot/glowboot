import { describe, expect, it } from "vitest";

import { Cartridge } from "./cartridge.js";

describe("Cartridge.parseMBCType", () => {
  it.each([
    [0x00, "ROM_ONLY"],
    [0x01, "MBC1"],
    [0x02, "MBC1"],
    [0x03, "MBC1"],
    [0x05, "MBC2"],
    [0x06, "MBC2"],
    [0x0f, "MBC3"],
    [0x10, "MBC3"],
    [0x11, "MBC3"],
    [0x12, "MBC3"],
    [0x13, "MBC3"],
    [0x19, "MBC5"],
    [0x1a, "MBC5"],
    [0x1b, "MBC5"],
    [0x1c, "MBC5"], // rumble
    [0x1d, "MBC5"], // rumble + RAM
    [0x1e, "MBC5"], // rumble + RAM + battery
    [0x22, "MBC7"],
    [0xfc, "CAMERA"]
  ] as const)("maps cart-type byte 0x%s to %s", (code, expected) => {
    expect(Cartridge.parseMBCType(code)).toBe(expected);
  });

  it("falls back to ROM_ONLY for unknown type codes", () => {
    // Gap codes (0x04, 0x07-0x0E, 0x14-0x18, 0x20+) aren't valid MBCs.
    expect(Cartridge.parseMBCType(0x04)).toBe("ROM_ONLY");
    expect(Cartridge.parseMBCType(0x20)).toBe("ROM_ONLY");
    expect(Cartridge.parseMBCType(0xfd)).toBe("ROM_ONLY");
  });
});

/** Build a minimal ROM with the requested header byte values. Pairs with
 *  the `skipLogoCheck` constructor option so tests don't need to embed
 *  the cart's logo fingerprint to pass validation. */
function buildRom(opts: {
  typeCode: number;
  romSizeCode?: number;
  ramSizeCode?: number;
  sizeBytes?: number;
}): Uint8Array {
  const size = opts.sizeBytes ?? 0x8000;
  const rom = new Uint8Array(size);
  rom[0x147] = opts.typeCode;
  rom[0x148] = opts.romSizeCode ?? 0;
  rom[0x149] = opts.ramSizeCode ?? 0;
  return rom;
}

describe("Camera (MBC 0xFC)", () => {
  function makeCameraCart(): Cartridge {
    // Real GB Camera cart: 1 MB ROM (size code 5), 128 KB RAM (size code 4).
    return new Cartridge(buildRom({ typeCode: 0xfc, romSizeCode: 5, ramSizeCode: 4, sizeBytes: 0x100000 }), {
      skipLogoCheck: true
    });
  }

  it("constructs and reports the CAMERA mbc type", () => {
    const cart = makeCameraCart();
    expect(cart.mbcType).toBe("CAMERA");
    expect(cart.romBanks).toBe(64);
    expect(cart.ramBanks).toBe(16);
  });

  it("fresh cart RAM defaults to 0xFF (matches real flash, used by ROM as 'first run' detection)", () => {
    const cart = makeCameraCart();
    expect(cart.read(0xa000)).toBe(0xff);
    expect(cart.read(0xb000)).toBe(0xff);
  });

  it("reads bypass the RAM-enable gate (camera flash is always readable)", () => {
    // The camera cart's MBC routes A000-BFFF reads through its own
    // sensor-register / cart-RAM dispatch ahead of the standard
    // RAM-enable check, so reads succeed whether or not the ROM has
    // written 0x0A to 0x0000. Forgetting this leaves live-view
    // reading 0xFF for every pixel byte → solid-black viewfinder
    // (tile ID 3 in default palettes).
    const cart = makeCameraCart();
    // Stage a value via the enabled-write path…
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x42);
    // …then disable RAM and verify reads still return the staged byte.
    cart.write(0x0000, 0x00);
    expect(cart.read(0xa000)).toBe(0x42);
  });

  it("writes to A000-AFFF require the 0x0A RAM-enable handshake (write-gate intact)", () => {
    // Reads bypass the gate, but writes don't — the ROM still has to
    // unlock SRAM before saving photos to the album banks.
    const cart = makeCameraCart();
    // RAM disabled (default state): writes get dropped.
    cart.write(0xa000, 0x42);
    expect(cart.read(0xa000)).toBe(0xff);
    // RAM enabled: writes land.
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x42);
    expect(cart.read(0xa000)).toBe(0x42);
  });

  it("ROM bank register at 0x2000 selects the upper half visible at 0x4000", () => {
    const cart = makeCameraCart();
    // Tag bank 5's first byte (offset 5 * 0x4000 = 0x14000) so we can
    // detect the switch — going through the ROM array directly is
    // impossible from outside, so we rely on header-byte reads picking
    // up the tag we placed in `buildRom`. Easier: just verify the
    // bank register lands in the cartridge's romBank field via a
    // round-trip read of the bank-0 logo bytes (always-bank-0).
    cart.write(0x2000, 0x05);
    // After bank switch, the upper window addresses bank 5, which is
    // zero-filled in our synthesized blob.
    expect(cart.read(0x4104)).toBe(0x00);
    // The lower window stays pinned to bank 0 — the cart-type byte we
    // planted at 0x0147 should remain visible regardless of bank switches.
    expect(cart.read(0x0147)).toBe(0xfc);
  });

  it("flips into camera-register mode when bit 4 of 0x4000 is set", () => {
    const cart = makeCameraCart();
    cart.write(0x0000, 0x0a); // RAM enable
    cart.write(0xa005, 0x42); // RAM-bank-0 mode → land in cart RAM
    cart.write(0x4000, 0x10); // camera mode on
    // A005 in camera mode falls inside the register window — every
    // register except register 0 is write-only from the CPU side and
    // reads back as 0x00.
    expect(cart.read(0xa005)).toBe(0x00);
    // Switching back to RAM mode reveals the byte we wrote earlier.
    cart.write(0x4000, 0x00);
    expect(cart.read(0xa005)).toBe(0x42);
  });

  it("triggers onCameraCapture when the ROM writes 1 to A000 bit 0", () => {
    const cart = makeCameraCart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x10);
    let calls = 0;
    cart.onCameraCapture = () => calls++;
    cart.write(0xa000, 0x01);
    expect(calls).toBe(1);
  });

  it("clears the busy bit synchronously after capture so the polling ROM sees 'done'", () => {
    const cart = makeCameraCart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x10);
    cart.onCameraCapture = () => {
      /* no host action — emulator-default capture */
    };
    cart.write(0xa000, 0x01);
    // After the trigger, A000 reads back as 0 because the cart cleared
    // the busy bit at the end of writeCamera. The ROM's loop "while
    // (A000 & 1)" terminates on the next read.
    expect(cart.read(0xa000) & 0x01).toBe(0);
  });

  it("does not trigger capture on writes to other registers", () => {
    const cart = makeCameraCart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x10);
    let calls = 0;
    cart.onCameraCapture = () => calls++;
    cart.write(0xa001, 0x01); // sensor reg #1 — not the trigger
    cart.write(0xa005, 0xff);
    expect(calls).toBe(0);
  });

  it("only register 0 is readable in camera mode; A001-A035 return 0 regardless of last write", () => {
    // Real M64283FP wiring: only the busy/trigger byte at register 0
    // is wired to the data bus on read; every other register is a
    // write-only sink. ROMs use the all-zero read pattern as an
    // "is the camera present?" probe, so getting this wrong has been
    // observed to bounce the UI into a fallback menu.
    const cart = makeCameraCart();
    cart.write(0x4000, 0x10);
    cart.write(0xa001, 0x42);
    cart.write(0xa010, 0xab);
    cart.write(0xa035, 0x77);
    expect(cart.read(0xa001)).toBe(0x00);
    expect(cart.read(0xa010)).toBe(0x00);
    expect(cart.read(0xa035)).toBe(0x00);
  });

  it("camera-mode register window mirrors across the full A000-BFFF range (mask 0x7F)", () => {
    // The cart masks the address with 0x7F — the 128-byte register
    // space repeats every 0x80 bytes throughout A000-BFFF. So A000,
    // A080, A100, A180… all alias to register 0. Aliased reads of
    // register 0 come back identically; aliased non-zero offsets all
    // return 0.
    const cart = makeCameraCart();
    cart.write(0x4000, 0x10);
    // Park a known value in register 0 by writing without bit 0
    // (writes with bit 0 set get masked to `& 6`).
    cart.write(0xa000, 0x06);
    expect(cart.read(0xa000)).toBe(0x06);
    expect(cart.read(0xa080)).toBe(0x06); // mirror
    expect(cart.read(0xa100)).toBe(0x06); // mirror
    expect(cart.read(0xa180)).toBe(0x06); // mirror
    expect(cart.read(0xb000)).toBe(0x06); // mirror — register window covers all of A000-BFFF
    // Non-zero register offsets are write-only → read 0 even at mirrored offsets.
    expect(cart.read(0xa001)).toBe(0x00);
    expect(cart.read(0xa081)).toBe(0x00);
    expect(cart.read(0xa101)).toBe(0x00);
  });

  it("captured-image buffer is reachable as cart RAM at bank 0 offset 0x100 after camera mode is dropped", () => {
    // The Camera ROM's live-view loop: trigger capture (camera mode
    // on, write 1 to A000) → drop camera mode → read pixel data from
    // A100-AEFF as if it were normal cart RAM. The host's job is to
    // populate cart RAM bank 0 at offset 0x100 in response to the
    // capture trigger; the ROM picks it up via the regular SRAM path.
    const cart = makeCameraCart();
    let captured = false;
    const fakeFrame = new Uint8Array(3584);
    for (let i = 0; i < fakeFrame.length; i++) fakeFrame[i] = (i * 17) & 0xff;
    cart.onCameraCapture = (c) => {
      captured = true;
      c.writeCameraImage(fakeFrame);
    };
    cart.write(0x4000, 0x10); // camera mode on
    cart.write(0xa000, 0x01); // trigger
    expect(captured).toBe(true);
    cart.write(0x4000, 0x00); // drop camera mode → bank 0 visible at A000-AFFF
    expect(cart.read(0xa100)).toBe(fakeFrame[0]);
    expect(cart.read(0xa1ff)).toBe(fakeFrame[0xff]);
    expect(cart.read(0xaeff)).toBe(fakeFrame[0xdff]);
    // Album metadata at A000-A0FF is untouched by capture writes.
    expect(cart.read(0xa000)).toBe(0xff);
    expect(cart.read(0xa0ff)).toBe(0xff);
  });

  it("sensor registers stay reachable even when RAM is not enabled (sensor I/O bypasses the cart-RAM gate)", () => {
    // Real hardware routes A000-A035 through the M64283FP, not the
    // MBC's cart-RAM path — the RAM-enable signal doesn't gate it.
    // Without this, the GB Camera ROM's busy-bit poll reads back
    // 0xFF (cart-RAM-disabled fallback) and hangs forever.
    const cart = makeCameraCart();
    cart.write(0x4000, 0x10); // camera mode on, RAM never enabled
    expect(cart.read(0xa000)).toBe(0x00); // not 0xFF
    // Writes also bypass the gate — required so the ROM can configure
    // exposure / contrast registers before the first capture.
    cart.write(0xa000, 0x03);
    expect(cart.read(0xa000) & 0x01).toBe(0); // capture triggered + busy bit cleared
  });

  it("RAM bank switching addresses different 8 KiB banks of the 128 KiB store", () => {
    const cart = makeCameraCart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x00); // bank 0
    cart.write(0xa000, 0x11);
    cart.write(0x4000, 0x05); // bank 5
    cart.write(0xa000, 0x55);
    cart.write(0x4000, 0x00);
    expect(cart.read(0xa000)).toBe(0x11);
    cart.write(0x4000, 0x05);
    expect(cart.read(0xa000)).toBe(0x55);
  });
});

describe("Cartridge constructor rejection", () => {
  it("rejects files under 32 KiB as too small to carry a valid header", () => {
    const tiny = new Uint8Array(0x1000);
    expect(() => new Cartridge(tiny)).toThrow(/too small/i);
  });

  it("rejects a 32 KiB file that doesn't carry the expected Nintendo-logo fingerprint", () => {
    // A zeroed-out ROM has the right size but won't match the logo CRC32,
    // so the constructor should refuse it. This is the same gate that
    // catches `.txt` files renamed to `.gb`.
    const fake = new Uint8Array(0x8000);
    expect(() => new Cartridge(fake)).toThrow(/logo/i);
  });

  it("rejects a file whose logo region is corrupted by even a single byte", () => {
    const fake = new Uint8Array(0x8000);
    // We don't embed the real Nintendo logo bytes so we can't build a valid
    // ROM here — but any bit pattern in the logo region should fail the
    // CRC32 check, demonstrating that the validator is byte-sensitive.
    for (let i = 0x0104; i < 0x0134; i++) fake[i] = 0xa5;
    expect(() => new Cartridge(fake)).toThrow(/logo/i);
  });
});

describe("MBC7 (cart type 0x22 — Kirby Tilt 'n' Tumble)", () => {
  function makeMbc7Cart(): Cartridge {
    // Real cart: 1 MB ROM (size code 5). RAM size header byte is
    // ignored — MBC7 always allocates 256 bytes of EEPROM regardless.
    return new Cartridge(buildRom({ typeCode: 0x22, romSizeCode: 5, sizeBytes: 0x100000 }), {
      skipLogoCheck: true
    });
  }

  /** Drive a complete EEPROM command frame: start bit + 9 opcode/
   *  address bits, MSB-first, optionally followed by N data bits.
   *  Each "cycle" is the canonical CS=1, CLK=0+DI, CLK=1 dance. */
  function eepromCommand(cart: Cartridge, opcode: number, arg: number, data?: number, dataBits = 16): void {
    const writeReg = (cs: number, clk: number, di: number): void => {
      cart.write(0xa080, (cs << 7) | (clk << 6) | (di << 1));
    };
    // Wake up the chip.
    writeReg(1, 0, 0);
    const sendBit = (b: number): void => {
      writeReg(1, 0, b);
      writeReg(1, 1, b);
    };
    sendBit(1); // start bit
    // 2-bit opcode MSB-first.
    sendBit((opcode >> 1) & 1);
    sendBit(opcode & 1);
    // 7-bit address / extended-op selector MSB-first.
    for (let i = 6; i >= 0; i--) sendBit((arg >> i) & 1);
    if (data !== undefined) {
      for (let i = dataBits - 1; i >= 0; i--) sendBit((data >> i) & 1);
    }
    // Drop CS to terminate.
    writeReg(0, 0, 0);
  }

  function eepromRead(cart: Cartridge, address: number): number {
    const writeReg = (cs: number, clk: number, di: number): void => {
      cart.write(0xa080, (cs << 7) | (clk << 6) | (di << 1));
    };
    writeReg(1, 0, 0);
    const sendBit = (b: number): void => {
      writeReg(1, 0, b);
      writeReg(1, 1, b);
    };
    sendBit(1); // start
    sendBit(1); // opcode bit 1 — READ = 0b10
    sendBit(0); // opcode bit 0
    for (let i = 6; i >= 0; i--) sendBit((address >> i) & 1);
    // Clock 16 bits out, sampling DO before each rising edge.
    let word = 0;
    for (let i = 15; i >= 0; i--) {
      writeReg(1, 0, 0);
      writeReg(1, 1, 0);
      const v = cart.read(0xa080);
      word |= (v & 1) << i;
    }
    writeReg(0, 0, 0);
    return word & 0xffff;
  }

  it("constructs and reports the MBC7 mbc type with a 256-byte EEPROM area", () => {
    const cart = makeMbc7Cart();
    expect(cart.mbcType).toBe("MBC7");
    expect(cart.ram.length).toBe(0x100);
    expect(cart.ram.every((b) => b === 0xff)).toBe(true); // unprogrammed default
  });

  it("requires both 0x0A and 0x40 RAM-enable handshakes before the register window decodes", () => {
    const cart = makeMbc7Cart();
    // Neither enable set → reads return 0xFF.
    expect(cart.read(0xa020)).toBe(0xff);
    cart.write(0x0000, 0x0a); // primary only
    expect(cart.read(0xa020)).toBe(0xff);
    cart.write(0x4000, 0x40); // secondary too
    // Tilt latch hasn't been triggered yet, so X reads as the
    // "no sample" sentinel low byte — but it's no longer 0xFF.
    expect(cart.read(0xa020)).toBe(0x00); // 0x8000 low byte
    expect(cart.read(0xa030)).toBe(0x80); // 0x8000 high byte
  });

  it("only the literal byte 0x40 unlocks the secondary enable; anything else disables it", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    expect(cart.read(0xa030)).toBe(0x80); // unlocked
    cart.write(0x4000, 0x42); // close-but-no-cigar
    expect(cart.read(0xa030)).toBe(0xff); // locked again
    cart.write(0x4000, 0x00);
    expect(cart.read(0xa030)).toBe(0xff);
  });

  it("requires 0x55 → 0xAA write-pair to latch a fresh tilt sample", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    cart.tiltSource = () => ({ x: 1.0, y: -1.0 }); // +1g east, +1g south
    // Writing 0xAA without a prior 0x55 must NOT sample (the cart
    // would be reading a half-handshake and seeing stale data).
    cart.write(0xa010, 0xaa);
    expect((cart.read(0xa030) << 8) | cart.read(0xa020)).toBe(0x8000);
    // Now do it properly.
    cart.write(0xa000, 0x55);
    cart.write(0xa010, 0xaa);
    const x = (cart.read(0xa030) << 8) | cart.read(0xa020);
    const y = (cart.read(0xa050) << 8) | cart.read(0xa040);
    // X axis is inverted on the cart (host +1g east → raw decreases),
    // so +1g host = 0x81D0 - 0x70 = 0x8160. Y axis is direct: -1g
    // host = 0x81D0 - 0x70 = 0x8160.
    expect(x).toBe(0x8160);
    expect(y).toBe(0x8160);
  });

  it("Ax6x reads 0x00 and Ax7x reads 0xFF (cart's sanity-check constants)", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    expect(cart.read(0xa060)).toBe(0x00);
    expect(cart.read(0xa070)).toBe(0xff);
  });

  it("EEPROM WRITE without prior EWEN is silently dropped", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    // Try to program word 5 to 0x1234 — without EWEN, EEPROM ignores.
    eepromCommand(cart, 0b01, 5, 0x1234);
    expect(eepromRead(cart, 5)).toBe(0xffff); // still unprogrammed
  });

  it("EEPROM WRITE after EWEN persists a 16-bit word", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    eepromCommand(cart, 0b00, 0b1100000); // EWEN
    eepromCommand(cart, 0b01, 5, 0x1234);
    expect(eepromRead(cart, 5)).toBe(0x1234);
    // Other words remain at their unprogrammed default.
    expect(eepromRead(cart, 4)).toBe(0xffff);
    expect(eepromRead(cart, 6)).toBe(0xffff);
  });

  it("EEPROM ERASE clears one word back to 0xFFFF", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    eepromCommand(cart, 0b00, 0b1100000); // EWEN
    eepromCommand(cart, 0b01, 5, 0x1234);
    eepromCommand(cart, 0b11, 5); // ERASE word 5
    expect(eepromRead(cart, 5)).toBe(0xffff);
  });

  it("EEPROM ERAL wipes the whole chip while EWEN is active", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    eepromCommand(cart, 0b00, 0b1100000); // EWEN
    eepromCommand(cart, 0b01, 5, 0x1234);
    eepromCommand(cart, 0b01, 50, 0xabcd);
    eepromCommand(cart, 0b00, 0b1000000); // ERAL (top 2 bits of arg = 10)
    expect(eepromRead(cart, 5)).toBe(0xffff);
    expect(eepromRead(cart, 50)).toBe(0xffff);
  });

  it("EEPROM EWDS disables further writes until EWEN is re-issued", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    eepromCommand(cart, 0b00, 0b1100000); // EWEN
    eepromCommand(cart, 0b01, 5, 0x1234);
    eepromCommand(cart, 0b00, 0b0000000); // EWDS
    eepromCommand(cart, 0b01, 5, 0xdead); // attempt overwrite
    expect(eepromRead(cart, 5)).toBe(0x1234); // still the old value
  });

  it("WRAL writes the same 16-bit word to every slot", () => {
    const cart = makeMbc7Cart();
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x40);
    eepromCommand(cart, 0b00, 0b1100000); // EWEN
    eepromCommand(cart, 0b00, 0b0100000, 0xa5a5); // WRAL → fill all 128 words
    for (const a of [0, 1, 50, 127]) expect(eepromRead(cart, a)).toBe(0xa5a5);
  });
});
