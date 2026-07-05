/**
 * Unified test-ROM entry point — one runner for every console.
 *
 *   npx tsx tests/run-roms.ts <engine> [args…]
 *
 *   engine   gb | gba | nes | snes | all
 *   args     forwarded verbatim to the engine's runner
 *            (filters, --bless, --bios, --screenshots, …)
 *
 * Examples:
 *   npm run test:roms gb mealybug        # one GB suite
 *   npm run test:roms gba mgba           # GBA tests matching "mgba"
 *   npm run test:roms snes -- --bless    # re-record the SNES baseline
 *   npm run test:roms all                # every baseline-gated engine
 *
 * Each engine's grading logic lives in tests/runners/<engine>.ts and is
 * spawned as its own process, so a crash in one engine can't take down an
 * `all` sweep and the per-engine scripts stay independently runnable.
 *
 * `all` runs every engine's baseline gate in sequence and exits non-zero
 * if any of them does — the pre-release check. Each engine's unfiltered
 * run diffs against its key in tests/roms-baseline.json (known-bad
 * results are tracked there, so by-design failures don't gate).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINES = ["gb", "gba", "nes", "snes"] as const;
const GATED: readonly string[] = ["gb", "gba", "nes", "snes"];

function usage(): void {
  console.log("Usage: npm run test:roms <engine> [args…]\n");
  console.log("  engine: gb | gba | nes | snes | all");
  console.log("  args:   forwarded to the engine's runner (filters, --bless, …)\n");
  console.log("  gb    baseline gate: Blargg / Mooneye / acid2 / mealybug / same-suite (--list for suites)");
  console.log("  gba   self-scoring gate: jsmolka + fuzzarm + mgba-suite + nba-hw-test");
  console.log("  nes   self-scoring gate: nestest + Blargg + sprite-hit + MMC3-IRQ + …");
  console.log("  snes  self-scoring gate: krom + gilyon + Sour + blargg SPC + save states");
  console.log("  all   every engine gate in sequence (the pre-release check)");
}

function runEngine(engine: string, args: string[]): number {
  // Every engine has a matching .mjs process entry (tsx-loader shim) next
  // to its .ts runner; the GBA one doubles as its worker-thread entry.
  const entry = join(HERE, "runners", `${engine}.mjs`);
  const res = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  return res.status ?? 1;
}

const [engine, ...rest] = process.argv.slice(2).filter((a) => a !== "--");

if (!engine || engine === "--help" || engine === "-h") {
  usage();
  process.exit(engine ? 0 : 1);
}

if (engine === "all") {
  let failed = 0;
  for (const e of GATED) {
    console.log(`\n════════ ${e.toUpperCase()} ════════`);
    if (runEngine(e, rest) !== 0) failed++;
  }
  console.log(`\n${failed === 0 ? "all engine gates green" : `${failed} engine gate(s) failing`}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (!(ENGINES as readonly string[]).includes(engine)) {
  console.error(`Unknown engine "${engine}"\n`);
  usage();
  process.exit(1);
}

process.exit(runEngine(engine, rest));
