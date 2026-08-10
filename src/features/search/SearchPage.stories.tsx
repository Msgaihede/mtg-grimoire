import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useAppStore, type SearchView } from "@/lib/store";
import { SearchPage } from "./SearchPage";

/**
 * The page, with the layout the store would be holding when a reader arrives at it.
 *
 * `searchView` lives in the store (`store.ts:120`, where `"grid"` is the app's own default) and
 * `Results` reads it directly, so a story cannot pass it as a prop — it has to be written before
 * the page mounts. `useState`'s lazy initializer is `AppShell.stories.tsx`'s choice for the same
 * problem and for its reason: an effect runs after the first paint, so a table story would render
 * the wall for one frame first.
 *
 * Safe against `preview.tsx`'s decorator, which resets the store wholesale (`world.ts`'s
 * `installWorld`) inside a `useMemo` — that memo runs while the decorator renders, and this
 * component is its child, so the reset has already happened by the time this line does.
 */
function Page({ view }: { view: SearchView }) {
  useState(() => {
    useAppStore.getState().setSearchView(view);
  });
  return <SearchPage />;
}

const meta = {
  title: "Search/Page",
  component: Page,
  tags: ["autodocs"],
  args: { view: "grid" },
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
       * Every story in this file writes `searchView` during render, and the store is a module
       * singleton that `.storybook/` cannot make per-story: zustand's `create` does not expose
       * the initializer it was given, and the store's actions close over that one store's `set`,
       * so a second instance of it would take an edit to `src/lib/store.ts`. Inline, an autodocs
       * page mounts every story at once and the last one to render would own the store for all of
       * them — every story below showing the same view, the same card, the same layout, and
       * reading as a component that ignores its arguments.
       *
       * The fake **backend** needs none of this — a world is per story in-process now
       * (`.storybook/fake/scope.ts`), and 30 of the 34 story files still render inline. This is
       * the four that touch the one global left over.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height (`@storybook/addon-docs`'s `StoryBlockParameters`), so it is this file's
       * own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "680px" },
      description: {
        component:
          "Card search: a filter bar, a count, and every match in one scroll.\n\n" +
          "**The first story file in this project that drives the fake backend end to end.** " +
          "Everything below comes out of `.storybook/fake/`: `useCardSearch` builds a request, " +
          "`ipc.searchCards` goes through the faked `@tauri-apps/api/core`, and " +
          "`db.ts`'s `search_cards` answers it. Nothing here is a hand-written row, so a story " +
          "that disagrees with the app is the app or the fake changing — not a fixture going " +
          "stale.\n\n" +
          "**The corpus is 43 printings and a default search finds 41 of them.** " +
          "`SearchRequest.paperOnly` is omitted-means-true and the fixture holds two digital " +
          "printings (`Black Lotus vma`, `A-Vivi Ornitier fin` — `.storybook/fake/seeds.ts:620` " +
          "names the same two), so every count on this page under the `starter` seed is 41 and " +
          'not 43. Measured 2026-08-10 by calling `readHandlers(seed("starter")).search_cards` ' +
          "with the page's own request.\n\n" +
          "**Two states this page can show have no story here, for two different reasons.** A " +
          "sync in flight is unreachable through the fake at all — its `sync_status` answers " +
          "`syncing: false` and its `sync_run` resolves at once — and nothing on this page reads " +
          "it anyway; the ribbon above does, and it is storied as `Chrome/AppShell`. And the " +
          "**page-load error banner** needs a `search_cards` that throws, which no seed and no " +
          "fault produces: the `busy` fault is honoured by writes only, deliberately, which is " +
          "what {@link Busy} below is about.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A browse of the whole database, as the app opens on it.
 *
 * The wall rather than the table, because that is the store's default (`store.ts:120`) and this
 * is a card app: the table is what a reader switches to when they are comparing prices.
 *
 * The count is the one line that says what the result area is showing, and it is a `role="status"`
 * mounted for the life of the view rather than one that appears with its own text — a live region
 * that arrives already full announces nothing.
 */
export const Default: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("41 cards")).toBeInTheDocument();
    // The first card in `search::ORDER_NAME` — the browse order, which is the card's name and
    // then its newest printing. Named rather than counted: jsdom's viewport is not the app's, so
    // *how many* tiles the virtualiser draws here is an artefact of `src/stories.test.tsx`'s
    // layout stub, while *which card is first* is the backend's answer.
    const first = await canvas.findByRole("button", {
      name: "Agadeem's Awakening // Agadeem, the Undercrypt",
    });
    // **A search tile is a drag source, and that is invisible.** `SearchPage.tsx:322` hands
    // `CardGrid` a `dragPayload`, which makes `cardDraggable` put `draggable="true"` on the
    // tile's wrapper (pragmatic-drag-and-drop's `addAttribute`). The collection's wall is handed
    // no payload and carries no such attribute — `Collection/Page`'s `CardMode` asserts the
    // other half of that pair, and the two claims are only worth anything together.
    await expect(first.closest('[draggable="true"]')).not.toBeNull();
  },
};

/**
 * The same search as five columns of facts.
 *
 * The table is the view for *comparing* — set, type, rarity, price — and a row here is read
 * rather than picked up: `dragPayload` is passed to the wall and to nothing else
 * (`SearchPage.tsx:144-148` says why).
 */
export const TableView: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("41 cards");
    // **What assistive tech is told the list is, which no screenshot shows.** A virtualised
    // table holds a couple of dozen rows in the DOM; `aria-rowcount` is every matching row plus
    // the header (`VirtualTable.tsx:181`), so 41 matches read as 42. Without it a screen reader
    // is told the database holds twenty cards.
    const table = canvas.getByRole("table", { name: "Search results" });
    await expect(table).toHaveAttribute("aria-rowcount", "42");
  },
};

/**
 * A database with nothing in it — the first run, before any sync has finished.
 *
 * The sentence is the point. An unfiltered search asks for everything, so an empty answer to it
 * is a statement about the *database* and not about the query; "No cards match these filters"
 * here would blame the reader for a sync that has not run. `summaryOf` decides between the two on
 * `unfiltered`, and `seed: "empty"` is the only seed whose `cards` table is empty.
 */
export const Empty: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Card database is empty — waiting for the first sync to finish."),
    ).toBeInTheDocument();
  },
};

/**
 * The flagged world, which this page cannot see — and that is the story.
 *
 * `seed: "needsReview"` adds one orphaned row to each of the three user card tables, and **none
 * of them is a card**: an orphan is a row naming an id `cards` has no row for, so it can never
 * come back from a search. `CardSummary` has no `needsReview` field either (`ipc.ts:109-155`),
 * so there is no surface here for a sentence to land on. The two views that do show one are
 * `Collection/Page` and `Wishlist/Page`, where it is a band under the row it belongs to.
 *
 * Kept as a story rather than left out, so that the claim is asserted rather than described: this
 * seed answers the same 41 cards `starter` does (measured 2026-08-10 over both seeds), and if a
 * future seed change makes an orphan visible here, this is where it fails.
 */
export const NeedsReview: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("41 cards")).toBeInTheDocument();
  },
};

/**
 * The database busy finishing a sync — **and the search answering anyway**.
 *
 * This is the whole point of the app's second connection. Reads go through `AppState.db_read`
 * (`SQLITE_OPEN_READ_ONLY`) so a search is not stuck behind an ~80 s ingest, and the fake keeps
 * that asymmetry exactly: `db.ts:1479`'s `BUSY` is raised by `refuseIfBusy` in every write
 * handler and by no read handler at all.
 *
 * So a `busy` story about *this* page is a story about nothing changing. Where the refusal is
 * visible is a write — `Collection/Page`'s `Busy` steps a quantity and gets the sentence back.
 */
export const Busy: Story = {
  args: { view: "grid" },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("41 cards")).toBeInTheDocument();
    // No alert either: the page's `role="alert"` band is for a *failed query*, and nothing here
    // failed.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * 5 243 printings, and a count that stops before it has walked them.
 *
 * The backend counts to `search::TOTAL_CAP` and no further — `db.ts:1201`, 5 000 — because
 * nobody reads the exact size of a 116 k-row browse. Past it the answer carries
 * `totalIsCapped`, and `countOf` (`SearchPage.tsx:222-225`) renders `5,000+ cards`: a floor,
 * which is true, rather than `5,000 cards`, which would not be.
 *
 * Reachable with no interaction at all. The unfiltered browse of this seed is already past the
 * cap — measured 2026-08-10: `total: 5000`, `totalIsCapped: true` — so the plus sign is what the
 * page opens on.
 */
export const Large: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("5,000+ cards")).toBeInTheDocument();
    // The lie the `+` exists to prevent, asserted as absent.
    await expect(canvas.queryByText("5,000 cards")).toBeNull();
  },
};

/**
 * The same cap, seen from the table — where it is also a fact about the ARIA tree.
 *
 * `SearchPage.tsx:360` hands `VirtualTable` a `total` of **`null`** when the count is capped, and
 * `VirtualTable.tsx:181` turns that into `aria-rowcount="-1"` — ARIA's "the total is unknown",
 * which is exactly what a capped count is. 5 001 would be a smaller lie than 20 and still a lie.
 *
 * Invisible on screen, and the only reason this is a story of its own rather than a second
 * assertion on {@link Large}: the two views take different paths to the same number.
 */
export const CappedTotal: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("5,000+ cards");
    const table = canvas.getByRole("table", { name: "Search results" });
    await expect(table).toHaveAttribute("aria-rowcount", "-1");
  },
};

/**
 * Typing until the count is real again.
 *
 * The `+` is not decoration: it is on while the backend stopped counting and off the moment the
 * match set fits under the cap. `Ancient` is one of the 26 adjectives `seeds.ts:543-570` builds
 * the synthetic corpus from, so it names one card in 26 — 201 printings, measured 2026-08-10 —
 * and the caption becomes an exact figure with the `aria-rowcount` to match.
 *
 * The wait is generous because the box is debounced by `DEBOUNCE_MS` (300 ms) before a keystroke
 * becomes a query, which is real time rather than a fake timer.
 */
export const NarrowedToAnExactCount: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("5,000+ cards");

    await userEvent.type(canvas.getByRole("searchbox", { name: "Search cards" }), "Ancient");

    await waitFor(
      async () => {
        await expect(canvas.getByText("201 cards")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    await expect(canvas.getByRole("table", { name: "Search results" })).toHaveAttribute(
      "aria-rowcount",
      "202",
    );
  },
};

/**
 * The `owned` filter, and the one thing about it that is easy to get wrong: **it counts entries,
 * not copies.**
 *
 * `db.ts:1258-1264` mirrors `search.rs` here — the filter asks whether `collection_entries` has a
 * row for the printing, and a row stepped to zero is a row the collection keeps. So Smuggler's
 * Copter passes `owned: true` on the strength of a row holding **no copies at all**
 * (`seeds.ts:254-256`, seeded at quantity 0 with the note that outlived the cards), while
 * `OwnedBadge` draws nothing for it: the badge's own guard is `owned <= 0 && !wishlisted`
 * (`OwnedBadge.tsx:29`).
 *
 * Twelve entries over twelve distinct printings, so the filtered list is twelve rows — measured
 * 2026-08-10. The table rather than the wall, because at jsdom's stubbed viewport the wall's
 * virtualiser draws only the first few tiles and the row this story is about is the eighth.
 */
export const OwnedCountsEntries: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("41 cards");

    await userEvent.click(canvas.getByRole("button", { name: "Owned" }));
    await waitFor(async () => {
      await expect(canvas.getByText("12 cards")).toBeInTheDocument();
    });

    // Listed, with nothing to say about copies. `queryByText` over the row rather than over the
    // canvas: every other row in this list has a badge, and the claim is about this one.
    const zeroRow = canvas.getByText("Smuggler's Copter").closest('[role="row"]');
    await expect(zeroRow).not.toBeNull();
    await expect(within(zeroRow as HTMLElement).queryByText(/in your collection/)).toBeNull();

    // The contrast, one row further down: a printing with copies says how many, and says it
    // where a screen reader can hear it — the visible `×4` is `aria-hidden`.
    const heldRow = canvas.getByText("Urza's Saga").closest('[role="row"]');
    await expect(
      within(heldRow as HTMLElement).getByText("4 in your collection"),
    ).toBeInTheDocument();
  },
};
