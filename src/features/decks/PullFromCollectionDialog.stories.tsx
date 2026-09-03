import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { DeckPullCandidate, DeckPullRow } from "@/lib/ipc";
import { openDropdown } from "@/test-dropdown";
import { PullFromCollectionDialog } from "./PullFromCollectionDialog";

/**
 * The source picker's accessible name.
 *
 * **A dropdown's trigger is a `button`, not a `combobox`**, so an absence assertion written
 * against `combobox` finds nothing whether or not the picker was drawn. `From` is the visible
 * word and the rest is the `sr-only` half that makes the name per card, joined inside one
 * `<label>`; spelling it out whole here is what would fail if that half were dropped.
 */
const sourceName = (printing: string) => `From, which copy of ${printing} to pull`;

/**
 * How long a `waitFor` will wait for one animation frame.
 *
 * The dialog fades and scales in, so its first painted frame is at `opacity: 0` — and
 * `toBeVisible` walks the ancestors, so *nothing* inside it is visible until that lands. Under
 * the suite's `MotionGlobalConfig.skipAnimations` that is one frame away rather than 260ms, but
 * it is still a frame, and `findBy*` resolves on the render before it. One wait per play: once
 * the surface has arrived, everything under it is visible in the same tick.
 *
 * The timeout is generous on purpose — what is being waited for is a `requestAnimationFrame`,
 * jsdom has no compositor, and the whole suite is dozens of files in parallel.
 */
const FRAME_WAIT = 5_000;

/** The loose English near-mint copy at the root — what a candidate is unless a row says
 *  otherwise. Every optional trait is off, so a story that turns one on is showing that trait
 *  and not a fixture. */
function candidate(over: Partial<DeckPullCandidate> = {}): DeckPullCandidate {
  return {
    entryId: 1,
    quantity: 1,
    folderId: null,
    folderName: null,
    folderKind: null,
    condition: "NM",
    lang: "en",
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    serialNumber: null,
    ...over,
  };
}

/**
 * The ordinary row: three copies short, three loose copies in one place, nothing to decide.
 *
 * The card ids are the workbench corpus's own, so the art beside each name is the fake's
 * generated crop for that exact printing rather than an "Unknown card" placeholder.
 */
const BOLT: DeckPullRow = {
  cardId: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
  name: "Lightning Bolt",
  setCode: "2x2",
  collectorNumber: "117",
  finish: null,
  short: 3,
  categories: ["Removal"],
  imageUris: null,
  candidates: [candidate({ entryId: 11, quantity: 3 })],
};

/**
 * The row the issue is about: the same printing in two places, so the dialog has to ask.
 *
 * It is also the row that takes from **two** sources at once — the root holds one and the binder
 * holds two, so the pre-picked plan spends the loose copy first and tops the line up out of the
 * binder. That is what makes `2 of 2` true of a row whose opening source cannot cover it alone.
 */
const BOROS_CHARM: DeckPullRow = {
  cardId: "d4ddf9cc-40a7-4b4f-bb51-b08171453c9a",
  name: "Boros Charm",
  setCode: "gtc",
  collectorNumber: "148",
  finish: null,
  short: 2,
  categories: ["Burn", "Sideboard"],
  imageUris: null,
  candidates: [
    candidate({ entryId: 21, quantity: 1 }),
    candidate({
      entryId: 22,
      quantity: 2,
      folderId: 3,
      folderName: "Modern binder",
      folderKind: "user",
      condition: "LP",
    }),
  ],
};

/** Two wanted, one owned loose — the row the collection cannot cover, which is a statement and
 *  not a fault. Foil, so the row also carries the mark that tells two lines of one printing
 *  apart. */
const SWORDS: DeckPullRow = {
  cardId: "b6bafa7b-62a4-477c-b2f5-6b9d26c6cbf4",
  name: "Swords to Plowshares",
  setCode: "ema",
  collectorNumber: "32",
  finish: "foil",
  short: 2,
  categories: ["Removal"],
  imageUris: null,
  candidates: [
    candidate({
      entryId: 31,
      quantity: 1,
      folderId: 7,
      folderName: "Recently removed",
      folderKind: "removed",
    }),
  ],
};

/**
 * What the deck is short of that is already on the reader's desk.
 *
 * **It reaches nothing** — no query, no mutation, no fake world. The plan, the two read states
 * and the write all arrive as props, which is `DeckSettingsForm`'s fence applied to a surface
 * that does have a button: every frame below is an argument rather than a seeded database, and a
 * stray query added to the component later would break these stories rather than pass them.
 *
 * The art is the workbench's own, because the ids are the corpus's own — the frames come through
 * `CardImage` and `@/lib/images`, which `.storybook/main.ts` aliases to the fake.
 */
const meta = {
  title: "Decks/PullFromCollectionDialog",
  component: PullFromCollectionDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    deckName: "Boros Burn",
    rows: [BOLT, BOROS_CHARM, SWORDS],
    loading: false,
    readError: null,
    pull: {
      mutate: fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    },
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A deck lists four Lightning Bolts and physically holds one, so the editor reads " +
          "*3 missing* — and three more are sitting in a binder. This is the one press that " +
          "puts the shortfall and the shelf together (issue #351).\n\n" +
          "**It is `Send missing to wishlist` read the other way.** That button asks the same " +
          "question of the copies the reader has *not* got; this is the half that can be " +
          "answered without spending anything.\n\n" +
          "**The reader is almost never deciding anything.** Every row arrives ticked on a " +
          "source the backend has already ranked, and the ordinary act is one press on the " +
          "footer. What the body is *for* is the minority of rows where a choice exists — the " +
          "issue's own request, *if redundant options exist in different folders, prompt the " +
          "user to choose* — and the minority the collection cannot cover. Both are drawn " +
          "beside the row as facts rather than as questions that stop the press.\n\n" +
          "**A picker is drawn only where there is more than one candidate.** A control " +
          "offering one option reads as a decision and is not, so the same sentence is printed " +
          "as plain text instead — one row with and without a decision in it, rather than two " +
          "shapes of row. The picker is `Dropdown`, which is the only kind of option list left " +
          "in this app, and it is drawn inside a `Dialog` the way `CategoriesDialog`'s delete " +
          "confirmation is.\n\n" +
          "**An empty plan is the ordinary answer, not a failure.** A pull moves only the " +
          "exact printing *and finish* the list names, and never a copy another deck is " +
          "already holding — so a deck reading *12 missing* can legitimately have nothing to " +
          "pull, and the panel says why rather than going blank.",
      },
    },
  },
} satisfies Meta<typeof PullFromCollectionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The whole plan: three rows, six copies, every one of them ticked.
 *
 * The three rows are deliberately the three shapes this dialog has — a line one loose pile
 * covers outright, a line spread over two places, and a line the collection cannot finish — so
 * one frame shows what the reader will actually meet. The footer counts copies **and** cards,
 * because the button below it can only carry one of the two.
 */
export const Review: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await expect(canvas.getByText("6 copies across 3 cards")).toBeVisible();

    // The row with nothing to decide states its source rather than offering it.
    const bolt = canvas.getByRole("checkbox", { name: "Pull Lightning Bolt, 3 copies" });
    const boltRow = within(bolt.closest("li")!);
    await expect(boltRow.queryByRole("button", { name: sourceName("Lightning Bolt") })).toBeNull();
    await expect(boltRow.getByText("From Collection · Near mint · 3 copies")).toBeVisible();

    // The press carries one pick per *source*, so the two-source row is two entries.
    await userEvent.click(canvas.getByRole("button", { name: "Pull 6 copies" }));
    await expect(args.pull.mutate).toHaveBeenCalledWith([
      { entryId: 11, quantity: 3 },
      { entryId: 21, quantity: 1 },
      { entryId: 22, quantity: 1 },
      { entryId: 31, quantity: 1 },
    ]);
  },
};

/**
 * The one question the issue actually asked for: the same printing in the root and in a binder.
 *
 * Each option names where the copy sits and what tells it from its siblings — the folder first,
 * because the backend's pre-pick order *is* a folder order and the list therefore reads in the
 * order it is ranked in. Picking the binder moves the whole line onto that entry, which the play
 * asserts at the wire rather than on the screen: the words changing is not the same claim as the
 * press changing.
 */
export const PickingASource: Story = {
  args: { rows: [BOROS_CHARM] },
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Boros Charm")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    const user = userEvent.setup();

    // The trigger says the picked *row*, which is what the reader reads — the entry id behind it
    // is not on screen and is not what this frame is about.
    await expect(canvas.getByRole("button", { name: sourceName("Boros Charm") })).toHaveTextContent(
      "Collection · Near mint · 1 copy",
    );

    // Opened once and the row clicked out of the open panel, rather than `openDropdown` followed
    // by `pickOption`: that helper opens the dropdown itself, and a second press on a trigger
    // whose panel is already up closes it.
    await openDropdown(user, sourceName("Boros Charm"));
    await expect(canvas.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection · Near mint · 1 copy",
      "Modern binder · Lightly played · 2 copies",
    ]);
    await user.click(
      canvas.getByRole("option", { name: "Modern binder · Lightly played · 2 copies" }),
    );

    // The binder holds both copies, so preferring it collapses two takes into one.
    await user.click(canvas.getByRole("button", { name: "Pull 2 copies" }));
    await expect(args.pull.mutate).toHaveBeenCalledWith([{ entryId: 22, quantity: 2 }]);
  },
};

/**
 * **The same dialog opened from one card's right-click** — `Collection ▸ Pull 2 from your
 * collection` (issue #350).
 *
 * The subtitle is the *whole* of the difference: it names the card instead of the deck's
 * shortfall, because a panel headed `Pull from collection` over a single row, saying *cards this
 * deck is short of*, reads as a plan that has lost the rest of itself. The heading does not move —
 * it says what the press does, and that is the same act at either scope.
 *
 * **The narrowing is the caller's and never this component's.** The editor filters the same cached
 * plan to the card's `pullKey` and hands over what is left, so nothing here holds a notion of a
 * key and the two entrances cannot come to disagree about which rows belong to which card. That
 * is why this story is one `args` line rather than a second component.
 *
 * **It opens at all only where there is a decision in it**: `choosePull` takes a lone candidate
 * outright with no dialog, and sends two or more — this row — here. None comes here too, so that
 * {@link NothingToPull}'s three sentences do the explaining rather than a banner that could only
 * have said the search found nothing.
 */
export const OneCard: Story = {
  args: { rows: [BOROS_CHARM], cardName: "Boros Charm" },
  play: async ({ canvas }) => {
    await waitFor(
      async () =>
        await expect(
          await canvas.findByText("Copies of Boros Charm you already own — into Boros Burn"),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    // The heading is unchanged, which is the half a reader would notice if it were not.
    await expect(canvas.getByRole("heading", { name: "Pull from collection" })).toBeVisible();
    await expect(
      canvas.queryByText("Cards this deck is short of that you already own — into Boros Burn"),
    ).toBeNull();
    await expect(canvas.getByText("2 copies across 1 card")).toBeVisible();
  },
};

/**
 * A line the collection cannot finish: two foil copies wanted, one sitting in `Recently removed`.
 *
 * **The sentence is a statement, not a warning.** It is the ordinary answer for a deck that is
 * genuinely short, so it carries no live-region role and none of the destructive colour — a
 * reader's own binder reported as an error is the one thing it must never read as. What the
 * collection *can* cover is still offered, which is why the row is drawn at all.
 */
export const PartlyCovered: Story = {
  args: { rows: [SWORDS] },
  play: async ({ canvas }) => {
    await waitFor(
      async () => expect(await canvas.findByText("Swords to Plowshares")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await expect(canvas.getByText(/still missing/)).toHaveTextContent(
      "1 copy still missing — nothing else you own loose matches this printing.",
    );
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Pull 1 copy" })).toBeEnabled();
  },
};

/** The read in flight. No skeleton rows: a list that briefly draws cards it has not been given
 *  is a list a reader would start ticking. */
export const Reading: Story = {
  args: { rows: null, loading: true },
  play: async ({ canvas }) => {
    await waitFor(
      async () => expect(await canvas.findByText("Reading your collection…")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    await expect(canvas.queryByText("Nothing to pull.")).toBeNull();
  },
};

/**
 * The read refused, in the backend's own words and where the rows would have been.
 *
 * No retry button: the host re-reads the next time this opens, and every deck write in the app
 * already invalidates the key it sits under.
 */
export const ReadRefused: Story = {
  args: { rows: null, readError: "database is locked" },
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("database is locked")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    await expect(canvas.getByRole("button", { name: "Pull 0 copies" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * Nothing to pull — and the frame that has to work hardest, because it is the one a reader
 * reaches from a header telling them the deck is short of a dozen cards.
 *
 * Drawn as a bare blank panel it reads as a query that failed, so the panel says why the two
 * numbers are allowed to disagree: the pull is narrowed to the exact printing and finish, and to
 * copies no other deck is holding.
 */
export const NothingToPull: Story = {
  args: { rows: [] },
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("Nothing to pull.")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await expect(canvas.getByText(/exact printing and finish/)).toHaveTextContent(
      "never a copy another deck is already holding",
    );
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
