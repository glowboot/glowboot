/**
 * Parser for the libretro-database .cht cheat file format.
 *
 * Example input:
 *
 *     cheats = 2
 *
 *     cheat0_desc = "Infinite Lives"
 *     cheat0_code = "010A17DA"
 *     cheat0_enable = false
 *
 *     cheat1_desc = "Max Score"
 *     cheat1_code = "00D3-DC-098+00F3-DC-098"
 *     cheat1_enable = false
 *
 * Each entry carries a single display name and a single code string. Multi-
 * part cheats (codes joined by '+' in the source) are split into one entry
 * per component so the downstream engine (which stores one code per entry)
 * can handle them — users re-enable the group together in the UI.
 */

export interface ParsedCheat {
  name: string;
  code: string;
}

const LINE_RE = /^cheat(\d+)_(desc|code)\s*=\s*"(.*)"\s*$/;

export function parseCht(text: string): ParsedCheat[] {
  const descs = new Map<number, string>();
  const codes = new Map<number, string>();

  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(LINE_RE);
    if (!m) continue;
    const idx = Number(m[1]);
    const field = m[2];
    const value = m[3] ?? "";
    if (field === "desc") descs.set(idx, value);
    else if (field === "code") codes.set(idx, value);
  }

  const out: ParsedCheat[] = [];
  const indices = [...codes.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const code = codes.get(idx);
    if (!code) continue;
    const baseName = descs.get(idx)?.trim() || `Cheat ${idx}`;
    const parts = code
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      out.push({ name: baseName, code: parts[0] ?? code });
    } else {
      parts.forEach((c, i) => out.push({ name: `${baseName} (${i + 1})`, code: c }));
    }
  }
  return out;
}
