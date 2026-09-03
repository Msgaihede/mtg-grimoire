/**
 * The three quick collection actions, as decisions rather than as writes — issue #350.
 *
 * **The file is `quickCollection.ts` and not `quickAdd.ts`, which is what the plan named it.**
 * `QuickAdd.tsx` — the toolbar's card field — already sits in this folder, and Windows' file
 * system is case-insensitive: `./QuickAdd` and `./quickAdd` resolve to whichever of the two the
 * resolver reaches first, so the pair made `QuickAdd.test.tsx` render `undefined` as a component
 * and `tsc` refuse the program outright (TS1149, "differs only in casing"). It is this repo's
 * `folderTree.ts` beside `FolderTree.tsx` a second time. Nothing about the exports moved.
 *
 * A deck card's right-click can record the copies a row is short of, record them *and* clear a
 * matching wish, or move copies the reader already owns loose into the deck. Every one of those
 * is a mutation somewhere else; what is here is the part that has to be *decided* first — how
 * many copies the row is short of, whether the rows may be pressed at all, and whether the press
 * has an unambiguous answer or has to ask.
 *
 * **Nothing in this file reads or writes anything.** It is pure over a {@link DeckCard} the
 * editor already has and over the two reads a press makes, which is what lets the whole of the
 * feature's judgement be checked as a truth table with no query client, no DOM and no backend —
 * `pullPlan.ts`'s discipline one press over, and for its reason: the alternative is a menu
 * builder and a dialog each holding half an opinion about when a press is ambiguous.
 *
 * ## A prompt only when the answer is ambiguous
 *
 * That is the whole rule the two `choose*` functions state, and it is stated once because the
 * two presses would otherwise word it twice: **one** matching wish is removed with no dialog,
 * **one** pull candidate is taken with no dialog, and only a genuine fork raises a picker. What
 * counts as a fork is a *count* and never a comparison against the shortfall — see
 * {@link choosePull}.
 */
import type { DeckCard, DeckPullPick, DeckPullRow, DeckQuickAddWish } from "@/lib/ipc";
import { NO_CHOICE, planPull, pullKey } from "./pullPlan";

/**
 * What the row the reader right-clicked is short of — exactly the red `3/4` a stacked card's
 * chin draws.
 *
 * `max(0, quantity − ownedQuantity)`, and the deliberate part is *whose* numbers those are: the
 * row's, not the deck's and not the printing's. A card short in two piles is two rows and two
 * presses, because the number in the menu label has to be the number on the screen the reader is
 * right-clicking — a label quoting a total the card is not wearing is worse than a second press.
 *
 * **A quick add files the whole shortfall in one go**, which is why this is a count rather than
 * a boolean: the alternative considered was one copy per press, and it costs four presses on the
 * deck somebody has just finished buying.
 *
 * The floor is not defensive. `ownedQuantity` is a sum over the copies in the deck's own group
 * attributed to this row, and a group can hold *more* than the list asks for — a reader who cut
 * a 4-copy line to 2 without taking the cardboard out — so a negative shortfall is an ordinary
 * state and reads as nothing missing.
 */
export function quickAddShort(card: DeckCard): number {
  return Math.max(0, card.quantity - card.ownedQuantity);
}

/**
 * Why the three rows are greyed, or `null` when they are live.
 *
 * **Greyed with a reason rather than hidden**, which is the menu's own rule for this submenu:
 * every card of this surface *can* be short, so a row that vanished on the cards it does not
 * apply to would read as a bug rather than as an answer.
 *
 * - `"theory"` — a plan holds no cards. `deck.rs`'s rule 2, and the reason it is a block rather
 *   than a shortfall of zero: a theory row's `ownedQuantity` is zeroed explicitly, so
 *   {@link quickAddShort} would answer the row's whole quantity and offer to record cardboard
 *   for a list that holds none. The backend refuses it too (`NOT_IN_DECK` reads the live list
 *   only), so this is the surface saying in advance what the write would say afterwards.
 * - `"nothing-missing"` — the group already holds what the row asks for. Nothing to record and
 *   nothing to pull.
 *
 * - `"inactive"` — the row is in a switched-off pile, so its `0` owned is a property of the
 *   *pile* rather than of the reader's shelves and there is no shortfall here to answer.
 *
 * **That third arm was not here for the length of one fan-out, and driving the shipped window is
 * what found it** (2026-09-03, debug build, real database). `attribute_owned` hands a switched-off
 * pile nothing out of the group — `category_active` is checked before the oracle total is spent —
 * so **every** row in one reads `0` owned however many copies sit in the deck's folder. Without
 * this arm {@link quickAddShort} read that `0` as a shortfall and the submenu offered
 * *Quick add 1 copy* on a Maybeboard line; the press was legal (the deck plays the card, so
 * `NOT_IN_DECK` passes), the copies were recorded, **and the row still read `0/1` afterwards** —
 * so the control appeared to do nothing and could be pressed again, and again. Measured: two
 * presses on one Maybeboard row left `collection_entries` id 276 holding **2** copies in the
 * deck's group with the row reading `0/1` throughout. A control whose own number never moves is
 * one a reader presses until something happens, and what happens is cardboard they never bought.
 *
 * **Greyed rather than made to work**, because the alternative is a second opinion about a
 * question the backend has already answered: attributing copies to a switched-off pile is
 * `attribute_owned`'s decision, and a shortfall computed here against a number the app refuses to
 * count would put two answers on one screen. The cure a reader has is the pile's own switch, and
 * `deckCardShort` — the *mark*'s predicate, which guards on `categoryActive` for this very
 * reason — is the precedent rather than a coincidence.
 */
export function quickAddBlock(
  card: DeckCard,
): "theory" | "inactive" | "nothing-missing" | null {
  if (card.variant === "theory") return "theory";
  // **Before the shortfall test and not after it**, because on an inactive row the shortfall is
  // not merely unknown — it is `quantity`, always, for every such row — so a later arm would be
  // unreachable and the row would read as short whatever the reader owns.
  if (!card.categoryActive) return "inactive";
  if (quickAddShort(card) === 0) return "nothing-missing";
  return null;
}

/** What to do with the wishes a press found. */
export type WishChoice =
  | { kind: "none" }
  | { kind: "one"; wish: DeckQuickAddWish }
  | { kind: "many"; wishes: readonly DeckQuickAddWish[] };

/**
 * The wishes `deck_quick_add_wishes` answered, read as a decision.
 *
 * **`none` is the common answer and is not a failure**: most cards a reader records are on no
 * shopping list at all, and the add still happens — the press is "record these copies, and clear
 * a wish if there is one", so a card with no wish gets the first half and nothing is owed about
 * the second.
 *
 * **`one` is removed with no dialog.** A picker offering a single row is a press that asks the
 * reader to confirm the only thing it could have done.
 *
 * **`many` is the one fork.** Which shopping list a copy comes off is a filing decision the
 * reader made on purpose — a wish in *Christmas list* and a wish in *Trade targets* are not
 * interchangeable — so the app must not pick one, and a **cancel there does neither half**: the
 * reader asked for both and got neither, which is the only answer a cancel can honestly give.
 *
 * The array is handed back untouched rather than re-sorted: the backend's order is the pre-pick
 * (the root first, then the reader's folders in their own `sortOrder`), and a sort here would be
 * a second opinion about a question already settled where the folder tree is visible.
 */
export function chooseWish(wishes: readonly DeckQuickAddWish[]): WishChoice {
  if (wishes.length === 0) return { kind: "none" };
  if (wishes.length === 1) return { kind: "one", wish: wishes[0] };
  return { kind: "many", wishes };
}

/** Whether a pull of this card needs the dialog, and the picks when it does not. */
export type PullChoiceForCard = { kind: "ask" } | { kind: "take"; picks: DeckPullPick[] };

/**
 * One card's slice of `deck_pull_plan`, read as a decision.
 *
 * The plan is a deck-wide answer; a per-card press is about one row of it, found by
 * {@link pullKey} — which takes the two fields it reads (`cardId`, `finish`) rather than a whole
 * {@link DeckPullRow}, so a {@link DeckCard} satisfies it unchanged and the two sides of the
 * match are one function.
 *
 * **Ambiguous is `candidates.length >= 2`, and nothing else.** In particular a lone candidate
 * holding *fewer* copies than the shortfall is still unambiguous: there is one pile to take from
 * and taking what is in it is the only thing a dialog could offer. Taking too little is a normal
 * answer here for `planPull`'s stated reason — filling three of four holes is worth doing.
 *
 * **No row at all is `ask`, deliberately.** A card with no unallocated copy anywhere is the
 * commonest way to press this and be told nothing can happen, and the dialog already words that
 * case (`NOTHING_TO_PULL`). A second sentence here would be the same fact said twice, in two
 * wordings, from two files.
 *
 * **The picks come from {@link planPull} rather than from arithmetic written here.** The row is
 * handed to the same function the dialog previews with, under {@link NO_CHOICE} — the reader has
 * departed from nothing, because there was nothing to depart from — so the copies a silent take
 * moves and the copies the dialog would have shown are the same number by construction rather
 * than by two files agreeing. A plan that yields no pick at all (a candidate holding nothing, a
 * row already filled) falls back to `ask` for the empty case's reason: the dialog explains, this
 * does not.
 */
export function choosePull(rows: readonly DeckPullRow[], card: DeckCard): PullChoiceForCard {
  const key = pullKey(card);
  const row = rows.find((r) => pullKey(r) === key);
  if (row === undefined || row.candidates.length >= 2) return { kind: "ask" };

  const { picks } = planPull([row], NO_CHOICE);
  if (picks.length === 0) return { kind: "ask" };
  // Copied out of the plan's `readonly` array rather than handed over: `deckPullFromCollection`
  // takes a mutable `DeckPullPick[]` — it is the wire type — and the array it is given belongs
  // to a plan a dialog may still be drawing from.
  return { kind: "take", picks: [...picks] };
}
