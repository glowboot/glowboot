/**
 * Binary save-state format for the GBA engine. `gba.ts` constructs a
 * `GbaStateWriter` / `GbaStateReader` and threads it through each
 * subsystem's `serialize(w)` / `deserialize(r)` method, which writes/reads
 * a fixed layout via these helpers; the concatenated payload carries a
 * 1-byte version prefix.
 *
 * Parallel to `src/gb/serialization/serialization.ts` but kept separate
 * because the two engines have independent lineages — bumping the GB
 * version shouldn't break GBA saves, and vice versa. The
 * `src/gb/tsconfig.json` / `src/gba/tsconfig.json` split also forbids
 * a cross-engine import.
 *
 * Storage of the serialised blob (IndexedDB slots, thumbnails, slot
 * enumeration) lives in `ui/persistence/save-state.ts` — this file is
 * only the binary format itself.
 */

/** First byte of every GBA save state. Bump on every change to any
 *  subsystem's `serialize`/`deserialize` layout. On load,
 *  `upgradeGbaState` walks the migrator chain to bring an older blob
 *  up to the current layout; a blob older than the oldest migrator
 *  throws `UnsupportedGbaSaveStateError` in `loadState` before any
 *  subsystem field gets mutated, so a stale snapshot results in a
 *  fresh boot rather than partially corrupting the engine. Reset to
 *  1 at the start of the public-release lineage — every change after
 *  that one adds a migrator at the previous version's key. */
export const GBA_STATE_VERSION = 1;

/** Thrown when a GBA save state's version is older than the oldest
 *  registered migrator (or newer than what we know about — forward-
 *  incompat). The UI surfaces this as a friendly "save state is from
 *  an older Glowboot; your in-game save is unaffected" message rather
 *  than a raw stack. */
export class UnsupportedGbaSaveStateError extends Error {
  constructor(
    readonly stateVersion: number,
    readonly currentVersion: number
  ) {
    super(
      stateVersion > currentVersion
        ? `GBA save state version ${stateVersion} is newer than this build (${currentVersion}). Update Glowboot to load it.`
        : `GBA save state version ${stateVersion} is too old to migrate to ${currentVersion}. Your in-game save (cartridge backup) is unaffected.`
    );
    this.name = "UnsupportedGbaSaveStateError";
  }
}

/** Migrator: takes a save-state blob at version N (first byte = N)
 *  and returns an equivalent blob at version N+1. Each migrator's
 *  only job is to translate the *changed* subsystem's bytes —
 *  unchanged subsystems' bytes flow through verbatim. The version
 *  prefix in the output must be N+1. Throw if the input is malformed;
 *  `upgradeGbaState` re-throws. */
type GbaStateMigrator = (bytes: Uint8Array) => Uint8Array;

/** Registry of v(N) → v(N+1) migrators. Add an entry alongside every
 *  `GBA_STATE_VERSION` bump. Keys are the SOURCE version; the migrator
 *  at key N produces a v(N+1) blob. Mirrors the GB engine's
 *  `STATE_MIGRATORS` so the migration discipline is identical across
 *  the two lineages. */
const GBA_STATE_MIGRATORS: Record<number, GbaStateMigrator> = {
  // 1: (b) => migrateV1toV2(b),
};

/** Walk the migrator chain from `bytes[0]` up to the current
 *  `GBA_STATE_VERSION`. Returns the upgraded blob (always at the
 *  current version). Throws `UnsupportedGbaSaveStateError` if the
 *  source version has no migrator (too old) or is newer than current
 *  (forward-incompat). Caller's responsibility to validate the blob
 *  is non-empty. */
export function upgradeGbaState(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    throw new UnsupportedGbaSaveStateError(0, GBA_STATE_VERSION);
  }
  let current = bytes;
  let version = current[0]!;
  if (version > GBA_STATE_VERSION) {
    throw new UnsupportedGbaSaveStateError(version, GBA_STATE_VERSION);
  }
  while (version < GBA_STATE_VERSION) {
    const migrate = GBA_STATE_MIGRATORS[version];
    if (!migrate) {
      throw new UnsupportedGbaSaveStateError(version, GBA_STATE_VERSION);
    }
    current = migrate(current);
    version = current[0]!;
  }
  return current;
}

export class GbaStateWriter {
  private readonly view: DataView;
  readonly buffer: Uint8Array;
  private offset = 0;

  constructor(capacity = 1024 * 1024) {
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

export class GbaStateReader {
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
