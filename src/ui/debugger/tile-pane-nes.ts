import { state } from "../state.js";
import { hex2 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Tile / CHR pane for the NES engine. Mirrors the Game Boy tile pane
 * (`./tile-pane.ts`) shape: per-rAF canvas dumps plus a textual OAM table.
 *
 *   1. **Pattern tables**: the two CHR pattern tables ($0000-$0FFF and
 *      $1000-$1FFF), each 256 tiles, drawn as a 16×16 grid of 8×8 tiles
 *      scaled 2×. Read through `cartridge.ppuRead` so it reflects the
 *      currently-banked CHR (mappers swap this live).
 *   2. **OAM**: textual table of the 64 sprite attribute records
 *      (Y / tile / attr / X).
 *
 * Tile decoding uses a neutral 4-shade grey palette — it's a raw-data
 * view, not a rendering of the game's actual palette choices (which
 * depend on per-tile palette selection the pattern table doesn't carry).
 */

const TILE_SIZE_NATIVE = 8;
const TILE_SCALE = 2;
const TILE_SIZE = TILE_SIZE_NATIVE * TILE_SCALE; // 16 px on screen
const TILES_PER_ROW = 16;
const TILE_ROWS = 16; // 256 tiles / 16 = 16 rows
const TILE_CANVAS_W = TILES_PER_ROW * TILE_SIZE; // 256
const TILE_CANVAS_H = TILE_ROWS * TILE_SIZE; // 256

/** Neutral 4-shade palette for the CHR dump. AABBGGRR little-endian,
 *  same format the framebuffer uses (R is the low byte). */
const DEFAULT_SHADES = [0xff000000, 0xff555555, 0xffaaaaaa, 0xffffffff];

interface Refs {
  table0Ctx: CanvasRenderingContext2D;
  table1Ctx: CanvasRenderingContext2D;
  oamRows: HTMLElement[];
  table0Image: ImageData;
  table1Image: ImageData;
}

let refs: Refs | null = null;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.style.imageRendering = "pixelated";
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
}

export const tilePaneNes: Pane = {
  id: "tile",
  label: "Tiles",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-tile");

    // ─── Pattern tables ─────────────────────────────────────────────
    const grid = document.createElement("div");
    grid.className = "tile-section";
    const gridHeading = document.createElement("div");
    gridHeading.className = "tile-section-heading";
    gridHeading.textContent = "CHR pattern tables ($0000-$1FFF, 256 tiles each)";
    grid.appendChild(gridHeading);
    const gridFlex = document.createElement("div");
    gridFlex.className = "tile-grid-flex";

    const t0Wrap = document.createElement("div");
    t0Wrap.className = "tile-grid-wrap";
    const t0Label = document.createElement("div");
    t0Label.className = "tile-grid-label";
    t0Label.textContent = "Table 0 ($0000)";
    const { canvas: t0Canvas, ctx: table0Ctx } = makeCanvas(TILE_CANVAS_W, TILE_CANVAS_H);
    t0Wrap.append(t0Label, t0Canvas);

    const t1Wrap = document.createElement("div");
    t1Wrap.className = "tile-grid-wrap";
    const t1Label = document.createElement("div");
    t1Label.className = "tile-grid-label";
    t1Label.textContent = "Table 1 ($1000)";
    const { canvas: t1Canvas, ctx: table1Ctx } = makeCanvas(TILE_CANVAS_W, TILE_CANVAS_H);
    t1Wrap.append(t1Label, t1Canvas);

    gridFlex.append(t0Wrap, t1Wrap);
    grid.appendChild(gridFlex);
    container.appendChild(grid);

    // ─── OAM sprite list ─────────────────────────────────────────────
    const oam = document.createElement("div");
    oam.className = "tile-section";
    const oamHeading = document.createElement("div");
    oamHeading.className = "tile-section-heading";
    oamHeading.textContent = "OAM (64 sprites)";
    oam.appendChild(oamHeading);
    const oamTable = document.createElement("table");
    oamTable.className = "oam-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>#</th><th>Y</th><th>Tile</th><th>Attr</th><th>X</th></tr>";
    oamTable.appendChild(thead);
    const oamBody = document.createElement("tbody");
    const oamRows: HTMLElement[] = [];
    for (let i = 0; i < 64; i++) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
      oamBody.appendChild(tr);
      oamRows.push(tr);
    }
    oamTable.appendChild(oamBody);
    oam.appendChild(oamTable);
    container.appendChild(oam);

    refs = {
      table0Ctx,
      table1Ctx,
      oamRows,
      table0Image: table0Ctx.createImageData(TILE_CANVAS_W, TILE_CANVAS_H),
      table1Image: table1Ctx.createImageData(TILE_CANVAS_W, TILE_CANVAS_H)
    };
  },

  refresh(): void {
    if (!refs) return;
    const nes = state.nes;
    if (!nes) return;

    paintPatternTable(nes.cartridge, refs.table0Image, 0x0000);
    refs.table0Ctx.putImageData(refs.table0Image, 0, 0);
    paintPatternTable(nes.cartridge, refs.table1Image, 0x1000);
    refs.table1Ctx.putImageData(refs.table1Image, 0, 0);

    const oamBuf = nes.ppu.debugOam;
    for (let i = 0; i < 64; i++) {
      const y = oamBuf[i * 4]!;
      const tile = oamBuf[i * 4 + 1]!;
      const attr = oamBuf[i * 4 + 2]!;
      const x = oamBuf[i * 4 + 3]!;
      const cells = refs.oamRows[i]!.children;
      cells[0]!.textContent = String(i);
      cells[1]!.textContent = hex2(y);
      cells[2]!.textContent = hex2(tile);
      cells[3]!.textContent = hex2(attr);
      cells[4]!.textContent = hex2(x);
    }
  }
};

/** Decode all 256 tiles of one CHR pattern table into the image buffer.
 *  Each tile is 16 bytes — 8 low-plane bytes then 8 high-plane bytes;
 *  the per-pixel 2-bit colour is `lowbit | (highbit << 1)`. Uses the
 *  neutral grey shades. */
function paintPatternTable(cart: NonNullable<typeof state.nes>["cartridge"], img: ImageData, base: number): void {
  const data = img.data;
  for (let t = 0; t < 256; t++) {
    const col = t % TILES_PER_ROW;
    const row = Math.floor(t / TILES_PER_ROW);
    const tileAddr = base + t * 16;
    for (let ty = 0; ty < 8; ty++) {
      const lo = cart.ppuRead(tileAddr + ty);
      const hi = cart.ppuRead(tileAddr + ty + 8);
      for (let tx = 0; tx < 8; tx++) {
        const bit = 7 - tx;
        const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        const rgba = DEFAULT_SHADES[colorIdx]!;
        for (let sy = 0; sy < TILE_SCALE; sy++) {
          for (let sx = 0; sx < TILE_SCALE; sx++) {
            const dx = col * TILE_SIZE + tx * TILE_SCALE + sx;
            const dy = row * TILE_SIZE + ty * TILE_SCALE + sy;
            const off = (dy * TILE_CANVAS_W + dx) * 4;
            data[off] = rgba & 0xff;
            data[off + 1] = (rgba >>> 8) & 0xff;
            data[off + 2] = (rgba >>> 16) & 0xff;
            data[off + 3] = 0xff;
          }
        }
      }
    }
  }
}
