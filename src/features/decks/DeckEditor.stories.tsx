import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { deckCardSlot, DECK_CARD_ATTR } from "./dnd";
import { DeckEditor } from "./DeckEditor";

/** Sol Ring's two printings, by id — the fold's two halves, and the only two rows in the corpus
 *  that can be folded together. Measured 2026-08-10 over `.storybook/fake/cards.ts`. */
const SOL_RING_SLD = "16a2c470-b2b8-4633-89b1-7b936bcaff8d";

/**
 * One deck, open — and, for the one story that needs it, the card pane docked beside it.
 *
 * **`deckId` is a prop of `DeckEditor` (`DeckEditor.tsx:142`), not something it reads out of the
 * store**, so this file writes no `openDeckId`: `App.tsx:26` reads that id and `App.tsx:38` hands it over,
 * and setting it here would stage a fact nothing on screen consumes. The store *is* what carries
 * the pane's deck context, and that is written by clicking a row rather than by a decorator
 * (`store.ts:135-136`'s `openCardFromDeck` is the only writer).
 *
 * `deckId: null` means **make one first**, through the same `deck_create` the gallery's New deck
 * form sends — the only way to reach an empty deck, since no seed has one (`seeds.ts:385-439`
 * gives all three seeded decks cards). A `useQuery` rather than an effect with a `setState`: it
 * runs once, it is cached in the story's own client, and `staleTime: Infinity` is what keeps a
 * window refocus in the Storybook browser from creating a second deck.
 *
 * The pane is a **sibling** of the editor here exactly as it is in `App.tsx:75-88`, keyed on the
 * card id for the same reason: a swap re-keys it onto the printing the deck now holds, and the
 * sentence saying what happened has to cross that unmount.
 */
function Editor({ deckId, pane = false }: { deckId: number | null; pane?: boolean }) {
  const created = useQuery({
    queryKey: ["story", "empty-deck"],
    queryFn: () => ipc.deckCreate({ name: "Untitled", formatKey: "modern" }),
    enabled: deckId === null,
    staleTime: Infinity,
  });
  const id = deckId ?? created.data?.id ?? null;

  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const closeCard = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="min-w-0 flex-1">{id !== null && <DeckEditor key={id} deckId={id} />}</div>
      {pane && selectedCardId && (
        <CardDetailPane key={selectedCardId} cardId={selectedCardId} onClose={closeCard} />
      )}
    </div>
  );
}

const meta = {
  title: "Decks/Editor",
  component: Editor,
  tags: ["autodocs"],
  args: { deckId: 1 },
  // Keyed, so changing the deck in Controls mounts a fresh editor rather than one that inherits
  // the last deck's grouping, open menu and add target — which is what `App.tsx:38` does with the
  // same key, for the same reason.
  render: (args) => <Editor key={`${args.deckId}:${args.pane}`} {...args} />,
  decorators: [
    // The editor is `h-full`, so it needs a parent with a height or its zone columns have none.
    // 1032px is exactly the content column at the 1280×800 window `tauri.conf.json:16-17` opens:
    // 1280 less the sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px), from
    // `AppShell.tsx:92` and `AppShell.tsx:144`. 720px of height is chosen rather than derived —
    // the ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="h-[720px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "One deck, open for editing — the Decks view in its second state rather than a screen " +
          "of its own. **There is no Save**: every control writes through one of Task 4's " +
          "commands and the list redraws from what the database answered, which is what " +
          "“autosave drafts” honestly means for a deck — the row *is* the draft.\n\n" +
          "Driven end to end by `.storybook/fake/`. The three seeded decks, measured 2026-08-10 " +
          'over `readHandlers(seed("starter")).deck_get`: **deck 1 `Modern Goodstuff`** is 18 ' +
          "rows — 60 main, 15 sideboard, 2 in the scratchpad — and validates **clean**; " +
          "**deck 2 `Kenrith Two-Drops`** is 99 main + 1 commander + 1 companion and produces " +
          "**exactly one** issue; **deck 3 `Old School 93/94`** is 4 rows holding 22 cards.\n\n" +
          "**Zero removes a deck row.** A zone slot holds an intention and nothing else, so it " +
          "sides with the wishlist rather than with the collection — and there is **no remove " +
          "mutation**: the tray's drop and the stepper's zero are both `setQuantity(…, 0)` " +
          "(`useDeck.ts:158-182`). {@link ZeroRemovesTheRow} is that, pressed.\n\n" +
          "**`maybe` counts toward nothing at all** — not size, not copies, not legality — and " +
          "the allocator never claims a copy for it, so every scratchpad row reads `0` owned " +
          "**by design** rather than for want of copies. {@link MaybePile} is the proof, on a " +
          "row that is `modern: not_legal` while the chip beside it still reads no issues.\n\n" +
          "**Owned is an allocation, never a decrement.** It is rebuilt on a zone write, the " +
          "Built toggle, or “Send missing to wishlist” — those three and nothing else — and a " +
          "**built** deck's claims come off what every other deck can see. Measured 2026-08-10 " +
          "by flipping deck 2's `isBuilt` off and re-reading deck 1: Counterspell 1→2, Ragavan " +
          "0→1, Tarmogoyf 2→3, Urza's Saga 3→4, and the deck's shortfall 65→61 of 75. " +
          "{@link Modern60} reads one of those badges and {@link BuiltToggle} presses the " +
          "switch.\n\n" +
          "**The editor has six mutations and no remove** — update (rename, cover, Built), " +
          "add-card, set-quantity, move, missing-to-wishlist and swap-printing. The last has no " +
          "control in this component at all: it is pressed on the card pane, which is a sibling " +
          "under `App`, and `DeckEditor.tsx:330-337` says in as many words that its entry in the " +
          "refused-write family can never fire from here. {@link SwapFolds} therefore renders " +
          "the pair, as `App` does.\n\n" +
          "**Drag-and-drop has no story on this page, and that is deliberate.** The zones are " +
          "drop targets and four surfaces are drag sources, but Storybook runs in an ordinary " +
          "browser with no WRY OLE drop target — while the shipped window depends on " +
          '`"dragDropEnabled": false` in `tauri.conf.json`, which is embedded at compile time. ' +
          "**A green drag here would prove nothing about the real app**; that is the live CDP " +
          "pass's to prove, and `Chrome/AppShell` already exercises the payload boundary.",
      },
    },
  },
} satisfies Meta<typeof Editor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Sixty Modern-legal cards, a full sideboard, and nothing wrong with any of it.
 *
 * Three columns rather than four: `main` is unconditional, `side` is drawn because Modern's
 * `sideboardMax` is 15, `companion` because its `allowsCompanion` is true — and `commander` is
 * absent because Modern requires none *and* the zone is empty. A zone holding cards is drawn
 * whatever the format says, so a re-format can never leave copies invisible and still counted.
 *
 * The headline figure is 60 with "+ 15 sideboard" under it, and that split is the whole reason
 * `DeckStats` imports `SIZE_ZONES` from the validation engine: the chip beside it says "Modern
 * decks need at least 60 cards", and a "Cards 75" next to that sentence would be two numbers for
 * one question.
 *
 * The 1/4 on Counterspell is what a built deck elsewhere costs this one. Two foil Counterspells
 * are in the binder; the built Kenrith deck has claimed one, so this deck can reach exactly one
 * of the four it wants — measured, and the number moves to 2 the moment that deck stops being
 * built.
 */
export const Modern60: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The count rides in the region's accessible name, because a reader arriving here — from a
    // move's focus hand-off, or from a screen reader's region list — is asking "which zone, and
    // how big".
    await expect(await canvas.findByRole("region", { name: "Main deck, 60 cards" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Sideboard, 15 cards" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Companion, 0 cards" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: /^Commander,/ })).toBeNull();

    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    // Not the 75 copies the price and the shortfall are counted over.
    await expect(canvas.getByText("+ 15 sideboard")).toBeInTheDocument();

    // The shortage mark, whose visible half is "1/4" and whose spoken half is a sentence. It is
    // drawn only where it says something — a fully covered row prints nothing at all, so sixty
    // green ticks never happen.
    await expect(canvas.getByText("You own 1 of 4")).toBeInTheDocument();
  },
};

/**
 * The command zone, the companion, and the one issue this deck exists to produce.
 *
 * No sideboard column: every singleton commander format has `sideboardMax: 0`, and the zone is
 * empty, so it is not drawn — which is the seeded rules driving the chrome rather than a format
 * key compared anywhere in the view.
 *
 * **A clean Commander companion is not buildable from this corpus, and the fixture stages that
 * dead end deliberately.** Lurrus of the Dream-Den asks that every permanent card in the starting
 * deck have mana value 2 or less, `companions.ts`' `STARTING_DECK` is `["main", "commander"]`
 * (CR 903.5a puts the commander in the pile it judges), Lurrus is `WB`, and the corpus's only
 * legends whose identity covers both W and B are Kenrith at mana value 5 and Tymna at 3. So the
 * one error names the commander, and it is the deck's whole issue list — measured 2026-08-10 by
 * running the real `validateDeck` over `deck_get({ id: 2 })`. There is no `WithCompanion` story
 * separate from this one because there is no second companion deck to build.
 */
export const CommanderDeck: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Commander, 1 card" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Companion, 1 card" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Main deck, 99 cards" })).toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: /^Sideboard,/ })).toBeNull();

    // One issue, and the chip counts rather than names: the sentence is behind it.
    const chip = canvas.getByRole("button", { name: "1 issue" });
    await userEvent.click(chip);
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toHaveTextContent(
      "Lurrus of the Dream-Den needs every permanent card in your deck to have mana value 2 " +
        "or less; Kenrith, the Returned King does not.",
    );
  },
};

/**
 * The scratchpad, and the rule that makes it one.
 *
 * `maybe` is not a column — it sits under the deck, shut by default, because cards go here to be
 * *thought about*. It counts toward nothing at all: not the size figure, not the copy limits, not
 * the legality check, and the allocator does not claim copies for it. The seeded row is Ancient
 * Tomb, which is `modern: not_legal` **on purpose** (`seeds.ts:359-362`), so a chip still reading
 * "No issues · Modern" over an illegal card in the pile is the demonstration.
 *
 * Its `0` owned is by design and not a shortage, which is why the row draws no shortage mark at
 * all: `ZoneColumn.tsx:437` excludes `maybe` from that comparison rather than letting the
 * allocator's silence read as a card the reader needs to buy.
 */
export const MaybePile: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = await canvas.findByRole("button", { name: "Maybe 1" });
    // One row, two copies — the disclosure counts rows and the column counts cards.
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(disclosure);

    const pile = canvas.getByRole("region", { name: "Maybe, 2 cards" });
    await expect(within(pile).getByRole("button", { name: "Ancient Tomb" })).toBeInTheDocument();
    // No shortage mark, on a row the collection covers none of — the one place in the editor
    // where owning nothing is not worth saying.
    await expect(within(pile).queryByText(/You own /)).toBeNull();

    // And nothing it holds reaches the size figure or the rules: two more copies are on screen
    // and the deck is still sixty cards, still legal, still short of the same 65.
    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Main deck, 60 cards" })).toBeInTheDocument();
    await expect(canvas.getByText("65 of 75 missing")).toBeInTheDocument();
  },
};

/**
 * Stepping a deck row to zero — **and the row goes.**
 *
 * The exact opposite of the collection's asymmetry, and the pair is easy to get backwards.
 * `collection_set_quantity(0)` keeps the row with its condition, its purchase price, its tags and
 * its acquisition story; `deck_set_card_quantity(0)` **deletes** (`db.ts:2118-2122`, mirroring the
 * table's `CHECK (quantity > 0)`), because a zone slot holds an intention and nothing else.
 *
 * **There is no remove control here to look for.** The collection grows one on a row it has
 * emptied; a deck row simply leaves, and the two ways to make it leave — the stepper's zero and a
 * drop on the remove tray — are the same `setQuantity(…, 0)` write. So the claim this story makes
 * is an absence, which is exactly what a `play` is for.
 *
 * Deck 3 because it is the one seeded deck with a row at a single copy: one press empties the
 * slot. It is also the archived deck, which the editor opens without comment — archiving is a
 * shelf, not a lock.
 */
export const ZeroRemovesTheRow: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Copies of Black Lotus in Main deck";
    const box = await canvas.findByRole("spinbutton", { name: label });
    await expect(box).toHaveValue(1);

    await userEvent.click(canvas.getByRole("button", { name: `Decrease ${label}` }));

    await waitFor(async () => {
      await expect(canvas.queryByRole("spinbutton", { name: label })).toBeNull();
    });
    // Gone, not emptied: no row, and nothing offering to remove one.
    await expect(canvas.queryByText("Black Lotus")).toBeNull();
    await expect(canvas.queryByRole("button", { name: /Remove/ })).toBeNull();
    // The zone's own count moved with it — 22 cards less the one copy.
    await expect(canvas.getByRole("region", { name: "Main deck, 21 cards" })).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * The one switch in this view with a consequence outside the deck it is on.
 *
 * A built deck has its copies *reserved*: `allocate_deck` runs in the same transaction, and every
 * other deck's `ownedQuantity` is computed from what is left. That is why the chip carries its
 * hint into its accessible name — "Built, Reserves your copies for this deck" — rather than
 * leaving the consequence to a tooltip.
 *
 * **A build never moves the built deck's own numbers, and that is the point rather than a gap.**
 * Deck 2 reads 6 of 101 owned whether it is built or not (measured 2026-08-10, both ways); what
 * moves is deck 1, four rows of it — Counterspell 1→2, Ragavan 0→1, Tarmogoyf 2→3, Urza's Saga
 * 3→4, its shortfall 65→61 — and there is no surface in the app that shows two decks at once, so
 * that half is measured here and read in {@link Modern60}'s badge.
 */
export const BuiltToggle: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole("button", {
      name: "Built, Reserves your copies for this deck",
    });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByText("95 of 101 missing")).toBeInTheDocument();

    await userEvent.click(chip);

    await waitFor(async () => {
      await expect(chip).toHaveAttribute("aria-pressed", "false");
    });
    // Its own claims are unchanged: releasing a reservation gives copies back to *other* decks.
    await expect(canvas.getByText("95 of 101 missing")).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * A deck a reader has just made: every zone empty, and the rules already talking.
 *
 * The only editor state no seed can hold, staged through the same `deck_create` the gallery's
 * form sends. Every column says "Nothing here yet." rather than showing an empty box, the charts
 * are not drawn at all (`DeckStats` gates them on `copies > 0` — four empty axes say nothing), and
 * the format check is a full sentence from the first card onwards: advisory, never blocking,
 * because an illegal deck is a deck somebody is still building.
 */
export const EmptyDeck: Story = {
  args: { deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Main deck, 0 cards" })).toBeVisible();
    await expect(canvas.getAllByText("Nothing here yet.").length).toBeGreaterThan(0);

    const chip = canvas.getByRole("button", { name: "1 issue" });
    await userEvent.click(chip);
    await expect(canvas.getByRole("dialog", { name: "Modern check" })).toHaveTextContent(
      "Modern decks need at least 60 cards; you have 0.",
    );
    // Nothing to chart, so no chart — and no "All 0 owned" either, which would be a cheerful
    // sentence about a deck that does not exist yet.
    await expect(canvas.queryByText("Mana curve")).toBeNull();
    await expect(canvas.queryByText(/^All 0 owned/)).toBeNull();
  },
};

/**
 * A row a sync left a question against — **listed, counted, and asking to be looked at.**
 *
 * The `needsReview` seed puts one orphan in each of the three user card tables; the deck one goes
 * into deck 1's main and takes it to 61 (`seeds.ts:493-495`), which is legal because Modern's
 * `deckMax` is null. Its sentence is `reconcile::merge`'s, copied verbatim: the printing was
 * merged into an id the card database does not have yet.
 *
 * The row keeps its name, set, collector number and language because `deck_cards` denormalises
 * all four at write time for exactly this day — there is no card left to re-read. It is still
 * counted by the size rule, still priced (at nothing), still steppable and still movable; what it
 * cannot do is become the deck's cover, and it draws no art rather than an empty frame.
 *
 * The validation panel says the same thing in the engine's words, as a **warning** and not an
 * error: the row is not illegal, it is unjudgeable.
 */
export const NeedsReview: Story = {
  args: { deckId: 1 },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Counted: 60 becomes 61, and the region's name is where that is said out loud.
    await expect(await canvas.findByRole("region", { name: "Main deck, 61 cards" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Psychic Frog" })).toBeInTheDocument();
    await expect(
      canvas.getByText(/Scryfall merged this printing into 0c62f9b1-4a7d-4e83-8f15-2b90d4c6e737/),
    ).toBeInTheDocument();
    // A sentence, not a flag — announced as one, under a label that says which kind it is.
    await expect(canvas.getByText("Needs review:")).toBeInTheDocument();
  },
};

/**
 * A write the database refused, said where the writing happened.
 *
 * `db.ts:1479`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the columns underneath are untouched
 * and still counting sixty.
 *
 * The banner speaks for the **latest** of the three writes the deck's own controls make
 * (set-quantity, move, update), not for whichever is still holding an error — a refused move used
 * to leave its sentence up while a rename succeeded behind it. The docked panel's add is
 * deliberately not among them: it reports beside the button that was pressed.
 *
 * The stepper is optimistic on the row's own number, so this exercises the rollback as well —
 * `onError` restores the snapshot `onMutate` took, and the box goes back to 4. That matters more
 * here than in the collection, because **zero removes**: a refused removal that stayed removed
 * would be a card silently gone.
 */
export const Busy: Story = {
  args: { deckId: 1 },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Copies of Lightning Bolt in Main deck";
    await userEvent.click(await canvas.findByRole("button", { name: `Decrease ${label}` }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change this deck — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(4);
    });
    // The deck is still here and still sixty: a refusal is news, not a broken editor.
    await expect(canvas.getByRole("region", { name: "Main deck, 60 cards" })).toBeInTheDocument();
  },
};

/**
 * The deck was deleted from somewhere else while this editor was open.
 *
 * The `gone` fault makes `deck_get` answer `null` (`db.ts:1416`), which is a **successful read of
 * nothing** and not an error — the distinction the editor draws in `DeckEditor.tsx:212`. A failed
 * read says "Could not open this deck" and keeps the deck; this says the deck is not there, and
 * sends the reader back to the gallery, because there is nothing on this screen to fix.
 *
 * Everything that would have drawn the deck is behind `row`, so there is no header, no format
 * select, no stats block and no columns — a paragraph is the whole view. That is also why any
 * open layer is dropped during render (`DeckEditor.tsx:361`): an `"inner"` Escape rung that
 * nothing draws would eat the first press of whatever the reader does next.
 */
export const Gone: Story = {
  args: { deckId: 1 },
  parameters: { fake: { fault: "gone" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "This deck is not there any more. It may have been deleted from the gallery — go back " +
          "and pick another one.",
      ),
    ).toBeInTheDocument();
    // Not an alert: nothing failed, and a red band would make a deleted deck read as a fault.
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.queryByLabelText("Deck name")).toBeNull();
    await expect(canvas.queryByRole("region", { name: /^Main deck/ })).toBeNull();
    // The way out is still here.
    await expect(canvas.getByRole("button", { name: "Back to decks" })).toBeEnabled();
  },
};

/**
 * Two printings of one card in one zone, folded into one row — and the sentence that says so.
 *
 * **`deck_swap_printing` folds on `(deck, card, zone)`.** A zone holds a printing at most once, so
 * swapping onto one the zone already has is not an error and not two rows: the quantities sum,
 * the answer carries `folded: true` with the landed total, and the pane announces it. Without the
 * sentence a line would simply disappear out of the deck list, which reads like a bug.
 *
 * **This is the one editor story that renders the card pane, because the swap has no control in
 * the editor at all.** "Use this printing" is drawn on the pane's printings rows and only for a
 * card opened *as a deck row* — `openCardFromDeck` is the sole writer of `paneDeckContext`, so
 * the offer exists exactly where a slot exists to rewrite. The pane is docked beside the editor
 * here as `App.tsx:75-88` docks it.
 *
 * Sol Ring is the only fold the corpus can produce: it is the one card with two printings in the
 * fixture that a seeded deck already plays (deck 2's main holds `c21 263`; `sld 913` is the
 * other, and the wall offers newest-printing-first, so it is the first of the two tiles). The
 * play adds `sld 913` from the docked panel — a Commander deck's singleton rule now broken, which
 * is beside the point — clicks that row, and swaps it onto the printing already in the zone.
 */
export const SwapFolds: Story = {
  args: { deckId: 2, pane: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The wall is searched rather than scrolled: it is virtualised, one column wide under
    // `src/stories.test.tsx`'s layout stub, and Sol Ring is far enough down an alphabetical list
    // of 36 cards that its tile is not mounted. The searchbox is addressed by role because the
    // panel's disclosure carries the same name, "Search cards", as this field's `sr-only` label.
    await userEvent.type(
      await canvas.findByRole("searchbox", { name: "Search cards" }),
      "Sol Ring",
    );

    // **All printings, because the panel collapses like the search page does.** Collapsed, Sol
    // Ring is one tile — its newest printing — which is the right default for building a deck
    // and the wrong one for a story about choosing between two printings. The toggle is on the
    // panel's own filter bar precisely so this is one press away.
    await userEvent.click(canvas.getByRole("button", { name: "All printings" }));

    // Two tiles, newest printing first — `sld 913` (2025-12-01) ahead of `c21 263` (2021-04-23),
    // which is `search::ORDER_NAME`: the card, then its newest printing.
    const add = await canvas.findAllByRole(
      "button",
      { name: "Add Sol Ring to Main deck" },
      { timeout: 4000 },
    );
    await expect(add).toHaveLength(2);
    await userEvent.click(add[0]);

    // Two rows now, and the deck says so before anything is folded.
    await waitFor(async () => {
      await expect(
        canvas.getAllByRole("spinbutton", { name: "Copies of Sol Ring in Main deck" }),
      ).toHaveLength(2);
    });

    // The added row, addressed by the slot it draws rather than by its name: both rows are called
    // Sol Ring, and the slot attribute is the only thing that tells them apart.
    const row = canvasElement.querySelector<HTMLButtonElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot("main", SOL_RING_SLD)}"]`,
    );
    await expect(row).not.toBeNull();
    await userEvent.click(row!);

    // The pane, opened as a deck row — which is what puts the offer on the other printing.
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    const use = await within(pane).findByRole("button", {
      name: "Use this printing (C21 263) in Main deck",
    });
    await userEvent.click(use);

    // One row of two, and the pane saying which. The number is the server's arithmetic, never a
    // guess: `useDeck.swapPrinting` writes no optimistic patch precisely because the fold is the
    // one number only the backend can compute.
    await waitFor(async () => {
      await expect(
        canvas.getByRole("spinbutton", { name: "Copies of Sol Ring in Main deck" }),
      ).toHaveValue(2);
    });
    await expect(
      await canvas.findByText("Folded into one row of 2 in Main deck."),
    ).toBeInTheDocument();
  },
};
