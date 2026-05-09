/**
 * Hex formatting helpers shared across debugger panes. Kept in one
 * module so the conventions ($-prefix, upper-case, zero-padded) stay
 * consistent across the CPU / memory / disassembly views.
 */

/** 2-digit hex with `$` prefix (byte). */
export function hex2(n: number): string {
  return "$" + (n & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

/** 4-digit hex with `$` prefix (word). */
export function hex4(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

/** Human label for a memory region. Used to colour-code the memory
 *  viewer's address gutter and — once implemented — the call-stack's
 *  return-address column. */
export function regionOf(addr: number): string {
  if (addr < 0x4000) return "ROM0";
  if (addr < 0x8000) return "ROMX";
  if (addr < 0xa000) return "VRAM";
  if (addr < 0xc000) return "SRAM";
  if (addr < 0xd000) return "WRAM0";
  if (addr < 0xe000) return "WRAMX";
  if (addr < 0xfe00) return "ECHO";
  if (addr < 0xfea0) return "OAM";
  if (addr < 0xff00) return "";
  if (addr < 0xff80) return "IO";
  if (addr < 0xffff) return "HRAM";
  return "IE";
}
