# Game compatibility

This page lists which games have been smoke-tested and what's currently broken.
Before [filing an issue](https://github.com/glowboot/glowboot/issues/new/choose), please check whether your game is already on the **Known issues** list at the bottom — if it is, there's no need to open a duplicate.

**Status legend**

| Symbol | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| ✅     | Plays through normally — no bugs observed in a 5–10 minute session |
| ⚠️     | Minor cosmetic glitches; gameplay unaffected                       |
| ❌     | Major bug — visibly broken or unplayable                           |
| ⏳     | Not yet tested                                                     |

Cart compatibility was checked on the version of Glowboot live at <https://glowboot.pages.dev>.

## Game Boy Color titles

| Game                                     | Status | Notes                                                                                 |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| Pokémon Crystal                          | ⏳     |                                                                                       |
| Pokémon Gold / Silver                    | ⏳     |                                                                                       |
| Pokémon Yellow                           | ⏳     | CGB-aware DMG title                                                                   |
| Pokémon Pinball                          | ⏳     | Rumble cart (MBC5+rumble)                                                             |
| The Legend of Zelda: Link's Awakening DX | ⏳     |                                                                                       |
| The Legend of Zelda: Oracle of Seasons   | ⏳     |                                                                                       |
| The Legend of Zelda: Oracle of Ages      | ⏳     |                                                                                       |
| Wario Land 3                             | ⏳     |                                                                                       |
| Donkey Kong Country                      | ⏳     | Heavy HDMA palette tricks                                                             |
| Mario Tennis                             | ⏳     |                                                                                       |
| Mario Golf                               | ⏳     |                                                                                       |
| Survival Kids                            | ⏳     |                                                                                       |
| Resident Evil Gaiden                     | ⏳     |                                                                                       |
| Shantae                                  | ✅     |                                                                                       |
| R-Type DX                                | ✅     |                                                                                       |
| Spider-Man (Vicarious Visions)           | ✅     |                                                                                       |
| X-Men: Mutant Academy                    | ✅     | Fighter-sprite HDMA fixed in `969b572`                                                |
| Tony Hawk's Pro Skater                   | ✅     |                                                                                       |
| Tony Hawk's Pro Skater 2                 | ⚠️     | Photo title screen has residual artefacts (much improved in `bfdaeb9`); gameplay fine |
| Tony Hawk's Pro Skater 3                 | ⚠️     | Same as THPS2                                                                         |
| Razor Freestyle Scooter                  | ⚠️     | Same as THPS2                                                                         |
| Frogger 2                                | ⏳     |                                                                                       |
| Driver                                   | ⏳     |                                                                                       |
| Lufia: The Legend Returns                | ⏳     |                                                                                       |
| Final Fantasy Legend (CGB)               | ⏳     |                                                                                       |

## Game Boy (DMG) titles

| Game                                  | Status | Notes                                                                          |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Tetris                                | ✅     |                                                                                |
| Super Mario Land                      | ⏳     |                                                                                |
| Super Mario Land 2: 6 Golden Coins    | ⏳     |                                                                                |
| Wario Land: Super Mario Land 3        | ⏳     |                                                                                |
| Donkey Kong (1994)                    | ⏳     |                                                                                |
| Final Fantasy Adventure               | ⏳     |                                                                                |
| Kirby's Dream Land                    | ⏳     |                                                                                |
| Kirby's Pinball Land                  | ⏳     |                                                                                |
| Castlevania: The Adventure            | ⏳     |                                                                                |
| Castlevania II: Belmont's Revenge     | ⏳     |                                                                                |
| Mega Man: Dr. Wily's Revenge          | ⏳     |                                                                                |
| The Legend of Zelda: Link's Awakening | ⏳     |                                                                                |
| Mario's Picross                       | ⏳     |                                                                                |
| The Addams Family                     | ❌     | Stuck on black screen after pressing Start; pre-existing bug, see issues below |
| Tom and Jerry                         | ⏳     |                                                                                |

## Known-tricky compatibility-test titles

These games are commonly used as emulator-accuracy benchmarks because they exercise specific hardware quirks (per the [gbdev wiki](https://gbdev.gg8.se/wiki/articles/Tricky-to-emulate_games)). Worth running early in a regression-test pass.

| Game                                 | Status | Notes                                                   |
| ------------------------------------ | ------ | ------------------------------------------------------- |
| Alone in the Dark: The New Nightmare | ⏳     | Per-scanline palette streaming (hi-color photo)         |
| Prehistorik Man                      | ⏳     | Sprite-evaluation delay sensitive                       |
| Pinball Deluxe                       | ⏳     | STAT IRQ blocking                                       |
| Pinball Fantasies                    | ⏳     | STAT IRQ blocking                                       |
| Altered Space                        | ⏳     | STAT IRQ                                                |
| Road Rash                            | ⏳     | DMG STAT-write bug — should be playable as of `59342fd` |
| Legend of Zerd                       | ⏳     | DMG STAT-write bug — should be playable as of `59342fd` |
| Mole Mania                           | ⏳     |                                                         |
| Star Wars: Episode I — Racer         | ⏳     |                                                         |
| Aladdin (Capcom)                     | ⏳     | HBlank effects                                          |

## Known issues (deferred)

### Crawfish / Vicarious Visions photo title screens render with residual artefacts

**Affected:** Tony Hawk's Pro Skater 2/3, Razor Freestyle Scooter (and likely any other title using the same per-scanline BG-palette-streaming engine).

**Symptom:** The photo on the title screen is recognisable but shows fine horizontal stripe artefacts and a vertical seam. Gameplay is unaffected. Substantially improved in `bfdaeb9` from severe vertical-band corruption.

**Status:** Tracked for a follow-up fix; needs deeper LCD pipeline / sprite-penalty modelling.

### The Addams Family (USA) hangs on a black screen after pressing Start

**Symptom:** Title screen renders correctly, music plays, pressing Start leaves the screen black with music continuing. Pre-existing bug, present before today's PPU work and confirmed working on SameBoy.

**Diagnosis:** The game's fade-in counter at WRAM `$C1F1` never advances past 0, holding the BG palette `$FF` (solid black). Some other game state at `$C1F2` does change, so at least one IRQ handler is running — the specific routine that should tick the fade counter is gated on a condition we don't satisfy.

**Status:** Tracked for a follow-up fix; needs a watchpoint on `$C1F1` to identify the missing increment path.

### Audio is functional in all tested games but fails strict cycle-accuracy tests

**Symptom:** No audible glitches reported in real game playback. However, strict APU test ROMs flag many sub-T-cycle quirks (e.g. wave-RAM read timing during channel-3 active read, exact sweep-period reload across power cycles, length-counter behaviour at frame-sequencer half-cycle boundaries).

**Status:** Tracked as a long-tail accuracy gap, not a gameplay blocker. Specific game-audio reports are welcome via the bug-report template — they're prioritised over generic test-ROM failures. See [`TEST_ROMS.md`](./TEST_ROMS.md) for the per-suite breakdown.

### PPU mid-mode-3 raster effects not reproduced

**Symptom:** A small number of CGB titles use mid-scanline register changes (BGP / OBP / LCDC / SCX / SCY altered between specific dot positions of mode 3) to produce raster effects that real hardware shows pixel-by-pixel. Glowboot's PPU renders each scanline atomically at end of mode 3, so these effects don't reproduce.

**Affected (observed so far):** Tony Hawk's Pro Skater 2/3, Razor Freestyle Scooter (already covered by the entry above). Other titles using the same technique would show similar visual differences.

**Status:** Reproducing this faithfully would require a Pixel-FIFO PPU rewrite. Tracked for a future major version.

---

If you find a game that's broken and isn't on this list, please [file a bug report](https://github.com/glowboot/glowboot/issues/new/choose).
