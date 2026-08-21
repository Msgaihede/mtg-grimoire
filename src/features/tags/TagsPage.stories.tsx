import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { HIDE_BACKGROUND_LABEL } from "./TagChips";
import { TagsPage } from "./TagsPage";

/** The weight control's accessible name is its whole `title`, so a query for it matches on the
 *  label and lets the explanation follow. */
const FLOOR = new RegExp(`^${HIDE_BACKGROUND_LABEL}`);

/**
 * The result caption, found by its element as well as by its words.
 *
 * **A bare `getByText("3 cards")` is ambiguous on this page, and not by accident of the
 * fixture.** The rail draws each tag's reach in the same grammar — `protection` reaches
 * `3 cards` — so the caption under the wall and a row in the column beside it read identically.
 * The selector picks the caption because it is a **paragraph** and a rail row's count is a
 * `<span>` inside a button.
 *
 * **It is not the page's only `role="status"` paragraph** — `TagTree` mounts a second one for
 * the hidden-tags sentence, empty until a tag is hidden — so this narrows rather than
 * identifies, and it is enough only because that element never holds a card count. A story
 * that needs the caption *itself* should reach for the element, not for these words.
 */
const CAPTION = { selector: "p[role='status']" } as const;

const meta = {
  title: "Tags/Page",
  component: TagsPage,
  tags: ["autodocs"],
  decorators: [
    // The page is `h-full`, so it needs a parent with a height or its two columns are handed a
    // 0px window and the wall's virtualiser draws nothing. 1032px is exactly the content column
    // at the app's narrow rung — the 1280-wide window `src-tauri/src/window.rs` opens on a 1080p
    // desk, less the sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px). The
    // height is chosen rather than derived; the ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Browse the corpus by what a card **is of** rather than by what it is called.\n\n" +
          "A reader types a motif, sees the tags that match it, drills into one, and gets a wall " +
          "of cards they can filter to their commander's colours and drag into a deck. Art " +
          "themes are the primary use and oracle tags the secondary one, which is why the " +
          "taxonomy chooser opens on `Both` and why the empty-state notice names the art file " +
          "first.\n\n" +
          "Driven end to end by `.storybook/fake/`: `tag_children` fills the rail, `tag_search` " +
          "answers the box, and `search_cards` answers the wall under the chips — so a story " +
          "that disagrees with the app is the app or the fake changing, never a fixture going " +
          "stale.\n\n" +
          "**The page opens on 46 cards where `Search/Page` opens on 37, and the difference is " +
          "the one thing this page does differently.** Collapse is **off** here " +
          "(`useCardSearch`'s `defaultAllPrintings`), because an art tag is a fact about *this " +
          "illustration* — a collapsed row would stand for five printings and be drawn by " +
          "whichever is newest, showing a reader a picture that need have nothing to do with " +
          "the motif they searched for. Art results are printings. The corpus is 52 printings, " +
          "two of them digital (`paperOnly` is omitted-means-true) and four legal in none of " +
          "Scryfall's formats (`playableOnly` rides with every format row but `Any card`), which " +
          "is 52 → 50 → **46**. Measured 2026-08-22 by calling " +
          "`readHandlers(seed(\"starter\")).search_cards` with this page's own request.\n\n" +
          "**The fake's motifs are the ones its 52 printings actually carry, and there is no " +
          "`dog` among them.** What the seed does carry is every *shape* the page needs: a " +
          "category reached only through its children (`animal`, via `cat` and `monkey`), a tag " +
          "under two parents (`forest`, under `plant` and `landscape`), one `weak` tagging so " +
          "the weight floor visibly changes a wall (`landscape`, 3 illustrations open and 2 " +
          "floored), and a tag on one printing but not its siblings (`lightning`, on 1 of the 4 " +
          "Lightning Bolts).\n\n" +
          "**Two of the four taxonomy worlds have stories here and the other two are the same " +
          "two one dataset over.** A fault is one value, so no story can be missing *both* " +
          "taxonomies at once; `artTagsMissing` and `oracleTagsMissing` are separate faults " +
          "precisely because the datasets are two files on two schedules, and the page has to " +
          "stand in all four.\n\n" +
          "**The rail is not virtualised, and the real taxonomy has thousands of art roots** " +
          "against the fake's four — so nothing here can feel that first paint. The live pass " +
          "measured it in the shipped window on 2026-08-20 (debug build, 1920×1080, real " +
          "taxonomy ingested) and it stays unvirtualised: 4,142 rows painted in 575–673 ms and " +
          "then scrolled at full frame rate. See `docs/reference/tags-live-findings.md`, which " +
          "also carries the two things that pass *did* find in this rail — names rendering one " +
          "pixel wide, and the hit list inheriting the tree's disclosures — and " +
          "`docs/superpowers/research/2026-08-20-scryfall-art-tags.md` for a dated root count, " +
          "which is where one belongs: Scryfall regenerates that file daily.",
      },
    },
  },
} satisfies Meta<typeof TagsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The page as a reader arrives at it: nothing picked, both taxonomies offered, the whole
 * playable corpus in the wall.
 *
 * The rail leads with the widest-reaching tags across both files — `Card Advantage` reaches 10
 * oracle cards, `Creature` 6 illustrations — and the unit changes with the taxonomy, because an
 * art tag counts **pictures** and an oracle tag counts cards.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("46 cards", CAPTION)).toBeInTheDocument();
    await expect(
      await canvas.findByRole("button", { name: "Creature, art tag, 6 illustrations" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Card Advantage, oracle tag, 10 cards" }),
    ).toBeInTheDocument();

    // Nothing picked is an invitation rather than a blank, and the weight control beside it is
    // greyed rather than absent — an option that vanishes reads as a control that broke.
    await expect(
      canvas.getByText("No tags picked yet. Pick one from the list to narrow the cards."),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: FLOOR })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // Both taxonomies are ingested in this world, so the never-downloaded notice is absent.
    await expect(canvas.queryByText(/tags have not been downloaded yet\./)).toBeNull();
  },
};

/**
 * A motif picked, and then the weight floor — the two presses the page exists for.
 *
 * `Landscape` reaches three illustrations: the Unfinity Forest, the Alpha Island, and Llanowar
 * Elves — where the elf is the subject and the wood behind her is the background element
 * Scryfall's definition of `weak` names. Pressing **{@link HIDE_BACKGROUND_LABEL}** drops that
 * tagging and the wall goes to two.
 *
 * That is the whole argument for the control's wording: the predicate is `ati.weight <> 'weak'`,
 * so it admits `median` — most of the corpus — and does not narrow to strong matches at all. It
 * drops background detail, and the words say only that.
 */
export const AMotifAndItsFloor: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("46 cards", CAPTION);

    await userEvent.click(
      await canvas.findByRole("button", { name: "Landscape, art tag, 3 illustrations" }),
    );

    // The chip carries its taxonomy for the rest of its life, and the rail row now says it is
    // picked — two drawings of one fact, which is what lets a reader look away and come back.
    await expect(
      await canvas.findByRole("button", {
        name: "Landscape, art tag, included. Press to exclude.",
      }),
    ).toBeInTheDocument();
    await waitFor(
      async () => {
        await expect(canvas.getByText("3 cards", CAPTION)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const floor = canvas.getByRole("button", { name: FLOOR });
    // Live now, because there is an art *include* for it to narrow. The floor rides that arm
    // alone: `oracle_tag_cards` has no `weight` column, and a floor on an exclude would let weak
    // forests back into a result the reader asked to have none in.
    await expect(floor).not.toHaveAttribute("aria-disabled");

    await userEvent.click(floor);

    await waitFor(
      async () => {
        await expect(canvas.getByText("2 cards", CAPTION)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    await expect(canvas.getByRole("button", { name: FLOOR })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * The type-ahead, and the tag it finds under a name the rail never showed.
 *
 * `Forest` is not a root — it sits under `plant` and under `landscape` — so the only way to it
 * without opening a branch is the box. The tree is replaced by the hit list while there is text
 * in the box: the two are alternatives, not a list under a list.
 */
export const SearchingForATag: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("46 cards", CAPTION);

    // The label is `sr-only`, which is the whole of what this control is called.
    await userEvent.type(canvas.getByRole("searchbox", { name: "Search tags" }), "forest");

    const hits = await canvas.findByRole("list", { name: "Matching tags" }, { timeout: 5000 });
    await waitFor(
      async () => {
        await expect(
          within(hits).getByRole("button", { name: "Forest, art tag, 2 illustrations" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    await userEvent.click(
      within(hits).getByRole("button", { name: "Forest, art tag, 2 illustrations" }),
    );

    // Two illustrations, two printings: the Unfinity Forest and Llanowar Elves.
    await waitFor(
      async () => {
        await expect(canvas.getByText("2 cards", CAPTION)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  },
};

/**
 * The art taxonomy has never been downloaded — **not a failure, and it must not read as one.**
 *
 * It is what every install is on its first launch and what a machine that cannot reach Scryfall
 * stays in permanently. The page still works for whichever file *did* arrive, which is why each
 * taxonomy gets its own line rather than one sentence about "tags": the rail is short an entire
 * file, and without the notice a reader typing `forest` into a page that has only oracle tags
 * would blame their spelling.
 *
 * `ingestedAt` is the test and `stale` is not — the latter is true of a taxonomy that is merely
 * due a refresh, which is a page with every tag in it.
 */
export const ArtTagsMissing: Story = {
  parameters: { fake: { fault: "artTagsMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByText("Art tags have not been downloaded yet."),
    ).toBeInTheDocument();
    // One line per taxonomy, and the oracle file is fine in this world.
    await expect(canvas.queryByText("Oracle tags have not been downloaded yet.")).toBeNull();
    // Direction rather than mood, and it is the whole of what a reader can do: there is no
    // button for this anywhere in the app.
    await expect(
      canvas.getByText("The app fetches them in the background. Nothing here needs a press."),
    ).toBeInTheDocument();

    // The rail keeps the taxonomy that *did* arrive rather than going empty…
    await expect(
      await canvas.findByRole("button", { name: "Card Advantage, oracle tag, 10 cards" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /, art tag, / })).toBeNull();
    // …and the wall is untouched, because no chip is narrowing it.
    await expect(await canvas.findByText("46 cards", CAPTION)).toBeInTheDocument();
  },
};

/**
 * The download failed — **and the page does not change**, which is the entire claim.
 *
 * A failed refresh leaves the taxonomy already ingested exactly where it was: an art theme
 * somebody is mid-deck on must not evaporate because a download timed out. So `art_tags_refresh`
 * writes the reason to `error_log`, emits its terminal `error` phase, and touches nothing else —
 * the rail keeps its tags, the wall keeps its cards, and no notice appears, because
 * `ingestedAt` is still set.
 *
 * The play forces the refresh itself, because **nothing on this page can**: the app asks Scryfall
 * on every launch that is due one, and there is no button. Without that press the fault would be
 * unobservable here and the story would be a second copy of {@link Default}. The reason lands in
 * `error_log`, which is `Settings/ErrorLogPanel`'s subject and not this page's.
 */
export const ArtTagsFetchError: Story = {
  parameters: { fake: { fault: "artTagsFetchError" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("46 cards", CAPTION);
    await canvas.findByRole("button", { name: "Creature, art tag, 6 illustrations" });

    // `force`, because the seed's watermark is inside the weekly window and a refresh that is
    // not due answers the status it already had and emits nothing.
    await expect(ipc.artTagsRefresh(true)).rejects.toThrow(/could not be downloaded/);

    // The terminal `error` event reaches the page's listener, which refetches the status and
    // re-reads both tag lists. Everything comes back the same.
    await waitFor(
      async () => {
        await expect(
          canvas.getByRole("button", { name: "Creature, art tag, 6 illustrations" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    await expect(canvas.queryByText(/tags have not been downloaded yet\./)).toBeNull();
    await expect(canvas.getByText("46 cards", CAPTION)).toBeInTheDocument();
  },
};
