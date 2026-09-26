/**
 * The plan's mark on a token — `theoryMatch.ts`'s three tiers, asked about the Tokens & Emblems
 * pile rather than about a deck card (token stacks, spec §3.5).
 *
 * A deck with a plan, read on the **Live** list, marks every deck card the plan also asks for:
 * green for the printing the plan named, blue for another printing of a planned card, red for a
 * card the plan does not ask for at all. The token pile is drawn with the deck's own card parts
 * since the token-stacks work, top-right corner included, so a token that wore no mark there
 * would be the one card on the desk the plan had nothing to say about. This module is the whole
 * of what it takes to answer for it: **no new arithmetic and no new tier**, only the two lists'
 * tokens spelled as the two sides `theoryMatchPlan` already compares.
 *
 * ## Both sides are built here, which is the one way this is not the deck cards' arrangement
 *
 * A deck card's plan arrives as `deck_theory_slots` — keys Rust spells, and a live row this side
 * spells to match (`theorySlot`'s note). There is no such command for tokens and none is wanted:
 * the plan's tokens are the theory list's own `deck_tokens` answer, which the editor reads with a
 * second `useDeckTokens`, so {@link tokenTheorySlots} spells the plan's half with the very same
 * {@link theorySlot} the live half is looked up by. One function on both sides is the property
 * the backend's key gives the cards, reached without a round trip.
 *
 * **The printing is the token's effective one** — the reader's pick, else the resolver's — which
 * is what the pile draws and so what a mark on it has to be about. **The finish is `null` on both
 * sides**: a token carries no finish on the wire yet, so two `null`s are one regular copy
 * matching another, exactly as two unfinished deck rows do.
 *
 * **The name tier's key is the token's `oracle_id`, never its name** — the one place this is not
 * a card's arrangement, and the spec's own rule that *a token's name does not identify it*. 104
 * token names are carried by more than one `oracle_id` (`deckTokens.ts`' subtitle note —
 * `Elemental` by 31, and `Wurm` twice on one Wurmcoil Engine), so keyed on the name a live
 * Deathtouch Wurm against a planned Lifelink one would read `Art Mismatch` — *the same token in
 * another printing* — about two different tokens. Keyed on the oracle id it reads the X, which is
 * true. So `oracleId` goes where `theoryMatch.ts` puts a card's name, on both sides: the slot's
 * `nameKey` and the live row's `name`. `theoryNameKey` still folds it, and the fold is a no-op —
 * Scryfall's oracle ids are lowercase UUIDs, with nothing to trim and nothing to lower — so the
 * key is the id as the wire spells it and `theoryMatch.ts` needs no second path for it. (A card
 * keys its name tier on the name because Scryfall omits `oracle_id` on reversible *cards*; a
 * token's `oracleId` is never empty here — it is the grain `deck_tokens` stores and the one every
 * token on the band is keyed by.)
 *
 * ## Why the number is `0` until PR 2
 *
 * The override is grained on `(deck, oracle_id)` with **no variant term** (`useDeckTokens`' note),
 * so a token's art and its quantity are one pair of values shared by both lists — and each list
 * draws at most one entry per `oracle_id`. So at **both** grains `planned − live` is one quantity
 * subtracted from itself: a token the plan makes in the same printing reads the tick, one the
 * plan makes in another printing (the resolver's default can differ between the lists) reads the
 * blue tick, and one only a substitute makes reads the X — never `±N`. That is the data rather
 * than a limit of the mark, and it holds *because* the name tier is keyed on the oracle id: keyed
 * on the name it would sum every same-named token on each side, and could print a number about
 * two different tokens. PR 2 gives each list its own printings and counts, and the same three
 * functions answer it with no edit.
 *
 * **`undefined` in, `undefined` out, and the editor keeps it that way while the plan loads.**
 * `useDeckTokens` answers `[]` until its read lands, and an empty plan is a plan that asks for
 * nothing — every live token would draw the red X for the length of one read. So the editor hands
 * {@link tokenTheoryPlan} `undefined` until the theory list's tokens have loaded, and an undefined
 * plan marks nothing.
 */
import type { TheorySlot } from "@/lib/ipc";
import type { DeckTokenView } from "./deckTokens";
import {
  theoryMatchMark,
  theoryMatchPlan,
  theorySlot,
  type TheoryMark,
  type TheoryMarkSwitches,
  type TheoryPlan,
} from "./theoryMatch";

/** The plan's tokens as `TheorySlot`s — each effective printing, keyed exactly as a deck card's
 *  slot is (`theorySlot({ cardId, finish: null })`), with the token's `oracleId` as the name
 *  tier's key — the module note says why never its name. `undefined` in, `undefined` out: a plan
 *  that has not loaded marks nothing. */
export function tokenTheorySlots(
  plan: readonly DeckTokenView[] | undefined,
): TheorySlot[] | undefined {
  return plan?.map((view) => ({
    key: theorySlot({ cardId: view.printingId, finish: null }),
    nameKey: view.oracleId,
    quantity: view.quantity,
  }));
}

/**
 * `theoryMatchPlan` over the live tokens, as cards — each one's `name` is its `oracleId`, the name
 * tier's key on both sides.
 *
 * **`categoryActive: true` for every one**: a token is in no category, so there is no switched-off
 * pile for it to be parked in. The one population rule a token does have — a dismissed token is
 * not one the deck brings — is the caller's, applied to both lists before they arrive here.
 */
export function tokenTheoryPlan(
  plan: readonly DeckTokenView[] | undefined,
  live: readonly DeckTokenView[],
  marks: TheoryMarkSwitches,
): TheoryPlan | undefined {
  return theoryMatchPlan(
    tokenTheorySlots(plan),
    live.map((view) => ({
      cardId: view.printingId,
      finish: null,
      name: view.oracleId,
      quantity: view.quantity,
      categoryActive: true,
    })),
    marks,
  );
}

/** One live token's mark — `theoryMatchMark` asked about the token's effective printing and its
 *  `oracleId`, so the deck's three switches and the fallback between tiers are that function's
 *  and nowhere else. */
export function tokenTheoryMark(
  plan: TheoryPlan | undefined,
  view: DeckTokenView,
): TheoryMark | null {
  return theoryMatchMark(plan, { cardId: view.printingId, finish: null, name: view.oracleId });
}
