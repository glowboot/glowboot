/**
 * DSP-1 coprocessor (NEC uPD77C25 running Nintendo's DSP-1/1A/1B program) —
 * the fixed-point 3D-math helper used by Super Mario Kart, Pilotwings and
 * ~15 other carts. High-level emulation of the command protocol: the host
 * talks to a data register (DR) and a status register (SR); a command byte
 * selects one of ~25 operations (multiply, inverse, trig, coordinate
 * rotations, attitude matrices, and the projection pipeline used for Mode 7
 * perspective), parameters stream in as 16-bit words and results stream
 * back out.
 *
 * Ported from the community reference reconstruction of the chip's program
 * (research credited to Overload, The Dumper, Neviksti and Andreas Naive);
 * lookup tables in `dsp1-tables.ts` are the chip's own data-ROM constants.
 * The port reproduces the reference's 16-bit truncation points exactly —
 * every assignment the original makes into an int16 lvalue goes through
 * `i16()` here. Reported ROM version is DSP-1B (command $2F returns $0101),
 * matching the reference's fixed-bug behaviour (e.g. command $28).
 *
 * Reference for the interface: fullsnes "SNES Cart DSP-n".
 */

import type { SnesStateReader, SnesStateWriter } from "../serialization/serialization.js";
import { DATA_ROM, MAX_AZS_EXP, MUL_TABLE, SIN_TABLE } from "./dsp1-tables.js";

const SR_DRC = 0x04;
const SR_DRS = 0x10;
const SR_RQM = 0x80;

const enum FsmState {
  WaitCommand,
  ReadData,
  WriteData
}

/** Truncate to signed 16-bit, as C int16 assignment does. */
function i16(v: number): number {
  return (v << 16) >> 16;
}

interface CommandInfo {
  op: number; // canonical operation id (indexes the dispatch switch)
  reads: number;
  writes: number;
}

// The 0x40-entry command map (commands with bit 6/7 set are ignored).
// Several slots alias the same operation; $1A/$2A/$3A freeze the chip.
// prettier-ignore
const COMMANDS: readonly (CommandInfo | null)[] = [
  { op: 0x00, reads: 2, writes: 1 },    // multiply
  { op: 0x01, reads: 4, writes: 0 },    // attitude A
  { op: 0x02, reads: 7, writes: 4 },    // parameter
  { op: 0x03, reads: 3, writes: 3 },    // subjective A
  { op: 0x04, reads: 2, writes: 2 },    // triangle
  { op: 0x01, reads: 4, writes: 0 },
  { op: 0x06, reads: 3, writes: 3 },    // project
  { op: 0x0f, reads: 1, writes: 1 },    // memory test
  { op: 0x08, reads: 3, writes: 2 },    // radius
  { op: 0x0d, reads: 3, writes: 3 },    // objective A
  { op: 0x0a, reads: 1, writes: 4 },    // raster (continuous)
  { op: 0x0b, reads: 3, writes: 1 },    // scalar A
  { op: 0x0c, reads: 3, writes: 2 },    // rotate
  { op: 0x0d, reads: 3, writes: 3 },
  { op: 0x0e, reads: 2, writes: 2 },    // target
  { op: 0x0f, reads: 1, writes: 1 },

  { op: 0x10, reads: 2, writes: 2 },    // inverse
  { op: 0x11, reads: 4, writes: 0 },    // attitude B
  { op: 0x02, reads: 7, writes: 4 },
  { op: 0x13, reads: 3, writes: 3 },    // subjective B
  { op: 0x14, reads: 6, writes: 3 },    // gyrate
  { op: 0x11, reads: 4, writes: 0 },
  { op: 0x06, reads: 3, writes: 3 },
  { op: 0x1f, reads: 1, writes: 1024 }, // memory dump
  { op: 0x18, reads: 4, writes: 1 },    // range
  { op: 0x1d, reads: 3, writes: 3 },    // objective B
  null,                                  // $1A freezes the chip
  { op: 0x1b, reads: 3, writes: 1 },    // scalar B
  { op: 0x1c, reads: 6, writes: 3 },    // polar
  { op: 0x1d, reads: 3, writes: 3 },
  { op: 0x0e, reads: 2, writes: 2 },
  { op: 0x1f, reads: 1, writes: 1024 },

  { op: 0x20, reads: 2, writes: 1 },    // multiply (variant)
  { op: 0x21, reads: 4, writes: 0 },    // attitude C
  { op: 0x02, reads: 7, writes: 4 },
  { op: 0x23, reads: 3, writes: 3 },    // subjective C
  { op: 0x04, reads: 2, writes: 2 },
  { op: 0x21, reads: 4, writes: 0 },
  { op: 0x06, reads: 3, writes: 3 },
  { op: 0x2f, reads: 1, writes: 1 },    // memory size (ROM version)
  { op: 0x28, reads: 3, writes: 1 },    // distance
  { op: 0x2d, reads: 3, writes: 3 },    // objective C
  null,                                  // $2A freezes the chip
  { op: 0x2b, reads: 3, writes: 1 },    // scalar C
  { op: 0x0c, reads: 3, writes: 2 },
  { op: 0x2d, reads: 3, writes: 3 },
  { op: 0x0e, reads: 2, writes: 2 },
  { op: 0x2f, reads: 1, writes: 1 },

  { op: 0x10, reads: 2, writes: 2 },
  { op: 0x01, reads: 4, writes: 0 },
  { op: 0x02, reads: 7, writes: 4 },
  { op: 0x03, reads: 3, writes: 3 },
  { op: 0x14, reads: 6, writes: 3 },
  { op: 0x01, reads: 4, writes: 0 },
  { op: 0x06, reads: 3, writes: 3 },
  { op: 0x1f, reads: 1, writes: 1024 },
  { op: 0x38, reads: 4, writes: 1 },    // range (variant)
  { op: 0x0d, reads: 3, writes: 3 },
  null,                                  // $3A freezes the chip
  { op: 0x0b, reads: 3, writes: 1 },
  { op: 0x1c, reads: 6, writes: 3 },
  { op: 0x0d, reads: 3, writes: 3 },
  { op: 0x0e, reads: 2, writes: 2 },
  { op: 0x1f, reads: 1, writes: 1024 }
];

export class Dsp1 {
  private sr = 0;
  private srLowByteAccess = false;
  private dr = 0;
  private state: FsmState = FsmState.WaitCommand;
  private command = 0;
  private dataCounter = 0;
  private readonly readBuffer = new Int16Array(7);
  private readonly writeBuffer = new Int16Array(1024);
  private freeze = false;

  // Projection/attitude state shared between commands.
  private readonly matrixA = new Int16Array(9);
  private readonly matrixB = new Int16Array(9);
  private readonly matrixC = new Int16Array(9);
  private centreX = 0;
  private centreY = 0;
  private centreZ = 0;
  private centreZC = 0;
  private centreZE = 0;
  private vOffset = 0;
  private les = 0;
  private cLes = 0;
  private eLes = 0;
  private sinAas = 0;
  private cosAas = 0;
  private sinAzs = 0;
  private cosAzs = 0;
  private sinAZS = 0;
  private cosAZS = 0;
  private secAZSC1 = 0;
  private secAZSE1 = 0;
  private secAZSC2 = 0;
  private secAZSE2 = 0;
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private hx = 0;
  private hy = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.sr = SR_DRC | SR_RQM;
    this.srLowByteAccess = false;
    this.dr = 0x0080;
    this.freeze = false;
    this.state = FsmState.WaitCommand;
    this.command = 0;
    this.dataCounter = 0;
    this.readBuffer.fill(0);
    this.writeBuffer.fill(0);
    this.matrixA.fill(0);
    this.matrixB.fill(0);
    this.matrixC.fill(0);
    this.centreX = this.centreY = this.centreZ = 0;
    this.centreZC = this.centreZE = 0;
    this.vOffset = 0;
    this.les = this.cLes = this.eLes = 0;
    this.sinAas = this.cosAas = this.sinAzs = this.cosAzs = 0;
    this.sinAZS = this.cosAZS = 0;
    this.secAZSC1 = this.secAZSE1 = this.secAZSC2 = this.secAZSE2 = 0;
    this.nx = this.ny = this.nz = 0;
    this.gx = this.gy = this.gz = 0;
    this.hx = this.hy = 0;
    this.vx = this.vy = this.vz = 0;
  }

  /** SR high byte; alternate reads return 0 (the register is 16-bit but
   *  only the high byte carries flags — the chip mirrors 8-bit access). */
  getSr(): number {
    this.srLowByteAccess = !this.srLowByteAccess;
    return this.srLowByteAccess ? 0 : this.sr;
  }

  getDr(): number {
    return this.fsmStep(true, 0);
  }

  setDr(v: number): void {
    this.fsmStep(false, v & 0xff);
  }

  /** One FSM step per byte access. Returns the byte the host reads (only
   *  meaningful for reads). */
  private fsmStep(read: boolean, data: number): number {
    if ((this.sr & SR_RQM) === 0) return 0;

    let out = 0;
    if (read) {
      out = (this.sr & SR_DRS) !== 0 ? (this.dr >> 8) & 0xff : this.dr & 0xff;
    } else {
      if ((this.sr & SR_DRS) !== 0) this.dr = (this.dr & 0x00ff) | (data << 8);
      else this.dr = (this.dr & 0xff00) | data;
    }

    switch (this.state) {
      case FsmState.WaitCommand: {
        const command = this.dr & 0xff;
        if ((command & 0xc0) === 0) {
          this.command = command;
          if (command === 0x1a || command === 0x2a || command === 0x3a) {
            this.freeze = true;
          } else {
            this.dataCounter = 0;
            this.state = FsmState.ReadData;
            this.sr &= ~SR_DRC;
          }
        }
        break;
      }
      case FsmState.ReadData: {
        this.sr ^= SR_DRS;
        if ((this.sr & SR_DRS) === 0) {
          this.readBuffer[this.dataCounter++] = i16(this.dr);
          const info = COMMANDS[this.command]!;
          if (this.dataCounter >= info.reads) {
            this.execute(info.op);
            if (info.writes !== 0) {
              this.dataCounter = 0;
              this.dr = this.writeBuffer[0]! & 0xffff;
              this.state = FsmState.WriteData;
            } else {
              this.dr = 0x0080;
              this.state = FsmState.WaitCommand;
              this.sr |= SR_DRC;
            }
          }
        }
        break;
      }
      case FsmState.WriteData: {
        this.sr ^= SR_DRS;
        if ((this.sr & SR_DRS) === 0) {
          this.dataCounter++;
          const info = COMMANDS[this.command]!;
          if (this.dataCounter >= info.writes) {
            if (this.command === 0x0a && this.dr !== 0x8000) {
              // raster works in continuous mode: next line, same command
              this.readBuffer[0] = i16(this.readBuffer[0]! + 1);
              this.execute(info.op);
              this.dataCounter = 0;
              this.dr = this.writeBuffer[0]! & 0xffff;
            } else {
              this.dr = 0x0080;
              this.state = FsmState.WaitCommand;
              this.sr |= SR_DRC;
            }
          } else {
            this.dr = this.writeBuffer[this.dataCounter]! & 0xffff;
          }
        }
        break;
      }
    }

    if (this.freeze) this.sr &= ~SR_RQM;
    return out;
  }

  private execute(op: number): void {
    const inp = this.readBuffer;
    const out = this.writeBuffer;
    switch (op) {
      case 0x00: // multiply
        out[0] = i16((inp[0]! * inp[1]!) >> 15);
        break;
      case 0x20: // multiply, DSP-1B variant
        out[0] = i16(((inp[0]! * inp[1]!) >> 15) + 1);
        break;
      case 0x10: {
        // inverse
        const r = this.inverse(inp[0]!, inp[1]!);
        out[0] = r.c;
        out[1] = r.e;
        break;
      }
      case 0x04: // triangle: Y = R*sin(A), X = R*cos(A)
        out[0] = i16((this.sin(inp[0]!) * inp[1]!) >> 15);
        out[1] = i16((this.cos(inp[0]!) * inp[1]!) >> 15);
        break;
      case 0x08: {
        // radius: squared norm as a 32-bit value
        const radius = (inp[0]! * inp[0]! + inp[1]! * inp[1]! + inp[2]! * inp[2]!) << 1;
        out[0] = i16(radius);
        out[1] = i16(radius >> 16);
        break;
      }
      case 0x18:
        out[0] = i16((inp[0]! * inp[0]! + inp[1]! * inp[1]! + inp[2]! * inp[2]! - inp[3]! * inp[3]!) >> 15);
        break;
      case 0x38:
        out[0] = i16(((inp[0]! * inp[0]! + inp[1]! * inp[1]! + inp[2]! * inp[2]! - inp[3]! * inp[3]!) >> 15) + 1);
        break;
      case 0x28: {
        // distance: sqrt(X²+Y²+Z²) via table interpolation
        const radius = inp[0]! * inp[0]! + inp[1]! * inp[1]! + inp[2]! * inp[2]!;
        if (radius === 0) {
          out[0] = 0;
        } else {
          const nd = this.normalizeDouble(radius);
          let c = nd.c;
          const e = nd.e;
          if (e & 1) c = i16((c * 0x4000) >> 15);
          const pos = i16((c * 0x0040) >> 15);
          const node1 = i16(DATA_ROM[0x00d5 + pos]!);
          const node2 = i16(DATA_ROM[0x00d6 + pos]!);
          let distance = i16((((node2 - node1) * (c & 0x1ff)) >> 9) + node1);
          distance = i16(distance >> (e >> 1));
          out[0] = distance;
        }
        break;
      }
      case 0x0c: // rotate (clockwise)
        out[0] = i16(((inp[2]! * this.sin(inp[0]!)) >> 15) + ((inp[1]! * this.cos(inp[0]!)) >> 15));
        out[1] = i16(((inp[2]! * this.cos(inp[0]!)) >> 15) - ((inp[1]! * this.sin(inp[0]!)) >> 15));
        break;
      case 0x1c: {
        // polar: 3D rotation around Z, then Y, then X
        const az = inp[0]!;
        const ay = inp[1]!;
        const ax = inp[2]!;
        let x1 = inp[3]!;
        let y1 = inp[4]!;
        let z1 = inp[5]!;
        let x = i16(((y1 * this.sin(az)) >> 15) + ((x1 * this.cos(az)) >> 15));
        let y = i16(((y1 * this.cos(az)) >> 15) - ((x1 * this.sin(az)) >> 15));
        x1 = x;
        y1 = y;
        let z = i16(((x1 * this.sin(ay)) >> 15) + ((z1 * this.cos(ay)) >> 15));
        x = i16(((x1 * this.cos(ay)) >> 15) - ((z1 * this.sin(ay)) >> 15));
        out[0] = x;
        z1 = z;
        y = i16(((z1 * this.sin(ax)) >> 15) + ((y1 * this.cos(ax)) >> 15));
        z = i16(((z1 * this.cos(ax)) >> 15) - ((y1 * this.sin(ax)) >> 15));
        out[1] = y;
        out[2] = z;
        break;
      }
      case 0x01:
        this.attitude(this.matrixA, inp);
        break;
      case 0x11:
        this.attitude(this.matrixB, inp);
        break;
      case 0x21:
        this.attitude(this.matrixC, inp);
        break;
      case 0x0d:
        this.objective(this.matrixA, inp, out);
        break;
      case 0x1d:
        this.objective(this.matrixB, inp, out);
        break;
      case 0x2d:
        this.objective(this.matrixC, inp, out);
        break;
      case 0x03:
        this.subjective(this.matrixA, inp, out);
        break;
      case 0x13:
        this.subjective(this.matrixB, inp, out);
        break;
      case 0x23:
        this.subjective(this.matrixC, inp, out);
        break;
      case 0x0b:
        out[0] = i16((inp[0]! * this.matrixA[0]! + inp[1]! * this.matrixA[3]! + inp[2]! * this.matrixA[6]!) >> 15);
        break;
      case 0x1b:
        out[0] = i16((inp[0]! * this.matrixB[0]! + inp[1]! * this.matrixB[3]! + inp[2]! * this.matrixB[6]!) >> 15);
        break;
      case 0x2b:
        out[0] = i16((inp[0]! * this.matrixC[0]! + inp[1]! * this.matrixC[3]! + inp[2]! * this.matrixC[6]!) >> 15);
        break;
      case 0x14:
        this.gyrate(inp, out);
        break;
      case 0x02:
        this.parameter(inp, out);
        break;
      case 0x0a:
        this.raster(inp, out);
        break;
      case 0x0e:
        this.target(inp, out);
        break;
      case 0x06:
        this.project(inp, out);
        break;
      case 0x0f: // memory test
        out[0] = 0x0000;
        break;
      case 0x1f: // memory dump (the reference copies 512 entries)
        for (let i = 0; i < 512; i++) out[i] = i16(DATA_ROM[i]!);
        break;
      case 0x2f: // ROM version: DSP-1B
        out[0] = 0x0101;
        break;
    }
  }

  // ── command bodies ─────────────────────────────────────────────────────

  private attitude(m: Int16Array, inp: Int16Array): void {
    const sinRz = this.sin(inp[1]!);
    const cosRz = this.cos(inp[1]!);
    const sinRy = this.sin(inp[2]!);
    const cosRy = this.cos(inp[2]!);
    const sinRx = this.sin(inp[3]!);
    const cosRx = this.cos(inp[3]!);
    const s = i16(inp[0]! >> 1);

    m[0] = i16((i16((s * cosRz) >> 15) * cosRy) >> 15);
    m[1] = i16(
      ((i16((s * sinRz) >> 15) * cosRx) >> 15) + ((i16((i16((s * cosRz) >> 15) * sinRx) >> 15) * sinRy) >> 15)
    );
    m[2] = i16(
      ((i16((s * sinRz) >> 15) * sinRx) >> 15) - ((i16((i16((s * cosRz) >> 15) * cosRx) >> 15) * sinRy) >> 15)
    );
    m[3] = i16(-((i16((s * sinRz) >> 15) * cosRy) >> 15));
    m[4] = i16(
      ((i16((s * cosRz) >> 15) * cosRx) >> 15) - ((i16((i16((s * sinRz) >> 15) * sinRx) >> 15) * sinRy) >> 15)
    );
    m[5] = i16(
      ((i16((s * cosRz) >> 15) * sinRx) >> 15) + ((i16((i16((s * sinRz) >> 15) * cosRx) >> 15) * sinRy) >> 15)
    );
    m[6] = i16((s * sinRy) >> 15);
    m[7] = i16(-((i16((s * sinRx) >> 15) * cosRy) >> 15));
    m[8] = i16((i16((s * cosRx) >> 15) * cosRy) >> 15);
  }

  private objective(m: Int16Array, inp: Int16Array, out: Int16Array): void {
    const x = inp[0]!;
    const y = inp[1]!;
    const z = inp[2]!;
    out[0] = i16(((m[0]! * x) >> 15) + ((m[3]! * y) >> 15) + ((m[6]! * z) >> 15));
    out[1] = i16(((m[1]! * x) >> 15) + ((m[4]! * y) >> 15) + ((m[7]! * z) >> 15));
    out[2] = i16(((m[2]! * x) >> 15) + ((m[5]! * y) >> 15) + ((m[8]! * z) >> 15));
  }

  private subjective(m: Int16Array, inp: Int16Array, out: Int16Array): void {
    const f = inp[0]!;
    const l = inp[1]!;
    const u = inp[2]!;
    out[0] = i16(((m[0]! * f) >> 15) + ((m[1]! * l) >> 15) + ((m[2]! * u) >> 15));
    out[1] = i16(((m[3]! * f) >> 15) + ((m[4]! * l) >> 15) + ((m[5]! * u) >> 15));
    out[2] = i16(((m[6]! * f) >> 15) + ((m[7]! * l) >> 15) + ((m[8]! * u) >> 15));
  }

  private gyrate(inp: Int16Array, out: Int16Array): void {
    const az = inp[0]!;
    const ax = inp[1]!;
    const ay = inp[2]!;
    const u = inp[3]!;
    const f = inp[4]!;
    const l = inp[5]!;
    const sinAy = this.sin(ay);
    const cosAy = this.cos(ay);

    const sec = this.inverse(this.cos(ax), 0);

    // rotation around Z
    let nd = this.normalizeDouble(u * cosAy - f * sinAy);
    let c = nd.c;
    let e = i16(sec.e - nd.e);
    ({ c, e } = this.normalize(i16((c * sec.c) >> 15), e));
    out[0] = i16(az + this.denormalizeAndClip(c, e));

    // rotation around X
    out[1] = i16(ax + ((u * sinAy) >> 15) + ((f * cosAy) >> 15));

    // rotation around Y
    nd = this.normalizeDouble(u * cosAy + f * sinAy);
    c = nd.c;
    e = i16(sec.e - nd.e);
    const nSin = this.normalize(this.sin(ax), e);
    const csin = nSin.c;
    e = nSin.e;
    ({ c, e } = this.normalize(i16(-((c * ((sec.c * csin) >> 15)) >> 15)), e));
    out[2] = i16(ay + this.denormalizeAndClip(c, e) + l);
  }

  private parameter(inp: Int16Array, out: Int16Array): void {
    const fx = inp[0]!;
    const fy = inp[1]!;
    const fz = inp[2]!;
    const lfe = inp[3]!;
    const les = inp[4]!;
    const aas = inp[5]!;
    const azs = inp[6]!;

    let AZS = azs;

    this.les = les;
    this.eLes = 0;
    ({ c: this.cLes, e: this.eLes } = this.normalize(les, this.eLes));

    this.sinAas = this.sin(aas);
    this.cosAas = this.cos(aas);
    this.sinAzs = this.sin(azs);
    this.cosAzs = this.cos(azs);

    this.nx = i16((this.sinAzs * -this.sinAas) >> 15);
    this.ny = i16((this.sinAzs * this.cosAas) >> 15);
    this.nz = i16((this.cosAzs * 0x7fff) >> 15);

    this.hx = i16((this.cosAas * 0x7fff) >> 15);
    this.hy = i16((this.sinAas * 0x7fff) >> 15);

    this.vx = i16((this.cosAzs * -this.sinAas) >> 15);
    this.vy = i16((this.cosAzs * this.cosAas) >> 15);
    this.vz = i16((-this.sinAzs * 0x7fff) >> 15);

    const lfeNx = i16((lfe * this.nx) >> 15);
    const lfeNy = i16((lfe * this.ny) >> 15);
    const lfeNz = i16((lfe * this.nz) >> 15);

    this.centreX = i16(fx + lfeNx);
    this.centreY = i16(fy + lfeNy);
    this.centreZ = i16(fz + lfeNz);

    const lesNx = i16((les * this.nx) >> 15);
    const lesNy = i16((les * this.ny) >> 15);
    const lesNz = i16((les * this.nz) >> 15);

    this.gx = i16(this.centreX - lesNx);
    this.gy = i16(this.centreY - lesNy);
    this.gz = i16(this.centreZ - lesNz);

    let { c, e } = this.normalize(this.centreZ, 0);
    this.centreZC = c;
    this.centreZE = e;

    let maxAZS = i16(MAX_AZS_EXP[-e]!);
    if (AZS < 0) {
      maxAZS = i16(-maxAZS);
      if (AZS < maxAZS + 1) AZS = i16(maxAZS + 1);
    } else {
      if (AZS > maxAZS) AZS = maxAZS;
    }

    this.sinAZS = this.sin(AZS);
    this.cosAZS = this.cos(AZS);

    ({ c: this.secAZSC1, e: this.secAZSE1 } = this.inverse(this.cosAZS, 0));
    ({ c, e } = this.normalize(i16((c * this.secAZSC1) >> 15), e));
    e = i16(e + this.secAZSE1);
    c = i16((this.denormalizeAndClip(c, e) * this.sinAZS) >> 15);

    this.centreX = i16(this.centreX + ((c * this.sinAas) >> 15));
    this.centreY = i16(this.centreY - ((c * this.cosAas) >> 15));

    out[2] = this.centreX;
    out[3] = this.centreY;

    let vof = 0;
    let azsClipped = azs;
    if (azs !== AZS || azs === maxAZS) {
      if (azsClipped === -32768) azsClipped = -32767;
      let cc = i16(azsClipped - maxAZS);
      if (cc >= 0) cc = i16(cc - 1);
      let aux = i16(~(cc << 2));
      cc = i16((aux * i16(DATA_ROM[0x0328]!)) >> 15);
      cc = i16(((cc * aux) >> 15) + i16(DATA_ROM[0x0327]!));
      vof = i16(vof - ((((cc * aux) >> 15) * this.les) >> 15));
      cc = i16((aux * aux) >> 15);
      aux = i16(((cc * i16(DATA_ROM[0x0324]!)) >> 15) + i16(DATA_ROM[0x0325]!));
      this.cosAZS = i16(this.cosAZS + ((((cc * aux) >> 15) * this.cosAZS) >> 15));
    }
    out[0] = i16(vof);

    this.vOffset = i16((this.les * this.cosAZS) >> 15);

    const sec = this.inverse(this.sinAZS, 0);
    let e2 = sec.e;
    let c2: number;
    ({ c: c2, e: e2 } = this.normalize(this.vOffset, e2));
    ({ c: c2, e: e2 } = this.normalize(i16((c2 * sec.c) >> 15), e2));
    if (c2 === -32768) {
      c2 = i16(c2 >> 1);
      e2 = i16(e2 + 1);
    }
    out[1] = this.denormalizeAndClip(i16(-c2), e2);

    ({ c: this.secAZSC2, e: this.secAZSE2 } = this.inverse(this.cosAZS, 0));
  }

  private raster(inp: Int16Array, out: Int16Array): void {
    const vs = inp[0]!;

    const inv = this.inverse(i16(((vs * this.sinAzs) >> 15) + this.vOffset), 7);
    let e = i16(inv.e + this.centreZE);
    const c1 = i16((inv.c * this.centreZC) >> 15);
    const e1 = i16(e + this.secAZSE2);

    let c: number;
    ({ c, e } = this.normalize(c1, e));
    c = this.denormalizeAndClip(c, e);

    out[0] = i16((c * this.cosAas) >> 15);
    out[2] = i16((c * this.sinAas) >> 15);

    let e1v = e1;
    ({ c, e: e1v } = this.normalize(i16((c1 * this.secAZSC2) >> 15), e1v));
    c = this.denormalizeAndClip(c, e1v);

    out[1] = i16((c * -this.sinAas) >> 15);
    out[3] = i16((c * this.cosAas) >> 15);
  }

  private target(inp: Int16Array, out: Int16Array): void {
    let h = inp[0]!;
    let v = inp[1]!;

    const inv = this.inverse(i16(((v * this.sinAzs) >> 15) + this.vOffset), 8);
    let e = i16(inv.e + this.centreZE);
    const c1 = i16((inv.c * this.centreZC) >> 15);
    const e1 = i16(e + this.secAZSE1);

    h = i16(h << 8);
    let c: number;
    ({ c, e } = this.normalize(c1, e));
    c = i16((this.denormalizeAndClip(c, e) * h) >> 15);

    out[0] = i16(this.centreX + ((c * this.cosAas) >> 15));
    out[1] = i16(this.centreY - ((c * this.sinAas) >> 15));

    v = i16(v << 8);
    let e1v = e1;
    ({ c, e: e1v } = this.normalize(i16((c1 * this.secAZSC1) >> 15), e1v));
    c = i16((this.denormalizeAndClip(c, e1v) * v) >> 15);

    out[0] = i16(out[0]! + ((c * -this.sinAas) >> 15));
    out[1] = i16(out[1]! + ((c * this.cosAas) >> 15));
  }

  private project(inp: Int16Array, out: Int16Array): void {
    const x = inp[0]!;
    const y = inp[1]!;
    const z = inp[2]!;

    let nd = this.normalizeDouble((x | 0) - this.gx);
    let px = nd.c;
    let e4 = nd.e;
    nd = this.normalizeDouble((y | 0) - this.gy);
    let py = nd.c;
    let e = nd.e;
    nd = this.normalizeDouble((z | 0) - this.gz);
    let pz = nd.c;
    let e3 = nd.e;

    px = i16(px >> 1);
    e4 = i16(e4 - 1);
    py = i16(py >> 1);
    e = i16(e - 1);
    pz = i16(pz >> 1);
    e3 = i16(e3 - 1);

    let refE = e < e3 ? e : e3;
    refE = refE < e4 ? refE : e4;

    px = this.shiftR(px, i16(e4 - refE));
    py = this.shiftR(py, i16(e - refE));
    pz = this.shiftR(pz, i16(e3 - refE));

    const c11 = i16(-((px * this.nx) >> 15));
    const c8 = i16(-((py * this.ny) >> 15));
    const c9 = i16(-((pz * this.nz) >> 15));
    const c12 = i16(c11 + c8 + c9);

    let aux4 = c12 | 0;
    // The reference reuses the refE variable here (refE = 16 - refE), and
    // the H/V/M exponent sums below read the MUTATED value.
    refE = 16 - refE;
    if (refE >= 0) aux4 = aux4 << refE;
    else aux4 = aux4 >> -refE;
    if (aux4 === -1) aux4 = 0;
    aux4 >>= 1;

    const aux = ((this.les & 0xffff) + aux4) | 0;
    nd = this.normalizeDouble(aux);
    const c10 = nd.c;
    const e2 = i16(15 - nd.e);

    const inv = this.inverse(c10, 0);
    const c2 = i16((inv.c * this.cLes) >> 15);
    e4 = inv.e;

    // H
    const c17 = i16(i16((px * this.hx) >> 15) + i16((py * this.hy) >> 15));
    const c18 = i16((c17 * c2) >> 15);
    let n = this.normalize(c18, 0);
    out[0] = this.denormalizeAndClip(n.c, i16(this.eLes - e2 + refE + n.e));

    // V
    const c24 = i16(i16((px * this.vx) >> 15) + i16((py * this.vy) >> 15) + i16((pz * this.vz) >> 15));
    const c26 = i16((c24 * c2) >> 15);
    n = this.normalize(c26, 0);
    out[1] = this.denormalizeAndClip(n.c, i16(this.eLes - e2 + refE + n.e));

    // M
    n = this.normalize(c2, e4);
    out[2] = this.denormalizeAndClip(n.c, i16(n.e + this.eLes - e2 - 7));
  }

  // ── fixed-point helpers ────────────────────────────────────────────────

  private sin(angle: number): number {
    if (angle < 0) {
      if (angle === -32768) return 0;
      return i16(-this.sin(-angle));
    }
    let s = SIN_TABLE[angle >> 8]! + ((MUL_TABLE[angle & 0xff]! * SIN_TABLE[0x40 + (angle >> 8)]!) >> 15);
    if (s > 32767) s = 32767;
    return i16(s);
  }

  private cos(angle: number): number {
    let a = angle;
    if (a < 0) {
      if (a === -32768) return -32768;
      a = -a;
    }
    let s = SIN_TABLE[0x40 + (a >> 8)]! - ((MUL_TABLE[a & 0xff]! * SIN_TABLE[a >> 8]!) >> 15);
    if (s < -32768) s = -32767;
    return i16(s);
  }

  /** 1/(coefficient·2^exponent) in normalized floating-point form: a table
   *  seed refined by two Newton iterations. */
  private inverse(coefficient: number, exponent: number): { c: number; e: number } {
    if (coefficient === 0) return { c: 0x7fff, e: 0x002f };

    let coef = coefficient;
    let exp = exponent;
    let sign = 1;
    if (coef < 0) {
      if (coef < -32767) coef = -32767;
      coef = -coef;
      sign = -1;
    }
    while (coef < 0x4000) {
      coef = i16(coef << 1);
      exp = i16(exp - 1);
    }

    let iCoefficient: number;
    if (coef === 0x4000) {
      // The reference's dangling-else: the sign decides between the two
      // exact-power-of-two results.
      if (sign === 1) {
        iCoefficient = 0x7fff;
      } else {
        iCoefficient = -0x4000;
        exp = i16(exp - 1);
      }
    } else {
      let i = i16(DATA_ROM[((coef - 0x4000) >> 7) + 0x0065]!);
      i = i16((i + i16((-i * i16((coef * i) >> 15)) >> 15)) << 1);
      i = i16((i + i16((-i * i16((coef * i) >> 15)) >> 15)) << 1);
      iCoefficient = i16(i * sign);
    }
    return { c: iCoefficient, e: i16(1 - exp) };
  }

  private denormalizeAndClip(c: number, e: number): number {
    if (e > 0) {
      if (c > 0) return 32767;
      if (c < 0) return -32767;
    } else if (e < 0) {
      return i16((c * DATA_ROM[0x0031 + e]!) >> 15);
    }
    return i16(c);
  }

  /** Normalize an int16 into coefficient·2^exponent with |c| in [1/2, 1). */
  private normalize(m: number, exponent: number): { c: number; e: number } {
    let i = 0x4000;
    let e = 0;
    if (m < 0) {
      while (m & i && i) {
        i >>= 1;
        e++;
      }
    } else {
      while (!(m & i) && i) {
        i >>= 1;
        e++;
      }
    }
    const c = e > 0 ? i16((m * DATA_ROM[0x21 + e]!) << 1) : i16(m);
    return { c, e: i16(exponent - e) };
  }

  /** normalize() for a 32-bit product. */
  private normalizeDouble(product: number): { c: number; e: number } {
    const p = product | 0;
    const n = i16(p & 0x7fff);
    const m = i16(p >> 15);
    let i = 0x4000;
    let e = 0;
    if (m < 0) {
      while (m & i && i) {
        i >>= 1;
        e++;
      }
    } else {
      while (!(m & i) && i) {
        i >>= 1;
        e++;
      }
    }

    let coefficient: number;
    if (e > 0) {
      coefficient = i16((m * DATA_ROM[0x0021 + e]!) << 1);
      if (e < 15) {
        coefficient = i16(coefficient + i16((n * DATA_ROM[0x0040 - e]!) >> 15));
      } else {
        i = 0x4000;
        if (m < 0) {
          while (n & i && i) {
            i >>= 1;
            e++;
          }
        } else {
          while (!(n & i) && i) {
            i >>= 1;
            e++;
          }
        }
        if (e > 15) coefficient = i16((n * DATA_ROM[0x0012 + e]!) << 1);
        else coefficient = i16(coefficient + n);
      }
    } else {
      coefficient = i16(m);
    }
    return { c: coefficient, e: i16(e) };
  }

  private shiftR(c: number, e: number): number {
    return i16((c * DATA_ROM[0x0031 + e]!) >> 15);
  }

  // ── persistence ────────────────────────────────────────────────────────

  serialize(w: SnesStateWriter): void {
    w.u8(this.sr);
    w.bool(this.srLowByteAccess);
    w.u16(this.dr);
    w.u8(this.state);
    w.u8(this.command);
    w.u16(this.dataCounter);
    for (let i = 0; i < 7; i++) w.i16(this.readBuffer[i]!);
    for (let i = 0; i < 1024; i++) w.i16(this.writeBuffer[i]!);
    w.bool(this.freeze);
    for (let i = 0; i < 9; i++) w.i16(this.matrixA[i]!);
    for (let i = 0; i < 9; i++) w.i16(this.matrixB[i]!);
    for (let i = 0; i < 9; i++) w.i16(this.matrixC[i]!);
    for (const v of [
      this.centreX,
      this.centreY,
      this.centreZ,
      this.centreZC,
      this.centreZE,
      this.vOffset,
      this.les,
      this.cLes,
      this.eLes,
      this.sinAas,
      this.cosAas,
      this.sinAzs,
      this.cosAzs,
      this.sinAZS,
      this.cosAZS,
      this.secAZSC1,
      this.secAZSE1,
      this.secAZSC2,
      this.secAZSE2,
      this.nx,
      this.ny,
      this.nz,
      this.gx,
      this.gy,
      this.gz,
      this.hx,
      this.hy,
      this.vx,
      this.vy,
      this.vz
    ]) {
      w.i16(v);
    }
  }

  deserialize(r: SnesStateReader): void {
    this.sr = r.u8();
    this.srLowByteAccess = r.bool();
    this.dr = r.u16();
    this.state = r.u8() as FsmState;
    this.command = r.u8();
    this.dataCounter = r.u16();
    for (let i = 0; i < 7; i++) this.readBuffer[i] = r.i16();
    for (let i = 0; i < 1024; i++) this.writeBuffer[i] = r.i16();
    this.freeze = r.bool();
    for (let i = 0; i < 9; i++) this.matrixA[i] = r.i16();
    for (let i = 0; i < 9; i++) this.matrixB[i] = r.i16();
    for (let i = 0; i < 9; i++) this.matrixC[i] = r.i16();
    this.centreX = r.i16();
    this.centreY = r.i16();
    this.centreZ = r.i16();
    this.centreZC = r.i16();
    this.centreZE = r.i16();
    this.vOffset = r.i16();
    this.les = r.i16();
    this.cLes = r.i16();
    this.eLes = r.i16();
    this.sinAas = r.i16();
    this.cosAas = r.i16();
    this.sinAzs = r.i16();
    this.cosAzs = r.i16();
    this.sinAZS = r.i16();
    this.cosAZS = r.i16();
    this.secAZSC1 = r.i16();
    this.secAZSE1 = r.i16();
    this.secAZSC2 = r.i16();
    this.secAZSE2 = r.i16();
    this.nx = r.i16();
    this.ny = r.i16();
    this.nz = r.i16();
    this.gx = r.i16();
    this.gy = r.i16();
    this.gz = r.i16();
    this.hx = r.i16();
    this.hy = r.i16();
    this.vx = r.i16();
    this.vy = r.i16();
    this.vz = r.i16();
  }
}
