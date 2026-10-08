import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import { ipc } from "@/lib/ipc";
import { useAppStore, type SearchView } from "@/lib/store";
import { WishlistPage } from "./WishlistPage";

/**
 * The page, with the layout the store would be holding when a reader arrives at it.
 *
 * `wishlistView` lives in the store and `WishlistPage` reads it directly, so a story cannot pass it
 * as a prop. `useState`'s lazy initializer is `CollectionPage.stories.tsx`'s answer: an effect runs
 * after the first paint, so a table story would render the wall for one frame first.
 */
function Page({ view }: { view: SearchView }) {
  useState(() => useAppStore.getState().setWishlistView(view));
  return <WishlistPage />;
}

/**
 * The page over a world a story changed first, **through the commands** — `DecksPage.stories.tsx`'s
 * `OrphanedCover`, for its reasons: it runs once, it is cached in the story's own client, and
 * `staleTime: Infinity` keeps a window refocus from staging again. `open` hands the page a folder to
 * open on its way in (`store.ts`'s `pendingFolder`), so a story about a deep level starts there
 * rather than scrolling a virtualised wall to reach it.
 */
function Staged({
  view,
  stageKey,
  stage,
  open = false,
}: {
  view: SearchView;
  stageKey: string;
  stage: () => Promise<number>;
  open?: boolean;
}) {
  useState(() => useAppStore.getState().setWishlistView(view));
  const staged = useQuery({ queryKey: ["story", stageKey], queryFn: stage, staleTime: Infinity });
  if (!staged.isSuccess) return null;
  return open ? <OpenedAt folderId={staged.data} /> : <WishlistPage />;
}

function OpenedAt({ folderId }: { folderId: number }) {
  useState(() => useAppStore.setState({ pendingFolder: { scope: "wishlist", id: folderId } }));
  return <WishlistPage />;
}

/** Every loose wish filed into `Ordered` — the headline case (spec §1). Returns how many moved. */
async function fileEverything(): Promise<number> {
  // No `shelves` and no `folderId`: the root read, today's behaviour byte for byte.
  const loose = await ipc.wishlistList({ limit: 500, offset: 0 });
  for (const wish of loose.items) await ipc.wishlistSetFolder(wish.id, 1);
  return loose.items.length;
}

/** `Someday`'s id, read off the seeded folder list rather than written down — nothing moves. */
async function somedayId(): Promise<number> {
  const someday = (await ipc.wishlistFolderList()).find((folder) => folder.name === "Someday");
  if (someday === undefined) throw new Error("the starter seed has no Someday folder");
  return someday.id;
}

/** Six folders nested under `Someday`, one loose wish filed at the bottom; returns `Lands`, the
 *  level the story opens on — five headings deep from there, past the three-level indent cap. */
async function nestSixDeep(): Promise<number> {
  const lands = await ipc.wishlistFolderCreate(3, "Lands");
  let parent = lands.id;
  for (const name of ["Fetchlands", "Foils", "Showcase", "Japanese", "Signed"]) {
    parent = (await ipc.wishlistFolderCreate(parent, name)).id;
  }
  const loose = await ipc.wishlistList({ limit: 1, offset: 0 });
  await ipc.wishlistSetFolder(loose.items[0].id, parent);
  return lands.id;
}

const meta = {
  title: "Wishlist/Page",
  component: Page,
  tags: ["autodocs"],
  // The app's own opening state: the wall.
  args: { view: "grid" },
  // Keyed on the view, so changing it in Controls remounts and the initializer above runs again.
  render: (args) => <Page key={args.view} {...args} />,
  decorators: [
    // **This box stands in for `AppShell`'s `main`, and since 2026-09-08 the `overflow-auto` is
    // the load-bearing half of it.** In table view the page is `h-full`, so it needs a parent with
    // a height or the virtualiser is handed a 0px window; in grid view the wall takes `CardGrid`'s
    // `grow` (through `WishlistGrid`), is as tall as its rows, and asks the nearest *scrolling*
    // ancestor to scroll them — which in the app is `main` and here is this. Without the class the
    // walk finds nothing, falls back to the wall itself, and the story draws every row of the
    // fixture in a box that overflows its own frame. `relative` is the rule that goes with any
    // `overflow` in this app (`packages/ui/CLAUDE.md`): a scroll container has to be the containing block
    // for its own absolutely positioned content.
    //
    // 1032px is the content column at a **1280-wide** window: 1280 less the sidebar's `w-52`
    // (208px) and less `main`'s `p-5` on both sides (40px). Not the window `tauri.conf.json`
    // opens — that one is wider, and a story drawn at it would never show the wall at the width
    // the app's 1024px floor says it has to survive. The height is chosen rather than derived: the
    // ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="relative h-[640px] w-[1032px] overflow-auto">
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
       * Every story in this file writes `wishlistView` during render, and the store is a module
       * singleton that `.storybook/` cannot make per-story. Inline, an autodocs page mounts every
       * story at once and the last one to render would own the store for all of them — every
       * story below showing the same layout, and reading as a component that ignores its
       * arguments. `CollectionPage.stories.tsx` carries the long form of this note.
       */
      story: { inline: false, height: "680px" },
      description: {
        component:
          "The thin mirror of the collection: a shopping list, not an inventory — drawn as a " +
          "wall of art or as a table, and **it opens on the wall**, which is where it agrees " +
          "with the search rather than with the collection. These are cards the reader does not " +
          "have yet and may never have held, so the picture is how you recognise the thing you " +
          "are about to buy; the table is a press away for the trip where the question is what " +
          "it all costs.\n\n" +
          "Driven end to end by `packages/fake/`. `starterWishes` seeds **eight wishes: five " +
          "loose at the root and three filed into the three folders of `starterWishFolders`** " +
          "— so every story here opens on the root's **shelves**: the five loose under **Not " +
          "sorted**, the filed three under their folders' headings ({@link Shelves}), and deck " +
          "4's list shut under **Managed by decks** ({@link ManagedWishlist}).\n\n" +
          "**The five at the root are five different answers to “is this filled?”**, and every " +
          "one of them is arithmetic the fake really does rather than a number written into a " +
          "fixture — `wishlist::OWNED_SQL` is mirrored by `db.ts`'s `ownedAgainstWish`. Measured " +
          "2026-08-10 over " +
          '`readHandlers(seed("starter")).wishlist_list`: Counterspell 2 of 4, Jace 0 of 1, ' +
          "the **foil** Ragavan 0 of 1 with a nonfoil in the binder, Rhystic Study 0 of 1, and " +
          "the any-printing Sol Ring **2 of 1** — fulfilled twice over, because a wish naming no " +
          "printing is filled by every printing of the card.\n\n" +
          "**Zero deletes here, and every stepper on the page can now reach it.** " +
          "`wishlist_set_quantity(0)` removes the row — the fake's handler mirrors " +
          "`wishlist_entries`' own `CHECK (quantity > 0)` — because a wish for none of " +
          "something is not a wish. The floor was `min={1}` until issue #284, on the argument " +
          "that a stepper deleting a row when held down is a one-way door with no undo; what " +
          "overruled it is that a collection entry has deleted at zero since schema v24 and its " +
          "steppers have always been `min={0}`, so one gesture meant two different things on " +
          "two lists a press apart. All three places a wish's number is drawn — the tile's " +
          "stepper ({@link CopiesFromATile}), the table's cell and the pencil's panel " +
          "({@link EditingFromATile}) — floor at zero together. **Removal keeps its own named " +
          "control**, which is the route that says the word rather than the one a held button " +
          "arrives at: {@link Removed} is the story of it.\n\n" +
          "**It has a docked card search on its right since 2026-09-07** " +
          "({@link WithSearchColumn}), which is what closed the sentence this page's own empty " +
          "state used to end on — *“Add cards from search with the + on any row or tile”*, a view " +
          "sending the reader to another route to fill the list it is about. The column is " +
          "`WishlistSearchPanel` and is storied in full at `Wishlist/SearchPanel`; every `+` in " +
          "it files into **the drawer on screen**, and a tile dropped on a heading files " +
          "there instead. Two `FilterBar`s are therefore mounted together on this page, told " +
          "apart by their boxes' names — `Search your wishlist` against `Search cards`.\n\n" +
          "**There is no `Large` story, and that is a fact about the seeds rather than about " +
          'this page.** `seed: "large"` builds 5 243 cards and 600 collection entries and ' +
          "**no wishes at all** — `largeSeed` says so in as many words, and " +
          "`wishlist_list` answers `total: 0` under it (measured 2026-08-10). A story named " +
          "`Large` would render the zero state {@link Empty} already covers, under a name " +
          "promising depth. Closing it means seeding wishes into `largeSeed`, which is a change " +
          "to a fixture every other story file reads.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The docked search column's `<section>`, by the name only it answers to. */
const PANEL_LABEL = "Add cards to your wishlist";

/**
 * The **page's own** copy of a control the sidebar draws too.
 *
 * Two `FilterBar`s are mounted on this page since 2026-09-07, and `FilterBar` names its own
 * controls — so `Show filters` and `Sort results` are each on screen twice. That is not a bug in
 * either row (a control means the same thing wherever it appears); what it means is that a play
 * reaching for one has to say which column it is about. The boxes themselves are already distinct
 * (`Search your wishlist` against `Search cards`), which is `FilterLabels`' whole reason.
 */
const pageControl = (canvas: ReturnType<typeof within>, name: RegExp | string): HTMLElement => {
  const found = canvas
    .getAllByRole("button", { name })
    .find((el: HTMLElement) => el.closest(`[aria-label="${PANEL_LABEL}"]`) === null);
  if (!found) throw new Error(`no page-side control named ${String(name)}`);
  return found;
};

/** A shelf's heading by name — found by the chevron spec §3.2 names ("Collapse Binder"), then the
 *  box `ShelfHeading` stamps, which is the heading's own. */
const headingNamed = (canvas: ReturnType<typeof within>, name: string): HTMLElement => {
  const chevron: HTMLElement = canvas.getByRole("button", {
    name: new RegExp(`^(Collapse|Expand) ${name}$`),
  });
  const box = chevron.closest<HTMLElement>("[data-shelf-heading]");
  if (box === null) throw new Error(`no heading box around ${name}`);
  return box;
};
/** A header figure's value — a `<dd>` beside its `<dt>`. */
const figureValue = (canvas: ReturnType<typeof within>, label: string) =>
  canvas.getByText(label).nextElementSibling as HTMLElement;
/** The path row's Add folder — the one on no heading and not in the search column. */
const pathAddFolder = (canvas: ReturnType<typeof within>): HTMLElement => {
  const found = canvas
    .getAllByRole("button", { name: /^Add folder/ })
    .find(
      (b: HTMLElement) =>
        b.closest("[data-shelf-heading]") === null &&
        b.closest(`[aria-label="${PANEL_LABEL}"]`) === null,
    );
  if (!found) throw new Error("no Add folder on the path row");
  return found;
};
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * The root's shelves, and the arithmetic this story has always pinned — **which moved from the
 * header to Not sorted's heading**. `$163.96` is the five loose wishes, and the header counts the
 * whole wall now (spec §3.6): the five loose, the three filed, and the five in deck 4's shut list.
 *
 * **One tile, not the two this story used to assert.** The page drew `Still to buy (USD)` beside
 * `Still to buy (EUR)` while there was no way for a reader to say which they were shopping in;
 * the marketplace setting is that way, so the figure follows it and the label carries the
 * currency. There is no euro node on screen here at all — this is the default world, which is
 * TCGplayer. The euro arithmetic is covered where it can be asserted against a chosen
 * marketplace rather than a world default: `WishlistPage.test.tsx`, and
 * `Collection/SummaryHeader`'s `InEuros`, whose header takes its marketplace as a prop.
 *
 * The unpriced counters stay two fields behind it, because the two currencies do not have the
 * same holes — `eur_etched` does not exist in Scryfall's data, so the same card can be priced in
 * dollars and unpriced in euros.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const loose = await waitFor(() => {
      const box = canvasElement.querySelector<HTMLElement>('[data-shelf-heading="0"]');
      if (box === null) throw new Error("no Not sorted shelf");
      return box;
    });
    await expect(loose).toHaveTextContent("5 cards · $163.96 · 1 unpriced");
    await waitFor(async () => {
      await expect(figureValue(canvas, "Cards")).toHaveTextContent("13");
    });
    await expect(canvas.getByText("Total cost (USD)")).toBeInTheDocument();
    await expect(figureValue(canvas, "Total cost (USD)")).not.toHaveTextContent("—");
    await expect(canvas.queryByText("€94.62")).not.toBeInTheDocument();

    // Five wishes, five tiles. One per **wish** and never per card, which is the reverse of the
    // collection's wall: there two entries for one printing are one piece of art, and here a
    // foil wish and a nonfoil wish are two wishes with two prices.
    await expect(canvas.getByRole("group", { name: "Your wishlist" })).toBeInTheDocument();
    // How many copies the reader wants, in the tile's bottom-left corner. It read `2/4` — owned
    // over wanted — until 2026-09-08.
    await expect(canvas.getByText("×4")).toBeInTheDocument();

    // The one thing a picture must not settle: Sol Ring's wish names no printing, so it is drawn
    // as one — the newest of its oracle card — and captioned as what it actually is.
    await expect(canvas.getByText("Any printing")).toBeInTheDocument();

    // **The Needs review cell is behind the Filters disclosure**, with everything else this row
    // does not keep on the bar — so a shut tray is the state the page opens in and nothing on
    // screen carries that name. It used to be a chip drawn only where there was something to
    // filter; `WISHLIST_TRAY` in `WishlistPage.tsx` says why that rule did not survive the move.
    await expect(canvas.queryByRole("button", { name: "Needs review" })).toBeNull();
    await expect(pageControl(canvas, /^Show filters/)).toBeInTheDocument();
  },
};

/**
 * The same five wishes as a list — the layout for the trip where the question is what it all
 * costs, and where six columns of facts beat six pieces of art.
 *
 * It is one press from {@link Default} and one press back; nothing else about the list changes,
 * which is the whole claim these two stories make together. The header above them is the same
 * header, and the wishes are the same wishes.
 */
export const Table: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `VirtualTable`'s rule 3: the data rows (5 loose + 2 in Ordered + 1 in Backordered = 8, deck 4's
    // list shut), plus the header, plus six bands — Not sorted, Ordered, Backordered, Someday, the
    // Managed by decks label and deck 4's heading.
    const table = await canvas.findByRole("table", { name: "Your wishlist" });
    await waitFor(async () => {
      await expect(table).toHaveAttribute("aria-rowcount", "15");
    });
    // The Wanted column's stepper, which is what the table says about copies now: it drew an
    // `Owned` column reading `2 of 4 owned` beside it until 2026-09-08. **The first of two** —
    // `Backordered` holds a second Counterspell of the same printing, one shelf down, and the
    // loose one is drawn first because Not sorted is.
    await expect(
      (await canvas.findAllByRole("spinbutton", { name: /Copies wanted of Counterspell/ }))[0],
    ).toHaveValue(4);
    await expect(canvas.queryByText(/owned/i)).toBeNull();
  },
};

/**
 * **Shelves** (spec §3): every wish at and below the root, one shelf per folder, nested — `Ordered`
 * with `Backordered` under its rail, `Someday` over its dashed empty box, and deck 4's list shut
 * under Managed by decks. A heading's figures are its folder's recursive total — `Ordered` reads
 * three wishes: two of its own and `Backordered`'s one. **Its → opens it** (issue #599), and the
 * page then *is* that folder: the breadcrumb names it and its sub-folder is the top shelf.
 *
 * **The table, so the whole tree is near the top of the list.** `packages/ui/stories.test.tsx` lays a
 * virtualised wall out in a 600px window and, with no width to measure, one card column wide — so
 * on the grid every heading below Not sorted's five tiles is outside the window and never drawn,
 * and a play may only ask about rows near the top. The table's 40px bands keep every heading in it.
 * {@link Default} is the grid's.
 */
export const Shelves: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ordered = await waitFor(() => headingNamed(canvas, "Ordered"));
    await waitFor(async () => {
      await expect(ordered).toHaveTextContent(/3 cards/);
    });
    const backordered = headingNamed(canvas, "Backordered");
    await expect(follows(ordered, backordered)).toBe(true);

    await userEvent.click(within(ordered).getByRole("button", { name: "Open Ordered" }));

    const trail = await canvas.findByRole("navigation", { name: "Wishlist folders" });
    await expect(within(trail).getByText("Ordered")).toHaveAttribute("aria-current", "page");
    await expect(await waitFor(() => headingNamed(canvas, "Backordered"))).toBeInTheDocument();
    await waitFor(async () => {
      await expect(canvas.queryByText("Ragavan, Nimble Pilferer")).toBeNull();
    });
  },
};

/**
 * **The headline case** (spec §1): every loose wish filed. The old root asked for the wishes filed
 * nowhere and drew a band of folder cards over nothing, with **Wishes 0** in the header. Every wish
 * is on the wall now under its folder's heading, Not sorted is still drawn — empty, over its dashed
 * drop box, as the way back out of a folder (issue #597) — and the header counts all of them.
 *
 * **Twelve, not thirteen, and the missing one is the grain working.** The loose Rhystic Study and
 * the one already filed in `Ordered` are the same printing with no finish, so filing the loose one
 * there lands on a taken grain and **merges** — one wish for two copies, `wishlist_set_folder`'s
 * rule since schema v23 and the fake's `mergeWishOnto`. So `Ordered` reads seven: its own two, four
 * of the five that arrived, and `Backordered`'s one.
 */
export const EverythingFiled: Story = {
  render: (args) => (
    <Staged key={args.view} view={args.view} stageKey="everything-filed" stage={fileEverything} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ordered = await waitFor(() => headingNamed(canvas, "Ordered"));
    await waitFor(async () => {
      await expect(figureValue(canvas, "Cards")).toHaveTextContent("12");
    });
    await expect(headingNamed(canvas, "Not sorted")).toBeInTheDocument();
    await waitFor(async () => {
      await expect(ordered).toHaveTextContent(/7 cards/);
    });
    await expect(await canvas.findByText("×4")).toBeInTheDocument();
    await expect(canvas.queryByText(/Your wishlist is empty/)).toBeNull();
  },
};

/**
 * **Past the three-level indent cap** (spec §3.3). Six folders under `Someday`, one wish at the
 * bottom, and the page opened on `Lands` — **opening a folder resets the indentation**, so its
 * sub-folders start at the left again. The heading five levels down keeps the third level's indent
 * and says its path from the deepest indented ancestor instead, as buttons that open each.
 *
 * Table view: the canvas's reference frame is "six levels deep, table view".
 */
export const DeepNesting: Story = {
  args: { view: "table" },
  render: (args) => (
    <Staged key={args.view} view={args.view} stageKey="deep-nesting" stage={nestSixDeep} open />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trail = await canvas.findByRole("navigation", { name: "Wishlist folders" });
    await expect(within(trail).getByText("Lands")).toHaveAttribute("aria-current", "page");
    const signed = await waitFor(() => headingNamed(canvas, "Signed"));
    const lead = within(signed)
      .getAllByRole("button")
      .filter((b) => ["Fetchlands", "Foils", "Showcase", "Japanese"].includes(b.textContent ?? ""));
    await expect(lead.length).toBeGreaterThan(0);
  },
};

/**
 * **A search suspends collapse** (spec §3.4, decision 4). Deck 4's list is shut by default; typing
 * a card in it opens its shelf, reads `1 of 5 cards` on the heading, and hides every shelf with no
 * match. Emptying the box shuts it again — nothing about the stored folds was written.
 *
 * It waits on **Not sorted** before typing rather than on the deck's heading, which is at the
 * bottom of the wall and outside the story runner's 600px window (see {@link Shelves}); once the
 * search has hidden every shelf with no match, the deck's is the top one.
 */
export const Filtering: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => headingNamed(canvas, "Not sorted"));

    await userEvent.type(canvas.getByLabelText("Search your wishlist"), "copter");

    await expect(await canvas.findByAltText("Smuggler's Copter")).toBeInTheDocument();
    const deck = headingNamed(canvas, "Rhystic Testbed");
    await expect(
      within(deck).getByRole("button", { name: "Collapse Rhystic Testbed" }),
    ).toHaveAttribute("aria-expanded", "true");
    await waitFor(async () => {
      await expect(deck).toHaveTextContent("1 of 5 cards");
    });
    await expect(canvasElement.querySelector('[data-shelf-heading="0"]')).toBeNull();
  },
};

/**
 * **A cabinet with nothing in it — and Add folder, which is how that changes.** The path row is
 * drawn over an empty cabinet on purpose: gated on having folders, a reader who has never filed
 * anything could never make their first. There is no breadcrumb, because there is no trail.
 */
export const EmptyCabinet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const add = await waitFor(() => pathAddFolder(canvas));
    await expect(canvas.queryByRole("navigation", { name: "Wishlist folders" })).toBeNull();

    await userEvent.click(add);

    const wall = await canvas.findByRole("group", { name: "Your wishlist" });
    await expect(await within(wall).findByRole("textbox")).toHaveFocus();
  },
};

/**
 * **Adding a folder** (spec §3.8): the new folder appears where it will live — last among its
 * siblings — as a heading whose name is the field, over an empty shelf. Typed on the line the name
 * will occupy, so nothing reflows when ✓ lands. **Opened on `Someday`** — handed over as the page
 * mounts, the way the home page's folder shortcuts do — so the field is on screen rather than
 * below a virtualised wall.
 */
export const AddingAFolder: Story = {
  render: (args) => (
    <Staged
      key={args.view}
      view={args.view}
      stageKey="adding-a-folder"
      stage={somedayId}
      open
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trail = await canvas.findByRole("navigation", { name: "Wishlist folders" });
    await expect(within(trail).getByText("Someday")).toHaveAttribute("aria-current", "page");

    await userEvent.click(await waitFor(() => pathAddFolder(canvas)));

    const field = await within(canvas.getByRole("group", { name: "Your wishlist" })).findByRole(
      "textbox",
    );
    await expect(field).toHaveFocus();
    await expect(field).toHaveValue("");
  },
};

/** **Renaming** (spec §3.8): the heading's name becomes the field, and its figures stay beside it
 *  — which is how a reader checks they have the right drawer. The table, for {@link Shelves}'
 *  reason: `Ordered`'s heading is near the top of the list there. */
export const RenamingAFolder: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ordered = await waitFor(() => headingNamed(canvas, "Ordered"));

    await userEvent.click(within(ordered).getByRole("button", { name: /^Rename/ }));

    const field = await within(ordered).findByRole("textbox");
    await expect(field).toHaveValue("Ordered");
    await expect(ordered).toHaveTextContent(/3 cards/);
  },
};

/**
 * **A heading mid-drag** (spec §3.9) — a story to drag in rather than to read, because the three
 * landings only exist under a pointer, and `packages/ui/test-drag.ts` cannot be imported into a play.
 *
 * Pick `Someday`'s heading up anywhere but its buttons: **every shelf folds to its heading** for the
 * length of the drag, the nested `Backordered` included, so the whole tree is a column of targets.
 * Over another heading, the top quarter puts it **before** (a gold line above), the bottom quarter
 * **after** (below), and the middle **inside** (the heading's edge goes gold). `Ordered` onto its own
 * `Backordered` marks nothing: a folder can never land in itself or below. Let go anywhere and the
 * shelves unfold exactly as they were — nothing was written but the move itself. The breadcrumb's
 * segments take a folder too, filing it last in that level. Deck 4's heading is not a source.
 */
export const DraggingAFolder: Story = {};

/**
 * **A deck's managed wishlist** (user schema v48, issue #512) — a shelf of its own under
 * **Managed by decks**, wearing `Layers`, **shut by default** (spec §3.4: a derived list, not a
 * binder), and with nothing on its heading that writes: no Add folder, no Rename, no `⋯`, no drag.
 * Collapse all first, so its heading is near the top of a virtualised wall. Opening it by its `→`
 * (issue #599) says whose list it is, and draws no stepper, no pencil and no Add folder inside.
 */
export const ManagedWishlist: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The wall's first heading — the one row a play may count on being drawn (see {@link Shelves}).
    await waitFor(() => headingNamed(canvas, "Not sorted"));
    await userEvent.click(canvas.getByRole("button", { name: "Collapse all" }));

    const deck = await waitFor(() => headingNamed(canvas, "Rhystic Testbed"));
    await expect(canvas.getByText("Managed by decks")).toBeInTheDocument();
    await expect(deck.querySelector("svg.lucide-layers")).not.toBeNull();
    await expect(within(deck).queryByRole("button", { name: /^Add folder/ })).toBeNull();
    await expect(within(deck).queryByRole("button", { name: /^Rename/ })).toBeNull();

    await userEvent.click(within(deck).getByRole("button", { name: "Open Rhystic Testbed" }));

    await expect(await canvas.findByText(/Managed by the deck “Rhystic Testbed”/)).toBeInTheDocument();
    await expect(await canvas.findByAltText("Smuggler's Copter")).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Add folder/ })).toBeNull();
    await expect(canvas.queryByRole("spinbutton", { name: /^Copies wanted of/ })).toBeNull();
  },
};

/**
 * Everything else a wish can be edited into, from a tile.
 *
 * The panel is the tile's answer to a 170px caption: which printing, which folder, and the named
 * removal, in the same anchored popup the search wall's quick-add hangs off — opening from the
 * tile's left edge so the first column's panel is not clipped by a scroller that cannot be
 * scrolled left. **It is the only route to two of those writes**, and on an any-printing wish it
 * is the only route to any of them, which is why the pencil is drawn on every tile.
 *
 * **The number is no longer among them alone.** It is still here, and it is now also on the tile
 * in front of the pencil ({@link CopiesFromATile}) — the same control, the same accessible name
 * and the same floor, because a wish's copy count is one write however the reader reaches it.
 *
 * The stepper here is the table's stepper, `min={0}` included: zero deletes a wish, and since
 * issue #284 that is a press the reader may make rather than a floor the UI holds them above.
 * Removal is still the press at the foot of the panel, offered on every wish — crossing a line
 * off a shopping list is what a shopping list is for, and it is the route that says so in words.
 */
export const EditingFromATile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **The first of two** since the shelves: `Backordered` holds a second Counterspell of the same
    // printing one shelf down, and the loose one — four copies — is drawn first, as Not sorted is.
    const [edit] = await canvas.findAllByRole("button", {
      name: /Edit Counterspell .* on your wishlist/,
    });
    await userEvent.click(edit);

    const panel = await canvas.findByRole("dialog", { name: "Edit Counterspell" });
    await expect(
      within(panel).getByRole("spinbutton", { name: "Copies wanted of Counterspell (MH2 267)" }),
    ).toHaveValue(4);
    await expect(
      within(panel).getByRole("button", { name: /Remove Counterspell .* from your wishlist/ }),
    ).toBeInTheDocument();
  },
};

/**
 * **How many copies, changed on the tile** — issue #284, and the half of the wall that was
 * missing.
 *
 * The table has always edited the number in place, because a shopping list is where the number
 * of copies is *maintained*. The wall drew the pencil and nothing else, so the same change cost
 * three presses on one drawing of the list and one on the other. The stepper is `size="xs"` over
 * the art beside the pencil, `tone="art"` for the backing that keeps a 1px outline legible over
 * an illustration, and `focus="inset"` because the frame it stands in clips its own corners.
 *
 * Counterspell is the subject because it is the seeded root wish with a number to move in both
 * directions — 4 wanted against 2 owned. Rhystic Study is the other half of the story at 1,
 * which is where the floor is worth looking at: since issue #284 its `Decrease` is **live**
 * rather than greyed, and the press it would take is the removal
 * (`wishlist_set_quantity(0)` → `remove_wish`). This play stops short of making it — a wish
 * leaving the list is {@link Removed}, which drives the control that says the word.
 *
 * Both controls live in `CardGrid`'s action strip, which is revealed on hover and on
 * focus-within and is **in the tab order on the wall's roving stop tile** (issue #558) — the
 * arrows make any tile that stop: "visible on hover" is not a state a keyboard has, which is also
 * why `userEvent` reaches them here with no hover of its own.
 */
export const CopiesFromATile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const counterspell = "Copies wanted of Counterspell (MH2 267)";
    // **The first of each pair** since the shelves: `Backordered` holds a second Counterspell and
    // `Ordered` a second Rhystic Study, each the same printing one shelf down — the loose ones are
    // drawn first, as Not sorted is, and those are the ones this story is about.
    const first = (name: string) => canvas.getAllByRole("spinbutton", { name })[0];

    await expect((await canvas.findAllByRole("spinbutton", { name: counterspell }))[0]).toHaveValue(
      4,
    );

    await userEvent.click(canvas.getAllByRole("button", { name: `Increase ${counterspell}` })[0]);

    // Optimistic on the row's own number and then confirmed by the answer — `patchWish` twice,
    // which is what lets a reader hold `+` without the box computing from a stale value.
    await waitFor(async () => {
      await expect(first(counterspell)).toHaveValue(5);
    });

    // The pencil is still beside it, so the printing, the folder and the named removal are all
    // still one press from the tile: the stepper is an addition rather than a rearrangement.
    await expect(
      canvas.getAllByRole("button", { name: /^Edit Counterspell .* on your wishlist/ })[0],
    ).toBeInTheDocument();

    // The floor, on the wish already sitting on it. Enabled is the whole assertion — what the
    // press would do belongs to {@link Removed}.
    await expect(
      canvas.getAllByRole("button", { name: "Decrease Copies wanted of Rhystic Study (PCY 45)" })[0],
    ).toBeEnabled();
  },
};

/**
 * A flagged wish on the wall — **listed, counted, and asking to be looked at**, which is the rule
 * `needs_review` is written under and therefore something no layout may drop.
 *
 * The table has a band across the row for the reconciler's sentence. A card has corners, so the
 * flag shares the top-left chip with the cost, and the whole sentence rides as its tooltip — the
 * same arrangement the band already makes for its own truncation, since the second half of that
 * sentence is what to do about it.
 */
export const FlaggedOnTheWall: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const flag = await canvas.findByText("Needs review", { selector: "span" });
    // The reconciler's sentence rides as a tooltip now, not a `title` — describing (the default
    // `describes: true`, since nothing else on the tile carries the sentence as text), so the
    // panel carries `role="tooltip"` once hovered.
    await userEvent.hover(flag);
    const reviewTooltip = await canvas.findByRole("tooltip", undefined, {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    await expect(reviewTooltip).toHaveTextContent(
      "Scryfall removed this printing from its database",
    );
  },
};

/**
 * A foil wish reading nothing owned, with a nonfoil of the same printing in the binder.
 *
 * This is why finish is part of what makes two wishes two wishes: the printing column carries
 * set, number **and** finish, because those three together are what identify a wish.
 *
 * **The count that used to prove it is gone.** This story asserted `0 of 1 owned` on the foil
 * wish beside a binder holding one nonfoil Ragavan — `ownedAgainstWish` narrowing by the wish's
 * `preferredFinish`. The wishlist compares itself to the collection nowhere since 2026-09-08, so
 * what is left to assert here is the statement itself: the row says which finish it is for, in
 * words, and no row on this page says anything about the binder.
 */
export const FoilWishUnfilled: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The printing column is the one column here that cannot be given a fixed width and stay
    // honest, because it carries three facts.
    const row = (await canvas.findByText("MH2 · 138 · Foil")).closest('[role="row"]');
    await expect(row).not.toBeNull();
    // The row states the finish and says nothing about the nonfoil Damaged Ragavan sitting one
    // view away in the binder — which the seed still holds, so this is an absence with a fixture
    // behind it rather than one that would pass over an empty collection.
    await expect(within(row as HTMLElement).queryByText(/owned/i)).toBeNull();
    // And the same three ride in the stepper's accessible name, which is the half no screenshot
    // shows: two wishes for one card differ only by printing and finish, so "Copies wanted of
    // Ragavan, Nimble Pilferer" alone would be two identical controls in one list as far as a
    // screen reader or a voice driver is concerned.
    await expect(
      canvas.getByRole("spinbutton", {
        name: "Copies wanted of Ragavan, Nimble Pilferer (MH2 138, Foil)",
      }),
    ).toHaveValue(1);
  },
};

/**
 * **The filter tray offers no way to ask about the collection**, which is what replaced the
 * `FulfilledAndUnfulfilled` story that stood here.
 *
 * That one drove the `Fulfilled` / `Still missing` chip both ways round — one chip, three states,
 * the word on it saying which was on. The chip is gone with every other comparison this list made
 * against the binder: a wishlist is the reader's own, and they take a card off it when they
 * acquire one. A story that merely stopped pressing the chip would prove nothing, so this opens
 * the tray and asserts the absence, alongside a chip that **is** there — without which the play
 * would pass over a tray that failed to open at all.
 */
export const NoCollectionFilter: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Two Sol Rings on the root's wall since the shelves — the loose any-printing wish and
    // `Ordered`'s pinned one — so this waits for either.
    await canvas.findAllByText("Sol Ring");

    // Behind the Filters disclosure since this page started drawing the shared row — the box, the
    // colours, the order and the layout pair are what stay on the bar.
    await userEvent.click(pageControl(canvas, /^Show filters/));

    await expect(canvas.getByRole("button", { name: "Needs review" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Still missing" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Fulfilled" })).toBeNull();
  },
};

/**
 * A shopping list nobody has written on yet.
 *
 * "Your wishlist is empty. Add cards from search with the + button." — a
 * statement about the wishlist, naming the control that fills it. `statusOf` chooses it on
 * `activeCount === 0`; with a filter on, the same empty list says "No wishes match these
 * filters", which is a statement about the filters instead.
 *
 * Both money figures read an em dash rather than $0.00 — a list that claims to be worth nothing
 * is worse than one that has not said.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Your wishlist is empty. Add cards from search with the + button.",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A wish a sync left a question against — **listed, counted, and asking to be looked at**.
 *
 * The reconciler walks `wishlist_entries` as well as `collection_entries`, so its sentence is a
 * band under the row it belongs to, drawn across the whole row because it is a sentence and not a
 * column. The row grows by `REVIEW_HEIGHT` and the virtualiser is told so through `extraHeight` —
 * a list told every row is the same height would overlap the one below it by exactly that band.
 *
 * The seeded sentence is `reconcile::flag_deleted`'s, copied verbatim with its date into
 * `packages/fake/seeds.ts`’s own seed function. It is the flagged row's *whole* explanation, and the second
 * half of it is what to do about it — which is why the band carries the sentence as a `title` as
 * well, and why a screen reader gets all of it either way.
 *
 * The **Needs review** cell is in the filter tray, which this play opens — it is drawn there
 * whether or not anything is flagged, where the chip it replaces appeared only once something
 * was ({@link Default} is the same page with the tray shut). `WISHLIST_TRAY` carries the reason:
 * a control that comes and goes costs a *row* the reader's attention, and costs a shut tray
 * nothing at all.
 */
export const NeedsReview: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Scryfall removed this printing from its database on 2026-07-31\./),
    ).toBeInTheDocument();
    // The flag lists and never hides: the unflagged wishes are still here with it — two
    // Counterspells since the shelves, the loose one and `Backordered`'s — and the table counts
    // every row. `VirtualTable`'s rule 3: 9 data rows (6 loose, the flagged one among them, 2 in
    // Ordered, 1 in Backordered; deck 4's list shut), the header, and six bands — Not sorted,
    // Ordered, Backordered, Someday, the Managed by decks label and deck 4's heading.
    await expect(canvas.getAllByText("Counterspell").length).toBeGreaterThan(0);
    await waitFor(async () => {
      await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
        "aria-rowcount",
        "16",
      );
    });
    await userEvent.click(pageControl(canvas, /^Show filters/));
    await expect(canvas.getByRole("button", { name: "Needs review" })).toBeInTheDocument();
  },
};

/**
 * A write the database refused.
 *
 * `db.ts`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the list underneath is untouched.
 * The alert is a `role="alert"` of its own rather than a line folded into the status above it:
 * that one describes the list, and this one describes something the reader just did to it.
 *
 * **Counterspell rather than one of the four wishes at quantity 1, and the reason moved with the
 * floor.** It used to be that `min={1}` left Decrease disabled on those rows, so a press on one
 * would have proved nothing about a refusal. Since issue #284 the floor is `0` and that press
 * lands — but it lands as a *removal*, which is a different write, and a row that is on its way
 * out has no number for the rollback to put back. This story is about a **quantity change**
 * being refused, so it needs a wish with a number to return to: 4.
 *
 * The stepper is optimistic on the row's own number, so this also exercises the rollback:
 * `onError` restores the snapshot `onMutate` took, and the box goes back to 4.
 */
export const Busy: Story = {
  args: { view: "table" },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Copies wanted of Counterspell (MH2 267)";
    // The loose Counterspell — the first of two since the shelves, `Backordered` holding the other.
    const [decrease] = await canvas.findAllByRole("button", { name: `Decrease ${label}` });
    await userEvent.click(decrease);

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Couldn't change your wishlist — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await waitFor(async () => {
      await expect(canvas.getAllByRole("spinbutton", { name: label })[0]).toHaveValue(4);
    });
  },
};

/**
 * Crossing a line off the list.
 *
 * **Removal is offered on every row here, where the collection offers it only on an emptied
 * one.** The two lists mean opposite things by deletion: losing a
 * collection entry loses the record of something owned — its condition, its price, the story of
 * where it came from — while crossing a line off a shopping list is what a shopping list is for.
 *
 * The row removed is the any-printing Sol Ring, whose accessible name is the whole of what
 * distinguishes it: `wishLabel` writes "any printing" where a pinned wish writes its set and
 * number, because a wish with no `card_id` is for the *card* and there is no printing to name.
 * (It is also the reason that row is not a drag source and not clickable: there is no printing
 * for a drop or a pane to be about.)
 *
 * The count moves with it — the table's and the header's both, since both are read off the
 * per-shelf counts the removal re-reads.
 *
 * **Asked by the button's name rather than by the card's**, since the shelves: `Ordered` holds a
 * pinned Sol Ring of its own on the same wall, so the word alone names two rows and only one of
 * them is going.
 */
export const Removed: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const remove = "Remove Sol Ring (any printing) from your wishlist";

    await userEvent.click(await canvas.findByRole("button", { name: remove }));

    await waitFor(async () => {
      await expect(canvas.queryByRole("button", { name: remove })).toBeNull();
    });
    // `VirtualTable`'s rule 3: 7 data rows left (4 loose, 2 in Ordered, 1 in Backordered; deck 4's
    // list shut), the header, and the six bands — Not sorted, Ordered, Backordered, Someday, the
    // Managed by decks label and deck 4's heading.
    await waitFor(async () => {
      await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
        "aria-rowcount",
        "14",
      );
    });
    // A removal that succeeded says nothing: the row going is the whole report.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * The page as it actually opens since 2026-09-07: **the list and a docked card search sharing one
 * row.**
 *
 * The column is `WishlistSearchPanel`, storied in full at `Wishlist/SearchPanel`; what this story
 * is about is the *page* around it — the row that had to be invented, since this view was
 * `flex-col` from its root down and had nothing to hang a column off.
 *
 * **Three things are being claimed here and only a browser can settle them.** The figures band and
 * the page's own `FilterBar` stay **full width above** the row, because that bar lays itself out in
 * four container bands and taking width off it rearranges the bar rather than shortening it. The
 * list side carries `min-w-0`, without which a flex item cannot shrink below its own min-content
 * and the overhang becomes a horizontal scrollbar across the whole app — `ManaValueChips` shipped
 * exactly that once, at 25px, invisible to the suite and to a screenshot. And the two filter rows
 * are separately addressable, which is what `FilterLabels` exists for: the page's box is
 * `Search your wishlist` and the column's is `Search cards`.
 */
export const WithSearchColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const column = canvas.getByRole("region", { name: PANEL_LABEL });
    // **Railed at rest** — `DEFAULT_SEARCH_OPEN` opens only the deck's column and rails the two
    // lists', because this page already draws a `FilterBar` of its own and below 544px the panel
    // is an overlay rather than a rail. Measured at seven widths in the shipped window on
    // 2026-09-07. So the two-filter-rows case below is one this play has to *ask* for, which is
    // the honest reading of it: it is what a reader who wants both sees, not what they arrive to.
    await userEvent.click(within(column).getByRole("button", { name: /card search$/ }));
    await expect(
      await within(column).findByRole("button", { name: /card search$/ }),
    ).toHaveAttribute("aria-expanded", "true");

    // Two rows, two names, and neither reaches the other's field.
    await expect(canvas.getByLabelText(/search your wishlist/i)).toBeInTheDocument();
    await expect(await within(column).findByLabelText("Search cards")).toBeInTheDocument();

    // **The page's own wall, awaited** — it is gated on `wishlist_list` answering, so a synchronous
    // query here asks before there is anything to find. The two walls carry different names by
    // construction rather than by agreement: this one passes `label="Your wishlist"` and
    // `CardSearchBody` passes none, so the column's is `CardGrid`'s default `Search results`.
    const list = await canvas.findByRole("group", { name: "Your wishlist" });

    // Nothing overhangs. Storybook is a real browser, so unlike the suite this is read off the box
    // rather than off a class — and the page's own scroller is what an overhang would reach.
    const row = column.parentElement!.parentElement!;
    await expect(row.scrollWidth).toBe(row.clientWidth);
    await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);

    // And the destination is the page: at the root that is the list's own name, never "no folder".
    // Asked of **one card**, because the column draws a quick-add per tile and the corpus's default
    // browse is 37 of them — a `.+` here is a question with 37 honest answers. `Ancient Tomb` is the
    // row `Wishlist/SearchPanel` and `Decks/SearchPanel` both reach for.
    await expect(
      await within(column).findByRole("button", {
        name: /^Add Ancient Tomb \(.+\) to Wishlist$/,
      }),
    ).toBeInTheDocument();
  },
};
