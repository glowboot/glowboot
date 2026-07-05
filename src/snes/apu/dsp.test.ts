import { describe, expect, it } from "vitest";

import { SnesDsp } from "./dsp.js";

describe("SnesDsp register file", () => {
  it("powers on with FLG in reset+mute", () => {
    const dsp = new SnesDsp(new Uint8Array(0x10000));
    dsp.addr = 0x6c;
    expect(dsp.readData()).toBe(0xe0);
  });

  it("round-trips voice registers through the $F2/$F3 pair", () => {
    const dsp = new SnesDsp(new Uint8Array(0x10000));
    dsp.addr = 0x00; // V0 VOLL
    dsp.writeData(0x7f);
    dsp.addr = 0x24; // V2 PITCHH
    dsp.writeData(0x21);
    dsp.addr = 0x00;
    expect(dsp.readData()).toBe(0x7f);
    dsp.addr = 0x24;
    expect(dsp.readData()).toBe(0x21);
  });

  it("ignores writes to the read-only $80-$FF mirror", () => {
    const dsp = new SnesDsp(new Uint8Array(0x10000));
    dsp.addr = 0x0c;
    dsp.writeData(0x55);
    dsp.addr = 0x8c; // mirror of $0C
    dsp.writeData(0x99);
    expect(dsp.readData()).toBe(0x55); // reads mirror down, write ignored
  });

  it("KON clears the started voices' ENDX bits; ENDX writes clear it all", () => {
    const dsp = new SnesDsp(new Uint8Array(0x10000));
    // pretend voices 0-3 ended
    dsp.addr = 0x7c;
    dsp.writeData(0x00); // clear
    (dsp as unknown as { regs: Uint8Array }).regs[0x7c] = 0x0f;
    dsp.addr = 0x4c;
    dsp.writeData(0x03); // start voices 0/1
    dsp.addr = 0x7c;
    expect(dsp.readData()).toBe(0x0c); // 2/3 still flagged
    dsp.writeData(0xff);
    expect(dsp.readData()).toBe(0x00);
  });
});

describe("SnesDsp synthesis", () => {
  /** ARAM with a sample directory at $0200 pointing at a BRR sample at
   *  $0300: filter-0 blocks holding a constant positive nibble. */
  function makeAram(headerFlags = 0x01): Uint8Array {
    const aram = new Uint8Array(0x10000);
    aram[0x200] = 0x00; // start = $0300
    aram[0x201] = 0x03;
    aram[0x202] = 0x00; // loop = $0300
    aram[0x203] = 0x03;
    aram[0x300] = 0xc0 | headerFlags; // shift 12, filter 0, flags
    for (let i = 1; i < 9; i++) aram[0x300 + i] = 0x77; // nibble +7
    return aram;
  }

  function keyedDsp(aram: Uint8Array): SnesDsp {
    const dsp = new SnesDsp(aram);
    dsp.addr = 0x5d; // DIR = $0200 >> 8
    dsp.writeData(0x02);
    dsp.addr = 0x00; // V0 VOLL / VOLR
    dsp.writeData(0x7f);
    dsp.addr = 0x01;
    dsp.writeData(0x7f);
    dsp.addr = 0x02; // pitch $1000 = native rate
    dsp.writeData(0x00);
    dsp.addr = 0x03;
    dsp.writeData(0x10);
    dsp.addr = 0x07; // GAIN direct, max
    dsp.writeData(0x7f);
    dsp.addr = 0x0c; // master volumes
    dsp.writeData(0x7f);
    dsp.addr = 0x1c;
    dsp.writeData(0x7f);
    dsp.addr = 0x6c; // FLG: clear reset/mute
    dsp.writeData(0x00);
    dsp.addr = 0x4c; // KON voice 0
    dsp.writeData(0x01);
    return dsp;
  }

  it("decodes BRR filter-0 samples and produces audio", () => {
    const dsp = keyedDsp(makeAram(0x03)); // end+loop
    dsp.tick(32 * 64); // 64 output samples
    const out = new Int16Array(256);
    const n = dsp.drainSamples(out);
    expect(n).toBeGreaterThan(0);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
    // nibble 7 << 12 >> 1 = 14336, through full volumes
    expect(peak).toBeGreaterThan(4000);
  });

  it("sets ENDX when an end block plays and silences non-looping voices", () => {
    const dsp = keyedDsp(makeAram(0x01)); // end without loop
    dsp.tick(32 * 40); // play through the 16-sample block
    dsp.addr = 0x7c;
    expect(dsp.readData() & 0x01).toBe(0x01);
    dsp.addr = 0x08; // V0 ENVX — voice fell silent
    expect(dsp.readData()).toBe(0);
  });

  it("keeps looping voices alive across end blocks", () => {
    const dsp = keyedDsp(makeAram(0x03)); // end+loop
    dsp.tick(32 * 100);
    dsp.addr = 0x08;
    expect(dsp.readData()).toBeGreaterThan(0);
  });

  it("ADSR attack rises and KOF releases the envelope to silence", () => {
    const aram = makeAram(0x03);
    const dsp = keyedDsp(aram);
    dsp.addr = 0x05; // ADSR1: enable, fast attack (rate 15)
    dsp.writeData(0x8f);
    dsp.addr = 0x4c; // re-key with ADSR
    dsp.writeData(0x01);
    dsp.tick(32 * 100);
    dsp.addr = 0x08;
    const envDuringAttack = dsp.readData();
    expect(envDuringAttack).toBeGreaterThan(0);
    dsp.addr = 0x5c; // KOF
    dsp.writeData(0x01);
    dsp.tick(32 * 400); // release ramps 8/sample from <= 0x7FF
    dsp.addr = 0x08;
    expect(dsp.readData()).toBe(0);
  });

  it("half pitch plays the block at half speed", () => {
    const aram = makeAram(0x01);
    const dsp = keyedDsp(aram);
    dsp.addr = 0x03; // pitch $0800 = half rate
    dsp.writeData(0x08);
    dsp.tick(32 * 20); // 20 samples < 32 needed to finish the block
    dsp.addr = 0x7c;
    expect(dsp.readData() & 0x01).toBe(0); // not ended yet
    dsp.tick(32 * 20);
    expect(dsp.readData() & 0x01).toBe(0x01);
  });
});

describe("SnesDsp echo", () => {
  function set(dsp: SnesDsp, reg: number, v: number): void {
    dsp.addr = reg;
    dsp.writeData(v);
  }

  it("writes the echo buffer into ARAM at ESA and respects the FLG write-protect", () => {
    const aram = new Uint8Array(0x10000);
    const dsp = new SnesDsp(aram);
    set(dsp, 0x6c, 0x00); // FLG: echo writes enabled
    set(dsp, 0x6d, 0x30); // ESA = $3000
    set(dsp, 0x7d, 0x01); // EDL = 2 KiB
    set(dsp, 0x0d, 0x00); // no feedback
    aram.fill(0x55, 0x3000, 0x3010);
    dsp.tick(32 * 8); // 8 samples: echo input is silent -> zeros written
    expect(aram[0x3000]).toBe(0);
    expect(aram[0x3003]).toBe(0);

    const dsp2 = new SnesDsp(aram);
    aram.fill(0x55, 0x4000, 0x4010);
    set(dsp2, 0x6c, 0x20); // FLG bit5: write-protected
    set(dsp2, 0x6d, 0x40);
    set(dsp2, 0x7d, 0x01);
    dsp2.tick(32 * 8);
    expect(aram[0x4000]).toBe(0x55); // untouched
  });

  it("feeds the FIR-filtered buffer into the output via EVOL", () => {
    const aram = new Uint8Array(0x10000);
    // preload a loud constant into the echo region ($2000, 16-bit LE samples)
    for (let i = 0; i < 0x800; i += 2) {
      aram[0x2000 + i] = 0x00;
      aram[0x2000 + i + 1] = 0x30; // $3000 = 12288
    }
    const dsp = new SnesDsp(aram);
    set(dsp, 0x6c, 0x20); // echo write-protected (keep the preload), not muted
    set(dsp, 0x6d, 0x20); // ESA = $2000
    set(dsp, 0x7d, 0x01);
    set(dsp, 0x0f, 0x7f); // FIR tap 0 = max
    set(dsp, 0x2c, 0x7f); // EVOLL max
    set(dsp, 0x3c, 0x7f);
    set(dsp, 0x0c, 0x00); // MVOL 0 -> anything nonzero in the ring is echo
    set(dsp, 0x1c, 0x00);
    dsp.tick(32 * 16);
    const buf = new Int16Array(64);
    const n = dsp.drainSamples(buf);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]!));
    expect(peak).toBeGreaterThan(1000); // echo audibly present
  });
});
