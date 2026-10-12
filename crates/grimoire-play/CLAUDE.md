# grimoire-play — games on a deck, over phase.rs's rules engine

The one place the app touches a rules engine: [phase.rs](https://github.com/phase-rs/phase)'s
`phase-engine` (library `engine`), taken from git at a pinned `rev`. Today it holds the goldfish
board's game: one player against a target that does nothing. Tomorrow it holds a game against
phase's AI. Facts go in (`CardFacts`, Scryfall's fields for a deck row), and a view and what
happened come out (`view.rs`). It knows nothing of SQLite, Tauri or a window.

Design, measurements and licences: [goldfish.md](../../docs/reference/goldfish.md).

---

## Binding rules

- **Desktop only.** Only `apps/desktop/src-tauri` depends on this crate. Never link it through
  `grimoire-core`: the web host's module is measured to the byte, and the light app has no
  Playtesting. Its commands are on `command_table::DESKTOP_ONLY`.
- **Every call into the engine runs on `on_engine_stack`** (16 MiB). Never call `Goldfish::new` or
  `act` straight from a Tauri command or a tokio worker. phase's recursion overflows small stacks,
  and an overflow aborts the app. Tests go through it too (`tests.rs`' `engine`).
- **The rev moves by a commit that runs the whole gate.** phase changes daily. This crate's tests
  are the proof that a move kept the board playing. A move may change what the parser
  understands, and that is the point.
- **The toolchain pin is a nightly because of this dependency** (`rust-toolchain.toml` has the
  record). If phase drops `cargo-features` from its root manifest, or a fork does, the pin can go
  back to a stable release.
- **Facts, not sentences.** `Happened` says which card went where and how. The page writes the log
  (`features/playtesting/goldfish/log.ts`). Never put display text in the view.
- **The wire is mirrored by hand.** `view.rs` ↔ `packages/ui/lib/ipc/goldfish.ts`. `ipc.test.ts`
  holds each struct field for field, and every `GoldfishAction` / `Happened` variant and field. A
  change to either side is one commit with the other.
- **A refused action changes nothing.** `act` restores its checkpoint on any `Err`. A rules play
  that the engine answers with a question is taken back and placed by hand
  (`session.rs`' module doc). Keep both: the board relies on a refusal leaving the game as it was.
- **Only the deck's cards are parsed**, with phase's own `build_oracle_face`. Never fetch phase's
  `card-data.json`: it is a 93 MB external host this app does not use.

## Commands

| Command | Action |
| --- | --- |
| `cargo test -p grimoire-play` | The game end to end, on the engine's stack |
| `cargo clippy -p grimoire-play --all-targets -- -D warnings` | Lints |
| `cargo fmt -p grimoire-play` | Format (never `--all`) |
