import { useEffect, useState, type RefObject } from "react";
import { MIN_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";

/**
 * The `gap-4` between the list and the dock, in px — spelled here because the arithmetic below has
 * to subtract it and Tailwind's number is not readable from JavaScript.
 *
 * **It is still a claim about the caller's markup that this hook cannot measure, and it is a
 * *default* rather than an assumption since 2026-09-08.** Both of the desk rows this was extracted
 * from are `flex min-h-0 flex-1 gap-4`, so a caller that says nothing gets exactly the number they
 * were written against; a row with a different gap hands its own in through
 * {@link DeskOptions.gap}, the way {@link useDeskWidth}'s `floor` has always been handed in. The
 * old sentence — "change the class and this number together" — now applies only to the two rows
 * that pass no options: a *third* row's `gap-5` is its own argument and not an edit to this line.
 */
const DESK_GAP = 16;

/**
 * The two facts about a desk row that are the caller's rather than this hook's, both defaulted to
 * what the rows it was extracted from measure.
 *
 * **Defaulted rather than required, because the two existing callers must be behaviourally
 * untouched**: `CollectionPage` and `WishlistPage` pass no options at all and get the exact
 * arithmetic they got before this bag existed. A required bag would have been the same numbers
 * written out at two call sites, which is the duplication this module was extracted to end.
 *
 * Neither is measurable from here. The gap is a Tailwind class, which is a string in the source and
 * a computed style on an element this hook is given no handle to; the floor is a *policy* about the
 * narrowest a docked column may be drawn, which belongs to whatever draws it.
 */
export interface DeskOptions {
  /**
   * The desk row's own flex `gap`, in px. Default 16 (`gap-4`) — see {@link DESK_GAP}.
   *
   * Subtracted from the row before the column's share of it is worked out, so a wrong number here
   * is a column that overflows its row by the difference rather than anything that goes red.
   */
  gap?: number;
  /**
   * The narrowest the docked column may be drawn, in px. Default `MIN_PANEL_WIDTH_PX`.
   *
   * This is the number {@link DeskWidth.roomy} is decided against — *not* a clamp on
   * {@link DeskWidth.maxPanelWidth}, which is deliberately left free to answer smaller: a row that
   * can spare less than this is a row that cannot hold both, and saying so is the whole of what
   * `roomy` is for.
   *
   * A caller whose column has a different floor from a card search panel's says so here. A folder
   * tree is the case this was added for: its floor is a tree's own, not a wall of card tiles'.
   */
  min?: number;
}

/** What a desk row can tell a docked search column about the room it has. */
export interface DeskWidth {
  /** The widest the panel may be drawn or dragged, in px — `Infinity` while nothing is measured. */
  maxPanelWidth: number;
  /** Whether the row can hold the list and the column **beside** each other. */
  roomy: boolean;
  /** How wide to draw the panel **over** the list, in px, for a row that cannot. `undefined` is a
   *  row that can. */
  overWidth: number | undefined;
}

/**
 * Measure the row a list and a docked search column share, and answer the three numbers that
 * column is drawn by.
 *
 * **This is one block that was two.** `CollectionPage` and `WishlistPage` each carried a
 * byte-identical copy of the observer and the arithmetic — a resemblance is N independent
 * decisions that happen to agree today, and the two would have drifted at the first measurement
 * that reached only one of them.
 *
 * `desk` is the row being measured — the flex row holding the list and the dock. `floor` is the
 * width that row's *list* must keep, which is **the caller's number and deliberately not a
 * constant in here**: the collection's floor and the wishlist's are both 192 today because both
 * walls draw the same tiles, and the collection's table view has a min-content width near 520
 * where its grid's is ~192. A hook that assumed one number would have to be edited to let one page
 * answer differently from the other, which is the arrangement this extraction exists to end.
 *
 * **`DeckEditor` is not a caller and is not meant to become one.** Its `panelOverWidth` carries an
 * extra `selectedCardId === null` clause, its desk is mounted only once `deck_get` has answered —
 * so its effect names `[hasRow]` where this one can name nothing — and it measures a desk holding
 * a deck rather than a list. Three differences, none of them cosmetic.
 *
 * **The desk must be mounted on the first commit.** The effect below runs once, because a
 * `RefObject` notifies nobody and there is no state here to name as a dependency. Both callers
 * draw their desk row unconditionally, which is what makes that legal; a page that drew one only
 * after its data landed would measure `null` forever and never look again. That is the trap
 * `DeckEditor` needed `[hasRow]` for, and it is stated here rather than guarded against, because a
 * guard that runs on every render buys nothing for a caller that cannot hit it.
 *
 * **`options` is the third thing that is the caller's, and it arrived after the first two** — see
 * {@link DeskOptions}. It is optional and defaulted to the numbers the two extracted rows were
 * written against, so `useDeskWidth(desk, 192)` means today exactly what it meant before the bag
 * existed. It is read for its two numbers during render and never named as a dependency, so a
 * caller passing a fresh object literal every render costs nothing — the one effect below still
 * runs once.
 */
export function useDeskWidth(
  desk: RefObject<HTMLElement | null>,
  floor: number,
  options?: DeskOptions,
): DeskWidth {
  // Pulled out as numbers rather than read off `options` below, so nothing downstream can
  // accidentally hold the object: it is a literal at the call site and a different one every
  // render, and a number cannot be.
  const gap = options?.gap ?? DESK_GAP;
  const min = options?.min ?? MIN_PANEL_WIDTH_PX;
  /** How wide that row is. `0` is *unmeasured* — jsdom, and the first paint before the observer
   *  has answered — and is read below as "roomy", never as a row of no width. */
  const [deskWidth, setDeskWidth] = useState(0);
  /**
   * How wide the window is, for the half-of-it cap on the panel's drag.
   *
   * `document.documentElement.clientWidth` rather than `window.innerWidth`, which is this app's
   * rule wherever a viewport width is used for anything: `innerWidth` counts the classic vertical
   * scrollbar and the layout does not — 1280 against 1265, measured on the deck editor — and both
   * of these pages scroll inside `AppShell`'s `main`, so there is always one. The difference is
   * not academic: it caps the panel at 640 where the honest number is 632.
   */
  const [viewport, setViewport] = useState(0);
  // One observer answering both, `DeckEditor`'s arrangement and its reason: the desk row is
  // `flex-1` inside the page, so nothing can change the window's width without changing the
  // desk's, and a second listener would let the two numbers be a frame apart. `entry` is
  // deliberately not read, so the callback is the same whether the observer or the line below it
  // calls it.
  useEffect(() => {
    const el = desk.current;
    if (!el) return;
    const measure = () => {
      setViewport(document.documentElement.clientWidth);
      setDeskWidth(el.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
    // `desk` is a ref object and never changes identity, so this is the `[]` both pages wrote —
    // named rather than omitted because the rule cannot know that about a parameter.
  }, [desk]);

  /**
   * The widest the docked panel may be drawn or dragged — the smaller of two caps that bind at
   * different window sizes, and `Infinity` while neither has been measured.
   *
   * **Half the window**, because a search column that can take three quarters of the app has
   * stopped being a column; and **whatever the row can spare over `floor`**, because the list is
   * what the width is being taken from. Neither is redundant: at 1032 — the app's own narrow rung
   * — the floor allows 824 where half the window is 640, and at 1920 the floor would allow ~1700
   * and only the half-window cap holds the column to a column.
   */
  const maxPanelWidth = Math.min(
    viewport > 0 ? Math.floor(viewport / 2) : Number.POSITIVE_INFINITY,
    deskWidth > 0 ? deskWidth - gap - floor : Number.POSITIVE_INFINITY,
  );
  /**
   * Whether this row can hold the list and the column side by side.
   *
   * **`deskWidth === 0` reads as roomy**, which is what keeps jsdom and the first paint out of the
   * way: an unmeasured row is not a narrow one, and railing on the first frame would draw the
   * panel shut for one commit on every load.
   *
   * **The press is what is stored, never this.** A railing is a measurement about a narrow window
   * and not a thing the reader asked for, so it decides what is *drawn* and `useSearchOpen` goes
   * on holding what they chose — see `CardSearchPanel`'s own prop doc. A width change must not be
   * able to throw a typed query away.
   *
   * **The floor it is measured against is {@link DeskOptions.min}**, `MIN_PANEL_WIDTH_PX` unless
   * the caller says otherwise — a docked column's narrowest is a fact about what that column
   * draws, and a folder tree's is not a card wall's.
   */
  const roomy = deskWidth === 0 || maxPanelWidth >= min;
  /**
   * How wide to draw the panel **over** the list, for a row that cannot hold both — the door out
   * of the rail, and the whole row's width because that is what the panel gets when it takes it.
   *
   * `undefined` is a row that can. On a phone this is the difference between a sidebar that exists
   * and one that is only ever a greyed chevron.
   */
  const overWidth = deskWidth > 0 && !roomy ? deskWidth : undefined;

  return { maxPanelWidth, roomy, overWidth };
}
