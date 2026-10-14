# grimoire-play — games on a deck, over phase.rs's rules engine

The one place the app touches a rules engine: [phase.rs](https://github.com/phase-rs/phase)'s
`phase-engine` (library `engine`) and its AI, `phase-ai`, taken from git at one pinned `rev`. It
holds two games: the goldfish board's (`session.rs`, `view.rs`: one player against a target that
does nothing) and a playtest (`playtest/`: the reader's deck against one other or three, each
opponent played by phase's AI). Facts go in (`CardFacts`, Scryfall's fields for a deck row), and
a view and what happened come out. It knows nothing of SQLite, Tauri or a window.

Design, measurements and licences: [goldfish.md](../../docs/reference/goldfish.md) (the engine,
the pin, the goldfish) and [playtest.md](../../docs/reference/playtest.md) (the AI game).

---

## Binding rules

- **Desktop only.** Only `apps/desktop/src-tauri` depends on this crate. Never link it through
  `grimoire-core`: the web host's module is measured to the byte, and the light app has no
  Playtesting. Its commands are on `command_table::DESKTOP_ONLY`.
- **Every call into the engine runs on `on_engine_stack`** (16 MiB). Never call `Goldfish::new`,
  `Playtest::new` or either's `act` straight from a Tauri command or a tokio worker. phase's
  recursion overflows small stacks, and an overflow aborts the app. Tests go through it too
  (`tests.rs`' and `playtest/tests.rs`' `engine`).
- **The rev moves by a commit that runs the whole gate**, and `phase-engine` and `phase-ai` move
  together, never apart: the AI reads the engine's `GameState`. phase changes daily. This crate's
  tests are the proof that a move kept both boards playing. A move may change what the parser
  understands, and that is the point.
- **The toolchain pin is a nightly because of this dependency** (`rust-toolchain.toml` has the
  record). If phase drops `cargo-features` from its root manifest, or a fork does, the pin can go
  back to a stable release.
- **Facts, not sentences.** `Happened` says which card went where and how. The page writes the log
  (`features/playtesting/goldfish/log.ts`). Never put display text in the view.
- **The wire is mirrored by hand.** `view.rs` ↔ `packages/ui/lib/ipc/goldfish.ts`, and
  `playtest/view.rs` ↔ `packages/ui/lib/ipc/playtest.ts`. `ipc.test.ts` holds each struct field
  for field, and every `GoldfishAction` / `Happened` / `PlaytestAction` / `PlaytestHappened`
  variant and field. A change to either side is one commit with the other.
- **A playtest never sends what the reader may not see.** Each opponent's hand and library are
  counts in `PlaytestSeat`, and their draws are `Drew` with no name (`playtest/session.rs`' `tell`).
- **A duel is a four-player game with one opponent.** `Playtest::new` takes a list of
  `OpponentDeck`s (one to three), and every seat is a `PlaytestPlayer`. Never add a code path for
  one player count alone: what the session does for `opponent` it does for `opponent2` and
  `opponent3`.
- **A playtest plays on by itself until the reader decides** (`advance`): the AI takes its own
  decisions through phase's `run_ai_actions`, and the reader's priority is passed for them except
  where `stops_here` stops them (their main phase, a step they asked for, the opponent's spell or
  combat after blocks when they could respond). The reader is stopped only at a `PlaytestStage`.
  A new stop is a new stage or a new `stops_here` rule, never a pause elsewhere in `advance`.
- **A prompt is the engine's legal answers, read generically** (`option_of`), never a match on
  `WaitingFor`'s hundred-odd variants. The one exception is `pick`: the few questions answered by
  a set of cards, whose fields give the count. `auto` must answer any prompt (phase-ai for the
  reader). A question with one answer (`sole_answer`) is taken by `advance`, never asked.
- **A replay frame shows, it never offers.** Every `PlaytestFrame` view is `watching`, with no
  prompt, attack or block (`view_as(true)`), so the AI's own questions never reach the page.
- **A refused action changes nothing.** Both games' `act` restore a checkpoint on any `Err`. On
  the goldfish, a rules play the engine answers with a question is taken back and placed by hand
  (`session.rs`' module doc); in a playtest the question is asked, and the cast's checkpoint
  (`Pending`) is what `cancel` goes back to until the spell is on the stack. Keep all three: both
  boards rely on a refusal leaving the game as it was.
- **Only the deck's cards are parsed**, with phase's own `build_oracle_face`. Never fetch phase's
  `card-data.json`: it is a 93 MB external host this app does not use.

## Commands

| Command                                                      | Action                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cargo test -p grimoire-play`                                | Both games end to end, on the engine's stack (the playtest's against a `VeryEasy` AI) |
| `cargo clippy -p grimoire-play --all-targets -- -D warnings` | Lints                                                                                 |
| `cargo fmt -p grimoire-play`                                 | Format (never `--all`)                                                                |
