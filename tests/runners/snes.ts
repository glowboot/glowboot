/**
 * SNES accuracy gate — boots test/demo ROMs headlessly and scores the
 * settled framebuffer against committed baseline hashes, mirroring
 * the NES / GBA runners.
 *
 *   npm run test:roms snes                        run everything
 *   npm run test:roms snes cpuadc                 substring filter
 *   npm run test:roms snes -- --bless             re-record baselines
 *
 * ROMs come from the PeterLemon/SNES suite (pinned commit, fetched on
 * demand into the gitignored tests/roms/snes/ cache). The CPU test ROMs
 * render computed-vs-expected value tables and print FAIL markers on
 * mismatch, so a blessed hash is only recorded after eyeballing the
 * screen; every entry here was visually verified to show its passing
 * state when first blessed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Snes } from "../../src/snes/snes.js";

// Three pinned ROM sources. The higan/snes-test-roms aggregator collects all
// three projects but can't replace the other two: its PeterLemon mirror has
// only the CPU/SPC700/GSU subtrees (none of the PPU / HelloWorld / Mode7 /
// HDMA / Window demos below), and its gilyon copies lack cputest-basic and
// carry an older spctest build than the v1.4 release. Sour's and blargg's
// prebuilt ROMs exist only in the aggregator.
const REPO = "https://raw.githubusercontent.com/PeterLemon/SNES";
const COMMIT = "350b394e86ec5d62f600b5cbf64cdce3721bb6ef";
/** higan/snes-test-roms — community aggregator of hardware-behavior tests
 *  (Sour's timing tests, blargg's SPC set). Pinned GitLab commit. */
const HIGAN_REPO = "https://gitlab.com/higan/snes-test-roms/-/raw";
const HIGAN_COMMIT = "26e8aa91e0d3b90b901e7e693bc4a8244b391d7b";
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(HERE, "roms", "snes");
// Shared multi-engine baseline file; this runner owns the "snes" key.
const BASELINE_PATH = join(HERE, "roms-baseline.json");

/** id → [repo path, frames to run] */
const TESTS: Record<string, [string, number]> = {
  "demo/hello-world": ["HelloWorld/HelloWorld.sfc", 20],
  "ppu/bgmap-2bpp": ["PPU/BGMAP/8x8/2BPP/8x8BG1Map2BPP32x328PAL/8x8BG1Map2BPP32x328PAL.sfc", 20],
  "ppu/bgmap-4bpp": ["PPU/BGMAP/8x8/4BPP/8x8BGMap4BPP32x328PAL/8x8BGMap4BPP32x328PAL.sfc", 20],
  "ppu/bgmap-8bpp": ["PPU/BGMAP/8x8/8BPP/32x32/8x8BGMap8BPP32x32.sfc", 20],
  "cpu/adc": ["CPUTest/CPU/ADC/CPUADC.sfc", 600],
  "cpu/and": ["CPUTest/CPU/AND/CPUAND.sfc", 600],
  "cpu/asl": ["CPUTest/CPU/ASL/CPUASL.sfc", 600],
  "cpu/bit": ["CPUTest/CPU/BIT/CPUBIT.sfc", 600],
  "cpu/bra": ["CPUTest/CPU/BRA/CPUBRA.sfc", 600],
  "cpu/cmp": ["CPUTest/CPU/CMP/CPUCMP.sfc", 600],
  "cpu/dec": ["CPUTest/CPU/DEC/CPUDEC.sfc", 600],
  "cpu/eor": ["CPUTest/CPU/EOR/CPUEOR.sfc", 600],
  "cpu/inc": ["CPUTest/CPU/INC/CPUINC.sfc", 600],
  "cpu/jmp": ["CPUTest/CPU/JMP/CPUJMP.sfc", 600],
  "cpu/ldr": ["CPUTest/CPU/LDR/CPULDR.sfc", 600],
  "cpu/lsr": ["CPUTest/CPU/LSR/CPULSR.sfc", 600],
  "cpu/mov": ["CPUTest/CPU/MOV/CPUMOV.sfc", 600],
  "cpu/msc": ["CPUTest/CPU/MSC/CPUMSC.sfc", 600],
  "cpu/ora": ["CPUTest/CPU/ORA/CPUORA.sfc", 600],
  "cpu/phl": ["CPUTest/CPU/PHL/CPUPHL.sfc", 600],
  "cpu/psr": ["CPUTest/CPU/PSR/CPUPSR.sfc", 600],
  "cpu/ret": ["CPUTest/CPU/RET/CPURET.sfc", 600],
  "cpu/rol": ["CPUTest/CPU/ROL/CPUROL.sfc", 600],
  "cpu/ror": ["CPUTest/CPU/ROR/CPUROR.sfc", 600],
  "cpu/sbc": ["CPUTest/CPU/SBC/CPUSBC.sfc", 600],
  "cpu/str": ["CPUTest/CPU/STR/CPUSTR.sfc", 600],
  "cpu/trn": ["CPUTest/CPU/TRN/CPUTRN.sfc", 600],
  "spc700/adc": ["CPUTest/SPC700/ADC/SPC700ADC.sfc", 600],
  "spc700/and": ["CPUTest/SPC700/AND/SPC700AND.sfc", 600],
  "spc700/dec": ["CPUTest/SPC700/DEC/SPC700DEC.sfc", 600],
  "spc700/eor": ["CPUTest/SPC700/EOR/SPC700EOR.sfc", 600],
  "spc700/inc": ["CPUTest/SPC700/INC/SPC700INC.sfc", 600],
  "spc700/ora": ["CPUTest/SPC700/ORA/SPC700ORA.sfc", 600],
  "spc700/sbc": ["CPUTest/SPC700/SBC/SPC700SBC.sfc", 600],
  // Mode 7 / HDMA / window demos animate continuously — the hash locks OUR
  // deterministic frame at the given count (verified visually plausible),
  // not the upstream reference capture (arbitrary animation phase).
  "ppu/mode7-rotzoom": ["PPU/Mode7/RotZoom/RotZoom.sfc", 60],
  "ppu/mode7-perspective": ["PPU/Mode7/Perspective/Perspective.sfc", 60],
  "ppu/hdma-gradient": ["PPU/HDMA/RedSpaceHDMA/RedSpaceHDMA.sfc", 30],
  "ppu/hdma-indirect": ["PPU/HDMA/RedSpaceIndirectHDMA/RedSpaceIndirectHDMA.sfc", 30],
  "ppu/hdma-wave": ["PPU/HDMA/WaveHDMA/WaveHDMA.sfc", 30],
  "ppu/window-hdma": ["PPU/Window/WindowHDMA/WindowHDMA.sfc", 30],
  // higan-collection hardware tests (higan: path prefix). These render
  // measured values or progress text; the hash pins OUR CURRENT state —
  // several are KNOWN-BAD vs hardware (documented in the baseline notes) and
  // exist so any drift in either direction surfaces as "changed".
  "timing/dma-irq": ["higan:Sour/SnesTests/dma_irq_test/dma_irq_test.sfc", 400],
  "timing/hv-positions": ["higan:Sour/SnesTests/timing_test/timing_test.sfc", 400],
  "spc/blargg-smp": ["higan:blargg-spc-6/spc_smp.sfc", 2000],
  "spc/blargg-timer": ["higan:blargg-spc-6/spc_timer.sfc", 2000],
  "spc/blargg-dsp6": ["higan:blargg-spc-6/spc_dsp6.sfc", 2000],
  "spc/blargg-mem-access": ["higan:blargg-spc-6/spc_mem_access_times.sfc", 2000]
};

/** gilyon/snes-tests — hardware-verified 65816 + SPC700 suites, distributed
 *  as prebuilt ROMs in a pinned release zip (SHA256-checked). */
const GILYON_ZIP = "https://github.com/gilyon/snes-tests/releases/download/v1.4/snes-tests.zip";
const GILYON_SHA256 = "c3a39e15a9f3789fe143e54dfa035c988204576eafacf97df8ff3546a917c5e9";

async function fetchGilyon(entry: string): Promise<Uint8Array> {
  const local = join(CACHE, `gilyon_${entry.replaceAll("/", "_")}`);
  try {
    return new Uint8Array(readFileSync(local));
  } catch {
    // not cached yet
  }
  const res = await fetch(GILYON_ZIP);
  if (!res.ok) throw new Error(`fetch gilyon zip: HTTP ${res.status}`);
  const zipBytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(zipBytes).digest("hex");
  if (sha !== GILYON_SHA256) throw new Error(`gilyon zip SHA256 mismatch: ${sha}`);
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(zipBytes);
  mkdirSync(CACHE, { recursive: true });
  for (const name of ["cputest/cputest-basic.sfc", "cputest/cputest-full.sfc", "spctest/spctest.sfc"]) {
    const data = zip.getEntry(name)?.getData();
    if (!data) throw new Error(`gilyon zip missing ${name}`);
    writeFileSync(join(CACHE, `gilyon_${name.replaceAll("/", "_")}`), data);
  }
  return new Uint8Array(readFileSync(local));
}

/** Run a gilyon suite until its on-screen verdict. Self-verifying: the ROM
 *  reports "Success" or "Failed" + a test number in the BG1 tilemap. On a
 *  failure screen, pressing A resumes with the next tests, so one run
 *  enumerates every failing test id. */
async function runGilyon(id: string, entry: string, maxFrames: number): Promise<boolean> {
  const snes = new Snes(await fetchGilyon(entry));
  const failures: string[] = [];
  let frames = 0;
  while (frames < maxFrames) {
    snes.runFrame();
    frames++;
    if (frames % 30 !== 0) continue;
    const ppu = snes.ppu as unknown as { tilemapBase: number[] };
    let text = "";
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 32; col++) {
        const t = snes.ppu.vram[((ppu.tilemapBase[0]! + row * 32 + col) & 0x7fff) << 1]!;
        text += t >= 0x20 && t < 0x7f ? String.fromCharCode(t) : " ";
      }
    }
    if (text.includes("Success")) {
      if (failures.length === 0) {
        console.log(`${id}: ✓ Success`);
        return true;
      }
      console.log(`${id}: ✗ ${failures.length} failing (${failures.join(" ")})`);
      return false;
    }
    if (text.includes("Failed")) {
      const m = text.match(/Test number:\s*([0-9A-Fa-f]+)/);
      if (m && !failures.includes(m[1]!)) failures.push(m[1]!);
      if (failures.length > 40) break;
      snes.buttons1 = 0x0080; // A: continue past the failure screen
      for (let i = 0; i < 6; i++) {
        snes.runFrame();
        frames++;
      }
      snes.buttons1 = 0;
    }
  }
  console.log(`${id}: ✗ no verdict after ${frames} frames (${failures.length} failures recorded)`);
  return false;
}

const GILYON_TESTS: [string, string, number][] = [
  ["gilyon/cputest-basic", "cputest/cputest-basic.sfc", 20000],
  ["gilyon/cputest-full", "cputest/cputest-full.sfc", 60000],
  ["gilyon/spctest", "spctest/spctest.sfc", 30000]
];

async function fetchCached(path: string): Promise<Uint8Array> {
  const local = join(CACHE, path.replaceAll("/", "_"));
  try {
    return new Uint8Array(readFileSync(local));
  } catch {
    // not cached yet
  }
  const url = path.startsWith("higan:")
    ? `${HIGAN_REPO}/${HIGAN_COMMIT}/${encodeURI(path.slice(6))}`
    : `${REPO}/${COMMIT}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${path}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(local, bytes);
  return bytes;
}

/** Save-state determinism on a real ROM: save mid-run, continue for the
 *  ground truth, restore into a fresh console, and both must produce the
 *  identical framebuffer. Self-verifying — no baseline entry. */
async function runSaveStateRoundTrip(id: string, romPath: string, saveAt: number, runAfter: number): Promise<boolean> {
  const rom = await fetchCached(romPath);
  const a = new Snes(rom);
  for (let f = 0; f < saveAt; f++) a.runFrame();
  const blob = a.saveState();
  for (let f = 0; f < runAfter; f++) a.runFrame();
  const truth = createHash("sha256")
    .update(Buffer.from(a.framebuffer.buffer, a.framebuffer.byteOffset, a.framebuffer.length))
    .digest("hex");
  const b = new Snes(rom);
  b.loadState(blob);
  for (let f = 0; f < runAfter; f++) b.runFrame();
  const got = createHash("sha256")
    .update(Buffer.from(b.framebuffer.buffer, b.framebuffer.byteOffset, b.framebuffer.length))
    .digest("hex");
  if (truth === got) {
    console.log(`${id}: ✓ restored run matches uninterrupted run`);
    return true;
  }
  console.log(`${id}: ✗ diverged after restore (${truth.slice(0, 12)} vs ${got.slice(0, 12)})`);
  return false;
}

const SAVESTATE_TESTS: [string, string, number, number][] = [
  ["savestate/hello-world", "HelloWorld/HelloWorld.sfc", 10, 10],
  ["savestate/mode7-rotzoom", "PPU/Mode7/RotZoom/RotZoom.sfc", 40, 30],
  ["savestate/spc700-adc", "CPUTest/SPC700/ADC/SPC700ADC.sfc", 120, 60]
];

const args = process.argv.slice(2).filter((a) => a !== "--");
const bless = args.includes("--bless");
const filters = args.filter((a) => !a.startsWith("--"));

let baseline: Record<string, string> = {};
try {
  const file = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
  baseline = (file["snes"] ?? {}) as Record<string, string>;
} catch {
  // first run
}

const selected = Object.entries(TESTS).filter(([id]) => filters.length === 0 || filters.some((f) => id.includes(f)));

let pass = 0;
let fail = 0;
const blessed: Record<string, string> = { ...baseline };

for (const [id, [path, frames]] of selected) {
  const snes = new Snes(await fetchCached(path));
  for (let f = 0; f < frames; f++) snes.runFrame();
  const fb = snes.framebuffer;
  const hash = createHash("sha256")
    .update(Buffer.from(fb.buffer, fb.byteOffset, fb.length))
    .digest("hex");

  if (bless) blessed[id] = hash;
  const want = baseline[id];
  if (!want) {
    console.log(`${id}: ${bless ? "blessed" : "✗ no baseline (run with --bless)"} ${hash.slice(0, 12)}`);
    if (bless) pass++;
    else fail++;
  } else if (want === hash) {
    console.log(`${id}: ✓`);
    pass++;
  } else {
    console.log(`${id}: ✗ frame changed (baseline ${want.slice(0, 12)}, got ${hash.slice(0, 12)})`);
    fail++;
  }
}

for (const [id, path, saveAt, runAfter] of SAVESTATE_TESTS) {
  if (filters.length > 0 && !filters.some((f) => id.includes(f))) continue;
  if (await runSaveStateRoundTrip(id, path, saveAt, runAfter)) pass++;
  else fail++;
}

for (const [id, entry, maxFrames] of GILYON_TESTS) {
  if (filters.length > 0 && !filters.some((f) => id.includes(f))) continue;
  if (await runGilyon(id, entry, maxFrames)) pass++;
  else fail++;
}

if (bless) {
  const whole = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>)
    : {};
  whole["snes"] = blessed;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(whole, null, 2)}\n`);
  console.log(`\nblessed ${selected.length} baseline(s)`);
}
console.log(`\n${pass} passing · ${fail} failing`);
if (fail > 0) process.exit(1);
