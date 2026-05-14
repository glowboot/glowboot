/**
 * Binary save-state format. `gameboy.ts` constructs a `StateWriter` /
 * `StateReader` and threads it through each subsystem's `serialize(w)` /
 * `deserialize(r)` method, which writes/reads a fixed layout via these
 * helpers; the concatenated payload carries a 1-byte version prefix.
 *
 * Storage of the serialized blob (IndexedDB slots, thumbnails, slot
 * enumeration) lives in `ui/persistence/save-state.ts` — this file is
 * only the binary format itself.
 */

/** Bump on every change to any subsystem's `serialize`/`deserialize`
 *  layout. The first byte of every save state is this version. On load,
 *  `upgradeState` walks the migrator chain to bring an older blob up to
 *  the current layout; a blob older than the oldest migrator throws
 *  `UnsupportedSaveStateError` in `loadState` before any subsystem field
 *  gets mutated, so a stale snapshot results in a fresh boot rather than
 *  partially corrupting the engine. */
export const STATE_VERSION = 1;

/** Thrown when a save state's version is older than the oldest registered
 *  migrator (or newer than what we know about — forward-incompat). The
 *  UI surfaces this as a friendly "save state is from an older Glowboot;
 *  your in-game save is unaffected" message rather than a raw stack. */
export class UnsupportedSaveStateError extends Error {
  constructor(
    readonly stateVersion: number,
    readonly currentVersion: number
  ) {
    super(
      stateVersion > currentVersion
        ? `Save state version ${stateVersion} is newer than this build (${currentVersion}). Update Glowboot to load it.`
        : `Save state version ${stateVersion} is too old to migrate to ${currentVersion}. Your in-game save (cartridge save RAM) is unaffected.`
    );
    this.name = "UnsupportedSaveStateError";
  }
}

/** Migrator: takes a save-state blob at version N (first byte = N) and
 *  returns an equivalent blob at version N+1. Each migrator's only job is
 *  to translate the *changed* subsystem's bytes — unchanged subsystems'
 *  bytes flow through verbatim. The version prefix in the output must be
 *  N+1. Throw if the input is malformed; `upgradeState` re-throws. */
type StateMigrator = (bytes: Uint8Array) => Uint8Array;

/** Registry of v(N) → v(N+1) migrators. Add an entry alongside every
 *  STATE_VERSION bump. Keys are the SOURCE version; the migrator at key N
 *  produces a v(N+1) blob. */
const STATE_MIGRATORS: Record<number, StateMigrator> = {
  // 1: (b) => migrateV1toV2(b),
};

/** Walk the migrator chain from `bytes[0]` up to the current
 *  `STATE_VERSION`. Returns the upgraded blob (always at the current
 *  version). Throws `UnsupportedSaveStateError` if the source version
 *  has no migrator (too old) or is newer than current (forward-incompat).
 *  Caller's responsibility to validate the blob is non-empty. */
export function upgradeState(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    throw new UnsupportedSaveStateError(0, STATE_VERSION);
  }
  let current = bytes;
  let version = current[0]!;
  if (version > STATE_VERSION) {
    throw new UnsupportedSaveStateError(version, STATE_VERSION);
  }
  while (version < STATE_VERSION) {
    const migrate = STATE_MIGRATORS[version];
    if (!migrate) {
      throw new UnsupportedSaveStateError(version, STATE_VERSION);
    }
    current = migrate(current);
    version = current[0]!;
  }
  return current;
}

export class StateWriter {
  private readonly view: DataView;
  readonly buffer: Uint8Array;
  private offset = 0;

  constructor(capacity = 256 * 1024) {
    const buf = new ArrayBuffer(capacity);
    this.view = new DataView(buf);
    this.buffer = new Uint8Array(buf);
  }

  u8(v: number): void {
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }
  i8(v: number): void {
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  i16(v: number): void {
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }
  i32(v: number): void {
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
  }
  f64(v: number): void {
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
  }
  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }
  bytes(src: Uint8Array): void {
    this.buffer.set(src, this.offset);
    this.offset += src.length;
  }

  finalize(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

export class StateReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }
  bytes(dst: Uint8Array): void {
    dst.set(this.buf.subarray(this.offset, this.offset + dst.length));
    this.offset += dst.length;
  }
}
