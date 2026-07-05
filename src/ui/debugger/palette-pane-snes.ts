import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * SNES palette pane — visualises the 256-entry CGRAM as a 16 × 16
 * swatch grid, matching the GBA palette pane's layout.
 *
 * SNES has a single palette bank shared by BGs and sprites: 2bpp BGs
 * slice it into 4-colour groups, 4bpp BGs and OBJs into 16-colour
 * rows (OBJ palettes live in the top half, entries 128-255), 8bpp
 * BGs use it flat. The 16-wide grid maps colour `(pal, idx)` of a
 * 4bpp layer onto row=pal, col=idx directly. Hover any cell for its
 * absolute index, raw BGR555, and unpacked RGB888.
 *
 * Engine surface consumed: `snes.ppu.cgram` — 512 bytes of
 * little-endian BGR555, written through live by the cart.
 */

let swatches: HTMLElement[] | null = null;

export const palettePaneSnes: Pane = {
  id: "palette",
  label: "Palette",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-palette");

    const wrap = document.createElement("div");
    wrap.className = "palette-section";
    const heading = document.createElement("div");
    heading.className = "palette-section-heading";
    heading.textContent = "CGRAM (256)";
    wrap.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "palette-gba-grid";
    const cells: HTMLElement[] = [];
    for (let i = 0; i < 256; i++) {
      const s = document.createElement("span");
      s.className = "palette-gba-swatch";
      grid.appendChild(s);
      cells.push(s);
    }
    wrap.appendChild(grid);
    container.appendChild(wrap);
    swatches = cells;
  },

  refresh(): void {
    if (!swatches) return;
    const snes = state.snes;
    if (!snes) return;
    const cgram = snes.ppu.cgram;
    for (let i = 0; i < 256; i++) {
      paintSwatch(swatches[i]!, cgram, i);
    }
  }
};

/** Paint one CGRAM swatch. `bytes[idx*2 .. idx*2+1]` is a little-endian
 *  BGR555 packed colour: `0 bbbbb ggggg rrrrr`. 5-bit components widen
 *  to 8 bits via the standard `(c << 3) | (c >> 2)`. */
function paintSwatch(el: HTMLElement, bytes: Uint8Array, idx: number): void {
  const lo = bytes[idx * 2] ?? 0;
  const hi = bytes[idx * 2 + 1] ?? 0;
  const bgr555 = ((hi << 8) | lo) & 0x7fff;
  const r5 = bgr555 & 0x1f;
  const g5 = (bgr555 >>> 5) & 0x1f;
  const b5 = (bgr555 >>> 10) & 0x1f;
  const r = (r5 << 3) | (r5 >>> 2);
  const g = (g5 << 3) | (g5 >>> 2);
  const b = (b5 << 3) | (b5 >>> 2);
  el.style.background = `rgb(${r}, ${g}, ${b})`;
  // Colour 0 of each 16-slot row is the transparent index for 4bpp
  // layers; mark it so palette rows read the way carts use them.
  el.classList.toggle("is-transparent", idx % 16 === 0);
  el.title =
    `CGRAM #${idx}` + `\nBGR555 $${bgr555.toString(16).padStart(4, "0").toUpperCase()}` + `\nRGB888 ${r}, ${g}, ${b}`;
}
