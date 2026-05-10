/**
 * Test-ROM harness — runs Game Boy test ROMs (Blargg / Mooneye / acid2 / etc.)
 * against the in-tree emulator and reports pass / fail. Not part of the
 * regular `npm test` chain; invoke via `npm run test:roms`.
 *
 * Test ROMs themselves live under `test-roms/` (gitignored) — fetch from
 *   https://github.com/c-sp/game-boy-test-roms/releases (latest .zip)
 *
 * Detection covers three protocols:
 *   1. Blargg — ASCII via serial; success = collected text contains
 *      "Passed", failure = "Failed".
 *   2. Mooneye — 6 magic bytes via serial after the test ends. Pass tail
 *      = [3, 5, 8, 13, 21, 34] (Fibonacci); fail = six 0x42's.
 *   3. Framebuffer — for screen-only tests (acid2, mealybug-tearoom-tests,
 *      etc.). After running for a fixed frame count, the rendered
 *      framebuffer is compared byte-for-byte to a reference PNG bundled
 *      with the test ROM. Used for tests in `SCREEN_TESTS` below.
 *
 * For DMG-cart-on-CGB-host tests (e.g. dmg-acid2), the reference PNG was
 * produced with a specific compat palette (see dmg-acid2's howto). We
 * install the matching shades via `setDmgCompatPalette` before running so
 * the framebuffer hashes line up.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

import { GameBoy } from "../src/gb/gameboy.js";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/gb/ppu/ppu.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_ROMS_DIR = resolve(ROOT, "test-roms");

const MAX_FRAMES_SERIAL = 60 * 20; // 20s at 60fps. Slowest passing Blargg test takes ~600 frames; tests that haven't completed by then are either screen-only or hung.
const FAIL_PREVIEW_LIMIT = 200;

// ─── Palette overrides for screen-only tests ──────────────────────────────────
// AABBGGRR layout — same as the framebuffer's u32 view. Colour 0 is the
// lightest shade, colour 3 the darkest, matching Glowboot's shade-table
// indexing.

// dmg-acid2 howto:
//   "LCD shades for CGB compatibility mode are:
//    - background: #000000, #0063C6, #7BFF31 and #FFFFFF
//    - objects:    #000000, #943939, #FF8484 and #FFFFFF"
const ACID2_CGB_BG = [0xffffffff, 0xff31ff7b, 0xffc66300, 0xff000000];
const ACID2_CGB_OBP = [0xffffffff, 0xff8484ff, 0xff393994, 0xff000000];

// Bully / Mealybug etc. — straight DMG grayscale per their howtos:
//   "#000000, #555555, #AAAAAA and #FFFFFF are used for the four DMG LCD shades"
const DMG_GRAY_BG = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];
const DMG_GRAY_OBP = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];

// ─── Screen-only test configs ────────────────────────────────────────────────
interface ScreenTest {
  romPath: string; // path under test-roms/
  refPng: string; // path under test-roms/
  palette?: { bg: number[]; obp0: number[]; obp1: number[] };
  frames: number;
}

// Discover Gambatte tests with CGB reference PNGs. Naming convention:
// `{stem}.gbc` paired with `{stem}_cgb04c.png` (CGB-CPU-04 revision C).
// Gambatte tests run for 15 LCD frames per the howto. Many gambatte
// ROMs use a hex-pattern or audio-output protocol instead of a PNG;
// those don't have a `_cgb04c.png` and get added to the skip set below.
function discoverGambatteTests(): ScreenTest[] {
  const root = resolve(TEST_ROMS_DIR, "gambatte");
  if (!existsSync(root)) return [];
  const tests: ScreenTest[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".gb") || entry.endsWith(".gbc")) {
        const stem = entry.replace(/\.(gb|gbc)$/, "");
        const dirRel = relative(TEST_ROMS_DIR, dir);
        const ref = join(dirRel, `${stem}_cgb04c.png`);
        if (existsSync(resolve(TEST_ROMS_DIR, ref))) {
          tests.push({
            romPath: join(dirRel, entry),
            refPng: ref,
            palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
            frames: 15
          });
        }
      }
    }
  };
  walk(root);
  return tests;
}

// Discover mealybug-tearoom-tests automatically. Each .gb ROM has a
// matching reference PNG with `_cgb_d` (CGB-D revision, our preference)
// or `_cgb_c` (CGB-C, fallback) suffix. We always compare against CGB
// references because Glowboot presents as CGB; DMG-only references with
// `_dmg_blob` suffix are skipped.
function discoverMealybugTests(): ScreenTest[] {
  const root = resolve(TEST_ROMS_DIR, "mealybug-tearoom-tests");
  if (!existsSync(root)) return [];
  const tests: ScreenTest[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(entry) === ".gb") {
        const stem = entry.slice(0, -3);
        const dirRel = relative(TEST_ROMS_DIR, dir);
        const refD = join(dirRel, `${stem}_cgb_d.png`);
        const refC = join(dirRel, `${stem}_cgb_c.png`);
        const ref = existsSync(resolve(TEST_ROMS_DIR, refD))
          ? refD
          : existsSync(resolve(TEST_ROMS_DIR, refC))
            ? refC
            : null;
        if (ref) {
          tests.push({
            romPath: join(dirRel, entry),
            refPng: ref,
            palette: { bg: ACID2_CGB_BG, obp0: ACID2_CGB_OBP, obp1: ACID2_CGB_OBP },
            frames: 60
          });
        }
      }
    }
  };
  walk(root);
  return tests;
}

const SCREEN_TESTS: ScreenTest[] = [
  {
    romPath: "dmg-acid2/dmg-acid2.gb",
    refPng: "dmg-acid2/dmg-acid2-cgb.png",
    palette: { bg: ACID2_CGB_BG, obp0: ACID2_CGB_OBP, obp1: ACID2_CGB_OBP },
    frames: 60
  },
  {
    romPath: "cgb-acid2/cgb-acid2.gbc",
    refPng: "cgb-acid2/cgb-acid2.png",
    frames: 60
  },
  {
    romPath: "cgb-acid-hell/cgb-acid-hell.gbc",
    refPng: "cgb-acid-hell/cgb-acid-hell.png",
    frames: 60
  },
  {
    romPath: "bully/bully.gb",
    refPng: "bully/bully.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 60
  },
  // Hacktix small framebuffer-comparison tests
  {
    romPath: "scribbltests/lycscx/lycscx.gb",
    refPng: "scribbltests/lycscx/lycscx-cgb-dmg.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "scribbltests/lycscy/lycscy.gb",
    refPng: "scribbltests/lycscy/lycscy-cgb-dmg.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "scribbltests/palettely/palettely.gb",
    refPng: "scribbltests/palettely/palettely-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "scribbltests/scxly/scxly.gb",
    refPng: "scribbltests/scxly/scxly-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "scribbltests/statcount/statcount-auto.gb",
    refPng: "scribbltests/statcount/statcount_auto-cgb-dmg.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 300
  },
  {
    romPath: "strikethrough/strikethrough.gb",
    refPng: "strikethrough/strikethrough-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "turtle-tests/window_y_trigger/window_y_trigger.gb",
    refPng: "turtle-tests/window_y_trigger/window_y_trigger.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "turtle-tests/window_y_trigger_wx_offscreen/window_y_trigger_wx_offscreen.gb",
    refPng: "turtle-tests/window_y_trigger_wx_offscreen/window_y_trigger_wx_offscreen.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "little-things-gb/firstwhite.gb",
    refPng: "little-things-gb/firstwhite-dmg-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 30
  },
  {
    romPath: "little-things-gb/tellinglys.gb",
    refPng: "little-things-gb/tellinglys-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 60
  },
  {
    romPath: "mbc3-tester/mbc3-tester.gb",
    refPng: "mbc3-tester/mbc3-tester-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 60
  },
  // Blargg screen-only tests — the c-sp release ships a reference PNG of
  // the post-completion screen for each parent ROM. Frame counts come
  // from the howto's "emulated seconds" table; we add ~50 % headroom so
  // the on-screen text has settled by the time we hash. Subtests under
  // `*/rom_singles` and `*/individual` don't have reference PNGs and
  // continue to be run via serial detection (where they have it).
  {
    romPath: "blargg/halt_bug.gb",
    refPng: "blargg/halt_bug-dmg-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 240
  },
  {
    romPath: "blargg/interrupt_time/interrupt_time.gb",
    refPng: "blargg/interrupt_time/interrupt_time-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 240
  },
  {
    romPath: "blargg/mem_timing-2/mem_timing.gb",
    refPng: "blargg/mem_timing-2/mem_timing-dmg-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 360
  },
  {
    romPath: "blargg/cgb_sound/cgb_sound.gb",
    refPng: "blargg/cgb_sound/cgb_sound-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 2400
  },
  {
    romPath: "blargg/dmg_sound/dmg_sound.gb",
    refPng: "blargg/dmg_sound/dmg_sound-dmg.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 2400
  },
  {
    romPath: "blargg/oam_bug/oam_bug.gb",
    refPng: "blargg/oam_bug/oam_bug-cgb.png",
    palette: { bg: DMG_GRAY_BG, obp0: DMG_GRAY_OBP, obp1: DMG_GRAY_OBP },
    frames: 240
  },
  ...discoverMealybugTests(),
  ...discoverGambatteTests()
];

const SCREEN_BY_ROM = new Map<string, ScreenTest>();
for (const t of SCREEN_TESTS) SCREEN_BY_ROM.set(t.romPath, t);

type Outcome = {
  name: string;
  status: "pass" | "fail" | "timeout" | "skip";
  detail: string;
  frames: number;
};

// ROMs we can't classify and that should be skipped rather than fall
// through to a serial-detection timeout. Populated by the indexers below.
const SKIP_ROMS = new Map<string, string>(); // path → reason

function indexMealybugSkips(): void {
  const root = resolve(TEST_ROMS_DIR, "mealybug-tearoom-tests");
  if (!existsSync(root)) return;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(entry) === ".gb") {
        const stem = entry.slice(0, -3);
        const dirRel = relative(TEST_ROMS_DIR, dir);
        const refD = resolve(TEST_ROMS_DIR, dirRel, `${stem}_cgb_d.png`);
        const refC = resolve(TEST_ROMS_DIR, dirRel, `${stem}_cgb_c.png`);
        const hasRef = existsSync(refD) || existsSync(refC);
        // Mealybug PPU tests are screenshot tests; if no CGB reference
        // exists for one (whether it has a DMG-only reference or no
        // reference at all), we can't compare it on our CGB-host.
        // Mealybug `dma/` + `mbc/` ROMs are serial tests instead, so
        // restrict the skip rule to the `ppu/` subdirectory.
        const isPpu = dirRel.endsWith("ppu") || dirRel.endsWith("ppu/");
        if (!hasRef && isPpu) SKIP_ROMS.set(join(dirRel, entry), "no CGB reference PNG bundled");
      }
    }
  };
  walk(root);
}
indexMealybugSkips();

// Gambatte ROMs that don't have a CGB reference PNG use the hex-pattern
// or audio-output protocol — we don't decode either, so skip them.
function indexGambatteSkips(): void {
  const root = resolve(TEST_ROMS_DIR, "gambatte");
  if (!existsSync(root)) return;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".gb") || entry.endsWith(".gbc")) {
        const stem = entry.replace(/\.(gb|gbc)$/, "");
        const dirRel = relative(TEST_ROMS_DIR, dir);
        const ref = resolve(TEST_ROMS_DIR, dirRel, `${stem}_cgb04c.png`);
        if (!existsSync(ref)) {
          SKIP_ROMS.set(join(dirRel, entry), "Gambatte hex-pattern / audio-output protocol — not yet supported");
        }
      }
    }
  };
  walk(root);
}
indexGambatteSkips();

function findRoms(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (extname(entry).toLowerCase() === ".gb" || extname(entry).toLowerCase() === ".gbc") out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const MOONEYE_PASS = [3, 5, 8, 13, 21, 34];

function tailMatches(buf: number[], expected: number[]): boolean {
  if (buf.length < expected.length) return false;
  const start = buf.length - expected.length;
  for (let i = 0; i < expected.length; i++) {
    if (buf[start + i] !== expected[i]) return false;
  }
  return true;
}

function loadReferencePng(absPath: string): Uint8Array {
  const png = PNG.sync.read(readFileSync(absPath));
  if (png.width !== SCREEN_WIDTH || png.height !== SCREEN_HEIGHT) {
    throw new Error(
      `reference PNG ${absPath} is ${png.width}×${png.height}, expected ${SCREEN_WIDTH}×${SCREEN_HEIGHT}`
    );
  }
  return new Uint8Array(png.data);
}

function diffPixels(a: Uint8Array, b: Uint8Array): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  }
  return diff;
}

function runFramebufferTest(romPath: string, cfg: ScreenTest, name: string): Outcome {
  const bytes = new Uint8Array(readFileSync(romPath));
  const gb = new GameBoy(bytes);
  if (cfg.palette) gb.ppu.setDmgCompatPalette(cfg.palette.bg, cfg.palette.obp0, cfg.palette.obp1);
  for (let f = 0; f < cfg.frames; f++) gb.runFrame();
  const ref = loadReferencePng(resolve(TEST_ROMS_DIR, cfg.refPng));
  const diff = diffPixels(gb.ppu.framebuffer, ref);
  if (diff === 0) return { name, status: "pass", detail: "framebuffer matches reference", frames: cfg.frames };
  return {
    name,
    status: "fail",
    detail: `${diff} of ${SCREEN_WIDTH * SCREEN_HEIGHT} pixels differ from reference`,
    frames: cfg.frames
  };
}

/**
 * GBMicrotest result convention (from the suite's howto):
 *   0xFF80 — actual result, 0xFF81 — expected result, 0xFF82 — pass flag
 *   (`0x01` = pass, `0xFF` = fail). Most tests stabilise within 2 frames;
 *   a few need ~380 ms (~23 frames). Run 30 to be safe.
 */
function runGbMicrotest(romPath: string, name: string): Outcome {
  const bytes = new Uint8Array(readFileSync(romPath));
  const gb = new GameBoy(bytes);
  const frames = 30;
  for (let f = 0; f < frames; f++) gb.runFrame();
  const flag = gb.mmu.readByte(0xff82);
  if (flag === 0x01) return { name, status: "pass", detail: "ff82=01", frames };
  if (flag === 0xff) {
    const actual = gb.mmu.readByte(0xff80);
    const expected = gb.mmu.readByte(0xff81);
    return {
      name,
      status: "fail",
      detail: `actual=0x${actual.toString(16).padStart(2, "0")} expected=0x${expected.toString(16).padStart(2, "0")}`,
      frames
    };
  }
  return { name, status: "fail", detail: `ff82=0x${flag.toString(16).padStart(2, "0")} (unset/incomplete)`, frames };
}

function runSerialTest(romPath: string, name: string): Outcome {
  const bytes = new Uint8Array(readFileSync(romPath));
  const gb = new GameBoy(bytes);
  const serialBytes: number[] = [];
  let serial = "";
  gb.mmu.onSerialOut = (b: number) => {
    serialBytes.push(b);
    serial += String.fromCharCode(b);
  };
  for (let f = 0; f < MAX_FRAMES_SERIAL; f++) {
    gb.runFrame();
    if (serial.includes("Passed")) return { name, status: "pass", detail: "blargg: Passed", frames: f + 1 };
    if (serial.includes("Failed")) return { name, status: "fail", detail: serial, frames: f + 1 };
    if (tailMatches(serialBytes, MOONEYE_PASS))
      return { name, status: "pass", detail: "mooneye: Fibonacci", frames: f + 1 };
    if (serialBytes.length >= 6 && serialBytes.slice(-6).every((b) => b === 0x42)) {
      return { name, status: "fail", detail: "mooneye: 0x42 ×6", frames: f + 1 };
    }
    // Same-suite-style: CPU registers carry the Fibonacci pass marker
    // after the test halts on `LD B, B`; check after each frame so we
    // don't run any longer than necessary.
    const r = gb.cpu.regs;
    if (r.b === 3 && r.c === 5 && r.d === 8 && r.e === 13 && r.h === 21 && r.l === 34) {
      return { name, status: "pass", detail: "register Fibonacci", frames: f + 1 };
    }
  }
  return { name, status: "timeout", detail: serial, frames: MAX_FRAMES_SERIAL };
}

function runOne(romPath: string): Outcome {
  const name = relative(TEST_ROMS_DIR, romPath);
  const skipReason = SKIP_ROMS.get(name);
  if (skipReason) {
    return { name, status: "skip", detail: skipReason, frames: 0 };
  }
  try {
    if (name.startsWith("gbmicrotest/") || name.startsWith("gbmicrotest\\")) return runGbMicrotest(romPath, name);
    const cfg = SCREEN_BY_ROM.get(name);
    return cfg ? runFramebufferTest(romPath, cfg, name) : runSerialTest(romPath, name);
  } catch (err) {
    // Some test ROMs deliberately exercise illegal opcodes / out-of-range
    // bus accesses to verify that our CPU throws or short-circuits the
    // way real hardware does. We surface those as "fail" rather than
    // letting them crash the whole sweep.
    return { name, status: "fail", detail: `threw: ${(err as Error).message}`, frames: 0 };
  }
}

function main(): void {
  const filter = process.argv[2];
  const all = findRoms(TEST_ROMS_DIR);
  if (all.length === 0) {
    console.error(`No ROMs found under ${TEST_ROMS_DIR}.`);
    console.error(`Fetch from https://github.com/c-sp/game-boy-test-roms/releases (latest .zip).`);
    process.exit(1);
  }

  const targets = filter ? all.filter((p) => p.toLowerCase().includes(filter.toLowerCase())) : all;
  if (targets.length === 0) {
    console.error(`Filter "${filter}" matched no ROMs.`);
    process.exit(1);
  }

  console.log(`Running ${targets.length} ROM(s)...\n`);
  const results: Outcome[] = [];
  for (const r of targets) results.push(runOne(r));

  const pass = results.filter((r) => r.status === "pass");
  const fail = results.filter((r) => r.status === "fail");
  const timeout = results.filter((r) => r.status === "timeout");
  const skip = results.filter((r) => r.status === "skip");

  for (const r of results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : r.status === "timeout" ? "TIME" : "SKIP";
    console.log(`[${tag}] ${r.name}${r.frames > 0 ? `  (${r.frames} frames)` : ""}`);
    if (r.status !== "pass" && r.detail) {
      const preview = r.detail.replace(/\s+/g, " ").trim().slice(0, FAIL_PREVIEW_LIMIT);
      if (preview) console.log(`        ${preview}`);
    }
  }

  console.log(`\n${pass.length} passed, ${fail.length} failed, ${timeout.length} timed out, ${skip.length} skipped.`);
  process.exit(fail.length + timeout.length > 0 ? 1 : 0);
}

main();
