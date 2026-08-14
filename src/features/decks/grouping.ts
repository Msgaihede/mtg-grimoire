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
 *
 * The one thing above this line that is the *reader's* to decide is `separateX`: whether a
 * spell printing `{X}` is counted at the mana value Scryfall gives it or gathered into a pile
 * of its own at the tail of the curve. It is a preference about how a curve reads and says
 * nothing about what is in the deck — which is why it is a per-deck column
 * (`decks.separate_x_group`) rather than anything the validation engine has heard of.
 */
import type { CategoryKind, DeckCard, DeckCategory } from "@/lib/ipc";
import { hasVariableCost } from "@/lib/mana";
import {
  autoCategoryDisplayOrder,
  autoCategoryFor,
  PREDEFINED_CATEGORY_NAMES,
} from "./autoCategory";
import { sortCards, type SortBy } from "./sorting";

export type GroupBy = "category" | "manaValue" | "type";

/** The toolbar's Group by select, so the three are named in one place. **The order here is not
 *  the order they are offered in** — a picker sorts by label (`src/lib/options.ts`), so this
 *  array is free to read in whatever order explains the modes and a fourth entry may be
 *  appended without deciding where it appears. */
export const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: "category", label: "Categories" },
  { value: "manaValue", label: "Mana value" },
  { value: "type", label: "Type" },
];

/** What a deck is grouped by until somebody says otherwise — the editor's initial state, and
 *  what a stored value this build cannot draw falls back to. */
export const DEFAULT_GROUP_BY: GroupBy = "category";

/** Derived from {@link GROUP_BY_OPTIONS} rather than written out a second time: a fourth
 *  grouping added to that array is offered *and* accepted from storage in one edit. */
const GROUP_BY_VALUES: ReadonlySet<string> = new Set(GROUP_BY_OPTIONS.map((o) => o.value));

/**
 * A stored `Group by` as a mode this build actually has, or {@link DEFAULT_GROUP_BY}.
 *
 * `DeckRow.lastGroupBy` arrives as a `string` on purpose — the vocabulary is this module's and
 * a database outlives the app, so a row written by a newer build, or one holding a word this
 * build has since dropped, is a value the wire has to carry rather than reject. What it must
 * **not** do is reach the toolbar: a select holding a value that is in none of its own options
 * is a control the reader cannot see their way out of. So an unknown word degrades to the
 * default and the editor draws a mode it can also leave.
 */
export function asGroupBy(value: string): GroupBy {
  return GROUP_BY_VALUES.has(value) ? (value as GroupBy) : DEFAULT_GROUP_BY;
}

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
   * `sum(unitPrice × quantity)` over the cards in this group that have a price, `null` when
   * none of them does.
   *
   * A partial total rather than nothing, because the surface that draws it also carries the
   * as-of sentence and a reader pricing a deck would rather know most of it. `null` rather
   * than `0` when nothing is priced, because `$0.00` is a price nobody quoted.
   *
   * **Whose prices is not a question this file answers.** The rows arrived already priced at
   * the marketplace their query named, so two marketplaces' totals over one pile are two
   * honest sums rather than a conversion of each other — each leaves out the copies *it*
   * cannot price.
   */
  totalPrice: number | null;
}

/**
 * The X pile's key and heading, exported so no caller — a chart, a story, a test — re-spells
 * either one. The key is a `CardGroup.key` like `mv-3` and shares its namespace deliberately:
 * it is one more mana-value heading, not a category, and nothing can be dropped into it.
 */
export const X_GROUP_KEY = "mv-x";
export const X_GROUP_NAME = "Mana value X";

/**
 * The mana-value buckets: 0–7 exactly, 8 open-ended, X, unknown last.
 *
 * `null` is *unknown* rather than zero — `cards.cmc` is nullable and an orphaned row has no
 * mana value at all, so filing it under 0 would be a number this app made up, sitting at the
 * head of the curve where a reader counts their cheapest spells.
 *
 * **`separateX` is the reader's own preference and the X test runs first.** A card printing
 * `{X}` has a `cmc` — Scryfall counts the variable as 0, so Fireball is mana value 1 — and
 * that number is honest about a spell nobody would cast for one mana. When the switch is on,
 * such a card leaves its `cmc` bucket entirely; see {@link buildGroups} for why it cannot be
 * in both. Running the test *before* the `null` check is the second half of the rule: an X in
 * the printed cost is knowledge, and *unknown* is for a row that carries none.
 *
 * X takes order 9 and unknown moves to 10, so the curve reads `0 … 8 or more, X, unknown`.
 * Like "8 or more", X is open-ended rather than a number, so it belongs at the tail rather
 * than at the head where a reader counts their cheapest spells; unknown stays behind it
 * because it is the absence of an answer rather than an answer.
 */
function manaValueBucket(
  card: Pick<DeckCard, "cmc" | "manaCost">,
  separateX: boolean,
): { key: string; name: string; order: number } {
  if (separateX && hasVariableCost(card.manaCost)) {
    return { key: X_GROUP_KEY, name: X_GROUP_NAME, order: 9 };
  }
  if (card.cmc === null) return { key: "mv-unknown", name: "Mana value unknown", order: 10 };
  const mv = Math.min(8, Math.max(0, Math.floor(card.cmc)));
  return {
    key: `mv-${mv}`,
    name: mv === 8 ? "Mana value 8 or more" : `Mana value ${mv}`,
    order: mv,
  };
}

/** Copies and money, the two sums every group carries, computed once. An unpriced row is left
 *  out of the sum rather than valued at anything: it is unpriced *at the marketplace the deck
 *  was read at*, and there is no second number here to reach for. */
function totals(cards: readonly DeckCard[]): { count: number; totalPrice: number | null } {
  let count = 0;
  let price = 0;
  let priced = false;
  for (const card of cards) {
    count += card.quantity;
    if (card.unitPrice !== null) {
      price += card.unitPrice * card.quantity;
      priced = true;
    }
  }
  return { count, totalPrice: priced ? price : null };
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
 * @param separateX the deck's own `separateXGroup` preference — see below. Defaults to
 *   `false`, which is what this function answered before the switch existed, so every caller
 *   that has not heard of it keeps the grouping it had.
 *
 * **There is no currency argument any more.** It took one while every row carried two prices,
 * so that a heading's total and the `price` order under it could not be computed from
 * different ones. Rust now answers a single `unitPrice` per row, at the marketplace the deck
 * was read at, so the heading and its rows agree by construction and there is nothing to pass.
 *
 * **`separateX` is a `manaValue` rule and is inert everywhere else.** Under `category` the
 * headings are the reader's own piles, and under `type` they are what a card *is*; neither is
 * a curve, and an "X" column beside Creature would be a fourth grouping wearing the third
 * one's name. It is passed through to {@link manaValueBucket}, which is called from the one
 * `manaValue` arm, so the inertness is structural rather than a branch to keep in step.
 *
 * **A card is in the X group or in its `cmc` bucket, never in both.** Every surface that draws
 * these headings counts copies and sums prices per group — the editor's column captions, the
 * curve, the stats strip — so a card counted twice makes the headings add up to more than the
 * deck, and the reader has no way to see which pile lied.
 */
export function buildGroups(
  cards: readonly DeckCard[],
  categories: readonly DeckCategory[],
  groupBy: GroupBy,
  sortBy: SortBy,
  separateX = false,
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
        ? manaValueBucket(card, separateX)
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
          totalPrice: null,
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
