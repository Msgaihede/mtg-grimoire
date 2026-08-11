/**
 * Where a card goes when the reader did not say.
 *
 * The add path takes a category id; the quick-add and the drag-from-anywhere paths often
 * have none, and this is the rule that supplies one. It reads the **type line and nothing
 * else** — not the oracle text, not the colours, not the mana value — because the answer has
 * to be one a reader can predict from the card in their hand, and because the alternative is
 * a heuristic that files Swords to Plowshares under "Removal" for some cards and not others.
 *
 * The categories panel offers "Auto-categorise from card types", which is this one rule
 * pressed once. The v8 migration deliberately does **not** run it (`schema.rs`: it would be a
 * second copy of this rule, in SQL, to keep in step) — every legacy `main` row lands in one
 * category called "Main deck" and the reader splits it when they choose to.
 */
import type { DeckCard } from "@/lib/ipc";

/**
 * The eight buckets, **in match order** — first one whose word appears on the front face
 * wins, and the order is the whole of the rule for a card with two types.
 *
 * `Land` leads because a land is a land before it is anything else. **Dryad Arbor** is the
 * case that makes this non-obvious and the reason this comment names it: its type line is
 * `Land Creature — Forest Dryad`, and a list that checked `Creature` first would file it in
 * the creature column, where no decklist has ever put it. Every artifact land is the same
 * card. `Creature` comes next for the reason from the other side — an Artifact Creature is a
 * creature to everyone who has ever built a deck. A Legendary Creature that is *the
 * commander* was placed explicitly and never reaches here.
 *
 * **This is the matching order and only the matching order.** What a reader sees is
 * {@link AUTO_CATEGORY_DISPLAY_ORDER}, which is this list with Land moved to the end — the
 * two genuinely want opposite answers about Land, and folding them back into one constant
 * breaks whichever job loses.
 */
export const AUTO_CATEGORIES = [
  "Land",
  "Creature",
  "Artifact",
  "Enchantment",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
] as const;

export type AutoCategory = (typeof AUTO_CATEGORIES)[number];

/**
 * The same eight buckets **in reading order** — Land last, as it is in every decklist ever
 * written down, because the lands are where the counting ends.
 *
 * This is what a reader sees: `grouping.ts` orders its `type` groups by it and `sorting.ts`
 * sorts by it, so a "group by type" and a "sort by type" cannot disagree.
 *
 * **Derived, never typed out a second time.** Two hand-written lists are two lists to keep in
 * step, and the day they drift the symptom is a Sorcery heading between two Instants. The one
 * transformation is stated here and nowhere else: take {@link AUTO_CATEGORIES} and move Land
 * to the end.
 *
 * The two orders differ **only** about Land, and that is not an oversight in either of them.
 * The matching order has to check Land first or Dryad Arbor (`Land Creature — Forest Dryad`)
 * is filed as a creature; the reading order has to draw it last or the decklist starts with
 * its mana base. One constant cannot be both, which is why "tidying" these back together is
 * the change to refuse.
 */
export const AUTO_CATEGORY_DISPLAY_ORDER: readonly string[] = [
  ...AUTO_CATEGORIES.filter((bucket) => bucket !== "Land"),
  "Land",
];

/**
 * Where a card with no type line goes — an orphan whose printing has left `cards`, or a
 * layout this list has no word for (a Dungeon, a Plane, an Attraction).
 *
 * **Never `""`.** The backend's find-or-create matches on `schema::DECK_CATEGORY_GRAIN`,
 * which is `(deck_id, name)`, so an empty name would be a real category — one with no
 * heading, which the reader can neither see, rename, nor switch back on.
 */
export const UNCATEGORISED = "Uncategorised";

/**
 * The four names `schema::PREDEFINED_CATEGORIES` seeds with every deck, mirrored here for
 * the guard below and for nothing else.
 *
 * `main` has no predefined name: a deck may own any number of `main` categories and the seed
 * names none. ("Main deck" is what the v8 *migration* calls the pile it files legacy rows
 * into — a perfectly ordinary user category, and deliberately not on this list.)
 */
export const PREDEFINED_CATEGORY_NAMES: readonly string[] = [
  "Commander",
  "Sideboard",
  "Companion",
  "Maybeboard",
];

/**
 * Every name {@link autoCategoryFor} can answer with — the eight buckets and the fallback.
 *
 * It exists so the collision guard can be a **sweep** rather than a review note. The trap it
 * closes: find-or-create matches on `(deck_id, name)` and ignores `kind`, so a rule that
 * ever answered `"Sideboard"` would file a plain add into the sideboard, and one that
 * answered `"Maybeboard"` would file it into a pile that is **inactive** — a card that
 * counts toward no size, no copy limit, no legality check and no allocation, having never
 * left the deck. Nothing on screen would say so. `autoCategory.test.ts` sweeps this list
 * against {@link PREDEFINED_CATEGORY_NAMES} for that reason.
 */
export const AUTO_CATEGORY_NAMES: readonly string[] = [...AUTO_CATEGORIES, UNCATEGORISED];

/**
 * The bucket one card belongs to, by its type line alone.
 *
 * The **front** face decides. `type_line` carries both halves of a double-faced card
 * separated by `//`, and the back of a modal DFC is routinely a land while its front is a
 * spell — a deck's curve is cast from the front, so reading the whole string would file
 * every MDFC spell under Land.
 */
export function autoCategoryFor(card: Pick<DeckCard, "typeLine">): string {
  const front = (card.typeLine ?? "").split("//")[0];
  return AUTO_CATEGORIES.find((bucket) => front.includes(bucket)) ?? UNCATEGORISED;
}

/**
 * Where a bucket sorts **on screen** — {@link AUTO_CATEGORY_DISPLAY_ORDER}, with the fallback
 * last.
 *
 * One function so the sort and the grouping share an order as well as a vocabulary.
 * {@link UNCATEGORISED}, and any name this list has never heard of, sorts with the unknowns
 * at the foot rather than at the head, which is where an unknown belongs.
 *
 * There is deliberately **no** exported "matching order" equivalent: the match order is
 * `autoCategoryFor`'s alone and nothing else has any business reading it.
 */
export function autoCategoryDisplayOrder(name: string): number {
  const at = AUTO_CATEGORY_DISPLAY_ORDER.indexOf(name);
  return at < 0 ? AUTO_CATEGORY_DISPLAY_ORDER.length : at;
}
