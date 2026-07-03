import { describe, expect, it } from "vitest";

import { type Bus, CPU } from "./cpu.js";

/** Flat 64 KiB RAM bus — enough to drive small hand-assembled programs. */
class RamBus implements Bus {
  readonly mem = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.mem[addr]!;
  }
  write(addr: number, value: number): void {
    this.mem[addr] = value;
  }
}

/** RamBus that logs every read address, for asserting dummy-read side effects. */
class RecordingBus extends RamBus {
  readonly reads: number[] = [];
  override read(addr: number): number {
    this.reads.push(addr);
    return super.read(addr);
  }
}

/** Load `program` at 0x0200, point the reset vector there, and reset. */
function makeCpu(program: number[]): { cpu: CPU; bus: RamBus } {
  const bus = new RamBus();
  bus.mem.set(program, 0x0200);
  bus.mem[0xfffc] = 0x00;
  bus.mem[0xfffd] = 0x02;
  const cpu = new CPU(bus);
  cpu.reset();
  return { cpu, bus };
}

describe("CPU", () => {
  it("resets PC from the vector and starts at 7 cycles", () => {
    const { cpu } = makeCpu([0xea]);
    expect(cpu.pc).toBe(0x0200);
    expect(cpu.sp).toBe(0xfd);
    expect(cpu.cycles).toBe(7);
  });

  it("LDA immediate sets A and Z/N flags", () => {
    const { cpu } = makeCpu([0xa9, 0x00, 0xa9, 0x80]); // LDA #$00 ; LDA #$80
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & 0x02).toBe(0x02); // Z set
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.p & 0x80).toBe(0x80); // N set
    expect(cpu.p & 0x02).toBe(0x00); // Z clear
  });

  it("ADC sets carry and overflow", () => {
    const { cpu } = makeCpu([0xa9, 0x50, 0x69, 0x50]); // LDA #$50 ; ADC #$50
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0xa0);
    expect(cpu.p & 0x40).toBe(0x40); // V set (positive + positive → negative)
    expect(cpu.p & 0x01).toBe(0x00); // C clear
  });

  it("counts the branch-taken + page-cross penalty", () => {
    // At 0x0200: BEQ +0 would not cross; craft a taken branch over a page.
    const bus = new RamBus();
    // LDA #$00 (sets Z), then BEQ to 0x0300 (crosses page from ~0x0204).
    bus.mem.set([0xa9, 0x00, 0xf0, 0x7c], 0x0280); // at 0x0280
    bus.mem[0xfffc] = 0x80;
    bus.mem[0xfffd] = 0x02;
    const cpu = new CPU(bus);
    cpu.reset();
    cpu.step(); // LDA #$00 → 2 cycles
    const before = cpu.cycles;
    cpu.step(); // BEQ taken, crosses 0x0284 → 0x0300: 2 base + 1 taken + 1 page
    expect(cpu.cycles - before).toBe(4);
    expect(cpu.pc).toBe(0x0300);
  });

  it("JSR/RTS round-trips through the stack", () => {
    const { cpu, bus } = makeCpu([0x20, 0x00, 0x03]); // JSR $0300
    bus.mem[0x0300] = 0x60; // RTS
    cpu.step(); // JSR
    expect(cpu.pc).toBe(0x0300);
    expect(cpu.sp).toBe(0xfb);
    cpu.step(); // RTS
    expect(cpu.pc).toBe(0x0203);
    expect(cpu.sp).toBe(0xfd);
  });

  // Every one-byte opcode fetches (and discards) the byte after it. It is a real
  // bus access, so it matters at a side-effecting address — cpu_exec_space runs
  // an RTS/RTI/BRK from $2001 whose dummy read of $2002 resets the PPU toggle.
  it("RTS issues a dummy read of the byte after the opcode, same cycle count", () => {
    const bus = new RecordingBus();
    bus.mem.set([0x20, 0x00, 0x03], 0x0200); // JSR $0300
    bus.mem[0x0300] = 0x60; // RTS
    bus.mem[0x0301] = 0x99; // the following byte the RTS must dummy-read
    bus.mem[0xfffc] = 0x00;
    bus.mem[0xfffd] = 0x02;
    const cpu = new CPU(bus);
    cpu.reset();
    cpu.step(); // JSR → PC = $0300
    bus.reads.length = 0;
    const before = cpu.cycles;
    cpu.step(); // RTS
    expect(cpu.cycles - before).toBe(6); // dummy read replaces an internal cycle
    expect(bus.reads).toContain(0x0301);
    expect(cpu.pc).toBe(0x0203);
  });

  it("RTI issues a dummy read of the byte after the opcode", () => {
    const bus = new RecordingBus();
    // LDA/PHA ×3 push PCH=$03, PCL=$10, P=$00; RTI at $0209 returns to $0310.
    bus.mem.set([0xa9, 0x03, 0x48, 0xa9, 0x10, 0x48, 0xa9, 0x00, 0x48, 0x40], 0x0200);
    bus.mem[0x020a] = 0x99; // the following byte the RTI must dummy-read
    bus.mem[0xfffc] = 0x00;
    bus.mem[0xfffd] = 0x02;
    const cpu = new CPU(bus);
    cpu.reset();
    for (let i = 0; i < 6; i++) cpu.step(); // the three LDA/PHA pairs
    bus.reads.length = 0;
    const before = cpu.cycles;
    cpu.step(); // RTI at $0209
    expect(cpu.cycles - before).toBe(6);
    expect(bus.reads).toContain(0x020a);
    expect(cpu.pc).toBe(0x0310);
  });

  it("ANC (0x0B) copies bit 7 into carry", () => {
    const { cpu } = makeCpu([0xa9, 0xc0, 0x0b, 0x80]); // LDA #$C0 ; ANC #$80
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.p & 0x01).toBe(0x01); // C = bit 7
    expect(cpu.p & 0x80).toBe(0x80); // N
  });

  it("SBX (0xCB) sets X = (A & X) - imm with borrow in carry", () => {
    // LDA #$FF ; LDX #$0F ; SBX #$05  → X = (0xFF & 0x0F) - 5 = 0x0A, C set
    const { cpu } = makeCpu([0xa9, 0xff, 0xa2, 0x0f, 0xcb, 0x05]);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.x).toBe(0x0a);
    expect(cpu.p & 0x01).toBe(0x01); // (A&X)=0x0F >= 5 → C
  });

  it("services an NMI by pushing state and vectoring", () => {
    const { cpu, bus } = makeCpu([0xea, 0xea]);
    bus.mem[0xfffa] = 0x34;
    bus.mem[0xfffb] = 0x12;
    cpu.nmi();
    cpu.step(); // the NMI is polled during this instruction (NOP)...
    cpu.step(); // ...and taken as the next step (interrupts are serviced after the poll)
    expect(cpu.pc).toBe(0x1234);
    expect(cpu.p & 0x04).toBe(0x04); // I set on interrupt entry
  });
});
