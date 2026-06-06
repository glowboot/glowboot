/**
 * Ambient declarations for the cross-runtime JavaScript globals the
 * engine is allowed to use. These are available in *both* Node 18+
 * and every modern browser, so relying on them doesn't couple the
 * emulator to a particular host.
 *
 * Adding more globals here should be a deliberate decision — the
 * whole point of the restricted `src/gb/tsconfig.json` is that
 * platform-specific APIs (document, localStorage, fetch, setTimeout,
 * requestAnimationFrame, …) fail type-checking so they can't sneak
 * into the engine by accident.
 */

interface Console {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  log(...args: unknown[]): void;
}

declare var console: Console;

interface Crypto {
  randomUUID(): string;
}

declare var crypto: Crypto;
