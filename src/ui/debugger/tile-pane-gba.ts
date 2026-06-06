import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * GBA tile pane — dumps 96 KiB of VRAM as a flat tile grid so you can
 * eyeball what character data the cart has uploaded.
 *
 * The view is intentionally simple for v1:
 *   - A single canvas, 32 tiles wide × 48 tiles tall = all of VRAM
 *     interpreted as 8bpp 8×8 tiles (1 byte per pixel). Bitmap-mode
 *     framebuffers also appear here — they just look like a scrolling
 *     dump of the rendered scene since each 8×8 region of the frame
 *     gets one tile cell.
 *   - Bpp + palette-bank picker: 8bpp uses one of two flat 256-colour
 *     banks; 4bpp slices each 16-colour palette out of the bank and
 *     uses one row at a time.
 *
 * The BG-map / OAM-sprite viewers from the GB tile pane don't have
 * direct GBA analogues yet — GBA's BG mapping has four affine + four
 * text BGs across multiple modes, and OBJ rendering involves the OAM
 * attribute fields. Both are Phase 4-extras if anyone hits a graphics
 * bug worth chasing.
 */

const GRID_TILES_W = 32; // tiles per row
const TILE_PX = 8;
const SCALE = 1;
/** 96 KiB VRAM / 64 bytes per 8bpp tile = 1536 tiles → 48 rows. */
const TILES_8BPP = 0x18000 / 64;
const ROWS_8BPP = TILES_8BPP / GRID_TILES_W;
/** 96 KiB VRAM / 32 bytes per 4bpp tile = 3072 tiles → 96 rows. */
const TILES_4BPP = 0x18000 / 32;
const ROWS_4BPP = TILES_4BPP / GRID_TILES_W;

interface Refs {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
  bppSelect: HTMLSelectElement;
  bankSelect: HTMLSelectElement;
  palRowSelect: HTMLSelectElement;
}

let refs: Refs | null = null;
let bpp: 4 | 8 = 4;
let bank: "bg" | "obj" = "bg";
let palRow = 0; // 4bpp only — which 16-colour slice (0-15)

export const tilePaneGba: Pane = {
  id: "tile",
  label: "Tiles",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-tile");

    const toolbar = document.createElement("div");
    toolbar.className = "tile-toolbar";

    const bppSelect = makeSelect(
      "Bpp",
      [
        ["4", "4bpp"],
        ["8", "8bpp"]
      ],
      String(bpp),
      (v) => {
        bpp = v === "8" ? 8 : 4;
        resize();
      }
    );
    const bankSelect = makeSelect(
      "Palette",
      [
        ["bg", "BG"],
        ["obj", "OBJ"]
      ],
      bank,
      (v) => {
        bank = v === "obj" ? "obj" : "bg";
      }
    );
    const palRowOptions: Array<[string, string]> = [];
    for (let i = 0; i < 16; i++) palRowOptions.push([String(i), `Row ${i}`]);
    const palRowSelect = makeSelect("Pal row", palRowOptions, String(palRow), (v) => {
      palRow = Math.max(0, Math.min(15, parseInt(v, 10) | 0));
    });

    toolbar.append(bppSelect.wrap, bankSelect.wrap, palRowSelect.wrap);
    container.appendChild(toolbar);

    const wrap = document.createElement("div");
    wrap.className = "tile-grid-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "tile-grid-canvas";
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
    const initialRows = bpp === 8 ? ROWS_8BPP : ROWS_4BPP;
    canvas.width = GRID_TILES_W * TILE_PX;
    canvas.height = initialRows * TILE_PX;
    canvas.style.width = `${canvas.width * SCALE}px`;
    canvas.style.height = `${canvas.height * SCALE}px`;
    canvas.style.imageRendering = "pixelated";
    const imageData = ctx.createImageData(canvas.width, canvas.height);

    refs = {
      canvas,
      ctx,
      imageData,
      bppSelect: bppSelect.select,
      bankSelect: bankSelect.select,
      palRowSelect: palRowSelect.select
    };
  },

  refresh(): void {
    if (!refs) return;
    const gba = state.gba;
    if (!gba) return;
    refs.palRowSelect.disabled = bpp === 8;
    paintGrid(refs, gba.mem.ppu.vram, gba.mem.ppu.palette);
  }
};

function resize(): void {
  if (!refs) return;
  const rows = bpp === 8 ? ROWS_8BPP : ROWS_4BPP;
  refs.canvas.width = GRID_TILES_W * TILE_PX;
  refs.canvas.height = rows * TILE_PX;
  refs.canvas.style.width = `${refs.canvas.width * SCALE}px`;
  refs.canvas.style.height = `${refs.canvas.height * SCALE}px`;
  refs.imageData = refs.ctx.createImageData(refs.canvas.width, refs.canvas.height);
}

function makeSelect(
  label: string,
  options: Array<[string, string]>,
  initial: string,
  onChange: (v: string) => void
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = document.createElement("label");
  wrap.className = "tile-toolbar-field";
  const lbl = document.createElement("span");
  lbl.textContent = label;
  wrap.appendChild(lbl);
  const select = document.createElement("select");
  for (const [value, text] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (value === initial) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange(select.value));
  wrap.appendChild(select);
  return { wrap, select };
}

function paintGrid(r: Refs, vram: Uint8Array, palette: Uint8Array): void {
  const px = r.imageData.data;
  const w = r.imageData.width;
  // Palette base: BG bank lives at offsets 0x000-0x1FF, OBJ at
  // 0x200-0x3FF. 4bpp also offsets by palRow * 16 within the bank.
  const paletteBase = bank === "obj" ? 0x200 : 0x000;
  const palRowOffset = bpp === 4 ? palRow * 16 : 0;

  const tilesTotal = bpp === 8 ? TILES_8BPP : TILES_4BPP;
  const tileBytes = bpp === 8 ? 64 : 32;
  for (let t = 0; t < tilesTotal; t++) {
    const tx = (t % GRID_TILES_W) * TILE_PX;
    const ty = Math.floor(t / GRID_TILES_W) * TILE_PX;
    const tileOffset = t * tileBytes;
    for (let py = 0; py < TILE_PX; py++) {
      for (let px2 = 0; px2 < TILE_PX; px2++) {
        let palIdx: number;
        if (bpp === 8) {
          palIdx = vram[tileOffset + py * TILE_PX + px2] ?? 0;
        } else {
          const byte = vram[tileOffset + py * 4 + (px2 >>> 1)] ?? 0;
          palIdx = (px2 & 1) === 0 ? byte & 0xf : (byte >>> 4) & 0xf;
        }
        const effective = bpp === 4 && palIdx !== 0 ? palIdx + palRowOffset : palIdx;
        // Index 0 is always transparent in tile modes; paint a faint
        // checkerboard so the user can tell empty/uninitialised tiles
        // apart from solid-colour-0 ones.
        let rOut: number, gOut: number, bOut: number, aOut: number;
        if (palIdx === 0) {
          const checker = ((tx + px2) ^ (ty + py)) & 1;
          rOut = gOut = bOut = checker ? 0x18 : 0x10;
          aOut = 255;
        } else {
          const palOff = paletteBase + effective * 2;
          const lo = palette[palOff] ?? 0;
          const hi = palette[palOff + 1] ?? 0;
          const bgr555 = ((hi << 8) | lo) & 0x7fff;
          const r5 = bgr555 & 0x1f;
          const g5 = (bgr555 >>> 5) & 0x1f;
          const b5 = (bgr555 >>> 10) & 0x1f;
          rOut = (r5 << 3) | (r5 >>> 2);
          gOut = (g5 << 3) | (g5 >>> 2);
          bOut = (b5 << 3) | (b5 >>> 2);
          aOut = 255;
        }
        const dstIdx = ((ty + py) * w + (tx + px2)) * 4;
        px[dstIdx] = rOut;
        px[dstIdx + 1] = gOut;
        px[dstIdx + 2] = bOut;
        px[dstIdx + 3] = aOut;
      }
    }
  }
  r.ctx.putImageData(r.imageData, 0, 0);
}
