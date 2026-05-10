/**
 * Test-ROM harness — runs Game Boy test ROMs (Blargg / Mooneye / etc.)
 * against the in-tree emulator and reports pass / fail. Not part of the
 * regular `npm test` chain; invoke via `npm run test:roms`.
 *
 * Test ROMs themselves live under `test-roms/` (gitignored) — fetch from
 *   https://github.com/c-sp/game-boy-test-roms/releases (latest .zip)
 *
 * Detection covers two output protocols:
 *   1. Blargg — ASCII via serial; success = collected text contains
 *      "Passed", failure = "Failed".
 *   2. Mooneye — 6 magic bytes via serial after the test ends.
 *      Pass = [3, 5, 8, 13, 21, 34] (Fibonacci). Fail = six 0x42's.
 *
 * Anything that doesn't emit serial in either format times out after
 * MAX_FRAMES. Screen-only tests (acid2 / mealybug-tearoom-tests / many
 * mooneye PPU tests) need a framebuffer-hash detector that's TBD.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GameBoy } from "../src/gb/gameboy.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_ROMS_DIR = resolve(ROOT, "test-roms");

const MAX_FRAMES = 60 * 60; // 60 seconds at 60 fps; longer than any Blargg test
const FAIL_PREVIEW_LIMIT = 200; // chars of serial output to print on fail

type Outcome = { name: string; status: "pass" | "fail" | "timeout"; serial: string; frames: number };

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

const MOONEYE_PASS = [3, 5, 8, 13, 21, 34]; // Fibonacci tail in registers / serial

function tailMatches(buf: number[], expected: number[]): boolean {
  if (buf.length < expected.length) return false;
  const start = buf.length - expected.length;
  for (let i = 0; i < expected.length; i++) {
    if (buf[start + i] !== expected[i]) return false;
  }
  return true;
}

function runOne(romPath: string): Outcome {
  const name = relative(TEST_ROMS_DIR, romPath);
  const bytes = new Uint8Array(readFileSync(romPath));

  const serialBytes: number[] = [];
  let serial = "";
  const gb = new GameBoy(bytes);
  gb.mmu.onSerialOut = (b: number) => {
    serialBytes.push(b);
    serial += String.fromCharCode(b);
  };

  for (let f = 0; f < MAX_FRAMES; f++) {
    gb.runFrame();
    // Blargg-style ASCII serial output.
    if (serial.includes("Passed")) return { name, status: "pass", serial, frames: f + 1 };
    if (serial.includes("Failed")) return { name, status: "fail", serial, frames: f + 1 };
    // Mooneye-style: 6-byte Fibonacci tail on pass, 6× 0x42 on fail.
    if (tailMatches(serialBytes, MOONEYE_PASS)) return { name, status: "pass", serial, frames: f + 1 };
    if (serialBytes.length >= 6 && serialBytes.slice(-6).every((b) => b === 0x42)) {
      return { name, status: "fail", serial, frames: f + 1 };
    }
  }
  return { name, status: "timeout", serial, frames: MAX_FRAMES };
}

function main(): void {
  const filter = process.argv[2]; // optional substring filter, e.g. "blargg/cpu_instrs"
  const all = findRoms(TEST_ROMS_DIR);
  if (all.length === 0) {
    console.error(`No ROMs found under ${TEST_ROMS_DIR}.`);
    console.error(`Fetch them with:\n  git clone --depth 1 https://github.com/c-sp/game-boy-test-roms.git test-roms`);
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

  for (const r of results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "TIME";
    console.log(`[${tag}] ${r.name}  (${r.frames} frames)`);
    if (r.status !== "pass" && r.serial) {
      const preview = r.serial.replace(/\s+/g, " ").trim().slice(0, FAIL_PREVIEW_LIMIT);
      if (preview) console.log(`        serial: ${preview}`);
    }
  }

  console.log(`\n${pass.length} passed, ${fail.length} failed, ${timeout.length} timed out.`);
  process.exit(fail.length + timeout.length > 0 ? 1 : 0);
}

main();
