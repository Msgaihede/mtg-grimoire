# grimoire-play — games on a deck and drafts, over phase.rs's rules engine

The one place the app touches a rules engine: [phase.rs](https://github.com/phase-rs/phase)'s
`phase-engine` (library `engine`) and its AI, `phase-ai`, taken from git at one pinned `rev`. It
holds **one game** (`playtest/session.rs`' `Playtest`): the reader's deck against the goldfish (an
opponent that takes no actions), or against one other deck or three, each opponent played by
phase's AI — or by a person at the reader's lobby (issue #1419). Goldfishing and playtesting are
that one game (the owner's decision of 2026-10-17).
`table.rs` reads the table off the engine's state (a card, a zone's place, a seat's mana), `view.rs`
is the table's shared wire types, and `playtest/view.rs` the game's; `support.rs` says what the
engine plays of a deck before a game. It also holds **one draft** (`draft/mod.rs`' `Draft`) over
phase's `draft-core`: boosters the page made, passed around a table of people and bots (two
cards a pick in a Commander draft), six straight into a sealed pool, or shuffled into a Winston
draft's shared stack; `draft/view.rs` is its wire and `draft/bots.rs` phase's draft bots (both
the pick-and-pass and the Winston bot), ported. Facts go in (`CardFacts`, Scryfall's fields for
a deck row), and a view and what happened come out. It knows nothing of SQLite, Tauri or a window.

Design, measurements and licences: [goldfish.md](../../docs/reference/goldfish.md) (the engine,
the pin, the hybrid model, the goldfish, the table's pieces) and
[playtest.md](../../docs/reference/playtest.md) (the game, its wire and its board).

---

## Binding rules

- **Desktop only.** Only `apps/desktop/src-tauri` depends on this crate. Never link it through
  `grimoire-core`: the web host's module is measured to the byte, and the light app has no
  Playtesting. Its commands are on `command_table::DESKTOP_ONLY`.
- **Every call into the engine runs on `on_engine_stack`** (16 MiB). Never call `Playtest::new` or
  its `act`, or any `Draft` method that can let a bot pick (`new`, `restore`, `pick`, `auto_pick`,
  `replace_with_bot`), straight from a Tauri command or a tokio worker. phase's recursion overflows
  small stacks, and an overflow aborts the app. Tests go through it too (`playtest/tests.rs`' and
  `playtest/goldfish_tests.rs`' `engine`, and `draft/tests.rs`').
- **The rev moves by a commit that runs the whole gate**, and `phase-engine`, `phase-ai` and
  `draft-core` move together, never apart: the AI reads the engine's `GameState`, and the draft
  reducer the engine's types. phase changes daily. This crate's tests are the proof that a move
  kept the game playing, against the AI and the goldfish, and the draft drafting. A move may change
  what the parser understands, and that is the point.
- **The toolchain pin is a nightly because of this dependency** (`rust-toolchain.toml` has the
  record). If phase drops `cargo-features` from its root manifest, or a fork does, the pin can go
  back to a stable release.
- **The goldfish is a seat, not a code path.** An empty `opponents` list is the goldfish: one
  opponent seat, its 200-land library, its two emblems (can't lose, for every player; no maximum
  hand size, for it alone), the reader on the play, the sandbox on. Never a separate session, view,
  command or board again. Whatever the session or the board does for an AI game it does for a
  goldfish game, unless the difference is the opponent's decisions (`fish_answer` in place of
  `run_ai_actions`) or the goldfish's emblems and `dead_on`.
- **Facts, not sentences.** `PlaytestHappened` says which card went where and how. The page writes
  the log (`packages/ui/features/playtesting/play/log.ts`). Never put display text in the view.
- **The wire is mirrored by hand.** `view.rs` ↔ `packages/ui/lib/ipc/table.ts` (the table's shared
  types), and `playtest/view.rs` ↔ `packages/ui/lib/ipc/playtest.ts` (the game). `ipc.test.ts`
  holds each struct field for field, and every `PlaytestAction` / `PlaytestHappened` variant and
  field. A change to either side is one commit with the other.
- **A game never sends what the reader may not see.** Each opponent's hand and library are counts
  in `PlaytestSeat`, and their draws are `Drew` with no name (`playtest/session.rs`' `tell`). In a
  lobby's game that holds for every person: each guest is sent the view from its own seat
  (`guest_steps`, `view_of`), never the host's.
- **A duel is a four-player game with one opponent.** `Playtest::new` takes a list of
  `OpponentDeck`s (none to three), and every seat is a `PlaytestPlayer`. Never add a code path for
  one player count alone: what the session does for `opponent` it does for `opponent2` and
  `opponent3`.
- **A person in an opponent's seat is a chair, not a second game** (issue #1419, a lobby's game).
  `OpponentDeck::person` seats a guest; the session keeps one `you` — the chair — and every
  "reader's" field (stage, prompt, stops, `pending`, `choice`, `ending`, `stopped_at`, mulligans,
  tokens) is the chair's, each other person's waiting in their `Chair` (`sit`). The chair is the
  host's (`PlayerId(0)`) at rest; `act_by` sits the acting guest, `advance` sits whoever the rules
  wait on. Never read `PlayerId(0)` for "the reader" outside `new`, the goldfish's `dead_on` and
  the host's replay frames — read `self.you`, and name players through `Eyes` (`seat_of`,
  `concealed`), so each person's view and facts are from their own seat. Facts go through `Log`,
  one line per person (`tell` with that person's `Eyes`); a fact of the chair's own doing is
  `own`, the table's `all`. A game with people takes no undo and no sandbox, a guest's step never
  carries frames, and a refusal puts back every chair (`Moment::chairs`).
- **The game plays on by itself until the reader decides** (`advance`): the AI takes its own
  decisions through phase's `run_ai_actions`, the goldfish its own through `fish_answer`, and the
  reader's priority is passed for them except where `stops_here` stops them (their main phase, a
  step they asked for, the opponent's spell or combat after blocks when they could respond). The
  reader is stopped only at a `PlaytestStage`. A new stop is a new stage or a new `stops_here`
  rule, never a pause elsewhere in `advance`.
- **The sandbox is a setting, checked in `run`** (`is_sandbox`). `SetSandbox`, like `SetStops`, is
  taken at any stage, plays nothing on and is not remembered by undo. Off, every hand edit is
  refused; on, hand edits are taken in the reader's main phase only, on the reader's cards and on
  any card the table shows (`editable`) — **never an opponent's hand or library**. Never check the
  sandbox action by action, and never let a hand edit reach the engine some other way.
- **Tapping for mana is the rules', never the sandbox's** (`tap_for_mana`, issue #1326). It is
  taken sandbox or not, wherever the reader has priority, from phase's own board list
  (`activatable_mana_actions_for_player`) — never a list of this crate's, and never the
  manual-selection list, which the land-tap reducer does not accept. The mana floats until a cast
  spends it or the rules empty the pool (CR 500.4); nothing plays on after it (`make_mana`), so a
  stop is not passed over. Never put it in `is_sandbox`, and never let the sandbox's `Tap` make
  mana.
- **A prompt is the engine's legal answers, read generically** (`option_of`), never a match on
  `WaitingFor`'s hundred-odd variants. The one exception is `pick`: the few questions answered by
  a set of cards, whose fields give the count. `auto` must answer any prompt (phase-ai for the
  reader). A question with one answer (`sole_answer`) is taken by `advance`, never asked.
- **A replay frame shows, it never offers.** Every `PlaytestFrame` view is `watching`, with no
  prompt, attack or block (`view_as(true)`), so the opponents' own questions never reach the page.
  The goldfish's steps are never frames of their own.
- **A refused action changes nothing.** `act` restores the whole `Moment` on any `Err` — the
  checkpoint and the session's own fields (`choice`, `pending`, `ending`, `stopped_at`), never
  the checkpoint alone (issue #1143). A play with several ways is asked about, and the cast's
  checkpoint (`Pending`) is what `cancel` goes back to until the spell is on the stack. A play is
  made unpaid (`unpaid`) only with the sandbox on and only when the rules offer no way at all;
  without the sandbox it is a refusal. Unpaid is a real cast without paying (`cast_free`, issue
  #1075) before it is ever a put: a put fires no cast or enter trigger. The free cast's emblem
  lives only while that cast is made (`end_free`). Keep all of it: the board relies on a refusal
  leaving the game as it was.
- **Undo and redo restore whole moments, never inverses** (`history.rs`, issue #1022). The session
  keeps the game before each successful action (`Moment`) and `Undo` / `Redo` restore one exactly;
  redo never replays, so the AI's dice cannot change a redone turn. Anything an action changes is
  in its `Moment` — the goldfish's `dead_on` is in its `Checkpoint` — so a new field of game state
  is a field there too. `UNDO_LIMIT` is mirrored by `packages/ui/features/playtesting/undo.ts`.
- **What the engine plays of a deck is phase's verdict, never ours** (`support.rs`, issue #1078):
  each face parsed as a game parses it, asked phase's `card_face_gaps`. Never add a list of cards
  or effects this crate judges by itself; a rev move changes the verdict, and that is the point.
  Like a game, it runs on `on_engine_stack`. A game asks the same of its own faces once, in
  `Playtest::new`, and every `GameCard` carries its face's `gaps` (issue #1093).
- **Only the deck's cards are parsed**, with phase's own `build_oracle_face`. Never fetch phase's
  `card-data.json`: it is a 93 MB external host this app does not use. A draft parses its own
  boosters' cards the same way (`cards::database`), and only for bots that read faces.

### The draft

- **phase's reducer is the authority on the draft** (`draft_core::session::apply`): passing, rounds,
  what a pick may name, the table's size. Never move a card between packs or pools in this crate.
  Modes map onto phase's kinds — `quick` and `cube` are `Quick`, `sealed` is `Sealed`,
  `commander` is `CommanderDraft`, `winston` is `Winston`, `pod` is its `PodFormat`'s (`booster`
  `Premier`, `commander` `CommanderDraft`, `winston` `Winston`) with `DraftSeat::Bot` seats — and
  its procedure table bounds the table: 2 to 8 seats from sets, any number for a cube (a cube
  source), six boosters for sealed, 3 to 8 for Commander, 2 to 4 and three boosters for Winston.
  A pick takes the procedure's `cards_per_pick` ids (`DraftView::picks_per_step`). phase's Sealed
  seats two at the least, so a pool of one sits beside a hidden bot with empty boosters, never
  shown.
- **The page makes the boosters; the draft deals exactly those** (`SetupPacks`, our `PackSource`).
  Never let phase collate a booster: Packs and Draft open from one generator. An instance id is
  `"{card_id}#{seat}.{round}.{index}"`, which every app, a guest's too, resolves in its own corpus.
- **Bots pick as phase's own do.** `bots.rs` is `draft-wasm/src/bot_ai.rs`, both halves,
  ported (that crate is a `cdylib`); keep it phase's and move it with the `rev`, never tune it here.
  After every call that can hand a bot a pack, bots pick until none holds a pack it has not picked
  from — a loop, because a completed round deals the next boosters. Their dice come from the seed
  and the cards picked so far, never from state kept between calls, so a restored draft picks as
  the original would have. In a Winston draft a bot's turn is phase's `winston_decision`, read off
  its own `filter_for_player` projection (never the session), chosen among the decisions the
  engine published as legal, with no dice; bots decide until it is a person's turn, bounded as
  phase's `resolve_shared_stack_bot_turns` is.
- **A refused pick changes nothing.** `pick`, `winston` and `replace_with_bot` keep the session
  and put it back on any `Err`, the bots' picks after it included. `pick` in a Winston draft is
  refused; `auto_pick` there is the bot's decision for the person's turn.
- **A view shows a seat its own pack and pool only**; every other seat is a count and a flag
  (`DraftSeatView`). A guest is sent its own `view(seat)`, never the host's. A Winston view's
  `stack` comes from draft-core's projection: the seat whose turn it is sees the cards of the pile
  in play, and every other pile, the stack and every other seat's view are counts. Never read a
  pile's cards off `SharedStackState` into a view.
- **The wire is mirrored by hand**: `draft/view.rs` ↔ `packages/ui/lib/ipc/draft.ts`, held by
  `ipc.test.ts`. A snapshot (`snapshot` / `restore`) is the setup less its boosters and phase's
  whole session, with a version `restore` checks.

## Commands

| Command                                                      | Action                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `cargo test -p grimoire-play`                                | The game end to end on the engine's stack, against the goldfish, a `VeryEasy` AI and a person (`lobby_tests.rs`); the drafts too |
| `cargo clippy -p grimoire-play --all-targets -- -D warnings` | Lints                                                                                                       |
| `cargo fmt -p grimoire-play`                                 | Format (never `--all`)                                                                                      |
