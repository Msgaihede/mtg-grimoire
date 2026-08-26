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
 */
function Page({ view }: { view: SearchView }) {
  useState(() => {
    useAppStore.getState().setCollectionView(view);
  });
  return <CollectionPage />;
}

const meta = {
  title: "Collection/Page",
  component: Page,
  tags: ["autodocs"],
  args: { view: "table" },
  // Keyed, so changing the layout in Controls remounts and the initializer above runs again
  // rather than writing to a store the mounted page is already subscribed to.
  render: (args) => <Page key={args.view} {...args} />,
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
          "**The page opens on the copies filed _nowhere_, which is five of those twelve.** The " +
          "root asks `rootOnly` since the Flatten switch landed, where an absent `folderId` used " +
          "to mean every folder — so four rows in the reader's binders and three in two deck " +
          "groups are one press away rather than on screen. That press is {@link Flattened}, " +
          "and the seed is what makes the difference visible: `collection_summary` still reads " +
          "`totalCards: 20` over `entries: 12` when it is asked *nothing*, which is what the " +
          "export dialog's \"ignoring the filters and folders\" offer reaches.\n\n" +
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
 * **The list is the root, and the root is the copies filed nowhere.** Five of the seed's twelve
 * entries: the other seven are in the reader's two binders or in one of two deck groups, and this
 * story asserts one of each is *absent* — Black Lotus sits in `Trade binder` and is the cleanest
 * proof that filing is now doing something. That reverses what this story pinned before the
 * Flatten switch, and the reversal is the requested behaviour rather than a regression:
 * {@link Flattened} is the one press that puts the whole binder back.
 */
export const Default: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The first row in `collection::COLLECTION_DEFAULT_ORDER` — name, then set code, then the
    // collector number cast to an integer — over the five rows the root holds. Named rather than
    // counted: jsdom's viewport is not the app's, so how many rows the virtualiser draws here is
    // an artefact of `src/stories.test.tsx`'s layout stub.
    await expect(await canvas.findByText("Tarmogoyf")).toBeInTheDocument();
    // Filed in `Trade binder`, and therefore not at the root. The one assertion in this file
    // that would go green again if `rootOnly` stopped being sent.
    await expect(canvas.queryByText("Black Lotus")).toBeNull();
    // What assistive tech is told the list is: every matching row plus the header
    // (`VirtualTable.tsx:181`), not the two dozen rows a virtualised table keeps in the DOM.
    // Five unfiled entries, so 6.
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "6",
    );
    await expect(canvas.getByText("To remove an entry, set its copies to zero.")).toBeVisible();
  },
};

/**
 * The same collection with the filing ignored — **every copy at once, wherever it is filed.**
 *
 * This is the other half of the root's new meaning, and the reason the switch exists at all: the
 * root holds the five entries nobody filed, and Flatten is the one press that puts all twelve back
 * on screen, including the three sitting in two decks' groups. It rides the filter bar past the
 * hairline, beside the grid-and-table pair, where every control is about how the list is *drawn*
 * rather than which rows are in it.
 *
 * **What goes with the press is the cabinet's controls** — the folder wall with its `New folder`
 * tile, and the pinned strip of deck groups and `Recently removed`. Nothing is lost by that:
 * those copies are in the list, and each one names its own drawer in the table's Folder column
 * (on the wall it is the tile's caption instead — see the wall's own `captionFor`).
 *
 * **The breadcrumb is the exception, and it survives as a sentence rather than a trail**:
 * `Collection · all folders`, inert, because with every folder on screen there is no level to
 * walk to. It stays because with the wall and the pinned strip gone it is the only thing saying
 * *why* — and because `WishlistBreadcrumb` does exactly this under the same flag, which is what
 * makes the two pages one control rather than two.
 */
export const Flattened: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Urza's Saga")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Flatten" }));

    // The whole seed, and the count is what says so: 12 entries plus the header.
    await waitFor(async () => {
      await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
        "aria-rowcount",
        "13",
      );
    });
    // The card that was filed away, back — and the folder it is in, named on its own row.
    await expect(canvas.getByText("Black Lotus")).toBeInTheDocument();
    // And the cabinet is put away: no drawers to open, no doors into the levels this list is
    // deliberately ignoring.
    await expect(canvas.queryByRole("list", { name: "Folders" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "New folder" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Deck folders" })).toBeNull();
    // **The bar stays, in inert words.** It is the only thing left on screen saying why three
    // bands just went, and `WishlistBreadcrumb` says the same sentence under the same flag.
    const bar = canvas.getByRole("navigation", { name: "Collection folders" });
    await expect(bar).toHaveTextContent(/Collection\s*·\s*all folders/);
    await expect(within(bar).queryByRole("button")).toBeNull();
  },
};

/**
 * The root's five entries as a wall of art — and **not a drag source**.
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
 */
export const CardMode: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("group", { name: "Your collection" })).toBeInTheDocument();
    // A card the root actually holds. Black Lotus stood here until the root started meaning
    // "filed nowhere" — the seed's only copy of one is in `Trade binder`, which {@link Flattened}
    // is the press that reaches.
    await expect(await canvas.findByRole("button", { name: "Urza's Saga" })).toBeInTheDocument();
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
 */
export const Empty: Story = {
  args: { view: "table" },
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
 */
export const EmptyCabinet: Story = {
  args: { view: "table" },
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
  args: { view: "table" },
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
    // The root's unflagged rows are still on screen with it — a flag lists, it does not filter.
    // `Urza's Saga` rather than the `Black Lotus` that stood here: the root is the copies filed
    // nowhere now, and the seed's Lotus is in `Trade binder`.
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
  args: { view: "table" },
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
  args: { view: "table" },
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
 * **It presses Flatten first, and that is a fact about the seed rather than about the stepper.**
 * The row with the acquisition story is filed in `Binder`, so the root — which is now the copies
 * filed nowhere — does not hold it. Flatten is one press and keeps the story pointed at the row
 * whose provenance is the whole argument above; the alternative was to pick a different row and
 * lose it.
 */
export const ZeroDeletesTheRow: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Flatten" }));

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
