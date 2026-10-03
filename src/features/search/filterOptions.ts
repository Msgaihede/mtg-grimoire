import { useMemo } from "react";
import type { DropdownOption } from "@/components/Dropdown/types";
import { BORDERS, BORDER_LABEL } from "@/lib/border";
import { CONDITIONS, CONDITION_LABEL, CONDITION_NOT_SET, type Condition } from "@/lib/conditions";
import { FINISHES, FINISH_LABEL } from "@/lib/finish";
import type { SearchSortKey } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { sortOptions } from "@/lib/options";
import { formatPrice } from "@/lib/prices";
import type { SortDir } from "@/lib/sort";
import { optionDisabled } from "./facets";
import type { FilterSurface } from "./FilterBar";
import { ANY_CARD, CARD_TYPES, SEARCH_SORT_OPTIONS } from "./useCardSearch";

/**
 * **The half of the filter row that is words and lists rather than controls** — which orders the
 * sort picker offers, how the formats are ranked, what the direction button is called, and how a
 * search is said back to the reader as chips.
 *
 * It was all inside `FilterBar.tsx` until 2026-10-03, and moved out for one reason: that file
 * also draws the grid-or-table pair, which reads the desktop's store, so nothing could import
 * any of this without importing the store with it. The phone face's filters sheet
 * (`mobile/phone/pages/SearchPage.tsx`) is a second drawing of the same filters over the same
 * hook, and two copies of these sentences would be two answers to "what is this search narrowed
 * by" that agree only until one of them moves. So the words live here, store-free, and both
 * faces read them; `FilterBar.tsx` re-exports what it always exported, so no desktop caller
 * changed.
 *
 * **Nothing in here may import `FilterBar.tsx` for a value.** The one import from it is
 * `FilterSurface`, and it is `import type` — which carries no edge at runtime and none for
 * `mobile/phone/fence.test.ts`, whose walk is what would go red if this file ever reached the
 * store.
 */

/**
 * The orders the picker offers, in the one order an option list in this app is drawn in:
 * alphabetically by the words on screen (`lib/options.ts`).
 *
 * Sorted once at module scope rather than inside a memo, unlike {@link useFormatOptions}. Nothing
 * about a sort is faceted — an order that would hand back the same rows rearranged is still an
 * order worth offering — so there is no state here for the ordering to depend on.
 * `SEARCH_SORT_OPTIONS` is declared in the order the orders were reasoned about, which is the
 * author's notes rather than anything a reader can see.
 *
 * **`Best match` is pinned first and outside the sort**, because it is not a column to order by:
 * it is the search's own ranking, and on a browse — with nothing to be relevant to — the name
 * order that stands in for it. A reader reaching for the way back reaches for it blind, so it
 * stays at the top whatever the alphabet does to the rows below.
 *
 * **`Best match`, and never `Default order` again** (issue #213). That name said what the row
 * *was* in the state machine — the empty sort spec — instead of what it does, so a reader
 * browsing the alphabetical opening wall read it as the name of alphabetical order and reported
 * the label as wrong. It is not: with text in the box this row is FTS5's `bm25` with the name
 * column weighted ten times the type line and oracle text, and a search for `human` opens on
 * `Human Frailty` rather than on `A Girl and Her Dogs`. `Name` is the row that really is
 * alphabetical, and it sits two below this one — which is the whole of the fix: name each row for
 * the order it produces, and let the reader pick between them.
 *
 * The one state the name overshoots is the empty box, where there is no query to be relevant to
 * and the search falls back to name order (`search.rs`'s `ORDER_NAME`). Kept anyway: a row whose
 * label changed as the reader typed would be a control moving under them, and `Name` is right
 * there for anyone who wants alphabetical said out loud.
 */
export const SEARCH_SORT_ROWS: readonly {
  value: SearchSortKey | "";
  label: string;
  disabled?: boolean;
}[] = [{ value: "", label: "Best match" }, ...sortOptions(SEARCH_SORT_OPTIONS, (s) => s.label)];

/**
 * The rarities the tray offers, in the order a card is printed at them.
 *
 * **Not alphabetical, and this is `sortOptions`' second kind of exemption**: the order *is* the
 * information. Common through mythic is a scale, the same way Near Mint through Damaged is on
 * the collection's condition chips — under the ungraded chip that leads them, which is the
 * default rather than a rung of the scale — and sorting it would put mythic between common and
 * rare.
 *
 * Scryfall's own lower-case words, which is what `cards.rarity` stores and what the backend's
 * `IN` compares against — SQLite's `=` on text is case-sensitive, so a capitalised value here
 * would match nothing and read as an empty corpus. `CardIndex::RARITY_KEYS` is the same four in
 * the same order; the two lists are hand-mirrored like the rest of `ipc.ts`' contract.
 *
 * Four of Scryfall's six. `special` and `bonus` are real values with no chip and no bitset — a
 * printing at one of them is matched by no rarity filter, which is the same answer it gets from
 * a filter that names none.
 */
export const RARITIES = ["common", "uncommon", "rare", "mythic"] as const;

/**
 * What the direction button says, spent twice — as its accessible name and as its `title`.
 *
 * It names the state **and** the press, because an arrow is the whole of what is drawn on that
 * button, and an arrow pointing up is read as "this is ascending" by one reader and "press to go
 * up" by the next. There is no visible text at all, so WCAG 2.5.3's "the name contains the
 * label" has nothing here to bind to.
 *
 * The out-of-reach reading names its reason instead of claiming a direction. At `Best match` the
 * list is ranked by relevance — and on a browse, with no query to rank against, by name — which
 * is neither ascending nor descending by any column the reader picked, and a button announcing
 * "ascending" over it would be describing a sort that is not there. **A `getByRole` on the exact
 * enabled string therefore fails on that row and reads as "the button is missing"**; match it
 * with a pattern that takes all three names.
 *
 * It names the *row* and not "no order picked", which is what it said while that row was called
 * `Default order`. `Best match` is a row a reader deliberately picks, so "no order picked" would
 * be the button contradicting the select beside it.
 *
 * Exported because the filter quick bar draws a second direction button over the same state, and
 * two buttons on one flag must never announce it in two sentences.
 */
export function sortDirectionName(dir: SortDir | undefined): string {
  if (!dir) return "Best match has no sort direction";
  return dir === "asc"
    ? "Sort ascending (click for descending)"
    : "Sort descending (click for ascending)";
}

/**
 * The formats in the order the dropdown draws them: **pickable first, greyed last, each
 * half alphabetical by the word on screen.**
 *
 * **The list is the search's own (`search.formats`) rather than the shared `FORMATS`, and it
 * can be longer than that array.** The hook answers with those keys plus its caller's default
 * format whenever that one is not among them — the deck editor's docked panel opens on the
 * format of the deck being edited, and a deck can be in a format this picker has never
 * offered. That extra key is not decoration: **a `<select>` whose `value` matches no
 * `<option>` does not draw blank — it silently reports the first one.** React never assigns
 * `select.value` for a controlled select; `react-dom` walks the options setting `selected`,
 * and on no match it selects the first row that is not disabled — which since the `Unplayable`
 * chip was merged in is the pinned `Any card`, the **widest** row this control has. So the
 * control would read "every card, art cards included" while the filter it names goes on
 * narrowing the results underneath, which is a control that lies about the list beside it —
 * and it lies further than it used to, because the row it now falls back to is not merely a
 * different filter but the opposite end of the one it is on. The options therefore have to
 * come from whoever owns the value, and a constant imported here could only ever be right for
 * the callers that never set one.
 *
 * The seeded key is a format like every other once it arrives: it sorts into the alphabet by
 * its label, greys by its own facet count, and is pinned by nothing. `Any card` and `Any
 * format` are the two rows that stay outside the sort, because they are the two rows that are
 * not formats.
 *
 * Alphabetical because a reader hunting for "Modern" hunts under M. `FORMATS`' own order is
 * roughly how the formats rank, which is knowledge this control never shows and which no two
 * players would write down the same way — so it stays a fact about the keys and stops being
 * a layout. The greyed half sinks rather than disappearing: a format nothing in this search
 * is legal in is still worth offering (it says the search has nothing there), and dropping it
 * would make the list jump under the cursor each time the facets land, which is the same
 * reason `SetCombobox` greys instead of filtering.
 *
 * Each option's disabled state is decided once and spent twice — as the grouping level and
 * as the attribute — because the two are the same question and `optionDisabled`'s "a
 * selected option is never greyed" arm is exactly where they must not disagree: the format
 * the reader picked stays in the pickable half however its own count reads, so the way out
 * of a dead end never sinks below the rows the reader cannot use.
 *
 * With no facets at all `optionDisabled` is false for every key, so both halves collapse
 * into one plain alphabetical list without a branch for it.
 *
 * **Belt and braces since the 2026-08-25 move to `<Dropdown>`, not the only defence any
 * more.** The shell no longer falls back to a wrong row on an unmatched value the way the old
 * `<select>` did — it draws its own placeholder dash instead (`DEFAULT_PLACEHOLDER`,
 * `Dropdown.tsx`) — but a dash reading "no format at all" while a seeded format goes on
 * narrowing the results underneath is still a control that lies about the list beside it, just
 * a quieter lie than `Any card`'s. The list still has to come from whoever owns the value.
 *
 * **Exported as a hook since the filter quick bar (2026-09-29)**, which draws this same tray from
 * a strip docked at the top of the scroller and must offer the same rows in the same order — a
 * second copy of this memo would be two orderings of one picker that agree only until one of
 * them moves.
 */
export function useFormatOptions<SortKey extends string>(
  search: FilterSurface<SortKey>,
): { value: string; label: string; disabled: boolean }[] {
  const facets = search.facets;
  return useMemo(
    () =>
      sortOptions(
        search.formats.map((f) => ({
          ...f,
          disabled: optionDisabled(facets?.formats, f.value, search.format === f.value),
        })),
        (f) => f.label,
        (f) => [f.disabled ? 1 : 0],
      ),
    [facets?.formats, search.format, search.formats],
  );
}

/** A word with its first letter raised — the rarities and the colours are stored lower-case. */
export function sentence(word: string): string {
  return word.replace(/^./, (c) => c.toUpperCase());
}

/**
 * One grade as its chip prints it, and what is left for `ToggleChip`'s `hint` to expand.
 *
 * **Five of the six are abbreviations and the sixth is not.** `NM` … `DMG` are stamped on every
 * marketplace listing the cards came from, so the chip draws the code and speaks the grade —
 * which is the whole of what `hint` is for, and why the grades spelled out never went on the bar.
 * `NONE` abbreviates nothing: it is the storage sentinel for a copy whose grade the reader never
 * stated, no listing anywhere carries it, and a chip reading `NONE` would be the one word in this
 * row nobody has seen before. It draws {@link CONDITION_LABEL}'s word and has nothing left to
 * expand, so it carries no hint rather than a hint repeating itself.
 *
 * **One function for the tray chip and the summary chip**, which is the rule the Owned pair
 * already keeps two cells apart: the statement and the control that made it use one vocabulary,
 * or `Condition: NONE` reads as a different filter from the `Not set` that is pressed in the
 * tray.
 */
export function conditionChip(condition: Condition): { label: string; hint?: string } {
  return condition === CONDITION_NOT_SET
    ? { label: CONDITION_LABEL[condition] }
    : { label: condition, hint: CONDITION_LABEL[condition].toLowerCase() };
}

/**
 * Every filter this search is currently narrowed by, one chip per *kind*.
 *
 * **Kinds, and the same kinds `activeFilterCount` counts.** Three colours are one chip reading
 * `Colour: Blue, Red, Green` rather than three, because the number on Reset all and the number of
 * chips under the bar have to be the same number — a reader who sees `Reset all 3` over six chips
 * has been told two different things about one search.
 *
 * **The search box is deliberately not in here.** Every other filter can be off screen — inside a
 * shut tray, or scrolled out of a narrow column — and that is the whole reason this row exists.
 * The text box is on the bar at every width with the words still in it, so a chip repeating them
 * would be the one statement that says nothing the reader cannot already see.
 *
 * Each chip clears its whole kind, which is what makes it the inverse of the count: pressing one
 * takes exactly one off the badge.
 */
export function activeChips<SortKey extends string>(
  search: FilterSurface<SortKey>,
  currency: "usd" | "eur",
): { label: string; remove: () => void }[] {
  const chips: { label: string; remove: () => void }[] = [];

  if (search.colors.length > 0) {
    chips.push({
      // `MANA_LABEL` rather than the letters: `Colour: W, U` is the payload, and the payload is
      // not what a reader picked — they pressed a white symbol and a blue one.
      //
      // **`exactly` rides the same chip rather than a second one**, for the reason the whole row
      // is one chip per kind: strict is not a filter, it is which reading the colour filter gets,
      // and a chip of its own would put a second entry under a badge that still counted one. The
      // word is in the sentence `Colour: exactly White, Blue` because that is the filter said
      // out loud — and it is what the × takes off along with the colours, because **the chip
      // names the reading**: an undo that left the word it had just printed standing would be
      // the statement and its own × disagreeing about what was cleared.
      //
      // **That is not the rule `toggleColorFilter` dropped**, and the difference is worth
      // holding. Unpressing the last colour chip is a press about one colour, so it leaves the
      // reading alone; pressing this × is a press on a sentence with `exactly` in it. One is an
      // incidental emptying of the row, the other is the reader clearing what they can read.
      label: `Color: ${search.colorsStrict ? "exactly " : ""}${MANA_KEYS.filter((k) =>
        search.colors.includes(k),
      )
        .map((k) => MANA_LABEL[k])
        .join(", ")}`,
      remove: () => {
        search.colors.forEach((c) => search.toggleColor(c));
        if (search.colorsStrict) search.toggleColorsStrict();
      },
    });
  }

  if (search.manaValues.length > 0 || search.manaX) {
    // One chip for both, because they are one OR group and one entry in the count — see
    // `ManaValueChips`, where X rides at the end of the numerals for the same reason.
    const values = [...search.manaValues]
      .sort((a, b) => a - b)
      .map((v) => (v >= 8 ? "8+" : String(v)));
    if (search.manaX) values.push("X");
    chips.push({
      label: `Mana value: ${values.join(", ")}`,
      remove: () => {
        search.manaValues.forEach((v) => search.toggleManaValue(v));
        if (search.manaX) search.toggleManaX();
      },
    });
  }

  if (search.sets.length > 0) {
    chips.push({
      // Upper-cased, which is how a set code is printed on the card and how the picker's own rows
      // draw it. The list is short by construction — the picker caps at 64 and a reader picks two
      // or three — so it is spelled out rather than counted.
      label: `Set: ${[...search.sets]
        .sort()
        .map((c) => c.toUpperCase())
        .join(", ")}`,
      remove: () => search.sets.forEach((c) => search.toggleSet(c)),
    });
  }

  if (search.format.length > 0) {
    const label =
      search.format === ANY_CARD
        ? "Any card"
        : (search.formats.find((f) => f.value === search.format)?.label ?? search.format);
    // `Showing:` and not `Format:` for the widening row, because `Any card` is not a format — it
    // is the corpus this search is drawn from, and a chip reading `Format: Any card` would state
    // a format filter that is not on.
    chips.push({
      label: search.format === ANY_CARD ? `Showing: ${label}` : `Format: ${label}`,
      remove: () => search.setFormat(""),
    });
  }

  if (search.rarities.length > 0) {
    chips.push({
      label: `Rarity: ${RARITIES.filter((r) => search.rarities.includes(r))
        .map(sentence)
        .join(", ")}`,
      remove: () => search.rarities.forEach((r) => search.toggleRarity(r)),
    });
  }

  // The **setter**, which is how every optional kind below is gated: a surface that cannot ask
  // this question is told apart from one that is not currently asking it by which of the two
  // fields is here at all.
  //
  // **It is here because `activeFilterCount` counts it.** This row and that badge are one
  // arithmetic — pressing a chip takes exactly one off the number — so a kind the count knows
  // about and this row could not state would be a reader looking at `Reset all 1` with nothing
  // under the rule saying what the 1 is. It matters more for this kind than for most: the type
  // chips are in the tray, so with the tray shut they have no control on screen at all.
  //
  // Drawn in `CARD_TYPES`' own order rather than the order they were pressed, which is the
  // rarities' rule above: the statement reads the same however the reader got to it.
  const { toggleType } = search;
  if (toggleType && search.types && search.types.length > 0) {
    const { types } = search;
    chips.push({
      label: `Type: ${CARD_TYPES.filter((t) => types.includes(t)).join(", ")}`,
      remove: () => types.forEach((t) => toggleType(t)),
    });
  }

  // The type chip's rule one kind along: gated on the setter, one chip for the whole OR group,
  // and drawn in `BORDERS`' own order — the ordinary card first — rather than the order pressed.
  // `BORDER_LABEL` rather than the ids, so `Full art` reads as the tray's chip reads and never as
  // the `fullart` the wire carries.
  const { toggleBorder } = search;
  if (toggleBorder && search.borders && search.borders.length > 0) {
    const { borders } = search;
    chips.push({
      label: `Border: ${BORDERS.filter((b) => borders.includes(b))
        .map((b) => BORDER_LABEL[b])
        .join(", ")}`,
      remove: () => borders.forEach((b) => toggleBorder(b)),
    });
  }

  // The setter and not the value, because `owned`'s own third state *is* `undefined`: a surface
  // that cannot ask this question is told apart from one that is not currently asking it by which
  // of the two fields is here at all.
  const { setOwned } = search;
  if (setOwned && search.owned !== undefined) {
    // The word the chip in the tray carries, so the statement and the control that made it use
    // one vocabulary.
    chips.push({
      label: search.owned ? "Owned" : "Missing",
      remove: () => setOwned(undefined),
    });
  }

  // One sentence for both of the cell's questions: `Finish: Foil` is true of a printing published
  // in foil and of a copy that is foil, and the surface the chip is drawn on says which.
  if (search.toggleFinish && search.finishes && search.finishes.length > 0) {
    const { finishes, toggleFinish } = search;
    chips.push({
      label: `Finish: ${FINISHES.filter((f) => finishes.includes(f))
        .map((f) => FINISH_LABEL[f])
        .join(", ")}`,
      remove: () => finishes.forEach((f) => toggleFinish(f)),
    });
  }

  if (search.toggleCondition && search.conditions && search.conditions.length > 0) {
    const { conditions, toggleCondition } = search;
    chips.push({
      // The grades as they are printed, which is what the chips carry — the spelled-out words are
      // the tooltip's, and `Condition: Near Mint, Lightly Played` would be twice the width of the
      // control that made it. The one grade nothing prints is spelled out anyway; `conditionChip`
      // carries the whole of that difference, so this row and the tray cannot come to disagree.
      label: `Condition: ${CONDITIONS.filter((c) => conditions.includes(c))
        .map((c) => conditionChip(c).label)
        .join(", ")}`,
      remove: () => conditions.forEach((c) => toggleCondition(c)),
    });
  }

  // The **setter** and not the value, `owned`'s rule above and for its reason: `undefined` is a
  // real third state here, so a surface that cannot ask the question is told apart from one that
  // is not currently asking it by which of the two fields is here at all. It is also what lets the
  // × clear the kind in one press where the chip in the tray walks the cycle.
  const { setNeedsReview } = search;
  if (setNeedsReview && search.needsReview !== undefined) {
    chips.push({
      label: search.needsReview ? "Needs review" : "Not flagged",
      remove: () => setNeedsReview(undefined),
    });
  }

  const { setPriceRange } = search;
  if (setPriceRange && (search.priceMin !== undefined || search.priceMax !== undefined)) {
    const low = search.priceMin === undefined ? null : formatPrice(search.priceMin, currency);
    const high = search.priceMax === undefined ? null : formatPrice(search.priceMax, currency);
    // Three sentences rather than one with an em dash and a hole in it: `Price: – $40` is a range
    // missing an end, where `Price: up to $40` is the filter said in words.
    const label =
      low !== null && high !== null
        ? `Price: ${low} – ${high}`
        : low !== null
          ? `Price: from ${low}`
          : `Price: up to ${high}`;
    chips.push({ label, remove: () => setPriceRange(undefined, undefined) });
  }

  return chips;
}

/**
 * The format picker's rows: the two pinned rows, then the formats as {@link useFormatOptions}
 * ordered them.
 *
 * **Two pinned rows above the sorted list, widest first — and they are what used to be a
 * select and an `Unplayable` chip.** Neither is a format: one is "no format filter at all" and
 * the other "no format filter, and no format required either", so both belong where a reader
 * reaches for them blind — first — whatever the alphabet and the facets do to the formats
 * below.
 *
 * They read as a ladder rather than as an alphabet: every card, every card that is legal
 * *somewhere*, then one named format. `Any format` is the default and the middle rung, which
 * is the shape a reader can predict without being told.
 *
 * Neither carries a `title`. Unlike a native `<option>` — which Windows never draws one for,
 * whatever the markup says — a `DropdownOption.title` here *would* show as a real hover
 * tooltip through `Row`'s `useTooltip` binding; it stays off because neither pinned row needs a
 * sentence beyond its own label, not because the platform would swallow it.
 *
 * Moved here from `FilterTray` with the rest of this file, so the phone's filters sheet offers
 * the same ladder rather than a second spelling of it.
 */
export function formatPickerRows<SortKey extends string>(
  search: FilterSurface<SortKey>,
  formatOptions: readonly { value: string; label: string; disabled: boolean }[],
): DropdownOption[] {
  return [
    // **`Any card` only where the surface narrows the corpus.** The card search and, since token
    // stacks (2026-09-26), the deck search's Collection tab send `playableOnly` under every other
    // row, so this is the widening back to what no format allows. The collection page and the
    // wishlist answer about cardboard the reader already has or wants and narrow by nothing of
    // the kind, so "every card, art cards included" is not a widening they can offer, and a row
    // that set `format` to a value the caller cannot honour would be a destination that goes
    // nowhere. `FilterSurface.anyCard` is what says which surface this is.
    //
    // It was drawn unconditionally for one commit while `FilterBar.tsx` was merged: a conversion
    // rewrote this block into an array and, in resolving the conflict, took one side whole —
    // which silently dropped the guard `main` had just added to the markup it replaced. The
    // suite caught it, which is the only reason this comment is here rather than a bug.
    ...(search.anyCard ? [{ value: ANY_CARD, label: "Any card" }] : []),
    { value: "", label: "Any format" },
    // The one place a real `disabled` was right on the old markup — `<option disabled>` is
    // native, and a listbox option is not a tab stop there is anything to lose. `DropdownOption`'s
    // own `disabled` is the shell's `aria-disabled` now, which is the same rule for the same
    // reason: a row here is never in the tab order either way, so there is nothing to strand.
    ...formatOptions.map((f) => ({ value: f.value, label: f.label, disabled: f.disabled })),
  ];
}
