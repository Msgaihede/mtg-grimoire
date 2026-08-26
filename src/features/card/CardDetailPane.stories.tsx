import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../.storybook/fake/fixtures";
import { seed } from "../../../.storybook/fake/seeds";
import { CardDetailPane } from "./CardDetailPane";
import type { PrintingGroupBy } from "./printings";
import { PRINTING_GROUP_BY_KEY } from "./usePrintingGroupBy";

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

/** Deck 2's `main` slot, and the printing every swap story starts from. */
const SOL_RING_C21 = printingId("c21", "263");

/** Lightning Bolt's Alpha printing — the corpus's one card with **four** printings, which is
 *  what makes it the fixture every grouping story is told through. */
const BOLT_LEA = printingId("lea", "161");

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
 * `CardDetailPane` takes `cardId` and `onClose`, and `App.tsx:100-104` supplies both from
 * `selectedCardId` — under a **constant** key, which is copied here rather than improved on. A
 * card-to-card move is not the pane leaving and another arriving, so keying the mount on the id
 * would make every printings row a 440ms cross-fade; the per-card remount that key used to buy
 * lives one level down now, inside the animated box, where `CardDetailPane` keys its own body.
 * Holding the id in this host's state instead would be the other failure — the second printing
 * drawn inside the first pane's scroll position, face and focus.
 *
 * **`deckId` is what decides whether the swap exists at all.** `store.ts`'s `openCardFromDeck`
 * is the only writer of `paneDeckContext` (`store.ts:165-166`); `setSelectedCardId` clears it
 * (`store.ts:163`). One host, two openers, and the difference between {@link FromDeckRow} and
 * {@link FromSearch} is which of the two branches below ran. The slot itself comes from
 * {@link slotOf}, because since schema v8 a context names a category row rather than one of
 * five words.
 *
 * **`groupBy` is seeded into the query cache, because there is no prop to pass it as.** How the
 * printings list is grouped is a *setting*: `usePrintingGroupBy` reads it out of `app_meta`
 * through TanStack Query and keeps it for the life of the window, deliberately, so that it
 * survives the remount every printings row causes. A story that wants the list to open already
 * grouped by price therefore writes the answer into the cache the pane reads — the key is
 * exported (`PRINTING_GROUP_BY_KEY`) for exactly this — which stages *the reader who chose that
 * mode yesterday* rather than mocking a command. The query is `staleTime: Infinity`, so a seeded
 * answer is never refetched over. `null` seeds nothing and leaves the fake to answer, which is
 * `artist`; {@link ChoosingHowToGroup} is the story that seeds nothing and drives the control
 * instead.
 *
 * `useState`'s lazy initializer rather than an effect, which is `AppShell.stories.tsx`'s
 * answer and for its reason: an effect runs after the first paint, so a deck-context story
 * would render one frame of a pane with no swap on it — and a mode-seeding story one frame of
 * the list under the wrong grouping.
 */
function Pane({
  cardId,
  deckId,
  groupBy,
}: {
  cardId: string;
  deckId: number | null;
  /** The grouping this reader last chose, or `null` for one who never chose. */
  groupBy: PrintingGroupBy | null;
}) {
  // The world's own client — `preview.tsx` mounts one `QueryClientProvider` per story, so this
  // is the very cache `CardDetailPane` is about to read from and nothing here leaks into the
  // next story.
  const queryClient = useQueryClient();
  useState(() => {
    if (groupBy !== null) queryClient.setQueryData(PRINTING_GROUP_BY_KEY, groupBy);
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
        // The regular copy, which is what every seeded row is. A story about the pane's foil
        // button on a deck row would seed a foil one and point this at it.
        finish: null,
      });
    }
  });

  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  // Stable, because it is the pane's `onDismiss` and therefore a dependency of the `keydown`
  // listener behind it — `App.tsx:78` says the same thing at the same level.
  const close = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);

  // A real close, not a no-op: a host that ignored `onClose` would make "Escape left the pane
  // open" true by construction, which is exactly the claim `AddToCollection`'s Escape story
  // rests on.
  if (selectedCardId === null) return null;
  return <CardDetailPane key="card-pane" cardId={selectedCardId} onClose={close} />;
}

const meta = {
  title: "Card/DetailPane",
  component: Pane,
  tags: ["autodocs"],
  args: { cardId: printingId("2x2", "117"), deckId: null, groupBy: null },
  // Keyed, so changing the card, the opener or the grouping in Controls mounts a fresh host and
  // the initializer above runs again rather than writing to a store and a cache the mounted pane
  // is already subscribed to.
  render: (args) => <Pane key={`${args.cardId}:${args.deckId}:${args.groupBy}`} {...args} />,
  decorators: [
    // The pane sets its own width — `w-96`, 384px (`CardDetailPane.tsx:217`) — and is
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
       * (`.storybook/fake/scope.ts`), and 43 of the 51 story files still render inline. This is
       * the four that touch the one global left over. The grouping seeded by {@link Pane} is not
       * one of them: a query cache *is* per story, so the three stories below that open in a
       * mode would be isolated with or without this parameter.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height (`@storybook/addon-docs`'s `StoryBlockParameters`), so it is this file's
       * own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "760px" },
      description: {
        component:
          "One printing, in full — the card, what it says, what each finish costs, where it is " +
          "legal, and every other printing of the same oracle card, grouped the way the reader " +
          "asked for.\n\n" +
          '**A docked pane rather than a modal**, and the ARIA says so: `role="complementary"` ' +
          'named "Card details", never `aria-modal`, because the list behind it stays live and ' +
          "clickable. It is also an ordinary element in the app's tree rather than a portal — " +
          "the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a " +
          "runtime `<style>` the moment it opens.\n\n" +
          "Driven end to end by `.storybook/fake/`: `card_detail` and `card_printings`, the " +
          "second **paper only** and newest first. Both take a **marketplace** like every " +
          "priced read in the app, and both answer `finishPrices` — one nullable figure per " +
          "finish, already chosen by the backend. Nothing on this page looks a key up in a " +
          "blob: two of the four marketplaces keep their prices in `marketplace_prices`, which " +
          "the webview cannot read, so the pane would have drawn em dashes on half the picker.\n\n" +
          "**No fallback of any kind, across finishes or across marketplaces.** " +
          "`cards.price_usd` is a display and sort chain and is never summed or shown here, and " +
          "`null` is *unpriced at this marketplace* rather than a hole to fill from another " +
          "one — the holes differ everywhere: there is no `eur_etched` key in Scryfall's data " +
          "at all, and either bulk feed can simply never have listed a printing. " +
          "{@link AllFinishes} is one of the corpus's **two** rows priced in all three " +
          "(measured 2026-08-10: Lightning Bolt `sta 105` and Counterspell `mh2 267`), and " +
          "{@link Legalities} is a printing with no USD price at all — an **em dash**, never " +
          "`$0.00` (`prices.ts:26-29`). Every story here renders at the default marketplace, " +
          "TCGplayer, because no seed writes the setting.\n\n" +
          "**The printings list is grouped four ways, and the reader picks.** " +
          "`buildPrintingGroups(items, mode)` decides every group and every ordering " +
          "(`printings.ts`); this pane draws what it is handed and counts it in that mode's own " +
          "word — “· 4 artists”, “· 3 release dates”, “· 4 sets”, and **nothing at all** under " +
          "Price, which is the one mode that makes no groups and therefore has no heading to " +
          "count. {@link Printings} is the default, Artist, and " +
          "{@link GroupedByReleaseDate}, {@link GroupedByPrice} and {@link GroupedBySet} are " +
          "the other three on the same card, so the four can be read against each other. " +
          "{@link ChoosingHowToGroup} drives the control itself. The choice is remembered in " +
          "`app_meta` and survives every row the reader clicks, which is why it is a query " +
          "rather than component state.\n\n" +
          "**This list is no longer where `View all printings` lands, and the cap on it is why " +
          "that matters.** The card menu's row used to have two destinations and both moved the " +
          "reader — the Search view from a plain surface, this 384px pane from inside the deck " +
          "editor — and it opens `AllPrintingsDialog` over whatever is on screen now, including " +
          "over this pane, so the row is a live offer on the pane's own card rather than the " +
          "greyed one it used to be here. What is left on this surface is the card's own list, " +
          "and it keeps the backend's **default page of 400** deliberately: it draws no filters, " +
          "so a truncation it names in its count line costs a reader nothing, where the modal " +
          "filters and therefore asks for the ceiling — a filter over a truncated list draws an " +
          "empty wall that reads as an answer. See `Card/All printings` for the other " +
          "surface.\n\n" +
          "**Two store facts are the pane's real subject, and both are invisible in a " +
          "screenshot.** `openCardFromDeck` is the *only* writer of `paneDeckContext` " +
          "(`store.ts:165-166`) and `setSelectedCardId` clears it (`store.ts:163`), so “opened " +
          "from a deck row” is structural rather than a rule call sites remember — " +
          "{@link FromDeckRow} and {@link FromSearch} are that pair on one card. And what a " +
          "printings row's click *means* is decided by that same context: with one, the click " +
          "**is** the swap and the pane follows the deck onto the printing it chose " +
          "({@link ClickingAPrintingSwapsTheDeck}); without one — or once the deck has been " +
          "deleted ({@link DeckGone}) — it is `viewPrinting`, and the reader is browsing. The " +
          "“Use this printing” button that used to carry the write on a line of its own is " +
          "gone with `DeckLine`; what it cost is that a deck-opened pane can no longer look at " +
          "a printing without committing to it, and what pays for it is the hover preview, " +
          "which shows any row's art without pressing anything.\n\n" +
          "**Nothing here is `alt`-tested against a URL.** Under Vitest `cardImageUrl` is the " +
          "real one and answers `mtgimg://`, which jsdom never loads; under Storybook the " +
          "fake answers a synthetic SVG data URI (`.storybook/fake/images.ts:141-156`). A play " +
          "therefore asserts an image is *present* and what its `alt` says, never its `src`.\n\n" +
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
 * card's own `type_line`, `oracle_text` and `mana_cost` rather than rendering nothing. The face
 * is unnamed in that branch, so no name is drawn: the pane's own `h2` already carries it, and a
 * second copy under the art would be the loudest repetition on the screen.
 *
 * **No flip control**, because `faceCount` answers 1 — the button only exists where there is a
 * second *physical* side to turn to. The row under the art is not empty even so: `2x2 117` is
 * sold in two finishes, so it holds the foil view, alone and full width. {@link FoilView} is
 * what pressing it does, and {@link DoubleFaced} is the printing where the two controls share
 * the line.
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
    // Nothing to turn over — and one control on the line that would have held the flip.
    await expect(within(pane).queryByRole("button", { name: /^Flip to/ })).toBeNull();
    await expect(
      within(pane).getByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();

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

    // Two finishes, two prices, each its own field on the answer.
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
      () =>
        expect(
          within(pane).getByText("TCGplayer prices as of the last card-data sync."),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    // Scryfall's image policy, in one line: the illustrator of the side on screen, and the
    // source. Not decoration and not optional.
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
 * (`printings.ts:53-60`), so `faceCount` answers 2 and the pane offers a flip. Everything the
 * flip changes changes together — the picture, the type line, the rules text, and the
 * illustrator credited underneath — because all four read `card.faces[face]`.
 *
 * The button is named for **where it goes**, not for what it does: "Flip to Insectile
 * Aberration" is a destination a reader can recognise, where "Flip" is a control they have to
 * press to find out about.
 *
 * **It is also the case the row under the art was rebuilt for.** Delver is sold in two finishes
 * *and* has a back, so both controls exist at once and share one line at half width each — a
 * pair of stacked full-width bars would have put 60px of button under the picture the direction
 * doc calls the loudest thing on the screen. The labels truncate rather than wrap for the same
 * 384px reason; the flip names a card face, and half a column is not enough for "Hanweir, the
 * Writhing Township".
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

    // Both ways of looking at the card, on the one line.
    await expect(
      within(pane).getByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();
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
    // The finish view is a fact about the *printing*, so turning the card over leaves it alone.
    await expect(
      within(pane).getByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();
  },
};

/**
 * Two faces on **one** side of one piece of cardboard — so both are printed here at once, and
 * there is nothing to flip.
 *
 * The distinction `faceCount` exists to draw: `split`, `adventure` and `flip` all carry two
 * `card_faces` and one physical side, and offering to turn one over would show a card back
 * (`printings.ts:476-489`). `Facts` therefore renders the whole array rather than one element
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

    // **And the control that makes it readable.** Both halves are on screen and neither can be
    // read: a classic split prints its titles top-to-bottom down the left edge, so the card is
    // turned clockwise — which is what a reader does with the cardboard, and what Scryfall's own
    // card page offers. `data-card-turn` is the handle, because jsdom-free or not, a `transform`
    // is not something the story runner can see either.
    const turn = within(pane).getByRole("button", { name: "Turn to read", pressed: false });
    await expect(pane.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "0");
    await userEvent.click(turn);
    await expect(pane.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "90");
    await expect(
      within(pane).getByRole("button", { name: "Turn back", pressed: true }),
    ).toBeInTheDocument();
  },
};

/**
 * The split card that turns the **other** way.
 *
 * Aftermath prints the top half upright and the bottom half rotated, and rotated the opposite
 * way from a classic split — `Dawn`'s title reads bottom-to-top up the *right* edge, so the card
 * is turned counter-clockwise. One rule for both would leave 96 of the 347 live split printings
 * upside down (measured 2026-08-21), which is why {@link SplitCard} and this story are two
 * fixtures rather than one.
 *
 * **How the two are told apart is a rules-text prefix, and that deserves saying out loud.**
 * Scryfall retired the `aftermath` *layout* — every one of those 347 rows is `layout: "split"` —
 * and moved the word into a `keywords` array this app has no column for. `orientation.ts` reads
 * `faces[1].oracleText` instead, and that test agreed with Scryfall's own array on **347 of 347**
 * printings, with zero disagreements.
 */
export const AftermathCard: Story = {
  args: { cardId: printingId("akh", "210") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent("Dusk // Dawn");
    await expect(within(pane).queryByRole("button", { name: /^Flip to/ })).toBeNull();

    await userEvent.click(within(pane).getByRole("button", { name: "Turn to read" }));

    await expect(pane.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "-90");
  },
};

/**
 * Two halves on one physical side, one of them printed upside down — the layout the turn control
 * exists for that has no other way to be read.
 *
 * `faceCount` answers 1 for `flip`, so there is no back and no flip button; without a turn,
 * Tok-Tok stays upside down forever. It is also the one turn that names a **destination** the
 * way the flip control does, because a flip card's two halves have two different names and
 * "turn it over" is not the thing a reader wants — Tok-Tok is.
 *
 * 45 live printings, the smallest of the four layouts this control serves.
 */
export const FlipCard: Story = {
  args: { cardId: printingId("chk", "153") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).queryByRole("button", { name: /^Flip to/ })).toBeNull();

    await userEvent.click(
      within(pane).getByRole("button", { name: "Turn to Tok-Tok, Volcano Born" }),
    );

    await expect(pane.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "180");
    // Named for the half the press brings up, in both directions — the flip control's rule,
    // applied to a card that has no second side.
    await expect(
      within(pane).getByRole("button", { name: "Turn to Akki Lavarunner", pressed: true }),
    ).toBeInTheDocument();
  },
};

/**
 * A plane — printed sideways in exactly the way a classic split is, and the layout the issue did
 * not ask for.
 *
 * It is here because the control was already built: `Llanowar`'s title reads bottom-to-top up the
 * left edge (checked against the printed image, 2026-08-21), so it takes the same clockwise turn
 * as {@link SplitCard} and costs one word in `orientation.ts`. 330 live printings that could not
 * be read in this pane before.
 */
export const PlaneCard: Story = {
  args: { cardId: printingId("ohop", "22") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent("Llanowar");

    await userEvent.click(within(pane).getByRole("button", { name: "Turn to read" }));

    await expect(pane.querySelector("[data-card-turn]")).toHaveAttribute("data-card-turn", "90");
  },
};

/**
 * Half of a meld, and the two things a reader can do about the other half.
 *
 * **They are different acts, which is why they are two controls.** *Meld* puts Brisela's picture
 * in this frame while the pane stays about Gisela — how you check what two halves make without
 * losing your place — and *Open* makes Brisela the open card, with her own prices, printings and
 * collection state. Collapsing them into one would have taken the comparison away.
 *
 * The relationship comes from `card_meld_parts`, which is a read of its own rather than a field
 * on `CardDetail`: the answer lives in the gzipped `raw` blob, so it costs an inflate, and the
 * backend gates that on `layout = 'meld'` — **72 of 116 590 rows**. The pane is fenced on the
 * same fact, so an ordinary card costs neither the call nor the parse.
 *
 * Gisela's `all_parts` also names **Bruna** as a `meld_part`, and she gets no control here: from
 * a half, the card worth offering is the whole. {@link MeldedCard} is the other side of it.
 */
export const MeldHalf: Story = {
  args: { cardId: printingId("emn", "28") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Gisela, the Broken Blade",
    );
    await expect(
      await within(pane).findByRole("img", { name: "Gisela, the Broken Blade" }),
    ).toBeInTheDocument();
    // The sibling half is in the same answer and is deliberately not a control.
    await expect(within(pane).queryByRole("button", { name: /Bruna/ })).toBeNull();

    const meld = await within(pane).findByRole("button", {
      name: "Meld — Brisela, Voice of Nightmares",
    });
    await userEvent.click(meld);

    // The picture is Brisela's; the heading is still Gisela's, because this is a look rather
    // than a trip.
    await expect(
      await within(pane).findByRole("img", { name: "Brisela, Voice of Nightmares" }),
    ).toBeInTheDocument();
    await expect(meld).toHaveAttribute("aria-pressed", "true");
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Gisela, the Broken Blade",
    );

    // And the trip, which really does re-point the pane.
    await userEvent.click(within(pane).getByRole("button", { name: "Open melded card" }));
    await waitFor(async () =>
      expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
        "Brisela, Voice of Nightmares",
      ),
    );
  },
};

/**
 * The melded card, and the two halves it is made of.
 *
 * **Only one verb here, and its absence is the point.** There is nothing for a *view* to do on
 * Brisela: the picture in the frame already **is** the meld. What a reader wants of Gisela and
 * Bruna from here is their cards — what they cost, which printings exist, whether the collection
 * holds one — so both controls open. The label names the relationship, because nothing else on
 * this pane would say why those two cards are under this one.
 *
 * The corpus holds this exact printing (`emn 15b`) rather than any Brisela on purpose: the ids in
 * a meld row's `all_parts` name specific printings, and `emn 15b` is the one Bruna's and Gisela's
 * own relations point at. A different Brisela would have drawn a control that opened nothing.
 */
export const MeldedCard: Story = {
  args: { cardId: printingId("emn", "15b") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Brisela, Voice of Nightmares",
    );

    await expect(
      await within(pane).findByRole("button", { name: "Meld part — Bruna, the Fading Light" }),
    ).toBeInTheDocument();
    // No view control: the card on screen is already the melded one.
    await expect(within(pane).queryByRole("button", { name: /^Meld — / })).toBeNull();

    await userEvent.click(
      within(pane).getByRole("button", { name: "Meld part — Gisela, the Broken Blade" }),
    );

    await waitFor(async () =>
      expect(within(pane).getByRole("heading", { level: 2 })).toHaveTextContent(
        "Gisela, the Broken Blade",
      ),
    );
  },
};

/**
 * **Seeing the shiny one** — the second control under the art, in both of its states.
 *
 * There is no foil photograph to fetch. Scryfall publishes one image per printing and it is the
 * plain one, so what this turns on is `FoilOverlay` — the app's own sheen and chip, laid over
 * the same art, the same marking the collection wall and the deck rows wear. It is therefore a
 * **view**, and it says nothing about which finish anyone owns **unless a surface that knows
 * named one**: a deck row plays a specific object and a collection tile *is* one, and both seed
 * it through the store's `paneFinish`. Opened from a search wall, from Tags or from a printings
 * row there is no such fact, and it is what it has always been — a way to see what the shiny one
 * looks like.
 *
 * A printing is offered the view only when it exists in a plain finish **and** a shiny one,
 * because those are the two ends the control moves between. A **foil-only** printing already
 * wears the treatment permanently through `soleFinish` — 12 366 printings exist only in foil,
 * and turning that off would un-say a fact about the object — and a **nonfoil-only** one has
 * nothing to show. So it is absent from {@link Printings} (`lea 161`, nonfoil only) and present
 * here.
 *
 * A **toggle**, so the state rides in `aria-pressed` rather than in two buttons swapping
 * places, and the visible words change with it — those words *are* the accessible name, and a
 * name that no longer contains its own visible label is a control voice control can no longer
 * press (WCAG 2.5.3).
 *
 * The sheen itself is a gradient in `mix-blend-screen` and jsdom paints nothing, so the play
 * asserts the overlay's presence through `data-foil-sheen` — the mark `CardArt` puts on it —
 * and leaves how it *looks* to the browser. `foil` wins over `etched` where a printing has
 * both, which is what {@link AllFinishes} shows; the corpus has no nonfoil+etched printing, so
 * the "View as etched" wording (a `Gem` rather than a `Sparkles` glyph) has no fixture to be
 * storied on.
 */
export const FoilView: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    // Off, and no sheen: `2x2 117` is sold both ways, so nothing about the object is being
    // stated until the reader asks.
    const on = within(pane).getByRole("button", { name: "View as foil", pressed: false });
    await expect(pane.querySelector("[data-foil-sheen]")).toBeNull();

    await userEvent.click(on);

    // The label now names the way *back*, which is what a toggle's name has to do.
    const off = await within(pane).findByRole("button", { name: "View as nonfoil", pressed: true });
    await expect(pane.querySelector("[data-foil-sheen]")).not.toBeNull();
    // The picture is the same picture — this is a treatment over it, not a second image.
    await expect(within(pane).getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();

    await userEvent.click(off);
    await expect(
      await within(pane).findByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();
    await expect(pane.querySelector("[data-foil-sheen]")).toBeNull();
  },
};

/**
 * Every printing of one card, **grouped by artist** — which is what the list opens on.
 *
 * Artist is the default because "which art is this?" is the question a printings list is asked,
 * and a heading that is an *illustrator* is a name the reader can check against the card in
 * their hand, where "Artwork 2" would be a number invented here. It is no longer the only
 * answer: the control beside the heading offers four, and `buildPrintingGroups` decides all of
 * them.
 *
 * **The groups are the artists, sorted, not the artworks in arrival order.** `groupByArtist`
 * folds every printing by one illustrator into one group and orders the groups
 * alphabetically (`localeCompare` with an explicit `"en"`, so the shipped window and the suite
 * cannot disagree), with the unattributed last. The old `groupByIllustration` headed each
 * *artwork* with its artist's name, so two artworks by one illustrator made two identically
 * headed groups; this makes one. Measured over `CARDS` 2026-08-13, the corpus has no such pair
 * — its one repeated illustrator (Mark Poole, {@link SharedArtist}) also repeats the
 * illustration — so the difference between the two functions is proved in
 * `printings.test.ts` rather than here.
 *
 * The count line says both figures because they are different questions: `items` is capped at
 * 400 and `total` is not, so a Forest reads "400 of 862 printings" rather than claiming it has
 * 400. The second half is the *mode's* word, and it moves with the control.
 *
 * Measured 2026-08-10 over `readHandlers(seed("starter")).card_printings` for Lightning Bolt:
 * **4 printings, 4 artists** — `sld 1638` (Desmuncubic), `2x2 117` (Christopher Moeller),
 * `sta 105` (Ezoi) and `lea 161` (Christopher Rush), which Rust hands over newest first and
 * this mode re-heads alphabetically.
 *
 * **The printing the pane is about does not offer to show itself.** It draws a gold hairline
 * down its edge and its set code as static text, where every other row's is a button — the
 * mouse clicks the row, the keyboard presses that button, one destination and two ways in.
 */
export const Printings: Story = {
  args: { cardId: BOLT_LEA },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // `find`, not `get`: the section draws its heading while the printings query is still in
    // flight, so the region exists a commit before its rows do.
    await expect(await within(list).findByText("4 printings · 4 artists")).toBeInTheDocument();
    await expect(within(list).getByRole("combobox", { name: "Group printings by" })).toHaveValue(
      "artist",
    );

    // One heading per artist, **in alphabetical order** — `getAllByText` answers in document
    // order, which is the only thing that can say the sort ran.
    await expect(
      within(list)
        .getAllByText(/^(Christopher Moeller|Christopher Rush|Desmuncubic|Ezoi)$/)
        .map((heading) => heading.textContent),
    ).toEqual(["Christopher Moeller", "Christopher Rush", "Desmuncubic", "Ezoi"]);
    // Four groups, four lists: a group is a heading *and* its own `<ul>`, which is what makes
    // the flat list of {@link GroupedByPrice} structurally different rather than merely
    // unlabelled.
    await expect(within(list).getAllByRole("list")).toHaveLength(4);

    // Three handles, and not a fourth: `lea 161` is the open printing and is static text.
    await expect(within(list).getByRole("button", { name: "Show SLD · 1638" })).toBeEnabled();
    await expect(within(list).getByRole("button", { name: "Show 2X2 · 117" })).toBeEnabled();
    await expect(within(list).getByRole("button", { name: "Show STA · 105" })).toBeEnabled();
    await expect(within(list).queryByRole("button", { name: "Show LEA · 161" })).toBeNull();

    // The Japanese printing is marked as one — the badge carries an `sr-only` "Language: " so
    // the two letters are not read as a word. The prefix is a separate node, so the claim is
    // made against the badge's whole text rather than by looking the sentence up. What the
    // letters are *short for* is the badge's hover ("Printed in Japanese", from `languages.ts`),
    // which is a 400ms rest a play would have to sit through — `AllPrintingsDialog.test.tsx`
    // holds that assertion on fake timers instead.
    await expect(within(list).getByText("ja")).toHaveTextContent("Language: ja");
  },
};

/**
 * Two printings, **one** artist — which is the only thing that proves the grouping does
 * anything at all.
 *
 * Alpha and Unlimited Ancestral Recall are both Mark Poole's, so under the default mode they
 * arrive under one heading with the count beside it, and the name is drawn once rather than
 * twice. The other half of the pair is {@link Printings}, where four printings are four groups;
 * {@link GroupedBySet} is this same card cut the other way, where the one group becomes two.
 *
 * The two also share an `illustration_id`, so this is a case the old artwork grouping would
 * have merged as well. What separates the two rules is a printing *reprinted with new art by
 * the same illustrator*, which this corpus does not contain — `printings.test.ts` owns that
 * fixture, and this story owns the rendering.
 *
 * Measured 2026-08-10: `card_printings` answers **2 items**, `2ed 48` then `lea 47`.
 */
export const SharedArtist: Story = {
  args: { cardId: printingId("lea", "47") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 1 artist")).toBeInTheDocument();
    // One heading, carrying its own count — two rows under one name, in one list.
    await expect(within(list).getAllByText("Mark Poole")).toHaveLength(1);
    await expect(within(list).getByText("Mark Poole").closest("p")).toHaveTextContent(
      "Mark Poole· 2",
    );
    await expect(within(list).getAllByRole("list")).toHaveLength(1);
    await expect(within(list).getByRole("button", { name: "Show 2ED · 48" })).toBeEnabled();
  },
};

/**
 * The same four printings **by release date** — one group per distinct day, newest first.
 *
 * The mode a reader is in when they are looking for "the one from a couple of years ago". It
 * groups on the raw ISO string rather than on a parsed date, because that is what the bucket
 * has to be unique by anyway and `YYYY-MM-DD` already sorts chronologically as text; only the
 * *heading* parses, and a row whose date is malformed reads as that string rather than as
 * "Invalid Date".
 *
 * **The heading's locale and time zone are both pinned, and both are load-bearing.**
 * `en-GB` because a date that read differently in the test runner, in Storybook and in the
 * shipped window would make every assertion about it a machine-specific one; **UTC** because
 * `releasedAt` is a calendar date with no time in it, and a formatter left on the local zone
 * renders midnight UTC as the evening *before* anywhere west of Greenwich — one day early for
 * every card in the game, on exactly the machines least likely to be the ones testing it.
 *
 * Opened already in this mode by seeding the setting rather than by driving the select, which
 * is what a reader who chose it last week sees; {@link ChoosingHowToGroup} is the interaction.
 *
 * Measured 2026-08-13 over `CARDS`: four printings, four distinct dates, so the counts match
 * {@link Printings} exactly and only the words and the order change.
 */
export const GroupedByReleaseDate: Story = {
  args: { cardId: BOLT_LEA, groupBy: "released" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // The seeded mode is the one the control shows: the select and the list read the same
    // answer, so a story cannot stage a header that disagrees with what is under it.
    await expect(within(list).getByRole("combobox", { name: "Group printings by" })).toHaveValue(
      "released",
    );
    await expect(
      await within(list).findByText("4 printings · 4 release dates"),
    ).toBeInTheDocument();

    // Newest first — this app's default direction everywhere, and already the order the rows
    // arrive in from Rust.
    await expect(
      within(list)
        .getAllByText(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/)
        .map((heading) => heading.textContent),
    ).toEqual(["8 Apr 2024", "8 Jul 2022", "23 Apr 2021", "5 Aug 1993"]);
    await expect(within(list).getAllByRole("list")).toHaveLength(4);
    // No artist heads anything here; the credit is still on each row's own facts.
    await expect(within(list).queryByText("Desmuncubic")).toBeNull();
  },
};

/**
 * **By price — the one mode that makes no groups at all.**
 *
 * Cheapest first, in a single list, because the whole point of the mode is a ranking a reader
 * can read straight down: a run of same-priced printings has nothing to head it that is not a
 * number already printed on the row. So `buildPrintingGroups` answers one group with a `null`
 * heading, the pane renders **no heading element** rather than an empty one — a flat list under
 * a blank line would read as a group whose name failed to load — and the summary drops its
 * second half whole rather than rewording it, because "· 1 price" would count a thing that is
 * not on screen.
 *
 * The price it sorts by is the **cheapest across finishes**, not the nonfoil one: a printing can
 * exist in exactly one finish, and ranking an etched-only promo by its missing plain price would
 * put the expensive ones at the bottom with the unpriced ones. A `null` sinks rather than
 * sorting as zero — it is *unpriced at this marketplace*, which is not the same claim as free —
 * and negative or non-finite values are treated as absent, because these numbers come from bulk
 * pricelists and a `-1` that reached the comparator would sort a garbage row to the top of the
 * most visible list in the pane.
 *
 * Measured 2026-08-13 at TCGplayer, the default: `2x2 117` at $2.39 (its **foil**, which is
 * cheaper than its own nonfoil $2.50), `sld 1638` at $3.03, `sta 105` at $17.85 and `lea 161` at
 * $620.00. The open printing is the dearest of the four and sorts last like any other row —
 * the pane's own card is not privileged in any mode.
 */
export const GroupedByPrice: Story = {
  args: { cardId: BOLT_LEA, groupBy: "price" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(within(list).getByRole("combobox", { name: "Group printings by" })).toHaveValue(
      "price",
    );
    // The count, and **nothing after it** — no "· 1 price", no group word at all. Asserted
    // against the whole line rather than by looking a substring up, because the `·` this mode
    // drops is a character every row's own set line uses.
    await expect(await within(list).findByText("4 printings")).toHaveTextContent(/^4 printings$/);

    // One list, no headings — the structural claim, and the only mode that makes it.
    await expect(within(list).getAllByRole("list")).toHaveLength(1);
    await expect(within(list).queryByText("Christopher Rush")).toBeNull();
    await expect(within(list).queryByText("Limited Edition Alpha")).toBeNull();

    // Cheapest first. Asserted through the row handles, whose accessible names Testing Library
    // returns in document order, plus the open printing — which has no handle, being static
    // text, and is the last row.
    const rows = within(list).getAllByRole("listitem");
    await expect(rows).toHaveLength(4);
    await expect(
      within(list)
        .getAllByRole("button", { name: /^Show / })
        .map((handle) => handle.getAttribute("aria-label")),
    ).toEqual(["Show 2X2 · 117", "Show SLD · 1638", "Show STA · 105"]);
    await expect(rows[3]).toHaveTextContent("LEA · 161");
  },
};

/**
 * **By set, sets in release order** — the mode for a reader who remembers the box.
 *
 * A set has no date of its own on a `Printing`, so it takes the **earliest** date among its own
 * printings rather than the first one seen: the per-card dates inside one set disagree, because
 * a promo, a prerelease stamp or a Secret Lair drop attached to a set is dated after the set
 * shipped. Taking the earliest is what makes "release order" the order the sets came out in,
 * rather than an order a single late variant can push a set to the top of. A set none of whose
 * printings carry a date sorts last, and equal dates break by `setCode` ascending, so the answer
 * never depends on which of two same-day sets Rust happened to list first.
 *
 * The heading is the set's **name**, falling back to the upper-cased code — which is a real
 * fallback rather than a defensive one, since `set_name` is nullable per row and a three-letter
 * code is what a Magic player calls a set anyway.
 *
 * Measured 2026-08-13: Secret Lair Drop (2024), Double Masters 2022, Strixhaven Mystical Archive
 * (2021), Limited Edition Alpha (1993).
 */
export const GroupedBySet: Story = {
  args: { cardId: BOLT_LEA, groupBy: "set" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(within(list).getByRole("combobox", { name: "Group printings by" })).toHaveValue(
      "set",
    );
    await expect(await within(list).findByText("4 printings · 4 sets")).toBeInTheDocument();

    await expect(
      within(list)
        .getAllByText(
          /^(Secret Lair Drop|Double Masters 2022|Strixhaven Mystical Archive|Limited Edition Alpha)$/,
        )
        .map((heading) => heading.textContent),
    ).toEqual([
      "Secret Lair Drop",
      "Double Masters 2022",
      "Strixhaven Mystical Archive",
      "Limited Edition Alpha",
    ]);
    await expect(within(list).getAllByRole("list")).toHaveLength(4);
  },
};

/**
 * **The control itself** — one press, and the same rows re-read as something else.
 *
 * The three stories above are staged by seeding the setting, which is the reader who chose a
 * mode and came back to it. This is the moment of choosing, and it is the interaction the whole
 * feature is: nothing is refetched, nothing is asked of the backend before the list moves, and
 * `card_printings` is not in the loop at all — `buildPrintingGroups` re-cuts the rows already in
 * hand. The write to `app_meta` goes out behind it and is deliberately **not** rolled back if it
 * is refused: `set_printing_group_by` answers BUSY while a sync holds the write connection, and
 * the reader's order snapping back under their hand mid-sync, with nothing on screen saying why,
 * would be the worst of both. What a refusal costs is only that the next launch opens on the
 * mode before it.
 *
 * The select is labelled for a screen reader alone. Every other "Group by" in the app carries a
 * visible `<label>` — the deck editor's toolbar, two inches to the left, is the control this one
 * is copied from — but that toolbar has a window's width and this pane has 352px of content
 * column, already spent on the heading. The name says what it groups rather than just "Group
 * by", because a reader listing this pane's controls hears it beside the marketplace and the
 * deck's own grouping.
 */
export const ChoosingHowToGroup: Story = {
  args: { cardId: BOLT_LEA },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // Where a reader who has never touched it starts.
    await expect(await within(list).findByText("4 printings · 4 artists")).toBeInTheDocument();
    const groupBy = within(list).getByRole("combobox", { name: "Group printings by" });
    await expect(groupBy).toHaveValue("artist");

    await userEvent.selectOptions(groupBy, "set");

    // The same four rows, cut four different ways — the count line, the headings and the
    // groups all move together, because all three are read off the one array.
    await expect(await within(list).findByText("4 printings · 4 sets")).toBeInTheDocument();
    await expect(groupBy).toHaveValue("set");
    await expect(within(list).getByText("Secret Lair Drop")).toBeInTheDocument();
    await expect(within(list).queryByText("Desmuncubic")).toBeNull();
    // And the rows themselves are the same rows: nothing was refetched to reorder them.
    await expect(within(list).getByRole("button", { name: "Show SLD · 1638" })).toBeEnabled();

    // Price is the one that changes the *shape* of the list rather than its headings.
    await userEvent.selectOptions(groupBy, "price");
    await expect(await within(list).findByText("4 printings")).toBeInTheDocument();
    await expect(within(list).getAllByRole("list")).toHaveLength(1);
    await expect(within(list).queryByText("Secret Lair Drop")).toBeNull();
  },
};

/**
 * A printing that exists in all three finishes, priced three different ways.
 *
 * **A finish's price is its own field on the answer and nothing else** — `finishPrices.nonfoil`,
 * `.foil`, `.etched`, each built by `sorting::price_expr` at the marketplace the read named, with
 * no fallback. The derived `cards.price_usd` column is a nonfoil→foil→etched chain built for
 * sorting, and using it here would quote a plain copy at foil rates. Etched is a third thing and
 * never `foil: true`: flattening it is the single commonest way an importer loses data — and it
 * is the finish the four marketplaces disagree about in *kind*, since Scryfall has no
 * `eur_etched` key while Mana Pool publishes 1 198 real etched prices.
 *
 * Measured 2026-08-10 over `card_detail` for `sta 105`: `usd 17.85`, `usd_foil 23.85`,
 * `usd_etched 18.68` — so **foil is dearer than etched here**, which is the ordering a single
 * number could not have told you. (Counterspell `mh2 267` is the corpus's only other three-finish
 * row and orders them the other way: `2.95 / 3.19 / 3.25`.) The same printing is the corpus's one
 * non-English row, so the language badge is drawn beside the set: shown only when it is not the
 * assumed one.
 *
 * It is also where the foil view's tie-break is visible: three finishes, and the control offers
 * **foil**, because foil is far the commoner of the two shiny ones and the one a reader means by
 * "what does it look like shiny". Nothing here weakens `soleFinish`, which speaks only for a
 * printing with exactly one non-plain finish.
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
    // Three finishes, one view offered, and it is the foil one.
    await expect(
      within(pane).getByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();
    await expect(within(pane).queryByRole("button", { name: /etched/ })).toBeNull();
    // Spec §5: a price is never shown without saying how old it is. `waitFor` for the reason
    // `SingleFaced` writes out: the pane fades in, and a `toBeVisible` under it is false until
    // the arrival lands.
    await waitFor(
      () =>
        expect(
          within(pane).getByText("TCGplayer prices as of the last card-data sync."),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // Once in the card's own facts and once on its row in the printings list below. The badge's
    // `sr-only` prefix is a separate node, so each is checked through its own whole text.
    await within(pane).findByText("4 printings · 4 artists");
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
 * It is also the printing that settles the **heading**. The chips became a section on 2026-08-20
 * — hairline, 12px uppercase word, the build `Printings` below already had — and the word is
 * **Formats** rather than "Legal formats" because this card would then be filed under a heading
 * seven of its own eight chips contradict. 3 461 cards in the corpus carry at least one banned or
 * restricted chip (3.0% of the 116 712 with legality data, measured 2026-08-20); this is the
 * extreme of them.
 *
 * The caption under the chips is the counterpart of the `not_legal` filter above: it keeps 11.3
 * of 23 formats on a typical card, and without a line saying so the fifteen it dropped here are
 * an absence the reader has to already know how to read.
 *
 * It has no USD price at all while its `eur` key is filled, so at the default marketplace the one
 * finish it exists in reads an **em dash**: `formatPrice` never renders `$0.00`, which is a price
 * nobody quoted.
 */
export const Legalities: Story = {
  args: { cardId: printingId("lea", "232") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **The section is re-read inside a `waitFor`, and that is not defensive padding** (added
    // 2026-08-20). This pane renders its body keyed on the open card, so the body a play first
    // sees is *replaced* the moment the card query resolves — and how long that takes is a fact
    // about the machine rather than about the pane. Run alone this story settled first and the
    // reads below were safe; run inside the whole of `stories.test.tsx` the resolve lands
    // **during** the play, and a node read before it is a node that has since been detached.
    // `toBeVisible` is false for a node that is no longer in the document, so the failure reads
    // as *"the Formats heading is invisible"* — a sentence about the one thing this story exists
    // to check — while the heading is on screen and perfectly correct. Retrying the read is what
    // tells those two apart. **It still fails for a section that is genuinely absent**, which is
    // the whole assertion: `NoLegalities` below is the story that pins that answer, and this one
    // would have to wait out the full timeout before agreeing with it.
    //
    // The section names the chips; the list inside it keeps its own, more exact name.
    const formats = await waitFor(() => {
      const pane = canvas.getByRole("complementary", { name: "Card details" });
      const region = within(pane).getByRole("region", { name: "Formats" });
      expect(within(region).getByRole("heading", { name: "Formats" })).toBeVisible();
      return region;
    });
    await expect(within(formats).getByText("Formats not listed are not legal.")).toBeVisible();
    const chips = within(formats).getByRole("list", { name: "Format legality" });
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
    // No USD for any finish of this printing, and no invented zero. The pane is re-read for the
    // reason above: the one held from before the `waitFor` may be a body that has been replaced.
    const settled = canvas.getByRole("complementary", { name: "Card details" });
    await expect(within(settled).getByText("Nonfoil").closest("div")).toHaveTextContent("Nonfoil—");
  },
};

/**
 * A card legal in nothing at all — so the chip list is **absent**, not empty.
 *
 * `Legalities` returns `null` when every key filters out, which is the right answer for the
 * corpus's one art-series printing: measured 2026-08-10, all 23 of `amh2 5s`'s legality keys are
 * `not_legal`. A section header over nothing, or a line reading "Not legal anywhere", would both
 * be the pane inventing a fact about a card that is not a card — and that is still the shape
 * after the chips became a headed section on 2026-08-20, which is what this story now holds.
 * **The heading, the hairline and the caption go with the chips**: a "Formats" rule over empty
 * space is the invented fact in a new form, and "Formats not listed are not legal" under nothing
 * at all is a sentence about all 23 of them. 9 176 cards in the corpus land here.
 *
 * It is the corpus's `imageStatus: "missing"` row as well, and its six price keys are null —
 * so this is also the one printing where a story can say what the pane looks like when the data
 * has nothing to offer it: the art frame, the name, the provenance and one dashed price.
 * `art_series` is a two-sided layout, so it still offers its flip — alone and full width, since
 * it is sold in one finish and there is no view to offer beside it.
 */
export const NoLegalities: Story = {
  args: { cardId: printingId("amh2", "5s") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    await expect(within(pane).queryByRole("list", { name: "Format legality" })).toBeNull();
    // The heading and the caption are part of the chips, not chrome that outlives them.
    await expect(within(pane).queryByRole("region", { name: "Formats" })).toBeNull();
    await expect(within(pane).queryByText("Formats not listed are not legal.")).toBeNull();
    await expect(within(pane).getByText("Nonfoil").closest("div")).toHaveTextContent("Nonfoil—");
    // Still a card, still credited, still turnable over.
    await expect(within(pane).getByText("AMH2 · 5s")).toBeInTheDocument();
    await expect(
      within(pane).getByRole("button", { name: "Flip to Prismatic Ending" }),
    ).toBeInTheDocument();
    await expect(within(pane).queryByRole("button", { name: /^View as/ })).toBeNull();
    await expect(within(pane).getByText(/^Illustrated by John Stanko\./)).toBeInTheDocument();
  },
};

/**
 * The picture did not arrive — so the frame says what is known and guesses at nothing.
 *
 * A rate-limited image is a **503 the `<img>` cannot read**: the element gets an `error` event
 * and no status code, so the panel that replaces it names the card, says the fetch may still be
 * running, and states the way back. It is deliberately not the no-art case — a printing with no
 * art anywhere is served a placeholder at the variant's exact dimensions, a 200 and never a 404,
 * so it draws a picture like any other card.
 *
 * **The error is fired rather than provoked, because nothing here can fail on its own**: the
 * fake answers every id with a synthetic SVG data URI, which needs no network
 * (`.storybook/fake/images.ts:141-156`). `PrintingPreview`'s `AfterAFailedFetch` stages its
 * failure the same way for the same reason.
 *
 * Everything below the frame is untouched — the failure belongs to one `<img>`, not to the card,
 * and not to the controls under it either: the foil view is still offered, because whether this
 * printing exists in two finishes is a fact about the printing and not about whether its picture
 * downloaded.
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
    await expect(
      within(pane).getByRole("button", { name: "View as foil", pressed: false }),
    ).toBeInTheDocument();
    await expect(within(pane).getByRole("region", { name: "Printings" })).toBeInTheDocument();
  },
};

/**
 * A printing the card database has no row for — **said in words, with the way out**.
 *
 * `card_detail` answers `null` rather than raising, so this is neither an error nor a spinner:
 * the pane draws its heading, its close control and one paragraph naming the likely cause. The
 * heading falls back to the word "Card", because there is no name to show and "Loading…" would
 * be a lie about a query that has already answered.
 *
 * Reached the only way it can be — by naming an id `cards` has no row for. That is what an
 * orphan *is*: user tables reference `cards.id` softly, so a row whose printing left the
 * database is flagged and kept, never deleted, and this pane is what opening one shows.
 *
 * Nothing below the paragraph is drawn, printings included: the section is behind `card.data`,
 * and a card with no `oracle_id` has no list to fail at loading either.
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
 * The card opened **as a deck row** — which is what turns every other printing into a swap.
 *
 * `openCardFromDeck` is the sole writer of `paneDeckContext` (`store.ts:135-136`), so the write
 * exists exactly where a slot exists to rewrite. Spec §2 scopes it to decks on purpose: a
 * collection entry's identity carries finish and condition, and swapping a printing there would
 * invent facts.
 *
 * **There is no "Use this printing" button any more — the row is the press.** `DeckLine` drew
 * one on a line of its own under every printing; the row itself is 352px wide, already clickable
 * and already the thing the reader is pointing at, so the click does what the button did. What
 * survives the deletion is everything the button *said*: the accessible name on the row's own
 * handle still carries the printing **and** the category, because the same printing can sit in
 * the main deck and the sideboard and forty rows otherwise share one visible label — and it is
 * the only place a reader who cannot see the row is told that pressing it rewrites a deck rather
 * than showing a card.
 *
 * The row the deck already holds says so with a small **`In deck`** badge rather than a control
 * that cannot be pressed: text and not colour, because the row's other mark is the gold hairline
 * for "this is the printing you are looking at", which is a different fact and must stay
 * distinguishable from it by more than a hue.
 *
 * Deck 2 (`Kenrith Two-Drops`) holds Sol Ring `c21 263` in its main category, and `sld 913` is
 * the corpus's only other Sol Ring — measured 2026-08-10 over `deck_get({ id: 2 })` and
 * `card_printings`.
 */
export const FromDeckRow: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 2 artists")).toBeInTheDocument();
    // The deck's own printing states the fact and offers nothing — it is also the open one, so
    // it has no handle at all.
    await expect(within(list).getByText("In deck")).toBeInTheDocument();
    await expect(within(list).queryByRole("button", { name: "Show C21 · 263" })).toBeNull();
    // The other row's handle **is** the write, and says which slot it rewrites.
    await expect(
      await within(list).findByRole("button", {
        name: "Use this printing (SLD 913) in Main deck",
      }),
    ).not.toHaveAttribute("aria-disabled", "true");
  },
};

/**
 * The same card opened from anywhere else — **and pressing a row only shows it**.
 *
 * `setSelectedCardId` clears `paneDeckContext` (`store.ts:133`), and that one line is what makes
 * "every other way of opening a card leaves no deck context" true by construction rather than by
 * six call sites remembering it. Search tiles, collection rows, wishlist rows, the docked panel's
 * tiles, the validation panel's card names and the pane's own close all go through it.
 *
 * Identical to {@link FromDeckRow} in every other respect — same printing, same list, same two
 * artists — which is the point of storying it separately: the difference between the two is one
 * store action, and it is worth being able to see that it is the *only* difference. Here the
 * handles are named "Show", the badge is absent, and a click browses.
 */
export const FromSearch: Story = {
  args: { cardId: SOL_RING_C21, deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    // The list is all there — this is not a pane missing a section.
    await expect(await within(list).findByText("2 printings · 2 artists")).toBeInTheDocument();
    await expect(within(list).getByRole("button", { name: "Show SLD · 913" })).toBeEnabled();
    // And no deck anywhere on it: no write offered, and no claim about a deck either.
    await expect(within(list).queryByRole("button", { name: /^Use this printing/ })).toBeNull();
    await expect(within(list).queryByText("In deck")).toBeNull();
  },
};

/**
 * **Pressing a printing rewrites the deck, and the pane follows it** — the whole of what a
 * deck-opened printings list is for, end to end.
 *
 * One press does two things, in one store write: `deck_swap_printing` moves the slot onto the
 * printing that was pressed, and `openCardFromDeck` re-opens the pane on it — so the reader ends
 * up looking at the card their deck now plays rather than at the one it used to. The pane is
 * keyed on `selectedCardId`, so that is a remount: a new front face, a new scroll position, a new
 * everything-per-card. The grouping is the one thing that survives it, because it is a query and
 * not component state.
 *
 * **The marks trade places, and that is the assertion.** Before the press the deck holds
 * `c21 263`: that row wears `In deck` and `sld 913`'s handle offers the write. Afterwards the
 * deck holds `sld 913`, which is now both the pane's card *and* the deck's, so it is static text
 * with the badge — and `c21 263`, the printing the reader came from, has become the offer. Which
 * is also the way back: pressing it swaps again.
 *
 * This story replaced one called `BrowsingPrintingsKeepsTheOffers`, which walked the same two
 * rows to prove that browsing a printing left the swap alive. That claim no longer exists to be
 * made: from a deck row there is no browsing left in this list — a click *is* the commitment —
 * and what a reader gets instead is the hover preview, which shows any row's art without
 * pressing anything. {@link FromSearch} is where a click still browses.
 */
export const ClickingAPrintingSwapsTheDeck: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = await canvas.findByRole("region", { name: "Printings" });
    const use = await within(before).findByRole("button", {
      name: "Use this printing (SLD 913) in Main deck",
    });
    // The deck holds the printing the pane is showing, and says so.
    await expect(within(before).getByText("In deck")).toBeInTheDocument();

    await userEvent.click(use);

    // **Waited for against the canvas, not against the section captured above.** The write is a
    // round trip, so that element is still mounted the instant the click returns — and then the
    // success re-keys the pane, unmounting it. A `waitFor` holding the old node would be
    // watching a detached tree for a change that lands in its replacement.
    await waitFor(async () => {
      await expect(
        canvas.getByRole("button", { name: "Use this printing (C21 263) in Main deck" }),
      ).toBeInTheDocument();
    });

    // The pane moved onto the printing the deck now plays: `sld 913` is the open row, so it is
    // static text with the badge, and the offer is on the row the reader came from.
    const after = canvas.getByRole("region", { name: "Printings" });
    await expect(
      within(after).queryByRole("button", { name: /^Use this printing \(SLD 913\)/ }),
    ).toBeNull();
    await expect(within(after).queryByRole("button", { name: "Show SLD · 913" })).toBeNull();
    // One badge, and it has followed the deck rather than the pane — they are the same row now.
    await expect(within(after).getAllByText("In deck")).toHaveLength(1);
    // Nothing was refused, and nothing folded: deck 2 held no `sld 913` row to merge into.
    await expect(within(after).queryByRole("alert")).toBeNull();
  },
};

/**
 * The deck was deleted from another view — so the rows stop offering a write they can only be
 * refused, and go back to being a printings list.
 *
 * `useSwapFromPane` mounts the editor's own `["decks", "detail"]` read and reports `deckGone`
 * when it succeeds and answers nothing (`useDeck.ts:456-473`). Every row then reverts: the
 * handle is named "Show" again and a press browses, and the `In deck` badge is gone too, because
 * that sentence is not true of a deck that is not there — and forty offers whose only way of
 * finding out is to be pressed are forty wrong offers.
 *
 * The `gone` fault is what stages it: measured 2026-08-10, `deck_get({ id: 2 })` answers `null`
 * under it while `card_detail` and `card_printings` go on answering, which is exactly the split
 * this state is about. What the pane keeps is the card — a deck disappearing is not a reason to
 * stop showing a printing, or to stop letting the reader look through the others.
 */
export const DeckGone: Story = {
  args: { cardId: SOL_RING_C21, deckId: 2 },
  parameters: { fake: { fault: "gone" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("region", { name: "Printings" });
    await expect(await within(list).findByText("2 printings · 2 artists")).toBeInTheDocument();
    // The read has to land first: while it is pending the deck is not known to be gone, and the
    // rows are still offers.
    await waitFor(async () => {
      await expect(within(list).getByRole("button", { name: "Show SLD · 913" })).toBeEnabled();
    });
    await expect(within(list).queryByRole("button", { name: /^Use this printing/ })).toBeNull();
    // Nor the badge on the deck's own printing: the deck is not there to hold anything.
    await expect(within(list).queryByText("In deck")).toBeNull();
    // And no complaint — nothing was attempted, so nothing failed.
    await expect(within(list).queryByRole("alert")).toBeNull();
  },
};

/**
 * A swap the database refused — **said beside the row that was pressed**.
 *
 * A banner at the top of the pane would be one sentence for forty rows with nothing on screen
 * saying which; the refusal is a `role="alert"` on the row's own line, which is where the reader
 * is looking. `db.ts`'s `BUSY` is `collection::BUSY` verbatim, raised by every write handler and
 * by no read handler — which is why the card, the prices and the printings list underneath are
 * untouched.
 *
 * **The caret used to be the invisible half of this story, and it is the half the rework
 * deleted.** `DeckLine`'s button set the `disabled` attribute for the duration of the write, and
 * a browser blurs a control that disables itself with no `relatedTarget` at all — so the caret
 * landed on `<body>`, inside a layer whose Escape hands focus back to whatever opened the pane,
 * and a hand-back effect existed purely to repair that. The press is now the row's own handle,
 * which goes `aria-disabled` and **never leaves the tab order** (`src/CLAUDE.md`), so it simply
 * keeps the caret and the repair was deleted rather than carried over. This play still asserts
 * the caret, because the guarantee is what matters and not the mechanism that used to buy it.
 *
 * The offer stays on the row: recording the same card twice is one interaction, and so is
 * trying again — and since nothing stops the click on the refusal itself any more, pressing the
 * row again *is* the retry.
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
    // Still offered, still named for what it does, and still holding the caret.
    await waitFor(async () => {
      await expect(
        within(list).getByRole("button", { name: "Use this printing (SLD 913) in Main deck" }),
      ).toHaveFocus();
    });
    // The deck still holds what it held: nothing was written, and the pane still says so on the
    // row it is true of.
    await expect(within(list).getByText("In deck")).toBeInTheDocument();
  },
};
