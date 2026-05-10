# Test-ROM accuracy inventory

Results from running the [c-sp Game Boy test-rom collection](https://github.com/c-sp/game-boy-test-roms) through `npm run test:roms`. Updated as suites are exercised; serves both as a regression baseline and as a triage list — entries marked "investigate" are concrete bugs we plan to address; entries marked "expected" are architectural or out-of-scope.

**Test-rom binaries are not bundled.** Fetch the latest release zip from <https://github.com/c-sp/game-boy-test-roms/releases> and unpack into `test-roms/` (gitignored).

## Summary

| Suite                           | Pass | Fail | Skip / Time | Last run                                                                     |
| ------------------------------- | ---: | ---: | ----------: | ---------------------------------------------------------------------------- |
| Blargg cpu_instrs               |   11 |    0 |           0 | 2026-05-10                                                                   |
| Blargg mem_timing v1            |    4 |    0 |           0 | 2026-05-10                                                                   |
| Blargg instr_timing             |    1 |    0 |           0 | 2026-05-10                                                                   |
| Blargg halt_bug                 |    1 |    0 |           0 | 2026-05-10 — pixel-perfect framebuffer match                                 |
| Blargg interrupt_time           |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                   |
| Blargg mem_timing v2 (parent)   |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                   |
| Blargg dmg_sound (parent)       |    0 |    1 |           0 | 2026-05-10 — 3087 px diff (DMG-only ref vs CGB-compat output)                |
| Blargg cgb_sound (parent)       |    0 |    1 |           0 | 2026-05-10 — 2949 px diff (cgb_sound 09 known-fail)                          |
| Blargg oam_bug (parent)         |    0 |    1 |           0 | 2026-05-10 — full-screen diff (DMG-only on CGB host)                         |
| Blargg dmg_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                      |
| Blargg cgb_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                      |
| Blargg mem_timing v2 (subtests) |    0 |    0 |           3 | individual subtests have no PNG                                              |
| Blargg oam_bug (subtests)       |    0 |    0 |           8 | DMG-only; subtests have no PNG                                               |
| Mooneye acceptance              |   25 |   47 |           3 | 2026-05-10                                                                   |
| Mooneye misc (CGB-specific)     |    0 |    8 |           0 | 2026-05-10 — 6 of 8 are boot\_\* (expected)                                  |
| Mealybug PPU (auto-discovered)  |    0 |   30 |           5 | 2026-05-10 — known mid-mode-3 raster gap                                     |
| acid2 (DMG + CGB + CGB-hell)    |    2 |    1 |           0 | 2026-05-10 — cgb-acid-hell 2 px diff                                         |
| Bully GB                        |    0 |    1 |           0 | 2026-05-10 — 290 px diff, boot-state                                         |
| GBMicrotest                     |  263 |  250 |           0 | 2026-05-10 — 51% pass; per-quirk catalogue                                   |
| Scribbltests                    |    2 |    3 |           3 | 2026-05-10 — scxly/palettely diverge heavily                                 |
| Strikethrough                   |    0 |    1 |           0 | 2026-05-10 — 22 px diff (close)                                              |
| Turtle Tests                    |    1 |    1 |           0 | 2026-05-10                                                                   |
| Mooneye-gb (wilbertpol fork)    |    0 |  114 |           7 | 2026-05-10 — most fail via 0xED illegal-opcode (test's own fail-fast)        |
| Little-things-gb                |    0 |    2 |           0 | 2026-05-10 — firstwhite 2488 px, tellinglys 5549 px                          |
| MBC3 Tester                     |    0 |    1 |           0 | 2026-05-10 — 5105 px diff                                                    |
| rtc3test                        |    0 |    0 |           1 | 2026-05-10 — interactive (button press required)                             |
| Same-suite                      |    3 |   75 |           0 | 2026-05-10 — APU 1/70, DMA 1/4, PPU 1/1                                      |
| age-test-roms                   |    1 |    3 |          43 | 2026-05-10 — most are screenshot-based; framebuffer detector TBD             |
| Gambatte test suite             |    5 |  193 |        3326 | 2026-05-10 — 198 ROMs have CGB PNG refs; 3 326 use hex/audio protocol (skip) |

## Detail

### Blargg cpu_instrs ✅

All 11 individual subtests pass: `01-special` through `11-op a,(hl)`.

### Blargg mem_timing v1 ✅

`01-read_timing`, `02-write_timing`, `03-modify_timing`, plus the bundled `mem_timing.gb` — all pass.

### Blargg instr_timing ✅

Single ROM passes.

### Mooneye acceptance — 25 / 75 (47 fail, 3 timeout)

Categorised:

| Group                                                                                                                              | Pass |            Fail | Notes                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---: | --------------: | --------------------------------------------------------------------------------------------------------------------- |
| `boot_*` (boot register / DIV / hwio post-boot snapshots)                                                                          |    0 |               8 | **expected** — Glowboot deliberately does not run a Nintendo boot ROM, so post-boot register state diverges by design |
| Instruction-timing edge cases (`call_*`, `jp_*`, `push_timing`, `rst_timing`, `add_sp_e_timing`, `ld_hl_sp_e_timing`, `oam_dma_*`) |    0 |              17 | **investigate** — sub-instruction cycle-accuracy gaps; not surfaced in any real game so far                           |
| `ret_*` / `reti_timing`                                                                                                            |    0 | 0 (+3 timeouts) | **investigate first** — three RET-class tests hang the harness, may indicate a real RET bug                           |
| PPU (`stat_irq_blocking` ✅, `intr_1_2_timing-GS` ✅, `intr_2_0_timing` ✅)                                                        |    3 |               9 | mode-3 + LCD-on edge cases; mid-scanline timing                                                                       |
| Timer                                                                                                                              |    5 |               8 | all `*_div_trigger` + `tima_reload`/`tma_write_reloading` — DIV→TIMA trigger edge case missing                        |
| `bits`, `instr`, `interrupts`, `serial`, `oam_dma` (top-level)                                                                     |    4 |               3 | mixed                                                                                                                 |

### Mealybug PPU — 0 / 30 (5 skipped)

All 30 framebuffer-comparison failures are expected in the current architecture. The mealybug suite tests **mid-mode-3 register changes** (BGP / OBP / LCDC / SCX / SCY changed between specific dot positions of mode 3, with reference images showing the resulting per-pixel raster effect). Glowboot's PPU renders each scanline atomically at end of mode 3, so these effects can't be reproduced without a Pixel-FIFO PPU rewrite.

The pixel-diff counts now serve as quantitative regression markers — fixes can be tracked by watching counts drop.

5 ROMs are skipped because they only ship `_dmg_blob.png` references; Glowboot is CGB-only and the comparison would be apples-to-oranges.

### acid2 — 2 / 3

| Test            | Status | Detail                                                                       |
| --------------- | ------ | ---------------------------------------------------------------------------- |
| `dmg-acid2`     | ✅     | 0 pixels differ from reference                                               |
| `cgb-acid2`     | ✅     | 0 pixels differ                                                              |
| `cgb-acid-hell` | ❌     | **2 of 23 040 pixels differ** — single tiny PPU edge case worth pinning down |

### GBMicrotest — 263 / 513 (51 %)

Per-quirk hardware catalogue. Failures cluster:

| Cluster                               | ~ count | Notes                            |
| ------------------------------------- | ------: | -------------------------------- |
| `line_153_lyc*_stat_timing`           |      10 | LY=153→LY=0 mid-VBlank quirk     |
| OAM / VRAM read+write locking by mode |      12 | mode-3 access blocking precision |
| `hblank_int_scx*_if`                  |     ~24 | mode-0 IRQ vs `(SCX & 7)`        |
| VBlank/STAT IRQ edge cases            |     ~13 | LCD-on, line 144 OAM, etc.       |
| Other (timer, OAM DMA, misc)          |    ~190 | scattered single-test fails      |

### Scribbltests / Strikethrough / Turtle Tests

| Test                                          | Status | Detail                       |
| --------------------------------------------- | ------ | ---------------------------- |
| `scribbltests/lycscx`                         | ✅     | 0 px                         |
| `scribbltests/lycscy`                         | ✅     | 0 px                         |
| `scribbltests/palettely`                      | ❌     | 12 800 px diff               |
| `scribbltests/scxly`                          | ❌     | 23 040 px diff (full screen) |
| `scribbltests/statcount-auto`                 | ❌     | 1 565 px diff                |
| `scribbltests/{fairylake, statcount, winpos}` | ⏳     | no reference PNG bundled     |
| `strikethrough`                               | ❌     | 22 px diff (close)           |
| `turtle-tests/window_y_trigger`               | ❌     | 1 716 px diff                |
| `turtle-tests/window_y_trigger_wx_offscreen`  | ✅     | 0 px                         |

### Bully GB

`290 px diff` — boot-state dependent. Same class as Mooneye `boot_*`.

## Triage candidates (fix before shipping)

- [ ] Mooneye `ret_*` timeouts — three tests hang; likely a real RET timing bug
- [ ] cgb-acid-hell 2-pixel diff — find which pixels and why
- [ ] Mooneye timer `*_div_trigger` (5 tests) — DIV→TIMA trigger edge case
- [ ] Mooneye `*_timing` for CALL/JP/RST/PUSH (~8 tests) — cycle accounting
- [ ] Strikethrough 22 px — close to passing; small fix likely
- [ ] Scribbltests `scxly` 100 % diff — investigate (palette? rendering path off?)
- [ ] GBMicrotest `hblank_int_scx*` cluster — 24 related fails on the same axis
