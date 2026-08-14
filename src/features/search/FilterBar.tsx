import { useMemo } from "react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import { SetCombobox } from "./SetCombobox";
import { ANY_CARD, type CardSearch } from "./useCardSearch";

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

      {/* The card the wall is narrowed to, drawn only while it is — and drawn **first**,
          beside the search box, because it is the one filter on this row the reader did not
          set here. It arrives from a card's own right-click menu in any of ten surfaces, so
          without it the reader gets a wall holding one card's printings and nothing on screen
          saying why; the name is the whole account, and pressing it is the way out.

          A `ToggleChip` like its neighbours rather than a shape of its own: it is on, it says
          so with the same gold border every other on-chip here uses, and it turns off on a
          press exactly as they do. The title leads with the visible name (WCAG 2.5.3) and
          spends the rest saying what the chip is, which "Lightning Bolt" alone cannot.

          **`max-w-48 truncate`, and it is the one chip on this row that needs a width bound.**
          Every other label here is a word this app chose; this one is a card name, which is
          data — up to 141 characters ("Our Market Research Shows That Players Like Really Long
          Card Names…"), and a name that long wraps to three lines inside a `h-9` box, taking
          the row's whole line with it. Written out whole rather than interpolated: Tailwind
          scans source text. The `title` carries the full name, so the ellipsis costs nothing. */}
      {search.oracleId !== "" && (
        <ToggleChip
          label={search.oracleName}
          pressed
          title={`${search.oracleName} — showing every printing of this card. Press to clear.`}
          className="max-w-48 truncate"
          onClick={() => search.setOracleId("")}
        />
      )}

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
