import { useCallback, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../.storybook/fake/fixtures";
import { seed } from "../../../.storybook/fake/seeds";
import { CardDetailPane } from "./CardDetailPane";

/**
 * A fixture printing's id — every story on this page is addressed by one, because `cardId` is the
 * only thing `CardDetailPane` takes.
 *
 * The lookup is the shared one and throws at module load rather than handing a story an id `cards`
 * has no row for; this wrapper only spares each `args` line a trailing `.id`.
 */
function printingId(setCode: string, collectorNumber: string): string {
  return printing(setCode, collectorNumber).id;
}

/** How long a `waitFor` will wait for one animation frame. See `SingleFaced`'s play for why
 *  that is measured in seconds rather than milliseconds. */
const FRAME_WAIT = 5_000;

/** Deck 2's `main` slot, the printing in it, and the printing it can be swapped to. */
const SOL_RING_C21 = printingId("c21", "263");

/**
 * `.storybook/fake/seeds.ts:462`'s `ORPHAN_DECK_CARD_ID`, spelled out because the seed keeps its
 * three orphan ids module-private — and deliberately outside the fixture, so `card_detail`
 * answers `null` for it. `world.test.ts` asserts all three are absent from `CARDS`, so a corpus
 * refresh that happened to mint this id fails a test rather than quietly healing it under
 * {@link NotInTheDatabase}.
 */
const ORPHAN_CARD_ID = "0c62f9b1-4a7d-4e83-8f15-2b90d4c6e737";

/**
 * The category a deck holds a printing in — **read out of the seed rather than written down.**
 *
 * Schema v8 replaced the fixed five-word zone with a `deck_categories` row, so a
 * `PaneDeckContext` names an **id** (what the swap is addressed by) and a **name** (what every
 * "Use this printing" label reads back). The id is minted by the seed's own row numbering and is
 * not a constant this file may assume; the name is the seed's too. Looking the pair up through
 * the deck card itself is also the honest staging: it is exactly the slot a reader would have
 * clicked to open this pane from.
 *
 * `null` when that deck does not hold that printing, which is what makes the host below fall
 * back to opening the card from "somewhere else" rather than inventing a slot.
 */
function slotOf(deckId: number, cardId: string) {
  const db = seed("starter");
  const row = db.deckCards.find((c) => c.deckId === deckId && c.cardId === cardId);
  return db.deckCategories.find((c) => c.id === row?.categoryId) ?? null;
}

/**
 * The pane, opened the way the app opens one — through the store, never through a prop.
 *
 * `CardDetailPane` takes `cardId` and `onClose`, and `App.tsx:79-88` supplies both from
 * `selectedCardId`, keyed on it. That key is not decoration here either: `store.viewPrinting`
 * writes a *new* `selectedCardId` when a printings row is clicked, so browsing the list
 * remounts the pane, and a host that held the id in its own state would show the second
 * printing inside the first pane's scroll position, face and focus.
 *
 * **`deckId` is what decides whether the swap offers exist at all.** `store.ts`'s
 * `openCardFromDeck` is the only writer of `paneDeckContext`; `setSelectedCardId` clears it. One
 * host, two openers, and the difference between {@link FromDeckRow} and {@link FromSearch} is
 * which of the two branches below ran. The slot itself comes from {@link slotOf}, because since
 * schema v8 a context names a category row rather than one of five words.
 *
 * `useState`'s lazy initializer rather than an effect, which is `AppShell.stories.tsx`'s
 * answer and for its reason: an effect runs after the first paint, so a deck-context story
 * would render one frame of a pane with no offers on it.
 */
function Pane({ cardId, deckId }: { cardId: string; deckId: number | null }) {
  useState(() => {
    const store = useAppStore.getState();
    const slot = deckId === null ? null : slotOf(deckId, cardId);
    if (deckId === null || slot === null) store.setSelectedCardId(cardId);
    else {
      store.openCardFromDeck({
        deckId,
        categoryId: slot.id,
        categoryName: slot.name,
        cardId,
        // The list the editor would have been drawing. `live` is what every seeded deck's rows
        // are in, and it is the variant the swap below is addressed to.
        variant: "live",
      });
    }
  });

  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  // Stable, because it is the pane's `onDismiss` and therefore a dependency of the `keydown`
  // listener behind it — `App.tsx:70` says the same thing at the same level.
  const close = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);

  // A real close, not a no-op: a host that ignored `onClose` would make "Escape left the pane
  // open" true by construction, which is exactly the claim `AddToCollection`'s Escape story
  // rests on.
  if (selectedCardId === null) return null;
  return <CardDetailPane key={selectedCardId} cardId={selectedCardId} onClose={close} />;
}

const meta = {
  title: "Card/DetailPane",
  component: Pane,
  tags: ["autodocs"],
  args: { cardId: printingId("2x2", "117"), deckId: null },
  // Keyed, so changing the card or the opener in Controls mounts a fresh host and the
  // initializer above runs again rather than writing to a store the mounted pane is already
  // subscribed to.
  render: (args) => <Pane key={`${args.cardId}:${args.deckId}`} {...args} />,
  decorators: [
    // The pane sets its own width — `w-96`, 384px (`CardDetailPane.tsx:347`) — and is
    // `shrink-0`, so what it needs from a parent is a **height**: it is the scroller, and a
    // parent with none gives a card taller than the frame nowhere to scroll. 720px matches the
    // deck editor's stories; it is chosen rather than derived, because the ribbon above the
    // content column is not a fixed number of pixels.
    (Story) => (
      <div className="flex h-[720px] items-stretch">
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
       * Every story in this file writes `selectedCardId` and `paneDeckContext` during render, and
       * the store is a module singleton that `.storybook/` cannot make per-story: zustand's
       * `create` does not expose the initializer it was given, and the store's actions close over
       * that one store's `set`, so a second instance of it would take an edit to
       * `src/lib/store.ts`. Inline, an autodocs page mounts every story at once and the last one
       * to render would own the store for all of them — every story below showing the same view,
       * the same card, the same layout, and reading as a component that ignores its arguments.
       *
       * The fake **backend** needs none of this — a world is per story in-process now
       * (`.storybook/fake/scope.ts`), and 30 of the 34 story files still render inline. This is
       * the four that touch the one global left over.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height (`@storybook/addon-docs`'s `StoryBlockParameters`), so it is this file's
       * own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "760px" },
      description: {
        component:
          "One printing, in full — the card, what it says, what each finish costs, where it is " +
          "legal, and every other printing of the same oracle card grouped by artwork.\n\n" +
          '**A docked pane rather than a modal**, and the ARIA says so: `role="complementary"` ' +
          'named "Card details", never `aria-modal`, because the list behind it stays live and ' +
          "clickable. It is also an ordinary element in the app's tree rather than a portal — " +
          "the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a " +
          "runtime `<style>` the moment it opens.\n\n" +
          "Driven end to end by `.storybook/fake/`: `card_detail` (`db.ts:1316-1319`) and " +
          "`card_printings` (`db.ts:1321-1335`), the second **paper only** and newest first.\n\n" +
          "**A finish's price is a lookup in the `prices` blob** — `usd` / `usd_foil` / " +
          "`usd_etched`, with no fallback of any kind (`finish.ts:65-72`). `cards.price_usd` is " +
          "a display and sort chain and is never summed or shown here. `eur_etched` does not " +
          "exist in the data at all (`finish.ts:27`), which is why the pane quotes USD and the " +
          "collection is the only surface with a euro column. {@link AllFinishes} is one of the " +
          "corpus's **two** rows priced in all three (measured 2026-08-10: Lightning Bolt " +
          "`sta 105` and Counterspell `mh2 267`), and {@link Legalities} is a printing whose " +
          "`usd` key is null — an **em dash**, never `$0.00` (`prices.ts:15-17`).\n\n" +
          "**Nothing here is `alt`-tested against a URL.** Under Vitest `cardImageUrl` is the " +
          "real one and answers `mtgimg://`, which jsdom never loads; under Storybook the " +
          "fake answers a synthetic SVG data URI (`.storybook/fake/images.ts:141-156`). A play " +
          "therefore asserts an image is *present* and what its `alt` says, never its `src`.\n\n" +
          "**Two store facts are the pane's real subject, and both are invisible in a " +
          "screenshot.** `openCardFromDeck` is the *only* writer of `paneDeckContext` " +
          "(`store.ts:135-136`) and `setSelectedCardId` clears it (`store.ts:133`), so “opened " +
          "from a deck row” is structural rather than a rule call sites remember — " +
          "{@link FromDeckRow} and {@link FromSearch} are that pair on one card. And " +
          "`viewPrinting` (`store.ts:138`) writes the id **without** touching the context, " +
          "which is what keeps the swap offers alive while the reader browses the printings " +
          "list; `setSelectedCardId` there instead would kill the affordance at its one moment " +
          "of use, silently. {@link BrowsingPrintingsKeepsTheOffers} is that one.\n\n" +
          '**Two states have no story here.** A failed *read* — the `role="alert"` reading ' +
          "“Could not read this card” — is unreachable through the fake: `busy` is honoured by " +
          "write handlers only, deliberately, because the app reads through a second read-only " +
          "connection. And a **sync in flight** is unreachable at all (the fake answers " +
          "`syncing: false`). What `busy` does reach is {@link Busy}, a refused swap.",
      },
    },
  },
} satisfies Meta<typeof Pane>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * One card, one side — the shape most of the 116 k corpus takes.
 *
 * `card_faces` is `[]` on a plain printing, and `Facts` synthesises a single face out of the
 * card's own `type_line`, `oracle_text` and `mana_cost` rather than rendering nothing
 * (`CardDetailPane.tsx:516-529`). The face is unnamed in that branch, so no name is drawn: the
 * pane's own `h2` already carries it, and a second copy under the art would be the loudest
 * repetition on the screen.
 *
 * **No flip control**, because `faceCount` answers 1 (`printings.ts:121-123`) — the button
 * only exists where there is a second *physical* side to turn to.
 */
export const SingleFaced: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    // Docked, not modal: the wall behind it stays live, so there is nothing to trap focus into
    // and nothing to mark inert.
    await expect(pane).not.toHaveAttribute("aria-modal");
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Lightning Bolt",
    );
    // The picture is `alt`-ed with the card's name — what a screen reader announces and what
    // shows if the fetch fails, and both readers want the card rather than "card image".
    await expect(within(pane).getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
    // Nothing to turn over.
    await expect(within(pane).queryByRole("button", { name: /^Flip to/ })).toBeNull();

    // Provenance in the data face, then the rarity **as a word** and not only as a colour: the
    // gem is `aria-hidden` and the label carries an `sr-only` "Rarity: " so two colours never
    // have to be told apart by eye. Asserted through the line rather than by its own text,
    // because that prefix and the word are separate nodes and Testing Library's default matcher
    // only joins an element's *direct* text children.
    await expect(within(pane).getByText("2X2 · 117")).toBeInTheDocument();
    await expect(within(pane).getByText("Double Masters 2022").closest("p")).toHaveTextContent(
      "Rarity: uncommon",
    );
    await expect(within(pane).getByText("Instant")).toBeInTheDocument();
    await expect(
      within(pane).getByText("Lightning Bolt deals 3 damage to any target."),
    ).toBeInTheDocument();

    // Two finishes, two prices, each from its own key in the blob.
    //
    // **`{ selector: "dt" }`, because "Foil" is a word this pane says more than once.** The
    // finish list says it in a `<dt>`; every foil row in the printings list below says it again
    // inside `FinishMark`'s `<svg><title>`, which Testing Library matches like any other text.
    // Which of them exist yet is a race with the printings query, so an unscoped lookup is a
    // test that passes on how fast a mock resolved.
    await expect(
      within(pane).getByText("Nonfoil", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Nonfoil$2.50");
    await expect(
      within(pane).getByText("Foil", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Foil$2.39");
    // **`waitFor`, because the pane arrives.** Its first painted frame is at `opacity: 0`, and
    // `toBeVisible` walks the ancestors — so nothing inside it is visible until that lands, one
    // frame away under the suite's `MotionGlobalConfig.skipAnimations`. Every other assertion
    // on this page reads presence or text, which the initial frame already has.
    //
    // The timeout is generous on purpose: what is being waited for is a `requestAnimationFrame`
    // — jsdom has no compositor, so `motion` drives its own loop off one — and the suite is 91
    // files of jsdom in parallel. The default second is a wait on the *scheduler*, and it
    // flaked once at that length while passing this play in isolation every time.
    await waitFor(
      () => expect(within(pane).getByText("TCGplayer prices as of the last card-data sync.")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    // Scryfall's image policy, in one line: the illustrator of the side on screen, and the
    // source. Not decoration and not optional (`CardDetailPane.tsx:417-424`).
    await expect(
      within(pane).getByText(
        "Illustrated by Christopher Moeller. Card images © Wizards of the Coast · Data © Scryfall",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A card with a back, and the control that turns it over.
 *
 * `transform` is one of five layouts whose `card_faces` are two *physical* sides
 * (`printings.ts:50-56`), so `faceCount` answers 2 and the pane offers a flip. Everything the
 * flip changes changes together — the picture, the type line, the rules text, and the
 * illustrator credited underneath — because all four read `card.faces[face]`.
 *
 * The button is named for **where it goes**, not for what it does: "Flip to Insectile
 * Aberration" is a destination a reader can recognise, where "Flip" is a control they have to
 * press to find out about.
 *
 * Delver's two faces share one illustrator, which is the ordinary case; {@link SplitCard} is
 * the printing where they do not.
 */
export const DoubleFaced: Story = {
  args: { cardId: printingId("isd", "51") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    // The heading is the whole card; the art and the facts are one side of it.
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Delver of Secrets // Insectile Aberration",
    );
    await expect(within(pane).getByRole("img", { name: "Delver of Secrets" })).toBeInTheDocument();
    await expect(within(pane).getByText("Creature — Human Wizard")).toBeInTheDocument();

    await userEvent.click(
      within(pane).getByRole("button", { name: "Flip to Insectile Aberration" }),
    );

    // The back, and the way back — one control, named for whichever side is not on screen.
    await expect(
      await within(pane).findByRole("img", { name: "Insectile Aberration" }),
    ).toBeInTheDocument();
    await expect(within(pane).getByText("Creature — Human Insect")).toBeInTheDocument();
    await expect(within(pane).getByText("Flying")).toBeInTheDocument();
    await expect(
      within(pane).getByRole("button", { name: "Flip to Delver of Secrets" }),
    ).toBeInTheDocument();
  },
};

/**
 * Two faces on **one** side of one piece of cardboard — so both are printed here at once, and
 * there is nothing to flip.
 *
 * The distinction `faceCount` exists to draw: `split`, `adventure` and `flip` all carry two
 * `card_faces` and one physical side, and offering to turn one over would show a card back
 * (`printings.ts:110-123`). `Facts` therefore renders the whole array rather than one element
 * of it, and names each half — which is the one branch where a face's name is drawn, because
 * the pane's `h2` cannot say which half a type line belongs to.
 *
 * **The credit line names one illustrator and this card has two.** `artistOf` reads
 * `card.faces[face]` and `face` is 0 on a card with no flip control, so Apocalypse's Fire // Ice
 * — David Martin on Fire, Franz Vohwinkel on Ice — credits David Martin under a picture
 * containing both halves. The printings list below it carries the printing's own `artist`
 * column, which is the string `"David Martin & Franz Vohwinkel"`, so the pane does name both;
 * the play asserts each where it is. Recorded as measured, not as a defect this story fixes.
 */
export const SplitCard: Story = {
  args: { cardId: printingId("apc", "128") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).queryByRole("button", { name: /^Flip to/ })).toBeNull();

    // Both halves, named, because the heading cannot say which type line is whose.
    await expect(within(pane).getByText("Fire")).toBeInTheDocument();
    await expect(within(pane).getByText("Ice")).toBeInTheDocument();
    await expect(
      within(pane).getByText("Fire deals 2 damage divided as you choose among one or two targets."),
    ).toBeInTheDocument();
    await expect(within(pane).getByText(/Tap target permanent\./)).toBeInTheDocument();

    // The credit under the art is face 0's; the printings row carries the printing's own
    // two-name string. Awaited, because the printings list is a second query and the section
    // renders its heading while that one is still in flight.
    await expect(
      within(pane).getByText(
        "Illustrated by David Martin. Card images © Wizards of the Coast · Data © Scryfall",
      ),
    ).toBeInTheDocument();
    await expect(
      await within(pane).findByText("David Martin & Franz Vohwinkel"),
    ).toBeInTheDocument();
  },
};

/**
 * Every printing of one card, **grouped by the artwork it carries**.
 *
 * The question a printings list is asked is "which art is this?", so the group's heading is its
 * *illustrator* — a name the reader can check against the card in their hand — rather than
 * "Artwork 2", which is a number invented here. Ordered newest first, and the count line says
 * both figures because they are different questions: `items` is capped at 400 and `total` is
 * not, so a Forest would read "400 of 862 printings" rather than claiming it has 400
 * (`CardDetailPane.tsx:687-689`, whose figure that is).
 *
 * Measured 2026-08-10 over `readHandlers(seed("starter")).card_printings` for Lightning Bolt:
 * **4 printings, 4 artworks** — `sld 1638` (Desmuncubic), `2x2 117` (Christopher Moeller),
 * `sta 105` (Ezoi) and `lea 161` (Christopher Rush), in that order.
 *
 * **The printing the pane is about does not offer to show itself.** It draws a gold hairline
 * down its edge and its set code as static text, where every other row's is a button — the
 * mouse clicks the row, the keyboard presses that button, one destination and two ways in.
 */
export const Printings: Story = {
  args: { cardId: printingId("lea", "161") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // `find`, not `get`: the section draws its heading while the printings query is still in
    // flight, so the region exists a commit before its rows do.
    await expect(await within(list).findByText("4 printings · 4 artworks")).toBeInTheDocument();

    // One heading per artwork, each an illustrator.
    for (const artist of ["Desmuncubic", "Christopher Moeller", "Ezoi", "Christopher Rush"]) {
      await expect(within(list).getByText(artist)).toBeInTheDocument();
    }

    // Three handles, and not a fourth: `lea 161` is the open printing and is static text.
    await expect(within(list).getByRole("button", { name: "Show SLD · 1638" })).toBeEnabled();
    await expect(within(list).getByRole("button", { name: "Show 2X2 · 117" })).toBeEnabled();
    await expect(within(list).getByRole("button", { name: "Show STA · 105" })).toBeEnabled();
    await expect(within(list).queryByRole("button", { name: "Show LEA · 161" })).toBeNull();

    // The Japanese printing is marked as one — the badge carries an `sr-only` "Language: " so
    // the two letters are not read as a word. The prefix is a separate node, so the claim is
    // made against the badge's whole text rather than by looking the sentence up.
    await expect(within(list).getByText("ja")).toHaveTextContent("Language: ja");
  },
};

/**
 * Two printings, **one** artwork — which is the only thing that proves the grouping does
 * anything at all.
 *
 * `groupByIllustration` merges printings whose `illustration_id` matches and never merges two
 * nulls, because that field is documented as missing on newly spoiled cards and merging them
 * would claim a set of unrelated printings share an art (`printings.ts:64-86`). Alpha and
 * Unlimited Ancestral Recall carry the same id, so they arrive under one heading with the count
 * beside it — and Mark Poole is named once rather than twice.
 *
 * Measured 2026-08-10: `card_printings` answers **2 items, 1 group**, `2ed 48` then `lea 47`.
 * The other half of the pair is {@link Printings}, where four printings are four groups.
 */
export const SharedArtwork: Story = {
  args: { cardId: printingId("lea", "47") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 1 artwork")).toBeInTheDocument();
    // One heading, carrying its own count — two rows under one name.
    await expect(within(list).getAllByText("Mark Poole")).toHaveLength(1);
    await expect(within(list).getByText("Mark Poole").closest("p")).toHaveTextContent(
      "Mark Poole· 2",
    );
    await expect(within(list).getByRole("button", { name: "Show 2ED · 48" })).toBeEnabled();
  },
};

/**
 * A printing that exists in all three finishes, priced from three different keys of one blob.
 *
 * **A finish's price is a lookup and nothing else** — `usd`, `usd_foil`, `usd_etched`, with no
 * fallback (`finish.ts:65-72`). The derived `cards.price_usd` column is a nonfoil→foil→etched
 * chain built for sorting, and using it here would quote a plain copy at foil rates. Etched is a
 * third thing and never `foil: true`: flattening it is the single commonest way an importer
 * loses data.
 *
 * Measured 2026-08-10 over `card_detail` for `sta 105`: `usd 17.85`, `usd_foil 23.85`,
 * `usd_etched 18.68` — so **foil is dearer than etched here**, which is the ordering a single
 * number could not have told you. (Counterspell `mh2 267` is the corpus's only other three-finish
 * row and orders them the other way: `2.95 / 3.19 / 3.25`.) The same printing is the corpus's one
 * non-English row, so the language badge is drawn beside the set: shown only when it is not the
 * assumed one.
 */
export const AllFinishes: Story = {
  args: { cardId: printingId("sta", "105") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    // `{ selector: "dt" }` on all three, for the reason `SingleFaced` writes out: every foil and
    // etched row in the printings list says the same word inside `FinishMark`'s `<title>`.
    await expect(
      within(pane).getByText("Nonfoil", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Nonfoil$17.85");
    await expect(
      within(pane).getByText("Foil", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Foil$23.85");
    await expect(
      within(pane).getByText("Etched", { selector: "dt" }).closest("div"),
    ).toHaveTextContent("Etched$18.68");
    // Spec §5: a price is never shown without saying how old it is. `waitFor` for the reason
    // `SingleFaced` writes out: the pane fades in, and a `toBeVisible` under it is false until
    // the arrival lands.
    await waitFor(
      () => expect(within(pane).getByText("TCGplayer prices as of the last card-data sync.")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // Once in the card's own facts and once on its row in the printings list below. The badge's
    // `sr-only` prefix is a separate node, so each is checked through its own whole text.
    await within(pane).findByText("4 printings · 4 artworks");
    const badges = within(pane).getAllByText("ja");
    await expect(badges).toHaveLength(2);
    for (const badge of badges) await expect(badge).toHaveTextContent("Language: ja");
  },
};

/**
 * Where a card may be played — **and never colour alone**.
 *
 * `not_legal` is dropped before anything is drawn, so a card is legal in most of what is left
 * and legal becomes the *quiet* case: its word is there for a screen reader and nowhere else,
 * while banned and restricted carry theirs in the chip. Gold is deliberately not spent on any of
 * them — twenty gold chips under the art would out-shout the focus outline, which has to mean
 * something.
 *
 * Alpha Black Lotus is the printing that makes the point: 23 keys in, **8 chips out**, and seven
 * of the eight say something. Measured 2026-08-10 over `legalityChips(card_detail(…).legalities)`
 * — the order below is `FORMAT_ORDER`'s, with unknown keys appended rather than dropped, because
 * the set grows with every new format.
 *
 * Its `usd` key is also null while its `eur` is not, so the one finish it exists in prices to an
 * **em dash**: `usdPrice` never renders `$0.00`, which is a price nobody quoted.
 */
export const Legalities: Story = {
  args: { cardId: printingId("lea", "232") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    const chips = within(pane).getByRole("list", { name: "Format legality" });
    // Exact, and in order: the format then its status, with "legal" present in the accessibility
    // tree even where it is not painted.
    await expect(
      within(chips)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "legacybanned",
      "vintagerestricted",
      "commanderbanned",
      "oathbreakerbanned",
      "duelbanned",
      "oldschoolrestricted",
      "predhbanned",
      "tlrlegal",
    ]);
    // No USD for any finish of this printing, and no invented zero.
    await expect(within(pane).getByText("Nonfoil").closest("div")).toHaveTextContent("Nonfoil—");
  },
};

/**
 * A card legal in nothing at all — so the chip list is **absent**, not empty.
 *
 * `Legalities` returns `null` when every key filters out (`CardDetailPane.tsx:596-597`), which
 * is the right answer for the corpus's one art-series printing: measured 2026-08-10, all 23 of
 * `amh2 5s`'s legality keys are `not_legal`. A section header over nothing, or a line reading
 * "Not legal anywhere", would both be the pane inventing a fact about a card that is not a card.
 *
 * It is the corpus's `imageStatus: "missing"` row as well, and its six price keys are null —
 * so this is also the one printing where a story can say what the pane looks like when the data
 * has nothing to offer it: the art frame, the name, the provenance and one dashed price.
 * `art_series` is a two-sided layout, so it still offers its flip.
 */
export const NoLegalities: Story = {
  args: { cardId: printingId("amh2", "5s") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).queryByRole("list", { name: "Format legality" })).toBeNull();
    await expect(within(pane).getByText("Nonfoil").closest("div")).toHaveTextContent("Nonfoil—");
    // Still a card, still credited, still turnable over.
    await expect(within(pane).getByText("AMH2 · 5s")).toBeInTheDocument();
    await expect(
      within(pane).getByRole("button", { name: "Flip to Prismatic Ending" }),
    ).toBeInTheDocument();
    await expect(within(pane).getByText(/^Illustrated by John Stanko\./)).toBeInTheDocument();
  },
};

/**
 * The picture did not arrive — so the frame says what is known and guesses at nothing.
 *
 * A rate-limited image is a **503 the `<img>` cannot read**: the element gets an `error` event
 * and no status code, so the panel that replaces it names the card, says the fetch may still be
 * running, and states the way back (`CardDetailPane.tsx:452-463`). It is deliberately not the
 * no-art case — a printing with no art anywhere is served a placeholder at the variant's exact
 * dimensions, a 200 and never a 404, so it draws a picture like any other card.
 *
 * **The error is fired rather than provoked, because nothing here can fail on its own**: the
 * fake answers every id with a synthetic SVG data URI, which needs no network
 * (`.storybook/fake/images.ts:141-156`). `PrintingPreview`'s `AfterAFailedFetch` stages its
 * failure the same way for the same reason.
 *
 * Everything below the frame is untouched — the failure belongs to one `<img>`, not to the card.
 */
export const NoImageYet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    const art = within(pane).getByRole("img", { name: "Lightning Bolt" });

    fireEvent.error(art);

    await waitFor(async () => {
      await expect(
        within(pane).getByText(
          "No image yet — it may still be downloading. Reopen the card to try again.",
        ),
      ).toBeInTheDocument();
    });
    // The picture is gone and the card is not: the panel carries the name the `alt` did.
    await expect(within(pane).queryByRole("img", { name: "Lightning Bolt" })).toBeNull();
    await expect(within(pane).getByText("2X2 · 117")).toBeInTheDocument();
    await expect(within(pane).getByRole("region", { name: "Printings" })).toBeInTheDocument();
  },
};

/**
 * A printing the card database has no row for — **said in words, with the way out**.
 *
 * `card_detail` answers `null` rather than raising, so this is neither an error nor a spinner:
 * the pane draws its heading, its close control and one paragraph naming the likely cause
 * (`CardDetailPane.tsx:397-402`). The heading falls back to the word "Card", because there is no
 * name to show and "Loading…" would be a lie about a query that has already answered.
 *
 * Reached the only way it can be — by naming an id `cards` has no row for. That is what an
 * orphan *is*: user tables reference `cards.id` softly, so a row whose printing left the
 * database is flagged and kept, never deleted, and this pane is what opening one shows.
 *
 * Nothing below the paragraph is drawn, printings included: the section is behind `card.data`,
 * and a card with no `oracle_id` has no list to fail at loading either (`CardDetailPane.tsx:669`).
 */
export const NotInTheDatabase: Story = {
  args: { cardId: ORPHAN_CARD_ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(
      await within(pane).findByText(
        "This printing is not in the card database any more. It may have been removed by the " +
          "last sync — close this and search again.",
      ),
    ).toBeInTheDocument();
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent("Card");
    // Not a failure: nothing broke, so nothing shouts.
    await expect(within(pane).queryByRole("alert")).toBeNull();
    await expect(within(pane).queryByRole("region", { name: "Printings" })).toBeNull();
    // The way out is still here.
    await expect(within(pane).getByRole("button", { name: "Close card details" })).toBeEnabled();
  },
};

/**
 * The card opened **as a deck row** — which is the only thing that puts "Use this printing" on
 * the list.
 *
 * `openCardFromDeck` is the sole writer of `paneDeckContext` (`store.ts:135-136`), so the offer
 * exists exactly where a slot exists to rewrite. Spec §2 scopes the swap to decks on purpose: a
 * collection entry's identity carries finish and condition, and swapping a printing there would
 * invent facts.
 *
 * Two things are drawn down the list as one column, and the pair is the design. The row the deck
 * already holds says **"This deck uses this printing"** as static text rather than as a control
 * that cannot be pressed (`CardDetailPane.tsx:915-924`); every other row offers a button whose
 * accessible name carries the printing *and* the category, because the same printing can sit in
 * the main deck and the sideboard and forty rows otherwise share one visible label.
 *
 * Deck 2 (`Kenrith Two-Drops`) holds Sol Ring `c21 263` in its main category, and `sld 913` is the corpus's
 * only other Sol Ring — measured 2026-08-10 over `deck_get({ id: 2 })` and `card_printings`.
 */
export const FromDeckRow: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 2 artworks")).toBeInTheDocument();
    // The deck's own printing states the fact; the other one offers the write.
    await expect(within(list).getByText("This deck uses this printing")).toBeInTheDocument();
    await expect(
      await within(list).findByRole("button", {
        name: "Use this printing (SLD 913) in Main deck",
      }),
    ).toBeEnabled();
  },
};

/**
 * The same card opened from anywhere else — **and the offers are simply not there**.
 *
 * `setSelectedCardId` clears `paneDeckContext` (`store.ts:133`), and that one line is what makes
 * "every other way of opening a card leaves no deck context" true by construction rather than by
 * six call sites remembering it. Search tiles, collection rows, wishlist rows, the docked panel's
 * tiles, the validation panel's card names and the pane's own close all go through it.
 *
 * Identical to {@link FromDeckRow} in every other respect — same printing, same list, same two
 * artworks — which is the point of storying it separately: the difference between the two is one
 * store action, and it is worth being able to see that it is the *only* difference.
 */
export const FromSearch: Story = {
  args: { cardId: SOL_RING_C21, deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // The list is all there — this is not a pane missing a section.
    await expect(await within(list).findByText("2 printings · 2 artworks")).toBeInTheDocument();
    await expect(within(list).getByRole("button", { name: "Show SLD · 913" })).toBeEnabled();
    // And no deck line at all: no offer, and no claim about a deck either.
    await expect(within(list).queryByRole("button", { name: /^Use this printing/ })).toBeNull();
    await expect(within(list).queryByText("This deck uses this printing")).toBeNull();
  },
};

/**
 * Browsing the printings list **keeps the swap offers** — the single most consequential line in
 * the store.
 *
 * A printings row's click calls `store.viewPrinting` (`CardDetailPane.tsx:776`), and
 * `viewPrinting` writes `selectedCardId` and deliberately does not touch `paneDeckContext`
 * (`store.ts:138`). `setSelectedCardId` there instead would compile, pass every type check, and
 * silently kill the affordance **at its one moment of use**: the reader opens a deck row
 * precisely to look through the other printings, and the offer would vanish the instant they
 * looked at one.
 *
 * The play walks that path. Open `c21 263` as deck 2's main slot, click through to `sld 913` —
 * proven by the handles swapping over, since the open printing is the one row that is static
 * text — and the offer is still on the list, now on the row the pane moved to.
 *
 * The context still names the deck's slot, so which row says what changes with the pane: the
 * offer follows the printing the deck does *not* hold, and the "This deck uses this printing"
 * line follows the one it does.
 */
export const BrowsingPrintingsKeepsTheOffers: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = await canvas.findByRole("region", { name: "Printings" });
    await expect(
      await within(before).findByRole("button", {
        name: "Use this printing (SLD 913) in Main deck",
      }),
    ).toBeEnabled();

    await userEvent.click(within(before).getByRole("button", { name: "Show SLD · 913" }));

    // The pane really moved: the open printing is the one row drawn as static text, so the two
    // handles have traded places.
    const after = await canvas.findByRole("region", { name: "Printings" });
    await waitFor(async () => {
      await expect(within(after).getByRole("button", { name: "Show C21 · 263" })).toBeEnabled();
    });
    await expect(within(after).queryByRole("button", { name: "Show SLD · 913" })).toBeNull();

    // **And the offer survived the trip.** It is on `sld 913` either way — the swap's `from` is
    // the deck's slot, not whatever the pane is showing.
    await expect(
      await within(after).findByRole("button", {
        name: "Use this printing (SLD 913) in Main deck",
      }),
    ).toBeEnabled();
    await expect(within(after).getByText("This deck uses this printing")).toBeInTheDocument();
  },
};

/**
 * The deck was deleted from another view — so the pane stops offering a write it can only be
 * refused.
 *
 * `useSwapFromPane` mounts the editor's own `["decks", "detail"]` read and reports `deckGone`
 * when it succeeds and answers nothing (`useDeck.ts:294-308`). `DeckLine` then draws **no line at
 * all** on any row (`CardDetailPane.tsx:896`): not the button, and not the "This deck uses this
 * printing" mark either, because that sentence is not true of a deck that is not there — and
 * forty buttons whose only way of finding out is to be pressed are forty wrong offers.
 *
 * The `gone` fault is what stages it: measured 2026-08-10, `deck_get({ id: 2 })` answers `null`
 * under it while `card_detail` and `card_printings` go on answering, which is exactly the split
 * this state is about. What the pane keeps is the card — a deck disappearing is not a reason to
 * stop showing a printing.
 */
export const DeckGone: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  parameters: { fake: { fault: "gone" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 2 artworks")).toBeInTheDocument();
    await waitFor(async () => {
      await expect(within(list).queryByRole("button", { name: /^Use this printing/ })).toBeNull();
    });
    // Nor the mark on the deck's own printing: the deck is not there to use anything.
    await expect(within(list).queryByText("This deck uses this printing")).toBeNull();
    // And no complaint — nothing was attempted, so nothing failed.
    await expect(within(list).queryByRole("alert")).toBeNull();
  },
};

/**
 * A swap the database refused — **said beside the row that was pressed**.
 *
 * A banner at the top of the pane would be one sentence for forty rows with nothing on screen
 * saying which; the refusal is a `role="alert"` on the row's own action line, which is where the
 * reader is looking. `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by every write
 * handler and by no read handler — which is why the card, the prices and the printings list
 * underneath are untouched.
 *
 * **The caret is the invisible half, and it is the reason this story has a `play`.** The button
 * disables itself for the write (`CardDetailPane.tsx:938`), and a browser blurs a control that
 * disables itself with no `relatedTarget` at all — so the caret lands on `<body>`, inside a
 * layer whose Escape hands focus back to whatever opened the pane. The button is still there
 * when the write settles, so it takes the caret back, and only from `<body>`
 * (`CardDetailPane.tsx:887-892`).
 *
 * The offer stays on the row: recording the same card twice is one interaction, and so is
 * trying again.
 */
export const Busy: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    const use = await within(list).findByRole("button", {
      name: "Use this printing (SLD 913) in Main deck",
    });
    await userEvent.click(use);

    const alert = await within(list).findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not use this printing — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // Still offered, and holding the caret rather than having dropped it on `<body>`.
    await waitFor(async () => {
      await expect(
        within(list).getByRole("button", { name: "Use this printing (SLD 913) in Main deck" }),
      ).toHaveFocus();
    });
    // The deck still holds what it held: nothing was written, and the pane still says so.
    await expect(within(list).getByText("This deck uses this printing")).toBeInTheDocument();
  },
};
