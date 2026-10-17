# The goldfish, the table, and the rules engine under them

A **goldfish** is an opponent that does nothing: no spells, no attacks, no blocks. Goldfishing a
deck shows how fast it does its thing on its own, which hands it keeps, and which turns it stumbles
on. It starts from the fish icon button in the deck editor's action bar (lucide `Fish`, named
"Goldfish this deck"), a game of the list on screen (Actual or Theory), or from the Playtesting
page's "Goldfish" table. Both play on **phase.rs's MTG rules engine**, the engine the app also uses
when it plays a deck against an AI.

**Since 2026-10-17 a goldfish game is a playtest whose opponent takes no actions** (the owner's
decision): one game, on one board. The game, its wire, its board and its undo are
[playtest.md](playtest.md)'s. This page holds the engine under it, the crate, the card data, the
hybrid model of rules and sandbox, the goldfish as an opponent, the table's shared pieces, and the
licences.

Built 2026-10-12 from the two artboards _Goldfish · opening hand_ and _Goldfish · the table, turn 9_,
as a board of its own; folded into the playtest board 2026-10-17. The binding rules are in each
area's `CLAUDE.md`. This page holds the reasons and the measurements.

## Contents

- [The engine: phase.rs](#the-engine-phasers)
- [Why the pin is a nightly](#why-the-pin-is-a-nightly)
- [The crate: `grimoire-play`](#the-crate-grimoire-play)
- [Card data: parsed from the deck, never downloaded](#card-data-parsed-from-the-deck-never-downloaded)
- [The hybrid model: what is a rule and what is a hand](#the-hybrid-model-what-is-a-rule-and-what-is-a-hand)
- [The goldfish never loses](#the-goldfish-never-loses)
- [One game on one board (2026-10-17)](#one-game-on-one-board-2026-10-17)
- [The table](#the-table)
- [What is not there yet](#what-is-not-there-yet)
- [Licences](#licences)

## The engine: phase.rs

[phase.rs](https://github.com/phase-rs/phase) is an open-source MTG rules engine in Rust. It covers
turns, priority, the stack, combat, state-based actions, layers, triggers and replacement effects,
and it parses rules text into abilities. It compiles to native code and to WASM. **The app took one
crate of it first, for the goldfish: `phase-engine`**, whose library is named `engine`. The AI
(`phase-ai`) was taken next, on 2026-10-13, for the playtest board ([playtest.md](playtest.md)).
phase's other crates (a server, an LLM opponent and a draft) are not linked. It compiled on stable
and on `wasm32-unknown-unknown` in the spike: `choose_action(&GameState, PlayerId, &AiConfig, &mut
impl Rng)` takes the same state the board plays on.

Pinned by `rev` in `crates/grimoire-play/Cargo.toml` (`b8d3b82c`, phase 0.107.0, 2026-10-12).
**Move it by a commit that runs the whole gate.** phase changes daily, and `grimoire-play`'s tests
are what show that a move kept the board playing.

Measured on the spike (2026-10-12, this container, 4 cores):

|                                                              |                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `cargo check` of the engine, cold                            | 5 m 23 s (stable 1.98.1, vendored); 4 m 24 s (nightly, from git) |
| Debug build of the engine alone                              | 8 m 30 s                                                         |
| Crates it adds to the lock                                   | 79, including `im`, `petgraph` 0.6, `strum`, `nom` 8             |
| Its own source                                               | ~1.9 million lines of Rust, 81 MB                                |
| A 2-player Commander `GameState` at turn 3, as JSON          | 385 KB, 1.7 ms to serialise (release)                            |
| Mulligan ×2, land, cast, commander cast, two turns (release) | 212 ms in all                                                    |

**It needs a 16 MiB stack.** phase's own `.cargo/config.toml` sets `RUST_MIN_STACK` to 16 MiB
because its recursion overflowed at 1 MiB, and a Tauri command runs on a 2 MiB tokio worker. An
overflow is an abort of the app, not a panic. So every call goes through
`grimoire_play::on_engine_stack`, which runs it on a thread of its own with that stack and turns an
engine panic into one sentence.

## Why the pin is a nightly

`rust-toolchain.toml` moved from 1.98.1 to `nightly-2026-10-11` on 2026-10-12, at the owner's
choice. The cause is that phase's workspace root declares `cargo-features = ["codegen-backend"]`.

**The engine itself is stable Rust.** There is no `#![feature]` in it, and it compiled on 1.98.1
once its four inherited manifest keys were written in by hand. The problem is only that line.
Cargo reads a git dependency's workspace root to fill in those inherited keys, and a stable cargo
refuses the whole package over that root:

- **As a git dependency:** `no matching package named 'phase-engine' found`. With `CARGO_LOG` on, the
  log shows `skipping malformed package`.
- **As a path dependency into a clone:** `the cargo feature 'codegen-backend' requires a nightly
version of Cargo`.

The options were a fork with that one line dropped, a vendored copy (81 MB, about double the
repository), or a nightly. The owner chose the nightly. **The date is the fast dev build's**, so a
checkout installs one compiler, not two. `scripts/toolchain.test.ts` holds the two dates equal and
accepts an exact release or a dated nightly, never a channel name.

**What the move cost:** `clippy --workspace --all-targets -D warnings` was clean on all five
members after one new lint, `needless_range_loop` in `grimoire-core/src/index/facets.rs`. The fix
keeps the loop's bound, because bucket 9 is the hidden "no mana value" bucket. That clippy run was
on Linux. Code under `cfg(windows)` is linted by CI's Windows jobs.

If phase drops that manifest line, or the app forks it, the pin can go back to a stable release.
`rust-toolchain.toml` says so too.

## The crate: `grimoire-play`

`crates/grimoire-play` is the only place the app touches a rules engine. Facts go in, and a view and
what happened come out. It knows nothing of SQLite, Tauri or a window.

| File                         | Holds                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cards.rs`                   | `CardFacts` (Scryfall's fields for one deck row) → phase's `CardFace` → a `CardDatabase` of the deck alone                                                       |
| `tokens.rs`                  | A deck's tokens in the printings the reader set, tied to phase's presets by oracle id                                                                            |
| `table.rs`                   | The table as every seat draws it, read off the engine's state: `game_card`, `place_of`, `mana_table`, `is_permanent`, `type_line`                                |
| `view.rs`                    | The table's shared wire types (`GameCard`, `Lane`, `CardCounter`, `TokenOffer`, `Place`, `Seat`, `MulliganView`, `ManaTable`), in `packages/ui/lib/ipc/table.ts` |
| `playtest/session.rs`        | `Playtest`: the one game, against the goldfish or the AI — its actions, the sandbox, `advance`, the checkpoint                                                   |
| `playtest/view.rs`           | The game's wire: `PlaytestView`, `PlaytestAction`, `PlaytestHappened` and the rest, in `packages/ui/lib/ipc/playtest.ts`                                         |
| `history.rs`                 | Undo and redo's whole moments ([playtest.md](playtest.md#undo-and-redo))                                                                                         |
| `lib.rs`                     | `on_engine_stack`                                                                                                                                                |
| `playtest/goldfish_tests.rs` | The game against the goldfish, end to end on a small Commander deck: the old goldfish board's suite, ported                                                      |
| `playtest/tests.rs`          | The game against the AI (`by_hand` turns the sandbox on to arrange a table)                                                                                      |

**Only the desktop links it** (the owner's decision, 2026-10-12). The light app's spec leaves
Playtesting out of the phone and the browser. Through `grimoire-core`, the engine would be several
megabytes of the web module, a module measured to the byte. The game's three commands are on
`command_table::DESKTOP_ONLY`. The half that is SQLite — which cards a deck plays with — is
`grimoire_core::play::deck_cards`, like every other read of `deck_cards`.

**Proving the game `Send` overflowed rustc's default recursion limit** in the desktop crate:
`overflow evaluating the requirement tauri::State<'_, GoldfishSlot> well-formed`, through
`Box<Goldfish>: Send`, on the goldfish board's slot of then. `GameState` is deep.
`apps/desktop/src-tauri/src/lib.rs` sets `#![recursion_limit = "256"]`, the bound rustc suggested,
and the one slot left (`PlaytestSlot`) still needs it.

## Card data: parsed from the deck, never downloaded

phase's own client fetches `card-data.json`, its whole parsed corpus, about 93 MB, from
`data.phase-rs.dev`. **The app fetches nothing.** It has every fact the parser needs already: name,
cost, type line, rules text, P/T, keywords, loyalty, and `card_faces`. It parses the deck's own
cards with `build_oracle_face`, the function phase's export is built with, so a card is parsed
exactly as on phase's site.

On the spike, five faces parsed in 14 ms in a release build and 117 ms in a debug one. A
Commander deck's hundred is about a second of a debug build, once per game.

**Three facts are read from the printing's blob** because `deck_get` does not carry them:
`keywords` (in Scryfall's casing, which the parser uses to tell a keyword-only line like `Flying`
from rules text), `loyalty` and `defense`. `cards.raw` is gzip on most rows, and SQLite's JSON
functions read a gzip BLOB as malformed JSONB — a hard error, not a NULL. So the blob comes back
whole (`CAST(raw AS BLOB)`) and `card_row::raw_json` opens it.

A few details of the bridge:

- **A Scryfall type line is split into MTGJSON's three lists** (`Legendary Creature — Elf Druid` →
  `Legendary` / `Creature` / `Elf Druid`), because the parser reads the split.
- **A card of several faces is known by its front face**, the name phase keys it by. Each face is
  its own export entry with its `face_index`.
- **`CardDatabase::get_by_name` answers nothing for a database loaded from an export.** `cards` is
  empty there, and only `face_index` is filled. Use `get_face_by_name`. Found the first time a test
  ran.

Which cards start the game is the deck's own rule. An inactive pile is not in the deck. The
sideboard, the maybeboard and a companion start outside the game. The commander pile starts in the
command zone, and its cards make the game a Commander game (40 life, a free first mulligan, tax).
Without a commander the format is phase's `freeform`.

## The hybrid model: what is a rule and what is a hand

The owner's choice of 2026-10-12, made a setting on 2026-10-17. The artboards are a free tabletop,
and phase has both a rules path and a sandbox path (`DebugAction`), so each action takes the one a
player at a table would. **The sandbox** is the second column, and the reader turns it on or off
whenever they like (`setSandbox`, the Sandbox pill in the middle line beside the Stops button, a
radio row in the game menu): **off by default against the AI, on against the goldfish.**

| By the rules                                                       | By hand (phase's sandbox, while it is on)                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| The London mulligan and Commander's free first one                 | A drag to any zone                                           |
| Playing a land as the turn's land drop                             | A card the rules will not play, put down unpaid              |
| Casting a spell, paid from untapped mana (`CastPaymentMode::Auto`) | Tapping and untapping                                        |
| Commander tax                                                      | Counters, token copies, preset tokens                        |
| The turn and each of its steps, every seat's; attacks and blocks   | Life totals, draws, mills and shuffles outside the draw step |
| P/T with counters and statics; the mana open                       |                                                              |

**A hand edit is taken in the reader's main phase only**, where nothing is half done, on the
reader's own cards anywhere and on any card the table shows: an opponent's battlefield, graveyard,
exile and command zone. **Never an opponent's hand or library**, which are counts the reader may
not see ("That card is in a zone you cannot see."). With the sandbox off, every hand edit — move,
tap, untap all, counters, token copy, create token, draw, mill, shuffle, set life — is refused:
"That changes the game by hand. Turn the sandbox on in the game menu to do it." The session checks
it in one place (`run`, through `is_sandbox`), so no action can slip past it.

**A play is rules first.** `Play` is a double-click or a drop from the hand or the command zone onto
the table. It looks for the legal `PlayLand` or `CastSpell` for that card:

- **Exactly one:** it is played. phase lists a cast once per way to make it (a target, a mode), so
  one row means nothing is left to decide.
- **Two or more:** the board asks which, as a prompt with Cancel ([playtest.md](playtest.md#prompts)).
- **None:** with the sandbox on, in the main phase, the card is put where it would have gone,
  unpaid (`unpaid`) — a permanent onto the battlefield, an instant or sorcery into the graveyard.
  `PlaytestHappened::Put` says so, and the log reads "Cast Swords to Plowshares · not paid for".
  With the sandbox off it is refused, in a sentence that ends "Turn the sandbox on to put it down
  by hand."

**A commander put down unpaid still raises its tax.** The reader cast it; they only skipped
paying. `record_commander_cast` is called on that path too. **A card elsewhere than the hand or the
command zone is activated**, and in the sandbox one with nothing to activate is put onto the
battlefield (a double-click on a graveyard's creature).

**The checkpoint is what keeps a cast honest.** `GameState` is persistent (`im`), so a clone is
cheap. A refused action restores the clone, so the game never holds half of anything. A cast keeps
one (`Pending`) while the engine asks the reader how to make it, and Cancel goes back to it until
the spell is on the stack.

**Until 2026-10-17 the goldfish board took two shortcuts the one game does not.** A spell with a
choice of targets was put down unpaid, because the board had no prompt; and a question the engine
asked while a turn passed (an upkeep trigger's target) took its first answer, told as "The rules
engine answered a … prompt for you". Both are prompts now, as against the AI. So is the discard to
hand size: the goldfish board had a `discard` stage and a `DiscardDialog` of its own (from
2026-10-13; before that the engine's first answer, always the cards drawn last), and it is now the
playtest's pick prompt, purpose `discard`.

## The goldfish never loses

**The goldfish is a seat, not a board.** `Playtest::new` with an empty `opponents` list deals a
goldfish game: one opponent seat (`PlayerId(1)`, `opponent` on the wire, the plate "Goldfish"), the
reader always on the play, the sandbox on, and no AI (`difficulty` is unused). `PlaytestView.goldfish`
says it is one.

**Its library is 200 copies of `Goldfish Scale`**, a synthetic land that does nothing
(`FISH_LIBRARY`), enough that it never runs out in a game anyone plays: it draws one a turn and
plays none. The emblem below would keep it in the game with an empty library too; a library is what
a mill or a "target player draws" has to act on.

**Two command-zone emblems are granted at the start**, never shown and never counted as anyone's
card, and out of the sandbox's reach:

- **"You can't lose the game"** — phase's `StaticMode::CantLoseTheGame` with no `affected` filter.
  `sba::static_affects_player` reads no filter as "every player" (CR 104.3b), so neither seat loses
  at 0 life or to an empty library, and a life total at 0 is a number on the board, not the end of
  the game. A goldfish game never reaches `over`.
- **No maximum hand size** — `StaticMode::NoMaximumHandSize`, for the goldfish alone (CR 402.2). It
  keeps every card it draws and never discards at cleanup, so its graveyard stays empty and the log
  stays quiet.

**It answers its own decisions by doing nothing** (`fish_answer`, inside `advance`): it passes
priority, declares no attackers and no blockers, keeps its hand, and answers anything else — a
question a card of the reader's puts to it — with the engine's first legal action. Its steps are
never replay frames of their own: there is nothing to watch, so the board says "Playing on…" while
the engine runs its turn. **The reader can attack it**, and its life drops by the rules.

**Dead on your turn N.** The goldfish's seat carries `deadOn` (`dead_on`): the reader's own turn
(phase's `turns_taken`) on which its life first reached 0 or less, `null` again once it is back
above 0. It is the one count of the reader's turns alone; everything else counts the game's turns,
both seats'. It is part of undo's moment (`Checkpoint`), so an undo past the killing blow brings
the goldfish back to life. The plate reads "Dead on your turn 5", highlighted with a gold
edge, and the game goes on until the reader deals another. A goldfish the rules bring to 0 is told
in the log as "The opponent is dead".

## One game on one board (2026-10-17)

The goldfish board came first (2026-10-12): a session of its own (`session.rs`' `Goldfish`), three
commands (`goldfish_start`, `goldfish_act`, `goldfish_end`), a wire of its own (`GoldfishView`,
`GoldfishAction`, `Happened`) and a board of its own (`GoldfishBoard`). The playtest board
(2026-10-13) borrowed its table pieces and widened them. Two games on one engine kept diverging:
the playtest had prompts, combat and phase-by-phase play, and the goldfish had the sandbox.

**The owner's decisions of 2026-10-17: goldfishing and playtesting are one game on one board.**
The goldfish is a playtest opponent that takes no actions. The three choices that shaped it:

| Question                  | Choice                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| How the goldfish is drawn | **The duel layout**: its band, its face-down hand count, its plate, its zone columns and an empty table, as a single AI opponent is |
| What the sandbox is       | **A setting**, off by default against the AI and on against the goldfish; on, it edits everything the table shows                   |
| How a turn is played      | **One turn flow, the playtest's**: the stage button, prompts for every question, the pick for a discard, the game's turn number     |

**What went away:** "Next turn" (now `pass` and `endTurn`, the stage button's "To combat" in the
first main phase with "End turn" beside it, Space its primary); the `discard` stage and
`DiscardDialog`; `Happened::OpponentTurn`, the goldfish's turn told in one line; counting only the
reader's turns; a spell with a choice of targets put down unpaid; the engine answering a prompt for
the reader while a turn passed. **What came:** combat against the goldfish, and every prompt.

**Where the code went.** `crates/grimoire-play/src/session.rs` is deleted; its card and mana helpers
are `table.rs`, and `view.rs` keeps only the table's shared wire types. The desktop's `goldfish/`
module and its three commands are gone; `playtest_start` takes `opponents: []` for the goldfish, and
there is one slot. In the UI, `lib/ipc/goldfish.ts` is `lib/ipc/table.ts` (`GameCard`, `GameLane`,
`GamePlace`, `GameSeat`), `features/playtesting/goldfish/` is `features/playtesting/table/`, and
`GoldfishBoard`, `DiscardDialog`, `useGoldfishGame` and `play/actions.ts` are deleted.
`features/playtesting/GoldfishPage.tsx` is a thin wrapper over `PlaytestPage`: `opponents: []`, the
plate named "Goldfish", and `returnTo="deck"`, so the way back is the deck editor and the undo
chords are the `goldfish` scope's. The deck editor's "Goldfish this deck" button and the store's
`goldfish` are still the way in.

## The table

`packages/ui/features/playtesting/table/` holds the pieces every seat of the one board is drawn
with: the battlefield (`Battlefield`, `layout.ts`), the hand (`HandFan`), the opening hand
(`OpeningHand`), the zone piles and the library dialog (`ZonePile`, `LibraryDialog`), the life plate
(`LifePlate`), the mana table (`ManaTable`), the preview (`Inspect`), the menus (`menus.ts`), the
drags (`tableDrag.ts`), the landing pop (`landing.ts`), the playmats (`playmats.ts`,
`CommanderMat`), the help and log panels (`Panels.tsx`) and the log's shared pieces (`log.ts`).
Each speaks `PlaytestAction`. `PlaytestBoard` arranges them ([playtest.md](playtest.md#the-board));
the design below is theirs, wherever they are placed.

**Cards are drawn as big as the table allows.** A lane's card size is capped high (260 px for a
creature, 220 for the back row) so a table of a few cards fills its lanes, and the lane's height
and the row's width shrink it as the table fills.

**The opening hand takes the whole board** (issue #993). Before the first turn the seven are the
only thing worth reading, so the mulligan screen is a scrim over everything below the 48 px top
band — the tables, the zones and the reader's plate go under it, and the band (the menu, the
opponents' plates, help and the log) stays above it — and each card is as large as the box allows: the smaller of a seventh of
the row's width (less six 14 px gaps) and its height (less the 28 px a picked card rises into), at
5:7, capped at `display`'s 672 px so nothing is drawn past the largest image the cache stores. The
row is a size container (`cqw`/`cqh`) and holds nothing `fixed`.

**The hand is one straight row**, not a fan. Up to seven cards sit side by side; more overlap so
the row stays the width of seven. The card pointed at is pulled 44 px out of the row and drawn over
its neighbours. Its button never moves, only its face does, and while it is up the strip it rose
into is part of the button. So a lift cannot take the card out from under the pointer, and the
card drops back the moment the pointer leaves it. The kept hand is held lands first, the same order
the opening hand shows. After that, a card drawn or returned goes on the right (`arrangeHand`).

**The preview follows the pointer.** It opens beside the cursor once the pointer has rested on a
card for half a second, and it moves with the pointer, kept inside the board. It closes the moment
the pointer leaves the card, and the next card — or the same one again — is rested on anew. A card
names itself in `data-point`, and the board lets go of a card whenever the pointer moves over
anything else: a card redrawn by another element gets no `mouseleave`. The wheel resizes it, from
200 to 640 px wide, while it is open; the size holds for the rest of the game. Its test id is
`card-inspect`.

**A card that lands pops once.** When a card arrives in a zone it gets a new id (CR 400.7). The
element that draws it names its ids in `data-land`, and the board scales and glows it once
(`landing.ts`, the Web Animations API, off under reduced motion). A step with more than eight new
ids is a deal, not a landing, and nothing pops.

**Playmats.** The game menu's Playmat offers the plain background, five felts and the commander's
art. A felt is a tint mixed into `--color-bg` (`playmats.ts`), so everything drawn for the
background stays readable on it. The commander's art is `CommanderMat`, drawn under everything and
dimmed by a sheet of `--color-bg`, so the cards read against the colour they do on the plain felt.
The board's felt is test id `board-felt`.

**The mana table** (issue #1002) is the mana open by type, above the stage button (`ManaTableView`).
`table.rs`' `mana_table` reads phase's `activatable_mana_options` for each untapped source: a source
counts toward every type it can make, the most of that type one activation adds, capped at its net
yield (`max_mana_yield`). So a dual land is in two columns and the columns sum to more than the mana
open; that is the question a reader asks of a table ("can I cast {W}{W}?"), where the total answers
"how much can I spend". A second row, the pool, is drawn only while mana floats (CR 106.4) —
mid-payment.

**A token wears the deck's printing** (issue #991). The start command reads each deck's tokens with
`grimoire_core::play::deck_tokens`: one printing per token the list keeps, the entry with the most
copies, or the token wall's default for one the reader has not set. `tokens.rs` ties them to
phase's presets by the Scryfall oracle id both name. A token offered in the menu, and a token on the
table however it was made, is drawn in that printing, and phase's preset image only for a token the
deck does not keep. The menu also offers the deck's tokens phase ties to none of its cards, a
hand-added one with no source.

**The log is cut into turns.** Each turn sits under a heading with a rule across it — the game's
turn number, both seats' turns counted — the turn being played in the accent, and each line has a
glyph for its kind (`LogKind`: a draw, a land, a cast). `table/log.ts` keeps the shared pieces (a
line, its kind, the cut into turns, the words for a life total moved by a stepper);
`play/log.ts` words every fact, the goldfish's as any opponent's ("The opponent drew a card", "Put
the opponent's Grizzly Bears into their graveyard").

**The table is laid out by the rules, not by where a card is let go.** Creatures are in front.
Behind them, lands are on the left and every other permanent on the right. Each lane is one row,
and its card size is solved so every pile fits (`layout.ts`). Cards of one name that look the same
— same printing, same tapped state, same counters — are one pile: the cards themselves stacked,
each edged 5 px up and to the right of the one above it, five drawn at most, and a ×N chip on the
pile's bottom edge for the count (issue #1001).

**An attachment is tucked under the card it is attached to** (issue #1073), the way MTG Arena and
a real table show it. `GameCard.attached_to` is the host's object id, read from phase's
`attached_to` (a permanent only: an Aura on a player, a Curse, names nothing and stays in its
lane). `layout.ts`' `attachmentsOf` takes every Aura, Equipment and Fortification out of its lane
and hangs it under its host's pile, each one showing its name bar (`ATTACHED`, 0.16 card-widths)
above the card; a card with attachments is a pile of its own, and `fitWidth` sizes the lane so the
tallest such pile still fits. An attachment on an attachment rides under the card at the bottom of
the chain. One that crosses tables — the reader's Pacifism on the opponent's creature — is drawn on
the host's table (`acrossTables`, the board's `across`), where its edge can be pointed at and its
menu opened but it is not carried off or tapped by a click. The edge is the attachment's own
button: it points, opens its own menu (an Equipment's equip ability is activated there) and is
picked when the rules ask for it on its own table.

**Drags are dnd-kit, as everywhere in the app** (`tableDrag.ts`, `TableDrag`, `useTableDropTarget`,
with a mark of its own, `mtg-grimoire/table-card`). A drop is a zone, never a coordinate, and only
the reader's cards are dragged — an opponent's never:

- from the hand or the command zone onto the table, the card is played (rules first, and unpaid in
  the sandbox when the rules allow nothing) — and only when the pointer itself is on the table
  (`pointerOnly`). A card carried out of the hand overlaps the table's edge long before the pointer
  does, and a drop there was played by accident. **This is the one drop the rules make, so it is
  the only one with the sandbox off**;
- anywhere else, it is a move, the sandbox's, offered only while its moves work (on, the reader's
  main phase, nothing with the engine);
- a pile dragged off the table moves its top card.

**Keys:** Space presses the stage button's primary action (To combat, End turn, the declarations;
it skips a replay while one runs). T, G, E and H tap, bury, exile or return the reader's card under
the pointer — the sandbox's, so only while its moves work. They are off while a field has the caret
or a menu or dialog is open. Space belongs to the board even when a button has the focus: a card
clicked keeps the focus, and Space would press it. Enter still presses a focused card, and that
plays it.

## What is not there yet

- **Mana payment by hand.** Every cast is paid by phase's `Auto`, the goldfish's game as the AI's.
- **Choosing who plays first against the goldfish.** The reader is always on the play.
- **A goldfish that does something** — a blocker, a removal spell now and then — is not a goldfish,
  and is the AI's job ([playtest.md](playtest.md)).
- **The light app.** Playtesting is not a destination there.

The rest of what the one game lacks is [playtest.md](playtest.md#what-is-not-there-yet)'s.

## Licences

phase.rs is **MIT OR Apache-2.0** (`LICENSE-MIT`, `LICENSE-APACHE`), compatible with this
repository's AGPL-3.0-or-later. Its `NOTICE` names the copyright — **"phase.rs, Copyright
2024-2026 phase.rs contributors"** — and MTGJSON (MIT) as the source of its card data. This page
is where the app carries that notice. The app uses no card data of phase's, only its code. Three of
the engine's dependencies are **MPL-2.0**: `im`, `bitmaps` and `sized-chunks`. That is file-level
copyleft, and they are taken unmodified from crates.io, which is compatible. `r-efi` is offered
under MIT, Apache or LGPL, and MIT applies. Everything else is MIT or Apache, with Unicode-3.0 and
Unlicense.
