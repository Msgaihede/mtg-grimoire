/**
 * The order the deck gallery's wall is drawn in — six keys, a direction, and one function every
 * surface that shows decks calls.
 *
 * `sorting.ts` is this module's sibling one level down: that one orders the cards inside a deck,
 * this one orders the decks. The two rules it states are the two rules here, and they are stated
 * again rather than cross-referenced because they are the properties a comparator has to be
 * *written* to have:
 *
 * **Stable.** `Array.prototype.sort` is stable (ES2019, and every engine this ships in), so two
 * decks a comparator cannot separate keep the order `deck_list` returned them in — archived
 * last, most recently touched first. A wall that reshuffled its ties on every redraw would move
 * tiles under a reader who had not asked for anything.
 *
 * **Total.** Two of the six keys read a fact that may simply not have arrived: the colour bar's
 * pips and the bracket estimate are each a query of their own, and a gallery draws its tiles
 * long before either answers. A comparator that threw there would take the whole page down over
 * a read still in flight, so the missing answer sorts to the end instead — `sorting.ts`'s
 * `nullsLast` gives the reason and it is the same one: unknown is never zero, and putting an
 * unknown at the head is putting it exactly where a reader counts their lowest brackets.
 *
 * ## What `desc` does, which is reverse *everything*
 *
 * Each key has a natural direction ({@link NATURAL_DESC}) and the toolbar's toggle reverses
 * whatever that is. Every comparator is written **in its own natural direction** and the toggle
 * negates the whole of one, tiebreaks included, so **the reverse of a list is that list upside
 * down** and not a differently-shuffled one — a reader who presses the arrow twice is back where
 * they started, and one who presses it once can read the same wall from the other end. Ties still
 * compare 0 and therefore still keep `deck_list`'s order, so stability survives the flip.
 * {@link comparatorFor} says why they are written that way round rather than uniformly ascending.
 *
 * That is also the one place this file's "unknowns last" differs from `nullsLast`, which pins
 * them at the foot in **both** directions. It can: a card sort has no direction toggle at all,
 * so its `descending` flag describes one fixed order rather than a control the reader presses.
 * Here there is a control, and a toggle that visibly failed to move a block of tiles would read
 * as a toggle that did not take. So the rule holds where it is claimed — a deck whose bracket
 * has not arrived sorts **last in the key's natural direction**, which is the direction the
 * reader gets the moment they pick that key — and reversing puts them first, on purpose.
 */
import { compareLabels } from "@/lib/options";
import { MANA_LINE_KEYS, type PipCounts } from "@/lib/mana";
import type { DeckRow } from "@/lib/ipc";
/** The one place `decks.bracket` and the estimate are reconciled into a single number. It
 *  lives beside the hook that produces the estimates because that is where a reader looking
 *  for "what number does this tile show" goes; a second reading of the `AUTO_BRACKET`
 *  sentinel here is how a sort and a caption come to disagree about one deck. */
import { effectiveBracket } from "./useDeckBrackets";

/** What a wall of decks can be ordered by. The vocabulary the stored `app_meta` row spells. */
export type DeckSortKey = "updated" | "name" | "colors" | "bracket" | "cards" | "format";

/** One order: which key, and which way round. */
export interface DeckSort {
  key: DeckSortKey;
  desc: boolean;
}

/**
 * The picker's rows.
 *
 * **The order of this array is not the order they are offered in.** `src/lib/options.ts` is the
 * app's one rule for an option list — alphabetical by the words on screen — and `SORT_OPTIONS`
 * in `sorting.ts` states the consequence this array inherits: the picker sorts by label, so this
 * list is free to read in whatever order explains the sorts, and a seventh key may be appended
 * without anybody deciding where it appears.
 */
export const DECK_SORT_OPTIONS: readonly { value: DeckSortKey; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "name", label: "Name" },
  { value: "colors", label: "Colors" },
  { value: "bracket", label: "Bracket" },
  { value: "cards", label: "Cards" },
  { value: "format", label: "Format" },
];

/**
 * What the gallery opens on, and what a stored word this build cannot draw falls back to.
 *
 * **It is today's order exactly** — `deck_list` answers most recently touched first, and this
 * reproduces that — so the gallery a reader knows is the gallery they get until they press
 * something. A default that quietly re-sorted the wall on the release that added a sort control
 * would look like the update had lost their decks.
 */
export const DEFAULT_DECK_SORT: DeckSort = { key: "updated", desc: true };

/**
 * Which way round each key reads when the reader first picks it.
 *
 * Two of the six count something, and a count is interesting from the top: the deck touched most
 * recently and the biggest pile are what a reader is looking for when they choose those keys.
 * The other four are alphabets and ladders — names, formats, colours in printed order, brackets
 * from 2 upward — and every one of those is read forwards.
 *
 * The toggle does not swap a glyph for this; it turns the one arrow `FilterBar` already draws.
 */
export const NATURAL_DESC: Record<DeckSortKey, boolean> = {
  updated: true,
  name: false,
  colors: false,
  bracket: false,
  cards: true,
  format: false,
};

/** Derived from {@link DECK_SORT_OPTIONS} rather than written out twice, so a seventh key is
 *  offered *and* accepted from storage in one edit — `sorting.ts`'s `SORT_VALUES`. */
const SORT_KEYS: ReadonlySet<string> = new Set(DECK_SORT_OPTIONS.map((o) => o.value));

/**
 * A stored `"<key>:<direction>"` as an order this build actually has, or
 * {@link DEFAULT_DECK_SORT}.
 *
 * **It accepts anything and answers something**, which is `asSortBy`'s contract in
 * `sorting.ts:47` one table over and holds for the same reason: the string comes out of
 * `app_meta`, a database outlives the app, and a key some future build stops offering has to
 * become an order the reader can leave rather than one the toolbar cannot draw. So there is no
 * error path, no `null` and nothing for a caller to handle.
 *
 * **A half-understood string degrades whole.** `"name:sideways"` answers the default rather than
 * `name` with a guessed direction: the two halves were written together by a build that meant
 * something by the pair, and honouring one of them would be this module inventing an order
 * nobody chose and then remembering it.
 */
export function parseDeckSort(stored: string): DeckSort {
  const parts = stored.split(":");
  // Exactly two, so `"name:asc:something"` degrades rather than having its tail quietly dropped:
  // a third field is a build that meant something by it, and honouring the first two of three is
  // the same guess this function refuses to make about a direction.
  if (parts.length !== 2) return DEFAULT_DECK_SORT;
  const [key, direction] = parts;
  if (!SORT_KEYS.has(key)) return DEFAULT_DECK_SORT;
  if (direction !== "asc" && direction !== "desc") return DEFAULT_DECK_SORT;
  return { key: key as DeckSortKey, desc: direction === "desc" };
}

/** The row {@link parseDeckSort} reads back. One string, so one `app_meta` cell holds the
 *  whole order. */
export function formatDeckSort(sort: DeckSort): string {
  return `${sort.key}:${sort.desc ? "desc" : "asc"}`;
}

/**
 * What the facts a comparator cannot get off a {@link DeckRow} come from.
 *
 * Both are maps rather than fields because both are separate reads: `deck_pip_costs` for the
 * colour bar, `deck_bracket_reads` for the estimate. A deck missing from either is a deck those
 * reads have not answered for — see the module header on what that costs it.
 */
export interface DeckSortContext {
  pips: Map<number, PipCounts>;
  brackets: Map<number, number>;
}

/** Deck names, compared the way an option list is — `compareLabels`, so case and accents do not
 *  split the wall and `"Set 2"` precedes `"Set 10"`. `options.ts` owns the collator and the
 *  reason it is pinned to `"en"`. */
const byName = (a: DeckRow, b: DeckRow) => compareLabels(a.name, b.name);

/** The words on the tile, which is what a reader sorting by format is reading. `formatName` is
 *  `null` only where the seeded `format_specs` table no longer carries the key — the deck still
 *  lists, and its raw key is the honest label for it. */
const formatLabel = (deck: DeckRow) => deck.formatName ?? deck.formatKey;

/**
 * A nullable number ascending, with `null` **after** every real one.
 *
 * `sorting.ts`'s `nullsLast` with its direction flag dropped, because the direction is applied
 * to the whole comparator here rather than to one term of it — see the module header. The reason
 * for the arm itself is that file's word for word: unknown is not zero, and a deck whose bracket
 * has not been read is not a bracket 0 deck.
 */
function unknownLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Which of the three colour groups a deck is in: **coloured**, **colourless**, **unknown**.
 *
 * The plan's order reads "mono W→U→B→R→G, then multicolour …, then colourless", and this is the
 * outer step of it. Colourless is a real answer — a deck of `{C}` costs and Eldrazi has an
 * identity, and the bar draws it a segment — so it sorts after every coloured deck rather than
 * with the decks that have nothing. A deck with no pips at all is the third group: an all-lands
 * pile, a deck of nothing but generic costs, and a deck whose pip read has not arrived are
 * indistinguishable from here, and all three have no colour to be placed by.
 */
function colorRank(pips: PipCounts | undefined): number {
  if (pips === undefined) return 2;
  for (const key of MANA_LINE_KEYS) if (pips[key] > 0) return 0;
  return pips.C > 0 ? 1 : 2;
}

/** How many of the five a deck plays — 1 for mono, 2+ for multicolour, which is the whole of
 *  the "mono first, then by colour count" half of the order. */
function colorCount(pips: PipCounts | undefined): number {
  if (pips === undefined) return 0;
  return MANA_LINE_KEYS.filter((key) => pips[key] > 0).length;
}

/**
 * The deck's colours as one number, **W in the high bit**: `W` is 16 and `G` is 1.
 *
 * Compared **high first**, which is exactly a lexicographic comparison of the two colour lists
 * in printed order and is the only arrangement that gives the sequence a Magic player expects:
 * `WU` (24) before `WB` (20) before `WR` (18) before `WG` (17) before `UB` (12). Ascending on
 * this mask, or a mask with `W` in the low bit, sorts `WG` after `UB` — a guild pair split
 * across the whole multicolour block for a reason nothing on screen could explain.
 *
 * The count is compared before this, so the two sides of a mask comparison always name the same
 * number of colours and the shorter-prefix case a lexicographic order has to worry about cannot
 * arise.
 */
function colorMask(pips: PipCounts | undefined): number {
  if (pips === undefined) return 0;
  let mask = 0;
  MANA_LINE_KEYS.forEach((key, index) => {
    if (pips[key] > 0) mask |= 1 << (MANA_LINE_KEYS.length - 1 - index);
  });
  return mask;
}

/**
 * The six orders, each written in **its own natural direction** ({@link NATURAL_DESC}) rather
 * than uniformly ascending — which is the one shape decision in this file, and it is what lets
 * the two rules the plan states both be true at once.
 *
 * Write them all ascending and negate on `desc`, and the *tiebreak* turns round with the primary
 * term: `cards` reads biggest-first by default, so its name tiebreak would run Z→A and two
 * hundred-card decks would list `Zur` above `Atraxa` for no reason a reader could see. Write them
 * naturally instead and each tiebreak is stated once, in the direction it is meant to read —
 * names forwards, and `updated`'s id backwards alongside its own descending stamp, because there
 * the tie *is* "which of these two was made later" and that is the same question the
 * second-resolution timestamp was trying to answer.
 *
 * {@link sortDecks} then turns the whole thing round only when the reader's direction differs
 * from the natural one, so the toggle is still an exact reversal of the list on screen.
 */
function comparatorFor(sort: DeckSortKey, ctx: DeckSortContext) {
  switch (sort) {
    // Newest first, and the id tiebreak rather than the name one: `updatedAt` is unix **seconds**
    // and two decks touched in the same second are common enough to see — a duplicate and its
    // original, a bulk import. Ids are monotonic, so the later id is the later deck.
    case "updated":
      return (a: DeckRow, b: DeckRow) => b.updatedAt - a.updatedAt || b.id - a.id;
    case "name":
      return (a: DeckRow, b: DeckRow) => byName(a, b) || a.id - b.id;
    case "colors":
      return (a: DeckRow, b: DeckRow) => {
        const pa = ctx.pips.get(a.id);
        const pb = ctx.pips.get(b.id);
        return (
          colorRank(pa) - colorRank(pb) ||
          colorCount(pa) - colorCount(pb) ||
          colorMask(pb) - colorMask(pa) ||
          byName(a, b)
        );
      };
    case "bracket":
      return (a: DeckRow, b: DeckRow) =>
        unknownLast(
          effectiveBracket(a.bracket, ctx.brackets.get(a.id)),
          effectiveBracket(b.bracket, ctx.brackets.get(b.id)),
        ) || byName(a, b);
    // The biggest pile first, which is what a reader picking a card count is looking for — and
    // the names still read forwards inside a size, because a name has no natural relationship to
    // a number of cards for a direction to be inherited from.
    case "cards":
      return (a: DeckRow, b: DeckRow) => b.cardCount - a.cardCount || byName(a, b);
    case "format":
      return (a: DeckRow, b: DeckRow) =>
        compareLabels(formatLabel(a), formatLabel(b)) || byName(a, b);
  }
}

/**
 * The wall, ordered — a **new** array.
 *
 * **Copies rather than sorting in place**, which is `sortOptions`' rule in `options.ts` and is
 * load-bearing for the same reason: the array reaching this is React Query's own cached
 * `deck_list` answer, and sorting it mutates the cache every other reader of `["decks", "list"]`
 * shares. The gallery, the move-to-deck menus and the folder cards all read that one array.
 *
 * The direction is applied by negating the comparator rather than by swapping the arguments, so
 * a tie still returns exactly `0` and the sort stays stable through the flip. And it is negated
 * only when the reader's direction **differs from the key's natural one** — `comparatorFor`
 * already answers in the natural direction, and negating on `sort.desc` alone would turn every
 * naturally-descending key upside down before the reader had touched anything.
 */
export function sortDecks(
  decks: readonly DeckRow[],
  sort: DeckSort,
  ctx: DeckSortContext,
): DeckRow[] {
  const compare = comparatorFor(sort.key, ctx);
  const turned = sort.desc !== NATURAL_DESC[sort.key];
  return [...decks].sort(turned ? (a, b) => -compare(a, b) : compare);
}
