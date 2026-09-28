import { act, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import type { Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { WishlistTable, type WishTableBands } from "./WishlistTable";
import type { WishTableRow } from "./wishShelfPlan";

/**
 * Every `band` callback `WishlistTable` has handed `VirtualTable`, one entry per render.
 *
 * **A recording pass-through rather than an assertion on anything drawn**, because the defect this
 * fences is invisible in the DOM: a `band` that changes identity draws exactly the same rows. What
 * it costs is `VirtualTable` asking the callback of every loaded row again, which is a fact about
 * the prop and nothing else. The real table still draws, so the headings below are real ones.
 */
const handed = vi.hoisted(() => ({ bands: [] as unknown[] }));

vi.mock("@/components/table/VirtualTable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/table/VirtualTable")>();
  function Recording(props: ComponentProps<typeof actual.VirtualTable>) {
    handed.bands.push(props.band);
    return <actual.VirtualTable {...props} />;
  }
  return { ...actual, VirtualTable: Recording };
});

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
  handed.bands.length = 0;
  useAppStore.setState({ selectedCardId: null });
});

/** `WishlistGrid.test.tsx`'s `BOLT`, copied rather than shared — a fixture two suites reach into
 *  is a fixture neither can change. */
const BOLT: WishRow = {
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
  elsewhere: 0,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

const EXPENSIVE: WishlistFolder = {
  id: 3,
  name: "Expensive",
  parentId: null,
  sortOrder: 0,
  managedDeckId: null,
  managedTokens: false,
};

const shelf = (id: number, name: string): Shelf => ({
  id,
  kind: id === 0 ? "unfiled" : "folder",
  group: "own",
  name,
  pathIds: [id],
  path: [name],
  depth: 0,
  indent: 0,
  lead: [],
  leadIds: [],
  headless: false,
  collapsed: false,
  locked: false,
});

/** Not sorted holding Bolt, then an empty Expensive — two heading bands around one wish. */
const ROWS: WishTableRow[] = [
  { band: "heading", shelf: shelf(0, "Not sorted"), empty: false },
  BOLT,
  { band: "heading", shelf: shelf(EXPENSIVE.id, "Expensive"), empty: true },
];

const noop = () => {};

/** Bands whose headings carry a word, so a render with new ones is told apart on screen. */
const bandsSaying = (word: string): WishTableBands => ({
  heading: (s) => <h3>{`${s.name} ${word}`}</h3>,
  empty: () => <p>{`nothing ${word}`}</p>,
  label: () => null,
  sticky: () => null,
  indentOf: () => 0,
});

const shelvedTable = (bands: WishTableBands) => (
  <WishlistTable
    rows={ROWS}
    total={1}
    bands={bands}
    listKey="k"
    sort={[{ key: "name", dir: "asc" }]}
    onSort={noop}
    folders={[EXPENSIVE]}
    nodes={[]}
    onNeedNextPage={noop}
    onSetQuantity={noop}
    onRemove={noop}
    onSetFolder={noop}
    onChangePrinting={noop}
    onAnyPrinting={noop}
    marketplace={MARKETPLACES.tcgplayer}
  />
);

describe("the table's shelf bands", () => {
  /**
   * **`band` holds still for the life of the table, whatever the page's bands do.** `VirtualTable`
   * asks it of every loaded row whenever its identity changes, and the page's bands are a fresh
   * object every render — `renderHeading` depends on a `useMutation` result. A `band` closed over
   * them (the defect: a memo on `bands`) was therefore a new callback per page render, and every
   * render built every heading in the list, not only the ones in the window, just to learn which
   * rows were bands. Keyed that way, the two renders below hand over two callbacks.
   *
   * The second half is what the stable callback must not cost: a band still draws the bands it was
   * *last* handed — the heading and an empty folder's box alike — because they travel by context
   * and are read when the band draws.
   */
  it("hands the table one band callback across renders, and draws the latest bands", () => {
    const { rerender } = render(shelvedTable(bandsSaying("first")));
    expect(screen.getByRole("heading", { name: "Expensive first" })).toBeInTheDocument();
    expect(screen.getByText("nothing first")).toBeInTheDocument();

    rerender(shelvedTable(bandsSaying("second")));
    expect(screen.getByRole("heading", { name: "Not sorted second" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Expensive second" })).toBeInTheDocument();
    expect(screen.getByText("nothing second")).toBeInTheDocument();
    expect(screen.queryByText("nothing first")).not.toBeInTheDocument();

    expect(handed.bands.length).toBeGreaterThanOrEqual(2);
    expect(typeof handed.bands[0]).toBe("function");
    expect(new Set(handed.bands).size).toBe(1);
  });

  /**
   * **A band is keyed by its shelf, so a pressed control leaves with its folder** (review, check 8).
   * The table keys its rows by position, so an unkeyed band was re-used at its old place for
   * whichever folder took that place after a Move up / Move down — the `⋯` the reader had pressed
   * stayed mounted, and focused, under the other folder's name. Keyed, the element the caret was on
   * goes with its folder and still names it, and nothing on screen is now focused under the wrong
   * name.
   */
  it("keys each band by its shelf, so a pressed control is never relabelled for another folder", () => {
    const CHEAP = shelf(4, "Cheap");
    const pair = (...order: Shelf[]): WishTableRow[] =>
      order.map((s) => ({ band: "heading", shelf: s, empty: false }));
    const withManage: WishTableBands = {
      ...bandsSaying(""),
      heading: (s) => <button type="button">{`Manage ${s.name}`}</button>,
    };
    const table = (rows: WishTableRow[]) => (
      <WishlistTable
        rows={rows}
        total={0}
        bands={withManage}
        listKey="k"
        sort={[{ key: "name", dir: "asc" }]}
        onSort={noop}
        folders={[EXPENSIVE]}
        nodes={[]}
        onNeedNextPage={noop}
        onSetQuantity={noop}
        onRemove={noop}
        onSetFolder={noop}
        onChangePrinting={noop}
        onAnyPrinting={noop}
        marketplace={MARKETPLACES.tcgplayer}
      />
    );
    const expensive = shelf(EXPENSIVE.id, "Expensive");
    const { rerender } = render(table(pair(expensive, CHEAP)));
    const pressed = screen.getByRole("button", { name: "Manage Expensive" });
    act(() => pressed.focus());

    rerender(table(pair(CHEAP, expensive)));

    expect(pressed).toHaveAccessibleName("Manage Expensive");
    expect(document.activeElement).not.toHaveAccessibleName("Manage Cheap");
    expect(screen.getByRole("button", { name: "Manage Cheap" })).not.toBe(pressed);
  });
});
