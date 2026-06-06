import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * GBA palette pane — visualises the two 256-entry palette banks.
 *
 *   - BG palette: 256 colours at 0x05000000-0x050001FF. In tile modes
 *     this is sliced 16 ways for 4bpp BGs (16 palettes × 16 colours)
 *     or used flat for 8bpp BGs.
 *   - OBJ palette: 256 colours at 0x05000200-0x050003FF. Same slicing
 *     options apply to sprites.
 *
 * Each grid is laid out 16 × 16 so the visual maps directly onto the
 * "row" addressing convention 4bpp games use — colour `(pal, idx)`
 * sits at row=pal, col=idx in the grid. Hover any cell to see its
 * absolute index, raw BGR555, and unpacked RGB888.
 *
 * Engine surface consumed: `gba.mem.ppu.palette` — the 1 KiB
 * little-endian BGR555 array. No engine changes required; the live
 * write-through means the swatches update automatically as the cart
 * blits new palettes during fades / mid-frame swaps.
 */

interface Refs {
  bgGrid: HTMLElement;
  obGrid: HTMLElement;
  bgSwatches: HTMLElement[];
  obSwatches: HTMLElement[];
}

let refs: Refs | null = null;

function buildGrid(label: string): { wrap: HTMLElement; grid: HTMLElement; swatches: HTMLElement[] } {
  const wrap = document.createElement("div");
  wrap.className = "palette-section";
  const heading = document.createElement("div");
  heading.className = "palette-section-heading";
  heading.textContent = label;
  wrap.appendChild(heading);
  const grid = document.createElement("div");
  grid.className = "palette-gba-grid";
  const swatches: HTMLElement[] = [];
  for (let i = 0; i < 256; i++) {
    const s = document.createElement("span");
    s.className = "palette-gba-swatch";
    grid.appendChild(s);
    swatches.push(s);
  }
  wrap.appendChild(grid);
  return { wrap, grid, swatches };
}

export const palettePaneGba: Pane = {
  id: "palette",
  label: "Palette",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-palette");
    const bg = buildGrid("BG palette (256)");
    const ob = buildGrid("OBJ palette (256)");
    container.append(bg.wrap, ob.wrap);
    refs = { bgGrid: bg.grid, obGrid: ob.grid, bgSwatches: bg.swatches, obSwatches: ob.swatches };
  },

  refresh(): void {
    if (!refs) return;
    const gba = state.gba;
    if (!gba) return;
    const pal = gba.mem.ppu.palette;
    for (let i = 0; i < 256; i++) {
      paintSwatch(refs.bgSwatches[i]!, pal, i * 2, i, "BG");
      paintSwatch(refs.obSwatches[i]!, pal, 0x200 + i * 2, i, "OBJ");
    }
  }
};

/** Paint one palette swatch. `bytes[off..off+1]` is a little-endian
 *  BGR555 packed colour: `0 bbbbb ggggg rrrrr`. 5-bit components widen
 *  to 8 bits via the standard `(c << 3) | (c >> 2)`. */
function paintSwatch(el: HTMLElement, bytes: Uint8Array, off: number, idx: number, bank: string): void {
  const lo = bytes[off] ?? 0;
  const hi = bytes[off + 1] ?? 0;
  const bgr555 = ((hi << 8) | lo) & 0x7fff;
  const r5 = bgr555 & 0x1f;
  const g5 = (bgr555 >>> 5) & 0x1f;
  const b5 = (bgr555 >>> 10) & 0x1f;
  const r = (r5 << 3) | (r5 >>> 2);
  const g = (g5 << 3) | (g5 >>> 2);
  const b = (b5 << 3) | (b5 >>> 2);
  el.style.background = `rgb(${r}, ${g}, ${b})`;
  // Colour-0 in each 16-slot row is the transparent index in 4bpp BG
  // mode. Mark it visually so users can tell at a glance whether the
  // bank's transparency is matching their expectations.
  el.classList.toggle("is-transparent", idx % 16 === 0);
  el.title =
    `${bank} #${idx}` + `\nBGR555 $${bgr555.toString(16).padStart(4, "0").toUpperCase()}` + `\nRGB888 ${r}, ${g}, ${b}`;
}
