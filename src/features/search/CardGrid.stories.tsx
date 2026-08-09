import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { OwnedBadge } from "@/components/OwnedBadge";
import type { DragPayload } from "@/features/decks/dnd";
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { CardGrid, type GridCard } from "./CardGrid";

/**
 * A fixture printing, by the two columns that identify one.
 *
 * By set and collector number rather than by index, because `CARDS` is generated
 * (`scripts/gen-storybook-cards.mjs`) and a regeneration may reorder it — an index would then
 * quietly point at a different card and every claim below it would still read as true. The same
 * helper `CardImage.stories.tsx` uses, for the same reason.
 */
function printing(setCode: string, collectorNumber: string): FakeCard {
  const card = CARDS.find((c) => c.setCode === setCode && c.collectorNumber === collectorNumber);
  if (!card) throw new Error(`No fixture printing ${setCode} ${collectorNumber}`);
  return card;
}

/** `GridCard` is the wall's whole contract — five fields, which both `CardSummary` and a mapped
 *  `CollectionRow` satisfy structurally. Anything a *particular* wall needs beyond it arrives
 *  through the `badge` and `action` slots rather than by widening this shape. */
const tile = (c: FakeCard): GridCard => ({
  id: c.id,
  name: c.name,
  setCode: c.setCode,
  collectorNumber: c.collectorNumber,
  rarity: c.rarity,
});

/** All 43 fixture printings (`.storybook/fake/cards.ts`), in the order that file lists them. */
const ALL: GridCard[] = CARDS.map(tile);

const BOLT_ALPHA = tile(printing("lea", "161"));
const BOLT_2X2 = tile(printing("2x2", "117"));
const BOLT_STRIXHAVEN = tile(printing("sta", "105"));

/**
 * `SearchPage.tsx:144-148`'s payload, verbatim — **at module scope, because it has to hold
 * still**.
 *
 * React detaches and re-runs a callback ref whose identity changed, and this wall re-registers a
 * tile's drag from a `useCallback` that names `dragPayload` among its dependencies. A fresh
 * arrow per render would therefore tear the registration down and rebuild it on every scrolled
 * row — and a source that unregisters mid-drag is a drop that never arrives.
 */
const tileDrag = (card: GridCard): DragPayload => ({
  kind: "card",
  cardId: card.id,
  name: card.name,
});

const meta = {
  title: "Search/CardGrid",
  component: CardGrid<GridCard>,
  tags: ["autodocs"],
  args: {
    rows: ALL,
    listKey: "stories",
    onSelect: fn(),
    onNeedNextPage: fn(),
  },
  // A height and a width, because the wall is `min-h-0 flex-1` and measures its own container to
  // decide how many columns fit. In a canvas with no sized parent it would grow to hold every
  // tile and virtualise nothing.
  decorators: [
    (Story) => (
      <div className="flex h-[34rem] max-w-[46rem] flex-col">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A list of cards as a wall of art — the search results, and the collection's card " +
          "mode. Virtualised by **row** rather than by tile: the virtualiser measures a list, " +
          "and a grid is a list of rows that each hold `columns` cards. An unfiltered browse " +
          "is ~117 k printings, so the alternative is 117 k DOM nodes.\n\n" +
          "The tiles are whole card images (the `grid` variant), which is also what keeps this " +
          "view inside Scryfall's image policy with no credit line of its own: the artist's " +
          "name is printed on the card. An art crop here would need one — which is exactly " +
          "why `ZoneColumn`'s row thumbnail, which *is* a crop, sits beside a name rather " +
          "than alone.\n\n" +
          "Two slots keep the wall generic. `badge` is a mark over the art's bottom-left " +
          "corner and `action` is one control at the end of the caption; the corner, its " +
          "felt backing and the `empty:hidden` guard belong to the wall, so two views cannot " +
          "drift into two shades. Switch the **Art** toolbar to Live to see real Scryfall " +
          "images instead of the offline placeholders.",
      },
    },
  },
} satisfies Meta<typeof CardGrid<GridCard>>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The search wall: every fixture printing, edge to edge and scrolling.
 *
 * How many fit across is a function of the container and nothing else — `columnsFor` divides the
 * measured width by a 170px floor plus the gap, and `tileWidthFor` then shares the leftover out
 * so the art stays flush to both edges. A fixed width would leave up to one whole tile's worth of
 * empty container down one side, which reads as a rendering fault rather than as a layout. This
 * canvas is capped at 46rem, so resize the Storybook window and the count moves with it.
 *
 * **The tiles are invisible to every `play` on this page**, and it is worth knowing where that
 * comes from. jsdom lays nothing out, so `@tanstack/react-virtual` measures the scroller at 0px
 * and computes an empty window — `CardGrid.test.tsx:72-75` stubs `offsetHeight` and `scrollTo`
 * to get around it, and a story file has no `beforeAll` to put that in, nor any business
 * patching `HTMLElement.prototype` inside the browser Storybook renders in. Measured 2026-08-09
 * with a throwaway spec: this wall renders **0** buttons under Vitest with no stub. So the only
 * `play` here is {@link Empty}'s, whose claim is about the container; everything else on this
 * page is Task 17's to look at.
 */
export const Wall: Story = {};

/**
 * No results — and the wall draws **nothing at all**, not an empty state.
 *
 * What "no cards" means is the page's to say and each caller says something different (a search
 * with no matches, a collection nobody has started, every filter excluding everything), so this
 * component renders its scroller and stops. `SearchPage` and `CollectionPage` both put their own
 * sentence above it.
 */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The wall is a labelled group rather than a list or a table: it is a set of buttons that
    // happen to be laid out in a grid, and calling it a table would promise rows and columns a
    // reader could navigate.
    await expect(canvas.getByRole("group", { name: "Search results" })).toBeInTheDocument();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
    // No tab stop on the scroller either. Every tile is a button, so the box is reachable and
    // scrollable through its own contents, and a stop here would be one more press between the
    // reader and the cards — which an empty wall makes visible as a stop leading to nothing.
    await expect(canvas.getByRole("group")).not.toHaveAttribute("tabindex");
  },
};

/** One match. The tile takes the whole first column and the wall is otherwise empty — the
 *  tiles share out the leftover width, so a single result is one card as wide as a column and
 *  never one card stretched across the wall. */
export const SingleResult: Story = { args: { rows: [BOLT_ALPHA] } };

/**
 * The marks: copies owned, and whether a wish covers the card.
 *
 * `SearchPage` draws `OwnedBadge` **unconditionally** and passes both facts, because the badge
 * is its own guard — on a browse of the whole database almost every tile has nothing to say. The
 * three fixtures that do are named here rather than picked by position: Alpha Lightning Bolt is
 * owned three times, the Double Masters printing is owned once *and* wished for, and the
 * Strixhaven one is wished for and not owned. Every other tile on this wall is handed a badge
 * that renders `null`, which is what `empty:hidden` on the corner turns into no corner at all —
 * without it a wall of unowned tiles was a wall of empty 12×4px chips.
 *
 * `CollectionPage` passes `owned` and no `wishlisted`: that wall shows what is held and has no
 * opinion about what is wanted.
 */
export const WithBadges: Story = {
  args: {
    badge: (card) => (
      <OwnedBadge
        owned={card.id === BOLT_ALPHA.id ? 3 : card.id === BOLT_2X2.id ? 1 : 0}
        wishlisted={card.id === BOLT_2X2.id || card.id === BOLT_STRIXHAVEN.id}
      />
    ),
  },
};

/**
 * Which card the detail pane is about.
 *
 * A **ring**, not an outline: gold says "focus" as an outline everywhere in this app and
 * "state" as a ring, and this one hugs the art rather than standing off it so the wall keeps its
 * rhythm. The badge is a sibling of the button rather than a child for the same family of
 * reasons — inside, its text would join the button's accessible name and a wall of forty cards
 * would be forty buttons called "Lightning Bolt 3 in your collection".
 */
export const Selected: Story = { args: { selectedId: BOLT_ALPHA.id } };

/**
 * A wall whose tiles can be carried to a deck — spec §1's first drag source.
 *
 * The payload is `{ kind: "card" }`, which a zone treats exactly as the deck panel's
 * `"search-card"`: add one copy. The remove tray narrows to `"deck-card"`, so a card from this
 * wall can never draw it.
 *
 * A drag registered here is real pragmatic-drag-and-drop wiring, and the registration sets
 * `draggable="true"` on the tile's root — which is how the component's own suite sees it landed
 * on the right element (`CardGrid.test.tsx`). No `play` asserts it here, because there are no
 * tiles in the DOM to assert it on: see {@link Wall}.
 */
export const Draggable: Story = { args: { dragPayload: tileDrag } };

/**
 * The same wall with the prop left off — which is the collection's card mode, and **a product
 * call rather than a fact about the tiles**.
 *
 * `CardGrid.tsx:136-164` is where that decision is recorded. A collection tile is a *card* —
 * `CollectionPage` sums the entries behind one printing into a single tile, and breaking them
 * apart is the table's job — so a `{ kind: "card" }` payload would be as honest here as it is on
 * the collection *rows* that carry one. What decided it was the enumeration the feature was
 * built from: the drag sources outside the deck editor are the search's tiles, the collection's
 * **table rows**, the pinned wishes and the pane's printings. The day this wall should be one
 * too, it passes the prop and nothing else changes.
 *
 * A wall given no payload registers no drag at all, so there is nothing to see here and that is
 * the point of putting it next to {@link Draggable}.
 */
export const NotDraggable: Story = {};

/**
 * The deck editor's docked search panel, at the width it actually has.
 *
 * 384px (`w-96`) is **331** by the time the panel's own left padding (12), the scrollbar (17)
 * and this wall's own padding (24) are off it — measured at 330 in the running window, and 23
 * short of two of the standard 170px tiles. At the standard floor the column drew one 330×490
 * card per row inside a wall 341px tall: less than a whole card, ever. `DeckSearchPanel.tsx:52`
 * drops the floor to **150**, at which the same 331 is two 159px tiles.
 *
 * A floor, not a width: tiles still share out the leftover, and the `grid` image is 488px wide,
 * so a smaller floor is a deeper downscale and never a blowup.
 *
 * That panel's tiles carry `"search-card"` through the lower-level `tileRef` seam rather than
 * through `dragPayload` — **one or the other, never both**. They do not compose: the tile runs
 * `tileRef` and then registers its own draggable on the *same* element, the library keeps one
 * draggable per element, and a development build logs "You have already registered a
 * `draggable` on the same element" for every tile on the wall.
 */
export const InTheDockedPanel: Story = {
  args: { rows: ALL, minTileWidth: 150 },
  // Width only. A story's own decorators run *inside* the meta's, so this box sits in the
  // 34rem-tall column above and takes its height from it — two nested boxes each setting a
  // height would leave the inner one deciding and the outer one lying.
  decorators: [
    (Story) => (
      <div className="flex min-h-0 w-[331px] flex-1 flex-col">
        <Story />
      </div>
    ),
  ],
};
