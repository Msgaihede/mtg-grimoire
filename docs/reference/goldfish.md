# The goldfish board, and the rules engine under it

A **goldfish** is an opponent that does nothing: no spells, no blocks, a life total the player keeps
by hand. Goldfishing a deck shows how fast it does its thing on its own, which hands it keeps, and
which turns it stumbles on. The board is the fish icon button in the deck editor's action bar (lucide `Fish`, named
"Goldfish this deck"), a game of the list
on screen (Actual or Theory), on **phase.rs's MTG rules engine** — the engine the app will also use
when it plays a deck against an AI.

Built 2026-10-12 from the two artboards _Goldfish · opening hand_ and _Goldfish · the table, turn 9_.
The binding rules are in each area's `CLAUDE.md`. This page holds the reasons and the measurements.

## Contents

- [The engine: phase.rs](#the-engine-phasers)
- [Why the pin is a nightly](#why-the-pin-is-a-nightly)
- [The crate: `grimoire-play`](#the-crate-grimoire-play)
- [Card data: parsed from the deck, never downloaded](#card-data-parsed-from-the-deck-never-downloaded)
- [The hybrid model: what is a rule and what is a hand](#the-hybrid-model-what-is-a-rule-and-what-is-a-hand)
- [The goldfish never loses](#the-goldfish-never-loses)
- [The commands and the wire](#the-commands-and-the-wire)
- [The board](#the-board)
- [What is not there yet](#what-is-not-there-yet)
- [Licences](#licences)

## The engine: phase.rs

[phase.rs](https://github.com/phase-rs/phase) is an open-source MTG rules engine in Rust. It covers
turns, priority, the stack, combat, state-based actions, layers, triggers and replacement effects,
and it parses rules text into abilities. It compiles to native code and to WASM. **The app takes one
crate of it for the goldfish: `phase-engine`**, whose library is named `engine`. The AI
(`phase-ai`) was taken next, on 2026-10-13, for the playtest board ([playtest.md](playtest.md)).
phase's other crates (a server, an LLM opponent and a draft) are not linked. It compiled on stable and on `wasm32-unknown-unknown`
in the spike: `choose_action(&GameState, PlayerId, &AiConfig, &mut impl Rng)` takes the same state
this board plays on.

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

| File         | Holds                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `cards.rs`   | `CardFacts` (Scryfall's fields for one deck row) → phase's `CardFace` → a `CardDatabase` of the deck alone        |
| `session.rs` | `Goldfish`: one game, its actions, the passive opponent, the checkpoint                                           |
| `view.rs`    | The wire: `GoldfishView`, `GameCard`, `GoldfishAction`, `Happened`, mirrored in `packages/ui/lib/ipc/goldfish.ts` |
| `lib.rs`     | `on_engine_stack`                                                                                                 |
| `tests.rs`   | A game played end to end on a small Commander deck                                                                |

**Only the desktop links it** (the owner's decision, 2026-10-12). The light app's spec leaves
Playtesting out of the phone and the browser. Through `grimoire-core`, the engine would be several
megabytes of the web module, a module measured to the byte. Its three commands are on
`command_table::DESKTOP_ONLY`. The half that is SQLite — which cards a deck plays with — is
`grimoire_core::play::deck_cards`, like every other read of `deck_cards`.

**Proving `Goldfish: Send` overflowed rustc's default recursion limit** in the desktop crate:
`overflow evaluating the requirement tauri::State<'_, GoldfishSlot> well-formed`, through
`Box<Goldfish>: Send`. `GameState` is deep. `apps/desktop/src-tauri/src/lib.rs` sets
`#![recursion_limit = "256"]`, the bound rustc suggested.

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

The owner's choice of 2026-10-12. The artboards are a free tabletop, and phase has both a rules
path and a sandbox path (`DebugAction`), so each action takes the one a player at a table would.

| By the rules                                                       | By hand (phase's sandbox)                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| The London mulligan and Commander's free first one                 | A drag to any zone                                           |
| Playing a land as the turn's land drop                             | A land past the land drop                                    |
| Casting a spell, paid from untapped mana (`CastPaymentMode::Auto`) | A card that cannot be paid for                               |
| Commander tax                                                      | Tapping and untapping                                        |
| The turn: untap, upkeep, draw; the goldfish's turn passing         | Counters, token copies, preset tokens                        |
| P/T with counters and statics; the mana open                       | Life totals, draws, mills and shuffles outside the draw step |

**A play is rules first, then by hand.** `Play` is a double-click or a drop from the hand or the
command zone onto the table. It looks for the one legal `PlayLand` or `CastSpell` for that card:

- **Exactly one:** it is played. phase lists a cast once per way to make it (a target, a mode), so
  one row means nothing is left to decide.
- **None, or two or more:** the card is put where it would have gone, unpaid — a permanent onto
  the battlefield, an instant or sorcery into the graveyard. `Happened::Put` says so, and the log
  reads "Cast Swords to Plowshares · not paid for". Taking the first of two ways would be choosing
  a target for the reader.

**The checkpoint is what makes the fallback honest.** `GameState` is persistent (`im`), so a clone
is cheap. The rules path runs on the real state. The moment the engine asks the reader anything but
"pass?" (a target, a "may"), the state goes back to the clone and the card is placed by hand
instead, so the game never holds half a cast.

**A commander put down unpaid still raises its tax.** The reader cast it; they only skipped
paying. `record_commander_cast` is called on that path too.

**A question the engine asks while a turn passes takes its first answer.** An example is an
upkeep trigger's target. `Happened::Chose` says so, and the log reads "The rules engine answered
a … prompt for you". It is the one place the engine decides for the reader, because by then the
thing that caused it cannot be taken back the way a cast can.

**The discard to hand size is the exception: the reader chooses it.** A turn passed with more
cards in hand than the maximum hand size stops at the reader's cleanup step
(`WaitingFor::DiscardToHandSize`, CR 514.1). The view says `stage: "discard"` and how many cards
are owed (`discard`), and every action but `Discard { ids }` is refused until it is answered. The
board opens `DiscardDialog` over the table; closing it shows the table, and "Discard N" (where
"Next turn" was) or Space opens it again. `Discard` then runs the same turn on to the reader's
next main phase. Until 2026-10-13 this question took the engine's first answer too, which was
always the cards drawn last. The count is the engine's, so a card that changes the maximum hand
size changes it. The goldfish's own discard (it draws a card a turn and plays none) still takes
the first answer.

## The goldfish never loses

The goldfish's library is 200 copies of `Goldfish Scale`, a synthetic land that does nothing.

At the start, the session grants the goldfish a command-zone emblem with phase's
`StaticMode::CantLoseTheGame` and no `affected` filter. `sba::static_affects_player` reads no
filter as "every player" (CR 104.3b). So neither seat loses at 0 life or to an empty library, and a
life total set to 0 is a number on the board, not the end of the game. The board says "Opponent ·
dead on turn N" with a gold edge, and the game goes on until the reader deals another. The emblem
is never shown.

## The commands and the wire

| Command                                  | Does                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `goldfish_start(deck_id, variant, seed)` | Reads the deck (`play::deck_cards`), deals a game, and answers the view at the opening hand. A fresh game replaces any other. |
| `goldfish_act(action)`                   | One `GoldfishAction`, answered with `{ view, happened }`. A refusal is one sentence and leaves the game exactly as it was.    |
| `goldfish_end()`                         | Drops the game.                                                                                                               |

**One game at a time, in a slot.** `GoldfishSlot` is Tauri-managed state, `Empty | Busy | Game`.
An action takes the game out of the slot onto the engine's thread and puts it back after, so a
second call while one runs is told the engine is busy rather than waiting. If the engine panics,
the game is lost and the slot empties.

**The view is sent, never the state.** The whole `GameState` is hundreds of kilobytes. The view is
what a board draws: each zone's cards, the lives, the mana open, the library, and the tokens the
deck makes. The library goes top first, because the board shows it when the reader asks to look.

**An object's id changes when it changes zone** (CR 400.7), so the page keeps an id only as long as
the view it came from. The page sends actions one at a time, in order, for that reason
(`useGoldfishGame`). A printing follows its card across a zone change: the session hands it to the
one object of that name that has none.

**A token wears the deck's printing** (issue #991). The start command reads the deck's tokens with
`grimoire_core::play::deck_tokens`: one printing per token the list keeps, the entry with the most
copies, or the token wall's default for one the reader has not set. `crates/grimoire-play`'s
`tokens.rs` ties them to phase's presets by the Scryfall oracle id both name. A token offered in
the menu, and a token on the table however it was made, is drawn in that printing, and phase's
preset image only for a token the deck does not keep. The menu also offers the deck's tokens phase
ties to none of its cards, a hand-added one with no source.

**Facts, not sentences.** `Happened` is which card went where and how. `features/playtesting/
goldfish/log.ts` writes the log's lines. `ipc.test.ts` reads `view.rs` and holds every variant and
field of `GoldfishAction` and `Happened` against the TypeScript unions, beside its usual
struct-for-interface walk.

## The board

`packages/ui/features/playtesting/goldfish/`. `GoldfishPage` is the Decks view's third state: the
store's `goldfish` names the open deck and variant, and `App.tsx` draws the board in the editor's
place. Every navigation clears it, so coming back to a deck finds the editor. The page covers the
whole window below the caption at `LAYER.stage`, a new rung between `header` and `popup`, so the
board's own menus and dialogs open over it. Escape is the way back.

`GoldfishBoard` is presentational: a view in, actions out, no `ipc`. That is what its stories stand
on. The artboard's fixed places are measured from the board's box, not from its 1440 × 900 frame:

- the table is inset 224 px from either side, 92 px from the top and 108 px from the bottom;
- the zone columns sit 22 px in, level with the table's top, each card 180 × 252 (the artboard's
  104 × 146, grown — large enough to read a commander's name and art without the preview);
- the plates and the hand are at the foot.

**Cards are drawn as big as the table allows.** A lane's card size is capped high (260 px for a
creature, 220 for the back row) so a table of a few cards fills its lanes, and the lane's height
and the row's width shrink it as the table fills.

**The opening hand takes the whole board** (issue #993). Before the first turn the seven are the
only thing worth reading, so the mulligan screen is a scrim over everything below the top band —
the zones and the reader's plate go under it, the menu, the goldfish's life, help and the log stay
raised above it — and each card is as large as the box allows: the smaller of a seventh of the
row's width (less six 14 px gaps) and its height (less the 28 px a picked card rises into), at 5:7,
capped at `display`'s 672 px so nothing is drawn past the largest image the cache stores. The row
is a size container (`cqw`/`cqh`) and holds nothing `fixed`. The playtest board hands it the same
box below its 48 px band.

**The hand is one straight row**, not a fan. Up to seven cards sit side by side; more overlap so
the row stays the width of seven. The card pointed at is pulled 44 px out of the row and drawn over
its neighbours. Its button never moves, only its face does, and while it is up the strip it rose
into is part of the button. So a lift cannot take the card out from under the pointer, and the
card drops back the moment the pointer leaves it. The kept hand is held lands first, the same order the
opening hand shows. After that, a card drawn or returned goes on the right (`arrangeHand`).

**The preview follows the pointer.** It opens beside the cursor once the pointer has rested on a
card for half a second, and it moves with the pointer, kept inside the board. It closes the moment
the pointer leaves the card, and the next card — or the same one again — is rested on anew. A card
names itself in `data-point`, and the board lets go of a card whenever the pointer moves over
anything else: a card redrawn by another element gets no `mouseleave`. The wheel resizes it, from 200 to 640 px wide, while it is open; the
size holds for the rest of the game.

**A card that lands pops once.** When a card arrives in a zone it gets a new id (CR 400.7). The
element that draws it names its ids in `data-land`, and the board scales and glows it once
(`landing.ts`, the Web Animations API, off under reduced motion). A step with more than eight new
ids is a deal, not a landing, and nothing pops.

**Playmats.** The game menu's Playmat offers the plain background, five felts and the commander's
art. A felt is a tint mixed into `--color-bg` (`playmats.ts`), so everything drawn for the
background stays readable on it.

**The log is cut into turns.** Each turn sits under a heading with a rule across it. The turn being
played is in the accent, and each line has a glyph for its kind (`LogKind`: a draw, a land, a cast).

**The log tells the goldfish's side too** (issue #1026). The goldfish plays its own turn: it
draws, plays nothing, and discards down to seven (it keeps seven, so from its first turn on that
is one card a turn). The session counts its draws and discards from the engine's events and says
the turn once, as it ends (`Happened::OpponentTurn`): "The opponent drew a card, discarded one and
passed". That line is filed under the reader's turn it followed: `linesFor` puts what came before
a `turnBegan` under the turn before it. A life total the rules change — a drain, a gain, either
seat's — is `Happened::Life` ("The opponent took 2, down to 38"), as against one the reader set
by hand (`LifeSet`). The playtest board's log already told every seat's doing, from phase's
events (`playtest/session.rs`' `tell`).

**The table is laid out by the rules, not by where a card is let go.** Creatures are in front.
Behind them, lands are on the left and every other permanent on the right. Each lane is one row,
and its card size is solved so every pile fits (`layout.ts`). Cards of one name that look the same
— same printing, same tapped state, same counters — are one pile, edged 3 px a card underneath
and marked ×N.

**Drags are dnd-kit, as everywhere in the app** (`goldfishDrag.ts`, with a mark of its own). A drop
is a zone, never a coordinate:

- from the hand or the command zone onto the table, the card is played (rules first) — and only
  when the pointer itself is on the table (`pointerOnly`). A card carried out of the hand overlaps
  the table's edge long before the pointer does, and a drop there was played by accident;
- anywhere else, it is a move;
- a pile dragged off the table moves its top card.

**Keys:** Space for the next turn; T, G, E and H tap, bury, exile or return the card under the
pointer. They are off while a field has the caret or a menu or dialog is open. Space belongs to the
board even when a button has the focus: a card clicked keeps the focus, and Space would press it.
Enter still presses a focused card, and that plays it.

## What is not there yet

- **Attacking.** The goldfish's life is the reader's to lower. The turn passes through combat with
  no attackers declared. Declaring attacks against the goldfish is phase's `DeclareAttackers`, and
  the next step.
- **A prompt for the engine's questions** — targets, modes, "may" — so a spell that needs one can
  be cast rather than placed. phase's `WaitingFor` has every one of them.
- **Phase-by-phase play.** A turn is "Next turn": end step, the goldfish's turn, then the reader's
  untap, upkeep and draw, and stop at the main phase.
- **The AI opponent** is not the goldfish's: a game against phase's AI is the Playtesting page's,
  [playtest.md](playtest.md).
- **The light app.** Playtesting is not a destination there.

## Licences

phase.rs is **MIT OR Apache-2.0** (`LICENSE-MIT`, `LICENSE-APACHE`), compatible with this
repository's AGPL-3.0-or-later. Its `NOTICE` names the copyright — **"phase.rs, Copyright
2024-2026 phase.rs contributors"** — and MTGJSON (MIT) as the source of its card data. This page
is where the app carries that notice. The app uses no card data of phase's, only its code. Three of the engine's dependencies are
**MPL-2.0**: `im`, `bitmaps` and `sized-chunks`. That is file-level copyleft, and they are taken
unmodified from crates.io, which is compatible. `r-efi` is offered under MIT, Apache or LGPL, and
MIT applies. Everything else is MIT or Apache, with Unicode-3.0 and Unlicense.
