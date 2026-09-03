import { useState } from "react";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useAppStore, type SearchView } from "@/lib/store";
import { CollectionPage } from "./CollectionPage";

/**
 * The page, with the layout the store would be holding when a reader arrives at it.
 *
 * `collectionView` lives in the store (`store.ts:124`, where `"table"` is the app's own default —
 * a collection is read for what is *in* it) and `CollectionPage` reads it directly, so a story
 * cannot pass it as a prop. `useState`'s lazy initializer is `AppShell.stories.tsx`'s answer to
 * that and for its reason: an effect runs after the first paint, so a card-mode story would
 * render the table for one frame first.
 *
 * **`"grid"`, not `"card"`.** The store's type is `SearchView = "table" | "grid"`
 * (`store.ts:26`), shared with the search view; "card mode" is what the filter bar's toggle
 * *calls* it — `LayoutToggle`'s two buttons are named "Card view" and "Table view"
 * (`FilterChips.tsx:171-174`).
 *
 * **`flatten` is the second store field a story here has to say out loud, and for a sharper
 * reason than the layout.** It moved out of `useState` and into `collectionFlattened` so that it
 * survives a restart, which makes it a module singleton every story on this page shares — and its
 * default is `true`, so a story that says nothing draws the *flattened* list. That is right for
 * most of them, because it is what the page opens on; it is wrong for the two whose subject is the
 * cabinet, which is not drawn at all while the switch is on. There is no `setCollectionFlattened`
 * to call — the store publishes a **toggle**, because the only sensible write is "the other one" —
 * so the seed is a plain `setState`, which deliberately does not bump `flattenPulse` and so writes
 * nothing back through `useFlattenPersistence` (not that a story mounts `AppShell` to have one).
 */
function Page({ view, flatten }: { view: SearchView; flatten: boolean }) {
  useState(() => {
    useAppStore.getState().setCollectionView(view);
    useAppStore.setState({ collectionFlattened: flatten });
  });
  return <CollectionPage />;
}

const meta = {
  title: "Collection/Page",
  component: Page,
  tags: ["autodocs"],
  // The app's own opening state for both fields — `"table"` is the layout a collection is read
  // in, and `flatten: true` is what a reader meets since the root was narrowed to "filed
  // nowhere". A story that needs the cabinet says so for itself.
  args: { view: "table", flatten: true },
  // Keyed on both, so changing either in Controls remounts and the initializer above runs again
  // rather than writing to a store the mounted page is already subscribed to.
  render: (args) => <Page key={`${args.view}:${String(args.flatten)}`} {...args} />,
  decorators: [
    // The page is `h-full`, so it needs a parent with a height or the virtualiser is handed a
    // 0px window. 1032px is exactly the content column at the app's narrow rung — the 1280-wide
    // window `src-tauri/src/window.rs` opens on a 1080p desk: 1280 less the sidebar's `w-52`
    // (208px) and less `main`'s `p-5` on both sides (40px), from `AppShell.tsx:92` and
    // `AppShell.tsx:144`. The height is chosen rather than derived — the ribbon above it is
    // not a fixed number of pixels.
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`.
       *
       * Every story in this file writes `collectionView` during render, and the store is a module
       * singleton that `.storybook/` cannot make per-story: zustand's `create` does not expose
       * the initializer it was given, and the store's actions close over that one store's `set`,
       * so a second instance of it would take an edit to `src/lib/store.ts`. Inline, an autodocs
       * page mounts every story at once and the last one to render would own the store for all of
       * them — every story below showing the same view, the same card, the same layout, and
       * reading as a component that ignores its arguments.
       *
       * The fake **backend** needs none of this — a world is per story in-process now
       * (`.storybook/fake/scope.ts`), and 43 of the 51 story files still render inline. This is
       * the four that touch the one global left over.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height (`@storybook/addon-docs`'s `StoryBlockParameters`), so it is this file's
       * own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "680px" },
      description: {
        component:
          "What the collection adds up to, what is in it, and the quantities editable in " +
          "place.\n\n" +
          "Driven end to end by `.storybook/fake/`: the header and the list are **two queries " +
          "over the same filters** (`useCollection` keeps the summary on a key with no sort in " +
          "it), both answered by `db.ts`'s `collection_list` and `collection_summary`, and the " +
          "stepper writes through `collection_set_quantity`.\n\n" +
          "**The `starter` seed is 12 entries holding 20 copies**, and the two numbers " +
          "disagreeing is the whole grammar of this view: a row is a *thing owned* — a foil and " +
          "a played nonfoil of one printing are two rows — and one of the twelve holds zero " +
          'copies. Measured 2026-08-10 by calling `readHandlers(seed("starter")).' +
          "collection_summary`: `totalCards: 20`, `uniqueCards: 12`, `entries: 12`.\n\n" +
          "**Quantity 0 deletes the row, and this reverses what this page said until v24.** " +
          "{@link ZeroDeletesTheRow} is it, and carries the argument on both sides: the row's " +
          "condition, purchase price, tags and acquisition story go with it, which is exactly " +
          "what the previous rule was preserving. The collection is now the record of what the " +
          "reader physically has, so a row holding no copies is not a card they have — the same " +
          "answer the wishlist has always given, reached from a different argument.\n\n" +
          "**The seeded zero-copy row above is therefore a state no shipped write can reach.** " +
          "It stays because `collection_update` can still produce one — an edit form sends eight " +
          "fields at once and must not delete its own subject — and it is what the Folder " +
          "column's removal control exists for.\n\n" +
          "**The page opens flattened — every copy, wherever it is filed — and the root it is " +
          "ignoring is five of those twelve.** The root asks `rootOnly` since the Flatten switch " +
          "landed, where an absent `folderId` used to mean every folder; that narrowing is the " +
          "reason the switch defaults **on**, because since schema v25 every card in a deck sits " +
          "in that deck's group folder, and on the maintainer's own database 275 of 275 entries " +
          "are filed in one — an unflattened first launch there draws `Cards 0 · Unique 0` over " +
          "a full binder. So {@link Default} is the flattened list, and {@link TheCabinet} is " +
          "the one press that puts the filing back on screen: four rows in the reader's binders " +
          "and three in two deck groups behind folder cards, five left at the root. The seed is " +
          "what makes the difference visible: `collection_summary` still reads `totalCards: 20` " +
          "over `entries: 12` when it is asked *nothing*, which is what the export dialog's " +
          '"ignoring the filters and folders" offer reaches.\n\n' +
          "**One state has no story: a page-load failure.** The `busy` fault is honoured by " +
          "write handlers only — deliberately, because reads go through a second, read-only " +
          "connection — so no seed or fault makes `collection_list` throw, and the " +
          '`role="status"` line\'s failure branch is unreachable from here. What `busy` *does* ' +
          "reach is {@link Busy}, the refused write.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The collection as a list of entries, which is what it is for.
 *
 * Six columns, and the one below them: "To remove an entry, set its copies to zero." Said once,
 * under the table, rather than forty times beside forty rows — removal is offered on a row at
 * zero and nowhere else (`CollectionTable.tsx:200`), and that is the one thing about this table
 * a reader cannot see.
 *
 * **The list is every copy the reader owns, wherever it is filed — because that is what the page
 * opens on.** `collectionFlattened` starts `true`: the root was narrowed to mean "filed nowhere",
 * and since schema v25 every card in a deck sits in that deck's group, so the unflattened root is
 * a screen a reader with decks would meet empty. All twelve of the seed's entries are here,
 * including the Black Lotus in `Trade binder` and the three in two deck groups, each naming its
 * own drawer in the Folder column.
 *
 * **What the switch takes away with the filing is the cabinet's controls** — the folder wall with
 * its `New folder` tile, and the pinned strip of deck groups and `Recently removed`. Nothing is
 * lost by that: those copies are in the list. {@link TheCabinet} is the one press that puts them
 * back, and it is what pins the root's narrowed meaning.
 *
 * **The breadcrumb is the exception, and it survives as a sentence rather than a trail**:
 * `Collection · all folders`, inert, because with every folder on screen there is no level to
 * walk to. It stays because with the wall and the pinned strip gone it is the only thing saying
 * *why* — and because `WishlistBreadcrumb` does exactly this under the same flag, which is what
 * makes the two pages one control rather than two.
 */
export const Default: Story = {
  args: { view: "table", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The first row in `collection::COLLECTION_DEFAULT_ORDER` — name, then set code, then the
    // collector number cast to an integer. Named rather than counted: jsdom's viewport is not
    // the app's, so how many rows the virtualiser draws here is an artefact of
    // `src/stories.test.tsx`'s layout stub.
    await expect(await canvas.findByText("Tarmogoyf")).toBeInTheDocument();
    // The card filed in `Trade binder`, on screen anyway. The one assertion here that would go
    // red if the page started sending `rootOnly` on the opening read again.
    await expect(canvas.getByText("Black Lotus")).toBeInTheDocument();
    // What assistive tech is told the list is: every matching row plus the header
    // (`VirtualTable.tsx:181`), not the two dozen rows a virtualised table keeps in the DOM.
    // The whole seed, so 12 entries plus the header.
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "13",
    );
    // And no cabinet: no drawers to open, no doors into the levels this list is ignoring.
    await expect(canvas.queryByRole("list", { name: "Folders" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "New folder" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Deck folders" })).toBeNull();
    // **The bar stays, in inert words** — the only thing on screen saying why those three bands
    // are not there, and `WishlistBreadcrumb` says the same sentence under the same flag.
    const bar = canvas.getByRole("navigation", { name: "Collection folders" });
    await expect(bar).toHaveTextContent(/Collection\s*·\s*all folders/);
    await expect(within(bar).queryByRole("button")).toBeNull();
    await expect(canvas.getByText("To remove an entry, set its copies to zero.")).toBeVisible();
  },
};

/**
 * The same collection with its filing back on screen — **the root, and the drawers beside it.**
 *
 * One press of Flatten, in the direction a reader actually presses it: the switch is on when the
 * page opens, so turning it *off* is what asks "where is all this?". What comes back is the whole
 * cabinet — the folder wall with its `New folder` tile as the first card, and the pinned strip of
 * deck groups and `Recently removed`, which are the app's own folders and never join the reader's
 * tree — and the breadcrumb stops being a sentence and becomes a trail.
 *
 * **And the list narrows, which is the half worth a story of its own.** `CollectionQuery.folderId`
 * absent used to mean "every folder"; it is `rootOnly` now, so the root is the copies filed
 * *nowhere* — five of the seed's twelve. The other seven are one folder card away: Black Lotus in
 * `Trade binder`, three more in two decks' groups. That reversal is the requested behaviour rather
 * than a regression, and it is exactly why {@link Default} opens with the switch on.
 *
 * Flatten rides the filter bar past the hairline, beside the grid-and-table pair, where every
 * control is about how the list is *drawn* rather than which rows are in it — and where nothing is
 * counted by the filter badge or cleared by Reset all.
 */
export const TheCabinet: Story = {
  args: { view: "table", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Black Lotus")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Flatten" }));

    // Five unfiled entries plus the header. The count is what says the root narrowed; a named
    // row alone could not tell "filed away" from "scrolled past".
    await waitFor(async () => {
      await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
        "aria-rowcount",
        "6",
      );
    });
    await expect(canvas.queryByText("Black Lotus")).toBeNull();
    // The cabinet, all three bands of it — the reader's own wall with the tile that makes the
    // next drawer, and the two the app owns kept out of that wall in lists of their own.
    const wall = canvas.getByRole("list", { name: "Folders" });
    await expect(within(wall).getByRole("button", { name: "New folder" })).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Deck folders" })).toBeInTheDocument();
    // And the trail is a trail again: `Collection` is somewhere to go, not a word in a sentence.
    const bar = canvas.getByRole("navigation", { name: "Collection folders" });
    await expect(bar).not.toHaveTextContent(/all folders/);
  },
};

/**
 * The same twelve entries as a wall of art — and **a drag source**, which reverses what this
 * story asserted until 2026-08-26.
 *
 * It used to pin the opposite, and the paragraph here argued it: spec §1's card surfaces were the
 * search wall, the collection *table*'s rows, pinned wishes and the card pane's printings, and
 * this wall was deliberately not among them because a tile has no `entryId` — it merges every
 * entry for one printing across finishes, conditions, languages *and folders*, so no single row
 * could be named. That reasoning was right about the payload and wrong about the conclusion: the
 * answer is a payload carrying **all** of them (`collectionTileSource`) and a question to the
 * reader when the art stands for more than one, rather than no gesture at all.
 *
 * The tile still carries the card payload too, which is what keeps it droppable on a deck
 * category and the sidebar's Decks entry exactly as a table row already is — so the attribute
 * below is a claim about both halves at once.
 *
 * A tile is a *card* where a row is an *entry*: a foil and a played nonfoil of one printing are
 * two rows to maintain and one piece of art to look at, so the tile carries the copies of both.
 *
 * **Flattened, like every story here that does not say otherwise** — so this is the wall a reader
 * meets, and each tile carries the drawer its copies are in as its caption (`captionFor`), which
 * is the wall's answer to the table's Folder column. {@link TheCabinet} is the other state, where
 * the wall is five tiles under a row of folder cards.
 */
export const CardMode: Story = {
  args: { view: "grid", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("group", { name: "Your collection" })).toBeInTheDocument();
    // A card the reader filed away, on the wall anyway — the tile-side proof of what the switch
    // does, and the one that would go red if the wall started asking `rootOnly` again.
    //
    // **Early in the alphabet on purpose.** Flattened, this wall is twelve tiles rather than
    // five, and `stories.test.tsx`'s layout stub gives the virtualiser a window that holds about
    // two rows of them — so a card named late in `COLLECTION_DEFAULT_ORDER` is simply not in the
    // DOM, which reads exactly like the filing having eaten it. (`Urza's Saga` stood here and
    // did that.) Name a row, never count them: `.storybook/CLAUDE.md`'s rule.
    await expect(await canvas.findByRole("button", { name: "Black Lotus" })).toBeInTheDocument();
    // And the caption that makes a flattened wall readable: without it a tile is a copy whose
    // drawer the reader cannot see without opening it.
    await expect(canvas.getAllByText("Filed in").length).toBeGreaterThan(0);
    // **Every tile the wall drew, and not a number written down here.** A wall where a single
    // tile registered would pass a spot check while the rest stayed dead, and a literal count is
    // a fact about this fixture that goes stale the day a row is added to it — so the claim is
    // stated over the tiles themselves. `data-grid-index` is `CardGrid`'s own handle on a tile
    // root, which is the element the draggable is registered on.
    //
    // **Asked of the tiles rather than of the canvas, which is newer than it looks.** This
    // counted every `draggable` element on the page until the folder cards above the wall became
    // drag sources of their own — folders can be reordered and re-filed by dragging now — and a
    // canvas-wide count then read those folder cards as unregistered tiles. The honest claim was
    // always *every tile is a handle*, and it is blind to whatever else on the page has learnt to
    // be dragged since.
    //
    // **It reverses what this story asserted before the wall became a drag source at all** —
    // `toHaveLength(0)`, "nothing on this page can be picked up" — which was true when it was
    // written and stopped being true on 2026-08-26. Kept as a note because the two claims are
    // each other's exact opposite, and a reader finding the old sentence in the history should
    // see which one won and why.
    //
    // **The mark is `DND_SOURCE_ATTR` and no longer `draggable="true"`**, which is not a rename
    // for tidiness: `@dnd-kit/dom`'s `PointerSensor` stands down for a press on a *native* HTML5
    // draggable and lets the platform have the gesture, so writing that attribute back would turn
    // every drag in the app off while this assertion went on passing. The card art inside each
    // tile is still `draggable={false}` by `CardImage`'s default — that is what stops the picture
    // stealing the gesture from the tile around it.
    //
    // Spread rather than the raw `NodeList`, which has no `.filter`.
    const tiles = [...canvasElement.querySelectorAll("[data-grid-index]")];
    await expect(tiles.length).toBeGreaterThan(0);
    await expect(tiles.filter((tile) => tile.hasAttribute(DND_SOURCE_ATTR))).toHaveLength(
      tiles.length,
    );
  },
};

/**
 * **The wall maintains quantities too, since issue #284** — a `QuantityStepper` in the strip over
 * the foot of the art, the same slot the search wall's quick-add and the wishlist's pencil ride
 * in, and the same place the deck editor puts a card's stepper. Until it landed, this view could
 * only edit copies in its *table*: the wall was the layout a reader looked at and the table was
 * the one they worked in.
 *
 * It costs the wall no height — the strip is `absolute inset-x-0 bottom-0`, so `tileHeight` is
 * unchanged — and it is revealed on hover **and on focus-within**, never removed from the tab
 * order, because "visible on hover" is not a state a keyboard has.
 *
 * **The number it shows is the tile's sum, which is the same figure `OwnedBadge` draws in the
 * corner** — two numbers six pixels apart disagreeing about one piece of art is not a state this
 * wall may show. A press is therefore a *delta* applied to one addressed row rather than the
 * control's own next value, and the floor is the copies that row cannot reach. On the ordinary
 * single-entry tile — which is every tile in this seed, since no two of its entries share a
 * printing *and* a finish — the two collapse into each other and a press is simply the number.
 *
 * Black Lotus is chosen for two reasons. It is filed in `Trade binder`, so the tile is one the
 * fence has to *allow* rather than one it never had to think about — a stepper here can only be
 * drawn once `collection_folder_list` has answered, since a folder the census has not confirmed
 * is fenced. And it is early in `COLLECTION_DEFAULT_ORDER`: flattened this wall is twelve tiles
 * and `stories.test.tsx`'s layout stub gives the virtualiser about two rows of them, so a card
 * named late is simply not in the DOM — which reads exactly like the control being missing.
 */
export const SteppingFromTheWall: Story = {
  args: { view: "grid", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **`Copies of <card> (<SET> <number>)`, not the table's `Quantity of <card> (Nonfoil, NM)`.**
    // A row names an *entry*, condition and all; a tile names the printing the art is a picture
    // of. The finish rides the same bracket only where the tile wears the mark, and a plain copy
    // draws no chip — so this one ends at the collector number, which is the wall's own nonfoil
    // rule stated in words instead of in a sheen.
    const label = "Copies of Black Lotus (LEA 232)";
    const box = await canvas.findByRole("spinbutton", { name: label });
    await expect(box).toHaveValue(1);

    await userEvent.click(canvas.getByRole("button", { name: `Increase ${label}` }));

    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(2);
    });
    // No refusal: this is a successful write, not a tolerated failure.
    await expect(canvas.queryByRole("alert")).toBeNull();

    // **The printing in that name is load-bearing, and this seed is why.** It puts three Lightning
    // Bolt tiles on one wall — two of them plain, differing only in which cardboard they are — so
    // a name built from the card alone gives two controls one name, on the one surface where the
    // only other thing telling them apart is a picture. Driving the real browser is what found it
    // (2026-09-01): jsdom cannot referee it, because both names are *correct* and merely not
    // unique, and no assertion about one tile can see the other. `getAllByRole` here, then the
    // uniqueness check — a `getBy*` would throw on the duplicate and read as a missing control.
    const bolts = canvas
      .getAllByRole("spinbutton")
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((name) => name.startsWith("Copies of Lightning Bolt"));
    await expect(bolts.length).toBeGreaterThan(1);
    await expect(new Set(bolts).size).toBe(bolts.length);
  },
};

/**
 * **The copies a deck physically holds, and the one tile on this wall with no stepper on it.**
 *
 * Since schema v25 a deck owns whatever its own `kind: "deck"` group holds, so the foil
 * Counterspell here is not spare cardboard filed under a label — it is *in* `Mono-Red Aggro`.
 * Stepping it would change how many copies that deck holds with `deck_cards` never touched, and
 * the deck would go on listing a card whose copies had walked off. The *drag* out of a group is
 * fenced in the backend (`collection_folders::set_entry_folder` answers `ENTRY_IN_A_DECK`);
 * `collection::set_quantity` has no folder fence at all, so the page's own predicate is the whole
 * of the guard on this gesture.
 *
 * **The rule is written positively — the root, or a folder the reader made — and never as a
 * blocklist of the two kinds the app owns.** A fourth `collection_folders.kind` added later is
 * fenced by default under that spelling and permitted by default under the other, and a control
 * that quietly turns itself on for a kind nobody has thought about is the failure worth
 * preventing. `Recently removed` is covered by the same clause without being named in it.
 *
 * **And it is *every* copy behind the art, not any of them.** Flattened, one printing in one
 * finish can stand for a copy in a binder and a copy in a deck's group at once — the control shows
 * the sum, so a stepper there would move a total that is partly the deck's. The drag takes the
 * opposite rule on purpose, because a drag ends in a question (`PickCopies`) and a stepper does
 * not.
 *
 * Black Lotus is the sentinel rather than scenery: the fence fails **closed** while the census is
 * loading, so a bare "no stepper" claim would pass over a page that had simply not answered yet.
 * A stepper on a tile in `Trade binder` can only exist once it has.
 */
export const DeckCopiesAreNotStepped: Story = {
  args: { view: "grid", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The census has answered, so a filed tile is allowed one.
    await expect(
      await canvas.findByRole("spinbutton", { name: "Copies of Black Lotus (LEA 232)" }),
    ).toBeInTheDocument();

    // The tile is a tile — art, badge, menu, drag — and only the control is missing. Named with
    // the finish because this copy is foil and the art wears the chip that says so.
    await expect(canvas.getByRole("button", { name: "Counterspell" })).toBeInTheDocument();
    await expect(
      canvas.queryByRole("spinbutton", { name: /^Copies of Counterspell \(.*Foil\)$/ }),
    ).toBeNull();
  },
};

/**
 * A collection nobody has put anything in yet.
 *
 * "Nothing here yet. Add cards from search, or import a collection file." — a statement about the
 * collection, with somewhere to go. `statusOf` chooses it on `activeCount === 0`; with a filter
 * on, the same empty list says "No cards in your collection match these filters", which is a
 * statement about the filters instead. Blaming the reader for a table nobody has filled would be
 * the one unhelpful thing an empty screen can do.
 *
 * **Flattened, which is what a fresh install actually opens on**, so the sentence above is the
 * first thing that database says to anybody. It is the same sentence either way here — with no
 * folders and nowhere to have drilled into, `statusOf`'s two folder-shaped answers ("the cards
 * below are the drawers", "Nothing filed here yet.") are both off — but the state is written out
 * rather than inherited, because those two answers are exactly what a flattened list must never
 * give and only this story stands where a reader first stands. {@link EmptyCabinet} is the same
 * database with the switch off, where the wall — and the way to make a first folder — is the
 * content.
 */
export const Empty: Story = {
  args: { view: "table", flatten: true },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Nothing here yet. Add cards from search, or import a collection file.",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * **A cabinet nobody has opened yet — and the one tile that opens it.**
 *
 * The wall is drawn over zero folders on purpose, which is what changed when `+ New folder` left
 * the row beside the breadcrumb and became the wall's first tile. Gated on the folder count — the
 * gate that was free while the control sat outside — it would be a trap door: no folder card,
 * therefore no wall, therefore no way to make a first folder, and the cabinet could never be
 * opened by anyone who did not already have one.
 *
 * No breadcrumb, though, and that half is unchanged: a lone inert `Collection` under a ribbon that
 * already says Collection is a subheading repeating its own heading, and there is nowhere for it
 * to lead.
 *
 * The tile is solid-bordered where every folder card is dashed — a dash means *container, not a
 * thing you own*, and this is a button. `NewFolderCard` carries that argument in full.
 *
 * **Pressed, it becomes the field rather than raising one**, which is the whole of what changed on
 * 2026-09-03: the name is typed on the line the folder's name will occupy, inside the same `<li>`,
 * and the strip that used to open under the breadcrumb — an input, `Create folder` and `Cancel` in
 * words, and a line reading *in Collection* — is gone. On a cabinet holding nothing that is also
 * the only tile there is, so this is the one story where the field is the entire wall.
 * {@link NamingAFolder} is the same press with drawers either side of it.
 *
 * **`flatten: false` is load-bearing rather than scenery.** The page opens flattened now, and no
 * wall is drawn at all while it is — so this story would show {@link Empty}'s screen under a
 * heading promising a cabinet, and the trap door this exists to guard would be invisible again.
 */
export const EmptyCabinet: Story = {
  args: { view: "table", flatten: false },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Folders" });

    // Exactly one tile, and it is the one that makes the first folder.
    await expect(within(wall).getAllByRole("listitem")).toHaveLength(1);
    await expect(canvas.queryByRole("navigation", { name: "Collection folders" })).toBeNull();

    await userEvent.click(within(wall).getByRole("button", { name: "New folder" }));

    // The field, **in the tile** — and the tile's button out of the tree rather than beside it.
    // A field back in a strip above the wall would satisfy the first line and neither of the
    // other two.
    const field = await canvas.findByRole("textbox", { name: "New folder name" });
    const tiles = within(wall).getAllByRole("listitem");
    await expect(tiles).toHaveLength(1);
    await expect(field.closest("li")).toBe(tiles[0]);
    await expect(within(wall).queryByRole("button", { name: "New folder" })).toBeNull();
  },
};

/**
 * **The same press with drawers either side of it — the picture the whole arrangement is about.**
 *
 * `Binder` and `Someday` stay folder cards while the first tile is a field, because one field is
 * open at a time across the cabinet and the page owns which. What the eye is meant to check here
 * is that **nothing moved**: the naming tile holds the wall's track and the row's height, and its
 * ✓ / ✕ land in the corner the folder cards beside it give their `⋯`.
 *
 * **Measured 2026-09-03, and not in the shipped window.** Headless Edge (`msedge
 * --headless=new`) over the *built* stylesheet (`dist/assets/*.css` after `npx vite build`), on a
 * `file://` page reproducing this wall's markup at the 1032px content column this file's own
 * decorator uses — the lock-free method this repo falls back on when the app lock is held, which
 * it was for the whole of that session. **Nobody has driven this change in the real WebView2
 * window yet.** With all four states side by side in one row of the
 * `grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2` track (five columns of ~197.6px):
 *
 * - The resting `New folder` tile, the naming tile, a resting folder card and a renaming card all
 *   measure **62px** tall, share the same `top` (30) and the same width (197.59; the resting
 *   folder card reads 197.61, sub-pixel rounding of its own content). A tile becoming a field and
 *   a card becoming a field each keep the track and the row height exactly.
 * - The single-row scroller is **74px** — 62 plus `p-1.5` either side, which is what `max-h-44`
 *   being a ceiling rather than a height means here.
 * - The folder card's `⋯` and both ✓ / ✕ pairs sit at **y = 34**, 4px down from the tile's own
 *   top: `right-1 top-1` resolving against the `<li>`. The pair is **58px** wide (28 + a 2px gap
 *   + 28) against the `⋯`'s 28.
 * - The name stops short of the tick rather than running under it — input right edge **366.19**
 *   against the tick's left edge **371.19** on the naming tile, **777.39** against **782.39** on
 *   the renaming card. The same 5px both times, which is what `pr-[4.125rem]` buys.
 * - The vocabulary rule holds in *computed* style and not only in source: `border-style` is
 *   `solid` on the resting tile and on the naming tile, `dashed` on the resting folder card and
 *   on the renaming card. The create shape stays a control; the rename shape stays a container.
 * - `caret-accent` emits and resolves to the gold `oklch(0.75 0.12 85)`, and `pr-[4.125rem]`
 *   emits `padding-right:4.125rem` — worth confirming only because a mistyped Tailwind arbitrary
 *   value emits no rule at all and nothing goes red for it.
 *
 * **None of that is what the play below asserts**, and it cannot be: `src/stories.test.tsx` runs
 * these plays under jsdom, which lays nothing out. What is checkable there is the *structure* the
 * geometry rests on — the field in the wall, in the tile's own `<li>`, with the drawers beside it
 * left alone — so that is what it checks.
 */
export const NamingAFolder: Story = {
  args: { view: "table", flatten: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = await canvas.findByRole("list", { name: "Folders" });
    // The starter seed's two top-level drawers, plus the tile that makes the next one.
    await expect(within(wall).getAllByRole("listitem")).toHaveLength(3);

    await userEvent.click(within(wall).getByRole("button", { name: "New folder" }));

    const field = await canvas.findByRole("textbox", { name: "New folder name" });
    const tiles = within(wall).getAllByRole("listitem");
    // No thirteenth tile and no reflow: the wall is the same length and the field is the first
    // tile rather than something added to the row.
    await expect(tiles).toHaveLength(3);
    await expect(field.closest("li")).toBe(tiles[0]);
    // And the drawers are still drawers — one field at a time across the cabinet.
    await expect(
      within(tiles[1]).getByRole("button", { name: /^Binder folder/ }),
    ).toBeInTheDocument();
    await expect(
      within(tiles[2]).getByRole("button", { name: /^Someday folder/ }),
    ).toBeInTheDocument();
  },
};

/**
 * One row a sync left a question against — **listed, counted, and asking to be looked at**.
 *
 * `needs_review` is a sentence and not a flag, and non-NULL never means "hidden". The banner is
 * the count and the way to the rows; it is drawn only while there are flagged rows *and* the
 * reader is not already looking at them, which is why pressing "Show them" takes it away
 * (`CollectionPage.tsx:236` — `!== true`, not `!`, because the chip's third state is "the rows
 * nothing flagged").
 *
 * The seeded orphan is a `collection_entries` row naming an id `cards` has no row for, so its
 * name comes back null and the table draws an em dash under the set and collector number the
 * entry recorded at write time — which is the whole reason those three columns are denormalised.
 * The sentence is `reconcile::sweep_orphans`', copied verbatim into `.storybook/fake/seeds.ts:473`.
 */
export const NeedsReview: Story = {
  args: { view: "table", flatten: true },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const banner = await canvas.findByRole("status", { name: "Needs review" });
    // Singular, because one row is flagged: "entries name" under a count of 1 is the kind of
    // wrongness a reader notices and a test does not.
    //
    // Written without a space after the colon, which is what the DOM really holds: the gap the
    // reader sees is the label's `mr-1` margin, not a character, so anything reading text
    // content — this assertion, a screen reader, a copy-paste — gets "Needs review:1". Measured
    // rather than assumed; the obvious spelling of this expectation fails.
    await expect(banner).toHaveTextContent(
      "Needs review:1 entry names a printing that changed or left the card database.",
    );
    // The unflagged rows are still on screen with it — a flag lists, it does not filter. Read
    // over the flattened list this page opens on, so "still on screen" means the whole
    // collection rather than one level of it.
    await expect(canvas.getByText("Urza's Saga")).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole("button", { name: "Show them" }));

    await waitFor(async () => {
      await expect(
        canvas.getByText(/This printing is not in the card database\./),
      ).toBeInTheDocument();
    });
    // The banner is gone, because the list is now the answer to the question it was asking.
    await expect(banner).toBeEmptyDOMElement();
    await expect(canvas.queryByText("Urza's Saga")).toBeNull();
  },
};

/**
 * Six hundred entries, which is what the virtualiser is for.
 *
 * `useCollection` pages at 100 (`COLLECTION_PAGE_SIZE`) and `VirtualTable` asks for the next page
 * from the virtualiser's own window rather than from a scroll handler, so this is the seed where
 * that machinery is doing work rather than rendering every row it was given. The count is exact —
 * a collection is counted in full, unlike the search's, which stops at 5 000.
 *
 * Measured 2026-08-10 over `readHandlers(seed("large"))`: `collection_list` answers
 * `total: 600` with 100 items in the first page, and `collection_summary` reads
 * `totalCards: 1500` over `entries: 600`.
 */
export const Large: Story = {
  // Flattened, as the page opens: `largeSeed` files nothing, so the root and the flat list are
  // the same 600 rows here — which is the point worth stating, because it is what makes the
  // count below a claim about the virtualiser rather than about the cabinet.
  args: { view: "table", flatten: true },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Ancient Aegis")).toBeInTheDocument();
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "601",
    );
  },
};

/**
 * A write the database refused, said where the writing happened.
 *
 * `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the list underneath is untouched and
 * still counting twelve. The alert is a `role="alert"` of its own rather than a line folded into
 * the status above it: that one describes the list, and this one describes something the reader
 * just did to it.
 *
 * The stepper is optimistic on the row's own number, so this also exercises the rollback —
 * `onError` restores the snapshot `onMutate` took, and the box goes back to 4.
 */
export const Busy: Story = {
  args: { view: "table", flatten: true },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Four Double Masters 2022 Bolts. Named by finish and condition as well as by card, because
    // two entries for one printing differ only there — which is exactly why the stepper's
    // accessible name carries all three.
    const label = "Quantity of Lightning Bolt (Nonfoil, NM)";
    const decrease = await canvas.findByRole("button", { name: `Decrease ${label}` });
    await userEvent.click(decrease);

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change your collection — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // Rolled back, not left showing the 3 the press guessed at.
    await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(4);
  },
};

/**
 * Stepping a row down to zero — **and the row goes.**
 *
 * This story asserted the opposite until schema v24, and the reversal is recorded here rather
 * than quietly rewritten, because the old rule was argued for and this is where it was argued.
 * `collection_set_quantity(0)` used to keep the row with its condition, its purchase price, its
 * tags and its acquisition story, on the reasoning that the day you own none of a card is not the
 * day the record of having owned it stops mattering. It now **deletes**, matching
 * `wishlist_set_quantity(0)`: the collection is the record of what you physically have, and a row
 * holding no copies is not a card you have.
 *
 * **The cost is real and was accepted deliberately.** The row chosen is the seeded acquisition
 * story — Alpha Lightning Bolt at Heavily Played, bought from Card Kingdom for $450 in 2021
 * (`.storybook/fake/seeds.ts`) — and stepping it to zero takes the condition, the
 * `conditionOriginal`, the purchase price and currency, the acquired-at date, the source, the
 * notes and the tags with it. That is precisely what the previous rule was preserving.
 *
 * **What this play is really guarding.** The row is deleted in the database either way; the bug
 * worth a story is the row that stays on *screen* after it is gone — a ghost whose `+` answers
 * "that row is gone", with the header disagreeing with the list beside it. That is what shipped
 * for a few hours in this PR, because `setQuantity`'s handler ignored `change.removed` while
 * `settle()` deliberately skips re-reading the list. jsdom unit tests could not catch it: they
 * mocked `{ quantity: 0, removed: false }`, a response the backend can no longer produce.
 *
 * **It needs the flattened list, and that is a fact about the seed rather than about the stepper.**
 * The row with the acquisition story is filed in `Binder`, so the root — which is now the copies
 * filed nowhere — does not hold it. It used to press Flatten to get there; the switch defaults on
 * since it moved into the store, so the story simply says which state it needs and the play is one
 * gesture again — the press it is about. The alternative was to pick a different row and lose the
 * provenance the whole argument above rests on.
 */
export const ZeroDeletesTheRow: Story = {
  args: { view: "table", flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Quantity of Lightning Bolt (Nonfoil, HP)";
    const box = await canvas.findByRole("spinbutton", { name: label });
    await expect(box).toHaveValue(1);

    await userEvent.click(canvas.getByRole("button", { name: `Decrease ${label}` }));

    // The row leaves the list. Addressed by a name built from its condition, so its absence is
    // a claim about this row and not merely about some row.
    await waitFor(async () => {
      await expect(canvas.queryByRole("spinbutton", { name: label })).toBeNull();
    });
    // And no removal control lingers for a row that is not there.
    await expect(
      canvas.queryByRole("button", {
        name: "Remove Lightning Bolt (Nonfoil, HP) from your collection",
      }),
    ).toBeNull();
    // No refusal: this is a successful write, not a tolerated failure.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
