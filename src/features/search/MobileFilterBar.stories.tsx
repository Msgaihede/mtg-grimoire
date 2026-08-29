import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowUp } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  FILTER_LABEL,
  filterChipState,
  FiltersButton,
  ManaChip,
  ManaValueChips,
  RarityChip,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { PriceRange } from "@/components/PriceRange";
import type { SearchSortKey } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import { FilterBar, SEARCH_SORT_ROWS } from "./FilterBar";
import { SetCombobox } from "./SetCombobox";
import { useCardSearch, type CardSearch } from "./useCardSearch";

// Declared here rather than shared, and the numbers rather than the box are what is shared.
// A Tailwind class cannot be built by interpolation — it would emit no rule at all — so the
// width is an inline style, which is how this repo already spells a computed length.
// `shrink-0` because the docs canvas is a flex container: without it a narrow canvas shrinks
// the frame and the story becomes a picture of a width nobody asked for.
const phone = (Story: () => ReactElement) => (
  <div
    className="flex shrink-0 overflow-hidden"
    style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}
  >
    <Story />
  </div>
);

/**
 * The three heights the whole round turns on, measured 2026-08-29 in headless Chromium over the
 * built stylesheet (`dist/assets/index-HbsLLTR6.css`) with `FilterBar`'s own markup at a **350px**
 * container — 390 less `main`'s `p-5`.
 *
 * They are constants here so the wall's caption can say what it is standing under rather than
 * asserting a number nothing checks. Nothing in the app reads them; when this file is deleted at
 * the end of the round they go with it, and the write-up is where they live afterwards.
 */
const MEASURED = {
  /** The whole bar, tray shut, nothing filtered: four lines plus two zero-height break lines. */
  barShut: 273,
  /** The same bar with every control raised to the 44px floor — F1. */
  barAtTargetSize: 329,
  /** `FilterTray` in the flow at one column: six cells, Rarity taking two rows of chips. */
  trayInFlow: 493,
  /** The ribbon **block** — `h-14`'s 56 plus `ManaLine`'s 2px, as Round 1 measured it. */
  ribbon: 58,
  /** A `CardGrid` tile at 1×: 170 wide, so 238 of art, plus `chinHeight(1) - CHIN_RISE`. */
  tile: 238 + 24,
} as const;

/**
 * The ribbon block stands here.
 *
 * **A ruler and not a proposal.** What the ribbon becomes on a phone is Task 5's round; this band
 * exists because a filter bar drawn at the top of an empty frame is a picture of a bar nobody has
 * to fit anything above, and it is the first thing subtracted from the budget. 58 rather than 56:
 * `h-14` is the row and `ManaLine` adds 2px under it, which is the block Round 1 measured.
 */
function RibbonBand() {
  return (
    <div
      className="flex shrink-0 items-end border-b border-border px-4 pb-1"
      style={{ height: MEASURED.ribbon }}
    >
      <span className={FILTER_LABEL}>Ribbon · 58</span>
    </div>
  );
}

/**
 * What the bar left the wall, drawn as the room it is and captioned with its own measured height.
 *
 * **The signature of this round, and the reason it is drawn at all**: the filter bar's cost is
 * not paid in the bar, it is paid in the only thing the reader opened the app for. Three options
 * compared without the wall under them are three pictures of the thing that is not scarce.
 *
 * The height is **measured rather than written down** — the repo's own rule about numbers a build
 * already answers, and the number changes with every option. `ResizeObserver` is stubbed to a
 * no-op under jsdom (`src/test-setup.ts`), so the caption reads `—` there and the story still
 * renders, which is all `src/stories.test.tsx` claims about it.
 *
 * The dashed foot is the **visible viewport at 700px** — 390×844 less a mobile browser's chrome.
 * Everything under that line costs a scroll on a real phone, and the outline inside the region is
 * one `CardGrid` tile at 1× so "one row and a sliver" is a picture rather than a sentence.
 */
function Wall() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  // `CardGrid`'s own shape: observe, then seed, then disconnect. jsdom's stub makes both halves
  // no-ops and the seed reads 0, which is the `—` case below.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);
  const rows = height > 0 ? Math.floor(height / MEASURED.tile) : 0;
  return (
    <div
      ref={ref}
      className="mt-3 flex min-h-0 flex-1 flex-col gap-2 rounded-lg border border-dashed border-border p-2"
    >
      <span className={FILTER_LABEL}>
        {height > 0 ? `Card wall · ${Math.round(height)}px · ${rows} tile row` : "Card wall · —"}
        {rows === 1 ? "" : height > 0 ? "s" : ""}
      </span>
      {/* One tile at 1×, at the width `columnsFor(350, 170)` gives it — which is one column, and
          that is `CardGrid`'s round to answer rather than this one's. */}
      <div
        className="shrink-0 rounded-md border border-dashed border-border"
        style={{ width: 170, height: MEASURED.tile }}
      />
    </div>
  );
}

/**
 * The app around the bar: `Ribbon`, then `AppShell`'s one scroller with its real padding.
 *
 * `relative min-h-0 flex-1 overflow-auto p-5` is `AppShell`'s `<main>` character for character,
 * because the 40px of vertical padding is the second thing subtracted from the budget and a
 * story that quietly used `p-4` would be arguing from a window the app does not have.
 *
 * **The nav rail is deliberately absent.** `w-52` is 208px of a 390px window and `w-17` is 68;
 * what happens to it is Task 5's question, and every number here assumes it has stopped taking
 * width. Say so rather than drawing a guess at it.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg text-text">
      <RibbonBand />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-auto p-5">{children}</main>
    </div>
  );
}

/** One captioned cell of the sheet — `FilterTray`'s `TrayField` shape, which is module-private,
 *  re-spelled from the caption recipe that is exported for exactly this. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={FILTER_LABEL}>{label}</span>
      {children}
    </div>
  );
}

/**
 * What both sheets hold — the tray's six cells, and for F3 the four controls that never fold away
 * on top of them.
 *
 * **Built out of `@/components/FilterChips` over the real `useCardSearch`, which is the sanctioned
 * way and the only one open here.** `FilterTray` is module-private inside `FilterBar.tsx` and
 * `trayOpen` is that component's own state with no prop and no `play` to reach it, so nothing
 * outside that file can put the shipped tray in a `Dialog`. **That is a real cost of F2 and F3
 * rather than a shortcut taken here**: shipping either one means the tray leaves `FilterBar`'s
 * privacy, and it is written up as such.
 *
 * Two rules `FilterTray` owns are therefore **not** re-derived below, because copying them is how
 * a stand-in starts to disagree with the thing it stands in for: the format picker's two pinned
 * rows and its alphabet (`FilterBar`'s `formatOptions` memo), and the tray's own greying. The
 * facet helpers are called through where a call is a pass-through rather than a copy.
 */
function SheetBody({ search, everything }: { search: CardSearch; everything: boolean }) {
  const facets = search.facets;
  const formatOptions: readonly DropdownOption[] = [
    { value: "", label: "Any format" },
    ...search.formats.map((f) => ({ value: f.value, label: f.label })),
  ];
  const sortOptions: readonly DropdownOption[] = SEARCH_SORT_ROWS.map((s) => ({
    value: s.value,
    label: s.label,
    disabled: s.disabled,
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
      {everything && (
        <>
          {/* The four that never fold away, in the sheet rather than on the bar — which is the
              whole of what F3 moves, and the whole of what it costs. */}
          <Cell label="Colour identity">
            <div role="group" aria-label="Color identity" className="flex flex-wrap gap-1.5">
              {MANA_KEYS.map((key) => (
                <ManaChip
                  key={key}
                  symbol={key}
                  pressed={search.colors.includes(key)}
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
          </Cell>
          <Cell label="Mana value">
            {/* No `chipClass`: the group's own `size-9` is the family's 36, and a sheet is 358px
                wide — ten chips at 36 are 396, so they wrap to two rows here exactly as they do
                on the bar. The 32px squeeze the bar spends below 640 buys nothing in a sheet. */}
            <ManaValueChips
              selected={search.manaValues}
              onToggle={search.toggleManaValue}
              disabled={(value) =>
                optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
              }
              title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
              xSelected={search.manaX}
              onToggleX={search.toggleManaX}
              xDisabled={countDisabled(facets?.manaX, search.manaX)}
              xTitle={(label) => facetTitle(label, facets?.manaX)}
            />
          </Cell>
          <Cell label="Sort results">
            <div className="flex items-center gap-1">
              <Dropdown
                label="Sort results"
                value={search.sortSelection}
                // The cast `FilterBar` makes at the same seam: a `<Dropdown>` hands back the
                // `value` string it was given, and the row it came from is one of `sortRows`'.
                onChange={(key) => search.setSortKey(key as SearchSortKey | "")}
                options={sortOptions}
                fill
              />
              {/* The arrow, turned over rather than swapped out — `SortableHeader`'s rule, and
                  `FilterBar`'s own spelling of it, minus the `motion` wrapper this stand-in has
                  no reason to re-declare. */}
              <button
                type="button"
                onClick={search.flipSortDir}
                disabled={!search.sortDir}
                aria-label={
                  search.sortDir ? `Sort direction: ${search.sortDir}` : "Sort direction — none"
                }
                className={cn(
                  FILTER_CONTROL,
                  FILTER_FOCUS,
                  "flex size-9 shrink-0 items-center justify-center",
                  filterChipState(false, !search.sortDir),
                )}
              >
                <ArrowUp
                  className={cn("size-4", search.sortDir === "desc" && "rotate-180")}
                  aria-hidden="true"
                />
              </button>
            </div>
          </Cell>
          <div aria-hidden="true" className="h-px shrink-0 bg-border" />
        </>
      )}
      <Cell label="Set">
        <SetCombobox
          selected={search.sets}
          onToggle={search.toggleSet}
          counts={facets?.sets}
          align="start"
          fill
        />
      </Cell>
      <Cell label="Format">
        <Dropdown
          label="Format"
          value={search.format}
          onChange={search.setFormat}
          options={formatOptions}
          fill
          searchable
          active={search.format !== ""}
        />
      </Cell>
      <Cell label="Owned">
        <div className="grid grid-cols-2 gap-1.5">
          <ToggleChip
            label="Owned"
            pressed={search.owned === true}
            onClick={() => search.setOwned(true)}
            className="w-full"
          />
          <ToggleChip
            label="Missing"
            pressed={search.owned === false}
            onClick={() => search.setOwned(false)}
            className="w-full"
          />
        </div>
      </Cell>
      <Cell label="Rarity">
        <div className="grid grid-cols-3 gap-1.5">
          {["common", "uncommon", "rare", "mythic"].map((rarity) => (
            <RarityChip
              key={rarity}
              rarity={rarity}
              pressed={search.rarities.includes(rarity)}
              onClick={() => search.toggleRarity(rarity)}
            />
          ))}
        </div>
      </Cell>
      <Cell label={`Price (${search.marketplace.currency.toUpperCase()})`}>
        <PriceRange
          min={search.priceMin}
          max={search.priceMax}
          currency={search.marketplace.currency}
          onChange={search.setPriceRange}
        />
      </Cell>
      <Cell label="Printings">
        <ToggleChip
          label="All printings"
          pressed={search.allPrintings}
          onClick={search.toggleAllPrintings}
          className="w-full"
        />
      </Cell>
      {/* Reset all travels with the filters. On the bar it lives under a rule below every
          control; in a sheet the foot of the sheet is that place. */}
      <div className="grid shrink-0 border-t border-border pt-3.5 [&>button]:justify-center">
        <ResetAll count={search.activeCount} onReset={search.resetAll} />
      </div>
    </div>
  );
}

/**
 * The rules F1 would add to the shipped stylesheet, **drawn unconditionally here.**
 *
 * A desktop Storybook has a fine pointer, so a `coarse:`-gated rule does not apply in this
 * preview and F1 would be a picture of today. These are therefore the same declarations with the
 * gate taken off — the option made lookable-at, and not the option as it would ship. **The
 * shipped spelling is `coarse:` on each of the three sites named below**, which is `src/index.css`'s
 * one variant for the question; `src/lib/touchTargets.test.ts` sweeps `src/` for any second
 * spelling of it and this file must not be one, so there is no media query here at all.
 *
 * Selected by the class each control's height is written as, because that is what F1 is: every
 * rung of the app's control ladder that is under the floor, raised to it. `.h-9` is
 * `FILTER_SHAPE`'s (the box, the Filters button, the sort trigger, Reset all); `.size-9` is the
 * six colour chips, the layout pair and the sort-direction button; `.size-8` is the ten mana-value
 * chips in this container band.
 *
 * The one control deliberately left alone is the **stated-filter chip**, and that is F1's real
 * design decision rather than an omission. It is 26px on purpose — `FilterChips.tsx` says a
 * statement must never be mistaken for a control — so it takes the *room* instead of the box: a
 * transparent `::before` bled to the floor above and below it. 26px already clears WCAG 2.5.8's
 * 24×24; what the pseudo-element buys is 2.5.5's 44, without moving a pixel a reader can see.
 */
const TARGET_SIZE_CSS = `
[data-target-size] .h-9 { height: var(--target-min); }
[data-target-size] .size-9 { width: var(--target-min); height: var(--target-min); }
[data-target-size] .size-8 { width: var(--target-min); height: var(--target-min); }
[data-target-size] [aria-label^="Remove filter"] { position: relative; }
[data-target-size] [aria-label^="Remove filter"]::before {
  content: ""; position: absolute; left: 0; right: 0;
  top: calc((1.625rem - var(--target-min)) / 2);
  bottom: calc((1.625rem - var(--target-min)) / 2);
}
`;

/** Which of the three arrangements a story is drawing. */
type Option = "targets" | "sheet" | "sticky";

/**
 * `FilterBar` over the **real `useCardSearch`**, in a phone-shaped `AppShell`, arranged three
 * ways.
 *
 * The hook rather than a hand-built `FilterSurface` for `FilterBar.stories.tsx`'s reason one level
 * up: the badge's arithmetic and six toggle rules live in it, and a copy would drift while every
 * story here stayed green. Both sheets are wired to the *same* hook as the bar, so pressing a chip
 * in the sheet moves the chips under the bar behind it.
 */
function MobileBar({ option, sheetOpen = false }: { option: Option; sheetOpen?: boolean }) {
  const search = useCardSearch();
  const [open, setOpen] = useState(sheetOpen);
  const bar =
    option === "sticky" ? (
      // F3's strip. **`FilterBar` is not on the wall in this option** — every control it holds is
      // in the sheet — so what stands here is the two the reader reaches for without opening
      // anything, built from the same two recipes the bar builds them from.
      //
      // `-mx-5 px-5` and `-mt-5 pt-5` because `position: sticky` sticks against the scroller's
      // **padding box**: without them the wall scrolls through `main`'s 20px gutters beside and
      // above the strip. `LAYER.header` is the rung a sticky bar over a scrolling list takes —
      // `layers.ts` names this exact pairing.
      <div
        className={cn(
          "sticky top-0 -mx-5 -mt-5 flex shrink-0 items-center gap-2 bg-bg px-5 pt-5 pb-2",
          LAYER.header,
        )}
      >
        <label htmlFor="mobile-search-text" className="sr-only">
          Search cards
        </label>
        <input
          id="mobile-search-text"
          type="search"
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          placeholder="Search cards…"
          className={cn(
            FILTER_FIELD,
            FILTER_FOCUS,
            "min-w-0 flex-1 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
          )}
        />
        <FiltersButton
          open={open}
          count={search.activeCount}
          onToggle={() => setOpen((on) => !on)}
          controls="mobile-filter-sheet"
        />
      </div>
    ) : (
      <div className="shrink-0">
        <FilterBar search={search} />
      </div>
    );
  return (
    // **The `transform` is load-bearing and is not decoration.** `Dialog`'s scrim is
    // `fixed inset-0`, which is laid out against the *viewport* — the whole Storybook canvas —
    // unless an ancestor is transformed, in which case that box becomes the containing block. So
    // without it the sheet would cover the canvas rather than the phone, and this round's whole
    // subject is what a 390px frame holds. `CreateDeckDialog.tsx` states the same mechanism from
    // the other end. `translateZ(0)` rather than a Tailwind utility because it is a fact about
    // this frame rather than a style anybody is choosing. Verified against the built stylesheet:
    // the scrim measures 390×844 inside this box and 2000-wide without it.
    //
    // **One artefact it cannot fix, and it is worth knowing before reading a pixel off this
    // story.** The scrim's inset is `p-4 sm:p-6`, and `sm:` is a *viewport* query — so in a
    // Storybook canvas wider than 640 the sheet takes 24px a side and draws **342px** wide, where
    // on a real 390px phone the viewport is under 640, `p-4` applies, and it is **358**. The
    // frame is a phone; the browser around it is not.
    <div
      data-target-size={option === "targets" ? "" : undefined}
      className="flex min-w-0 flex-1 flex-col"
      style={{ transform: "translateZ(0)" }}
    >
      {/* `display: none` by the UA stylesheet, so it is not a flex item. */}
      {option === "targets" && <style>{TARGET_SIZE_CSS}</style>}
      <Shell>
        {bar}
        <Wall />
      </Shell>
      {option !== "targets" && (
        // **`w-full` and not a sheet's height**, which is the one thing `Dialog` cannot be asked
        // for: `width` is its only geometry prop, the panel is `max-h-full` inside a
        // `place-items-center` scrim, and a body shorter than the window therefore draws a centred
        // card rather than a sheet. A full-height surface needs a prop `Dialog` has not got — see
        // the write-up, where that is one of this round's costs rather than a detail.
        <Dialog
          open={open}
          title="Filters"
          closeLabel="Close filters"
          width="w-full"
          onDismiss={() => setOpen(false)}
          onClose={() => setOpen(false)}
        >
          <div id="mobile-filter-sheet" className="flex min-h-0 flex-1 flex-col">
            <SheetBody search={search} everything={option === "sticky"} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

const meta = {
  // The wrapper, not `FilterBar` — typing the meta over the component would demand a whole
  // `FilterSurface` as a story arg, which is the object the real hook exists here to avoid.
  component: MobileBar,
  title: "Mobile/Filter bar",
  tags: ["autodocs"],
  decorators: [phone],
  argTypes: { option: { table: { disable: true }, control: false } },
  parameters: {
    // Two of the three stories mount a `Dialog`, whose scrim is `fixed inset-0`: rendered inline,
    // each one would cover the whole docs page rather than its own block and the last mounted
    // would be the only one readable. `inline: false` gives each an iframe, which is the viewport
    // the fixed positioning is then relative to — `Dialog.stories.tsx`'s reason, unchanged.
    docs: {
      story: { inline: false, height: "880px" },
      description: {
        component:
          "Three arrangements of the filter row at **390×844**, each in the app it really sits " +
          "in — a 56px `Ribbon` and `AppShell`'s `<main>` with its own `p-5`, which is what " +
          "leaves the bar a **350px** container.\n\n" +
          "**This round is narrower than the other three, and the tree is why.** `FilterBar` " +
          "already lays out by its own width in four bands at 640 / 900 / 1500, and the sub-640 " +
          "band was drawn for the deck editor's docked panel at its 206px floor — a ~193px " +
          "content box, half a phone. Below 640 the search box already takes a whole line, the " +
          "gaps already close from 12 to 8, and the mana-value chips already drop from 36px to " +
          "32. Nothing here proposes a phone layout the component does not have.\n\n" +
          "**The vertical budget is what decides it.** At 390×844 a mobile browser leaves about " +
          "700px visible. The ribbon block's 58 and `main`'s 40 of padding take 98 of it, and " +
          "the bar takes **273px more** — four lines, two zero-height break lines at 8px of row " +
          "gap apiece, and the always-drawn Reset all under its rule. Measured 2026-08-29 in " +
          "headless Chromium over `dist/assets/*.css` at a 350px container. That leaves the wall " +
          "**329px**, which is one 262px tile row and 67px of nothing — not the ~500px the plan " +
          "estimated.\n\n" +
          "Each story is drawn in the state its own proposal is visible in: F1 and F3 with the " +
          "sheet shut, F2 with it open, since F2's shut bar is byte-identical to today's. The " +
          "`sheetOpen` control opens either of the other two.",
      },
    },
  },
} satisfies Meta<typeof MobileBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **F1 — change nothing but the target size.**
 *
 * The container query already answers a 390px box, so the only thing wrong with the shipped bar
 * on a phone is that a finger is aiming at controls drawn for a mouse: 36px for the search box,
 * the Filters button, the sort pair, the colour chips and the layout pair, and **32px** for the
 * ten mana-value chips. WCAG 2.5.5 (AAA) asks 44×44; 2.5.8 (AA) asks 24×24, which every one of
 * them already clears.
 *
 * **Drawn at the floor unconditionally, and it would ship gated.** A desktop Storybook has a fine
 * pointer, so a `coarse:`-gated rule would not apply in this preview and this story would be a
 * picture of today. The declarations are in `TARGET_SIZE_CSS` above with the gate taken off; the
 * shipped edit is `coarse:h-11` on `FILTER_SHAPE`, `coarse:size-11` on `ManaChip` and
 * `LayoutToggle`'s buttons — all three inside `FilterChips.tsx`, which serves the collection's
 * row and `PrintingsFilterBar` too — plus `coarse:size-11` at `FilterBar`'s two call sites, the
 * sort-direction button and `ManaValueChips`' `chipClass`.
 *
 * **What it costs: 56px.** The bar goes 273 → **329**, because the colour chips grow to 294px and
 * still share their line with Filters, but the mana-value group goes from two rows of 32 to two
 * rows of 44. The wall drops from 329px to **273** — still one tile row, with 11px left over
 * instead of 69. Nothing wraps differently and no line is added: the ten value chips already wrap
 * at 32 in a 350px container (356 > 350), which is the fact that makes this option cheap.
 *
 * **The one control left at 26px is the deliberate part.** A stated-filter chip is not the family's
 * 36 on purpose — `FilterChips.tsx` says a statement must never be mistaken for a control — so it
 * takes the room and not the box: a transparent `::before` bled to the floor above and below it,
 * which is how a 26px chip meets 2.5.5 without moving a pixel a reader can see.
 *
 * The bar here is the shipped one whole, disclosure included, so pressing `Filters` opens the
 * **in-flow tray** — 493px against a 602px content column, with the wall gone and the bottom of
 * the tray itself below the fold. That is what F1 leaves alone and what F2 exists to answer.
 */
export const RaisedTargets: Story = {
  args: { option: "targets" },
};

/**
 * **F2 — the disclosure becomes a sheet.**
 *
 * The bar is untouched; what changes is where `Filters` opens. In the flow the tray is **493px**
 * at one column (measured — six cells, Rarity taking two rows of chips), so an open tray puts the
 * bar and its tray at 774px against a 602px content column: the wall is not pushed down, it is
 * gone, and the bottom of the tray is itself below the fold. As a modal it covers the wall it
 * would otherwise have pushed off, which is honest — a reader choosing filters is not looking at
 * cards — and the stated-filter chips stay on the bar underneath, legible through the scrim, so
 * what is on is still readable while it is being changed.
 *
 * **Two costs, and neither is a detail.** `Dialog`'s only geometry prop is `width`, so a
 * full-height sheet needs a prop it has not got; drawn with what exists it is a centred panel that
 * grows to `max-h-full` and stops. And the tray cannot move without leaving `FilterBar.tsx`'s
 * module privacy — `FilterTray` is not exported and `trayOpen` has no prop, which is why the body
 * below is assembled from `FilterChips`' exports rather than being the shipped tray.
 *
 * **The third cost is the one that decides the option.** A sheet is modality, and modality is a
 * different element tree — CSS cannot switch it. `FilterBar` chooses its arrangement entirely in
 * `@container/fb`, so making the tray a sheet only below some width takes a `ResizeObserver` in
 * this file: a second mechanism beside the container query, answering the same question. The
 * alternative — a CSS-only `fixed inset-0` tray — would be a modal with no scrim, no `aria-modal`,
 * no focus trap and no Escape, which `src/CLAUDE.md` forbids outright.
 *
 * **The bar behind the scrim is the shipped one, and its own `Filters` button still opens the
 * shipped tray** — nothing here can rewire a press inside a component this file only mounts, which
 * is the same privacy the tray's own move runs into. Use it: close the sheet, press `Filters`, and
 * the 493px tray is the thing F2 replaces, in flow, at the width it would really be drawn at. The
 * `sheetOpen` control puts the alternative back.
 */
export const TrayAsSheet: Story = {
  args: { option: "sheet", sheetOpen: true },
};

/**
 * **F3 — a sticky one-line bar.**
 *
 * The search box and one `Filters` button ride the top of the wall as it scrolls; everything else
 * — the colours, the mana values, the sort, the layout pair, the stated filters and Reset all —
 * lives in F2's sheet. The strip is **44px**, so the wall gets **558px**: two full tile rows and
 * 22px over — `CardGrid`'s `GAP` is 12 — against one row and a sliver today.
 *
 * **It buys the most and spends the most.** What leaves the bar is not four controls, it is the
 * row's whole design: `FilterBar`'s four bands collapse to one, the `order` plus `basis-full`
 * arrangement has nothing left to arrange, and — the real loss — the stated-filter chips go with
 * it. Those are the app's one legible statement of what a search is currently narrowed by, drawn
 * precisely because a filter behind a shut disclosure has no control on screen. With them in the
 * sheet, a badge reading `4` is the whole of what a reader is told, and finding out which four
 * takes a press. Measured: that row is 151px with five kinds on, which is most of what this
 * option is buying.
 *
 * **The sticky mechanics are real work.** `position: sticky` sticks against the scroller's padding
 * box, so the strip needs `-mx-5 px-5` and `-mt-5 pt-5` or the wall scrolls through `main`'s 20px
 * gutters beside and above it, and it needs an opaque `bg-bg` and `LAYER.header` — the rung
 * `layers.ts` names for exactly this pairing.
 */
export const OneLineSticky: Story = {
  args: { option: "sticky" },
};
