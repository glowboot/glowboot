import { type CheatEntry, decodeCheat, formatCode, type MMU, newCheatId } from "../../gb";
import { errorToast, toast } from "../hud/toast.js";
import * as Cheats from "../persistence/cheats.js";
import { state } from "../state.js";

/**
 * Game Shark-style memory scanner. Lets the user narrow down the
 * address of a game value (health, lives, coins, boss HP, timers) by
 * repeatedly filtering a snapshot of RAM.
 *
 * Two ways to start:
 *   - "Scan = N" — you can see the value in-game; the scanner keeps
 *     every address that currently holds N.
 *   - "Scan (unknown)" — you can't see the value (boss HP, RNG seed);
 *     the scanner snapshots every address. Use relative filters
 *     (Changed / Increased / Decreased) as the value moves.
 *
 * State is in-memory only — lives on the module while the tab stays
 * open; cleared automatically on cart switch. Memory coverage: cart
 * RAM ($A000-$BFFF), WRAM bank 0 ($C000-$CFFF), the currently-mapped
 * WRAM bank ($D000-$DFFF) on CGB, and HRAM ($FF80-$FFFE). A CGB game
 * that parks the value in an unmapped bank can briefly hide it from
 * the scanner; filter again when the bank is back.
 */

/** Per-candidate entry: address + the byte we last observed there. */
type Candidate = { addr: number; last: number };

const CANDIDATE_LIMIT_TO_LIST = 50;

type ValueComparison = "eq-value" | "ne-value" | "gt-value" | "lt-value";
type RelativeComparison = "changed" | "unchanged" | "increased" | "decreased";
type ComparisonKind = ValueComparison | RelativeComparison;

export interface ScannerHost {
  onCheatAdded(): void;
}

let scanState: Candidate[] | null = null;
let scanCartId: string | null = null;

export function renderScanner(parent: HTMLElement, host: ScannerHost): void {
  const gb = state.gb;
  if (!gb) return;

  const currentId = gb.cart.title + "|" + gb.cart.globalChecksum;
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
    renderIdle(panel, () => renderScanner(parent, host));
  } else {
    renderActive(panel, host, () => renderScanner(parent, host));
  }

  parent.appendChild(panel);
}

function renderIdle(panel: HTMLElement, rerender: () => void): void {
  const mmu = state.gb?.mmu;
  if (!mmu) return;

  const form = document.createElement("form");
  form.className = "cheats-scanner-row";

  const label = document.createElement("span");
  label.textContent = "Start with value";
  label.className = "cheats-scanner-label";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.min = "0";
  valueInput.max = "255";
  valueInput.placeholder = "e.g. 3";
  valueInput.className = "cheats-scanner-value";

  const startBtn = document.createElement("button");
  startBtn.type = "submit";
  startBtn.className = "cheats-scanner-btn";
  startBtn.textContent = "Scan";

  const unknownBtn = document.createElement("button");
  unknownBtn.type = "button";
  unknownBtn.className = "cheats-scanner-btn cheats-scanner-btn-alt";
  unknownBtn.textContent = "Scan (unknown)";
  unknownBtn.title = "Snapshot every byte. Use Changed / Increased / Decreased after the value moves in-game.";

  form.append(label, valueInput, startBtn, unknownBtn);
  panel.appendChild(form);

  const hint = document.createElement("div");
  hint.className = "cheats-scanner-hint";
  hint.textContent =
    "Enter a value you can see in-game (lives, coins, HP) and click Scan. " +
    "If the value is hidden, click Scan (unknown) and narrow via Changed / Increased / Decreased.";
  panel.appendChild(hint);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = parseInt(valueInput.value, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) {
      toast("Enter a value between 0 and 255");
      return;
    }
    scanState = collectAllCandidates(mmu).filter((c) => c.last === (v & 0xff));
    toast(`${scanState.length.toLocaleString()} candidates`);
    rerender();
  });

  unknownBtn.addEventListener("click", () => {
    scanState = collectAllCandidates(mmu);
    toast(`${scanState.length.toLocaleString()} candidates`);
    rerender();
  });
}

function renderActive(panel: HTMLElement, host: ScannerHost, rerender: () => void): void {
  const mmu = state.gb?.mmu;
  if (!mmu) return;

  // Status line — updated in place on every filter action so the filter
  // bar itself (and the user's typed value) stays untouched.
  const status = document.createElement("div");
  status.className = "cheats-scanner-status";
  panel.appendChild(status);

  // Relative filters (no value input — compare vs. previous snapshot).
  const relRow = document.createElement("div");
  relRow.className = "cheats-scanner-filters";

  // Value filters (share one input on the left).
  const valRow = document.createElement("form");
  valRow.className = "cheats-scanner-filters";
  const sharedValueInput = document.createElement("input");
  sharedValueInput.type = "number";
  sharedValueInput.min = "0";
  sharedValueInput.max = "255";
  sharedValueInput.className = "cheats-scanner-value";
  sharedValueInput.placeholder = "value";
  sharedValueInput.title = "Compare candidates' current bytes against this value (Enter applies =)";
  valRow.appendChild(sharedValueInput);

  // Container that re-renders on filter click (status + list), while
  // the filter bar stays put so typed values survive.
  const body = document.createElement("div");

  const redrawBody = (): void => {
    const candidates = scanState ?? [];
    status.textContent = `${candidates.length.toLocaleString()} candidate${candidates.length === 1 ? "" : "s"}`;
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
    body.appendChild(renderList(candidates, mmu, host));
  };

  const runFilter = (kind: ComparisonKind, value?: number): void => {
    if (!scanState) return;
    scanState = applyFilter(mmu, scanState, kind, value);
    redrawBody();
  };

  const readSharedValue = (): number | null => {
    const v = parseInt(sharedValueInput.value, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) {
      toast("Enter a value between 0 and 255");
      return null;
    }
    return v & 0xff;
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
    valBtn("= N", "Keep addresses whose current byte equals the value on the left", "eq-value"),
    valBtn("≠ N", "Keep addresses whose current byte is not the value on the left", "ne-value"),
    valBtn(">", "Keep addresses whose byte is greater than the value on the left", "gt-value"),
    valBtn("<", "Keep addresses whose byte is less than the value on the left", "lt-value")
  );
  // Enter in the shared value input applies `= N` (the most common
  // action) — saves a click when iterating through visible values.
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
    relBtn("Changed", "Keep addresses whose byte changed since the last scan", "changed"),
    relBtn("Unchanged", "Keep addresses whose byte did not change since the last scan", "unchanged"),
    relBtn("Increased", "Keep addresses whose byte went up since the last scan", "increased"),
    relBtn("Decreased", "Keep addresses whose byte went down since the last scan", "decreased")
  );

  panel.append(valRow, relRow);

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "cheats-scanner-reset";
  resetBtn.textContent = "New scan";
  resetBtn.addEventListener("click", () => {
    scanState = null;
    rerender(); // falls back to the idle form
  });
  panel.appendChild(resetBtn);

  panel.appendChild(body);

  // Initial paint of status + list.
  redrawBody();
}

function renderList(candidates: Candidate[], mmu: MMU, host: ScannerHost): HTMLElement {
  const list = document.createElement("div");
  list.className = "cheats-scanner-list";

  for (const c of candidates) {
    const row = document.createElement("div");
    row.className = "cheats-scanner-list-row";
    const current = mmu.readByte(c.addr);

    const addrEl = document.createElement("span");
    addrEl.className = "cheats-scanner-addr";
    addrEl.textContent = hex4(c.addr);

    const valEl = document.createElement("span");
    valEl.className = "cheats-scanner-val";
    valEl.title = `Current value at this address (decimal ${current}, hex ${hex2(current)})`;
    valEl.textContent = hex2(current);

    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.min = "0";
    targetInput.max = "255";
    targetInput.value = String(current);
    targetInput.className = "cheats-scanner-target";
    targetInput.title = "Value to write / freeze this address at (0-255)";

    const readTarget = (): number | null => {
      const v = parseInt(targetInput.value, 10);
      if (!Number.isFinite(v) || v < 0 || v > 255) {
        toast("Enter a value between 0 and 255");
        return null;
      }
      return v & 0xff;
    };

    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "cheats-scanner-set";
    setBtn.textContent = "Set";
    setBtn.title = "Write the value to this address once — the game may overwrite it next frame";
    setBtn.addEventListener("click", () => {
      const v = readTarget();
      if (v === null) return;
      mmu.writeByte(c.addr, v);
      valEl.textContent = hex2(v);
      c.last = v;
      toast(`${hex4(c.addr)} = ${hex2(v)} (${v})`);
    });

    const freezeBtn = document.createElement("button");
    freezeBtn.type = "button";
    freezeBtn.className = "cheats-scanner-add";
    freezeBtn.textContent = "Freeze";
    freezeBtn.title = "Add as a Game Shark cheat — writes every frame so the game can't change it";
    freezeBtn.addEventListener("click", () => {
      const v = readTarget();
      if (v === null) return;
      void addCheatForAddress(c.addr, v, host);
    });

    row.append(addrEl, valEl, targetInput, setBtn, freezeBtn);
    list.appendChild(row);
  }

  return list;
}

// ── Scan engine ────────────────────────────────────────────────────

/** Snapshot every scannable byte: cart RAM, WRAM bank 0, the currently-
 *  mapped WRAM bank on CGB, and HRAM. ~10 KB per pass — fast. */
function collectAllCandidates(mmu: MMU): Candidate[] {
  const out: Candidate[] = [];
  for (let a = 0xa000; a <= 0xdfff; a++) {
    out.push({ addr: a, last: mmu.readByte(a) });
  }
  for (let a = 0xff80; a <= 0xfffe; a++) {
    out.push({ addr: a, last: mmu.readByte(a) });
  }
  return out;
}

function applyFilter(mmu: MMU, prev: Candidate[], kind: ComparisonKind, value?: number): Candidate[] {
  const out: Candidate[] = [];
  for (const c of prev) {
    const cur = mmu.readByte(c.addr);
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

async function addCheatForAddress(addr: number, value: number, host: ScannerHost): Promise<void> {
  const gb = state.gb;
  if (!gb) return;
  const code = (
    "01" +
    value.toString(16).padStart(2, "0") +
    (addr & 0xff).toString(16).padStart(2, "0") +
    ((addr >> 8) & 0xff).toString(16).padStart(2, "0")
  ).toUpperCase();
  const decoded = decodeCheat(code);
  if (!decoded) {
    errorToast("Could not build cheat code");
    return;
  }
  const entry: CheatEntry = {
    id: newCheatId(),
    name: `Freeze ${hex4(addr)} = ${hex2(value)}`,
    code: formatCode(code),
    format: decoded.format,
    enabled: true,
    address: decoded.address,
    value: decoded.value
  };
  gb.cheats.add(entry);
  await Cheats.save(gb.cart, gb.cheats.entries);
  toast(`Added freeze ${hex4(addr)} = ${hex2(value)}`);
  host.onCheatAdded();
}

function hex2(n: number): string {
  return "$" + n.toString(16).padStart(2, "0").toUpperCase();
}

function hex4(n: number): string {
  return "$" + n.toString(16).padStart(4, "0").toUpperCase();
}
