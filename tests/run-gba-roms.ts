/**
 * Unified GBA test-ROM runner — a SELF-SCORING accuracy gate.
 *
 * We run four upstream suites and grade each test against numbers the
 * ROM reports about ITSELF — no external reference hashes. The verdict
 * comes from one of three signatures: a per-test pass/total counter
 * read from IWRAM, jsmolka's r12 (the fail number its math tests stash
 * there), or a golden hash over the framebuffer we previously baselined
 * and re-bless on verified accuracy improvements — the hash covers both
 * the visual-only tests and jsmolka's CPU suites, whose "All tests
 * passed" result screen differs from any "Failed test N".
 *
 * Suites (auto-fetched on first run, SHA256-verified, pinned commits):
 *
 *   jsmolka     13 tests — ARM/Thumb/BIOS/memory/save/NES/PPU. The CPU
 *               suites self-report on screen ("All tests passed" vs
 *               "Failed test N") and are validated by the result-screen
 *               hash; the math tests additionally stash a fail number in
 *               r12. PPU sub-tests are visual (golden hash). NOTE: the
 *               failed-test register is NOT uniform — the CPU suites use
 *               r7, the math tests r12 — so only the screen is reliable.
 *   fuzzarm      3 tests — randomized ARM/Thumb fuzzing. Visual pass
 *               screen → golden hash.
 *   mgba-suite  14 tests — endrift's suite (menu-navigated). 13 of the
 *               14 categories write a {pass,total} tally into an IWRAM
 *               results struct (see MGBA_COUNTER_ADDRS); the Video category
 *               instead self-checks each of its 7 sub-tests' render against
 *               an on-screen reference (runVideoComparison) for a {pass,total}.
 *   nba-hw-test 10 tests — NanoBoyAdvance hardware tests with a
 *               test_count/pass_count framework counter. The pure-visual
 *               ppu-* ROMs (no counter, no reference) were dropped.
 *
 *   40 tests total.
 *
 * Scoring — each run is reduced to a Signature, compared to its entry in
 * the committed BASELINE (tests/run-gba-roms-baseline.json):
 *   • count   — IWRAM pass/total tally (counter tests)
 *   • r12fail #N — jsmolka math-test failure number
 *   • hash    — golden BGR555 framebuffer hash (visual-only tests +
 *               jsmolka CPU result screens)
 * Verdicts: pass / improve / regress / fail (known-bad) / changed / new.
 * The run exits non-zero on regress, changed, crash, or unimpl. After a
 * real, verified accuracy change, re-record the baseline with `--bless`.
 *
 * Counter-settle: the completion criterion fires on framebuffer
 * stability, which can precede the final tally (e.g. mgba-suite-timing
 * settles at f≈432 but is visually stable at f≈429). Counter tests keep
 * running past completion until the tally stops moving, so reported
 * counts are final.
 *
 * Set `GLOWBOOT_NO_FETCH=1` to skip auto-fetch (offline — drop the ROMs
 * at `tests/gba-roms/<suite>/<file>.gba` manually). The gate runs the
 * HLE BIOS path — the configuration the BROWSER ships — against the
 * committed baseline. `--bios` runs a real Nintendo BIOS at
 * `tests/gba-roms/gba_bios.bin` as an INFORMATIONAL comparison against
 * the same baseline (counter values are BIOS-sensitive); it prints the
 * diff but never gates and never re-records.
 *
 * Usage:
 *   npm run test:gba-roms                       # everything (gate, HLE)
 *   npm run test:gba-roms mgba                  # one suite / substring
 *   npm run test:gba-roms jsmolka-arm           # one test by id
 *   npm run test:gba-roms -- --bless            # re-record the baseline
 *   npm run test:gba-roms -- --bios             # opt-in real-BIOS diagnostic (local)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

import { Gba } from "../src/gba/gba.js";
import type { GbaButton } from "../src/gba/joypad/joypad.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROMS_DIR = resolve(__dirname, "gba-roms");

// ─── ROM manifest (URLs + SHA256s) ───────────────────────────────────
//
// Each entry pins an upstream commit so reruns reproduce byte-for-byte.
// The per-file SHA256s give a second layer of verification against
// MITM / GitHub-side tampering — empty SHA = upstream doesn't publish
// one, so the commit pin alone gates the bytes.
//
// Source provenance:
//   jsmolka/gba-tests, DenSinH/FuzzARM, nba-emu/hw-test — canonical
//     upstream repos by the respective authors (long-running GBA
//     emulator / test-suite maintainers).
//   Asphaltian/sgba — community mirror of the mgba-emu/suite tests
//     that pre-builds the .gba binary (upstream is C source for the
//     devkitARM toolchain and doesn't publish binaries). SHA pin locks
//     the byte content.

type SuiteSource =
  | { kind: "github_raw"; repo: string; commit: string; files: readonly { path: string; sha256: string }[] }
  | { kind: "direct"; files: readonly { path: string; url: string; sha256: string }[] };

interface Suite {
  name: string;
  description: string;
  source: SuiteSource;
}

const SUITES: readonly Suite[] = [
  {
    name: "jsmolka",
    description: "jsmolka/gba-tests — ARM, Thumb, BIOS, memory, save, NES, PPU",
    source: {
      kind: "github_raw",
      repo: "jsmolka/gba-tests",
      commit: "a7113b67e63f83a9b321696ddd7042ccfad6c881",
      files: [
        { path: "arm/arm.gba", sha256: "77ee88662552bdc885c1080c0172ff119d54db791bd73b21808cf1ff1fe5b40e" },
        { path: "thumb/thumb.gba", sha256: "b5cb2291df4ab314b31c598acd9bff2ccfa0b38efff29daadfe97422ce369b67" },
        { path: "bios/bios.gba", sha256: "9d7b369fa1aa661ff03692b3d79c6f644b623d72983d0fc890e6d87a0409a3c9" },
        { path: "memory/memory.gba", sha256: "21024fb6aae6343f5f0466dd54e3149de1fbeb23f78e7d85a015c983684d2f87" },
        { path: "nes/nes.gba", sha256: "d990df112763087d0415b3785c1b4d31c0237794a704d0446fc5f5e474a44f98" },
        { path: "unsafe/unsafe.gba", sha256: "bb727d59fa81915a5f5c609f4befb64872d3a3d830bc6ae0149e26410e648f85" },
        { path: "save/none.gba", sha256: "edb34ba6590d070c8a50cf0f3566b1e3cc679377b978224ff1b872d27f2b1630" },
        { path: "save/sram.gba", sha256: "a37ad99c31e3f805eb05a00e498b65bd78e6f43a0a139cd695bea1f88229af2c" },
        { path: "save/flash64.gba", sha256: "7e2aa32e943aedde88bd750eadcdbf55152d3a1ec61385011b7f15cd85b07c02" },
        { path: "save/flash128.gba", sha256: "9ac50e51d3ce4209dbdf85e472e70c067d5827e9af1bb3e707f6bd9059d5f0c6" },
        // ppu/*.gba have no upstream SHA — the commit pin still gates the bytes.
        { path: "ppu/hello.gba", sha256: "" },
        { path: "ppu/shades.gba", sha256: "" },
        { path: "ppu/stripes.gba", sha256: "" }
      ]
    }
  },
  {
    name: "fuzzarm",
    description: "DenSinH/FuzzARM — randomized ARM/Thumb fuzz tests (10 000 cases each)",
    source: {
      kind: "github_raw",
      repo: "DenSinH/FuzzARM",
      commit: "a675329cd57da48e3e406216ba2d79dd7e09ee20",
      files: [
        { path: "ARM_Any.gba", sha256: "5db4e020a61a0760043cb66b7149fa1777501080dbfc1b956c9600d44a4500f5" },
        { path: "THUMB_Any.gba", sha256: "c89d9e0894d9ef5af5de6bf7819b32383acad535ec5ab8c7e5b4f6278dff34f6" },
        { path: "FuzzARM.gba", sha256: "266e3d4f1dc231aadf9d296b13897cdc0de4c3cef73cf0c83806c0cef3422269" }
      ]
    }
  },
  {
    name: "mgba-suite",
    description: "mgba-emu/suite — memory / IO / timing / DMA / BIOS math / video edges",
    source: {
      kind: "direct",
      // Pin a specific Asphaltian commit (2026-04-26 "Sync with mGBA,
      // fixes DMA latching") rather than `main` — Asphaltian resyncs
      // against newer mGBA periodically and the bare branch would drift
      // out from under our baseline.
      files: [
        {
          path: "suite.gba",
          url: "https://raw.githubusercontent.com/Asphaltian/sgba/d29fdcf14cebe90833eb65534efdfe47c03744aa/Assets/roms/suite.gba",
          sha256: "073ac37db89b791a589ec93853074043b31d0c931f43f4a69afa7319248ec8bb"
        }
      ]
    }
  },
  {
    name: "nba-hw-test",
    description: "nba-emu/hw-test — DMA / IRQ / HALTCNT / timer edges (counter-scored only)",
    source: {
      kind: "github_raw",
      repo: "nba-emu/hw-test",
      commit: "7b7b7ae4afd6122065c94fbd51843a5709fe577e",
      files: [
        {
          path: "bus/128kb-boundary/128kb-boundary.gba",
          sha256: "e4397b9d87fd8f3f9e77ef02f8bd3ba326897849fd6e832f7e805c1e1b64b8b1"
        },
        {
          path: "dma/burst-into-tears/burst-into-tears.gba",
          sha256: "803ce6e7d444ad4a1397fb12bee1e2144aa5e95731ff31e9c2d68077e45958ce"
        },
        {
          path: "dma/force-nseq-access/force-nseq-access.gba",
          sha256: "e623d15dc8962731f38e5a467689f88cf49a270d367cbbb970203d11f186eb8b"
        },
        { path: "dma/latch/latch.gba", sha256: "9830af8bafca4064792d749948d0d4f9e1ae4e42ae10b622fab15d0759815340" },
        {
          path: "dma/start-delay/start-delay.gba",
          sha256: "dfd922caac35579b1ea2ef60aa2c12b92f7025ae9f17c75fee053f2c870ed9c8"
        },
        { path: "haltcnt/haltcnt.gba", sha256: "819b7968c4dc781b868eb2b97c12c17773d7cadd2e54fdd2a934112b1f191374" },
        {
          path: "irq/irq-delay/irq-delay.gba",
          sha256: "70d36ec5765f21a6a1690a14fe046d377f51283901a6d15958ca0b5a6147b125"
        },
        {
          path: "ppu/vram-mirror/vram-mirror.gba",
          sha256: "f8eedd949da40ed544ceeb5d9f3ab0812d45c2f4fe4e9a3613ca6e4356d9642b"
        },
        { path: "timer/reload/reload.gba", sha256: "ce1c32a560aa46e3070e7a9745102c0168380d3d1c100032fd5ff4ebe9fd6947" },
        {
          path: "timer/start-stop/start-stop.gba",
          sha256: "c25f0a63e7b9a350163dc8d683dd081934b65295f06a9079109ab709b9b785a7"
        }
      ]
    }
  }
];

// ─── Test definitions (37 scenarios) ─────────────────────────────────
//
// Each entry pins a ROM path (under its suite), a max-frame budget, a
// completion criterion, and an optional list of input events that
// drive menu navigation for the multi-test suites.
//
// KEYINPUT bit layout (matches GBA hardware):
//   bit 0 = A      bit 4 = Right
//   bit 1 = B      bit 5 = Left
//   bit 2 = Select bit 6 = Up
//   bit 3 = Start  bit 7 = Down
// Keys are pulsed: 10-frame hold then release, with 15-frame spacing
// before the next event so menus that gate on key-down edges see each
// press cleanly (a persistent-mask model collapses repeated same-key
// presses into a single edge, which breaks armwrestler's menu).

interface InputEvent {
  /** Frame number to assert these keys. Keys are held for
   *  `KEY_HOLD_FRAMES` then released — pulsing rather than persistent
   *  so menus that gate on key-down edges see each press cleanly. */
  frame: number;
  /** KEYINPUT-bit mask. */
  keys: number;
}

type Completion =
  | { kind: "stable_frames"; window: number; minFrames: number }
  | { kind: "input_then_stable"; window: number; minFrames: number }
  | { kind: "exact_frame"; frame: number };

interface TestDef {
  id: string;
  suite: string;
  rom: string;
  maxFrames: number;
  inputs: readonly InputEvent[];
  completion: Completion;
}

const KEY_HOLD_FRAMES = 10;

const TESTS: readonly TestDef[] = [
  // ── jsmolka — 13 tests, no input ────────────────────────────────
  {
    id: "jsmolka-arm",
    suite: "jsmolka",
    rom: "arm/arm.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-thumb",
    suite: "jsmolka",
    rom: "thumb/thumb.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-bios",
    suite: "jsmolka",
    rom: "bios/bios.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-memory",
    suite: "jsmolka",
    rom: "memory/memory.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-nes",
    suite: "jsmolka",
    rom: "nes/nes.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-unsafe",
    suite: "jsmolka",
    rom: "unsafe/unsafe.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-flash128",
    suite: "jsmolka",
    rom: "save/flash128.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 150 }
  },
  {
    id: "jsmolka-flash64",
    suite: "jsmolka",
    rom: "save/flash64.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 150 }
  },
  {
    id: "jsmolka-sram",
    suite: "jsmolka",
    rom: "save/sram.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-save-none",
    suite: "jsmolka",
    rom: "save/none.gba",
    maxFrames: 600,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 30 }
  },
  {
    id: "jsmolka-ppu-hello",
    suite: "jsmolka",
    rom: "ppu/hello.gba",
    maxFrames: 300,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 10 }
  },
  {
    id: "jsmolka-ppu-shades",
    suite: "jsmolka",
    rom: "ppu/shades.gba",
    maxFrames: 300,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 10 }
  },
  {
    id: "jsmolka-ppu-stripes",
    suite: "jsmolka",
    rom: "ppu/stripes.gba",
    maxFrames: 300,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 10 }
  },

  // ── fuzzarm — 3 tests, no input (auto-runs after a delay) ─────────
  {
    id: "fuzzarm-arm",
    suite: "fuzzarm",
    rom: "ARM_Any.gba",
    maxFrames: 30000,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 2000 }
  },
  {
    id: "fuzzarm-thumb",
    suite: "fuzzarm",
    rom: "THUMB_Any.gba",
    maxFrames: 30000,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 2000 }
  },
  {
    id: "fuzzarm-mixed",
    suite: "fuzzarm",
    rom: "FuzzARM.gba",
    maxFrames: 30000,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 2000 }
  },

  // ── mgba-suite — 14 tests, menu navigation via DOWN×N + A ─────────
  {
    id: "mgba-suite-memory",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [{ frame: 80, keys: 1 }],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-io-read",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-timing",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-timers",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-timer-irq",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 1 }
    ],
    // 90 subtests take ~600 frames to compute. The on-screen counter
    // ticks well after the framebuffer settles, so we have to push
    // minFrames past the test's longest runtime to read the final
    // tally — `input_then_stable` would otherwise stop at f=429 with
    // only the first ~37 subtests recorded.
    completion: { kind: "input_then_stable", window: 30, minFrames: 800 }
  },
  {
    id: "mgba-suite-shifter",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-carry",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-multiply-long",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-bios-math",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 128 },
      { frame: 240, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-dma",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 3600,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 128 },
      { frame: 240, keys: 128 },
      { frame: 260, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 600 }
  },
  {
    id: "mgba-suite-sio-read",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 128 },
      { frame: 240, keys: 128 },
      { frame: 260, keys: 128 },
      { frame: 280, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-sio-timing",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 128 },
      { frame: 240, keys: 128 },
      { frame: 260, keys: 128 },
      { frame: 280, keys: 128 },
      { frame: 300, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    id: "mgba-suite-misc-edge",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [
      { frame: 80, keys: 128 },
      { frame: 100, keys: 128 },
      { frame: 120, keys: 128 },
      { frame: 140, keys: 128 },
      { frame: 160, keys: 128 },
      { frame: 180, keys: 128 },
      { frame: 200, keys: 128 },
      { frame: 220, keys: 128 },
      { frame: 240, keys: 128 },
      { frame: 260, keys: 128 },
      { frame: 280, keys: 128 },
      { frame: 300, keys: 128 },
      { frame: 320, keys: 1 }
    ],
    completion: { kind: "input_then_stable", window: 30, minFrames: 400 }
  },
  {
    // Self-checking — runTest dispatches this id to runVideoComparison, which
    // does its own navigation + Actual-vs-Expected capture across all 7
    // sub-tests; the generic inputs/completion below are unused.
    id: "mgba-suite-video",
    suite: "mgba-suite",
    rom: "suite.gba",
    maxFrames: 2400,
    inputs: [],
    completion: { kind: "exact_frame", frame: 1 }
  },

  // ── nba-hw-test — 10 counter-scored tests, no input, all auto-run ──
  // Each ROM runs its framework subtests and writes test_count/pass_count
  // to a known IWRAM struct (see NBA_COUNTER_ADDRS). Only the tests with a
  // real counter are kept — the pure-visual ppu-* ROMs (bgpd, bgx,
  // greenswap, sprite-hmosaic, ram-access-timing, dispcnt-latch,
  // status-irq-dma) were dropped: no reference, no automated signal.
  {
    id: "nba-bus-128kb-boundary",
    suite: "nba-hw-test",
    rom: "bus/128kb-boundary/128kb-boundary.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-dma-burst-into-tears",
    suite: "nba-hw-test",
    rom: "dma/burst-into-tears/burst-into-tears.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-dma-force-nseq-access",
    suite: "nba-hw-test",
    rom: "dma/force-nseq-access/force-nseq-access.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-dma-latch",
    suite: "nba-hw-test",
    rom: "dma/latch/latch.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-dma-start-delay",
    suite: "nba-hw-test",
    rom: "dma/start-delay/start-delay.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-haltcnt",
    suite: "nba-hw-test",
    rom: "haltcnt/haltcnt.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-irq-delay",
    suite: "nba-hw-test",
    rom: "irq/irq-delay/irq-delay.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-ppu-vram-mirror",
    suite: "nba-hw-test",
    rom: "ppu/vram-mirror/vram-mirror.gba",
    maxFrames: 400,
    // Counter reaches its final value (10/10) at frame ~82; bumped
    // from the default 60 so subt= captures the post-test_print state.
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 100 }
  },
  {
    id: "nba-timer-reload",
    suite: "nba-hw-test",
    rom: "timer/reload/reload.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  },
  {
    id: "nba-timer-start-stop",
    suite: "nba-hw-test",
    rom: "timer/start-stop/start-stop.gba",
    maxFrames: 400,
    inputs: [],
    completion: { kind: "stable_frames", window: 10, minFrames: 60 }
  }
];

// ─── Self-scoring baseline (real numbers, no external hashes) ────────
//
// Every test self-reports from ROM state — we don't compare against any
// external reference set, only the local committed baseline:
//   • counter tests (mgba-suite + nba-hw-test): IWRAM pass/total tally
//   • jsmolka CPU tests: golden hash of the result screen ("All tests
//     passed" vs "Failed test N"); math tests also stash r12 on failure
//   • visual-only tests with no counter (fuzzarm, mgba video / sio-timing):
//     a golden BGR555 framebuffer hash
// Each result is compared to its BASELINE entry; the run FAILS (exit 1) on
// any regression — a counter dropping, an r12 pass turning fail, or a
// golden hash changing. Counts going UP are flagged as improvements to
// lock in with `--bless`, which rewrites the baseline file.

type Signature =
  | { kind: "count"; pass: number; total: number }
  | { kind: "r12fail"; test: number }
  | { kind: "hash"; hash: string };

/** HLE is the only committed baseline — it's the BIOS configuration the
 *  browser ships, and the only one verifiable without a (gitignored,
 *  copyrighted) Nintendo BIOS dump. `--bios` runs the real BIOS purely
 *  as an INFORMATIONAL comparison against this same baseline: it prints
 *  where the two diverge (~4 timing/IRQ tests — real-BIOS IRQ-entry
 *  cycles vs the HLE stub) but never gates and never re-records. */
const USE_BIOS = process.argv.includes("--bios");
const BASELINE_PATH = resolve(__dirname, "run-gba-roms-baseline.json");

function loadBaseline(): Record<string, Signature> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, Signature>;
}

function writeBaseline(b: Record<string, Signature>): void {
  // Stable key order so diffs stay readable.
  const ordered: Record<string, Signature> = {};
  for (const k of Object.keys(b).sort()) ordered[k] = b[k]!;
  writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + "\n");
}

/** Reduce a run to its self-reported signature (see BASELINE comment).
 *  jsmolka has no single pass/fail register — the math tests stash the
 *  result in r12, but the CPU-instruction suites put the failed sub-test
 *  number in r7 (and arm even reuses r7 as a scratch pointer). So r12 only
 *  catches the math-style failures; everything else is validated by the
 *  golden framebuffer hash of the result screen ("All tests passed" vs
 *  "Failed test N" render differently), which is the actual ground truth. */
function signatureOf(test: TestDef, r: RunResult): Signature {
  if (r.subtestPass !== null && r.subtestTotal !== null) {
    return { kind: "count", pass: r.subtestPass, total: r.subtestTotal };
  }
  if (test.suite === "jsmolka" && r.r12 !== 0) {
    return { kind: "r12fail", test: r.r12 };
  }
  return { kind: "hash", hash: r.bgr555Hash };
}

// ─── Download flow ───────────────────────────────────────────────────

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchAsBytes(url: string): Promise<Uint8Array> {
  // Some hosts (TCRF, Cult-of-GBA) 403 the bare Node UA.
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (glowboot-test-runner)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function ensureFile(absPath: string, url: string, expectedSha: string): Promise<void> {
  if (existsSync(absPath)) {
    if (expectedSha === "") return; // Commit pin gates bytes; nothing to verify.
    const actual = sha256(readFileSync(absPath));
    if (actual === expectedSha) return;
    console.log(`  [WARN] ${absPath} checksum drift; re-downloading`);
  }
  if (process.env.GLOWBOOT_NO_FETCH === "1") {
    throw new Error(`Missing ${absPath}; auto-fetch disabled. Download manually from ${url}.`);
  }
  console.log(`  [fetch] ${absPath}`);
  console.log(`          ↳ ${url}`);
  const bytes = await fetchAsBytes(url);
  if (expectedSha !== "") {
    const actual = sha256(bytes);
    if (actual !== expectedSha) {
      throw new Error(`Checksum mismatch for ${url}\n    expected: ${expectedSha}\n    actual:   ${actual}`);
    }
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
}

async function ensureRoms(): Promise<void> {
  console.log(`Fetching test ROMs (jsmolka / fuzzarm / mgba-suite / nba-hw-test)…`);
  for (const suite of SUITES) {
    const suiteDir = join(ROMS_DIR, suite.name);
    // Narrowing on `source.kind` keeps `file` typed as the right
    // union branch — direct-URL files carry a `url` field that the
    // github_raw branch doesn't have.
    if (suite.source.kind === "github_raw") {
      const baseUrl = `https://raw.githubusercontent.com/${suite.source.repo}/${suite.source.commit}`;
      for (const file of suite.source.files) {
        await ensureFile(join(suiteDir, file.path), `${baseUrl}/${file.path}`, file.sha256);
      }
    } else {
      for (const file of suite.source.files) {
        await ensureFile(join(suiteDir, file.path), file.url, file.sha256);
      }
    }
  }
}

// ─── BGR555 framebuffer hash ─────────────────────────────────────────

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 160;

/** Convert our RGBA32 framebuffer back to raw 76 800-byte BGR555 LE
 *  and SHA256 it. BGR555 is the GBA's native pixel format, so hashing
 *  in that representation makes the golden hashes portable to other
 *  emulators / reference traces with the same pixel layout. Lossless
 *  round-trip because we expand 5→8 via `(c << 3) | (c >> 2)` and
 *  recover with `c >> 3`. */
function bgr555HashOf(fb: Uint8ClampedArray<ArrayBuffer>): string {
  const buf = Buffer.alloc(SCREEN_WIDTH * SCREEN_HEIGHT * 2);
  for (let i = 0, j = 0; i < fb.length; i += 4, j += 2) {
    const r5 = (fb[i] ?? 0) >>> 3;
    const g5 = (fb[i + 1] ?? 0) >>> 3;
    const b5 = (fb[i + 2] ?? 0) >>> 3;
    const v = r5 | (g5 << 5) | (b5 << 10);
    buf[j] = v & 0xff;
    buf[j + 1] = (v >>> 8) & 0xff;
  }
  return createHash("sha256").update(buf).digest("hex");
}

interface FrameStats {
  nonBlackPixels: number;
  distinctColours: number;
}

function summariseFrame(fb: Uint8ClampedArray<ArrayBuffer>): FrameStats {
  let nonBlackPixels = 0;
  const seen = new Set<number>();
  for (let i = 0; i < fb.length; i += 4) {
    const r = fb[i] ?? 0;
    const g = fb[i + 1] ?? 0;
    const b = fb[i + 2] ?? 0;
    seen.add((r << 16) | (g << 8) | b);
    if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels++;
  }
  return { nonBlackPixels, distinctColours: seen.size };
}

// ─── Test runner (frame-based with input automation) ─────────────────

const INPUT_BIT_BUTTONS: readonly GbaButton[] = ["a", "b", "select", "start", "right", "left", "up", "down"];

interface RunResult {
  framesRun: number;
  completedAt: number; // frame where completion fired, or framesRun if budget exhausted
  error: string | null;
  errorAtFrame: number;
  finalPc: number;
  cpsr: number;
  nonBlackPixels: number;
  distinctColours: number;
  bgr555Hash: string;
  rgbaSha1: string;
  dispcnt: number;
  vcount: number;
  elapsedSec: number;
  r12: number;
  /** jsmolka mode-4 "text drawn at canonical region" probe. */
  textDrawn: boolean;
  /** mgba-suite internal pass/total counter — the first adjacent
   *  IWRAM word-pair where both are 1..5000 and pass ≤ total.
   *  Empirically matches what the suite renders on screen for
   *  shifter (140/140), carry (93/93), multiply-long (52/72),
   *  bios-math (615/615), memory, io-read, dma, sio-read. The
   *  counter is on the test function's stack, so its absolute
   *  offset varies per test, but it's consistently the first
   *  "small int pair" the scan encounters. `null` when no
   *  plausible pair is found (e.g. on jsmolka where the test
   *  doesn't use this idiom). */
  subtestPass: number | null;
  subtestTotal: number | null;
}

/** Picture-region hash of the LAST per-scanline render, excluding the bottom
 *  label strip (rows 138-159 carry the "Actual"/"Expected" text the video
 *  tests overlay — including it would make every comparison differ). Reads
 *  `gba.framebuffer` directly and does NOT call renderFrame(): the Layer-
 *  toggle tests change BG enables mid-frame, so a whole-frame re-render at the
 *  final register state would lose the per-scanline effect and false-fail. */
const VIDEO_PICTURE_ROWS = 138;
function videoPictureHash(gba: Gba): string {
  const fb = gba.framebuffer;
  return createHash("sha1")
    .update(Buffer.from(fb.buffer, fb.byteOffset, 240 * VIDEO_PICTURE_ROWS * 4))
    .digest("hex");
}

/** mgba-suite Video category — 7 self-checking sub-tests. Selecting one
 *  renders OUR output ("Actual"); pressing A again renders the hardware
 *  reference ("Expected"). A sub-test passes when the two match outside the
 *  label strip. This replaces the old shallow submenu-only hash (which only
 *  proved the menu drew) with a real {pass,total} tally that catches PPU
 *  rendering bugs. Re-boots per sub-test so menu-cursor state can't drift. */
function runVideoComparison(
  romBytes: Uint8Array,
  biosBytes: Uint8Array | null
): { pass: number; total: number; last: Gba } {
  const total = 7;
  let pass = 0;
  let last!: Gba;
  for (let idx = 0; idx < total; idx++) {
    const gba = new Gba(romBytes, biosBytes ?? undefined);
    last = gba;
    const press = new Map<number, GbaButton>();
    let f = 80;
    for (let i = 0; i < 13; i++) {
      press.set(f, "down"); // main-menu cursor → Video
      f += 20;
    }
    press.set(f, "a"); // enter the Video submenu
    f += 40;
    for (let i = 0; i < idx; i++) {
      press.set(f, "down"); // submenu cursor → sub-test idx
      f += 20;
    }
    press.set(f, "a"); // show Actual
    const actualAt = f + 25;
    f += 50;
    press.set(f, "a"); // show Expected
    const expectedAt = f + 25;
    f += 50;
    const end = f + 20;
    let held: { btn: GbaButton; until: number } | null = null;
    let actual = "";
    let expected = "";
    for (let fr = 0; fr < end; fr++) {
      const b = press.get(fr);
      if (b !== undefined) {
        gba.joypad.press(b);
        held = { btn: b, until: fr + KEY_HOLD_FRAMES };
      }
      if (held && fr === held.until) {
        gba.joypad.release(held.btn);
        held = null;
      }
      gba.runFrame();
      if (fr === actualAt) actual = videoPictureHash(gba);
      if (fr === expectedAt) expected = videoPictureHash(gba);
    }
    if (actual !== "" && actual === expected) pass++;
  }
  return { pass, total, last };
}

function runTest(def: TestDef, romBytes: Uint8Array, biosBytes: Uint8Array | null): RunResult {
  // The Video category is self-checking (Actual vs Expected reference) — run
  // the dedicated 7-sub-test comparison instead of the generic single-capture
  // flow, and report it as a {pass,total} count.
  if (def.id === "mgba-suite-video") {
    const t0 = performance.now();
    const { pass, total, last } = runVideoComparison(romBytes, biosBytes);
    last.mem.ppu.renderFrame();
    const fb = last.framebuffer;
    const stats = summariseFrame(fb);
    return {
      framesRun: 0,
      completedAt: 0,
      error: null,
      errorAtFrame: 0,
      finalPc: 0,
      cpsr: 0,
      nonBlackPixels: stats.nonBlackPixels,
      distinctColours: stats.distinctColours,
      bgr555Hash: bgr555HashOf(fb),
      rgbaSha1: "",
      dispcnt: last.mem.ppu.dispcnt,
      vcount: last.mem.ppu.vcount,
      elapsedSec: (performance.now() - t0) / 1000,
      r12: 0,
      textDrawn: false,
      subtestPass: pass,
      subtestTotal: total
    };
  }

  const gba = new Gba(romBytes, biosBytes ?? undefined);

  /** Effective input mask for a given frame: OR of every event whose
   *  hold window [frame, frame+KEY_HOLD_FRAMES) covers `f`. */
  const inputMaskFor = (f: number): number => {
    let mask = 0;
    for (const ev of def.inputs) {
      if (f >= ev.frame && f < ev.frame + KEY_HOLD_FRAMES) mask |= ev.keys;
    }
    return mask;
  };

  /** First frame where `input_then_stable` can start watching for
   *  stability — one frame past the last input's release. */
  const lastInputReleaseFrame =
    def.inputs.length === 0 ? 0 : Math.max(...def.inputs.map((i) => i.frame + KEY_HOLD_FRAMES));

  const start = performance.now();
  let error: string | null = null;
  let errorAtFrame = 0;
  let completedAt = def.maxFrames;
  let recentHash = "";
  let stableSince = -1;
  let framesRun = 0;

  try {
    for (let f = 0; f < def.maxFrames; f++) {
      // Apply input mask for this frame.
      const mask = inputMaskFor(f);
      for (let bit = 0; bit < INPUT_BIT_BUTTONS.length; bit++) {
        const btn = INPUT_BIT_BUTTONS[bit]!;
        if ((mask & (1 << bit)) !== 0) gba.joypad.press(btn);
        else gba.joypad.release(btn);
      }
      gba.runFrame();
      framesRun = f + 1;

      // Completion check.
      const c = def.completion;
      if (c.kind === "exact_frame") {
        if (f + 1 >= c.frame) {
          completedAt = f + 1;
          break;
        }
      } else {
        // Hash the *current* frame to compare against the running
        // recent hash. We can use the cheaper rgba-sha1 here; the
        // canonical BGR555 hash is computed once at the end.
        const h = createHash("sha1")
          .update(Buffer.from(gba.framebuffer.buffer, gba.framebuffer.byteOffset, gba.framebuffer.byteLength))
          .digest("hex");
        const watchStart = c.kind === "input_then_stable" ? Math.max(c.minFrames, lastInputReleaseFrame) : c.minFrames;
        if (f + 1 >= watchStart) {
          if (h === recentHash) {
            if (stableSince === -1) stableSince = f;
            if (f - stableSince + 1 >= c.window) {
              completedAt = f + 1;
              break;
            }
          } else {
            stableSince = -1;
          }
        }
        recentHash = h;
      }
    }
  } catch (err) {
    error = (err as Error).message;
    errorAtFrame = framesRun;
  }
  const elapsedSec = (performance.now() - start) / 1000;

  // Final framebuffer.
  gba.mem.ppu.renderFrame();
  const fb = gba.framebuffer;
  const stats = summariseFrame(fb);
  const bgr555Hash = bgr555HashOf(fb);
  const rgbaSha1 = createHash("sha1")
    .update(Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength))
    .digest("hex");

  // jsmolka text probe — only meaningful for jsmolka tests, but the
  // probe is cheap so compute it for every test.
  const vram = gba.mem.vram;
  let textDrawn = false;
  outer: for (let y = 76; y < 84; y++) {
    for (let x = 56; x < 184; x++) {
      if ((vram[SCREEN_WIDTH * y + x] ?? 0) !== 0) {
        textDrawn = true;
        break outer;
      }
    }
  }

  // mgba-suite pass/total counter scan. Each suite test ROM keeps the
  // running tally in a known IWRAM struct (pass at `addr`, total at
  // `addr + 4`), found by capturing the test's final-state IWRAM with
  // `tests/probe-find-real-counter.ts` after a long run. Hard-code the
  // addresses per-test so the reported `subt=` reflects the actual
  // pass rate, not whichever "first plausible word pair" happens to
  // land at the test's intermediate capture frame.
  //
  // Note: these addresses are tied to the mgba-suite ROM commit pinned
  // in SUITES above (current SHA256: 073ac37db…). If the ROM updates,
  // re-run `tests/probe-find-real-counter.ts <test_id> <down_count>
  // 5000 <expected_total>` to find the new offsets.
  // Each category writes {pass:u32, total:u32} into an 8-byte slot of a
  // results struct in IWRAM. Found by scanning for the stable pass/total
  // pair after the category settles (slots are 8 bytes apart around the
  // already-validated dma slot 0x03002e9c / memory slot 0x030032b8).
  // Video stays 0 here — it has no IWRAM tally; runTest dispatches it to
  // runVideoComparison (Actual-vs-Expected per sub-test) instead. sio-timing
  // IS counter-scored (0x030032e4, an all-fail 0/4).
  const MGBA_COUNTER_ADDRS: Record<string, number> = {
    "mgba-suite-memory": 0x030032b8,
    "mgba-suite-io-read": 0x03002ea4,
    "mgba-suite-timing": 0x03003350,
    "mgba-suite-timers": 0x030032f8,
    "mgba-suite-timer-irq": 0x030032ec,
    "mgba-suite-dma": 0x03002e9c,
    "mgba-suite-sio-read": 0x030032d8,
    "mgba-suite-sio-timing": 0x030032e4,
    "mgba-suite-misc-edge": 0x030032c0,
    "mgba-suite-shifter": 0x030032d0,
    "mgba-suite-carry": 0x03002e94,
    "mgba-suite-multiply-long": 0x030032c8,
    "mgba-suite-bios-math": 0x03002e8c,
    "mgba-suite-video": 0
  };
  // nba-emu/hw-test framework counters — each ROM's lib/test.c statics
  // `test_count` (at `addr`) + `test_pass_count` (at `addr + 4`). NOTE
  // the byte order is REVERSED vs mgba-suite (which is pass-then-total).
  // Discovered + verified by `tests/probe-nba-hw-test.ts` against the
  // `test_expect*(` call count in each ROM's source/main.c.
  // 0 = pure-visual ROM with no framework counter (bgpd, bgx, etc.).
  const NBA_COUNTER_ADDRS: Record<string, number> = {
    "nba-bus-128kb-boundary": 0x030003dc,
    "nba-dma-burst-into-tears": 0x03000234,
    "nba-dma-force-nseq-access": 0x0300014c,
    "nba-dma-latch": 0x0300014c,
    "nba-dma-start-delay": 0x030001c4,
    "nba-haltcnt": 0x030004ec,
    "nba-irq-delay": 0x030003e8,
    "nba-ppu-vram-mirror": 0x030003f4,
    "nba-timer-reload": 0x03000424,
    "nba-timer-start-stop": 0x03000264
  };

  // Counter-settle. A counter-scored test keeps ticking its pass/total
  // tally for a while after the framebuffer goes stable (the completion
  // criterion fires on framebuffer stability, which can precede the final
  // tally — e.g. mgba-suite-timing settles at f≈432 but goes visually
  // stable at f≈429). The framebuffer hash / stats above are already
  // frozen at completedAt for the visual-hash verdict; here we keep
  // running WITHOUT re-capturing them until the counter stops moving (or
  // we hit maxFrames), so the reported count is the FINAL tally.
  const settleAddr =
    def.suite === "mgba-suite"
      ? MGBA_COUNTER_ADDRS[def.id]
      : def.suite === "nba-hw-test"
        ? NBA_COUNTER_ADDRS[def.id]
        : undefined;
  if (!error && settleAddr !== undefined && settleAddr !== 0) {
    const off = settleAddr - 0x03000000;
    const pairKey = (): number => {
      const iw = gba.mem.iwram;
      const a = (iw[off]! | (iw[off + 1]! << 8) | (iw[off + 2]! << 16) | (iw[off + 3]! << 24)) >>> 0;
      const b = (iw[off + 4]! | (iw[off + 5]! << 8) | (iw[off + 6]! << 16) | (iw[off + 7]! << 24)) >>> 0;
      return ((Math.imul(a, 100003) + b) >>> 0) | 0;
    };
    let last = pairKey();
    let stableFor = 0;
    try {
      for (let f = framesRun; f < def.maxFrames && stableFor < 20; f++) {
        gba.runFrame();
        framesRun = f + 1;
        const cur = pairKey();
        if (cur === last) stableFor++;
        else {
          stableFor = 0;
          last = cur;
        }
      }
    } catch {
      /* a crash during settle leaves the last-read tally; verdict still uses it */
    }
  }

  let subtestPass: number | null = null;
  let subtestTotal: number | null = null;
  if (def.suite === "mgba-suite") {
    const iwram = gba.mem.iwram;
    const counterAddr = MGBA_COUNTER_ADDRS[def.id];
    if (counterAddr !== undefined && counterAddr !== 0) {
      const off = counterAddr - 0x03000000;
      const a = (iwram[off]! | (iwram[off + 1]! << 8) | (iwram[off + 2]! << 16) | (iwram[off + 3]! << 24)) >>> 0;
      const b = (iwram[off + 4]! | (iwram[off + 5]! << 8) | (iwram[off + 6]! << 16) | (iwram[off + 7]! << 24)) >>> 0;
      // Allow pass=0: a known-good address with a valid total IS a real result
      // even when every sub-test fails (e.g. sio-timing 0/4) — gating on a>0
      // would drop it back to a hash and hide the all-fail tally.
      if (b > 0 && a <= b && b < 10_000) {
        subtestPass = a;
        subtestTotal = b;
      }
    } else if (counterAddr === undefined) {
      // No mapping yet for this test — fall back to the legacy "first
      // plausible word pair" heuristic so we still get a signal.
      for (let off = 0; off < iwram.length - 8; off += 4) {
        const a = (iwram[off]! | (iwram[off + 1]! << 8) | (iwram[off + 2]! << 16) | (iwram[off + 3]! << 24)) >>> 0;
        const b = (iwram[off + 4]! | (iwram[off + 5]! << 8) | (iwram[off + 6]! << 16) | (iwram[off + 7]! << 24)) >>> 0;
        if (a > 0 && a < 5000 && b > 0 && b < 5000 && a <= b) {
          subtestPass = a;
          subtestTotal = b;
          break;
        }
      }
    }
  } else if (def.suite === "nba-hw-test") {
    const counterAddr = NBA_COUNTER_ADDRS[def.id];
    if (counterAddr !== undefined && counterAddr !== 0) {
      const iwram = gba.mem.iwram;
      const off = counterAddr - 0x03000000;
      // test_count first, then test_pass_count (see lib/test.c).
      const total = (iwram[off]! | (iwram[off + 1]! << 8) | (iwram[off + 2]! << 16) | (iwram[off + 3]! << 24)) >>> 0;
      const pass = (iwram[off + 4]! | (iwram[off + 5]! << 8) | (iwram[off + 6]! << 16) | (iwram[off + 7]! << 24)) >>> 0;
      if (total > 0 && pass <= total && total < 1000) {
        subtestPass = pass;
        subtestTotal = total;
      }
    }
  }

  return {
    framesRun,
    completedAt,
    error,
    errorAtFrame,
    finalPc: gba.cpu.regs.r[15]! >>> 0,
    cpsr: gba.cpu.regs.cpsr >>> 0,
    nonBlackPixels: stats.nonBlackPixels,
    distinctColours: stats.distinctColours,
    bgr555Hash,
    rgbaSha1,
    dispcnt: gba.mem.ppu.dispcnt,
    vcount: gba.mem.ppu.vcount,
    elapsedSec,
    r12: gba.cpu.regs.r[12]! >>> 0,
    textDrawn,
    subtestPass,
    subtestTotal
  };
}

// ─── Verdict adapters ────────────────────────────────────────────────

// pass     = matches baseline (counter equal, r12 still 0, hash unchanged)
// improve  = counter went UP / an expected-fail now passes → bless to lock
// regress  = counter went DOWN / an r12 pass turned fail → FAILS the run
// fail     = matches an expected r12 failure in the baseline (known-bad)
// changed  = golden hash changed, or signature shape flipped → FAILS the run
// new      = no baseline entry yet (run --bless) → does not fail the run
// crash / unimpl = CPU threw mid-run → FAILS the run
type Verdict = "pass" | "improve" | "regress" | "fail" | "changed" | "new" | "crash" | "unimpl";

interface Reported {
  verdict: Verdict;
  detail: string;
}

function classifyError(err: string): "crash" | "unimpl" {
  return /unimplemented/i.test(err) ? "unimpl" : "crash";
}

function describeSig(s: Signature): string {
  switch (s.kind) {
    case "count":
      return `${s.pass}/${s.total}`;
    case "r12fail":
      return `fail #${s.test}`;
    case "hash":
      return `bgr=${s.hash.slice(0, 8)}`;
  }
}

/** Compare a run's self-reported signature to its baseline entry. */
function verdictFor(test: TestDef, r: RunResult, base: Signature | undefined): Reported {
  if (r.error) return { verdict: classifyError(r.error), detail: r.error };
  const sig = signatureOf(test, r);
  if (!base) return { verdict: "new", detail: describeSig(sig) };

  if (base.kind === "count" && sig.kind === "count") {
    if (sig.total !== base.total) {
      return { verdict: "changed", detail: `total ${base.total}→${sig.total} (pass ${sig.pass})` };
    }
    if (sig.pass < base.pass) return { verdict: "regress", detail: `${sig.pass}/${sig.total} (was ${base.pass})` };
    if (sig.pass > base.pass) return { verdict: "improve", detail: `${sig.pass}/${sig.total} (was ${base.pass})` };
    return { verdict: "pass", detail: `${sig.pass}/${sig.total}` };
  }
  if (base.kind === "r12fail") {
    if (sig.kind === "r12fail" && sig.test === base.test) return { verdict: "fail", detail: `#${sig.test} (known)` };
    return { verdict: "changed", detail: describeSig(sig) };
  }
  if (base.kind === "hash") {
    if (sig.kind === "hash" && sig.hash === base.hash)
      return { verdict: "pass", detail: `bgr=${sig.hash.slice(0, 8)}` };
    return { verdict: "changed", detail: describeSig(sig) };
  }
  // Signature shape flipped vs baseline (e.g. a counter test stopped
  // reporting a counter) — always worth a hard look.
  return { verdict: "changed", detail: `${base.kind}→${describeSig(sig)}` };
}

function statusGlyph(v: Verdict): string {
  switch (v) {
    case "pass":
      return "✓ pass  ";
    case "improve":
      return "▲ better ";
    case "regress":
      return "✗ regress";
    case "fail":
      return "· fail  ";
    case "changed":
      return "✗ changed";
    case "new":
      return "? new   ";
    case "unimpl":
      return "◐ unimpl";
    case "crash":
      return "✗ crash ";
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // First positional arg that isn't a flag is the filter.
  const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));
  // `--bless` rewrites the baseline from this run's results (use after a
  // real, verified accuracy change). Without it, the run is a gate.
  const bless = process.argv.includes("--bless");
  await ensureRoms();
  const baseline = loadBaseline();
  console.log("");

  const filtered = filter
    ? TESTS.filter(
        (t) =>
          t.id.toLowerCase().includes(filter.toLowerCase()) ||
          t.suite.toLowerCase().includes(filter.toLowerCase()) ||
          `${t.suite}/${t.rom}`.toLowerCase().includes(filter.toLowerCase())
      )
    : TESTS;
  if (filtered.length === 0) {
    console.log(`No tests matched "${filter}".`);
    process.exitCode = 1;
    return;
  }

  // Optional BIOS image. Prefer the real Nintendo BIOS (jsmolka-bios
  // #1 checks the first instruction byte-for-byte), fall back to the
  // Cult-of-GBA open-source replacement BIOS, fall back to no BIOS.
  // tests/gba-roms/ is gitignored so neither byte stream lands in the
  // repo. The browser build no longer bundles a BIOS — production
  // runs through HLE only — but the test runner still honours either
  // file when present, useful for diffing against real-BIOS output.
  const biosNintendoPath = join(ROMS_DIR, "gba_bios.bin");
  const biosOpenPath = join(ROMS_DIR, "gba_bios_cult_of_gba.bin");
  let biosBytes: Uint8Array | null = null;
  let biosSource = "none";
  // The gate runs HLE (the config the browser ships) against the
  // committed baseline. `--bios` opts into a real BIOS as a LOCAL
  // diagnostic, scored against a gitignored baseline (see BASELINE_PATH).
  if (USE_BIOS) {
    if (existsSync(biosNintendoPath)) {
      biosBytes = new Uint8Array(readFileSync(biosNintendoPath));
      biosSource = "Nintendo (diagnostic)";
    } else if (existsSync(biosOpenPath)) {
      biosBytes = new Uint8Array(readFileSync(biosOpenPath));
      biosSource = "Cult-of-GBA (diagnostic)";
    } else {
      console.error("--bios requires a real BIOS at tests/gba-roms/gba_bios.bin (or gba_bios_cult_of_gba.bin).");
      process.exit(1);
    }
  } else {
    biosSource = "HLE";
  }
  console.log(`Running ${filtered.length} test(s)… (BIOS: ${biosSource})`);
  console.log("");

  const tally: Record<Verdict, number> = {
    pass: 0,
    improve: 0,
    regress: 0,
    fail: 0,
    changed: 0,
    new: 0,
    crash: 0,
    unimpl: 0
  };
  // This run's signatures, keyed by test id — written out by --bless.
  const signatures: Record<string, Signature> = {};
  const startTime = performance.now();

  // Cache loaded ROM bytes — mgba-suite's 14 tests reuse one ROM, so
  // re-reading from disk per test is wasteful.
  const romCache = new Map<string, Uint8Array>();

  const envWorkers = Number(process.env.GBA_TEST_WORKERS);
  const workerCount = Math.min(
    Number.isFinite(envWorkers) && envWorkers >= 1 ? Math.floor(envWorkers) : Math.min(4, availableParallelism()),
    filtered.length
  );

  const printResult = (test: TestDef, r: RunResult): void => {
    const reported = verdictFor(test, r, baseline[test.id]);
    tally[reported.verdict]++;
    if (!r.error) signatures[test.id] = signatureOf(test, r);
    const detail = reported.detail ? `  ${reported.detail}` : "";
    const pcInfo = r.error ? ` @ 0x${r.finalPc.toString(16).padStart(8, "0")}` : "";
    const stats = ` (f=${r.completedAt}/${test.maxFrames} ${r.elapsedSec.toFixed(2)}s)`;
    console.log(`  ${test.id.padEnd(28)} ${statusGlyph(reported.verdict)}${detail}${pcInfo}${stats}`);
  };

  const loadRomBytes = (test: TestDef): Uint8Array => {
    const romPath = join(ROMS_DIR, test.suite, test.rom);
    let bytes = romCache.get(romPath);
    if (!bytes) {
      bytes = new Uint8Array(readFileSync(romPath));
      romCache.set(romPath, bytes);
    }
    return bytes;
  };

  if (workerCount <= 1) {
    for (const test of filtered) printResult(test, runTest(test, loadRomBytes(test), biosBytes));
  } else {
    console.log(`  (running with ${workerCount} workers)`);
    await new Promise<void>((resolveAll, rejectAll) => {
      let nextIdx = 0;
      let completed = 0;
      const inFlight = new Map<Worker, TestDef>();
      const workers: Worker[] = [];

      const dispatch = (worker: Worker): void => {
        if (nextIdx >= filtered.length) {
          worker.terminate();
          return;
        }
        const test = filtered[nextIdx++]!;
        inFlight.set(worker, test);
        const job: WorkerJob = { test, romBytes: loadRomBytes(test), biosBytes };
        worker.postMessage(job);
      };

      for (let i = 0; i < workerCount; i++) {
        const w = new Worker(new URL("./run-gba-roms-worker.mjs", import.meta.url));
        workers.push(w);
        w.on("message", (reply: WorkerReply) => {
          const test = inFlight.get(w)!;
          inFlight.delete(w);
          printResult(test, reply.result);
          completed++;
          if (completed === filtered.length) {
            for (const wk of workers) void wk.terminate();
            resolveAll();
          } else {
            dispatch(w);
          }
        });
        w.on("error", rejectAll);
        dispatch(w);
      }
    });
  }

  const elapsed = (performance.now() - startTime) / 1000;
  console.log("");
  console.log(`Summary (${filtered.length} tests in ${elapsed.toFixed(1)}s):`);
  console.log(`  ✓ pass:    ${tally.pass}    (matches baseline)`);
  console.log(`  ▲ better:  ${tally.improve}    (count up / known-fail now passes — --bless to lock in)`);
  console.log(`  · fail:    ${tally.fail}    (sub-test still failing, recorded as known-bad in baseline)`);
  console.log(`  ✗ regress: ${tally.regress}    (count dropped / a passing test started failing)`);
  console.log(`  ✗ changed: ${tally.changed}    (golden hash changed, or signature shape flipped)`);
  console.log(`  ? new:     ${tally["new"]}    (no baseline entry yet — run --bless)`);
  console.log(`  ◐ unimpl:  ${tally.unimpl}    (CPU halted on an unimplemented instruction)`);
  console.log(`  ✗ crash:   ${tally.crash}    (CPU halted on an unpredictable error)`);

  // Real-number rollup — the headline metric: total counter sub-tests passing.
  let cPass = 0;
  let cTotal = 0;
  for (const s of Object.values(signatures)) {
    if (s.kind === "count") {
      cPass += s.pass;
      cTotal += s.total;
    }
  }
  if (cTotal > 0) console.log(`\n  counter sub-tests passing: ${cPass}/${cTotal}`);

  if (USE_BIOS) {
    // Real-BIOS run is informational only: it shows how the real BIOS
    // diverges from the committed HLE baseline (~4 timing/IRQ tests). It
    // never gates and never re-records.
    if (bless) console.log("\n(--bless ignored: --bios is informational and never rewrites the committed baseline.)");
    const diff = tally.regress + tally.changed + tally.improve;
    console.log(
      diff > 0
        ? `\nℹ real-BIOS vs HLE baseline: ${diff} test(s) differ (expected — informational, not a gate).`
        : `\nℹ real-BIOS matches the HLE baseline on all ${filtered.length} test(s).`
    );
    return;
  }

  if (bless) {
    // Merge so a filtered run only rewrites the tests it actually ran.
    writeBaseline({ ...baseline, ...signatures });
    console.log(`\n✓ blessed ${Object.keys(signatures).length} test(s) → ${BASELINE_PATH}`);
    return;
  }

  const broke = tally.regress + tally.changed + tally.crash + tally.unimpl;
  console.log("");
  if (broke > 0) {
    console.log(`✗ ${broke} regression(s) / crash(es) vs baseline. Investigate, or --bless if intended.`);
    process.exitCode = 1;
  } else if (tally["new"] > 0) {
    console.log(`? ${tally["new"]} test(s) have no baseline entry — run with --bless to record them.`);
  } else if (tally.improve > 0) {
    console.log(`▲ ${tally.improve} improvement(s) — run --bless to lock the higher numbers into the baseline.`);
  } else {
    console.log(`✓ all ${filtered.length} test(s) match baseline.`);
  }
}

interface WorkerJob {
  test: TestDef;
  romBytes: Uint8Array;
  biosBytes: Uint8Array | null;
}

interface WorkerReply {
  testId: string;
  result: RunResult;
}

if (isMainThread) {
  void main();
} else if (parentPort) {
  parentPort.on("message", (job: WorkerJob) => {
    const result = runTest(job.test, job.romBytes, job.biosBytes);
    const reply: WorkerReply = { testId: job.test.id, result };
    parentPort!.postMessage(reply);
  });
}
