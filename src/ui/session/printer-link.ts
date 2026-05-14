import { type PrintedPage, Printer, type SerialLink } from "../../gb";

/**
 * SerialLink implementation that wires the engine printer's bytes
 * back into the MMU. From the guest's perspective, this looks like a
 * real Game Boy Printer hanging off the link cable: every byte the
 * guest shifts out gets a byte shifted back from the printer's state
 * machine (0x00 during the body, 0x81 ack, status byte at the trailer).
 *
 * Pages emitted by the printer get forwarded to whichever consumer
 * asked at construction time — typically the printer popover, which
 * renders them and offers a save-as-PNG button.
 */
export class PrinterLink implements SerialLink {
  private readonly printer = new Printer();

  /** Synchronous local device — every transfer resolves before the
   *  bit timer expires, so the MMU's default 1 ms timeout is fine.
   *  Widening it here would just slow Game Boy Camera prints by 100×. */
  readonly paired = false;

  constructor(onPagePrinted: (page: PrintedPage) => void) {
    this.printer.onPagePrinted = onPagePrinted;
  }

  sendAsMaster(byte: number, resolve: (peerByte: number) => void): void {
    // Printer responds in the same transfer; no async round-trip
    // because there's no peer over the wire — just the local state
    // machine. Resolving synchronously matches what real hardware
    // does: the printer's response bit is shifted in as the guest
    // shifts its bit out.
    resolve(this.printer.receiveByte(byte));
  }

  onPeerInitiated(): void {
    // The printer is a passive device — it never starts a transfer
    // on its own, so there's nothing for us to register here.
  }

  close(): void {
    // No persistent resources (no sockets, no broadcast channel) — the
    // printer state goes away with the instance. Nothing to tear down.
  }
}
