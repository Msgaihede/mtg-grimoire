import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ipc,
  type SearchRequest,
  type SearchResponse,
  type SearchSortKey,
  type TagNamespace,
} from "@/lib/ipc";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";
import {
  chipKey,
  mergeTagTerms,
  termsFor,
  type TagChip,
  type TagSelection,
} from "@/features/tags/tagFilters";
import { useCardFacets, type FacetRequest } from "./useCardFacets";
import {
  parseTagQuery,
  removeToken,
  setTokenNegated,
  setTokenValue,
  tokenKey,
  type TagToken,
} from "./tagQuery";

/**
 * No tag chips — what a caller that has never heard of the Tags page passes.
 *
 * One shared frozen object rather than a fresh `{}` per render: it is spread into the
 * request payload and into the facet request, and a caller that hands back a new empty
 * object each time is a caller nothing downstream may depend on the identity of. Frozen for
 * `EMPTY_SELECTION`'s reason — a cast gets past the type and this does not.
 */
const EMPTY_TAG_TERMS: Pick<SearchRequest, "artTags" | "oracleTags" | "artWeightFloor"> =
  Object.freeze({});

/** Rows per request. The backend clamps at 200; 50 is one screenful plus slack. */
export const PAGE_SIZE = 50;

/** How long the search box stays quiet before a keystroke becomes a query. */
export const DEBOUNCE_MS = 300;

/**
 * The `legalities` keys the format picker offers, in the order those keys rank — which is a
 * fact about the formats and **not** the order anybody sees.
 *
 * Every picker draws this through `sortOptions` (`@/lib/options`): alphabetically by `label`,
 * with the formats this search has nothing legal in sunk to the bottom. So reordering the
 * array below moves nothing on screen and only costs the keys their one written order — a
 * picker drawn wrong is a bug in that picker's `sortOptions` call, never in this list.
 */
export const FORMATS = [
  { value: "standard", label: "Standard" },
  { value: "pioneer", label: "Pioneer" },
  { value: "modern", label: "Modern" },
  { value: "legacy", label: "Legacy" },
  { value: "vintage", label: "Vintage" },
  { value: "pauper", label: "Pauper" },
  { value: "commander", label: "Commander" },
] as const;

/**
 * One row of the format filter — the `legalities` key the backend filters by, and the word the
 * picker draws it as. Named for the *filter* rather than for a format, because
 * `useFormatSpecs.ts` already exports a `FormatOption` of `{ key, name }` for the deck's own
 * picker and the two are not the same shape.
 */
export interface FormatFilterOption {
  value: string;
  label: string;
}

/**
 * The format filter's widest row: **every card, including the printings no format allows** —
 * art series, tokens, emblems, memorabilia.
 *
 * A value of the format select rather than a chip beside it, because the two controls were
 * asking one question. `Any format` already means "legal in at least one of Scryfall's
 * formats", so the old `Unplayable` chip's only reachable job was to widen *that* row: pressing
 * it with a format picked did nothing at all, because a card legal in Modern is legal
 * somewhere by definition. Three rows in one list say the whole thing once — everything,
 * everything playable, or one named format — and the state that used to mean "Modern, and also
 * the art cards" is gone rather than hidden.
 *
 * **The hyphen is what makes it safe.** This value shares a namespace with the `legalities`
 * keys the backend filters by and with the `format_specs.key`s the deck editor seeds from, and
 * neither has ever carried one: they are single lowercase words (`standardbrawl`,
 * `paupercommander`, `oldschool`). So no real format can collide with the sentinel, and
 * {@link formatParams} can tell them apart by equality rather than by a second flag travelling
 * beside the value.
 */
export const ANY_CARD = "any-card";

/**
 * The two things the one format select decides: which `legalities` key the backend narrows to,
 * and whether the printings no format allows are in the corpus at all.
 *
 * `playableOnly` rides with **every** row but `Any card`, the named formats included, and that
 * is not belt-and-braces — it is what makes the three rows nest. A card legal in Modern is
 * legal somewhere, so the flag cannot narrow a format row any further; sending it anyway means
 * one expression answers all three rows, and there is no fourth combination for a reader to
 * reach.
 *
 * Both fields are **absent rather than `false`** on `Any card`, which is the request every
 * other caller of `search_cards` sends: `playableOnly` is omitted-means-false (the opposite of
 * `paperOnly` beside it — see `SearchRequest.playableOnly`), so "show them" is no filter at
 * all, and spelling it out would make the payload lie about intent.
 *
 * Exported because it is the whole of the mapping and both the page's payload and the facet
 * request are built from it — two copies of this branch are how a wall of cards and the counts
 * greying its chips come to describe different corpora.
 */
export function formatParams(selection: string): { format?: string; playableOnly?: true } {
  if (selection === ANY_CARD) return {};
  return { format: selection || undefined, playableOnly: true };
}

/**
 * The orders the filter bar's sort picker offers.
 *
 * **This array's order is its declaration order and nothing else.** `FilterBar`'s sort
 * `<select>` draws it alphabetically by label through `sortOptions` (`lib/options.ts`), and
 * the only other reader — `sortSelection` below — asks nothing about position. So reordering
 * these seven lines moves nothing a reader sees; it only costs them the one grouping they
 * have, which is the five the table's headers also reach, then the two nothing on screen can.
 * Add to the end.
 *
 * **`manaValue` and `released` have no header to press**, and they are why this picker is
 * more than the table's headers restated. There is no room for two more columns — the reason
 * is at {@link SearchSortKey} — so this is the same trade the collection's select made for
 * "Recently added", from the view whose table is one column wider.
 *
 * **No `Custom…` row, and none can be needed here.** The collection's select carries one
 * because it offers 5 of its 7 keys, so a header can build a sort that select cannot name.
 * This list is *every* key the search sorts by, so `sortSelection` can only ever come back
 * `""` for an empty spec — a state the picker has a real row for.
 */
export const SEARCH_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "set", label: "Set" },
  { value: "type", label: "Type" },
  { value: "rarity", label: "Rarity" },
  { value: "price", label: "Price" },
  { value: "manaValue", label: "Mana value" },
  { value: "released", label: "Released" },
] as const satisfies readonly { value: SearchSortKey; label: string }[];

/**
 * Which direction one press on each key asks for first.
 *
 * Descending on price, because "highest first" is what clicking a money column means, and
 * ascending on everything that reads as a list. The table's own columns carry this too, as
 * documentation; this table is the one that runs, because the state lives here with the
 * query. Keep the two in step.
 *
 * The two keys with no column follow the same split from the picker: `manaValue` ascending
 * because a curve reads as a list, and `released` **descending** because "newest first" is
 * what pressing a release date means — the argument `price` above it carries, and the one
 * behind the collection's `added: "desc"`.
 */
const SEARCH_FIRST_DIR: Record<SearchSortKey, SortDir> = {
  name: "asc",
  set: "asc",
  type: "asc",
  rarity: "asc",
  price: "desc",
  manaValue: "asc",
  released: "desc",
};

/**
 * The filter's colours are the interface's mana symbols — the same six letters in the same
 * order, and `colorParam` depends on that order to make "U then W" and "W then U" the same
 * query key. This module used to declare its own copy; an alias is what is left, because
 * two lists that must stay identical will not.
 */
export type ColorKey = ManaKey;

// `MANA_VALUES` moved to `@/components/FilterChips`, with the chips that draw it. It is not
// re-exported from here: the one importer moved with it, and a pass-through nobody imports
// is a second name for one thing that only exists to be found by a search.

/** Add or remove one value. The order values were picked in is not information. */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Move a three-state filter on one press: off → the caller's question → its opposite → off.
 *
 * One chip and not two, because the two questions are opposites of each other rather than
 * two independent switches — "owned" and "missing" cannot both be on, and a pair of chips
 * that can be would offer a combination meaning nothing. `first` is which of them the press
 * lands on, because it is not the same question in both views that use this: a search asks
 * "what have I already got", a shopping list asks "what am I still missing".
 *
 * The chip's *label* is what says which state is on — an unpressed chip cannot mean "not
 * owned" and also be the same chip that means it when pressed.
 */
export function cycleTriState(current: boolean | undefined, first: boolean): boolean | undefined {
  if (current === undefined) return first;
  return current === first ? !first : undefined;
}

/** Everything {@link activeFilterCount} counts — every filter the search view offers. */
export interface FilterState {
  text: string;
  /**
   * The format select's whole value: `""` for `Any format`, {@link ANY_CARD} for `Any card`,
   * or a `legalities` key. Two of those three are "no format filter" and only one of them is
   * the default, which is why the count below tests for a non-empty string rather than for a
   * format.
   */
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  /** The X chip — "also the cards with `{X}` in their printed cost". The other half of the
   *  same question `manaValues` asks, which is why the two are counted as one kind below. */
  manaX: boolean;
  /** `false` is a filter too — "the cards I do *not* have" — so this is compared against
   *  `undefined` rather than tested for truthiness. */
  owned: boolean | undefined;
}

/**
 * How many *kinds* of filter are on.
 *
 * Kinds, not values: this number captions a Reset all button, and its job is to tell the
 * reader how much is about to change. Three colours in one chip row is one thing that is
 * on, not three.
 */
export function activeFilterCount(f: FilterState): number {
  return [
    f.text.trim().length > 0,
    // **`Any card` counts, and it is the one row here that *widens*.** This number captions
    // Reset all and answers "how much would pressing this change" — reset puts the select back
    // on `Any format`, so a reader sitting on `Any card` really does have one thing that press
    // would clear. A count that read zero there would caption a button that changes the wall.
    f.format.length > 0,
    f.colors.length > 0,
    f.sets.length > 0,
    // One term, not two: the X chip rides *inside* the mana-value group and is OR'd with the
    // numerals, so "3 and X" is one thing that is on for the same reason three colours are.
    // It has to be in here at all, though — an X-only search with no term for it would count
    // zero, hide Reset all, and leave a reader who filtered into nothing with no way out.
    f.manaValues.length > 0 || f.manaX,
    f.owned !== undefined,
  ].filter(Boolean).length;
}

/**
 * The picked colours as the backend spells them — `"WU"`, `"C"`, or nothing.
 *
 * Always WUBRG order, so `U` then `W` and `W` then `U` produce the same string and
 * therefore the same query key: picking the same two colours in the other order must not
 * cost a second round trip.
 */
export function colorParam(picked: readonly ColorKey[]): string | undefined {
  if (picked.length === 0) return undefined;
  return MANA_KEYS.filter((c) => picked.includes(c)).join("");
}

/**
 * Add or remove one colour.
 *
 * `C` is exclusive both ways. The backend reads a `colors` of exactly `"C"` as
 * colourless-only and anything else as subset-of-these-letters — and subset semantics
 * already include colourless cards. So `"WC"` would not mean "white or colourless", it
 * would mean plain `"W"`, and a button that silently does nothing is worse than one that
 * clears the others.
 */
export function toggleColor(picked: readonly ColorKey[], key: ColorKey): ColorKey[] {
  if (picked.includes(key)) return picked.filter((c) => c !== key);
  if (key === "C") return ["C"];
  return [...picked.filter((c) => c !== "C"), key];
}

// `sortCurrency` is gone, and so is the `currency` parameter it fed. It existed to send the
// selected currency **only** when a money column was deciding the order, because everything
// else about a price was decided on this side off the twin fields every row carried. Rust now
// answers one price per row for the marketplace it was asked about, so the marketplace decides
// the source *and* the money *and* the order together, and it travels on every price-bearing
// query rather than on the ones that happen to be sorted by money. Two things could not
// disagree any more, so there is nothing left to keep in step.

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * Counts the rows actually delivered rather than multiplying a page number by `PAGE_SIZE`.
 * The two agree only while every page comes back full, and one need not: a sync swapping
 * the `cards` table between two requests changes what the offsets address, so a page can
 * arrive short of what was asked for. A computed offset would then point past rows that
 * were never delivered, and the reader would never see them.
 *
 * `total` is only an end when the backend counted to it. A capped total means "5 000 or
 * more", and stopping there would cut a 116 k-card browse off at the five-thousandth row
 * — so when it is capped, the short page is the only signal that the data ran out.
 */
export function nextOffset(pages: readonly SearchResponse[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last) return undefined;
  const seen = pages.reduce((n, p) => n + p.items.length, 0);
  // A short page is the end of the data whatever `total` says. The two can disagree — a
  // sync swapping the table between two requests is enough — and believing `total` alone
  // would refetch the same empty page forever.
  if (last.items.length === 0) return undefined;
  if (!last.totalIsCapped && seen >= last.total) return undefined;
  return seen;
}

/**
 * Whether the reader is deep enough into the loaded rows to want the next page.
 *
 * `lastRenderedIndex` is the bottom of the virtualiser's window, so the next page starts
 * downloading while roughly a fifth of the current one is still ahead of the scrollbar.
 */
export function needsNextPage(lastRenderedIndex: number, loadedCount: number): boolean {
  if (loadedCount === 0) return false;
  return lastRenderedIndex >= loadedCount * 0.8 - 1;
}

/**
 * Filter state, the debounce, and the paged query behind the search view.
 *
 * The query is never disabled: an empty box with no filters is a browse of the whole
 * database sorted by name, which is what a card app should open on, and it is also the
 * one request whose empty answer proves the database itself is empty (see `unfiltered`).
 *
 * Two of the three options are **defaults** — the format filter's and the printings mode's —
 * and default is the whole of what they are: the reader can always move either, including to a
 * format the deck they are building is not legal in, and `Any format` never leaves the list.
 * The third, {@link CardSearchOptions.tagTerms}, is not a default but a **narrowing the caller
 * owns**: the Tags page's chips are a filter this row has no control for, so they ride in from
 * outside and no control here can clear them. `SearchPage` passes nothing and gets exactly the
 * hook it always had.
 */
export interface CardSearchOptions {
  /**
   * The format the filter opens on, or `null`/absent for "Any format" — the caller's own
   * answer, which the deck editor derives from the open deck.
   *
   * The **caller's**, because only the caller knows whether the key it is holding is one the
   * database can answer: a key with no `legalities` behind it comes back as no rows at all,
   * which is indistinguishable on screen from a search that genuinely matched nothing, and
   * telling those keys apart takes the `format_specs` row the caller already has in hand. A
   * hook cannot make that judgement about a key it was handed, so it does not try; it seeds
   * what it is given, and the caller is the fence. `DeckEditor`'s `searchFormatDefault` is
   * where that fence is written down.
   */
  defaultFormat?: FormatFilterOption | null;
  /**
   * Which printings mode the view **opens** on — `false` (one row per card) unless a caller
   * says otherwise, which is what this hook has always answered.
   *
   * `true` is the Tags page's, and the reason is the whole point of that page: an art tag is a
   * fact about **this illustration**, so collapsing folds five printings into one row drawn by
   * the newest — whose art may have nothing to do with the motif the reader searched for. Art
   * results are printings.
   *
   * A **seed** and not a lock, because `FilterBar` still draws the All printings toggle and a
   * control the reader can see must be one they can move: a reader narrowed to an oracle tag is
   * asking "which cards do this", where one row per card is the right answer. The seed is what
   * makes the page's *opening* answer honest.
   */
  defaultAllPrintings?: boolean;
  /**
   * Tag chips to AND into every request — the Tags page's whole filter, and the one narrowing
   * on this hook that no control in `FilterBar` can reach.
   *
   * The fields are `SearchRequest`'s own, so a caller hands over what `termsFor` built and
   * nothing here re-derives it. **The query key is derived from this object rather than passed
   * beside it** (`JSON.stringify` below), which is what makes "same payload, same key" true by
   * construction: a key and a payload passed as two parameters are two things that can disagree,
   * and the disagreement is invisible — one search answered out of another's cached pages.
   * `tagFilters.ts`'s `termsFor` writes its fields in a fixed order and sorts every list, so the
   * string is stable across two selections that mean the same thing.
   */
  tagTerms?: Pick<SearchRequest, "artTags" | "oracleTags" | "artWeightFloor">;
}

export function useCardSearch(options: CardSearchOptions = {}) {
  // Read once, and as a string rather than as the object: every caller builds that object
  // inline, so it is a new identity on every render and nothing may depend on it.
  const defaultFormatValue = options.defaultFormat?.value ?? "";
  /**
   * The caller's tag chips — the Tags page's whole filter, and half of what finally rides.
   *
   * The other half is typed into the search box, and the two are merged into `tagTerms` further
   * down, once the typed names have been resolved. This is the raw caller half, kept apart so
   * the merge has something to name.
   *
   * Nothing depends on the object's *identity*: the request payload is rebuilt inside `queryFn`
   * and the facet request is hashed by React Query with its keys sorted, so a caller building
   * this inline costs nothing.
   */
  const callerTagTerms = options.tagTerms ?? EMPTY_TAG_TERMS;
  // Which marketplace's prices this list is quoting. It is an input to the query rather than
  // a formatting choice: the backend prices the page with it, so it is in the key below and a
  // switch re-asks.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  // The format select's whole value, which is three kinds of thing in one string: `""` is
  // `Any format` and the default, {@link ANY_CARD} is `Any card`, anything else is a
  // `legalities` key. {@link formatParams} is the only place that branch is written.
  //
  // Seeded from the caller's default rather than from `""`, so the first request the panel
  // makes is already the filtered one — an empty seed corrected afterwards would send the
  // unfiltered search first and answer it, which is a wall of illegal cards and a second round
  // trip to replace it.
  const [format, setFormat] = useState(defaultFormatValue);
  /**
   * The default this filter is currently *sitting on*, so a changed default can be told from a
   * reader who happens to have picked the same key.
   *
   * React's adjust-state-during-render pattern, and deliberately **not** a `useEffect`. An
   * effect runs after the paint, so the panel would draw one frame of the previous deck's
   * filter and — worse — fire a whole request for it, which against a 116 k-row corpus is a
   * visible wall of the wrong cards. Setting state during render re-runs this component before
   * anything is committed, so the old filter never reaches the DOM or the query.
   *
   * It is also what applies a default that **arrives late**: `useFormatSpecs` is a query, so on
   * the first deck opened in a session this panel mounts before the seed has answered and the
   * default is `null` for a render or two. The seed above cannot catch that one; this does.
   *
   * Compared against the *applied* default rather than against `format`, which is what makes
   * `resetAll` stick: reset clears `format` and touches nothing here, so the default comes back
   * only when the **deck's** format changes, never a beat after the reader cleared it.
   */
  const [appliedDefaultFormat, setAppliedDefaultFormat] = useState(defaultFormatValue);
  if (defaultFormatValue !== appliedDefaultFormat) {
    setAppliedDefaultFormat(defaultFormatValue);
    setFormat(defaultFormatValue);
  }
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  // The other half of the mana-value question, and **additive rather than exclusive**:
  // Scryfall's `cmc` already counts `{X}` as zero, so `{X}{B}{B}{B}` answers the `3` chip and
  // this one both, and a reader who presses both finds it once. Its own state and not a
  // sentinel inside `manaValues`, because it is not a mana value.
  const [manaX, setManaX] = useState(false);
  const [owned, setOwned] = useState<boolean | undefined>(undefined);
  // Not a filter, and deliberately outside `resetAll`: clearing what you are looking at
  // should not also throw away the order you chose to read it in.
  const [sort, setSort] = useState<SortSpec<SearchSortKey>>([]);
  // A **view mode**, and outside `resetAll` for the same reason the sort is: clearing what
  // you are looking at should not also change *how* you are looking at it.
  //
  // Off is one row per card — 37 553 cards rather than 107 337 printings — because "which
  // cards exist" is the question a search box is asked, and "which printings exist" is the
  // question the card detail pane answers.
  //
  // Seeded `false` unconditionally, and nothing outside this row can seed it otherwise any
  // more: "View all printings" used to arrive here as a card to open up, and is a modal drawn
  // over wherever the reader already is now. So the toggle is a press on this row or nothing —
  // an independent view mode rather than the tail of somebody else's navigation.
  //
  // Seeded from the caller rather than pinned `false` since the Tags page landed — see
  // {@link CardSearchOptions.defaultAllPrintings} for why that page opens uncollapsed. A seed
  // and not a lock: the toggle on the filter row is still the reader's.
  const [allPrintings, setAllPrintings] = useState(options.defaultAllPrintings ?? false);
  // The printings no format allows used to be a chip of their own here, `unplayable`, defaulting
  // to off-and-hidden. It is the format select's `Any card` row now — one control, because the
  // chip and the select were narrowing and widening the same axis and `Modern plus the art
  // cards` was a state nothing wanted. Two things changed with it, both deliberate: the row is
  // **counted by Reset all and cleared by it**, where the chip was neither (it was filed beside
  // `allPrintings` as a statement about the corpus), and it can no longer be on at the same time
  // as a named format. The reason for the default is unchanged and is what `Any format` still
  // means: a card legal in no format at all is an art card, a token, an emblem or a piece of
  // memorabilia, and a search for `lightning bolt` that answers with three of them above the
  // card is a search answering the wrong question.
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  /**
   * Scryfall's tagger syntax, read out of the box — `o:ramp`, `otag:"spot removal"`, `-a:dragon`
   * — and the free text left over for FTS.
   *
   * Parsed from the **debounced** string rather than the live one, so the chips, the note and
   * the wall all move together. A row that appeared a keystroke at a time while the wall waited
   * would read as three controls arguing. The two gestures that are not typing — a chip's ✕ and
   * its include/exclude toggle — flush the debounce themselves, because a press is a deliberate
   * act and should not sit for 300 ms.
   */
  const parsed = useMemo(() => parseTagQuery(debouncedText), [debouncedText]);

  /** The tokens as asks, and the one string that identifies them. Order matters: the answer is
   *  positional, so two queries naming the same tags in a different order are two questions. */
  const asks = useMemo(
    () => parsed.tokens.map((t) => ({ namespace: t.namespace, value: t.value })),
    [parsed],
  );
  const askKey = useMemo(() => asks.map(tokenKey).join(" "), [asks]);

  /**
   * The typed names, as the canonical slugs the filters match on.
   *
   * Keyed on {@link askKey} rather than on the whole query, so editing the free text beside a
   * tag does not re-ask a question already answered — and so the two searches `a:dog bolt` and
   * `bolt a:dog` share one answer.
   */
  const tagResolution = useQuery({
    queryKey: ["tags", "resolve", askKey],
    queryFn: () => ipc.tagResolve(asks),
    enabled: asks.length > 0,
  });

  /**
   * What the reader typed, as chips — and the tokens that could not be resolved.
   *
   * **Deduplicated by `chipKey`, first mode winning.** A chip's identity is the tag, while a
   * token's is where it sits in the string, so `a:dog a:dog` is two terms and one chip. That is
   * also what makes the ✕ honest: it removes *every* term that produced the chip, because a
   * chip that vanished and left the wall still narrowed would be worse than no chip at all.
   */
  const typed = useMemo(() => {
    const answers = tagResolution.data;
    const chips: TagChip[] = [];
    const seen = new Set<string>();
    const unknown: TagToken[] = [];
    parsed.tokens.forEach((token, i) => {
      // Undefined while the query is in flight, which is why the search is gated below rather
      // than being allowed to run against a half-resolved list.
      const ref = answers?.[i];
      if (ref === undefined) return;
      if (ref === null) {
        unknown.push(token);
        return;
      }
      const key = chipKey(ref.namespace, ref.slug);
      if (seen.has(key)) return;
      seen.add(key);
      chips.push({
        slug: ref.slug,
        label: ref.label,
        namespace: ref.namespace,
        mode: token.negated ? "exclude" : "include",
      });
    });
    return { chips, unknown };
  }, [parsed, tagResolution.data]);

  /**
   * The tag filter the typed syntax adds, in the shape a chip row already produces.
   *
   * Built through `termsFor` rather than by hand, so "a taxonomy nobody picked from is absent,
   * not empty" is stated once for both gestures. The floor is `"any"`: the syntax has no
   * keyword for it, because Scryfall has none to borrow.
   */
  const typedTerms = useMemo(
    () => termsFor({ chips: typed.chips, namespace: "both", floor: "any" } satisfies TagSelection),
    [typed.chips],
  );

  /**
   * Every tag this search filters by: the caller's chips ANDed with the reader's typed ones.
   *
   * Both are narrowings the reader asked for, so they merge rather than one winning — see
   * `mergeTagTerms`, which also sorts and dedupes each list so that chipping `dog` and typing
   * `a:dog` is one predicate and, more to the point, one query key.
   */
  const tagTerms = useMemo(
    () => mergeTagTerms(callerTagTerms, typedTerms),
    [callerTagTerms, typedTerms],
  );

  /**
   * The query-key segment for the tags, derived from the payload rather than taken beside it —
   * which is what makes "same payload, same key" hold by construction. Two parameters are two
   * things that can disagree, and a key that missed a tag would answer one search out of
   * another's cached pages with nothing on screen to notice.
   *
   * **`"null"` when nothing at all is picked**, which is what keeps a plain search on any of
   * this hook's three callers keyed exactly as it has always been: a segment that is constant
   * across every reachable state of a view costs that view no second key. `mergeTagTerms`
   * assigns a field only when there is one, so the empty case is an empty object and this is
   * the one place that is spelled `null`.
   */
  const tagKey = JSON.stringify(tagTerms.artTags ?? tagTerms.oracleTags ? tagTerms : null);

  /**
   * Whether a **tag** was picked — the reader asking something, from either gesture.
   *
   * Read by `unfiltered` below, and it has to be the *slugs* rather than the presence of the
   * object: an empty `artTags` adds no SQL at all (`filters::picked_tags`), so a payload
   * carrying one asked nothing and its empty answer is still a statement about the database.
   * The weight floor is deliberately not counted for the same reason — it narrows nothing
   * without an include, and `termsFor` will not send one on its own.
   */
  const hasTagTerms =
    (tagTerms.artTags?.include?.length ?? 0) > 0 ||
    (tagTerms.artTags?.exclude?.length ?? 0) > 0 ||
    (tagTerms.oracleTags?.include?.length ?? 0) > 0 ||
    (tagTerms.oracleTags?.exclude?.length ?? 0) > 0;

  /**
   * Whether the typed tags are in a state the search may not be run in — and both arms of it
   * **fail closed**, which is the opposite of what this file does everywhere else.
   *
   * *Pending*: the names are still being resolved. A search run now would go out with no tag
   * filter at all and **cache the unfiltered corpus under the key that afterwards means
   * "filtered"** — the whole wall wrong, served instantly, with nothing to notice.
   *
   * *Unknown*: a name that resolved to nothing. Answering it as though the term were not there
   * shows the reader the unfiltered wall in reply to a narrowing they asked for, which is the
   * one direction a search must never fail in. Scryfall 404s here; this draws an empty wall and
   * `tagNotFound` is what the box says about it.
   */
  const tagsPending = asks.length > 0 && tagResolution.isPending;
  const tagQueryBlocked = tagsPending || typed.unknown.length > 0;

  /**
   * Rewrite the box, and let the wall follow immediately.
   *
   * The debounce exists to keep a keystroke from becoming a query; a chip's press is already
   * the reader's final answer, so it flushes. Without this the chip the ✕ removed sits on
   * screen for another 300 ms and the press reads as dropped.
   */
  const rewrite = (next: string) => {
    setText(next);
    setDebouncedText(next);
  };

  const colorsParam = colorParam(colors);
  // Sorted before they reach the key: picking two sets in either order is the same search
  // and must not cost a second round trip.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;

  // Every input the request is built from, so a changed filter can never be answered by
  // another filter's cached pages.
  const queryKey = [
    "cards",
    "search",
    debouncedText,
    // **Two request fields in one segment, and it is exact rather than lossy.** The select
    // decides `format` *and* `playableOnly`, and its three values map to three distinct strings
    // — `""`, `"any-card"`, a key — so this segment alone tells every reachable request apart.
    // There used to be a second `unplayable ? "unplayable" : "playable"` segment beside it; it
    // went with the chip, because a key carrying the same fact twice is one that can carry it
    // twice differently.
    format,
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // **A segment of its own, and the whole feature turns on it being here.** X is a second
    // axis over the same chips, so a key that carried only the numerals would answer "3, and
    // also X" out of the cached pages of plain "3" — instantly, from local SQLite, with no
    // spinner and nothing to notice. Spelled rather than stringified, like its neighbours.
    manaX ? "x" : "",
    // Three states in one segment, spelled rather than stringified: `String(undefined)` and
    // `String(false)` are both truthy strings, and a key that cannot tell "off" from "the
    // ones I do not own" answers one with the other's cached pages.
    owned === undefined ? "" : owned ? "owned" : "missing",
    // The whole sort in one segment: a differently-ordered page is a different answer, and
    // must not be served from the cached pages of the order before it.
    sort.map((t) => `${t.key}:${t.dir}`).join(","),
    // Spelled rather than stringified, for the reason `owned` is: these are different
    // *rows*, not a different order over the same rows, so the two modes must never answer
    // each other from cache.
    allPrintings ? "all" : "collapsed",
    // **On every search, not only a price-ordered one.** The marketplace decides what the
    // Price column *contains* now, not merely how it is ordered — Card Kingdom's numbers come
    // out of a different table from TCGplayer's — so two marketplaces are two answers to the
    // same filters, and neither may be served from the other's cached pages.
    marketplace.id,
    // The caller's tag chips, as the one string they serialise to. `"null"` on every view but
    // the Tags page, which is what keeps a search made from this hook's other two callers keyed
    // exactly as it has always been — a segment that is constant across every reachable state
    // of a view costs that view no second key.
    tagKey,
  ];

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      ipc.searchCards({
        // **The free text, not the box** — the tag terms have been lifted out of it, so
        // `bolt a:dragon` searches FTS for `bolt` alone. Sending the raw string would have FTS
        // hunting for a card whose text contains `a:dragon`, which is no card.
        //
        // Blank strings are dropped rather than sent: the backend treats them as unset
        // anyway, and sending them would make the request payload lie about intent.
        text: parsed.text || undefined,
        // `format` and `playableOnly` together, from the one select that decides both. See
        // {@link formatParams} — including why a named format sends `playableOnly` too.
        ...formatParams(format),
        colors: colorsParam,
        sets: setsParam,
        manaValues: manaParam,
        // Absent rather than `false`, which is the backend's own default: an off chip is not
        // a filter, and sending one would make the payload lie about intent the way an empty
        // `text` would. `true` *widens* — it adds the `{X}` cards to whatever the numerals
        // matched — so it is only ever a statement, never a narrowing nobody asked for.
        manaX: manaX || undefined,
        // Sent only when it is set, so an untouched filter row produces exactly the payload
        // it always did. `false` is meaningful here and `undefined` is not sent at all.
        owned,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        // Always sent, unlike the filters above: it is not a refinement that can be left off,
        // it is which prices the page is quoting. The backend's default is `tcgplayer` and
        // this is often exactly that — sending it anyway keeps the payload and the query key
        // saying the same thing.
        marketplace: marketplace.id,
        // Absent rather than `false` when all printings are asked for: uncollapsed is the
        // backend's own default, and sending it would make the payload lie about intent —
        // the same rule `paperOnly` follows below.
        collapse: allPrintings ? undefined : true,
        // The caller's tag chips, spread rather than named field by field: `termsFor` already
        // leaves out a taxonomy nobody picked from and a floor with nothing to narrow, so what
        // arrives here is exactly what should ride, and restating the three names would be a
        // second place for one of them to be forgotten.
        ...tagTerms,
        // `paperOnly` is deliberately absent — omitted means true, which is the default
        // this view wants. Sending `true` explicitly would be the same request with more
        // ways to get it wrong. `playableOnly` is the neighbour with the opposite default and
        // rides up with `format` above, for the reason written at {@link formatParams}.
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    // See `tagQueryBlocked`: a search that runs before its tag names have resolved caches the
    // unfiltered corpus under the key that afterwards means "filtered", and one that runs with
    // an unknown name answers a narrowing with the whole wall.
    enabled: !tagQueryBlocked,
    // Filter changes keep the old rows on screen until the new ones land, so a search
    // that has to wait out an ingest's database lock does not blank the list first.
    placeholderData: keepPreviousData,
  });

  /**
   * The page, or **nothing at all while the tag terms are not answerable**.
   *
   * The emptying is here rather than at each consumer for two reasons. `placeholderData:
   * keepPreviousData` is doing its job — it hands back the *previous* search's rows while the
   * query is disabled — so a wall left to itself would go on showing the cards from before the
   * unknown tag was typed, which reads as "these are your results" and is the one lie this
   * feature could tell. And it is one rule for three callers: a consumer that forgot it would
   * fail exactly the same silent way.
   */
  const rows = useMemo(
    () => (tagQueryBlocked ? [] : (query.data?.pages.flatMap((p) => p.items) ?? [])),
    [query.data, tagQueryBlocked],
  );

  /**
   * The same filters the page above is built from, and nothing else.
   *
   * Written out rather than derived from the query's own payload, because the two differ in
   * exactly the way that matters: the page carries a sort, an offset and a collapse, and a
   * facet answer depends on none of the three. {@link FacetRequest} is the fence around those
   * three — it cannot hold them — and this object is what has to stay in step with the payload
   * above it.
   */
  const facetReq: FacetRequest = {
    // The free text, exactly as the page's payload spells it — the counts greying a chip and the
    // wall that chip filters have to describe one corpus, and a facet request carrying the whole
    // box would be counting over an FTS query the search never ran.
    text: parsed.text || undefined,
    // Spelled through the same {@link formatParams} the page's payload is, so the counts
    // greying this row's chips and the wall those chips filter can never describe different
    // corpora. `playableOnly` is a filter the facets must carry (unlike `collapse`): it decides
    // which printings exist for this search, so a count taken without it would offer a set or a
    // mana value that only art cards satisfy.
    ...formatParams(format),
    colors: colorsParam,
    sets: setsParam,
    manaValues: manaParam,
    // Spelled exactly as the page's payload spells it — `|| undefined` and not `manaX` —
    // because React Query hashes this object with its `undefined` values dropped: a bare
    // `false` would mint a second key for the search an untouched row has always had.
    manaX: manaX || undefined,
    owned,
    // The tag chips travel with the facets for the reason every other filter here does: the
    // counts that grey a chip and the wall that chip filters have to describe one corpus, or a
    // colour the picked motif has none of is still offered. Spread from the same object the
    // page's payload is built from, so the two cannot disagree about which tags are picked.
    //
    // **The index narrows by them** since 2026-08-20 — `index/facets.rs`'s `run_facets` resolves
    // each picked slug through its closure into a bitset, intersects those with the FTS one and
    // hands `compute` the single narrowing set it takes, so these counts describe the tag-filtered
    // wall rather than the corpus above it. Until then they rode, keyed the answer and were
    // ignored, which left the counts **wider** than the wall — the direction this row is built to
    // fail in, and still the direction any future gap here must fail in: `facets.ts` greys only
    // what would change nothing, so a count that is too high offers an option that turns out
    // empty, where one that was too low would hide cards nobody would think to report missing.
    ...tagTerms,
  };
  const facets = useCardFacets(facetReq);

  const defaultFormatLabel = options.defaultFormat?.label;
  /**
   * The rows the format picker offers, which is {@link FORMATS} plus — when it is not already
   * one of them — the default itself.
   *
   * It has to be able to carry a key `FORMATS` does not list because the deck picker offers
   * every enabled `format_specs` row against this list's seven: a Brawl or an Oathbreaker deck
   * would otherwise open on a filter whose value no option holds, and a `<select>` given a
   * value none of its `<option>`s carry does not show it — it silently reports the first one,
   * so the panel would say `Any format` over a filtered wall of cards.
   *
   * **Depends on the two string fields and never on the object.** Every caller builds
   * `defaultFormat` inline, so the object is a fresh identity each render and a dependency on
   * it would rebuild this array — and therefore the picker's own memo below it — on every
   * keystroke in the search box. The option is rebuilt from the two strings for the same
   * reason, rather than closed over.
   */
  const formats = useMemo<readonly FormatFilterOption[]>(() => {
    // The **value** decides, because the value is what `format` above was seeded from: a row
    // fenced out for want of a label would leave the filter set to a key the picker cannot
    // draw, which is precisely the case this memo exists to prevent. A row is still a value
    // *and* a word, so a default carrying no word falls back to its key rather than putting a
    // blank line in the picker. Nothing reaches that fallback today — the one caller that sets
    // a default reads `spec.displayName` — and the two lines must not be able to disagree.
    if (!defaultFormatValue) return FORMATS;
    if (FORMATS.some((f) => f.value === defaultFormatValue)) return FORMATS;
    return [
      ...FORMATS,
      { value: defaultFormatValue, label: defaultFormatLabel || defaultFormatValue },
    ];
  }, [defaultFormatValue, defaultFormatLabel]);

  // **"Not the default", which is very nearly but not quite "the reader set it".** The name
  // says the intent and the comparison is what the state can answer: a format equal to the
  // default reads as unset however it got there. So a reader who presses Reset all on a
  // Commander deck's panel and then picks Commander back off the select counts as having asked
  // nothing, and an empty answer would be captioned "waiting for the sync" rather than "your
  // search missed". Telling those two apart would take remembering the press, which buys a
  // caption in a case that also needs the database to be empty.
  //
  // **`Any card` is not reader-set either, and that arm is about arithmetic rather than about
  // intent.** It is the one row of this select that *widens*: its result set is a superset of
  // `Any format`'s, so an empty answer to it with nothing else on still proves the database is
  // empty rather than that the search missed — which is exactly the distinction this flag is
  // read for. Counting it would caption a cold database's empty wall "try another word", and
  // there is no other word.
  const formatIsReaderSet = format !== "" && format !== ANY_CARD && format !== defaultFormatValue;

  return {
    text,
    setText,
    /**
     * The tags the reader typed into the box, resolved — what the chip row under it draws.
     *
     * Empty on a box with no tagger syntax in it, and empty *while a name is resolving*, which
     * is the state the row must not draw a half-answer in. Deduplicated by tag, so `a:dog
     * a:dog` is one chip; see the note on `typed` for why the ✕ then removes both terms.
     */
    tagChips: typed.chips,
    /**
     * The typed names that name no tag — Scryfall's 404, as something the box can say.
     *
     * Non-empty means the wall is deliberately empty: see `tagQueryBlocked`. The tokens are
     * carried whole rather than as strings, so the note can offer the near misses for one and
     * the chip row can go on identifying the rest by position.
     */
    tagNotFound: typed.unknown,
    /** Whether the typed names are still being looked up. The wall is empty and *not* a result
     *  while this is true, which is what tells a spinner from an answer. */
    tagsResolving: tagsPending,
    /**
     * Take one typed tag out of the query — a chip's ✕.
     *
     * Removes **every** term that produced the chip, because a chip that vanished and left the
     * wall still narrowed would be worse than no chip at all. Spliced out of the box's own text
     * rather than tracked beside it, so the string the reader can see stays the one source of
     * truth for the query.
     */
    removeTagChip: (slug: string, namespace: TagNamespace) => {
      const key = chipKey(namespace, slug);
      // Right to left: every span is an offset into the string being edited, so removing a
      // later term first leaves the earlier ones' spans still true.
      const doomed = parsed.tokens
        .map((token, i) => ({ token, ref: tagResolution.data?.[i] }))
        .filter(({ ref }) => ref && chipKey(ref.namespace, ref.slug) === key)
        .map(({ token }) => token)
        .reverse();
      rewrite(doomed.reduce((query, token) => removeToken(query, token), debouncedText));
    },
    /**
     * Put a real tag in place of one the box could not find — pressing a suggestion under the
     * "no such tag" note.
     *
     * Named by **token** rather than by tag, unlike the two above: an unresolved term has no
     * tag to be identified by, and its position in the string is the only thing it has.
     */
    replaceTagToken: (token: TagToken, value: string) =>
      rewrite(setTokenValue(debouncedText, token, value)),
    /** Flip one typed tag between include and exclude — a chip's press. Rewrites every term
     *  that produced the chip, for {@link removeTagChip}'s reason. */
    toggleTagChipMode: (slug: string, namespace: TagNamespace) => {
      const key = chipKey(namespace, slug);
      const picked = typed.chips.find((c) => chipKey(c.namespace, c.slug) === key);
      if (!picked) return;
      const negated = picked.mode === "include";
      const doomed = parsed.tokens
        .map((token, i) => ({ token, ref: tagResolution.data?.[i] }))
        .filter(({ ref }) => ref && chipKey(ref.namespace, ref.slug) === key)
        .map(({ token }) => token)
        .reverse();
      rewrite(
        doomed.reduce((query, token) => setTokenNegated(query, token, negated), debouncedText),
      );
    },
    /**
     * The format select's whole value — `""` (`Any format`, the default), {@link ANY_CARD}
     * (`Any card`), or a `legalities` key.
     *
     * One string for what used to be a select and a chip: it decides both `format` and
     * `playableOnly`, through {@link formatParams}. The two rows that are not formats are the
     * two pinned above the sorted list in `FilterBar`, and the widest of them is first.
     */
    format,
    setFormat,
    /**
     * The rows the format picker draws, in the order the *keys* rank — which is a fact about
     * the formats and not the order anybody sees. Every picker sorts this through `sortOptions`
     * exactly as it sorted {@link FORMATS}, which is what it is when no default was passed.
     */
    formats,
    colors,
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    /**
     * Also match the cards whose printed cost contains `{X}`.
     *
     * **Additive, never exclusive.** It is OR'd with the numeral chips exactly as they are
     * OR'd with each other, so pressing `3` and `X` asks for "costs 3, or has an X" and finds
     * `{X}{B}{B}{B}` once rather than twice. A filter for the purposes of `activeFilterCount`
     * and `resetAll`, and counted with `manaValues` as the one question the group asks.
     */
    manaX,
    toggleManaX: () => setManaX((on) => !on),
    /**
     * `true` narrows to printings the collection has an entry for, `false` to those it does
     * not, `undefined` asks nothing. **An entry, not a copy**: a row emptied to zero passes
     * `true` while its badge reads `×0` (see `SearchRequest.owned`).
     */
    owned,
    /** Off → owned → missing → off. The search asks "what have I already got" first. */
    toggleOwned: () => setOwned((current) => cycleTriState(current, true)),
    /**
     * Show every printing rather than one row per card.
     *
     * `false` — one row per card — is the default. A view mode and not a filter, so it is
     * absent from {@link activeFilterCount} and survives `resetAll`.
     */
    allPrintings,
    toggleAllPrintings: () => setAllPrintings((on) => !on),
    /**
     * How many kinds of filter are on — the number on the Reset all badge.
     *
     * **Counts a default format, and the asymmetry with `unfiltered` below is deliberate.**
     * The two answer different questions about the same state. `unfiltered` asks *did the
     * reader ask anything of the database*, and a default nobody chose is not the reader
     * asking. This number captions **Reset all** and asks *how much would pressing this
     * change* — and a format filter that is on really is one thing it would clear. So a
     * Commander deck's panel opens reading `Reset all 1`, and pressing it goes to `Any
     * format`, which is the honest escape hatch rather than a badge lying about what the
     * button does.
     */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      owned,
    }),
    /**
     * The keys this list is ordered by, first one deciding. Keys rather than columns since
     * the picker landed: two of the seven have no header. Empty is the view's own default —
     * relevance when there is a query, name order when there is not.
     */
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as SearchSortKey, {
          additive,
          firstDir: SEARCH_FIRST_DIR[key as SearchSortKey] ?? "asc",
        }),
      ),
    /**
     * The filter bar's select: one term, replacing whatever was there.
     *
     * `""` is a row of that select rather than an absence — the empty spec, which is this
     * view's own order and the only way back to relevance once a key has been picked. The
     * collection's twin takes a key and nothing else, because its list is never empty.
     */
    setSortKey: (key: SearchSortKey | "") =>
      setSort(key === "" ? [] : [{ key, dir: SEARCH_FIRST_DIR[key] }]),
    /**
     * What the select shows: the sort's first term, or `""` — the `Best match` row — for the
     * view's own order.
     *
     * The *first* term rather than a requirement that there be only one, because "sorted
     * primarily by Name" is true of a Shift-built two-key sort and is what a reader glancing
     * at the control wants to know.
     *
     * **It falls back to `""` where the collection's falls back to `"name"`, and that is the
     * one place the two views differ.** An empty spec here is relevance when there is a query
     * and name when there is not, so pinning `name` would have the control state a name order
     * over a ranked search — a lie the collection cannot tell, because name order is exactly
     * what its empty spec means.
     *
     * It cannot come back `""` from a *non-empty* spec, which is why there is no `Custom…`
     * row to draw: see {@link SEARCH_SORT_OPTIONS}.
     */
    sortSelection: sort.length === 0 ? "" : sort[0].key,
    /**
     * The direction button beside the select: rewrites the first term's direction in place,
     * leaving any Shift-built secondary keys where they are.
     *
     * In place for `applySort`'s reason — a first key that jumped to the end of the sort when
     * its direction changed would silently hand the order to whatever was second.
     *
     * **A no-op on an empty spec**, rather than seeding a term to flip: the view's own order
     * is relevance under a query, which has no other direction to offer, and a button that
     * invented a name sort would be answering a question nobody asked.
     */
    flipSortDir: () =>
      setSort((spec) =>
        spec.length === 0
          ? spec
          : spec.map((term, at) =>
              at === 0 ? { key: term.key, dir: term.dir === "asc" ? "desc" : "asc" } : term,
            ),
      ),
    /**
     * Clear every filter at once, including the search box.
     *
     * `format` goes to `""` and **not back to the deck's**: Reset all means "no filters", and a
     * button that put a filter back would be the one control on this row that cannot clear what
     * it captions. The clear also sticks — the re-seed guard above compares against
     * `appliedDefaultFormat`, which this does not touch, so the default returns when the deck's
     * format changes and never a render later on its own.
     *
     * **That one line now also puts `Any card` back to `Any format`**, which the old `Unplayable`
     * chip deliberately survived. The chip was outside this because it was a statement about the
     * corpus rather than a filter; as a row of the format select it is neither outside nor
     * special, and a reset that left the select where it was would be the one control this
     * button cannot clear.
     */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
      setManaX(false);
      setOwned(undefined);
    },
    /**
     * The marketplace every price on this view is quoted from — its label for the as-of
     * sentence and its currency for the formatter. The *numbers* were decided by the query
     * this is part of the key of.
     *
     * Handed on rather than read again in the view: one source means a header that names
     * TCGplayer over cells the backend priced at Card Kingdom cannot happen.
     */
    marketplace,
    query,
    rows,
    /**
     * How many printings each filter option would leave, for the row that draws them —
     * `undefined` whenever that is not known, which is what every control reads as "leave
     * this live". See `useCardFacets`, which owns that collapse, and `facets.ts`, which owns
     * the rule the controls apply to it.
     *
     * **`facets.total` is not {@link total}.** This one counts printings and is exact; that
     * one counts the rows the list will draw (collapsed to one per card) and stops at 5 000.
     * Only the former is what a colour count is read against.
     */
    facets,
    /**
     * Identity of the current search, for anything that has to react to "this is a
     * different search now" — resetting the scroll position, above all. Derived from the
     * query key itself rather than rebuilt from the same fields, so the two cannot drift.
     * Serialised rather than joined: the text half is whatever the user typed, and a
     * separator a user can type is a separator that can collide.
     */
    searchKey: JSON.stringify(queryKey),
    /** Size of the whole match set, not of `rows`. `0` until the first page answers. */
    // Zero rather than the previous search's figure while the tag terms are unanswerable —
    // `rows` is empty for the reason written at its definition, and a caption reading `5,000+`
    // over an empty wall would be the same lie in one line.
    total: tagQueryBlocked ? 0 : (query.data?.pages[0]?.total ?? 0),
    /** `total` is a floor, not a figure: render it as `5,000+`. */
    totalIsCapped: !tagQueryBlocked && (query.data?.pages[0]?.totalIsCapped ?? false),
    /**
     * Nothing was asked of the database at all. An empty answer to *this* is an empty
     * database, not a search that missed — the difference between "wait for the sync"
     * and "try another word".
     *
     * A format the *caller* defaulted is not the reader asking, which is why this reads
     * `formatIsReaderSet` rather than `format`: a deck editor's panel over a database that has
     * not synced yet would otherwise caption its empty wall "try another word", and there is no
     * other word — there are no cards. That test is "the format differs from the default", with
     * the one consequence written at its definition above. With no default the two expressions
     * are identical, which is why `SearchPage` cannot notice the difference.
     */
    unfiltered:
      !debouncedText &&
      !formatIsReaderSet &&
      !colorsParam &&
      !setsParam &&
      !manaParam &&
      !manaX &&
      owned === undefined &&
      !hasTagTerms,
  };
}

/** The whole of what `FilterBar` consumes — named so the component and its test agree. */
export type CardSearch = ReturnType<typeof useCardSearch>;
