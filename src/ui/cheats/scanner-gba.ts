import {
  decodeGbaCheat,
  formatGbaCheat,
  type GbaCheatEntry,
  type GbaCheatWidth,
  type MemoryBus,
  newGbaCheatId
} from "../../gba";
import { errorToast, toast } from "../hud/toast.js";
import * as Cheats from "../persistence/cheats.js";
import * as Recents from "../persistence/recents.js";
import { state } from "../state.js";

/**
 * Game Shark-style memory scanner for the GBA engine. Same idea as the
 * GB version (`./scanner.ts`) — repeated filtering of a RAM snapshot
 * narrows down the address of a game value (HP, gold, lap timer) —
 * with two GBA-specific extensions:
 *
 *   - **Width selector.** GB scanner is byte-only. GBA games store
 *     most interesting values as 16- or 32-bit (HP up to 9999, gold
 *     up to ~10^6, frame counters as u32), so the scanner exposes
 *     an 8 / 16 / 32-bit picker. The width also drives the initial
 *     scan stride (aligned addresses) and which `read*` / `write*`
 *     the bus call dispatches to.
 *
 *   - **Memory regions.** EWRAM (0x02000000-0x0203FFFF, 256 KiB) and
 *     IWRAM (0x03000000-0x03007FFF, 32 KiB) — the two regions a
 *     game can park mutable state in. Cart-ROM at 0x08xxxxxx is
 *     immutable and the LCD I/O at 0x04xxxxxx is volatile; both
 *     skipped. Total scan range ≈ 288 KiB, ~30× the GB scanner but
 *     still a sub-millisecond walk for filters.
 *
 * State is module-local and cleared on cart switch — same contract as
 * the GB scanner so the cheats popover can call `renderScannerGba` on
 * every open without losing in-progress scans.
 */

const EWRAM_BASE = 0x02000000;
const EWRAM_END = 0x02040000; // exclusive — 256 KiB
const IWRAM_BASE = 0x03000000;
const IWRAM_END = 0x03008000; // exclusive — 32 KiB

const CANDIDATE_LIMIT_TO_LIST = 50;

type Candidate = { addr: number; last: number };

type ValueComparison = "eq-value" | "ne-value" | "gt-value" | "lt-value";
type RelativeComparison = "changed" | "unchanged" | "increased" | "decreased";
type ComparisonKind = ValueComparison | RelativeComparison;

export interface ScannerHost {
  onCheatAdded(): void;
}

let scanState: Candidate[] | null = null;
let scanCartId: string | null = null;
let scanWidth: GbaCheatWidth = 16;

function widthMax(w: GbaCheatWidth): number {
  return w === 8 ? 0xff : w === 16 ? 0xffff : 0xffffffff;
}

function readAt(bus: MemoryBus, addr: number, w: GbaCheatWidth): number {
  if (w === 8) return bus.read8(addr) & 0xff;
  if (w === 16) return bus.read16(addr) & 0xffff;
  return bus.read32(addr) >>> 0;
}

function writeAt(bus: MemoryBus, addr: number, value: number, w: GbaCheatWidth): void {
  if (w === 8) bus.write8(addr, value & 0xff);
  else if (w === 16) bus.write16(addr, value & 0xffff);
  else bus.write32(addr, value | 0);
}

export function renderScannerGba(parent: HTMLElement, host: ScannerHost): void {
  const gba = state.gba;
  if (!gba) return;

  // Cart-id key uses the same Recents.idForGba hash that persistence
  // uses for save-states and cheats, so cart swap wipes stale state
  // without the popover having to coordinate.
  const currentId = Recents.idForGba(gba);
  if (scanCartId !== currentId) {
    scanState = null;
    scanCartId = currentId;
  }

  for (const el of parent.querySelectorAll(".cheats-scanner")) el.remove();

  const panel = document.createElement("div");
  panel.className = "cheats-scanner";

  const heading = document.createElement("div");
  heading.className = "cheats-scanner-heading";
  heading.textContent = "Memory scanner";
  panel.appendChild(heading);

  if (scanState === null) {
    renderIdle(panel, () => renderScannerGba(parent, host));
  } else {
    renderActive(panel, host, () => renderScannerGba(parent, host));
  }

  parent.appendChild(panel);
}

function renderIdle(panel: HTMLElement, rerender: () => void): void {
  const bus = state.gba?.mem.bus;
  if (!bus) return;

  const form = document.createElement("form");
  form.className = "cheats-scanner-row";

  const label = document.createElement("span");
  label.textContent = "Start with value";
  label.className = "cheats-scanner-label";

  const widthSel = makeWidthSelector(() => {
    // Idle-state width change has no scan state to invalidate; just
    // adjust the value input's max so a typed 0xFFFF stops rejecting
    // when the user picks 16-bit.
    valueInput.max = String(widthMax(scanWidth));
  });

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.min = "0";
  valueInput.max = String(widthMax(scanWidth));
  valueInput.placeholder = "e.g. 100";
  valueInput.className = "cheats-scanner-value";

  const startBtn = document.createElement("button");
  startBtn.type = "submit";
  startBtn.className = "cheats-scanner-btn";
  startBtn.textContent = "Scan";

  const unknownBtn = document.createElement("button");
  unknownBtn.type = "button";
  unknownBtn.className = "cheats-scanner-btn cheats-scanner-btn-alt";
  unknownBtn.textContent = "Scan (unknown)";
  unknownBtn.title = "Snapshot every address. Use Changed / Increased / Decreased after the value moves in-game.";

  form.append(label, widthSel, valueInput, startBtn, unknownBtn);
  panel.appendChild(form);

  const hint = document.createElement("div");
  hint.className = "cheats-scanner-hint";
  hint.textContent =
    "Pick a width (8 / 16 / 32-bit), enter a value you can see in-game (HP, gold, timer) and click Scan. " +
    "If the value is hidden, click Scan (unknown) and narrow via Changed / Increased / Decreased.";
  panel.appendChild(hint);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = parseInt(valueInput.value, 10);
    if (!Number.isFinite(v) || v < 0 || v > widthMax(scanWidth)) {
      toast(`Enter a value between 0 and ${widthMax(scanWidth)}`);
      return;
    }
    scanState = collectAllCandidates(bus, scanWidth).filter((c) => c.last === (v & widthMax(scanWidth)));
    toast(`${scanState.length.toLocaleString()} candidates`);
    rerender();
  });

  unknownBtn.addEventListener("click", () => {
    scanState = collectAllCandidates(bus, scanWidth);
    toast(`${scanState.length.toLocaleString()} candidates`);
    rerender();
  });
}

function renderActive(panel: HTMLElement, host: ScannerHost, rerender: () => void): void {
  const bus = state.gba?.mem.bus;
  if (!bus) return;

  const status = document.createElement("div");
  status.className = "cheats-scanner-status";
  panel.appendChild(status);

  // Width is fixed once a scan starts — flipping mid-scan would
  // invalidate every candidate's `last` value (stride + read width
  // changed). Show the active width as a tag instead of a picker so
  // the user remembers what they chose; New scan resets back to the
  // selector.
  const widthTag = document.createElement("span");
  widthTag.className = "cheats-scanner-width-tag";
  widthTag.textContent = `${scanWidth}-bit`;
  widthTag.title = "Width chosen for this scan. Use New scan to switch.";
  status.appendChild(widthTag);

  const relRow = document.createElement("div");
  relRow.className = "cheats-scanner-filters";

  const valRow = document.createElement("form");
  valRow.className = "cheats-scanner-filters";
  const sharedValueInput = document.createElement("input");
  sharedValueInput.type = "number";
  sharedValueInput.min = "0";
  sharedValueInput.max = String(widthMax(scanWidth));
  sharedValueInput.className = "cheats-scanner-value";
  sharedValueInput.placeholder = "value";
  sharedValueInput.title = "Compare candidates' current value against this (Enter applies =)";
  valRow.appendChild(sharedValueInput);

  const body = document.createElement("div");

  const redrawBody = (): void => {
    const candidates = scanState ?? [];
    status.innerHTML = "";
    status.appendChild(widthTag);
    const count = document.createElement("span");
    count.textContent = ` · ${candidates.length.toLocaleString()} candidate${candidates.length === 1 ? "" : "s"}`;
    status.appendChild(count);
    body.innerHTML = "";
    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cheats-scanner-empty";
      empty.textContent = "No matches — try a different filter or start a new scan.";
      body.appendChild(empty);
      return;
    }
    if (candidates.length > CANDIDATE_LIMIT_TO_LIST) {
      const hint = document.createElement("div");
      hint.className = "cheats-scanner-hint";
      hint.textContent = `Keep filtering — the list appears when candidates drop below ${CANDIDATE_LIMIT_TO_LIST}.`;
      body.appendChild(hint);
      return;
    }
    body.appendChild(renderList(candidates, bus, host));
  };

  const runFilter = (kind: ComparisonKind, value?: number): void => {
    if (!scanState) return;
    scanState = applyFilter(bus, scanState, kind, value, scanWidth);
    redrawBody();
  };

  const readSharedValue = (): number | null => {
    const v = parseInt(sharedValueInput.value, 10);
    if (!Number.isFinite(v) || v < 0 || v > widthMax(scanWidth)) {
      toast(`Enter a value between 0 and ${widthMax(scanWidth)}`);
      return null;
    }
    return v & widthMax(scanWidth);
  };

  const valBtn = (label: string, title: string, kind: ValueComparison): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cheats-scanner-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => {
      const v = readSharedValue();
      if (v === null) return;
      runFilter(kind, v);
    });
    return b;
  };
  valRow.append(
    valBtn("= N", "Keep addresses whose current value equals the value on the left", "eq-value"),
    valBtn("≠ N", "Keep addresses whose current value is not the value on the left", "ne-value"),
    valBtn(">", "Keep addresses whose value is greater than the value on the left", "gt-value"),
    valBtn("<", "Keep addresses whose value is less than the value on the left", "lt-value")
  );
  valRow.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = readSharedValue();
    if (v === null) return;
    runFilter("eq-value", v);
  });

  const relBtn = (label: string, title: string, kind: RelativeComparison): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cheats-scanner-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => runFilter(kind));
    return b;
  };
  relRow.append(
    relBtn("Changed", "Keep addresses whose value changed since the last scan", "changed"),
    relBtn("Unchanged", "Keep addresses whose value did not change since the last scan", "unchanged"),
    relBtn("Increased", "Keep addresses whose value went up since the last scan", "increased"),
    relBtn("Decreased", "Keep addresses whose value went down since the last scan", "decreased")
  );

  panel.append(valRow, relRow);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "cheats-scanner-reset";
  resetBtn.textContent = "New scan";
  resetBtn.addEventListener("click", () => {
    scanState = null;
    rerender();
  });
  panel.appendChild(resetBtn);

  panel.appendChild(body);
  redrawBody();
}

function renderList(candidates: Candidate[], bus: MemoryBus, host: ScannerHost): HTMLElement {
  const list = document.createElement("div");
  // `--wide` widens the grid's minmax so 8-char addresses + their row
  // controls fit one-per-line on a typical-width popover. The GB
  // scanner stays on the narrow default because its 4-char address
  // packs two rows comfortably per line.
  list.className = "cheats-scanner-list cheats-scanner-list--wide";

  for (const c of candidates) {
    const row = document.createElement("div");
    row.className = "cheats-scanner-list-row";
    const current = readAt(bus, c.addr, scanWidth);

    const addrEl = document.createElement("span");
    addrEl.className = "cheats-scanner-addr";
    addrEl.textContent = hex8(c.addr);

    const valEl = document.createElement("span");
    valEl.className = "cheats-scanner-val";
    valEl.title = `Current value at this address (decimal ${current}, hex ${hexW(current, scanWidth)})`;
    valEl.textContent = hexW(current, scanWidth);

    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.min = "0";
    targetInput.max = String(widthMax(scanWidth));
    targetInput.value = String(current);
    targetInput.className = "cheats-scanner-target";
    targetInput.title = `Value to write / freeze this address at (0-${widthMax(scanWidth)})`;

    const readTarget = (): number | null => {
      const v = parseInt(targetInput.value, 10);
      if (!Number.isFinite(v) || v < 0 || v > widthMax(scanWidth)) {
        toast(`Enter a value between 0 and ${widthMax(scanWidth)}`);
        return null;
      }
      return v & widthMax(scanWidth);
    };

    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "cheats-scanner-set";
    setBtn.textContent = "Set";
    setBtn.title = "Write the value to this address once — the game may overwrite it next frame";
    setBtn.addEventListener("click", () => {
      const v = readTarget();
      if (v === null) return;
      writeAt(bus, c.addr, v, scanWidth);
      valEl.textContent = hexW(v, scanWidth);
      c.last = v;
      toast(`${hex8(c.addr)} = ${hexW(v, scanWidth)} (${v})`);
    });

    const freezeBtn = document.createElement("button");
    freezeBtn.type = "button";
    freezeBtn.className = "cheats-scanner-add";
    freezeBtn.textContent = "Freeze";
    freezeBtn.title = "Add as a cheat — writes every frame so the game can't change it";
    freezeBtn.addEventListener("click", () => {
      const v = readTarget();
      if (v === null) return;
      void addCheatForAddress(c.addr, v, scanWidth, host);
    });

    row.append(addrEl, valEl, targetInput, setBtn, freezeBtn);
    list.appendChild(row);
  }

  return list;
}

// ── Scan engine ────────────────────────────────────────────────────

/** Snapshot EWRAM (256 KiB) + IWRAM (32 KiB) at the chosen width's
 *  alignment. Stride = width / 8; reading aligned matches what cart
 *  code actually writes, so unaligned scans would mostly capture
 *  garbage from adjacent values. */
function collectAllCandidates(bus: MemoryBus, w: GbaCheatWidth): Candidate[] {
  const stride = w / 8;
  const out: Candidate[] = [];
  for (let a = EWRAM_BASE; a < EWRAM_END; a += stride) {
    out.push({ addr: a, last: readAt(bus, a, w) });
  }
  for (let a = IWRAM_BASE; a < IWRAM_END; a += stride) {
    out.push({ addr: a, last: readAt(bus, a, w) });
  }
  return out;
}

function applyFilter(
  bus: MemoryBus,
  prev: Candidate[],
  kind: ComparisonKind,
  value: number | undefined,
  w: GbaCheatWidth
): Candidate[] {
  const out: Candidate[] = [];
  for (const c of prev) {
    const cur = readAt(bus, c.addr, w);
    let keep = false;
    switch (kind) {
      case "eq-value":
        keep = cur === value;
        break;
      case "ne-value":
        keep = cur !== value;
        break;
      case "gt-value":
        keep = cur > (value ?? 0);
        break;
      case "lt-value":
        keep = cur < (value ?? 0);
        break;
      case "changed":
        keep = cur !== c.last;
        break;
      case "unchanged":
        keep = cur === c.last;
        break;
      case "increased":
        keep = cur > c.last;
        break;
      case "decreased":
        keep = cur < c.last;
        break;
    }
    if (keep) out.push({ addr: c.addr, last: cur });
  }
  return out;
}

// ── Cheat construction ────────────────────────────────────────────

async function addCheatForAddress(addr: number, value: number, w: GbaCheatWidth, host: ScannerHost): Promise<void> {
  const gba = state.gba;
  if (!gba) return;
  const code = `${addr.toString(16).toUpperCase().padStart(8, "0")}:${value
    .toString(16)
    .toUpperCase()
    .padStart(w / 4, "0")}`;
  const decoded = decodeGbaCheat(code);
  if (!decoded) {
    errorToast("Could not build cheat code");
    return;
  }
  const entry: GbaCheatEntry = {
    id: newGbaCheatId(),
    name: `Freeze ${hex8(addr)} = ${hexW(value, w)}`,
    code: formatGbaCheat(decoded),
    enabled: true,
    address: decoded.address,
    value: decoded.value,
    width: decoded.width
  };
  gba.cheats.add(entry);
  await Cheats.saveGba(gba, gba.cheats.entries);
  toast(`Added freeze ${hex8(addr)} = ${hexW(value, w)}`);
  host.onCheatAdded();
}

function makeWidthSelector(onChange: () => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "cheats-scanner-width";
  sel.title = "Value width — most GBA values are 16 or 32-bit";
  for (const w of [8, 16, 32] as const) {
    const opt = document.createElement("option");
    opt.value = String(w);
    opt.textContent = `${w}-bit`;
    if (w === scanWidth) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const v = parseInt(sel.value, 10);
    if (v === 8 || v === 16 || v === 32) {
      scanWidth = v;
      onChange();
    }
  });
  return sel;
}

function hex8(n: number): string {
  return "$" + (n >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function hexW(n: number, w: GbaCheatWidth): string {
  return (
    "$" +
    (n >>> 0)
      .toString(16)
      .padStart(w / 4, "0")
      .toUpperCase()
  );
}
