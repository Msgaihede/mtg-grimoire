# Playtesting against phase.rs's AI

A **playtest** is a game of the reader's deck against another of their decks, the opponent's seat
played by **phase.rs's AI** (`phase-ai`). It runs on the same rules engine as the goldfish board,
and its board is the goldfish's, with the opponent's half drawn above it, turned around.

Built 2026-10-13. The owner's four choices that shape it:

| Question                 | Choice                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Who plays the opponent   | phase-ai, at a difficulty the reader picks                                                                                                 |
| How strict the rules are | The rules decide, with a prompt for targets, modes and the rest. The goldfish's sandbox stays on the reader's own cards as an escape hatch |
| Where a game starts      | The Playtesting page: your deck, the opponent's deck (any of your own), a difficulty                                                       |
| Priority                 | Arena-style auto-pass: the reader decides only in their main phases, in combat, and when the engine asks                                   |

The engine, the nightly pin, the 16 MiB stack and the licences are [goldfish.md](goldfish.md)'s.
The binding rules are in [`crates/grimoire-play/CLAUDE.md`](../../crates/grimoire-play/CLAUDE.md).

## Contents

- [The AI](#the-ai)
- [The session: playing on until the reader decides](#the-session-playing-on-until-the-reader-decides)
- [Prompts](#prompts)
- [Casting, cancelling and the sandbox](#casting-cancelling-and-the-sandbox)
- [What the reader may see](#what-the-reader-may-see)
- [The commands and the wire](#the-commands-and-the-wire)
- [The setup page](#the-setup-page)
- [The board](#the-board)
- [What is not there yet](#what-is-not-there-yet)

## The AI

`phase-ai` comes from the same repository and the same `rev` as `phase-engine`. The two move
together, because the AI reads the engine's `GameState`. Its licence is the engine's, MIT OR
Apache-2.0. It adds `mimalloc` on native targets, but only as a dependency: the library never sets
the global allocator. Only phase's own binaries do.

The session drives it the way phase's own server does: `auto_play::run_ai_actions` takes every
decision the AI seat can take now, in one batch, on a per-game `AiSession`. That session is phase's
analysis of both decks, and it is built the first time the AI decides. The config is
`create_config_for_players(difficulty, Native, 2)`. The wire offers phase's five presets, from
`veryEasy` to `veryHard`. Its sixth preset, cEDH, is a four-player Commander preset and is left out.

**The dice are seeded.** The AI's `ChaCha8Rng` is seeded from the game's seed, XORed with a
constant so that it is not the shuffle's own stream. The same seed and decks play the same game,
and the session's tests rely on that. The seed's lowest bit is the coin flip: even, the reader
plays first.

**Measured** (debug build, this container, 2026-10-13): a Medium AI's keep and first turn took
1.8 s. The crate's fourteen playtest tests, six AI turns among them at VeryEasy, ran in about 4 s
together. Medium and above search with phase's 1.5 s budget a decision, so a long AI turn takes
seconds. The board says "Opponent is thinking…" meanwhile.

## The session: playing on until the reader decides

`crates/grimoire-play/src/playtest/session.rs`. After every action, and once at the deal,
`advance` plays on by itself:

1. If the game is over, it stops.
2. If the AI can act, it runs the AI's batch and loops.
3. Otherwise the reader is the one to act, and it is decided by what the engine waits on:
   - **The opening hand.** It stops.
   - **Priority.** It stops in the reader's own main phase (first or second) with an empty stack.
     Anywhere else it passes for the reader: upkeep, draw, the AI's whole turn, a spell of
     either seat's resolving.
   - **Declare attackers.** It stops, unless the reader has no creature that can attack, or the
     turn is being ended (`endTurn`).
   - **Declare blockers.** It stops, unless the reader has no creature that can block.
   - **Anything else** is a question for the reader. It stops, as a prompt.

That gives the six `PlaytestStage`s: `mulligan`, `main`, `attack`, `block`, `prompt` and `over`. A
step limit of 2000 passes for one action stops a loop in the engine or the AI from hanging the
board. A game never reaches it.

**`pass` and `endTurn`.** `pass` in the first main phase goes on to combat, so it stops at
declare attackers if there is a creature to attack with, and at the second main phase otherwise.
`pass` in the second main phase ends the turn, plays the AI's turn, and stops at the reader's next
decision. `endTurn` skips both: the rest of the reader's turn is passed with no attack.

**Commander.** A commander on either side makes the game a Commander game: 40 life, the command
zone and tax. Without one, the format is phase's `freeform` at 20 life.

**The first turn's start is told by the session.** phase begins turn 1 inside `start_game`, before
the hands are kept, and that event is never returned. The keep inserts `turnBegan` for turn 1, so
the log opens on the right turn. While the hands are being decided, the view's `turn` is 0, even
though phase already counts 1.

## Prompts

phase has well over a hundred kinds of question (`WaitingFor`). Each one's answers are its legal
actions, so **a prompt is the question's name and its legal answers**. The answers are read
generically, never matched variant by variant.

- `kind` is phase's `WaitingFor` variant name, such as `TargetSelection`, `ModeChoice` or
  `DiscardChoice`. The page puts the common ones in words and splits any other at its capitals.
- Each option is one `GameAction`, described by the facts in its JSON data (`option_of`):
  - the cards and players it names, read from a handful of field names: `object_id`, `targets`,
    `target`, `cards`, `keep` and the like, where a target is `{"Object": id}` or `{"Player": id}`;
  - a number (`value`, `index`, `ability_index`, the first of `indices`), which is 0-based;
  - a yes or no (`accept`, `pay`, `top`);
  - a named choice's word (`choice`).

  An answer of a kind the board has never seen still shows what it points at.

- **`auto`** answers any prompt with `phase_ai::choose_action` for the reader, at Medium.
  `Happened::Chose` says so. It is also the answer to a prompt with no options the board can draw.
- A card named alone by an option lights up on the table, and clicking it answers.

**The board's own questions.** phase lists a cast once per way to make it, for example one
`CastSpell` per target set. So a `play` with several ways becomes a `CastChoice` prompt, and an
`activate` with several abilities becomes an `AbilityChoice` prompt. These are held by the session
(`BoardChoice`): nothing has happened yet, and `cancel` simply drops them. Some spells instead come
as one cast followed by phase's own `TargetSelection`. To the reader, the two read the same.

## Casting, cancelling and the sandbox

**`play`** takes the one legal `PlayLand` or `CastSpell` for that card. When the rules allow none
(no land drop left, too little mana, nothing to target), **it is refused with a sentence**, unlike
the goldfish, which puts the card down unpaid. Putting a card down unpaid against an opponent would
be cheating it. Payment is phase's `Auto`, from untapped mana.

**`activate`** takes every legal action of a permanent's: an ability, equip, crew, station,
saddle, transform, turn face up. These are found by the source field in the action's data
(`names_source`). Mana abilities are not on the list, since a cast pays its own mana.

**A cast can be taken back until it is on the stack.** `play`, `activate` and an answer to a board
question each keep a checkpoint (`Pending`) while the engine asks the reader how to make the cast.
`cancel` restores it. The first time priority is passed with the spell on the stack, the
checkpoint is dropped: the spell is cast, and the AI may already be answering it.

**The sandbox** is the goldfish's set of actions, on the reader's own cards only and in their main
phase only, where nothing is half done: move a card anywhere by hand, tap, counters, token copies,
preset tokens, draw, mill, shuffle and life totals. It is phase's debug actions. The engine permits
them for the reader's seat (`debug_permitted`) and never for the AI's. The AI may well notice: it
reads the state as it is.

**A refused action changes nothing**, as on the goldfish: `act` restores its checkpoint on any
`Err`.

## What the reader may see

The opponent's hand and library are **counts** (`handCount`, `library`). Their `hand` and
`libraryCards` are always empty on the wire. An opponent's draw is `drew` with no name, and a card
going back from their hand to their library is not told at all. The AI itself reads the whole
`GameState`. Whether it plays as if it knows the reader's hand is phase's business, not this
board's.

## The commands and the wire

| Command                                                                                  | Does                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `playtest_start(deck_id, variant, opponent_deck_id, opponent_variant, difficulty, seed)` | Reads both decks (`play::deck_cards`), deals, and answers with a `PlaytestStep` at the reader's opening hand. A fresh game replaces any other. |
| `playtest_act(action)`                                                                   | One `PlaytestAction`, and everything the AI does after it until the reader next decides. A refusal is one sentence.                            |
| `playtest_end()`                                                                         | Drops the game.                                                                                                                                |

**The goldfish's slot arrangement, in a slot of its own** (`PlaytestSlot`: `Empty | Busy | Game`).
A goldfish game and a playtest can be held at once. A call while the AI is thinking is told "The
opponent is still thinking." All three commands are on `command_table::DESKTOP_ONLY`.

**The wire** is `playtest/view.rs` ↔ `packages/ui/lib/ipc/playtest.ts`. It reuses the goldfish's
`GameCard`, `MulliganView`, `TokenOffer`, `Place` and `Seat`, so the goldfish's table pieces draw
both boards. `ipc.test.ts` holds every struct field for field, every `PlaytestAction` and
`PlaytestHappened` variant and field, and the three string unions (`PlaytestStage`,
`PlaytestPhase`, `Difficulty`).

**Facts come from phase's events** (`tell`). Each applied action returns `GameEvent`s, and so does
each of the AI's actions. They become the log's facts:

| Event                                    | Fact                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `TurnStarted`                            | `turnBegan`                                                                                          |
| `LandPlayed`                             | `played`                                                                                             |
| `SpellCast`                              | `cast`                                                                                               |
| `AbilityActivated` (not mana)            | `activated`                                                                                          |
| `ZoneChanged`                            | `moved`, or `drew` (library to hand). A move to or from the stack is the cast, and is not told again |
| `AttackersDeclared` / `BlockersDeclared` | `attacked` / `blocked`                                                                               |
| `DamageDealt` to a permanent             | `dealt` (damage to a player is its `LifeChanged`)                                                    |
| `LifeChanged`                            | `life` (a delta)                                                                                     |
| `TokenCreated`                           | `tokensCreated`, with consecutive tokens of one name counted together                                |

A sandbox action's events are not told. The action's own fact says what the reader did.

**A printing follows its card.** phase keeps an object's id across zones and bumps its
`incarnation`. The session still re-homes a printing whose object is gone, by seat and name
(`follow_printings`), so a deck's second art stays on its card wherever the card goes.

## The setup page

`packages/ui/features/playtesting/PlaytestSetup.tsx`, under the Playtesting rail entry. It has one
`Dropdown` per seat, listing the decks that are not archived, with the format as the hint. A deck
with a plan offers a Theory / Actual pair, in the editor's order. Difficulty is a five-button group,
from "Very easy" to "Very hard", and starts on Medium. Start is `aria-disabled` until both decks are
picked. The same deck on both sides is allowed, and labelled "A mirror match." The last picks are
kept for the window's life in `viewMemory("playtesting.setup")`, never in storage.

## The board

`packages/ui/features/playtesting/play/`. `PlaytestPage` covers the window below the caption at
`LAYER.stage`, as the goldfish's page does, and Escape goes back to the setup page.
`PlaytestBoard` is presentational: a view in, actions out. `usePlaytestGame` is
`useGoldfishGame`'s serial queue.

**The opponent's half is the reader's, turned around.** The measurements below are from the
board's box, and the board fits a 1280 × 800 window (a 766 px board):

- **The opponent's band** is the top 72 px: their face-down hand (56 × 78 backs, 40 px showing,
  "Hand · N"), their life plate, and the chrome.
- **The reader's foot** is the bottom 108 px, as on the goldfish: the hand, the life plate, and the
  stage button.
- **The middle line** is 36 px high, centred. It shows "Turn 5 · Your main phase", the combat
  ("You attack with 2 · 1 blocked"), the stack as chips (top first, gold edge for the reader's, red
  for the opponent's), and the newest log line or the engine's refusal.
- **The two tables** share the rest equally, each inset 112 px from either side. On the opponent's
  table the creature lane is nearest the middle line and the back row is at the top.
- **The zone columns** sit 16 px in, with 80 × 112 cards (the goldfish's are 180 × 252). The
  opponent's side has library over graveyard on the left and exile over command on the right. The
  reader's side has command over exile on the left and graveyard over library on the right.

**The stage button**, bottom right. Space presses its primary action.

| Stage                     | Primary                                                                                       | Also                 |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `main`, first main phase  | To combat (`pass`)                                                                            | End turn (`endTurn`) |
| `main`, second main phase | End turn (`pass`)                                                                             |                      |
| `attack`                  | Attack with N, or No attack                                                                   |                      |
| `block`                   | Confirm blocks, or No blocks                                                                  |                      |
| busy                      | A spinner and "Opponent is thinking…"                                                         |                      |
| `over`                    | A centred banner ("You won", "You lost", "Draw"; "On turn N") with New game and Back to setup |                      |

**Interactions.**

- **Your cards** work as on the goldfish, plus "Activate ability" at the head of a battlefield
  card's menu.
- **The opponent's cards** can be pointed at for the preview, and their graveyard and exile open
  read-only. They cannot be dragged, tapped or right-clicked, and their table takes no drops.
- **Attack:** a click toggles an eligible creature. An attacker gets a red ring and moves 14 px
  toward the middle.
- **Block:** click your blocker (a gold ring), then an attacker it can block. Both get the same
  number. Click an assigned blocker again to remove it.
- **Prompt:** the panel floats bottom right and is not modal, so the table stays inspectable.
  Hovering a row previews its card. "Let the engine choose" is always offered, and "Cancel" is
  offered when the question came out of the reader's own cast. A card that an option names alone
  lights up on the table.
- **Picks reset** with every new view.

**The goldfish's pieces, widened rather than copied.** Several goldfish components gained optional
props. When those props are absent, the goldfish draws exactly as before.

- `Battlefield`: `flipped`, `readOnly`, `marks` (attack, block or chosen, with a badge), `pick`,
  and `onActivate`.
- `layoutTable` and `pilesOf`: an `apart` key, so an attacking creature does not join a pile with
  its untouched twin.
- The zone components: a `size`.
- `useGoldfishDropTarget`: `refuse`.
- `LibraryDialog`: `opponent`, for a read-only look.
- `cardMenu`: `onActivate`.
- `HelpPanel`: its content.

The views these pieces take are narrowed to `Pick<…>`s of the fields they read, so a
`PlaytestSeat` fits where a `GoldfishView` did.

## What is not there yet

- **Holding priority.** The reader cannot answer the AI's spell, or pump a blocker after blocks;
  auto-pass passes those windows. phase's `auto_pass_recommended` and its phase stops are the way
  in.
- **Attacking a planeswalker or a battle.** Every attacker attacks the opponent.
- **Choosing who plays first.** It is the seed's coin flip.
- **Mana payment by hand.** Every cast is paid by phase's `Auto`.
- **A rich prompt for multi-card picks.** A scry, a "choose any number" or a split is offered as
  the engine enumerates it, or left to `auto`.
- **The light app.** Playtesting is not a destination there.
