/**
 * **The caret a page hands back to a shelf heading** — one type for both cabinets
 * (`CollectionShelfParts`' `CollectionShelfHeading` and the wishlist's `WishShelfHeading`), after
 * Add folder in that heading (`"add"`) or after a Move up / Move down of it (`"manage"`, its `⋯`).
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
