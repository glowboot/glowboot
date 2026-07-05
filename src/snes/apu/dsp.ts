/**
 * S-DSP — the SNES's sample synthesizer.
 *
 * Eight voices play BRR-compressed samples from ARAM: 9-byte blocks (a
 * shift/filter/loop/end header + 16 nibbles) decoded through four IIR
 * prediction filters, pitched by a 14-bit phase accumulator, shaped by
 * ADSR or GAIN envelopes driven from the hardware's 32-entry rate table,
 * optionally replaced by the LFSR noise generator, and mixed per-channel
 * volume into a stereo stream at 32 kHz (one sample per 32 SPC cycles).
 *
 * Register file behaviours: the $80-$FF read-only mirror, KON clearing the
 * started voices' ENDX bits, ENDX write-clears, FLG reset/mute, ENVX/OUTX
 * live read-back. Still pending from the full chip: echo (ESA/EDL/FIR/EFB),
 * pitch modulation (PMON), and gaussian interpolation (linear for now) —
 * documented gaps, not silent ones.
 *
 * Reference: fullsnes "SNES APU" (DSP registers, BRR samples).
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";

/** Envelope/rate table: period in samples between steps (0 = never). */
// prettier-ignore
const RATE_TABLE = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128,
  96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];

const enum EnvPhase {
  Attack,
  Decay,
  Sustain,
  Release,
  Off
}

// The S-DSP's 4-tap gaussian interpolation kernel (hardware filter ROM, as
// documented in the DSP references). Index by the 8-bit fractional sample
// position; the left half mirrors for the trailing taps.
// prettier-ignore
const GAUSS = new Int16Array([
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,
  2,2,3,3,3,3,3,4,4,4,4,4,5,5,5,5,
  6,6,6,6,7,7,7,8,8,8,9,9,9,10,10,10,
  11,11,11,12,12,13,13,14,14,15,15,15,16,16,17,17,
  18,19,19,20,20,21,21,22,23,23,24,24,25,26,27,27,
  28,29,29,30,31,32,32,33,34,35,36,36,37,38,39,40,
  41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,
  58,59,60,61,62,64,65,66,67,69,70,71,73,74,76,77,
  78,80,81,83,84,86,87,89,90,92,94,95,97,99,100,102,
  104,106,107,109,111,113,115,117,118,120,122,124,126,128,130,132,
  134,137,139,141,143,145,147,150,152,154,156,159,161,163,166,168,
  171,173,175,178,180,183,186,188,191,193,196,199,201,204,207,210,
  212,215,218,221,224,227,230,233,236,239,242,245,248,251,254,257,
  260,263,267,270,273,276,280,283,286,290,293,297,300,304,307,311,
  314,318,321,325,328,332,336,339,343,347,351,354,358,362,366,370,
  374,378,381,385,389,393,397,401,405,410,414,418,422,426,430,434,
  439,443,447,451,456,460,464,469,473,477,482,486,491,495,499,504,
  508,513,517,522,527,531,536,540,545,550,554,559,563,568,573,577,
  582,587,592,596,601,606,611,615,620,625,630,635,640,644,649,654,
  659,664,669,674,678,683,688,693,698,703,708,713,718,723,728,732,
  737,742,747,752,757,762,767,772,777,782,787,792,797,802,806,811,
  816,821,826,831,836,841,846,851,855,860,865,870,875,880,884,889,
  894,899,904,908,913,918,923,927,932,937,941,946,951,955,960,965,
  969,974,978,983,988,992,997,1001,1005,1010,1014,1019,1023,1027,1032,1036,
  1040,1045,1049,1053,1057,1061,1066,1070,1074,1078,1082,1086,1090,1094,1098,1102,
  1106,1109,1113,1117,1121,1125,1128,1132,1136,1139,1143,1146,1150,1153,1157,1160,
  1164,1167,1170,1174,1177,1180,1183,1186,1190,1193,1196,1199,1202,1205,1207,1210,
  1213,1216,1219,1221,1224,1227,1229,1232,1234,1237,1239,1241,1244,1246,1248,1251,
  1253,1255,1257,1259,1261,1263,1265,1267,1269,1270,1272,1274,1275,1277,1279,1280,
  1282,1283,1284,1286,1287,1288,1290,1291,1292,1293,1294,1295,1296,1297,1297,1298,
  1299,1300,1300,1301,1302,1302,1303,1303,1303,1304,1304,1304,1304,1304,1305,1305
]);

class Voice {
  // BRR playback
  brrAddr = 0;
  bufIndex = 0;
  readonly samples = new Int16Array(16);
  prev1 = 0;
  prev2 = 0;
  pitchCounter = 0;

  /** Header of the block currently in the sample buffer. */
  blockHeader = 0;

  // envelope (0..0x7FF)
  env = 0;
  phase = EnvPhase.Off;
  /** Last four decoded samples, newest first — the gaussian kernel's taps. */
  readonly hist = new Int16Array(4);
  rateCounter = 0;

  keyOn = false;
  lastSample = 0;
}

export class SnesDsp {
  /** Exposed DSP address latch ($F2). */
  addr = 0;

  private readonly regs = new Uint8Array(0x80);
  private readonly voices: Voice[] = Array.from({ length: 8 }, () => new Voice());

  /** Stereo output ring (interleaved L/R, 32 kHz). */
  private readonly ring = new Int16Array(0x8000);
  private ringWrite = 0;
  private ringRead = 0;

  /** Host-side per-voice mute (UI feature, not serialized). */
  readonly muteChannel: boolean[] = new Array<boolean>(8).fill(false);

  /** Debugger scope taps (not serialized): one ring per voice holding the
   *  post-envelope voice output as offset-128 bytes (128 = silence), plus a
   *  peak-tracking envelope follower per voice — the same surface shape the
   *  GB/GBA APUs expose for their audio panes. */
  readonly debugBufferSize = 2048;
  readonly debugVoice: Uint8Array[] = Array.from({ length: 8 }, () => new Uint8Array(2048).fill(128));
  readonly voiceEnvelope = new Float32Array(8);
  debugBufferPos = 0;

  private sampleClock = 0;

  // Echo unit (fullsnes "DSP Echo"): a ring buffer in ARAM at ESA<<8, EDL*2 KiB
  // long, read + FIR-filtered into the output and rewritten with the EON
  // voices' mix plus EFB feedback. The 8-tap FIR history is refilled from the
  // buffer itself each sample.
  private echoPointer = 0;
  private readonly echoHistL = new Int16Array(8);
  private readonly echoHistR = new Int16Array(8);
  private echoHistPos = 0;
  private noise = 0x4000;
  private noiseCounter = 0;

  constructor(private readonly aram: Uint8Array) {
    this.regs[0x6c] = 0xe0; // FLG: reset + mute at power-on
  }

  readData(): number {
    const reg = this.addr & 0x7f;
    if ((reg & 0x0f) === 0x08) return (this.voices[reg >> 4]!.env >> 4) & 0x7f; // ENVX
    if ((reg & 0x0f) === 0x09) return (this.voices[reg >> 4]!.lastSample >> 8) & 0xff; // OUTX
    return this.regs[reg]!;
  }

  writeData(v: number): void {
    if (this.addr >= 0x80) return; // upper half is read-only mirror
    const reg = this.addr & 0x7f;
    switch (reg) {
      case 0x4c: // KON — starting a voice clears its ENDX bit
        this.regs[0x7c] = this.regs[0x7c]! & ~v;
        this.regs[reg] = v;
        for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOn(i);
        break;
      case 0x5c: // KOF — release
        this.regs[reg] = v;
        for (let i = 0; i < 8; i++) {
          if ((v & (1 << i)) !== 0 && this.voices[i]!.phase !== EnvPhase.Off) {
            this.voices[i]!.phase = EnvPhase.Release;
          }
        }
        break;
      case 0x7c: // ENDX — any write clears it
        this.regs[reg] = 0;
        break;
      default:
        this.regs[reg] = v;
    }
  }

  /** Direct register access for tests/serialization. */
  reg(index: number): number {
    return this.regs[index & 0x7f]!;
  }

  serialize(w: SnesStateWriter): void {
    w.u8(this.addr);
    w.bytes(this.regs);
    for (const v of this.voices) {
      w.u16(v.brrAddr);
      w.u8(v.bufIndex);
      for (let i = 0; i < 16; i++) w.i16(v.samples[i]!);
      w.i16(v.prev1);
      w.i16(v.prev2);
      w.u16(v.pitchCounter);
      w.u8(v.blockHeader);
      w.u16(v.env);
      w.u8(v.phase);
      w.u16(v.rateCounter);
      w.i16(v.lastSample);
      for (let h = 0; h < 4; h++) w.i16(v.hist[h]!);
    }
    w.u8(this.sampleClock);
    w.u16(this.noise);
    w.u16(this.noiseCounter);
    w.u16(this.echoPointer);
    for (let i = 0; i < 8; i++) w.i16(this.echoHistL[i]!);
    for (let i = 0; i < 8; i++) w.i16(this.echoHistR[i]!);
    w.u8(this.echoHistPos);
  }

  deserialize(r: SnesStateReader): void {
    this.addr = r.u8();
    r.bytes(this.regs);
    for (const v of this.voices) {
      v.brrAddr = r.u16();
      v.bufIndex = r.u8();
      for (let i = 0; i < 16; i++) v.samples[i] = r.i16();
      v.prev1 = r.i16();
      v.prev2 = r.i16();
      v.pitchCounter = r.u16();
      v.blockHeader = r.u8();
      v.env = r.u16();
      v.phase = r.u8();
      v.rateCounter = r.u16();
      v.lastSample = r.i16();
      for (let h = 0; h < 4; h++) v.hist[h] = r.i16();
    }
    this.sampleClock = r.u8();
    this.noise = r.u16();
    this.noiseCounter = r.u16();
    this.echoPointer = r.u16();
    for (let i = 0; i < 8; i++) this.echoHistL[i] = r.i16();
    for (let i = 0; i < 8; i++) this.echoHistR[i] = r.i16();
    this.echoHistPos = r.u8();
    // Drop transient audio in the ring — the next frames refill it.
    this.ringWrite = 0;
    this.ringRead = 0;
  }

  /** Pull all buffered stereo samples (interleaved L/R). */
  drainSamples(out: Int16Array): number {
    let n = 0;
    while (this.ringRead !== this.ringWrite && n < out.length) {
      out[n++] = this.ring[this.ringRead]!;
      this.ringRead = (this.ringRead + 1) & 0x7fff;
    }
    return n;
  }

  get bufferedSamples(): number {
    return (this.ringWrite - this.ringRead) & 0x7fff;
  }

  tick(spcCycles: number): void {
    this.sampleClock += spcCycles;
    while (this.sampleClock >= 32) {
      this.sampleClock -= 32;
      this.sample();
    }
  }

  // ── voice lifecycle ───────────────────────────────────────────────────

  private dirEntry(voice: number): { start: number; loop: number } {
    const dir = (this.regs[0x5d]! << 8) + this.regs[(voice << 4) | 0x04]! * 4;
    return {
      start: this.aram[dir & 0xffff]! | (this.aram[(dir + 1) & 0xffff]! << 8),
      loop: this.aram[(dir + 2) & 0xffff]! | (this.aram[(dir + 3) & 0xffff]! << 8)
    };
  }

  private keyOn(i: number): void {
    const v = this.voices[i]!;
    v.brrAddr = this.dirEntry(i).start;
    v.bufIndex = 0;
    v.prev1 = 0;
    v.prev2 = 0;
    v.pitchCounter = 0;
    v.env = 0;
    v.phase = EnvPhase.Attack;
    v.rateCounter = 0;
    v.hist.fill(0);
    this.decodeBlock(v);
    v.hist[0] = v.samples[0]!;
  }

  /** Decode the 9-byte BRR block at v.brrAddr into the sample buffer. The
   *  header's end/loop flags apply when the block is CONSUMED (see
   *  advanceBlock) — a voice keyed onto a single end block still plays it. */
  private decodeBlock(v: Voice): void {
    const header = this.aram[v.brrAddr & 0xffff]!;
    v.blockHeader = header;
    const shift = header >> 4;
    const filter = (header >> 2) & 3;

    for (let n = 0; n < 16; n++) {
      const byte = this.aram[(v.brrAddr + 1 + (n >> 1)) & 0xffff]!;
      let nib = (n & 1) === 0 ? byte >> 4 : byte & 0xf;
      nib = (nib << 28) >> 28; // sign-extend
      let s = shift <= 12 ? (nib << shift) >> 1 : (nib >> 3) << 12;
      switch (filter) {
        case 1:
          s += v.prev1 + (-v.prev1 >> 4);
          break;
        case 2:
          s += v.prev1 * 2 + ((-v.prev1 * 3) >> 5) - v.prev2 + (v.prev2 >> 4);
          break;
        case 3:
          s += v.prev1 * 2 + ((-v.prev1 * 13) >> 6) - v.prev2 + ((v.prev2 * 3) >> 4);
          break;
      }
      // clamp to 16-bit, then clip to 15-bit range as hardware does
      s = Math.max(-0x8000, Math.min(0x7fff, s));
      s = ((s << 17) >> 17) & ~0; // 15-bit sign wrap
      v.samples[n] = s;
      v.prev2 = v.prev1;
      v.prev1 = s;
    }
  }

  /** The buffered block is used up: apply its end/loop flags and decode the
   *  follower. Returns false when the voice fell silent. */
  private advanceBlock(i: number, v: Voice): boolean {
    if ((v.blockHeader & 1) !== 0) {
      this.regs[0x7c] = this.regs[0x7c]! | (1 << i);
      if ((v.blockHeader & 2) === 0) {
        v.phase = EnvPhase.Off;
        v.env = 0;
        return false;
      }
      v.brrAddr = this.dirEntry(i).loop;
    } else {
      v.brrAddr = (v.brrAddr + 9) & 0xffff;
    }
    this.decodeBlock(v);
    return true;
  }

  // ── envelope ──────────────────────────────────────────────────────────

  private stepEnvelope(i: number, v: Voice): void {
    if (v.phase === EnvPhase.Off) return;
    if (v.phase === EnvPhase.Release) {
      v.env -= 8;
      if (v.env <= 0) {
        v.env = 0;
        v.phase = EnvPhase.Off;
      }
      return;
    }

    const adsr1 = this.regs[(i << 4) | 0x05]!;
    if ((adsr1 & 0x80) !== 0) {
      // ADSR mode
      const adsr2 = this.regs[(i << 4) | 0x06]!;
      if (v.phase === EnvPhase.Attack) {
        const rate = ((adsr1 & 0xf) << 1) + 1;
        if (this.rateTick(v, rate)) {
          v.env += rate === 31 ? 1024 : 32;
          if (v.env >= 0x7e0) {
            v.env = Math.min(v.env, 0x7ff);
            v.phase = EnvPhase.Decay;
          }
        }
      } else if (v.phase === EnvPhase.Decay) {
        const rate = (((adsr1 >> 4) & 7) << 1) + 16;
        if (this.rateTick(v, rate)) v.env -= ((v.env - 1) >> 8) + 1;
        const sustainLevel = (((adsr2 >> 5) & 7) + 1) << 8;
        if (v.env <= sustainLevel) v.phase = EnvPhase.Sustain;
      } else {
        const rate = adsr2 & 0x1f;
        if (this.rateTick(v, rate)) v.env -= ((v.env - 1) >> 8) + 1;
      }
    } else {
      // GAIN mode
      const gain = this.regs[(i << 4) | 0x07]!;
      if ((gain & 0x80) === 0) {
        v.env = (gain & 0x7f) << 4;
      } else {
        const rate = gain & 0x1f;
        if (this.rateTick(v, rate)) {
          switch ((gain >> 5) & 3) {
            case 0:
              v.env -= 32;
              break; // linear decrease
            case 1:
              v.env -= ((v.env - 1) >> 8) + 1;
              break; // exp decrease
            case 2:
              v.env += 32;
              break; // linear increase
            case 3:
              v.env += v.env < 0x600 ? 32 : 8;
              break; // bent increase
          }
        }
      }
    }
    v.env = Math.max(0, Math.min(0x7ff, v.env));
  }

  private rateTick(v: Voice, rate: number): boolean {
    const period = RATE_TABLE[rate & 0x1f]!;
    if (period === 0) return false;
    v.rateCounter++;
    if (v.rateCounter >= period) {
      v.rateCounter = 0;
      return true;
    }
    return false;
  }

  // ── mixing ────────────────────────────────────────────────────────────

  private sample(): void {
    const flg = this.regs[0x6c]!;

    // noise LFSR clocks from FLG bits 0-4
    const noiseRate = RATE_TABLE[flg & 0x1f]!;
    if (noiseRate !== 0) {
      this.noiseCounter++;
      if (this.noiseCounter >= noiseRate) {
        this.noiseCounter = 0;
        const bit = (this.noise ^ (this.noise >> 1)) & 1;
        this.noise = ((this.noise >> 1) | (bit << 14)) & 0x7fff;
      }
    }

    let left = 0;
    let right = 0;
    let echoInL = 0;
    let echoInR = 0;

    for (let i = 0; i < 8; i++) {
      const v = this.voices[i]!;
      if (v.phase === EnvPhase.Off) {
        v.lastSample = 0;
        this.debugVoice[i]![this.debugBufferPos] = 128;
        this.voiceEnvelope[i] = this.voiceEnvelope[i]! * 0.9985;
        continue;
      }

      this.stepEnvelope(i, v);

      // pitch step
      const pitch = (this.regs[(i << 4) | 0x02]! | (this.regs[(i << 4) | 0x03]! << 8)) & 0x3fff;
      v.pitchCounter += pitch;
      let alive = true;
      while (v.pitchCounter >= 0x1000) {
        v.pitchCounter -= 0x1000;
        v.bufIndex++;
        if (v.bufIndex >= 16) {
          v.bufIndex = 0;
          alive = this.advanceBlock(i, v);
          if (!alive) break;
        }
        v.hist[3] = v.hist[2]!;
        v.hist[2] = v.hist[1]!;
        v.hist[1] = v.hist[0]!;
        v.hist[0] = v.samples[v.bufIndex]!;
      }
      if (!alive) {
        v.lastSample = 0;
        this.debugVoice[i]![this.debugBufferPos] = 128;
        this.voiceEnvelope[i] = this.voiceEnvelope[i]! * 0.9985;
        continue;
      }

      // 4-tap gaussian interpolation over the last decoded samples (the
      // reference kernel: three taps summed with 16-bit wrap, the newest
      // tap added afterwards, clamped, low bit cleared).
      const off = (v.pitchCounter >> 4) & 0xff;
      let s =
        ((GAUSS[255 - off]! * v.hist[3]!) >> 11) +
        ((GAUSS[511 - off]! * v.hist[2]!) >> 11) +
        ((GAUSS[256 + off]! * v.hist[1]!) >> 11);
      s = (s << 16) >> 16;
      s += (GAUSS[off]! * v.hist[0]!) >> 11;
      s = Math.max(-0x8000, Math.min(0x7fff, s)) & ~1;

      if ((this.regs[0x3d]! & (1 << i)) !== 0) {
        s = ((this.noise << 17) >> 16) >> 1; // noise replaces the sample
      }

      s = (s * v.env) >> 11;
      v.lastSample = s;

      if (this.muteChannel[i]) s = 0;
      this.debugVoice[i]![this.debugBufferPos] = 128 + (s >> 9);
      const f = Math.abs(s) / 32768;
      this.voiceEnvelope[i] = f > this.voiceEnvelope[i]! ? f : this.voiceEnvelope[i]! * 0.9985;
      const volL = (this.regs[(i << 4) | 0x00]! << 24) >> 24;
      const volR = (this.regs[(i << 4) | 0x01]! << 24) >> 24;
      left += (s * volL) >> 7;
      right += (s * volR) >> 7;
      if ((this.regs[0x4d]! & (1 << i)) !== 0) {
        echoInL += (s * volL) >> 7;
        echoInR += (s * volR) >> 7;
      }
    }

    // ── echo unit ──
    const esa = this.regs[0x6d]! << 8;
    const bufAddr = (esa + this.echoPointer) & 0xffff;
    // read the buffer into the FIR history (15-bit samples, sign-extended)
    const rawL = ((this.aram[bufAddr]! | (this.aram[(bufAddr + 1) & 0xffff]! << 8)) << 16) >> 16;
    const rawR = ((this.aram[(bufAddr + 2) & 0xffff]! | (this.aram[(bufAddr + 3) & 0xffff]! << 8)) << 16) >> 16;
    this.echoHistPos = (this.echoHistPos + 1) & 7;
    this.echoHistL[this.echoHistPos] = rawL >> 1;
    this.echoHistR[this.echoHistPos] = rawR >> 1;
    // 8-tap FIR: taps 0-6 accumulate with 16-bit wrap semantics; the final
    // tap's sum is clamped (fullsnes / verified DSP behaviour).
    let firL = 0;
    let firR = 0;
    for (let t = 0; t < 8; t++) {
      const c = (this.regs[(t << 4) | 0x0f]! << 24) >> 24;
      const h = (this.echoHistPos + t + 1) & 7;
      firL += (this.echoHistL[h]! * c) >> 6;
      firR += (this.echoHistR[h]! * c) >> 6;
      if (t === 6) {
        firL = (firL << 16) >> 16;
        firR = (firR << 16) >> 16;
      }
    }
    firL = Math.max(-0x8000, Math.min(0x7fff, firL));
    firR = Math.max(-0x8000, Math.min(0x7fff, firR));

    // write-back: EON mix + feedback, unless FLG bit 5 (ECEN̅) write-protects
    if ((flg & 0x20) === 0) {
      const efb = (this.regs[0x0d]! << 24) >> 24;
      const inL = Math.max(-0x8000, Math.min(0x7fff, echoInL + ((firL * efb) >> 7))) & ~1;
      const inR = Math.max(-0x8000, Math.min(0x7fff, echoInR + ((firR * efb) >> 7))) & ~1;
      this.aram[bufAddr] = inL & 0xff;
      this.aram[(bufAddr + 1) & 0xffff] = (inL >> 8) & 0xff;
      this.aram[(bufAddr + 2) & 0xffff] = inR & 0xff;
      this.aram[(bufAddr + 3) & 0xffff] = (inR >> 8) & 0xff;
    }

    // advance the ring: EDL selects the length (0 -> 4 bytes), latched at wrap
    this.echoPointer += 4;
    const echoBytes = Math.max(1, (this.regs[0x7d]! & 0x0f) * 512) * 4;
    if (this.echoPointer >= echoBytes) this.echoPointer = 0;

    const mute = (flg & 0x40) !== 0;
    const mvolL = (this.regs[0x0c]! << 24) >> 24;
    const mvolR = (this.regs[0x1c]! << 24) >> 24;
    const evolL = (this.regs[0x2c]! << 24) >> 24;
    const evolR = (this.regs[0x3c]! << 24) >> 24;
    const outL = mute ? 0 : Math.max(-0x8000, Math.min(0x7fff, ((left * mvolL) >> 7) + ((firL * evolL) >> 7)));
    const outR = mute ? 0 : Math.max(-0x8000, Math.min(0x7fff, ((right * mvolR) >> 7) + ((firR * evolR) >> 7)));

    this.ring[this.ringWrite] = outL;
    this.ring[(this.ringWrite + 1) & 0x7fff] = outR;
    this.ringWrite = (this.ringWrite + 2) & 0x7fff;
    if (this.ringWrite === this.ringRead) this.ringRead = (this.ringRead + 2) & 0x7fff;
    this.debugBufferPos = (this.debugBufferPos + 1) & (this.debugBufferSize - 1);
  }
}
