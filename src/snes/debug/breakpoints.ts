/**
 * SNES breakpoint registry. Mirrors `src/gba/debug/breakpoints.ts`
 * with 24-bit addresses (`(pbr << 16) | pc`) to fit the 65C816's
 * bank:offset program space.
 *
 * PC flavour only for now — read / write watchpoints need per-access
 * taps the SNES bus doesn't expose yet. The hit type keeps the `kind`
 * field so watchpoints can slot in without changing the UI contract.
 *
 * The engine (`Cpu65816.step`) calls the cheap `checkSnesPc` helper
 * before every opcode fetch. The fast path — no breakpoints set — is
 * a single module-boolean read.
 *
 * Hits are latched into module-scoped `lastHit`; the UI pacing loop
 * drains it via `takeSnesHit()` after each frame and auto-pauses if
 * non-null.
 *
 * Like the GB / GBA registries this is process-global. If
 * multi-instance support is ever added, it would become a per-Snes
 * field.
 */

export type SnesBreakpointKind = "pc";

export interface SnesBreakpointHit {
  kind: SnesBreakpointKind;
  addr: number;
}

const pcBps = new Set<number>();

// Plain-boolean mirror of `pcBps.size > 0`, maintained by the add /
// remove / toggle / clear mutators. `checkSnesPc` runs once per CPU
// instruction; `Set.size` is a builtin getter call while reading a
// module boolean is free (same reasoning as the GBA registry).
let anyPcBps = false;
function syncAnyFlags(): void {
  anyPcBps = pcBps.size > 0;
}

let lastHit: SnesBreakpointHit | null = null;

/**
 * When a PC breakpoint fires we want to *stop before* the instruction at
 * that address executes. But a single `Step` press is meant to walk over
 * it, otherwise the user would be stuck in a "hit → pause → step → hit
 * again" loop. `armedPc` is the address the user should be allowed to
 * pass through once. Set by `takeSnesHit` on a `pc` hit, cleared when
 * the CPU actually executes that PC.
 */
let armedPc = -1;

export function addSnesPcBreakpoint(addr: number): void {
  pcBps.add(addr & 0xffffff);
  syncAnyFlags();
}

export function removeSnesPcBreakpoint(addr: number): void {
  pcBps.delete(addr & 0xffffff);
  syncAnyFlags();
}

export function toggleSnesPcBreakpoint(addr: number): boolean {
  const a = addr & 0xffffff;
  if (pcBps.has(a)) {
    pcBps.delete(a);
    syncAnyFlags();
    return false;
  }
  pcBps.add(a);
  syncAnyFlags();
  return true;
}

export function hasSnesPcBreakpoint(addr: number): boolean {
  return pcBps.has(addr & 0xffffff);
}

export function listSnesPcBreakpoints(): number[] {
  return [...pcBps].sort((a, b) => a - b);
}

export function clearAllSnesBreakpoints(): void {
  pcBps.clear();
  syncAnyFlags();
  lastHit = null;
  armedPc = -1;
}

/**
 * Called at the top of `Cpu65816.step`. If the current PC has a
 * breakpoint AND that PC isn't the armed one (which the user is being
 * allowed through after a previous hit), latches a hit and returns
 * true — the caller should NOT execute.
 */
export function checkSnesPc(pc: number): boolean {
  if (!anyPcBps) return false;
  const a = pc & 0xffffff;
  if (a === armedPc) {
    armedPc = -1; // single-shot pass-through; next visit re-triggers
    return false;
  }
  if (pcBps.has(a)) {
    lastHit = { kind: "pc", addr: a };
    return true;
  }
  return false;
}

/** Non-destructive read — useful for the UI status bar. */
export function peekSnesHit(): SnesBreakpointHit | null {
  return lastHit;
}

/**
 * Tell the PC check to pass through this address once. Used by the
 * host's step / frame entry so resuming at a breakpointed PC advances
 * instead of re-triggering the same breakpoint and making no
 * progress.
 */
export function armSnesPassThrough(pc: number): void {
  armedPc = pc & 0xffffff;
}

/**
 * Consume the pending hit. For `pc` hits, arms the address so the next
 * visit passes through (lets the user single-step off of a breakpoint
 * without immediately re-triggering it).
 */
export function takeSnesHit(): SnesBreakpointHit | null {
  const h = lastHit;
  lastHit = null;
  if (h?.kind === "pc") armedPc = h.addr;
  return h;
}
