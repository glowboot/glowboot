# Test-ROM accuracy inventory

Results from running the [c-sp Game Boy test-rom collection](https://github.com/c-sp/game-boy-test-roms) through `npm run test:roms`. Updated as suites are exercised; serves both as a regression baseline and as a triage list — entries marked "investigate" are concrete bugs we plan to address; entries marked "expected" are architectural or out-of-scope.

**Test-rom binaries are not bundled.** On first run, `npm run test:roms` auto-fetches the latest [c-sp Game Boy test-roms release](https://github.com/c-sp/game-boy-test-roms/releases) into `tests/roms/` (gitignored). Set `GLOWBOOT_NO_FETCH=1` to skip the auto-fetch and use a manually-prepared directory.

**Optional boot ROMs.** A handful of Mooneye `boot_*` tests check post-boot DIV / register-file / hardware-IO state and only pass when a real Nintendo boot ROM has run first. Drop your own `dmg_boot.bin` (256 B) and/or `cgb_boot.bin` (2 304 B) into `tests/roms/` and the harness will pick them up automatically — boot tests for which the matching file is missing are reported as `SKIP` instead of `FAIL`. Boot ROMs are not bundled (Nintendo copyright); the rest of the suite runs from the post-boot state regardless.

## Summary

| Suite                           | Pass | Fail | Skip / Time | Last run                                                                      |
| ------------------------------- | ---: | ---: | ----------: | ----------------------------------------------------------------------------- |
| Blargg cpu_instrs               |   11 |    0 |           0 | 2026-05-10                                                                    |
| Blargg mem_timing v1            |    4 |    0 |           0 | 2026-05-10                                                                    |
| Blargg instr_timing             |    1 |    0 |           0 | 2026-05-10                                                                    |
| Blargg halt_bug                 |    1 |    0 |           0 | 2026-05-10 — pixel-perfect framebuffer match                                  |
| Blargg interrupt_time           |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                    |
| Blargg mem_timing v2 (parent)   |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                    |
| Blargg dmg_sound (parent)       |    0 |    1 |           0 | 2026-05-10 — 3087 px diff (DMG-only ref vs CGB-compat output)                 |
| Blargg cgb_sound (parent)       |    0 |    1 |           0 | 2026-05-10 — 2949 px diff (cgb_sound 09 known-fail)                           |
| Blargg oam_bug (parent)         |    0 |    1 |           0 | 2026-05-10 — full-screen diff (DMG-only on CGB host)                          |
| Blargg dmg_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                       |
| Blargg cgb_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                       |
| Blargg mem_timing v2 (subtests) |    0 |    0 |           3 | individual subtests have no PNG                                               |
| Blargg oam_bug (subtests)       |    0 |    0 |           8 | DMG-only; subtests have no PNG                                                |
| Mooneye acceptance              |   52 |   23 |           0 | 2026-05-10 — timer tick moved to post-bus-access (matches T=4 increment)      |
| Mooneye misc (CGB-specific)     |    0 |    2 |           6 | 2026-05-10 — 6 of 8 `boot_*` skipped without `tests/roms/cgb_boot.bin`        |
| Mealybug PPU (auto-discovered)  |    0 |   30 |           5 | 2026-05-10 — known mid-mode-3 raster gap                                      |
| acid2 (DMG + CGB + CGB-hell)    |    2 |    1 |           0 | 2026-05-10 — cgb-acid-hell 2 px diff (single-sprite sub-pixel quirk)          |
| Bully GB                        |    0 |    1 |           0 | 2026-05-10 — 290 px diff, boot-state                                          |
| GBMicrotest                     |  273 |  240 |           0 | 2026-05-10 — + 4 line_153 LY quirk (LY hidden as 0 from dot 4 of line 153)    |
| Scribbltests                    |    4 |    1 |           3 | 2026-05-10 — palette config fixed scxly + palettely; statcount-auto still off |
| Strikethrough                   |    0 |    1 |           0 | 2026-05-10 — 7 px diff (was 22 before per-bus DMA fix); needs Pixel-FIFO      |
| Turtle Tests                    |    1 |    1 |           0 | 2026-05-10                                                                    |
| Mooneye-gb (wilbertpol fork)    |    0 |  114 |           7 | 2026-05-10 — most fail via 0xED illegal-opcode (test's own fail-fast)         |
| Little-things-gb                |    0 |    2 |           0 | 2026-05-10 — firstwhite 2488 px, tellinglys 5549 px                           |
| MBC3 Tester                     |    0 |    1 |           0 | 2026-05-10 — 5105 px diff                                                     |
| rtc3test                        |    0 |    0 |           1 | 2026-05-10 — interactive (button press required)                              |
| Same-suite                      |    3 |   75 |           0 | 2026-05-10 — APU 1/70, DMA 1/4, PPU 1/1                                       |
| age-test-roms                   |    1 |    3 |          43 | 2026-05-10 — most are screenshot-based; framebuffer detector TBD              |
| Gambatte test suite             |    5 |  193 |        3326 | 2026-05-10 — 198 ROMs have CGB PNG refs; 3 326 use hex/audio protocol (skip)  |

## Detail

### Blargg cpu_instrs ✅

All 11 individual subtests pass: `01-special` through `11-op a,(hl)`.

### Blargg mem_timing v1 ✅

`01-read_timing`, `02-write_timing`, `03-modify_timing`, plus the bundled `mem_timing.gb` — all pass.

### Blargg instr_timing ✅

Single ROM passes.

### Mooneye acceptance — 52 / 75 (23 fail, 0 timeout)

Categorised:

| Group                                                                                                                                               | Pass | Fail | Notes                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot_*` (boot register / DIV / hwio post-boot snapshots)                                                                                           |    0 |    8 | runnable — drop `tests/roms/dmg_boot.bin` / `cgb_boot.bin` to enable; otherwise reported as `SKIP`. Default sweep skips                            |
| `ret_*` / `reti_timing` / `call_timing` / `jp_timing` / `pop_timing` / `ld_hl_sp_e_timing` / `oam_dma_timing` / `oam_dma_restart` / `oam_dma/basic` |    9 |    0 | **fixed** by moving OAM DMA tick to per-bus-access (was per-step), 2-cycle DMA setup delay                                                         |
| `push_timing`, `rst_timing`, `call_*_timing2`                                                                                                       |    4 |    0 | **fixed** by writing the high byte before the low byte in `stackPush` + dropping CPU writes to OAM while DMA is active                             |
| `oam_dma/reg_read`, `oam_dma/sources-GS`                                                                                                            |    2 |    0 | **fixed** by latching last-write at FF46 + extending DMA-source echo through 0xFE/0xFF                                                             |
| `oam_dma_start`                                                                                                                                     |    0 |    1 | needs sub-M-cycle DMA start-window modelling (test runs code from OAM mid-DMA)                                                                     |
| PPU (`stat_irq_blocking` ✅, `intr_1_2_timing-GS` ✅, `intr_2_0_timing` ✅)                                                                         |    3 |    9 | mode-3 + LCD-on edge cases; mid-scanline timing                                                                                                    |
| Timer (`tim*_div_trigger`, `tima_reload`, `tima_write_reloading`, `tma_write_reloading`)                                                            |   12 |    1 | **fixed** by falling-edge model on (TAC ∧ div_bit) + 1-M-cycle TIMA reload window (`tima = 0` then snap to TMA + IRQ)                              |
| `interrupts/ie_push`                                                                                                                                |    1 |    0 | **fixed** by latching IRQ vector between PCH and PCL pushes — when SP=0 the PCH push clobbers IE and the vector becomes 0x0000 with no acknowledge |
| `bits/unused_hwio-{GS,C}`                                                                                                                           |    0 |    2 | needs post-boot DMG-compat-vs-CGB-mode latching driven by the boot ROM; without one we always present as native CGB                                |
| `bits`, `instr`, `interrupts`, `serial`, misc                                                                                                       |    4 |    1 | mixed                                                                                                                                              |

### Mealybug PPU — 0 / 30 (5 skipped)

All 30 framebuffer-comparison failures are expected in the current architecture. The mealybug suite tests **mid-mode-3 register changes** (BGP / OBP / LCDC / SCX / SCY changed between specific dot positions of mode 3, with reference images showing the resulting per-pixel raster effect). Glowboot's PPU renders each scanline atomically at end of mode 3, so these effects can't be reproduced without a Pixel-FIFO PPU rewrite.

The pixel-diff counts now serve as quantitative regression markers — fixes can be tracked by watching counts drop.

5 ROMs are skipped because they only ship `_dmg_blob.png` references; Glowboot is CGB-only and the comparison would be apples-to-oranges.

### acid2 — 2 / 3

| Test            | Status | Detail                                                                                                                                                                                                              |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmg-acid2`     | ✅     | 0 pixels differ from reference                                                                                                                                                                                      |
| `cgb-acid2`     | ✅     | 0 pixels differ                                                                                                                                                                                                     |
| `cgb-acid-hell` | ❌     | 2 of 23 040 pixels differ (`(80,68)` / `(80,69)` swapped — middle column of one 8×8 sprite). Author intentionally hides which quirk; deferred until a Pixel-FIFO PPU lets us re-investigate at sub-pixel precision. |

### GBMicrotest — 273 / 513 (53 %)

Per-quirk hardware catalogue. Failures cluster:

| Cluster                               | ~ count | Notes                            |
| ------------------------------------- | ------: | -------------------------------- |
| `line_153_lyc*_stat_timing`           |      10 | LY=153→LY=0 mid-VBlank quirk     |
| OAM / VRAM read+write locking by mode |      12 | mode-3 access blocking precision |
| `hblank_int_scx*_if`                  |     ~24 | mode-0 IRQ vs `(SCX & 7)`        |
| VBlank/STAT IRQ edge cases            |     ~13 | LCD-on, line 144 OAM, etc.       |
| Other (timer, OAM DMA, misc)          |    ~190 | scattered single-test fails      |

### Scribbltests / Strikethrough / Turtle Tests

| Test                                          | Status | Detail                                                                                                        |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `scribbltests/lycscx`                         | ✅     | 0 px                                                                                                          |
| `scribbltests/lycscy`                         | ✅     | 0 px                                                                                                          |
| `scribbltests/palettely`                      | ✅     | 0 px (CGB-compat palette)                                                                                     |
| `scribbltests/scxly`                          | ✅     | 0 px (DMG-green palette)                                                                                      |
| `scribbltests/statcount-auto`                 | ❌     | 1 565 px diff                                                                                                 |
| `scribbltests/{fairylake, statcount, winpos}` | ⏳     | no reference PNG bundled                                                                                      |
| `strikethrough`                               | ❌     | 7 px diff (was 22; per-bus DMA fix recovered the in-DMA HBlank but mid-scanline OAM re-read needs Pixel-FIFO) |
| `turtle-tests/window_y_trigger`               | ❌     | 1 716 px diff                                                                                                 |
| `turtle-tests/window_y_trigger_wx_offscreen`  | ✅     | 0 px                                                                                                          |

### Bully GB

`290 px diff` — boot-state dependent. Same class as Mooneye `boot_*`.

## Triage candidates (fix before shipping)

- [x] ~~Mooneye `ret_*` timeouts — three tests hang; likely a real RET timing bug~~ — fixed by per-bus-access DMA ticking + 2-cycle setup delay
- [x] ~~cgb-acid-hell 2-pixel diff — find which pixels and why~~ — investigated 2026-05-10: 2 px at `(80,68)`/`(80,69)` are swapped within a single 8×8 sprite's middle column. Author hides the quirk catalogue; with our atomic-scanline PPU we can't probe further. Deferred to Pixel-FIFO.
- [x] ~~Mooneye timer `*_div_trigger` (5 tests) — DIV→TIMA trigger edge case~~ — fixed 2026-05-10 by modeling the timer's input as `(TAC enable) AND (div_bit)` and bumping TIMA on its falling edge (covers DIV reset, TAC enable→disable, TAC mode change). Also fixed `tima_reload`/`tima_write_reloading`/`tma_write_reloading` via the 1-M-cycle reload window.
- [x] ~~Mooneye `push_timing` / `rst_timing` / `call_*_timing2` — remaining cycle-accounting gaps~~ — fixed 2026-05-10 by reversing `stackPush` byte order (high before low) and dropping CPU writes to OAM while DMA is active
- [ ] ~~Mooneye `rapid_toggle` — off-by-1 on IRQ servicing under rapid TAC toggling (BC=$FFD8 vs expected $FFD9)~~ — investigated 2026-05-10: traced 16 falling-edge bumps at iters 8-14 / 23-29 / 38-39, each one iteration later than real HW's 7-13 / 22-28 / 37-38. The shift is a ~2 M-cycle DIV alignment difference that pushes every bit-9 boundary across one iteration. Fixing requires sub-M-cycle bus-write timing in the CPU; deferred.
- [x] ~~Strikethrough 22 px — close to passing; small fix likely~~ — partially fixed 2026-05-10 (22 → 7 px from per-bus DMA tick). Remaining 7 px need mid-scanline OAM re-read; deferred to Pixel-FIFO.
- [x] ~~Scribbltests `scxly` 100 % diff — investigate (palette? rendering path off?)~~ — fixed 2026-05-10: reference uses DMG green LCD shades (#98C00F / #0F380F), not gray. `palettely` had a similar mismatch (uses CGB-compat shades, not gray); both now pass with the right palette config in the test runner.
- [ ] ~~GBMicrotest `hblank_int_scx*` cluster — 24 related fails on the same axis~~ — investigated 2026-05-10: requires sub-M-cycle PPU resolution (paired `_a` / `_b` variants probe ±1 dot of mode-3 boundary). Atomic-mode-3 PPU can pass either side but not both; deferred to the Pixel-FIFO rewrite that gates Mealybug too.
