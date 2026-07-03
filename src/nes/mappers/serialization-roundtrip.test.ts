/**
 * Save-state round-trip sweep across every registered mapper.
 *
 * The system-level savestate gate covers four mappers (NROM/MMC1/MMC3/MMC5 —
 * the ones with cached test ROMs); this sweep closes the rest of the class at
 * the unit level. Each supported mapper is discovered from the factory,
 * driven through a deterministic register/IRQ/audio fuzz, and checked for two
 * invariants:
 *
 *  1. Encoding symmetry — serialize → deserialize into a fresh instance →
 *     serialize again must be byte-identical (catches read/write order
 *     mismatches and width drift).
 *  2. Behavioural equality — the original and the restored instance, driven
 *     with an identical continuation (writes, ticks, IRQ clocks, expansion
 *     audio, side-effectful reads), must return the same bus values and
 *     serialize identically (catches mutable state that was never serialized,
 *     which invariant 1 alone cannot see).
 */

import { describe, expect, it } from "vitest";

import type { NesRom } from "../cartridge/rom.js";
import { NesStateReader, NesStateWriter } from "../serialization/serialization.js";
import { createMapper, type Mapper } from "./mapper.js";

/** Deterministic PRNG — test must not depend on Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic cart with deterministic, bank-distinguishable content. Fresh
 *  arrays per call so instances never share mutable CHR/PRG. */
function makeRom(mapper: number): NesRom {
  const prgRom = new Uint8Array(0x40000); // 256 KiB
  for (let i = 0; i < prgRom.length; i++) prgRom[i] = (i * 7 + (i >> 13)) & 0xff;
  const chrRom = new Uint8Array(0x20000); // 128 KiB
  for (let i = 0; i < chrRom.length; i++) chrRom[i] = (i * 13 + (i >> 10)) & 0xff;
  return {
    prgRom,
    chrRom,
    usesChrRam: false,
    chrRamSize: 0,
    prgRamSize: 0x2000,
    prgNvramSize: 0x2000,
    mapper,
    submapper: 0,
    mirroring: "vertical",
    battery: false,
    region: "ntsc",
    nes2: false
  };
}

/** Register-shaped write targets: mapper registers decode sparsely (VRC /
 *  Irem / Jaleco / FME-7 style at `$x000-$x00F`; MMC5 / Bandai / Taito below
 *  $8000 at specific bases), so uniform-random addresses would rarely hit
 *  one and the fuzz would be vacuous. */
function prgRegAddr(rnd: () => number): number {
  return rnd() < 0.25
    ? 0x8000 | Math.floor(rnd() * 0x8000) // broad-decode mappers (MMC1 etc.)
    : 0x8000 | (Math.floor(rnd() * 8) << 12) | Math.floor(rnd() * 16);
}
const LOW_REG_BASES = [0x4100, 0x5000, 0x5100, 0x5200, 0x5c00, 0x6000, 0x7ef0, 0x7f00];
function lowRegAddr(rnd: () => number): number {
  return rnd() < 0.25
    ? 0x4020 + Math.floor(rnd() * 0x3fe0)
    : LOW_REG_BASES[Math.floor(rnd() * LOW_REG_BASES.length)]! + Math.floor(rnd() * 16);
}

/** Drive the mapper through `steps` deterministic operations that exercise
 *  its register file, IRQ counters, expansion audio, and side-effectful
 *  reads (MMC2/MMC4 CHR latches, Namco 163 auto-increment ports). */
function fuzz(m: Mapper, seed: number, steps: number): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < steps; i++) {
    switch (Math.floor(rnd() * 8)) {
      case 0:
      case 1:
      case 2:
        m.prgWrite(prgRegAddr(rnd), Math.floor(rnd() * 256));
        break;
      case 3:
        m.lowWrite?.(lowRegAddr(rnd), Math.floor(rnd() * 256));
        break;
      case 4:
        m.chrWrite(Math.floor(rnd() * 0x2000), Math.floor(rnd() * 256));
        break;
      case 5:
        // Budgets larger than any 16-bit IRQ latch so cycle counters loaded
        // by the register fuzz actually cross zero during the run.
        m.tick?.(1 + Math.floor(rnd() * 20000));
        for (let c = 0; c < 8; c++) m.clockIrq?.();
        break;
      case 6: {
        // Side-effectful reads count as state transitions too.
        m.chrRead(Math.floor(rnd() * 0x2000));
        m.prgRead(0x8000 | Math.floor(rnd() * 0x8000));
        m.lowRead?.(0x4020 + Math.floor(rnd() * 0x3fe0));
        break;
      }
      case 7: {
        const audio = m.audio?.();
        if (audio) for (let c = 0; c < 32; c++) audio.clock();
        m.setLargeSprites?.(rnd() < 0.5);
        break;
      }
    }
  }
}

/** Leave the mapper's IRQ machinery armed mid-flight before the snapshot:
 *  latch a large-ish count, reload, enable/acknowledge — across the register
 *  layouts of the IRQ-bearing families. The random fuzz almost always leaves
 *  the (serialized, latching) pending flag already set, which would mask a
 *  dropped counter: both instances would report IRQ forever. Arming clears
 *  pending and puts the countdown in progress, so a counter that silently
 *  fell out of the save state fires at the wrong time in the tick-only
 *  window. Harmless for mappers where these addresses are banking registers
 *  (both instances receive the same writes). */
function armIrqs(m: Mapper): void {
  // Ordered so cross-family address aliasing can't clobber a later family's
  // arm (e.g. Sunsoft-3's $C800 decodes as MMC3's $C000 latch, so the
  // MMC3-family writes come last), and every family's pending flag is
  // acknowledged by its own enable/ack register.
  const script: [number, number][] = [
    [0xf000, 0x04], // VRC: latch low nibble
    [0xf001, 0x06], //   latch high nibble
    [0xf002, 0x06], //   enable, cycle mode (write also acks)
    [0x9005, 0x60], // Irem H3001: latch hi
    [0x9006, 0x00], //   latch lo
    [0x9004, 0x00], //   reload counter from latch (acks)
    [0x9003, 0x80], //   enable (acks)
    [0xc800, 0x20], // Sunsoft-3: IRQ high
    [0xc800, 0x00], //   IRQ low
    [0xd800, 0x10], //   enable (write acks)
    [0x800b, 0x00], // Bandai FCG: latch lo
    [0x800c, 0x60], //   latch hi
    [0x800a, 0x01], //   enable + reload (acks)
    [0xc000, 0x60], // MMC3 family: latch
    [0xc001, 0x00], //   reload on next clock
    [0xe000, 0x00], //   disable + ACK the fuzz's latched pending
    [0xe001, 0x00] //   enable
  ];
  for (const [addr, value] of script) m.prgWrite(addr, value);
  m.lowWrite?.(0x5203, 0x40); // MMC5 scanline compare
  m.lowWrite?.(0x5204, 0x80); //   enable
  m.lowRead?.(0x5204); // reading $5204 acks a pending MMC5 IRQ
  m.tick?.(64); // cycle countdowns in progress, far from firing
  // Consume MMC3-style pending-reload flags and leave the scanline counters
  // mid-flight too — a snapshot taken with the reload flag still set would
  // re-synchronize a dropped counter on the first clock after restore.
  for (let i = 0; i < 16; i++) m.clockIrq?.();
}

function snapshot(m: Mapper): Uint8Array {
  const w = new NesStateWriter();
  m.serialize(w);
  return w.finalize();
}

/** Sample the mapper's externally observable surface. Reads here are applied
 *  to both instances in the same order, so side effects stay symmetric. */
function observe(m: Mapper): string {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    out.push(m.prgRead(0x8000 + i * 0x1ff));
    out.push(m.chrRead((i * 0x7f) & 0x1fff));
  }
  out.push(m.irqState?.() ? 1 : 0);
  const audio = m.audio?.();
  if (audio) out.push(audio.output() & 0xffff);
  return `${m.mirroring()}:${out.join(",")}`;
}

/** Every mapper number the factory accepts, discovered by probing — the
 *  sweep self-extends when a new mapper is registered. */
const SUPPORTED: number[] = [];
for (let n = 0; n < 256; n++) {
  try {
    createMapper(makeRom(n));
    SUPPORTED.push(n);
  } catch {
    // unsupported number
  }
}

describe("mapper save-state round-trip sweep", () => {
  it("discovers the full registered mapper set", () => {
    expect(SUPPORTED.length).toBeGreaterThanOrEqual(55);
  });

  for (const n of SUPPORTED) {
    it(`mapper ${n}: serialize/deserialize round-trips and behaves identically`, () => {
      // Several seeds so a state bug can't hide behind one seed's incidental
      // register values (e.g. whether the final fuzz left the IRQ enabled).
      for (const base of [0xc0ffee, 0x5eed01, 0x1dea77]) {
        const a = createMapper(makeRom(n));
        fuzz(a, base ^ n, 400);
        armIrqs(a);

        // 1. Encoding symmetry.
        const bytes1 = snapshot(a);
        const b = createMapper(makeRom(n));
        b.deserialize(new NesStateReader(bytes1));
        expect(snapshot(b)).toEqual(bytes1);

        // 2a. Tick-only divergence window: advance both instances with no
        // register writes, so a dropped IRQ/timer counter (invisible to
        // invariant 1, and quickly re-written by a full fuzz) surfaces as the
        // IRQ lines rising at different times. The IRQ line is sampled every
        // step — pending flags latch, so a coarse-grained comparison would
        // miss two counters that both fire inside the same chunk. Total
        // budgets exceed any 16-bit cycle latch and 8-bit scanline latch.
        let irqTraceA = "";
        let irqTraceB = "";
        for (let stepI = 0; stepI < 96; stepI++) {
          a.tick?.(750);
          b.tick?.(750);
          for (let c = 0; c < 4; c++) {
            a.clockIrq?.();
            b.clockIrq?.();
          }
          irqTraceA += a.irqState?.() ? "1" : "0";
          irqTraceB += b.irqState?.() ? "1" : "0";
          if (stepI % 12 === 11) expect(observe(b)).toEqual(observe(a));
        }
        expect(irqTraceB).toEqual(irqTraceA);

        // 2b. Behavioural equality under an identical mixed continuation
        // (writes, side-effectful reads, audio), observed as a trace.
        for (let chunk = 0; chunk < 8; chunk++) {
          const seed = (base ^ n) + chunk * 977;
          fuzz(a, seed, 25);
          fuzz(b, seed, 25);
          expect(observe(b)).toEqual(observe(a));
        }
        expect(snapshot(b)).toEqual(snapshot(a));
      }
    });
  }
});
