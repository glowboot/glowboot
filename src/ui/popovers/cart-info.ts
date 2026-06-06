import { type Gba, parseGbaHeader } from "../../gba";
import { AUDIO_MODES, type AudioMode } from "../audio/output.js";
import { cartInfoPop, cartInfoTrigger } from "../dom.js";
import { formatPlayTime } from "../format.js";
import { errorToast, toast } from "../hud/toast.js";
import { type CartOverrides, loadCartOverrides, saveCartOverrides } from "../persistence/cart-overrides.js";
import { KEYS, lsGet } from "../persistence/local-storage.js";
import * as Recents from "../persistence/recents.js";
import * as SaveRamGba from "../persistence/save-ram-gba.js";
import { saveBlobNative } from "../save-blob.js";
import { applyCartOverrides } from "../session/cart-overrides.js";
import * as Palettes from "../session/palettes.js";
import { flushPlayTime, startPlayTimer } from "../session/play-time.js";
import { loadIntegerScalePref } from "../settings";
import { state } from "../state.js";
import { createPopover } from "./helper.js";

/**
 * Cartridge-info popover — read-only view of the ROM's header
 * metadata plus cumulative play time, with per-game override editors
 * for any settings that apply to the active engine.
 *
 * The trigger sits next to the NOW-PLAYING title and is unhidden in
 * `rom-loader.ts` once a ROM has loaded. The popover branches on the
 * active engine: GB carts expose MBC / ROM-RAM banks / RTC / CGB mode
 * / licensee. GBA carts expose game-code / maker-code / version /
 * backup-type / ROM CRC. Both share the engine-agnostic override
 * panel — render mode, integer scaling, pixel response, audio mode —
 * since those all target the same renderer / audio abstractions.
 * Palette and CGB colour correction stay GB-only because they drive
 * the GB PPU directly.
 */

export const { open: openCartInfo, close: closeCartInfo } = createPopover({
  trigger: cartInfoTrigger,
  pop: cartInfoPop,
  render: renderCartInfo
});

/** Build the small circular "↺" reset button that clears all per-game
 *  overrides. Used by both `renderGbCartInfo` and `renderGbaCartInfo`
 *  — they pass their own disabled flag (true when there's nothing to
 *  clear) and click handler (the engine-specific persistOverride
 *  call). The SVG is the same Material-style refresh glyph in both;
 *  duplicating its 3 lines twice was the original sin. */
function createOverridesResetButton(disabled: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bindings-reset";
  btn.setAttribute("aria-label", "Clear all per-game overrides");
  btn.title = "Clear all per-game overrides";
  btn.disabled = disabled;
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg>';
  btn.addEventListener("click", onClick);
  return btn;
}

// Clicking the ROM title forwards to the cart-info trigger — same
// popover, wider click target. The trigger is `hidden` until a ROM
// loads; while hidden we no-op so clicking "—" (the placeholder)
// doesn't pop an empty "Load a ROM to see cart info" dialog.
document.getElementById("np-title")?.addEventListener("click", (e) => {
  if (!cartInfoTrigger || cartInfoTrigger.hidden) return;
  e.stopPropagation();
  cartInfoTrigger.click();
});

async function renderCartInfo(): Promise<void> {
  if (!cartInfoPop) return;
  cartInfoPop.innerHTML = "";
  if (state.gb) {
    await renderGbCartInfo();
    return;
  }
  if (state.gba) {
    await renderGbaCartInfo(state.gba);
    return;
  }
  const empty = document.createElement("div");
  empty.className = "pop-empty";
  empty.textContent = "Load a ROM to see cart info";
  cartInfoPop.appendChild(empty);
}

async function renderGbCartInfo(): Promise<void> {
  const gb = state.gb;
  if (!gb || !cartInfoPop) return;
  const c = gb.cart;
  // Flush the in-memory play-time counter so the value we show reflects
  // the current session, not just the last 30 s-interval checkpoint.
  await flushPlayTime();
  startPlayTimer();
  const recent = (await Recents.list()).find((r) => r.id === Recents.idFor(c));
  const playMs = recent?.totalPlayMs ?? 0;
  const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, "0").toUpperCase()}`;
  const hex4 = (n: number): string => `0x${n.toString(16).padStart(4, "0").toUpperCase()}`;
  const kib = (banks: number, size: number): string =>
    banks === 0 ? "—" : `${banks} × ${size} = ${(banks * size).toLocaleString()} KiB`;

  const title = document.createElement("div");
  title.className = "cart-info-title";
  title.textContent = c.title || "(untitled)";
  cartInfoPop.appendChild(title);

  const mode = c.cgbFlag === 0xc0 ? "CGB-only" : c.cgb ? "CGB-enhanced" : "DMG";
  const region = c.destinationCode === 0x00 ? "Japan" : "Overseas";
  const licensee = c.newLicensee !== null ? `"${c.newLicensee}" (0x33)` : hex2(c.licenseeCode);

  const rows: Array<[string, string]> = [
    ["MBC", `${c.mbcType} (${hex2(c.typeCode)})`],
    ["ROM", kib(c.romBanks, 16)],
    ["RAM", kib(c.ramBanks, 8)],
    ["Battery", c.hasBattery ? "Yes" : "No"],
    ...(c.mbcType === "MBC3" ? [["RTC", c.hasRtc ? "Yes" : "No"] as [string, string]] : []),
    ["Mode", mode],
    ["Region", region],
    ["Licensee", licensee],
    ["Header CRC", hex2(c.headerChecksum)],
    ["Global CRC", hex4(c.globalChecksum)],
    ["ROM size", `${c.rom.length.toLocaleString()} bytes`],
    ["Play time", playMs >= 60_000 ? formatPlayTime(playMs) : "—"]
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "cart-info-row";
    const ks = document.createElement("span");
    ks.textContent = k;
    const vs = document.createElement("b");
    vs.textContent = v;
    row.appendChild(ks);
    row.appendChild(vs);
    cartInfoPop.appendChild(row);
  }

  // ── Per-game overrides ─────────────────────────────────────────────
  // Each override row mirrors its corresponding Settings popover input
  // (select for render mode + palette, checkbox for toggles, slider for
  // pixel response). When no override is pinned, the input reflects the
  // current global value. Changing the input pins the new value; the
  // small ↺ icon that appears alongside a pinned row clears the pin
  // and the input snaps back to the global.
  const overrides = await loadCartOverrides(Recents.idFor(c));
  const hasAnyOverride =
    overrides.renderMode !== undefined ||
    overrides.palette !== undefined ||
    overrides.colorCorrection !== undefined ||
    overrides.integerScale !== undefined ||
    overrides.pixelResponse !== undefined ||
    overrides.audioMode !== undefined;

  renderSharedCartOverrides(cartInfoPop, overrides, hasAnyOverride, persistOverride, () => {
    // GB-specific overrides slot between Audio mode and Integer
    // scaling. Palette only applies to DMG carts (CGB titles drive
    // their own palette RAM); Colour correction only applies to
    // CGB carts (the DMG path has no colour space to correct).
    if (!c.cgb) {
      renderSelectOverride({
        label: "Palette",
        options: Palettes.PALETTES.map((p) => [p.id, p.name]),
        globalValue: Palettes.loadPaletteId(),
        pinned: overrides.palette,
        onPin: (v) => persistOverride({ ...overrides, palette: v }),
        onReset: () => persistOverride({ ...overrides, palette: undefined })
      });
    }

    if (c.cgb) {
      renderCheckboxOverride({
        label: "Colour correction",
        globalValue: lsGet(KEYS.COLOR_CORRECTION) !== "0",
        pinned: overrides.colorCorrection,
        onPin: (v) => persistOverride({ ...overrides, colorCorrection: v }),
        onReset: () => persistOverride({ ...overrides, colorCorrection: undefined })
      });
    }
  });
}

async function renderGbaCartInfo(gba: Gba): Promise<void> {
  if (!cartInfoPop) return;
  await flushPlayTime();
  startPlayTimer();
  const id = Recents.idForGba(gba);
  const recent = (await Recents.list()).find((r) => r.id === id);
  const playMs = recent?.totalPlayMs ?? 0;
  const header = parseGbaHeader(gba.mem.rom);
  const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, "0").toUpperCase()}`;

  const title = document.createElement("div");
  title.className = "cart-info-title";
  title.textContent = header.title || "(untitled)";
  cartInfoPop.appendChild(title);

  // Backup label mirrors the toast `handleGbaRomFile` shows on load.
  const backup =
    gba.backup.type === "none"
      ? "—"
      : gba.backup.type === "flash64"
        ? "Flash 64 KiB"
        : gba.backup.type === "flash128"
          ? "Flash 128 KiB"
          : gba.backup.type === "sram"
            ? "SRAM"
            : gba.backup.type === "eeprom"
              ? "EEPROM"
              : gba.backup.type;
  const checksumOk = header.headerChecksumValid
    ? `${hex2(header.headerChecksum)} ✓`
    : `${hex2(header.headerChecksum)} ✗`;

  const rows: Array<[string, string]> = [
    ["Game code", header.gameCode || "—"],
    ["Maker", header.makerCode || "—"],
    ["Version", String(header.version)],
    ["Backup", backup],
    ["Header CRC", checksumOk],
    ["ROM size", `${gba.mem.rom.length.toLocaleString()} bytes`],
    ["Play time", playMs >= 60_000 ? formatPlayTime(playMs) : "—"]
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "cart-info-row";
    const ks = document.createElement("span");
    ks.textContent = k;
    const vs = document.createElement("b");
    vs.textContent = v;
    row.appendChild(ks);
    row.appendChild(vs);
    cartInfoPop.appendChild(row);
  }

  // Save-data management — Export / Import / Clear the cart's battery
  // backup. Only meaningful for carts that have a backup (the
  // "Backup: —" carts get the row hidden). Cleaning happens against the
  // *live* device so the change is immediately visible to the running
  // cart; the IDB store is wiped too so a refresh doesn't bring the
  // old save back.
  if (SaveRamGba.isPersistable(gba)) {
    const saveHeading = document.createElement("div");
    saveHeading.className = "cart-info-heading";
    const saveHeadingLabel = document.createElement("span");
    saveHeadingLabel.textContent = "Save data";
    saveHeading.appendChild(saveHeadingLabel);
    cartInfoPop.appendChild(saveHeading);

    const saveRow = document.createElement("div");
    saveRow.className = "cart-info-row cart-info-save-actions";

    const makeBtn = (label: string, title: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cart-info-save-btn";
      b.textContent = label;
      b.title = title;
      return b;
    };

    const exportBtn = makeBtn("Export", "Download the current save as a .sav file");
    const importBtn = makeBtn("Import", "Replace the current save with bytes from a .sav file");
    const clearBtn = makeBtn("Clear", "Wipe the cart's save data (no undo)");
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".sav,.srm,application/octet-stream";
    importInput.hidden = true;
    saveRow.appendChild(exportBtn);
    saveRow.appendChild(importBtn);
    saveRow.appendChild(clearBtn);
    saveRow.appendChild(importInput);
    cartInfoPop.appendChild(saveRow);

    exportBtn.addEventListener("click", async () => {
      const bytes = SaveRamGba.exportBytes(gba);
      if (!bytes) {
        errorToast("No save data to export yet");
        return;
      }
      const stem = (header.title || "save").replace(/[^A-Za-z0-9 ._-]+/g, "_").trim() || "save";
      const filename = `${stem}.sav`;
      // Copy into a fresh ArrayBuffer the Blob can own without sharing
      // the underlying buffer with the emulator's live SRAM.
      const buf = new ArrayBuffer(bytes.length);
      new Uint8Array(buf).set(bytes);
      const blob = new Blob([buf], { type: "application/octet-stream" });
      const share = await saveBlobNative(blob, filename);
      if (share === "shared" || share === "cancelled") return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      importInput.value = "";
      if (!file) return;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        errorToast("Could not read file");
        return;
      }
      const result = await SaveRamGba.importBytes(gba, bytes);
      if (!result.ok) {
        errorToast(result.reason);
        return;
      }
      toast(`Imported ${bytes.length.toLocaleString()} bytes`);
    });

    clearBtn.addEventListener("click", async () => {
      // Inline confirm — a full modal would be overkill for an admin
      // action gated behind opening the cart-info popover already.
      if (!window.confirm("Wipe the cart's save data? This cannot be undone.")) return;
      await SaveRamGba.clear(gba);
      toast("Save data cleared");
    });
  }

  // Per-game overrides — render mode, integer scaling, pixel response,
  // and audio mode all apply to GBA carts via the shared renderer /
  // audio abstractions (the GBA raw-2D path was retired). Palette and
  // colour correction stay GB-only because they target the GB PPU.
  const overrides = await loadCartOverrides(id);
  const hasAnyOverride =
    overrides.renderMode !== undefined ||
    overrides.integerScale !== undefined ||
    overrides.pixelResponse !== undefined ||
    overrides.audioMode !== undefined;
  // GBA has no engine-specific extras — palette + colour correction
  // are GB-only since they target the GB PPU.
  renderSharedCartOverrides(cartInfoPop, overrides, hasAnyOverride, persistOverride, null);
}

function clampPixelResponse(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(0.85, v)) : 0;
}

/** Per-game overrides block shared by the GB and GBA cart-info
 *  popovers — heading + reset button, Render mode, Audio mode,
 *  Integer scaling, Pixel response. The optional `engineExtras`
 *  callback runs between Audio mode and Integer scaling; the GB
 *  renderer uses it to inject Palette / Colour-correction
 *  overrides at that point. `hasAnyOverride` stays in the caller's
 *  hands because each engine has a different set of pinnable
 *  fields (GB tracks palette + CGB colour correction; GBA doesn't). */
function renderSharedCartOverrides(
  parent: HTMLElement,
  overrides: CartOverrides,
  hasAnyOverride: boolean,
  persist: (next: CartOverrides) => Promise<void>,
  engineExtras: (() => void) | null
): void {
  const heading = document.createElement("div");
  heading.className = "cart-info-heading";
  const headingLabel = document.createElement("span");
  headingLabel.textContent = "Per-game overrides";
  heading.appendChild(headingLabel);
  // Reset button reuses the ghost-pill style + counter-clockwise-arrow
  // glyph from the settings popover's .bindings-reset / .grade-reset
  // pattern so the "clear overrides" action reads as the same verb.
  // Disabled when nothing is pinned — no-op clicks shouldn't feel live.
  heading.appendChild(createOverridesResetButton(!hasAnyOverride, () => void persist({})));
  parent.appendChild(heading);

  renderSelectOverride({
    label: "Render mode",
    options: RENDER_MODE_OPTIONS,
    globalValue: lsGet(KEYS.RENDER_MODE) ?? "canvas",
    pinned: overrides.renderMode,
    onPin: (v) => persist({ ...overrides, renderMode: v }),
    onReset: () => persist({ ...overrides, renderMode: undefined })
  });

  renderSelectOverride({
    label: "Audio mode",
    options: AUDIO_MODES.map((m): [string, string] => [m.id, m.name]),
    globalValue: lsGet(KEYS.AUDIO_MODE) ?? "studio",
    pinned: overrides.audioMode,
    onPin: (v) => persist({ ...overrides, audioMode: v as AudioMode }),
    onReset: () => persist({ ...overrides, audioMode: undefined })
  });

  engineExtras?.();

  renderCheckboxOverride({
    label: "Integer scaling",
    globalValue: loadIntegerScalePref(),
    pinned: overrides.integerScale,
    onPin: (v) => persist({ ...overrides, integerScale: v }),
    onReset: () => persist({ ...overrides, integerScale: undefined })
  });

  renderSliderOverride({
    label: "Pixel response",
    min: 0,
    max: 0.85,
    step: 0.01,
    globalValue: clampPixelResponse(parseFloat(lsGet(KEYS.PIXEL_RESPONSE) ?? "0")),
    pinned: overrides.pixelResponse,
    onPin: (v) => persist({ ...overrides, pixelResponse: v }),
    onReset: () => persist({ ...overrides, pixelResponse: undefined })
  });
}

/** Mode key → human label. Keep this list in sync with the render-mode
 *  dropdown in `settings/panels.ts` and the `<option>`s in
 *  `pages/index.html`. */
const RENDER_MODE_OPTIONS: Array<[string, string]> = [
  ["canvas", "Original"],
  ["webgl-bilinear", "Bilinear"],
  ["webgl-crt", "CRT"],
  ["webgl-hq2x", "HQ2x"],
  ["webgl-lcd", "LCD"],
  ["webgl-mmpx", "MMPX"],
  ["webgl-sxbr", "Super-xBR"]
];

/** Shared row scaffold — builds `<label class="cart-info-override">`
 *  as a 2-column grid (label / control). Pinned rows get a small
 *  accent bullet before the label and a `title` hint that right-
 *  click clears the override — same pattern as the binding chips
 *  in the Controls editor. Right-click to clear keeps the row
 *  visually uncluttered while still giving users an undo path. */
function buildOverrideRow(label: string, control: HTMLElement, pinned: boolean, onReset: () => void): void {
  if (!cartInfoPop) return;
  const row = document.createElement("label");
  row.className = "cart-info-row cart-info-override";
  if (pinned) row.classList.add("is-pinned");

  const name = document.createElement("span");
  name.textContent = label;
  row.appendChild(name);

  row.appendChild(control);

  if (pinned) {
    control.title = "Right-click to reset to global default";
    control.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    });
  }

  cartInfoPop.appendChild(row);
}

interface SelectOverrideOpts {
  label: string;
  options: Array<[string, string]>;
  globalValue: string;
  pinned: string | undefined;
  onPin: (v: string) => void;
  onReset: () => void;
}
function renderSelectOverride(o: SelectOverrideOpts): void {
  const sel = document.createElement("select");
  const effective = o.pinned ?? o.globalValue;
  for (const [value, text] of o.options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (value === effective) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => o.onPin(sel.value));
  buildOverrideRow(o.label, sel, o.pinned !== undefined, o.onReset);
}

interface CheckboxOverrideOpts {
  label: string;
  globalValue: boolean;
  pinned: boolean | undefined;
  onPin: (v: boolean) => void;
  onReset: () => void;
}
function renderCheckboxOverride(o: CheckboxOverrideOpts): void {
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = o.pinned ?? o.globalValue;
  cb.addEventListener("change", () => o.onPin(cb.checked));
  // Clicks on the wrapping <label> bubble to the checkbox — stop that
  // short on the input element itself so a user's checkbox flip
  // doesn't also trigger the label-click-toggles-checkbox pathway.
  cb.addEventListener("click", (e) => e.stopPropagation());
  buildOverrideRow(o.label, cb, o.pinned !== undefined, o.onReset);
}

interface SliderOverrideOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  globalValue: number;
  pinned: number | undefined;
  onPin: (v: number) => void;
  onReset: () => void;
}
function renderSliderOverride(o: SliderOverrideOpts): void {
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(o.min);
  slider.max = String(o.max);
  slider.step = String(o.step);
  slider.value = String(o.pinned ?? o.globalValue);
  // Persist on `change` (release) so a mid-drag slider move doesn't
  // thrash IndexedDB — applyCartOverrides triggers a live preview on
  // each call which is meaningful at release, overkill on drag.
  slider.addEventListener("change", () => o.onPin(parseFloat(slider.value)));
  buildOverrideRow(o.label, slider, o.pinned !== undefined, o.onReset);
}

/** Write the new overrides object to IDB and re-apply it to the live
 *  engine. Empty-string values from the dropdown become `undefined`
 *  before reaching here; callers pass the merged object. Cart id
 *  comes from whichever engine is active — GB uses `cartIdOf`, GBA
 *  uses `cartIdOfGba`. */
async function persistOverride(next: CartOverrides): Promise<void> {
  const id = state.gb ? Recents.idFor(state.gb.cart) : state.gba ? Recents.idForGba(state.gba) : null;
  if (!id) return;
  // Strip empty-string entries that snuck through — the select's "use
  // global" option carries `""`, not the typed-field `undefined` value.
  const clean: CartOverrides = {
    palette: next.palette || undefined,
    colorCorrection: next.colorCorrection,
    renderMode: next.renderMode || undefined,
    integerScale: next.integerScale,
    pixelResponse: next.pixelResponse,
    audioMode: next.audioMode || undefined
  };
  await saveCartOverrides(id, clean);
  applyCartOverrides(clean);
  // Re-render so the reset button's disabled state reflects the new
  // pin-count. Without this, toggling the first override after page
  // load leaves the button stuck on the initial snapshot.
  await renderCartInfo();
}
