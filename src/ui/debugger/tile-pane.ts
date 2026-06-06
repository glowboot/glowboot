import { state } from "../state.js";
import { hex2 } from "./format.js";
import type { Pane } from "./pane.js";

/**
 * Tile / VRAM pane for the Game Boy / Game Boy Color engine — three
 * sub-views. The Game Boy Advance equivalent (`./tile-pane-gba.ts`)
 * is a simpler single-canvas dump of the 96 KiB GBA VRAM with a
 * 4bpp / 8bpp toggle and palette-bank picker (per-BG-map and per-OBJ
 * sprite views aren't ported yet).
 *
 *   1. **Tile data**: all 384 tiles in VRAM bank 0, plus bank 1 on CGB.
 *      Rendered to a canvas as a 16×24 grid of 8×8 tiles (scaled 2×
 *      for readability).
 *   2. **BG map**: the currently-active background map ($9800 or
 *      $9C00 depending on LCDC bit 3) rendered at natural 256×256.
 *   3. **OAM**: textual table of the 40 sprite attribute records.
 *
 * All three refresh per rAF tick while the pane is visible. Tile
 * decoding uses a neutral 4-shade palette — it's a raw-data view, not
 * a rendering of the game's actual palette choices.
 */

const TILE_SIZE_NATIVE = 8;
const TILE_SCALE = 2;
const TILE_SIZE = TILE_SIZE_NATIVE * TILE_SCALE; // 16 px on screen
const TILES_PER_ROW = 16;
const TILE_ROWS = 24; // 384 tiles / 16 = 24 rows
const TILE_CANVAS_W = TILES_PER_ROW * TILE_SIZE; // 256
const TILE_CANVAS_H = TILE_ROWS * TILE_SIZE; // 384

const BGMAP_SIZE = 256; // 32 tiles × 8 px, drawn 1:1 (no scale)

/** Neutral "default DMG" shade palette used by the tile + BG-map
 *  canvases. AABBGGRR little-endian, same format as the framebuffer. */
const DEFAULT_SHADES = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];

interface Refs {
  bank0Canvas: HTMLCanvasElement;
  bank0Ctx: CanvasRenderingContext2D;
  bank1Canvas: HTMLCanvasElement;
  bank1Ctx: CanvasRenderingContext2D;
  bank1Wrap: HTMLElement;
  bgMapCanvas: HTMLCanvasElement;
  bgMapCtx: CanvasRenderingContext2D;
  bgMapHeading: HTMLElement;
  oamBody: HTMLElement;
  oamRows: HTMLElement[];
  bank0Image: ImageData;
  bank1Image: ImageData;
  bgMapImage: ImageData;
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

export const tilePane: Pane = {
  id: "tile",
  label: "Tiles",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-tile");

    // ─── Tile data grid(s) ──────────────────────────────────────────
    const grid = document.createElement("div");
    grid.className = "tile-section";
    const gridHeading = document.createElement("div");
    gridHeading.className = "tile-section-heading";
    gridHeading.textContent = "VRAM tiles ($8000-$97FF, 384 tiles × 2 banks on CGB)";
    grid.appendChild(gridHeading);
    const gridFlex = document.createElement("div");
    gridFlex.className = "tile-grid-flex";

    const bank0Wrap = document.createElement("div");
    bank0Wrap.className = "tile-grid-wrap";
    const bank0Label = document.createElement("div");
    bank0Label.className = "tile-grid-label";
    bank0Label.textContent = "Bank 0";
    const { canvas: bank0Canvas, ctx: bank0Ctx } = makeCanvas(TILE_CANVAS_W, TILE_CANVAS_H);
    bank0Wrap.append(bank0Label, bank0Canvas);

    const bank1Wrap = document.createElement("div");
    bank1Wrap.className = "tile-grid-wrap";
    const bank1Label = document.createElement("div");
    bank1Label.className = "tile-grid-label";
    bank1Label.textContent = "Bank 1";
    const { canvas: bank1Canvas, ctx: bank1Ctx } = makeCanvas(TILE_CANVAS_W, TILE_CANVAS_H);
    bank1Wrap.append(bank1Label, bank1Canvas);

    gridFlex.append(bank0Wrap, bank1Wrap);
    grid.appendChild(gridFlex);
    container.appendChild(grid);

    // ─── BG map ───────────────────────────────────────────────────────
    const bgMap = document.createElement("div");
    bgMap.className = "tile-section";
    const bgMapHeading = document.createElement("div");
    bgMapHeading.className = "tile-section-heading";
    bgMapHeading.textContent = "Background map";
    bgMap.appendChild(bgMapHeading);
    const { canvas: bgMapCanvas, ctx: bgMapCtx } = makeCanvas(BGMAP_SIZE, BGMAP_SIZE);
    bgMap.appendChild(bgMapCanvas);
    container.appendChild(bgMap);

    // ─── OAM sprite list ─────────────────────────────────────────────
    const oam = document.createElement("div");
    oam.className = "tile-section";
    const oamHeading = document.createElement("div");
    oamHeading.className = "tile-section-heading";
    oamHeading.textContent = "OAM (40 sprites)";
    oam.appendChild(oamHeading);
    const oamTable = document.createElement("table");
    oamTable.className = "oam-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>#</th><th>Y</th><th>X</th><th>Tile</th><th>Flags</th></tr>";
    oamTable.appendChild(thead);
    const oamBody = document.createElement("tbody");
    const oamRows: HTMLElement[] = [];
    for (let i = 0; i < 40; i++) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td>";
      oamBody.appendChild(tr);
      oamRows.push(tr);
    }
    oamTable.appendChild(oamBody);
    oam.appendChild(oamTable);
    container.appendChild(oam);

    refs = {
      bank0Canvas,
      bank0Ctx,
      bank1Canvas,
      bank1Ctx,
      bank1Wrap,
      bgMapCanvas,
      bgMapCtx,
      bgMapHeading,
      oamBody,
      oamRows,
      bank0Image: bank0Ctx.createImageData(TILE_CANVAS_W, TILE_CANVAS_H),
      bank1Image: bank1Ctx.createImageData(TILE_CANVAS_W, TILE_CANVAS_H),
      bgMapImage: bgMapCtx.createImageData(BGMAP_SIZE, BGMAP_SIZE)
    };
  },

  refresh(): void {
    if (!refs) return;
    const gb = state.gb;
    if (!gb) return;

    paintTileGrid(gb.ppu, refs.bank0Image, 0);
    refs.bank0Ctx.putImageData(refs.bank0Image, 0, 0);

    refs.bank1Wrap.style.display = gb.cart.cgb ? "" : "none";
    if (gb.cart.cgb) {
      paintTileGrid(gb.ppu, refs.bank1Image, 1);
      refs.bank1Ctx.putImageData(refs.bank1Image, 0, 0);
    }

    // LCDC bit 3 picks the tilemap base; bit 4 picks the tile-data
    // addressing mode (signed = $8800 method, anchored at $9000).
    const lcdc = gb.ppu.readByte(0xff40);
    const mapBase = lcdc & 0x08 ? 0x1c00 : 0x1800; // $9C00 vs $9800 in VRAM offset
    const signedTiles = (lcdc & 0x10) === 0;
    refs.bgMapHeading.textContent = `Background map ($${(mapBase + 0x8000).toString(16).toUpperCase()})`;
    paintBgMap(gb.ppu, refs.bgMapImage, mapBase, signedTiles);
    refs.bgMapCtx.putImageData(refs.bgMapImage, 0, 0);

    const oamBuf = gb.ppu.debugOam;
    for (let i = 0; i < 40; i++) {
      const y = oamBuf[i * 4]!;
      const x = oamBuf[i * 4 + 1]!;
      const tile = oamBuf[i * 4 + 2]!;
      const flags = oamBuf[i * 4 + 3]!;
      const cells = refs.oamRows[i]!.children;
      cells[0]!.textContent = String(i);
      cells[1]!.textContent = hex2(y);
      cells[2]!.textContent = hex2(x);
      cells[3]!.textContent = hex2(tile);
      cells[4]!.textContent = hex2(flags);
    }
  }
};

/** Decode all 384 tiles of the given VRAM bank into the image buffer.
 *  Uses the neutral 4-shade palette — the actual game palettes are
 *  applied per-pixel at render time and picking any one of them here
 *  would misrepresent sprites assigned to a different palette. */
function paintTileGrid(ppu: NonNullable<typeof state.gb>["ppu"], img: ImageData, bank: 0 | 1): void {
  const data = img.data;
  for (let t = 0; t < 384; t++) {
    const col = t % TILES_PER_ROW;
    const row = Math.floor(t / TILES_PER_ROW);
    const tileAddr = t * 16; // 16 bytes per tile
    for (let ty = 0; ty < 8; ty++) {
      const lo = ppu.peekVram(bank, tileAddr + ty * 2);
      const hi = ppu.peekVram(bank, tileAddr + ty * 2 + 1);
      for (let tx = 0; tx < 8; tx++) {
        const bit = 7 - tx;
        const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        const rgba = DEFAULT_SHADES[colorIdx]!;
        // Scale up each source pixel to TILE_SCALE × TILE_SCALE block.
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

function paintBgMap(
  ppu: NonNullable<typeof state.gb>["ppu"],
  img: ImageData,
  mapBase: number,
  signedTiles: boolean
): void {
  const data = img.data;
  for (let mapRow = 0; mapRow < 32; mapRow++) {
    for (let mapCol = 0; mapCol < 32; mapCol++) {
      const rawIdx = ppu.peekVram(0, mapBase + mapRow * 32 + mapCol);
      // Signed addressing anchors the tile-data block at $9000 (VRAM
      // offset 0x1000) and uses the index as a signed offset; unsigned
      // mode anchors at $8000 (offset 0). Mirrors PPU.renderBgScanline.
      const tileAddr = signedTiles ? 0x1000 + ((rawIdx << 24) >> 24) * 16 : rawIdx * 16;
      for (let ty = 0; ty < 8; ty++) {
        const lo = ppu.peekVram(0, tileAddr + ty * 2);
        const hi = ppu.peekVram(0, tileAddr + ty * 2 + 1);
        for (let tx = 0; tx < 8; tx++) {
          const bit = 7 - tx;
          const colorIdx = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          const rgba = DEFAULT_SHADES[colorIdx]!;
          const dx = mapCol * 8 + tx;
          const dy = mapRow * 8 + ty;
          const off = (dy * BGMAP_SIZE + dx) * 4;
          data[off] = rgba & 0xff;
          data[off + 1] = (rgba >>> 8) & 0xff;
          data[off + 2] = (rgba >>> 16) & 0xff;
          data[off + 3] = 0xff;
        }
      }
    }
  }
}
