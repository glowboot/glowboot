import { describe, expect, it } from "vitest";

import { Apu } from "../apu/apu.js";
import { InterruptController, IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3 } from "../memory/interrupts.js";
import { makeGbaMemoryMap } from "../memory/mapped-bus.js";
import { Timer } from "./timer.js";

function makeTimer(): { ic: InterruptController; apu: Apu; timer: Timer } {
  const ic = new InterruptController();
  const apu = new Apu();
  return { ic, apu, timer: new Timer(ic, apu) };
}

function startTimer(
  timer: Timer,
  channel: 0 | 1 | 2 | 3,
  opts: { reload: number; prescaler?: number; irq?: boolean; cascade?: boolean }
): void {
  const base = channel * 4;
  timer.write16(base + 0, opts.reload & 0xffff);
  let control = (opts.prescaler ?? 0) & 0x3;
  if (opts.cascade) control |= 0x04;
  if (opts.irq) control |= 0x40;
  control |= 0x80; // enable
  timer.write16(base + 2, control);
  // Clear the 2-cycle post-enable delay on THIS channel only so
  // subsequent `tick()` calls advance the counter immediately.
  // Calling `timer.tick(2)` would also drive every other enabled
  // timer two cycles forward (breaks cascade tests). Test bodies
  // were written before the delay was modelled.
  timer.channels[channel].enableDelay = 0;
}

describe("Timer — prescaler + reload", () => {
  it("counter starts at the programmed reload value on enable", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0xfffe });
    expect(timer.channels[0].counter).toBe(0xfffe);
  });

  it("prescaler 0 (1 CPU cycle / tick) increments counter every cycle", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x0000 });
    timer.tick(5);
    expect(timer.channels[0].counter).toBe(5);
  });

  it("prescaler 1 (64 cycles / tick) requires 64 cycles per increment", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x0000, prescaler: 1 });
    timer.tick(63);
    expect(timer.channels[0].counter).toBe(0);
    timer.tick(1);
    expect(timer.channels[0].counter).toBe(1);
  });

  it("prescaler 2 = 256 cycles, prescaler 3 = 1024 cycles", () => {
    for (const [p, period] of [
      [2, 256],
      [3, 1024]
    ] as const) {
      const { timer } = makeTimer();
      startTimer(timer, 0, { reload: 0x0000, prescaler: p });
      timer.tick(period - 1);
      expect(timer.channels[0].counter).toBe(0);
      timer.tick(1);
      expect(timer.channels[0].counter).toBe(1);
    }
  });
});

describe("Timer — overflow + reload + IRQ", () => {
  it("counter wraps from 0xFFFF back to the reload value on overflow", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x1000 });
    // Hand-set counter close to overflow to skip a long tick.
    timer.channels[0].counter = 0xffff;
    timer.tick(1);
    expect(timer.channels[0].counter).toBe(0x1000);
  });

  it("raises IRQ_TIMER0 on overflow when IRQ enabled", () => {
    const { timer, ic } = makeTimer();
    startTimer(timer, 0, { reload: 0xfffe, irq: true });
    timer.tick(2); // 0xFFFE → 0xFFFF → 0xFFFE (overflow)
    expect(ic.if_ & (1 << IRQ_TIMER0)).toBe(1 << IRQ_TIMER0);
  });

  it("does NOT raise IRQ when IRQ-enable bit is clear", () => {
    const { timer, ic } = makeTimer();
    startTimer(timer, 0, { reload: 0xffff, irq: false });
    timer.tick(1);
    expect(ic.if_ & (1 << IRQ_TIMER0)).toBe(0);
  });

  it("each channel raises its own IRQ source", () => {
    const irqs: [0 | 1 | 2 | 3, number][] = [
      [0, IRQ_TIMER0],
      [1, IRQ_TIMER1],
      [2, IRQ_TIMER2],
      [3, IRQ_TIMER3]
    ];
    for (const [ch, irq] of irqs) {
      const { timer, ic } = makeTimer();
      startTimer(timer, ch, { reload: 0xffff, irq: true });
      timer.tick(1);
      expect(ic.if_ & (1 << irq)).toBe(1 << irq);
    }
  });
});

describe("Timer — cascade mode", () => {
  it("cascade timer ticks once when the previous timer overflows", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0xffff }); // overflows on every tick
    startTimer(timer, 1, { reload: 0x0000, cascade: true });
    timer.tick(3); // 3 overflows of timer 0 → timer 1 += 3
    expect(timer.channels[0].counter).toBe(0xffff);
    expect(timer.channels[1].counter).toBe(3);
  });

  it("cascade chains through multiple timers", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0xffff });
    startTimer(timer, 1, { reload: 0xffff, cascade: true });
    startTimer(timer, 2, { reload: 0x0000, cascade: true });
    timer.tick(2); // 2 t0 overflows → 2 t1 ticks → 2 t1 overflows → t2 += 2
    expect(timer.channels[2].counter).toBe(2);
  });

  it("cascade-mode timer doesn't tick from the prescaler", () => {
    const { timer } = makeTimer();
    startTimer(timer, 1, { reload: 0x0000, cascade: true });
    // Timer 0 not enabled — timer 1 should stay stuck.
    timer.tick(10_000);
    expect(timer.channels[1].counter).toBe(0);
  });

  it("timer 0 cannot be a cascade slave (cascade bit ignored on channel 0)", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x0000, cascade: true });
    timer.tick(5);
    // Cascade ignored → prescaler still drives it.
    expect(timer.channels[0].counter).toBe(5);
  });
});

describe("Timer — bus I/O", () => {
  it("TM_L read returns the current counter, not the reload", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x1234 });
    timer.tick(10);
    expect(timer.read16(0x00)).toBe(0x1234 + 10);
  });

  it("TM_L write updates the reload value (counter only loads on enable / overflow)", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x1000 });
    timer.tick(5);
    expect(timer.channels[0].counter).toBe(0x1005);
    timer.write16(0x00, 0x5555); // change reload while running
    // Counter unchanged.
    expect(timer.channels[0].counter).toBe(0x1005);
    // TM_L writes while enabled defer by 1 cycle (STR data-phase lands
    // on the LAST instruction cycle). Park counter at 0xFFFE so the
    // overflow happens on tick 2, AFTER the pending reload has applied.
    timer.channels[0].counter = 0xfffe;
    timer.tick(2);
    expect(timer.channels[0].counter).toBe(0x5555);
  });

  it("TM_L write defers 1 cycle: first-cycle overflow uses OLD reload", () => {
    // nba-hw-test timer/reload's "FFF8 32 7" probe. The bus data
    // phase of an STR lands on the LAST cycle of the instruction, so a
    // 2-cycle STR overwrite splits the timer's batch into "tick 1 cycle
    // with OLD reload, then apply, then tick 1 cycle with NEW reload."
    // If the first cycle overflows, the reload uses the OLD value.
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0x1000 });
    timer.channels[0].counter = 0xffff;
    timer.write16(0x00, 0x5555); // overwrite RELOAD while running
    timer.tick(2); // models a 2-cycle STR
    // Cycle 1: overflow → reload = OLD 0x1000. Cycle 2 (after apply):
    // counter ticks once more → 0x1001.
    expect(timer.channels[0].counter).toBe(0x1001);
    expect(timer.channels[0].reload).toBe(0x5555); // pending applied
  });

  it("re-enabling a stopped timer reloads the counter", () => {
    const { timer } = makeTimer();
    startTimer(timer, 0, { reload: 0xaaaa });
    timer.tick(100);
    expect(timer.channels[0].counter).toBe(0xaaaa + 100);
    // Disable. TM_H writes while enabled defer 1 cycle (STR data
    // phase), so tick() through the simulated STR before the next
    // write — back-to-back STRs in real code have a 2-cycle gap.
    timer.write16(0x02, 0x0000);
    timer.tick(2);
    // Re-enable — counter should reload.
    timer.write16(0x02, 0x0080);
    expect(timer.channels[0].counter).toBe(0xaaaa);
  });
});

describe("MappedBus + Timer wiring", () => {
  it("CPU writes to 0x04000100 reach Timer channel 0's reload register", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000100, 0x1234);
    expect(mem.timer.channels[0].reload).toBe(0x1234);
  });

  it("CPU writes to 0x04000106 reach Timer channel 1's control register", () => {
    const mem = makeGbaMemoryMap();
    mem.bus.write16(0x04000106, 0x0080);
    expect(mem.timer.channels[1].enabled).toBe(true);
  });

  it("Timer overflow on channel 0 pops a Direct Sound FIFO sample when DSA is bound to timer 0", () => {
    const mem = makeGbaMemoryMap();
    // Enable APU master and bind DSA to timer 0.
    mem.bus.write16(0x04000084, 0x0080); // SOUNDCNT_X master enable
    mem.bus.write16(0x04000082, 0); // SOUNDCNT_H: DSA timer = 0 (bit 10 clear)
    mem.bus.write32(0x040000a0, 0x44332211); // push 4 samples
    expect(mem.apu.fifoA.fill).toBe(4);
    // Configure timer 0 with reload 0xFFFF so the first tick overflows.
    mem.bus.write16(0x04000100, 0xffff);
    mem.bus.write16(0x04000102, 0x80);
    // Skip the post-enable delay (tested separately) so this test
    // can probe the FIFO-pop side effect in isolation.
    mem.timer.channels[0].enableDelay = 0;
    mem.timer.tick(1);
    expect(mem.apu.fifoA.fill).toBe(3); // one sample popped
  });
});
