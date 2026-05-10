import type { APU } from "../apu/apu.js";
import type { Cartridge } from "../cartridge/cartridge.js";
import type { CheatManager } from "../cheats/manager.js";
import type { CPU } from "../cpu/cpu.js";
import { checkRead, checkWrite } from "../debug/breakpoints.js";
import type { Joypad } from "../joypad/joypad.js";
import type { PPU } from "../ppu/ppu.js";
import type { StateReader, StateWriter } from "../serialization/serialization.js";
import type { Timer } from "../timer/timer.js";
import { INTERRUPT_SERIAL, type InterruptController } from "./interrupts.js";
import { NO_LINK, type SerialLink } from "./serial-link.js";

/**
 * Memory Management Unit — the system bus.
 *
 * Game Boy memory map:
 *  0x0000–0x3FFF  ROM Bank 0
 *  0x4000–0x7FFF  ROM Bank N (switchable via MBC)
 *  0x8000–0x9FFF  Video RAM (VRAM)
 *  0xA000–0xBFFF  External / cartridge RAM
 *  0xC000–0xCFFF  Work RAM Bank 0
 *  0xD000–0xDFFF  Work RAM Bank 1
 *  0xE000–0xFDFF  Echo RAM (mirrors 0xC000–0xDDFF)
 *  0xFE00–0xFE9F  OAM (sprite attribute table)
 *  0xFEA0–0xFEFF  Prohibited
 *  0xFF00–0xFF7F  I/O registers
 *  0xFF80–0xFFFE  High RAM (HRAM)
 *  0xFFFF         Interrupt Enable register
 */
export class MMU {
  /** WRAM: 8 KiB on DMG, 32 KiB on CGB (8 banks × 4 KiB). */
  private readonly wram: Uint8Array;
  private readonly hram = new Uint8Array(0x007f); // 127 B High RAM

  /** CGB WRAM bank (1-7). Bank 0 is always mapped at 0xC000. */
  private svbk = 1;

  // CGB HDMA state.
  private hdmaSrcHi = 0xff;
  private hdmaSrcLo = 0xff;
  private hdmaDstHi = 0xff;
  private hdmaDstLo = 0xff;
  private hdmaCtrl = 0xff; // 0xFF55 read value (0xff = idle)
  // H-Blank HDMA progress
  private hdmaActive = false;
  private hdmaSrcCur = 0;
  private hdmaDstCur = 0;
  private hdmaBlocks = 0; // remaining 16-byte blocks

  /** OAM DMA state. 160 bytes copied at one byte per M-cycle, plus a
   *  setup delay before the first copy. Mooneye `ret_timing` is the
   *  cycle-precise reference: it parks SP so RET pops the high byte from
   *  OAM[0] exactly on the cycle DMA writes byte 159, and expects to read
   *  the locked-DMA value (0xFF). For our `tickDma` runs *before* the
   *  bus access in the same M-cycle, we need a 2-cycle setup window so
   *  byte 159 is still copying — not just-finished — when the read
   *  resolves. */
  private dmaActive = false;
  private dmaStartDelay = 0;
  private dmaSrcBase = 0;
  private dmaIndex = 0;

  /** Set after construction — breaks the MMU ↔ CPU reference cycle. */
  cpu: CPU | null = null;

  /** Attached by GameBoy; null when there are no cheats at all. */
  cheats: CheatManager | null = null;

  /** Serial-out hook (SB at 0xFF01, triggered by writing 0x81 to SC at
   *  0xFF02). Used by the Blargg headless runner to capture test output;
   *  the running emulator leaves this null. */
  onSerialOut: ((byte: number) => void) | null = null;
  private serialData = 0x00;

  /** SC register (0xFF02). Bit 7 = transfer active, bit 1 = CGB high-
   *  speed clock, bit 0 = clock source (1 = internal / master). */
  private serialControl = 0x7e; // post-boot value (bits 1-6 are ones)
  /** Set during a master transfer while we're waiting for the peer's
   *  async response; guards against double-completion when the
   *  peer-initiated path fires for a race'd transfer. */
  private serialAwaitingPeer = false;

  /** Number of T-cycles remaining before the current master transfer's
   *  response byte is latched into SB and the serial IRQ fires. Real
   *  hardware takes one byte time per transfer: 4096 T-cycles at
   *  8192 Hz baud (DMG / CGB normal speed), 128 T-cycles in CGB
   *  high-speed mode (SC bit 1 set). Some interrupt-driven print
   *  routines (Game Boy Camera) depend on having ~one byte time of
   *  CPU work between the SC=0x81 write and the serial IRQ firing —
   *  completing synchronously stalls them.
   *
   *  When the active link reports `paired === true` (a remote peer
   *  whose reply may take 5-50 ms over the wire), this timer extends
   *  to ~200 ms so the late peer byte still wins over the 0xFF
   *  fallback. The CPU keeps running other instructions in the
   *  meantime; only the IRQ firing is deferred. */
  private serialBitTimer = 0;
  /** ~1 s of T-cycles at the DMG / CGB-normal master clock (4194304 Hz).
   *  Used as the give-up deadline for a master transfer when a remote
   *  peer is connected — anything shorter loses to a relay-path RTT.
   *  The peer's actual reply, when it arrives before this, fires the
   *  IRQ immediately so games proceed at network speed, not deadline
   *  speed. */
  private static readonly REMOTE_SERIAL_TIMEOUT = 4194304;
  /** Peer byte stashed by the link's resolve callback while
   *  `serialBitTimer` counts down. -1 means no transfer in flight. */
  private serialPendingByte = -1;
  /** Pluggable link — the browser side swaps in a BroadcastChannel
   *  implementation when the user enables link-cable mode. Default
   *  no-op mirrors an unplugged cable. */
  serialLink: SerialLink = NO_LINK;

  constructor(
    private readonly cartridge: Cartridge,
    private readonly ppu: PPU,
    private readonly apu: APU,
    private readonly timer: Timer,
    private readonly joypad: Joypad,
    private readonly interrupts: InterruptController,
    private readonly cgb: boolean = false
  ) {
    this.wram = new Uint8Array(cgb ? 0x8000 : 0x2000);
    this.installPeerHandler();
  }

  /** Hot-swap the link backend (e.g. pair mode toggled at runtime). The
   *  new link inherits the same peer-initiated handler so incoming
   *  bytes keep reaching the MMU without the host having to re-wire. */
  setSerialLink(link: SerialLink): void {
    this.serialLink.close();
    this.serialLink = link;
    this.installPeerHandler();
  }

  /** Installed once per `serialLink` instance. When a remote peer that
   *  has internal clock selected sends us a byte, we latch it into our
   *  SB (shifting out whatever was there), fire the serial IRQ if we
   *  were waiting on a transfer, and return our pre-latch byte for the
   *  peer — on real hardware the two shift registers are wired
   *  together, so a clock pulse exchanges one bit per side per beat. */
  private installPeerHandler(): void {
    this.serialLink.onPeerInitiated((peerByte) => {
      const ourByte = this.serialData;
      this.serialData = peerByte & 0xff;
      if (this.serialControl & 0x80) {
        this.serialControl &= ~0x80;
        this.serialAwaitingPeer = false;
        this.interrupts.request(INTERRUPT_SERIAL);
      }
      return ourByte;
    });
  }

  /** Shared completion path for master-side transfers — latches the
   *  received byte into SB, clears SC bit 7, and requests the serial
   *  interrupt. Idempotent: the `serialAwaitingPeer` gate at the call
   *  site prevents a late link response from overwriting a completed
   *  transfer. */
  private completeSerialTransfer(receivedByte: number): void {
    this.serialData = receivedByte & 0xff;
    this.serialControl &= ~0x80;
    this.interrupts.request(INTERRUPT_SERIAL);
  }

  /** Advance the serial-transfer bit timer by `tCycles` T-cycles. When
   *  the timer expires, the pending peer response (stashed by the
   *  link's resolve callback) is latched into SB and the IRQ fires.
   *  If no response has arrived by expiry — async link took longer
   *  than a byte time — we latch 0xFF (matches an unplugged cable). */
  tickSerial(tCycles: number): void {
    if (this.serialBitTimer <= 0) return;
    this.serialBitTimer -= tCycles;
    if (this.serialBitTimer > 0) return;
    this.serialBitTimer = 0;
    if (!this.serialAwaitingPeer) return;
    const peerByte = this.serialPendingByte >= 0 ? this.serialPendingByte : 0xff;
    this.serialPendingByte = -1;
    this.serialAwaitingPeer = false;
    this.completeSerialTransfer(peerByte);
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch on the top nibble of `addr`. V8 lowers the switch to a jump
   * table keyed on `addr >> 12`, so each access resolves in a single indexed
   * branch. Page F (0xF000–0xFFFF) is mixed and falls through a sub-decode.
   */
  readByte(addr: number): number {
    addr &= 0xffff;
    checkRead(addr);
    // While OAM DMA is copying, *only OAM* is locked (it's being written
    // by the DMA). ROM / VRAM / WRAM / IO remain CPU-readable — the bus
    // is busy but instruction fetches still work. Mooneye's `ret_timing`
    // and similar tests rely on the CPU being able to execute the DMA
    // wait loop from ROM rather than HRAM. Games that *do* park their
    // wait loop in HRAM still work fine; this is just less restrictive.
    if (this.dmaActive && addr >= 0xfe00 && addr < 0xfea0) return 0xff;
    const paged = this.readMemoryPage(addr);
    if (paged !== undefined) {
      // Game Genie ROM patches only apply to the 0x0000-0x7FFF range; for
      // everything else (VRAM / external RAM / WRAM / echo) the byte is
      // handed back unchanged.
      return addr < 0x8000 && this.cheats !== null ? this.cheats.patchRomRead(addr, paged) : paged;
    }
    // Page F (0xF000-0xFFFF) — HRAM / IE / echo tail / OAM / unused / IO.
    if (addr >= 0xff80) {
      if (addr === 0xffff) return this.interrupts.ie;
      return this.hram[addr - 0xff80]!;
    }
    if (addr < 0xfe00) return this.wramRead(addr - 0x2000); // echo tail
    if (addr < 0xfea0) return this.ppu.readOam(addr - 0xfe00);
    if (addr < 0xff00) return 0xff; // prohibited
    return this.readIO(addr);
  }

  /**
   * Top-nibble dispatch for pages 0-E (everything except high page F).
   * Returns `undefined` for page F so the caller can handle HRAM / OAM /
   * I/O themselves — each caller has slightly different rules for that
   * region (`readByte` implements the full map; `readDmaSource` returns
   * 0xFF). V8 lowers the switch on `addr >> 12` to a jump table keyed on
   * the top nibble, so this remains a one-indexed-branch hot path even
   * as a separate method.
   */
  private readMemoryPage(addr: number): number | undefined {
    switch (addr >> 12) {
      case 0x0:
      case 0x1:
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x5:
      case 0x6:
      case 0x7:
        return this.cartridge.read(addr); // ROM
      case 0x8:
      case 0x9:
        return this.ppu.readVram(addr - 0x8000); // VRAM
      case 0xa:
      case 0xb:
        return this.cartridge.read(addr); // ext RAM
      case 0xc:
      case 0xd:
        return this.wramRead(addr); // WRAM (banked on CGB)
      case 0xe:
        return this.wramRead(addr - 0x2000); // echo WRAM
      default:
        return undefined;
    }
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  writeByte(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    checkWrite(addr);
    switch (addr >> 12) {
      case 0x0:
      case 0x1:
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x5:
      case 0x6:
      case 0x7:
        this.cartridge.write(addr, value);
        return;
      case 0x8:
      case 0x9:
        this.ppu.writeVram(addr - 0x8000, value);
        return;
      case 0xa:
      case 0xb:
        this.cartridge.write(addr, value);
        return;
      case 0xc:
      case 0xd:
        this.wramWrite(addr, value);
        return;
      case 0xe:
        this.wramWrite(addr - 0x2000, value);
        return;
      default: // 0xf000-0xffff
        // HRAM / IE first — stack pushes land here.
        if (addr >= 0xff80) {
          if (addr === 0xffff) this.interrupts.ie = value;
          else this.hram[addr - 0xff80] = value;
          return;
        }
        if (addr < 0xfe00) {
          this.wramWrite(addr - 0x2000, value);
          return;
        }
        if (addr < 0xfea0) {
          this.ppu.writeOam(addr - 0xfe00, value);
          return;
        }
        if (addr < 0xff00) return; // prohibited
        this.writeIO(addr, value);
    }
  }

  // ─── WRAM (banked in CGB mode) ────────────────────────────────────────────

  private wramRead(addr: number): number {
    if (!this.cgb || addr < 0xd000) return this.wram[addr - 0xc000]!;
    return this.wram[this.svbk * 0x1000 + (addr - 0xd000)]!;
  }

  private wramWrite(addr: number, v: number): void {
    if (!this.cgb || addr < 0xd000) this.wram[addr - 0xc000] = v;
    else this.wram[this.svbk * 0x1000 + (addr - 0xd000)] = v;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    w.bytes(this.wram);
    w.bytes(this.hram);
    w.u8(this.svbk);
    w.u8(this.hdmaSrcHi);
    w.u8(this.hdmaSrcLo);
    w.u8(this.hdmaDstHi);
    w.u8(this.hdmaDstLo);
    w.u8(this.hdmaCtrl);
    w.bool(this.hdmaActive);
    w.u16(this.hdmaSrcCur);
    w.u16(this.hdmaDstCur);
    w.u16(this.hdmaBlocks);
    // OAM DMA in-flight state (without this, a save taken mid-DMA loads
    // with dmaActive=false and the remainder of the copy never happens).
    w.bool(this.dmaActive);
    w.u16(this.dmaSrcBase);
    w.u8(this.dmaIndex);
    w.u8(this.dmaStartDelay);
  }
  deserialize(r: StateReader): void {
    r.bytes(this.wram);
    r.bytes(this.hram);
    this.svbk = r.u8();
    this.hdmaSrcHi = r.u8();
    this.hdmaSrcLo = r.u8();
    this.hdmaDstHi = r.u8();
    this.hdmaDstLo = r.u8();
    this.hdmaCtrl = r.u8();
    this.hdmaActive = r.bool();
    this.hdmaSrcCur = r.u16();
    this.hdmaDstCur = r.u16();
    this.hdmaBlocks = r.u16();
    this.dmaActive = r.bool();
    this.dmaSrcBase = r.u16();
    this.dmaIndex = r.u8();
    this.dmaStartDelay = r.u8();
  }

  // ─── I/O registers ────────────────────────────────────────────────────────

  private readIO(addr: number): number {
    switch (addr) {
      case 0xff00:
        return this.joypad.read();
      case 0xff01:
        return this.serialData;
      case 0xff02:
        // Unused bits (1-6 on DMG, 1-5 on CGB) read as 1.
        return this.serialControl | (this.cgb ? 0x7c : 0x7e);
      case 0xff04:
      case 0xff05:
      case 0xff06:
      case 0xff07:
        return this.timer.readByte(addr);
      // Unused high bits of IF read as 1 on real hardware (see Pan Docs).
      case 0xff0f:
        return this.interrupts.if | 0xe0;
      // ── CGB registers ───────────────────────────────────────────────────
      case 0xff4d:
        return this.cgb && this.cpu ? this.cpu.readKey1() : 0xff;
      case 0xff51:
        return this.cgb ? this.hdmaSrcHi : 0xff;
      case 0xff52:
        return this.cgb ? this.hdmaSrcLo : 0xff;
      case 0xff53:
        return this.cgb ? this.hdmaDstHi : 0xff;
      case 0xff54:
        return this.cgb ? this.hdmaDstLo : 0xff;
      case 0xff55:
        return this.cgb ? this.hdmaCtrl : 0xff;
      case 0xff70:
        return this.cgb ? 0xf8 | this.svbk : 0xff;
      default:
        if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.readByte(addr);
        if (addr >= 0xff40 && addr <= 0xff4b) return this.ppu.readByte(addr);
        if (this.cgb) {
          if (addr === 0xff4f) return this.ppu.readByte(addr);
          if (addr >= 0xff68 && addr <= 0xff6c) return this.ppu.readByte(addr);
        }
        return 0xff;
    }
  }

  private writeIO(addr: number, value: number): void {
    switch (addr) {
      case 0xff00:
        this.joypad.write(value);
        return;
      case 0xff01:
        this.serialData = value;
        return;
      case 0xff02: {
        this.serialControl = value;
        // Headless test-runner hook — fires on the classic "start
        // transfer, internal clock" pattern Blargg test ROMs use to
        // print their pass / fail message via the serial port.
        if ((value & 0x81) === 0x81 && this.onSerialOut) this.onSerialOut(this.serialData);
        if ((value & 0x80) === 0) {
          this.serialAwaitingPeer = false;
          this.serialBitTimer = 0;
          this.serialPendingByte = -1;
          return;
        }
        if (value & 0x01) {
          // Internal clock — we drive the transfer. Send the byte
          // immediately so the link can start its work, but defer the
          // SC-bit-7 clear and the IRQ by one byte time (4096 T-cycles
          // normal, 128 high-speed). Synchronous completion breaks
          // interrupt-driven print routines that expect to do bookkeeping
          // between SC=0x81 and the serial IRQ.
          this.serialAwaitingPeer = true;
          this.serialPendingByte = -1;
          // Local-link timer is one byte time at the selected clock —
          // synchronous resolves want the IRQ deferred this long for
          // Camera-printer compatibility. For a remote peer the timer
          // is the give-up deadline; the IRQ fires earlier on actual
          // arrival of the peer's byte (see the link callback below).
          const isRemote = this.serialLink.paired;
          const localTimer = this.cgb && value & 0x02 ? 128 : 4096;
          this.serialBitTimer = isRemote ? MMU.REMOTE_SERIAL_TIMEOUT : localTimer;
          const sent = this.serialData;
          this.serialLink.sendAsMaster(sent, (peerByte) => {
            if (!this.serialAwaitingPeer) return; // already claimed by peer-initiated path
            if (isRemote) {
              // Remote peer responded — fire the IRQ now so games
              // proceed at network RTT speed instead of waiting out
              // the give-up deadline. Cancel the bit timer so
              // tickSerial doesn't double-fire with 0xFF.
              this.serialAwaitingPeer = false;
              this.serialPendingByte = -1;
              this.serialBitTimer = 0;
              this.completeSerialTransfer(peerByte);
            } else if (this.serialBitTimer > 0) {
              // Local synchronous link — stash the response and let
              // tickSerial latch it once the bit timer expires, so
              // print routines get their expected pre-IRQ window.
              this.serialPendingByte = peerByte & 0xff;
            } else {
              // Local link but timer already fired (shouldn't happen
              // in practice: synchronous resolves stash before the
              // first tick). Latch defensively.
              this.serialAwaitingPeer = false;
              this.completeSerialTransfer(peerByte);
            }
          });
        } else {
          // External clock — we're the slave. The peer's clock will
          // drive completion via the `onPeerInitiated` handler. We
          // just wait (or until the game cancels by clearing SC bit 7).
          this.serialAwaitingPeer = false;
          this.serialBitTimer = 0;
          this.serialPendingByte = -1;
        }
        return;
      }
      case 0xff04:
      case 0xff05:
      case 0xff06:
      case 0xff07:
        this.timer.writeByte(addr, value);
        return;
      case 0xff0f:
        this.interrupts.if = value & 0x1f;
        return;
      // OAM DMA transfer
      case 0xff46:
        this.dmaTransfer(value);
        return;
      // ── CGB registers ───────────────────────────────────────────────────
      case 0xff4d:
        if (this.cgb && this.cpu) this.cpu.writeKey1(value);
        return;
      case 0xff51:
        if (this.cgb) this.hdmaSrcHi = value;
        return;
      case 0xff52:
        if (this.cgb) this.hdmaSrcLo = value & 0xf0;
        return;
      case 0xff53:
        if (this.cgb) this.hdmaDstHi = value & 0x1f;
        return;
      case 0xff54:
        if (this.cgb) this.hdmaDstLo = value & 0xf0;
        return;
      case 0xff55:
        if (this.cgb) this.triggerHdma(value);
        return;
      case 0xff70:
        if (this.cgb) this.svbk = value & 0x07 || 1;
        return;
      default:
        if (addr >= 0xff10 && addr <= 0xff3f) {
          this.apu.writeByte(addr, value);
          return;
        }
        if (addr >= 0xff40 && addr <= 0xff4b) {
          this.ppu.writeByte(addr, value);
          return;
        }
        if (this.cgb) {
          if (addr === 0xff4f) {
            this.ppu.writeByte(addr, value);
            return;
          }
          if (addr >= 0xff68 && addr <= 0xff6c) {
            this.ppu.writeByte(addr, value);
            return;
          }
        }
    }
  }

  // ─── CGB HDMA ─────────────────────────────────────────────────────────────

  /**
   * Kick off an HDMA transfer.
   *  - Bit 7 = 0 → General-Purpose: entire block copied instantly.
   *  - Bit 7 = 1 → H-Blank: 16 bytes copied at each HBlank entry.
   * Writing with bit 7 = 0 while an H-Blank transfer is active cancels it.
   */
  private triggerHdma(value: number): void {
    const hblankMode = (value & 0x80) !== 0;

    if (this.hdmaActive && !hblankMode) {
      // Cancel an in-progress H-Blank transfer.
      this.hdmaActive = false;
      this.hdmaCtrl = 0x80 | ((this.hdmaBlocks - 1) & 0x7f);
      return;
    }

    const src = ((this.hdmaSrcHi << 8) | this.hdmaSrcLo) & 0xfff0;
    const dst = 0x8000 | (this.hdmaDstHi << 8) | this.hdmaDstLo;
    const blocks = (value & 0x7f) + 1;

    if (hblankMode) {
      this.hdmaSrcCur = src;
      this.hdmaDstCur = dst;
      this.hdmaBlocks = blocks;
      this.hdmaActive = true;
      this.hdmaCtrl = value & 0x7f; // bit 7 = 0 means "transfer active"
    } else {
      for (let i = 0; i < blocks * 16; i++) {
        this.writeByte(dst + i, this.readByte(src + i));
      }
      this.hdmaCtrl = 0xff;
      this.advanceHdmaRegisters(blocks * 16);
    }
  }

  /** Real CGB hardware updates HDMA1-4 to point past the last byte
   *  transferred when a transfer completes (and after each block in
   *  H-Blank mode). Games like X-Men Mutant Academy rely on the auto-
   *  advance to stream sequential blocks by re-triggering GP-DMA with
   *  only the source updated — without it, every block clobbers the
   *  same 16 destination bytes and the rest of the tile data never
   *  reaches VRAM. */
  private advanceHdmaRegisters(byteCount: number): void {
    const newSrc = ((this.hdmaSrcHi << 8) | this.hdmaSrcLo) + byteCount;
    const newDst = (((this.hdmaDstHi << 8) | this.hdmaDstLo) + byteCount) & 0x1ff0;
    this.hdmaSrcHi = (newSrc >> 8) & 0xff;
    this.hdmaSrcLo = newSrc & 0xf0;
    this.hdmaDstHi = (newDst >> 8) & 0x1f;
    this.hdmaDstLo = newDst & 0xf0;
  }

  /** Called by PPU on each H-Blank entry; transfers one 16-byte block. */
  hdmaHBlankStep(): void {
    if (!this.hdmaActive) return;
    for (let i = 0; i < 16; i++) {
      this.writeByte(this.hdmaDstCur + i, this.readByte(this.hdmaSrcCur + i));
    }
    this.hdmaSrcCur = (this.hdmaSrcCur + 16) & 0xffff;
    this.hdmaDstCur = (this.hdmaDstCur + 16) & 0xffff;
    this.hdmaBlocks--;
    this.advanceHdmaRegisters(16);
    if (this.hdmaBlocks === 0) {
      this.hdmaActive = false;
      this.hdmaCtrl = 0xff;
    } else {
      this.hdmaCtrl = (this.hdmaBlocks - 1) & 0x7f;
    }
  }

  // ─── OAM DMA ──────────────────────────────────────────────────────────────

  /**
   * Begin an OAM DMA. On real hardware the transfer takes 160 M-cycles:
   * one byte of OAM is copied per M-cycle and the CPU's bus is restricted
   * to HRAM (plus the IE register) for the duration. We buffer the source
   * address here and run one byte per `tickDma()` call from the frame
   * pacer, returning 0xFF from `readByte` outside HRAM while active.
   */
  private dmaTransfer(value: number): void {
    // Values > 0xDF would read from OAM / unmapped space; real hardware
    // clamps, but most emulators just copy whatever the CPU asked for.
    this.dmaSrcBase = (value & 0xff) * 0x100;
    this.dmaIndex = 0;
    this.dmaActive = true;
    this.dmaStartDelay = 2;
  }

  /** Advance the OAM DMA by `mCycles` M-cycles. Called once per CPU bus
   *  access / internal cycle from the CPU itself. */
  tickDma(mCycles: number): void {
    if (!this.dmaActive) return;
    for (let i = 0; i < mCycles && this.dmaActive; i++) {
      if (this.dmaStartDelay > 0) {
        this.dmaStartDelay--;
        continue;
      }
      const byte = this.readDmaSource(this.dmaSrcBase + this.dmaIndex);
      this.ppu.writeOam(this.dmaIndex, byte);
      this.dmaIndex++;
      if (this.dmaIndex >= 0xa0) this.dmaActive = false;
    }
  }

  /**
   * Internal source-read for DMA. Unlike the CPU's view of the bus (which
   * we restrict to HRAM while DMA is active), the DMA engine itself can
   * read anywhere in the normal address space. Route it through the
   * underlying readers directly so we don't bounce off our own
   * bus-restriction logic.
   */
  private readDmaSource(addr: number): number {
    return this.readMemoryPage(addr & 0xffff) ?? 0xff;
  }
}
