/**
 * The one place a view learns what its groups are.
 *
 * Four views draw a deck — the stack, the table, the text columns and the grid — and every
 * one of them takes `CardGroup[]` and renders it. Nothing below this line knows about a
 * category, a bucket or a sort; nothing above it re-derives one. That is what keeps four
 * surfaces from answering "how many cards are in the Ramp column" four ways.
 *
 * **The rule that governs the whole file**, and the one the spec is most explicit about:
 * *the switch decides whether a pile counts at all; the kind decides only whether the pile
 * is played beside the deck or in it.* So an inactive category is never bucketed into
 * somebody else's curve — but it is never hidden either, because the affordance for
 * switching it back on is seeing it. Under `manaValue` and `type` the derived groups are
 * built from the **active** cards only, and every **inactive category** is then appended as
 * itself, unchanged, in `sortOrder`.
 */
import type { CategoryKind, DeckCard, DeckCategory } from "@/lib/ipc";
import {
  autoCategoryDisplayOrder,
  autoCategoryFor,
  PREDEFINED_CATEGORY_NAMES,
} from "./autoCategory";
import { sortCards, type SortBy } from "./sorting";

export type GroupBy = "category" | "manaValue" | "type";

/** The toolbar's Group by select, so the three are named in one place. */
export const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: "category", label: "Categories" },
  { value: "manaValue", label: "Mana value" },
  { value: "type", label: "Type" },
];

/**
 * One heading and the cards under it.
 *
 * Two kinds of group wear this one shape, and `categoryId` is what tells them apart:
 *
 * * a **category** group *is* a pile of the deck. It has an id, so a card can be dropped
 *   into it, its heading renamed and its switch flipped; it draws even when it is empty,
 *   because an empty Sideboard is where the next sideboard card goes.
 * * a **derived** group is a heading and nothing more — `categoryId`, `kind` `null`. Nothing
 *   can be dropped into "Mana value 3", and an empty one does not exist at all.
 */
export interface CardGroup {
  /** Stable across regroupings, so React keeps the rows rather than remounting them. */
  key: string;
  /** The heading, and the accessible name of the list under it. */
  name: string;
  /** The rules word, for a category group. `null` for a derived one, which has no rules
   *  role at all. */
  kind: CategoryKind | null;
  /** `null` for a derived group — which is exactly the test for "can a card be dropped
   *  here", since every deck write is addressed by a category id. */
  categoryId: number | null;
  /**
   * Whether what is in here counts toward anything: size, copy limits, legality, the
   * allocator's claims. A derived group is built from active cards, so it is always `true`.
   */
  isActive: boolean;
  /** One of the four `schema::PREDEFINED_CATEGORIES` — cannot be renamed or deleted, which
   *  is the whole of what a heading needs to know about it. */
  isPredefined: boolean;
  /** In the order `sortBy` asked for, already applied. */
  cards: DeckCard[];
  /** **Copies**, not rows: four Bolts are four cards, and a deck is counted in cards. */
  count: number;
  /**
   * `sum(unitPriceUsd × quantity)` over the cards that have a price, `null` when none of
   * them does.
   *
   * A partial total rather than nothing, because the surface that draws it also carries
   * `PRICES_AS_OF` and a reader pricing a deck would rather know most of it. `null` rather
   * than `0` when nothing is priced, because `$0.00` is a price nobody quoted.
   */
  totalPriceUsd: number | null;
}

/**
 * The mana-value buckets: 0–7 exactly, 8 open-ended, unknown last.
 *
 * `null` is *unknown* rather than zero — `cards.cmc` is nullable and an orphaned row has no
 * mana value at all, so filing it under 0 would be a number this app made up, sitting at the
 * head of the curve where a reader counts their cheapest spells.
 */
function manaValueBucket(cmc: number | null): { key: string; name: string; order: number } {
  if (cmc === null) return { key: "mv-unknown", name: "Mana value unknown", order: 9 };
  const mv = Math.min(8, Math.max(0, Math.floor(cmc)));
  return {
    key: `mv-${mv}`,
    name: mv === 8 ? "Mana value 8 or more" : `Mana value ${mv}`,
    order: mv,
  };
}

/** Copies and money, the two sums every group carries, computed once. */
function totals(cards: readonly DeckCard[]): { count: number; totalPriceUsd: number | null } {
  let count = 0;
  let price = 0;
  let priced = false;
  for (const card of cards) {
    count += card.quantity;
    if (card.unitPriceUsd !== null) {
      price += card.unitPriceUsd * card.quantity;
      priced = true;
    }
  }
  return { count, totalPriceUsd: priced ? price : null };
}

/** A category, as the group that *is* it. */
function categoryGroup(category: DeckCategory, cards: DeckCard[]): CardGroup {
  return {
    key: `cat-${category.id}`,
    name: category.name,
    kind: category.kind,
    categoryId: category.id,
    isActive: category.isActive,
    // By kind and not by name: a user is free to call a pile of their own "Sideboard" —
    // `DECK_CATEGORY_GRAIN` allows it, because the predefined Sideboard was never named by
    // the user — and that one is theirs to rename and delete like any other.
    isPredefined: category.kind !== "main" && PREDEFINED_CATEGORY_NAMES.includes(category.name),
    cards,
    ...totals(cards),
  };
}

/**
 * A row whose `categoryId` is in no category the read answered with, drawn under the name
 * the row itself carries.
 *
 * It should not happen — `DeckDetail.categories` is *every* category of the deck — and it is
 * handled anyway for `sortCards`' reason: a card the editor silently dropped is worse than a
 * heading nobody expected, and this is the only branch where "drop it" was even available.
 */
function strayGroup(cards: DeckCard[]): CardGroup {
  const first = cards[0];
  return {
    key: `cat-${first.categoryId}`,
    name: first.categoryName,
    kind: first.categoryKind,
    categoryId: first.categoryId,
    isActive: first.categoryActive,
    isPredefined: false,
    cards,
    ...totals(cards),
  };
}

/**
 * The deck, as headings and rows.
 *
 * @param cards every row of the variant on screen, in the read's own order
 * @param categories every category of the deck, in `sortOrder` — including the empty ones
 * @param groupBy what the headings are
 * @param sortBy the order inside each heading
 */
export function buildGroups(
  cards: readonly DeckCard[],
  categories: readonly DeckCategory[],
  groupBy: GroupBy,
  sortBy: SortBy,
): CardGroup[] {
  const byCategory = new Map<number, DeckCard[]>();
  for (const card of cards) {
    const bucket = byCategory.get(card.categoryId);
    if (bucket) bucket.push(card);
    else byCategory.set(card.categoryId, [card]);
  }

  const ordered = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  // The piles, drawn whether or not anything is in them: a category is a place as well as a
  // heading, and a column that vanished with its last card is a column the reader cannot put
  // one back into. That holds for the four predefined piles and for the reader's own alike —
  // a category made and not yet filled does not disappear between two keystrokes.
  const categoryGroups = ordered.map((category) =>
    categoryGroup(category, sortCards(byCategory.get(category.id) ?? [], sortBy)),
  );

  // Anything filed under a category the read did not answer with, after the real ones.
  const known = new Set(ordered.map((c) => c.id));
  const strays = [...byCategory.entries()]
    .filter(([id]) => !known.has(id))
    .map(([, rows]) => strayGroup(sortCards(rows, sortBy)));

  if (groupBy === "category") return [...categoryGroups, ...strays];

  // Derived: the active cards are bucketed, and every switched-off pile is appended as
  // itself. Both halves are the rule. Bucketing an inactive card would count a Maybeboard
  // card into the curve the reader is reading; dropping the pile would make ten cards vanish
  // from the editor the moment the grouping changed, with no way to get them back.
  const derived = new Map<string, { order: number; group: CardGroup }>();
  for (const card of cards) {
    if (!card.categoryActive) continue;
    const bucket =
      groupBy === "manaValue"
        ? manaValueBucket(card.cmc)
        : (() => {
            // What the card *is* comes from the matching order; where its heading *sits*
            // comes from the reading order, which puts Land last. See `autoCategory.ts` for
            // why those are two lists and must stay two.
            const name = autoCategoryFor(card);
            return { key: `type-${name}`, name, order: autoCategoryDisplayOrder(name) };
          })();

    const seen = derived.get(bucket.key);
    if (seen) seen.group.cards.push(card);
    else {
      derived.set(bucket.key, {
        order: bucket.order,
        group: {
          key: bucket.key,
          name: bucket.name,
          kind: null,
          categoryId: null,
          isActive: true,
          isPredefined: false,
          cards: [card],
          count: 0,
          totalPriceUsd: null,
        },
      });
    }
  }

  const derivedGroups = [...derived.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ group }) => ({
      ...group,
      cards: sortCards(group.cards, sortBy),
      ...totals(group.cards),
    }));

  return [...derivedGroups, ...[...categoryGroups, ...strays].filter((group) => !group.isActive)];
}
