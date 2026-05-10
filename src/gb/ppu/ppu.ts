import { INTERRUPT_LCD, INTERRUPT_VBLANK, type InterruptController } from "../memory/interrupts.js";
import type { StateReader, StateWriter } from "../serialization/serialization.js";

/** Screen dimensions */
export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;

/**
 * PPU modes — each scanline cycles through OAM Search → Drawing → HBlank.
 * VBlank covers lines 144–153.
 */
const enum Mode {
  HBlank = 0,
  VBlank = 1,
  OAMSearch = 2,
  Drawing = 3
}

/** Dots (clock cycles) per scanline phase. */
const DOTS_OAM = 80;
const DOTS_DRAW = 172; // minimum; stretches for scrolling/sprites
const DOTS_HBLANK = 204; // padded to reach 456 per line
const DOTS_PER_LINE = DOTS_OAM + DOTS_DRAW + DOTS_HBLANK; // 456

const LINES_VISIBLE = 144;
const LINES_VBLANK = 10; // lines 144–153
const TOTAL_LINES = LINES_VISIBLE + LINES_VBLANK; // 154

// I/O register addresses
const ADDR_LCDC = 0xff40;
const ADDR_STAT = 0xff41;
const ADDR_SCY = 0xff42;
const ADDR_SCX = 0xff43;
const ADDR_LY = 0xff44;
const ADDR_LYC = 0xff45;
const ADDR_BGP = 0xff47;
const ADDR_OBP0 = 0xff48;
const ADDR_OBP1 = 0xff49;
const ADDR_WY = 0xff4a;
const ADDR_WX = 0xff4b;
// CGB-only
const ADDR_VBK = 0xff4f;
const ADDR_BCPS = 0xff68;
const ADDR_BCPD = 0xff69;
const ADDR_OCPS = 0xff6a;
const ADDR_OCPD = 0xff6b;
const ADDR_OPRI = 0xff6c;

/**
 * Pixel Processing Unit.
 *
 * Call `tick(cycles)` every CPU M-cycle to advance the PPU.
 * Read the completed frame from `framebuffer` after each VBlank interrupt.
 */
export class PPU {
  /** RGBA8888 framebuffer — 160 × 144 × 4 bytes. */
  readonly framebuffer: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  /**
   * Little-endian u32 view over `framebuffer` so each pixel is a single store.
   * Assumes LE host (every modern browser target). Palette entries are
   * pre-byte-swapped to match this layout.
   */
  private readonly fb32 = new Uint32Array(
    this.framebuffer.buffer,
    this.framebuffer.byteOffset,
    SCREEN_WIDTH * SCREEN_HEIGHT
  );

  /** VRAM: 1 bank on DMG, 2 banks on CGB (selected via VBK / 0xFF4F). */
  private readonly vram: Uint8Array;
  private vramBank = 0;
  private readonly oam = new Uint8Array(0x00a0);

  /**
   * Per-scanline background colour-index buffer (0-3).
   * Populated by renderBackground() and read by renderSprites() to implement
   * BG-over-sprite priority (OAM attribute bit 7).
   */
  private readonly bgColorBuf = new Uint8Array(SCREEN_WIDTH);

  /** CGB BG-priority flag per pixel (0 or 1) — BG-attr bit 7. */
  private readonly bgPriBuf = new Uint8Array(SCREEN_WIDTH);

  /** Scratch buffer for scanline sprite selection (reused each line). */
  private readonly visibleSprites = new Uint8Array(10);

  // LCD control & status. Post-boot defaults reflect the state the
  // boot ROM leaves behind (LCD on, BGP=$FC, sprites visible). When a
  // real boot ROM is loaded the constructor zeros lcdc/bgp ahead of
  // boot-ROM execution so the boot ROM itself drives them up.
  private lcdc: number;
  private stat = 0x00;
  private scy = 0x00;
  private scx = 0x00;
  private ly = 0x00;
  private lyc = 0x00;
  private bgp: number;
  private obp0 = 0xff;
  private obp1 = 0xff;
  private wy = 0x00;
  private wx = 0x00;

  private mode = Mode.OAMSearch;
  private dots = 0;

  /**
   * Mode-3 (drawing) length for the current scanline, recomputed at every
   * mode 2 → mode 3 transition. Real hardware extends mode 3 by `(SCX & 7)`
   * for fine X scroll, +6 dots when the window is enabled and active, and
   * 6–11 dots per visible sprite (formula per Pan Docs *Rendering*). With
   * a fixed 172 dots, our HBlank window was correspondingly longer than
   * real hardware's, so games that stream BCPD per HBlank fit more writes
   * per scanline than they would on hardware — the auto-increment counter
   * runs ahead and the streamed palette content desyncs frame after frame.
   * Visible as the photo-title corruption in Crawfish Interactive titles.
   */
  private mode3Length = DOTS_DRAW;

  /**
   * Window internal line counter. Increments each scanline where the window
   * enable condition is met (LCDC bit 5 set AND WY ≤ LY), regardless of WX.
   * Resets to 0 at the start of each new frame.
   */
  private winLY = 0;

  /** True while we're past the 4-dot mark of line 153 (LY hidden as 0).
   *  Drives the early line-153 → line-0 transition and prevents the
   *  visible-LY check in the VBlank case from re-applying the quirk. */
  private line153Quirk = false;

  /**
   * Fired once per frame the instant the PPU enters VBlank. Cheaper than
   * having the host poll `readByte(0xff44)` from the main loop.
   */
  onVBlank: (() => void) | null = null;

  /**
   * Fired each time the PPU enters H-Blank on a visible line. Used by MMU
   * to drive CGB H-Blank-timed HDMA (one 16-byte block per HBlank).
   */
  onHBlank: (() => void) | null = null;

  /**
   * CGB OPRI (0xFF6C) bit 0:
   *   0 = OAM index order (CGB default)
   *   1 = X-coordinate ordering (DMG-style, used for DMG-in-CGB mode)
   */
  private opri = 0;

  /**
   * DMG-mode palette LUTs in LE u32 form for direct framebuffer writes.
   * Regenerated only when BGP/OBP0/OBP1 are written.
   */
  private readonly bgPalette = new Uint32Array(4);
  private readonly obp0Palette = new Uint32Array(4);
  private readonly obp1Palette = new Uint32Array(4);

  /**
   * Per-instance base-shade tables for the DMG render path. Default to the
   * familiar green shades; a host running a DMG cart on a CGB console can
   * overwrite them via `setDmgCompatPalette()` to emulate the boot ROM's
   * title-hash-based colourisation.
   */
  private readonly bgShades: Uint32Array;
  private readonly obp0Shades: Uint32Array;
  private readonly obp1Shades: Uint32Array;

  /** Default DMG greens, encoded as 0xAABBGGRR for LE framebuffer writes. */
  private static readonly DEFAULT_SHADES = [0xffd0f8e0, 0xff70c088, 0xff566834, 0xff201808] as const;

  /**
   * Optional LCD colour-curve emulation for CGB output. Raw RGB555 → RGB888
   * is technically accurate as a register transform but far from what CGB
   * games were designed to look like — the actual CGB LCD muted and warmed
   * the primaries, so games look neon / oversaturated without correction.
   * When enabled, CGB palette LUT entries are routed through a CGB LCD
   * correction matrix at build time (no per-pixel cost). The DMG render
   * path keeps its hand-curated shade tables untouched.
   */
  private _colorCorrection = false;
  /** Write-only externally — host wiring drives the toggle through the
   *  setter; the render path reads the private field directly. */
  set colorCorrection(enabled: boolean) {
    if (this._colorCorrection === enabled) return;
    this._colorCorrection = enabled;
    if (this.cgb) {
      for (let i = 0; i < 32; i++) this.refreshCgbPaletteEntry(this.cgbBgPalettes, this.bgPalRam, i);
      for (let i = 0; i < 32; i++) this.refreshCgbPaletteEntry(this.cgbObPalettes, this.obPalRam, i);
      this.cgbBgPalettesActive.set(this.cgbBgPalettes);
      this.cgbObPalettesActive.set(this.cgbObPalettes);
    }
  }

  // ── CGB palette state ────────────────────────────────────────────────────
  /** BG palette RAM: 8 palettes × 4 colors × 2 bytes = 64 bytes. */
  private readonly bgPalRam = new Uint8Array(64);
  /** OBJ palette RAM: 8 palettes × 4 colors × 2 bytes = 64 bytes. */
  private readonly obPalRam = new Uint8Array(64);
  /** Decoded BG palettes (32 colors), updated immediately on every BCPD write. */
  private readonly cgbBgPalettes = new Uint32Array(32);
  /** Decoded OBJ palettes (32 colors), updated immediately on every OCPD write. */
  private readonly cgbObPalettes = new Uint32Array(32);
  /**
   * Snapshot of `cgbBgPalettes` / `cgbObPalettes` taken at mode-3 entry,
   * used by the renderer instead of the live LUTs. On real CGB hardware,
   * BCPD/OCPD writes during mode 3 are blocked (palette RAM is being read
   * by the LCD), so the palette in effect for a scanline is whatever was
   * written *before* mode 3 started. Reading the live LUT at mode-3 exit
   * (our previous behaviour) accidentally let mode-3 writes leak into the
   * current scanline's render — visible as photo-title corruption in
   * games like THPS2/3 and Razor that stream palettes per HBlank.
   */
  private readonly cgbBgPalettesActive = new Uint32Array(32);
  private readonly cgbObPalettesActive = new Uint32Array(32);

  /** Debug-only read of a VRAM byte in a specific bank, without
   *  toggling VBK (so the running game's bank selection stays
   *  untouched). Bank 0 is DMG / CGB base tiles + maps; bank 1 is
   *  CGB-only (extra tiles + BG-map attributes). Returns 0xFF when
   *  bank 1 is requested on a DMG console. */
  peekVram(bank: 0 | 1, offset: number): number {
    if (bank === 1 && !this.cgb) return 0xff;
    return this.vram[bank * 0x2000 + (offset & 0x1fff)]!;
  }

  /** Live 40-entry OAM buffer, read-only from outside. Exposed for
   *  the debugger's sprite list view. */
  get debugOam(): Uint8Array {
    return this.oam;
  }

  /** Debug-only view of the raw palette buffers. Returns live refs —
   *  the consumer must not mutate them. Used by the debugger pane to
   *  render swatches; not for gameplay code. */
  get debugPalettes(): {
    bgPalRam: Uint8Array;
    obPalRam: Uint8Array;
    cgbBg: Uint32Array;
    cgbOb: Uint32Array;
    dmgBg: Uint32Array;
    dmgObp0: Uint32Array;
    dmgObp1: Uint32Array;
  } {
    return {
      bgPalRam: this.bgPalRam,
      obPalRam: this.obPalRam,
      cgbBg: this.cgbBgPalettes,
      cgbOb: this.cgbObPalettes,
      dmgBg: this.bgPalette,
      dmgObp0: this.obp0Palette,
      dmgObp1: this.obp1Palette
    };
  }

  /** BCPS/BGPI: low 6 bits = index, bit 7 = auto-increment. */
  private bgpi = 0;
  /** OCPS/OBPI: low 6 bits = index, bit 7 = auto-increment. */
  private obpi = 0;

  constructor(
    private readonly interrupts: InterruptController,
    /** CGB console features available (VRAM/WRAM banking, palette RAM, HDMA). */
    readonly cgb: boolean = false,
    /** CGB-enhanced cartridge — selects the CGB render path over the DMG one. */
    readonly cgbGame: boolean = cgb,
    /** Boot ROM about to run — zero registers the boot ROM is responsible for. */
    preBoot = false
  ) {
    this.lcdc = preBoot ? 0x00 : 0x91;
    this.bgp = preBoot ? 0x00 : 0xfc;
    this.vram = new Uint8Array(cgb ? 0x4000 : 0x2000);

    // Instance shade tables seed from the default green table. `setDmgCompatPalette`
    // can replace them when a DMG cart is booted on a CGB console.
    this.bgShades = new Uint32Array(PPU.DEFAULT_SHADES);
    this.obp0Shades = new Uint32Array(PPU.DEFAULT_SHADES);
    this.obp1Shades = new Uint32Array(PPU.DEFAULT_SHADES);

    this.refreshPalette(this.bgPalette, this.bgShades, this.bgp);
    this.refreshPalette(this.obp0Palette, this.obp0Shades, this.obp0);
    this.refreshPalette(this.obp1Palette, this.obp1Shades, this.obp1);

    if (cgb) {
      // Power-on CGB palettes are undefined; fill with white so an un-initialised
      // game doesn't show as all-black.
      this.bgPalRam.fill(0xff);
      this.obPalRam.fill(0xff);
      for (let i = 0; i < 32; i++) {
        this.refreshCgbPaletteEntry(this.cgbBgPalettes, this.bgPalRam, i);
        this.refreshCgbPaletteEntry(this.cgbObPalettes, this.obPalRam, i);
      }
    }
  }

  /**
   * Override the base shade tables used by the DMG render path. The three
   * 4-entry arrays must hold LE-u32 RGBA values matching the framebuffer
   * format (same encoding as `DEFAULT_SHADES`). Intended for the host to
   * apply a CGB boot-ROM-style compatibility palette when a DMG cart is
   * booted on a CGB console.
   */
  setDmgCompatPalette(bg: ArrayLike<number>, obp0: ArrayLike<number>, obp1: ArrayLike<number>): void {
    this.bgShades.set(bg);
    this.obp0Shades.set(obp0);
    this.obp1Shades.set(obp1);
    this.refreshPalette(this.bgPalette, this.bgShades, this.bgp);
    this.refreshPalette(this.obp0Palette, this.obp0Shades, this.obp0);
    this.refreshPalette(this.obp1Palette, this.obp1Shades, this.obp1);
  }

  // ─── Bus interface ────────────────────────────────────────────────────────

  /** True when CPU bus access to VRAM should return 0xFF / drop writes:
   *  during mode 3 (Drawing), and only while the LCD is on. Internal PPU
   *  rendering reads `this.vram[…]` directly and bypasses this gate. */
  private vramLocked(): boolean {
    return this.mode === Mode.Drawing && (this.lcdc & 0x80) !== 0;
  }

  /** True when CPU bus access to OAM should return 0xFF / drop writes:
   *  during mode 2 (OAM Search) and mode 3 (Drawing), and only while the
   *  LCD is on. OAM-DMA's lock is handled separately in MMU. */
  private oamLocked(): boolean {
    if (!(this.lcdc & 0x80)) return false;
    return this.mode === Mode.OAMSearch || this.mode === Mode.Drawing;
  }

  readVram(offset: number): number {
    if (this.vramLocked()) return 0xff;
    return this.vram[this.vramBank * 0x2000 + (offset & 0x1fff)]!;
  }
  writeVram(offset: number, v: number): void {
    if (this.vramLocked()) return;
    this.vram[this.vramBank * 0x2000 + (offset & 0x1fff)] = v;
  }

  readOam(offset: number): number {
    if (this.oamLocked()) return 0xff;
    return this.oam[offset]!;
  }
  writeOam(offset: number, v: number): void {
    if (this.oamLocked()) return;
    this.oam[offset] = v;
  }
  /** OAM-DMA bypasses the CPU bus and owns the OAM port directly, so its
   *  writes go through even when the PPU is in mode 2 / 3. MMU's
   *  `tickDma` is the only caller; CPU-side writes use `writeOam`. */
  writeOamFromDma(offset: number, v: number): void {
    this.oam[offset] = v;
  }

  readByte(addr: number): number {
    switch (addr) {
      case ADDR_LCDC:
        return this.lcdc;
      case ADDR_STAT:
        // LCD off: PPU halted, mode reads 0, coincidence is not computed (or
        // would spuriously latch true when LY and LYC both happen to be 0,
        // trapping any wait-for-mode<2 loop a game uses to gate palette writes).
        if (!(this.lcdc & 0x80)) return 0x80 | (this.stat & 0x78);
        return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 0x04 : 0) | this.mode;
      case ADDR_SCY:
        return this.scy;
      case ADDR_SCX:
        return this.scx;
      case ADDR_LY:
        return this.lcdc & 0x80 ? this.ly : 0;
      case ADDR_LYC:
        return this.lyc;
      case ADDR_BGP:
        return this.bgp;
      case ADDR_OBP0:
        return this.obp0;
      case ADDR_OBP1:
        return this.obp1;
      case ADDR_WY:
        return this.wy;
      case ADDR_WX:
        return this.wx;
      // ── CGB-only ───────────────────────────────────────────────────────
      case ADDR_VBK:
        return this.cgb ? 0xfe | this.vramBank : 0xff;
      case ADDR_BCPS:
        return this.cgb ? this.bgpi | 0x40 : 0xff;
      case ADDR_BCPD:
        return this.cgb ? this.bgPalRam[this.bgpi & 0x3f]! : 0xff;
      case ADDR_OCPS:
        return this.cgb ? this.obpi | 0x40 : 0xff;
      case ADDR_OCPD:
        return this.cgb ? this.obPalRam[this.obpi & 0x3f]! : 0xff;
      case ADDR_OPRI:
        return this.cgb ? 0xfe | this.opri : 0xff;
      default:
        return 0xff;
    }
  }

  writeByte(addr: number, v: number): void {
    switch (addr) {
      case ADDR_LCDC: {
        const wasOn = (this.lcdc & 0x80) !== 0;
        const willBeOn = (v & 0x80) !== 0;
        this.lcdc = v;
        if (!wasOn && willBeOn) {
          // LCD turning on: resynchronize to the start of the first visible
          // scanline. The first scanline is effectively 4 T-cycles shorter
          // than normal (hence the initial `dots=4`), which matches the
          // oam_bug lcd_sync test's LY→1 transition at M-cycle 113.
          this.ly = 0;
          this.winLY = 0;
          this.dots = 4;
          this.mode = Mode.OAMSearch;
          this.statLine = false;
          this.updateStatLine();
        } else if (wasOn && !willBeOn) {
          // LCD turning off: PPU halts. Clear counters so the resume state
          // is well-defined.
          this.ly = 0;
          this.winLY = 0;
          this.dots = 0;
          this.mode = Mode.HBlank;
          this.statLine = false;
        }
        break;
      }
      case ADDR_STAT: {
        // DMG STAT-write bug: on monochrome hardware (and on CGB running
        // a DMG cart in compat mode) writing any value to STAT latches
        // 0xFF for ~1 M-cycle before the real value. Pan Docs / devrs
        // FAQ specifies it fires only when ((mode is HBlank or VBlank)
        // AND LCD is on), OR when LY == LYC (any mode, even LCD off).
        // Mode 2 / mode 3 alone must NOT trigger it — otherwise mid-
        // scanline STAT-writes produce spurious OAM-IRQs that crash
        // games like Pinball Deluxe. Required by Ocean engine titles
        // (Addams Family, Road Rash): their in-game STAT handler is
        // what restores the BG / OBJ palettes after the title screen.
        if (!this.cgbGame) {
          const modeEligible = (this.mode === Mode.HBlank || this.mode === Mode.VBlank) && (this.lcdc & 0x80) !== 0;
          const lycEligible = this.ly === this.lyc;
          if (modeEligible || lycEligible) {
            const saved = this.stat;
            this.stat = 0x78 | (saved & 0x07);
            this.updateStatLine();
            this.stat = saved;
          }
        }
        this.stat = (v & 0x78) | (this.stat & 0x07);
        this.updateStatLine();
        break;
      }
      case ADDR_SCY:
        this.scy = v;
        break;
      case ADDR_SCX:
        this.scx = v;
        break;
      case ADDR_LY:
        break; // read-only
      case ADDR_LYC:
        this.lyc = v;
        this.checkLyc();
        break;
      case ADDR_BGP:
        this.bgp = v;
        this.refreshPalette(this.bgPalette, this.bgShades, v);
        break;
      case ADDR_OBP0:
        this.obp0 = v;
        this.refreshPalette(this.obp0Palette, this.obp0Shades, v);
        break;
      case ADDR_OBP1:
        this.obp1 = v;
        this.refreshPalette(this.obp1Palette, this.obp1Shades, v);
        break;
      case ADDR_WY:
        this.wy = v;
        break;
      case ADDR_WX:
        this.wx = v;
        break;
      // ── CGB-only ───────────────────────────────────────────────────────
      case ADDR_VBK:
        if (this.cgb) this.vramBank = v & 1;
        break;
      case ADDR_BCPS:
        if (this.cgb) this.bgpi = v & 0xbf;
        break;
      case ADDR_BCPD:
        if (this.cgb) this.writeCgbPalette(this.bgPalRam, this.cgbBgPalettes, v, true);
        break;
      case ADDR_OCPS:
        if (this.cgb) this.obpi = v & 0xbf;
        break;
      case ADDR_OCPD:
        if (this.cgb) this.writeCgbPalette(this.obPalRam, this.cgbObPalettes, v, false);
        break;
      case ADDR_OPRI:
        if (this.cgb) this.opri = v & 1;
        break;
    }
  }

  private writeCgbPalette(ram: Uint8Array, lut: Uint32Array, v: number, isBg: boolean): void {
    const idxReg = isBg ? this.bgpi : this.obpi;
    const index = idxReg & 0x3f;
    // Pan Docs Palettes: "Setting [auto-increment] will increment the
    // Address field after writing to BCPD, even during Mode 3 despite the
    // write itself failing." Real hardware blocks the data write during
    // mode 3 (palette RAM is being read by the LCD) but still advances
    // the index. Without this rule, when our mode-3 boundary is shorter
    // than real hardware's, writes that real hw silently dropped instead
    // land in palette RAM here — desyncing the streamed content for the
    // rest of the frame.
    if (this.mode !== Mode.Drawing) {
      ram[index] = v;
      this.refreshCgbPaletteEntry(lut, ram, index >> 1);
    }
    if (idxReg & 0x80) {
      const next = 0x80 | ((index + 1) & 0x3f);
      if (isBg) this.bgpi = next;
      else this.obpi = next;
    }
  }

  /**
   * Mode-3 length for the upcoming scanline. Base 172 dots, plus:
   *  - `(SCX & 7)` fine-X scroll penalty
   *  - +6 dots when the window is enabled and active for this line
   *  - per visible sprite: `11 - min(5, (X + SCX) & 7)` (only when LCDC.1
   *    enables sprites; disabled sprites contribute no penalty per Pan
   *    Docs, which mirrors what real hardware does with the OBJ-fetch
   *    pipeline gated off)
   */
  private computeMode3Length(): void {
    let length = DOTS_DRAW + (this.scx & 7);
    if ((this.lcdc & 0x20) !== 0 && this.wy <= this.ly) {
      length += 6;
    }
    if ((this.lcdc & 0x02) !== 0) {
      const spriteHeight = (this.lcdc & 0x04) !== 0 ? 16 : 8;
      let count = 0;
      for (let i = 0; i < 40 && count < 10; i++) {
        const sprY = this.oam[i * 4]! - 16;
        if (this.ly >= sprY && this.ly < sprY + spriteHeight) {
          const x = this.oam[i * 4 + 1]!;
          length += 11 - Math.min(5, (x + this.scx) & 7);
          count++;
        }
      }
    }
    this.mode3Length = length;
  }

  private refreshCgbPaletteEntry(lut: Uint32Array, ram: Uint8Array, colorIdx: number): void {
    const lo = ram[colorIdx * 2]!;
    const hi = ram[colorIdx * 2 + 1]!;
    const word = lo | (hi << 8);
    const r = word & 0x1f;
    const g = (word >> 5) & 0x1f;
    const b = (word >> 10) & 0x1f;
    // 5→8 bit expansion: (x << 3) | (x >> 2) gives a smooth 0..255 range.
    let R = (r << 3) | (r >> 2);
    let G = (g << 3) | (g >> 2);
    let B = (b << 3) | (b >> 2);
    if (this._colorCorrection) {
      // CGB LCD response matrix. Blends a fraction of each channel into the
      // others to reproduce the warm, muted response of the real CGB display —
      // removes the over-bright "neon" look of raw RGB555 on an sRGB monitor
      // while preserving saturation well enough that games still look vivid.
      // Weights sum to 32 per output channel.
      const Rc = (R * 26 + G * 4 + B * 2) >> 5;
      const Gc = (G * 24 + B * 8) >> 5;
      const Bc = (R * 6 + G * 4 + B * 22) >> 5;
      R = Rc;
      G = Gc;
      B = Bc;
    }
    // LE u32 layout: 0xAABBGGRR so fb32 writes produce RGBA bytes in memory.
    lut[colorIdx] = 0xff000000 | (B << 16) | (G << 8) | R;
  }

  // ─── Timing ───────────────────────────────────────────────────────────────

  /** Advance PPU by `mCycles` M-cycles (1 M-cycle = 4 dots). */
  tick(mCycles: number): void {
    if (!(this.lcdc & 0x80)) return; // LCD off

    this.dots += mCycles * 4;

    switch (this.mode) {
      case Mode.OAMSearch:
        if (this.dots >= DOTS_OAM) {
          this.dots -= DOTS_OAM;
          this.computeMode3Length();
          if (this.cgbGame) {
            // Freeze the palette state the upcoming mode-3 render will see.
            this.cgbBgPalettesActive.set(this.cgbBgPalettes);
            this.cgbObPalettesActive.set(this.cgbObPalettes);
          }
          this.setMode(Mode.Drawing);
        }
        break;

      case Mode.Drawing:
        if (this.dots >= this.mode3Length) {
          this.dots -= this.mode3Length;
          this.renderLine();
          this.setMode(Mode.HBlank);
          this.onHBlank?.();
        }
        break;

      case Mode.HBlank: {
        // HBlank consumes whatever's left of the 376-dot mode 3 + mode 0
        // budget after a variable-length mode 3 — total scanline still 456.
        const hblankLen = DOTS_PER_LINE - DOTS_OAM - this.mode3Length;
        if (this.dots >= hblankLen) {
          this.dots -= hblankLen;
          this.ly++;
          this.checkLyc();
          if (this.ly === LINES_VISIBLE) {
            this.setMode(Mode.VBlank);
            this.interrupts.request(INTERRUPT_VBLANK);
            this.onVBlank?.();
          } else {
            this.setMode(Mode.OAMSearch);
          }
        }
        break;
      }

      case Mode.VBlank:
        // Line 153 LY quirk: 4 dots after entering line 153 the LY register
        // wraps to 0 while mode stays at VBlank, and LY=0 holds through the
        // remaining ~452 dots until line 0 / mode 2 begins. Mooneye / GBM
        // `line_153_*` and `poweron_stat_*` verify this. Without the quirk,
        // games / boot ROMs that wait on a specific (LY, mode) pair miss
        // the LY=0 phase and stall.
        if (this.ly === 153 && !this.line153Quirk && this.dots >= 4) {
          this.ly = 0;
          this.line153Quirk = true;
          this.checkLyc();
        }
        if (this.dots >= DOTS_PER_LINE) {
          this.dots -= DOTS_PER_LINE;
          if (this.line153Quirk) {
            this.line153Quirk = false;
            this.winLY = 0; // Reset window line counter for new frame
            this.setMode(Mode.OAMSearch);
          } else {
            this.ly++;
            this.checkLyc();
            // Defensive: if a tick batch was big enough to skip the LY=0
            // window entirely, fall through to the same wrap-to-line-0.
            if (this.ly >= TOTAL_LINES) {
              this.ly = 0;
              this.winLY = 0;
              this.checkLyc();
              this.setMode(Mode.OAMSearch);
            }
          }
        }
        break;
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private renderLine(): void {
    if (this.ly >= SCREEN_HEIGHT) return;
    const winRendered = this.cgbGame ? this.renderBackgroundCgb() : this.renderBackground();
    if (this.cgbGame) this.renderSpritesCgb();
    else this.renderSprites();
    // winLY increments only when at least one window pixel was actually drawn
    // this scanline (WX in range 0..166, LCDC bit 5 set, WY ≤ LY).
    if (winRendered) this.winLY++;
  }

  /**
   * Renders background and window for the current scanline.
   * Returns true if any window pixel was drawn (so winLY should increment).
   *
   * Tile data (lo/hi) is fetched once per 8-pixel tile span rather than once
   * per pixel; unless fine-X scroll splits the span, one tile = two VRAM reads.
   */
  private renderBackground(): boolean {
    const bgEnabled = (this.lcdc & 0x01) !== 0;
    // On DMG, LCDC bit 0 disables both BG and Window ("Window Display Bit has no effect").
    const winEnabled = bgEnabled && (this.lcdc & 0x20) !== 0 && this.wy <= this.ly;
    const palette = this.bgPalette;
    const fbBase = this.ly * SCREEN_WIDTH;
    const { vram, fb32, bgColorBuf } = this;

    if (!bgEnabled) {
      // DMG LCDC.0 clear: BG + window off, fill with color 0 and leave bg
      // colour buffer at 0 so sprites always win the priority check.
      const color = palette[0]!;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        bgColorBuf[x] = 0;
        fb32[fbBase + x] = color;
      }
      return false;
    }

    const bgMap = (this.lcdc & 0x08) !== 0 ? 0x1c00 : 0x1800;
    const winMap = (this.lcdc & 0x40) !== 0 ? 0x1c00 : 0x1800;
    const signed = (this.lcdc & 0x10) === 0;
    const winStartX = this.wx - 7;
    const bgEndX = winEnabled ? Math.max(0, Math.min(winStartX, SCREEN_WIDTH)) : SCREEN_WIDTH;

    // Shared tile-span blitter for both the BG and the Window — identical
    // logic except for the tile-map base, the source Y/X, the target screen
    // range, and whether the source X wraps at 256 (BG wraps, Window
    // doesn't). Mirrors the `drawSpan` closure in `renderBackgroundCgb`.
    const drawSpan = (
      mapBase: number,
      srcY: number,
      srcXInit: number,
      xStart: number,
      xEnd: number,
      wrap: boolean
    ): void => {
      const tileRow = (srcY >> 3) & 0x1f;
      const fineY2 = (srcY & 7) * 2;
      let srcX = srcXInit;
      let x = xStart;
      while (x < xEnd) {
        const tileCol = (srcX >> 3) & 0x1f;
        const tileIndex = vram[mapBase + tileRow * 32 + tileCol]!;
        const tileAddr = signed ? 0x1000 + ((tileIndex << 24) >> 24) * 16 : tileIndex * 16;
        const lo = vram[tileAddr + fineY2]!;
        const hi = vram[tileAddr + fineY2 + 1]!;
        const fineXStart = srcX & 7;
        const count = Math.min(8 - fineXStart, xEnd - x);
        for (let k = 0; k < count; k++) {
          const bit = 7 - (fineXStart + k);
          const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          bgColorBuf[x + k] = colorIdx;
          fb32[fbBase + x + k] = palette[colorIdx]!;
        }
        x += count;
        srcX = wrap ? (srcX + count) & 0xff : srcX + count;
      }
    };

    drawSpan(bgMap, (this.ly + this.scy) & 0xff, this.scx & 0xff, 0, bgEndX, true);

    if (winEnabled && bgEndX < SCREEN_WIDTH) {
      drawSpan(winMap, this.winLY, bgEndX - winStartX, bgEndX, SCREEN_WIDTH, false);
      return true;
    }
    return false;
  }

  private renderSprites(): void {
    if (!(this.lcdc & 0x02)) return;

    const tallSprites = (this.lcdc & 0x04) !== 0;
    const spriteHeight = tallSprites ? 16 : 8;

    // Collect up to 10 sprites that intersect this scanline (in OAM order).
    const visible = this.visibleSprites;
    let count = 0;
    for (let i = 0; i < 40 && count < 10; i++) {
      const sprY = this.oam[i * 4]! - 16;
      if (this.ly >= sprY && this.ly < sprY + spriteHeight) visible[count++] = i;
    }

    // DMG priority: lower X wins; OAM index is tiebreaker (lower = higher priority).
    // Sort highest-X / highest-index first so the winner (lowest X / index) is painted last.
    const oam = this.oam;
    visible.subarray(0, count).sort((a, b) => {
      const xa = oam[a * 4 + 1]!;
      const xb = oam[b * 4 + 1]!;
      return xa !== xb ? xb - xa : b - a;
    });

    for (let vi = 0; vi < count; vi++) {
      const i = visible[vi]!;
      const sprY = this.oam[i * 4]! - 16;
      const sprX = this.oam[i * 4 + 1]! - 8;
      const tileNum = this.oam[i * 4 + 2]! & (tallSprites ? 0xfe : 0xff);
      const attrs = this.oam[i * 4 + 3]!;

      const palette = attrs & 0x10 ? this.obp1Palette : this.obp0Palette;
      const flipX = (attrs & 0x20) !== 0;
      const flipY = (attrs & 0x40) !== 0;
      const priority = (attrs & 0x80) !== 0;

      let fineY = this.ly - sprY;
      if (flipY) fineY = spriteHeight - 1 - fineY;

      const tileAddr = tileNum * 16 + fineY * 2;
      const lo = this.vram[tileAddr]!;
      const hi = this.vram[tileAddr + 1]!;

      for (let fx = 0; fx < 8; fx++) {
        const screenX = sprX + fx;
        if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;

        const bit = flipX ? fx : 7 - fx;
        const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (colorIdx === 0) continue; // transparent

        // BG-over-sprite priority: attr bit 7 set → sprite only shows over BG color 0.
        // When LCDC bit 0 is clear, BG/Window are disabled; sprites always win.
        if (priority && this.lcdc & 0x01 && this.bgColorBuf[screenX] !== 0) continue;

        this.setPixel(screenX, this.ly, palette[colorIdx]!);
      }
    }
  }

  // ─── CGB rendering ────────────────────────────────────────────────────────

  /**
   * CGB BG + window. Each tile index in VRAM bank 0 is paired with an
   * attribute byte at the same offset in VRAM bank 1:
   *   bit 0-2  BG palette (0-7)
   *   bit 3    tile VRAM bank (0 or 1)
   *   bit 5    H-flip
   *   bit 6    V-flip
   *   bit 7    BG-over-OBJ priority
   *
   * On CGB, LCDC.0 doesn't disable BG — it demotes BG+Window priority so OBJs
   * always appear on top. BG is always drawn; priority is consumed by
   * `renderSpritesCgb()` via `bgPriBuf`.
   */
  private renderBackgroundCgb(): boolean {
    const fbBase = this.ly * SCREEN_WIDTH;
    const { vram, fb32, bgColorBuf, bgPriBuf, cgbBgPalettesActive: cgbBgPalettes } = this;

    const winEnabled = (this.lcdc & 0x20) !== 0 && this.wy <= this.ly;
    const bgMap = (this.lcdc & 0x08) !== 0 ? 0x1c00 : 0x1800;
    const winMap = (this.lcdc & 0x40) !== 0 ? 0x1c00 : 0x1800;
    const signed = (this.lcdc & 0x10) === 0;
    const winStartX = this.wx - 7;
    const bgEndX = winEnabled ? Math.max(0, Math.min(winStartX, SCREEN_WIDTH)) : SCREEN_WIDTH;

    const drawSpan = (
      mapBase: number,
      srcY: number,
      srcXInit: number,
      xStart: number,
      xEnd: number,
      wrap: boolean
    ): void => {
      const tileRow = (srcY >> 3) & 0x1f;
      const mapRowOff = mapBase + tileRow * 32;
      const fineY = srcY & 7;

      let srcX = srcXInit;
      let x = xStart;
      while (x < xEnd) {
        const tileCol = (srcX >> 3) & 0x1f;
        const tileIndex = vram[mapRowOff + tileCol]!;
        const attrs = vram[0x2000 + mapRowOff + tileCol]!;
        const tileBank = (attrs >> 3) & 1;
        const flipX = (attrs & 0x20) !== 0;
        const flipY = (attrs & 0x40) !== 0;
        const priority = (attrs & 0x80) !== 0 ? 1 : 0;
        const palBase = (attrs & 0x07) * 4;

        const fy = flipY ? 7 - fineY : fineY;
        const tileBase = signed ? 0x1000 + ((tileIndex << 24) >> 24) * 16 : tileIndex * 16;
        const tileAddr = tileBank * 0x2000 + tileBase + fy * 2;
        const lo = vram[tileAddr]!;
        const hi = vram[tileAddr + 1]!;

        const fineXStart = srcX & 7;
        const count = Math.min(8 - fineXStart, xEnd - x);
        for (let k = 0; k < count; k++) {
          const bx = fineXStart + k;
          const bit = flipX ? bx : 7 - bx;
          const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          bgColorBuf[x + k] = colorIdx;
          bgPriBuf[x + k] = priority;
          fb32[fbBase + x + k] = cgbBgPalettes[palBase + colorIdx]!;
        }
        x += count;
        srcX = wrap ? (srcX + count) & 0xff : srcX + count;
      }
    };

    drawSpan(bgMap, (this.ly + this.scy) & 0xff, this.scx & 0xff, 0, bgEndX, true);

    if (winEnabled && bgEndX < SCREEN_WIDTH) {
      drawSpan(winMap, this.winLY, bgEndX - winStartX, bgEndX, SCREEN_WIDTH, false);
      return true;
    }
    return false;
  }

  /**
   * CGB sprites. Differences from DMG:
   *  - No X-based priority sort: first-in-OAM wins, so we iterate the 10
   *    selected sprites in reverse (last loses, so earlier overwrites later).
   *  - Attribute byte: palette in bits 0-2, VRAM bank in bit 3.
   *  - BG-over-OBJ priority is a three-way AND of LCDC.0 (master), OAM priority
   *    bit 7, and BG-attr priority bit 7 captured in bgPriBuf.
   */
  private renderSpritesCgb(): void {
    if (!(this.lcdc & 0x02)) return;

    const tallSprites = (this.lcdc & 0x04) !== 0;
    const spriteHeight = tallSprites ? 16 : 8;
    const bgMasterPri = (this.lcdc & 0x01) !== 0;

    const visible = this.visibleSprites;
    let count = 0;
    for (let i = 0; i < 40 && count < 10; i++) {
      const sprY = this.oam[i * 4]! - 16;
      if (this.ly >= sprY && this.ly < sprY + spriteHeight) visible[count++] = i;
    }

    // OPRI=1 selects DMG-style X-coord priority. Sort so the winner (lowest X
    // then lowest OAM index) is painted last.
    if (this.opri) {
      const oam = this.oam;
      visible.subarray(0, count).sort((a, b) => {
        const xa = oam[a * 4 + 1]!;
        const xb = oam[b * 4 + 1]!;
        return xa !== xb ? xb - xa : b - a;
      });
      // Paint front-to-back so the last (lowest-priority) ends up on bottom;
      // with the reverse sort above, iterating normally puts winners last.
      for (let vi = 0; vi < count; vi++) this.drawCgbSprite(visible[vi]!, tallSprites, spriteHeight, bgMasterPri);
      return;
    }

    // Paint back-to-front so the first OAM entry (highest priority) lands on top.
    for (let vi = count - 1; vi >= 0; vi--) {
      this.drawCgbSprite(visible[vi]!, tallSprites, spriteHeight, bgMasterPri);
    }
  }

  private drawCgbSprite(i: number, tallSprites: boolean, spriteHeight: number, bgMasterPri: boolean): void {
    const sprY = this.oam[i * 4]! - 16;
    const sprX = this.oam[i * 4 + 1]! - 8;
    const tileNum = this.oam[i * 4 + 2]! & (tallSprites ? 0xfe : 0xff);
    const attrs = this.oam[i * 4 + 3]!;

    const palBase = (attrs & 0x07) * 4;
    const tileBank = (attrs >> 3) & 1;
    const flipX = (attrs & 0x20) !== 0;
    const flipY = (attrs & 0x40) !== 0;
    const objPri = (attrs & 0x80) !== 0;

    let fineY = this.ly - sprY;
    if (flipY) fineY = spriteHeight - 1 - fineY;

    const tileAddr = tileBank * 0x2000 + tileNum * 16 + fineY * 2;
    const lo = this.vram[tileAddr]!;
    const hi = this.vram[tileAddr + 1]!;
    const fbRow = this.ly * SCREEN_WIDTH;

    for (let fx = 0; fx < 8; fx++) {
      const screenX = sprX + fx;
      if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;

      const bit = flipX ? fx : 7 - fx;
      const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      if (colorIdx === 0) continue; // transparent

      // CGB priority: if LCDC.0 is clear, sprites always win. Otherwise
      // BG wins if BG colour is non-zero AND (OAM priority OR BG-attr priority).
      if (bgMasterPri && this.bgColorBuf[screenX] !== 0 && (objPri || this.bgPriBuf[screenX] !== 0)) continue;

      this.fb32[fbRow + screenX] = this.cgbObPalettesActive[palBase + colorIdx]!;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * "STAT line" — the single wire on real hardware that ORs all the
   * enabled STAT interrupt sources (mode 0/1/2 + LYC compare). We only
   * request the IRQ on its rising edge, so repeated triggers from the
   * same (still-asserted) source don't fire again — matching the STAT
   * IRQ blocking quirk that a handful of demos and games rely on.
   */
  private statLine = false;

  private updateStatLine(): void {
    const bitHBlank = (this.stat & 0x08) !== 0 && this.mode === Mode.HBlank;
    const bitVBlank = (this.stat & 0x10) !== 0 && this.mode === Mode.VBlank;
    const bitOAM = (this.stat & 0x20) !== 0 && this.mode === Mode.OAMSearch;
    const bitLYC = (this.stat & 0x40) !== 0 && this.ly === this.lyc;
    const line = bitHBlank || bitVBlank || bitOAM || bitLYC;
    if (line && !this.statLine) this.interrupts.request(INTERRUPT_LCD);
    this.statLine = line;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.updateStatLine();
  }

  private checkLyc(): void {
    this.updateStatLine();
  }

  /** Rebuild a cached palette LUT from its register byte and shade table. */
  private refreshPalette(dst: Uint32Array, shades: Uint32Array, reg: number): void {
    dst[0] = shades[(reg >> 0) & 3]!;
    dst[1] = shades[(reg >> 2) & 3]!;
    dst[2] = shades[(reg >> 4) & 3]!;
    dst[3] = shades[(reg >> 6) & 3]!;
  }

  private setPixel(x: number, y: number, rgba: number): void {
    this.fb32[y * SCREEN_WIDTH + x] = rgba;
  }

  // ─── Save state ───────────────────────────────────────────────────────────

  serialize(w: StateWriter): void {
    w.bytes(this.vram);
    w.bytes(this.oam);
    w.u8(this.vramBank);
    w.u8(this.lcdc);
    w.u8(this.stat);
    w.u8(this.scy);
    w.u8(this.scx);
    w.u8(this.ly);
    w.u8(this.lyc);
    w.u8(this.bgp);
    w.u8(this.obp0);
    w.u8(this.obp1);
    w.u8(this.wy);
    w.u8(this.wx);
    w.u8(this.mode);
    w.i32(this.dots);
    w.u16(this.winLY);
    w.bool(this.line153Quirk);
    w.u16(this.mode3Length);
    w.u8(this.bgpi);
    w.u8(this.obpi);
    w.u8(this.opri);
    w.bytes(this.bgPalRam);
    w.bytes(this.obPalRam);
  }
  deserialize(r: StateReader): void {
    r.bytes(this.vram);
    r.bytes(this.oam);
    this.vramBank = r.u8();
    this.lcdc = r.u8();
    this.stat = r.u8();
    this.scy = r.u8();
    this.scx = r.u8();
    this.ly = r.u8();
    this.lyc = r.u8();
    this.bgp = r.u8();
    this.obp0 = r.u8();
    this.obp1 = r.u8();
    this.wy = r.u8();
    this.wx = r.u8();
    this.mode = r.u8() as Mode;
    this.dots = r.i32();
    this.winLY = r.u16();
    this.line153Quirk = r.bool();
    this.mode3Length = r.u16();
    this.bgpi = r.u8();
    this.obpi = r.u8();
    this.opri = r.u8();
    r.bytes(this.bgPalRam);
    r.bytes(this.obPalRam);

    // Rebuild the palette LUTs from restored register / RAM values.
    this.refreshPalette(this.bgPalette, this.bgShades, this.bgp);
    this.refreshPalette(this.obp0Palette, this.obp0Shades, this.obp0);
    this.refreshPalette(this.obp1Palette, this.obp1Shades, this.obp1);
    if (this.cgb) {
      for (let i = 0; i < 32; i++) {
        this.refreshCgbPaletteEntry(this.cgbBgPalettes, this.bgPalRam, i);
        this.refreshCgbPaletteEntry(this.cgbObPalettes, this.obPalRam, i);
      }
      this.cgbBgPalettesActive.set(this.cgbBgPalettes);
      this.cgbObPalettesActive.set(this.cgbObPalettes);
    }
  }
}
