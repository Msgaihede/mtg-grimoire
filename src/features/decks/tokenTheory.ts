/**
 * The plan's mark on a token — `theoryMatch.ts`'s three tiers, asked about the Tokens & Emblems
 * pile rather than about a deck card (token stacks, spec §3.5 and §4.8).
 *
 * A deck with a plan, read on the **Live** list, marks every deck card the plan also asks for:
 * green for the printing the plan named, blue for another printing of a planned card, red for a
 * card the plan does not ask for at all. The token pile is drawn with the deck's own card parts
 * since the token-stacks work, top-right corner included, so a token that wore no mark there
 * would be the one card on the desk the plan had nothing to say about. This module is the whole
 * of what it takes to answer for it: **no new arithmetic and no new tier**, only the two lists'
 * token entries spelled as the two sides `theoryMatchPlan` already compares.
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
 * **Each side is a list's entries** — one view per printing-and-finish the list holds, or the
 * token's one implicit entry where it holds none (spec §4.2) — which is what the pile draws and so
 * what a mark on it has to be about. **The slot is the printing and the entry's real finish**,
 * spelled as a deck card's is ({@link tokenDeckFinish}: the regular copy is `null`), so a plan
 * asking for a foil Treasure is not satisfied by the nonfoil one — the deck card's own rule.
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
 * ## The number is real since PR 2
 *
 * Until user schema v52 a token's art and quantity were one pair of values both lists shared, so
 * `planned − live` was one quantity subtracted from itself and every mark was a tick, a blue tick
 * or an X — never `±N`. Each list has its own entries now, so every tier answers as it does for a
 * card: the exact tier carries `planned − live` at the printing-and-finish grain, and the name
 * tier sums **every** entry of the token on both sides before subtracting. This module did not
 * change to get there — the data did — and keying the name tier on the oracle id is what keeps
 * that sum about one token: keyed on the name it would add two different `Wurm`s together.
 *
 * **`undefined` in, `undefined` out, and the editor keeps it that way while the plan loads.**
 * `useDeckTokens` answers `[]` until its read lands, and an empty plan is a plan that asks for
 * nothing — every live token would draw the red X for the length of one read. So the editor hands
 * {@link tokenTheoryPlan} `undefined` until the theory list's tokens have loaded, and an undefined
 * plan marks nothing.
 */
import type { DeckFinish, TheorySlot } from "@/lib/ipc";
import type { DeckTokenView } from "./deckTokens";
import {
  theoryMatchMark,
  theoryMatchPlan,
  theorySlot,
  type TheoryMark,
  type TheoryMarkSwitches,
  type TheoryPlan,
} from "./theoryMatch";

/**
 * An entry's finish spelled the way a deck card's is — `nonfoil` is `null`, `DeckFinish`'s *the
 * regular copy* — because a token entry is keyed and drawn by the deck card's own functions.
 *
 * `theorySlot` spells `cardId|finish ?? ""`, so the two sides of a token plan agree whichever
 * spelling they share; this one is chosen so a token's slot is exactly the key a deck card of the
 * same printing and finish would have. The pile's face and chin read it too (`tokenFaceFacts`),
 * which is `playedFinish`'s input shape: a stated `null` falls to the printing's sole finish,
 * which for a regular entry of a printing sold in nonfoil is no finish at all.
 *
 * Here rather than in `deckTokens.ts` because the two readers are this module and the pile, both
 * of which spell a token as a deck card; the conclusions module's views keep the collection's
 * three words.
 */
export function tokenDeckFinish(view: Pick<DeckTokenView, "finish">): DeckFinish {
  return view.finish === "nonfoil" ? null : view.finish;
}

/**
 * The plan's entries as `TheorySlot`s — each printing **and finish**, keyed exactly as a deck
 * card's slot is (`theorySlot({ cardId, finish })`), with the token's `oracleId` as the name
 * tier's key — the module note says why never its name. `undefined` in, `undefined` out: a plan
 * that has not loaded marks nothing.
 *
 * **An entry held at 0 is no slot at all.** Rule 3 (spec §4.2) keeps a token's last entry at 0
 * rather than deleting it, so the implicit default does not come back under a reader who zeroed
 * the only printing they had — a row that means *the plan wants none of this token*. Kept as a
 * slot it would be a plan asking for zero of the printing, and one live copy against it would
 * read the exact tick (`DIFFERENCE_FLOOR` keeps 1-against-0 at no number) instead of the X the
 * plan's real answer is. A deck card's plan cannot hold a zero row — stepping one to 0 deletes
 * it — so this filter is the one place the token side has to say so for itself.
 */
export function tokenTheorySlots(
  plan: readonly DeckTokenView[] | undefined,
): TheorySlot[] | undefined {
  return plan
    ?.filter((view) => view.quantity > 0)
    .map((view) => ({
      key: theorySlot({ cardId: view.printingId, finish: tokenDeckFinish(view) }),
      nameKey: view.oracleId,
      quantity: view.quantity,
    }));
}

/**
 * `theoryMatchPlan` over the live entries, as cards — each one's `name` is its token's
 * `oracleId`, the name tier's key on both sides, so a token's entries sum into one name.
 *
 * **`categoryActive: true` for every one**: a token is in no category, so there is no switched-off
 * pile for it to be parked in. **Both lists arrive whole** — every entry the read answered, since
 * managed tokens took Dismiss away (spec §3.3), so the caller filters nothing — and a plan entry at
 * 0 is dropped by {@link tokenTheorySlots}, above, as a live one at 0 counts nothing toward a sum.
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
      finish: tokenDeckFinish(view),
      name: view.oracleId,
      quantity: view.quantity,
      categoryActive: true,
    })),
    marks,
  );
}

/** One live entry's mark — `theoryMatchMark` asked about the entry's printing and finish and its
 *  token's `oracleId`, so the deck's three switches and the fallback between tiers are that
 *  function's and nowhere else. */
export function tokenTheoryMark(
  plan: TheoryPlan | undefined,
  view: DeckTokenView,
): TheoryMark | null {
  return theoryMatchMark(plan, {
    cardId: view.printingId,
    finish: tokenDeckFinish(view),
    name: view.oracleId,
  });
}
