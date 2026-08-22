import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { readDragData } from "@/features/decks/dnd";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { startDrag } from "@/test-drag";
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

function wall(rows: WishRow[], over: { flattened?: boolean } = {}) {
  return render(
    <WishlistGrid
      rows={rows}
      listKey="k"
      folders={[EXPENSIVE]}
      nodes={NODES}
      folderNameOf={folderNameOf}
      flattened={over.flattened ?? false}
      onNeedNextPage={noop}
      onSetQuantity={noop}
      onRemove={noop}
      onSetFolder={noop}
      onChangePrinting={noop}
      onAnyPrinting={noop}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
}

function list(rows: WishRow[], over: { flattened?: boolean } = {}) {
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
      onSetQuantity={noop}
      onRemove={noop}
      onSetFolder={noop}
      onChangePrinting={noop}
      onAnyPrinting={noop}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
}

/**
 * What one drag actually put in the library's store.
 *
 * The payload never travels in the platform's `DataTransfer` — it lives in the adapter's own
 * store, keyed off `getInitialData` — so a monitor is the only way to read it, and the drag has
 * to be ended (`cancel`) or the library's one global "a drag is active" flag strands every later
 * test in the file.
 */
async function carriedBy(source: Element): Promise<Record<string, unknown> | null> {
  const seen: Record<string, unknown>[] = [];
  const stop = monitorForElements({ onDragStart: ({ source: s }) => seen.push(s.data) });
  const held = await startDrag(source);
  await held.cancel();
  stop();
  expect(held.started).toBe(true);
  return seen[0] ?? null;
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
    const tile = container.querySelector('[draggable="true"]');
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
    const row = listed.container.querySelector('[draggable="true"]');
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
    const tile = container.querySelector('[draggable="true"]');
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
    const row = listed.container.querySelector('[draggable="true"]');
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

  it("says how many other places the card is on the list, in both views", () => {
    const rows = [{ ...BOLT, elsewhere: 2 }];
    const { unmount } = wall(rows);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist in 2 other places" }),
    ).toBeInTheDocument();
    unmount();

    list(rows);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist in 2 other places" }),
    ).toBeInTheDocument();
  });

  /** One duplicate is one *place*, not two — the sentence is read by somebody deciding whether to
   *  buy the card again, so the number in it has to be the number of other rows. */
  it("says one place in the singular", () => {
    wall([{ ...BOLT, elsewhere: 1 }]);
    expect(
      screen.getByRole("img", { name: "Also on your wishlist in 1 other place" }),
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
