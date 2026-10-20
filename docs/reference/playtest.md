# Playtesting: the one game, against phase.rs's AI or the goldfish

A **playtest** is a game of the reader's deck against another of their decks, or against three in
a four-player game, each opponent's seat played by **phase.rs's AI** (`phase-ai`) — or against
**the goldfish**, an opponent that takes no actions. **Goldfishing is this game** (the owner's
decision of 2026-10-17): one session, one wire, one board, and the goldfish is a seat across the
table from the reader, drawn as a single AI opponent is. The opponents' half of the board is the
reader's, turned around.

Built 2026-10-13; four players added 2026-10-14 (issue #994); the goldfish and the sandbox setting
folded in 2026-10-17. The owner's choices that shape it:

| Question                 | Choice                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Who plays the opponent   | phase-ai, at a difficulty the reader picks; or the goldfish, which takes no actions (2026-10-17)                                           |
| How strict the rules are | The rules decide, with a prompt for targets, modes and the rest                                                                            |
| The sandbox              | A setting (2026-10-17): off by default against the AI, on against the goldfish. On, it edits every card the table shows, in the main phase |
| Where a game starts      | The Playtesting page: your deck, who it plays (any of your own decks, or the goldfish), a difficulty; or the deck editor's goldfish button |
| How many opponents       | The goldfish, one, or three for a four-player game (issue #994): one player against three AI seats                                         |
| Priority                 | Arena-style auto-pass: the reader decides only in their main phases, in combat, and when the engine asks                                   |

The engine, the nightly pin, the 16 MiB stack, the hybrid model of rules and sandbox, the goldfish
as an opponent (its emblems, its library, `deadOn`), the table's shared pieces and the licences are
[goldfish.md](goldfish.md)'s. The binding rules are in [`crates/grimoire-play/CLAUDE.md`](../../crates/grimoire-play/CLAUDE.md).

## Contents

- [The AI](#the-ai)
- [The session: playing on until the reader decides](#the-session-playing-on-until-the-reader-decides)
- [Four players](#four-players)
- [Prompts](#prompts)
- [Casting, cancelling and the sandbox](#casting-cancelling-and-the-sandbox)
- [Undo and redo](#undo-and-redo)
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
analysis of every deck, and it is built the first time the AI decides. The config is
`create_config_for_players(difficulty, Native, players)`, one per AI seat, every seat at the one
difficulty: with four players phase caps each preset's search (depth 2, two thirds of the nodes,
its "paranoid" cap), so a four-player AI thinks less a decision than a duel's. The wire offers
phase's five presets, from `veryEasy` to `veryHard`. Its sixth preset, cEDH, is a competitive
four-player Commander preset with bracket validation of the decks, and is left out.

**The dice are seeded.** The AI's `ChaCha8Rng` is seeded from the game's seed, XORed with a
constant so that it is not the shuffle's own stream. The same seed and decks play the same game,
and the session's tests rely on that. The seed modulo the player count is the coin flip: 0, the
reader plays first (in a duel, an even seed).

**Measured** (debug build, this container, 2026-10-13): a Medium AI's keep and first turn took
1.8 s. The crate's fourteen playtest tests, six AI turns among them at VeryEasy, ran in about 4 s
together. Medium and above search with phase's 1.5 s budget a decision, so a long AI turn takes
seconds. The board says "Opponent is thinking…" meanwhile.

## The session: playing on until the reader decides

`crates/grimoire-play/src/playtest/session.rs`. After every action, and once at the deal,
`advance` plays on by itself:

1. If the game is over, it stops.
2. If the AI can act, it runs the AI's batch and loops. If the goldfish is to decide, it answers
   with `fish_answer` (pass, no attackers, no blockers, keep, else the first legal action) and
   loops; the goldfish's steps are never replay frames of their own.
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
phase otherwise. In the second main phase it ends the turn and plays the opponent's, the AI's or
the goldfish's. `endTurn`, from `main` or `respond`, passes until the turn changes: on the reader's
turn with no attack and both main phases passed, and on the opponent's turn with no response or
step stop. A block or a question still stops it. `view.endingTurn` says it is running.

**Commander.** A commander on any side makes the game a Commander game: 40 life, the command
zone, tax and 21 commander damage. Without one, the format is phase's `freeform` at 20 life.

**The first turn's start is told by the session.** phase begins turn 1 inside `start_game`, before
the hands are kept, and that event is never returned. The keep inserts `turnBegan` for turn 1, so
the log opens on the right turn. While the hands are being decided, the view's `turn` is 0, even
though phase already counts 1.

## Four players

Issue #994: one player against three AI opponents, the way a Commander pod sits. The session is the
duel's, widened rather than forked: `Playtest::new` takes a list of `OpponentDeck`s, none to
three (`MAX_OPPONENTS`). A duel is the list of one, and the empty list is the goldfish, one seat
with no deck of the reader's in it.

- **The seats.** The reader is `PlayerId(0)`, and the opponents `PlayerId(1)` on, in turn order.
  phase seats the first opponent as `DeckList.opponent` and the others as `ai_decks`. On the wire
  a player is a `PlaytestPlayer`: `you`, `opponent`, `opponent2`, `opponent3`. A duel's two are
  spelled as the table's `Seat` (`GameSeat`), so a duel's facts read as they always did. `view.opponents`
  holds each opponent's `PlaytestSeat`, which says whose it is (`player`) and whether they are out
  (`out`).
- **The AI seats** are every opponent, one `run_ai_actions` batch for all of them: phase plays each
  seat whose decision it is, including an attack of one AI on another and its blocks.
- **Stops are per side, not per opponent.** `PlaytestStop.seat` stays `Seat`: an `opponent` stop
  stops on each opponent's turn. The smart stops are unchanged: any opponent's spell on top, and
  any combat after blocks, when the reader could answer it.
- **Attacks name a player.** `PlaytestAttacker.players` lists the players a creature can attack,
  and a `PlaytestAttackPair` carries `player`, the one attacked when `target` is `null`. From the
  reader, a `null` player is the first opponent the creature can attack.
- **A player who loses leaves** (CR 800.4a), and the others play on. phase marks them
  `is_eliminated`, and the session tells it as `eliminated` (`tell_out`), read off the players
  rather than an event so that a life total set by hand counts too. The last opponent out ends the game,
  `gameOver` with the reader the winner. **The reader out is the end of their game**: phase would
  play the three AIs on among themselves, but the session stops there (`reader_out`): the stage
  is `over`, `you.out` is set and `winner` is `null`, which the board reads as a loss. A duel's
  loser is told by `gameOver` alone, as before.
- **Replay frames** are bounded at 80 an opponent, since one `endTurn` plays all three of their
  turns.

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
  - a named choice's word (`choice`);
  - the abilities it names, when the question lists them (`Playtest::abilities`): a question
    whose data holds a list of `{ source_id, source_name, description }` — the triggers of
    `OrderTriggers`, the effects of `ReplacementChoice` — is answered by counting into it, an
    `order` (a permutation of the list) or an `index` (one of it). Each is sent as its source
    card with the ability's words in `text`, never as bare numbers (issue #1027).

  An answer of a kind the board has never seen still shows what it points at.

- **An order of triggers reads first-to-resolve first.** phase's `order` lists the triggers as
  they are placed on the stack, so the first placed resolves last; the page reverses it, says
  "Clavileño resolves first, then Carmen", and numbers each picture. Two different triggers of
  cards of one name are told apart by their words. An answer standing for abilities carries
  their words in its tooltip.

- **No two triggers read alike unless they are alike** (issue #1076). Each trigger also carries
  its **cause** (`PlaytestCause`): what set it off, read from the trigger's first event —
  `pending_trigger_order`'s `trigger_events`, a stack entry's `stack_trigger_event_batches` or
  `trigger_event` — by the field names its events name their subject with (`object_id`,
  `target`, `attacker`, `attacker_ids`…), never matched event by event. The cause is the
  event's kind, its card's id and name (left out when the reader may not see the card) and its
  player (the card's controller, or the event's player when it names no card). The page:
  - names a trigger whose row holds another of one card name and one text by its cause:
    "Soul Warden for Llanowar Elves resolves first, then Soul Warden for Grizzly Bears";
  - offers an order of triggers that reads the same as one before it once (`distinctOptions`):
    two Soul Wardens seeing one creature enter, or two Delvers' upkeep triggers, can go either
    way round, and the engine lists both orders. Every other question keeps every answer,
    since its facts are a reading of the engine's answer, not all of it;
  - says a question about one trigger by its cause too — `PlaytestPrompt.sourceText` and
    `cause`, read from the question's own `source_id`, `description` and `trigger_events`: the
    header reads "Choose a target · Impact Tremors for Grizzly Bears", the trigger's words in
    its tooltip. phase orders one ability's triggers itself when the order cannot matter, and
    then asks each one's targets in turn; before this, the questions were word for word alike
    and their source was the top of the stack, which is not always the trigger being asked about;
  - gives each ability on the stack its words and cause (`PlaytestStackItem.text`, `cause`), in
    its card's tooltip and its spoken label.

- **`auto`** answers any prompt with `phase_ai::choose_action` for the reader, at Medium.
  `Happened::Chose` says so. It is also the answer to a prompt with no options the board can draw.
- **A question with one answer is never asked** (issue #999, `sole_answer`). phase already fills
  in a cast whose targets have one combination, and a discard of every card in hand. What it still
  asks with one answer, `advance` takes and tells as `Chose`: a target slot with one card left
  once the reader answered the first, a payment with nothing to choose, a sole mana source. phase's
  own way back out of a cast (`CancelCast`, `BackToManaPayment`) is not counted, since the board's
  `cancel` is there for that. A pick has one answer only when every eligible card must be picked
  and their order cannot matter. Should the engine refuse that answer, the question is asked
  after all.
- A card named alone by an option lights up on the table, and clicking it answers.
- **An alternative cost is asked as which cost** (issue #1072). A spell with Overload, Evoke,
  Bestow, Dash and the like whose printed and alternative costs are both payable is phase's
  `AlternativeCastChoice`, answered `ChooseAlternativeCast` with `Normal` or `Alternative` — a
  tagged choice, which `option_of` reads as the option's `label` (`tag_of`). The question's own
  `keyword` field rides on the prompt as `keyword`, so the board says "Overload" and "Mana cost"
  rather than two rows of the same words. With only one cost payable, phase takes it unasked.

**A pick: the answer that is a set of cards.** For a scry of three, `legal_actions` offers four
answers (none, all, each card alone), and there are sixteen. So for the questions whose answer is
a set of cards, the prompt carries a `pick` beside its options (`Playtest::pick`): the cards, which
of them may be picked, a minimum and a maximum, and whether order counts. `pickCards` answers it.
The answer is `SelectCards`, `SelectTargets` for `ChooseObjectsSelection`, or the kept set
(`ChooseKeptCreatures`, `ChooseKeptPermanents`) for a keep. The meaning of the picked cards is
phase's:

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
| `KeepWithinTotalPowerChoice`                     | `keep`    | Are kept; the rest are sacrificed                           | any, their total power at most `powerCap`           |
| `KeepExactPermanentsChoice`                      | `keep`    | Are kept; the rest are sacrificed                           | `required_count`                                    |

A keep within a total power (Slaughter the Strong, Destined Confrontation — issue #1079) is bounded
by power as well as count: `powerCap` is the cap, each creature counts its current power
(`GameCard.power`), and the board will not pick a creature that would pass it. phase's own
`legal_actions` for it are two canned sets (keep none, and its greedy keep), which before the pick
showed as two identical "Choose kept creatures" chips; they stay under "Other answers", each naming
the creatures it keeps (`option_of` reads `kept`).

The session checks the count, the power cap, that each card is eligible and that none is picked
twice. The engine
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

**`play`** takes the one legal `PlayLand` or `CastSpell` for that card, or asks which of several
(`CastChoice`, below). Payment is phase's `Auto`, from untapped mana. When the rules allow none (no
land drop left, too little mana, nothing to target), what happens is the sandbox's:

- **Sandbox off: it is refused with a sentence** that ends "Turn the sandbox on to put it down by
  hand." Putting a card down unpaid against an opponent would be cheating it, so it is never done
  unasked.
- **Sandbox on, in the reader's main phase: it is played unpaid** (`unpaid`): cast without paying
  its mana cost (CR 118.9, under a `CastFromHandFree` emblem held only while the cast is made —
  [goldfish.md](goldfish.md)), so its cast and enter triggers happen (issue #1075), told as `cast`.
  Only when even that is not legal is it put where it would have gone — a permanent onto the
  battlefield, an instant or sorcery into the graveyard — told as `put` and logged "Cast Ponder ·
  not paid for". A commander from the command zone still raises its
  tax (CR 903.8). Only when the rules offer no way: a card with one way is played, and one with
  several is asked about, sandbox or not.

A card elsewhere than the hand or the command zone is cast when the rules offer a cast of it there
(a foretold card in exile, flashback in the graveyard); else it is activated rather than played,
and in the sandbox one with nothing to activate is put onto the battlefield (a double-click on a
graveyard's creature).

**`foretell`** takes phase's `Foretell` special action for a hand card (CR 702.143a): {2} paid
from untapped mana, the card exiled face down and foretold. It is refused, saying why, off the
reader's turn or with {2} out of reach. **What the rules offer is on the card**: `canForetell` on a
hand card the engine would foretell now, `castable` on a graveyard or exile card it would cast now,
`foretold` on a foretold card in exile — each read off the legal actions once per view, and never
set in a replay frame. An opponent's face-down exiled cards are not in their seat's `exile` at all.

**`activate`** takes every legal action of a permanent's: an ability, equip, crew, station,
saddle, transform, turn face up. These are found by the source field in the action's data
(`names_source`). Mana abilities are not on the list, since a cast pays its own mana.

**A cast can be taken back until it is on the stack.** `play`, `activate` and an answer to a board
question each keep a checkpoint (`Pending`) while the engine asks the reader how to make the cast.
`cancel` restores it. The first time priority is passed with the spell on the stack, the
checkpoint is dropped: the spell is cast, and the AI may already be answering it.

**The sandbox is a setting** (`setSandbox { on }`, `view.sandbox`), the owner's decision of
2026-10-17: **off by default against the AI, on against the goldfish**, and the reader's to turn on
or off at any stage. Like `setStops` it changes nothing on the table, plays nothing on, and is not
remembered by undo. Its actions are a hand on the table: move a card anywhere, tap, untap all,
counters, token copies, preset tokens, draw, mill, shuffle and life totals — phase's debug actions,
which the engine permits for the reader's seat (`debug_permitted`) and never for the AI's.

- **Off,** every one of them is refused: "That changes the game by hand. Turn the sandbox on in the
  game menu to do it." `run` checks it first (`is_sandbox`), so no action slips past.
- **On,** they are taken in the reader's main phase only, where nothing is half done, on the
  reader's own cards anywhere and on **any card the table shows**: an opponent's battlefield,
  graveyard, exile and command zone (`editable`). **Never an opponent's hand or library**, which
  the reader may not see: "That card is in a zone you cannot see." The goldfish's emblems are out
  of reach too.

The AI may well notice: it reads the state as it is. Tokens wear each deck's own printings, every
seat's ([goldfish.md](goldfish.md#the-table), _A token wears the deck's printing_). The hybrid model
it comes from is [goldfish.md](goldfish.md#the-hybrid-model-what-is-a-rule-and-what-is-a-hand)'s.

**A refused action changes nothing**: `act` restores its checkpoint on any `Err`.

## Undo and redo

**`Ctrl+Z` goes back to the reader's last decision, with everything the opponent did after it;
`Ctrl+Y` or `Ctrl+Shift+Z` comes forward again** (issue #1022, 2026-10-14), against the AI and the
goldfish alike. The chords are the shortcut catalogue's
([keyboard-shortcuts.md](keyboard-shortcuts.md#undo-and-redo-on-the-game-boards)), under the
`playtesting` scope from the setup page and the `goldfish` scope over the deck editor (`returnTo`).
**Undo** and **Redo** also head the game menu (`gameMenu`), greyed when there is nowhere to go and
while the engine is busy, for a reader who does not know the chords.

**The history is the engine's, and it is whole games, not inverses**
(`crates/grimoire-play/src/history.rs`). Before every action it takes, the session keeps the game
as it was. `GameState` is persistent (`im`), so a clone is a handful of reference counts. Going back
is restoring one, which is exact for every action the board has, the rules' and the sandbox's
alike; an inverse per action would be a second rules engine. A new action ends the redo trail. A
hundred actions back is the limit (`UNDO_LIMIT`).

**On the wire they are actions**, `{ type: "undo" }` and `{ type: "redo" }` on `playtest_act`: no
new command, the engine's stack and the slot as for any action. They answer with the board as it
was and no facts, and the view's `canUndo` and `canRedo` say whether either has anywhere to go. A
refused action was never taken, so it is not remembered; nothing to undo is a refusal like any
other.

**What a moment holds**: the checkpoint (the `GameState`, the printings, the mulligan count, **the
AI's dice**, the players told out, and the goldfish's `dead_on`), and the session's place around it
— a cast half made (`Pending`), the board's own question, the end told, the turn being ended, the
stop last stopped at. The dice are why redo restores rather than replays: the AI's turn after a redo
is the one the reader saw, not a new roll. An undo after a different choice is a new roll, and the
AI may well play otherwise. `dead_on` is why an undo past the goldfish's killing blow brings it back
to life on its plate.

**The log is the page's**, so the page keeps its side of the history the same way:
`features/playtesting/undo.ts`' `LogBook` holds the whole log as it stood before each action, by
the engine's own rules and limit so the two walk in step. Whole logs rather than a count of the
lines an action added, because a replay logs its beats one by one, or merged when it is skipped or
motion is reduced, and a count would have to agree with every way of logging them.

**One action is one step back, and an action is the reader's.** The AI's turn is never a moment of
its own: it happened inside the reader's action that passed to it, so undo lands where the reader
last decided, never in the middle of the opponent's turn. Undo and redo answer with no facts and no
frames, so nothing plays back. **The stops and the sandbox are settings** (`setStops`,
`setSandbox`): not remembered, and left as they are by undo. A finished game can be undone too, which is how a reader takes back the play
that lost it.

## What the reader may see

Each opponent's hand and library are **counts** (`handCount`, `library`), the goldfish's too.
Their `hand` and `libraryCards` are always empty on the wire, and the sandbox never reaches them.
An opponent's draw is `drew` with no name, and a card going back from their hand to their library
is not told at all. The AI itself reads the whole `GameState`. Whether it plays as if it knows the
reader's hand is phase's business, not this board's.

## The commands and the wire

| Command                                                               | Does                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playtest_start(game, deck_id, variant, opponents, difficulty, seed)` | Reads every deck (`play::deck_cards`), deals, and answers with a `PlaytestStep` at the reader's opening hand. `game` is the page's fresh name for the deal; `opponents` is up to three `PlaytestOpponent { deckId, variant }`; **none is the goldfish** (`difficulty` unused). A fresh game replaces any other, from the moment the call arrives. |
| `playtest_act(game, action)`                                          | One `PlaytestAction` on `game`, and everything the opponents do after it until the reader next decides. A refusal is one sentence and leaves the game exactly as it was; a game since replaced is refused.                                                                                                                                        |
| `playtest_end(game)`                                                  | Drops `game` — at once, even mid-action — and leaves a newer one be.                                                                                                                                                                                                                                                                              |
| `playtest_support(deck_id, variant)`                                  | What the engine plays of a deck, before a game: a `DeckSupport` (its different cards, and the `UnsupportedCard`s phase reads only in part). See [the setup page](#the-setup-page).                                                                                                                                                                |

**One game at a time, in one slot** (`PlaytestSlot`: `Empty | Dealing | Busy | Game`), the
goldfish's game and the AI's alike. An action takes the game out of the slot onto the engine's
thread and puts it back after, so a call while one runs is told "The opponent is still thinking."
rather than waiting. If the engine panics, the game is lost and the slot empties.

**Every game has the page's name, and every call names its game** (issue #1141, 2026-10-20). A
start claims the slot for its game as it arrives (`Dealing`), so the game it replaces is gone at
once; an action puts its game back only if the slot is still `Busy` with that name, and an end
empties the slot only if it holds that name — even `Busy`. So a board that leaves while the AI is
mid-turn ends its game then, and the turn's answer drops it; a new board's deal is never
overwritten by the old board's late answer; and a late action or end from a board that has gone, or
from another window's, never touches a newer game. On the page the name is drawn like the seed,
fresh per deal (`usePlaytestGame`), and an action still queued when its deal is put away is not
sent. All four commands are on
`command_table::DESKTOP_ONLY`. The goldfish board's own three (`goldfish_start`, `goldfish_act`,
`goldfish_end`) and its slot were removed on 2026-10-17, when its game became this one; the
desktop's `facts` and `token_facts` live in `playtest/mod.rs` now.

**The view is sent, never the state.** The whole `GameState` is hundreds of kilobytes. The view is
what a board draws: each zone's cards, the lives, the mana open, the library, and the tokens the
deck makes. The page sends actions one at a time, in order (`usePlaytestGame`'s serial queue), so
each is read against the view it was made from.

**The wire** is `playtest/view.rs` ↔ `packages/ui/lib/ipc/playtest.ts`, built on the table's
shared types in `view.rs` ↔ `packages/ui/lib/ipc/table.ts`: `GameCard`, `Lane` (`GameLane`),
`CardCounter`, `TokenOffer`, `Place` (`GamePlace`), `Seat` (`GameSeat`, a stop's side),
`MulliganView` and `ManaTable`, which the pieces in `features/playtesting/table/` draw. A player is
`PlaytestPlayer`. The goldfish adds no type of its own, only fields (2026-10-17):
`PlaytestView.sandbox`, `PlaytestView.goldfish`, `PlaytestSeat.deadOn`, and the action `setSandbox
{ on }`; and the sandbox's facts `put`, `tapped` and `counters` gained `seat`, since a card the
reader moves by hand may be an opponent's. `ipc.test.ts` holds every struct field for field, every
`PlaytestAction` and `PlaytestHappened` variant and field, and the string unions (`PlaytestStage`,
`PlaytestPhase`, `Difficulty` and the rest).

**Facts come from phase's events** (`tell`). Each applied action returns `GameEvent`s, and so does
each of the AI's actions. They become the log's facts:

| Event                                    | Fact                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `TurnStarted`                            | `turnBegan`                                                                                          |
| `LandPlayed`                             | `played`                                                                                             |
| `SpellCast`                              | `cast`                                                                                               |
| `AbilityActivated` (not mana)            | `activated`                                                                                          |
| `Foretold`                               | `foretold`, naming the reader's own card only; its move from the hand to exile is not told again     |
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

**A stack item names its targets** (issue #1071). Each `PlaytestStackItem` carries `targets`, the
ids of the cards it targets that the table shows (a permanent, a card in a graveyard, in exile or in
the command zone, another spell on the stack), and `targetPlayers`. They are read from the entry's
`ResolvedAbility` and its `sub_ability` / `else_ability` chain, and from an equip's creature
(`stack_targets`); a target in a hand or a library is left out, as the reader may not see it.

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

**The table** is a three-button group: "Goldfish", "1 opponent" (the default) or "3 opponents".
Three opponents show three dropdowns, "Opponent 1's deck" to "Opponent 3's", and Start waits for
all four decks. Any deck may sit in any seat, twice over. **"Goldfish"** hides every opponent's
seat and the difficulty: the goldfish is no deck and plays at no skill, so Start waits for the
reader's deck alone, and the board opens against it with the sandbox on, exactly as the deck
editor's "Goldfish this deck" does. The seats a table hides keep their picks.

### What the engine plays of a deck (issue #1078)

phase's parser reads most cards whole. A card it reads only in part is still dealt and played, as
a body with a cost and a type, but the parts it could not read do nothing. So the setup page marks
each deck before it is picked:

- **In the deck lists**, each row has a glyph for the list the deck is first dealt from: a green
  `CircleCheck` when every card is played whole, a gold `TriangleAlert` when some are played only
  in part (a caution, not the red of a broken rule: the deck still plays). The row's tooltip is
  the sentence, and the glyph rides on the closed trigger with the picked deck.
- **Under each seat**, the picked deck's verdict in the list picked there ("The rules engine plays
  23 of 24 cards in full; 1 card is played only in part."), and a fold that lists those cards,
  each with its copies and what phase leaves out of it.

**The verdict is phase's own.** `grimoire-play`'s `support.rs` parses each face exactly as a game
does (`cards::parsed_faces`, `build_oracle_face`) and asks `engine::game::coverage::card_face_gaps`,
the check behind phase's coverage report and its deck builder's "N of M supported". A gap is
phase's label (`Effect:…`, `Trigger:…`, `Keyword:…`, `Static:…`, `SilentDrop:2_of_3`), and
`features/playtesting/support.ts`' `gapWords` puts it in words. Two printings of one card are one
card, their copies summed.

**Each card is parsed once per window.** The host holds a `SupportCache` (`PlaytestSupport`) keyed
by oracle id, behind one lock, so a burst of questions parses each shared card once. The page asks
about the seats' decks at once and about the rest **one at a time** (`usePlaytestSupport`), so a
first visit's sweep of every deck never queues ahead of the deck the reader just picked. The
answers are under the `["decks"]` query root, so a deck edit marks them stale; a refetch is a
database read and cache lookups.

**In a game, each card carries its own gaps** (issue #1093). `Playtest::new` asks
`card_face_gaps` of every face in the game's card database once, and keeps the faces with a gap by
name; every `GameCard` the session builds carries its face's (`gaps`, empty for a face played in
full and for a token). The board's `CardFace` draws a card with any in a **gold border inside the
card** — the setup's caution colour, clear of the outline marks for attack, block and pick, which
sit outside it — wherever it is drawn: the hand, the battlefield, a pile, the preview. The card's
label says "played only in part", and the preview names each gap with `gapWords`. A transformed
card is its shown face's name, so its marks follow the face; it is fixed for the game, so not in a
`Moment`.

## The board

`packages/ui/features/playtesting/play/`. **One board for every game on a deck**: whatever it draws
for an AI game it draws for a goldfish game, and a change to it is a change to both. `PlaytestPage`
covers the window below the caption at `LAYER.stage`, a rung between `header` and `popup`, so the
board's own menus and dialogs open over it. `PlaytestBoard` is presentational: a view in, actions
out, no `ipc`, which is what its stories stand on. `usePlaytestGame` is the serial queue that wires
it to the engine. The pieces it is drawn with are the table's ([goldfish.md](goldfish.md#the-table)).

**Opened from two places** (`returnTo`). The Playtesting page's setup opens it with `"setup"`, and
the deck editor's "Goldfish this deck" through `features/playtesting/GoldfishPage.tsx`, a thin
wrapper that picks `opponents: []`, names the plate "Goldfish" and passes `"deck"`. `returnTo`
names the back button ("‹ Setup" or "‹ <deck name>"), the game menu's and the result banner's way
back ("Back to setup", "Back to the deck"), and the undo chords' scope (`playtesting` or
`goldfish`). Escape is the way back, and skips a replay instead while one runs. The goldfish page
is the Decks view's third state: the store's `goldfish` names the open deck and variant, `App.tsx`
draws the board in the editor's place, and every navigation clears it, so coming back to a deck
finds the editor.

**The goldfish is drawn in the duel layout** (the owner's choice of 2026-10-17), exactly as a single
AI opponent is: its band with its face-down hand count, its plate, its zone columns and its empty
table. Nothing of it is its own but the plate's title, which reads "Dead on your turn N" with the
plate highlighted while `deadOn` is set, and the busy text, "Playing on…", since the goldfish
thinks about nothing and the engine is only playing its turn.

**Four players.** A duel's board is drawn exactly as before. At a four-player table the
opponent's table, band and zone columns give way to three `OpponentArea`s side by side in the same
box (96 px in from either side, from the band to the middle line), about 357 × 289 each in a
1280 × 800 window. Each has a compact plate row (glow, poison, its own aim target), a two-wide
grid of 40 × 56 tiles (hand face down with its count, library, graveyard, exile, command) and its
flipped, read-only battlefield, `data-table` and `data-plate` named by its `PlaytestPlayer`. An
opponent who is out stays drawn, dimmed under an "Out" chip. The words name each one "Opponent 1",
"Opponent 2", "Opponent 3" in turn order (`play/players.ts`), never by deck, since one deck can sit
twice; a duel keeps "the opponent". An attacker with more than one player to attack waits to be
aimed at a plate, and an AI's attack on another AI is drawn in red too. The banner reads "You
lost" when the reader is out, or when any opponent wins.

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
  chrome. The duel's compact plate sits right of the hand in a box that ends 116 px from the right
  edge, so it never runs under the help and log buttons: a plate wider than that (a long deck name,
  the sandbox's stepper) shortens its title, and the full title is its tooltip.
- **The tables** are inset from either side by a zone column and 12 px either side of it — 96 px
  at the narrowest. On the opponent's table the creature lane is nearest the middle line and the
  back row is at the top.
- **The zone columns** sit 12 px in, their cards as big as a card on the tables is drawn before a
  full row shrinks it — the lane's height bound, `tableCardWidth` — and never under 72 × 101 (the
  artboard's are 180 × 252; 60 × 84 until issue #992 grew them a fifth), each zone's count on its
  card. A short window keeps 72 × 101; a 1400 px board draws them 173 × 242. On the
  opponent's side, library over graveyard is on the left and exile over command on the right. On
  the reader's side, command over exile is on the left and graveyard over library on the right.
- **The stack** is real cards (52 × 73, up to three, then "+N") in the right gutter between the
  zone columns, top first, with whose each is; an ability says its words and its cause in its
  tooltip. It covers no table.
- **The prompt** docks at the bottom over the hand, at most 640 × 104, and the reader's plate moves
  to the edge while it is up. **The picker** sits centred over the middle, up to 820 px wide.

**The middle line** is a turn tracker: Beginning · Main 1 · Combat · Main 2 · End, the current
phase lit in the active seat's colour, and a caption that names the step, such as "Turn 6 ·
Opponent's turn · Upkeep — you may respond". Beside it are the Stops button and **the Sandbox
pill** (`aria-pressed`, lit while on): both are settings of the game rather than moves in it, and
whether a click may change the game outside the rules is the first thing to know about it, so it is
always in sight. The top band has no room for it, since the opponent's plate grows with its hand.
The game menu has the same switch as a "Sandbox" radio row.

**The plates.** The active seat's plate has a gold glow, and poison shows as a chip when it is
above 0.

**Combat is drawn.** Arrows run from each attacker to what it attacks (the plate for a player, the
card for a planeswalker or battle) and from each blocker to its attacker. The reader's attacks are
gold, the opponent's red, and blocks a dashed blue. They are measured from the DOM
(`[data-table] [data-point]`, `[data-plate]`) on every view, 220 ms later, and on a resize. An
attacker is ringed, slid 14 px toward the middle, lifted and shadowed.

**Targets are drawn.** A dotted, thinner arrow runs from each spell or ability on the stack
(`[data-stack]`) to what it targets: a card on a table, another spell on the stack, or a player's
plate, in the controller's colour (gold for the reader's, red for an opponent's). The same
`BoardArrows` overlay draws them with combat's, so they show against the goldfish, against the AI
and in a replay frame alike. A target the board does not draw (a card under a pile's top, a stack
item past the first three) has no arrow.

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

| Stage                     | Primary                                                                                                                            | Also                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `main`, first main phase  | To combat (`pass`)                                                                                                                 | End turn (`endTurn`)  |
| `main`, second main phase | End turn (`pass`)                                                                                                                  |                       |
| `respond`                 | Pass (`pass`)                                                                                                                      | Pass turn (`endTurn`) |
| `attack`                  | Attack with N, or No attack                                                                                                        |                       |
| `block`                   | Confirm blocks, or No blocks                                                                                                       |                       |
| busy                      | A spinner and "Opponent is thinking…" ("Playing on…" against the goldfish; "Passing turn…" while `endTurn` runs)                   |                       |
| `over`                    | A centred banner ("You won", "You lost", "Draw"; "On turn N") with New game and the way back ("Back to setup", "Back to the deck") |                       |

**Interactions.**

- **The sandbox decides most of what is offered.** The board works it out once (`edits`: the
  sandbox on, the reader's main phase, nothing with the engine) and hands it to every piece.
  - **Off:** no hand edits are drawn. A card's menu keeps only the rules' rows (Play, Foretell, Cast,
    Activate ability), and a castable card in the graveyard or exile dialog its Cast; a click does not tap; T, G, E and H do nothing; the only drag is a play onto the
    table; the library pile is disabled; a graveyard or exile opens read-only; and every life plate
    is read-only text (`LifePlate`'s `readOnly`). What is left is the rules'.
  - **On:** the reader's cards have the whole hand — moves, taps, counters, token copies, draws,
    the keys and every drag ([goldfish.md](goldfish.md#the-table)). **The opponents' battlefield
    cards get a card menu** too (tap, counters, token copy, move), and their plates steppers. An
    opponent's card is never dragged, and their hand and library stay counts.
- **Your cards:** a double-click or a drop on the table plays a card from the hand or the command
  zone, and "Activate ability" heads a battlefield card's menu. In `respond`, the hand and the
  abilities are playable as in the main phase; the sandbox is not.
- **The opponent's cards** can be pointed at for the preview, and their graveyard and exile open
  read-only. They are never dragged, and their table takes no drops (`refuse`).
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
  table — unless it stands for one of its abilities (a replacement effect), which only the panel
  answers. Each answer shows the pictures of the cards it names; a question whose title does not
  say what an answer decides (an order of triggers, a replacement) has a line under it.
- **Picker:** a `pick` opens the cards at 92 × 129, with a counter ("2 of up to 3"). Confirm stays
  `aria-disabled` until the count is within the pick's bounds. An ordered pick numbers its cards;
  scry sorts into "Keep on top" and "Bottom", surveil into "Top" and "Graveyard". Cards that may
  not be picked are dimmed. "Look at the table" folds the panel, "Other answers" shows the generic
  options, and "Let the engine choose" and Cancel stay.
- **Picks reset** with every new view.

**The table's shared pieces, widened rather than copied.** The pieces in
`features/playtesting/table/` were the goldfish board's, and gained optional props for the playtest
board (2026-10-13) rather than being copied; since 2026-10-17 this board is the only one they draw.
For a seat that is not the reader's, and for the sandbox:

- `Battlefield`: `flipped`, `readOnly`, `marks` (attack, block or chosen, with a badge), `pick`,
  `onActivate`, and `dense` (tighter padding).
- `LifePlate`: `compact`, a one-row plate 38 px tall; `readOnly`, the number as plain text with the
  sandbox off.
- `layoutTable` and `pilesOf`: an `apart` key, so an attacking creature does not join a pile with
  its untouched twin.
- The zone components: a `size`, whose `compact` puts each zone's count on its card.
- `useTableDropTarget`: `refuse`, and `sandbox` (off, a zone takes only a play).
- `LibraryDialog`: `opponent`, for a read-only look.
- `cardMenu`: `onActivate`, and `sandbox` (off, only the rules' rows).
- `HelpPanel`: its content.

The views these pieces take are narrowed to `Pick<…>`s of the fields they read, so any seat's
`PlaytestSeat` fits.

## What is not there yet

- **Holding priority over your own spell.** The reader's own spell on top never stops them, so
  they cannot respond to it themselves (a second spell on top of their first).
- **Choosing who plays first.** It is the seed's coin flip against the AI, and the reader against
  the goldfish.
- **Mana payment by hand.** Every cast is paid by phase's `Auto`.
- **A split or a pile.** A search that splits its finds between zones, separate piles and
  distributions are still their generic options or `auto`.
- **The light app.** Playtesting is not a destination there.
- **A difficulty per opponent.** Every AI seat plays at the one difficulty.
- **Two opponents, five or six.** phase seats up to six; the setup page offers the goldfish, a duel
  or four players. `Playtest::new` takes none to three.
- **Commander damage on the board.** The rules count it (21 loses), but no plate shows it yet.
- **Watching the AIs play on** after the reader is out.
