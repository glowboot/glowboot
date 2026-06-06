import { GameBoy } from "../gb";
import { Gba, parseGbaHeader } from "../gba";
import { restoreSymbolsForCurrentCart } from "./debugger/symbols-pane.js";
import { restoreGbaSymbolsForCurrentCart } from "./debugger/symbols-pane-gba.js";
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
import { readGyroscope, readSolarBrightness, readTilt, requestMotionPermission, startTilt } from "./input/tilt.js";
import { loadCartOverrides } from "./persistence/cart-overrides.js";
import * as Cheats from "./persistence/cheats.js";
import { importStateFile } from "./persistence/io/state.js";
import { KEYS, lsGet } from "./persistence/local-storage.js";
import * as Recents from "./persistence/recents.js";
import * as SaveRam from "./persistence/save-ram.js";
import * as SaveRamGba from "./persistence/save-ram-gba.js";
import * as SaveState from "./persistence/save-state.js";
import { refreshPrinterTrigger } from "./popovers";
import { applyCartOverrides } from "./session/cart-overrides.js";
import { startPacing, stopPacing } from "./session/pacing.js";
import { applyPatch, detectPatch } from "./session/patches.js";
import { flushPlayTime, startPlayTimer } from "./session/play-time.js";
import { REWIND_CAPACITY_SECONDS, RewindBuffer } from "./session/rewind-buffer.js";
import { startGbaSession, stopGbaSession } from "./session/runtime-gba.js";
import {
  applyColorCorrection,
  applyCurrentPalette,
  applyMuteState,
  refreshGbOnlyAvailability,
  refreshPaletteAvailability,
  syncIntegerScaleToggle
} from "./settings";
import { audio, gamepad, renderer, type RewindMeta, setPaused, state, swapRenderer } from "./state.js";

/**
 * All ROM-entry paths converge here. Engine dispatch lives in each
 * entry point so the GB-only `startEmulator` never sees a GBA ROM:
 *
 *   - Header **Load ROM** button (file `<input>` `change` handler) —
 *     routes `.gba` to {@link handleGbaRomFile}, otherwise to the GB
 *     path via {@link loadRomFile} → {@link startEmulator}.
 *   - Drag-and-drop handler — same dispatch as the load button, plus
 *     handles `.ips` / `.bps` patches and dropped `.gbstate` /
 *     `.gbastate` save-state files.
 *   - PWA `launchQueue` — double-click a registered file extension
 *     from the OS once the app is installed; `file_handlers` in
 *     `vite.config.ts` register `.gb` / `.gbc` / `.gba`, and the
 *     consumer below mirrors the drop-handler dispatch.
 *
 * Lifecycle bookkeeping (flush previous cart, auto-resume, thumbnail
 * capture) lives in {@link startEmulator} (GB) and
 * {@link handleGbaRomFile} (GBA) so the entry points stay small.
 */

const ROM_RE = /\.(gb|gbc)$/i;
const GBA_ROM_RE = /\.gba$/i;
const PATCH_RE = /\.(ips|bps)$/i;
// Matches `.gbstate` (Game Boy) and `.gbastate` (Game Boy Advance).
// `importStateFile` is engine-polymorphic so the same drop path
// dispatches both — the JSON envelope's cartId selects which engine
// actually receives the state.
const STATE_RE = /\.gba?state$/i;

/** Boot a GBA ROM. The function tears down any running GB session
 *  first and persists save-RAM / auto-state for both engines so the
 *  outgoing cart can be resumed later. Exported so the library popover
 *  can dispatch GBA entries back through here — see also
 *  {@link startEmulator} for the GB side. */
export async function handleGbaRomFile(file: File, rememberInRecents = true): Promise<void> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    console.warn("[Loader] file read failed:", err);
    errorToast("Could not read file");
    return;
  }
  let header;
  try {
    header = parseGbaHeader(new Uint8Array(buffer));
  } catch (err) {
    errorToast(`Not a valid GBA ROM: ${(err as Error).message}`);
    return;
  }

  // Tear down any running GB session before booting the GBA cart.
  // Flush the outgoing GB cart's save RAM + auto-snapshot so its
  // resume point isn't lost when the user comes back to it later.
  if (state.gb) {
    await SaveRam.save(state.gb.cart, true);
    await SaveState.saveAutoState(state.gb);
    stopPacing();
    state.gb = null;
    gamepad.unbind();
    state.rewinder?.stop();
    state.rewinder = null;
  }
  // Cancel any pending thumbnail capture left over from the previous
  // cart — without this, a 4-second-delayed snapshot scheduled by the
  // outgoing GB load would fire against the GBA framebuffer and
  // overwrite the wrong library entry.
  if (state.thumbnailTimer !== null) {
    clearTimeout(state.thumbnailTimer);
    state.thumbnailTimer = null;
  }
  // Flush the outgoing GBA cart's backup + auto-snapshot before
  // discarding it (e.g. when switching between two GBA carts).
  if (state.gba) {
    await SaveRamGba.save(state.gba, true);
    await SaveState.saveAutoState(state.gba);
    state.rewinder?.stop();
    state.rewinder = null;
  }

  // Rebuild the shared renderer at GBA dimensions (240×160). The GB
  // path's renderer is sized to 160×144; carrying that into a GBA load
  // would either letterbox or stretch the framebuffer. We honour the
  // user's preferred render mode so GBA also benefits from the WebGL
  // shaders rather than being pinned to Canvas 2D.
  swapRenderer(lsGet(KEYS.RENDER_MODE) ?? "canvas", { width: 240, height: 160 });

  // Fresh Gba defaults to speedMultiplier = 1; hide the ×N indicator
  // if the previous cart was left mid-cycle. Mirrors the GB path.
  speedEl?.classList.remove("is-on");

  await audio.resume(); // must be inside the user-gesture frame that loaded the file

  // No BIOS image: GBA carts run through Glowboot's HLE BIOS. The real
  // Cult-of-GBA BIOS is kept only as a test-runner diagnostic aid (see
  // tests/run-gba-roms.ts), never shipped to the browser.
  const gba = new Gba(new Uint8Array(buffer));
  state.gba = gba;
  // Re-sync the Settings controls now that the engine has switched.
  // With the unified prefs (one key for integer-scale) the toggle
  // value doesn't change across engines, but `refreshGbOnlyAvailability`
  // does need the swap to grey out the GB-only controls.
  syncIntegerScaleToggle();
  refreshGbOnlyAvailability();
  refreshPaletteAvailability();
  // Hydrate any previously-loaded symbol file for this exact cart so
  // disasm / call-stack labels reappear without the user re-picking the
  // file. No-op when nothing's stored.
  restoreGbaSymbolsForCurrentCart();
  // Restore persisted SRAM / Flash bytes before the cart's first
  // instruction runs — otherwise the cart's "load save" routine sees
  // an erased backup and starts a new game.
  await SaveRamGba.load(gba);
  // Seed the cheat engine with persisted entries so per-frame writes
  // resume in the same enabled / disabled state the user left them.
  gba.cheats.setEntries(await Cheats.loadGba(gba));
  // Resume from the last auto-snapshot if one exists for this cart.
  // Best-effort — a version mismatch or decode error just leaves the
  // cart at its fresh state. Mirrors the GB path's behaviour.
  try {
    if ((await SaveState.hasAutoState(gba)) && (await SaveState.loadAutoState(gba))) {
      toast("Resumed last session");
    }
  } catch (err) {
    console.warn("[State] GBA auto-resume failed:", err);
  }
  // Keyboard + gamepad input feed through the bound joypad. Touch
  // input picks it up via the `getJoypad` callback in panels.ts.
  gamepad.bind(gba.joypad);
  gamepad.bindShoulders(gba.joypad);
  startGbaSession(gba, audio);
  // Play-time tracking — same plumbing as the GB path so the library
  // shows total play and "most played" counts across both engines.
  // Key the timer by `idForGba` so GBA carts get their own per-cart
  // bucket; flushPlayTime is already invoked on pause / tab-hide /
  // ROM swap via the shared session hooks.
  state.playTrackingId = Recents.idForGba(gba);
  startPlayTimer();

  // Same landing-screen takedown the GB path does: hide the "Load ROM"
  // placeholder (it's still on top of the canvas otherwise, intercepting
  // every tap) and flag the body as carrying a running cart so the touch
  // toolbar fades in.
  if (canvasPlaceholder) canvasPlaceholder.hidden = true;
  document.body.classList.add("has-cart");

  // Header icons that need a running engine. Mirror the subset of the
  // `startEmulator` path's enable block that's actually wired for GBA
  // today: fullscreen + library + save-slots + cart-info. Cheats and
  // the debugger are GB-only for now — stay disabled with a tooltip
  // that explains *why* rather than the generic "load a ROM" wording.
  if (fsBtn) {
    fsBtn.disabled = false;
    fsBtn.title = "Fullscreen";
  }
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
  if (cartInfoTrigger) cartInfoTrigger.hidden = false;

  const label = header.title || file.name.replace(/\.[^.]+$/, "");
  // Drive the NOW-PLAYING strip (title + FPS + elapsed-time) for the
  // GBA session, same hooks the GB path uses. `tickStatus` is wired
  // from `startGbaSession`'s `onFrame`.
  resetStatus(label.toUpperCase());
  // Reuse `currentFilename` so the Reset hotkey can re-launch via the
  // GBA branch in `resetCart`. The two engines are mutually exclusive
  // so they don't fight over the field.
  state.currentFilename = file.name;
  // Re-project the engine-agnostic user prefs onto the fresh APU.
  // Palette / colour-correction are GB-specific and silently no-op
  // when `state.gb` is null. The other shared knobs (audio mode etc.)
  // arrive via per-cart overrides below.
  applyMuteState();

  // Rewinder — same contract as the GB side, just snapshotting a
  // GBA engine with its 240×160 framebuffer. `state.rewinder` was
  // re-typed polymorphic in this commit so a single slot serves
  // both engines.
  state.rewinder = new RewindBuffer<RewindMeta>(
    gba,
    () => ({
      frameCount: state.frameCount,
      elapsedMs: performance.now() - state.runStartMs,
      // Copy — the PPU writes into the same buffer object every
      // frame, so we need our own snapshot to display on rewind.
      framebuffer: new Uint8ClampedArray(gba.framebuffer) as Uint8ClampedArray<ArrayBuffer>
    }),
    1000,
    REWIND_CAPACITY_SECONDS
  );
  state.rewinder.start();
  // Per-cart overrides — same record format the GB path uses, keyed
  // by `cartIdOfGba`. Currently only the audio-mode pin applies to
  // GBA carts (palette / colour-correction / renderer-abstraction
  // knobs are GB-only by nature). Non-blocking so the cart still
  // starts with global defaults if IDB is slow.
  void loadCartOverrides(Recents.idForGba(gba)).then((overrides) => {
    if (state.gba === gba) applyCartOverrides(overrides);
  });
  // Forward the cart's GPIO rumble bit to the connected controller's
  // vibration actuator (and the device's haptic motor on mobile),
  // mirroring the GB MBC5 path. Non-rumble carts leave the hook null.
  if (gba.hasRumble) {
    gba.onRumbleChange = (on) => gamepad.setRumble(on);
  }
  // Re-attach (or lazily create) the GBA Multiplayer link. Settings
  // init can't construct the GBA-side BC link before a cart is loaded
  // — at that point `state.gba` is still null and `enable2PlayerLink`
  // falls through to the GB-side path. Mirror the persisted link mode
  // here so a 2P session survives "page-reload with cart auto-load".
  if (state.gbaLink === null && lsGet(KEYS.LINK_CABLE_MODE) === "2p") {
    const roomCode = (lsGet(KEYS.LINK_ROOM_CODE) ?? "").trim();
    const RELAY_URL = ((import.meta.env.VITE_LINK_RELAY_URL as string | undefined) ?? "").trim();
    // Cross-device GBA Multi-Pak is experimental — see
    // `GBA_LINK_CROSS_DEVICE_EXPERIMENTAL` doc in local-storage.ts.
    // Without the opt-in, room codes are ignored on the GBA path and
    // we fall back to same-machine BroadcastChannel.
    const crossDeviceExperimental = lsGet(KEYS.GBA_LINK_CROSS_DEVICE_EXPERIMENTAL) === "1";
    if (roomCode && RELAY_URL && crossDeviceExperimental) {
      const { WebRtcGbaLink } = await import("./session/webrtc-link-gba.js");
      state.gbaLink = new WebRtcGbaLink(roomCode, RELAY_URL);
    } else {
      const { BroadcastChannelGbaLink } = await import("./session/link-cable-gba.js");
      state.gbaLink = new BroadcastChannelGbaLink();
    }
  }
  if (state.gbaLink !== null) gba.sio.setLink(state.gbaLink);
  // Yoshi-family tilt carts (Yoshi Topsy-Turvy, Koro Koro Puzzle) —
  // point the sensor at the same device-motion / keyboard reader the
  // GB MBC7 path uses. `startTilt` is idempotent; on iOS the motion
  // API needs a user-gesture permission prompt, attached to the canvas's
  // first click. The accelerometer chip and the MBC7 chip are different
  // hardware, but the host-side input vector (`{x, y}` in g-units) is
  // exactly what both want, so the source is shared.
  if (gba.tilt !== null) {
    startTilt();
    gba.tilt.tiltSource = () => readTilt();
    const screen = document.getElementById("screen");
    if (screen) {
      const onceClick = () => {
        screen.removeEventListener("click", onceClick);
        void requestMotionPermission();
      };
      screen.addEventListener("click", onceClick);
    }
    // The Yoshi-family carts capture the sensor reading at the moment
    // the player presses A on each calibration step — there's no real-
    // time visual feedback before that. A keyboard user has no reason
    // to know they have to hold I/J/K/L *while* pressing A on each
    // step, and without it the cart records an empty tilt range and
    // gameplay Yoshi visually leans but can't move. Surface the rule
    // up-front so they don't have to discover it the hard way.
    toast("Tilt cart — hold I/J/K/L while pressing A on each calibration step.");
  }
  // WarioWare: Twisted! — wire the cart-side gyroscope to the
  // shared keyboard / DeviceMotion reader. The gyroscope measures
  // angular velocity around Z; we map the same J/L "tilt left/right"
  // keys to clockwise / anti-clockwise rotation (Y axis is meaningless
  // for a Z-rotation sensor and is ignored).
  if (gba.gyroscope !== null) {
    startTilt();
    gba.gyroscope.angularVelocitySource = () => readGyroscope();
    toast("Gyroscope cart — J/L to rotate counter-clockwise / clockwise.");
  }
  // Boktai trilogy — wire the cart-side solar sensor to the brightness
  // value the Settings → Session → "Solar brightness" slider drives.
  // The cart's photodiode is sampled on every counter-reset pulse, so
  // any slider change takes effect on the next in-game sensor read.
  if (gba.solarSensor !== null) {
    gba.solarSensor.brightnessSource = () => readSolarBrightness();
    toast("Solar-sensor cart — adjust ambient light via Settings → Solar brightness.");
  }
  // Add the GBA cart to the library so it shows up in the Recents
  // popover alongside GB entries. Skipped when the launch came from a
  // library card click itself (the caller will bump the timestamp via
  // a follow-up `rememberGba` call to avoid re-writing the bytes).
  if (rememberInRecents) {
    void Recents.rememberGba(gba, new Uint8Array(buffer), file.name);
  }
  // Capture a library thumbnail a few seconds in — mirrors the GB
  // path. Time the capture for when the user is most likely past the
  // splash/title screen, so the library tile reflects actual play.
  // `cartIdOfGba` keeps the id stable across the timeout boundary;
  // the `state.gba === gbaRef` guard skips the write if the user has
  // since swapped to another cart.
  const gbaRef = gba;
  state.thumbnailTimer = window.setTimeout(() => {
    state.thumbnailTimer = null;
    if (state.gba !== gbaRef) return;
    let thumb: string | undefined;
    try {
      thumb = canvas.toDataURL("image/png");
    } catch {
      /* tainted canvas */
    }
    if (thumb) void Recents.setThumbnail(Recents.idForGba(gbaRef), thumb);
  }, 4000);
}

export async function startEmulator(romData: Uint8Array, filename: string, rememberInRecents = true): Promise<void> {
  await audio.resume(); // must be inside a user-gesture frame

  // Tear down any running GBA session before booting a GB cart.
  // No-op if no GBA session is active. Rebuilds the renderer at 160×144
  // so the new GB engine paints into a correctly-sized viewport.
  const wasGba = state.gba !== null;
  if (state.gba) {
    await SaveRamGba.save(state.gba, true);
    state.gba = null;
  }
  stopGbaSession();
  if (wasGba) {
    swapRenderer(lsGet(KEYS.RENDER_MODE) ?? "canvas", { width: 160, height: 144 });
  }

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
  // Re-sync the Settings controls now that the engine has switched
  // (the user may have just been on a GBA cart). Most controls share
  // a single key now, but `refreshGbOnlyAvailability` needs the swap
  // to re-enable the GB-only rows that are greyed out under GBA.
  syncIntegerScaleToggle();
  refreshGbOnlyAvailability();
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
  refreshPrinterTrigger();

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
    if ((await SaveState.hasAutoState(gb)) && (await SaveState.loadAutoState(gb))) {
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
    REWIND_CAPACITY_SECONDS
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
  void loadCartOverrides(Recents.idFor(gb.cart)).then((overrides) => {
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

/** Import a dropped save-state file (`.gbstate` for Game Boy,
 *  `.gbastate` for Game Boy Advance) into the currently-running cart.
 *  Validation (cartId match, schema) lives in `importStateFile` —
 *  this wrapper just handles the file-read + toast for each failure
 *  path so the drop handler stays tidy. */
async function tryLoadAsState(file: File): Promise<void> {
  const engine = state.gb ?? state.gba;
  if (!engine) {
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
  const result = await importStateFile(engine, text);
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
  const filename = state.currentFilename;
  if (!filename) return;

  // GBA path. Same UX as GB: confirm, clear auto-state, tear down,
  // reload from cached ROM bytes. SRAM / Flash / EEPROM is kept so
  // in-game saves survive the restart (the user can wipe those from
  // the Slots popover if they want a truly clean state).
  if (state.gba) {
    const ok = await confirmAction({
      title: "Restart this ROM?",
      body: "Your last-session resume point will be cleared. In-game saves are kept.",
      confirmLabel: "Restart",
      danger: true
    });
    if (!ok) return;
    const bytes = new Uint8Array(state.gba.mem.rom);
    await SaveState.clearAutoState(state.gba);
    stopGbaSession();
    state.gba = null;
    // Reconstruct a synthetic File so the existing GBA load path
    // handles all the wiring (audio resume, canvas swap, save-RAM
    // load, header parse, toast, status reset). Wrapping the bytes
    // in a File is cheap and avoids duplicating that logic here.
    const file = new File([bytes], filename, { type: "application/octet-stream" });
    await handleGbaRomFile(file);
    return;
  }

  if (!state.gb) return;
  const ok = await confirmAction({
    title: "Restart this ROM?",
    body: "Your last-session resume point will be cleared. In-game saves are kept.",
    confirmLabel: "Restart",
    danger: true
  });
  if (!ok) return;
  const bytes = state.gb.cart.rom;
  await SaveState.clearAutoState(state.gb);
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
  const gbaRom = files.find((f) => GBA_ROM_RE.test(f.name));
  if (gbaRom) {
    await handleGbaRomFile(gbaRom);
    romInput.value = "";
    return;
  }
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
  const gbaRom = files.find((f) => GBA_ROM_RE.test(f.name));
  const rom = files.find((f) => ROM_RE.test(f.name));
  const patch = files.find((f) => PATCH_RE.test(f.name));
  const savedState = files.find((f) => STATE_RE.test(f.name));
  if (!gbaRom && !rom && !patch && !savedState) return;
  e.preventDefault();

  if (gbaRom) {
    await handleGbaRomFile(gbaRom);
    return;
  }

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

/** PWA file association — when a `.gb` / `.gbc` / `.gba` is opened
 *  from the OS via the installed PWA the browser hands the file to
 *  the page through `window.launchQueue`. The `file_handlers` entry
 *  in the manifest registers all three associations; this consumer
 *  routes the delivered file to whichever engine handles its
 *  extension, mirroring the drop-handler dispatch above. No-op in
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
  const file = await handle.getFile();
  if (GBA_ROM_RE.test(file.name)) {
    await handleGbaRomFile(file);
  } else {
    await loadRomFile(file);
  }
});
