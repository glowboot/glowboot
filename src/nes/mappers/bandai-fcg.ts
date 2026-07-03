/**
 * Mapper 16 (Bandai FCG-1 / FCG-2 / LZ93D50) — Dragon Ball / Dragon Ball Z RPGs,
 * SD Gundam Gaiden, Rokudenashi Blues, Datach carts. A 16 KiB switchable PRG
 * bank at $8000 (last bank fixed at $C000), eight 1 KiB CHR banks, switchable
 * mirroring, a 16-bit CPU-cycle IRQ counter, and a serial 24C01/24C02 EEPROM for
 * the battery save.
 *
 * Registers (mirrored across $6000-$7FFF for FCG-1/2 and $8000-$FFFF for the
 * LZ93D50; decoded by the low nibble):
 *   $x0-$x7  CHR bank 0-7 (1 KiB each)
 *   $x8      PRG bank (16 KiB)
 *   $x9      mirroring (0 vert, 1 horiz, 2 one-screen A, 3 one-screen B)
 *   $xA      IRQ control: bit 0 enable, reload counter from latch, acknowledge
 *   $xB/$xC  IRQ latch low / high byte
 *   $xD      EEPROM / RAM control (drives the serial EEPROM's clock + data)
 *
 * Reference: https://www.nesdev.org/wiki/INES_Mapper_016 and /wiki/Bandai_FCG.
 */

import type { Mirroring, NesRom } from "../cartridge/rom.js";
import type { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import type { Mapper } from "./mapper.js";

// EEPROM transfer phases.
const IDLE = 0;
const DEVICE = 1; // shifting in the 1010xxxR device-address byte
const WORD = 2; // shifting in the word address (write path)
const WRITE = 3; // shifting in a data byte to store
const READ = 4; // shifting a data byte out to the CPU
const ACK = 5; // one clock where the slave drives ACK, then → `after`
const READ_ACK = 6; // one clock reading the master's ACK/NACK after a read byte

/** Serial I²C EEPROM (24C01 = 128 B, 24C02 = 256 B) as wired on the LZ93D50: the
 *  CPU drives SCL/SDA through $800D and reads SDA back at $6000 bit 4. Modelled
 *  as an I²C slave clocked by the SCL/SDA transitions. */
class SerialEeprom {
  readonly data: Uint8Array;
  private readonly mask: number;
  private scl = 0;
  private sda = 0;
  private state = IDLE;
  private after = IDLE; // phase to resume after an ACK clock
  private bit = 0;
  private buf = 0;
  private addr = 0;
  private out = 1; // SDA driven back to the CPU (1 = released/high)

  constructor(bytes: number) {
    this.data = new Uint8Array(bytes).fill(0xff);
    this.mask = bytes - 1;
  }

  read(): number {
    return this.out;
  }

  write(scl: number, sda: number): void {
    if (this.scl && scl) {
      // SCL steady high: an SDA edge is a START or STOP condition.
      if (this.sda && !sda) {
        this.state = DEVICE;
        this.bit = 0;
        this.buf = 0;
        this.out = 1;
      } else if (!this.sda && sda) {
        this.state = IDLE;
        this.out = 1;
      }
    } else if (!this.scl && scl) {
      this.rising(sda);
    } else if (this.scl && !scl) {
      this.falling();
    }
    this.scl = scl;
    this.sda = sda;
  }

  private rising(sda: number): void {
    switch (this.state) {
      case DEVICE:
      case WORD:
      case WRITE:
        this.buf = ((this.buf << 1) | sda) & 0xff;
        this.bit++;
        break;
      case READ:
        this.bit++; // the output bit was placed on the falling edge
        break;
      case READ_ACK:
        // Master ACK (0) continues the sequential read; NACK (1) ends it.
        this.state = sda ? IDLE : READ;
        this.bit = 0;
        break;
    }
  }

  private falling(): void {
    if ((this.state === DEVICE || this.state === WORD || this.state === WRITE) && this.bit === 8) {
      this.bit = 0;
      this.completeInputByte(); // drives ACK (out = 0, SDA low) for the master to sample
    } else if (this.state === ACK) {
      // 9th clock done: release SDA (writes) or start clocking data out (reads).
      this.state = this.after;
      this.bit = 0;
      if (this.state === READ) this.placeReadBit();
      else this.out = 1;
    } else if (this.state === READ && this.bit === 8) {
      this.addr = (this.addr + 1) & this.mask;
      this.state = READ_ACK;
      this.out = 1; // release SDA for the master to ACK/NACK
    } else if (this.state === READ) {
      this.placeReadBit();
    }
  }

  private completeInputByte(): void {
    if (this.state === DEVICE) {
      this.after = this.buf & 1 ? READ : WORD; // R/W bit: read, else the word address follows
    } else if (this.state === WORD) {
      this.addr = this.buf & this.mask;
      this.after = WRITE;
    } else {
      this.data[this.addr] = this.buf; // WRITE: store + auto-increment
      this.addr = (this.addr + 1) & this.mask;
      this.after = WRITE;
    }
    this.state = ACK;
    this.out = 0; // acknowledge: held low through the 9th (ACK) clock
  }

  private placeReadBit(): void {
    this.out = (this.data[this.addr]! >> (7 - this.bit)) & 1;
  }

  serialize(w: NesStateWriter): void {
    w.bytes(this.data);
    w.u8(this.scl);
    w.u8(this.sda);
    w.u8(this.state);
    w.u8(this.after);
    w.u8(this.bit);
    w.u8(this.buf);
    w.u16(this.addr);
    w.u8(this.out);
  }
  deserialize(r: NesStateReader): void {
    r.bytes(this.data);
    this.scl = r.u8();
    this.sda = r.u8();
    this.state = r.u8();
    this.after = r.u8();
    this.bit = r.u8();
    this.buf = r.u8();
    this.addr = r.u16();
    this.out = r.u8();
  }
}

export class BandaiFcgMapper implements Mapper {
  private readonly prg: Uint8Array;
  private readonly chr: Uint8Array;
  private readonly chrWritable: boolean;
  private readonly prgBankCount: number; // 16 KiB units
  private readonly chrBankCount: number; // 1 KiB units

  private prgBank = 0;
  private readonly chrBanks = [0, 0, 0, 0, 0, 0, 0, 0];
  private mirror: Mirroring;

  private irqEnabled = false;
  private irqCounter = 0;
  private irqLatch = 0;
  private irqPending = false;

  private readonly eeprom: SerialEeprom;

  constructor(rom: NesRom) {
    this.prg = rom.prgRom;
    this.prgBankCount = Math.max(1, rom.prgRom.length / 0x4000);
    this.mirror = rom.mirroring;
    if (rom.usesChrRam) {
      this.chr = new Uint8Array(rom.chrRamSize || 0x2000);
      this.chrWritable = true;
    } else {
      this.chr = rom.chrRom;
      this.chrWritable = false;
    }
    this.chrBankCount = Math.max(1, this.chr.length / 0x400);
    // 24C02 (256 B) on the LZ93D50 with battery; 24C01 (128 B) otherwise.
    this.eeprom = new SerialEeprom(rom.submapper === 5 || rom.prgNvramSize >= 256 ? 256 : 128);
  }

  prgRead(addr: number): number {
    const bank = addr & 0x4000 ? this.prgBankCount - 1 : this.prgBank;
    return this.prg[((bank % this.prgBankCount) * 0x4000 + (addr & 0x3fff)) % this.prg.length]!;
  }

  prgWrite(addr: number, value: number): void {
    this.register(addr, value);
  }
  lowWrite(addr: number, value: number): void {
    this.register(addr, value); // FCG-1/2 place the registers at $6000-$7FFF
  }
  lowRead(addr: number): number | null {
    if (addr < 0x8000) return this.eeprom.read() << 4; // SDA on bit 4
    return null;
  }

  private register(addr: number, value: number): void {
    switch (addr & 0x0f) {
      case 0x0:
      case 0x1:
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x5:
      case 0x6:
      case 0x7:
        this.chrBanks[addr & 7] = value;
        break;
      case 0x8:
        this.prgBank = value & 0x0f;
        break;
      case 0x9:
        this.mirror = ["vertical", "horizontal", "single-lower", "single-upper"][value & 3] as Mirroring;
        break;
      case 0xa:
        this.irqEnabled = (value & 1) !== 0;
        this.irqCounter = this.irqLatch;
        this.irqPending = false;
        break;
      case 0xb:
        this.irqLatch = (this.irqLatch & 0xff00) | value;
        break;
      case 0xc:
        this.irqLatch = (this.irqLatch & 0x00ff) | (value << 8);
        break;
      case 0xd:
        // EEPROM: bit 5 = SCL, bit 6 = SDA.
        this.eeprom.write((value >> 5) & 1, (value >> 6) & 1);
        break;
    }
  }

  chrRead(addr: number): number {
    return this.chr[this.chrOffset(addr)]!;
  }
  chrWrite(addr: number, value: number): void {
    if (this.chrWritable) this.chr[this.chrOffset(addr)] = value;
  }
  private chrOffset(addr: number): number {
    const bank = this.chrBanks[(addr >> 10) & 7]!;
    return ((bank % this.chrBankCount) * 0x400 + (addr & 0x3ff)) % this.chr.length;
  }

  mirroring(): Mirroring {
    return this.mirror;
  }

  tick(cpuCycles: number): void {
    if (!this.irqEnabled) return;
    for (let i = 0; i < cpuCycles; i++) {
      if (this.irqCounter === 0) {
        this.irqCounter = 0xffff;
        this.irqPending = true;
      } else {
        this.irqCounter--;
      }
    }
  }
  irqState(): boolean {
    return this.irqPending;
  }

  serialize(w: NesStateWriter): void {
    w.u8(this.prgBank);
    for (const b of this.chrBanks) w.u8(b);
    w.u8(["vertical", "horizontal", "single-lower", "single-upper", "four-screen"].indexOf(this.mirror));
    w.bool(this.irqEnabled);
    w.u16(this.irqCounter);
    w.u16(this.irqLatch);
    w.bool(this.irqPending);
    this.eeprom.serialize(w);
    if (this.chrWritable) w.bytes(this.chr);
  }
  deserialize(r: NesStateReader): void {
    this.prgBank = r.u8();
    for (let i = 0; i < this.chrBanks.length; i++) this.chrBanks[i] = r.u8();
    this.mirror = ["vertical", "horizontal", "single-lower", "single-upper", "four-screen"][r.u8()] as Mirroring;
    this.irqEnabled = r.bool();
    this.irqCounter = r.u16();
    this.irqLatch = r.u16();
    this.irqPending = r.bool();
    this.eeprom.deserialize(r);
    if (this.chrWritable) r.bytes(this.chr);
  }
}
