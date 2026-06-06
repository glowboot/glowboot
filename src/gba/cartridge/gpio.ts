/**
 * Cart GPIO controller — 4-pin general-purpose I/O exposed at three
 * fixed cart-ROM addresses just past the header:
 *
 *   0x080000C4  Data register      (4 bits used, bits 4-15 reserved)
 *   0x080000C6  Direction register (4 bits, 1 = output / CPU drives,
 *                                            0 = input  / cart drives)
 *   0x080000C8  Read-enable        (bit 0: 1 = GPIO reads visible,
 *                                            0 = reads at the three
 *                                                addresses fall through
 *                                                to the cart-ROM bytes)
 *
 * Multiple cart peripherals share these four data bits in practice —
 * Drill Dozer drives a rumble actuator on bit 3, the Seiko S-3511A
 * real-time clock used by Pokémon Gen 3 drives SCK/SIO/CS on bits
 * 0/1/2, and Boktai's solar sensor sits on bit 3 again on a cart that
 * doesn't ship rumble. The controller therefore takes plug-in features
 * via `addFeature(...)`: every CPU data-register write fans out to
 * each feature (so they can decode edges off their own pins) and every
 * CPU data-register read pools the cart-driven bits each feature wants
 * to assert on input pins.
 *
 * Pin convention from the CPU's POV: a write to the data register
 * affects only the bits the direction register marks as outputs;
 * input bits keep whatever value the cart-driven peripherals set
 * during the previous read.
 *
 * Read-enable defaults to false on cart power-on — cart code that
 * never writes the enable register sees pure cart-ROM bytes at
 * 0xC4-0xC8 (which is what the ROM image places there). The bus
 * checks `readEnable` before delegating reads to this controller; when
 * it's false the cart-ROM region's normal byte-read path runs instead.
 */

/** Single bit position for the chip-select / read-enable / etc. pins
 *  used by peripherals. Exported so feature implementations can build
 *  bitmasks without re-deriving the values. */
export const GPIO_SCK = 1 << 0;
export const GPIO_SIO = 1 << 1;
export const GPIO_CS = 1 << 2;
export const GPIO_BIT3 = 1 << 3;

/** Plug-in interface for a peripheral that listens on the GPIO. The
 *  controller calls `onDataWrite` after each CPU write to the data
 *  register and pools `readData` outputs across features on each
 *  read. Features that only care about writes (rumble) can return 0
 *  from `readData`. */
export interface GpioFeature {
  /** Called after the CPU has written the data register. `cpuData` is
   *  the 4-bit value the CPU drove (already masked to output pins);
   *  `direction` is the current 4-bit direction register. The feature
   *  is responsible for tracking pin edges across calls. */
  onDataWrite(cpuData: number, direction: number): void;

  /** Called when the CPU reads the data register. The feature returns
   *  the 4-bit value it wants to assert on input pins (direction bit
   *  = 0). The controller masks the result against `~direction` before
   *  OR-ing with CPU-driven output bits, so features can return their
   *  full pin map; bits the CPU drives win over feature output for
   *  those positions. */
  readData(direction: number): number;
}

/** Cart-side GPIO controller. One instance lives on `MappedBus` when
 *  the loaded cart needs GPIO; otherwise the field is null and the
 *  bus skips the special-case routing. */
export class GbaCartGpio {
  /** Last 4-bit data value the CPU wrote. Output pins (direction = 1)
   *  read back as this. */
  private data = 0;
  /** Direction register — bit set = CPU is output / cart is input. */
  private direction = 0;
  /** True when read-enable register's bit 0 is set. When false the
   *  bus's read path bypasses this controller entirely. */
  private _readEnable = false;
  /** Active feature list. Reads pool their output; writes broadcast. */
  private readonly features: GpioFeature[] = [];

  get readEnable(): boolean {
    return this._readEnable;
  }

  addFeature(f: GpioFeature): void {
    this.features.push(f);
  }

  /** Bus-side write entry. `addr` is the absolute cart-ROM address;
   *  the controller cares about 0x080000C4 / C6 / C8 only. */
  write(addr: number, value: number): void {
    switch (addr & 0xfffffffe) {
      case 0x080000c4: {
        const newData = value & 0xf;
        if (newData !== this.data) {
          this.data = newData;
          for (const f of this.features) f.onDataWrite(newData, this.direction);
        }
        return;
      }
      case 0x080000c6:
        this.direction = value & 0xf;
        return;
      case 0x080000c8:
        this._readEnable = (value & 1) !== 0;
        return;
    }
  }

  /** Bus-side read entry. Caller must check `readEnable` first — when
   *  it's false the bus reads the cart-ROM bytes instead, not this. */
  read(addr: number): number {
    switch (addr & 0xfffffffe) {
      case 0x080000c4: {
        // CPU-output pins read back what CPU wrote; CPU-input pins
        // read what features drive. Mask each contribution to the
        // bits it owns to keep the lanes disjoint.
        let cartBits = 0;
        for (const f of this.features) cartBits |= f.readData(this.direction);
        const cpuBits = this.data & this.direction;
        const inputBits = cartBits & ~this.direction & 0xf;
        return (cpuBits | inputBits) & 0xf;
      }
      case 0x080000c6:
        return this.direction;
      case 0x080000c8:
        return this._readEnable ? 1 : 0;
    }
    return 0;
  }
}
