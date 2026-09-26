import { useLayoutEffect, type RefObject } from "react";

/**
 * **The caret a page hands back to a shelf heading** — one type for both cabinets
 * (`CollectionShelfParts`' `CollectionShelfHeading` and the wishlist's `WishShelfHeading`), after
 * Add folder in that heading (`"add"`) or after a Move up / Move down of it (`"manage"`, its `⋯`).
 * The page side is `useHeadingCaret`; this is the heading side.
 *
 * The page cannot focus the control itself: the heading may not be drawn when the request is made
 * (the wall virtualises), and the element it remembered is often a detached one. So the heading
 * takes the caret the moment it is drawn with the request on it — **only while nothing else has
 * it** (`<body>`, or still `from`), and **once per request** (`claim`, which also spends it).
 *
 * One declaration rather than one per page, so the two pages cannot drift into two contracts that
 * happen to agree today.
 */
export interface HeadingCaret {
  /** One request, one caret: `claim(id)` answers `true` exactly once per id. */
  id: number;
  control: "add" | "manage";
  /** The element the reader pressed. Still holding the caret means nothing has moved it since, so
   *  it may be taken from — a heading that stayed mounted keeps its element, and taking the caret
   *  back is focusing the same control. (The table's bands are keyed by shelf, so a pressed `⋯`
   *  there goes with its folder rather than staying behind to draw another one.) */
  from: HTMLElement | null;
  /** `true` exactly once per id — and the page's answer **spends** the request, so the heading is
   *  not revealed again once it has the caret. */
  claim: (id: number) => boolean;
}

/**
 * How each control is found inside `ShelfHeading`'s row: the `⋯` by what it declares
 * (`aria-haspopup`, the one menu trigger on a heading) and Add folder by the first word of its name,
 * `Add folder in <folder>` — the two ways the page suites find them, so a renamed control breaks
 * both together.
 */
export const HEADING_CARET_CONTROL: Record<HeadingCaret["control"], string> = {
  add: 'button[aria-label^="Add folder"]',
  manage: 'button[aria-haspopup="menu"]',
};

/**
 * **A heading takes the caret when it is drawn with a request on it** — the one effect both heading
 * components call, with the heading's own row (the element `ShelfHeading` hands its drop ref, which
 * carries `data-shelf-heading`).
 *
 * - **Only while nothing else has it**: the caret is on `<body>`, where a detached opener or a
 *   closed field leaves it, or still on the element the reader pressed (`from`).
 * - **Only once per request**, so a heading scrolled back into view later never pulls the caret off
 *   whatever the reader has moved on to.
 * - **Found through the row, never through `document`**: a lookup across the page answers with
 *   whichever heading's control comes first, and during a reorder two rows can briefly stand for
 *   one folder.
 * - **A layout effect**, so the caret is placed in the commit that draws the heading rather than a
 *   frame after it. A control not drawn (a field is open over the heading) is not a claim: the
 *   request waits for it.
 *
 * ⚠️ **`claim` sets the page's state from this effect, and that is a deliberate exception** to the
 * house rule against a `setState` in an effect. The rule is about *derived* state synced after the
 * fact; this is an **event** — the heading reached the screen and the caret was handed over — and
 * the page cannot see it happen, because only this commit knows the control is drawn. It is guarded
 * and loop-free: `claim` answers `true` once per id (the page's ref, which also stops StrictMode's
 * second run from taking twice), the state it clears is the request itself, and the render that
 * follows hands this heading no `caret`, so the effect has nothing left to do.
 */
export function useTakeHeadingCaret(
  caret: HeadingCaret | undefined,
  row: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (caret === undefined) return;
    const control = row.current?.querySelector<HTMLElement>(HEADING_CARET_CONTROL[caret.control]);
    if (control == null || !caret.claim(caret.id)) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active === caret.from) control.focus();
  }, [caret, row]);
}
