import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ArrowUpToLine, ChevronDown, RotateCcw, Search } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { DockedPanel, holdsBar } from "@/components/DockedBar";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  ColorExactChip,
  FILTER_CONTROL,
  FILTER_FOCUS,
  FILTER_UNAVAILABLE,
  filterChipState,
  FiltersButton,
  ManaChip,
  ManaValueChips,
} from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DOCKED_SHADOW } from "@/lib/dockedBar";
import { LAYER } from "@/lib/layers";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import { nearestScroller } from "@/lib/useDockHeight";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import {
  FilterTray,
  SEARCH_LABELS,
  SEARCH_SORT_ROWS,
  SEARCH_TRAY,
  sortDirectionName,
  useFormatOptions,
  type FilterLabels,
  type FilterSurface,
  type TrayCell,
} from "./FilterBar";

export interface FilterQuickBarProps<SortKey extends string> {
  /** The page's own search — the very object its `FilterBar` draws, so the two are one state. */
  search: FilterSurface<SortKey>;
  /** From `useFilterQuickBar` — the page row has scrolled away in grid view. */
  shown: boolean;
  /** The page row's `labels`. Default {@link SEARCH_LABELS}; the bar derives its own id stem. */
  labels?: FilterLabels;
  /** The page row's sort rows. Default {@link SEARCH_SORT_ROWS}. */
  sortRows?: readonly { value: SortKey; label: string; disabled?: boolean }[];
  /** The page row's tray cells. Default {@link SEARCH_TRAY}. */
  tray?: readonly TrayCell[];
  /** A page's own control, drawn after Top with a divider — Tags' picked tags. */
  lead?: ReactNode;
  /** The rung from which the mana values are drawn inline rather than folded. */
  manaValuesFrom?: "wide" | "widest";
  /** The wrapper's negative bottom margin, cancelling the section's `gap`. */
  className?: string;
}

/** A bar press: the row's 36px control in the deck bar's `text-xs`, on the bar's own fill. */
const PRESS =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-border bg-surface px-2.5 text-xs";
/** The round chips at 32px, their pressed ring offset on the bar's `surface` rather than `bg`. */
const CHIP_SM = "size-8 text-base ring-offset-surface";
/** `FiltersButton`'s and `ResetAll`'s count badge, character for character. */
const BADGE = "rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground";
/**
 * Literal strings, because Tailwind reads source text: one pair per `manaValuesFrom`. An
 * interpolated `@min-[${px}px]/qb:flex` would emit no rule at all, and both halves would draw at
 * every width — two mana-value groups on one bar.
 */
const MV_INLINE = {
  wide: "hidden @min-[1100px]/qb:flex",
  widest: "hidden @min-[1500px]/qb:flex",
} as const;
const MV_FOLDED = { wide: "@min-[1100px]/qb:hidden", widest: "@min-[1500px]/qb:hidden" } as const;

/** A hairline between two groups of the bar. `aria-hidden`: a line is not a control. */
function Divider(): ReactElement {
  return <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />;
}

/**
 * A card wall's filter row, folded into one line and docked across the top of `AppShell`'s `main`
 * while the row itself has scrolled away (spec 2026-09-29) — on card search, the collection, the
 * wishlist and Tags, in grid view only.
 *
 * **It stands in for the page's `FilterBar` rather than being a second filter.** It takes the
 * same `search`, `labels`, `sortRows` and `tray` its page hands the row, so every control here is
 * a second entrance to one of the row's, on the same state and the same setters: a chip pressed
 * here is pressed there, and the bar can never offer a filter the row does not. What it carries is
 * what a reader reaches for *while working down a wall* — Top, the text, the colours, the mana
 * values, the tray, the sort and Reset all — and none of the row's readouts: the "Filtering by"
 * line and `TagQueryRow` are read at the top. It is the deck editor's undocked bar
 * (`DeckHeaderBar`) drawn for the filter row: the same 53px `DockedPanel`, the same shadow, the
 * same slide-down, the same Top and the same caret hold — `components/DockedBar` is where both
 * bars take those from, so they cannot drift.
 *
 * ## One row at every width, four rungs
 *
 * The group is its own container (`@container/qb`), and a rung is its **content box** width —
 * `main`'s content width, since `DockedPanel`'s inline padding restores `main`'s 20px:
 *
 * | Rung | Width | What changes |
 * | --- | --- | --- |
 * | widest | ≥ 1500 | `Top`, `Filters` and `Reset all` carry their words; search caps at 360 |
 * | wide | 1100 – 1499 | words go (icons, with names and tooltips); mana values inline |
 * | normal | 860 – 1099 | mana values fold into the `Mana value` press |
 * | tight | < 860 | sort leaves the bar |
 *
 * `manaValuesFrom="widest"` moves the fold one rung up, for Tags, whose picked tags take ~250px of
 * the row. **The names never move with the width**: a word is hidden by a class and the control's
 * `aria-label` carries it at every rung, so nothing a test or a screen reader addresses changes as
 * the window grows.
 *
 * **A container query rather than `DeckHeaderBar`'s measured rung, and that is not a taste.** The
 * deck bar is handed its rung by `DeckEditor`, which already measures `deskWidth` for the search
 * panel's floor, so the width was free. None of the four pages measures anything this bar could
 * borrow, and a `ResizeObserver` in here would be a second measurement of `main` answering a frame
 * behind the layout it is reacting to — where the container query is the browser's own answer
 * about the box the bar is actually in. The cost is the usual one: **jsdom applies no container
 * query and loads no stylesheet**, so every test sees every rung's controls at once (both mana
 * groups, the sort, every word) and the rungs are a live-window claim. And a container is the
 * containing block for `fixed` descendants (`packages/ui/CLAUDE.md`), which this bar has to live with
 * rather than avoid: the tray hangs `absolute` from the group, but the sort `Dropdown` and every
 * popup inside the tray **do** draw in a `fixed` frame. They land right anyway because
 * `usePopupPlacement` measures that zero-size frame and subtracts whatever containing block it
 * landed in, so a container above one moves nothing. What a container must never do is sit on
 * or inside a *scroller* between a popup and the bar — overflow clips a descendant whose
 * containing block is inside it — which is why the tray's own `@container/fb` is on the box
 * around its scroller and never on the scroller (see the tray below). Nothing here portals.
 */
export function FilterQuickBar<SortKey extends string>({
  search,
  shown,
  labels = SEARCH_LABELS,
  sortRows = SEARCH_SORT_ROWS as readonly { value: SortKey; label: string }[],
  tray = SEARCH_TRAY,
  lead,
  manaValuesFrom = "wide",
  className,
}: FilterQuickBarProps<SortKey>): ReactElement {
  const tip = useTooltip();
  /**
   * The caret is inside the bar **and is the kind that holds it up** — in the search field, or on
   * any control the keyboard brought it to. See {@link holdsBar}: a clicked button does not hold,
   * because a mouse press focuses a button as a side effect.
   */
  const [caretHolds, setCaretHolds] = useState(false);
  /** The bar's own tray — **independent of the page row's**, which keeps its own open state. */
  const [trayOpen, setTrayOpen] = useState(false);
  /**
   * The group element, in **state** through a callback ref rather than a ref object, because the
   * outside-press effect names it as a dependency and a `ref.current` in a dependency array is
   * read during render — `DeckHeaderBar`'s arrangement for the same lint rule.
   */
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const trayId = useId();
  /**
   * **Mounted only while shown, and held while the caret is in it.** `shown` alone would unmount
   * the bar the instant the page row scrolled back with the caret still in the bar's search field
   * — and a focused element that leaves the DOM drops the caret on `<body>`, one Tab from the top
   * of the window, mid-word. So the bar also stays while {@link caretHolds}, and goes once the
   * caret leaves. Typing is the case that matters: a changed search resets the wall to its top,
   * which brings the page row back into view and would otherwise take the field away under the
   * next keystroke.
   */
  const mounted = shown || caretHolds;
  // Put down during render, never in an effect: a tray left "open" behind an unmounted bar would
  // come back open on the next undock, over a wall the reader has since scrolled.
  if (!mounted && trayOpen) setTrayOpen(false);

  const facets = search.facets;
  const formatOptions = useFormatOptions(search);
  // The bar's own id stem, so its tray and sort never share an `id` with the page row's. A
  // `<label for>` binds to the *first* element with its id, so a shared stem would name the row's
  // controls twice and leave the bar's unnamed — both rows are in the DOM while the bar is down.
  const qbLabels: FilterLabels = { ...labels, idStem: `${labels.idStem}-qb` };
  const sortDir = search.sortDir;
  const count = search.activeCount;
  const sortOptions: readonly DropdownOption[] = sortRows.map((s) => ({
    value: s.value,
    label: s.label,
    disabled: s.disabled,
  }));
  // What the folded press says is picked: ascending, `8+` for the open-ended chip, `X` last —
  // the order the chips themselves are drawn in, whatever order the reader pressed them.
  const picked = [...search.manaValues]
    .sort((a, b) => a - b)
    .map((v) => (v >= 8 ? "8+" : String(v)));
  if (search.manaX) picked.push("X");
  const mvSummary = picked.join(", ");
  // `ResetAll`'s own sentence, so the bar's and the row's Reset all answer to one name.
  const resetName = `Reset all — ${count} filter${count === 1 ? "" : "s"} active`;

  /**
   * **A pointer press outside the bar closes its tray**, and the listener is in the **capture**
   * phase on `document` so a control that stops propagation cannot keep the tray open under a
   * press the reader aimed elsewhere. "Outside the bar" is outside the group, which the tray is
   * inside of — and it can be, because **nothing in the tray portals** (checked 2026-09-29: no
   * `createPortal` in `SetCombobox`, `Dropdown` or `PriceRange`, which all anchor inside their own
   * roots; the tooltip panel is root-mounted but takes no pointer), so a press on
   * an open set picker's row is a press inside the group. A portalled popup added to the tray later
   * would close the tray on its own rows, and this is the line to revisit then.
   *
   * Registered only while the tray is open, so a quiet bar costs the document nothing. The caret is
   * deliberately **not** handed back on this path — an outside press means the reader has gone
   * somewhere else, which is the app's rule for an outside click (`packages/ui/CLAUDE.md`).
   */
  useEffect(() => {
    if (!trayOpen || group === null) return;
    const onDown = (e: PointerEvent) => {
      if (!group.contains(e.target as Node)) setTrayOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [trayOpen, group]);

  /**
   * **Top: the page scrolls to 0 and the caret goes to the page row's own search field.**
   *
   * The one press that lets go of the bar outright, whatever holds it — bringing the row back is
   * its whole job, and a caret the keyboard left on it would keep the bar pinned over the very row
   * it just revealed. The scroller is found rather than assumed (`nearestScroller`, which is `main`
   * on every page this draws on), and the scroll is smooth unless the reader asked for reduced
   * motion — a jump of a whole wall is what the preference exists to refuse. `scrollTop = 0` is
   * the fallback for a scroller with no `scrollTo`, which is jsdom's elements and nothing shipped.
   *
   * The caret lands on `#${labels.idStem}-text` — the **row's** field, never the bar's — with
   * `preventScroll`, because the smooth scroll is already taking the page there and a focus scroll
   * would snap it the rest of the way at once. A caret left on the bar's own Top would leave with
   * the bar, on `<body>`.
   */
  const backToTop = () => {
    setCaretHolds(false);
    const scroller = group ? nearestScroller(group) : null;
    if (scroller) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      } else {
        scroller.scrollTop = 0;
      }
    }
    document.getElementById(`${labels.idStem}-text`)?.focus({ preventScroll: true });
  };

  // Built once and drawn in one of two places — inline from the `manaValuesFrom` rung up, inside
  // the folded press below it — with the row's own facet greying and sentences.
  const manaValues = (
    <ManaValueChips
      chipClass="size-8"
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
  );

  return (
    <AnimatePresence>
      {mounted && (
        <div
          key="filter-quick-bar"
          className={cn(
            // Zero height, with the section's `gap` cancelled by the caller's negative margin, so
            // appearing costs the wall no layout — `DeckHeaderBar`'s box, argued there. `sticky`
            // rather than `fixed`, so the bar is the section's width with nothing measured.
            // `LAYER.quickBar` because the tray hangs over the collection's and wishlist's docked
            // search column, which is `LAYER.popup` and later in the DOM.
            "sticky top-0 left-0 h-0",
            LAYER.quickBar,
            className,
          )}
        >
          <DockedPanel>
            {/* `role="group"` and not `role="toolbar"`, `DeckHeaderBar`'s ruling: a toolbar
                promises one tab stop and arrow keys between its controls, and a search field's
                arrows move a caret. */}
            <div
              ref={setGroup}
              role="group"
              aria-label="Filter quick bar"
              // React's `focusin`/`focusout`, which bubble — decided afresh on every move, so a
              // caret walking from the field to a clicked button stops holding at that step.
              onFocus={(e) => setCaretHolds(holdsBar(e.target))}
              onBlur={(e) => {
                // Moving between two of the bar's own controls is not leaving it.
                if (e.currentTarget.contains(e.relatedTarget)) return;
                // Nor is the window losing focus (Alt+Tab): the caret comes back with the window.
                if (e.relatedTarget === null && !document.hasFocus()) return;
                setCaretHolds(false);
              }}
              // **Escape closes the bar's tray and hands the caret to Filters — bubbling on
              // purpose.** An open set picker or dropdown inside the tray is a capture-phase
              // `"inner"` layer: it closes first and consumes the key, so this handler sees
              // `defaultPrevented` and leaves the tray open. One press per layer, the app's
              // ladder. With the tray shut the press is not this bar's at all, and falls through
              // to whatever the page does with it.
              onKeyDown={(e) => {
                if (e.key !== "Escape" || !trayOpen || e.defaultPrevented) return;
                e.preventDefault();
                setTrayOpen(false);
                group?.querySelector<HTMLButtonElement>(`[aria-controls="${trayId}"]`)?.focus();
              }}
              className="@container/qb relative flex h-full items-center gap-2"
            >
              <button
                type="button"
                aria-label="Back to the top"
                {...tip("Back to the top", { describes: false })}
                onClick={backToTop}
                className={cn(
                  FILTER_CONTROL,
                  FILTER_FOCUS,
                  PRESS,
                  "w-9 px-0 text-dim hover:text-text @min-[1500px]/qb:w-auto @min-[1500px]/qb:px-2.5",
                )}
              >
                <ArrowUpToLine aria-hidden="true" className="size-4 shrink-0" />
                <span className="hidden @min-[1500px]/qb:inline">Top</span>
              </button>

              {lead && (
                <>
                  {lead}
                  <Divider />
                </>
              )}

              {/* The one control that gives up width, capped so its text never sits alone in the
                  middle of a wide window. Bound to the page's `text` — the bar has no draft. */}
              <div className="relative flex max-w-70 min-w-30 flex-1 basis-50 items-center @min-[1500px]/qb:max-w-90">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-dim"
                />
                <input
                  type="search"
                  aria-label={labels.search}
                  placeholder={`${labels.search}…`}
                  value={search.text}
                  onChange={(e) => search.setText(e.target.value)}
                  // A box with text owns one Escape and an empty one owns none — the row's rule.
                  onKeyDown={(e) => clearFieldOnEscape(e, search.text, () => search.setText(""))}
                  className={cn(
                    "h-9 w-full min-w-0 rounded-md border border-border bg-bg pr-2.5 pl-8 text-xs placeholder:text-dim",
                    FILTER_FOCUS,
                  )}
                />
              </div>

              <Divider />

              <div
                role="group"
                aria-label="Color identity"
                className="flex shrink-0 items-center gap-1.5 px-0.5"
              >
                {MANA_KEYS.map((key) => (
                  <ManaChip
                    key={key}
                    symbol={key}
                    className={CHIP_SM}
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
                <ColorExactChip
                  className={CHIP_SM}
                  pressed={search.colorsStrict}
                  onClick={search.toggleColorsStrict}
                />
              </div>

              <Divider />

              <div className={cn("shrink-0 items-center", MV_INLINE[manaValuesFrom])}>
                {manaValues}
              </div>
              <div className={cn("shrink-0", MV_FOLDED[manaValuesFrom])}>
                <AnchoredPopup
                  label={`Mana value — ${mvSummary || "any"}`}
                  panelLabel="Mana value"
                  align="start"
                  triggerContent={
                    <>
                      <span>Mana value</span>
                      {/* Capped at 64px: every chip picked is a list of nearly thirty characters,
                          and on a bar that must stay one row an unbounded summary takes its width
                          from the search field. The trigger's `aria-label` keeps the whole list. */}
                      {mvSummary && (
                        <span className="max-w-16 truncate font-mono tabular-nums">
                          {mvSummary}
                        </span>
                      )}
                      <ChevronDown aria-hidden="true" className="size-3.5" />
                    </>
                  }
                  triggerClassName={cn(
                    FILTER_CONTROL,
                    PRESS,
                    "bg-transparent pr-2",
                    filterChipState(picked.length > 0),
                  )}
                  panelClassName="p-2.5"
                >
                  {manaValues}
                </AnchoredPopup>
              </div>

              <span aria-hidden="true" className="min-w-2 flex-1" />

              <FiltersButton
                open={trayOpen}
                count={count}
                onToggle={() => setTrayOpen((open) => !open)}
                controls={trayId}
                labelClass="hidden @min-[1500px]/qb:inline"
                className="text-xs"
              />

              {/* The row's sort, drawn exactly as the row draws it, and gone below 860 — sort is
                  the one control a reader deep in a wall is least likely to want mid-scroll. */}
              <div className="hidden shrink-0 items-center gap-2 @min-[860px]/qb:flex">
                <Divider />
                <label
                  id={`${qbLabels.idStem}-sort-label`}
                  htmlFor={`${qbLabels.idStem}-sort`}
                  className="sr-only"
                >
                  Sort results
                </label>
                <div className="flex items-center gap-1">
                  <Dropdown
                    id={`${qbLabels.idStem}-sort`}
                    labelledBy={`${qbLabels.idStem}-sort-label`}
                    value={search.sortSelection}
                    onChange={(key) => search.setSortKey(key as SortKey)}
                    options={sortOptions}
                  />
                  {/* Wrapped for the row's reason: a `disabled` button fires no pointer events,
                      so a tooltip bound to it would be inert in exactly the state it explains. */}
                  <span {...tip(sortDirectionName(sortDir), { describes: false })}>
                    <button
                      type="button"
                      onClick={search.flipSortDir}
                      disabled={!sortDir}
                      aria-label={sortDirectionName(sortDir)}
                      className={cn(
                        FILTER_CONTROL,
                        FILTER_FOCUS,
                        "flex size-9 items-center justify-center",
                        filterChipState(false, !sortDir),
                      )}
                    >
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
                  </span>
                </div>
              </div>

              <Divider />
              {/* `ResetAll`'s rule and name, drawn here rather than imported because the bar's
                  version gives up its word below the widest rung. The guard is on the press, not
                  the attribute: `aria-disabled` keeps it in the tab order. */}
              <button
                type="button"
                onClick={() => {
                  if (count > 0) search.resetAll();
                }}
                aria-disabled={count <= 0 || undefined}
                aria-label={resetName}
                {...tip(resetName, { describes: false })}
                className={cn(
                  FILTER_CONTROL,
                  FILTER_FOCUS,
                  PRESS,
                  "min-w-9 gap-2 px-2 text-dim @min-[1500px]/qb:px-2.5",
                  count <= 0 ? FILTER_UNAVAILABLE : "hover:text-text",
                )}
              >
                <RotateCcw aria-hidden="true" className="size-4 shrink-0 @min-[1500px]/qb:hidden" />
                <span className="hidden @min-[1500px]/qb:inline">Reset all</span>
                {count > 0 && (
                  <span aria-hidden="true" className={BADGE}>
                    {count}
                  </span>
                )}
              </button>

              {trayOpen && (
                /* **The page's own `FilterTray`, same cells, hung under the bar — in two boxes,
                   and which box carries what is the whole of this.**

                   The **outer** box is `@container/fb`, because the tray's grid asks that
                   container for its columns (`@min-[640px]/fb:grid-cols-2`, `@min-[900px]/fb:…`)
                   and a query naming a container no ancestor is resolves to nothing: without it
                   the bar's tray drew one column at every width. It is `absolute inset-x-0
                   top-full` against the group, so it is the group's width — the panel's inline
                   padding already restores `main`'s 20px, which is the spec's inset — and it
                   wears the bar's shadow so the tray reads as the bar's extension. `mt-[17px]`
                   lands it exactly 8px under the bar's outer edge, like every other neighbour of
                   the bar: the group's foot is the panel's 8px of `py-2` above the panel's
                   bottom, the panel's 53px is border-box with its 1px `border-b` inside that, so
                   8 + 1 + 8 is 17 from the group's foot.

                   The **inner** box is the scroller — `overflow-y-auto` past `100vh − 12rem` —
                   and **the container must never move onto it or inside it.** A container is the
                   containing block for `fixed` descendants (`packages/ui/CLAUDE.md`), and every popup in
                   the tray (the format and sort `Dropdown`s, the set picker) draws in a `fixed`
                   frame; that frame lands right because `usePopupPlacement` measures it and
                   subtracts whatever containing block it landed in, but a containing block
                   *inside* the scroller would have the scroller clip every one of them. On the
                   outer box, which has no overflow, the popups escape the scroller.

                   Inside the group, so an outside press and Escape both treat it as part of the
                   bar. */
                <div
                  className={cn(
                    "@container/fb absolute inset-x-0 top-full mt-[17px] rounded-lg",
                    DOCKED_SHADOW,
                  )}
                >
                  <div className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-lg">
                    <FilterTray
                      id={trayId}
                      search={search}
                      cells={tray}
                      labels={qbLabels}
                      formatOptions={formatOptions}
                    />
                  </div>
                </div>
              )}
            </div>
          </DockedPanel>
        </div>
      )}
    </AnimatePresence>
  );
}
