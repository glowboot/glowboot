# Changelog

All notable user-facing and developer-facing changes to Glowboot are
documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Glowboot
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Draggable translation overlay.** The "translate the screen" panel can now
  be dragged by its header and dropped anywhere on the page; its position is
  remembered across sessions, so it no longer overlaps the game when the
  panel grows tall.

### Added

- **Close button on the keyboard-shortcuts sheet.** The `?` cheat-sheet now
  has a ✕ button matching the other modals (Esc, `?`, and clicking the
  backdrop still close it too).

## [1.2.1] — 2026-06-07

### Fixed

- **Stuck joypad buttons.** A button held when focus left the playing
  surface (opening a popover, switching tabs) could stay pressed — the
  game would then act on its own, e.g. the character walking by itself
  after a pause / save / reload. Key releases now always register (even
  when a menu has focus), held buttons are cleared on window blur / tab
  switch, and loading a save state no longer restores live input.

## [1.2.0] — 2026-06-07

### Added

- **AI screenshot enhancer** — taking a screenshot now opens a preview
  with a Download action and an "Enhance with AI" action. Enhancing runs
  a PixelPerfect ×4 sprite-upscaling model (ESRGAN, ONNX Runtime Web,
  WebGPU with a CPU/WASM fallback) on the native frame and shows a
  drag-to-compare before/after, then lets you download the 4× PNG. The
  model (~32 MB, fp16) is hosted off-repo and the ONNX runtime loads
  from a version-pinned CDN — neither touches the main bundle or first
  page load; both are fetched only on first use and cached after, and a
  delivery failure only disables Enhance.
- **Translate the screen (experimental)** — a Translate hotkey (or the
  touch-toolbar button) reads the on-screen text (PaddleOCR PP-OCRv5),
  translates it into your chosen language, and can read it aloud, in a
  non-blocking overlay. Three-tier, capability-detected routing: the
  Chromium **Translator API** (Chrome/Edge, instant, no download) → an
  **offline per-language Opus-MT model** via transformers.js (opt-in,
  ~100 MB/language, downloadable from Settings or inline, cached, any
  browser) → **read-aloud** fallback (Web Speech API). 19 languages are
  available offline (so they work in every browser); a "Don't translate —
  read aloud" mode works everywhere. Everything is on-device — no server,
  no API key, no text or image leaves the browser. The runtime libraries
  load from a version-pinned CDN and the models from our own Hugging Face
  repos; neither touches the main bundle.

## [1.1.0] — 2026-06-06

The Game Boy Advance release. Glowboot now plays Game Boy, Game Boy
Color, **and** Game Boy Advance carts out of the same browser tab,
with the engine, debugger, save persistence, cheats, and link cable
extended across both lineages.

### Added

- **Game Boy Advance engine** — ARM7TDMI CPU (full ARM + Thumb
  decoders, seven CPU modes with banked registers, ARMv4T-correct
  pipeline + misaligned-load quirks), the LCD-controller PPU (all six
  BG modes, four BGs + 128 OBJs, three windows, alpha blending,
  mosaic, mode-7 affine), the APU (four PSG channels + two
  DMA-driven Direct Sound FIFOs), four hardware timers + cascade, four
  DMA channels, interrupt controller, and joypad. Headless-runnable
  under `src/gba/`.
- **GBA cart backup** — SRAM (32 KiB), Flash 64/128 KiB with the
  correct per-save-type chip IDs (Atmel / SST / Macronix / Panasonic),
  EEPROM 512 B / 8 KiB autodetect; persisted to IndexedDB and
  auto-saved every 2 seconds, same as the Game Boy path.
- **GBA cart GPIO peripherals** — Seiko S-3511 real-time clock for
  Pokémon Ruby / Sapphire / Emerald / FireRed / LeafGreen and the
  Boktai trilogy (battery-backed: an in-game clock-set persists with
  the cart's save and keeps running across power-offs); rumble for Drill Dozer and WarioWare: Twisted!;
  ADXRS300 single-axis gyroscope for WarioWare: Twisted!; ADXL202E
  two-axis accelerometer for Yoshi Topsy-Turvy and Koro Koro Puzzle;
  solar sensor for the Boktai trilogy.
- **GBA BIOS HLE** — High-level emulation of the full SWI dispatcher
  (CpuSet / CpuFastSet, the LZ77 / RLE / Huffman / Diff / BitUnPack
  decompressors, VBlankIntrWait / IntrWait polling-loop semantics,
  RegisterRamReset, ObjAffineSet / BgAffineSet) so carts run without a
  Nintendo BIOS image. A real BIOS at `tests/gba-roms/gba_bios.bin` is
  honoured by the headless test runner for diagnostic comparisons.
- **GBA debugger** — Nine panes mirroring the Game Boy debugger: CPU
  (ARM7TDMI register file + CPSR / SPSR + HALT / IME / IF / IE /
  IntrWait mask), Disasm (ARM 4-byte / Thumb 2-byte with CPSR.T
  mode-follow), Memory (the sparse 4 GiB address space, switchable
  segments BIOS / EWRAM / IWRAM / I/O / Palette / VRAM / OAM / ROM /
  SRAM), Palettes (the two 256-entry banks at 16×16), Tiles (96 KiB
  VRAM as a 4bpp / 8bpp flat tile grid), Audio (six oscilloscope rows
  — four PSG + DSA / DSB), Breakpoints, Call stack (BL / Thumb-BL +
  BX / LDM-with-PC / POP-with-PC + IRQ entry), Symbols (flat 32-bit
  addresses, accepts `nm` output and linker maps).
- **GBA cheats** — Paste raw GameShark (`AAAAAAAA:VV`) or CodeBreaker
  (`AAAAAAAA+VVVV`) codes; ROM-read patches and per-frame RAM writes
  both supported. Code-database search and `.cht` import work for GBA
  too. Action-Replay decryption is intentionally not implemented (the
  libretro database already serves every published code in pre-
  decrypted CodeBreaker form).
- **GBA link cable (experimental)** — SIO Multi-Player mode wired
  end-to-end. Same-machine pairs via `BroadcastChannel` between two
  tabs; cross-device rides the same Cloudflare Worker relay + WebRTC
  upgrade the Game Boy cable uses, opt-in via
  `localStorage["gb-gba-link-cross-device-experimental"] = "1"`. Slow
  trade protocols (Pokémon trade over Normal-32) work reasonably;
  cable-detect-rate protocols (Tetris Worlds VS, Mario Kart Super
  Circuit, Bomberman Tournament) are intermittent because cross-tab
  IPC (~1-3 ms / msg) can't match real-cable round-trip time
  (~360 µs / transfer). Normal-8 / Normal-32 / UART / JOY-bus modes
  are no-transport stubs; the Wireless Adapter (RFU) is unsupported.
- **GBA save states + autosave** — twelve labeled slots (digit keys to
  load, `Shift+digit` to save), `.gbastate` single-slot export /
  import, auto-resume-on-reload, and a 2-minute rewind buffer all work
  identically across Game Boy and Game Boy Advance carts.
- **Tilt and motion controls extended to GBA** — Yoshi Topsy-Turvy
  and Koro Koro Puzzle (ADXL202E accelerometer) reuse the same
  `I / K / J / L` keyboard mapping and `DeviceMotion` plumbing that
  Kirby Tilt 'n' Tumble uses on Game Boy. WarioWare: Twisted!
  (ADXRS300 gyroscope) reuses `J / L` as counter-clockwise /
  clockwise rotation. Yoshi Topsy-Turvy has a multi-screen
  calibration sequence the cart imposes — keyboard players need to
  hold the matching tilt key while pressing A on each calibration
  screen.
- **PWA `.gba` file association** — Double-clicking a `.gba` file on
  an installed Glowboot PWA opens it in the existing emulator window,
  same as `.gb` / `.gbc`.
- **GBA accuracy gate** — `npm run test:gba-roms` runs 40 self-scoring
  tests across four upstream suites (jsmolka, FuzzARM, mgba-suite,
  nba-emu/hw-test); the run is diffed against the committed baseline
  in `tests/run-gba-roms-baseline.json` (4545 / 7059 counter sub-tests
  cleared). Auto-fetches the test ROMs (SHA256-pinned, pinned commits)
  on first run; `--bless` re-records the baseline after a verified
  accuracy change.

### Changed

- Documentation updated for full GBA parity: the user-facing feature
  bullets, save / rewind / cheats / link-cable / tilt sections, the
  debugger walkthrough, and the developer-facing accuracy + cycle-
  domain + frame-pacing + credits sections all describe both engines
  side by side. Honest framing on the GBA link cable: slow trade
  protocols tend to work, cable-detect-rate protocols are
  intermittent.
- Bug-report issue template's console-mode dropdown now offers a GBA
  option alongside DMG and CGB.
- "Original" is now the default for both the audio-mode and
  render-mode dropdowns, giving a fresh browser unprocessed sound and
  pixels out of the box — closest to what real silicon would output.
  Both dropdowns surface the option first under the same label so the
  no-post-processor choice is one obvious click. Existing users keep
  whichever mode they had picked; only the label "Studio" / "Canvas
  2D" has been re-themed.

### Notes

- The hosted relay (`relay.glowboot.workers.dev`) is shared between
  Game Boy and Game Boy Advance link-cable pairing. Room codes are
  namespaced with a `gba-` prefix on the GBA side so a GB peer
  entering the same code can't silently cross-pair with a GBA peer.
- GBA cheat search defaults to the libretro community database.
- The integer-scaling toggle now defaults **off** so the GBA's
  240×160 frame fills more of the viewport; toggle it on for the
  Game Boy's 160×144 frame to keep every pixel square.

## [1.0.0] — 2026-05-14

Initial public release. Game Boy (DMG) and Game Boy Color (CGB) carts
play in the browser, with the engine running entirely client-side and
all save data stored locally.

### Added

- **Game Boy engine** — Full Sharp LR35902 CPU (256 primary + 256
  CB-prefix opcodes, M-cycle-accurate timing, HALT / STOP, HALT-bug
  semantics, interrupt servicing), pixel-FIFO PPU (BG fetcher +
  per-pixel sprite mixer, four-mode timing with STAT IRQ blocking,
  DMG sprite-priority rules, 10-sprite-per-line limit), four-channel
  APU (two squares with duty, wave, noise LFSR; volume envelopes,
  CH1 sweep, length counters, the DIV-driven 512 Hz frame sequencer
  clocked off DIV bit 12 / bit 13 with hardware-accurate extra-step
  behaviour on DIV writes), and the timer with all four input-clock
  rates.
- **Memory / MBCs** — Work RAM, VRAM, OAM, HRAM, I/O, echo RAM. Mappers:
  ROM_ONLY, MBC1, MBC2, MBC3 (with real-time clock), MBC5, MBC7
  (accelerometer + EEPROM, for Kirby Tilt 'n' Tumble), and Pocket
  Camera (`0xFC`). OAM DMA runs over 160 M-cycles with the CPU bus
  restricted to HRAM. MBC3 RTC ticks against wall-clock time so day-
  night carts (Pokémon Gold / Silver / Crystal) keep moving while the
  emulator is paused or backgrounded.
- **Game Boy Color** — Automatic detection via cart header; banked
  VRAM / WRAM, BG-map attribute tables, palette RAM, OPRI selection,
  KEY1 double-speed mode, general-purpose + H-Blank HDMA.
- **Game Boy Camera** — Webcam plugged into the cart's M64283FP image
  sensor: sensor-register window with capture-trigger handshake,
  exposure + 4×4 ordered-dither pipeline, captured 128×112 frames
  packed as 2 bpp tile data into cart RAM bank 0 at offset 0x100.
  Take photos, save them to the cart's 30-slot album, replay the
  built-in mini-games, and print photos through the virtual printer.
- **Game Boy Printer** — Virtual printer plugged into the link cable
  with the full per-byte state machine (magic / cmd / compression /
  length / data / checksum / keepalive / status), RLE decompression
  for compressed bands, and the READY → PRINTING → DONE status
  transitions strict ROMs (Game Boy Camera) require. Printed pages
  persist to local storage as a single tray across every cart.
- **Link cable (2-player)** — Two copies of the emulator pair up and
  exchange serial bytes. Same-machine pairing via `BroadcastChannel`
  between two tabs / windows; cross-device pairing via the WebSocket
  relay at `VITE_LINK_RELAY_URL` (the hosted build ships with
  `relay.glowboot.workers.dev` already configured), upgrading to a
  direct `RTCDataChannel` for low-latency byte forwarding. The relay
  protocol contract lives in `src/ui/session/webrtc-link.ts`.
- **Tilt controls** — Kirby Tilt 'n' Tumble (MBC7 accelerometer)
  runs end-to-end. On phones the device's motion sensor maps onto
  the cart's two-axis accelerometer in real time; on desktop,
  `I` / `K` / `J` / `L` stand in for tilt forward / back / left /
  right. iOS gates motion access behind a permission prompt the
  emulator triggers on the first canvas tap.
- **Cart battery saves** — Auto-saved to IndexedDB every 2 seconds
  and on tab hide / close, so progress survives closing the tab
  without ever opening the in-game save menu.
- **Save states** — Twelve labeled per-cart slots with thumbnails;
  `Shift+digit` to save, digit to load. Single-slot export / import
  via `.gbstate` JSON envelope so a moment can be shared with
  another player on the same cart. Auto-resume on tab return.
- **Rewind** — Hold `Backspace` to scrub backwards through the last
  two minutes of play. The HUD shows elapsed-time delta; release
  resumes from the scrubbed point.
- **Speed and slow motion** — `M` cycles 0.5× / 1× / 2× / 4×;
  `Shift+M` walks back. Mute below and above 1× because pitch-shift
  doesn't survive gracefully.
- **Cheats** — Paste Game Genie (`004-BCE-E66`) or Game Shark
  (`010F27D0`) codes, search the community-maintained cheat
  database by game title, or import a `.cht` pack. Codes start
  disabled after bulk import to avoid surprises.
- **Patching** — Drop a `.ips` or `.bps` patch onto the page with
  the ROM to apply it. Patched carts appear as separate Library
  entries with an amber badge; their save data is isolated from the
  vanilla cart.
- **Debugger** — Nine panes (CPU, Disasm, Memory, Palettes, Tiles,
  Audio, Breakpoints, Call stack, Symbols). Execute / read / write
  breakpoints, RGBDS-style `.sym` symbol-file loading per cart, and
  Step / Frame / Rewind controls live inside the debugger so live
  state stays inspectable.
- **Renderer** — Nearest-neighbour by default; optional GLSL
  shaders for HQ2x, MMPX, and Super-xBR upscaling. Per-cart palette
  override, CGB colour correction, simulated LCD pixel response,
  and integer scaling are all configurable per-display.
- **Library** — Recent-ROM list with cart thumbnails and play-time
  tracking; per-cart settings overrides (palette, colour correction
  toggle, etc.) persist across sessions.
- **PWA** — Installable as a standalone app on desktop Chrome /
  Edge and Android Chrome. Works fully offline after first load;
  `.gb` / `.gbc` files double-click into the installed app on
  supported OSes.
- **Settings export / import** — Backup the entire library
  (preferences + save RAM + save states + cheats + ROMs) to a
  single bundle and restore it on another browser / device.

### Notes

- Cross-device link-cable pairing needs `VITE_LINK_RELAY_URL` set at
  build time. The hosted build ships with one configured;
  self-hosters supply their own (or reuse the hosted one). Without a
  relay the link cable falls back to same-machine `BroadcastChannel`
  pairing.
- Glowboot presents as CGB to all carts, so the DMG-only quirks
  exercised by Blargg's `oam_bug` 02 / 04 / 05 / 07 / 08 and
  `dmg_sound` 09 / 10 / 12 fail by design. The behaviours those tests
  probe don't exist on real CGB hardware and no commercial cart
  relies on them.
