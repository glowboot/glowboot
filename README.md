# Glowboot

Play original Game Boy, Game Boy Color, and Game Boy Advance games in
your browser. No installation required, your game data stays on your
device, works on desktop and phones.

**Play at** [glowboot.pages.dev](https://glowboot.pages.dev/).

[![CI](https://github.com/glowboot/glowboot/actions/workflows/ci.yml/badge.svg)](https://github.com/glowboot/glowboot/actions/workflows/ci.yml)

> **Built entirely by AI.** Every artifact in this repository —
> TypeScript, CSS, HTML, configs, tests, documentation, images and
> screenshots, even the product name _Glowboot_ — was created or
> modified by AI agents working from natural-language direction. No
> file has been hand-typed or hand-edited by a human. The human behind
> Glowboot conceived the project, directs it, tests, and reviews — but
> writes none of it.

## Contents

- [What you can do](#what-you-can-do)
- [Getting started](#getting-started)
- [Controls](#controls)
- [Tips & features](#tips--features)
- [For developers](#for-developers)
- [Privacy](#privacy)
- [Disclaimer](#disclaimer)
- [Credits](#credits)
- [License](#license)

## What you can do

- **Play Game Boy, Game Boy Color, and Game Boy Advance games** —
  just load a `.gb`, `.gbc`, or `.gba` file and go.
- **Save anywhere, anytime** — 12 save slots per game, each with a
  thumbnail so you can see what's saved where. Or just close the tab —
  the emulator picks up exactly where you left off.
- **Rewind time** — hold a key to scrub backwards through the last
  two minutes of play. Great for tricky jumps and boss fights.
- **Speed it up or slow it down** — cycle between slow-motion, normal,
  2×, and 4× speed.
- **Record gameplay** — save a screenshot (PNG) or a video of what's on
  screen. Screenshots open a preview where you can **enhance with AI** —
  a neural upscaler renders a 4× version with cleaned-up edges and
  gradients, shown as a before/after you can drag-compare.
- **Translate the screen (experimental)** — press the Translate hotkey (or
  tap the Translate button in the touch toolbar) to read the on-screen
  text, translate it into your language, and optionally hear it read aloud. Everything runs on-device: no server, no API key.
  Chrome/Edge translate instantly with the built-in translator; other
  browsers can opt into a small on-device translation model. Where
  translation isn't available it falls back to reading the text aloud.
- **Ask AI about the screen (experimental, opt-in)** — point Glowboot at
  any OpenAI-compatible vision endpoint (a cloud provider, or a local
  server like Ollama / LM Studio) in Settings → AI assist, then ask a
  free-form question about what's on screen, get a quick hint, or have it
  described — streamed back and optionally read aloud, in your chosen
  language. Off until you configure it; nothing is sent until you do.
- **Let AI play (experimental, opt-in)** — turn that same endpoint loose
  on the game: it looks at the screen, plans the next few inputs, and
  drives the joypad, step by step. You can give it a **goal**, nudge it
  with **live hints**, and it keeps a running scratchpad and will
  **rewind** out of mistakes. Best on slower / turn-based games — twitch
  platformers will flail — and it spends your own API budget, so it's
  capped and stoppable, with a one-time cost confirmation before the first run.
- **Cheats** — paste Game Genie or Game Shark codes on Game Boy,
  GameShark or CodeBreaker codes on Game Boy Advance, or search an
  online database by game title.
- **Apply romhacks** — drag an `.ips` or `.bps` patch onto the page
  together with a ROM to play translations, randomizers, or fan hacks.
- **Customise the look** — unfiltered pixels by default, or pick a
  handheld LCD simulation, CRT scanlines, Bilinear / HQ2x / MMPX /
  Super-xBR smoothing, and more.
- **Customise the sound** — clean unprocessed output by default, or
  pick an audio mode: the original Game Boy speaker, warm headphones,
  a boombox, cassette tape, a small hall, and others. Per-channel
  mutes too.
- **Rebind almost anything** — every Game Boy button, gamepad mapping,
  and shell hotkey (pause, turbo, rewind, screenshot, record, reset) is
  customisable in Settings. The save-slot digits `0`–`9` stay fixed
  since the digit IS the slot number.
- **Touch-friendly** — on phones and tablets you get an on-screen D-pad
  and action buttons automatically. Landscape on touch offers three
  in-game layouts (side-gutter flank, dimmed overlay, tap-to-reveal) or
  a "force portrait" prompt for users who prefer the historical
  portrait-only feel — pick yours in Settings → Controls → Touch.
  Fullscreen keeps the overlay visible so you can actually play.
- **Rumble** — if your gamepad has a vibration motor, the emulator can
  rumble along with the game. The Game Boy MBC5 rumble carts
  (Pokémon Pinball, Perfect Dark, Shantae, …) and the GBA's Drill
  Dozer family drive it directly. There's also an optional audio-
  reactive mode that pulses the motor from the game's bass energy,
  so every ROM gets tactile feedback on drums and explosions. On
  Android phones the same signals drive the device's vibration motor
  via the Web Vibration API. iOS Safari ignores the API by browser
  policy; rumble there is silent.
- **Accessible** — works end-to-end with a keyboard: visible focus
  rings, Escape closes popovers, Tab is trapped while dialogs are open,
  a "Skip to game" link jumps focus past the header, and the emulator
  announces session-level events (paused, resumed, speed change,
  rewind) through a polite screen-reader live region. Respects
  `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **Link cable** — pair two tabs (or two devices anywhere in the world,
  via an optional relay) and play 2-player Tetris, trade Pokémon, or
  whatever else your cart supports. Game Boy Advance link-cable
  support is experimental — slower trade protocols (Pokémon Ruby /
  Sapphire / FireRed / Emerald) tend to work; faster cable-detect
  protocols (Mario Kart Super Circuit, Tetris Worlds VS) are
  intermittent.
- **Game Boy Camera** — load the Camera cart and your webcam becomes
  the in-game sensor. The viewfinder shows live video, you can take
  photos, save them to the cart's photo album, and play the built-in
  mini-games.
- **Game Boy Printer** — turn the link cable to "Printer" mode and
  any printer-aware ROM (Game Boy Camera prints, Pokémon Yellow's
  Pokédex, Mario's Picross, …) drops its output into a popover,
  ready to save as PNG.
- **Tilt and motion controls** — Kirby Tilt 'n' Tumble (Game Boy
  MBC7), Yoshi Topsy-Turvy and Koro Koro Puzzle (Game Boy Advance
  ADXL202E accelerometer carts), and WarioWare: Twisted! (Game Boy
  Advance ADXRS300 gyroscope) all work end-to-end. On phones the
  device's motion sensor maps directly to the cart's sensor; on
  desktop, **`I` / `K` / `J` / `L`** (rebindable in Settings →
  Controls) stand in for forward / back / left / right tilt, with
  **`J` / `L`** also covering counter-clockwise / clockwise
  rotation for the Wario gyroscope. iOS asks for motion permission
  the first time you tap the canvas.
- **Real-time clock** — both engines tick a real clock so games
  whose mechanics depend on wall time keep moving. Pokémon Gold /
  Silver / Crystal (Game Boy MBC3 RTC) plus Pokémon Ruby / Sapphire /
  Emerald / FireRed / LeafGreen and the Boktai trilogy (GBA Seiko
  S-3511A on the cart GPIO) all see real time, so day-night
  cycles, berry growth, the daily Lottery Corner, and Boktai's
  solar-time progression advance naturally — including while the
  emulator is paused or the tab is backgrounded. Setting the clock
  in-game (Boktai's setup screen) sticks: the chip state is
  battery-backed alongside the cart's save, so the set time keeps
  running across power-offs just like the real cartridge.
- **Per-game overrides** — pin a palette, CGB colour correction
  preference, or render mode for a specific cart via the cartridge-info
  popover — the next time you load that ROM it launches with exactly
  those settings.
- **All your game data stays local** — ROMs, saves, cheats, thumbnails,
  and settings live in your browser. See [Privacy](#privacy) for the
  few things that do leave the page (anonymous analytics, optional
  link-cable relay, optional online cheat-database lookup).
- **Built-in debugger** — registers, memory editor, tile / palette
  viewer, scrollable live disassembly with a breakpoint gutter, live
  audio scopes, breakpoints, watchpoints, a synthesized call stack,
  and optional `.sym`-file symbol resolution. More under
  [Debugger](#debugger).

## Getting started

### Step 1 — get a ROM

You'll need a `.gb` (original Game Boy), `.gbc` (Game Boy Color), or
`.gba` (Game Boy Advance) file. The emulator needs the game file to
play.

Where to get one legally:

- **Homebrew, public-domain, and indie games** —
  [itch.io's Game Boy tag](https://itch.io/games/tag-game-boy) is the
  simplest entry point: a deep catalogue of GB Studio creations,
  demoscene releases, and modern indie titles, with annual jams like
  GBJAM adding fresh entries. The
  [Homebrew Hub](https://hh.gbdev.io/) on gbdev.io is a curated
  download-ready archive of community releases.
- **Modern commercial releases** — a handful of small publishers
  (First Press Games, Incube8 Games, and others) sell brand-new Game
  Boy / Game Boy Color cartridges, often bundled with a digital ROM
  you can play in an emulator after purchase.
- **Romhacks and fan translations** —
  [romhacking.net](https://www.romhacking.net) hosts thousands of
  patches as `.ips` / `.bps` files. Glowboot applies them on the fly:
  drag the patch onto the page together with a ROM you legally own.
- **Your own cartridges** — dump them with a Game Boy cart reader.
  Common options:
  [GB Operator](https://www.epilogue.co/product/gb-operator)
  (polished, commercial),
  [GBxCart RW](https://www.insidegadgets.com/product/gbxcart-rw/)
  (cheaper, community favourite), or the
  [Open Source Cartridge Reader](https://github.com/sanni/cartreader)
  (DIY kit, supports many consoles).

### Step 2 — load the game

There are three ways to load a game:

1. **Click the "Load ROM" box** in the middle of the screen and pick a
   file.
2. **Drag a `.gb` / `.gbc` / `.gba` file** onto the page from your desktop.
3. **Double-click the file** in your OS file manager — works once
   you've installed the app (see [Install as an app](#install-as-an-app)).

That's it. The game starts immediately.

### Step 3 — play

On desktop, use the keyboard or a gamepad. On a phone or tablet, the
on-screen D-pad and face buttons appear automatically.

## Controls

### Game Boy buttons

| Game Boy | Keyboard | Gamepad                        |
| -------- | -------- | ------------------------------ |
| D-Pad    | ← ↑ ↓ →  | D-Pad or left analog stick     |
| A        | `Z`      | Bottom face button (A on Xbox) |
| B        | `X`      | Right face button (B on Xbox)  |
| Start    | `Enter`  | Start / Options                |
| Select   | `Shift`  | Back / Share                   |

### Emulator shortcuts

Press **`?`** any time to see a full list of every current keyboard
shortcut — pause / rewind / speed / screenshot / record / reset / save
slots, all with their live bindings. Anything non-positional can be
rebound via **Settings → Controls → Hotkeys**.

Rebinding tips:

- **Right-click a binding chip to clear it** (keyboard, hotkey, or
  gamepad) — the next press won't fire for that button until you
  re-capture it.
- **Holding Shift reverses** the speed cycle (e.g. `Shift+M` with the
  default binding), so you can step back down from 4× without walking
  all the way around through 0.5×.

## Tips & features

### Finding settings

The Settings popover has a **filter field at the top** — type any part
of a setting's name ("rumble", "palette", "volume", …) and the list
filters live, auto-expanding any collapsed sections that match.
Sections remember their open / closed state across reloads, so once
you've got the popover arranged the way you like it, it stays that
way. Each section header has a small **↺ reset** button that flips
every control inside it back to defaults — useful after a slider-tuning
session when you've forgotten where you started.

### Customise the look

Gear icon in the header → **Display**:

- **Rendering** — **Original** _(default — raw pixels, no
  post-processing)_ plus several GPU shaders (alphabetical): Bilinear,
  CRT, HQ2x, LCD, MMPX _(style-preserving 2× pixel-art magnification,
  McGuire & Mara 2020)_, and Super-xBR.
- **Integer scaling** — default OFF so the GBA's 240×160 frame
  fills more of the viewport; toggle ON to keep every pixel
  perfectly square (best for Game Boy and Game Boy Color, whose
  160×144 frame grids evenly on most displays).
- **CGB colour correction** — default ON; emulates the real CGB LCD's
  warm, muted response so Game Boy Color titles don't look neon on an
  sRGB monitor.
- **Pixel response** — slider that mimics the real LCD's slow response.
  Fixes flicker in games that used 30 Hz strobing for fake transparency
  (Pokémon, Link's Awakening rain).
- **Palette** — picks a 4-colour scheme for DMG games (CGB carts ship
  their own palette so this row dims out for them).
- **Colour grading** — brightness / contrast / gamma / saturation /
  temperature sliders for fine-tuning. Each slider shows its current
  value to the right so you can dial in precise numbers.

### Customise the sound

Gear icon in the header → **Audio**:

- **Volume** — master volume slider.
- **Audio mode** — picks a filter / EQ / reverb chain applied to the
  emulator's output:
  - **Original** _(default)_ — clean pass-through, no colouration.
  - **Boombox** — boosted lows and highs, V-shape EQ.
  - **Bright & crisp** — high-shelf lift for sparkle on muffled speakers.
  - **Cassette tape** — saturation + slight wow/flutter and tape hiss.
  - **Game Boy speaker** — band-pass + speaker resonance, the way the
    original handheld sounded through its tiny piezo.
  - **Hall reverb** — short room reverb for spatial depth.
  - **Warm headphones** — gentle low-end lift and rolled-off treble.

  Modes are loudness-calibrated against Original at boot so switching
  between them doesn't make the music suddenly louder or quieter.

- **Channels** — four toggles to mute the individual APU channels
  (Pulse 1, Pulse 2, Wave, Noise). Useful for hearing what each voice
  in a track is doing.
- **Per-cart audio mode** — Cart-info popover lets you pin a specific
  mode to a specific ROM (e.g. always play Pokémon with Warm headphones)
  so your global default isn't overridden globally.

### Backup your stuff

Gear icon → **Backup**:

- **Preferences** — small JSON file with your theme, bindings, colour
  settings. Drag it back to a fresh browser to restore.
- **Library & saves** — bigger JSON file with every ROM, save, save
  state, thumbnail, cheat, and printer page in your library. Lets you
  move everything to a new computer or back up before clearing browser
  data.

### Library

The clock icon in the header opens your **Library** — every game you've
played, with a thumbnail and how much time you've spent on each. Click
any card to jump back in. Up to 50 recent games are kept.

### Saving

There are two independent ways to save progress — you'll probably use
both:

- **In-game save.** Games that shipped with a battery-backed cartridge
  (Pokémon, Zelda, Kirby…) save the same way they did on real hardware
  — through the game's own save menu. The emulator writes that save to
  your browser every 2 seconds, so progress survives closing the tab
  without having to think about it.
- **Save states.** A snapshot of the exact moment you're at. Press
  `Shift+1` to save to slot 1; press `1` to reload it. Twelve slots per
  game; the digits 0–9 cover the first ten, the remaining two are
  reachable from the slot popover. Each slot shows a thumbnail so you
  can tell them apart, and you can add a short name ("Before the boss",
  "Glitch setup") via the ✎ icon.

You can export a single save-state to a file (⤓ icon) and re-import it
later or share it with someone playing the same game.

Two small safety nets: **saving on top of a labelled slot** asks for
confirmation first (so your "Before Ganon" save doesn't vanish under a
stray digit press), and **loading a slot after a long unsaved stretch**
warns before replacing the current run. Rapid slot-hopping stays
silent.

### Picking up where you left off

Close the tab anytime. Next time you open the same game, the emulator
silently restores the exact moment you stopped — a small "Resumed last
session" toast tells you it happened. This is separate from your ten
manual save slots, so it never overwrites a deliberate save.

### Rewind

Hold `Backspace` and the game runs backwards. The overlay shows how
far back you've scrubbed (e.g. "-5.2s") so you can let go at the right
moment. Release to resume from wherever you are. Perfect for retrying
a tricky boss pattern or recovering from a mistake. The buffer holds
the last 2 minutes of play.

### Speed and slow motion

Tap `M` to cycle: 0.5× (slow motion) → 1× (normal) → 2× → 4×. Press
`Shift+M` to walk the cycle backwards. The speed badge colour-codes
the state: mint for slow motion, amber for turbo — so you can tell at
a glance which side of normal you're on. Audio is muted at any speed
other than 1× (audio doesn't survive pitch-shift gracefully).

### Cheats

Click the wand icon in the header. You can:

- **Paste a code** — on Game Boy / Color: Game Genie
  (`004-BCE-E66`) or Game Shark (`010F27D0`). On Game Boy Advance:
  GameShark (`AAAAAAAA:VV`, e.g. `02000A5E:63`) or CodeBreaker
  (`AAAAAAAA+VVVV`, e.g. `83001D08+03E7`).
- **Search online by game title** — pulls cheat lists from a
  community-maintained database.
- **Import a `.cht` file** you downloaded.

Cheats start disabled after bulk import so nothing changes unexpectedly
mid-game — tick the box next to each one to turn it on. There's an
**Enable all / Disable all** toggle at the top of the list if you
imported a pack and want to flip them en masse. Hover a code badge to
see what each format actually does (ROM-read patch vs per-frame RAM
write).

### Romhacks and translations

Drop a `.ips` or `.bps` patch onto the page together with a ROM to
apply it. Patched games appear as separate entries in your Library
with an amber badge showing the patch name. Save files are isolated —
playing a hack won't touch your vanilla save.

### Link cable (2-player)

Two copies of the emulator can pair up and exchange serial bytes, so
games like 2-player Tetris or Pokémon trade work end-to-end.

**Same machine, two tabs/windows.** Open the emulator in two windows
side by side (both fully visible — browsers throttle unfocused tabs
to ~1 fps, which freezes the game). In Settings → Session → **Link
cable** = `2-Player` in both. Both windows auto-pair via
`BroadcastChannel` — you'll see a "Link cable connected" toast and
the inline status pill flips from grey "Waiting" to green
"Connected". Load the same ROM in both, pick 2P, go.

**Two devices, anywhere.** Cross-device pairing needs a relay
endpoint, baked into the build via `VITE_LINK_RELAY_URL` (see
`.env.example`); without one the link cable falls back to
BroadcastChannel for same-machine pairing only. The hosted
[glowboot.pages.dev](https://glowboot.pages.dev/) build ships with
`https://relay.glowboot.workers.dev` already configured, so
cross-device pairing works out of the box there — self-hosters set
their own URL (or reuse that one) at build time. On both devices:
Settings → Session → Link cable → set to `2-Player` and enter the
same short room code (anything 1-32 chars alphanumeric). First to
connect waits; second triggers the pairing. After matching, the
peers try to upgrade to a **WebRTC `RTCDataChannel`** so serial bytes
flow peer-to-peer over UDP — typical RTT ~5–50 ms, fine for Pokémon
trade and playable for Tetris. If NAT traversal fails (~8 s budget),
the link transparently keeps routing bytes through the relay
WebSocket instead — slower (~30–120 ms RTT depending on geography)
but the game keeps working.

The relay handles WebRTC signalling (matching peers by room code,
forwarding SDP offer/answer + ICE candidates) and acts as a fallback
byte forwarder when the peers can't establish a direct
DataChannel. It stores nothing, requires no accounts, and never
parses payloads — JSON envelopes are echoed verbatim between the
two paired sockets.

**GBA link cable — experimental.** The transport that makes Game
Boy Pokémon trade and 2-player Tetris solid doesn't scale to
GBA's faster cable protocols. Pokémon trade (Ruby / Sapphire /
FireRed / LeafGreen / Emerald) uses the same slow Normal-32 SIO
mode the GB carts use and works reasonably; Multi-Pak protocols
(Tetris Worlds VS, Mario Kart Super Circuit, Bomberman Tournament)
require ~360 µs per cable-side transfer round-trip, which
cross-tab `BroadcastChannel` IPC (~ms per message) can't match —
cable detection is intermittent. Two browser tabs on the same
machine pair via `BroadcastChannel`; fps stays at 60 in menus and
single-player but drops to ~30-45 during heavy cable-detect
bursts because the runtime spends real-time budget yielding so
peer messages can drain mid-frame.

Cross-device GBA link cable (with a room code) goes through
WebRTC like the GB cable, but cable-detect handshakes are even
more latency-sensitive over the internet. By default room codes
are ignored on the GBA path and the link falls back to
same-machine; protocol-tolerant uses (Pokémon trade over the
Normal-32 mode, slow-paced menu chat) can opt in by setting
`localStorage["gb-gba-link-cross-device-experimental"] = "1"` in
the dev tools and reloading. Mileage may vary; this is
intentionally hidden until a cached-state migration of the WebRTC
link lands.

### Game Boy Camera

The Camera cart (a.k.a. Pocket Camera, MBC type `0xFC`) plugs your
webcam in as the M64283FP image sensor. Load the ROM and the
emulator asks for camera permission; the live-view shows real video
through the cart's pipeline (exposure, gain, dither matrix), so the
in-game viewfinder behaves like the real hardware against a chunky
2-bit greyscale.

You can take photos, save them to the cart's 30-slot album, replay
the built-in mini-games, and print individual photos out via the
virtual printer (see below). Saved photos persist to the cart's
battery-backed RAM the same way real cartridge saves do.

The webcam stream stays local — frames are processed in-page and
never leave your device. Releasing the cart (loading another ROM,
closing the tab) shuts the stream down and the OS indicator light
goes out.

### Virtual Game Boy Printer

Settings → Session → **Link cable** = `Printer` plugs a virtual
printer into the serial port. A printer-tray icon appears in the
toolbar; any printer-aware ROM that triggers an in-game print drops
its page into the tray.

What works:

- **Game Boy Camera** — print individual photos from the album.
- **Pokémon (Yellow / Gold / Silver / Crystal)** — print the
  Pokédex screen.
- **Mario's Picross**, **Game Boy Gallery**, and other prints from
  any cart that drives the standard Game Boy Printer protocol.

Each printed page is saved to your browser's local storage as you
go, surviving reloads and ROM switches — the history is a single
queue across every game, the same way a real printer's tray would
be. Hover any thumbnail for **download** (PNG) and **delete**
buttons, or use **Clear all** at the bottom of the popover to wipe
the queue. Both destructive actions confirm first.

### Tilt and motion controls (sensor carts)

A handful of carts shipped with a motion sensor soldered into the
cartridge itself — the player tilts or twists the whole console to
play. Glowboot emulates the sensor end-to-end on:

- **Kirby Tilt 'n' Tumble** (Game Boy, Nintendo's MBC7 mapper —
  two-axis accelerometer).
- **Yoshi Topsy-Turvy** and **Koro Koro Puzzle: Happy Panechu!**
  (Game Boy Advance, Analog Devices ADXL202E — two-axis
  accelerometer).
- **WarioWare: Twisted!** (Game Boy Advance, Analog Devices
  ADXRS300 — single-axis gyroscope measuring rotation rate around
  the screen-normal axis; the player twists the console rather
  than tilting it).

How tilt input reaches the cart:

- **On phones and tablets**, tilt the device. The OS motion sensor
  maps onto the cart's two-axis accelerometer in real time, so the
  ball rolls the way you tip the device. iOS gates motion access
  behind a permission prompt — the emulator triggers it the first
  time you tap the canvas after loading the ROM.
- **On desktop**, **`I` / `K` / `J` / `L`** stand in for tilt
  forward / back / left / right. Hold a key for sustained tilt;
  release to let the simulated ball settle back to centre. For
  WarioWare: Twisted! the same **`J` / `L`** keys double as
  counter-clockwise / clockwise rotation (the cart only cares about
  the Z-axis rate, so the X-axis keys `I` / `K` do nothing there).
  The four keys appear in the keyboard cheat sheet (`?`) and are
  rebindable via Settings → Controls → Keyboard alongside the
  D-pad and face buttons.

**Yoshi Topsy-Turvy calibration** — the cart starts with a
multi-screen tilt calibration that samples each axis when you
press A. Keyboard players need to **hold the matching tilt key
while pressing A** on each calibration screen; otherwise the cart
saves a zeroed neutral point and tilting in-game does nothing. The
in-game pause menu has a "Calibrate Tilt Sensor" entry if you want
to redo it later.

Save data is battery-backed via each cart's onboard EEPROM (Kirby
Tilt 'n' Tumble), Flash (Yoshi Topsy-Turvy / Koro Koro Puzzle), or
SRAM (WarioWare: Twisted!), so your progress persists between
sessions just like the original hardware.

### Debugger

Click the bug icon in the header to open the debugger.
On narrow viewports the bug icon folds into the **More (⋮) menu**
along with the other secondary actions, so the action row stays one
line on phones. Opening the debugger auto-pauses the emulator so
live state isn't a blur — press Space or the ▶ button to resume.

Nine panes, switchable via the tab strip across the top (arrow keys
work inside it). Both engines have the full set; the contents
naturally differ between Game Boy (Sharp LR35902) and Game Boy
Advance (ARM7TDMI):

- **CPU** — Game Boy: every register, flag, control signal (IME,
  HALT, STOP, double-speed, HALT-bug) plus IE / IF. Game Boy
  Advance: the ARM7TDMI register file (r0–r15 in the current mode's
  bank, CPSR with N/Z/C/V + I/F/T + mode, SPSR), plus HALT, IME, IE,
  IF, and the IntrWait mask that gates IntrWait halt-release.
  Live-updated while running.
- **Disasm** — live disassembly with the current instruction
  highlighted. On Game Boy Advance the decoder tracks CPSR.T to
  decode ARM (4-byte) or Thumb (2-byte) instructions and re-seeds
  the window when the mode switches. Seeds with ~165 instructions
  around PC and lazy-extends at both edges as you scroll, so you
  can walk far before or after the current address without losing
  your place. The address gutter is clickable: left-click to toggle
  an execute breakpoint, right-click anywhere on the row does the
  same. Operands show symbol names instead of hex when a symbol
  file is loaded.
- **Memory** — hex + ASCII viewer with a virtual scroller, click to
  edit any byte inline, 100-entry undo in the toolbar. Game Boy:
  flat 64 KiB address space with a region legend (ROM / VRAM /
  WRAM / OAM / IO / HRAM) that doubles as a quick-jump row. Game
  Boy Advance: the sparse 4 GiB address space is split into
  segments (BIOS / EWRAM / IWRAM / I/O / Palette / VRAM / OAM /
  ROM / SRAM) picked from a toolbar — jump-to-address parses an
  8-hex value and switches segments automatically. Writes route
  through the bus so MMIO / palette / OAM side-effects fire
  normally.
- **Palettes** — Game Boy: DMG BGP / OBP0 / OBP1 and all 8 CGB
  background + 8 CGB object palettes. Game Boy Advance: the two
  256-entry palette banks (BG at `0x05000000`, OBJ at `0x05000200`)
  laid out 16 × 16 so `(palette, index)` reads off naturally for
  4bpp BGs and sprites. Hover any cell for its absolute index, raw
  BGR/RGB555, and unpacked RGB.
- **Tiles** — Game Boy: the two VRAM tile banks rendered to a grid
  (384 tiles each), the BG map at 256 × 256, and the full OAM
  sprite table. Game Boy Advance: all 96 KiB of VRAM as a flat tile
  grid with a 4bpp / 8bpp toggle and a palette-bank picker; in
  bitmap modes the framebuffer shows up directly as a scrolling
  tile dump. (Per-BG map and per-OBJ sprite viewers don't have GBA
  equivalents yet — GBA's four affine + four text BGs across
  multiple modes plus OAM attribute fields make those non-trivial.)
- **Audio** — per-channel oscilloscope traces plus envelope meters,
  so you can see exactly which channel is playing what. Game Boy
  has four rows (CH1 / CH2 squares, CH3 wave, CH4 noise); Game Boy
  Advance has the same four PSG rows plus two for the Direct Sound
  FIFOs (DSA / DSB), which drive the music in most GBA carts.
- **Breakpoints** — list of active PC breakpoints + read / write
  watchpoints. The add-form accepts a hex address (`$0150`, `0150`
  on Game Boy; `$08000000`, `08000000` on Game Boy Advance) or a
  symbol name from the currently loaded symbol file. "At PC" drops
  one at the current program counter. See
  [Breakpoints and watchpoints](#breakpoints-and-watchpoints) below.
- **Call stack** — top of the list is the innermost frame; symbols
  replace hex where known. Game Boy: inferred from CALL / RST / IRQ
  pushes and RET pops; frame kinds (`CALL` / `RST` / `IRQ`) are
  colour-coded. Game Boy Advance: inferred from BL / Thumb-BL
  pushes plus BX / LDM-with-PC / POP-with-PC returns plus IRQ
  entry; frame kinds are `CALL` and `IRQ` (no `RST` analogue on
  ARM7TDMI).
- **Symbols** — loader for plain-text symbol files. Game Boy reads
  RGBDS-style `.sym` (`bank:addr name`); Game Boy Advance uses flat
  32-bit addresses (`[0x|$]AAAAAAAA[:] NAME` per line, blank lines
  and `;` / `#` comments skipped, so `nm` output or a build-log
  excerpt pastes straight in). Pick a file, the count + source
  label appear, and every other pane starts resolving addresses to
  names. The parsed text is cached in `localStorage` keyed by cart
  identity, so the same ROM auto-restores its symbols next session.

A control bar along the bottom has **Play / Pause**, **Step** (one
CPU instruction), **Frame** (one full VBlank), and **Rewind** (one
snapshot ≈ 1 s). These three step buttons live only inside the
debugger — they're inspection tools that only make sense when you can
see the panes update.

#### Breakpoints and watchpoints

Three flavours, all set from the Breakpoints pane:

- **Execute (PC) breakpoint** — pauses right before the instruction
  at the given address runs. Set it on the Disasm pane by
  left-clicking the gutter dot on any row, or right-clicking the row
  itself. A second press at the same address removes it; the row
  tints red while active. Stepping off a hit breakpoint passes
  through once so you don't loop on it.
- **Read watchpoint** — pauses the moment any instruction reads from
  the address. Useful for catching vblank-wait loops (watch `$FF44`
  on Game Boy, `$04000006` on Game Boy Advance) or finding which
  routine polls a game variable.
- **Write watchpoint** — pauses on any write. The classic
  "what's changing this variable?" tool — watch the RAM slot, play
  the game, the emulator pauses the exact instant something touches
  it.

A toast announces each hit with kind + address; the Call stack pane
shows the routine chain that led there. All three pass through the
bus's normal read / write path, so DMA, HDMA, MBC-register, and
GBA MMIO writes trigger watchpoints too.

#### Symbol files

Symbol-file format depends on the engine, since Game Boy addresses
are bank-prefixed and Game Boy Advance addresses are flat 32-bit.

**Game Boy** — a `.sym` file maps `bank:addr` pairs to names,
produced by RGBDS, no$gmb, and most Game Boy disassemblers:

```
00:0150 EntryPoint
00:017d InitDisplay
01:4a8c LoadTilemap
```

**Game Boy Advance** — flat 32-bit addresses, more permissive
syntax so `nm` output or a linker map excerpt drops in cleanly:

```
08000000  EntryPoint
0x080003a8: GameLoop
$03007FFC  IRQHandler
```

With a file loaded, `CALL $4A8C` (or `BL $080003A8`) shows up as
`CALL LoadTilemap` (`BL GameLoop`) in the Disasm pane, call-stack
frames gain names, and the Breakpoints add-form accepts
identifiers as input. For popular commercial games, complete `.sym`
files live in community disassembly projects (e.g. the `pret/`
collective for Pokémon; `kaspermeerts/supermarioland` for Super
Mario Land).

### Install as an app

On desktop Chrome / Edge, or Android Chrome, the browser shows an
**Install** option in the address bar. Once installed:

- The emulator runs in its own window, no browser toolbars.
- It works fully offline.
- `.gb`, `.gbc`, and `.gba` files can be **double-clicked from the OS**
  to open in the emulator.
- Your game data — ROMs, saves, cheats, thumbnails — stays in your
  browser's local storage. See [Privacy](#privacy) for the small set of
  network requests the page makes.

## For developers

Technical details — architecture, build commands, and known accuracy
limitations. Skip this if you just want to play games.

### Build

Requirements: Node.js 20+.

```sh
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173`.

| Command                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | Start the Vite dev server with HMR                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run build`         | Produce a production build in `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run preview`       | Serve the production build locally                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm run typecheck`     | Typecheck both the UI and the DOM-free engine bundle, no emit                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm test`              | Run the Vitest unit suite once                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run test:watch`    | Run Vitest in watch mode                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run test:roms`     | Run the external test-ROM harness (auto-fetches the c-sp release on first run)                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run test:gba-roms` | Run the GBA accuracy gate (40 self-scoring tests across jsmolka + fuzzarm + mgba-suite + nba-emu/hw-test; grades each test on the pass/total counts and pass codes the ROM reports about itself, diffed against a committed baseline; auto-fetches ROMs on first run; `-- --bless` re-records the baseline). Runs the HLE-BIOS path the browser ships; `-- --bios` runs a real Nintendo BIOS as an informational comparison against the same baseline (never gates) |
| `npm run lint`          | ESLint across the repo (file globs come from `eslint.config`)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run lint:fix`      | ESLint with `--fix` to auto-resolve safe issues                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npm run format`        | Prettier write across the repo                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run format:check`  | Prettier check (no writes) — used by CI                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Continuous integration

`.github/workflows/ci.yml` runs on every push and PR to `main` or
`develop`: typecheck → format check → lint → unit tests → production
build. All five gates must pass before a merge.

### Link-cable relay

Cross-device link-cable pairing needs a separately-hosted WebSocket
relay. The emulator reads its URL from `VITE_LINK_RELAY_URL` at build
time (set it in `.env.local` for local testing or in Cloudflare Pages
→ Settings → Environment variables for production); leave it unset
and link-cable mode falls back to same-machine BroadcastChannel
pairing. The protocol contract — used both for WebRTC signalling and
as the relay-mode fallback when peers can't establish a direct
DataChannel — lives in `src/ui/session/webrtc-link.ts` (Game Boy
byte-at-a-time transfers) and `src/ui/session/webrtc-link-gba.ts`
(Game Boy Advance multiplayer halfwords). Room codes are namespaced
with a `gba-` prefix on the GBA side so a Game Boy peer entering the
same code never silently cross-pairs with a Game Boy Advance peer.

The same relay endpoint serves both engines, but the **Game Boy
Advance cross-device path is opt-in**: by default the GBA link
falls back to same-machine BroadcastChannel even when
`VITE_LINK_RELAY_URL` is set, because cable-detect handshakes are
too latency-sensitive for typical internet RTT to drive reliably.
Users who want to try slow protocols (Pokémon trade over the
GBA Normal-32 mode) flip
`localStorage["gb-gba-link-cross-device-experimental"] = "1"` and
reload.

### Game Boy core

- **CPU** — Full Sharp LR35902 instruction set (256 primary opcodes +
  256 CB-prefix bit-operation opcodes), interrupt servicing,
  `HALT`/`STOP`, M-cycle-accurate timing.
- **PPU** — Background, window, sprites (8×8 / 8×16), pixel-FIFO
  renderer (BG fetcher + per-pixel sprite mixing), four-mode timing
  (OAM / Drawing / HBlank / VBlank), DMG sprite-priority rules,
  10-sprite-per-line limit, STAT IRQ blocking.
- **APU** — All four channels (two square with duty, wave, noise LFSR),
  volume envelopes, CH1 frequency sweep, length counters, DIV-driven
  512 Hz frame sequencer (clocked off DIV bit 12 in single-speed / bit
  13 in CGB double-speed, so a write to FF04 that drops the bit fires
  an extra step — matching real hardware), NR50 master volume, NR51
  stereo panning. DC-blocked output through a Web Audio `GainNode` for
  master volume.
- **Memory / MBC** — Work RAM, VRAM, OAM, HRAM, I/O, echo RAM. Mappers:
  ROM_ONLY, MBC1, MBC2, MBC3 (with RTC), MBC5, MBC7 (accelerometer +
  EEPROM, for Kirby Tilt 'n' Tumble), and Pocket Camera (`0xFC`). OAM
  DMA runs over 160 M-cycles with the CPU bus restricted to HRAM. Save
  RAM persisted to IndexedDB (autosaved every 2 s + on tab hide / close).
- **Serial / link** — SC=0x81 master transfers complete after one
  byte time (4096 T-cycles in normal speed, 128 T-cycles in CGB
  high-speed mode), matching real-hardware shift timing so
  interrupt-driven protocols (Game Boy Printer, Camera-print) don't
  race their own ISR.
- **Pocket Camera (MBC 0xFC)** — sensor-register window with
  capture-trigger handshake, M64282FP exposure + 4×4 ordered dither
  pipeline, captured 128×112 frames packed as 2 bpp tile data into
  cart RAM bank 0 at offset 0x100.
- **Game Boy Printer** — virtual printer plugged into the link
  cable. Full per-byte state machine (magic / cmd / compression /
  length / data / checksum / keepalive / status), RLE decompression
  for compressed DATA bands, status flags driven through the
  canonical READY → PRINTING → DONE transitions strict ROMs (Game
  Boy Camera) require.
- **MBC3 RTC** — Real-time clock ticks against emulated time with full
  latch semantics. Advances by wall-clock time while the emulator is
  paused or the tab is backgrounded, so Pokémon G/S/C day-night cycle
  and berry timers keep moving.
- **CGB** — Automatic detection via cart header, banked VRAM / WRAM,
  BG-map attribute tables, palette RAM, OPRI selection, KEY1
  double-speed mode, general-purpose + H-Blank HDMA.
- **Timer** — DIV, TIMA, TMA, TAC with all four input-clock rates.

### GBA core

- **CPU** — ARM7TDMI with full ARM and Thumb decoders, all instruction
  classes (data-processing, branches, multiplies incl. long-multiply
  carry-flag quirks, single + multi-word loads/stores, SWI), the seven
  CPU modes with banked R8–R14 + SPSR (USR/FIQ/IRQ/SVC/ABT/UND/SYS),
  pipeline-aware open-bus reads, and the misaligned-LDR / LDRH /
  LDRSH quirks real silicon exhibits. Passes jsmolka's full ARM /
  Thumb / memory / unsafe test suites and fuzzarm.
- **PPU** — All six BG modes (tile 0/1/2, bitmap 3/4/5) with the four
  BG layers, OBJ engine (128 sprites, 8 size/shape combos, normal +
  affine including double-size), three windows (WIN0 / WIN1 / OBJWIN),
  alpha blending (BLDCNT modes 0–3) with semi-transparent OBJ alpha
  preservation, OBJ + BG mosaic, the BG2/BG3 affine reference-point
  per-line accumulators that make mode-7 racers work, and 2-line
  DISPCNT BG-enable latching. Tile + bitmap renderers share a unified
  compositor that handles priority sorting, OBJ-over-BG semantics,
  and the OBJ-window mask pass.
- **APU** — Full PSG (the GB's four channels, exposed through the GBA
  register file at 0x60–0x8F) plus the two Direct Sound FIFOs at
  0xA0 / 0xA4. FIFOs are pumped by timer-overflow IRQs and refilled
  via DMA when they drop below the half-full watermark — the same
  trigger real silicon uses, so cart-driven sample playback (the
  way every commercial GBA game plays sampled audio) lands cleanly.
  Mixer combines PSG + Direct Sound under SOUNDCNT_H volume controls.
- **DMA** — All four channels (DMA0 internal + DMA1/2 sound + DMA3
  general), every start-timing mode (Immediate, VBlank, HBlank,
  Special — including DMA1/2's Sound-FIFO and DMA3's video-capture
  timing), 16/32-bit transfers, address-control modes including
  Increment-with-reload for repeating sound buffers, and the
  channel-priority + bus-latch quirks that mgba-suite-dma exercises
  (DMA0's "SRAM-not-on-bus" handling, cart-bus open-bus on aborted
  transfers).
- **Timers** — All four 16-bit countup timers with the four prescaler
  divisors (1, 64, 256, 1024 CPU cycles per tick), cascade-from-
  previous-timer mode, IRQ-on-overflow, and the deferred-write quirks
  that test ROMs probe (control writes don't apply immediately when
  the channel is mid-tick; reload latches at overflow).
- **BIOS** — Full High-Level Emulation of the SWI vector. Math
  (Div / DivArm / Sqrt / ArcTan / ArcTan2), memory (CpuSet /
  CpuFastSet / RegisterRamReset), affine (BgAffineSet /
  ObjAffineSet), halt / IntrWait / VBlankIntrWait with the polling-
  loop semantics real BIOS exhibits (re-OR'd IE on each iteration),
  and the four decompression SWIs (LZ77UnCompWRam / LZ77UnCompVRam /
  RLUnCompWRam / RLUnCompVRam / HuffUnComp / Diff8/16bitUnFilter /
  BitUnPack). No BIOS image required for normal play.
- **Cart backup** — Auto-detected from the ROM image: SRAM (32 KiB),
  Flash 64 KiB (Atmel + SST + Panasonic chip IDs), Flash 128 KiB
  (Macronix + SST + Sanyo chip IDs with erase + bank switching), and
  EEPROM with size autodetect (512 B vs 8 KiB resolved from the cart's
  first DMA3 transfer). All four types persist to IndexedDB on the
  same 2-second + tab-hide cadence as the GB side.
- **Cart GPIO** — Plug-in feature port for the 4-pin GPIO bank at
  0x080000C4 / C6 / C8. Drives Drill Dozer's rumble actuator
  (V49E/J/P/K — bit 3 → `navigator.vibrate` / gamepad rumble) and
  the Seiko S-3511A real-time clock used by Pokémon Ruby / Sapphire /
  Emerald / FireRed / LeafGreen and the Boktai trilogy (Status /
  DateTime / Time commands; clock reads from system time, so berry
  growth, day/night cycles, and the daily Lottery Corner tick
  naturally across save/load).

### Project structure

The tree is split along one hard boundary: `src/gb/` and `src/gba/`
(the two engine cores) are pure hardware simulation with **no DOM,
no fetch, no localStorage** — they can be imported from Node for
headless test runners. All browser-side code lives under `src/ui/`.

```
src/
├── main.ts                   # Thin orchestrator — imports UI modules in order
├── gb/                       # Pure engine, headless-runnable (no browser deps)
│   ├── gameboy.ts            #   Top-level emulator, owns subsystems
│   ├── index.ts              #   Public engine API (UI imports go through here)
│   ├── serialization/
│   │   └── serialization.ts  #     StateReader / StateWriter binary save-state helpers
│   ├── joypad/
│   │   └── joypad.ts         #     P1 register + pressed-button state
│   ├── cpu/
│   │   ├── cpu.ts            #     LR35902 decoder, ALU, HALT/STOP, IRQ dispatch
│   │   └── registers.ts      #     A/B/C/D/E/H/L/F + SP/PC with 16-bit pair accessors
│   ├── memory/
│   │   ├── mmu.ts            #     Address decoder / bus, cycle-accurate OAM DMA, HDMA
│   │   ├── interrupts.ts     #     IF / IE registers and request / servicing helpers
│   │   └── serial-link.ts    #     SerialLink interface — no-op default; UI provides BroadcastChannel / WebRTC impls
│   ├── cartridge/
│   │   └── cartridge.ts      #     Header parse + MBC1/2/3/5/7 bank switching, MBC3 RTC, MBC7 accelerometer, Pocket Camera (0xFC)
│   ├── ppu/
│   │   └── ppu.ts            #     Pixel-FIFO renderer (BG fetcher, per-pixel sprite mix), STAT/LYC, mode timing, STAT line
│   ├── apu/
│   │   ├── apu.ts            #     Frame sequencer, mixer, DC filter, channel mutes
│   │   └── channels.ts       #     CH1/CH2 square, CH3 wave, CH4 noise LFSR
│   ├── timer/
│   │   └── timer.ts          #     DIV / TIMA / TMA / TAC
│   ├── printer/
│   │   └── printer.ts        #     Game Boy Printer state machine + RLE decompressor
│   ├── cheats/
│   │   ├── codec.ts          #     Game Genie / Game Shark code decoder (pure)
│   │   └── manager.ts        #     Runtime cheat engine (ROM patches + RAM writes)
│   └── debug/                #   Debugger back-end (hooks into CPU + MMU)
│       ├── breakpoints.ts    #     PC / read / write breakpoint registry + check hooks
│       ├── call-stack.ts     #     Synthesized CALL / RST / IRQ frame tracker
│       ├── disassembler.ts   #     Pure LR35902 decoder (256 primary + 256 CB opcodes)
│       └── symbols.ts        #     RGBDS .sym parser + by-addr / by-name lookup
├── gba/                      # Pure GBA engine, headless-runnable. ARM7TDMI (full ARM + Thumb decoders) + LCD-controller PPU (4 BGs + sprites + window + blend + mosaic + mode-7 affine) + APU (4 PSG channels + 2 Direct Sound FIFOs DMA-driven) + 4 timers + 4 DMA channels + interrupt controller + joypad + SIO register file + BIOS HLE (full SWI dispatcher incl. LZ77/RLE/Huffman/Diff/BitUnPack) + cart backup (SRAM/Flash 64/128 KiB/EEPROM 512 B/8 KiB) persisted to IDB + cart GPIO (rumble for Drill Dozer + WarioWare Twisted, RTC for Pokémon Gen 3 + Boktai, gyroscope for WarioWare Twisted, solar sensor for Boktai) + cart accelerometer (ADXL202E for Yoshi Topsy-Turvy + Koro Koro Puzzle)
│   ├── index.ts              #   Public engine API (header parser, cheat codec/manager, GBA core)
│   ├── globals.d.ts          #   No-DOM type shim for the headless engine build
│   ├── cartridge/
│   │   ├── header.ts         #     GBA ROM header parser + 0x96 magic-byte check
│   │   ├── backup.ts         #     Backup-marker detection (EEPROM/SRAM/Flash) + SRAM (32 KB) + Flash (64/128 KB w/ chip ID, erase, bank switch) IoHandlers at 0x0E000000 + EEPROM (512 B / 8 KB autodetect, DMA3 bit-serial) at 0x0D000000
│   │   ├── gpio.ts           #     Cart GPIO controller (data/direction/read-enable at 0x080000C4-C8) — plug-in features for peripherals on the shared 4-pin port
│   │   ├── rumble.ts         #     GpioRumble feature (Drill Dozer V49* + WarioWare Twisted RZW* — data-bit 3 → onRumbleChange callback)
│   │   ├── rtc.ts            #     Seiko S-3511A real-time-clock chip emulation as a GpioFeature (Status / DateTime / Time commands; BCD encoding; system Date.now() as time source)
│   │   ├── rtc-detect.ts     #     RTC cart-detection table — Pokémon Gen 3 (Ruby/Sapphire/Emerald/FireRed/LeafGreen) + Boktai trilogy
│   │   ├── accelerometer.ts  #     ADXL202E accelerometer (Yoshi Topsy-Turvy KYG* + Koro Koro Puzzle KHPJ) — memory-mapped register window at 0x0E008000-0x0E008500, 12-bit X/Y sample
│   │   ├── gyroscope.ts      #     ADXRS300 Z-axis gyroscope (WarioWare: Twisted RZW*) — bit-serial protocol over GPIO bits 0/1/2 (sample/clock/data); 12-bit angular velocity reading shifted out MSB-first
│   │   └── solar.ts          #     Konami photodiode + 8-bit digital-ramp ADC solar sensor (Boktai trilogy U3I*/U32*/U33*) — counter ramped via GPIO bit 0, reset + re-sample via bit 1, comparator output on bit 3
│   ├── cheats/
│   │   ├── codec.ts          #     Raw GBA cheat-code decoder (AAAAAAAA:VV 8/16/32-bit)
│   │   └── manager.ts        #     Runtime cheat engine — per-frame RAM writes via bus
│   ├── cpu/                  #   ARM7TDMI: full ARM + Thumb decoders + banked regs + condition codes
│   │   ├── cpu.ts            #     Top-level CPU with stepArm/stepThumb dispatch on CPSR.T (+ Halt/IntrWait gate)
│   │   ├── arm.ts            #     ARM-state decoder + executors (all instruction classes)
│   │   ├── thumb.ts          #     Thumb-state decoder + executors (all 19 instruction formats)
│   │   ├── alu.ts            #     Shared ALU helper (16 data-processing ops + carry/overflow)
│   │   ├── bios-hle.ts       #     SWI dispatcher: math + memory + affine + halt/IntrWait + LZ77/RLE/Huffman/Diff decompression + BitUnPack
│   │   ├── shifter.ts        #     Barrel shifter (LSL/LSR/ASR/ROR/RRX with imm/reg quirks)
│   │   ├── conditions.ts     #     16 ARM condition codes (EQ/NE/.../AL/NV)
│   │   └── registers.ts      #     ArmRegisters with FIQ/IRQ/SVC/ABT/UND mode banking + CPSR/SPSR
│   ├── memory/               #   Memory bus: byte regions (RAM/ROM) + handler regions (MMIO)
│   │   ├── bus.ts            #     MemoryBus interface + FlatBus (single-region; used by unit tests)
│   │   ├── mapped-bus.ts     #     MappedBus + GBA memory-map factory (BIOS/EWRAM/IWRAM/IO/VRAM/…)
│   │   ├── interrupts.ts     #     IE/IF/IME register file + raise() helper (CPU polls before each step)
│   │   └── dma.ts            #     4 DMA channels w/ immediate / VBlank / HBlank / Sound-FIFO triggers
│   ├── apu/                  #   APU: 4 PSG channels + Direct Sound A/B + stereo mixer (UI-fed AudioContext)
│   │   ├── apu.ts            #     Register file + frame sequencer + mixer + Direct Sound FIFOs (timer-drained pop)
│   │   └── channels.ts       #     PSG channel implementations — squares (1+2 w/ sweep) + wave (3) + noise/LFSR (4)
│   ├── joypad/               #   Joypad: KEYINPUT (0x130) read-only + KEYCNT (0x132) R/W
│   │   └── joypad.ts         #     10-button active-low key state (A/B/SELECT/START/D-pad/L/R)
│   ├── sio/                  #   Serial I/O — mode-aware register file (0x120..0x15F)
│   │   └── sio.ts            #     RCNT/SIOCNT mode dispatch (Normal-8/Normal-32/Multiplayer/UART/General-purpose/JOY-bus); no link cable yet
│   ├── timer/                #   4 hardware timers (0x100..0x10F) with prescaler + cascade + IRQ
│   │   └── timer.ts          #     Drives Direct Sound FIFO pop via Apu.onTimerOverflow
│   ├── ppu/                  #   PPU: LCD controller (bitmap modes 3 + 4 + tile modes 0/1/2 + sprites)
│   │   ├── ppu.ts            #     DISPCNT/DISPSTAT/VCOUNT/BG*CNT/BG*OFS/affine-matrix/WIN*/BLD*/MOSAIC I/O + dot-scanline state machine + front-to-back compositor with window-masking + alpha/brighten/darken blend + semi-transparent-OBJ forced-alpha + BG mosaic post-process + modes 0-5 (incl. 160×128 mode 5 bitmap)
│   │   ├── bg.ts             #     Text + affine BG renderers (4bpp/8bpp text; 8bpp affine; per-tile flip + palette bank; matrix sampling + wraparound)
│   │   ├── obj.ts            #     Sprite renderer — normal + affine sprites (OAM parsing; shape × size; 4bpp + 8bpp; 1D + 2D mapping; double-size affine box; OBJ-window cover for attr-0 mode 2; semi-trans marker for mode 1; source-space mosaic snap when attr-0 bit 12)
│   │   └── window.ts         #     Per-pixel WIN0/WIN1/OBJWIN/WINOUT enable mask (priority WIN0 > WIN1 > OBJWIN > outside; GBATEK rectangle clamping)
│   └── serialization/        #   Save-state lineage scaffold (independent from GB)
│       └── serialization.ts  #     GBA_STATE_VERSION + GbaStateReader/Writer + upgradeGbaState migrator chain
└── ui/                       # Browser shell — DOM, network, storage
    ├── state.ts              #   Shared mutable app state + renderer/audio/gamepad singletons
    ├── dom.ts                #   Centralised getElementById wall
    ├── format.ts             #   relativeTime / formatPlayTime / formatTime / slot helpers
    ├── draggable.ts          #   makeDraggablePanel — drag a fixed panel by a handle, position remembered (translate + assist overlays)
    ├── rom-loader.ts         #   Load ROM button, drag-drop, PWA launchQueue → startEmulator
    ├── save-blob.ts          #   Web Share API helper for mobile screenshot/recording exports
    ├── audio/                #   Web Audio output graph + post-processor presets
    │   └── output.ts         #     AudioContext scheduler, master gain, post-processor chain
    ├── hud/                  #   Passive on-screen readouts (no engine deps)
    │   ├── status.ts         #     NOW-PLAYING strip (frame / FPS / elapsed)
    │   ├── toast.ts          #     Transient status-message helper (info + error channels, queued)
    │   ├── shortcut-hint.ts  #     `?` cheat-sheet overlay with live bindings
    │   ├── modal.ts          #     Themed promptText / confirmAction replacing native dialogs
    │   └── announce.ts       #     SR-only polite live region for session events
    ├── debugger/             #   Debugger popover panes (one file each)
    │   ├── pane.ts           #     Pane interface contract (mount / refresh / id / label)
    │   ├── format.ts         #     hex2 / hex4 / regionOf helpers shared by panes
    │   ├── cpu-pane.ts       #     Live register / flag / IME / interrupt display
    │   ├── disasm-pane.ts    #     Scrollable disassembly with BP gutter + symbol resolve
    │   ├── memory-pane.ts    #     Virtual-scroll hex viewer + inline editor + undo
    │   ├── palette-pane.ts   #     DMG + CGB BG/OBJ palette display with RGB555 tooltip
    │   ├── tile-pane.ts      #     VRAM tile banks, BG map preview, OAM table
    │   ├── audio-pane.ts     #     Per-channel oscilloscope + envelope meters
    │   ├── breakpoints-pane.ts #   Add / list / remove BPs + WPs, symbol-name input
    │   ├── callstack-pane.ts #     Frame list top-down, kind-coloured, symbol-resolved
    │   └── symbols-pane.ts   #     .sym file picker + cache + search + list
    ├── popovers/             #   One file per popover + shared trigger mutex
    │   ├── index.ts          #     Barrel re-exports + focus trap + Esc + click mutex
    │   ├── helper.ts         #     createPopover factory (open/close/render/onOpen spec)
    │   ├── library.ts        #     Recents / library grid
    │   ├── slots.ts          #     Save-slot grid + doSaveState / doLoadState
    │   ├── cheats.ts         #     Cheat list + add form + .cht import + online search
    │   ├── cart-info.ts      #     ROM header metadata + GBA save-data export/import/clear + per-game override editors
    │   ├── debugger.ts       #     Debugger popover orchestrator (tab strip + control bar)
    │   ├── printer.ts        #     Printer tray popover — printed pages with PNG export
    │   ├── more.ts           #     Narrow-viewport overflow menu — mirror-clicks the secondary triggers
    │   └── settings.ts       #     Settings popover open/close (content lives below)
    ├── settings/             #   Settings-popover content
    │   ├── index.ts          #     Barrel + side-effect import for collapse
    │   ├── panels.ts         #     Display / audio / touch / rumble / session / backup wiring, per-section resets, search, saved-pip, slider labels
    │   ├── bindings.ts       #     Controls editor (keyboard / gamepad / hotkeys)
    │   └── collapse.ts       #     Click-to-collapse section headers with persisted state
    ├── session/              #   Runtime / lifecycle glue (session-scoped behaviour)
    │   ├── actions.ts        #     Pause / turbo / screenshot / recording / fullscreen
    │   ├── link-status.ts    #     CustomEvent channel from link impls → Settings status pill
    │   ├── link-cable.ts     #     Same-machine GB BroadcastChannel link
    │   ├── webrtc-link.ts    #     Cross-device GB WebRTC link (signalling via Cloudflare Worker relay, then peer-to-peer)
    │   ├── link-cable-gba.ts #     Same-machine GBA Multi-Pak BroadcastChannel link (cached-state + per-slot queue)
    │   ├── webrtc-link-gba.ts #    Cross-device GBA Multi-Pak link (experimental; opt-in via localStorage)
    │   ├── runtime-gba.ts    #     GBA-side rAF loop + chunked sub-frame interleave for the BC link path
    │   ├── pacing-gba.ts     #     Pure helper: catch-up frame count math for the GBA pacer
    │   ├── printer-link.ts   #     SerialLink that wires the engine printer's bytes back into the MMU
    │   ├── cart-overrides.ts #     Per-cart palette / colour-correction / render-mode pinning
    │   ├── rewind.ts         #     Backspace-held rewind scrubber (UI)
    │   ├── rewind-buffer.ts  #     Rolling save-state ring buffer
    │   ├── autosave.ts       #     Save-RAM interval + visibility + beforeunload hooks
    │   ├── auto-pause.ts     #     Blur / focus listeners, pause on focus loss
    │   ├── pacing.ts         #     requestAnimationFrame-driven frame pacer
    │   ├── play-time.ts      #     Cumulative play-time tracker + 30 s flush interval
    │   ├── screenshot.ts     #     canvas.toBlob → PNG download
    │   ├── screenshot-preview.ts # Screenshot modal + AI-enhance before/after flow
    │   ├── recording.ts      #     MediaRecorder-based canvas + audio video capture
    │   ├── patches.ts        #     IPS / BPS patch application
    │   └── palettes.ts       #     DMG palette presets + localStorage persistence
    ├── renderer/             #   Render layer (Canvas 2D / WebGL, shaders, temporal blend)
    │   ├── index.ts          #     Barrel re-exports for external consumers
    │   ├── canvas.ts         #     Canvas 2D renderer (plain blit)
    │   ├── webgl.ts          #     WebGL shader renderer + FBO plumbing
    │   ├── shaders.ts        #     VERT_SRC, GRADE_*, all FRAG_* shader sources, registry
    │   └── temporal.ts       #     Pixel-response temporal blender (shared by both)
    ├── upscale/              #   AI screenshot upscaler
    │   └── upscaler.ts       #     PixelPerfect ×4 ESRGAN via ONNX Runtime Web (lazy; model + runtime fetched on first use)
    ├── ocr/                  #   AI "translate the screen" (read → translate → speak), all on-device
    │   ├── ocr.ts            #     On-screen text recognition (PaddleOCR PP-OCRv5 via ppu-paddle-ocr; lib from CDN, models from our HF)
    │   ├── translate.ts      #     Chromium Translator API backend (Chrome/Edge) + availability detection
    │   ├── mt.ts             #     Offline backend — per-language Opus-MT via transformers.js (opt-in; models from our HF)
    │   ├── narrate.ts        #     Text-to-speech via the Web Speech API (voice selection)
    │   ├── languages.ts      #     Supported target languages (kept in sync with mt.ts model map)
    │   └── translate-overlay.ts # Overlay flow + three-tier routing (API → offline → read-aloud)
    ├── assist/               #   AI "ask about the screen" + "let AI play" (opt-in; bring-your-own OpenAI-compatible vision endpoint)
    │   ├── assist.ts         #     Endpoint client: askAssist (streamed Q&A) + askPlan (agent action JSON) + listModels + preferred-answer-language
    │   ├── ai-play.ts        #     "Let AI play" agent loop (capture → plan → drive joypad; goal, one-shot hints, own snapshot ring for rewind, scratchpad)
    │   └── assist-overlay.ts #     Ask / Hint / Describe panel + Let-AI-play controls (goal box, one-shot hints, live status)
    ├── styles/               #   Stylesheets, imported by main.ts in cascade order
    │   ├── base.css          #     Reset, layout, header, responsive ladder, toast
    │   ├── themes.css        #     Aurora / Caustics / Starfield animated backgrounds
    │   ├── canvas.css        #     Rig + canvas frame + CRT overlay + flash/rewind overlays
    │   ├── touch.css         #     On-screen D-pad / A-B / Start-Select
    │   └── popovers.css      #     Backdrop, all five popovers, bindings editor, modal fallback
    ├── input/
    │   ├── gamepad.ts        #     Web Gamepad API polling → joypad press/release
    │   ├── touch.ts          #     On-screen D-pad / buttons → joypad press/release
    │   ├── touch-layout.ts   #     Persisted touch-overlay layout (mirror / scale / spacing)
    │   ├── touch-actions.ts  #     Tap-to-trigger for the footer legend on touch
    │   ├── bindings.ts       #     User-editable key + gamepad binding store
    │   ├── keyboard.ts       #     Global keydown / keyup routing (hotkeys + joypad)
    │   ├── haptic.ts         #     safeVibrate helper — gates navigator.vibrate on user activation
    │   ├── tilt.ts           #     DeviceMotion → MBC7 accelerometer (Kirby Tilt 'n' Tumble)
    │   └── webcam.ts         #     Webcam → Pocket Camera sensor pipeline (luma + dither + 2bpp pack)
    ├── cheats/
    │   ├── parser.ts         #     libretro-format .cht file parser
    │   ├── cdn.ts            #     Online cheat-database lookup (GitHub + jsdelivr)
    │   └── scanner.ts        #     Game Shark-style RAM scanner: narrow an address by repeated value filtering
    └── persistence/          #   IndexedDB-backed storage
        ├── storage.ts        #     Shared IDB wrapper (roms / save-ram / save-states / cheats)
        ├── local-storage.ts  #     Centralised localStorage key catalogue + safe get/set helpers
        ├── crc32.ts          #     Shared CRC32 (cart id content hash, BPS checksum)
        ├── cart-id.ts        #     Per-cart id (title + header cs + rom CRC32)
        ├── cart-overrides.ts #     Per-cart settings overrides (palette, colour correction, …)
        ├── save-ram.ts       #     Battery-backed RAM + MBC3 RTC sidecar
        ├── save-state.ts     #     Per-slot save-state store + private auto-snapshot + slot labels
        ├── cheats.ts         #     Per-cart cheat list
        ├── recents.ts        #     Library entries (metadata, thumbnails, play time)
        ├── printouts.ts      #     Game Boy Printer tray history (per-page PNG store)
        └── io/               #     Export / import bundles (backup + restore)
            ├── base64.ts     #       Chunked binary-safe base64 (handles multi-MB ROM/save bundles)
            ├── settings.ts   #       Preferences bundle (localStorage keys)
            ├── library.ts    #       Library bundle (save-RAM + save-states + cheats + ROMs)
            └── state.ts      #       Single slot → .gbstate file (share one moment)
```

### Clock domain

**Game Boy.** The engine uses **M-cycles** (= 4 T-cycles / 4 dots) as
the lingua franca between subsystems. `CPU.step()` returns the
M-cycles consumed; `Timer.tick(m)` takes M-cycles directly;
`PPU.tick(m)` takes M-cycles and converts to dots internally. The
APU is the exception — it ticks in real-time T-cycles via
`APU.tickTCycles(t)` called per CPU bus access, so wave-channel-RAM
reads land at the exact M-cycle the access happens on. The APU's
512 Hz frame sequencer isn't even tied to that counter; it's clocked
by the falling edge of DIV bit 12 (single-speed) or bit 13
(double-speed), driven from the Timer. One Game Boy frame is
`4 194 304 / 4 / 59.73 ≈ 17 556` M-cycles.

**Game Boy Advance.** The GBA engine ticks in raw CPU cycles at
**16.78 MHz** (= 4 × the Game Boy's clock; the dot clock stays at
the same 4.19 MHz). There's no M-cycle abstraction — `cpu.step()`
returns cycles, the PPU and APU consume cycles, and the timers
divide them down. One full GBA frame is **280 896 cycles** at ~59.73
Hz; `Gba.runFrame()` may overshoot by 1–3 cycles when the last
instruction straddles the boundary and credits the next frame's
budget. All four hardware timers, DMA channels, the SIO unit, and
the APU's two Direct Sound FIFOs share the same cycle counter, with
each subsystem's `tick(cycles)` advancing in lockstep with the CPU.

### Frame pacing

Both engines pace themselves against **wall-clock time**, not the
monitor's `requestAnimationFrame` rate — so a 120 Hz or 144 Hz
display doesn't make the emulator run too fast. Elapsed milliseconds
(scaled by `speedMultiplier`) accumulate into a budget; `runFrame`
is called as many times as fit. A cap prevents a backgrounded tab
from producing a huge catch-up burst on return.

The two engines run on separate rAF loops because their per-frame
needs differ. `GameBoy.runFrame()` runs exactly one frame (one
VBlank) atomically. `Gba.runFrame()` is the same shape, but the
GBA loop in `src/ui/session/runtime-gba.ts` uses a chunked variant
(`runFrameChunked`) that yields to the task queue mid-frame **only
when SIO activity is detected** — needed so cross-tab
BroadcastChannel link-cable messages can drain between halfword
transfers without the runtime busy-waiting on its own message
queue. Idle frames stay atomic and pay zero yield overhead.

### Audio output

A single `AudioOutput` instance (created in `src/ui/state.ts`)
serves both engines. The Game Boy APU and the Game Boy Advance APU
each fill their own `outLeft` / `outRight` arrays each frame and
call back into `audio.schedule(left, right, count)` — the rest of
the pipeline doesn't care which engine produced the samples.

`AudioOutput` uses the _scheduled AudioBuffer_ technique: incoming
sample buffers are scheduled onto the audio graph starting at
`nextStart`, which walks forward one buffer-length at a time. If
the queue falls behind wall clock (slow frame) or drifts too far
ahead (fast frame), `nextStart` is realigned so latency stays
bounded. All source buffers route through a master `GainNode`.
Pausing suspends the `AudioContext`, cutting already-queued audio
too.

### Accuracy and known limitations

Passes the `dmg-acid2` and `cgb-acid2` PPU tests and Blargg's
`cpu_instrs`, `instr_timing`, `mem_timing`, `mem_timing-2`, `halt_bug`,
`interrupt_time`, and `cgb_sound` test suites in full. The emulator is
**not** cycle-accurate down to the T-cycle and deliberately skips a few
edges:

- **DMG-only audio quirks not emulated.** `dmg_sound` 09 / 10 / 12
  exercise behaviours specific to the DMG audio hardware. Glowboot
  presents as CGB, so those fail by design.
- **DMG OAM corruption bug not emulated.** Blargg's `oam_bug` tests 02,
  04, 05, 07, 08 exercise a DMG-only quirk where `INC`/`DEC`/`PUSH`/
  `POP`/`LDI`/`LDD` on an address in `$FE00–$FEFF` during OAM search
  corrupts wave RAM. The bug physically does not occur on CGB, and we
  present as a CGB console — no commercial game relies on it.
- **CGB-only host.** DMG carts run in CGB compatibility mode. The real
  CGB boot ROM hashes the cart title to pick one of ~30 palette schemes
  for DMG carts; we don't ship the boot ROM, so DMG carts default to an
  aurora-matched palette that the user can swap from Settings (9
  curated presets).
- **PPU is per-M-cycle, not per-T-cycle.** The renderer is a pixel-FIFO
  (BG fetcher + per-pixel sprite mixer) and the PPU is ticked
  synchronously on every CPU bus access, so most mid-mode-3 register
  writes land on the right pixel. Granularity is 1 M-cycle (4 dots) in
  single-speed and 2 dots in CGB double-speed, so the sub-M-cycle dot-
  precise effects probed by parts of the Mealybug Tearoom suite (BGP /
  OBP / LCDC changed at specific dots inside an M-cycle) don't fully
  reproduce. No known gameplay impact; affects the test suite only.

GBA accuracy is measured by `npm run test:gba-roms` against jsmolka,
fuzzarm, mgba-suite, and nba-emu/hw-test. The current baseline is
40/40 verdicts passing with 4851/7058 counter sub-tests cleared;
mgba-suite's memory (1552/1552) and dma (1256/1256) categories pass
in full.
Known gaps:

- **HLE BIOS, not a real BIOS image.** The engine reimplements the
  GBA BIOS at the SWI-vector level — math, memory, decompression,
  IntrWait. Cycle costs of HLE SWIs are mid-range approximations,
  not the exact 4 + 13×loops + 7 cycles a real division takes; the
  net IRQ / timer drift is small enough that no shipping cart we've
  tested wedges on it, but it's why a few mgba-suite-timing sub-tests
  fall short. A real Nintendo BIOS can be dropped in at
  `tests/gba-roms/gba_bios.bin` and the test runner will use it.
- **Cycle accuracy is per-instruction, not per-bus-cycle.** Cart-ROM
  prefetch modelling + the precise timer-tick-vs-bus-read interleave
  are the source of the remaining mgba-suite-timing / mgba-suite-
  timers / nba-bus-128kb-boundary sub-test gaps. Real games tolerate
  it; the test ROMs that probe exact T-cycle counts don't.
- **Link cable: Multi-Player mode only, and experimental.** SIO
  Multi-Player mode is the only transport-wired mode. Same-machine
  pairs via `BroadcastChannel` between two tabs; cross-device
  pairing rides the same Cloudflare Worker relay + WebRTC upgrade
  the Game Boy cable uses, but is **opt-in only** on the GBA path
  (`localStorage["gb-gba-link-cross-device-experimental"] = "1"`)
  because cable-detect handshakes are latency-sensitive. In
  practice slow trade protocols (Pokémon Ruby / Sapphire /
  FireRed / LeafGreen / Emerald, mid-second handshake) work
  reasonably; cable-detect-rate protocols (Tetris Worlds VS, Mario
  Kart Super Circuit, Bomberman Tournament) are intermittent
  because cross-tab BroadcastChannel IPC (~1-3 ms per message)
  can't match real-cable round-trip times (~360 µs per transfer at
  115200 baud). Normal-8 / Normal-32 / UART / JOY-bus modes are
  intentionally left as no-transport stubs — they only matter for
  GameCube link (Pokémon Box) and the e-Reader card scanner,
  neither of which Glowboot emulates. The Wireless Adapter (RFU)
  is also unsupported — its command set is ~80% undocumented in
  public references and no open-source emulator has working
  support after 10+ years of community effort.
- **No encrypted Action Replay decoder.** GBA cheats accept raw
  `AAAAAAAA:VV` and CodeBreaker `AAAAAAAA+VVVV` formats — the
  libretro online database serves every published GBA code in pre-
  decrypted CodeBreaker form, so an AR decoder adds no real value
  beyond what's already on the open internet.

## Privacy

The emulator itself runs entirely in your browser, and your game data
never leaves your device — ROMs, save RAM, save states, thumbnails,
cheats, library entries, printer pages, and webcam frames (Game Boy
Camera cart) all live in your browser's IndexedDB / localStorage and
are not uploaded anywhere.

The page does make a small set of outbound requests, listed in full
below. **Scope:** the list applies to the hosted build at
`glowboot.pages.dev`. If you run the emulator locally (`npm run dev`)
or self-host the build, the Cloudflare analytics beacon isn't part of
the source code — it's injected by Cloudflare Pages on its own
hosting, so it doesn't appear in any build you serve yourself. The
link-cable relay URL is also user-configurable (`VITE_LINK_RELAY_URL`
at build time); a self-hoster can point at their own relay, reuse the
public one, or leave it unset to disable cross-device pairing
entirely.

**Always-on (one anonymous request per page load on `glowboot.pages.dev`):**

- **Cloudflare Web Analytics** — the host (`glowboot.pages.dev`)
  injects `static.cloudflareinsights.com/beacon.min.js`, which fires
  one anonymous pageview per visit. It records page URL, referrer,
  country (from your IP, anonymized server-side), browser and viewport
  size. No cookies, no fingerprinting, no cross-site tracking. The
  data lets the maintainer see whether anyone is using the project.
  If you'd rather not be counted, any tracking blocker (uBlock Origin,
  Pi-hole, etc.) blocks the beacon and the emulator still works
  normally.

**Only when you opt in to the feature:**

- **Link-cable relay (cross-device 2-player only).** When you set
  Settings → Session → Link cable to `2-Player` _and_ pair across
  devices via the relay, your tab opens a WebSocket to
  `relay.glowboot.workers.dev` (or whatever URL is configured). The
  relay forwards bytes between the two paired tabs and stores nothing;
  closing either tab drops the session. Same-machine 2-player pairing
  via `BroadcastChannel` doesn't touch the network at all.
- **Cheat-database lookup.** When you click "Search by title" in the
  Cheats popover, the cart's title is sent to public cheat lists
  hosted on GitHub (mirrored via jsdelivr) as a single JSON fetch —
  no auth, no cookies. Pasting Game Genie / Game Shark codes by hand,
  or importing a `.cht` file, never touches the network.
- **AI screenshot enhancer.** The first time you click "Enhance with
  AI" on a screenshot, the browser downloads the upscaler model (~32 MB,
  from a Hugging Face repo) and the ONNX runtime (from the jsdelivr CDN).
  No image data leaves your device — the upscale runs entirely in your
  browser. Both downloads are one-time and cached; if either fails,
  Enhance is simply unavailable and the rest of the app is unaffected.
- **Translate the screen.** The text-recognition model and, where used,
  the offline translation model are downloaded from our own Hugging Face
  repos on first use and cached (the runtimes load from a pinned CDN);
  translation otherwise uses your browser's built-in translator
  (Chrome/Edge). The captured frame and the recognised/translated text
  **never leave your device** — recognition, translation, and text-to-
  speech all run locally. No server, no API key. If a download fails, the
  feature degrades to reading the text aloud, or is simply unavailable; the
  rest of the app is unaffected.
- **Ask AI / Let AI play.** This is the one feature that sends your screen
  off-device — and only if you set it up. When you configure an endpoint in
  Settings → AI assist and trigger it, the captured frame plus your question
  (or, for "Let AI play", a frame each turn) are sent to the OpenAI-
  compatible endpoint **you** chose: a third-party provider, or a local
  server you run (Ollama / LM Studio) that keeps everything on your machine.
  Glowboot runs no AI server of its own and supplies no key — whatever you
  send is governed by your chosen endpoint's policies. Off until configured;
  nothing is sent until you ask.

That's the entire list. The webcam stream (when you load the Game
Boy Camera cart), the link-cable bytes (when paired), and every byte
of every save state stay in your browser.

## Disclaimer

Glowboot is an independent project, not affiliated with, endorsed by,
or sponsored by Nintendo Co., Ltd. **Game Boy**, **Game Boy Color**,
and **Game Boy Advance** are trademarks of Nintendo, used here for
descriptive purposes only.

The emulator ships no ROMs and no BIOS files. Game Boy Advance carts
run through Glowboot's High-Level Emulation of the GBA BIOS, so no
Nintendo BIOS image is required. Use Glowboot with cartridges you
legally own, with public-domain or freely-licensed homebrew, and with
patches whose authors permit redistribution. Game
saves, screenshots, recordings, and printer output you produce while
playing belong to you. The Glowboot authors take no responsibility for
content users load into the emulator.

## Credits

Glowboot ships three third-party algorithm ports in
`src/ui/renderer/shaders.ts`. Each retains its upstream copyright and
MIT license notice in the file itself; the summary here is for quick
reference.

- **xBR-lv2** — Sergio "Hyllian" Galiano (2011–2016, MIT). Single-pass
  weighted-edge upscaler. Used by the **Super-xBR** render mode (Pass 1
  is xBR-lv2; Pass 2 is an original anti-ringing min/max clamp).
- **MMPX (Style-Preserving Pixel-Art Magnification)** — Morgan McGuire
  & Mara Gagiu (2020, MIT) —
  [casual-effects.com paper](https://casual-effects.com/research/McGuire2021PixelArt/).
  2× pattern-match scaler. Used by the **MMPX** render mode.
- **HQ2x (GLSL implementation)** — Lior Halphon (MIT). The HQ-family
  algorithm itself is by Maxim Stepin (2003); Halphon's GLSL port is
  what we ported into Glowboot's WebGL renderer (with the bitwise
  pattern matches expanded to boolean expressions because GLSL ES 1.0
  has no integer bitwise ops). Used by the **HQ2x** render mode.

Glowboot's test-ROM harness (`npm run test:roms`, developer-only — the
ROMs are auto-fetched into `tests/roms/` on first run, never bundled)
runs against
[c-sp's game-boy-test-roms](https://github.com/c-sp/game-boy-test-roms)
collection. That archive aggregates work by Joonas "Gekkio" Javanainen
(Mooneye Test Suite), Shay "Blargg" Green, Matt Currie (dmg-acid2,
cgb-acid2, cgb-acid-hell, Mealybug Tearoom Tests), Christoph Sprenger
(AGE test ROMs), the Hacktix collective (Bully, Strikethrough,
little-things-gb), Toxa (GBMicrotest), Wilbert Pol, and others.

The hardware accuracy work owes a debt to the open documentation
maintained at [Pan Docs](https://gbdev.io/pandocs/) and the
[gbdev wiki](https://gbdev.gg8.se/wiki/), and to Joonas Javanainen's
extensive [hardware-research notes](https://gbdev.io/) on Game Boy
timing edge cases.

When Pan Docs and the wiki ran out — for the obscure STAT-IRQ timing
edges, OAM-DMA quirks, MBC3 RTC latch semantics, APU wave-RAM read
behaviour, and similar dark corners — the readable open-source code of
[mGBA](https://mgba.io/) and [SameBoy](https://sameboy.github.io/)
was the next port of call. Glowboot's implementation is written from
scratch in TypeScript, but the design decisions and the awareness of
which quirks even exist were informed by studying those projects.
Thank you to their authors.

The GBA engine owes a parallel set of debts. Test-ROM coverage in
`npm run test:gba-roms` runs against four upstream suites:
[jsmolka/gba-tests](https://github.com/jsmolka/gba-tests) (ARM,
Thumb, BIOS, memory, save-cart, PPU) by Julian Smolka;
[DenSinH/FuzzARM](https://github.com/DenSinH/FuzzARM) (randomised
ARM / Thumb fuzz coverage) by Dennis Eddy;
[mgba-emu/suite](https://github.com/mgba-emu/suite) (memory, I/O,
timing, DMA, BIOS math, video edges) by Vicki Pfau / the mGBA team,
fetched from the
[Asphaltian/sgba](https://github.com/Asphaltian/sgba) community
mirror so we pin a known-good build with recent DMA-latching fixes;
and [nba-emu/hw-test](https://github.com/nba-emu/hw-test) (DMA, IRQ,
HALTCNT, timer edges) by fleroviux. Authoritative hardware
documentation lives in **GBATEK** by Martin Korth, the canonical
GBA hardware reference, together with the gbdev community wiki and
forum threads. For the dark corners GBATEK leaves to interpretation
— BIOS HLE clobber semantics, GPIO peripherals (RTC / rumble /
gyroscope / solar / accelerometer), DMA bus-latch behaviour, cart
prefetch + WAITCNT timing — the next port of call was the readable
open-source code of [mGBA](https://mgba.io/) again (especially
`gba/bios.c` and `gba/cart-game-info.c`) plus
[NanoBoyAdvance](https://github.com/nba-emu/NanoBoyAdvance) by
fleroviux. Same authorship caveat applies: every line under
`src/gba/` is original TypeScript, but the design decisions and the
list of "things you didn't know existed until they hit your test
suite" came from those projects. Thank you to their authors.

The **AI screenshot upscaler** runs the
[PixelPerfectV4](https://openmodeldb.info/models/4x-PixelPerfectV4)
sprite-upscaling model (ESRGAN architecture, WTFPL), converted to ONNX
and quantised to fp16; Real-ESRGAN, the architecture it builds on, is by
Xintao Wang et al. (BSD-3-Clause). The model is hosted off-repo on
Hugging Face (it exceeds Cloudflare Pages' 25 MiB per-file limit) and
fetched at runtime; `VITE_UPSCALE_MODEL_URL` overrides the source.
Inference uses
[ONNX Runtime Web](https://onnxruntime.ai/) (Microsoft, MIT), loaded at
runtime from a version-pinned CDN. A delivery failure for either only
disables Enhance — the emulator is unaffected.

The **translate-the-screen** feature stands on several open-source
projects. The runtime libraries load from a version-pinned CDN (never
bundled); the model files are mirrored on our own Hugging Face org (via a
maintainer-only mirror script) so the feature doesn't depend on third-party
hosts. Text recognition uses
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (PP-OCRv5,
Apache-2.0) via
[ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr);
offline translation uses the
[Helsinki-NLP Opus-MT](https://github.com/Helsinki-NLP/Opus-MT) models
(Jörg Tiedemann et al., CC-BY-4.0), ONNX-converted by
[Xenova](https://huggingface.co/Xenova) and run through
[transformers.js](https://github.com/huggingface/transformers.js) (Hugging
Face, Apache-2.0). In Chrome/Edge it uses the browser's built-in on-device
Translator API instead; text-to-speech uses the built-in Web Speech API.
Recognition is experimental and varies by game font.

## License

[MIT License](./LICENSE) © 2026 the Glowboot authors.

You're free to use, modify, and redistribute the code — the only
condition is that the copyright notice and license text stay with any
substantial copy or fork.
