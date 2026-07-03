/**
 * MOS 6502 / Ricoh 2A03 disassembler — maps up to three consecutive bytes
 * into a `DecodedInstruction`. Pure, no browser / engine dependencies, so it
 * runs in headless test suites or debuggers without pulling in the rest of
 * the engine.
 *
 * Covers all 256 opcode slots, including the unofficial instructions the
 * {@link import("../cpu/cpu.js").CPU} actually executes (SLO/RLA/SRE/RRA, SAX,
 * LAX, DCP, ISC, the immediate combined-ALU ops, the unstable stores, and the
 * multi-byte NOPs). Returns `length` (1-3 bytes consumed) so callers can walk
 * contiguous code; and `targetAddr` for flow-control or memory-referencing ops
 * so the UI can render clickable jump / memory links.
 *
 * Formatting convention: `$XX` / `$XXXX` for hex literals, branch / JMP-relative
 * offsets resolved to their absolute target in the text so a reader doesn't have
 * to do PC math. Unofficial opcodes are prefixed with `*` to match the
 * `nestest` disassembly-log convention (e.g. `*NOP`, `*LAX`, `*SAX`).
 */

export interface DecodedInstruction {
  /** Human-readable mnemonic (e.g. `"LDA"`, `"JMP"`, `"BNE"`). Unofficial
   *  opcodes are prefixed with `"*"` (e.g. `"*NOP"`, `"*LAX"`). */
  readonly mnemonic: string;
  /** Operand string (e.g. `"#$44"`, `"$4400,X"`, `"($44),Y"`, `"$C5F5"`).
   *  Empty for implied ops; `"A"` for the accumulator shifts/rotates. */
  readonly operands: string;
  /** Bytes consumed — always 1, 2, or 3. */
  readonly length: number;
  /** Absolute 16-bit address this instruction references, when meaningful —
   *  branch / jump / call targets and absolute / zero-page memory operands —
   *  so the UI can render clickable links. Undefined for register-only ops. */
  readonly targetAddr?: number;
}

/** 6502 addressing modes. Mirrors the `Mode` enum in `cpu.ts`. */
const enum Mode {
  IMP, // implied
  ACC, // accumulator (ASL A / LSR A / ROL A / ROR A)
  IMM, // immediate          #$XX
  ZP, // zero page           $XX
  ZPX, // zero page,X         $XX,X
  ZPY, // zero page,Y         $XX,Y
  IZX, // (indirect,X)        ($XX,X)
  IZY, // (indirect),Y        ($XX),Y
  ABS, // absolute            $XXXX
  ABX, // absolute,X          $XXXX,X
  ABY, // absolute,Y          $XXXX,Y
  IND, // indirect (JMP only) ($XXXX)
  REL // relative (branches)  $XXXX (resolved target)
}

interface OpInfo {
  readonly mnemonic: string;
  readonly mode: Mode;
  readonly unofficial?: boolean;
}

function hex2(n: number): string {
  return "$" + (n & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

function hex4(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

/** Sign-extend an 8-bit relative offset and add to (pc+2) to get the absolute
 *  branch target. */
function relTarget(pc: number, rel: number): number {
  return (pc + 2 + ((rel << 24) >> 24)) & 0xffff;
}

/**
 * Decode the instruction starting at `b0`. `pc` is the address of `b0`; needed
 * to resolve relative-branch offsets to their absolute target. Callers pass 3
 * bytes (pad with 0 if short); for 2-/3-byte opcodes the unused trailing bytes
 * are simply ignored.
 */
export function decode(b0: number, b1: number, b2: number, pc: number): DecodedInstruction {
  b0 &= 0xff;
  b1 &= 0xff;
  b2 &= 0xff;

  const info = TABLE[b0]!;
  const word = b1 | (b2 << 8);
  const mnemonic = info.unofficial ? "*" + info.mnemonic : info.mnemonic;

  switch (info.mode) {
    case Mode.IMP:
      return { mnemonic, operands: "", length: 1 };
    case Mode.ACC:
      return { mnemonic, operands: "A", length: 1 };
    case Mode.IMM:
      return { mnemonic, operands: `#${hex2(b1)}`, length: 2 };
    case Mode.ZP:
      return { mnemonic, operands: hex2(b1), length: 2, targetAddr: b1 };
    case Mode.ZPX:
      return { mnemonic, operands: `${hex2(b1)},X`, length: 2, targetAddr: b1 };
    case Mode.ZPY:
      return { mnemonic, operands: `${hex2(b1)},Y`, length: 2, targetAddr: b1 };
    case Mode.IZX:
      return { mnemonic, operands: `(${hex2(b1)},X)`, length: 2 };
    case Mode.IZY:
      return { mnemonic, operands: `(${hex2(b1)}),Y`, length: 2 };
    case Mode.ABS:
      return { mnemonic, operands: hex4(word), length: 3, targetAddr: word };
    case Mode.ABX:
      return { mnemonic, operands: `${hex4(word)},X`, length: 3, targetAddr: word };
    case Mode.ABY:
      return { mnemonic, operands: `${hex4(word)},Y`, length: 3, targetAddr: word };
    case Mode.IND:
      return { mnemonic, operands: `(${hex4(word)})`, length: 3, targetAddr: word };
    case Mode.REL: {
      const t = relTarget(pc, b1);
      return { mnemonic, operands: hex4(t), length: 2, targetAddr: t };
    }
  }
}

// ─── Opcode table ───────────────────────────────────────────────────────────
// One entry per opcode (0x00-0xFF), in numeric order. Mnemonics and addressing
// modes match what `cpu.ts`'s `execute()` switch actually does — including the
// unofficial opcodes (flagged `unofficial: true` so `decode` prefixes them with
// `*`). The JAM/KIL opcodes (0x02, 0x12, … 0xF2) freeze the CPU; they're shown
// as `*JAM` (implied) so the disassembler never lies about an unimplemented slot.

const IMP = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.IMP });
const ACC = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ACC });
const IMM = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.IMM });
const ZP = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ZP });
const ZPX = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ZPX });
const ZPY = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ZPY });
const IZX = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.IZX });
const IZY = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.IZY });
const ABS = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ABS });
const ABX = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ABX });
const ABY = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.ABY });
const IND = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.IND });
const REL = (mnemonic: string): OpInfo => ({ mnemonic, mode: Mode.REL });

/** Mark an entry as unofficial (decoded mnemonic gets a `*` prefix). */
const U = (info: OpInfo): OpInfo => ({ ...info, unofficial: true });

// prettier-ignore
const TABLE: readonly OpInfo[] = [
  /* 00 */ IMP("BRK"),    IZX("ORA"),    U(IMP("JAM")), U(IZX("SLO")),
  /* 04 */ U(ZP("NOP")),  ZP("ORA"),     ZP("ASL"),     U(ZP("SLO")),
  /* 08 */ IMP("PHP"),    IMM("ORA"),    ACC("ASL"),    U(IMM("ANC")),
  /* 0C */ U(ABS("NOP")), ABS("ORA"),    ABS("ASL"),    U(ABS("SLO")),

  /* 10 */ REL("BPL"),    IZY("ORA"),    U(IMP("JAM")), U(IZY("SLO")),
  /* 14 */ U(ZPX("NOP")), ZPX("ORA"),    ZPX("ASL"),    U(ZPX("SLO")),
  /* 18 */ IMP("CLC"),    ABY("ORA"),    U(IMP("NOP")), U(ABY("SLO")),
  /* 1C */ U(ABX("NOP")), ABX("ORA"),    ABX("ASL"),    U(ABX("SLO")),

  /* 20 */ ABS("JSR"),    IZX("AND"),    U(IMP("JAM")), U(IZX("RLA")),
  /* 24 */ ZP("BIT"),     ZP("AND"),     ZP("ROL"),     U(ZP("RLA")),
  /* 28 */ IMP("PLP"),    IMM("AND"),    ACC("ROL"),    U(IMM("ANC")),
  /* 2C */ ABS("BIT"),    ABS("AND"),    ABS("ROL"),    U(ABS("RLA")),

  /* 30 */ REL("BMI"),    IZY("AND"),    U(IMP("JAM")), U(IZY("RLA")),
  /* 34 */ U(ZPX("NOP")), ZPX("AND"),    ZPX("ROL"),    U(ZPX("RLA")),
  /* 38 */ IMP("SEC"),    ABY("AND"),    U(IMP("NOP")), U(ABY("RLA")),
  /* 3C */ U(ABX("NOP")), ABX("AND"),    ABX("ROL"),    U(ABX("RLA")),

  /* 40 */ IMP("RTI"),    IZX("EOR"),    U(IMP("JAM")), U(IZX("SRE")),
  /* 44 */ U(ZP("NOP")),  ZP("EOR"),     ZP("LSR"),     U(ZP("SRE")),
  /* 48 */ IMP("PHA"),    IMM("EOR"),    ACC("LSR"),    U(IMM("ALR")),
  /* 4C */ ABS("JMP"),    ABS("EOR"),    ABS("LSR"),    U(ABS("SRE")),

  /* 50 */ REL("BVC"),    IZY("EOR"),    U(IMP("JAM")), U(IZY("SRE")),
  /* 54 */ U(ZPX("NOP")), ZPX("EOR"),    ZPX("LSR"),    U(ZPX("SRE")),
  /* 58 */ IMP("CLI"),    ABY("EOR"),    U(IMP("NOP")), U(ABY("SRE")),
  /* 5C */ U(ABX("NOP")), ABX("EOR"),    ABX("LSR"),    U(ABX("SRE")),

  /* 60 */ IMP("RTS"),    IZX("ADC"),    U(IMP("JAM")), U(IZX("RRA")),
  /* 64 */ U(ZP("NOP")),  ZP("ADC"),     ZP("ROR"),     U(ZP("RRA")),
  /* 68 */ IMP("PLA"),    IMM("ADC"),    ACC("ROR"),    U(IMM("ARR")),
  /* 6C */ IND("JMP"),    ABS("ADC"),    ABS("ROR"),    U(ABS("RRA")),

  /* 70 */ REL("BVS"),    IZY("ADC"),    U(IMP("JAM")), U(IZY("RRA")),
  /* 74 */ U(ZPX("NOP")), ZPX("ADC"),    ZPX("ROR"),    U(ZPX("RRA")),
  /* 78 */ IMP("SEI"),    ABY("ADC"),    U(IMP("NOP")), U(ABY("RRA")),
  /* 7C */ U(ABX("NOP")), ABX("ADC"),    ABX("ROR"),    U(ABX("RRA")),

  /* 80 */ U(IMM("NOP")), IZX("STA"),    U(IMM("NOP")), U(IZX("SAX")),
  /* 84 */ ZP("STY"),     ZP("STA"),     ZP("STX"),     U(ZP("SAX")),
  /* 88 */ IMP("DEY"),    U(IMM("NOP")), IMP("TXA"),    U(IMM("ANE")),
  /* 8C */ ABS("STY"),    ABS("STA"),    ABS("STX"),    U(ABS("SAX")),

  /* 90 */ REL("BCC"),    IZY("STA"),    U(IMP("JAM")), U(IZY("SHA")),
  /* 94 */ ZPX("STY"),    ZPX("STA"),    ZPY("STX"),    U(ZPY("SAX")),
  /* 98 */ IMP("TYA"),    ABY("STA"),    IMP("TXS"),    U(ABY("TAS")),
  /* 9C */ U(ABX("SHY")), ABX("STA"),    U(ABY("SHX")), U(ABY("SHA")),

  /* A0 */ IMM("LDY"),    IZX("LDA"),    IMM("LDX"),    U(IZX("LAX")),
  /* A4 */ ZP("LDY"),     ZP("LDA"),     ZP("LDX"),     U(ZP("LAX")),
  /* A8 */ IMP("TAY"),    IMM("LDA"),    IMP("TAX"),    U(IMM("LXA")),
  /* AC */ ABS("LDY"),    ABS("LDA"),    ABS("LDX"),    U(ABS("LAX")),

  /* B0 */ REL("BCS"),    IZY("LDA"),    U(IMP("JAM")), U(IZY("LAX")),
  /* B4 */ ZPX("LDY"),    ZPX("LDA"),    ZPY("LDX"),    U(ZPY("LAX")),
  /* B8 */ IMP("CLV"),    ABY("LDA"),    IMP("TSX"),    U(ABY("LAS")),
  /* BC */ ABX("LDY"),    ABX("LDA"),    ABY("LDX"),    U(ABY("LAX")),

  /* C0 */ IMM("CPY"),    IZX("CMP"),    U(IMM("NOP")), U(IZX("DCP")),
  /* C4 */ ZP("CPY"),     ZP("CMP"),     ZP("DEC"),     U(ZP("DCP")),
  /* C8 */ IMP("INY"),    IMM("CMP"),    IMP("DEX"),    U(IMM("SBX")),
  /* CC */ ABS("CPY"),    ABS("CMP"),    ABS("DEC"),    U(ABS("DCP")),

  /* D0 */ REL("BNE"),    IZY("CMP"),    U(IMP("JAM")), U(IZY("DCP")),
  /* D4 */ U(ZPX("NOP")), ZPX("CMP"),    ZPX("DEC"),    U(ZPX("DCP")),
  /* D8 */ IMP("CLD"),    ABY("CMP"),    U(IMP("NOP")), U(ABY("DCP")),
  /* DC */ U(ABX("NOP")), ABX("CMP"),    ABX("DEC"),    U(ABX("DCP")),

  /* E0 */ IMM("CPX"),    IZX("SBC"),    U(IMM("NOP")), U(IZX("ISC")),
  /* E4 */ ZP("CPX"),     ZP("SBC"),     ZP("INC"),     U(ZP("ISC")),
  /* E8 */ IMP("INX"),    IMM("SBC"),    IMP("NOP"),    U(IMM("SBC")),
  /* EC */ ABS("CPX"),    ABS("SBC"),    ABS("INC"),    U(ABS("ISC")),

  /* F0 */ REL("BEQ"),    IZY("SBC"),    U(IMP("JAM")), U(IZY("ISC")),
  /* F4 */ U(ZPX("NOP")), ZPX("SBC"),    ZPX("INC"),    U(ZPX("ISC")),
  /* F8 */ IMP("SED"),    ABY("SBC"),    U(IMP("NOP")), U(ABY("ISC")),
  /* FC */ U(ABX("NOP")), ABX("SBC"),    ABX("INC"),    U(ABX("ISC")),
];
