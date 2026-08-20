import { useMemo } from "react";
import { ArrowUp } from "lucide-react";
import { motion } from "motion/react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import type { SearchSortKey } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import type { SortDir } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import { SetCombobox } from "./SetCombobox";
import { ANY_CARD, SEARCH_SORT_OPTIONS, type CardSearch } from "./useCardSearch";

/**
 * The orders the picker offers, in the one order an option list in this app is drawn in:
 * alphabetically by the words on screen (`lib/options.ts`).
 *
 * Sorted once at module scope rather than inside a memo, unlike `formatOptions` below. Nothing
 * about a sort is faceted — an order that would hand back the same rows rearranged is still an
 * order worth offering — so there is no state here for the ordering to depend on.
 * `SEARCH_SORT_OPTIONS` is declared in the order the orders were reasoned about, which is the
 * author's notes rather than anything a reader can see.
 *
 * `Default order` is deliberately not in this list. It is pinned above it in the markup, because
 * it is not an order to pick but the absence of one.
 */
const SORT_ROWS = sortOptions(SEARCH_SORT_OPTIONS, (s) => s.label);

/**
 * What the direction button says, spent twice — as its accessible name and as its `title`.
 *
 * It names the state **and** the press, because an arrow is the whole of what is drawn on that
 * button, and an arrow pointing up is read as "this is ascending" by one reader and "press to go
 * up" by the next. There is no visible text at all, so WCAG 2.5.3's "the name contains the
 * label" has nothing here to bind to.
 *
 * The out-of-reach reading names its reason instead of claiming a direction. At `Default order`
 * the list is in the view's own order — relevance when there is a query, name when there is not
 * — which is neither ascending nor descending by any column, and a button announcing "ascending"
 * over it would be describing a sort that is not there. **A `getByRole` on the exact enabled
 * string therefore fails on that row and reads as "the button is missing"**; match this name on
 * a prefix.
 */
function sortDirectionName(dir: SortDir | undefined): string {
  if (!dir) return "Sort direction — no order picked";
  return dir === "asc"
    ? "Sort direction: ascending — press for descending"
    : "Sort direction: descending — press for ascending";
}

/**
 * Every filter the search view offers, in one row.
 *
 * The colour chips are the app's one deliberate splash of colour and the reason the rest
 * of the chrome stays grey: a real mana symbol on its authentic printed fill is
 * recognisable at 36px to anyone who has held a card, in a way that a letter in a coloured
 * circle is not. Everything else here is quiet on purpose — outlined, mono, grey — so that
 * the one thing the eye lands on is which colours are switched on.
 *
 * The controls themselves live in `@/components/FilterChips`, which the collection view
 * builds its own row out of. This file owns the layout and *which* filters the search
 * offers, and nothing else.
 *
 * Not every control on it is a filter. The sort picker, the printings mode and the layout pair
 * each say how the results are *shown* rather than which ones there are — so none of them is
 * counted by the Reset all badge or cleared by pressing it, and the sort in particular is one
 * piece of state shared with the table's headers rather than something this row owns.
 */
export function FilterBar({
  search,
  layoutToggle = true,
}: {
  search: CardSearch;
  /**
   * Whether the grid-or-table pair rides the row.
   *
   * Off in the deck editor's docked panel, which is a wall of art and has no table to switch
   * to: the toggle there would move the *search view's* stored preference and change nothing
   * the reader can see, which is a control that lies. Everything else on the row is a
   * statement about which cards to show and means the same thing in both places.
   */
  layoutToggle?: boolean;
}) {
  /**
   * How many printings each option would leave, or `undefined` when that is not known.
   *
   * Every control below reads it through `facets.ts`, which is where the rule lives:
   * greyed means "turning this on would not change the result set", not-greyed means "we
   * don't know" — so `undefined` here leaves the whole row live, which is what a cold index,
   * a failed query and the first render all arrive as.
   */
  const facets = search.facets;
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
   */
  const formatOptions = useMemo(
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
  /**
   * Which way the list runs, or nothing when it runs in the view's own order.
   *
   * The **first** term's direction, because the first term is the one the select owns:
   * `flipSortDir` rewrites it in place and leaves a Shift-built secondary key exactly where the
   * table's headers put it. Read through `sortSelection` rather than straight off `sort[0]`, so
   * that one derived value decides all three things the button does — which way the arrow
   * points, what its name says, and whether it can be pressed — and the two halves of the pair
   * can never disagree about whether there is a sort at all.
   */
  const sortDir: SortDir | undefined =
    search.sortSelection === "" ? undefined : (search.sort[0]?.dir ?? "asc");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="card-search-text" className="sr-only">
        Search cards
      </label>
      <input
        id="card-search-text"
        type="search"
        value={search.text}
        onChange={(e) => search.setText(e.target.value)}
        placeholder="Search cards…"
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "min-w-56 flex-1 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
        )}
      />

      {/* Wider than the other groups' `gap-1`: a pressed chip's ring reaches 4px past its
          edge, and at 4px apart two pressed chips look like one welded object. */}
      <div role="group" aria-label="Color identity" className="flex gap-1.5">
        {MANA_KEYS.map((key) => (
          <ManaChip
            key={key}
            symbol={key}
            pressed={search.colors.includes(key)}
            // The one control on this row that does not ask "would this return nothing".
            // `colors` is subset semantics, so pressing a chip with another already on
            // *broadens* — the count is the size of the result set after the press, read
            // against `facets.total`. And that total is the facets' own: printings, exact,
            // and not the collapsed, capped number the results caption prints.
            disabled={colorDisabled(
              facets?.colors[key],
              facets?.total ?? 0,
              search.colors.includes(key),
            )}
            title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      <ManaValueChips
        selected={search.manaValues}
        onToggle={search.toggleManaValue}
        disabled={(value) =>
          optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
        }
        // The chip hands its own label back, so "8 or more" is spelled in one place.
        title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
        xSelected={search.manaX}
        onToggleX={search.toggleManaX}
        // `manaX` is a **field** of the facet response beside `manaValues` rather than a key
        // inside it, so this reads a bare count — and `countDisabled` is the same rule the
        // nine chips to its left grey by rather than a second one written next to it. Rust
        // counts it off the same `Skip::Mana` base, so X greys when and only when its
        // neighbours would: because nothing in this search has one.
        xDisabled={countDisabled(facets?.manaX, search.manaX)}
        xTitle={(label) => facetTitle(label, facets?.manaX)}
      />

      <SetCombobox selected={search.sets} onToggle={search.toggleSet} counts={facets?.sets} />

      <label htmlFor="card-search-format" className="sr-only">
        Format
      </label>
      <select
        id="card-search-format"
        value={search.format}
        onChange={(e) => search.setFormat(e.target.value)}
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "bg-surface px-2",
          // Accent means "this is not where the control opens", which is a wider claim than
          // "a filter is on" — `Any card` is a *widening* and lights the same way, because the
          // reader needs to see that the wall in front of them has art cards and tokens in it.
          // `Any format` is the default and the only value that reads as untouched.
          search.format ? "border-accent text-accent" : "border-border text-dim",
        )}
      >
        {/* **Two pinned rows above the sorted list, widest first — and they are what used to be
            a select and an `Unplayable` chip.** Neither is a format: one is "no format filter at
            all" and the other "no format filter, and no format required either", so both belong
            where a reader reaches for them blind — first — whatever the alphabet and the facets
            do to the formats below, and however many of them the search hands over.

            They read as a ladder rather than as an alphabet: every card, every card that is
            legal *somewhere*, then one named format. `Any format` is the default and the middle
            rung, which is the shape a reader can predict without being told.

            Neither carries a `title`. A `title` on an `<option>` is not drawn by Windows' native
            dropdown, so the sentence explaining that "any card" means art cards, tokens and
            emblems could only be read by a screen reader — and the labels stay this short on
            purpose: a `<select>` is as wide as its widest option, and this row has to survive
            the deck editor's docked panel at its 206px floor. */}
        <option value={ANY_CARD}>Any card</option>
        <option value="">Any format</option>
        {formatOptions.map((f) => (
          // The one place a real `disabled` is right: `<option disabled>` is native, and a
          // listbox option is not a tab stop there is anything to lose. No count rides here
          // — a `title` on an `<option>` is not drawn by Windows' native dropdown, so it
          // would be a sentence nobody can read.
          <option key={f.value} value={f.value} disabled={f.disabled}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Last of the filters, because it is the only one that is not a statement about the
          card: everything left of it describes cardboard, and this describes the reader's
          relationship to it. One chip and three states — the word on it is what says which
          of the two questions is being asked, so an unpressed "Owned" cannot be mistaken
          for a pressed "Missing".

          **Never greyed**, whatever its counts say: greying a chip mid-cycle would strand
          whoever is in it. The tooltip counts what the chip's *word* names, which is one
          rule reading correctly in both directions — unpressed, it is what pressing would
          give; pressed, it is what the reader is already looking at. */}
      <ToggleChip
        label={search.owned === false ? "Missing" : "Owned"}
        pressed={search.owned !== undefined}
        title={facetTitle(
          search.owned === false ? "Missing" : "Owned",
          search.owned === false ? facets?.owned.missing : facets?.owned.owned,
        )}
        onClick={search.toggleOwned}
      />

      {/* The sort, from the other end of the state the table's headers already drive. Picking
          here *replaces* the sort with that one term; the headers refine and extend it. So the
          picker follows a header press and a header's arrow follows the picker — one piece of
          state with two controls on it, which is the collection's arrangement and the reason
          this sits in the collection's place on the row: last, just before Reset all.

          **Drawn in both layouts and on both surfaces, which is the whole of the feature.** The
          grid has no headers to press, and the deck editor's docked panel is a grid with no
          table to switch to at all — so `layoutToggle` is deliberately not the fence. That prop
          says "this surface has no second layout", which names exactly the surface with no other
          way to sort; fencing on it would take the control away from the one place it is the
          only one.

          The pair is boxed rather than left to the row's own `gap-x-3`, which would stand the
          arrow 12px off the order it belongs to and let `flex-wrap` break the two onto separate
          lines — a direction with its order on the line above is a button about nothing. 4px
          apart, like the layout pair at the far end of the row.

          It costs the docked panel nothing at its 206px floor. A `<select>` is as wide as its
          widest option and `Default order` is the widest row this one has — two characters more
          than the `Any format` beside it — which puts the whole pair well inside the `min-w-56`
          (224px) the search box on the line above already asks for. Nothing added here is what
          decides that column's width, and the box wraps as one. */}
      <div className="flex items-center gap-1">
        {/* **`Sort results`, and never shortened back to `Sort`.** The collection's twin is a bare
            `Sort` and this one may not copy it, because this row is drawn on two surfaces and one
            of them already has a `Sort`: the deck editor's toolbar sorts **the deck**, this sorts
            **the search results**, and with the docked panel open both lists are on screen at
            once. Two comboboxes with one name is not a WCAG failure — it is a control that cannot
            be addressed unambiguously, by a screen reader walking the form, by anyone driving the
            app by voice, or by a `getByLabelText("Sort")` that starts throwing "found multiple"
            the day a test opens that panel.

            The widening goes here rather than on the deck editor's label for the reason that
            decides every one of these: that one has only to be unambiguous where it is mounted,
            and this one has to be unambiguous *wherever* it is. `PrintingsFilterBar.tsx:380` made
            the same call and wrote down the same trap — a bare verb names an action and not the
            thing it acts on, which is why it draws `Sort printings by` and not `Sort by`. */}
        <label htmlFor="card-search-sort" className="sr-only">
          Sort results
        </label>
        <select
          id="card-search-sort"
          value={search.sortSelection}
          onChange={(e) => search.setSortKey(e.target.value as SearchSortKey | "")}
          // **Never gold**, unlike the format select two controls back. Accent there means "this
          // is not where the control opens", which is a state a filter can be in and out of. A
          // list is always in *some* order, so a sort cannot be inactive — and a gold sort
          // picker would be saying "a filter is on" about the one control on this row that is
          // not a filter, and that Reset all deliberately does not clear.
          className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
        >
          {/* Pinned first and outside the sorted list, for the reason `Any format` is: it is not
              an order to pick but the absence of one, and a reader reaching for the way back
              reaches for it blind.

              Pickable, and **not** `disabled` like the collection's `Custom…` — the two rows
              look alike and are opposites. That one is a state the control can only be *put*
              into, from a header this select has no option for. This one is a real destination:
              it is how a reader who sorted by accident gets the view's own order back, and on
              the grid it is the only way, because the third press that clears a sort is a press
              on a header the grid does not draw. */}
          <option value="">Default order</option>
          {SORT_ROWS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* One arrow, turned over — never `ArrowDown` swapped in for `ArrowUp`. That is the rule
            `SortableHeader.tsx:51-55` states and this is the reason it states it: a different
            element in the same slot is unmounted and remounted, so the indicator *teleports*,
            and the whole of what the press means is that the order reversed. Half a turn is that
            fact, drawn. `initial={false}`, so a row that opens already descending draws its
            arrow turned rather than spinning on first paint — the header's rule, for the
            header's reason.

            `rotate` is a transform prop, so `MotionConfig reducedMotion="user"` reaches it and
            no `useReducedMotion` opt-out is owed here (`docs/reference/motion.md` — the trap
            there is the *non*-positional properties, and this animates none).

            **The real `disabled`, and the row's `aria-disabled` rule does not bind.** That rule
            is about a filter row greying *as the reader types*, where a control leaving the tab
            order would shrink the row out from under a keyboard caret. This one can only grey
            when the reader themselves puts the select back to `Default order`, and their caret
            is on that select when they do it — the button never vanishes from under the thing
            focusing it. */}
        <button
          type="button"
          onClick={search.flipSortDir}
          disabled={!sortDir}
          aria-label={sortDirectionName(sortDir)}
          title={sortDirectionName(sortDir)}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "flex size-9 items-center justify-center",
            // Not `aria-pressed`, and never gold: descending is not a filter switched on, it is
            // the other half of a control that is always doing something. `filterChipState`'s
            // unpressed arm is what every other quiet control on this row wears, and its
            // `unavailable` arm is the row's one greying treatment rather than a second one
            // written next to it.
            filterChipState(false, !sortDir),
          )}
        >
          {/* `flex` on the span is load-bearing and not decoration: a bare `<span>` is a
              non-replaced inline box, a transform does not apply to one at all, and the rotation
              would silently do nothing. `SortableHeader` carries the same class for the same
              reason. */}
          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: sortDir === "desc" ? 180 : 0 }}
            transition={TRANSITION.fast}
            className="flex"
          >
            <ArrowUp className="size-4" />
          </motion.span>
        </button>
      </div>

      {/* Always drawn, greyed when there is nothing to clear — the rule lives in the control,
          so every view that offers a reset offers the same one. This row is the reason it is
          that way round: the search box above is `flex-1`, so a Reset that appeared on the
          first press would take its width out of the box and slide all nine colour chips left
          under the finger that just pressed one. */}
      <ResetAll count={search.activeCount} onReset={search.resetAll} />

      {/* A view mode rather than a filter, so it sits past the reset with the layout pair
          rather than among the statements about which cards to show — and, like them, it
          is untouched by Reset all. The search answers "which cards exist"; this is the way
          through to "which printings", which is otherwise the card pane's question. */}
      <ToggleChip
        label="All printings"
        pressed={search.allPrintings}
        onClick={search.toggleAllPrintings}
      />

      {/* An `Unplayable` chip used to ride here, beside All printings, on the argument that
          both said what there is to look *through* rather than what to look for. It is the
          format select's `Any card` row now: the chip and that select were moving the same axis
          in opposite directions, and the one state only the pair could reach — "Modern, and
          also the art cards" — was a filter contradicting itself. One control, three rows, and
          the row is counted and cleared by Reset all like the filter it always was. */}

      {layoutToggle && <ViewToggle />}
    </div>
  );
}

/** The layout pair, bound to the search's own preference — the collection keeps a separate
 *  one, because a search is for looking at cards and a collection for counting them. */
function ViewToggle() {
  const view = useAppStore((s) => s.searchView);
  const setSearchView = useAppStore((s) => s.setSearchView);
  return <LayoutToggle view={view} onChange={setSearchView} />;
}
