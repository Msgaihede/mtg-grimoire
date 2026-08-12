# MTG Grimoire

[![CI](https://github.com/Msgaihede/mtg-grimoire/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Msgaihede/mtg-grimoire/actions/workflows/ci.yml)
[![frontend coverage 97%](https://img.shields.io/badge/frontend%20coverage-97%25-brightgreen)](docs/reference/test-coverage.md)
[![rust coverage 77%](https://img.shields.io/badge/rust%20coverage-77%25-yellowgreen)](docs/reference/test-coverage.md)

Portable desktop app for tracking a Magic: The Gathering collection — Tauri 2 + React 19.

## Install

Grab the latest [release](https://github.com/Msgaihede/mtg-grimoire/releases):

- **`…-setup.exe`** — Windows installer (NSIS). Installs to Program Files.
- **`…-windows-x64-portable.zip`** — a single self-contained executable. Unzip anywhere and
  run it; the collection database lives in a `data/` folder beside the exe, so the whole
  thing moves on a USB stick.
- **`….msi`** — Windows installer for managed deployment.
- **`….deb` / `….AppImage`** — Linux builds. These compile and bundle in CI but have not
  been run by anyone; treat them as best-effort.

The installers are unsigned, so Windows SmartScreen warns on first run.

## Development

See `CLAUDE.md` for architecture and the map of the rest. Rules for an area live in that area's
own `CLAUDE.md` (`src/`, `src-tauri/`, `src/features/decks/`, `.storybook/`, `.github/`);
`docs/reference/` holds the long-form record behind them, and `docs/superpowers/` the specs and
plans.

- `npm run tauri dev` — run the app
- `npm run verify` — build + lint + Vitest + cargo test; run before every commit

Pull requests are gated on `ci-ok`, which aggregates the frontend checks and a Rust matrix
across Windows and Linux. Versions are derived from conventional commits by release-please —
never edit a version by hand.

### Test coverage

| Side                    | Lines covered          | Tests            |
| ----------------------- | ---------------------- | ---------------- |
| Frontend — Vitest + v8  | **97.34%** (3777/3880) | 1769 in 91 files |
| Rust — `cargo llvm-cov` | **77.45%** (5811/7503) | 549              |

- `npm run test:coverage` — frontend; writes `coverage/`
- `npm run test:coverage:rust` — Rust; needs `cargo install cargo-llvm-cov` and
  `rustup component add llvm-tools-preview` once

Neither runs in CI — the instrumented Rust rebuild takes minutes against `cargo test`'s seconds.

The Rust figure counts **shipped code only**, and is ~14 points below what `cargo llvm-cov`
prints on its own: the crate's tests are inline `#[cfg(test)]` modules, so llvm-cov instruments
them too and scores every line of them covered by definition. `scripts/coverage-rust.mjs` splits
each file at its test module and reports both halves. Measured 2026-08-12 on debug builds,
Windows — [docs/reference/test-coverage.md](docs/reference/test-coverage.md) has the per-file
tables, the thin spots, and the traps. **The numbers above are hand-maintained and nothing
recomputes them.**
