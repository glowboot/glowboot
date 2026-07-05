/**
 * Ambient declarations for the cross-runtime JavaScript globals the SNES engine
 * is allowed to use. Mirrors `src/gb/globals.d.ts` / `src/nes/globals.d.ts`:
 * same minimal `console` + `crypto` surface, same intent — keep
 * platform-specific APIs (document, localStorage, fetch, …) failing
 * type-checking under `src/snes/tsconfig.json` so they can't sneak into the
 * engine by accident.
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
