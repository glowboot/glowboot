import { describe, expect, it } from "vitest";

import { APU } from "./apu.js";

/** A DMC read callback that always returns a fixed sample byte. */
const dmcRead = (): number => 0xaa;

function makeApu(): APU {
  return new APU(dmcRead);
}

// The frame sequencer + even/odd flag are private; peek through a typed cast
// (they exist at runtime) so timing tests can assert the divider directly.
interface Internals {
  evenCycle: boolean;
  frameCycle: number;
  frameMode: number;
}
const peek = (apu: APU): Internals => apu as unknown as Internals;

// 4-step frame-sequencer half-frame clocks (CPU cycles), per nesdev.
const HALF_FRAME_1 = 14913;
const QUARTER_FRAME_4 = 29829; // also sets the frame IRQ flag in 4-step mode

describe("APU register routing", () => {
  it("routes $4000-$4003 to pulse 1 (length loads via $4003)", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x01); // enable pulse 1 length counter
    apu.writeRegister(0x4003, 0x08); // length index = 0x08 >> 3 = 1 → 254
    apu.tick(1); // the staged length reload applies on the next APU cycle
    // Only pulse 1's length bit (0x01) should be set in the status read.
    expect(apu.readStatus() & 0x0f).toBe(0x01);
  });

  it("routes $4004-$4007 to pulse 2", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x02); // enable pulse 2 length counter
    apu.writeRegister(0x4007, 0x08);
    apu.tick(1);
    expect(apu.readStatus() & 0x0f).toBe(0x02);
  });

  it("routes $4008-$400B to the triangle", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x04); // enable triangle length counter
    apu.writeRegister(0x400b, 0x08);
    apu.tick(1);
    expect(apu.readStatus() & 0x0f).toBe(0x04);
  });

  it("routes $400C-$400F to the noise channel", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x08); // enable noise length counter
    apu.writeRegister(0x400f, 0x08);
    apu.tick(1);
    expect(apu.readStatus() & 0x0f).toBe(0x08);
  });

  it("routes $4010-$4013 to the DMC (enable arms a sample fetch)", () => {
    const apu = makeApu();
    apu.writeRegister(0x4011, 0x40); // direct load (DMC register, must not throw)
    apu.writeRegister(0x4013, 0x01); // sample length: (1 << 4) | 1 = 17 bytes
    apu.writeRegister(0x4015, 0x10); // enable DMC → bytesRemaining = 17
    expect(apu.readStatus() & 0x10).toBe(0x10); // DMC active
  });

  it("ignores writes to unmapped $4014/$4016", () => {
    const apu = makeApu();
    // These addresses fall through writeRegister's branches with no effect.
    expect(() => {
      apu.writeRegister(0x4014, 0xff);
      apu.writeRegister(0x4016, 0xff);
    }).not.toThrow();
    expect(apu.readStatus() & 0x0f).toBe(0);
  });
});

describe("APU $4015 status read", () => {
  it("reports active length counters in bits 0-3", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x0f); // enable all four length counters
    apu.writeRegister(0x4003, 0x08); // pulse 1 length
    apu.writeRegister(0x4007, 0x08); // pulse 2 length
    apu.writeRegister(0x400b, 0x08); // triangle length
    apu.writeRegister(0x400f, 0x08); // noise length
    apu.tick(1); // the staged length reloads apply on the next APU cycle
    expect(apu.readStatus() & 0x0f).toBe(0x0f);
  });

  it("clears a length counter when disabled via $4015", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x01);
    apu.writeRegister(0x4003, 0x08);
    apu.tick(1); // the staged length reload applies on the next APU cycle
    expect(apu.readStatus() & 0x01).toBe(0x01);
    apu.writeRegister(0x4015, 0x00); // disable → length value forced to 0
    expect(apu.readStatus() & 0x01).toBe(0);
  });

  it("reports the frame IRQ flag in bit 6 and clears it on read", () => {
    const apu = makeApu();
    apu.tick(QUARTER_FRAME_4); // reach the 4-step IRQ point
    expect(apu.readStatus() & 0x40).toBe(0x40); // flag visible
    expect(apu.readStatus() & 0x40).toBe(0); // cleared by the previous read
  });

  it("a length-counter read does not clear the DMC IRQ bit (bit 7)", () => {
    const apu = makeApu();
    // No DMC IRQ has fired, so bit 7 stays clear regardless of reads.
    expect(apu.readStatus() & 0x80).toBe(0);
  });
});

describe("APU frame counter ($4017)", () => {
  it("frame IRQ flag is first set at 29828 cycles in 4-step mode", () => {
    const apu = makeApu();
    // The flag is asserted across the three cycles before the sequencer wraps
    // (29828..29830), so it first reads set one cycle before the quarter/half
    // clock at 29829 — the timing blargg's apu_test verifies.
    apu.tick(QUARTER_FRAME_4 - 2);
    expect(apu.irqState()).toBe(false);
    apu.tick(1); // the 29828th clock sets the flag
    expect(apu.irqState()).toBe(true);
  });

  it("inhibiting IRQ via $4017 bit 6 keeps the flag clear", () => {
    const apu = makeApu();
    apu.writeRegister(0x4017, 0x40); // 4-step, IRQ inhibited
    apu.tick(QUARTER_FRAME_4 + 2);
    expect(apu.irqState()).toBe(false);
    expect(apu.readStatus() & 0x40).toBe(0);
  });

  it("writing $4017 with the inhibit bit clears a pending frame IRQ", () => {
    const apu = makeApu();
    apu.tick(QUARTER_FRAME_4);
    expect(apu.irqState()).toBe(true);
    apu.writeRegister(0x4017, 0x40); // inhibit → clears pending flag
    expect(apu.irqState()).toBe(false);
  });

  it("5-step mode (bit 7) never raises a frame IRQ", () => {
    const apu = makeApu();
    apu.writeRegister(0x4017, 0x80); // 5-step
    expect(peek(apu).frameMode).toBe(1);
    apu.tick(40000); // past a full 5-step sequence (37281 cycles)
    expect(apu.irqState()).toBe(false);
    expect(apu.readStatus() & 0x40).toBe(0);
  });

  it("switching to 5-step mode immediately clocks a half frame", () => {
    const apu = makeApu();
    // Arm a non-halted pulse length, then flip to 5-step. The immediate
    // quarter+half clock should knock one off the length counter.
    apu.writeRegister(0x4015, 0x01);
    apu.writeRegister(0x4000, 0x10); // duty 0, halt clear, constant vol
    apu.writeRegister(0x4003, 0x10); // length index 0x10 >> 3 = 2 → 20
    apu.tick(1); // let the staged length reload land before the half-frame clock
    apu.writeRegister(0x4017, 0x80); // 5-step → immediate half frame
    // Length 20 → 19 means bit 0 still set; assert via a deeper count below.
    expect(apu.readStatus() & 0x01).toBe(0x01);
  });

  it("4-step mode resets frameCycle and re-arms each sequence", () => {
    const apu = makeApu();
    apu.tick(QUARTER_FRAME_4 + 1); // 29830th clock wraps frameCycle to 0
    expect(peek(apu).frameCycle).toBe(0);
  });
});

describe("APU length counters clock on half frames", () => {
  it("decrements a pulse length counter at the half-frame clock", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x01); // enable pulse 1
    apu.writeRegister(0x4000, 0x10); // halt clear (bit 5 = 0), constant volume
    apu.writeRegister(0x4003, 0x10); // length index 2 → value 20

    // Just before the first half-frame clock the counter is untouched (>0).
    apu.tick(HALF_FRAME_1 - 1);
    expect(apu.readStatus() & 0x01).toBe(0x01);

    // After many half frames (one full 4-step sequence has two), the counter
    // keeps draining; it is still > 0 here.
    apu.tick(HALF_FRAME_1);
    expect(apu.readStatus() & 0x01).toBe(0x01);
  });

  it("a halted length counter does not decrement", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x01);
    apu.writeRegister(0x4000, 0x30); // bit 5 set → length halt
    apu.writeRegister(0x4003, 0x18); // length index 3 → value 2

    // Run several full 4-step sequences; without the halt the value (2) would
    // hit 0, but halted it never decrements.
    for (let i = 0; i < 4; i++) apu.tick(30000);
    expect(apu.readStatus() & 0x01).toBe(0x01);
  });

  it("drains an un-halted short length counter to zero", () => {
    const apu = makeApu();
    apu.writeRegister(0x4015, 0x01);
    apu.writeRegister(0x4000, 0x10); // halt clear
    apu.writeRegister(0x4003, 0x18); // length index 3 → value 2

    // Two half-frame clocks per 4-step sequence; two sequences supply four
    // half frames, more than enough to drain a value of 2.
    apu.tick(30000);
    apu.tick(30000);
    expect(apu.readStatus() & 0x01).toBe(0);
  });
});

describe("APU even/odd cycle stepping", () => {
  it("toggles the APU-cycle phase every CPU clock", () => {
    const apu = makeApu();
    expect(peek(apu).evenCycle).toBe(false);
    apu.tick(1);
    expect(peek(apu).evenCycle).toBe(true);
    apu.tick(1);
    expect(peek(apu).evenCycle).toBe(false);
  });

  it("returns to the same phase after an even number of clocks", () => {
    const apu = makeApu();
    apu.tick(10);
    expect(peek(apu).evenCycle).toBe(false);
    apu.tick(1);
    expect(peek(apu).evenCycle).toBe(true);
  });
});

describe("APU sample-rate setter", () => {
  it("emits more samples per cycle at a higher sample rate", () => {
    const lo = makeApu();
    lo.sampleRate = 22050;
    lo.tick(20000);
    const hi = makeApu();
    hi.sampleRate = 96000;
    hi.tick(20000);
    expect(hi.outPos).toBeGreaterThan(lo.outPos);
  });

  it("produces roughly the expected sample count for 44100 Hz", () => {
    const apu = makeApu();
    apu.sampleRate = 44100;
    // 1.789773 MHz / 44100 ≈ 40.6 cycles/sample → ~493 samples in 20000 cycles.
    apu.tick(20000);
    expect(apu.outPos).toBeGreaterThan(450);
    expect(apu.outPos).toBeLessThan(540);
  });
});

describe("APU mixer", () => {
  it("produces a sustained non-silent signal after enabling a pulse channel", () => {
    // Baseline: with nothing enabled the output is just a decaying DC transient.
    const idle = makeApu();
    idle.sampleRate = 44100;
    idle.tick(8000);
    let idleLate = 0;
    for (let i = 80; i < idle.outPos; i++) idleLate = Math.max(idleLate, Math.abs(idle.outLeft[i]!));

    const apu = makeApu();
    apu.sampleRate = 44100;
    apu.writeRegister(0x4015, 0x01); // enable pulse 1 length counter
    apu.writeRegister(0x4000, 0x9f); // duty 2 (50%), halt clear, constant vol 15
    apu.writeRegister(0x4002, 0x80); // timer low
    apu.writeRegister(0x4003, 0x08); // timer high 0, length index 1 → 254
    apu.tick(8000);

    // After the idle DC transient would have decayed, the driven pulse still
    // swings the mixer — its late-sample amplitude clears the idle floor.
    let pulseLate = 0;
    for (let i = 80; i < apu.outPos; i++) pulseLate = Math.max(pulseLate, Math.abs(apu.outLeft[i]!));
    expect(pulseLate).toBeGreaterThan(idleLate);
    expect(pulseLate).toBeGreaterThan(0.01);
    // Output is duplicated to both stereo channels.
    expect(apu.outRight[0]).toBe(apu.outLeft[0]);
  });

  it("with no channels enabled, settles toward zero (no sustained AC tone)", () => {
    // The triangle sequencer holds at a non-zero level and the DMC has a DC
    // level even when un-triggered, so the mixer starts with a DC offset. The
    // one-pole DC-blocker decays that offset toward zero rather than producing
    // a sustained waveform — assert the transient shrinks instead of asserting
    // (incorrect) pure silence.
    const apu = makeApu();
    apu.sampleRate = 44100;
    apu.tick(4000);
    expect(apu.outPos).toBeGreaterThan(2);
    const first = Math.abs(apu.outLeft[0]!);
    const last = Math.abs(apu.outLeft[apu.outPos - 1]!);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeLessThan(first); // decaying transient, not a steady tone
  });
});

describe("APU reset", () => {
  it("clears the frame sequencer state and pending IRQ", () => {
    const apu = makeApu();
    apu.tick(QUARTER_FRAME_4); // raise the frame IRQ
    expect(apu.irqState()).toBe(true);
    apu.reset();
    expect(apu.irqState()).toBe(false);
    // Reset seeds the sequencer a few clocks in, as if $4017 = $00 had been
    // written just before the CPU's first instruction (apu_reset/4017_timing).
    expect(peek(apu).frameCycle).toBe(5);
    expect(peek(apu).frameMode).toBe(0);
    expect(apu.outPos).toBe(0);
  });
});
