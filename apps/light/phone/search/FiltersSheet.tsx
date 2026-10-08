import type { ReactNode, Ref } from "react";
import { ArrowUp, SlidersHorizontal } from "lucide-react";
import { motion } from "motion/react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  FILTER_LABEL,
  filterChipState,
  ManaChip,
  ManaValueChips,
  RarityChip,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { PriceRange } from "@/components/PriceRange";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "@/features/search/facets";
import {
  conditionChip,
  formatPickerRows,
  RARITIES,
  SEARCH_SORT_ROWS,
  SEARCH_TRAY,
  sentence,
  type TrayCell,
  sortDirectionName,
  useFormatOptions,
} from "@/features/search/filterOptions";
import { countOf } from "@/features/search/resultCount";
import { SetCombobox } from "@/features/search/SetCombobox";
import type { FilterSurface } from "@/features/search/FilterBar";
import { CARD_TYPES, cycleTriState } from "@/features/search/useCardSearch";
import { BORDERS, BORDER_LABEL } from "@/lib/border";
import { FINISHES, FINISH_LABEL } from "@/lib/finish";
import { CONDITIONS, CONDITION_NOT_SET } from "@/lib/conditions";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * **Every control in the sheet is a 44px touch target, whatever the pointer.** The shared chips
 * grow to 44 only under `coarse:` — a desktop row that grew for a finger would be 44px of chrome
 * over every list — but this face is the phone's at every pointer, the way its search box and tab
 * bar already are, so a narrowed browser with a mouse draws the sheet a phone draws.
 *
 * Set as a floor from the container rather than on each control, because three of them (the set
 * picker's trigger, the price boxes, a rarity chip) draw their own boxes and take no class for
 * one. `min-h` and never `h`, for `FILTER_SHAPE`'s reason: a minimum is not in the cascade contest
 * a second height would be, so it holds against every `h-9` it meets. The variant's selector
 * outranks a utility's, which is what makes it win rather than tie.
 *
 * **And every text box is 16px**, the search box's rule: below it, iOS and some Android browsers
 * zoom the page when the box takes focus — and the format and set pickers focus their own search
 * box the moment they open, so a 14px one zooms the sheet on a press that asked for nothing of
 * the kind. That reaches the price boxes too, which is the point: they are typed into as well.
 */
const TOUCH_FLOOR = "[&_button]:min-h-11 [&_input[type=text]]:min-h-11 [&_input]:text-base";

/** The badge `FiltersButton` and `ResetAll` draw, character for character. */
export const BADGE =
  "rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground";

/**
 * How many kinds of filter **the sheet** holds: the surface's `activeCount` without the box.
 *
 * **The box is not in the sheet on this face**, and that is the whole difference from the
 * desktop. There the search box, the Filters button and Reset all are one bar, so a count that
 * includes the typed query is a count of that bar (`FilterChips`' `FiltersButton` says so). Here
 * the box sits beside the button, outside the sheet, with its own words on screen — so a query
 * counted on the button lit it `Filters — 1 active` over a sheet with nothing chosen in it (the
 * first phone run, 2026-10-04).
 *
 * Subtracted rather than recounted, because `activeFilterCount` counts the text as exactly one
 * kind — `text.trim().length > 0` — on every surface that feeds it (the card search, the
 * collection, the wishlist), and a second list of the other kinds here would be a copy that
 * drifts the day a kind is added there.
 */
export function sheetFilterCount(
  search: Pick<FilterSurface<string>, "activeCount" | "text">,
): number {
  return Math.max(0, search.activeCount - (search.text.trim().length > 0 ? 1 : 0));
}

/**
 * The sheet's Reset all: every filter the sheet holds, **and not the box beside it**.
 *
 * Its caption is {@link sheetFilterCount}, and `ResetAll`'s number answers "how much would this
 * press change" — so a press that also emptied the box would change one thing more than it says,
 * and empty it out of sight behind a sheet that fills the window. The query is the reader's own
 * words in a control of its own, cleared there; putting the chips back is not starting over.
 * `resetAll` is the surface's, unforked: the text goes back in the same batch, so the box never
 * renders empty and no search is asked for the empty query in between.
 */
function resetSheet(search: Pick<FilterSurface<string>, "text" | "setText" | "resetAll">) {
  const text = search.text;
  search.resetAll();
  search.setText(text);
}

/**
 * The one `Filters` button a page's line carries, beside its box — Search's, the collection's and
 * the wishlist's, so the three draw one control. Its count is {@link sheetFilterCount}: what the
 * sheet it opens holds, never the box beside it.
 */
export function FiltersButton({
  ref,
  search,
  expanded,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  /** The surface whose sheet this opens — read for {@link sheetFilterCount} and nothing else. */
  search: Pick<FilterSurface<string>, "activeCount" | "text">;
  expanded: boolean;
  onClick: () => void;
}) {
  const active = sheetFilterCount(search);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      // A sheet, not a disclosure: the desktop bar's `FiltersButton` opens a tray in the page and
      // says so with `aria-controls`; a modal has neither a place in the page nor an id to point at.
      aria-haspopup="dialog"
      aria-expanded={expanded}
      // The count is in the name because the badge is hidden from a screen reader, and the
      // word on the button is in it too (WCAG 2.5.3).
      aria-label={active > 0 ? `Filters — ${active} active` : "Filters"}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "inline-flex h-11 shrink-0 items-center gap-2 px-3",
        // Gold while anything is on: the sheet is shut, so this is the one place a filter
        // the reader cannot see is said to be there.
        filterChipState(active > 0),
      )}
    >
      <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
      Filters
      {active > 0 && (
        <span aria-hidden="true" className={BADGE}>
          {active}
        </span>
      )}
    </button>
  );
}

/**
 * One captioned section of the sheet.
 *
 * **A heading rather than a `<label>`**, so a screen reader can walk the sheet by its twelve
 * captions — the one way through a long modal that is not twelve groups of Tab presses. The
 * controls name themselves: each chip group already carries its own `aria-label`, and the two
 * pickers here take a `label`.
 */
function Section({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className={FILTER_LABEL}>{caption}</h3>
      {children}
    </div>
  );
}

/**
 * The direction the results run in, as one arrow turned over.
 *
 * The desktop bar's button at the sheet's size, and for its reasons: one arrow rotated rather than
 * two swapped, so the press reads as the order reversing; `disabled` at `Best match`, which is a
 * ranking with no direction to reverse; and the name from `sortDirectionName`, because two buttons
 * on one flag must never announce it in two sentences. No tooltip — a finger has no hover, and
 * the accessible name already says everything a tooltip would.
 */
function SortDirection<SortKey extends string>({ search }: { search: FilterSurface<SortKey> }) {
  const dir = search.sortDir;
  return (
    <button
      type="button"
      onClick={search.flipSortDir}
      disabled={!dir}
      aria-label={sortDirectionName(dir)}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "flex size-11 shrink-0 items-center justify-center",
        filterChipState(false, !dir),
      )}
    >
      {/* `flex` on the span is load-bearing: a transform does not apply to a bare inline box. */}
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ rotate: dir === "desc" ? 180 : 0 }}
        transition={TRANSITION.fast}
        className="flex"
      >
        <ArrowUp className="size-4" />
      </motion.span>
    </button>
  );
}

/**
 * The search's filters, in a sheet over the wall — everything but the box.
 *
 * **The phone's version of the desktop's tray, over the same hook and the same words.** The state
 * is `useCardSearch`'s, so every press applies at once and the wall behind the scrim moves with
 * it; the rows, the format ladder, the facet greying and the direction's name are read from
 * `filterOptions.ts` and `facets.ts`, the modules `FilterBar` reads them from. What is the phone's
 * own is the arrangement: one column of captioned sections, in the order a reader narrows a
 * search — how it is ordered, which format, the card's colours and cost, what it is, how it is
 * printed, whether it is owned, then the rarer questions — with a footer that says how many
 * cards the search now holds.
 *
 * **It is not a place.** The URL names a view, a deck and a card (`routes.ts`); a sheet of
 * controls over a page is the page's own state, so opening it pushes nothing and Back is not how
 * it closes — Escape, the ✕, the scrim and `Show N cards` are. A card is a place because a reader
 * sends one to somebody; nobody sends a half-set filter.
 *
 * **Mounted by the page, inside the shell**, where `CardSheet` is a sibling of the shell. Both
 * are `Dialog`, whose scrim is `fixed inset-0`, so both depend on nothing between them and the
 * root becoming a containing block — no `transform`, `filter` or `contain` on the shell or its
 * `main`. This one cannot move out: it is open over one page, from that page's own state.
 *
 * **Below 640px it fills the window**, by `Dialog`'s own rule, and the panel is padded by the top
 * inset and the footer by the bottom one — a full-bleed sheet under `viewport-fit=cover` is drawn
 * under the status bar and the home indicator otherwise. From 640 to this face's 1023 it is a
 * centred panel.
 */
export function FiltersSheet<SortKey extends string>({
  open,
  search,
  tray = SEARCH_TRAY,
  sortRows,
  total,
  capped = false,
  onDismiss,
  onClose,
}: {
  open: boolean;
  /**
   * Any list's filters — the structural surface the desktop's `FilterBar` takes, so the card
   * search's hook, the collection's and the wishlist's all fit it.
   */
  search: FilterSurface<SortKey>;
  /**
   * Which of the optional cells the sheet draws — `FilterBar`'s own `tray` list, so a surface
   * offers the same filters on both faces. The sort, the colours and the mana values are always
   * drawn, as they are always on the desktop's bar; a cell named here whose setter the surface does
   * not wire draws nothing, the bar's rule. Defaults to the card search's.
   */
  tray?: readonly TrayCell[];
  /** The sort picker's rows. Defaults to the card search's. */
  sortRows?: readonly { value: SortKey | ""; label: string; disabled?: boolean }[];
  /** How many cards the list now holds, for the footer — `undefined` until it has answered. */
  total: number | undefined;
  /** Whether `total` is a floor (the search stops counting at 5 000). */
  capped?: boolean;
  /** Escape, the ✕ and `Show N cards`: hand the caret back to the opener, then close. */
  onDismiss: () => void;
  /** The scrim: close, and leave the caret where the press put it. */
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="Filters"
      closeLabel="Close filters"
      size="h-full w-[38rem] pt-[env(safe-area-inset-top)] sm:h-auto sm:pt-0"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <SheetBody
        search={search}
        tray={tray}
        sortRows={
          sortRows ?? (SEARCH_SORT_ROWS as readonly { value: SortKey | ""; label: string }[])
        }
        total={total}
        capped={capped}
        onDone={onDismiss}
      />
    </Dialog>
  );
}

/**
 * The sheet's contents — a separate component so the hooks below run only while it is open:
 * `Dialog` mounts nothing while shut.
 */
function SheetBody<SortKey extends string>({
  search,
  tray,
  sortRows,
  total,
  capped,
  onDone,
}: {
  search: FilterSurface<SortKey>;
  tray: readonly TrayCell[];
  sortRows: readonly { value: SortKey | ""; label: string; disabled?: boolean }[];
  total: number | undefined;
  capped: boolean;
  onDone: () => void;
}) {
  const { facets } = search;
  const formatRows = formatPickerRows(search, useFormatOptions(search));
  const currency = search.marketplace.currency;
  /** A cell is drawn where the surface names it **and** wires it — `FilterBar`'s two rules. */
  const offers = (cell: TrayCell) => tray.includes(cell);
  // The figure the footer button carries. `undefined` until the first page has answered, which
  // says nothing about how many cards there are.
  const counted = total === undefined ? undefined : countOf(total, capped);
  const showLabel =
    counted === undefined ? "Show cards" : total === 0 ? "No cards match" : `Show ${counted}`;

  return (
    <>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-6",
          TOUCH_FLOOR,
        )}
      >
        <div className="flex flex-col gap-5">
          <Section caption="Sort">
            <div className="flex min-w-0 items-center gap-2">
              <Dropdown
                // `Sort results`, never a bare `Sort`: the deck editor's toolbar sorts the deck,
                // and this name has to be unambiguous wherever the search is drawn.
                label="Sort results"
                value={search.sortSelection}
                onChange={(key) => search.setSortKey(key as SortKey)}
                options={sortRows}
                fill
                className="min-w-0"
              />
              <SortDirection search={search} />
            </div>
          </Section>

          {offers("format") && (
            <Section caption="Format">
              <Dropdown
                label="Format"
                value={search.format}
                onChange={search.setFormat}
                options={formatRows}
                fill
                searchable
                // Gold for anything but `Any format`, `Any card` included: the desktop tray's rule,
                // because the widening is as much a statement about the wall as a narrowing.
                active={search.format !== ""}
              />
            </Section>
          )}

          <Section caption="Color identity">
            {/* One line from 640, where the six and the pair fit beside each other; two below. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
              {/* Six across with the room shared between them, and the reading on a line of its own
                below. Seven round chips at 44px do not fit 328px with room for a pressed ring
                between them — the desktop's own 6px is what keeps two rings from welding. */}
              <div
                role="group"
                aria-label="Color identity"
                className="flex justify-between sm:justify-start sm:gap-3"
              >
                {MANA_KEYS.map((key) => (
                  <ManaChip
                    key={key}
                    symbol={key}
                    className="size-11 text-xl"
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
              {/* **Two words where the desktop has a glyph.** `ColorExactChip` says which reading
                the colours get with an icon and a tooltip, and a finger has no hover to reach the
                tooltip with — so the sheet spells both readings out, as a pair like Owned and
                Missing, and the one that is pressed is the one in force. Same flag, same
                toggle; pressing the reading already on does nothing, because one of the two is
                always true. */}
              <div
                role="group"
                aria-label="Color reading"
                className="grid grid-cols-2 gap-1.5 sm:flex-1"
              >
                <ToggleChip
                  label="Within"
                  hint="cards whose color identity fits within these colors"
                  pressed={!search.colorsStrict}
                  onClick={() => {
                    if (search.colorsStrict) search.toggleColorsStrict();
                  }}
                />
                <ToggleChip
                  label="Exactly"
                  hint="cards whose color identity is exactly these colors"
                  pressed={search.colorsStrict}
                  onClick={() => {
                    if (!search.colorsStrict) search.toggleColorsStrict();
                  }}
                />
              </div>
            </div>
          </Section>

          <Section caption="Mana value">
            <ManaValueChips
              // Five to a line at a phone's width and ten above 640: a flex basis of a fifth (a
              // tenth) less the gap, grown to take the rounding. A basis outranks the chip's own
              // width, so the squares become even keys rather than a ragged wrap of six and four.
              chipClass="h-11 grow basis-[calc(20%-0.25rem)] sm:basis-[calc(10%-0.25rem)]"
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
          </Section>

          {offers("rarity") && (
            <Section caption="Rarity">
              <div
                role="group"
                aria-label="Rarity"
                // Centred, as every other chip in the sheet is: `RarityChip` starts its gem at the
                // left edge, which is right in a row of chips sized to their words and ragged in a
                // grid of equal cells.
                className="grid grid-cols-2 gap-1.5 *:justify-center sm:grid-cols-4"
              >
                {RARITIES.map((rarity) => (
                  <RarityChip
                    key={rarity}
                    rarity={rarity}
                    pressed={search.rarities.includes(rarity)}
                    disabled={optionDisabled(
                      facets?.rarities,
                      rarity,
                      search.rarities.includes(rarity),
                    )}
                    title={facetTitle(sentence(rarity), facets?.rarities[rarity])}
                    onClick={() => search.toggleRarity(rarity)}
                  />
                ))}
              </div>
            </Section>
          )}

          {offers("type") && search.toggleType && (
            <Section caption="Type">
              {/* Two columns: `Planeswalker` is wider than a third of a phone's sheet. */}
              <div
                role="group"
                aria-label="Type"
                className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
              >
                {CARD_TYPES.map((t) => (
                  <ToggleChip
                    key={t}
                    label={t}
                    pressed={search.types?.includes(t) ?? false}
                    disabled={optionDisabled(facets?.types, t, search.types?.includes(t) ?? false)}
                    title={facetTitle(t, facets?.types?.[t])}
                    onClick={() => search.toggleType?.(t)}
                  />
                ))}
              </div>
            </Section>
          )}

          {offers("border") && search.toggleBorder && (
            <Section caption="Border">
              <div role="group" aria-label="Border" className="grid grid-cols-3 gap-1.5">
                {BORDERS.map((b) => {
                  const pressed = search.borders?.includes(b) ?? false;
                  return (
                    <ToggleChip
                      key={b}
                      label={BORDER_LABEL[b]}
                      pressed={pressed}
                      disabled={optionDisabled(facets?.borders, b, pressed)}
                      title={facetTitle(BORDER_LABEL[b], facets?.borders?.[b])}
                      onClick={() => search.toggleBorder?.(b)}
                    />
                  );
                })}
              </div>
            </Section>
          )}

          {offers("finish") && search.toggleFinish && (
            <Section caption="Finish">
              {/* Whether the printing was *published* in a finish — the card search's question, a
                printing in two finishes answering both — or, over a list of copies, which finish
                this copy *is*. One cell, the desktop's, and its two readings. */}
              <div role="group" aria-label="Finish" className="grid grid-cols-3 gap-1.5">
                {FINISHES.map((f) => {
                  const pressed = search.finishes?.includes(f) ?? false;
                  return (
                    <ToggleChip
                      key={f}
                      label={FINISH_LABEL[f]}
                      pressed={pressed}
                      disabled={optionDisabled(facets?.finishes, f, pressed)}
                      title={facetTitle(FINISH_LABEL[f], facets?.finishes?.[f])}
                      onClick={() => search.toggleFinish?.(f)}
                    />
                  );
                })}
              </div>
            </Section>
          )}

          {offers("condition") && search.toggleCondition && (
            <Section caption="Condition">
              {/* The grade of the copy — a collection's question alone. Three to a line, and
                  `Not set` the whole first one, the desktop tray's narrow arrangement and for its
                  reason: it is the one label with a space in it. */}
              <div role="group" aria-label="Condition" className="grid grid-cols-3 gap-1.5">
                {CONDITIONS.map((c) => {
                  const { label, hint } = conditionChip(c);
                  return (
                    <ToggleChip
                      key={c}
                      label={label}
                      hint={hint}
                      pressed={search.conditions?.includes(c) ?? false}
                      onClick={() => search.toggleCondition?.(c)}
                      className={cn(c === CONDITION_NOT_SET && "col-span-3 whitespace-nowrap")}
                    />
                  );
                })}
              </div>
            </Section>
          )}

          {offers("owned") && search.setOwned && (
            <Section caption="Owned">
              {/* Pressing the answer already on turns it off, so off → Owned → Missing is still one
                press each, and neither answer hides behind the other. */}
              <div className="grid grid-cols-2 gap-1.5">
                <ToggleChip
                  label="Owned"
                  pressed={search.owned === true}
                  title={facetTitle("Owned", facets?.owned.owned)}
                  onClick={() => search.setOwned?.(search.owned === true ? undefined : true)}
                />
                <ToggleChip
                  label="Missing"
                  pressed={search.owned === false}
                  title={facetTitle("Missing", facets?.owned.missing)}
                  onClick={() => search.setOwned?.(search.owned === false ? undefined : false)}
                />
              </div>
            </Section>
          )}

          {offers("set") && (
            <Section caption="Set">
              <SetCombobox
                selected={search.sets}
                onToggle={search.toggleSet}
                counts={facets?.sets}
                align="start"
                fill
              />
            </Section>
          )}

          {/* The marketplace's currency in the caption, never a bare `$`: a band in euros and a
              band in dollars are two different filters, and this is the only place that says
              which one is on. */}
          {offers("price") && search.setPriceRange && (
            <Section caption={`Price (${currency.toUpperCase()})`}>
              {/* The boxes a step wider than the bar's: at 16px a 64px box clips `12.50`. */}
              <div className="[&_input[type=text]]:w-20">
                <PriceRange
                  min={search.priceMin}
                  max={search.priceMax}
                  currency={currency}
                  onChange={search.setPriceRange}
                />
              </div>
            </Section>
          )}

          {offers("needsReview") && search.setNeedsReview && (
            <Section caption="Needs review">
              {/* Off → flagged → not flagged → off, and the word on the chip says which of the
                  three is on — the desktop tray's chip, word for word. */}
              <ToggleChip
                label={search.needsReview === false ? "Not flagged" : "Needs review"}
                pressed={search.needsReview !== undefined}
                onClick={() => search.setNeedsReview?.(cycleTriState(search.needsReview, true))}
              />
            </Section>
          )}

          {offers("printings") && search.toggleAllPrintings && (
            <Section caption="Printings">
              {/* A view mode rather than a filter: neither counted on the badge nor cleared by
                Reset all. One label, never flipped — `aria-pressed` carries the state. */}
              <ToggleChip
                label="All printings"
                pressed={search.allPrintings ?? false}
                onClick={search.toggleAllPrintings}
              />
            </Section>
          )}
        </div>
      </div>

      <footer
        className={cn(
          "flex shrink-0 items-center gap-3 border-t border-border bg-surface px-4 pt-3",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
          TOUCH_FLOOR,
        )}
      >
        <ResetAll count={sheetFilterCount(search)} onReset={() => resetSheet(search)} />
        <button
          type="button"
          onClick={onDone}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            // The app's primary: gold on the table, not a gold slab. The fill is what a press
            // shows, as it is what a hover shows on the desktop.
            "min-w-0 flex-1 truncate border-accent px-4 text-accent",
            "active:bg-accent active:text-accent-foreground",
          )}
        >
          {showLabel}
        </button>
        {/* The count as it moves, said politely: a reader pressing chips by touch with a screen
            reader on hears the wall narrow without having to find the button again. */}
        <span role="status" className="sr-only">
          {counted}
        </span>
      </footer>
    </>
  );
}
