import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
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
  useState(() => useAppStore.getState().setCollectionView(view));
  return <CollectionPage />;
}

/**
 * The page over a world a story changed first, **through the commands** — the wishlist's `Staged`,
 * for its reasons: it runs once, it is cached in the story's own client, and `staleTime: Infinity`
 * keeps a window refocus from staging again. `open` hands the page a folder to open on its way in
 * (`store.ts`'s `pendingFolder`), so a story about a deep level starts there rather than scrolling
 * a virtualised wall to reach it.
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
  useState(() => useAppStore.getState().setCollectionView(view));
  const staged = useQuery({ queryKey: ["story", stageKey], queryFn: stage, staleTime: Infinity });
  if (!staged.isSuccess) return null;
  return open ? <OpenedAt folderId={staged.data} /> : <CollectionPage />;
}

function OpenedAt({ folderId }: { folderId: number }) {
  useState(() => useAppStore.setState({ pendingFolder: { scope: "collection", id: folderId } }));
  return <CollectionPage />;
}

/** The starter seed's folder by name — its ids are the seed's business, its names are what the
 *  stories below are about. */
async function folderNamed(name: string): Promise<number> {
  const found = (await ipc.collectionFolderList()).find((folder) => folder.name === name);
  if (found === undefined) throw new Error(`the starter seed has no folder called ${name}`);
  return found.id;
}

/** Every loose copy filed into `Binder` — the headline case (spec §1). Returns how many moved.
 *  `rootOnly`, and no `shelves`: the root read as every other caller still makes it. */
async function fileEverything(): Promise<number> {
  const binder = await folderNamed("Binder");
  const loose = await ipc.collectionList({ limit: 500, offset: 0, rootOnly: true });
  for (const entry of loose.items) await ipc.collectionSetFolder(entry.id, binder);
  return loose.items.length;
}

/** Five folders nested under `Trade binder`, one loose copy filed at the bottom; returns `Binder`,
 *  the level the story opens on — six headings deep from there, past the three-level indent cap. */
async function nestDeep(): Promise<number> {
  let parent = await folderNamed("Trade binder");
  for (const name of ["Lands", "Fetchlands", "Foils", "Showcase", "Signed"]) {
    parent = (await ipc.collectionFolderCreate(parent, name)).id;
  }
  const loose = await ipc.collectionList({ limit: 1, offset: 0, rootOnly: true });
  await ipc.collectionSetFolder(loose.items[0].id, parent);
  return folderNamed("Binder");
}

/** A shelf's heading by name — its chevron (`Collapse X` / `Expand X`), then the box
 *  `ShelfHeading` stamps, which is the heading's own. */
const headingNamed = (canvas: ReturnType<typeof within>, name: string): HTMLElement => {
  // Annotated: `ReturnType<typeof within>` erases the query's element type to `any`.
  const chevron: HTMLElement = canvas.getByRole("button", {
    name: new RegExp(`^(Collapse|Expand) ${name}$`),
  });
  const box = chevron.closest<HTMLElement>("[data-shelf-heading]");
  if (box === null) throw new Error(`no heading box around ${name}`);
  return box;
};
/**
 * **How long a play waits for the wall to settle — a ceiling, never a pause.** A heading or a tile
 * exists only once three reads have answered in turn — the folder census, the per-shelf counts,
 * then the page of rows — and the virtualiser has measured. Under `npm run verify`, where the
 * whole suite runs beside `tsc`, `vite build` and `eslint`, that chain has run past the 1000ms a
 * `findBy*` or a `waitFor` gives up at by default: `CardMode` and `Filtering` failed exactly there
 * on 2026-09-26 and passed alone. A wait that finds its element returns the moment it does, so a
 * passing play pays nothing for this; `vite.config.ts`'s `testTimeout` paragraph makes the same
 * trade one level up, for the same measured starvation.
 */
const SETTLED = { timeout: 5000 };

/**
 * **Press a shelf control by its name** — a heading's chevron (`Collapse Not sorted`,
 * `Expand Modern Goodstuff`) or the path row's `Collapse all` — once it is on screen.
 *
 * It is how the grid plays below bring the shelf they are about to the top of the wall, and the
 * reason is `src/stories.test.tsx`'s layout stub rather than taste. Under that runner the wall is
 * **one 262px column in a 600px window with two rows of overscan**, so it draws the first shelf's
 * first four tiles and stops. A flattened wall could get away with naming a card early in the
 * alphabet; a shelved wall is ordered by *shelf* first, and **Not sorted** comes first — so every
 * filed card sat below the fold and was simply not in the DOM, which reads exactly like the card
 * having gone. Shutting the shelves above is the gesture a reader makes for the same reason, and
 * it writes nothing but this story's own fold row. The measured window: the wall drew the Not
 * sorted heading, its four tiles and the `Binder` heading, and nothing else (2026-09-26).
 *
 * **A path-row control is pressed only once the wall is drawn** — every play waits on a heading
 * first. `Collapse all` folds the shelves the page has *built*, and the button is on screen from
 * the first render, before the census has answered: pressed then, it folds nothing and the play
 * reads a wall nobody collapsed.
 */
async function press(canvas: ReturnType<typeof within>, name: string): Promise<void> {
  await userEvent.click(await canvas.findByRole("button", { name }, SETTLED));
}
/** The path row's Add folder — the one inside the `Shelves` toolbar. */
const pathAddFolder = (canvas: ReturnType<typeof within>): HTMLElement =>
  within(canvas.getByRole("group", { name: "Shelves" })).getByRole("button", { name: "Add folder" });
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const meta = {
  title: "Collection/Page",
  component: Page,
  tags: ["autodocs"],
  // "table" is the layout a collection is read in — the app's own opening state.
  args: { view: "table" },
  // Keyed on the view, so changing it in Controls remounts and the initializer above runs again.
  render: (args) => <Page key={args.view} {...args} />,
  decorators: [
    // **This box stands in for `AppShell`'s `main`, and since 2026-09-08 the `overflow-auto` is
    // the load-bearing half of it.** In table view the page is `h-full`, so it needs a parent with
    // a height or the virtualiser is handed a 0px window; in grid view the wall takes `CardGrid`'s
    // `grow`, is as tall as its rows, and asks the nearest *scrolling* ancestor to scroll them —
    // which in the app is `main` and here is this. Without the class the walk finds nothing, falls
    // back to the wall itself, and the story draws every row of the fixture in a box that overflows
    // its own frame; with it, both views read exactly as they do in the window. `relative` is the
    // rule that goes with any `overflow` in this app (`src/CLAUDE.md`): a scroll container has to be
    // the containing block for its own absolutely positioned content, or an `sr-only` label inside
    // stretches the document.
    //
    // 1032px is exactly the content column at the app's narrow rung — the 1280-wide window
    // `src-tauri/src/window.rs` opens on a 1080p desk: 1280 less the sidebar's `w-52` (208px) and
    // less `main`'s `p-5` on both sides (40px), from `AppShell.tsx:92` and `AppShell.tsx:144`. The
    // height is chosen rather than derived — the ribbon above it is not a fixed number of pixels.
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
          "**The `starter` seed is 12 entries holding 21 copies**, and the two numbers " +
          "disagreeing is the whole grammar of this view: a row is a *thing owned* — a foil and " +
          "a played nonfoil of one printing are two rows — and four of the twelve hold more than " +
          'one copy. Re-measured 2026-09-08 by calling `readHandlers(seed("starter")).' +
          "collection_summary`: `totalCards: 21`, `uniqueCards: 11`, `entries: 12`.\n\n" +
          "**`uniqueCards` sits one below `entries`, and that is the seed's newest row saying " +
          "what it is for**: a second `sta 105`, etched like the graded one above it and " +
          "recorded at `NONE`, so the table draws `Etched · Near mint` beside a bare `Etched` and " +
          "the Finish sort has a real not-set pair inside one finish. Same printing, so the " +
          "*card* count is unchanged — and one tile on the wall rather than two, since a tile is " +
          "a printing and a finish.\n\n" +
          "**Quantity 0 deletes the row, and this reverses what this page said until v24.** " +
          "{@link ZeroDeletesTheRow} is it, and carries the argument on both sides: the row's " +
          "condition, purchase price, tags and acquisition story go with it, which is exactly " +
          "what the previous rule was preserving. The collection is now the record of what the " +
          "reader physically has, so a row holding no copies is not a card they have — the same " +
          "answer the wishlist has always given, reached from a different argument.\n\n" +
          "**So a row holding no copies is a state no shipped write can reach, and since " +
          "2026-09-08 the seed holds none** (issue #425). It carried one for months, under a " +
          "comment stating the pre-v24 rule, and what that cost is agreement between the fake " +
          "and the crate wherever *owned* is asked as an existence question — " +
          "`collection_source::owns_printing` is an `EXISTS` precisely *because* zero rows are " +
          "gone. `collection_update` could still write one (an edit form sends eight fields at " +
          "once and must not delete its own subject) and it has no caller in `src/`, which is " +
          "what leaves the table's removal control as the escape hatch for a row nothing " +
          "in the app produces. `CollectionTable.stories.tsx`'s `ZeroQuantity` is where " +
          "that row is drawn, from rows handed to the component rather than from a " +
          "database.\n\n" +
          "**The page opens on shelves** — every copy at the root, one shelf per folder: the " +
          "loose five under **Not sorted**, `Binder` with `Trade binder` nested under its rail, " +
          "`Someday` wearing its lock, and the deck groups and `Recently removed` shut under " +
          "**Decks**. {@link Default} is that wall; {@link EverythingFiled} is the reader this " +
          "design was for, who files everything.\n\n" +
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
 * **Shelves** (spec §3): every copy at and below the root, one shelf per folder, nested — the loose
 * five under **Not sorted**, `Binder` with `Trade binder` under its rail, `Someday` wearing its
 * lock, and the app's own folders shut under **Decks**. A heading's figures are its folder's own
 * copies with everything under it added in, so `Binder` counts `Trade binder`'s Black Lotus.
 *
 * Table view, the app's opening layout: each shelf is a band, with its rows under it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const binder = await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);
    const trade = headingNamed(canvas, "Trade binder");
    await expect(follows(binder, trade)).toBe(true);
    await expect(await canvas.findByText("Black Lotus", undefined, SETTLED)).toBeInTheDocument();
    // The app's own folders, after the reader's, under their label — and shut.
    await expect(canvas.getByRole("heading", { name: "Decks" })).toBeInTheDocument();
    await expect(
      within(headingNamed(canvas, "Recently removed")).getByRole("button", {
        name: "Expand Recently removed",
      }),
    ).toHaveAttribute("aria-expanded", "false");
    // No Flatten, and no folder band.
    await expect(canvas.queryByRole("button", { name: "Flatten" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Folders" })).toBeNull();
    await expect(canvas.getByText("To remove an entry, set its copies to zero.")).toBeVisible();
  },
};

/**
 * **The headline case** (spec §1): every loose copy filed. The old root asked for the copies filed
 * nowhere and drew `Cards 0` over a full binder; now every card is on the wall under its folder's
 * heading, there is no Not sorted shelf, and the header counts the whole collection.
 */
export const EverythingFiled: Story = {
  args: { view: "grid" },
  render: (args) => (
    <Staged key={args.view} view={args.view} stageKey="everything-filed" stage={fileEverything} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const binder = await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);
    await expect(canvasElement.querySelector('[data-shelf-heading="0"]')).toBeNull();
    // A copy that was loose a moment ago, on the wall under the drawer it was filed into — named
    // by its stepper, because a tile's button says only "Lightning Bolt" and this seed has four.
    // `Binder` is the first shelf now, so its first tiles are inside the runner's window (see
    // {@link press}); `Trade binder`'s Black Lotus, which stood here, is below it.
    const copy = await canvas.findByRole(
      "spinbutton",
      { name: "Copies of Lightning Bolt (2X2 117)" },
      SETTLED,
    );
    await expect(follows(binder, copy)).toBe(true);
    await expect(canvas.queryByText(/Nothing here yet/)).toBeNull();
  },
};

/**
 * **Past the three-level indent cap** (spec §3.3). Five folders under `Trade binder`, one copy at
 * the bottom, and the page opened on `Binder` — **opening a folder resets the indentation**, so its
 * sub-folders start at the left again. A heading past the third level keeps the third level's
 * indent and says its path from the deepest indented ancestor instead, as buttons that open each.
 *
 * Table view: the canvas's reference frame is "six levels deep, table view".
 */
export const DeepNesting: Story = {
  args: { view: "table" },
  render: (args) => (
    <Staged key={args.view} view={args.view} stageKey="deep-nesting" stage={nestDeep} open />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trail = await canvas.findByRole("navigation", { name: "Collection folders" }, SETTLED);
    await expect(within(trail).getByText("Binder")).toHaveAttribute("aria-current", "page");
    const signed = await waitFor(() => headingNamed(canvas, "Signed"), SETTLED);
    const lead = within(signed)
      .getAllByRole("button")
      .filter((b) => ["Foils", "Showcase"].includes(b.textContent ?? ""));
    await expect(lead.length).toBeGreaterThan(0);
    // Rails, one per level of indent, capped at three.
    await expect(signed.closest('[role="row"]')?.querySelectorAll("[data-shelf-rail]").length).toBe(3);
  },
};

/**
 * **A search narrows the wall to the shelves it matches** (spec §3.4, decision 4). Typing a card
 * filed two levels down lights its shelf and every heading above it, reads `N of M` on each, and
 * hides every shelf with no match — Not sorted included. A shut shelf holding a match opens for the
 * length of the search, and emptying the box hands every fold back exactly as it was: nothing about
 * the stored folds is written.
 */
export const Filtering: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);

    await userEvent.type(canvas.getByLabelText("Search your collection"), "lotus");

    // Past the box's 300ms debounce and the three reads again, so the same ceiling.
    await expect(
      await canvas.findByRole("button", { name: "Black Lotus" }, SETTLED),
    ).toBeInTheDocument();
    await waitFor(async () => {
      await expect(headingNamed(canvas, "Trade binder")).toHaveTextContent(/\d+ of \d+ cards?/);
    }, SETTLED);
    // Not sorted holds no lotus, so it is not drawn while the search is on.
    await expect(canvasElement.querySelector('[data-shelf-heading="0"]')).toBeNull();
  },
};

/**
 * The same twelve entries as **eleven** pieces of art — the seed's two `sta 105` rows are one
 * printing in one finish, which is exactly the wall's grain — and **a drag source**, which
 * reverses what this
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
 * **At the root, like every story here that does not say otherwise** — every shelf on one wall, each tile under the heading of the drawer its copies are in.
 */
export const CardMode: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Your collection" }, SETTLED),
    ).toBeInTheDocument();
    // A card the reader filed away, on the wall anyway — the tile-side proof of what the shelves
    // do, and the one that would go red if the wall started asking `rootOnly` again.
    //
    // **Not sorted is shut first**, because under `stories.test.tsx`'s layout stub the wall draws
    // its first shelf's first four tiles and nothing below — see {@link press}. With it shut,
    // `Binder` is the first shelf with cards, and Consecrated Sphinx (the graded slab filed there)
    // is its first tile. Name a row, never count them: `.storybook/CLAUDE.md`'s rule.
    await press(canvas, "Collapse Not sorted");
    const sphinx = await canvas.findByRole("button", { name: "Consecrated Sphinx" }, SETTLED);
    // Under that shelf's heading, which is what says where it is now that a tile is per folder
    // (decision 11).
    await expect(follows(headingNamed(canvas, "Binder"), sphinx)).toBe(true);
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
 * unchanged — and it is revealed on hover **and on focus-within**, and is in the tab order on the
 * wall's one roving stop tile (issue #558), because "visible on hover" is not a state a keyboard
 * has. The arrows make any tile that stop.
 *
 * **The number it shows is the tile's sum, which is the same figure `OwnedBadge` draws in the
 * corner** — two numbers six pixels apart disagreeing about one piece of art is not a state this
 * wall may show. A press is therefore a *delta* applied to one addressed row rather than the
 * control's own next value, and the floor is the copies that row cannot reach. On the ordinary
 * single-entry tile — which is every tile in this seed, since no two of its entries share a
 * printing *and* a finish — the two collapse into each other and a press is simply the number.
 *
 * The Alpha Lightning Bolt is chosen because it is filed in `Binder`, so the tile is one the fence
 * has to *allow* rather than one it never had to think about — a stepper here can only be drawn
 * once `collection_folder_list` has answered, since a folder the census has not confirmed is
 * fenced. (It was Black Lotus in `Trade binder` until the wall became shelves; that tile is now
 * below the runner's window — see {@link press}.)
 */
export const SteppingFromTheWall: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **The printing in a tile's name is load-bearing, and this seed is why.** It puts four
    // Lightning Bolt printings in the collection — two of them plain, differing only in which
    // cardboard they are — so a name built from the card alone gives two controls one name, on the
    // one surface where the only other thing telling them apart is a picture. Driving the real
    // browser is what found it (2026-09-01): jsdom cannot referee it, because both names are
    // *correct* and merely not unique, and no assertion about one tile can see the other.
    // `getAllByRole` here, then the uniqueness check — a `getBy*` would throw on the duplicate and
    // read as a missing control.
    //
    // **Asked first, of the wall as it opens**: Not sorted's two Bolts (`2X2 117` and the etched
    // `STA 105`) are the first tiles it draws.
    const bolts = await waitFor(async () => {
      const names = canvas
        .getAllByRole("spinbutton")
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter((name) => name.startsWith("Copies of Lightning Bolt"));
      await expect(names.length).toBeGreaterThan(1);
      return names;
    }, SETTLED);
    await expect(new Set(bolts).size).toBe(bolts.length);

    // Then Not sorted shut, so `Binder` — and the copy it files — comes up into the window.
    await press(canvas, "Collapse Not sorted");

    // **`Copies of <card> (<SET> <number>)`, not the table's `Quantity of <card> (Nonfoil, NM)`.**
    // A row names an *entry*, condition and all; a tile names the printing the art is a picture
    // of. The finish rides the same bracket only where the tile wears the mark, and a plain copy
    // draws no chip — so this one ends at the collector number, which is the wall's own nonfoil
    // rule stated in words instead of in a sheen.
    const label = "Copies of Lightning Bolt (LEA 161)";
    const box = await canvas.findByRole("spinbutton", { name: label }, SETTLED);
    await expect(box).toHaveValue(1);

    await userEvent.click(canvas.getByRole("button", { name: `Increase ${label}` }));

    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(2);
    }, SETTLED);
    // No refusal: this is a successful write, not a tolerated failure.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * **The copies a deck physically holds, and the one tile on this wall with no stepper on it.**
 *
 * Since schema v25 a deck owns whatever its own `kind: "deck"` group holds, so the two
 * Counterspells here are not spare cardboard filed under a label — they are *in*
 * `Modern Goodstuff`.
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
 * **And it is *every* copy behind the art, not any of them.** At the root a tile is a printing, a
 * finish *and* a shelf (decision 11), so the copies behind one piece of art sit in one folder and
 * the rule reads that folder; it is still written over every copy, so a tile that ever stood for a
 * binder and a deck's group at once would be fenced rather than move a total that is partly the
 * deck's. The drag takes the opposite rule on purpose, because a drag ends in a question
 * (`PickCopies`) and a stepper does not.
 *
 * The Alpha Lightning Bolt in `Binder` is the sentinel rather than scenery: the fence fails
 * **closed** while the census is loading, so a bare "no stepper" claim would pass over a page that
 * had simply not answered yet. A stepper on a tile in a folder the reader made can only exist once
 * it has.
 *
 * **Two views of the wall, one after the other**, because under `stories.test.tsx`'s layout stub
 * only the first few tiles are drawn (see {@link press}): Not sorted shut brings `Binder` up for
 * the sentinel, and then every shelf shut but the deck's own brings its group up for the claim.
 */
export const DeckCopiesAreNotStepped: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The census has answered, so a filed tile is allowed one.
    await press(canvas, "Collapse Not sorted");
    await expect(
      await canvas.findByRole(
        "spinbutton",
        { name: "Copies of Lightning Bolt (LEA 161)" },
        SETTLED,
      ),
    ).toBeInTheDocument();

    // The deck groups are shut by default; open this deck's the way a reader would, from its
    // heading — with everything else shut, so its tiles are the first the wall draws.
    await press(canvas, "Collapse all");
    await press(canvas, "Expand Modern Goodstuff");

    // The tile is a tile — art, badge, menu, drag — and only the control is missing. **Any**
    // stepper naming the card, rather than one spelt with a finish: a pattern demanding `Foil)`
    // passed over this seed's nonfoil copies whatever the page drew, since 2026-09-07 moved them.
    await expect(
      await canvas.findByRole("button", { name: "Counterspell" }, SETTLED),
    ).toBeInTheDocument();
    await expect(
      canvas.queryByRole("spinbutton", { name: /^Copies of Counterspell \(/ }),
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
 * **At the root, which is what a fresh install actually opens on**, so the sentence above is the
 * first thing that database says to anybody. With no folders and nowhere to have drilled into,
 * `statusOf`'s folder-shaped answer ("Nothing filed here yet.") is off, and only this story stands
 * where a reader first stands. {@link EmptyCabinet} is the same database seen from the path row,
 * where Add folder — the way to make a first folder — is the content.
 */
export const Empty: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Nothing here yet. Add cards from search, or import a collection file.",
        undefined,
        SETTLED,
      ),
    ).toBeInTheDocument();
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
    // The census first: with no folder list the page cannot yet say there is no trail, so the
    // breadcrumb's absence below would be read off a page that had not answered.
    await canvas.findByText(
      "Nothing here yet. Add cards from search, or import a collection file.",
      undefined,
      SETTLED,
    );
    const add = await waitFor(() => pathAddFolder(canvas), SETTLED);
    await expect(canvas.queryByRole("navigation", { name: "Collection folders" })).toBeNull();

    await userEvent.click(add);

    await expect(
      await canvas.findByRole("textbox", { name: "Folder name" }, SETTLED),
    ).toHaveFocus();
  },
};

/**
 * **Adding a folder** (spec §3.8): the new folder appears where it will live — last among its
 * siblings — as a heading whose name is the field, over an empty shelf, and the wall scrolls it
 * into view (`revealShelfId`). Typed on the line the name will occupy, so nothing reflows when ✓
 * lands.
 *
 * **The play shuts every shelf first**, and the press then opens `Binder` again on its own — a
 * shut parent opens so the new heading has somewhere to be drawn. That is not scenery: the reveal
 * is a scroll, and `stories.test.tsx` stubs `scrollTo` to nothing, so under that runner a new
 * heading below the window stays out of the DOM (see {@link press}). Shut, the wall is short
 * enough that the field lands inside the window without one.
 */
export const AddingAFolder: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The wall first — `Collapse all` folds the shelves the page has built (see {@link press}).
    await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);
    await press(canvas, "Collapse all");
    // Read back off the heading rather than assumed from the press: `Binder` is shut.
    const binder = await waitFor(() => {
      const box = headingNamed(canvas, "Binder");
      if (within(box).queryByRole("button", { name: "Expand Binder" }) === null) {
        throw new Error("Binder is still open");
      }
      return box;
    }, SETTLED);
    await expect(
      within(binder).getByRole("button", { name: "Expand Binder" }),
    ).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(within(binder).getByRole("button", { name: "Add folder in Binder" }));

    const field = await canvas.findByRole("textbox", { name: "Folder name" }, SETTLED);
    await expect(field).toHaveFocus();
    await expect(field).toHaveValue("");
    // Inside Binder, after Trade binder — last among its siblings.
    await expect(follows(headingNamed(canvas, "Trade binder"), field)).toBe(true);
  },
};

/** **Renaming** (spec §3.8): the heading's name becomes the field, and its figures stay beside it
 *  — which is how a reader checks they have the right drawer. */
export const RenamingAFolder: Story = {
  args: { view: "grid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const binder = await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);

    await userEvent.click(within(binder).getByRole("button", { name: "Rename Binder" }));

    const field = await canvas.findByRole("textbox", { name: "Rename Binder" }, SETTLED);
    await expect(field).toHaveValue("Binder");
    await expect(field.closest("[data-shelf-heading]")).toHaveTextContent(/\d+ cards?/);
  },
};

/**
 * **A heading mid-drag** (spec §3.9) — a story to drag in rather than to read, because the three
 * landings only exist under a pointer, and `src/test-drag.ts` cannot be imported into a play.
 *
 * Card view. Pick `Someday`'s heading up anywhere but its buttons: **every shelf folds to its
 * heading** for the length of the drag, the nested `Trade binder` included, so the whole tree is a
 * column of targets — and the heading you are holding stays under the pointer while the wall
 * shortens around it. Over another heading, the top quarter puts it **before** (a gold line above),
 * the bottom quarter **after** (below), and the middle **inside** (the heading's edge goes gold).
 * `Binder` onto its own `Trade binder` marks nothing: a folder can never land in itself or below.
 * Let go anywhere and the shelves unfold exactly as they were — nothing was written but the move
 * itself. The path row's breadcrumb segments take a folder too, filing it last in that level. The
 * deck groups' headings are not sources. In the table the wall does not fold (its rows are keyed
 * by position), and every heading is still a source and a target.
 */
export const DraggingAFolder: Story = { args: { view: "grid" } };

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
 * The sentence is `reconcile::sweep_orphans`', copied verbatim into `.storybook/fake/seeds.ts`'s
 * `MISSING_NOTE` — named rather than numbered, because a line number in prose routes to neither
 * CI job and this one had already drifted onto an unrelated row.
 */
export const NeedsReview: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const banner = await canvas.findByRole("status", { name: "Needs review" }, SETTLED);
    // Singular, because one row is flagged: "entries name" under a count of 1 is the kind of
    // wrongness a reader notices and a test does not.
    //
    // Written without a space after the colon, which is what the DOM really holds: the gap the
    // reader sees is the label's `mr-1` margin, not a character, so anything reading text
    // content — this assertion, a screen reader, a copy-paste — gets "Needs review:1". Measured
    // rather than assumed; the obvious spelling of this expectation fails.
    //
    // **Waited for, not read once**: the region is mounted before the summary it reports has
    // answered, so a read the moment it is found can see it empty.
    await waitFor(async () => {
      await expect(banner).toHaveTextContent(
        "Needs review:1 entry names a printing that changed or left the card database.",
      );
    }, SETTLED);
    // The unflagged rows are still on screen with it — a flag lists, it does not filter. Read
    // at the root this page opens on, so "still on screen" means every shelf's rows rather than
    // one level of them. Found rather than got: the rows are a different read from the banner's.
    await expect(await canvas.findByText("Urza's Saga", undefined, SETTLED)).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole("button", { name: "Show them" }));

    await waitFor(async () => {
      await expect(
        canvas.getByText(/This printing is not in the card database\./),
      ).toBeInTheDocument();
    }, SETTLED);
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
  // At the root, as the page opens: `largeSeed` files nothing, so the root is one shelf of the
  // same 600 rows here — which is the point worth stating, because it is what makes the count
  // below a claim about the virtualiser rather than about the cabinet.
  args: { view: "table" },
  parameters: { fake: { seed: "large" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Ancient Aegis", undefined, SETTLED)).toBeInTheDocument();
    // 600 rows, the header, and **Not sorted's band** — `VirtualTable` counts a shelf's heading
    // band as a row, and the loose 600 are one shelf with a heading at the root.
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "602",
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
    const decrease = await canvas.findByRole("button", { name: `Decrease ${label}` }, SETTLED);
    await userEvent.click(decrease);

    const alert = await canvas.findByRole("alert", undefined, SETTLED);
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
 * **It is read at the root, and that is a fact about the seed rather than about the stepper.**
 * The row with the acquisition story is filed in `Binder`, and the root's wall is every shelf, so
 * it is on screen under `Binder`'s heading and the play is one gesture — the press it is about. The
 * alternative was to pick a different row and lose the provenance the whole argument above rests
 * on.
 */
export const ZeroDeletesTheRow: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Quantity of Lightning Bolt (Nonfoil, HP)";
    const box = await canvas.findByRole("spinbutton", { name: label }, SETTLED);
    await expect(box).toHaveValue(1);

    await userEvent.click(canvas.getByRole("button", { name: `Decrease ${label}` }));

    // The row leaves the list. Addressed by a name built from its condition, so its absence is
    // a claim about this row and not merely about some row.
    await waitFor(async () => {
      await expect(canvas.queryByRole("spinbutton", { name: label })).toBeNull();
    }, SETTLED);
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

/**
 * **Correcting a copy from the row it is on** — the collection's own `Edit copy…`, and the app's
 * first press that reaches `collection_update` at all.
 *
 * The row is the whole fence. A table row *is* one `collection_entries` entry, so there is a copy
 * to be about; the wall's tile is the page's **summary** of a printing across however many entries
 * it happens to hold, and a dialog editing "the grade" of three rows at once would be choosing a
 * copy the reader never named. So the row offers the item and a tile does not — absent rather than
 * greyed, because it is missing from every tile of that wall and therefore reads as a fact about
 * the surface. {@link CardMode} is that surface; this is this one.
 *
 * **The dialog is seeded from the row it was opened on**, which is what the identity line under
 * the heading is for: a reader with a Near Mint Bolt in two binders is told which drawer this
 * question is about before they answer it.
 *
 * `Collection/Edit copy` is the dialog's own page, with the states this page cannot reach in one
 * press — a copy nobody has graded, a price recorded in another currency, a grade this build
 * cannot name.
 */
export const EditingACopy: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The proxy Black Lotus, filed in `Trade binder` — a table row is short enough that that
    // shelf's rows are inside `stories.test.tsx`'s window where a wall's tiles are not (see
    // {@link press}), and filed, so the identity line has a drawer to name rather than falling back
    // to `Collection`.
    const row = await canvas.findByRole("row", { name: /Black Lotus/ }, SETTLED);

    await userEvent.pointer({ keys: "[MouseRight]", target: row });
    await canvas.findByRole("menu");
    await userEvent.click(canvas.getByRole("menuitem", { name: "Edit copy…" }));

    const dialog = await canvas.findByRole("dialog", { name: "Edit copy" });
    // The copy, and the grade it is recorded at — read off the row rather than defaulted.
    await expect(within(dialog).getByText("LEA 232 · Nonfoil · Trade binder")).toBeInTheDocument();
    await expect(within(dialog).getByRole("button", { name: "Condition" })).toHaveTextContent(
      "Near mint",
    );
    // Nothing has changed yet, so there is nothing to write — and the button says so before the
    // press rather than after it.
    await expect(within(dialog).getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * The column that had to move to make room, and what it looks like when it is drawn beside the
 * binder — **the path by which a card the reader does not own yet gets into the drawer they are
 * standing in.**
 *
 * The panel is `features/search/CardSearchPanel` with `features/search/CardSearchBody` inside it,
 * the same two the deck editor draws; what this page supplies is the destination. A press on a
 * tile's `+` files into the folder on screen — the trigger says so before the press, which is the
 * one part of what pressing it does that a screenshot cannot show — and a tile dragged onto a
 * shelf's heading files there too, as an `collection_add` rather than a refile.
 *
 * **The page opens at the root and files there** — there is no folder to be standing in until one
 * is opened from its heading's title — so out of the box this behaves exactly as every `+` in the
 * app already did.
 *
 * The two filter rows on screen are two `FilterBar`s over two different backends, told apart by
 * their boxes alone: `Search your collection` narrows the reader's binder, `Search cards` narrows
 * every printing Scryfall has published.
 */
export const WithSearch: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "Add cards to your collection" });

    // **Railed at rest** — `DEFAULT_SEARCH_OPEN` rails the two lists' columns and opens only the
    // deck's, because this page already draws a `FilterBar` of its own and below 544px the panel
    // is an overlay rather than a rail. Measured at seven widths in the shipped window on
    // 2026-09-07. The press is the reader's real entry point, so the play uses it.
    await userEvent.click(within(panel).getByRole("button", { name: "Expand card search" }));
    await expect(
      await within(panel).findByRole("button", { name: "Collapse card search" }),
    ).toHaveAttribute("aria-expanded", "true");

    // The two boxes, and the whole of what tells them apart.
    await expect(
      canvas.getByRole("searchbox", { name: "Search your collection" }),
    ).toBeInTheDocument();
    const box = await within(panel).findByRole("searchbox", { name: "Search cards" });

    // At the root the destination is the list's own name — never "no folder", which would
    // describe the same drawer the breadcrumb calls Collection.
    await userEvent.type(box, "Ancient Tomb");
    await expect(
      await within(panel).findByRole(
        "button",
        { name: /^Add Ancient Tomb .* to Collection$/ },
        SETTLED,
      ),
    ).toBeInTheDocument();

    // And in a drawer it is the drawer. `Binder` is the seed's own top-level folder, opened from
    // its heading's → — the way into a folder since issue #599 moved it off the title. Waited
    // for: the wall is its own reads, and nothing above has asked whether they have answered.
    const binder = await waitFor(() => headingNamed(canvas, "Binder"), SETTLED);
    await userEvent.click(within(binder).getByRole("button", { name: "Open Binder" }));
    await waitFor(async () => {
      await expect(
        within(panel).getByRole("button", { name: /^Add Ancient Tomb .* to Binder$/ }),
      ).toBeInTheDocument();
    }, SETTLED);
  },
};

/**
 * The panel at the narrowest a reader can drag it to, on the page whose list is taking the width.
 *
 * `MIN_PANEL_WIDTH_PX` is **206**, measured from one 150px card and the chrome around it, and the
 * page caps the drag at `min(⌊viewport / 2⌋, deskWidth − DESK_GAP − LIST_FLOOR)`. A **414px** row
 * is that cap landing exactly on the floor: 414 − 16 − 192 = 206.
 *
 * The thing this width forbids is an **overhang**. A flex item cannot shrink below its own
 * min-content, and this page scrolls inside `AppShell`'s `overflow-auto` `main` — so a control
 * that will not fit puts a horizontal scrollbar across the whole window, which is the
 * `ManaValueChips` failure `src/CLAUDE.md` records and the 1024px floor forbids.
 *
 * **Storybook is a real browser, so the play below reads it off the box rather than off a class.**
 * Under `src/stories.test.tsx` every rectangle is zero and the same three assertions are `0 === 0`
 * — true, and true of nothing. This story is where they mean something.
 */
export const Narrow: Story = {
  args: { view: "grid" },
  decorators: [
    // Inside the file's own 1032px box, because a story decorator is applied nearer the component
    // than a meta one. `h-full` so the page still has a height to be `h-full` of.
    (Story) => (
      <div className="h-full w-[414px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "Add cards to your collection" });
    const toggle = within(panel).getByRole("button", { name: /card search$/ });

    // Drawn beside the list rather than over it: 206 is the floor, not below it.
    await expect(panel).not.toHaveAttribute("data-search-over");

    // Railed at rest — see {@link WithSearch} — and this story measures the *open* panel at its
    // floor. The disclosure is the same element across the press, so the row read off it is the
    // same box either way.
    await userEvent.click(toggle);

    // Nothing overhangs — the panel, its title row, and its own filter row, which is the piece
    // most likely to break at this width because it is the one with ten chips in it.
    const row = toggle.parentElement!;
    await expect(panel.scrollWidth).toBe(panel.clientWidth);
    await expect(row.scrollWidth).toBe(row.clientWidth);
    const filters = (await within(panel).findByRole("searchbox", { name: "Search cards" }))
      .parentElement!;
    await expect(filters.scrollWidth).toBe(filters.clientWidth);
  },
};

/**
 * The row that cannot hold both — **the panel drawn _over_ the list at the row's full width.**
 *
 * Below the floor there is no third column to squeeze; `roomForPanel` goes false and the page
 * hands the panel the whole row as `overWidth`, so the search covers the binder instead of
 * refusing to open. On a phone that is the difference between a sidebar that exists and one that
 * is only ever a chevron that will not press.
 *
 * **There is no `Railed` story on this page, and that is arithmetic rather than an omission.**
 * The deck editor rails because its own overlay is suppressed while the card pane is open; this
 * page's card surface is a centred modal and takes width from nothing, so `panelOverWidth` is set
 * for *every* row too narrow to dock — `roomy === false` and `over === undefined` cannot both be
 * true here. The rail is `CardSearchPanel`'s own state and `DeckSearchPanel.stories`' `NoRoom` is
 * where it is drawn.
 *
 * **The overlay itself is a browser-only fact.** `src/stories.test.tsx` stubs `ResizeObserver` to
 * a no-op, so `deskWidth` never leaves 0 there and 0 reads as *unmeasured*, which is roomy — the
 * play below therefore asserts what is true in both places, and the placement is what a reader
 * (or a CDP pass) sees here.
 */
export const Overlaid: Story = {
  args: { view: "grid" },
  decorators: [
    // 380 − 16 − 192 = 172, which is under the 206 one card needs.
    (Story) => (
      <div className="h-full w-[380px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "Add cards to your collection" });

    // The disclosure never refuses on this page — there is always somewhere to draw the column,
    // beside the list or over it — so it is pressable at every width rather than `aria-disabled`.
    // It starts railed (see {@link WithSearch}), so the press is what this story is about: at a
    // width the row cannot dock, the disclosure still opens rather than refusing.
    //
    // **The placement is deliberately not asserted here.** As the note above says, this runner
    // stubs `ResizeObserver` to a no-op, so `deskWidth` never leaves 0 and 0 reads as roomy — the
    // overlay is a browser-only fact and `data-search-over` is absent under the suite. What is
    // true in both places is that the control opens and the list survives underneath.
    const toggle = within(panel).getByRole("button", { name: /card search$/ });
    await expect(toggle).not.toHaveAttribute("aria-disabled");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // And the list is still mounted underneath rather than replaced: an overlay covers the binder
    // for as long as the reader wants the search, and one press gives it back.
    await expect(canvas.getByRole("searchbox", { name: "Search your collection" })).toBeInTheDocument();
  },
};
