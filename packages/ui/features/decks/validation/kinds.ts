/**
 * The category-kind lists the validation rules share, in a module of their own.
 *
 * {@link SIZE_KINDS} is read by `engine.ts` **and** `companions.ts`, and `companions.ts` already
 * imports `engine.ts` (for `isOrphan` and `manaValueOf`) while `engine.ts` imports it back — so a
 * top-level constant in `companions.ts` derived from one exported by `engine.ts` would read it
 * before `engine.ts` had run, and throw. A leaf module both can import is what lets the two
 * lists be one list rather than two spellings that drift (issue #554).
 */
import type { CategoryKind } from "@/lib/ipc";

/**
 * The category kinds `deckMin`/`deckMax` count together — "exactly 100 **incl cmdr**",
 * "exactly 60 incl Oathbreaker + signature spell" (both of those live in a `commander`
 * category).
 *
 * **The rule, in one sentence: the switch decides whether a pile counts at all; the kind
 * decides only whether the pile is played *beside* the deck or *in* it — and only `side` and
 * `companion` are beside it.** So `deck.filter((c) => c.categoryActive)` has already dropped
 * everything switched off before this list is consulted, and this list drops the two kinds
 * that are played beside the deck: the sideboard (CR 100.4a) and the companion, which EDH
 * calls "effectively a 101st card" — exactly the card a "100-card deck" figure must not add.
 * Everything else that is switched on is in the deck.
 *
 * **That is why `maybe` is here**, which reads odd until the alternative is written out.
 * Leaving it off put an *active* Maybeboard inside the format's card pool and inside the
 * binder's reservations but outside the deck's size — so a second Sol Ring in one raised a
 * singleton error under a size figure that still read 100, which is two answers to one
 * question. Kind `maybe` now exists for exactly one reason, to name the predefined Maybeboard
 * and seed it inactive, and that is honest: being switched off is the whole of what the
 * Maybeboard is.
 *
 * Kinds and not categories, because a deck may own any number of `main` categories — the user
 * names and orders them — and a size rule that had to be told about each one would be a rule
 * the user could break by making a pile. What a card is *for* is the kind; what it is *called*
 * is theirs. A **sixth** kind added to the schema therefore has to be placed here deliberately;
 * it will not fall in by accident, which is the trade this positive list buys over spelling the
 * rule as `!== "side" && !== "companion"`.
 *
 * Exported because the deck editor's stats strip prints the same total beside this file's
 * sentence about it: "Modern decks need at least 60 cards; you have 59" under a headline
 * figure counting the sideboard too is two numbers for one question. Reading one query is not
 * enough to make two surfaces agree — they have to read one definition. `DeckRow.cardCount` is
 * the third reader and is these three words again, in SQL (`deck.rs`'s `DECK_SELECT`).
 *
 * **The rules read it too, and two of them used to spell it for themselves.** `companions.ts`'
 * starting deck *is* this list — the cards a companion's condition is asked about are the cards
 * the deck is sized over — and `engine.ts`' identity pass is this list less the command zone
 * plus the sideboard. Both were written out by hand, as `main | commander` and `main | side`, and
 * both missed `maybe` when it joined (issue #554): a switched-on Maybeboard was counted toward
 * 100 cards while Lurrus, Yorion and the commander's colour identity never saw it.
 */
export const SIZE_KINDS: readonly CategoryKind[] = ["main", "commander", "maybe"];
