# Glowboot

Play original Game Boy and Game Boy Color games in your browser. No
installation required, your game data stays on your device, works on
desktop and phones.

**Live at** [glowboot.pages.dev](https://glowboot.pages.dev/).

## Contents

- [What you can do](#what-you-can-do)
- [Getting started](#getting-started)
- [Controls](#controls)
- [Tips & features](#tips--features)
- [Install as an app](#install-as-an-app)
- [For developers](#for-developers)
- [Known issues (deferred)](#known-issues-deferred)
- [Privacy](#privacy)
- [Disclaimer](#disclaimer)
- [License](#license)

## What you can do

- **Play any Game Boy or Game Boy Color game** — just load a `.gb` or
  `.gbc` file and go.
- **Save anywhere, anytime** — 12 save slots per game, each with a
  thumbnail so you can see what's saved where. Or just close the tab —
  the emulator picks up exactly where you left off.
- **Rewind time** — hold a key to scrub backwards through recent play
  (30 seconds to 10 minutes, configurable; one minute by default).
  Great for tricky jumps and boss fights.
- **Speed it up or slow it down** — cycle between slow-motion, normal,
  2×, and 4× speed.
- **Record gameplay** — save a screenshot (PNG) or a video of what's on
  screen.
- **Cheats** — paste Game Genie or Game Shark codes, or search an
  online database by game title.
- **Apply romhacks** — drag an `.ips` or `.bps` patch onto the page
  together with a ROM to play translations, randomizers, or fan hacks.
- **Customise the look** — choose between a clean pixel display, a
  handheld LCD simulation, CRT scanlines, xBR smoothing, authentic DMG
  green, Game Boy Pocket olive, SGB sepia, and more.
- **Rebind almost anything** — every Game Boy button, gamepad mapping,
  and shell hotkey (pause, rewind, screenshot, debugger…) is
  customisable in Settings. The save-slot digits `0`–`9` stay fixed
  since the digit IS the slot number.
- **Touch-friendly** — on phones and tablets you get an on-screen D-pad
  and action buttons automatically. The Game Boy was a portrait device,
  so landscape on touch is blocked with a "rotate to portrait" prompt
  rather than fighting a layout that never felt right. Fullscreen keeps
  the overlay visible so you can actually play.
- **Rumble** — if your gamepad has a vibration motor, the emulator can
  rumble along with the game. The MBC5 rumble carts (Pokémon Pinball,
  Perfect Dark, Shantae, …) drive it directly. There's also an optional
  audio-reactive mode that pulses the motor from the game's bass
  energy, so every ROM gets tactile feedback on drums and explosions.
  On Android phones the same signals drive the device's vibration motor
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
  whatever else your cart supports.
- **Game Boy Camera** — load the Camera cart and your webcam becomes
  the in-game sensor. The viewfinder shows live video, you can take
  photos, save them to the cart's photo album, and play the built-in
  mini-games.
- **Game Boy Printer** — turn the link cable to "Printer" mode and
  any printer-aware ROM (Game Boy Camera prints, Pokémon Yellow's
  Pokédex, Mario's Picross, …) drops its output into a popover,
  ready to save as PNG.
- **Tilt controls** — Kirby Tilt 'n' Tumble and other MBC7
  accelerometer carts work end-to-end. On phones the device's motion
  sensor maps directly to the cart's tilt input; on desktop, **`I` /
  `K` / `J` / `L`** (rebindable in Settings → Controls) stand in for
  forward / back / left / right. iOS asks for motion permission the
  first time you tap the canvas.
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

### Step 1 — get a Game Boy ROM

You'll need a `.gb` (original Game Boy) or `.gbc` (Game Boy Color) file.
The emulator needs the game file to play.

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
2. **Drag a `.gb` / `.gbc` file** onto the page from your desktop.
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

- **Rendering** — several GPU shaders to pick from: Aurora (Glowboot's
  signature look — anti-aliased pixel edges with a soft, colour-faithful
  highlight bloom around bright objects), Super-xBR (default), xBR,
  handheld LCD, scanlines, full CRT, bloom, DMG green, Pocket olive,
  Light amber, SGB sepia, or the clean pixel output (Canvas 2D).
- **Integer scaling** — default ON; keeps every pixel perfectly square.
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
a tricky boss pattern or recovering from a mistake. The default window
is one minute; you can change it to anywhere between 30 seconds and 10
minutes under Settings → Session → Rewind buffer (longer windows use
more memory).

### Speed and slow motion

Tap `M` to cycle: 0.5× (slow motion) → 1× (normal) → 2× → 4×. Press
`Shift+M` to walk the cycle backwards. The speed badge colour-codes
the state: mint for slow motion, amber for turbo — so you can tell at
a glance which side of normal you're on. Audio is muted at any speed
other than 1× (audio doesn't survive pitch-shift gracefully).

### Cheats

Click the wand icon in the header. You can:

- **Paste a code** — Game Genie (`004-BCE-E66`) or Game Shark
  (`010F27D0`).
- **Search online by game title** — pulls cheat lists from a
  community-maintained database.
- **Import a `.cht` file** you downloaded.

Cheats start disabled after bulk import so nothing changes unexpectedly
mid-game — tick the box next to each one to turn it on. There's an
**Enable all / Disable all** toggle at the top of the list if you
imported a pack and want to flip them en masse. Hover a GG / GS badge
to see what each format actually does (ROM-read patch vs per-frame
RAM write).

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

### Tilt controls (Kirby Tilt 'n' Tumble & MBC7 carts)

Kirby Tilt 'n' Tumble shipped with an accelerometer in the cartridge
itself (Nintendo's MBC7 mapper) — the player tilts the whole Game Boy
to roll Kirby through the maze. Glowboot emulates that sensor end-to-end:

- **On phones and tablets**, tilt the device. The OS motion sensor
  maps onto the cart's two-axis accelerometer in real time, so the
  ball rolls the way you tip the device. iOS gates motion access
  behind a permission prompt — the emulator triggers it the first
  time you tap the canvas after loading the ROM.
- **On desktop**, **`I` / `K` / `J` / `L`** stand in for tilt
  forward / back / left / right. Hold a key for sustained tilt;
  release to let the simulated ball settle back to centre. The four
  keys appear in the keyboard cheat sheet (`?`) and are rebindable
  via Settings → Controls → Keyboard alongside the D-pad and face
  buttons.

Save data is battery-backed via the cart's onboard EEPROM, so your
Tilt 'n' Tumble progress persists between sessions just like the
original hardware.

### Debugger

Click the bug icon in the header to open the debugger.
On narrow viewports the bug icon folds into the **More (⋮) menu**
along with the other secondary actions, so the action row stays one
line on phones. Opening the debugger auto-pauses the emulator so
live state isn't a blur — press Space or the ▶ button to resume.

Nine panes, switchable via the tab strip across the top (arrow keys
work inside it):

- **CPU** — every register, flag, control signal (IME, HALT, STOP,
  double-speed, HALT-bug) plus IE / IF. Live-updated while running.
- **Disasm** — live disassembly with the current instruction
  highlighted. Seeds with ~165 instructions around PC and lazy-extends
  at both edges as you scroll, so you can walk far before or after the
  current address without losing your place. The address gutter is
  clickable: left-click to toggle an execute breakpoint, right-click
  anywhere on the row does the same. Operands show symbol names
  instead of hex when a `.sym` file is loaded.
- **Memory** — hex + ASCII viewer of the entire 64 KiB address space
  with a virtual scroller. The region legend (ROM / VRAM / WRAM / OAM
  / IO / HRAM) doubles as a quick-jump row. Click any byte to edit it
  inline; Enter writes via the MMU (so MBC side-effects fire
  normally). A 100-entry undo stack lives in the toolbar.
- **Palettes** — DMG BGP / OBP0 / OBP1 and all 8 CGB background + 8
  CGB object palettes. Hover a colour for its raw RGB555 value.
- **Tiles** — the two VRAM tile banks rendered to a grid (384 tiles
  each), the BG map at 256 × 256, and the full OAM sprite table.
- **Audio** — per-channel oscilloscope traces (CH1 / CH2 squares,
  CH3 wave, CH4 noise) plus envelope meters, so you can see exactly
  which channel is playing what.
- **Breakpoints** — list of active PC breakpoints + read / write
  watchpoints. The add-form accepts a hex address (`$0150`, `0150`)
  or a symbol name from the currently loaded `.sym` file. "At PC"
  drops one at the current program counter. See
  [Breakpoints and watchpoints](#breakpoints-and-watchpoints) below.
- **Call stack** — inferred from CALL / RST / IRQ pushes and RET
  pops. Top of the list is the innermost frame; the kind of each
  frame (`CALL` / `RST` / `IRQ`) is colour-coded. Symbols replace
  hex where known.
- **Symbols** — loader for RGBDS-style `.sym` files. Pick a file, the
  count + source label appear, and every other pane starts resolving
  addresses to names. The parsed text is cached in `localStorage`
  keyed by cart title, so the same ROM auto-restores its symbols next
  session.

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
  the address. Useful for catching vblank-wait loops (watch `$FF44`)
  or finding which routine polls a game variable.
- **Write watchpoint** — pauses on any write. The classic
  "what's changing this variable?" tool — watch the RAM slot, play
  the game, the emulator pauses the exact instant something touches
  it.

A toast announces each hit with kind + address; the Call stack pane
shows the routine chain that led there. All three pass through the
MMU's normal read / write path, so DMA, HDMA, and MBC-register
writes trigger watchpoints too.

#### Symbol files

A `.sym` file maps `bank:addr` pairs to names — produced by RGBDS,
no$gmb, and most Game Boy disassemblers. Examples:

```
00:0150 EntryPoint
00:017d InitDisplay
01:4a8c LoadTilemap
```

With one loaded, `CALL $4A8C` shows up as `CALL LoadTilemap` in the
Disasm pane, call-stack frames gain names, and the Breakpoints
add-form accepts identifiers as input. For popular commercial games,
complete `.sym` files live in community disassembly projects (e.g.
the `pret/` collective for Pokémon; `kaspermeerts/supermarioland`
for Super Mario Land).

## Install as an app

### Desktop & Android (PWA)

On desktop Chrome / Edge, or Android Chrome, the browser shows an
**Install** option in the address bar. Once installed:

- The emulator runs in its own window, no browser toolbars.
- It works fully offline.
- `.gb` and `.gbc` files can be **double-clicked from the OS** to open
  in the emulator.
- Your game data — ROMs, saves, cheats, thumbnails — stays in your
  browser's local storage. See [Privacy](#privacy) for the small set of
  network requests the page makes.

## For developers

Technical details — architecture, build commands, and known accuracy
limitations. Skip this if you just want to play games.

### Build

Requirements: Node.js 18+.

```sh
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173`.

| Command                | Description                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`          | Start the Vite dev server with HMR                                             |
| `npm run build`        | Produce a production build in `dist/`                                          |
| `npm run preview`      | Serve the production build locally                                             |
| `npm run typecheck`    | Typecheck both the UI and the DOM-free engine bundle, no emit                  |
| `npm test`             | Run the Vitest unit suite once                                                 |
| `npm run test:watch`   | Run Vitest in watch mode                                                       |
| `npm run test:roms`    | Run the external test-ROM harness (auto-fetches the c-sp release on first run) |
| `npm run lint`         | ESLint across the repo (file globs come from `eslint.config`)                  |
| `npm run lint:fix`     | ESLint with `--fix` to auto-resolve safe issues                                |
| `npm run format`       | Prettier write across the repo                                                 |
| `npm run format:check` | Prettier check (no writes) — used by CI                                        |

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
DataChannel — lives in `src/ui/session/webrtc-link.ts`.

### Emulator core

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

### Project structure

The tree is split along one hard boundary: `src/gb/` is pure
hardware simulation with **no DOM, no fetch, no localStorage** — it
can be imported from Node for headless test runners. All browser-side
code lives under `src/ui/`.

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
│   │   └── interrupts.ts     #     IF / IE registers and request / servicing helpers
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
└── ui/                       # Browser shell — DOM, network, storage
    ├── state.ts              #   Shared mutable app state + renderer/audio/gamepad singletons
    ├── dom.ts                #   Centralised getElementById wall
    ├── format.ts             #   relativeTime / formatPlayTime / formatTime / slot helpers
    ├── rom-loader.ts         #   Load ROM button, drag-drop, PWA launchQueue → startEmulator
    ├── audio-output.ts       #   AudioContext scheduler + master gain node
    ├── save-blob.ts          #   Web Share API helper for mobile screenshot/recording exports
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
    │   ├── cart-info.ts      #     ROM header metadata
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
    │   ├── link-cable.ts     #     Same-machine BroadcastChannel link
    │   ├── webrtc-link.ts    #     Cross-device WebRTC link (signalling via Cloudflare Worker relay, then peer-to-peer)
    │   ├── printer-link.ts   #     SerialLink that wires the engine printer's bytes back into the MMU
    │   ├── cart-overrides.ts #     Per-cart palette / colour-correction / render-mode pinning
    │   ├── rewind.ts         #     Backspace-held rewind scrubber (UI)
    │   ├── rewind-buffer.ts  #     Rolling save-state ring buffer
    │   ├── autosave.ts       #     Save-RAM interval + visibility + beforeunload hooks
    │   ├── auto-pause.ts     #     Blur / focus listeners, pause on focus loss
    │   ├── pacing.ts         #     requestAnimationFrame-driven frame pacer
    │   ├── play-time.ts      #     Cumulative play-time tracker + 30 s flush interval
    │   ├── screenshot.ts     #     canvas.toBlob → PNG download
    │   ├── recording.ts      #     MediaRecorder-based canvas + audio video capture
    │   ├── patches.ts        #     IPS / BPS patch application
    │   └── palettes.ts       #     DMG palette presets + localStorage persistence
    ├── renderer/             #   Render layer (Canvas 2D / WebGL, shaders, temporal blend)
    │   ├── index.ts          #     Barrel re-exports for external consumers
    │   ├── canvas.ts         #     Canvas 2D renderer (plain blit)
    │   ├── webgl.ts          #     WebGL shader renderer + FBO plumbing
    │   ├── shaders.ts        #     VERT_SRC, GRADE_*, all FRAG_* shader sources, registry
    │   └── temporal.ts       #     Pixel-response temporal blender (shared by both)
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
    │   └── cdn.ts            #     Online cheat-database lookup (GitHub + jsdelivr)
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
            ├── settings.ts   #       Preferences bundle (localStorage keys)
            ├── library.ts    #       Library bundle (save-RAM + save-states + cheats + ROMs)
            └── state.ts      #       Single slot → .gbstate file (share one moment)
```

### Clock domain

The emulator uses **M-cycles** (= 4 T-cycles / 4 dots) as the lingua
franca between subsystems. `CPU.step()` returns the M-cycles consumed;
`Timer.tick(m)` takes M-cycles directly; `PPU.tick(m)` takes M-cycles
and converts to dots internally. The APU is the exception — it ticks
in real-time T-cycles via `APU.tickTCycles(t)` called per CPU bus
access, so wave-channel-RAM reads land at the exact M-cycle the access
happens on. The APU's 512 Hz frame sequencer isn't even tied to that
counter; it's clocked by the falling edge of DIV bit 12 (single-speed)
or bit 13 (double-speed), driven from the Timer. One Game Boy frame
is `4 194 304 / 4 / 59.73 ≈ 17 556` M-cycles.

### Frame pacing

`GameBoy.runFrame()` runs exactly one frame (one VBlank). The main loop
paces itself against **wall-clock time**, not the monitor's
`requestAnimationFrame` rate — so a 120 Hz or 144 Hz display doesn't
make the emulator run too fast. Elapsed milliseconds (scaled by
`speedMultiplier`) accumulate into a budget; `runFrame` is called as
many times as fit. A cap prevents a backgrounded tab from producing a
huge catch-up burst on return.

### Audio output

`AudioOutput` uses the _scheduled AudioBuffer_ technique: the APU fills
its `outLeft` / `outRight` arrays each frame, then the host schedules
them onto the audio graph starting at `nextStart`, which walks forward
one buffer-length at a time. If the queue falls behind wall clock
(slow frame) or drifts too far ahead (fast frame), `nextStart` is
realigned so latency stays bounded. All source buffers route through a
master `GainNode`. Pausing suspends the `AudioContext`, cutting
already-queued audio too.

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
- **PPU is per-pixel but not per-T-cycle.** The renderer is a pixel-FIFO
  (BG fetcher + per-pixel sprite mixer), so most mid-mode-3 register
  writes land on the right pixel — but the PPU is still ticked in
  batches after each CPU instruction rather than synchronously per bus
  access, so dot-precise effects probed by the Mealybug Tearoom suite
  (BGP / OBP / LCDC changed at specific dot positions) don't fully
  reproduce. No known gameplay impact; affects the test suite only.
- **Sprite-fetcher stalls approximated.** Mode-3 length penalties from
  sprites + window are honoured as a single post-pump idle pad rather
  than per-sprite at the right dot. Total scanline length is correct;
  per-sprite timing is not.

## Known issues (deferred)

### The Addams Family (USA) hangs on a black screen after pressing Start

**Symptom:** Title screen renders correctly, music plays, pressing Start leaves the screen black with music continuing.

**Diagnosis:** The game's fade-in counter at WRAM `$C1F1` never advances past 0, holding the BG palette `$FF` (solid black). Some other game state at `$C1F2` does change, so at least one IRQ handler is running — the specific routine that should tick the fade counter is gated on a condition we don't satisfy.

**Status:** Tracked for a follow-up fix; needs a watchpoint on `$C1F1` to identify the missing increment path.

### Audio is functional in all tested games but fails strict cycle-accuracy tests

**Symptom:** No audible glitches reported in real game playback. However, strict APU test ROMs flag many sub-T-cycle quirks (e.g. NRx2 envelope "zombie mode" writes, exact sweep-period reload across power cycles, length-counter behaviour at frame-sequencer half-cycle boundaries, frame-sequencer phase under double-speed switching).

**Status:** Tracked as a long-tail accuracy gap, not a gameplay blocker. Specific game-audio reports are welcome via the bug-report template — they're prioritised over generic test-ROM failures.

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

That's the entire list. The webcam stream (when you load the Game
Boy Camera cart), the link-cable bytes (when paired), and every byte
of every save state stay in your browser.

## Disclaimer

Glowboot is an independent project, not affiliated with, endorsed by,
or sponsored by Nintendo Co., Ltd. **Game Boy** and **Game Boy Color**
are trademarks of Nintendo, used here for descriptive purposes only.

The emulator ships no ROMs, BIOS files, or other copyrighted content.
Use it with cartridges you legally own, with public-domain or
freely-licensed homebrew, and with patches whose authors permit
redistribution. Game saves, screenshots, recordings, and printer
output you produce while playing belong to you. The Glowboot authors
take no responsibility for content users load into the emulator.

## License

[MIT License](./LICENSE) © 2026 the Glowboot authors.

You're free to use, modify, and redistribute the code — the only
condition is that the copyright notice and license text stay with any
substantial copy or fork.
