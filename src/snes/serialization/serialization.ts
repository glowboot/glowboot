/**
 * Binary save-state format for the SNES engine. `snes.ts` constructs a
 * `SnesStateWriter` / `SnesStateReader` and threads it through each
 * subsystem's `serialize(w)` / `deserialize(r)` method, which writes/reads a
 * fixed layout via these helpers; the concatenated payload carries a 1-byte
 * version prefix.
 *
 * Parallel to the GB / GBA / NES serialization modules but kept separate:
 * the engines have independent lineages — bumping one version must not break
 * the others — and the `src/snes/tsconfig.json` split forbids a cross-engine
 * import.
 *
 * Storage of the serialised blob (IndexedDB slots, thumbnails, slot
 * enumeration) lives in `ui/persistence/save-state.ts` — this file is only
 * the binary format itself.
 */

/** First byte of every SNES save state. Bump on every change to any
 *  subsystem's `serialize`/`deserialize` layout (with a migrator, once the
 *  engine has shipped — pre-release the version may stay at 1 while layouts
 *  churn). */
export const SNES_STATE_VERSION = 1;

/** Thrown when a SNES save state's version is older than the oldest
 *  registered migrator or newer than this build. */
export class UnsupportedSnesSaveStateError extends Error {
  constructor(
    readonly stateVersion: number,
    readonly currentVersion: number
  ) {
    super(
      stateVersion > currentVersion
        ? `Save state version ${stateVersion} is newer than this build (${currentVersion}). Update Glowboot to load it.`
        : `Save state version ${stateVersion} is too old to migrate to ${currentVersion}. Your in-game save (cartridge save RAM) is unaffected.`
    );
    this.name = "UnsupportedSnesSaveStateError";
  }
}

/** Migrator: takes a save-state blob at version N (first byte = N) and
 *  returns an equivalent blob at version N+1. */
type SnesStateMigrator = (bytes: Uint8Array) => Uint8Array;

/** Registry of v(N) → v(N+1) migrators. Add an entry alongside every
 *  SNES_STATE_VERSION bump once the engine has shipped. */
const SNES_STATE_MIGRATORS: Record<number, SnesStateMigrator> = {
  // 1: (b) => migrateV1toV2(b),
};

/** Walk the migrator chain from `bytes[0]` up to the current
 *  `SNES_STATE_VERSION`. Throws `UnsupportedSnesSaveStateError` for a blob
 *  with no migration path — before any subsystem field gets mutated. */
export function upgradeSnesState(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    throw new UnsupportedSnesSaveStateError(0, SNES_STATE_VERSION);
  }
  let current = bytes;
  let version = current[0]!;
  if (version > SNES_STATE_VERSION) {
    throw new UnsupportedSnesSaveStateError(version, SNES_STATE_VERSION);
  }
  while (version < SNES_STATE_VERSION) {
    const migrate = SNES_STATE_MIGRATORS[version];
    if (!migrate) {
      throw new UnsupportedSnesSaveStateError(version, SNES_STATE_VERSION);
    }
    current = migrate(current);
    version = current[0]!;
  }
  return current;
}

export class SnesStateWriter {
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

export class SnesStateReader {
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
