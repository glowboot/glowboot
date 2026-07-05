import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * SNES tile pane — dumps all 64 KiB of VRAM as a flat grid of 8×8
 * tiles, matching the GBA tile pane's canvas + toolbar layout.
 *
 * SNES CHR data is planar: each tile row is a pair of plane bytes,
 * with plane pairs 16 bytes apart — 2bpp tiles are 16 bytes, 4bpp 32,
 * 8bpp 64 (same maths as the PPU's `tilePixel`). The bpp selector
 * reinterprets the whole address space at once; regions holding
 * tilemaps or differently-packed data just look like noise.
 *
 * The palette-group selector picks which 2^bpp-colour slice of CGRAM
 * colours the view (disabled at 8bpp, where the palette is flat).
 */

const GRID_TILES_W = 32;
const TILE_PX = 8;
const VRAM_BYTES = 0x10000;

interface Refs {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
  groupSelect: HTMLSelectElement;
}

let refs: Refs | null = null;
let bpp: 2 | 4 | 8 = 4;
let palGroup = 0;

function bytesPerTile(): number {
  return bpp * 8;
}

function tileCount(): number {
  return VRAM_BYTES / bytesPerTile();
}

export const tilePaneSnes: Pane = {
  id: "tiles",
  label: "Tiles",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-tile");

    const toolbar = document.createElement("div");
    toolbar.className = "tile-toolbar";

    const bppSelect = makeSelect(
      "Bpp",
      [
        ["2", "2bpp"],
        ["4", "4bpp"],
        ["8", "8bpp"]
      ],
      String(bpp),
      (v) => {
        bpp = v === "8" ? 8 : v === "2" ? 2 : 4;
        rebuildGroupOptions();
        resize();
      }
    );
    const groupSelect = makeSelect("Pal group", [], String(palGroup), (v) => {
      palGroup = parseInt(v, 10) | 0;
    });

    toolbar.append(bppSelect.wrap, groupSelect.wrap);
    container.appendChild(toolbar);

    const wrap = document.createElement("div");
    wrap.className = "tile-grid-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "tile-grid-canvas";
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
    canvas.style.imageRendering = "pixelated";

    refs = { canvas, ctx, imageData: ctx.createImageData(1, 1), groupSelect: groupSelect.select };
    rebuildGroupOptions();
    resize();
  },

  refresh(): void {
    if (!refs) return;
    const snes = state.snes;
    if (!snes) return;
    refs.groupSelect.disabled = bpp === 8;
    paintGrid(refs, snes.ppu.vram, snes.ppu.cgram);
  }
};

function resize(): void {
  if (!refs) return;
  const rows = tileCount() / GRID_TILES_W;
  refs.canvas.width = GRID_TILES_W * TILE_PX;
  refs.canvas.height = rows * TILE_PX;
  refs.canvas.style.width = `${refs.canvas.width}px`;
  refs.canvas.style.height = `${refs.canvas.height}px`;
  refs.imageData = refs.ctx.createImageData(refs.canvas.width, refs.canvas.height);
}

function rebuildGroupOptions(): void {
  if (!refs) return;
  const groupCount = 256 / (1 << bpp);
  if (palGroup >= groupCount) palGroup = 0;
  const select = refs.groupSelect;
  select.innerHTML = "";
  for (let i = 0; i < groupCount; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Group ${i}`;
    if (i === palGroup) opt.selected = true;
    select.appendChild(opt);
  }
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

function paintGrid(r: Refs, vram: Uint8Array, cgram: Uint8Array): void {
  const px = r.imageData.data;
  const w = r.imageData.width;
  const coloursPerGroup = 1 << bpp;
  const groupBase = bpp === 8 ? 0 : palGroup * coloursPerGroup;
  const tileBytes = bytesPerTile();
  const tilesTotal = tileCount();

  for (let t = 0; t < tilesTotal; t++) {
    const tx = (t % GRID_TILES_W) * TILE_PX;
    const ty = Math.floor(t / GRID_TILES_W) * TILE_PX;
    const tileOffset = t * tileBytes;
    for (let py = 0; py < TILE_PX; py++) {
      for (let px2 = 0; px2 < TILE_PX; px2++) {
        // Planar decode, same layout as the PPU's tilePixel: row `py`'s
        // byte for plane `p` sits at py*2 + (p>>1)*16 + (p&1).
        const shift = 7 - px2;
        let pix = 0;
        for (let plane = 0; plane < bpp; plane++) {
          const byte = vram[tileOffset + py * 2 + ((plane >> 1) << 4) + (plane & 1)]!;
          pix |= ((byte >> shift) & 1) << plane;
        }
        // Index 0 is the transparent index; paint a faint checkerboard
        // so empty tiles read differently from solid colour-0 ones.
        let rOut: number, gOut: number, bOut: number;
        if (pix === 0) {
          const checker = ((tx + px2) ^ (ty + py)) & 1;
          rOut = gOut = bOut = checker ? 0x18 : 0x10;
        } else {
          const palOff = (groupBase + pix) * 2;
          const lo = cgram[palOff] ?? 0;
          const hi = cgram[palOff + 1] ?? 0;
          const bgr555 = ((hi << 8) | lo) & 0x7fff;
          const r5 = bgr555 & 0x1f;
          const g5 = (bgr555 >>> 5) & 0x1f;
          const b5 = (bgr555 >>> 10) & 0x1f;
          rOut = (r5 << 3) | (r5 >>> 2);
          gOut = (g5 << 3) | (g5 >>> 2);
          bOut = (b5 << 3) | (b5 >>> 2);
        }
        const dstIdx = ((ty + py) * w + (tx + px2)) * 4;
        px[dstIdx] = rOut;
        px[dstIdx + 1] = gOut;
        px[dstIdx + 2] = bOut;
        px[dstIdx + 3] = 255;
      }
    }
  }
  r.ctx.putImageData(r.imageData, 0, 0);
}
