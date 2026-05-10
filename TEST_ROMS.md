# Test-ROM accuracy inventory

Results from running the [c-sp Game Boy test-rom collection](https://github.com/c-sp/game-boy-test-roms) through `npm run test:roms`. Updated as suites are exercised; serves both as a regression baseline and as a triage list — entries marked "investigate" are concrete bugs we plan to address; entries marked "expected" are architectural or out-of-scope.

**Test-rom binaries are not bundled.** On first run, `npm run test:roms` auto-fetches the latest [c-sp Game Boy test-roms release](https://github.com/c-sp/game-boy-test-roms/releases) into `tests/roms/` (gitignored). Set `GLOWBOOT_NO_FETCH=1` to skip the auto-fetch and use a manually-prepared directory.

**Optional boot ROMs.** A handful of Mooneye `boot_*` tests check post-boot DIV / register-file / hardware-IO state and only pass when a real Nintendo boot ROM has run first. Drop your own `dmg_boot.bin` (256 B) and/or `cgb_boot.bin` (2 304 B) into `tests/roms/` and the harness will pick them up automatically — boot tests for which the matching file is missing are reported as `SKIP` instead of `FAIL`. Boot ROMs are not bundled (Nintendo copyright); the rest of the suite runs from the post-boot state regardless.

## Summary

| Suite                           | Pass | Fail | Skip / Time | Last run                                                                        |
| ------------------------------- | ---: | ---: | ----------: | ------------------------------------------------------------------------------- |
| Blargg cpu_instrs               |   11 |    0 |           0 | 2026-05-10                                                                      |
| Blargg mem_timing v1            |    4 |    0 |           0 | 2026-05-10                                                                      |
| Blargg instr_timing             |    1 |    0 |           0 | 2026-05-10                                                                      |
| Blargg halt_bug                 |    1 |    0 |           0 | 2026-05-10 — pixel-perfect framebuffer match                                    |
| Blargg interrupt_time           |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                      |
| Blargg mem_timing v2 (parent)   |    1 |    0 |           0 | 2026-05-10 — pixel-perfect                                                      |
| Blargg dmg_sound (parent)       |    0 |    1 |           0 | 2026-05-10 — 3087 px diff (DMG-only ref vs CGB-compat output)                   |
| Blargg cgb_sound (parent)       |    1 |    0 |           0 | 2026-05-10 — pixel-perfect after DIV-edge FS + +6-T wave trigger delay          |
| Blargg oam_bug (parent)         |    0 |    1 |           0 | 2026-05-10 — full-screen diff (DMG-only on CGB host)                            |
| Blargg dmg_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                         |
| Blargg cgb_sound (subtests)     |    0 |    0 |          12 | individual subtests have no PNG; serial output not used                         |
| Blargg mem_timing v2 (subtests) |    0 |    0 |           3 | individual subtests have no PNG                                                 |
| Blargg oam_bug (subtests)       |    0 |    0 |           8 | DMG-only; subtests have no PNG                                                  |
| Mooneye acceptance              |   51 |   24 |           0 | 2026-05-10 — pixel-FIFO Phase 5 net +/-: regressed `intr_2_0_timing` only       |
| Mooneye misc (CGB-specific)     |    0 |    2 |           6 | 2026-05-10 — 6 of 8 `boot_*` skipped without `tests/roms/cgb_boot.bin`          |
| Mealybug PPU (auto-discovered)  |    0 |   30 |           5 | 2026-05-10 — pixel-FIFO renderer; gap is sub-T-cycle CPU↔PPU sync               |
| acid2 (DMG + CGB + CGB-hell)    |    2 |    1 |           0 | 2026-05-10 — cgb-acid-hell 2 px diff (single-sprite sub-pixel quirk)            |
| Bully GB                        |    0 |    1 |           0 | 2026-05-10 — 290 px diff, boot-state                                            |
| GBMicrotest                     |  293 |  220 |           0 | 2026-05-10 — pixel-FIFO PPU rewrite (+15 sprite4\_\*/stat_write/lcdon_to_stat0) |
| Scribbltests                    |    4 |    1 |           3 | 2026-05-10 — statcount-auto down to 1473 px (was 1565)                          |
| Strikethrough                   |    0 |    1 |           0 | 2026-05-10 — 13 px diff (regressed from 7 with the FIFO; mid-line OAM re-read)  |
| Turtle Tests                    |    1 |    1 |           0 | 2026-05-10 — window_y_trigger_wx_offscreen recovered via pop-time window check  |
| Mooneye-gb (wilbertpol fork)    |    0 |  114 |           7 | 2026-05-10 — most fail via 0xED illegal-opcode (test's own fail-fast)           |
| Little-things-gb                |    0 |    2 |           0 | 2026-05-10 — firstwhite 2488 px, tellinglys 5549 px                             |
| MBC3 Tester                     |    0 |    1 |           0 | 2026-05-10 — 5105 px diff                                                       |
| rtc3test                        |    0 |    0 |           1 | 2026-05-10 — interactive (button press required)                                |
| Same-suite                      |   14 |   64 |           0 | 2026-05-10 — DIV-edge FS + wave +6-T trigger delay; APU 12/67, DMA 1/4, PPU 1/1 |
| age-test-roms                   |    1 |    3 |          43 | 2026-05-10 — most are screenshot-based; framebuffer detector TBD                |
| Gambatte test suite             |    5 |  193 |        3326 | 2026-05-10 — 198 ROMs have CGB PNG refs; 3 326 use hex/audio protocol (skip)    |

## Detail

### Blargg cpu_instrs ✅

All 11 individual subtests pass: `01-special` through `11-op a,(hl)`.

### Blargg mem_timing v1 ✅

`01-read_timing`, `02-write_timing`, `03-modify_timing`, plus the bundled `mem_timing.gb` — all pass.

### Blargg instr_timing ✅

Single ROM passes.

### Mooneye acceptance — 51 / 75 (24 fail, 0 timeout)

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

The pixel-FIFO PPU rewrite (Phase 3-6, 2026-05-10) shrank these failures from full-screen diffs to mostly single-digit-pixel territory — the smallest are 2, 10, 19, 21 px out of 23 040. Closing the gap fully needs three more pieces:

1. **Per-T-cycle CPU↔PPU sync** — PPU is currently ticked in batches after each CPU instruction, so mid-mode-3 register writes (BGP / OBP / LCDC / etc.) take effect at the END of the writing instruction instead of the exact T-cycle. The 4-pixel-wide error blocks visible in `m3_bgp_change` are exactly consistent with this PPU lag.
2. **Sprite-fetcher state machine** — Phase 5 approximates per-sprite mode-3 stalls via a post-pump idle pad, which gets the total length right but not per-sprite dot positions.
3. **Per-fetcher-step register snapshots** — some tests need BGP read at fetch time, not pop time.

The pixel-diff counts serve as quantitative regression markers — fixes can be tracked by watching counts drop. 5 ROMs are skipped because they only ship `_dmg_blob.png` references; Glowboot is CGB-only and the comparison would be apples-to-oranges.

### acid2 — 2 / 3

| Test            | Status | Detail                                                                                                                                                                                                                                                        |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmg-acid2`     | ✅     | 0 pixels differ from reference                                                                                                                                                                                                                                |
| `cgb-acid2`     | ✅     | 0 pixels differ                                                                                                                                                                                                                                               |
| `cgb-acid-hell` | ❌     | 2 of 23 040 pixels differ (`(80,68)` / `(80,69)` swapped — middle column of one 8×8 sprite). Author intentionally hides which quirk; survived the pixel-FIFO rewrite, suggesting it needs sub-T-cycle sprite-fetch timing rather than per-pixel mode-3 logic. |

### GBMicrotest — 293 / 513 (57 %)

Per-quirk hardware catalogue. The pixel-FIFO PPU rewrite (Phase 3-6, 2026-05-10) added +15 passes (all 8 `sprite4_*_a`, `ppu_sprite0_scx0_a`/`scx4_a`, `lcdon_to_stat0_a/c`, `line_153_lyc0_stat_timing_j`, `hblank_int_if_a`, `stat_write_glitch_l1_a`/`l143_a`) but cost 1 (`lcdon_to_oam_unlock_d`). Remaining failures cluster around:

| Cluster                               | ~ count | Notes                                          |
| ------------------------------------- | ------: | ---------------------------------------------- |
| `hblank_int_scx*_if`                  |     ~24 | mode-0 IRQ vs `(SCX & 7)` — sub-dot resolution |
| `line_153_lyc*_stat_timing`           |       9 | LY=153→LY=0 mid-VBlank quirk (one fixed)       |
| OAM / VRAM read+write locking by mode |      ~8 | mode-3 access blocking precision               |
| VBlank/STAT IRQ edge cases            |     ~12 | LCD-on, line 144 OAM, etc.                     |
| Other (timer, OAM DMA, misc)          |    ~167 | scattered single-test fails                    |

### Scribbltests / Strikethrough / Turtle Tests

| Test                                          | Status | Detail                                                                            |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `scribbltests/lycscx`                         | ✅     | 0 px                                                                              |
| `scribbltests/lycscy`                         | ✅     | 0 px                                                                              |
| `scribbltests/palettely`                      | ✅     | 0 px (CGB-compat palette)                                                         |
| `scribbltests/scxly`                          | ✅     | 0 px (DMG-green palette)                                                          |
| `scribbltests/statcount-auto`                 | ❌     | 1 473 px diff (was 1 565 pre-FIFO)                                                |
| `scribbltests/{fairylake, statcount, winpos}` | ⏳     | no reference PNG bundled                                                          |
| `strikethrough`                               | ❌     | 13 px diff (regressed from 7 with the FIFO; per-T-cycle CPU↔PPU sync would fix)   |
| `turtle-tests/window_y_trigger`               | ❌     | 1 710 px diff                                                                     |
| `turtle-tests/window_y_trigger_wx_offscreen`  | ✅     | 0 px (pop-time pre-pop window check; first window pixel lands at screen X = WX−7) |

### Same-suite — 14 / 78 (DIV-edge FS + wave +6-T trigger)

Same-suite mostly probes precise APU + DMA + interrupt timing. The session's APU work (DIV-edge frame sequencer, +6-T wave trigger delay, STOP-resets-DIV) brought it from 7 to 14. Breakdown:

| Group                            | Pass | Fail | Notes                                                                                       |
| -------------------------------- | ---: | ---: | ------------------------------------------------------------------------------------------- |
| `apu/channel_1` (square + sweep) |    0 |   21 | square trigger / duty / freq-change / NRx2-glitch / sweep — needs per-test investigation    |
| `apu/channel_2` (square)         |    0 |   15 | same patterns as channel_1 minus sweep                                                      |
| `apu/channel_3` (wave)           |    6 |    9 | unblocked by +6-T wave trigger delay; remaining are first-sample / freq-change / and-glitch |
| `apu/channel_4` (noise)          |    4 |    9 | unblocked by DIV-edge FS; remaining are align / delay / lfsr-7-15 / restart                 |
| `apu/div_*`                      |    2 |    3 | non-`_10` variants pass; `_10` (double-speed) variants need STOP CPU-pause modelling        |
| `dma/*`                          |    1 |    3 | `gbc_dma_cont` passes; HDMA/GDMA edge cases remain                                          |
| `interrupt/ei_delay_halt`        |    0 |    1 | EI-delay vs HALT interaction                                                                |
| `ppu/blocking_bgpi_increase`     |    1 |    0 | passes — covered by Phase 5 BCPI auto-increment-during-block                                |
| `sgb/*`                          |    0 |    2 | SGB protocol not emulated                                                                   |

### Bully GB

`290 px diff` — boot-state dependent. Same class as Mooneye `boot_*`.

## Triage candidates (fix before shipping)

- [x] ~~Mooneye `ret_*` timeouts — three tests hang; likely a real RET timing bug~~ — fixed by per-bus-access DMA ticking + 2-cycle setup delay
- [x] ~~cgb-acid-hell 2-pixel diff — find which pixels and why~~ — investigated 2026-05-10; survived the pixel-FIFO rewrite, suggesting it needs sub-T-cycle sprite-fetch timing rather than per-pixel mode-3 logic. Deferred until per-T-cycle CPU↔PPU sync lands.
- [x] ~~Mooneye timer `*_div_trigger` (5 tests) — DIV→TIMA trigger edge case~~ — fixed 2026-05-10 by modeling the timer's input as `(TAC enable) AND (div_bit)` and bumping TIMA on its falling edge (covers DIV reset, TAC enable→disable, TAC mode change). Also fixed `tima_reload`/`tima_write_reloading`/`tma_write_reloading` via the 1-M-cycle reload window.
- [x] ~~Mooneye `push_timing` / `rst_timing` / `call_*_timing2` — remaining cycle-accounting gaps~~ — fixed 2026-05-10 by reversing `stackPush` byte order (high before low) and dropping CPU writes to OAM while DMA is active
- [ ] ~~Mooneye `rapid_toggle` — off-by-1 on IRQ servicing under rapid TAC toggling (BC=$FFD8 vs expected $FFD9)~~ — investigated 2026-05-10: traced 16 falling-edge bumps at iters 8-14 / 23-29 / 38-39, each one iteration later than real HW's 7-13 / 22-28 / 37-38. The shift is a ~2 M-cycle DIV alignment difference that pushes every bit-9 boundary across one iteration. Fixing requires sub-M-cycle bus-write timing in the CPU; deferred.
- [x] ~~**Turtle Tests `window_y_trigger_wx_offscreen` — regressed pass → 862 px with the pixel-FIFO**~~ — fixed 2026-05-10 by moving the window-activation check to pop-time (gated on FIFO has data + SCX discards finished) so the first window pixel lands at screen X = WX − 7 rather than WX − 6. Matches pre-FIFO `bgEndX = wx − 7` semantics; gbmicrotest win[0-15]\_a all still pass because mode-3 length stays 178 dots for wx=7.
- [ ] **Strikethrough — regressed 7 → 13 px with the pixel-FIFO** (the 6 extra px land at sprite-X boundaries past the 10-sprite limit, where the FIFO catches mid-mode-3 BG/OAM updates that the atomic renderer didn't). The reference matches the atomic behavior, so closing this needs per-T-cycle CPU↔PPU sync — same blocker as Mealybug.
- [x] ~~Scribbltests `scxly` 100 % diff — investigate (palette? rendering path off?)~~ — fixed 2026-05-10: reference uses DMG green LCD shades (#98C00F / #0F380F), not gray. `palettely` had a similar mismatch (uses CGB-compat shades, not gray); both now pass with the right palette config in the test runner.
- [ ] **GBMicrotest `hblank_int_scx*` cluster — ~24 related fails on the same axis**. Pixel-FIFO didn't unlock these because they need T-cycle-precise mode-0 IRQ timing relative to `(SCX & 7)`. Same root cause as Mealybug — needs per-T-cycle CPU↔PPU sync.
- [ ] **Same-suite `div_*_10` (3 tests) — double-speed FS variants**. STOP-resets-DIV landed but didn't unlock these; they likely need the 0x20000 T-cycle CPU pause that real CGB performs during a speed switch.
- [ ] **Mealybug parity (0/30)** — needs per-T-cycle CPU↔PPU sync + sprite-fetcher state machine + per-fetcher-step register snapshots. Diff counts are now small (most under 50 px) but the architectural lift is real.
