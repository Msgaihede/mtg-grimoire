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
   - **Priority.** It stops where `stops_here` says (below). Anywhere else it passes for the
     reader.
   - **Declare attackers.** It stops, unless the reader has no creature that can attack, or the
     turn is being ended (`endTurn`).
   - **Declare blockers.** It stops, unless the reader has no creature that can block.
   - **Anything else** is a question for the reader. It stops, as a prompt.

That gives the stages a step can end on: `mulligan`, `main`, `attack`, `block`, `respond`,
`prompt` and `over`. The eighth, `watching`, is a replay frame's only. A step limit of 2000 passes
for one action stops a loop in the engine or the AI from hanging the board. A game never reaches
it.

### Where the reader gets priority: smart stops and toggles

The owner's choice of 2026-10-13, Arena's arrangement. With priority, the reader is stopped:

| Where                                                      | Stage     | When                                 |
| ---------------------------------------------------------- | --------- | ------------------------------------ |
| Their own main phase, the stack empty                      | `main`    | Always                               |
| A step they asked to stop at (`setStops`), the stack empty | `respond` | Once per step                        |
| The opponent's spell or ability on top of the stack        | `respond` | If they have something they could do |
| Combat, once blockers are declared, the stack empty        | `respond` | If they have something they could do |

"Something they could do" is phase's `has_meaningful_priority_action`: a spell or ability other
than a mana ability. Without one there is nothing to decide, and the stop would only cost a click.
**The reader's own spell on top never stops them**: it resolves, as on Arena.

**The stops** are `PlaytestStop { seat, step }`, a step of either seat's turn: upkeep, draw, first
main, beginning of combat, after attackers, after blockers, damage, second main or end. They are
set as a whole by `setStops`, at any stage, and come back in `view.stops`. "Once per step" is
`stopped_at`: passing at a stop does not stop there again when priority comes back in the same
step.

**`pass` and `endTurn`.** `pass` passes priority once. In the first main phase it goes on to combat,
so it stops at declare attackers if there is a creature to attack with, and at the second main
phase otherwise. In the second main phase it ends the turn and plays the AI's. `endTurn`, from
`main` or `respond`, passes until the turn changes: on the reader's turn with no attack and both
main phases passed, and on the opponent's turn with no response or step stop. A block or a
question still stops it. `view.endingTurn` says it is running.

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

**A pick: the answer that is a set of cards.** For a scry of three, `legal_actions` offers four
answers (none, all, each card alone), and there are sixteen. So for the questions whose answer is
a set of cards, the prompt carries a `pick` beside its options (`Playtest::pick`): the cards, which
of them may be picked, a minimum and a maximum, and whether order counts. `pickCards` answers it.
The answer is `SelectCards`, or `SelectTargets` for `ChooseObjectsSelection`. The meaning of the
picked cards is phase's:

| Question                                         | `purpose` | The picked cards                                            | Count                                               |
| ------------------------------------------------ | --------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `ScryChoice`                                     | `scry`    | Stay on top, first picked on top; the rest go to the bottom | 0 to all, ordered                                   |
| `SurveilChoice`                                  | `surveil` | Stay on top, in order; the rest go to the graveyard         | 0 to all, ordered                                   |
| `DiscardChoice`, `DiscardToHandSize`             | `discard` | Are discarded                                               | `count`, or up to it                                |
| `SearchChoice`                                   | `search`  | Are found                                                   | `count`, or up to it when a partial find is allowed |
| `DigChoice`                                      | `dig`     | Are kept, from `selectable_cards`                           | `keep_count`, or up to it                           |
| `ChooseFromZoneChoice`, `ChooseObjectsSelection` | `choose`  | Are chosen                                                  | as the question says                                |
| `RevealChoice`                                   | `reveal`  | Is revealed                                                 | one, or none when optional                          |
| `MultiTargetSelection`                           | `targets` | Are the targets                                             | `min_targets` to `max_targets`                      |

The session checks the count, that each card is eligible and that none is picked twice. The engine
checks the rest (a search's "different names", say), and its refusal is the sentence shown. This
is the one place the session reads question kinds by name, because their fields say how many
cards are wanted and the generic options cannot. Any other question is still its options, and
`auto` still answers every one.

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
reads the state as it is. Tokens wear each deck's own printings, both seats', as on the goldfish
(`goldfish.md`, _A token wears the deck's printing_).

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
| `DamageDealt` to a permanent             | `dealt`, naming the permanent by id and seat (damage to a player is its `LifeChanged`)               |
| `LifeChanged`                            | `life`: the change and the total after it                                                            |
| `TokenCreated`                           | `tokensCreated`, with consecutive tokens of one name counted together                                |

A sandbox action's events are not told. The action's own fact says what the reader did.

**Replay frames.** A step's `frames` are the table after each thing worth showing on the way: each
of the AI's decisions that the log tells, and each of the reader's auto-passes that led somewhere
(a spell resolving, combat damage). Each frame is a view with the stage `watching` and no prompt,
attack or block offered, so whose question it was stays hidden. The opponent's hand stays a count.
An AI decision's frame is drawn from the state phase hands back with it (`AiActionResult.state`):
it is swapped into the session for the view and straight back out, two pointers for persistent
state. A step answers with at most 80 frames, and the final `view` comes after them.

**Attacks name what they attack.** `attack` takes `{ attacker, target }` pairs: `target` is a
planeswalker's or a battle's id, or `null` for the opponent. In the attack stage, each attacker's
`targets` come from phase's per-attacker map (`valid_attack_targets_by_attacker`), falling back to
the step's aggregate list. The combat view's `attacks` give every attacker's target, both seats',
so the board can draw arrows.

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

**The opponent's half is the reader's, turned around.** The cosmetic overhaul of 2026-10-13
gave the tables most of the height: the chrome is thinner and the zone columns narrower. Measured
in Storybook's Chromium, from the board's box:

|                   | 1280 × 800 window (766 px board) | 1440 × 900 window (866 px board) |
| ----------------- | -------------------------------- | -------------------------------- |
| The opponent band | 48 px                            | 48 px                            |
| The middle line   | 28 px                            | 28 px                            |
| The reader's foot | 112 px                           | 112 px                           |
| Each table        | 289 px                           | 339 px                           |
| A card on a table | 70 × 98                          | 88 × 123                         |

Before the overhaul, a table at 1280 was 275 px and its cards about 61 px wide.

- **The opponent's band** holds their face-down hand ("Hand · N"), their life plate, and the
  chrome.
- **The tables** are inset 96 px from either side. On the opponent's table the creature lane is
  nearest the middle line and the back row is at the top.
- **The zone columns** sit 12 px in, with 72 × 101 cards (the goldfish's are 180 × 252; 60 × 84 until issue #992 grew them a fifth), each zone's count on its card. On the
  opponent's side, library over graveyard is on the left and exile over command on the right. On
  the reader's side, command over exile is on the left and graveyard over library on the right.
- **The stack** is real cards (52 × 73, up to three, then "+N") in the right gutter between the
  zone columns, top first, with whose each is. It covers no table.
- **The prompt** docks at the bottom over the hand, at most 640 × 104, and the reader's plate moves
  to the edge while it is up. **The picker** sits centred over the middle, up to 820 px wide.

**The middle line** is a turn tracker: Beginning · Main 1 · Combat · Main 2 · End, the current
phase lit in the active seat's colour, and a caption that names the step, such as "Turn 6 ·
Opponent's turn · Upkeep — you may respond". Beside it is the Stops button.

**The plates.** The active seat's plate has a gold glow, and poison shows as a chip when it is
above 0.

**Combat is drawn.** Arrows run from each attacker to what it attacks (the plate for a player, the
card for a planeswalker or battle) and from each blocker to its attacker. The reader's attacks are
gold, the opponent's red, and blocks a dashed blue. They are measured from the DOM
(`[data-table] [data-point]`, `[data-plate]`) on every view, 220 ms later, and on a resize. An
attacker is ringed, slid 14 px toward the middle, lifted and shadowed.

**Damage and life pop.** A `dealt` pops "−N" over the permanent it names (`targetId` on `seat`'s
battlefield), and a `life` pops "−N" in red or "+N" in green by that seat's plate. The pops use the
Web Animations API and are off under reduced motion. A creature the damage killed is already gone
from the view, and pops nothing.

**The AI's turn is replayed.** A step's `frames` play one by one, 450 ms apart, before the board
settles on the step's view. The pops fire as each frame lands, and the board is read-only meanwhile.
Skip (the chip, Space or Escape — Escape skips rather than leaving while a replay runs) jumps to the
end. Under reduced motion the end is shown at once. The log takes every fact once: each frame's
facts are found as a run of `step.happened`, and the end takes the rest.

**The stage button**, bottom right. Space presses its primary action.

| Stage                     | Primary                                                                                       | Also                  |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| `main`, first main phase  | To combat (`pass`)                                                                            | End turn (`endTurn`)  |
| `main`, second main phase | End turn (`pass`)                                                                             |                       |
| `respond`                 | Pass (`pass`)                                                                                 | Pass turn (`endTurn`) |
| `attack`                  | Attack with N, or No attack                                                                   |                       |
| `block`                   | Confirm blocks, or No blocks                                                                  |                       |
| busy                      | A spinner and "Opponent is thinking…" ("Passing turn…" while `endTurn` runs)                  |                       |
| `over`                    | A centred banner ("You won", "You lost", "Draw"; "On turn N") with New game and Back to setup |                       |

**Interactions.**

- **Your cards** work as on the goldfish, plus "Activate ability" at the head of a battlefield
  card's menu. In `respond`, the hand and the abilities are playable as in the main phase; the
  sandbox is not.
- **The opponent's cards** can be pointed at for the preview, and their graveyard and exile open
  read-only. They cannot be dragged, tapped or right-clicked, and their table takes no drops.
- **Attack:** a click toggles a creature that can only attack the opponent. A creature with
  planeswalkers or battles to choose from attacks the player by default (else its first target)
  and waits to be aimed. While it waits, its targets light up (the opponent's plate too, when it
  can attack the player), and a click on one aims it. Clicking it again while it waits removes it,
  and clicking it later aims it again.
- **Block:** click your blocker (a gold ring), then an attacker it can block. Both get the same
  number. Click an assigned blocker again to remove it.
- **Stops:** the Stops button opens a row of step toggles for each seat's turn, Arena-style. Each
  toggle sends the whole set (`setStops`). The reader's own main phases are drawn as fixed on.
- **Prompt:** the docked panel is not modal, so the table stays inspectable. Hovering an answer
  previews its card. "Let the engine choose" is always offered, and "Cancel" is offered when the
  question came out of the reader's own cast. A card that an option names alone lights up on the
  table.
- **Picker:** a `pick` opens the cards at 92 × 129, with a counter ("2 of up to 3"). Confirm stays
  `aria-disabled` until the count is within the pick's bounds. An ordered pick numbers its cards;
  scry sorts into "Keep on top" and "Bottom", surveil into "Top" and "Graveyard". Cards that may
  not be picked are dimmed. "Look at the table" folds the panel, "Other answers" shows the generic
  options, and "Let the engine choose" and Cancel stay.
- **Picks reset** with every new view.

**The goldfish's pieces, widened rather than copied.** Several goldfish components gained optional
props. When those props are absent, the goldfish draws exactly as before.

- `Battlefield`: `flipped`, `readOnly`, `marks` (attack, block or chosen, with a badge), `pick`,
  `onActivate`, and `dense` (tighter padding).
- `LifePlate`: `compact`, a one-row plate 38 px tall.
- `layoutTable` and `pilesOf`: an `apart` key, so an attacking creature does not join a pile with
  its untouched twin.
- The zone components: a `size`, whose `compact` puts each zone's count on its card.
- `useGoldfishDropTarget`: `refuse`.
- `LibraryDialog`: `opponent`, for a read-only look.
- `cardMenu`: `onActivate`.
- `HelpPanel`: its content.

The views these pieces take are narrowed to `Pick<…>`s of the fields they read, so a
`PlaytestSeat` fits where a `GoldfishView` did.

## What is not there yet

- **Holding priority over your own spell.** The reader's own spell on top never stops them, so
  they cannot respond to it themselves (a second spell on top of their first).
- **Choosing who plays first.** It is the seed's coin flip.
- **Mana payment by hand.** Every cast is paid by phase's `Auto`.
- **A split or a pile.** A search that splits its finds between zones, separate piles and
  distributions are still their generic options or `auto`.
- **The light app.** Playtesting is not a destination there.
