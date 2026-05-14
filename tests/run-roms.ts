/**
 * Test-ROM harness — runs Game Boy test ROMs (Blargg / Mooneye / acid2 / etc.)
 * against the in-tree emulator and reports pass / fail. Not part of the
 * regular `npm test` chain; invoke via `npm run test:roms`.
 *
 * Test ROMs themselves live under `tests/roms/` (gitignored). On first
 * run, if that directory is empty, we fetch the latest c-sp Game Boy
 * test-roms release zip from GitHub and unpack it in place. Set
 * `GLOWBOOT_NO_FETCH=1` to disable the auto-fetch (e.g. when running
 * offline) and fall back to the original "fetch it yourself" workflow.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import { PNG } from "pngjs";

import { GameBoy, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/gb";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_ROMS_DIR = resolve(__dirname, "roms");
const RELEASE_API = "https://api.github.com/repos/c-sp/game-boy-test-roms/releases/latest";

const MAX_FRAMES_SERIAL = 60 * 20; // 20s at 60fps. Slowest passing Blargg test takes ~600 frames; tests that haven't completed by then are either screen-only or hung.
const FAIL_PREVIEW_LIMIT = 200;

// ─── First-run fetch ────────────────────────────────────────────────────────
// Bridges the gap between "clone the repo" and "run a test ROM". The c-sp
// release ships a single zip with all the suite directories at the top
// level (`blargg/`, `mooneye-test-suite/`, `gambatte/`, …) so a flat
// extract into `test-roms/` lines up with the paths the runner expects.

async function ensureTestRoms(): Promise<void> {
  if (existsSync(TEST_ROMS_DIR) && readdirSync(TEST_ROMS_DIR).length > 0) return;
  if (process.env.GLOWBOOT_NO_FETCH === "1") return;

  console.log(`tests/roms/ is empty — fetching latest c-sp Game Boy test-roms release…`);
  const releaseRes = await fetch(RELEASE_API, { headers: { "User-Agent": "glowboot-test-runner" } });
  if (!releaseRes.ok) {
    throw new Error(
      `GitHub API ${releaseRes.status} for ${RELEASE_API} — set GLOWBOOT_NO_FETCH=1 to skip and unpack manually`
    );
  }
  const release = (await releaseRes.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string; size: number }[];
  };
  const asset = release.assets.find((a) => /^game-boy-test-roms-.*\.zip$/.test(a.name));
  if (!asset) {
    throw new Error(`Could not find game-boy-test-roms-*.zip in release ${release.tag_name}`);
  }
  console.log(`  → ${release.tag_name} / ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MiB)`);

  const zipRes = await fetch(asset.browser_download_url);
  if (!zipRes.ok) throw new Error(`Asset download failed: HTTP ${zipRes.status}`);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());

  console.log(`  → extracting to ${relative(ROOT, TEST_ROMS_DIR)}/`);
  mkdirSync(TEST_ROMS_DIR, { recursive: true });
  new AdmZip(zipBuf).extractAllTo(TEST_ROMS_DIR, /* overwrite */ true);
  console.log(`  ✓ ready (${readdirSync(TEST_ROMS_DIR).length} top-level entries)`);
}

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

// Classic DMG green LCD shades (#9BBC0F / #8BAC0F / #306230 / #0F380F) —
// scribbletests/scxly's reference image was captured on real DMG hardware
// and bakes those greens in; the test only uses palette slots 0 and 3.
const DMG_GREEN_BG = [0xff0fc098, 0xff0fac8b, 0xff306230, 0xff0f380f];
const DMG_GREEN_OBP = [0xff0fc098, 0xff0fac8b, 0xff306230, 0xff0f380f];

// ─── Screen-only test configs ────────────────────────────────────────────────
interface ScreenTest {
  romPath: string; // path under test-roms/
  refPng: string; // path under test-roms/
  palette?: { bg: number[]; obp0: number[]; obp1: number[] };
  frames: number;
  useBootRom?: boolean; // run via `cgb_boot.bin` first — Mealybug needs the boot-ROM logo bitmap
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
            frames: 200, // CGB boot animation ~150 frames + ~50 to stabilise
            useBootRom: true
          });
        }
      }
    }
  };
  walk(root);
  return tests;
}

const STATIC_SCREEN_TESTS: ScreenTest[] = [
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
    palette: { bg: ACID2_CGB_BG, obp0: ACID2_CGB_OBP, obp1: ACID2_CGB_OBP },
    frames: 30
  },
  {
    romPath: "scribbltests/scxly/scxly.gb",
    refPng: "scribbltests/scxly/scxly-cgb.png",
    palette: { bg: DMG_GREEN_BG, obp0: DMG_GREEN_OBP, obp1: DMG_GREEN_OBP },
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
  }
];

// Built in `main` after `ensureTestRoms` so the auto-discovered mealybug /
// gambatte entries see the freshly extracted directories.
let SCREEN_BY_ROM = new Map<string, ScreenTest>();

// Optional boot ROMs the user can drop into tests/roms/. They're only
// consulted for Mooneye `boot_*` tests (which check DIV / register file /
// hardware-IO state the boot ROM is responsible for); every other test
// runs from the post-boot state as before. Boot ROMs are not bundled —
// they're under copyright — so an absent file just skips the test.
let DMG_BOOT_ROM: Uint8Array | null = null;
let CGB_BOOT_ROM: Uint8Array | null = null;

function loadBootRoms(): void {
  const dmgPath = resolve(TEST_ROMS_DIR, "dmg_boot.bin");
  const cgbPath = resolve(TEST_ROMS_DIR, "cgb_boot.bin");
  if (existsSync(dmgPath)) DMG_BOOT_ROM = new Uint8Array(readFileSync(dmgPath));
  if (existsSync(cgbPath)) CGB_BOOT_ROM = new Uint8Array(readFileSync(cgbPath));
}

/** Mooneye `boot_*` tests target a specific console — we infer that from the
 *  filename suffix. Everything else returns null and runs in post-boot mode. */
function bootRomForTest(name: string): { kind: "dmg" | "cgb"; rom: Uint8Array | null } | null {
  if (!/\/boot_[^/]+\.(gb|gbc)$/.test(name)) return null;
  const kind = /-cgb/i.test(name) || name.endsWith(".gbc") ? "cgb" : "dmg";
  return { kind, rom: kind === "cgb" ? CGB_BOOT_ROM : DMG_BOOT_ROM };
}

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

// Mooneye `boot_*` tests target a specific console revision via the
// filename suffix (e.g. `boot_div-S.gb` = SGB, `boot_regs-mgb.gb` = MGB,
// `boot_div-dmgABCmgb.gb` = DMG-A/B/C plus MGB). Glowboot is CGB-only —
// post-boot register state and HWIO depend on the specific model, so
// these can't pass even with `dmg_boot.bin` present. Skip them with a
// clear reason rather than letting them fail. Tests with `-cgb*` (or
// `.gbc` extension) keep going through the existing `bootRomForTest`
// path, which handles them correctly.
function indexBootRomSkips(): void {
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".gb") && !entry.endsWith(".gbc")) continue;
      if (!/^boot_/.test(entry)) continue;
      const stem = entry.replace(/\.(gb|gbc)$/, "");
      // Explicit non-CGB hardware suffixes (per Mooneye naming convention):
      //   -sgb, -sgb2, -S    SGB / SGB2
      //   -mgb               Game Boy Pocket
      //   -dmg, -dmg0,       DMG variants (incl. DMG-A/B/C)
      //   -dmgABC*           DMG-A/B/C combined with MGB
      //   -G                 DMG+MGB group
      //   -A, -agb, -ags     Game Boy Advance / SP (we don't emulate AGB)
      const isNonCgb = /-(sgb2?|S|G|A|agb|ags)$/.test(stem) || /-mgb$/i.test(stem) || /-dmg[A-Za-z0-9]*$/i.test(stem);
      if (!isNonCgb) continue;
      SKIP_ROMS.set(join(relative(TEST_ROMS_DIR, dir), entry), "model-specific boot test (Glowboot is CGB-only)");
    }
  };
  walk(resolve(TEST_ROMS_DIR, "mooneye-test-suite"));
  walk(resolve(TEST_ROMS_DIR, "mooneye-test-suite-wilbertpol"));
}

// AGE test naming convention (see age-test-roms/README.md):
//   `<test>-cgbBCE.gb`     — runs on CGB B/C/E
//   `<test>-cgbE.gb`       — runs on CGB E only
//   `<test>-dmgC.gb`       — DMG-only build
//   `<test>-dmgC-cgbBC.gb` — cross-compatible build (DMG + CGB)
//   `<test>-ncm[A-Z]+.gb`  — non-CGB-mode reference (CGB hardware in DMG mode)
//   `<test>-nocgb.gb`      — non-CGB-mode build
// Glowboot is CGB-only and presents as CGB-E. We skip pure DMG and
// non-CGB-mode variants — they either won't run or won't match the
// reference. Tests with NO PNG reference are register-state checks that
// halt on `LD B, B`; we run those via the serial harness (which now
// detects the LD-B,B-with-non-Fibonacci-regs failure case).
function indexAgeSkips(): void {
  const root = resolve(TEST_ROMS_DIR, "age-test-roms");
  if (!existsSync(root)) return;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".gb") && !entry.endsWith(".gbc")) continue;
      const stem = entry.replace(/\.(gb|gbc)$/, "");
      const dirRel = relative(TEST_ROMS_DIR, dir);
      // Non-CGB-mode builds — explicit "-nocgb" suffix or "-ncm<X>" reference.
      if (stem.endsWith("-nocgb") || /-ncm[A-Z]+$/.test(stem)) {
        SKIP_ROMS.set(join(dirRel, entry), "AGE non-CGB-mode test (Glowboot is CGB-only)");
        continue;
      }
      // DMG-only — name ends with "-dmg<X>" with no trailing "-cgb<Y>".
      if (/-dmg[A-Z]+$/.test(stem)) {
        SKIP_ROMS.set(join(dirRel, entry), "AGE DMG-only test (Glowboot is CGB-only)");
        continue;
      }
      // ROM has no hardware suffix and no CGB-mode reference PNG in its
      // directory — there's nothing to compare against and the ROM
      // itself may be DMG-only despite the unsuffixed name (e.g.
      // `m3-bg-bgp.gb` ships only dmgC/ncm[BC|E] references).
      const hasHwSuffix = /-(cgb|dmg|ncm)[A-Z]+$/.test(stem);
      if (!hasHwSuffix) {
        const dirEntries = readdirSync(dir);
        const hasCgbRef = dirEntries.some((e) => e.startsWith(stem + "-cgb") && e.endsWith(".png"));
        const hasAnyRef = dirEntries.some((e) => e.startsWith(stem + "-") && e.endsWith(".png"));
        if (hasAnyRef && !hasCgbRef) {
          SKIP_ROMS.set(join(dirRel, entry), "AGE: only DMG/non-CGB references bundled");
          continue;
        }
      }
    }
  };
  walk(root);
}

// AGE screenshot-based tests with CGB references. ROM `<stem>.gb` matches
// `<stem>-cgbBCE.png` / `<stem>-cgbE.png` etc. We try the variants in
// preference order; the first hit wins.
function discoverAgeScreenTests(): ScreenTest[] {
  const root = resolve(TEST_ROMS_DIR, "age-test-roms");
  if (!existsSync(root)) return [];
  const tests: ScreenTest[] = [];
  const variants = ["cgbBCE", "cgbBE", "cgbBC", "cgbE", "cgbB", "cgbC"];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".gb") && !entry.endsWith(".gbc")) continue;
      const stem = entry.replace(/\.(gb|gbc)$/, "");
      const dirRel = relative(TEST_ROMS_DIR, dir);
      for (const v of variants) {
        const refName = `${stem}-${v}.png`;
        if (existsSync(resolve(TEST_ROMS_DIR, dirRel, refName))) {
          tests.push({ romPath: join(dirRel, entry), refPng: join(dirRel, refName), frames: 60 });
          break;
        }
      }
    }
  };
  walk(root);
  return tests;
}

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

function diffPixels(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  }
  return diff;
}

function runFramebufferTest(romPath: string, cfg: ScreenTest, name: string): Outcome {
  const bytes = new Uint8Array(readFileSync(romPath));
  // Mealybug tests rely on the Nintendo logo bitmap left in VRAM after the
  // boot ROM runs (the test's "(r) logo as a sprite" comment). Reference
  // screenshots were captured on real HW which always boots, so framebuffer
  // tests need to boot through `cgb_boot.bin` when present.
  const bootRom = cfg.useBootRom && CGB_BOOT_ROM ? CGB_BOOT_ROM : null;
  const gb = new GameBoy(bytes, bootRom);
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

function runSerialTest(romPath: string, name: string, bootRom: Uint8Array | null = null): Outcome {
  const bytes = new Uint8Array(readFileSync(romPath));
  const gb = new GameBoy(bytes, bootRom);
  const serialBytes: number[] = [];
  let serial = "";
  gb.mmu.onSerialOut = (b: number) => {
    serialBytes.push(b);
    serial += String.fromCharCode(b);
  };
  // AGE-style "test done" signal: the test executes `LD B, B` (0x40) once
  // it's finished, then loops or halts on it. We detect that by watching
  // the PC + general regs settle for several frames in a row while PC
  // sits on a `LD B, B` byte. On settle, registers carry the Fibonacci
  // marker for pass; any other values mean fail. Without this fallback,
  // AGE tests that fail just time out silently.
  let stableFrames = 0;
  let lastPc = -1;
  let lastB = -1;
  let lastC = -1;
  let lastD = -1;
  let lastE = -1;
  let lastH = -1;
  let lastL = -1;
  for (let f = 0; f < MAX_FRAMES_SERIAL; f++) {
    try {
      gb.runFrame();
    } catch (err) {
      // Wilbertpol-style exit: the test executes opcode `0xED` (undefined
      // on LR35902) to signal completion. Register state at the moment
      // of the throw distinguishes pass (Fibonacci) from fail (anything
      // else). Other illegal-opcode throws are genuine CPU errors and
      // bubble up to runOne's catch.
      const msg = (err as Error).message;
      if (/^Illegal opcode 0xed /.test(msg)) {
        const r = gb.cpu.regs;
        if (r.b === 3 && r.c === 5 && r.d === 8 && r.e === 13 && r.h === 21 && r.l === 34) {
          return { name, status: "pass", detail: "register Fibonacci (0xED exit)", frames: f + 1 };
        }
        return {
          name,
          status: "fail",
          detail: `0xED reached with B=${r.b} C=${r.c} D=${r.d} E=${r.e} H=${r.h} L=${r.l} (expected 3,5,8,13,21,34)`,
          frames: f + 1
        };
      }
      throw err;
    }
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
    // AGE-style fail: PC + general regs stable across frames AND PC on
    // LD B, B. Compare component-wise so distinct states never collide.
    const stable =
      r.pc === lastPc &&
      r.b === lastB &&
      r.c === lastC &&
      r.d === lastD &&
      r.e === lastE &&
      r.h === lastH &&
      r.l === lastL;
    if (stable) {
      stableFrames++;
      if (stableFrames >= 4 && gb.mmu.readByte(r.pc) === 0x40) {
        return {
          name,
          status: "fail",
          detail: `LD B,B reached with B=${r.b} C=${r.c} D=${r.d} E=${r.e} H=${r.h} L=${r.l} (expected 3,5,8,13,21,34)`,
          frames: f + 1
        };
      }
    } else {
      stableFrames = 0;
      lastPc = r.pc;
      lastB = r.b;
      lastC = r.c;
      lastD = r.d;
      lastE = r.e;
      lastH = r.h;
      lastL = r.l;
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
  const boot = bootRomForTest(name);
  if (boot && !boot.rom) {
    return { name, status: "skip", detail: `requires tests/roms/${boot.kind}_boot.bin (not bundled)`, frames: 0 };
  }
  try {
    if (name.startsWith("gbmicrotest/") || name.startsWith("gbmicrotest\\")) return runGbMicrotest(romPath, name);
    const cfg = SCREEN_BY_ROM.get(name);
    return cfg ? runFramebufferTest(romPath, cfg, name) : runSerialTest(romPath, name, boot?.rom ?? null);
  } catch (err) {
    // Some test ROMs deliberately exercise illegal opcodes / out-of-range
    // bus accesses to verify that our CPU throws or short-circuits the
    // way real hardware does. We surface those as "fail" rather than
    // letting them crash the whole sweep.
    return { name, status: "fail", detail: `threw: ${(err as Error).message}`, frames: 0 };
  }
}

async function main(): Promise<void> {
  // The cartridge constructor logs a one-line summary on every load.
  // Useful in the browser shell, but at one line per ROM × 4 500+ ROMs
  // it drowns the harness output. Drop `console.info` for the duration
  // of the run; harness messages use `console.log` and stay visible.
  console.info = () => {};

  await ensureTestRoms();
  // Discovery + skip indexing happen here so they see the freshly
  // extracted directories on first-run, not the empty placeholder.
  const screenTests = [
    ...STATIC_SCREEN_TESTS,
    ...discoverMealybugTests(),
    ...discoverGambatteTests(),
    ...discoverAgeScreenTests()
  ];
  SCREEN_BY_ROM = new Map<string, ScreenTest>(screenTests.map((t) => [t.romPath, t]));
  indexMealybugSkips();
  indexGambatteSkips();
  indexAgeSkips();
  indexBootRomSkips();
  loadBootRoms();

  const arg = process.argv[2];
  const all = findRoms(TEST_ROMS_DIR);
  if (all.length === 0) {
    console.error(`No ROMs found under ${TEST_ROMS_DIR}.`);
    console.error(`Fetch from https://github.com/c-sp/game-boy-test-roms/releases (latest .zip).`);
    process.exit(1);
  }

  // No arg → print the suite list as a discoverability prompt rather
  // than silently running everything (full sweep takes several
  // minutes). Use `--all` to opt into running every ROM.
  if (arg === undefined) {
    const suites = Array.from(new Set(all.map((p) => relative(TEST_ROMS_DIR, p).split("/")[0]!))).sort();
    console.log(`Usage: npm run test:roms <filter>\n`);
    console.log(`Available suites:`);
    for (const s of suites) console.log(`  ${s}`);
    console.log(`\nExamples:`);
    console.log(`  npm run test:roms blargg            # whole suite`);
    console.log(`  npm run test:roms cgb_sound/09      # single ROM (substring match)`);
    console.log(`  npm run test:roms -- --all          # everything (${all.length} ROMs, slow)`);
    process.exit(0);
  }

  const filter = arg === "--all" ? undefined : arg;
  const targets = filter ? all.filter((p) => p.toLowerCase().includes(filter.toLowerCase())) : all;
  if (targets.length === 0) {
    console.error(`Filter "${filter}" matched no ROMs.`);
    process.exit(1);
  }

  console.log(`Running ${targets.length} ROM(s)...\n`);
  const results: Outcome[] = [];
  for (const r of targets) {
    const outcome = runOne(r);
    results.push(outcome);
    const tag =
      outcome.status === "pass"
        ? "PASS"
        : outcome.status === "fail"
          ? "FAIL"
          : outcome.status === "timeout"
            ? "TIME"
            : "SKIP";
    console.log(`[${tag}] ${outcome.name}${outcome.frames > 0 ? `  (${outcome.frames} frames)` : ""}`);
    if (outcome.status !== "pass" && outcome.detail) {
      const preview = outcome.detail.replace(/\s+/g, " ").trim().slice(0, FAIL_PREVIEW_LIMIT);
      if (preview) console.log(`        ${preview}`);
    }
  }

  const pass = results.filter((r) => r.status === "pass");
  const fail = results.filter((r) => r.status === "fail");
  const timeout = results.filter((r) => r.status === "timeout");
  const skip = results.filter((r) => r.status === "skip");

  console.log(`\n${pass.length} passed, ${fail.length} failed, ${timeout.length} timed out, ${skip.length} skipped.`);
  process.exit(fail.length + timeout.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
