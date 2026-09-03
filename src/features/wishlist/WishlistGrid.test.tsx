import { render, screen, within } from "@testing-library/react";
import { isWebTarget } from "@/pwa/target";

// The build flag `cardArtSrc` branches on. `false` is what `__CORE__` already answers under
// vitest, so this changes nothing here until a case below asks for a browser.
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_A_DRAG, readDragData } from "@/features/decks/dnd";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";
import { stubNarrowWindow } from "@/test-viewport";
import { PHONE_TILE_WIDTH } from "@/features/search/CardGrid";
import { WishlistGrid } from "./WishlistGrid";
import { WishlistTable } from "./WishlistTable";
import { readWishDrag } from "./wishDrag";

/**
 * What a wish says about itself in the two views that draw it — the drag it hands out, the folder
 * it is captioned with while the list is flattened, and the mark that catches the same card being
 * on the list twice. Design spec §4 and §9.
 *
 * **One file for both views, because these are three contracts about one list rather than two
 * components' behaviour.** "The answer must not differ between two drawings of one list" is the
 * rule the wall and the table already follow for the row menu, and every claim below is of that
 * shape — a folder caption the wall drew and the table did not would be a bug no test of either
 * one alone could state. So each block asserts the wall and the list side by side.
 *
 * **The drags run over the library's real code path** — `src/test-drag.ts` says why jsdom can
 * carry `dragstart` at all and lists what it cannot. What is out of reach here and stays the live
 * pass's: the platform's own drag preview, the pointer hit-testing that decides which folder card
 * a `dragover` lands on, and every clipping question about a caption at 170px, since jsdom has no
 * layout engine.
 */

/** A wish pinned to one printing — `WishlistPage.test.tsx`'s own `BOLT`, copied rather than
 *  shared, since a fixture two suites reach into is a fixture neither can change. */
const BOLT: WishRow = {
  // The Arena export filter's field and its only reader — nothing this suite drives touches it.
  legalities: null,
  id: 7,
  oracleId: "o-bolt",
  cardId: "c1",
  folderId: null,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 4,
  preferredFinish: "foil",
  unitPrice: 400.5,
  ownedQuantity: 1,
  elsewhere: 0,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/**
 * A wish for the *card*, which is what a shopping list usually means — and the row this task is
 * really about: `cardId` is null, so it has no card mark to carry and used to be undraggable.
 */
const ANY: WishRow = {
  ...BOLT,
  id: 8,
  cardId: null,
  setCode: null,
  collectorNumber: null,
  lang: null,
  rarity: null,
  artCardId: "c-recall",
  name: "Ancestral Recall",
  manaCost: "{U}",
  preferredFinish: null,
  quantity: 1,
  ownedQuantity: 0,
  unitPrice: 12,
};

const EXPENSIVE: WishlistFolder = { id: 3, name: "Expensive", parentId: null, sortOrder: 0 };

const NODES: FolderNode<WishlistFolder>[] = [
  { folder: EXPENSIVE, depth: 0, count: 0, children: [] },
];

/** The page's join, as spec §4 describes it: the root reads `Wishlist`, a folder reads its name,
 *  and a folder the page cannot see answers `null`. */
const folderNameOf = (folderId: number | null) =>
  folderId === null ? "Wishlist" : folderId === EXPENSIVE.id ? EXPENSIVE.name : null;

const noop = () => {};

/** What either view may be handed instead of a `noop` — the two writes a case below drives. */
interface Overrides {
  flattened?: boolean;
  onSetQuantity?: (row: WishRow, quantity: number) => void;
}

function wall(rows: WishRow[], over: Overrides = {}) {
  return render(
    <WishlistGrid
      rows={rows}
      listKey="k"
      folders={[EXPENSIVE]}
      nodes={NODES}
      folderNameOf={folderNameOf}
      flattened={over.flattened ?? false}
      onNeedNextPage={noop}
      onSetQuantity={over.onSetQuantity ?? noop}
      onRemove={noop}
      onSetFolder={noop}
      onChangePrinting={noop}
      onAnyPrinting={noop}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
}

function list(rows: WishRow[], over: Overrides = {}) {
  return render(
    <WishlistTable
      rows={rows}
      total={rows.length}
      listKey="k"
      sort={[{ key: "name", dir: "asc" }]}
      onSort={noop}
      folders={[EXPENSIVE]}
      nodes={NODES}
      folderNameOf={folderNameOf}
      flattened={over.flattened ?? false}
      onNeedNextPage={noop}
      onSetQuantity={over.onSetQuantity ?? noop}
      onRemove={noop}
      onSetFolder={noop}
      onChangePrinting={noop}
      onAnyPrinting={noop}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
}

/**
 * A tile's chin, reached from the printing line the wall writes into it.
 *
 * `CardChin` is the only element in a tile carrying a vertical border, which is what makes this a
 * stable way in — every other route is a count of `parentElement` hops through two components'
 * markup, and it moves the first time either of them gains a wrapper.
 */
const chinOf = (printing: string): HTMLElement =>
  screen.getByText(printing).closest("span.border-x") as HTMLElement;

/**
 * The nearest ancestor (or the element itself) that would be an absolutely positioned
 * descendant's containing block — read off the class list, because **jsdom loads no stylesheet
 * and computes no layout**, so `getComputedStyle().position` answers `"static"` for every
 * element on screen whatever Tailwind would have painted.
 *
 * The four are the position utilities that establish one; `static` deliberately is not, and that
 * is the whole point of the class the wall passes its pencil. `classList.contains` and never a
 * substring of `className`: `relative` is a substring of nothing here today, but `sticky` sits
 * inside `hover:sticky` and the family of mistakes is the one that reads a `hover:` variant as
 * an applied class.
 */
const POSITIONING = ["relative", "absolute", "fixed", "sticky"];
const nearestPositioned = (from: HTMLElement): HTMLElement | null => {
  for (let el: HTMLElement | null = from; el !== null; el = el.parentElement) {
    if (POSITIONING.some((token) => el!.classList.contains(token))) return el;
  }
  return null;
};

/**
 * What one drag actually put in the library's store.
 *
 * The payload never travels in a `DataTransfer` — it lives in the library's own store, keyed off
 * the source's `data` — so a monitor is the only way to read it, and the drag has to be ended
 * (`cancel`) or the manager's one drag operation strands every later test in the file.
 */
async function carriedBy(source: Element): Promise<Record<string, unknown> | null> {
  const drags = recordDrags();
  // A box of its own, because dnd-kit hit-tests by coordinate and jsdom measures every rect as
  // four zeroes — a source with no box is pressed at the origin and never travels.
  const held = await startPointerDrag(boxed(source as HTMLElement, 0));
  // **Asked before the drag is let go, because `started` is a live reading rather than a
  // remembered one**: `PointerHeld.started` is a getter over the manager's own operation status,
  // so after a cancel it is false for every drag there has ever been.
  expect(held.started).toBe(true);
  await held.cancel();
  drags.stop();
  return drags.records[0] ?? null;
}

/**
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders no
 * rows at all. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  // The wall's tile size is the reader's and lives in a module-level store that outlives a
  // render, so a suite that left a section at 2× would be measured here.
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS }, selectedCardId: null });
});

describe("a wish's drag", () => {
  /**
   * The proof the deck's drop targets did not regress. A pinned wish is genuinely two things, so
   * its record carries both marks — and `readDragData`, which is untouched by any of this, still
   * reads a card out of it.
   */
  it("carries both marks on a pinned wish, in both views", async () => {
    const { container, unmount } = wall([{ ...BOLT, folderId: EXPENSIVE.id }]);
    const tile = container.querySelector(`[${DND_SOURCE_ATTR}]`);
    expect(tile).not.toBeNull();

    const fromWall = await carriedBy(tile!);
    expect(readDragData(fromWall!)).toEqual({
      kind: "card",
      cardId: "c1",
      name: "Lightning Bolt",
      typeLine: "Instant",
    });
    expect(readWishDrag(fromWall!)).toEqual({
      wishId: 7,
      name: "Lightning Bolt",
      // Where it is filed *now*, so a folder can refuse the wish already in it.
      folderId: EXPENSIVE.id,
    });
    unmount();

    const listed = list([{ ...BOLT, folderId: EXPENSIVE.id }]);
    const row = listed.container.querySelector(`[${DND_SOURCE_ATTR}]`);
    const fromList = await carriedBy(row!);
    expect(readDragData(fromList!)).toEqual(readDragData(fromWall!));
    expect(readWishDrag(fromList!)).toEqual(readWishDrag(fromWall!));
  });

  /**
   * The row this task exists for. It could not be picked up at all before — `CardGrid` was handed
   * `null` and registered nothing — and it is now a wish and only a wish: `readDragData` answers
   * `null`, so a deck column lights nothing up and writes nothing, which is exactly what it did
   * when the tile was inert.
   */
  it("carries the wish mark alone on an any-printing wish, in both views", async () => {
    const { container, unmount } = wall([ANY]);
    const tile = container.querySelector(`[${DND_SOURCE_ATTR}]`);
    expect(tile).not.toBeNull();

    const fromWall = await carriedBy(tile!);
    expect(readDragData(fromWall!)).toBeNull();
    expect(readWishDrag(fromWall!)).toEqual({
      wishId: 8,
      name: "Ancestral Recall",
      folderId: null,
    });
    // No card mark at all, rather than a card mark carrying an empty id.
    expect(fromWall).not.toHaveProperty("dragSource");
    unmount();

    const listed = list([ANY]);
    const row = listed.container.querySelector(`[${DND_SOURCE_ATTR}]`);
    expect(row).not.toBeNull();
    const fromList = await carriedBy(row!);
    expect(readDragData(fromList!)).toBeNull();
    expect(readWishDrag(fromList!)).toEqual(readWishDrag(fromWall!));
  });
});

describe("the folder caption", () => {
  it("names each wish's folder while flattened, and reads Wishlist at the root", () => {
    const rows = [{ ...BOLT, folderId: EXPENSIVE.id }, ANY];
    const { unmount } = wall(rows, { flattened: true });
    expect(screen.getByText("Expensive")).toBeInTheDocument();
    expect(screen.getByText("Wishlist")).toBeInTheDocument();
    unmount();

    list(rows, { flattened: true });
    expect(screen.getByText("Expensive")).toBeInTheDocument();
    expect(screen.getByText("Wishlist")).toBeInTheDocument();
  });

  /**
   * Inside a folder the caption would be the same word under every wish, said once already by the
   * breadcrumb — so it is drawn on exactly one screen and both views agree about which.
   */
  it("draws nothing while the list is not flattened", () => {
    const rows = [{ ...BOLT, folderId: EXPENSIVE.id }];
    const { unmount } = wall(rows);
    expect(screen.queryByText("Expensive")).toBeNull();
    unmount();

    list(rows);
    expect(screen.queryByText("Expensive")).toBeNull();
  });

  /** A folder another window deleted between the two reads has no honest name, so the caption is
   *  absent rather than blank. */
  it("says nothing about a folder the page cannot name", () => {
    wall([{ ...BOLT, folderId: 404 }], { flattened: true });
    expect(screen.queryByText("Filed in")).toBeNull();
    expect(screen.getByAltText("Lightning Bolt")).toBeInTheDocument();
  });
});

describe("the elsewhere mark", () => {
  /** Most rows answer 0, which is what makes this free for a reader with no duplicates. */
  it("is absent on a wish that is only on the list once", () => {
    const { unmount } = wall([BOLT]);
    expect(screen.queryByRole("img", { name: /Also on your wishlist/ })).toBeNull();
    unmount();

    list([BOLT]);
    expect(screen.queryByRole("img", { name: /Also on your wishlist/ })).toBeNull();
  });

  /**
   * **Wishes, not places** — the noun is the fix of 2026-08-22 and it is the whole assertion.
   * The grain is `(oracle_id, card_id, preferred_finish, folder_id)`, so a foil Bolt and a
   * nonfoil Bolt both loose at the root are two counted rows in *one* place, and the old
   * sentence said "2 other places" over them.
   */
  it("says how many other wishes on the list are for the card, in both views", () => {
    const rows = [{ ...BOLT, elsewhere: 2 }];
    const { unmount } = wall(rows);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist as 2 other wishes" }),
    ).toBeInTheDocument();
    unmount();

    list(rows);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist as 2 other wishes" }),
    ).toBeInTheDocument();
  });

  /** One duplicate is one *wish*, not two — the sentence is read by somebody deciding whether to
   *  buy the card again, so the number in it has to be the number of other rows. */
  it("says one wish in the singular", () => {
    wall([{ ...BOLT, elsewhere: 1 }]);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist as 1 other wish" }),
    ).toBeInTheDocument();
  });
});

describe("the list's own editor", () => {
  /**
   * Spec §5: the list reaches the two new writes through the *wall's* control rather than a
   * design of its own, and it names the wish rather than the verb — four hundred rows are four
   * hundred different wishes and "Edit" is the same word on all of them.
   *
   * **That it is one control in both views is the whole claim.** The two writes an any-printing
   * wish can only reach through this panel must not be one view's privilege.
   */
  it("is the wall's pencil, drawn in both views and named for the wish", () => {
    const name = "Edit Lightning Bolt (LEA 161, Foil) on your wishlist";
    const { unmount } = wall([BOLT]);
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
    unmount();

    list([BOLT]);
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  /**
   * It opens the panel in place rather than asking the page for a surface of its own —
   * `AnchoredPopup` owns its open state, so a callback up to the page could only ever open a
   * *different* surface, which is the two-designs-for-one-job this replaced.
   */
  it("opens the wish's panel from a row, without opening the card", async () => {
    list([BOLT]);

    await userEvent.click(screen.getByRole("button", { name: /^Edit Lightning Bolt/ }));

    const panel = await screen.findByRole("dialog", { name: "Edit Lightning Bolt" });
    expect(within(panel).getByRole("button", { name: /^Move to folder/ })).toBeInTheDocument();
    // The press belongs to the cell: a reader reaching for the pencil did not ask for the card
    // pane, and the column's `interactive` flag is what stops the row's own click.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** The printing is still a caption — this moved a control into the cell, not a column. */
  it("leaves the printing itself as text", () => {
    const { container } = list([BOLT]);
    expect(within(container).getByText("LEA · 161 · Foil").tagName).toBe("SPAN");
  });
});

/**
 * **How many copies, from either drawing of the list** — issue #284, and this file's own rule
 * arriving at the one write that did not follow it.
 *
 * The table has always edited the number in place, because a shopping list is where the number
 * of copies is *maintained*. The wall had the pencil and nothing else, so the same change cost
 * three presses there and one here — which is exactly the difference between two drawings of one
 * list that the header of this file says must not exist. So every claim below is asserted on the
 * wall **and** on the table, except the three that are about the tile's own arrangement (the
 * strip is `CardGrid`'s and a table row has no such thing).
 *
 * **The floor is `0` on both, and `0` is a real press.** `wishlist.rs`'s `set_wish_quantity` has
 * always returned `remove_wish(conn, id)` at zero, because `wishlist_entries.quantity` carries
 * `CHECK (quantity > 0)` — a wish for none of something is not a wish. What changed is the UI
 * guard in front of it: `min={1}` used to argue that a stepper deleting a row when held down is
 * a one-way door, and the collection's wall reaching zero and deleting there is what overruled
 * it. **The deletion itself is deliberately not asserted here** — it is the backend's, and this
 * file renders two components over rows rather than a page over a database. What is asserted is
 * the *argument*: that the press happens and that the number asked for is zero.
 */
describe("the wall's own quantity stepper", () => {
  /** The name every stepper for this wish carries, in both views and in the pencil's panel: a
   *  wish is named by its printing and finish, because two wishes for one card differ by nothing
   *  else. Written out rather than built from `wishLabel`, so a case here cannot pass by
   *  agreeing with the implementation about a name that is wrong. */
  const LABEL = "Copies wanted of Lightning Bolt (LEA 161, Foil)";

  it("is drawn on a tile and in a row alike, named for the wish", () => {
    const { unmount } = wall([BOLT]);
    expect(screen.getByRole("spinbutton", { name: LABEL })).toHaveValue(4);
    unmount();

    list([BOLT]);
    expect(screen.getByRole("spinbutton", { name: LABEL })).toHaveValue(4);
  });

  /**
   * **Two wishes for one card, and two controls a reader can tell apart** — the case the name is
   * `wishLabel` for, and the only one that can fail when it is not.
   *
   * A foil Bolt and a nonfoil Bolt are two wishes for one piece of cardboard: same name, same
   * set, same number, different finish, and `WISH_PREFERRED_FINISH` in `wishlist.rs` is the rule
   * that they must not be collapsed. A stepper named `Copies wanted of Lightning Bolt` would be
   * two identical controls on one wall as far as a screen reader or a voice driver is concerned
   * — and the failure is *silent* on a wall with one Bolt on it, which is every other case in
   * this block. `getByRole` is the assertion as much as the values are: it throws on two matches,
   * so a name built from the card alone cannot reach the first line.
   *
   * The press at the end is the other half. Two rows that differ by nothing the eye can see in a
   * 20px box have to reach two different wishes, or the name is unique and the wiring is not.
   */
  it("names two wishes for one card apart, and each reaches its own wish", async () => {
    const nonfoil: WishRow = { ...BOLT, id: 9, preferredFinish: "nonfoil", quantity: 2 };
    const other = "Copies wanted of Lightning Bolt (LEA 161, Nonfoil)";
    const onSetQuantity = vi.fn();
    wall([BOLT, nonfoil], { onSetQuantity });

    expect(screen.getByRole("spinbutton", { name: LABEL })).toHaveValue(4);
    expect(screen.getByRole("spinbutton", { name: other })).toHaveValue(2);

    await userEvent.click(screen.getByRole("button", { name: `Increase ${other}` }));

    expect(onSetQuantity).toHaveBeenCalledWith(nonfoil, 3);
  });

  /**
   * The write, with the wish it is about rather than an id: the page's mutation is keyed on the
   * row, and a control that handed over only a number would be a control the page has to look
   * the row back up for.
   */
  it("asks for the new number, carrying the wish, from either view", async () => {
    const fromWall = vi.fn();
    const { unmount } = wall([BOLT], { onSetQuantity: fromWall });

    await userEvent.click(screen.getByRole("button", { name: `Increase ${LABEL}` }));
    expect(fromWall).toHaveBeenCalledWith(BOLT, 5);
    unmount();

    const fromList = vi.fn();
    list([BOLT], { onSetQuantity: fromList });
    await userEvent.click(screen.getByRole("button", { name: `Increase ${LABEL}` }));
    expect(fromList).toHaveBeenCalledWith(BOLT, 5);
  });

  /**
   * **The floor is reachable, and reaching it is the removal.** A wish for one copy stepped down
   * asks for zero — the press is not swallowed by a disabled button, which is what `min={1}`
   * made it on exactly the rows a reader is most likely to be crossing off.
   *
   * The argument is asserted and not the deletion: what happens to the row is
   * `set_wish_quantity`'s, and nothing in this file has a database behind it.
   */
  it("asks for zero from a wish of one copy, in both views", async () => {
    const single: WishRow = { ...BOLT, quantity: 1 };

    const fromWall = vi.fn();
    const { unmount } = wall([single], { onSetQuantity: fromWall });
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${LABEL}` }));
    expect(fromWall).toHaveBeenCalledWith(single, 0);
    unmount();

    const fromList = vi.fn();
    list([single], { onSetQuantity: fromList });
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${LABEL}` }));
    expect(fromList).toHaveBeenCalledWith(single, 0);
  });

  /**
   * **A press on `−` is not a press on the card.** The strip lies over the picture's foot, and
   * the tile's art button is what opens the pane — so the claim is that the two presses landing
   * a few pixels apart do two different things.
   *
   * The art is clicked first, deliberately: without it the case would pass on a wall that could
   * not open a card at all, which is the shape of an assertion that cannot fail. `selectedCardId`
   * is the real thing rather than a proxy — `WishlistGrid` hands `CardGrid` the store's own
   * setter as `onSelect`, so there is no injected callback between the press and the pane.
   */
  it("changes the number without opening the card", async () => {
    const onSetQuantity = vi.fn();
    wall([BOLT], { onSetQuantity });

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
    expect(useAppStore.getState().selectedCardId).toBe("c1");
    useAppStore.setState({ selectedCardId: null });

    await userEvent.click(screen.getByRole("button", { name: `Decrease ${LABEL}` }));

    expect(onSetQuantity).toHaveBeenCalledWith(BOLT, 3);
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The pencil is still there and still opens the panel. It lost the strip to itself and nothing
   * else: the two writes only it reaches — the printing and the folder — and the named removal
   * are all still one press from the tile, which is what makes the number moving out in front of
   * it an addition rather than a rearrangement.
   */
  it("stands beside the pencil, which still opens the wish's panel", async () => {
    wall([BOLT]);

    const pencil = screen.getByRole("button", {
      name: "Edit Lightning Bolt (LEA 161, Foil) on your wishlist",
    });
    await userEvent.click(pencil);

    const panel = await screen.findByRole("dialog", { name: "Edit Lightning Bolt" });
    expect(
      within(panel).getByRole("button", { name: /Remove Lightning Bolt .* from your wishlist/ }),
    ).toBeInTheDocument();
  });

  /**
   * **The mark that stops a decrement being a drag, and the only way it is defended.**
   *
   * A wish tile is a drag source, and the sensor asks `closest(NOT_A_DRAG)` at the press: the
   * stepper's `<input>` is excluded by tag, its two `<button>`s are not. Without the wrapper's
   * mark, a press on `−` that travelled five pixels would carry the wish off into a deck instead
   * of decrementing it. **jsdom cannot see a drag start from a real pointer press on a button**,
   * so nothing else in this suite can go red for it — the selector the sensor itself uses is
   * asked the same question here, rather than the attribute being spelled out a second time.
   *
   * One mark for both buttons rather than one each, which is what `closest` buys and what
   * `DeckCardControls` already does around the same control.
   *
   * **The pencil is guarded separately, and since issue #348 it is guarded somewhere else.** The
   * stepper stood beside it in `CardGrid`'s bottom strip until then and the two shared one
   * wrapper; the stepper has gone to the tile's right margin, so the wrapper covers the stepper
   * alone and the pencil is left holding `AnchoredPopup`'s own mark. Both halves are asserted
   * here rather than only the stepper's — a pencil that quietly lost its mark is a press on the
   * panel becoming a drag of the wish, and no other test in this file would notice.
   */
  it("marks the stepper and the pencil as not a drag, separately", () => {
    wall([BOLT]);

    const decrease = screen.getByRole("button", { name: `Decrease ${LABEL}` });
    const increase = screen.getByRole("button", { name: `Increase ${LABEL}` });
    const guard = decrease.closest(NOT_A_DRAG);

    expect(guard).not.toBeNull();
    expect(increase.closest(NOT_A_DRAG)).toBe(guard);

    // The pencil is outside that wrapper now, and carries a mark of its own — `AnchoredPopup`
    // marks itself, which is `dnd.ts`'s rule read the other way round.
    const pencil = screen.getByRole("button", { name: /^Edit Lightning Bolt/ });
    expect(guard!.contains(pencil)).toBe(false);
    expect(pencil.closest(NOT_A_DRAG)).not.toBeNull();
  });

  /**
   * **The pencil is `position: static` — so `CardGrid`'s strip is what the 256px panel hangs
   * off.**
   *
   * `AnchoredPopup` is `relative` by default and `WishlistGrid` passes it `static` precisely so
   * that it is not the containing block: a panel anchored to a 20px control at the right end of
   * a 170px tile opens off the left of the scroller, and left overflow — unlike right — cannot
   * be scrolled back into view. Anything positioned put between the two is the silent way to
   * undo it, because a `relative` box looks like nothing at all in the markup — which is why
   * this asserts the *identity* of the anchor rather than the pencil's own class.
   *
   * **Read off the class list, since jsdom loads no stylesheet** — see {@link nearestPositioned}.
   */
  it("leaves the strip as the box the pencil's panel is anchored to", () => {
    wall([BOLT]);

    const popupRoot = screen.getByRole("button", { name: /^Edit Lightning Bolt/ }).parentElement!;
    // `CardGrid`'s action strip — the only `pointer-events-none` box between a tile's controls
    // and the tile itself, and the box that comment calls the anchor.
    const strip = popupRoot.closest(".pointer-events-none");

    expect(strip).not.toBeNull();
    expect(nearestPositioned(popupRoot)).toBe(strip);
  });
});

/**
 * **A wish tile carries two money facts, and they answer different questions.**
 *
 * The chin quotes **one copy** of the printing and finish this wish is for — the same statement
 * every other wall's chin makes, which is what lets a reader carry one vocabulary between the
 * collection, the decks and this list. "Still to buy" is `unit × copies still missing`: it is what
 * the page header sums and what the table's Cost column shows, so it keeps the corner it already
 * has beside the review flag rather than being folded into the bar.
 *
 * Spec §5 — a price is never shown without saying how old it is — is answered once above this
 * wall by `pricesAsOf`, which is why the chin's figure is bare rather than forty tooltips.
 */
describe("what a wish tile says about money", () => {
  it("quotes one copy in the chin, and what is still to buy in the corner", () => {
    wall([{ ...BOLT, unitPrice: 12.32, quantity: 4, ownedQuantity: 2 }]);

    expect(within(chinOf("LEA · 161")).getByText("$12.32")).toBeInTheDocument();
    // Two copies still to find, at that unit price — the header's own arithmetic, and the one
    // figure that must not move into the bar.
    expect(screen.getByText("$24.64")).toBeInTheDocument();
  });

  /**
   * A wish the marketplace does not quote draws an em dash rather than another marketplace's rate
   * wearing this one's currency sign.
   */
  it("draws an em dash in the chin for a wish this marketplace cannot price", () => {
    wall([{ ...BOLT, unitPrice: null }]);

    expect(within(chinOf("LEA · 161")).getByText("—")).toBeInTheDocument();
  });

  /**
   * The corner sat 4px in, which on the search wall is deliberately the card's printed nameplate
   * — and on a wishlist tile is the card's own **name**. It drops below the printed title bar.
   *
   * `classList.contains` rather than a substring of `className`, and here that is not a
   * formality: the offset it must no longer carry is a **prefix** of the one it now does, so
   * `includes` would pass on a tile that had not moved at all.
   */
  it("keeps the corner clear of the card's printed name", () => {
    wall([{ ...BOLT, needsReview: "Check the printing." }]);

    const corner = screen.getByText("Needs review").closest("span[class*='absolute']")!;
    expect(corner.classList.contains("top-[calc(0.25rem*var(--mark-scale,1))]")).toBe(false);
    expect(corner.classList.contains("top-[calc(2rem*var(--mark-scale,1))]")).toBe(true);
  });
});

/**
 * **The wall says the printing; the table says the printing and the finish — and both are right.**
 *
 * They are one fact in two surroundings. The table has no art, no chin and no glyph, so the word
 * is the only statement of the finish there. The wall's caption is the chin's printing line, one
 * gutter from `FinishMark`, whose accessible name is that same word — so the word and the glyph
 * were "Foil" twice on the surface with the least room in the app to say anything twice.
 *
 * Each claim below is asserted on the wall **and** the table side by side, which is this file's
 * own rule: "the answer must not differ between two drawings of one list" is what makes a
 * deliberate difference worth pinning rather than assuming.
 */
describe("the printing line", () => {
  it("drops the finish word from the wall, where the glyph says it, and keeps it in the table", () => {
    const { unmount } = wall([BOLT]);
    const chin = chinOf("LEA · 161");
    expect(screen.queryByText("LEA · 161 · Foil")).toBeNull();
    // Said once, and by the mark: the glyph's own `aria-label` is the word that was dropped.
    expect(within(chin).getByRole("img", { name: "Foil" })).toBeInTheDocument();
    unmount();

    list([BOLT]);
    expect(screen.getByText("LEA · 161 · Foil")).toBeInTheDocument();
  });

  /**
   * **The exception, and the one that makes this a rule about the glyph rather than about the
   * word.** `FinishMark` draws nothing for nonfoil — it is the finish a price is assumed to be —
   * so a blanket drop would leave a wish *for the nonfoil* looking identical to a wish with no
   * preference at all. Those are two different wishes, which is the whole of what
   * `WISH_PREFERRED_FINISH` in `wishlist.rs` exists to keep apart.
   */
  it("keeps the word on a nonfoil wish, which draws no glyph to say it", () => {
    const { unmount } = wall([{ ...BOLT, preferredFinish: "nonfoil" }]);
    const chin = chinOf("LEA · 161 · Nonfoil");
    expect(within(chin).queryByRole("img", { name: "Nonfoil" })).toBeNull();
    unmount();

    list([{ ...BOLT, preferredFinish: "nonfoil" }]);
    expect(screen.getByText("LEA · 161 · Nonfoil")).toBeInTheDocument();
  });

  /** No preference is not nonfoil, and says neither. */
  it("says nothing about the finish on a wish that names none", () => {
    wall([{ ...BOLT, preferredFinish: null }]);

    expect(chinOf("LEA · 161")).toBeInTheDocument();
    expect(screen.queryByText(/· (Foil|Nonfoil|Etched)$/)).toBeNull();
  });

  /**
   * The one thing this caption exists to protect, and the thing a blanket rewrite would have
   * taken: an unpinned wish is *drawn* as a printing it is not for, so its caption may not name
   * that cardboard — with or without a finish appended.
   */
  it("still says Any printing on an unpinned wish, foil or not", () => {
    wall([
      { ...ANY, preferredFinish: "foil" },
      { ...ANY, id: 9, name: "Time Walk", artCardId: "c-walk", preferredFinish: null },
    ]);

    expect(screen.getAllByText("Any printing")).toHaveLength(2);
    expect(screen.queryByText("Any printing · Foil")).toBeNull();
  });
});

/**
 * **G1 — the tile a phone is handed, and the proof this wall is wired to ask for it.**
 *
 * A 390px window with the bottom tab bar instead of the rail leaves this wall **324px** once
 * `main`'s `p-5` and the scroller's own `border` + `p-3` are off it, and at the standard 170 that
 * is a single column with 90px of margin either side. `PHONE_TILE_WIDTH` and the arithmetic that
 * chose it live in `CardGrid.tsx`; what is asserted here is only that this call site asks the
 * question at all — a width that is right in a constant and never passed is the failure mode.
 *
 * **The prop, not a pixel.** jsdom lays nothing out, so the wall measures itself at 0 and
 * `tileWidthFor` answers a zero-width wall with the size it was asked for — which is what makes
 * the tile's own inline width a faithful reading of the prop and nothing else.
 */
describe("the tile the wishlist's wall is given at the phone width", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The tile's root — the box the width is set on, not the art button that takes the caret. */
  const tileOf = (container: HTMLElement) => container.querySelector("[data-grid-index]");

  it("hands the wall the phone's narrower tile below the phone width", () => {
    stubNarrowWindow(true);
    const { container } = wall([BOLT]);

    expect(tileOf(container)).toHaveStyle({ width: `${PHONE_TILE_WIDTH}px` });
  });

  it("leaves the wall's own default standing at every other width", () => {
    stubNarrowWindow(false);
    const { container } = wall([BOLT]);

    // 170 is `CardGrid`'s `TILE_BASE_WIDTH`, module-private and pinned by that component's own
    // suite. Spelled here because what this case is about is that the prop is *absent* — a wall
    // passing 144 unconditionally would pass the case above.
    expect(tileOf(container)).toHaveStyle({ width: "170px" });
  });
});

/**
 * **The wishlist wall in a browser** — the same failure, and the same fix, as the collection's:
 * `wishlist_list` is routed on web and `mtgimg://` cannot be reached there, so a row that
 * carries no URL is a named, artless frame.
 *
 * The second case is this wall's own question rather than a copy of the collection's. A wish for
 * *any* printing has no `cardId` at all; it is drawn as whichever printing the backend's join
 * chose, which is what `artCardId` names — so the picture has to follow that id, and a tile
 * reading `cardId` would draw nothing on exactly the rows a wishlist is mostly made of.
 */
describe("a wish's art", () => {
  const SCRYFALL = { display: "https://cards.scryfall.io/display/front/c/1/c1.webp?1706230661" };

  afterEach(() => {
    vi.mocked(isWebTarget).mockReturnValue(false);
  });

  it("draws the pinned printing's own picture in a browser", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    wall([{ ...BOLT, imageUris: SCRYFALL }]);

    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("src", SCRYFALL.display);
  });

  it("draws an any-printing wish as the printing the backend chose for it", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    wall([{ ...ANY, imageUris: SCRYFALL }]);

    expect(screen.getByAltText("Ancestral Recall")).toHaveAttribute("src", SCRYFALL.display);
  });

  /** The local cache still wins on the desktop; the field rides on both builds. */
  it("keeps drawing the cached protocol picture on desktop", () => {
    wall([{ ...BOLT, imageUris: SCRYFALL }]);

    const src = screen.getByAltText("Lightning Bolt").getAttribute("src");
    expect(src).toContain("mtgimg");
    expect(src).not.toContain("scryfall.io");
  });
});
