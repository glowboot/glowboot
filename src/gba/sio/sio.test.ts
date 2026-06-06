import { describe, expect, it } from "vitest";

import { Sio } from "./sio.js";
import type { GbaSioLink } from "./sio-link.js";

const SIODATA32_L = 0x00;
const SIODATA32_H = 0x02;
const SIOCNT = 0x08;
const SIOMLT_SEND = 0x0a;
const RCNT = 0x14;
const JOYCNT = 0x20;

// Mode selectors per the GBATEK contract documented in sio.ts:
//   RCNT bit 15 = 0, SIOCNT[13:12] = 00 → Normal-8 (default)
//                                  = 01 → Normal-32
//                                  = 10 → Multiplayer
//                                  = 11 → UART
//   RCNT bits 15:14 = 10 → General-purpose
//                  = 11 → JOY-bus
const SIOCNT_MODE_N32 = 1 << 12;
const SIOCNT_MODE_M = 2 << 12;
const SIOCNT_MODE_U = 3 << 12;
const RCNT_MODE_G = 2 << 14;
const RCNT_MODE_J = 3 << 14;

function withMode(write: (sio: Sio) => void): Sio {
  const sio = new Sio();
  write(sio);
  return sio;
}

describe("Sio — mode-keyed register reads", () => {
  it("SIOCNT reads back the cart's bit 14 (IRQ enable) — not forced", () => {
    // mgba-suite-sio-read's M-mode SIOCNT write of 0xEFFF expects bit
    // 14 = 1 on read because the cart wrote it; an empty Sio with no
    // cart writes returns 0 (bit 14 clear).
    expect(new Sio().read16(SIOCNT) & 0x4000).toBe(0);
    const sio = withMode((s) => s.write16(SIOCNT, 0x4000));
    expect(sio.read16(SIOCNT) & 0x4000).toBe(0x4000);
  });

  it("SIOCNT preserves the writable mask 0x7F8F", () => {
    // Write all-ones except bits 12-13 to keep Normal-8 mode (those
    // bits select UART, which would force bit 5 on and confound the
    // mask check).
    const sio = withMode((s) => s.write16(SIOCNT, 0xffff & ~0x3000));
    expect(sio.read16(SIOCNT)).toBe(0x7f8f & ~0x3000);
  });

  it("SIOCNT sets bit 5 (FIFO empty) when in UART mode", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_U));
    expect(sio.read16(SIOCNT) & 0x0020).toBe(0x0020);
  });

  it("SIOCNT does NOT set bit 5 outside UART mode", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_N32));
    expect(sio.read16(SIOCNT) & 0x0020).toBe(0);
  });

  it("SIODATA32 echoes the stored value in Normal-32 mode", () => {
    const sio = withMode((s) => {
      s.write16(SIOCNT, SIOCNT_MODE_N32);
      s.write16(SIODATA32_L, 0xbeef);
      s.write16(SIODATA32_H, 0xdead);
    });
    expect(sio.read16(SIODATA32_L)).toBe(0xbeef);
    expect(sio.read16(SIODATA32_H)).toBe(0xdead);
  });

  it("SIODATA32 reads 0 in every non-N32 mode (closed bus)", () => {
    for (const ctl of [0, SIOCNT_MODE_M, SIOCNT_MODE_U]) {
      const sio = withMode((s) => {
        s.write16(SIOCNT, ctl);
        s.write16(SIODATA32_L, 0xbeef);
        s.write16(SIODATA32_H, 0xdead);
      });
      expect(sio.read16(SIODATA32_L)).toBe(0);
      expect(sio.read16(SIODATA32_H)).toBe(0);
    }
  });

  it("SIOMLT_SEND echoes in every non-UART mode", () => {
    for (const ctl of [0, SIOCNT_MODE_N32, SIOCNT_MODE_M]) {
      const sio = withMode((s) => {
        s.write16(SIOCNT, ctl);
        s.write16(SIOMLT_SEND, 0xabcd);
      });
      expect(sio.read16(SIOMLT_SEND)).toBe(0xabcd);
    }
  });

  it("SIOMLT_SEND forces 0 in UART mode", () => {
    const sio = withMode((s) => {
      s.write16(SIOMLT_SEND, 0xabcd);
      s.write16(SIOCNT, SIOCNT_MODE_U);
    });
    expect(sio.read16(SIOMLT_SEND)).toBe(0);
  });
});

describe("Sio — RCNT mode-specific constants", () => {
  it("Normal modes (N8/N32) read 0x01F5 in the low half", () => {
    for (const ctl of [0, SIOCNT_MODE_N32]) {
      const sio = withMode((s) => s.write16(SIOCNT, ctl));
      expect(sio.read16(RCNT) & 0x3fff).toBe(0x01f5);
    }
  });

  it("Multiplayer / UART / General modes read 0x01FF in the low half", () => {
    const cases: Array<[number, number]> = [
      [0, SIOCNT_MODE_M],
      [0, SIOCNT_MODE_U],
      [RCNT_MODE_G, 0]
    ];
    for (const [rcntHi, siocntCtl] of cases) {
      const sio = withMode((s) => {
        s.write16(SIOCNT, siocntCtl);
        s.write16(RCNT, rcntHi);
      });
      expect(sio.read16(RCNT) & 0x3fff).toBe(0x01ff);
    }
  });

  it("JOY-bus mode reads 0x01FC in the low half", () => {
    const sio = withMode((s) => s.write16(RCNT, RCNT_MODE_J));
    expect(sio.read16(RCNT) & 0x3fff).toBe(0x01fc);
  });

  it("RCNT high bits 14-15 reflect the stored mode-select", () => {
    const sio = withMode((s) => s.write16(RCNT, RCNT_MODE_J));
    expect(sio.read16(RCNT) & 0xc000).toBe(RCNT_MODE_J);
  });
});

describe("Sio — JOY-bus registers", () => {
  it("JOYCNT bit 6 always reads 1 ('device ID inverter')", () => {
    expect(new Sio().read16(JOYCNT)).toBe(0x0040);
  });

  it("JOY_RECV / JOY_TRANS / JOYSTAT all read 0", () => {
    const sio = new Sio();
    expect(sio.read16(0x30)).toBe(0);
    expect(sio.read16(0x32)).toBe(0);
    expect(sio.read16(0x34)).toBe(0);
    expect(sio.read16(0x36)).toBe(0);
    expect(sio.read16(0x38)).toBe(0);
  });
});

describe("Sio — 8/32-bit accessors compose from read16/write16", () => {
  it("read8 returns the low or high byte of read16 at the aligned offset", () => {
    const sio = withMode((s) => {
      s.write16(SIOCNT, SIOCNT_MODE_N32);
      s.write16(SIODATA32_L, 0xbeef);
    });
    expect(sio.read8(SIODATA32_L)).toBe(0xef);
    expect(sio.read8(SIODATA32_L + 1)).toBe(0xbe);
  });

  it("write8 byte-merges into the underlying halfword without disturbing the sibling byte", () => {
    const sio = withMode((s) => {
      s.write16(SIOCNT, SIOCNT_MODE_N32);
      s.write16(SIODATA32_L, 0xbeef);
    });
    sio.write8(SIODATA32_L, 0x11);
    expect(sio.read16(SIODATA32_L)).toBe(0xbe11);
    sio.write8(SIODATA32_L + 1, 0x22);
    expect(sio.read16(SIODATA32_L)).toBe(0x2211);
  });

  it("read32 / write32 round-trip via the two halfword slots", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_N32));
    sio.write32(SIODATA32_L, 0xdeadbeef);
    expect(sio.read16(SIODATA32_L)).toBe(0xbeef);
    expect(sio.read16(SIODATA32_H)).toBe(0xdead);
    expect(sio.read32(SIODATA32_L) >>> 0).toBe(0xdeadbeef);
  });
});

describe("Sio — writes to read-only addresses are ignored", () => {
  it("writing to JOYCNT does not change its read-back constant", () => {
    const sio = new Sio();
    sio.write16(JOYCNT, 0x1234);
    expect(sio.read16(JOYCNT)).toBe(0x0040);
  });

  it("writing to an unmapped offset does not throw or corrupt later reads", () => {
    const sio = new Sio();
    sio.write16(0x3c, 0xffff);
    expect(sio.read16(SIOCNT)).toBe(0);
  });

  it("SIOCNT in Multiplayer mode echoes cart-written SI/SD when no link is attached", () => {
    // Unpaired: mgba-suite-sio-read writes the full mask and expects
    // bits 2-3 to be readable as part of the writable mask. Only the
    // paired path synthesises SI/SD from link state.
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M | 0x000c));
    expect(sio.read16(SIOCNT) & 0x000c).toBe(0x000c);
  });

  it("SIOCNT in Multiplayer mode forces SD=1 when a paired link is attached", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.setLink(makePairedStubLink());
    // SD bit = 1 ("all GBAs ready") signals cable presence to the cart.
    expect(sio.read16(SIOCNT) & 0x0008).toBe(0x0008);
    // SI bit = 0 because we default to slot 0 (parent).
    expect(sio.read16(SIOCNT) & 0x0004).toBe(0);
  });

  it("SIOCNT in Multiplayer mode sets SI=1 and slot bits 4-5 for child slots", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.setLink(makePairedStubLink());
    sio.setMultiplayerSlotId(2);
    const v = sio.read16(SIOCNT);
    expect(v & 0x0004).toBe(0x0004); // SI = 1 (child)
    expect(v & 0x0008).toBe(0x0008); // SD = 1 (paired)
    expect((v >>> 4) & 3).toBe(2); // slot ID = 2
  });

  it("SIOCNT outside Multiplayer mode preserves cart-written bit 2 + bit 3", () => {
    // Normal-8: SI/SD have no hardware semantics and just echo.
    const sio = withMode((s) => s.write16(SIOCNT, 0x000c));
    expect(sio.read16(SIOCNT) & 0x000c).toBe(0x000c);
  });
});

function makePairedStubLink(): GbaSioLink {
  return {
    paired: true,
    sendAsMaster: () => {},
    setHandlers: () => {},
    notifySiomltSendChange: () => {},
    resyncSlot: () => {},
    close: () => {}
  };
}

// ─── Multiplayer transfer state machine ─────────────────────────────
//
// Phase 1 covers 2-player Multiplayer mode (the most common config —
// Pokémon trades, Mario Kart, FFTA, etc.). The cart's flow is:
//   1. Write SIOCNT to enter Multiplayer mode (bits 12-13 = 10).
//   2. Write desired payload to SIOMLT_SEND (offset 0x0A).
//   3. Pulse SIOCNT.BUSY=1 (bit 7) — the 0→1 edge starts a transfer.
//   4. Cart spin-waits for BUSY to clear OR the SIO IRQ to fire,
//      then reads SIOMULTI0..3 for per-player payloads.
//   5. Unconnected slots latch as 0xFFFF on real silicon.

const SIOCNT_BUSY = 1 << 7;
const SIOCNT_IRQ = 1 << 14;
const SIOMULTI0 = 0x00;
const SIOMULTI1 = 0x02;

interface FakeInterrupts {
  raise: (source: number) => void;
  raised: number[];
}

function fakeInterrupts(): FakeInterrupts {
  const raised: number[] = [];
  return {
    raise: (s: number) => {
      raised.push(s);
    },
    raised
  };
}

/** Cast helper — Sio's `interrupts` field is typed as the full
 *  InterruptController, but the tests only need the `.raise()`
 *  method. Cheap-and-clear cast keeps the test focused. */
function withFakeInterrupts(sio: Sio, ints: FakeInterrupts): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sio as unknown as { interrupts: any }).interrupts = ints;
}

describe("Sio — Multiplayer transfer (unpaired)", () => {
  it("a START pulse with no peer leaves BUSY stuck — the cart hangs the same way an unplugged cable does", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.write16(SIOMLT_SEND, 0x1234);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    // BUSY stays set; SIOMULTI* stay at their in-flight 0xFFFF.
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(SIOCNT_BUSY);
    expect(sio.read16(SIOMULTI0)).toBe(0xffff);
    expect(sio.read16(SIOMULTI1)).toBe(0xffff);
  });

  it("does NOT fire the SIO IRQ when no peer is connected", () => {
    const ints = fakeInterrupts();
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    withFakeInterrupts(sio, ints);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY | SIOCNT_IRQ);
    expect(ints.raised).toEqual([]);
  });

  it("a BUSY pulse outside Multiplayer mode is a no-op (no transfer fires)", () => {
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_N32));
    sio.write16(SIOCNT, SIOCNT_MODE_N32 | SIOCNT_BUSY);
    // SIOMULTI0..3 stay at their power-on zero; the Multiplayer-mode
    // intercept doesn't kick in for N32.
  });
});

describe("Sio — Multiplayer transfer (paired)", () => {
  // A fake link that captures the master's data and lets the test
  // synthesise a peer response on demand.
  function makeLink(): {
    paired: boolean;
    captured: { masterSend: number; resolve: (peer: readonly [number, number, number]) => void }[];
    handlers: {
      onMasterStart: ((m: number) => number) | null;
      onTransferComplete: ((s0: number, s1: number, s2: number, s3: number) => void) | null;
    };
    sendAsMaster: (masterSend: number, resolve: (peer: readonly [number, number, number]) => void) => void;
    setHandlers: (h: {
      onMasterStart: (m: number) => number;
      onTransferComplete: (s0: number, s1: number, s2: number, s3: number) => void;
    }) => void;
    notifySiomltSendChange: (v: number) => void;
    resyncSlot: () => void;
    close: () => void;
  } {
    const captured: { masterSend: number; resolve: (peer: readonly [number, number, number]) => void }[] = [];
    const handlers: {
      onMasterStart: ((m: number) => number) | null;
      onTransferComplete: ((s0: number, s1: number, s2: number, s3: number) => void) | null;
    } = {
      onMasterStart: null,
      onTransferComplete: null
    };
    return {
      paired: true,
      captured,
      handlers,
      sendAsMaster: (masterSend, resolve) => {
        captured.push({ masterSend, resolve });
      },
      setHandlers: (h) => {
        handlers.onMasterStart = h.onMasterStart;
        handlers.onTransferComplete = h.onTransferComplete;
      },
      notifySiomltSendChange: () => {},
      resyncSlot: () => {},
      close: () => {}
    };
  }

  it("master path: forwards SIOMLT_SEND to the link and latches the peer reply into slot 1", () => {
    const link = makeLink();
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.setLink(link);
    sio.write16(SIOMLT_SEND, 0x1234);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    // Link captured the master's send; transfer is still in flight,
    // so SIOMULTI* slots are 0xFFFF and BUSY is still set.
    expect(link.captured).toHaveLength(1);
    expect(link.captured[0]!.masterSend).toBe(0x1234);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(SIOCNT_BUSY);
    // Resolve the peer reply — stashed; the cart still sees BUSY=1.
    link.captured[0]!.resolve([0xabcd, 0xffff, 0xffff]);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(SIOCNT_BUSY);
    // Advance the CPU-cycle timer past the scheduled completion.
    sio.tick(100000);
    expect(sio.read16(SIOMULTI0)).toBe(0x1234);
    expect(sio.read16(SIOMULTI1)).toBe(0xabcd);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(0);
  });

  it("slave path: peer-master-start latches the master's value into slot 0 and slave's into slot 1", () => {
    const link = makeLink();
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.setLink(link);
    sio.write16(SIOMLT_SEND, 0xaaaa);
    // Peer (master) initiates; the handler returns our slave value.
    expect(link.handlers.onMasterStart).not.toBeNull();
    const slaveResponse = link.handlers.onMasterStart!(0xbbbb);
    expect(slaveResponse).toBe(0xaaaa);
    // The transport then drives onTransferComplete with both values.
    link.handlers.onTransferComplete!(0xbbbb, 0xaaaa, 0xffff, 0xffff);
    expect(sio.read16(SIOMULTI0)).toBe(0xbbbb);
    expect(sio.read16(SIOMULTI1)).toBe(0xaaaa);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(0);
  });

  it("fires the SIO IRQ when a paired transfer completes and SIOCNT.IRQ was set", () => {
    const link = makeLink();
    const ints = fakeInterrupts();
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    withFakeInterrupts(sio, ints);
    sio.setLink(link);
    sio.write16(SIOMLT_SEND, 0x1234);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY | SIOCNT_IRQ);
    expect(ints.raised).toEqual([]); // not yet — peer hasn't replied
    link.captured[0]!.resolve([0xabcd, 0xffff, 0xffff]);
    expect(ints.raised).toEqual([]); // resolved but transfer-cycle timer still pending
    sio.tick(100000);
    expect(ints.raised).toEqual([7]); // IRQ_SERIAL fires once timer expires
  });

  it("a slave (slotId != 0) writing START does NOT initiate a local transfer", () => {
    const link = makeLink();
    const sio = withMode((s) => s.write16(SIOCNT, SIOCNT_MODE_M));
    sio.setLink(link);
    sio.setMultiplayerSlotId(1);
    sio.write16(SIOMLT_SEND, 0xaaaa);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    // Slave START is a no-op: the link is never asked to broadcast.
    expect(link.captured).toHaveLength(0);
    // BUSY stays set — waiting for the master's multi-start to arrive
    // and unblock via onTransferComplete.
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(SIOCNT_BUSY);
    // SIOMULTI is the in-flight 0xFFFF latch (not the cart's own send).
    expect(sio.read16(SIOMULTI0)).toBe(0xffff);
    expect(sio.read16(SIOMULTI1)).toBe(0xffff);
    // Master's transfer arrives. Slave queues it and `tick()`
    // delivers one per `MULTI_TRANSFER_CYCLES` window so the cart
    // sees each transfer's SIOMULTI individually (vs. losing
    // intermediate values when the transport delivers a burst).
    link.handlers.onTransferComplete!(0xbbbb, 0xaaaa, 0xffff, 0xffff);
    sio.tick(100000);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(0);
    expect(sio.read16(SIOMULTI0)).toBe(0xbbbb);
    expect(sio.read16(SIOMULTI1)).toBe(0xaaaa);
  });

  it("setLink(null) tears down a previously-attached link cleanly", () => {
    const link = makeLink();
    const sio = new Sio();
    sio.setLink(link);
    sio.setLink(null);
    // After tear-down a BUSY pulse falls back to the unpaired path —
    // no peer responds, SIOMULTI* stay at the in-flight 0xFFFF, BUSY
    // remains set. Same hang behaviour as a cart booted with no link
    // ever attached.
    sio.write16(SIOCNT, SIOCNT_MODE_M);
    sio.write16(SIOMLT_SEND, 0x5555);
    sio.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    expect(sio.read16(SIOCNT) & SIOCNT_BUSY).toBe(SIOCNT_BUSY);
    expect(sio.read16(SIOMULTI0)).toBe(0xffff);
  });
});

// ─── Two-engine Multiplayer round-trip ──────────────────────────────
//
// Boots two `Sio` instances with an in-process transport between them
// and exercises the Multiplayer transfer protocol end-to-end. Closest
// we can get to "two browser tabs paired via BroadcastChannel" without
// a DOM — the transport replaces the BroadcastChannel hop with a
// direct method call, but the SIO controller and link contract are
// the production code paths.

type LinkHandlers = {
  onMasterStart: (m: number) => number;
  onTransferComplete: (s0: number, s1: number, s2: number, s3: number) => void;
};

/** Build a pair of mutually-connected GbaSioLink stubs using the
 *  VBA-M cached-state model: each side caches the latest peer
 *  SIOMLT_SEND broadcast via `notifySiomltSendChange`, master's
 *  `sendAsMaster` resolves synchronously from the cache, and slave's
 *  `onTransferComplete` fires from the master's result broadcast. */
function makeLinkedPair(): { aLink: GbaSioLink; bLink: GbaSioLink; setA(sio: Sio): void; setB(sio: Sio): void } {
  let aHandlers: LinkHandlers | null = null;
  let bHandlers: LinkHandlers | null = null;
  let aPeerSend = 0xffff;
  let bPeerSend = 0xffff;

  const aLink: GbaSioLink = {
    paired: true,
    sendAsMaster: (masterSend, resolve) => {
      const slaveData = aPeerSend;
      bHandlers?.onTransferComplete(masterSend & 0xffff, slaveData & 0xffff, 0xffff, 0xffff);
      resolve([slaveData & 0xffff, 0xffff, 0xffff]);
    },
    setHandlers: (h) => {
      aHandlers = h;
    },
    notifySiomltSendChange: (v) => {
      bPeerSend = v & 0xffff;
    },
    resyncSlot: () => {},
    close: () => {}
  };
  const bLink: GbaSioLink = {
    paired: true,
    sendAsMaster: (masterSend, resolve) => {
      const slaveData = bPeerSend;
      aHandlers?.onTransferComplete(masterSend & 0xffff, slaveData & 0xffff, 0xffff, 0xffff);
      resolve([slaveData & 0xffff, 0xffff, 0xffff]);
    },
    setHandlers: (h) => {
      bHandlers = h;
    },
    notifySiomltSendChange: (v) => {
      aPeerSend = v & 0xffff;
    },
    resyncSlot: () => {},
    close: () => {}
  };
  return {
    aLink,
    bLink,
    setA: (sio) => sio.setLink(aLink),
    setB: (sio) => sio.setLink(bLink)
  };
}

describe("Sio — Multiplayer two-engine round-trip", () => {
  it("master + slave both latch the 4-slot result on a single transfer", () => {
    const pair = makeLinkedPair();
    const a = new Sio();
    const b = new Sio();
    a.write16(SIOCNT, SIOCNT_MODE_M);
    b.write16(SIOCNT, SIOCNT_MODE_M);
    pair.setA(a);
    pair.setB(b);

    a.write16(SIOMLT_SEND, 0x1111);
    b.write16(SIOMLT_SEND, 0x2222);
    // A initiates the transfer.
    a.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    // Master's completion is scheduled — advance the cycle timer.
    a.tick(100000);

    // Both sides should agree on the slot layout: slot 0 = master (A),
    // slot 1 = slave 1 (B), 2/3 = 0xFFFF (no peers in this ring).
    expect(a.read16(SIOMULTI0)).toBe(0x1111);
    expect(a.read16(SIOMULTI1)).toBe(0x2222);
    expect(a.read16(0x04)).toBe(0xffff); // SIOMULTI2
    expect(a.read16(0x06)).toBe(0xffff); // SIOMULTI3
    expect(b.read16(SIOMULTI0)).toBe(0x1111);
    expect(b.read16(SIOMULTI1)).toBe(0x2222);
    expect(b.read16(0x04)).toBe(0xffff);
    expect(b.read16(0x06)).toBe(0xffff);
    // BUSY clears on both sides.
    expect(a.read16(SIOCNT) & SIOCNT_BUSY).toBe(0);
    expect(b.read16(SIOCNT) & SIOCNT_BUSY).toBe(0);
  });

  it("either side can be master across consecutive transfers", () => {
    const pair = makeLinkedPair();
    const a = new Sio();
    const b = new Sio();
    a.write16(SIOCNT, SIOCNT_MODE_M);
    b.write16(SIOCNT, SIOCNT_MODE_M);
    pair.setA(a);
    pair.setB(b);

    // Round 1: A is master.
    a.write16(SIOMLT_SEND, 0x1111);
    b.write16(SIOMLT_SEND, 0x2222);
    a.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    a.tick(100000);
    expect(a.read16(SIOMULTI0)).toBe(0x1111);
    expect(a.read16(SIOMULTI1)).toBe(0x2222);

    // Round 2: B is master.
    a.write16(SIOMLT_SEND, 0x3333);
    b.write16(SIOMLT_SEND, 0x4444);
    b.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_BUSY);
    b.tick(100000);
    // Now slot 0 = B's value, slot 1 = A's response.
    expect(b.read16(SIOMULTI0)).toBe(0x4444);
    expect(b.read16(SIOMULTI1)).toBe(0x3333);
    expect(a.read16(SIOMULTI0)).toBe(0x4444);
    expect(a.read16(SIOMULTI1)).toBe(0x3333);
  });

  it("fires SIO IRQ on both sides when IRQ enable is set", () => {
    const pair = makeLinkedPair();
    const a = new Sio();
    const b = new Sio();
    const ai = fakeInterrupts();
    const bi = fakeInterrupts();
    withFakeInterrupts(a, ai);
    withFakeInterrupts(b, bi);
    a.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_IRQ);
    b.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_IRQ);
    pair.setA(a);
    pair.setB(b);

    a.write16(SIOMLT_SEND, 0xaaaa);
    b.write16(SIOMLT_SEND, 0xbbbb);
    a.write16(SIOCNT, SIOCNT_MODE_M | SIOCNT_IRQ | SIOCNT_BUSY);
    a.tick(100000);

    expect(ai.raised).toEqual([7]); // IRQ_SERIAL
    expect(bi.raised).toEqual([7]);
  });
});
