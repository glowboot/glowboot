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

  /** Scratch buffer for scanline sprite selection (reused each line). The
   *  10-entry budget matches real hardware's mode-2 OAM-search cap. The
   *  Pixel-FIFO renderer pre-collects + sorts these at mode-3 start, then
   *  resolves the winning sprite at each pixel during the BG-FIFO pop. */
  private readonly visibleSprites = new Uint8Array(10);
  private visibleSpriteCount = 0;
  /** `visibleSprites` indices sorted by screen X (then OAM index for ties) —
   *  walk order for the sprite-fetcher state machine. `visibleSprites`
   *  itself stays in priority order for `resolveSpritePixel`. */
  private readonly spriteFetchOrder = new Uint8Array(10);
  /** Per-visible-sprite latch of LCDC.1 (OBJ enable) sampled the dot the
   *  sprite-fetcher kicks in. -1 = not yet reached, 0 = was off, 1 = was
   *  on. Indexed by `visibleSprites` position so `resolveSpritePixel` can
   *  cheaply filter. Mealybug `m3_lcdc_obj_en_change` toggles LCDC.1
   *  mid-mode-3 and the test catches per-sprite differences. */
  private readonly spriteObjEnabled = new Int8Array(10);
  /** Index into `spriteFetchOrder` of the next sprite waiting for fetch.
   *  When BG fetcher's pixel-X reaches that sprite's screen X, the fetcher
   *  state machine inserts a stall (see `mode3SpriteStallDots`). */
  private mode3NextSpriteIdx = 0;
  /** Dots remaining in the current sprite-fetcher stall. While > 0 the BG
   *  fetcher is paused; tickDots keeps consuming dots so register writes
   *  during the stall still take effect at the correct timing. */
  private mode3SpriteStallDots = 0;

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
   * Mode-3 (drawing) length for the just-completed scanline, recorded at
   * mode 3 → mode 0 transition by reading the actual dot count consumed by
   * the FIFO pump. The HBlank handler subtracts this from the 376-dot
   * post-OAM budget so each scanline still totals 456 dots.
   */
  private mode3Length = DOTS_DRAW;

  /** Set when pixel 159 hits the framebuffer; consumed by 1 dot of mode 3
   *  hold before sprite-stall / HBlank. The pump itself only takes 171
   *  dots end-to-end for an SCX=0 line; real hardware spends one more dot
   *  before the mode 0 transition (Pan Docs: "172 dots minimum"). */
  private lineHoldPending = false;
  /** Set when the BG fetcher is reset for window mid-line. Consumed as
   *  one dot of post-activation stall so the natural 5-dot fetcher restart
   *  becomes the documented 6-dot window stretch. */
  private windowStallPending = false;

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

  /** LY value used for the LYC=LY comparison in STAT bit 2. Tracks `ly`
   *  for almost the entire frame, but lags during the line-153 quirk:
   *  visible LY changes from 153 → 0 at dot 4, while LYC compare
   *  continues to use 153 for an additional 8 dots (until dot 12).
   *  GBMicrotest `line_153_lyc*_stat_timing` and Mooneye `ly_lyc_*`
   *  detect this lag. */
  private lyForCompare = 0;

  // ── BG Pixel-FIFO state (Phase 3) ───────────────────────────────────────
  /** BG fetcher sub-step (0 = Get Tile, 1 = Get Lo, 2 = Get Hi, 3 = Push).
   *  Each step takes 2 dots; we advance state on every other dot. */
  private fetchStep = 0;
  /** 0 → first dot of the current step, 1 → second dot (do the work then). */
  private fetchPhase = 0;
  /** Tile column index within the BG/window tilemap for the next fetch. */
  private fetchTileX = 0;
  /** Latched tile number from step 0. */
  private fetchTileNum = 0;
  /** CGB BG attribute byte (bank 1 of tilemap); 0 on DMG. */
  private fetchAttr = 0;
  /** Tile data low / high bytes from steps 1 and 2. */
  private fetchTileLo = 0;
  private fetchTileHi = 0;
  /** True once the window has activated for the current scanline; the
   *  fetcher then sources from the window map and `winLY`. */
  private fetchInWindow = false;
  /** Set at the start of mode 3 so the very first BG fetch is "discarded"
   *  — the FIFO push is dropped and the fetcher starts a second cycle.
   *  This matches real hardware's 12-dot pre-pixel warmup (= two 6-dot
   *  fetcher cycles) before pixel 1 emerges; without it our pump finishes
   *  the line 6 dots early. */
  private firstTileDiscard = true;
  /** BG FIFO — 8-entry circular buffer. Each entry packs:
   *    bits 0-1: color index (0..3)
   *    bits 2-4: CGB BG palette (0..7), 0 on DMG
   *    bit 5:    CGB BG-over-OBJ priority bit, 0 on DMG */
  private readonly bgFifo = new Uint8Array(8);
  private bgFifoHead = 0;
  private bgFifoCount = 0;
  /** Next pixel to push (0..160). At 160, the fetcher idles until mode 3
   *  ends. Sprites (Phase 4 will integrate) still draw atomically post-line. */
  private currentPx = 0;
  /** Fine-X discard counter at the start of mode 3 (= SCX & 7). Pixels
   *  popped while this is > 0 get thrown out without advancing currentPx. */
  private discardLeft = 0;
  /** Set to true once sprites have been overlaid for the current scanline.
   *  We trigger sprite render the moment the fetcher reaches `currentPx
   *  === 160` so a `runFrame()` ending mid-mode-3 still leaves a fully
   *  rendered scanline behind. Without this gate the mode-3-end fallback
   *  in `advanceDots` would overlay sprites a second time. */
  private lineSpritesDrawn = false;
  /** Scratch row for BG pixels during mode 3. We commit to `fb32`
   *  atomically when the line completes (currentPx === 160) so a partial
   *  mode-3 at end of `runFrame()` doesn't leave half-rendered scanlines
   *  visible. Per-pixel changes (BGP, palettes, attributes) still take
   *  effect because each pixel is computed via the fetcher with current
   *  register state at fetch time. */
  private readonly scratchRow = new Uint32Array(SCREEN_WIDTH);

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

    if (!preBoot && cgb) {
      // The CGB boot ROM hands the PPU off mid-VBlank (LY ≈ 0x90), not at the
      // top of frame 0. Some CGB carts read VRAM the instant they start with
      // the LCD on and rely on it being accessible — e.g. Trouballs' CGB
      // VRAM-bank self-test locks the console up if that read lands in mode 3.
      // Land partway into line 144 (matching where the boot ROM hands off) so
      // the next 143→144 transition — and `onVBlank` — fires mid runFrame
      // rather than exactly on the frame boundary. The DMG boot ROM is shorter
      // and its DMG carts boot fine from the default top-of-frame state, so
      // this is gated to CGB only (LY=0x90 there regressed a few DMG titles).
      this.ly = 0x90;
      this.lyForCompare = 0x90;
      this.mode = Mode.VBlank;
      this.dots = 412;
    }

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
        // LYC compare uses `lyForCompare`, which lags `ly` during the line
        // 153 quirk so STAT bit 2 doesn't briefly latch true between dots
        // 4–11 of line 153 with LYC=0.
        return 0x80 | (this.stat & 0x78) | (this.lyForCompare === this.lyc ? 0x04 : 0) | this.mode;
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
          //
          // NOTE: this offset is calibrated for the CPU's 3-dots-before /
          // 1-dot-after bus-access split. If the bus-access timing changes
          // (e.g. moving to a 0+4 "pending cycles" model), this offset may
          // need to change too — verified empirically against `oam_bug
          // lcd_sync`, `hblank_int_scxN`, and Mealybug references.
          this.ly = 0;
          this.lyForCompare = 0;
          this.winLY = 0;
          this.dots = 4;
          this.mode = Mode.OAMSearch;
          this.line153Quirk = false;
          this.statLine = false;
          this.updateStatLine();
        } else if (wasOn && !willBeOn) {
          // LCD turning off: PPU halts. Clear counters so the resume state
          // is well-defined. line153Quirk MUST clear too — a cart that
          // disables the LCD mid-line-153 (e.g. Qix Adventure between VRAM
          // updates) would otherwise resume with the quirk stuck set,
          // making the next VBlank entry bail early so LY never wraps and
          // the VBlank IRQ never fires.
          this.ly = 0;
          this.lyForCompare = 0;
          this.winLY = 0;
          this.dots = 0;
          this.mode = Mode.HBlank;
          this.line153Quirk = false;
          this.statLine = false;
        }
        break;
      }
      case ADDR_STAT: {
        // DMG STAT-write bug: on monochrome hardware (and on CGB running
        // a DMG cart in compat mode) writing any value to STAT latches
        // 0xFF for ~1 M-cycle before the real value. It fires only when
        // ((mode is HBlank or VBlank) AND LCD is on), or when LY == LYC.
        // Mode 2 / mode 3 alone must NOT trigger it — otherwise mid-
        // scanline STAT-writes produce spurious OAM-IRQs that crash
        // games like Pinball Deluxe. Required by Ocean engine titles
        // (Addams Family, Road Rash): their in-game STAT handler is
        // what restores the BG / OBJ palettes after the title screen.
        // (updateStatLine suppresses the IRQ while the LCD is off.)
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
   * Per-sprite mode-3 stall: `11 - min(5, (X + SCX) & 7)` dots applied at
   * the moment the BG fetcher's pixel-X reaches each sprite's screen X.
   * 11 dots when tile-aligned, down to 6 when the sprite starts ≥5 pixels
   * into a tile. Inserted inline by the dot-loop in `Mode.Drawing` (see
   * `mode3NextSpriteIdx` / `mode3SpriteStallDots`), so writes that land
   * during a stall observe the correct mid-line dot for subsequent fetches.
   */
  private spriteStallDotsFor(oamIdx: number): number {
    const x = this.oam[oamIdx * 4 + 1]!;
    return 11 - Math.min(5, (x + this.scx) & 7);
  }

  /** Build `spriteFetchOrder` as `visibleSprites` indices sorted by screen
   *  X (lowest first, OAM-index for ties). Walked left-to-right by the
   *  fetcher state machine. */
  private buildSpriteFetchOrder(): void {
    const oam = this.oam;
    const sprites = this.visibleSprites;
    const order = this.spriteFetchOrder;
    for (let i = 0; i < this.visibleSpriteCount; i++) order[i] = i;
    // Insertion sort — N ≤ 10 so the overhead is in the noise.
    for (let i = 1; i < this.visibleSpriteCount; i++) {
      const cur = order[i]!;
      const curX = oam[sprites[cur]! * 4 + 1]!;
      let j = i - 1;
      while (j >= 0) {
        const prev = order[j]!;
        const prevX = oam[sprites[prev]! * 4 + 1]!;
        if (prevX < curX || (prevX === curX && sprites[prev]! < sprites[cur]!)) break;
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = cur;
    }
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

  /**
   * Advance PPU by `mCycles` M-cycles (1 M-cycle = 4 dots). Thin wrapper
   * around `tickDots` — kept for callers that still think in M-cycles.
   */
  tick(mCycles: number): void {
    this.tickDots(mCycles * 4);
  }

  /**
   * Advance PPU by `dots` dots directly. Used by the CPU's per-bus-access
   * tick path so register writes (BGP / SCX / LCDC / …) take effect at
   * the M-cycle of the write rather than at the end of the writing
   * instruction. The internal loop drains the dot budget across mode
   * boundaries.
   */
  tickDots(dots: number): void {
    if (!(this.lcdc & 0x80)) return; // LCD off
    let remaining = dots;
    while (remaining > 0) {
      remaining -= this.advanceDots(remaining);
    }
  }

  /**
   * Consume up to `maxDots` dots in the current mode. Returns the number
   * actually consumed. The caller (`tick`) loops until the budget is empty.
   */
  private advanceDots(maxDots: number): number {
    switch (this.mode) {
      case Mode.OAMSearch: {
        const consume = Math.min(maxDots, DOTS_OAM - this.dots);
        this.dots += consume;
        if (this.dots >= DOTS_OAM) {
          this.dots = 0;
          if (this.cgbGame) {
            // Freeze the palette state the upcoming mode-3 render will see.
            this.cgbBgPalettesActive.set(this.cgbBgPalettes);
            this.cgbObPalettesActive.set(this.cgbObPalettes);
          }
          this.resetBgFetcher();
          this.setMode(Mode.Drawing);
        }
        return consume;
      }

      case Mode.Drawing: {
        // Mode 3 ends when the BG FIFO has emitted all 160 pixels and any
        // pending sprite fetch has completed. Base length 172 dots
        // (12-dot warmup + 160 emits), plus (SCX & 7) fine-X discards in
        // the pump, plus 6 dots on window restart, plus
        // `11 - min(5, (x+SCX) & 7)` per visible sprite — applied inline
        // at the BG-pixel-X reaches sprite-X dot. Inline stalls (rather
        // than a post-pump pad) let register writes during the stall
        // observe the right dot for subsequent sprite/BG fetches, which
        // is what Mealybug `m3_lcdc_*` and the GBMicrotest hblank_scx
        // cluster catch.
        let consumed = 0;
        const oam = this.oam;
        const sprites = this.visibleSprites;
        const order = this.spriteFetchOrder;
        while (consumed < maxDots) {
          if (this.windowStallPending) {
            // 1-dot stall after window activation so the fetcher restart
            // contributes the documented 6-dot mode-3 stretch (rather than
            // the 5-dot natural-cycle delay our pump alone produces).
            this.windowStallPending = false;
            this.dots++;
            consumed++;
          } else if (this.mode3SpriteStallDots > 0) {
            // Sprite-fetcher stall — BG paused, sprite tile is being
            // fetched. One dot per loop so LCDC.1 / register writes
            // landing mid-stall update for the next sprite correctly.
            this.mode3SpriteStallDots--;
            this.dots++;
            consumed++;
          } else if (this.currentPx < SCREEN_WIDTH) {
            // Check whether the next pending sprite has been reached.
            // Sprites at sprX < 0 (off-screen left) fire during warmup
            // so they're processed at any dot. Sprites at sprX >= 0 wait
            // until the (SCX & 7) fine-X discard has completed — real HW
            // kicks the fetcher in when the BG fetcher's emit-X reaches
            // the sprite's screen X, which is offset by `discardLeft`
            // dots from our `currentPx` counter (currentPx only advances
            // after discards finish).
            const nextIdx = this.mode3NextSpriteIdx;
            if (nextIdx < this.visibleSpriteCount) {
              const visIdx = order[nextIdx]!;
              const oamIdx = sprites[visIdx]!;
              const sprX = oam[oamIdx * 4 + 1]! - 8;
              const reachable = sprX < 0 ? this.bgFifoCount > 0 : this.discardLeft === 0 && sprX <= this.currentPx;
              if (reachable) {
                // Latch LCDC.1 at fetcher kick-in dot. If OBJ is off,
                // the sprite still consumes its stall (real HW behavior)
                // but won't appear in `resolveSpritePixel`.
                this.spriteObjEnabled[visIdx] = (this.lcdc & 0x02) !== 0 ? 1 : 0;
                this.mode3SpriteStallDots = this.spriteStallDotsFor(oamIdx);
                this.mode3NextSpriteIdx++;
                // Re-loop without consuming a dot so the stall starts on
                // this iteration. mode3SpriteStallDots branch above will
                // tick the first stall dot next.
                continue;
              }
            }
            this.advanceBgFetcher();
            this.tryPushBgPixel();
            this.dots++;
            consumed++;
          } else if (this.lineHoldPending) {
            // 1-dot hold between pixel 159 hitting the framebuffer and
            // mode 0 transition. Matches Pan Docs' "172 dot minimum".
            this.lineHoldPending = false;
            this.dots++;
            consumed++;
          } else {
            this.mode3Length = this.dots;
            this.dots = 0;
            // Safety: if a host config aborted the pump mid-line, commit
            // whatever the scratch row holds. Normally lineSpritesDrawn
            // is already true via the in-pump line-complete path.
            if (this.ly < SCREEN_HEIGHT && !this.lineSpritesDrawn) {
              this.lineSpritesDrawn = true;
              if (this.fetchInWindow) this.winLY++;
              this.fb32.set(this.scratchRow, this.ly * SCREEN_WIDTH);
            }
            this.setMode(Mode.HBlank);
            this.onHBlank?.();
            break;
          }
        }
        return consumed;
      }

      case Mode.HBlank: {
        // HBlank consumes whatever's left of the 376-dot mode 3 + mode 0
        // budget after a variable-length mode 3 — total scanline still 456.
        const hblankLen = DOTS_PER_LINE - DOTS_OAM - this.mode3Length;
        const consume = Math.min(maxDots, hblankLen - this.dots);
        this.dots += consume;
        if (this.dots >= hblankLen) {
          this.dots = 0;
          this.ly++;
          this.lyForCompare = this.ly;
          this.checkLyc();
          if (this.ly === LINES_VISIBLE) {
            this.setMode(Mode.VBlank);
            this.interrupts.request(INTERRUPT_VBLANK);
            this.onVBlank?.();
          } else {
            this.setMode(Mode.OAMSearch);
          }
        }
        return consume;
      }

      case Mode.VBlank: {
        // Line 153 LY quirk: 4 dots after entering line 153 the LY register
        // wraps to 0 while mode stays at VBlank, and LY=0 holds through the
        // remaining ~452 dots until line 0 / mode 2 begins. Mooneye / GBM
        // `line_153_*` and `poweron_stat_*` verify this.
        //
        // Sub-quirk: the LYC=LY compare lags the visible LY change by 8
        // more dots (until dot 12), so STAT bit 2 doesn't briefly latch
        // true with LYC=0 between dots 4–11. `lyForCompare` keeps the
        // pre-change value (153) until dot 12 and is then reconciled
        // with `ly` (= 0).
        if (this.ly === 153 && !this.line153Quirk && this.dots < 4) {
          const consume = Math.min(maxDots, 4 - this.dots);
          this.dots += consume;
          if (this.dots >= 4) {
            this.ly = 0;
            this.line153Quirk = true;
            // Don't update lyForCompare here — it stays at 153 for ~8
            // more dots so STAT bit 2 keeps comparing against 153 until
            // dot 12 of line 153.
          }
          return consume;
        }
        if (this.line153Quirk && this.lyForCompare === 153 && this.dots < 6) {
          const consume = Math.min(maxDots, 6 - this.dots);
          this.dots += consume;
          if (this.dots >= 6) {
            this.lyForCompare = 0;
            this.checkLyc();
          }
          return consume;
        }
        const consume = Math.min(maxDots, DOTS_PER_LINE - this.dots);
        this.dots += consume;
        if (this.dots >= DOTS_PER_LINE) {
          this.dots = 0;
          if (this.line153Quirk) {
            this.line153Quirk = false;
            this.winLY = 0; // Reset window line counter for new frame
            this.setMode(Mode.OAMSearch);
          } else {
            this.ly++;
            this.lyForCompare = this.ly;
            this.checkLyc();
            if (this.ly >= TOTAL_LINES) {
              this.ly = 0;
              this.lyForCompare = 0;
              this.winLY = 0;
              this.checkLyc();
              this.setMode(Mode.OAMSearch);
            }
          }
        }
        return consume;
      }
    }
  }

  // ─── BG Pixel-FIFO ───────────────────────────────────────────────────────

  /** Reset the BG fetcher + FIFO at the start of mode 3. The fetcher will
   *  pull from the BG tilemap (or the window tilemap once `fetchInWindow`
   *  flips), filling the 8-px FIFO. Pixels are popped one per dot in
   *  `tryPushBgPixel`; the first `(SCX & 7)` pops are discarded as the
   *  fine-X scroll. */
  private resetBgFetcher(): void {
    this.fetchStep = 0;
    this.fetchPhase = 0;
    this.fetchTileX = 0;
    this.fetchTileNum = 0;
    this.fetchAttr = 0;
    this.fetchTileLo = 0;
    this.fetchTileHi = 0;
    this.fetchInWindow = false;
    this.firstTileDiscard = true;
    this.bgFifoHead = 0;
    this.bgFifoCount = 0;
    this.currentPx = 0;
    this.discardLeft = this.scx & 7;
    this.lineSpritesDrawn = false;
    this.lineHoldPending = false;
    this.windowStallPending = false;
    this.mode3NextSpriteIdx = 0;
    this.mode3SpriteStallDots = 0;
    this.spriteObjEnabled.fill(-1);
    this.collectVisibleSprites();
    this.buildSpriteFetchOrder();
  }

  /** Pre-collect the (up to 10) sprites that intersect the current scanline
   *  and sort them by priority. The sort order depends on the host:
   *    - DMG: lowest X first; OAM index breaks ties (lowest first wins).
   *    - CGB OPRI=0: OAM order (default — lowest OAM index wins).
   *    - CGB OPRI=1: same as DMG (lowest X first, lowest OAM tiebreaker).
   *  The pixel-FIFO mixer iterates this list in order and takes the first
   *  non-transparent pixel at each X. */
  private collectVisibleSprites(): void {
    // OAM scan runs regardless of LCDC.1 on real HW — the bit only gates
    // whether each sprite ultimately renders. The per-sprite-fetcher
    // state machine latches LCDC.1 at sprite kick-in (see the Drawing
    // case of `advanceDots`), and `resolveSpritePixel` skips sprites
    // whose latch is 0.
    const tallSprites = (this.lcdc & 0x04) !== 0;
    const spriteHeight = tallSprites ? 16 : 8;
    const oam = this.oam;
    let count = 0;
    for (let i = 0; i < 40 && count < 10; i++) {
      const sprY = oam[i * 4]! - 16;
      if (this.ly >= sprY && this.ly < sprY + spriteHeight) this.visibleSprites[count++] = i;
    }
    this.visibleSpriteCount = count;
    if (!this.cgbGame || this.opri & 1) {
      this.visibleSprites.subarray(0, count).sort((a, b) => {
        const xa = oam[a * 4 + 1]!,
          xb = oam[b * 4 + 1]!;
        return xa !== xb ? xa - xb : a - b;
      });
    }
  }

  /** Resolve the winning sprite pixel for `screenX` (or 0 = transparent if
   *  no sprite covers that column). Stores the result in three out fields
   *  (`outSprColor`, `outSprPalette`, `outSprPriority`) to avoid object
   *  allocation in the hot pixel-emit loop. */
  private outSprColor = 0;
  private outSprPalette = 0;
  private outSprPriority = 0;
  private resolveSpritePixel(screenX: number): void {
    this.outSprColor = 0;
    if (this.visibleSpriteCount === 0) return;
    const oam = this.oam;
    const tallSprites = (this.lcdc & 0x04) !== 0;
    const spriteHeight = tallSprites ? 16 : 8;
    for (let i = 0; i < this.visibleSpriteCount; i++) {
      if (this.spriteObjEnabled[i] !== 1) continue;
      const idx = this.visibleSprites[i]!;
      const sprX = oam[idx * 4 + 1]! - 8;
      if (screenX < sprX || screenX >= sprX + 8) continue;
      const sprY = oam[idx * 4]! - 16;
      const tileNum = oam[idx * 4 + 2]! & (tallSprites ? 0xfe : 0xff);
      const attrs = oam[idx * 4 + 3]!;
      const flipX = (attrs & 0x20) !== 0;
      const flipY = (attrs & 0x40) !== 0;
      let fineX = screenX - sprX;
      if (flipX) fineX = 7 - fineX;
      let fineY = this.ly - sprY;
      if (flipY) fineY = spriteHeight - 1 - fineY;
      const bankOffset = this.cgb && (attrs & 0x08) !== 0 ? 0x2000 : 0;
      const lo = this.vram[bankOffset + tileNum * 16 + fineY * 2]!;
      const hi = this.vram[bankOffset + tileNum * 16 + fineY * 2 + 1]!;
      const bit = 7 - fineX;
      const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      if (colorIdx === 0) continue; // transparent — try the next sprite
      this.outSprColor = colorIdx;
      this.outSprPalette = this.cgbGame ? attrs & 0x07 : (attrs & 0x10) !== 0 ? 1 : 0;
      this.outSprPriority = (attrs & 0x80) !== 0 ? 1 : 0;
      return;
    }
  }

  /** Advance the BG fetcher one dot. Each step (Get Tile / Get Lo / Get Hi
   *  / Push) takes 2 dots — `fetchPhase` tracks the half-step. Step 3
   *  (Push) only succeeds when the FIFO is empty; otherwise it stalls and
   *  retries on the next dot. */
  private advanceBgFetcher(): void {
    if (this.fetchPhase === 0) {
      this.fetchPhase = 1;
      return;
    }
    this.fetchPhase = 0;

    switch (this.fetchStep) {
      case 0: {
        // Get Tile — read tilemap entry (and CGB attribute byte from bank 1).
        const useWindow = this.fetchInWindow;
        const tileX = useWindow ? this.fetchTileX & 0x1f : ((this.scx >> 3) + this.fetchTileX) & 0x1f;
        const tileY = useWindow ? (this.winLY >> 3) & 0x1f : (((this.ly + this.scy) & 0xff) >> 3) & 0x1f;
        const mapBase = useWindow
          ? (this.lcdc & 0x40) !== 0
            ? 0x1c00
            : 0x1800
          : (this.lcdc & 0x08) !== 0
            ? 0x1c00
            : 0x1800;
        const mapAddr = mapBase + tileY * 32 + tileX;
        this.fetchTileNum = this.vram[mapAddr]!;
        this.fetchAttr = this.cgb ? this.vram[0x2000 + mapAddr]! : 0;
        this.fetchStep = 1;
        return;
      }
      case 1: {
        this.fetchTileLo = this.readBgTileByte(0);
        this.fetchStep = 2;
        return;
      }
      case 2: {
        this.fetchTileHi = this.readBgTileByte(1);
        this.fetchStep = 3;
        // Pan Docs: the auto-push at end of step 2 lands here. If the FIFO
        // happens to be empty already, the push goes straight in.
        this.tryPushFetcherToFifo();
        return;
      }
      case 3: {
        this.tryPushFetcherToFifo();
        return;
      }
    }
  }

  /** Read one of the two tile-data bytes for the currently-latched BG tile,
   *  honouring LCDC.4 (signed/unsigned addressing) and the CGB attribute
   *  bits for VRAM bank (0x08) and Y-flip (0x40). */
  private readBgTileByte(offset: 0 | 1): number {
    const useWindow = this.fetchInWindow;
    const fineY = useWindow ? this.winLY & 7 : (this.ly + this.scy) & 7;
    const flipY = (this.fetchAttr & 0x40) !== 0;
    const effFineY = flipY ? 7 - fineY : fineY;
    const tileNum = this.fetchTileNum;
    const tileBase = (this.lcdc & 0x10) !== 0 ? tileNum * 16 : 0x1000 + ((tileNum << 24) >> 24) * 16;
    const bankOffset = (this.fetchAttr & 0x08) !== 0 ? 0x2000 : 0;
    return this.vram[bankOffset + tileBase + effFineY * 2 + offset]!;
  }

  /** Push 8 fetched pixels into the BG FIFO if it's empty. Each FIFO entry
   *  packs the 2-bit color index plus CGB BG palette index (3 bits) and
   *  BG-over-OBJ priority bit, so the popper can apply the right palette
   *  and resolve sprite priority without re-reading the attribute byte. */
  private tryPushFetcherToFifo(): void {
    if (this.bgFifoCount > 0) return;
    if (this.firstTileDiscard) {
      // Drop the first fetch — its tile data lands "in the air" on real
      // hardware. Re-arm the fetcher at step 0 so the next 6 dots produce
      // the line's actual first tile. fetchTileX stays at 0 so we re-read
      // the same map entry for the real fetch.
      this.firstTileDiscard = false;
      this.fetchStep = 0;
      return;
    }
    const flipX = (this.fetchAttr & 0x20) !== 0;
    const palAttr = ((this.fetchAttr & 0x07) << 2) | (((this.fetchAttr >> 7) & 1) << 5);
    const lo = this.fetchTileLo;
    const hi = this.fetchTileHi;
    const fifo = this.bgFifo;
    for (let i = 0; i < 8; i++) {
      const bit = flipX ? i : 7 - i;
      const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      fifo[i] = colorIdx | palAttr;
    }
    this.bgFifoHead = 0;
    this.bgFifoCount = 8;
    this.fetchTileX = (this.fetchTileX + 1) & 0x1f;
    this.fetchStep = 0;
  }

  /** Pop one pixel from the BG FIFO and either discard (fine-X scroll) or
   *  emit it to the framebuffer. Also detects window activation: when the
   *  pushed-pixel X reaches `WX - 7`, the BG FIFO is cleared and the
   *  fetcher restarts in window mode for the rest of the line. */
  private tryPushBgPixel(): void {
    if (this.currentPx >= SCREEN_WIDTH || this.bgFifoCount === 0) return;

    // Drain the SCX fine-X discard before any window check — those pops
    // happen during the (SCX & 7) "warmup" before the LCD is at screen
    // X=0, so the WX comparison hasn't started yet.
    if (this.discardLeft > 0) {
      this.bgFifoHead = (this.bgFifoHead + 1) & 7;
      this.bgFifoCount--;
      this.discardLeft--;
      return;
    }

    // Pre-pop window activation: real hardware checks `screen X == WX - 7`
    // every dot, and on a match the BG fetcher resets to window mode
    // BEFORE the next pixel pops — so pixel `WX - 7` is the first window
    // pixel (no BG pixel emitted at that column). For WX < 7 we discard
    // `(7 - wx)` window pixels so the first visible pixel lands on
    // window-tile-0 fineX `(7 - wx)`, matching pre-FIFO's
    // `srcXInit = bgEndX - winStartX` calculation. We gate this check on
    // the FIFO already having data + SCX discard finished, so it fires
    // at the same moment a real LCD's X counter would actually be at
    // (currentPx) — not during the warmup, where the LCD's X counter is
    // still negative.
    if (
      !this.fetchInWindow &&
      (this.lcdc & 0x20) !== 0 &&
      this.wy <= this.ly &&
      this.wx <= 166 &&
      this.currentPx + 7 >= this.wx
    ) {
      this.fetchInWindow = true;
      this.fetchTileX = 0;
      this.bgFifoHead = 0;
      this.bgFifoCount = 0;
      this.fetchStep = 0;
      this.fetchPhase = 0;
      return;
    }

    const entry = this.bgFifo[this.bgFifoHead]!;
    this.bgFifoHead = (this.bgFifoHead + 1) & 7;
    this.bgFifoCount--;

    const bgColorIdx = entry & 0x03;
    const bgPalIdx = (entry >> 2) & 0x07;
    const bgPriBit = (entry >> 5) & 1;

    // Effective BG color index for sprite-priority decisions. DMG with
    // LCDC.0 cleared forces BG to color 0 so sprites always win.
    const effectiveBg = !this.cgbGame && !(this.lcdc & 0x01) ? 0 : bgColorIdx;

    // Resolve the winning sprite pixel for this column (if any).
    // LCDC.1 (OBJ enable) gate is per-sprite, latched at the
    // fetcher kick-in dot (see Drawing case in `advanceDots`).
    this.resolveSpritePixel(this.currentPx);

    // Decide if the sprite is on top. CGB has a master-priority gate via
    // LCDC.0; if cleared, sprites always win. Otherwise BG wins when its
    // color is non-zero AND (sprite's OAM priority OR BG-attr priority)
    // is set. DMG just looks at the sprite's OAM priority bit.
    let useSprite = false;
    if (this.outSprColor !== 0) {
      if (this.cgbGame) {
        if (!(this.lcdc & 0x01)) useSprite = true;
        else if (effectiveBg === 0) useSprite = true;
        else if (this.outSprPriority || bgPriBit) useSprite = false;
        else useSprite = true;
      } else {
        if (effectiveBg === 0) useSprite = true;
        else useSprite = !this.outSprPriority;
      }
    }

    let rgba: number;
    if (useSprite) {
      rgba = this.cgbGame
        ? this.cgbObPalettesActive[this.outSprPalette * 4 + this.outSprColor]!
        : (this.outSprPalette === 1 ? this.obp1Palette : this.obp0Palette)[this.outSprColor]!;
    } else if (this.cgbGame) {
      rgba = this.cgbBgPalettesActive[bgPalIdx * 4 + bgColorIdx]!;
    } else {
      rgba = (this.lcdc & 0x01) !== 0 ? this.bgPalette[bgColorIdx]! : this.bgPalette[0]!;
    }

    this.scratchRow[this.currentPx] = rgba;
    this.currentPx++;

    // Line complete — commit BG scratch row to fb. Sprites are already
    // mixed in per-pixel above, so no separate sprite-overlay pass.
    if (this.currentPx === SCREEN_WIDTH && !this.lineSpritesDrawn && this.ly < SCREEN_HEIGHT) {
      this.lineSpritesDrawn = true;
      if (this.fetchInWindow) this.winLY++;
      this.fb32.set(this.scratchRow, this.ly * SCREEN_WIDTH);
      this.lineHoldPending = true;
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
    // The PPU drives the STAT interrupt line only while it is running; with
    // the LCD off there is no line, so no STAT IRQ can be raised. A DMG cart
    // that disables the LCD and then enables the LYC source while LY and LYC
    // are both 0 (e.g. InfoGenius Berlitz clears STAT, then sets STAT bit 6,
    // right after a VBlank-synced LCD-off) would otherwise get a phantom
    // STAT IRQ that wedges its handler on a never-satisfied mode-wait.
    if ((this.lcdc & 0x80) === 0) {
      this.statLine = false;
      return;
    }
    const bitHBlank = (this.stat & 0x08) !== 0 && this.mode === Mode.HBlank;
    const bitVBlank = (this.stat & 0x10) !== 0 && this.mode === Mode.VBlank;
    const bitOAM = (this.stat & 0x20) !== 0 && this.mode === Mode.OAMSearch;
    const bitLYC = (this.stat & 0x40) !== 0 && this.lyForCompare === this.lyc;
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
    w.u16(this.lyForCompare);
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
    this.lyForCompare = r.u16();
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
