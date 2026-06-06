import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * Palette pane for the Game Boy / Game Boy Color engine —
 * visualises the currently-loaded palettes. The Game Boy Advance
 * equivalent (`./palette-pane-gba.ts`) renders the two 256-entry
 * BG + OBJ banks as 16×16 grids.
 *
 * CGB: 8 BG palettes + 8 OBJ palettes, each 4 colours, rendered as
 * 4-swatch rows next to the palette index. Raw RGB555 appears in the
 * hover tooltip.
 *
 * DMG (or CGB-compat mode): BGP / OBP0 / OBP1 each as a 4-swatch row.
 * Uses the same `setDmgCompatPalette` shade table the PPU writes into
 * the framebuffer — so colour correction and the user's active DMG
 * palette preset are reflected.
 */

interface Refs {
  mode: HTMLElement;
  cgbSection: HTMLElement;
  dmgSection: HTMLElement;
  cgbBgSwatches: HTMLElement[];
  cgbObSwatches: HTMLElement[];
  dmgSwatches: { bg: HTMLElement[]; obp0: HTMLElement[]; obp1: HTMLElement[] };
}

let refs: Refs | null = null;

function createPaletteRow(label: string): { row: HTMLElement; swatches: HTMLElement[] } {
  const row = document.createElement("div");
  row.className = "palette-row";
  const lbl = document.createElement("span");
  lbl.className = "palette-row-label";
  lbl.textContent = label;
  row.appendChild(lbl);
  const swatches: HTMLElement[] = [];
  for (let i = 0; i < 4; i++) {
    const s = document.createElement("span");
    s.className = "palette-swatch-cell";
    row.appendChild(s);
    swatches.push(s);
  }
  return { row, swatches };
}

export const palettePane: Pane = {
  id: "palette",
  label: "Palette",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-palette");

    const mode = document.createElement("div");
    mode.className = "palette-mode";

    const cgbSection = document.createElement("div");
    cgbSection.className = "palette-section";
    const cgbBgHeading = document.createElement("div");
    cgbBgHeading.className = "palette-section-heading";
    cgbBgHeading.textContent = "CGB — BG palettes";
    cgbSection.appendChild(cgbBgHeading);
    const cgbBgSwatches: HTMLElement[] = [];
    for (let p = 0; p < 8; p++) {
      const { row, swatches } = createPaletteRow(`#${p}`);
      cgbSection.appendChild(row);
      cgbBgSwatches.push(...swatches);
    }
    const cgbObHeading = document.createElement("div");
    cgbObHeading.className = "palette-section-heading";
    cgbObHeading.textContent = "CGB — OBJ palettes";
    cgbSection.appendChild(cgbObHeading);
    const cgbObSwatches: HTMLElement[] = [];
    for (let p = 0; p < 8; p++) {
      const { row, swatches } = createPaletteRow(`#${p}`);
      cgbSection.appendChild(row);
      cgbObSwatches.push(...swatches);
    }

    const dmgSection = document.createElement("div");
    dmgSection.className = "palette-section";
    const dmgHeading = document.createElement("div");
    dmgHeading.className = "palette-section-heading";
    dmgHeading.textContent = "DMG — Compat palettes";
    dmgSection.appendChild(dmgHeading);
    const dmgBg = createPaletteRow("BGP");
    const dmgObp0 = createPaletteRow("OBP0");
    const dmgObp1 = createPaletteRow("OBP1");
    dmgSection.append(dmgBg.row, dmgObp0.row, dmgObp1.row);

    container.append(mode, cgbSection, dmgSection);

    refs = {
      mode,
      cgbSection,
      dmgSection,
      cgbBgSwatches,
      cgbObSwatches,
      dmgSwatches: { bg: dmgBg.swatches, obp0: dmgObp0.swatches, obp1: dmgObp1.swatches }
    };
  },

  refresh(): void {
    if (!refs) return;
    const gb = state.gb;
    if (!gb) {
      refs.mode.textContent = "No ROM loaded.";
      return;
    }
    const cgb = gb.cart.cgb;
    refs.mode.textContent = cgb ? "CGB game — BG + OBJ palette RAM live" : "DMG-compat game — BGP/OBP* shade tables";
    refs.cgbSection.hidden = !cgb;
    refs.dmgSection.hidden = cgb;

    const p = gb.ppu.debugPalettes;
    if (cgb) {
      for (let i = 0; i < 32; i++) {
        paintSwatch(refs.cgbBgSwatches[i]!, p.cgbBg[i]!, p.bgPalRam, i);
        paintSwatch(refs.cgbObSwatches[i]!, p.cgbOb[i]!, p.obPalRam, i);
      }
    } else {
      for (let i = 0; i < 4; i++) {
        paintSwatch(refs.dmgSwatches.bg[i]!, p.dmgBg[i]!);
        paintSwatch(refs.dmgSwatches.obp0[i]!, p.dmgObp0[i]!);
        paintSwatch(refs.dmgSwatches.obp1[i]!, p.dmgObp1[i]!);
      }
    }
  }
};

/** Paint one swatch. `rgba` is a little-endian `0xAABBGGRR` value
 *  (the framebuffer format). `rawBytes` + `colorIndex` are optional —
 *  when provided, the tooltip shows the raw RGB555 value from palette
 *  RAM so CGB tweakers can cross-reference. */
function paintSwatch(el: HTMLElement, rgba: number, rawBytes?: Uint8Array, colorIndex?: number): void {
  const r = rgba & 0xff;
  const g = (rgba >>> 8) & 0xff;
  const b = (rgba >>> 16) & 0xff;
  el.style.background = `rgb(${r}, ${g}, ${b})`;
  if (rawBytes && colorIndex !== undefined) {
    const lo = rawBytes[colorIndex * 2]!;
    const hi = rawBytes[colorIndex * 2 + 1]!;
    const rgb555 = ((hi << 8) | lo) & 0x7fff;
    el.title = `RGB555 $${rgb555.toString(16).padStart(4, "0").toUpperCase()}   RGB888 ${r}, ${g}, ${b}`;
  } else {
    el.title = `RGB888 ${r}, ${g}, ${b}`;
  }
}
