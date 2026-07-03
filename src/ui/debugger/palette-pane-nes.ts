import { NES_PALETTE } from "../../nes";
import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * Palette pane for the NES engine — visualises the 32-byte palette RAM
 * ($3F00-$3F1F). Mirrors the Game Boy palette pane (`./palette-pane.ts`)
 * 4-swatch-row layout.
 *
 * Palette RAM holds 32 indices into the 64-entry master palette
 * (`NES_PALETTE`). The 32 entries are 8 four-colour palettes: the first
 * 16 are the 4 background palettes, the last 16 the 4 sprite palettes.
 * Each swatch shows the resolved master colour; the tooltip carries the
 * palette-RAM index, the master-palette index it points at, and the
 * resolved RGB.
 */

interface Refs {
  mode: HTMLElement;
  bgSwatches: HTMLElement[];
  obSwatches: HTMLElement[];
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

export const palettePaneNes: Pane = {
  id: "palette",
  label: "Palette",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-palette");

    const mode = document.createElement("div");
    mode.className = "palette-mode";

    const section = document.createElement("div");
    section.className = "palette-section";

    const bgHeading = document.createElement("div");
    bgHeading.className = "palette-section-heading";
    bgHeading.textContent = "Background palettes ($3F00-$3F0F)";
    section.appendChild(bgHeading);
    const bgSwatches: HTMLElement[] = [];
    for (let p = 0; p < 4; p++) {
      const { row, swatches } = createPaletteRow(`#${p}`);
      section.appendChild(row);
      bgSwatches.push(...swatches);
    }

    const obHeading = document.createElement("div");
    obHeading.className = "palette-section-heading";
    obHeading.textContent = "Sprite palettes ($3F10-$3F1F)";
    section.appendChild(obHeading);
    const obSwatches: HTMLElement[] = [];
    for (let p = 0; p < 4; p++) {
      const { row, swatches } = createPaletteRow(`#${p}`);
      section.appendChild(row);
      obSwatches.push(...swatches);
    }

    container.append(mode, section);

    refs = { mode, bgSwatches, obSwatches };
  },

  refresh(): void {
    if (!refs) return;
    const nes = state.nes;
    if (!nes) {
      refs.mode.textContent = "No ROM loaded.";
      return;
    }
    refs.mode.textContent = "Palette RAM ($3F00-$3F1F) — live";
    for (let i = 0; i < 16; i++) {
      paintSwatch(refs.bgSwatches[i]!, nes.ppu.peekPalette(i), i);
      paintSwatch(refs.obSwatches[i]!, nes.ppu.peekPalette(16 + i), 16 + i);
    }
  }
};

/** Paint one swatch from a palette-RAM byte. `paletteIndex` is the
 *  $3F00-relative index (0-31); the byte it holds is itself an index
 *  into the 64-entry master palette. The tooltip surfaces both so a
 *  reader can cross-reference. */
function paintSwatch(el: HTMLElement, masterIndex: number, paletteIndex: number): void {
  const v = NES_PALETTE[masterIndex & 0x3f]!;
  const r = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = (v >>> 16) & 0xff;
  el.style.background = `rgb(${r}, ${g}, ${b})`;
  el.title = `$3F${(paletteIndex & 0x1f).toString(16).padStart(2, "0").toUpperCase()} → master $${(masterIndex & 0x3f)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase()}   RGB888 ${r}, ${g}, ${b}`;
}
