/**
 * **The fold anchor's carry** (spec §3.9) — the one piece of module state a folder-heading drag
 * keeps while the wall folds and unfolds around it, and the names a sectioned wall and
 * `useFoldAnchor` share to find a heading row. `useFoldAnchor` is the page's half and drives
 * {@link shelfCarry}; `CardGrid` is the wall's half, attaches to it, and answers each
 * {@link ShelfAnchorRequest} from its own layout.
 *
 * Moved out of `CardGrid.tsx` as it stood (final review S-M3), so the shelves feature no longer
 * reaches into the search wall for its own drag state. The argument for keeping the geometry on
 * the wall's side is on {@link CarryState}.
 */
import type { ShelfLayout } from "@/lib/shelfLayout";

/**
 * The attribute every sectioned row carries naming its shelf — a heading's, a run of tiles', an
 * empty box's (a label has none). `useFoldAnchor` finds the heading a press landed in by it, and a
 * drop's landing place is read off it.
 */
export const SHELF_ID_ATTR = "data-shelf-id";

/** A heading row of a sectioned wall — the element a folder drag is picked up from. */
export const SHELF_HEADING_ROW = `[data-shelf-row="heading"][${SHELF_ID_ATTR}]`;

/** What the fold anchor asks a sectioned wall: put one shelf's heading row's top at a point. */
export interface ShelfAnchorRequest {
  shelfId: number;
  /** Where the heading row's top must be, as a viewport `clientY`. */
  top: number;
  /** Whether temporary room may be added to get it there — a folded wall's, see `anchorPlan`. */
  room: boolean;
}

/**
 * How long after a drop the wall keeps re-anchoring the moved heading as the new order arrives,
 * in ms. A folder move is not optimistic — the write, then a refetch of the folders — so the
 * moved heading reaches the wall a beat after the unfold. Any wheel, key or press ends it sooner.
 */
const SETTLE_MS = 2000;

/**
 * **The carried heading, for spec §3.9's anchor** — "the page stays anchored on the dragged
 * heading as it folds and unfolds". Module state, because there is one pointer: `useFoldAnchor`
 * (the page) feeds it the press, the pointer and the fold, and the sectioned wall does the
 * geometry, because only the wall knows where a row *is*.
 *
 * **Why the wall and not the page, measured in the live pass (2026-09-26).** The anchor used to be
 * a page-side scroll by the heading element's measured box, and it failed three ways at once:
 * during a drag dnd-kit promotes the source to a `position: fixed` popover, so its box is the
 * floating copy at the pointer and never its slot in the wall; the fold's own render still used
 * the old scroll offset (5664 against a folded wall of 1210), so the heading's row was outside the
 * virtualiser's window and **unmounted** in that very commit, which also lost dnd-kit's feedback
 * element; and the page's layout effect runs after the wall's, too late for either. So the wall
 * keeps the carried heading's row drawn whatever its window says, and places it from the layout's
 * own arithmetic (`rowStartOf`, `anchorPlan`) rather than from a box.
 *
 * **What lands where**, each a {@link ShelfAnchorRequest} to every attached wall:
 * - **Fold**: the carried heading at the pointer, less where in its row it was grabbed — with
 *   temporary room above or below when the folded wall is too short to get it there.
 * - **Escape**: the carried heading at the pointer, on the real (unfolded) page.
 * - **Drop**: the heading row the pointer was over stays where it was (so the unfold does not
 *   flash some other part of the wall), and when the new order arrives the **moved** heading goes
 *   to the pointer — inside {@link SETTLE_MS}.
 */
interface CarryState {
  /** The shelf whose heading row the press landed in, or `null`. */
  shelfId: number | null;
  /** The pointer's distance below that row's top, at the press. */
  grab: number;
  x: number;
  y: number;
  folding: boolean;
  /** How the fold ended: a drop over another heading row, a drop anywhere else, or Escape. */
  ended: { shelfId: number; top: number } | "drop" | "escape" | null;
  /** A drop is settling: the moved heading goes to the pointer when the new order arrives. */
  settling: boolean;
}

const carry: CarryState = {
  shelfId: null,
  grab: 0,
  x: 0,
  y: 0,
  folding: false,
  ended: null,
  settling: false,
};
const carryListeners = new Set<() => void>();
const carryWalls = new Set<(request: ShelfAnchorRequest) => void>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function setCarried(shelfId: number | null) {
  if (carry.shelfId === shelfId) return;
  carry.shelfId = shelfId;
  for (const listener of carryListeners) listener();
}

/**
 * **The settling is over, and so is the carry** (fix round 1, Minor 4). The carried heading's row is
 * kept drawn outside the virtualiser's window for as long as there is a carry, so a carry that
 * outlived its drag left the moved heading mounted wherever the reader scrolled — in the DOM, in
 * the tab order (a Tab from above the wall landed on it and the browser scrolled there), and as
 * the last drawn row the sectioned paging rule reads. So the carry ends with the drag it belongs
 * to: here, when a drop's settling ends — by timeout, by the reader taking the page, or by the
 * moved heading having been placed. Mid-fold the carry stays: it is the drag.
 */
function endSettling() {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  carry.settling = false;
  if (!carry.folding) releaseCarryNextFrame();
}

/**
 * Let the carry go on the next animation frame rather than now. The anchor that ended the drag has
 * just scrolled, and the virtualiser only draws the rows at the new offset when that scroll's event
 * arrives — which the browser dispatches before the next frame's callbacks. Dropping the forced row
 * sooner would re-render at the old offset without it, unmounting the heading the drag just
 * returned to its slot. A press in between keeps its own carry.
 */
let releaseFrame: number | null = null;
function releaseCarryNextFrame() {
  if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
  const shelfId = carry.shelfId;
  releaseFrame = requestAnimationFrame(() => {
    releaseFrame = null;
    if (!carry.folding && !carry.settling && carry.shelfId === shelfId) setCarried(null);
  });
}

function requestAnchor(request: ShelfAnchorRequest) {
  for (const wall of carryWalls) wall(request);
}

/** The shelf row under a viewport point other than the carried one — where a drop was let go. */
function rowUnderPointer(x: number, y: number): { shelfId: number; top: number } | null {
  if (typeof document.elementsFromPoint !== "function") return null;
  for (const element of document.elementsFromPoint(x, y)) {
    const row = element.closest<HTMLElement>(`[data-shelf-row][${SHELF_ID_ATTR}]`);
    const shelfId = row ? Number(row.getAttribute(SHELF_ID_ATTR)) : Number.NaN;
    if (row && Number.isInteger(shelfId) && shelfId !== carry.shelfId) {
      return { shelfId, top: row.getBoundingClientRect().top };
    }
  }
  return null;
}

/** The fold anchor's controller — driven by `useFoldAnchor`, read by the sectioned wall. */
export const shelfCarry = {
  /** A press — on a heading row (its shelf and the row's top), or anywhere else (`null`). */
  press(on: { shelfId: number; rowTop: number } | null, x: number, y: number) {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
    releaseFrame = null;
    carry.grab = on ? y - on.rowTop : 0;
    carry.x = x;
    carry.y = y;
    carry.ended = null;
    carry.settling = false;
    setCarried(on ? on.shelfId : null);
  },
  move(x: number, y: number) {
    carry.x = x;
    carry.y = y;
  },
  /** The pointer came up. Mid-fold that is a drop; otherwise it was a press, and the carry ends. */
  up(x: number, y: number) {
    carry.x = x;
    carry.y = y;
    if (!carry.folding) {
      setCarried(null);
      return;
    }
    carry.ended = rowUnderPointer(x, y) ?? "drop";
  },
  /** Escape mid-fold: the drag is cancelled, and the heading goes back to the pointer. Any other
   *  Escape is the reader's own, like any other key. */
  escape() {
    if (carry.folding) carry.ended = "escape";
    else shelfCarry.interrupt();
  },
  /** The reader took the page (a wheel, a key): a settling drop ends here. A wheel mid-drag is
   *  part of the drag and ends nothing. */
  interrupt() {
    if (carry.settling) endSettling();
  },
  /** The page's fold flag changed — `useFoldAnchor`'s layout effect, after the wall has drawn it. */
  fold(folding: boolean) {
    if (carry.folding === folding) return;
    carry.folding = folding;
    const shelfId = carry.shelfId;
    if (shelfId === null) return;
    if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
    releaseFrame = null;
    const atPointer = { shelfId, top: carry.y - carry.grab };
    if (folding) {
      carry.ended = null;
      requestAnchor({ ...atPointer, room: true });
      return;
    }
    const ended = carry.ended;
    carry.ended = null;
    requestAnchor(
      typeof ended === "object" && ended !== null
        ? { ...ended, room: false }
        : { ...atPointer, room: false },
    );
    if (ended === "escape") {
      // A cancelled drag moved nothing: nothing to settle, and the carry is over.
      releaseCarryNextFrame();
      return;
    }
    // **The settling starts here, after the wall has committed the unfold** (fix round 1, Minor
    // 6): this runs in `useFoldAnchor`'s layout effect, which is after the wall's own `[shelved]`
    // effect in the same commit — so the settling can only catch an order that arrives in a
    // *later* commit. It does, because a folder move is written and then refetched; an optimistic
    // move, whose new order arrived in the unfold commit itself, would never be settled. The
    // other end of this is `carriedPlace` in `CardGrid`.
    carry.settling = true;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(endSettling, SETTLE_MS);
  },
  /** While a drop settles: the carried heading, at the pointer. */
  settling(): ShelfAnchorRequest | null {
    if (carry.shelfId === null || !carry.settling) return null;
    return { shelfId: carry.shelfId, top: carry.y - carry.grab, room: false };
  },
  /** Forget everything, anchoring nothing — the page that drove the carry has gone. */
  reset() {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (releaseFrame !== null) cancelAnimationFrame(releaseFrame);
    releaseFrame = null;
    carry.folding = false;
    carry.ended = null;
    carry.settling = false;
    setCarried(null);
  },
  carried: (): number | null => carry.shelfId,
  subscribe(listener: () => void) {
    carryListeners.add(listener);
    return () => {
      carryListeners.delete(listener);
    };
  },
  /** A sectioned wall listening for anchor requests; the return detaches it. */
  attach(wall: (request: ShelfAnchorRequest) => void) {
    carryWalls.add(wall);
    return () => {
      carryWalls.delete(wall);
    };
  },
};

/** Where a shelf's heading sits among the headings, and under which folders — its place in the
 *  wall's order, which a folder move changes and a page of cards landing does not. */
export function headingPlace(layout: ShelfLayout, shelfId: number): string | null {
  let ordinal = 0;
  for (const row of layout.rows) {
    if (row.kind !== "heading") continue;
    if (row.shelf.id === shelfId) return `${row.shelf.pathIds.join("/")}#${ordinal}`;
    ordinal++;
  }
  return null;
}
