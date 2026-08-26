import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { OwnedBadge } from "@/components/OwnedBadge";
import type { DragPayload } from "@/features/decks/dnd";
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { printing } from "../../../.storybook/fake/fixtures";
import { CardGrid, type GridCard } from "./CardGrid";

/**
 * `GridCard` is the wall's whole contract — five fields, which both `CardSummary` and a mapped
 * `CollectionRow` satisfy structurally. Anything a *particular* wall needs beyond it arrives
 * through the `badge` and `action` slots rather than by widening this shape.
 *
 * The **sixth** field here is not a widening of that contract and must not become one: `CardGrid`
 * is generic over `T extends GridCard`, and `typeLine` is a field the *payload* wants and the
 * wall never draws — which is precisely the case that generic exists for. `SearchPage` hands it
 * a whole `CardSummary` for the same reason. A wall with no type line to give (the collection's
 * card mode) is unaffected, because it passes no `dragPayload` at all.
 */
type StoryCard = GridCard & { typeLine: string | null };

const gridCard = (c: FakeCard): StoryCard => ({
  id: c.id,
  name: c.name,
  setCode: c.setCode,
  collectorNumber: c.collectorNumber,
  rarity: c.rarity,
  typeLine: c.typeLine,
});

/** All 43 fixture printings (`.storybook/fake/cards.ts`), in the order that file lists them. */
const ALL: StoryCard[] = CARDS.map(gridCard);

const BOLT_ALPHA = gridCard(printing("lea", "161"));
const BOLT_2X2 = gridCard(printing("2x2", "117"));
const BOLT_STRIXHAVEN = gridCard(printing("sta", "105"));
/** One of the three fixture cards Wizards named — see {@link GameChangers}. */
const RHYSTIC_STUDY = gridCard(printing("pcy", "45"));

/**
 * Which fixture printings the Commander bracket counts — **derived from the corpus**, never a
 * hand-written list of ids, so a fixture regenerated with a different set of crowns still
 * stories the truth.
 *
 * Module scope for `tileDrag`'s reason: the wall re-registers a tile's drag when a callback it
 * was handed changes identity, and a fresh arrow per render would do that on every scrolled row.
 *
 * `StoryCard` carries no `gameChanger` field of its own on purpose — the wall's slot is a
 * *question asked about a card*, and the collection's wall has no answer to give. `SearchPage`
 * passes the one-line `(card) => card.gameChanger`; a story with no such column looks the id up.
 */
const GAME_CHANGER_IDS = new Set(CARDS.filter((c) => c.gameChanger).map((c) => c.id));
const isGameChanger = (card: StoryCard) => GAME_CHANGER_IDS.has(card.id);

/**
 * `SearchPage`'s own `tileDrag`, verbatim — **at module scope, because it has to hold still**.
 *
 * React detaches and re-runs a callback ref whose identity changed, and this wall re-registers a
 * tile's drag from a `useCallback` that names `dragPayload` among its dependencies. A fresh
 * arrow per render would therefore tear the registration down and rebuild it on every scrolled
 * row — and a source that unregisters mid-drag is a drop that never arrives.
 */
const tileDrag = (card: StoryCard): DragPayload => ({
  kind: "card",
  cardId: card.id,
  name: card.name,
  typeLine: card.typeLine,
});

/**
 * One tile's root element, found by the caption that identifies its printing.
 *
 * By the caption and not by the card's name, because a wall of search results is routinely
 * several printings of one card — four of the first five fixture rows are called "Lightning
 * Bolt" — and not by index either, since a virtualised wall's window depends on the viewport.
 * `SET · number` is the one string on a tile that is unique to the piece of cardboard.
 *
 * The chin's inner `<span>` walks up to the tile's own `<div>`: the tile is
 * `div > (div.relative > button + corner + action strip) + CardChin span > span`, so the
 * nearest `div` ancestor of that inner span is the root.
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
  // Pinned to the row shape these stories actually pass, which is the wall's contract plus the
  // one field a drag payload needs — see {@link StoryCard}. `CardGrid<GridCard>` would type the
  // `dragPayload` slot as taking the bare contract and reject the payload the real search sends.
  component: CardGrid<StoryCard>,
  tags: ["autodocs"],
  args: {
    rows: ALL,
    listKey: "stories",
    // Which of the four card sections this wall is standing in for. Required, and `CardGrid`'s
    // own `zoomSection` doc says why there is no default: three surfaces are this component, and
    // one that had not said which it is would silently share another's zoom. These stories are
    // the **search** wall, so ctrl+wheel in the canvas steps `cardZoom.search` and leaves the
    // collection, the deck editor's docked column and the deck itself alone.
    //
    // {@link InTheDockedPanel} inherits it rather than claiming `deckSearch`, and that is
    // deliberate: it is a story about the tile *floor* at that panel's width, and one story on
    // this page zooming out of step with the six above it would read as the wall rather than as
    // the section.
    zoomSection: "search",
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
          "name is printed on the card. An art crop would need one — and the deck's stack and " +
          "grid views draw whole cards for the same two reasons this wall does, so a reader " +
          "moving between them is looking at the same object.\n\n" +
          "**Seven callbacks keep the wall generic** — `badge`, `topLeft`, `finish`, " +
          "`gameChanger`, `action`, `tileRef` and `dragPayload` — and each is a question the " +
          "caller answers about a card rather than a field on the row, because the search's " +
          "rows and the collection's know different things. The two the stories below lean on " +
          "are `badge`, a mark over the art's bottom-left corner, and `action`, one control in " +
          "a strip over the art's foot; the corner, its felt backing and the `empty:hidden` guard " +
          "belong to the wall, so two views cannot drift into two shades.\n\n" +
          "**`arrowNav` is the one behaviour that is opt-in rather than answered per card.** It " +
          "makes the arrow keys walk the wall and move the *selection* with them, which two of " +
          "the four callers want and two must not have — the printings modal reads left and " +
          "right as a step through a card's printings, and the deck editor's docked column sits " +
          "beside a deck the arrows belong to. Switch the **Art** " +
          "toolbar to Live to see real Scryfall images instead of the offline placeholders.",
      },
    },
  },
} satisfies Meta<typeof CardGrid<StoryCard>>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The search wall: every fixture printing, edge to edge and scrolling.
 *
 * How many fit across is a function of the container and the reader's zoom — `columnsFor` divides
 * the measured width by the drawn tile width plus the gap, and `sideGutterFor` splits whatever is
 * left over either side of the row so the wall stays centred. This canvas is capped at 46rem, so
 * resize the Storybook window and the count moves with it. (The tiles used to *stretch* to fill
 * the row instead; `TILE_BASE_WIDTH` carries the measurement that ended it — flush edges made the
 * drawn size a step function of the column count, so seven of the ten zoom stops moved nothing.)
 *
 * **Tiles are visible to a `play` here, and the column count still is not.** jsdom lays nothing
 * out, so `@tanstack/react-virtual` would measure the scroller at 0px and render no tiles at
 * all; `src/stories.test.tsx`'s `beforeAll` stubs `offsetHeight`/`offsetWidth`/`scrollTo` for
 * every play in the repository. But this wall does not ask the virtualiser how wide it is — it
 * measures its own rows container with `clientWidth` and a `ResizeObserver` (`CardGrid`'s effect
 * over `rowsRef`), and `src/test-setup.ts` stubs `ResizeObserver` to a no-op. So under
 * Vitest the width stays 0, `columnsFor` floors at **one** column, and every tile is
 * `TILE_BASE_WIDTH` wide. Tiles exist to be asserted about; how many fit across is still a claim
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
 * The Commander bracket's crown — the fourth mark a tile can wear, and the one that shares a
 * corner instead of taking one.
 *
 * A tile has three corners spoken for (bottom-left the owned badge, top-left the printing count,
 * top-right the finish chip) and the crown goes in **that same top-right chip**, beside the foil
 * or etched glyph. A boxed "GC" badge — which is what the deck views draw, where a row has a line
 * of text to hang it on — reads as a sticker on a wall of art; at 12px in gold it reads as part
 * of the card.
 *
 * **The picture is decoration and the chin is the statement.** The chip lives inside the
 * tile's button and the whole overlay around it is `aria-hidden`, because any text of its own
 * would join the button's accessible name and make a wall of game changers forty buttons called
 * "… Game changer" — the same trap the owned badge avoids by being a *sibling* of the button.
 * So the tile appends an `sr-only` `, Game changer` to its chin.
 *
 * **The finish word is not there beside it, and the asymmetry is the point.** The chin draws a
 * `FinishMark` of its own whose `aria-label` is the finish's word, so a span saying it again made
 * a foil card announce "Foil" twice. The crown has no such twin — `GameChangerMark` is drawn only
 * inside the `aria-hidden` overlay and the chin has no slot for it — so this span is the only
 * thing that says it, and turning the chip off to fix the duplication would take the crown with
 * it (`FoilOverlay`'s `mark` governs both glyphs).
 *
 * Two rows, both drawn: the wall is virtualised and jsdom lays nothing out, so a play can only
 * reach the first few tiles of a list (`.storybook/CLAUDE.md`'s rule — assert a named row, never
 * a count). Rhystic Study is one of the three fixture cards carrying `gameChanger: true`; the
 * Alpha Bolt beside it is not.
 *
 * **`tileFor` cannot find a crowned tile**, which is why this play reaches for the button's name
 * instead: that helper matches a caption exactly, and a crowned tile's caption is
 * `PCY · 45, Game changer`.
 */
export const GameChangers: Story = {
  args: { rows: [RHYSTIC_STUDY, BOLT_ALPHA], gameChanger: isGameChanger },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const crowned = canvas.getByRole("button", { name: "Rhystic Study" });
    // `hidden: true`: the mark is *in* the accessibility tree only as far as the
    // `aria-hidden` overlay above it allows, which is not at all. Asked for anyway, because
    // "the crown is drawn, over this card and inside this button" is the claim.
    await expect(
      within(crowned).getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).toBeInTheDocument();
    // And the button is still called nothing but the card.
    await expect(crowned).toHaveAccessibleName("Rhystic Study");
    // The words, in the caption beside the set and the number.
    await expect(canvas.getByText(`, ${GAME_CHANGER_LABEL}`)).toHaveClass("sr-only");

    const plain = canvas.getByRole("button", { name: "Lightning Bolt" });
    await expect(
      within(plain).queryByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).toBeNull();
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
 * The arrow keys walking the wall — and **the selection walking with them**.
 *
 * Opt-in, through `arrowNav`, and only the search page and the collection page pass it. Every
 * press calls `onSelect`, which on both of those *is* the store's `selectedCardId` and therefore
 * what the docked card pane reads: the reader asked for the next card to be selected, not merely
 * outlined, and a ring that moved while the pane held still would be a wall with two carets on
 * it. The printings modal draws this same component and must never take the prop — left and
 * right *there* step through a card's printings, and one key cannot mean two things on one
 * screen.
 *
 * Left and right are linear across row boundaries (the last tile of a row steps to the first of
 * the next, because a wall of results is one list that happens to be wrapped); up and down move a
 * whole row; neither end wraps. **None of which this canvas can show under Vitest**, where
 * `ResizeObserver` is a no-op, the wall measures 0px and `columnsFor` floors at one column — so
 * the `play` below asserts only what a single column can answer, and `gridNav.test.ts` holds the
 * grid cases.
 *
 * The caret lands on the tile's **art button**, not on the tile's root: the root is
 * `tabIndex={-1}` so a closing menu can hand focus back to it, and it wears no ring. Both tiles
 * are found here through `data-grid-index` — a tile's absolute place in the list, which is the
 * number every step of a move is keyed off, because selecting a card opens a 384px pane and
 * re-flows the wall to fewer columns as a *result* of the press being handled.
 */
export const ArrowKeys: Story = {
  args: { arrowNav: true },
  play: async ({ canvasElement, args }) => {
    const caretOn = (index: number) =>
      canvasElement.querySelector<HTMLElement>(`[data-grid-index="${index}"] button`);
    const first = caretOn(0);
    await expect(first).not.toBeNull();

    // Placed by hand and checked, rather than typed into: `userEvent.type` focuses whatever
    // element it is handed, so a focus assertion after it passes for the wrong reason.
    first?.focus();
    await expect(first).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    // The printing first, and the row beside it: a tile is not always a printing, so the wall
    // hands the surface both halves of the press.
    await expect(args.onSelect).toHaveBeenLastCalledWith(ALL[1].id, ALL[1]);
    await expect(caretOn(1)).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    await expect(args.onSelect).toHaveBeenLastCalledWith(ALL[0].id, ALL[0]);
    await expect(caretOn(0)).toHaveFocus();
  },
};

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
 * `CardGrid`'s doc on the `dragPayload` prop is where that decision is recorded. A collection
 * tile is a *card* — `CollectionPage` sums the entries behind one printing into a single tile,
 * and breaking them apart is the table's job — so a `{ kind: "card" }` payload would be as
 * honest here as it is on the collection *rows* that carry one. What decided it was the
 * enumeration the feature was built from: the drag sources outside the deck editor are the
 * search's tiles, the collection's **table rows**, the pinned wishes and the pane's printings.
 * The day this wall should be one too, it passes the prop and nothing else changes.
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
    // The longest name in the fixture, drawn in a frame `TILE_BASE_WIDTH` (170px) wide under
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
 * 384px is that panel's **opening** width — the reader may drag its edge — and 384 is **331** by
 * the time the panel's own left padding (12), the scrollbar (17) and this wall's own padding (24)
 * are off it: measured at 330 in the running window, and 23 short of two of the standard 170px
 * tiles. At the standard size the column drew one 330×490 card per row inside a wall 341px tall:
 * less than a whole card, ever. `DeckSearchPanel`'s `TILE_BASE` drops it to **150**, at which the
 * same 331 is two tiles with 19px of gutter split either side.
 *
 * The `grid` image is 488px wide, so a smaller base is a deeper downscale and never a blowup.
 *
 * That panel's tiles carry `"search-card"` through the lower-level `tileRef` seam rather than
 * through `dragPayload` — **one or the other, never both**. They do not compose: the tile runs
 * `tileRef` and then registers its own draggable on the *same* element, the library keeps one
 * draggable per element, and a development build logs "You have already registered a
 * `draggable` on the same element" for every tile on the wall.
 */
export const InTheDockedPanel: Story = {
  args: { rows: ALL, baseTileWidth: 150 },
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
