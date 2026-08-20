import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { DeckWalkStop } from "@/features/decks/deckWalk";
import { useDeck } from "@/features/decks/useDeck";
import type { PrintingsResponse } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { readHandlers } from "../../../.storybook/fake/db";
import { printing } from "../../../.storybook/fake/fixtures";
import { seed } from "../../../.storybook/fake/seeds";
import { AllPrintingsDialog } from "./AllPrintingsDialog";

/**
 * The card every filter story is told through: **`Ancient Aegis`, from the `large` seed.**
 *
 * Not a real card, and that is what makes it the right one. The whole corpus's most reprinted
 * card is Lightning Bolt with **four** printings across four sets, which is a list rather than a
 * wall — nothing to narrow, no set worth pressing twice, and a language picker with one row in
 * it. `large`'s synthetic cards are eight printings each, and `seeds.ts` builds them by taking
 * the *card-shaped* columns from one real row and the *printing-shaped* ones from a second, per
 * printing: so eight rows agree about the card and differ about the set, the artist, the
 * language, the finishes and the frame, which is the only thing a printings list is about.
 *
 * Measured 2026-08-18 over `readHandlers(seed("large")).card_printings`: **8 printings in 6
 * sets** (three in Limited Edition Alpha, one each in 2X2, SLD, STA, 2ED and UNF), **7 English
 * and 1 Japanese**, three foil, one etched, three full-art, three borderless, and **no promo,
 * showcase or extended-art printing at all** — which is what puts three greyed chips on the row
 * and makes {@link Default} able to show a treatment that is out of reach rather than missing.
 *
 * Looked up by name rather than by its id: the synthetic ids are minted by a counter in
 * `seeds.ts` and are not a constant this file may assume, and a lookup that finds nothing throws
 * here rather than opening a modal onto an empty wall that reads as a broken component.
 */
const REPRINTED = largeCard("Ancient Aegis");

/** Sol Ring's Commander 2021 printing — the row deck 2 (`Kenrith Two-Drops`) plays in its Main
 *  deck, and therefore the slot every deck story below swaps. `sld 913` is the corpus's only
 *  other Sol Ring, which is what makes two printings enough to prove a swap. */
const SOL_RING_C21 = printing("c21", "263");

/**
 * The page size the modal asks the backend for, copied from `AllPrintingsDialog`'s own
 * `PRINTINGS_PAGE` because that constant is module-private.
 *
 * It is only needed to *address the cache* — {@link Truncated} seeds an answer the fake cannot
 * produce, and a query key is exact. A copy is safe here because it cannot rot silently: the day
 * the modal asks for a different page, this key stops matching, that story's seeded answer is
 * ignored, and its play fails on the count line rather than passing over a stale fixture.
 */
const PRINTINGS_PAGE = 1000;

/** One synthetic oracle card of the `large` seed, by the name `seeds.ts` mints for it. */
function largeCard(name: string): { oracleId: string; name: string } {
  const row = seed("large").cards.find((card) => card.name === name);
  if (!row) throw new Error(`No synthetic card called ${name} in the large seed`);
  return { oracleId: row.oracleId, name: row.name };
}

/**
 * The deck slot a menu row would have handed the modal — **read out of the seed, never written
 * down.**
 *
 * A `PaneDeckContext` is all five parts of a deck card's grain, and three of them are the seed's
 * to mint: the category id comes from its own row numbering, the category *name* is the user's
 * word for it (schema v8 made it a row rather than one of five fixed zones), and the finish is
 * whichever object that row plays. Looking the trio up through the deck card itself is also the
 * honest staging — it is exactly the row a reader would have right-clicked to open this modal.
 *
 * `CardDetailPane.stories.tsx` carries the same helper. Neither can export it: every non-default
 * export of a CSF file is indexed as a *story*, and `.storybook/fake/fixtures.ts` is where a
 * shared one would go — see that file's header for the whole of that argument.
 */
function slotOf(deckId: number, cardId: string): PaneDeckContext {
  const db = seed("starter");
  const row = db.deckCards.find((card) => card.deckId === deckId && card.cardId === cardId);
  const category = db.deckCategories.find((c) => c.id === row?.categoryId);
  if (!row || !category) throw new Error(`Deck ${deckId} holds no ${cardId}`);
  return {
    deckId,
    categoryId: category.id,
    categoryName: category.name,
    cardId,
    // The list every seeded deck's rows are in, and the one the swap below is addressed to.
    variant: "live",
    finish: row.finish,
  };
}

/**
 * One deck's live rows as a walk the modal can step along — **the shape `DeckEditor` publishes.**
 *
 * `store.deckWalk` is the open editor's cards in the order the desk is drawing them, which depends
 * on that editor's grouping, its sorting and its filter; the modal is mounted at `App` level and
 * has no way to ask, so the editor hands it over. A story has no editor, so it writes the field
 * directly — the *order* is `DeckEditor`'s claim and belongs to that component's tests, and what
 * is staged here is only the fact that there is a walk at all.
 *
 * The seed's own row order stands in for the desk's. It is built the way {@link slotOf} builds one
 * slot and for the same reason: **the fake stores table rows and derives DTOs**, so a deck card row
 * carries a category *id* and a denormalised name and neither the category's word nor the card's
 * oracle id — those are looked up, exactly as the backend's own SELECT joins them.
 *
 * A row whose printing has left the corpus is dropped rather than carried: an orphan has no oracle
 * id, and an oracle id is the whole of what this modal is opened by.
 */
function deckWalkOf(deckId: number): DeckWalkStop[] {
  const db = seed("starter");
  const stops: DeckWalkStop[] = [];
  for (const row of db.deckCards) {
    if (row.deckId !== deckId || row.variant !== "live") continue;
    const card = db.cards.find((c) => c.id === row.cardId);
    const category = db.deckCategories.find((c) => c.id === row.categoryId);
    if (!card || !category) continue;
    stops.push({
      oracleId: card.oracleId,
      name: row.name,
      deck: {
        deckId,
        categoryId: category.id,
        categoryName: category.name,
        cardId: row.cardId,
        variant: "live",
        finish: row.finish,
      },
    });
  }
  return stops;
}

/**
 * Deck 2's walk, and the stop {@link SteppingTheDeck} opens on.
 *
 * **The second card rather than a card named here**, which is what keeps the story honest against
 * a seed that gains or loses rows: index 1 has a neighbour on both sides by construction, so both
 * chevrons are live and neither end state is being shown by accident. Naming a card instead would
 * be a claim about where that card sits in somebody else's deck.
 */
const DECK_2_WALK = deckWalkOf(2);
const WALK_FROM = DECK_2_WALK[1];

/**
 * A page the fake cannot answer with: **the real rows, under a count no fixture can reach.**
 *
 * The backend truncates a printings list and reports the untruncated count beside it, so the
 * modal has a third wording for `items.length < total`. Nothing in the workbench can produce it:
 * the fake's `card_printings` caps at `MAX_PRINTINGS` (400) exactly as `card.rs` does, and the
 * largest oracle card in either seed has eight printings. Only the five basic lands exceed 400 in
 * the real database at all.
 *
 * So the *items* are the fake's own — the same handler this story's world would run, over the
 * same memoised corpus — and only the count is raised. That is the smallest possible fiction: it
 * stages the one fact a fixture cannot have, and leaves every row on the wall a row the workbench
 * really answered with.
 */
function truncatedPage(oracleId: string, total: number): PrintingsResponse {
  const answer = readHandlers(seed("large")).card_printings({
    oracleId,
    marketplace: DEFAULT_MARKETPLACE,
  });
  return { items: answer.items, total };
}

/**
 * The modal, opened the way the app opens one — through the store, never through a prop.
 *
 * `AllPrintingsDialog` takes **no props at all**: it reads `printingsRequest`, draws nothing when
 * it is null, and is mounted once in `App.tsx` over whatever view is up. That is the whole of the
 * change it exists for, so a story has to open it the same way a menu row does — one store write,
 * and nothing else moves.
 *
 * **The box above the modal is not scenery.** The old `View all printings` had two destinations
 * and both *moved the reader*: from the Collection it navigated to Search with the open card
 * cleared, and inside the deck editor it opened the 384px card pane. The claim this modal makes
 * is that the surface underneath survives — so these stories draw a surface underneath, and the
 * deck ones draw the actual row the swap rewrites, read back through `useDeck` from the same
 * `deck_get` the modal's own `useSwapFromPane` mounted.
 *
 * **`useState`'s lazy initializer rather than an effect**, which is `CardDetailPane.stories.tsx`'
 * answer and for its reason: an effect runs after the first paint, so the modal would render one
 * frame closed — and {@link Truncated}'s seeded answer would land one frame after the query that
 * was supposed to find it, which is a refetch rather than a fixture.
 */
function Printings({
  oracleId,
  name,
  deckId,
  heldCardId,
  walkDeckId,
  truncatedTo,
}: {
  /** The oracle card whose printings are being asked for. */
  oracleId: string;
  /** Its name — the modal's title, and the name every tile is announced under. A `Printing`
   *  carries none, because a name is a fact about the card and not about the cardboard. */
  name: string;
  /** The deck the modal was opened *from*, or `null` for every other surface. Non-null is what
   *  makes a press a swap rather than a look. */
  deckId: number | null;
  /** The printing that deck row plays: the swap's `from`, and the tile the wall rings. */
  heldCardId: string | null;
  /** Stage an open deck editor publishing this deck's walk, or `null` for no editor at all —
   *  which is what every surface outside the deck builder opens the modal from. */
  walkDeckId: number | null;
  /** Stage a truncated page by claiming this many printings exist. `null` leaves the fake to
   *  answer — see {@link truncatedPage} for why the count cannot come from it. */
  truncatedTo: number | null;
}) {
  // The world's own client — `preview.tsx` mounts one `QueryClientProvider` per story, so this is
  // the very cache the modal is about to read from, and nothing seeded here leaks into the next
  // story.
  const queryClient = useQueryClient();
  const [slot] = useState<PaneDeckContext | null>(() => {
    const opened = deckId === null || heldCardId === null ? null : slotOf(deckId, heldCardId);
    if (truncatedTo !== null) {
      queryClient.setQueryData(
        ["card", "printings", oracleId, DEFAULT_MARKETPLACE, PRINTINGS_PAGE],
        truncatedPage(oracleId, truncatedTo),
      );
    }
    // **Written on every story, `[]` included**, rather than only where a walk is wanted: the
    // store is the one global `.storybook/` cannot make per-story, so a story that said nothing
    // here would inherit whichever deck the last one staged and grow chevrons nobody asked for.
    useAppStore.getState().setDeckWalk(walkDeckId === null ? [] : deckWalkOf(walkDeckId));
    useAppStore.getState().openAllPrintings({ oracleId, name, deck: opened });
    return opened;
  });

  // The deck behind the modal, through the key `useSwapFromPane` already mounted — so this costs
  // no second `deck_get`, and it is the same cache the swap patches on the way out.
  const deck = useDeck(slot?.deckId ?? null, "live");
  const held =
    slot === null
      ? null
      : (deck.cards.find((card) => card.categoryId === slot.categoryId && card.name === name) ??
        null);

  return (
    <>
      <div className="space-y-1 p-4">
        <p className="text-sm text-dim">
          The view the reader was on. The modal opens over it and it is still here underneath.
        </p>
        {slot && (
          <p className="font-mono text-sm text-text">
            {held
              ? `${slot.categoryName} · ${name} — ${held.setCode.toUpperCase()} ${held.collectorNumber}`
              : `${slot.categoryName} · reading…`}
          </p>
        )}
      </div>
      <AllPrintingsDialog />
    </>
  );
}

const meta = {
  title: "Card/All printings",
  component: Printings,
  tags: ["autodocs"],
  args: {
    oracleId: REPRINTED.oracleId,
    name: REPRINTED.name,
    deckId: null,
    heldCardId: null,
    walkDeckId: null,
    truncatedTo: null,
  },
  // Keyed, so changing the card, the opener or the count in Controls mounts a fresh host and the
  // initializer runs again — rather than writing to a store and a cache the mounted modal is
  // already subscribed to.
  render: (args) => (
    <Printings
      key={`${args.oracleId}:${args.deckId}:${args.walkDeckId}:${args.truncatedTo}`}
      {...args}
    />
  ),
  parameters: {
    // The wall this file is about. `starter`'s most reprinted card has four printings; see
    // {@link REPRINTED} for why eight synthetic ones say more about a filter than four real ones.
    // The two deck stories override it, because `large` seeds no decks.
    fake: { seed: "large" },
    docs: {
      /**
       * **Each story on this page gets its own frame, and it is owed for two separate reasons.**
       *
       * The scrim is `fixed inset-0`: rendered inline, every story would cover the whole docs page
       * rather than its own block, and the last one mounted would be the only one anybody could
       * read. And every story here writes `useAppStore` during render — the one global
       * `.storybook/` cannot make per-story — so inline, the last story to render would own
       * `printingsRequest` for all of them and each heading would sit over the same card. One
       * parameter, two problems; `DeckSettingsDialog` has the first alone and `CardDetailPane` the
       * second.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height, so it is this file's own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "760px" },
      description: {
        component:
          "Every paper printing of one card, as a wall of art the reader can narrow — and, from " +
          "a deck row, choose from.\n\n" +
          "**A centred modal rather than a place to go.** `View all printings` used to have two " +
          "destinations and both moved the reader: outside the deck editor one `set` wrote " +
          '`activeView: "search"` and cleared the open card *and* the open deck, so asking ' +
          "which printings a card had closed the deck it was being asked about; inside the " +
          "editor it opened the 384px card pane, which is the right content at the wrong width. " +
          "Printings are *consulted*, like deck history and categories, so this is a " +
          "`Dialog` like both of them and the store field behind it writes one thing.\n\n" +
          "**What a press means is decided by one field.** With a deck slot the press **is** the " +
          "swap — `deck_swap_printing`, through the same `useSwapFromPane` the card pane presses " +
          "— and the modal closes on success ({@link FromADeckRow}) or stays open and says why " +
          "({@link RefusedSwap}). Without one it opens the card pane on the printing that was " +
          "pressed, which is the *go and look at this one* a reader who is not building a deck " +
          "asked for.\n\n" +
          "**The filters are TypeScript's and the wall is `CardGrid`'s.** `printingFilters.ts` " +
          "decides what survives the text box, the set and language pickers and the treatment " +
          "chips; the sort control is the **card pane's persisted `PrintingGroupBy`**, shared " +
          "with it through `app_meta`, and it is labelled *Sort* rather than *Group by* because " +
          "this wall draws no headings — `CardGrid` positions rows absolutely inside a " +
          "virtualiser, so a heading cannot be interleaved without this surface owning the " +
          "virtualisation.\n\n" +
          "Driven end to end by `.storybook/fake/`: `card_printings` (paper only, newest first, " +
          "priced per finish at the marketplace asked for), `deck_get` and `deck_swap_printing`. " +
          "Every story renders at the default marketplace, TCGplayer, because no seed writes the " +
          "setting — and a printing the feed has no figure for draws an **em dash**, never " +
          "`$0.00`.\n\n" +
          "**One state is staged rather than answered**, and only one: a page the backend " +
          "truncated ({@link Truncated}). The fake caps at the same 400 `card.rs` does and no " +
          "fixture card comes near it, so that story raises the count over the fake's own rows.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering modal into a story-sized one, and
        // is what lets the surface behind it stay visible in the same frame. Without it the
        // scrim covers the whole page and the claim this component exists to make is invisible.
        style={{ transform: "translateZ(0)" }}
        className="relative h-[44rem] overflow-hidden rounded-lg border border-border bg-bg"
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Printings>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The wall as it opens: eight printings of one card, in six sets, with every control at rest.
 *
 * **For reading the controls against the thing they narrow.** The count line is above them
 * because it is what they are read against; the set chips are the sets *these* printings are in,
 * built from the rows rather than from `ipc.setsList`'s ~1050 sets, of which roughly 1040 hold no
 * printing of any given card; and the language picker exists because the non-English rows are
 * most of what crowds a heavily reprinted card's wall — the corner of the one Japanese tile says
 * `JA`, and none of the seven English ones says anything, because a wall where every tile says
 * `EN` says nothing.
 *
 * **The three chips at zero are the state worth looking at.** No printing of this card is a
 * promo, a showcase or extended art, so those chips are drawn **greyed rather than dropped** —
 * `facets.ts`' rule: an option that vanishes reads as a control that broke, where a greyed one
 * reads as a fact about the card in front of you. The row also keeps a fixed shape that way, so
 * it does not reflow as the reader narrows.
 *
 * The sort control opens on `artist`, which is the *card pane's* stored preference and not this
 * modal's: a reader who sorts by price here finds the pane sorted by price too, because it is one
 * question asked on two surfaces and answered in one `app_meta` row.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Ancient Aegis/ });
    const modal = within(dialog);

    // Unfiltered and uncapped, so the count line is the plain wording — no "of", nothing to
    // explain, which is the case a reader must be able to trust at a glance.
    await expect(await modal.findByText("8 printings")).toBeInTheDocument();
    await expect(modal.getByRole("combobox", { name: "Sort printings by" })).toHaveValue("artist");

    // A chip's accessible name carries its **count** as well as its label (the bare number beside
    // it says nothing on its own), so an exact-label query would fail here and read as a missing
    // control. Alpha holds three of the eight; the other five sets hold one each.
    await expect(
      modal.getByRole("button", { name: "Limited Edition Alpha — 3 printings" }),
    ).toBeInTheDocument();

    // Out of reach, and saying so in all three channels the chip owns.
    const promo = modal.getByRole("button", { name: "Promo — 0 printings" });
    await expect(promo).toHaveAttribute("aria-disabled", "true");
    // …while a treatment this card really has is an ordinary offer beside it.
    await expect(modal.getByRole("button", { name: "Foil — 3 printings" })).not.toHaveAttribute(
      "aria-disabled",
    );

    // The one non-English printing, counted rather than merely present: `JA 1` is what makes the
    // row worth pressing on a card whose other seven rows are the same language.
    await expect(modal.getByRole("checkbox", { name: "JA — 1 printing" })).toBeInTheDocument();

    // A tile, by the name that tells it from the other seven. **The first one in artist order**
    // rather than a count of them: jsdom lays nothing out, so how many tiles a virtualised wall
    // draws under `src/stories.test.tsx` is an artefact of that file's stubbed viewport.
    await expect(await modal.findByAltText("Ancient Aegis (UNF 8)")).toBeInTheDocument();
  },
};

/**
 * The same wall with `alpha` typed into the box — **for the sentence the count line changes to.**
 *
 * Three wordings exist and this is the third: `showing 3 of 8 printings`, counted against the
 * whole list rather than against what is on screen, so a reader can always see how much of the
 * card they are looking at. The other two are {@link Default}'s and {@link Truncated}'s.
 *
 * **The text box matches four fields and says which in its placeholder** — set name, set code,
 * collector number, artist — because a search box that silently ignores what you typed is worse
 * than no box. The card's own name is deliberately not among them: it is identical on every row
 * here, so matching it would pass everything.
 *
 * `alpha` reaches the three Limited Edition Alpha rows through the **set name**, which is the
 * field a reader is most likely to type and the one no other control on the row can reach: the
 * set chips are pressed, not typed, and a chip is only worth pressing once you know the set is
 * there.
 */
export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Ancient Aegis/ });
    const modal = within(dialog);
    await modal.findByText("8 printings");

    await userEvent.type(modal.getByRole("searchbox", { name: "Filter printings" }), "alpha");

    await expect(await modal.findByText("showing 3 of 8 printings")).toBeInTheDocument();
    // The tile that fell out is **gone from the wall**, not merely uncounted. `UNF 8` is the one
    // worth asking about: it is first in artist order, so it is on screen whenever it is in the
    // list at all, and its absence cannot be a virtualiser's window.
    await expect(modal.queryByAltText("Ancient Aegis (UNF 8)")).toBeNull();
    await expect(await modal.findByAltText("Ancient Aegis (LEA 1)")).toBeInTheDocument();
  },
};

/**
 * A page the backend cut short — **for the wording that stops the wall claiming to be complete.**
 *
 * `8 of 862 printings`: the first number is what arrived, the second is what exists. The modal
 * asks for the backend's ceiling (1000) rather than the card pane's 400 precisely because it
 * filters, and a filter over a truncated list *lies* — narrowing to a set that fell outside the
 * page would draw an empty wall that reads as an answer rather than as a truncation. This wording
 * is the fence around the case where even the wide page was not enough.
 *
 * 862 is Forest's real count, which is the largest in the corpus; the eight rows under it are the
 * fake's own answer for this card. See {@link truncatedPage} for why the count is staged and the
 * rows are not — and note that the modal draws no *second* sentence about it: the count line is
 * the only place this fact is said, so it has to be legible on its own.
 */
export const Truncated: Story = {
  args: { truncatedTo: 862 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Ancient Aegis/ });
    const modal = within(dialog);

    await expect(await modal.findByText("8 of 862 printings")).toBeInTheDocument();
    // Still a wall, not an apology: what did arrive is drawn exactly as it is when nothing was
    // cut, and the filters still narrow it.
    await expect(await modal.findByAltText("Ancient Aegis (UNF 8)")).toBeInTheDocument();
  },
};

/**
 * Opened from a deck row, and pressing a tile **rewrites the deck** — the whole of what this
 * modal is for, end to end.
 *
 * Deck 2 (`Kenrith Two-Drops`) plays Sol Ring `c21 263` in its Main deck, and `sld 913` is the
 * corpus's only other Sol Ring. The row behind the modal names the printing the deck plays today;
 * after the press it names the other one, which is the only assertion that says the write landed
 * rather than that a button was clickable.
 *
 * **The held printing wears the ring**, and it is the only tile on the wall that is special:
 * `selectedId` is the slot's `cardId`, and it is `null` on every other surface because then no
 * printing here is the deck's.
 *
 * **Click-commits, deliberately.** The tile is the thing the reader is pointing at, and the cost
 * the card pane pays for the same gesture — no way to look at a printing without committing to it
 * — is not paid here, because the whole wall is art and looking is what a wall is for. A
 * mis-press is covered by the deck's undo.
 *
 * The two tiles are also a small lesson in the corner marks: `sld 913` is sold **foil only**, so
 * it wears the sheen and the corner chip, and neither feed lists a price for it — an em dash,
 * never `$0.00`.
 */
export const FromADeckRow: Story = {
  args: {
    oracleId: SOL_RING_C21.oracleId,
    name: SOL_RING_C21.name,
    deckId: 2,
    heldCardId: SOL_RING_C21.id,
  },
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Sol Ring/ });
    const modal = within(dialog);
    await expect(await modal.findByText("2 printings")).toBeInTheDocument();

    // What the deck plays now, read back out of `deck_get` rather than assumed.
    await expect(await canvas.findByText("Main deck · Sol Ring — C21 263")).toBeInTheDocument();

    // `CardArt` rings the selected card's frame, which is the image's parent — the mark is a
    // border on the art rather than anything in the accessibility tree, so this is the only
    // place it can be asked about.
    const held = await modal.findByAltText("Sol Ring (C21 263)");
    await expect(held.parentElement).toHaveClass("ring-accent");
    await expect((await modal.findByAltText("Sol Ring (SLD 913)")).parentElement).not.toHaveClass(
      "ring-accent",
    );

    await userEvent.click(modal.getByRole("button", { name: "Sol Ring (SLD 913)" }));

    // The deck row behind the modal now names the printing that was pressed. `waitFor`, because
    // the press is a round trip: the write, then the re-read that draws this line.
    await waitFor(async () => {
      await expect(canvas.getByText("Main deck · Sol Ring — SLD 913")).toBeInTheDocument();
    });
    // And the modal is gone, which is the other half of "the press was the decision": there is
    // nothing left to confirm. Waited for, because `Dialog` keeps its panel mounted for the
    // length of its fade.
    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog")).toBeNull();
    });
  },
};

/**
 * The same press, refused — **for the sentence, and for the fact that the modal is still there.**
 *
 * `busy` is `collection::BUSY` verbatim, raised by every *write* handler in the fake and by no
 * read handler, which is exactly the split this state needs: the printings, the prices and the
 * deck read all answer, and only the swap is turned down. It is the one refusal a story can
 * stage, and the one a reader is most likely to meet — a sync holds the write connection.
 *
 * **The refusal is drawn beside the wall and the wall stays up**, which is half of why this list
 * left the card pane: the pane had nowhere good to put this sentence, and a modal that closed on
 * a refusal would take the reader's place in the list away over something they can simply try
 * again. `role="alert"`, because the press that produced it has already been forgotten by the
 * eye — the tile looks exactly as it did.
 *
 * And the deck row behind it is unchanged, which is the assertion that says nothing was half
 * written.
 */
export const RefusedSwap: Story = {
  args: {
    oracleId: SOL_RING_C21.oracleId,
    name: SOL_RING_C21.name,
    deckId: 2,
    heldCardId: SOL_RING_C21.id,
  },
  parameters: { fake: { seed: "starter", fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Sol Ring/ });
    const modal = within(dialog);
    await expect(await canvas.findByText("Main deck · Sol Ring — C21 263")).toBeInTheDocument();

    await userEvent.click(await modal.findByRole("button", { name: "Sol Ring (SLD 913)" }));

    await expect(await modal.findByRole("alert")).toHaveTextContent(
      "Could not use that printing — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // Still open, still showing the whole list, and the deck still plays what it played.
    await expect(canvas.getByRole("dialog")).toBeInTheDocument();
    await expect(modal.getByText("2 printings")).toBeInTheDocument();
    await expect(canvas.getByText("Main deck · Sol Ring — C21 263")).toBeInTheDocument();
  },
};

/**
 * Narrowed until nothing is left — **for the sentence and for the one control that undoes it.**
 *
 * Two empty states exist and they are different facts: this one is about the *filter* and the
 * reader can undo it, where "This card has no paper printings." is about the card and they
 * cannot. Saying them in one sentence would tell a reader with a typo in the box that their card
 * had left the database.
 *
 * **Neither state draws a control of its own.** `Clear all` is the filter bar's and appears
 * exactly when there is something to clear — which is exactly when this sentence is on screen —
 * so a second button with the same job would be one more thing to keep in step and an ambiguous
 * target for anything addressing it by name. The play asserts that there is precisely one of
 * them, which is the only way that claim can be made rather than assumed.
 */
export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /Ancient Aegis/ });
    const modal = within(dialog);
    await modal.findByText("8 printings");

    await userEvent.type(modal.getByRole("searchbox", { name: "Filter printings" }), "zzz");

    await expect(await modal.findByText("No printings match these filters.")).toBeInTheDocument();
    // The other sentence is not drawn: this card has eight printings, and nothing here has
    // suggested otherwise.
    await expect(modal.queryByText("This card has no paper printings.")).toBeNull();
    // The count line keeps counting against the whole list, so the reader can see what they have
    // narrowed away from.
    await expect(modal.getByText("showing 0 of 8 printings")).toBeInTheDocument();

    // One way out, not two.
    const clear = modal.getAllByRole("button", { name: /Clear/ });
    await expect(clear).toHaveLength(1);
    await userEvent.click(clear[0]);

    await expect(await modal.findByText("8 printings")).toBeInTheDocument();
    await expect(modal.queryByText("No printings match these filters.")).toBeNull();
  },
};

/**
 * Opened from a deck row with the editor open behind it — **the modal as a window onto the deck
 * rather than onto one card.**
 *
 * A chevron on each side, and ArrowLeft/ArrowRight beside them, move it to the previous and next
 * card in deck order. That order is `store.deckWalk`, published by `DeckEditor` because it depends
 * on the editor's grouping, its sorting and its filter and this component is mounted at `App`
 * level with no way to ask. A reader checking which printing of each card they have sleeved up
 * walks the whole deck without closing anything.
 *
 * **Everything hangs off one index** — where `request.deck` sits on that walk. It is `-1` from a
 * search tile, from the collection and from a deck the editor is not showing, and in every one of
 * those there is no walk, so there are no chevrons and the arrow keys are not the modal's. Every
 * other story on this page is that case: {@link FromADeckRow} is opened from a deck row with no
 * editor behind it, and draws none.
 *
 * **A step is two writes.** The modal moves, and so does the desk behind the scrim — the gold ring
 * on the deck card and the card pane docked beside it — so closing after six steps leaves the
 * reader on the card they walked to rather than the one they started from, and a press on a tile
 * goes on writing the row the desk is marking. The second write is the one nothing in this frame
 * draws, so the play reads it out of the store.
 *
 * **The chevrons are named for what they land on**, because a chevron says nothing on its own; at
 * the two ends of the walk the matching one is drawn and `disabled` rather than dropped, so the
 * first step is never the moment a control appears under the reader's pointer.
 *
 * The box above the modal is the surface the reader was on, and it keeps naming the row the modal
 * was *opened* from — it is scenery for the swap stories rather than a second readout of the walk.
 */
export const SteppingTheDeck: Story = {
  args: {
    oracleId: WALK_FROM.oracleId,
    name: WALK_FROM.name,
    deckId: WALK_FROM.deck.deckId,
    heldCardId: WALK_FROM.deck.cardId,
    walkDeckId: 2,
  },
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("dialog", { name: WALK_FROM.name });

    const back = canvas.getByRole("button", {
      name: `Previous card in the deck, ${DECK_2_WALK[0].name}`,
    });
    const forward = canvas.getByRole("button", {
      name: `Next card in the deck, ${DECK_2_WALK[2].name}`,
    });
    await expect(back).toBeEnabled();
    await expect(forward).toBeEnabled();

    await userEvent.click(forward);

    // The modal re-captions itself: it is still the same dialog, about the next card.
    await expect(await canvas.findByRole("dialog", { name: DECK_2_WALK[2].name })).toBeVisible();
    // And the desk followed. Read out of the store because nothing in this frame draws the deck
    // editor — the ring and the card pane are what these two fields are.
    await waitFor(async () => {
      await expect(useAppStore.getState().paneDeckContext).toEqual(DECK_2_WALK[2].deck);
    });
    await expect(useAppStore.getState().selectedCardId).toBe(DECK_2_WALK[2].deck.cardId);
  },
};
