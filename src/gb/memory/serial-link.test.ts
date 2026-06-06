import { describe, expect, it, vi } from "vitest";

import { NO_LINK } from "./serial-link.js";

describe("NO_LINK — disconnected-cable default", () => {
  it("resolves master transfers synchronously with 0xFF", () => {
    const got: number[] = [];
    NO_LINK.sendAsMaster(0x55, (b) => got.push(b));
    expect(got).toEqual([0xff]);
  });

  it("resolves with 0xFF regardless of the byte sent", () => {
    for (const byte of [0x00, 0x42, 0xff, 0x101]) {
      let received = -1;
      NO_LINK.sendAsMaster(byte, (b) => {
        received = b;
      });
      expect(received).toBe(0xff);
    }
  });

  it("accepts onPeerInitiated handlers without invoking them — no peer exists to push bytes", () => {
    const handler = vi.fn((peerByte: number) => peerByte);
    NO_LINK.onPeerInitiated(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports paired === false so the MMU keeps its narrow local timeout", () => {
    expect(NO_LINK.paired).toBe(false);
  });

  it("close() is a safe no-op and idempotent", () => {
    expect(() => {
      NO_LINK.close();
      NO_LINK.close();
      NO_LINK.close();
    }).not.toThrow();
  });

  it("close() does not perturb subsequent transfers — sendAsMaster still resolves with 0xFF", () => {
    NO_LINK.close();
    let received = -1;
    NO_LINK.sendAsMaster(0x10, (b) => {
      received = b;
    });
    expect(received).toBe(0xff);
  });
});
