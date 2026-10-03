import type { ReactNode } from "react";
import { ArrowUp } from "lucide-react";
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
  formatPickerRows,
  RARITIES,
  SEARCH_SORT_ROWS,
  sentence,
  sortDirectionName,
  useFormatOptions,
} from "@/features/search/filterOptions";
import { countOf } from "@/features/search/resultCount";
import { SetCombobox } from "@/features/search/SetCombobox";
import { CARD_TYPES, type CardSearch } from "@/features/search/useCardSearch";
import { BORDERS, BORDER_LABEL } from "@/lib/border";
import { FINISHES, FINISH_LABEL } from "@/lib/finish";
import type { SearchSortKey } from "@/lib/ipc";
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
function SortDirection({ search }: { search: CardSearch }) {
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
export function FiltersSheet({
  open,
  search,
  onDismiss,
  onClose,
}: {
  open: boolean;
  search: CardSearch;
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
      <SheetBody search={search} onDone={onDismiss} />
    </Dialog>
  );
}

/**
 * The sheet's contents — a separate component so the hooks below run only while it is open:
 * `Dialog` mounts nothing while shut.
 */
function SheetBody({ search, onDone }: { search: CardSearch; onDone: () => void }) {
  const { facets, query } = search;
  const formatRows = formatPickerRows(search, useFormatOptions(search));
  const sortRows = SEARCH_SORT_ROWS;
  const currency = search.marketplace.currency;
  // The figure the footer button carries. `undefined` until the first page has answered, which
  // says nothing about how many cards there are.
  const counted =
    query.data === undefined ? undefined : countOf(search.total, search.totalIsCapped);
  const showLabel =
    counted === undefined
      ? "Show cards"
      : search.total === 0
        ? "No cards match"
        : `Show ${counted}`;

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
                onChange={(key) => search.setSortKey(key as SearchSortKey | "")}
                options={sortRows}
                fill
                className="min-w-0"
              />
              <SortDirection search={search} />
            </div>
          </Section>

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

          <Section caption="Type">
            {/* Two columns: `Planeswalker` is wider than a third of a phone's sheet. */}
            <div role="group" aria-label="Type" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {CARD_TYPES.map((t) => (
                <ToggleChip
                  key={t}
                  label={t}
                  pressed={search.types.includes(t)}
                  disabled={optionDisabled(facets?.types, t, search.types.includes(t))}
                  title={facetTitle(t, facets?.types?.[t])}
                  onClick={() => search.toggleType(t)}
                />
              ))}
            </div>
          </Section>

          <Section caption="Border">
            <div role="group" aria-label="Border" className="grid grid-cols-3 gap-1.5">
              {BORDERS.map((b) => {
                const pressed = search.borders.includes(b);
                return (
                  <ToggleChip
                    key={b}
                    label={BORDER_LABEL[b]}
                    pressed={pressed}
                    disabled={optionDisabled(facets?.borders, b, pressed)}
                    title={facetTitle(BORDER_LABEL[b], facets?.borders?.[b])}
                    onClick={() => search.toggleBorder(b)}
                  />
                );
              })}
            </div>
          </Section>

          <Section caption="Finish">
            {/* Whether the printing was *published* in a finish — the card search's question, a
                printing in two finishes answering both. */}
            <div role="group" aria-label="Finish" className="grid grid-cols-3 gap-1.5">
              {FINISHES.map((f) => {
                const pressed = search.finishes.includes(f);
                return (
                  <ToggleChip
                    key={f}
                    label={FINISH_LABEL[f]}
                    pressed={pressed}
                    disabled={optionDisabled(facets?.finishes, f, pressed)}
                    title={facetTitle(FINISH_LABEL[f], facets?.finishes?.[f])}
                    onClick={() => search.toggleFinish(f)}
                  />
                );
              })}
            </div>
          </Section>

          <Section caption="Owned">
            {/* Pressing the answer already on turns it off, so off → Owned → Missing is still one
                press each, and neither answer hides behind the other. */}
            <div className="grid grid-cols-2 gap-1.5">
              <ToggleChip
                label="Owned"
                pressed={search.owned === true}
                title={facetTitle("Owned", facets?.owned.owned)}
                onClick={() => search.setOwned(search.owned === true ? undefined : true)}
              />
              <ToggleChip
                label="Missing"
                pressed={search.owned === false}
                title={facetTitle("Missing", facets?.owned.missing)}
                onClick={() => search.setOwned(search.owned === false ? undefined : false)}
              />
            </div>
          </Section>

          <Section caption="Set">
            <SetCombobox
              selected={search.sets}
              onToggle={search.toggleSet}
              counts={facets?.sets}
              align="start"
              fill
            />
          </Section>

          {/* The marketplace's currency in the caption, never a bare `$`: a band in euros and a
              band in dollars are two different filters, and this is the only place that says
              which one is on. */}
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

          <Section caption="Printings">
            {/* A view mode rather than a filter: neither counted on the badge nor cleared by
                Reset all. One label, never flipped — `aria-pressed` carries the state. */}
            <ToggleChip
              label="All printings"
              pressed={search.allPrintings}
              onClick={search.toggleAllPrintings}
            />
          </Section>
        </div>
      </div>

      <footer
        className={cn(
          "flex shrink-0 items-center gap-3 border-t border-border bg-surface px-4 pt-3",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
          TOUCH_FLOOR,
        )}
      >
        <ResetAll count={search.activeCount} onReset={search.resetAll} />
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
