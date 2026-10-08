/**
 * Where an unfiled add lands on the list the reader is standing in — `decks.default_category_id`
 * read against **that list's** piles.
 *
 * **The setting is one per deck and it names a _live_ pile.** Deck settings mounts the live list
 * and offers its piles, and `deck_update` refuses a theory pile's id for the column. Since user
 * schema v53 (issue #561) each list has piles of its own, so on the Theory tab the stored id is,
 * by construction, not one of the piles on screen — and reading it by id alone would put every
 * quick add on the plan back to Auto for a reader who had pointed the deck at their Sideboard.
 *
 * So the plan's answer is **the pile of the same name**: the reader chose "Sideboard", and the
 * plan's Sideboard is the pile of that name there. Three steps, in this order:
 *
 * 1. {@link AUTO_CATEGORY} is Auto on either list — it names no pile.
 * 2. An id among `piles` is itself. That is the whole of the Actual tab, and it is the one read
 *    that needs no second list.
 * 3. Otherwise the id is looked up among `livePiles` for its **name**, and the pile of that exact
 *    name among `piles` is the answer. A name the plan does not have — the reader never made
 *    that pile there — is Auto, and so is an id neither list carries: the one render a deleted
 *    pile can be caught in, which is `DeckEditor`'s existing fallback and needs no repairing,
 *    because deleting a pile already puts the deck back to Auto in the same transaction.
 *
 * **The name is compared exactly**, because the grain is `(deck_id, variant, name)` and two
 * names that differ only in case are two piles there too.
 *
 * `livePiles` is `undefined` while that read is in flight or where there is no need for one —
 * the answer is then Auto rather than a guess, which is where the deck is about to land anyway.
 */
import type { DeckCategory } from "@/lib/ipc";
import { AUTO_CATEGORY } from "./autoCategory";

/** The two fields this reads — so a caller can hand it a `CardGroup`-shaped row or a fixture. */
type Pile = Pick<DeckCategory, "id" | "name">;

export function defaultPileFor(
  defaultCategoryId: number,
  piles: readonly Pile[],
  livePiles: readonly Pile[] | undefined,
): number {
  if (defaultCategoryId === AUTO_CATEGORY) return AUTO_CATEGORY;
  if (piles.some((pile) => pile.id === defaultCategoryId)) return defaultCategoryId;
  const name = livePiles?.find((pile) => pile.id === defaultCategoryId)?.name;
  if (name === undefined) return AUTO_CATEGORY;
  return piles.find((pile) => pile.name === name)?.id ?? AUTO_CATEGORY;
}
