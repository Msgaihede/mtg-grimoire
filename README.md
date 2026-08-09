# MTG Grimoire

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

See `CLAUDE.md` for architecture and `docs/` for specs and plans.

- `npm run tauri dev` — run the app
- `npm run verify` — build + lint + Vitest + cargo test; run before every commit

Pull requests are gated on `ci-ok`, which aggregates the frontend checks and a Rust matrix
across Windows and Linux. Versions are derived from conventional commits by release-please —
never edit a version by hand.
