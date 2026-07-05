/**
 * Self-contained 65C816 disassembler for the SNES debugger's disasm pane.
 *
 * Instruction lengths are flag-dependent: accumulator immediates (ADC AND
 * BIT CMP EOR LDA ORA SBC #imm) are 8-bit when M is set, 16-bit when
 * clear; index immediates (CPX CPY LDX LDY #imm) follow X the same way.
 * The caller passes the widths in effect at `pbr:pc` — the decoder can't
 * know them from the byte stream alone.
 */

type Mode =
  | "imp"
  | "acc"
  | "immM"
  | "immX"
  | "imm8"
  | "dp"
  | "dpx"
  | "dpy"
  | "idp"
  | "idx"
  | "idy"
  | "idl"
  | "idly"
  | "abs"
  | "abx"
  | "aby"
  | "iab"
  | "iax"
  | "ial"
  | "long"
  | "lox"
  | "sr"
  | "isy"
  | "rel8"
  | "rel16"
  | "mv";

// prettier-ignore
const TABLE: string[] = [
  // 0x00
  "BRK imm8", "ORA idx", "COP imm8", "ORA sr", "TSB dp", "ORA dp", "ASL dp", "ORA idl",
  "PHP imp", "ORA immM", "ASL acc", "PHD imp", "TSB abs", "ORA abs", "ASL abs", "ORA long",
  // 0x10
  "BPL rel8", "ORA idy", "ORA idp", "ORA isy", "TRB dp", "ORA dpx", "ASL dpx", "ORA idly",
  "CLC imp", "ORA aby", "INC acc", "TCS imp", "TRB abs", "ORA abx", "ASL abx", "ORA lox",
  // 0x20
  "JSR abs", "AND idx", "JSL long", "AND sr", "BIT dp", "AND dp", "ROL dp", "AND idl",
  "PLP imp", "AND immM", "ROL acc", "PLD imp", "BIT abs", "AND abs", "ROL abs", "AND long",
  // 0x30
  "BMI rel8", "AND idy", "AND idp", "AND isy", "BIT dpx", "AND dpx", "ROL dpx", "AND idly",
  "SEC imp", "AND aby", "DEC acc", "TSC imp", "BIT abx", "AND abx", "ROL abx", "AND lox",
  // 0x40
  "RTI imp", "EOR idx", "WDM imm8", "EOR sr", "MVP mv", "EOR dp", "LSR dp", "EOR idl",
  "PHA imp", "EOR immM", "LSR acc", "PHK imp", "JMP abs", "EOR abs", "LSR abs", "EOR long",
  // 0x50
  "BVC rel8", "EOR idy", "EOR idp", "EOR isy", "MVN mv", "EOR dpx", "LSR dpx", "EOR idly",
  "CLI imp", "EOR aby", "PHY imp", "TCD imp", "JML long", "EOR abx", "LSR abx", "EOR lox",
  // 0x60
  "RTS imp", "ADC idx", "PER rel16", "ADC sr", "STZ dp", "ADC dp", "ROR dp", "ADC idl",
  "PLA imp", "ADC immM", "ROR acc", "RTL imp", "JMP iab", "ADC abs", "ROR abs", "ADC long",
  // 0x70
  "BVS rel8", "ADC idy", "ADC idp", "ADC isy", "STZ dpx", "ADC dpx", "ROR dpx", "ADC idly",
  "SEI imp", "ADC aby", "PLY imp", "TDC imp", "JMP iax", "ADC abx", "ROR abx", "ADC lox",
  // 0x80
  "BRA rel8", "STA idx", "BRL rel16", "STA sr", "STY dp", "STA dp", "STX dp", "STA idl",
  "DEY imp", "BIT immM", "TXA imp", "PHB imp", "STY abs", "STA abs", "STX abs", "STA long",
  // 0x90
  "BCC rel8", "STA idy", "STA idp", "STA isy", "STY dpx", "STA dpx", "STX dpy", "STA idly",
  "TYA imp", "STA aby", "TXS imp", "TXY imp", "STZ abs", "STA abx", "STZ abx", "STA lox",
  // 0xA0
  "LDY immX", "LDA idx", "LDX immX", "LDA sr", "LDY dp", "LDA dp", "LDX dp", "LDA idl",
  "TAY imp", "LDA immM", "TAX imp", "PLB imp", "LDY abs", "LDA abs", "LDX abs", "LDA long",
  // 0xB0
  "BCS rel8", "LDA idy", "LDA idp", "LDA isy", "LDY dpx", "LDA dpx", "LDX dpy", "LDA idly",
  "CLV imp", "LDA aby", "TSX imp", "TYX imp", "LDY abx", "LDA abx", "LDX aby", "LDA lox",
  // 0xC0
  "CPY immX", "CMP idx", "REP imm8", "CMP sr", "CPY dp", "CMP dp", "DEC dp", "CMP idl",
  "INY imp", "CMP immM", "DEX imp", "WAI imp", "CPY abs", "CMP abs", "DEC abs", "CMP long",
  // 0xD0
  "BNE rel8", "CMP idy", "CMP idp", "CMP isy", "PEI idp", "CMP dpx", "DEC dpx", "CMP idly",
  "CLD imp", "CMP aby", "PHX imp", "STP imp", "JML ial", "CMP abx", "DEC abx", "CMP lox",
  // 0xE0
  "CPX immX", "SBC idx", "SEP imm8", "SBC sr", "CPX dp", "SBC dp", "INC dp", "SBC idl",
  "INX imp", "SBC immM", "NOP imp", "XBA imp", "CPX abs", "SBC abs", "INC abs", "SBC long",
  // 0xF0
  "BEQ rel8", "SBC idy", "SBC idp", "SBC isy", "PEA abs", "SBC dpx", "INC dpx", "SBC idly",
  "SED imp", "SBC aby", "PLX imp", "XCE imp", "JSR iax", "SBC abx", "INC abx", "SBC lox"
];

function h2(n: number): string {
  return "$" + (n & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

function h4(n: number): string {
  return "$" + (n & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

function h6(n: number): string {
  return "$" + (n & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
}

export function disassemble65c816(
  peek: (addr: number) => number,
  pbr: number,
  pc: number,
  m8: boolean,
  x8: boolean
): { text: string; length: number } {
  const at = (i: number): number => peek(((pbr & 0xff) << 16) | ((pc + i) & 0xffff)) & 0xff;
  const entry = TABLE[at(0)]!;
  const mn = entry.slice(0, 3);
  const mode = entry.slice(4) as Mode;

  switch (mode) {
    case "imp":
      return { text: mn, length: 1 };
    case "acc":
      return { text: `${mn} A`, length: 1 };
    case "imm8":
      return { text: `${mn} #${h2(at(1))}`, length: 2 };
    case "immM":
      if (m8) return { text: `${mn} #${h2(at(1))}`, length: 2 };
      return { text: `${mn} #${h4(at(1) | (at(2) << 8))}`, length: 3 };
    case "immX":
      if (x8) return { text: `${mn} #${h2(at(1))}`, length: 2 };
      return { text: `${mn} #${h4(at(1) | (at(2) << 8))}`, length: 3 };
    case "dp":
      return { text: `${mn} ${h2(at(1))}`, length: 2 };
    case "dpx":
      return { text: `${mn} ${h2(at(1))},X`, length: 2 };
    case "dpy":
      return { text: `${mn} ${h2(at(1))},Y`, length: 2 };
    case "idp":
      return { text: `${mn} (${h2(at(1))})`, length: 2 };
    case "idx":
      return { text: `${mn} (${h2(at(1))},X)`, length: 2 };
    case "idy":
      return { text: `${mn} (${h2(at(1))}),Y`, length: 2 };
    case "idl":
      return { text: `${mn} [${h2(at(1))}]`, length: 2 };
    case "idly":
      return { text: `${mn} [${h2(at(1))}],Y`, length: 2 };
    case "sr":
      return { text: `${mn} ${h2(at(1))},S`, length: 2 };
    case "isy":
      return { text: `${mn} (${h2(at(1))},S),Y`, length: 2 };
    case "abs":
      return { text: `${mn} ${h4(at(1) | (at(2) << 8))}`, length: 3 };
    case "abx":
      return { text: `${mn} ${h4(at(1) | (at(2) << 8))},X`, length: 3 };
    case "aby":
      return { text: `${mn} ${h4(at(1) | (at(2) << 8))},Y`, length: 3 };
    case "iab":
      return { text: `${mn} (${h4(at(1) | (at(2) << 8))})`, length: 3 };
    case "iax":
      return { text: `${mn} (${h4(at(1) | (at(2) << 8))},X)`, length: 3 };
    case "ial":
      return { text: `${mn} [${h4(at(1) | (at(2) << 8))}]`, length: 3 };
    case "long":
      return { text: `${mn} ${h6(at(1) | (at(2) << 8) | (at(3) << 16))}`, length: 4 };
    case "lox":
      return { text: `${mn} ${h6(at(1) | (at(2) << 8) | (at(3) << 16))},X`, length: 4 };
    case "rel8": {
      const target = (pc + 2 + ((at(1) << 24) >> 24)) & 0xffff;
      return { text: `${mn} ${h4(target)}`, length: 2 };
    }
    case "rel16": {
      const target = (pc + 3 + (((at(1) | (at(2) << 8)) << 16) >> 16)) & 0xffff;
      return { text: `${mn} ${h4(target)}`, length: 3 };
    }
    case "mv": {
      // Object code stores the destination bank first, then the source
      // bank; assembler syntax is `MVN srcbk,dstbk` — render source first.
      const dst = at(1);
      const src = at(2);
      return { text: `${mn} ${h2(src)},${h2(dst)}`, length: 3 };
    }
  }
}
