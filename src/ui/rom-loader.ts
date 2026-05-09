import { GameBoy } from "../gb";
import { restoreSymbolsForCurrentCart } from "./debugger/symbols-pane.js";
import {
  canvas,
  canvasPlaceholder,
  cartInfoTrigger,
  cheatsTrigger,
  debuggerTrigger,
  fsBtn,
  loadBtn,
  recentsTrigger,
  romInput,
  slotsTrigger,
  speedEl
} from "./dom.js";
import { confirmAction } from "./hud/modal.js";
import { resetStatus, tickStatus } from "./hud/status.js";
import { errorToast, toast } from "./hud/toast.js";
import { loadCartOverrides } from "./persistence/cart-overrides.js";
import * as Cheats from "./persistence/cheats.js";
import { importStateFile } from "./persistence/io/state.js";
import { KEYS, lsGet } from "./persistence/local-storage.js";
import * as Recents from "./persistence/recents.js";
import * as SaveRam from "./persistence/save-ram.js";
import * as SaveState from "./persistence/save-state.js";
import { applyCartOverrides } from "./session/cart-overrides.js";
import { startPacing, stopPacing } from "./session/pacing.js";
import { applyPatch, detectPatch } from "./session/patches.js";
import { flushPlayTime, startPlayTimer } from "./session/play-time.js";
import { RewindBuffer } from "./session/rewind-buffer.js";
import { applyColorCorrection, applyCurrentPalette, applyMuteState, refreshPaletteAvailability } from "./settings";
import { audio, gamepad, renderer, setPaused, state } from "./state.js";

/**
 * All ROM-entry paths converge here: the header **Load ROM** button, the
 * drag-and-drop handler, and the PWA `launchQueue` (double-click a .gb /
 * .gbc from the OS once the app is installed). Everything calls the same
 * `startEmulator` so lifecycle bookkeeping (flush previous cart, auto-
 * resume, thumbnail capture) lives in one place.
 */

const ROM_RE = /\.(gb|gbc)$/i;
const PATCH_RE = /\.(ips|bps)$/i;
const STATE_RE = /\.gbstate$/i;

/** Read the user's rewind-buffer-length preference. One capture per
 *  second, so the number is both seconds of history and slots in the
 *  ring. Range-clamped to avoid a corrupt localStorage value blowing
 *  up memory; 60 is the historical default. */
function loadRewindCapacity(): number {
  const raw = parseInt(lsGet(KEYS.REWIND_CAPACITY) ?? "60", 10);
  if (!Number.isFinite(raw)) return 60;
  return Math.max(10, Math.min(1800, raw));
}

export async function startEmulator(romData: Uint8Array, filename: string, rememberInRecents = true): Promise<void> {
  await audio.resume(); // must be inside a user-gesture frame

  // Flush the previous cart's save RAM, auto-snapshot, and play-time
  // counter before discarding it. Await so all three writes complete before
  // the old cart object goes out of scope — the auto-state captures the
  // exact moment of ROM switch so resuming Game A after playing Game B
  // picks up where Game A left off.
  if (state.gb) {
    await SaveRam.save(state.gb.cart, true);
    await SaveState.saveAutoState(state.gb);
    await flushPlayTime();
  }
  state.playTrackingId = null;
  // The RTC pause marker belongs to the outgoing cart; clearing it here
  // prevents a stale pause timestamp from being applied to the new cart's
  // clock on first resume.
  state.rtcWallPauseMs = 0;
  state.autoPausedOnBlur = false;
  // The freshly-built GameBoy boots at speedMultiplier = 1, so hide the
  // "×2" / "×4" / "×0.5" indicator even if the previous cart was left
  // mid-cycle.
  speedEl?.classList.remove("is-on");

  stopPacing();
  gamepad.unbind();
  state.rewinder?.stop();
  state.rewinder = null;
  // Release the webcam if a previous Camera cart was running. The
  // user's OS indicator-light should drop the moment they swap to a
  // non-camera ROM. No-op if the webcam was never started.
  void import("./input/webcam.js").then((m) => m.stopWebcam());
  if (state.thumbnailTimer !== null) {
    clearTimeout(state.thumbnailTimer);
    state.thumbnailTimer = null;
  }

  // Cart construction can throw on malformed headers, unsupported MBC
  // types, or truncated data. The previous cart is already torn down by
  // the setup above, so on failure we land in a clean "no cart running"
  // state — toast the reason and bail. The user can pick another ROM.
  let gb: GameBoy;
  try {
    gb = new GameBoy(romData);
  } catch (err) {
    state.gb = null;
    console.warn("[Loader] cart construction failed:", err);
    errorToast(`Could not load ROM: ${(err as Error).message}`);
    return;
  }
  state.gb = gb;
  await SaveRam.load(gb.cart);
  gb.cheats.setEntries(await Cheats.load(gb.cart));
  gamepad.bind(gb.joypad);
  gb.apu.sampleRate = audio.sampleRate;

  gb.onFrame = (fb) => {
    renderer.render(fb);
    tickStatus(performance.now());
  };
  gb.onAudioFrame = (left, right, count) => {
    audio.schedule(left, right, count);
  };
  // Forward the MBC5-rumble bit to the connected controller's
  // vibration actuator. Non-rumble carts leave `onRumbleChange` null,
  // so there's no overhead for the common case.
  if (gb.cart.hasRumble) {
    gb.cart.onRumbleChange = (on) => gamepad.setRumble(on);
  }
  // MBC7 cart (Kirby Tilt 'n' Tumble) — point the cart's tilt callback
  // at the device-motion / keyboard reader. `startTilt` is idempotent;
  // on iOS the motion API is permission-gated, so we attach a one-shot
  // canvas-click handler that invokes `requestMotionPermission` from
  // inside a user-gesture context (Safari rejects the request otherwise).
  if (gb.cart.mbcType === "MBC7") {
    const { startTilt, readTilt, requestMotionPermission } = await import("./input/tilt.js");
    startTilt();
    gb.cart.tiltSource = () => readTilt();
    const screen = document.getElementById("screen");
    if (screen) {
      const onceClick = () => {
        screen.removeEventListener("click", onceClick);
        void requestMotionPermission();
      };
      screen.addEventListener("click", onceClick);
    }
  }
  // Game Boy Camera cart — wire the webcam in as the sensor source.
  // `startWebcam` eagerly grabs the stream so the OS permission prompt
  // fires on cart load (and the stream is live by the time the player
  // navigates into Shoot mode). The Camera ROM triggers a capture every
  // frame via the busy-bit handshake at $A000, so `onCameraCapture` is
  // the only driver we need — no separate 30 Hz timer to race with the
  // ROM's mid-frame SRAM reads.
  if (gb.cart.mbcType === "CAMERA") {
    const { startWebcam, captureToCartRam } = await import("./input/webcam.js");
    gb.cart.onCameraCapture = (cart) => captureToCartRam(cart);
    void startWebcam();
  }
  // Link cable — if the user has pair mode on, attach the live
  // BroadcastChannel instance to this fresh MMU so serial transfers
  // reach the other tab.
  if (state.link) gb.mmu.setSerialLink(state.link);

  resetStatus(gb.cart.title || filename.replace(/\.[^.]+$/, "").toUpperCase());
  state.currentFilename = filename;
  // Rehydrate any `.sym` file the user previously loaded for this cart
  // so the debugger comes up with names already resolved.
  restoreSymbolsForCurrentCart();
  if (cartInfoTrigger) cartInfoTrigger.hidden = false;
  // Hide the "Load ROM" click-to-load placeholder now that an engine
  // exists. We never reshow it for the session; subsequent ROM loads
  // go through the header's Load button / drag-drop / Library.
  if (canvasPlaceholder) canvasPlaceholder.hidden = true;
  // Header icons that only make sense with a ROM running. Start
  // disabled in the HTML; re-enable here so the first time a cart is
  // loaded they become tappable. We never disable them again — once a
  // cart has been loaded for the session, there's always an engine to
  // open the popover / fullscreen against.
  // Their HTML titles include a "load a ROM to use" hint so the
  // disabled state is self-explanatory; swap to the plain feature name
  // once the ROM is in.
  // Library is also flipped to enabled here even though `Recents.remember`
  // (called below) is async — semantically a ROM has just loaded, so the
  // library is about to be non-empty. Avoids waiting for the IDB write
  // to flush before the icon becomes tappable.
  if (recentsTrigger) {
    recentsTrigger.disabled = false;
    recentsTrigger.title = "Library";
  }
  if (slotsTrigger) {
    slotsTrigger.disabled = false;
    slotsTrigger.title = "Save slots";
  }
  if (cheatsTrigger) {
    cheatsTrigger.disabled = false;
    cheatsTrigger.title = "Cheats";
  }
  if (debuggerTrigger) {
    debuggerTrigger.disabled = false;
    debuggerTrigger.title = "Debugger";
  }
  if (fsBtn) {
    fsBtn.disabled = false;
    fsBtn.title = "Fullscreen";
  }
  // Printer's trigger is gated on link-cable mode + history rather
  // than just "ROM loaded", so it owns its own enable logic. Nudge it
  // to re-evaluate now that `state.gb` is set — its disabled-state
  // hint can now move from the generic "load a ROM" wording to the
  // more specific "set Link cable to Printer in Settings" step.
  void import("./popovers/printer.js").then((m) => m.refreshPrinterTrigger());

  // Body-level signal that a cart is running. CSS uses this to fade
  // the touch action toolbar in (every button below the canvas needs
  // a running engine, so showing them on the empty-state placeholder
  // would just be noise). Stays sticky for the session — failure
  // paths null `state.gb` only as an intermediate step before another
  // load, and there's no user-facing "close cart" action.
  document.body.classList.add("has-cart");

  // Resume from the last auto-snapshot if one exists for this cart. Runs
  // before gb.start() so the engine wakes up at the snapshotted PC instead
  // of the default boot state. Best-effort — a version mismatch or decode
  // error just leaves the cart at its fresh state.
  try {
    if ((await SaveState.hasAutoState(gb.cart)) && (await SaveState.loadAutoState(gb))) {
      toast("Resumed last session");
    }
  } catch (err) {
    console.warn("[State] auto-resume failed:", err);
  }

  startPacing(gb);
  setPaused(false);
  state.playTrackingId = Recents.idFor(gb.cart);
  startPlayTimer();

  state.rewinder = new RewindBuffer(
    gb,
    () => ({
      frameCount: state.frameCount,
      elapsedMs: performance.now() - state.runStartMs,
      // Copy — the PPU keeps writing into the same buffer object each
      // frame, so we need our own snapshot to display on rewind.
      framebuffer: new Uint8ClampedArray(gb.ppu.framebuffer) as Uint8ClampedArray<ArrayBuffer>
    }),
    1000,
    loadRewindCapacity()
  );
  state.rewinder.start();

  // Re-apply user preferences that live outside the engine — the new
  // GameBoy instance owns fresh APU + PPU state, so the previous session's
  // settings need to be re-projected onto it.
  applyCurrentPalette();
  refreshPaletteAvailability();
  applyMuteState();
  applyColorCorrection();

  // Per-cart overrides run on top of the global prefs above — any pinned
  // palette / colour-correction / render-mode replaces the global value
  // just for this cart. Non-blocking: if IDB is slow the cart still
  // starts with the global defaults.
  void loadCartOverrides(gb.cart).then((overrides) => {
    if (state.gb === gb) applyCartOverrides(overrides);
  });

  if (rememberInRecents) {
    void Recents.remember(gb.cart, romData, filename);
  }

  // Capture a library thumbnail a few seconds in — long enough that most
  // games are past their splash/title screen, but short enough that the
  // user is likely still playing. Replaces any prior thumbnail so it
  // tracks where the user actually spends time.
  const cartRef = gb.cart;
  state.thumbnailTimer = window.setTimeout(() => {
    state.thumbnailTimer = null;
    if (state.gb?.cart !== cartRef) return;
    let thumb: string | undefined;
    try {
      thumb = canvas.toDataURL("image/png");
    } catch {
      /* tainted canvas */
    }
    if (thumb) void Recents.setThumbnail(Recents.idFor(cartRef), thumb);
  }, 4000);
}

// ─── Entry points ─────────────────────────────────────────────────────────
// Three paths end up here: the Load-ROM button / file-picker, drag-and-drop,
// and the PWA launchQueue (double-clicking a .gb/.gbc in the OS file manager
// once the app is installed). `loadRomFile` keeps the shared file→bytes
// hand-off in one place.

async function loadRomFile(file: File): Promise<void> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    console.warn("[Loader] file read failed:", err);
    errorToast("Could not read file");
    return;
  }
  await startEmulator(new Uint8Array(buffer), file.name);
}

/** Apply an IPS/BPS patch to the currently-loaded ROM and restart with
 *  the patched bytes. Fresh bytes mean a fresh cart ID, so the Recents
 *  / save-RAM / save-states for the patched variant stay separate from
 *  the unmodified base ROM — there's no risk of a randomizer's save-RAM
 *  colliding with the vanilla game. */
async function applyPatchToCurrent(patchFile: File): Promise<void> {
  if (!state.gb) {
    toast("Load a ROM first, then drop the patch");
    return;
  }
  let patch: Uint8Array;
  try {
    patch = new Uint8Array(await patchFile.arrayBuffer());
  } catch (err) {
    console.warn("[Loader] patch file read failed:", err);
    errorToast("Could not read patch file");
    return;
  }
  const base = state.gb.cart.rom;
  let patched: Uint8Array;
  try {
    patched = applyPatch(base, patch);
  } catch (err) {
    console.warn("[Patches] apply failed:", err);
    errorToast(`Patch failed: ${(err as Error).message}`);
    return;
  }
  // Derive a readable filename for Recents — keep the original stem but
  // tack on the patch name so the Library entry is obviously a hack.
  const baseStem = (state.currentFilename ?? "rom").replace(/\.[^.]+$/, "");
  const patchStem = patchFile.name.replace(/\.[^.]+$/, "");
  const ext = state.gb.cart.cgb ? ".gbc" : ".gb";
  const newName = `${baseStem} [${patchStem}]${ext}`;
  stopPacing();
  state.gb = null;
  await startEmulator(patched, newName, true);
  toast("Patch applied");
}

/** Try to treat a drop/pick as an IPS/BPS patch first; returns true on
 *  handled. Lets the drop handler short-circuit before falling through to
 *  the ROM path for paired-file drops (rom + patch together). */
async function tryLoadAsPatch(file: File): Promise<boolean> {
  if (!/\.(ips|bps)$/i.test(file.name)) return false;
  await applyPatchToCurrent(file);
  return true;
}

/** Import a dropped `.gbstate` file into the currently-running cart.
 *  Validation (cartId match, schema) lives in `importStateFile` — this
 *  wrapper just handles the file-read + toast for each failure path so
 *  the drop handler stays tidy. */
async function tryLoadAsState(file: File): Promise<void> {
  if (!state.gb) {
    toast("Load a ROM first, then drop the save state");
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    console.warn("[Loader] state file read failed:", err);
    errorToast("Could not read save-state file");
    return;
  }
  const result = await importStateFile(state.gb.cart, text);
  if (!result.ok) {
    errorToast(result.reason ?? "Import failed");
    return;
  }
  toast(`Imported slot ${result.slot}`);
}

loadBtn?.addEventListener("click", () => romInput.click());
canvasPlaceholder?.addEventListener("click", () => romInput.click());

// ─── Restart cart ─────────────────────────────────────────────────────────
// The auto-snapshot feature always restores the last-session engine state
// on load, which is exactly wrong once the user has finished a game and
// the saved state is parked on the ending screen. This clears the
// auto-state for the current cart and re-launches from the ROM's entry
// point. Save-RAM (in-game save files) is intentionally left alone —
// users who genuinely want a fresh start can delete the Library entry.
export async function resetCart(): Promise<void> {
  if (!state.gb || !state.currentFilename) return;
  const ok = await confirmAction({
    title: "Restart this ROM?",
    body: "Your last-session resume point will be cleared. In-game saves are kept.",
    confirmLabel: "Restart",
    danger: true
  });
  if (!ok) return;
  const bytes = state.gb.cart.rom;
  const filename = state.currentFilename;
  await SaveState.clearAutoState(state.gb.cart);
  // Detach the running engine before re-entering `startEmulator` — its
  // "flush old cart" block would otherwise re-write the auto-state we
  // just cleared before the restart even begins.
  stopPacing();
  state.gb = null;
  await startEmulator(bytes, filename, true);
}

romInput.addEventListener("change", async () => {
  const files = Array.from(romInput.files ?? []);
  if (files.length === 0) return;
  const rom = files.find((f) => ROM_RE.test(f.name));
  const patch = files.find((f) => PATCH_RE.test(f.name));
  try {
    if (rom && patch) {
      const romBytes = new Uint8Array(await rom.arrayBuffer());
      const patchBytes = new Uint8Array(await patch.arrayBuffer());
      const patched = applyPatch(romBytes, patchBytes);
      const baseStem = rom.name.replace(/\.[^.]+$/, "");
      const patchStem = patch.name.replace(/\.[^.]+$/, "");
      const ext = rom.name.match(/\.[^.]+$/)?.[0] ?? ".gb";
      await startEmulator(patched, `${baseStem} [${patchStem}]${ext}`);
      toast("Patch applied");
    } else if (rom) {
      await loadRomFile(rom);
    } else if (patch) {
      await tryLoadAsPatch(patch);
    }
  } catch (err) {
    errorToast(`Load failed: ${(err as Error).message}`);
  }
  // Reset so the same file can be re-selected if the user picks it again.
  romInput.value = "";
});

// Drag-and-drop ROMs (and optionally patches, or a save-state) onto
// the page. Accepted shapes:
//   rom only                  → load
//   patch only                → apply to the currently-running cart
//   rom + patch (any order)   → patch then load the patched bytes
//   .gbstate only             → import into the currently-running cart
// Visual drop-target affordance: dragenter/leave fire on every child
// crossing, so we ref-count enters and only clear the state when the
// count hits zero. Hitting `drop` or `dragend` resets unconditionally.
let dragDepth = 0;
function setDropTarget(on: boolean): void {
  document.body.classList.toggle("is-drop-target", on);
}
document.body.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  if (dragDepth === 1) setDropTarget(true);
});
document.body.addEventListener("dragleave", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropTarget(false);
});
document.body.addEventListener("dragend", () => {
  dragDepth = 0;
  setDropTarget(false);
});
document.body.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.body.addEventListener("drop", async (e) => {
  dragDepth = 0;
  setDropTarget(false);
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  const rom = files.find((f) => ROM_RE.test(f.name));
  const patch = files.find((f) => PATCH_RE.test(f.name));
  const savedState = files.find((f) => STATE_RE.test(f.name));
  if (!rom && !patch && !savedState) return;
  e.preventDefault();

  if (rom && patch) {
    let romBytes: Uint8Array;
    let patchBytes: Uint8Array;
    try {
      romBytes = new Uint8Array(await rom.arrayBuffer());
      patchBytes = new Uint8Array(await patch.arrayBuffer());
    } catch (err) {
      console.warn("[Loader] file read failed:", err);
      errorToast("Could not read file");
      return;
    }
    if (!detectPatch(patchBytes)) {
      toast("Unrecognised patch format");
      return;
    }
    let patched: Uint8Array;
    try {
      patched = applyPatch(romBytes, patchBytes);
    } catch (err) {
      errorToast(`Patch failed: ${(err as Error).message}`);
      return;
    }
    const baseStem = rom.name.replace(/\.[^.]+$/, "");
    const patchStem = patch.name.replace(/\.[^.]+$/, "");
    const ext = rom.name.match(/\.[^.]+$/)?.[0] ?? ".gb";
    await startEmulator(patched, `${baseStem} [${patchStem}]${ext}`);
    toast("Patch applied");
    return;
  }
  if (rom) {
    await loadRomFile(rom);
    return;
  }
  if (patch) {
    await tryLoadAsPatch(patch);
    return;
  }
  if (savedState) await tryLoadAsState(savedState);
});

/** PWA file association — when a .gb / .gbc is opened from the OS via the
 *  installed PWA the browser hands the file to the page through
 *  window.launchQueue. The file_handlers entry in the manifest registers
 *  the association; this just consumes what gets delivered. No-op in
 *  browsers without the API (Safari / Firefox). */
const lq = (
  window as Window & {
    launchQueue?: {
      setConsumer(c: (params: { files?: FileSystemFileHandle[] }) => void): void;
    };
  }
).launchQueue;
lq?.setConsumer(async (params) => {
  const handle = params.files?.[0];
  if (!handle) return;
  await loadRomFile(await handle.getFile());
});
