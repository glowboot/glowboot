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

/** 8-digit hex with `$` prefix (32-bit register / GBA address). */
export function hex8(n: number): string {
  return "$" + (n >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

/** Friendly name for an ARM7TDMI mode. Returns `"???"` for reserved
 *  values so the CPU pane shows the raw 5-bit field instead of
 *  silently falling back to a misleading label. */
export function armModeName(mode: number): string {
  switch (mode & 0x1f) {
    case 0x10:
      return "USR";
    case 0x11:
      return "FIQ";
    case 0x12:
      return "IRQ";
    case 0x13:
      return "SVC";
    case 0x17:
      return "ABT";
    case 0x1b:
      return "UND";
    case 0x1f:
      return "SYS";
    default:
      return "???";
  }
}

/** HTML-escape a string before splicing it into an `innerHTML`
 *  assignment. Used by the debugger panes that build their row markup
 *  as a single concatenated HTML string for fewer DOM allocations than
 *  per-row `createElement` would cost. Symbol names come from
 *  user-uploaded `.sym` / `.map` files — a malicious file could
 *  otherwise land arbitrary markup in the panel. The five entity
 *  replacements are sufficient because the only context we splice
 *  into is element text or attribute-free content. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Human label for a Game Boy memory region (16-bit address space).
 *  Used to colour-code the Game Boy memory viewer's address gutter and
 *  — once implemented — the call-stack's return-address column. The
 *  Game Boy Advance memory pane segments the 4 GiB space differently
 *  and doesn't use this helper. */
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
