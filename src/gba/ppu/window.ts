/**
 * GBA window-mask builder.
 *
 * The PPU has four windows that gate which layers are visible at each
 * pixel: WIN0, WIN1, OBJWIN, and "outside" (WINOUT). When any of them
 * is enabled (DISPCNT bits 13-15), every visible pixel falls into
 * exactly one window, decided in priority order:
 *
 *   WIN0  > WIN1  > OBJWIN  > outside
 *
 * The selected window's enable byte (low or high of WININ / WINOUT)
 * dictates which layers may draw at that pixel:
 *
 *   bit 0 = BG0      bit 3 = BG3       bit 5 = color effect
 *   bit 1 = BG1      bit 4 = OBJ
 *   bit 2 = BG2
 *
 * Window rectangle quirks (per GBATEK):
 *   - X1 / Y1 are inclusive lefts / tops.
 *   - X2 / Y2 are exclusive rights / bottoms.
 *   - Garbage rectangles where X2 > 240 OR X1 > X2 are normalised by
 *     clamping X2 to 240 (which means a wrapped X1 > X2 window extends
 *     from X1 to the right edge). Same rule applies on Y with 160.
 *   - X1 == X2 with X1 < 240 → the window is empty.
 *
 * OBJWIN — sprites with OAM attr-0 mode 2 carve out a region of the
 * screen that uses WINOUT's high byte as its enable mask. The PPU
 * renders these mode-2 sprites' tile-opaque pixels into a per-line
 * cover row (1 byte per pixel, 1 = covered) before calling into
 * `buildWindowMaskLine`, which consults the cover at OBJWIN-priority.
 */

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;

const DISPCNT_WIN0_ENABLE = 1 << 13;
const DISPCNT_WIN1_ENABLE = 1 << 14;
const DISPCNT_OBJWIN_ENABLE = 1 << 15;

/** Pre-decoded rectangle in screen space (after the GBATEK clamping
 *  rules) plus the enable byte selected when a pixel is inside. */
interface WindowRect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  enable: number;
}

/** True iff DISPCNT activates any windowing (WIN0 / WIN1 / OBJWIN).
 *  Callers can skip the mask build entirely when this is false — every
 *  layer is unmasked. */
export function windowsActive(dispcnt: number): boolean {
  return (dispcnt & (DISPCNT_WIN0_ENABLE | DISPCNT_WIN1_ENABLE | DISPCNT_OBJWIN_ENABLE)) !== 0;
}

/** Populate one row (`y`) of the window mask. `outRow` is a 240-byte
 *  view into the per-line mask scratch. `objWindowMaskRow`, if
 *  non-null, supplies the row's mode-2 sprite cover — pixels with
 *  `objWindowMaskRow[x] !== 0` fall into OBJWIN when neither WIN0 nor
 *  WIN1 claims them and DISPCNT bit 15 is set. */
export function buildWindowMaskLine(
  y: number,
  dispcnt: number,
  win0h: number,
  win1h: number,
  win0v: number,
  win1v: number,
  winin: number,
  winout: number,
  objWindowMaskRow: Uint8Array | null,
  outRow: Uint8Array
): void {
  const win0Enabled = (dispcnt & DISPCNT_WIN0_ENABLE) !== 0;
  const win1Enabled = (dispcnt & DISPCNT_WIN1_ENABLE) !== 0;
  const objWinEnabled = (dispcnt & DISPCNT_OBJWIN_ENABLE) !== 0 && objWindowMaskRow !== null;

  const win0: WindowRect | null = win0Enabled
    ? {
        ...decodeRect(win0h, win0v),
        enable: winin & 0x3f
      }
    : null;
  const win1: WindowRect | null = win1Enabled
    ? {
        ...decodeRect(win1h, win1v),
        enable: (winin >>> 8) & 0x3f
      }
    : null;

  // OBJWIN uses the WINOUT high byte; outside-of-any-window uses the
  // low byte.
  const objWinEnable = (winout >>> 8) & 0x3f;
  const outsideEnable = winout & 0x3f;

  const win0InRow = win0 !== null && y >= win0.y1 && y < win0.y2;
  const win1InRow = win1 !== null && y >= win1.y1 && y < win1.y2;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    let enable: number;
    if (win0InRow && x >= win0!.x1 && x < win0!.x2) {
      enable = win0!.enable;
    } else if (win1InRow && x >= win1!.x1 && x < win1!.x2) {
      enable = win1!.enable;
    } else if (objWinEnabled && objWindowMaskRow![x] !== 0) {
      enable = objWinEnable;
    } else {
      enable = outsideEnable;
    }
    outRow[x] = enable;
  }
}

/** Full-frame mask builder — loops over `buildWindowMaskLine` for
 *  every visible scanline. Used by tests; the PPU's per-scanline
 *  pipeline calls the per-line entry point directly into a 240-byte
 *  row scratch. */
export function buildWindowMask(
  dispcnt: number,
  win0h: number,
  win1h: number,
  win0v: number,
  win1v: number,
  winin: number,
  winout: number,
  objWindowMask: Uint8Array | null,
  out: Uint8Array
): void {
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    const rowBase = y * SCREEN_WIDTH;
    const outRow = out.subarray(rowBase, rowBase + SCREEN_WIDTH);
    const objWinRow = objWindowMask ? objWindowMask.subarray(rowBase, rowBase + SCREEN_WIDTH) : null;
    buildWindowMaskLine(y, dispcnt, win0h, win1h, win0v, win1v, winin, winout, objWinRow, outRow);
  }
}

/** Decode a 16-bit (H, V) register pair into a normalised rectangle.
 *
 *  H register: high byte = X1, low byte = X2.
 *  V register: high byte = Y1, low byte = Y2.
 *
 *  After GBATEK clamping: X2 > screen-edge OR X1 > X2 → X2 = edge.
 *  This makes "wrapped" or out-of-range rectangles behave as a single
 *  contiguous strip from X1 to the edge, which matches what real
 *  hardware does. */
function decodeRect(hReg: number, vReg: number): Omit<WindowRect, "enable"> {
  const x1Raw = (hReg >>> 8) & 0xff;
  const x2Raw = hReg & 0xff;
  const y1Raw = (vReg >>> 8) & 0xff;
  const y2Raw = vReg & 0xff;
  const x2 = x2Raw > SCREEN_WIDTH || x1Raw > x2Raw ? SCREEN_WIDTH : x2Raw;
  const y2 = y2Raw > SCREEN_HEIGHT || y1Raw > y2Raw ? SCREEN_HEIGHT : y2Raw;
  return { x1: x1Raw, x2, y1: y1Raw, y2 };
}
