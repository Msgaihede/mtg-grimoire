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
    // 0px window. 1032px is exactly the content column at the 1280×800 window
    // `tauri.conf.json:16-17` opens: 1280 less the sidebar's `w-52` (208px) and less `main`'s
    // `p-5` on both sides (40px), from `AppShell.tsx:92` and `AppShell.tsx:144`. The height is
    // chosen rather than derived — the ribbon above it is not a fixed number of pixels.
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
       * (`.storybook/fake/scope.ts`), and 42 of the 50 story files still render inline. This is
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
          "**Quantity 0 keeps the row.** That is the rule this page exists to make visible, and " +
          "{@link ZeroKeepsTheRow} is it: the condition, the purchase price, the tags and the " +
          "acquisition story all survive the day the user owns none of the card, and deleting is " +
          "`collection_remove` and only ever that. The wishlist is the exact opposite by table " +
          "CHECK, and `Wishlist/Page` says so from the other side.\n\n" +
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
 */
export const Default: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The first row in `collection::COLLECTION_DEFAULT_ORDER` — name, then set code, then the
    // collector number cast to an integer. Named rather than counted: jsdom's viewport is not
    // the app's, so how many rows the virtualiser draws here is an artefact of
    // `src/stories.test.tsx`'s layout stub.
    await expect(await canvas.findByText("Black Lotus")).toBeInTheDocument();
    // What assistive tech is told the list is: every matching row plus the header
    // (`VirtualTable.tsx:181`), not the two dozen rows a virtualised table keeps in the DOM.
    // 12 entries, so 13.
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "13",
    );
    await expect(canvas.getByText("To remove an entry, set its copies to zero.")).toBeVisible();
  },
};

/**
 * The same twelve entries as a wall of art — and **not a drag source**.
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
    await expect(await canvas.findByRole("button", { name: "Black Lotus" })).toBeInTheDocument();
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
    // Twelve unflagged rows are still on screen with it — a flag lists, it does not filter.
    await expect(canvas.getByText("Black Lotus")).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole("button", { name: "Show them" }));

    await waitFor(async () => {
      await expect(
        canvas.getByText(/This printing is not in the card database\./),
      ).toBeInTheDocument();
    });
    // The banner is gone, because the list is now the answer to the question it was asking.
    await expect(banner).toBeEmptyDOMElement();
    await expect(canvas.queryByText("Black Lotus")).toBeNull();
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
 * Stepping a row down to zero — **and the row stays.**
 *
 * The clearest demonstration in the app of an asymmetry that is easy to get backwards.
 * `collection_set_quantity(0)` keeps the row with its condition, its purchase price, its tags and
 * its acquisition story (`db.ts:1886-1896`), because the day you own none of a card is not the
 * day the record of having owned it stops mattering. `wishlist_set_quantity(0)` **deletes**
 * (`db.ts:1968-1977`), because a wish for none of something is not a wish.
 *
 * The row chosen is the seeded acquisition story — Alpha Lightning Bolt at Heavily Played, bought
 * from Card Kingdom for $450 in 2021 (`.storybook/fake/seeds.ts:216-223`). None of that is a
 * column in this table; what the table *can* show is that the row is still there, still Heavily
 * Played, and now offering the one control that deletes.
 *
 * That control appearing is the second half of the rule: removal is offered on a row at zero and
 * nowhere else (`CollectionTable.tsx:200`), so a mis-added four-copy row cannot be lost to one
 * click on a list that scrolls under the pointer.
 */
export const ZeroKeepsTheRow: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Quantity of Lightning Bolt (Nonfoil, HP)";
    const box = await canvas.findByRole("spinbutton", { name: label });
    await expect(box).toHaveValue(1);
    // Nothing to remove with, yet.
    await expect(
      canvas.queryByRole("button", {
        name: "Remove Lightning Bolt (Nonfoil, HP) from your collection",
      }),
    ).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: `Decrease ${label}` }));

    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(0);
    });
    // Still a row, still Heavily Played — the stepper is addressed by a name built from the
    // condition, so finding it at all is the claim that the condition survived the write.
    await expect(
      canvas.getByRole("button", {
        name: "Remove Lightning Bolt (Nonfoil, HP) from your collection",
      }),
    ).toBeInTheDocument();
    // And no refusal: this is a successful write, not a tolerated failure.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
