/**
 * GBA breakpoint / watchpoint registry. Mirrors `src/gb/debug/breakpoints.ts`
 * with 32-bit addresses to fit the GBA memory map.
 *
 * Three flavours:
 *   - **pc**     fires when the CPU is about to execute the instruction
 *                at a given address (check happens before the fetch so
 *                the stopped-state PC equals the breakpoint address)
 *   - **read**   fires when the CPU reads the given memory address
 *   - **write**  fires when the CPU writes the given memory address
 *
 * Read / write match on the access's base address only — a watchpoint
 * at 0x02001000 fires on any of read8 / read16 / read32 starting at
 * that address. Multi-byte accesses don't "splash" onto adjacent
 * watchpoints; users who want byte-granular coverage set multiple
 * watchpoints. Matches the GB-side convention and keeps the hot
 * check a single `Set.has` per access.
 *
 * The engine (CPU.step + bus reads / writes) calls the cheap `check*`
 * helpers on every access. The fast path — no entries in the relevant
 * set — is a single `Set.size === 0` check.
 *
 * Hits are latched into module-scoped `lastHit`; the UI pacing loop
 * drains it via `takeHit()` after each frame and auto-pauses if
 * non-null.
 *
 * Like the GB registry this is process-global. If multi-instance
 * support is ever added, it would become a per-Gba field.
 */

export type GbaBreakpointKind = "pc" | "read" | "write";

export interface GbaBreakpointHit {
  kind: GbaBreakpointKind;
  addr: number;
}

const pcBps = new Set<number>();
const readWps = new Set<number>();
const writeWps = new Set<number>();

let lastHit: GbaBreakpointHit | null = null;

/**
 * When a PC breakpoint fires we want to *stop before* the instruction at
 * that address executes. But a single `Step` press is meant to walk over
 * it, otherwise the user would be stuck in a "hit → pause → step → hit
 * again" loop. `armedPc` is the address the user should be allowed to
 * pass through once. Set by `takeGbaHit` on a `pc` hit, cleared when
 * the CPU actually executes that PC.
 */
let armedPc = -1;

export function addGbaPcBreakpoint(addr: number): void {
  pcBps.add(addr >>> 0);
}

export function removeGbaPcBreakpoint(addr: number): void {
  pcBps.delete(addr >>> 0);
}

export function toggleGbaPcBreakpoint(addr: number): boolean {
  const a = addr >>> 0;
  if (pcBps.has(a)) {
    pcBps.delete(a);
    return false;
  }
  pcBps.add(a);
  return true;
}

export function hasGbaPcBreakpoint(addr: number): boolean {
  return pcBps.has(addr >>> 0);
}

export function listGbaPcBreakpoints(): number[] {
  return [...pcBps].sort((a, b) => a - b);
}

export function addGbaReadWatchpoint(addr: number): void {
  readWps.add(addr >>> 0);
}

export function removeGbaReadWatchpoint(addr: number): void {
  readWps.delete(addr >>> 0);
}

export function hasGbaReadWatchpoint(addr: number): boolean {
  return readWps.has(addr >>> 0);
}

export function listGbaReadWatchpoints(): number[] {
  return [...readWps].sort((a, b) => a - b);
}

export function addGbaWriteWatchpoint(addr: number): void {
  writeWps.add(addr >>> 0);
}

export function removeGbaWriteWatchpoint(addr: number): void {
  writeWps.delete(addr >>> 0);
}

export function hasGbaWriteWatchpoint(addr: number): boolean {
  return writeWps.has(addr >>> 0);
}

export function listGbaWriteWatchpoints(): number[] {
  return [...writeWps].sort((a, b) => a - b);
}

export function clearAllGbaBreakpoints(): void {
  pcBps.clear();
  readWps.clear();
  writeWps.clear();
  lastHit = null;
  armedPc = -1;
}

/**
 * Called at the top of `ArmCpu.step`. If the current PC has a
 * breakpoint AND that PC isn't the armed one (which the user is being
 * allowed through after a previous hit), latches a hit and returns
 * true — the caller should NOT execute.
 */
export function checkGbaPc(pc: number): boolean {
  if (pcBps.size === 0) return false;
  const a = pc >>> 0;
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

export function checkGbaRead(addr: number): void {
  if (readWps.size === 0) return;
  const a = addr >>> 0;
  if (readWps.has(a)) lastHit = { kind: "read", addr: a };
}

export function checkGbaWrite(addr: number): void {
  if (writeWps.size === 0) return;
  const a = addr >>> 0;
  if (writeWps.has(a)) lastHit = { kind: "write", addr: a };
}

/** Non-destructive read — useful for the UI status bar. */
export function peekGbaHit(): GbaBreakpointHit | null {
  return lastHit;
}

/**
 * Tell the PC check to pass through this address once. Used by
 * `stepInstruction` so a Step press at a breakpointed PC advances
 * instead of re-triggering the same breakpoint and making no
 * progress.
 */
export function armGbaPassThrough(pc: number): void {
  armedPc = pc >>> 0;
}

/**
 * Consume the pending hit. For `pc` hits, arms the address so the next
 * visit passes through (lets the user single-step off of a breakpoint
 * without immediately re-triggering it).
 */
export function takeGbaHit(): GbaBreakpointHit | null {
  const h = lastHit;
  lastHit = null;
  if (h?.kind === "pc") armedPc = h.addr;
  return h;
}
