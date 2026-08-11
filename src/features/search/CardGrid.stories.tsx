import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, within } from "storybook/test";
import { OwnedBadge } from "@/components/OwnedBadge";
import type { DragPayload } from "@/features/decks/dnd";
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { printing } from "../../../.storybook/fake/fixtures";
import { CardGrid, type GridCard } from "./CardGrid";

/** `GridCard` is the wall's whole contract — five fields, which both `CardSummary` and a mapped
 *  `CollectionRow` satisfy structurally. Anything a *particular* wall needs beyond it arrives
 *  through the `badge` and `action` slots rather than by widening this shape. */
const gridCard = (c: FakeCard): GridCard => ({
  id: c.id,
  name: c.name,
  setCode: c.setCode,
  collectorNumber: c.collectorNumber,
  rarity: c.rarity,
});

/** All 43 fixture printings (`.storybook/fake/cards.ts`), in the order that file lists them. */
const ALL: GridCard[] = CARDS.map(gridCard);

const BOLT_ALPHA = gridCard(printing("lea", "161"));
const BOLT_2X2 = gridCard(printing("2x2", "117"));
const BOLT_STRIXHAVEN = gridCard(printing("sta", "105"));

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

/**
 * One tile's root element, found by the caption that identifies its printing.
 *
 * By the caption and not by the card's name, because a wall of search results is routinely
 * several printings of one card — four of the first five fixture rows are called "Lightning
 * Bolt" — and not by index either, since a virtualised wall's window depends on the viewport.
 * `SET · number` is the one string on a tile that is unique to the piece of cardboard.
 *
 * The caption's inner `<span>` walks up to the tile's own `<div>`: the tile is
 * `div > (div.relative > button + corner) + caption span > span`, so the nearest `div`
 * ancestor of that inner span is the root.
 */
function tileFor(canvasElement: HTMLElement, caption: string): HTMLElement {
  const tile = within(canvasElement).getByText(caption).closest("div");
  if (!tile) throw new Error(`No tile captioned ${caption}`);
  return tile;
}

/**
 * The mark over a tile's bottom-left corner — the button's own next sibling.
 *
 * The corner and the felt behind it belong to the **wall** rather than to the mark (a mark sits
 * on a photograph, so it needs something behind it to be readable at all), which is why it is a
 * sibling to find rather than something a badge renders.
 */
function cornerOf(tile: HTMLElement): Element | null {
  return within(tile).getByRole("button").nextElementSibling;
}

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
          "why the deck views' art, which *is* a crop, always sits beside the card's name " +
          "rather than alone.\n\n" +
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
 * **Tiles are visible to a `play` here, and the column count still is not.** jsdom lays nothing
 * out, so `@tanstack/react-virtual` would measure the scroller at 0px and render no tiles at
 * all; `src/stories.test.tsx`'s `beforeAll` stubs `offsetHeight`/`offsetWidth`/`scrollTo` for
 * every play in the repository. But this wall does not ask the virtualiser how wide it is — it
 * measures its own rows container with `clientWidth` and a `ResizeObserver`
 * (`CardGrid.tsx:191-198`), and `src/test-setup.ts` stubs `ResizeObserver` to a no-op. So under
 * Vitest the width stays 0, `columnsFor` floors at **one** column, and every tile is
 * `TILE_MIN_WIDTH` wide. Tiles exist to be asserted about; how many fit across is still a claim
 * only a browser can settle, which is why {@link InTheDockedPanel} — the one story on this page
 * that is *about* the column count — carries no `play`.
 */
export const Wall: Story = {
  play: async ({ canvasElement }) => {
    // The top tile, reached through the one thing that identifies a *printing* — four of the
    // first five fixture cards are called "Lightning Bolt", so the caption is the handle and
    // the name is not.
    const tile = tileFor(canvasElement, "LEA · 161");
    const button = within(tile).getByRole("button");
    // The name is the button's whole accessible name, and it comes from the art's `alt`: this
    // string is what a screen reader announces *and* what shows when a fetch fails, and both
    // readers want the card rather than the words "card image".
    await expect(button).toHaveAccessibleName("Lightning Bolt");
    // `draggable={false}` on the picture, always, whether or not the tile is a drag source: an
    // `<img>` is draggable by default and a browser picks the *nearest* draggable ancestor, so
    // the art would start a drag of itself and the tile's own would never begin.
    await expect(button.querySelector("img")).toHaveAttribute("draggable", "false");
  },
};

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
  play: async ({ canvasElement }) => {
    // Both facts reach a screen reader as words rather than as a shape: `×3` is `aria-hidden`
    // and the heart is an icon, so the badge carries an `sr-only` sentence for each. Read off
    // the tiles they belong to, because two of the five printings on this wall are wished for.
    const both = tileFor(canvasElement, "2X2 · 117");
    await expect(within(both).getByText("1 in your collection")).toBeInTheDocument();
    await expect(within(both).getByText("On your wishlist")).toBeInTheDocument();
    // Wished for and not owned — the badge draws the half it has and nothing standing in for
    // the half it does not. A `×0` beside the heart would be a count nobody asked for.
    const wishedOnly = tileFor(canvasElement, "STA · 105");
    await expect(within(wishedOnly).getByText("On your wishlist")).toBeInTheDocument();
    await expect(within(wishedOnly).queryByText(/in your collection$/)).toBeNull();

    const owned = tileFor(canvasElement, "LEA · 161");
    await expect(within(owned).getByText("3 in your collection")).toBeInTheDocument();
    // **And none of it is in the tile's name.** The badge is a *sibling* of the button rather
    // than a child, so a wall of forty cards is forty buttons called "Lightning Bolt" and not
    // forty called "Lightning Bolt 3 in your collection".
    await expect(within(owned).getByRole("button")).toHaveAccessibleName("Lightning Bolt");
    await expect(cornerOf(owned)).toHaveTextContent("3 in your collection");

    // `empty:hidden`, which is what makes "a mark with nothing to say draws nothing" true.
    // `OwnedBadge` guards *itself* and returns `null`, but React has no way to ask an element
    // what it will render — so the corner is built either way and the CSS is what removes it.
    // Before that guard existed, a wall of unowned tiles was a wall of empty 12×4px chips.
    // The Secret Lair Bolt is the tile this story's callback gives no copies and no wish.
    await expect(cornerOf(tileFor(canvasElement, "SLD · 1638"))).toBeEmptyDOMElement();
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
 * The payload is `{ kind: "card" }`, which a category treats exactly as the deck panel's
 * `"search-card"`: add one copy. The remove tray narrows to `"deck-card"`, so a card from this
 * wall can never draw it.
 *
 * A drag registered here is real pragmatic-drag-and-drop wiring, and the registration sets
 * `draggable="true"` on the tile's root — which is how the component's own suite sees it landed
 * on the right element, and what the `play` reads here.
 */
export const Draggable: Story = {
  args: { dragPayload: tileDrag },
  play: async ({ canvasElement }) => {
    const tile = tileFor(canvasElement, "LEA · 161");
    // The **root** carries it, not the art: the whole tile is the handle. Asserted through
    // `closest` from the button rather than on `tile` directly, so this still holds if the
    // registration ever moves to a wrapper.
    await expect(within(tile).getByRole("button").closest('[draggable="true"]')).not.toBeNull();
  },
};

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
 * the point of putting it next to {@link Draggable}. Which also makes it the one state on this
 * page that a screenshot cannot tell from {@link Wall} at all, and the `play` is the whole of
 * the difference.
 */
export const NotDraggable: Story = {
  play: async ({ canvasElement }) => {
    const tile = tileFor(canvasElement, "LEA · 161");
    await expect(within(tile).getByRole("button").closest('[draggable="true"]')).toBeNull();
    // The art still says `draggable="false"` — that one is the component's own, unconditional,
    // and unrelated to whether the tile is a source. Named here so the assertion above is
    // understood as "no registration", not "nothing in this tile mentions dragging".
    await expect(tile.querySelector("img")).toHaveAttribute("draggable", "false");
  },
};

/**
 * A tile whose picture never arrived: the card's **name** in the frame, and what is being done
 * about it underneath.
 *
 * A tile with no art is still a card. The name is what the reader came for and it is known
 * without the image, so a rate-limited screen reads as a list of cards rather than a wall of
 * broken-image icons. `line-clamp-3` is the cap — the frame is 170px at its narrowest and an
 * unbounded name would push the "Retrying…" line out of it.
 *
 * **The error is fired rather than provoked**, because nothing here can fail on its own: the
 * fake's `cardImageUrl` answers every id — including ids in no fixture row — with a synthetic
 * data URI, and a data URI needs no network. `Card/PrintingPreview`'s story of the same name
 * does it the same way, over the frame that has no sentence to change.
 *
 * **The word is "Retrying…", not "No image", and only one of the two is reachable here.**
 * `useImageRetry` answers the first error with `src: null` and a scheduled retry, so `retrying`
 * is true and the tile says so. `failed` — which is what prints "No image" — needs the retry
 * budget spent: two attempts on a doubling delay from a 30 s floor (`IMAGE_RETRY_FLOOR_MS`), so
 * a minute and a half away, which neither a `play` nor a reader is going to wait for. That
 * second word is Task 17's, and only with a real rate limit behind it.
 */
export const AfterAFailedFetch: Story = {
  args: { rows: ALL.slice(0, 4) },
  play: async ({ canvasElement }) => {
    const tile = tileFor(canvasElement, "LEA · 161");
    const art = within(tile).getByRole("button").querySelector("img");
    await expect(art).not.toBeNull();
    fireEvent.error(art as HTMLImageElement);
    // The `<img>` is **unmounted**, not left on screen holding a URL that has already failed —
    // which is the whole shape of `useImageRetry`'s contract: `src ? <img/> : <fallback/>`.
    await expect(within(tile).getByRole("button").querySelector("img")).toBeNull();
    await expect(tile).toHaveTextContent("Lightning Bolt");
    await expect(within(tile).getByText("Retrying…")).toBeInTheDocument();
    // The other three tiles are untouched: one frame's failure is one frame's, and the hook's
    // state resets on a new `src` rather than being shared across the wall.
    await expect(tileFor(canvasElement, "2X2 · 117").querySelector("img")).not.toBeNull();
  },
};

/**
 * The longest names in the corpus, in the one place a tile ever draws a card's name.
 *
 * **A healthy tile draws no name at all** — the art is the button and the caption is
 * `SET · number` — so this state exists only behind a failed fetch, which is why the `play`
 * fires one on every tile. That is not a contrivance: it is the only screen on which a long
 * name can overflow anything here, and `line-clamp-3` is the cap that was chosen for it.
 *
 * The four rows are the four longest names in `.storybook/fake/cards.ts`, measured 2026-08-09:
 * `Agadeem's Awakening // Agadeem, the Undercrypt` at **46** characters,
 * `Delver of Secrets // Insectile Aberration` at 41, `Prismatic Ending // Prismatic Ending` at
 * 36, and `Bonecrusher Giant // Stomp` at 26. All four carry a `//`, which is not a coincidence
 * — a `//` name is two names and a separator — and their four layouts are all different
 * (`modal_dfc`, `transform`, `art_series`, `adventure`), so the length comes from the naming
 * convention rather than from any one kind of card.
 */
export const LongNames: Story = {
  args: {
    rows: [
      gridCard(printing("znr", "90")),
      gridCard(printing("isd", "51")),
      gridCard(printing("amh2", "5s")),
      gridCard(printing("eld", "115")),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const art of canvasElement.querySelectorAll("img")) fireEvent.error(art);
    // The longest name in the fixture, drawn in a frame `TILE_MIN_WIDTH` (170px) wide under
    // Vitest. Whether three lines hold it is a question for a browser — `line-clamp` is CSS,
    // and jsdom applies none — so what is pinned here is that the name is *drawn* rather than
    // dropped, and that the cap is on the element that carries it.
    const name = canvas.getByText("Agadeem's Awakening // Agadeem, the Undercrypt");
    await expect(name).toHaveClass("line-clamp-3");
    await expect(canvas.getByText("Delver of Secrets // Insectile Aberration")).toBeInTheDocument();
  },
};

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
