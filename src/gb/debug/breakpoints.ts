/**
 * Breakpoint / watchpoint registry for the debugger.
 *
 * Three flavors:
 *   - **pc**     fires when the CPU is about to execute the instruction
 *                at a given address (check happens before the fetch so
 *                the stopped-state PC equals the breakpoint address)
 *   - **read**   fires when the CPU reads the given memory address
 *   - **write**  fires when the CPU writes the given memory address
 *
 * The engine (CPU.step + runFrame + MMU.readByte/writeByte) calls the
 * cheap `check*` helpers on every access. The fast path — no entries
 * in the relevant set — is a single `Set.size === 0` check. Hits are
 * latched into module-scoped `lastHit`; the UI pacing loop drains it
 * via `takeHit()` after each frame and auto-pauses if non-null.
 *
 * The registry is process-global (one Game Boy at a time), which fits
 * the current architecture. If multi-instance support is ever added,
 * this would become a per-GameBoy instance.
 */

type BreakpointKind = "pc" | "read" | "write";

export interface BreakpointHit {
  kind: BreakpointKind;
  addr: number;
}

const pcBps = new Set<number>();
const readWps = new Set<number>();
const writeWps = new Set<number>();

let lastHit: BreakpointHit | null = null;

/**
 * When a PC breakpoint fires we want to *stop before* the instruction at
 * that address executes. But a single `Step` press is meant to walk over
 * it, otherwise the user would be stuck in a "hit → pause → step → hit
 * again" loop. `armedPc` is the address the user should be allowed to
 * pass through once. Set by `takeHit` on a `pc` hit, cleared when the
 * CPU actually executes that PC.
 */
let armedPc = -1;

export function addPcBreakpoint(addr: number): void {
  pcBps.add(addr & 0xffff);
}

export function removePcBreakpoint(addr: number): void {
  pcBps.delete(addr & 0xffff);
}

export function togglePcBreakpoint(addr: number): boolean {
  const a = addr & 0xffff;
  if (pcBps.has(a)) {
    pcBps.delete(a);
    return false;
  }
  pcBps.add(a);
  return true;
}

export function hasPcBreakpoint(addr: number): boolean {
  return pcBps.has(addr & 0xffff);
}

export function listPcBreakpoints(): number[] {
  return [...pcBps].sort((a, b) => a - b);
}

export function addReadWatchpoint(addr: number): void {
  readWps.add(addr & 0xffff);
}

export function removeReadWatchpoint(addr: number): void {
  readWps.delete(addr & 0xffff);
}

export function hasReadWatchpoint(addr: number): boolean {
  return readWps.has(addr & 0xffff);
}

export function listReadWatchpoints(): number[] {
  return [...readWps].sort((a, b) => a - b);
}

export function addWriteWatchpoint(addr: number): void {
  writeWps.add(addr & 0xffff);
}

export function removeWriteWatchpoint(addr: number): void {
  writeWps.delete(addr & 0xffff);
}

export function hasWriteWatchpoint(addr: number): boolean {
  return writeWps.has(addr & 0xffff);
}

export function listWriteWatchpoints(): number[] {
  return [...writeWps].sort((a, b) => a - b);
}

export function clearAll(): void {
  pcBps.clear();
  readWps.clear();
  writeWps.clear();
  lastHit = null;
  armedPc = -1;
}

/**
 * Called at the top of `CPU.step`. If the current PC has a breakpoint
 * AND that PC isn't the armed one (which the user is being allowed
 * through after a previous hit), latches a hit and returns true — the
 * caller should NOT execute.
 */
export function checkPc(pc: number): boolean {
  if (pcBps.size === 0) return false;
  const a = pc & 0xffff;
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

export function checkRead(addr: number): void {
  if (readWps.size === 0) return;
  const a = addr & 0xffff;
  if (readWps.has(a)) lastHit = { kind: "read", addr: a };
}

export function checkWrite(addr: number): void {
  if (writeWps.size === 0) return;
  const a = addr & 0xffff;
  if (writeWps.has(a)) lastHit = { kind: "write", addr: a };
}

/** Non-destructive read — useful for the UI status bar. */
export function peekHit(): BreakpointHit | null {
  return lastHit;
}

/**
 * Tell the PC check to pass through this address once. Used by
 * `stepInstruction` so a Step press at a breakpointed PC advances
 * instead of re-triggering the same breakpoint and making no
 * progress.
 */
export function armPassThrough(pc: number): void {
  armedPc = pc & 0xffff;
}

/**
 * Consume the pending hit. For `pc` hits, arms the address so the next
 * visit passes through (lets the user single-step off of a breakpoint
 * without immediately re-triggering it).
 */
export function takeHit(): BreakpointHit | null {
  const h = lastHit;
  lastHit = null;
  if (h?.kind === "pc") armedPc = h.addr;
  return h;
}
