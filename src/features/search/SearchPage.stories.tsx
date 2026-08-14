import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { GAME_CHANGER_HINT, GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
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
       * (`.storybook/fake/scope.ts`), and 40 of the 47 story files still render inline. This is
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
          "**The corpus is 43 printings and the caption says 33, down three steps.** " +
          "`SearchRequest.paperOnly` is omitted-means-true and the fixture holds two digital " +
          "printings (`Black Lotus vma`, `A-Vivi Ornitier fin` — `.storybook/fake/seeds.ts:620` " +
          "names the same two), which is **43 → 41**; the search view sends `playableOnly` and " +
          "three paper printings are legal in none of Scryfall's formats, which is **41 → 38** " +
          "({@link Unplayable} is that chip in one row); and the page opens **collapsed**, one " +
          "row per card, where five of the survivors are further printings of a card already in " +
          "the list (four Lightning Bolts, two Sol Rings, two Ancestral Recalls) — **38 → 33**. " +
          "So `33 cards` is what every play below waits for; pressing Unplayable gets 36 and " +
          "All printings asks for the whole 41 ({@link CollapsedPrintings}). Measured " +
          '2026-08-10 by calling `readHandlers(seed("starter")).search_cards` with the page\'s ' +
          "own request, and re-measured 2026-08-14 after the playable filter landed — the two " +
          "middle steps did not exist for the first measurement.\n\n" +
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
    await expect(await canvas.findByText("33 cards")).toBeInTheDocument();
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
 * What the collapse actually does, in one row.
 *
 * Sol Ring is printed twice in this corpus — `sld 913` (2025-12-01) and `c21 263` (2021-04-23)
 * — so collapsed it is **one** row that says `×2 printings` and prices across both. Press All
 * printings and it is two rows, each priced on its own.
 *
 * Three rules are visible here at once. The **representative is the newest printing**, so the
 * set cell reads `SLD · 913` and not the older one. The **count and the range describe what
 * matched**, never the database — filters narrow printings first and the survivors are
 * grouped. And the mark is drawn **only past one printing**: every other row on this page has
 * a single printing and says nothing, because `×1 printings` on 17 588 of 37 553 cards would
 * be a column of noise.
 */
export const CollapsedPrintings: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("33 cards");

    await userEvent.type(canvas.getByRole("searchbox", { name: "Search cards" }), "Sol Ring");

    // Anchored on the card and not on the mark: the box is debounced by `DEBOUNCE_MS`, and
    // the unfiltered list already holds another card with two printings — asserting on the
    // first `×2 printings` in the document raced the query and found Ancestral Recall.
    //
    // The whole check is inside one `waitFor` so it re-reads the row: the results are
    // replaced wholesale when the query lands, and an element captured before that is stale.
    await waitFor(
      async () => {
        const rows = canvas
          .getAllByRole("row")
          .filter((r) => r.textContent?.includes("Sol Ring"));
        await expect(rows).toHaveLength(1);
        // Read off the row's own text rather than through a matcher: the set cell is three
        // text nodes (`SLD`, ` · `, `913`), so a regex spanning the separator matches no
        // single element.
        await expect(rows[0].textContent).toContain("×2 printings");
        // The newest printing represents the card — `search::COLLAPSE_REP`.
        await expect(rows[0].textContent).toContain("SLD");
        await expect(rows[0].textContent).toContain("913");
      },
      { timeout: 5000 },
    );

    await userEvent.click(canvas.getByRole("button", { name: "All printings" }));

    // Two rows now, and neither claims to stand for more than itself.
    await waitFor(async () => {
      await expect(canvas.getAllByText("Sol Ring")).toHaveLength(2);
    });
    await expect(canvas.queryByText(/×\d+ printings/)).toBeNull();
  },
};

/**
 * The cards the search hides, and the chip that asks for them back.
 *
 * **Off is the default, and off means hidden** — which is the whole of what makes this chip
 * worth a story, because a filter that is on before the reader touches anything is otherwise
 * invisible. `playableOnly` narrows to `cards.legal_mask != 0`: legal or restricted in at
 * least one of Scryfall's 23 formats. Three of the fixture's 41 paper printings fail it — the
 * `astx` art card, `Kozilek, Compleated` (a Mystery Booster 2 playtest card) and `Little Girl`
 * (Unhinged) — so the caption steps 33 → 36 on one press.
 *
 * The art card is the case that says why the default is what it is. It is named
 * `Prismatic Ending // Prismatic Ending`, which is the card's name **twice**, and bm25 rewards
 * exactly that — searching for a card returned its own art card above it until
 * `search::non_card_rank` demoted them. This filter is the other half of that fix: ranking
 * decides what comes first, and this decides whether it is there at all.
 *
 * It is drawn beside All printings rather than among the filters because both say what there
 * is to look *through* rather than what to look for — so neither is counted by Reset all, and
 * neither is cleared by it.
 */
export const Unplayable: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("33 cards");

    const chip = canvas.getByRole("button", { name: /^Unplayable/ });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    await canvas.findByText("36 cards");
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // **Named rather than counted, and reached by a search rather than by scrolling.** The
    // table is virtualised and jsdom lays nothing out, so which rows are in the DOM is an
    // artefact of the runner's stub — and the art card is deep in name order. Narrowing to it
    // is the only way to assert *which* three rows arrived.
    await userEvent.type(canvas.getByRole("searchbox", { name: "Search cards" }), "Prismatic");
    await waitFor(
      async () => {
        await expect(canvas.getByText("1 card")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    await expect(canvas.getByText("Prismatic Ending // Prismatic Ending")).toBeInTheDocument();

    // And the other direction, which is the sharper half: the corpus holds **no** ordinary
    // printing of Prismatic Ending, so switching the chip off leaves this search with nothing
    // — and the page says so as a statement about the filters rather than about the database,
    // because the search box is on (`summaryOf`'s `unfiltered` arm).
    await userEvent.click(chip);
    await waitFor(async () => {
      await expect(canvas.getByText("No cards match these filters.")).toBeInTheDocument();
    });
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
    await canvas.findByText("33 cards");
    // **What assistive tech is told the list is, which no screenshot shows.** A virtualised
    // table holds a couple of dozen rows in the DOM; `aria-rowcount` is every matching row plus
    // the header (`VirtualTable.tsx:181`), so 33 matches read as 34. Without it a screen reader
    // is told the database holds twenty cards.
    const table = canvas.getByRole("table", { name: "Search results" });
    await expect(table).toHaveAttribute("aria-rowcount", "34");
  },
};

/**
 * A database with nothing in it — the first run, before any sync has finished.
 *
 * The sentence is the point. An unfiltered search asks for everything, so an empty answer to it
 * is a statement about the *database* and not about the query; "No cards match these filters"
 * here would blame the reader for a sync that has not run. `summaryOf` decides between the two on
 * `unfiltered`, and `seed: "empty"` is the only seed whose `cards` table is empty.
 *
 * **And the filter row above it is fully live**, which is the second claim and the one that
 * had no test. Counted honestly an empty corpus puts every option at zero, the greying rule
 * dims the whole row, and — with no filter on — there is no `Reset all` drawn to escape by:
 * the first screen a new user ever sees would be a dead control panel. So `facets::compute`
 * guards on `ix.all.count() == 0` and answers `ready: false`, the same shape a cold index
 * has, and the fake's `facet_cards` carries the same guard. It went in without one: the fake
 * answered `ready: true` unconditionally, mirroring a `compute` that no longer existed, and
 * this story plus `Decks/SearchPanel` and `Collection/Page` all drew a fully-greyed row the
 * shipped window cannot produce. Nothing went red, because no `play` looked at the row.
 * Verified live 2026-08-11 against a cleared `data/`: 0 of 19 chips greyed for the whole of
 * the opening sync.
 */
export const Empty: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Card database is empty — waiting for the first sync to finish."),
    ).toBeInTheDocument();

    const chips = canvas.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    await expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) await expect(chip).not.toHaveAttribute("aria-disabled");
    // No count in any name either — an empty corpus is "we have not counted", so `facetTitle`
    // is handed nothing and the chips keep the plain labels they had before this feature.
    await expect(canvas.getByRole("button", { name: "White" })).toBeInTheDocument();
    const format = canvas.getByLabelText("Format") as HTMLSelectElement;
    await expect([...format.options].filter((o) => o.disabled)).toHaveLength(0);
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
 * seed answers the same 33 cards `starter` does (measured 2026-08-14 over both seeds), and if a
 * future seed change makes an orphan visible here, this is where it fails.
 */
export const NeedsReview: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("33 cards")).toBeInTheDocument();
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
    await expect(await canvas.findByText("33 cards")).toBeInTheDocument();
    // No alert either: the page's `role="alert"` band is for a *failed query*, and nothing here
    // failed.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * 5 238 printings of 683 cards — and the count that stops before it has walked them.
 *
 * The seed holds 5 243 rows; the two the search never counts are digital, and the three it
 * used to count and no longer does are the printings no format allows (`seeds.ts`'s
 * `LARGE_TEMPLATES`, which is why the synthetic 5 200 are all playable).
 *
 * **This is the story where the collapse pays for itself.** The page opens on one row per
 * card, so the caption is an exact `683 cards`; pressing All printings asks for the printings
 * instead, and *then* the count runs past `search::TOTAL_CAP` (`db.ts`, 5 000) and stops.
 * Past it the answer carries `totalIsCapped`, and `countOf` (`SearchPage.tsx`) renders
 * `5,000+ cards`: a floor, which is true, rather than `5,000 cards`, which would not be.
 *
 * The two captions are the same seed asked two questions, which is the clearest statement of
 * what the toggle does that this file can make.
 */
export const Large: Story = {
  args: { view: "grid" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Collapsed — the default — the whole set fits under the cap and is counted exactly.
    await expect(await canvas.findByText("683 cards")).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "All printings" }));

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
 *
 * All printings is pressed first, because the cap is only reachable over printings now — 683
 * cards fit under it comfortably, and a collapsed table reports an honest `aria-rowcount`.
 */
export const CappedTotal: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Collapsed the count is exact, so the row count is a real number rather than "unknown".
    await canvas.findByText("683 cards");
    await expect(canvas.getByRole("table", { name: "Search results" })).toHaveAttribute(
      "aria-rowcount",
      "684",
    );

    await userEvent.click(canvas.getByRole("button", { name: "All printings" }));

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
    await canvas.findByText("683 cards");
    // Over printings, because that is where the cap lives — see {@link CappedTotal}.
    await userEvent.click(canvas.getByRole("button", { name: "All printings" }));
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
 * Twelve entries over twelve distinct printings — which the collapsed list shows as **nine
 * cards**, because three of those printings are second copies of a card already in it. The
 * filter narrows printings first and the survivors are grouped, so the count answers "how many
 * cards do I have an entry for", which is the question the chip asks. Measured 2026-08-11.
 *
 * The table rather than the wall, because at jsdom's stubbed viewport the wall's virtualiser
 * draws only the first few tiles and the row this story is about is the eighth.
 */
export const OwnedCountsEntries: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("33 cards");

    // A prefix, because the chip's accessible name carries its facet count — "Owned — 9
    // printings" — and the label is what has to come first.
    await userEvent.click(canvas.getByRole("button", { name: /^Owned\b/ }));
    await waitFor(async () => {
      await expect(canvas.getByText("9 cards")).toBeInTheDocument();
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

/**
 * A card the Commander bracket counts, in the cell that identifies its row.
 *
 * The crown sits with the owned badge and the finish mark, because all three are facts about the
 * **card** and the table's other five columns are about the printing. `cards.game_changer` is an
 * oracle-level column, so a collapsed row takes it from its representative printing and no
 * aggregate is needed to make a group agree with itself.
 *
 * Three fixture printings carry it (`.storybook/fake/cards.ts`) and they were chosen to break the
 * obvious guesses: **Ancient Tomb**, a land with no mana cost at all; **Rhystic Study**, printed
 * at `common`; and **Consecrated Sphinx**, a foil-only `special`. It is a property of the card
 * and never of its rarity or its cardboard.
 *
 * Two claims here that a screenshot cannot make. The mark is **named** — a screen reader saying
 * "crown" beside a card would be describing the icon rather than the card — and it carries a
 * `<title>` so a pointer gets the same sentence in words. The table needs no `aria-hidden`
 * workaround for either: that trap belongs to the wall, where the chip sits inside the tile's
 * button ({@link GameChangerOnTheWall}).
 *
 * The wait is generous because the box is debounced by `DEBOUNCE_MS` (300 ms) before a keystroke
 * becomes a query, which is real time rather than a fake timer.
 */
export const GameChangerRow: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("33 cards");

    await userEvent.type(canvas.getByRole("searchbox", { name: "Search cards" }), "Rhystic");

    // The whole check inside one `waitFor`, because the results are replaced wholesale when the
    // query lands and a row captured before that is stale.
    await waitFor(
      async () => {
        const rows = canvas.getAllByRole("row").filter((r) => r.textContent?.includes("Rhystic"));
        await expect(rows).toHaveLength(1);
        await expect(
          within(rows[0]).getByRole("img", { name: GAME_CHANGER_LABEL }),
        ).toBeInTheDocument();
        // The pointer's half of the same fact: a `<title>` inside the glyph, which is what a
        // hover surfaces. `getByTitle` matches an SVG `<title>` element, not the attribute —
        // and the sentence it holds is longer than the name, because a tooltip has room to say
        // what a game changer *is*.
        await expect(within(rows[0]).getByTitle(GAME_CHANGER_HINT)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  },
};

/**
 * The same fact over the art — and the reason the wall states it twice.
 *
 * The crown shares the **top-right chip** with the finish mark rather than taking a corner of its
 * own: a tile's other two are spoken for (bottom-left the owned badge, top-left the printing
 * count), and the deck views' boxed "GC" badge reads as a sticker on a wall of art.
 *
 * That chip is inside the tile's button, and the whole overlay around it is `aria-hidden` — any
 * text of its own would join the button's accessible name and make a wall of game changers forty
 * buttons called "… Game changer". So the picture is decoration and the caption is the statement:
 * the tile appends an `sr-only` `, Game changer` beside the set and number, which is where the
 * finish word already goes. Both halves are asserted here, and so is the button's name.
 */
export const GameChangerOnTheWall: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("33 cards");

    await userEvent.type(canvas.getByRole("searchbox", { name: "Search cards" }), "Rhystic");

    await waitFor(
      async () => {
        const tile = canvas.getByRole("button", { name: "Rhystic Study" });
        // `hidden: true` — the mark is under an `aria-hidden` overlay, which is the point.
        await expect(
          within(tile).getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
        ).toBeInTheDocument();
        await expect(tile).toHaveAccessibleName("Rhystic Study");
        await expect(canvas.getByText(`, ${GAME_CHANGER_LABEL}`)).toHaveClass("sr-only");
      },
      { timeout: 5000 },
    );
  },
};
