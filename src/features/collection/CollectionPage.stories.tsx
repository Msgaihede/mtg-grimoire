import { useState } from "react";
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
 * The whole collection as a wall of art — and **not a drag source**.
 *
 * Spec §1's card surfaces are the search wall, the collection *table*'s rows, pinned wishes and
 * the card pane's printings. This wall is not among them: `CollectionPage.tsx:291-304` hands
 * `CardGrid` rows, a label, a selection and a badge, and no `dragPayload` — so `cardDraggable`
 * is never attached and pragmatic-drag-and-drop never writes its `draggable="true"`. The pair of
 * claims only means anything together, so `Search/Page`'s `Default` asserts that the search wall
 * *does* carry the attribute.
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
    // Nothing on this page can be picked up. Over the whole canvas rather than one tile: the
    // claim is that the wall registered no draggable at all, and a single tile could pass while
    // the rest did not. The card art is `draggable={false}` and so is not matched here.
    await expect(canvasElement.querySelectorAll('[draggable="true"]')).toHaveLength(0);
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

    // The naming field, and the sentence that says where the folder will land — which is the
    // whole of what a reader who cannot see which level the strip is drawn over is owed.
    await expect(
      await canvas.findByRole("textbox", { name: "New folder name" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("in Collection")).toBeInTheDocument();
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
