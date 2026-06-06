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

/** Parser for GBA .cht files (libretro's GBA directory, all in
 *  CodeBreaker format).
 *
 *  GB's `parseCht` above splits the code string on `+` because GB
 *  cheats use `+` to chain MULTIPLE Game Genie / Game Shark codes
 *  inside one cheat. GBA's CodeBreaker format uses `+` to separate
 *  the op1 and op2 halves of a SINGLE code — so a naive `+`-split
 *  produces "AAAAAAAA" and "VVVV" fragments that neither half can
 *  decode as a full code.
 *
 *  Correct rule for GBA: strip every separator, chunk the resulting
 *  hex string into 12-character blocks (8 hex for op1 + 4 hex for
 *  op2). One block = one CodeBreaker code. Cheats with N blocks
 *  emit N ParsedCheat entries (a "Cheat (1)", "Cheat (2)" suffix
 *  pattern, mirroring the GB parser's multi-part handling). */
export function parseGbaCht(text: string): ParsedCheat[] {
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
    const raw = codes.get(idx);
    if (!raw) continue;
    const baseName = descs.get(idx)?.trim() || `Cheat ${idx}`;
    // Strip every non-hex separator, then chunk into 12-char codes.
    const clean = raw.replace(/0x/gi, "").replace(/[^0-9A-Fa-f]/g, "");
    if (clean.length % 12 !== 0 || clean.length === 0) {
      // Malformed (or a format we don't recognise) — pass the raw
      // string through; the decoder will null it and the importer
      // counts it as a skip with a console warning.
      out.push({ name: baseName, code: raw });
      continue;
    }
    const blockCount = clean.length / 12;
    for (let i = 0; i < blockCount; i++) {
      const block = clean.slice(i * 12, (i + 1) * 12);
      const name = blockCount === 1 ? baseName : `${baseName} (${i + 1})`;
      out.push({ name, code: block });
    }
  }
  return out;
}
