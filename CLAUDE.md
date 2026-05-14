# Glowboot — Claude instructions

A TypeScript Game Boy / Game Boy Color emulator that runs in the browser. End-user docs live in `README.md`; this file is for AI agents working on the codebase.

## Stack

- **TypeScript** (strict), **Vite** (single-page emulator at `pages/index.html`), **Vitest** for tests, **Prettier** + **ESLint** for style.
- The cross-device link-cable relay lives in a separate repo (own Cloudflare Worker, own deploy). The emulator only knows it via `VITE_LINK_RELAY_URL` and the protocol contract in `src/ui/session/webrtc-link.ts`.

## Repo layout

```
src/gb/   Hardware emulator: cpu, ppu, apu, mmu, joypad, cartridge, serialization.
                Pure TypeScript, no DOM. Save states + headless tests rely on this.
src/ui/         Browser shell: rom-loader, settings/, popovers/, input/, hud/,
                persistence/, session/. Bridges the emulator to the browser.
pages/          Vite root — `pages/index.html` is the emulator. Public assets
                in `pages/public/`. Deployed to glowboot.pages.dev.
```

## CI gates (run in this order before reporting any task complete)

```sh
npm run typecheck      # tsc — runs BOTH passes (main config + tsconfig.gb.json for the headless engine)
npm test               # vitest — ~310 tests, fast
npm run lint           # eslint
npm run format:check   # prettier
npm run build          # full Vite build
```

If `format:check` warns, run `npm run format` (or `npx prettier --write <files>`) and re-check. Don't skip gates. Plain `tsc --noEmit` misses the engine's standalone tsconfig — always use `npm run typecheck`.

## Workflow conventions

- **Commit messages** — Conventional Commits style: `<type>: subject` with `type` ∈ {`feat`, `fix`, `chore`, `refactor`, `docs`, `test`}. Multi-line bodies are fine when context warrants.
- **Always propose a commit message** at the end of each batch of edits — don't wait to be asked.
- **Vite dev server stays running** between verifications. HMR handles routine edits; only restart for `vite.config.ts` / manifest / entry-point changes.
- **After each change you MUST check whether `README.md` needs updating** — this is a blocking step before declaring a task complete, not a soft reminder. The Project structure tree (file paths, descriptions), the For developers section, and the Accuracy and known limitations list all drift fastest. If you added, moved, renamed, or deleted any file under `src/`, the structure tree IS out of date until you fix it.

## Code conventions

- **Default to no comments.** Add one only when the _why_ is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific bug, behaviour that would surprise a reader). Don't explain _what_ the code does — names already do that. Don't reference the current task / fix / callers — those rot.
- **Don't introduce features, abstractions, or "future-proofing" the task didn't ask for.** A bug fix doesn't need surrounding cleanup. Three similar lines beats a premature abstraction.
- **Preserve user-data shapes.** localStorage keys, IndexedDB schemas, save-RAM layouts, save-state structure, exported bundle formats — all of these are now in the wild on users' machines. Renaming, restructuring, or dropping fields silently breaks people's saves and settings. If a layout change is genuinely necessary, add a one-way migration (read old, write new) and keep the read path until the next major release.
- **Don't add UI hints that restate already-visible info.** The control strip already lists default bindings; don't duplicate them.
- **Tactile button affordances over wireframe.** For interactive controls, lead with fills + borders + shadows; outline-only feels less tappable.

## Hardware / protocol work

- **Port from a reference, don't derive empirically.** For mapper / PPU / APU / serial protocol work, read Pan Docs, the gbdev wiki, and the source of established open-source Game Boy emulators _before_ writing code. Empirical guessing from runtime traces wastes hours.
- **Verify against test ROM suites when you touch hardware.** `npm run test:roms` (no arg prints the suite menu). Not a CI gate — running everything is slow — but invaluable for catching regressions. Rough mapping: PPU work → `mealybug-tearoom-tests` + `dmg-acid2` / `cgb-acid2`; CPU / interrupts / timer → `blargg/cpu_instrs/individual`, `mooneye-test-suite`, `same-suite`; APU → `blargg/cgb_sound`, `same-suite`; MBCs → `mooneye-test-suite` mbc folders. Run only the relevant suite — `npm run test:roms mealybug` etc.
- **Validate the host-input → cart pipeline end-to-end before writing the protocol.** Prove a forced-constant input produces the expected in-game effect (e.g. a fixed tilt value rolls Kirby's ball east in Kirby Tilt 'n' Tumble) before iterating on input wiring.
- **Save states**: whenever any subsystem's `serialize`/`deserialize` layout changes, bump `STATE_VERSION` in `src/gb/serialization/serialization.ts` AND add an `upgradeState` migrator that chains v(N) → v(N+1). The emulator is shared across users, so existing save files in the wild must keep loading.

## Common gotchas

- **DeviceMotion silent on Android** despite HTTPS → Chrome's site-level motion-sensor toggle is off. Check that _before_ debugging code.
- **Tests presenting as CGB by default** → some DMG-only test subtests (`blargg/oam_bug` 02/04/05/07/08, `blargg/dmg_sound` 09/10/12) fail by design when run on a CGB-presenting emulator. The behaviours those subtests probe (the DMG OAM-corruption bug, DMG-specific sound register quirks) don't exist on CGB hardware — the failures are hardware-correct, not engine bugs.
