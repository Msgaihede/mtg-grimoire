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
 * `Land` leads because a land is a land before it is anything else: an artifact land is
 * where your mana comes from, and Dryad Arbor is not a creature you would find in the
 * creature column. `Creature` comes next for the same reason from the other side — an
 * Artifact Creature is a creature to everyone who has ever built a deck. A Legendary Creature
 * that is *the commander* was placed explicitly and never reaches here.
 *
 * Exported because it is also the app's type **order**: `sorting.ts` sorts by it and
 * `grouping.ts` groups by it, so a "sort by type" and a "group by type" cannot disagree
 * about what a type is or which comes first.
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
 * Where a name sorts in {@link AUTO_CATEGORIES}, with the fallback last.
 *
 * One function so the sort and the grouping share an order as well as a vocabulary. A name
 * this list has never heard of sorts with the fallback rather than at the head, which is
 * where an unknown belongs.
 */
export function autoCategoryOrder(name: string): number {
  const at = (AUTO_CATEGORIES as readonly string[]).indexOf(name);
  return at < 0 ? AUTO_CATEGORIES.length : at;
}
