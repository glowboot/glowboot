/**
 * OBC1 — the OBJ controller used solely by Metal Combat: Falcon's Revenge.
 * It sits on the cart's 8 KiB battery SRAM window ($6000-$7FFF of banks
 * $00-$3F / $80-$BF) and scatters sprite writes into the layout the S-PPU's
 * OAM DMA expects: the game streams a sprite's four low-table bytes through
 * $7FF0-$7FF3 and its two high-table bits through $7FF4, and the chip
 * distributes them by the current sprite index ($7FF6) and table base
 * ($7FF5). Every other address in the window is plain SRAM.
 *
 * The three latched fields (base pointer, sprite index, bit-shift) are pure
 * functions of the persisted $7FF5/$7FF6 bytes, so they carry no state of
 * their own — {@link reset} recomputes them from SRAM, which is how a
 * loaded save state or a fresh boot restores them.
 *
 * Register interface follows fullsnes "SNES Cart OBC1"; ported from the
 * established open-source reference.
 */

export class Obc1 {
  private readonly ram: Uint8Array;
  private baseptr = 0x1c00;
  private address = 0;
  private shift = 0;

  /** `sram` is the cart's battery RAM (≥ 8 KiB), shared with the bus. */
  constructor(sram: Uint8Array) {
    this.ram = sram;
    this.reset();
  }

  reset(): void {
    this.baseptr = this.ram[0x1ff5]! & 1 ? 0x1800 : 0x1c00;
    this.address = this.ram[0x1ff6]! & 0x7f;
    this.shift = (this.ram[0x1ff6]! & 3) << 1;
  }

  /** `off` is the $6000-$7FFF window offset within its bank. */
  read(off: number): number {
    const a = off & 0x1fff;
    switch (a) {
      case 0x1ff0:
        return this.ram[this.baseptr + (this.address << 2) + 0]!;
      case 0x1ff1:
        return this.ram[this.baseptr + (this.address << 2) + 1]!;
      case 0x1ff2:
        return this.ram[this.baseptr + (this.address << 2) + 2]!;
      case 0x1ff3:
        return this.ram[this.baseptr + (this.address << 2) + 3]!;
      case 0x1ff4:
        return this.ram[this.baseptr + (this.address >> 2) + 0x200]!;
    }
    return this.ram[a]!;
  }

  write(off: number, data: number): void {
    const a = off & 0x1fff;
    switch (a) {
      case 0x1ff0:
        this.ram[this.baseptr + (this.address << 2) + 0] = data;
        return;
      case 0x1ff1:
        this.ram[this.baseptr + (this.address << 2) + 1] = data;
        return;
      case 0x1ff2:
        this.ram[this.baseptr + (this.address << 2) + 2] = data;
        return;
      case 0x1ff3:
        this.ram[this.baseptr + (this.address << 2) + 3] = data;
        return;
      case 0x1ff4: {
        const ptr = this.baseptr + (this.address >> 2) + 0x200;
        this.ram[ptr] = (this.ram[ptr]! & ~(3 << this.shift)) | ((data & 3) << this.shift);
        return;
      }
      case 0x1ff5:
        this.baseptr = data & 1 ? 0x1800 : 0x1c00;
        this.ram[a] = data;
        return;
      case 0x1ff6:
        this.address = data & 0x7f;
        this.shift = (data & 3) << 1;
        this.ram[a] = data;
        return;
    }
    this.ram[a] = data;
  }
}
