import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { DeckEditor } from "./DeckEditor";

/**
 * One deck, open — and, for the one story that needs it, the card pane docked beside it.
 *
 * **`deckId` is a prop of `DeckEditor`, not something it reads out of the store**, so this file
 * writes no `openDeckId`: `App.tsx` reads that id and hands it over, and setting it here would
 * stage a fact nothing on screen consumes. The store *is* what carries the pane's deck context,
 * and that is written by clicking a card rather than by a decorator (`store.ts`'s
 * `openCardFromDeck` is the only writer).
 *
 * `deckId: null` means **make one first**, through the same `deck_create` the gallery's New deck
 * form sends — the only way to reach an empty deck, since no seed has one. A `useQuery` rather
 * than an effect with a `setState`: it runs once, it is cached in the story's own client, and
 * `staleTime: Infinity` is what keeps a window refocus in the Storybook browser from creating a
 * second deck.
 *
 * The pane is a **sibling** of the editor here exactly as it is in `App.tsx`, keyed on the card
 * id for the same reason: a swap re-keys it onto the printing the deck now holds, and the
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
  // the last deck's view, grouping, filter and add target — which is what `App.tsx` does with
  // the same key, for the same reason.
  render: (args) => <Editor key={`${args.deckId}:${args.pane}`} {...args} />,
  decorators: [
    // The editor is `h-full`, so it needs a parent with a height or its views have none.
    // 1032px is exactly the content column at the 1280×800 window `tauri.conf.json` opens: 1280
    // less the sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px). 720px of
    // height is chosen rather than derived — the ribbon above it is not a fixed number of
    // pixels.
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
          "**This component is a header, a toolbar and a frame.** It decides which variant is " +
          "read, how the cards are grouped, sorted and filtered, which of the four views draws " +
          "them and which of five layers is open — and it draws no card and no heading itself. " +
          "`grouping.ts` says what the groups are and `views/` draw them, which is what stops " +
          "four surfaces answering “how many cards are in the Ramp column” four ways.\n\n" +
          "**The groups are the deck's own categories** (schema v8), in `sortOrder`, empty and " +
          "switched-off ones included — never a fixed set of zones, and never filtered by the " +
          "format. A category is a row the user names, orders and switches on or off, so hiding " +
          "one would hide a pile they built; the format still *judges* the deck through the " +
          "check chip and no longer decides what is drawn.\n\n" +
          "**Five layers, one piece of state.** The format check, the categories drawer, the " +
          "history drawer, the theory difference dialog and the deck settings dialog each " +
          'register the `"inner"` Escape rung, and `useDismissOnEscape` orders exactly two ' +
          "rungs — so two of them open at once would both close on one press. A union rather " +
          "than five booleans is what makes “never two” structural; {@link NeverTwoLayers} is " +
          "that, pressed.\n\n" +
          "**An inactive category counts toward nothing at all** — not size, not copies, not " +
          "legality — and the allocator never claims a copy for one, so every card in it reads " +
          "`0` owned **by design** rather than for want of copies. That is `isActive` and never " +
          "the word `maybe`: the Maybeboard is one seeded row that starts switched off, and a " +
          "pile of the user's own that they switch off behaves identically. {@link MaybePile} " +
          "is the proof, on a card that is `modern: not_legal` while the chip beside it still " +
          "reads no issues.\n\n" +
          "**Owned is an allocation, never a decrement.** It is rebuilt on a card write, the " +
          "Built toggle, or “Send missing to wishlist” — those three and nothing else — and a " +
          "**built** deck's claims come off what every other deck can see. Measured 2026-08-10 " +
          "by flipping deck 2's `isBuilt` off and re-reading deck 1: Counterspell 1→2, Ragavan " +
          "0→1, Tarmogoyf 2→3, Urza's Saga 3→4, and the deck's shortfall 65→61 of 75. " +
          "{@link Modern60} reads one of those marks and {@link BuiltToggle} presses the " +
          "switch.\n\n" +
          "**Every card carries the same four affordances in every view, from one module.** A " +
          "stepper whose zero *removes* the card, a move control, a `draggable()` registration " +
          "and the slot attribute the card pane finds its way home by all come from " +
          "`cardControl.tsx` — four copies would be four chances for one surface to quietly " +
          "stop offering something, and the reader would find it by switching view and losing " +
          "the ability to remove a card. What each view decides is *placement*: the table " +
          "spends them as a column, the other three draw them over the card, revealed by the " +
          "same hover and focus that lift a stacked card.\n\n" +
          "**The move control is a native `<select>`, deliberately.** The row menu it replaces " +
          'was an anchored popup, which made it a sixth `"inner"` peer in the Escape union ' +
          "with a z-index, a focus hand-back and a click-away boundary to get right. A select " +
          "is none of those: the browser draws it in its own layer, and it is reachable by " +
          "keyboard, pointer and voice without this app writing a line of it.\n\n" +
          "**The stepper sends an absolute quantity and never a delta**, and the reason is in " +
          "`useDeck.ts`: `deck_add_card` looks the printing up in `cards` and therefore " +
          "*refuses an orphaned card*, while `deck_set_card_quantity` addresses the slot that " +
          "is already there. The one card whose printing has left the database is exactly the " +
          "one a reader most needs to step down and out, so a `+1`/`−1` stepper would be " +
          "broken on precisely the cards that most need fixing. {@link ZeroRemovesTheCard} is " +
          "that, pressed.\n\n" +
          "**Drag-and-drop has no story on this page, and that is deliberate.** Every group is " +
          "a drop target and every card is a drag source, but Storybook runs in an " +
          "ordinary browser with no WRY OLE drop target — while the shipped window depends on " +
          '`"dragDropEnabled": false` in `tauri.conf.json`, which is embedded at compile time. ' +
          "**A green drag here would prove nothing about the real app**; that is the live CDP " +
          "pass's to prove, and `Chrome/AppShell` already exercises the payload boundary.\n\n" +
          "Driven end to end by `.storybook/fake/`. The seeded decks, measured 2026-08-11 " +
          'over `readHandlers(seed("starter")).deck_get`: **deck 1 `Modern Goodstuff`** is 18 ' +
          "rows — 60 main, 15 sideboard, 2 on the Maybeboard — and validates **clean**; " +
          "**deck 2 `Kenrith Two-Drops`** is 99 main + 1 commander + 1 companion and produces " +
          "**exactly one** issue; **deck 3 `Old School 93/94`** is 4 rows holding 22 cards. " +
          "Those three came through the v8 migration, so their five groups read Commander, " +
          "Main deck, Sideboard, Companion, Maybeboard — a deck made *today* starts with only " +
          "the four predefined ones ({@link EmptyDeck}) and grows the rest by name. **Deck 4 " +
          "`Rhystic Testbed`** is that second shape filled in: three piles the reader named, " +
          "one of them switched off, two game changers, a tagged card, a copy limit broken on " +
          "purpose and a theory list that differs from the deck. The categories, tags, history " +
          "and theory commands the four overlays read are all the fake's now, so those " +
          "surfaces are driven rather than degraded — see `Decks/CategoriesPanel`, " +
          "`Decks/AuditDrawer` and `Decks/TheoryDiffDialog` for what each of them draws.",
      },
    },
  },
} satisfies Meta<typeof Editor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Sixty Modern-legal cards, a full sideboard, and nothing wrong with any of it.
 *
 * **Five groups, because the deck has five categories** — and Modern's rules have nothing to say
 * about which of them are drawn. The editor used to filter the four fixed zones by the format's
 * seeded spec (no commander column unless `requiresCommander`, no sideboard unless
 * `sideboardMax`); schema v8 makes a category a row the *user* named, ordered and switched on or
 * off, so hiding one would hide a pile they built. This deck is Modern and its Commander group
 * is drawn, empty, saying "Nothing here yet."
 *
 * The order is the v8 migration's own — Commander, Main deck, Sideboard, Companion, Maybeboard
 * — because a *seeded* deck comes out of that migration rather than out of `deck_create`.
 *
 * The stats aside's headline figure is 60 with "+ 15 sideboard" under it, and that split is the
 * whole reason `DeckStats` imports `SIZE_KINDS` from the validation engine: the chip in the
 * header says "Modern decks need at least 60 cards", and a "Cards 75" next to that sentence
 * would be two numbers for one question.
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
    // The heading is the group's *name* and nothing else — the count and the summed price are
    // text beside it, in the data face, drawn the same way by all four views.
    await expect(await canvas.findByRole("region", { name: "Main deck" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Sideboard" })).toBeVisible();
    // Modern requires no commander and this pile is empty, and the group is here all the same.
    await expect(canvas.getByRole("region", { name: "Commander" })).toBeVisible();
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("60 cards"),
    ).toBeInTheDocument();

    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    // Not the 75 copies the price and the shortfall are counted over.
    await expect(canvas.getByText("+ 15 sideboard")).toBeInTheDocument();

    // The shortage, spoken rather than only marked: every mark on a stacked card is
    // `aria-hidden`, so the button's own name is the whole of what a keyboard reader gets.
    await expect(
      canvas.getByRole("button", { name: /^Counterspell.*you own 1 of 4/ }),
    ).toBeInTheDocument();
  },
};

/**
 * The command zone, the companion, and the one issue this deck exists to produce.
 *
 * (The command *zone* is the rules' word; the group drawing it is a category named "Commander",
 * of kind `commander`, which is why its heading carries a `RULE` marker.)
 *
 * The Sideboard group is drawn even though every singleton commander format has
 * `sideboardMax: 0`, and that is the point of the v8 model: the format judges the deck (the chip
 * below still counts its one issue) and no longer decides which piles exist.
 *
 * **A clean Commander companion is not buildable from this corpus, and the fixture stages that
 * dead end deliberately.** Lurrus of the Dream-Den asks that every permanent card in the starting
 * deck have mana value 2 or less, `companions.ts`' `STARTING_DECK` is `["main", "commander"]`
 * (CR 903.5a puts the commander in the pile it judges), Lurrus is `WB`, and the corpus's only
 * legends whose identity covers both W and B are Kenrith at mana value 5 and Tymna at 3. So the
 * one error names the commander, and it is the deck's whole issue list — measured 2026-08-10 by
 * running the real `validateDeck` over `deck_get({ id: 2 })`.
 */
export const CommanderDeck: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const commander = await canvas.findByRole("region", { name: "Commander" });
    await expect(within(commander).getByText("1 card")).toBeInTheDocument();
    // `RULE` means "the ruleset reads this pile by name", which is why it is on the commander
    // and the sideboard and never on the Maybeboard.
    await expect(within(commander).getByText("RULE")).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Companion" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Main deck" })).toBeInTheDocument();

    // One issue, and the chip counts rather than names: the sentence is behind it.
    await userEvent.click(canvas.getByRole("button", { name: "1 issue" }));
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toHaveTextContent(
      "Lurrus of the Dream-Den needs every permanent card in your deck to have mana value 2 " +
        "or less; Kenrith, the Returned King does not.",
    );
  },
};

/**
 * One deck, four ways of looking at it — and the same headings in every one.
 *
 * The switch is the toolbar's, the groups are `grouping.ts`'s, and each view decides only how a
 * card is drawn: a stack of card faces, a `VirtualTable` row, a 22px line, a 150px tile. That is
 * what makes this a switch rather than four screens — the Sort and Group by beside it keep
 * meaning the same thing whichever is pressed, and the table's own headers deliberately do not
 * sort, because one list with two orders is a list nobody can read.
 */
export const FourViews: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const press = (label: string) => userEvent.click(canvas.getByRole("button", { name: label }));
    await canvas.findByRole("region", { name: "Main deck" });

    await press("Table");
    await expect(await canvas.findByRole("table", { name: "This deck" })).toBeInTheDocument();

    await press("Text");
    await waitFor(async () => await expect(canvas.queryByRole("table")).toBeNull());
    await expect(canvas.getByRole("region", { name: "Main deck" })).toBeVisible();

    await press("Grid");
    await expect(canvas.getByRole("region", { name: "Main deck" })).toBeVisible();

    await press("Stacks");
    await expect(canvas.getByRole("list", { name: "Main deck" })).toBeInTheDocument();
  },
};

/**
 * The toolbar's two orders, which are two different questions about one list.
 *
 * **Group by** decides the headings — the deck's own piles, the mana curve's buckets, or the
 * card types — and **Sort** decides the order inside each heading. They are separate because a
 * reader grouping by category still wants the cheap spells first, and a reader grouping by mana
 * value still wants the list alphabetical inside a bucket.
 *
 * Grouping by anything but Categories drops the *inactive* piles out of the buckets and appends
 * them, unchanged, at the end — an inactive card must never be counted into a curve the reader
 * is reading, and a pile that vanished when the grouping changed would be ten cards gone with no
 * way to get them back.
 *
 * **A third control appears and disappears with the first.** `Split X` gives the `{X}` spells a
 * heading of their own, so it is drawn only under Mana value — there is nothing for it to say
 * about a deck grouped by category or by type, and a control that persists across a grouping it
 * has no effect on is one whose scope the reader has to remember. Unlike the two selects beside
 * it, its state is **the deck's** (`decks.separate_x_group`, schema v12) rather than this
 * session's: how you are looking at a deck right now is thrown away with the editor, and whether
 * a particular deck is worth reading with its X spells apart is an answer about that deck. What
 * it does to the curve, and the one number it deliberately leaves alone, is `Decks/DeckStats`'.
 */
export const GroupAndSort: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Main deck" });
    const splitX = () => canvas.queryByRole("button", { name: /^Split X/ });
    await expect(splitX()).toBeNull();

    await userEvent.selectOptions(canvas.getByLabelText("Group by"), "manaValue");
    await expect(await canvas.findByRole("region", { name: "Mana value 1" })).toBeVisible();
    // The switched-off pile is still drawn, as itself, after the buckets.
    await expect(canvas.getByRole("region", { name: "Maybeboard" })).toBeVisible();
    // The whole sentence is the chip's accessible name as well as its tooltip: "Split X" alone
    // names a thing rather than an action, and the name has to stand up read with no select
    // beside it. It begins with the visible label all the same (WCAG 2.5.3).
    const chip = canvas.getByRole("button", { name: /^Split X/ });
    await expect(chip).toHaveAccessibleName(
      "Split X — give cards with X in their cost a group of their own, instead of counting X " +
        "as zero",
    );
    // A pressed-state control and never the `disabled` attribute, which would take it out of the
    // tab order. *Which* way it is set is the deck's own column and therefore the seed's to say,
    // so this asserts that the state is there to be read rather than what it currently reads.
    await expect(chip).toHaveAttribute("aria-pressed");
    await expect(chip).toBeEnabled();

    await userEvent.selectOptions(canvas.getByLabelText("Group by"), "type");
    await expect(await canvas.findByRole("region", { name: "Creature" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Mana value 1" })).toBeNull();
    // Gone with the grouping it qualifies.
    await expect(splitX()).toBeNull();

    await userEvent.selectOptions(canvas.getByLabelText("Sort"), "price");
    await expect(canvas.getByLabelText("Sort")).toHaveValue("price");
  },
};

/**
 * The switched-off pile, and the rule that makes it one.
 *
 * **`isActive` is the whole of "counts toward nothing", and it is not the Maybeboard's alone.**
 * The old editor drew `maybe` as a collapsed drawer under the deck because it was the one zone
 * the arithmetic skipped; schema v8 moves that fact onto `deck_categories.is_active`, which any
 * category can carry — so the Maybeboard is one seeded row that happens to start switched off,
 * it is a group like the rest, and the drawer is gone. A pile the reader switches off behaves
 * identically; a Maybeboard they switch on counts like anything else.
 *
 * The seeded card is Ancient Tomb, which is `modern: not_legal` **on purpose**, so a chip still
 * reading "No issues · Modern" over an illegal card in the pile is the demonstration: an
 * inactive category reaches neither the size figure, nor the copy limits, nor the legality
 * check, and the allocator claims no copies for it.
 *
 * Its `0` owned is by design and not a shortage, which is why the card draws no shortage mark at
 * all and its accessible name says nothing about owning any — the views read the category's
 * `isActive` rather than the word `maybe`.
 */
export const MaybePile: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // No disclosure to press: the pile is a group, drawn from the first paint in its own
    // `sortOrder` position (last, for a deck that came through the v8 migration).
    const pile = await canvas.findByRole("region", { name: "Maybeboard" });
    await expect(within(pile).getByText("INACTIVE")).toBeInTheDocument();
    const tomb = within(pile).getByRole("button", { name: /^Ancient Tomb/ });
    await expect(tomb).toBeInTheDocument();
    // No shortage, and not in the name either — the one place in the editor where owning
    // nothing is not worth saying.
    await expect(tomb.getAttribute("aria-label")).not.toMatch(/you own/i);

    // And nothing it holds reaches the size figure or the rules: two copies are on screen and
    // the deck is still sixty cards, still legal, still short of the same 65.
    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("60 cards"),
    ).toBeInTheDocument();
    await expect(canvas.getByText("65 of 75 missing")).toBeInTheDocument();
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
 * moves is deck 1, four cards of it — Counterspell 1→2, Ragavan 0→1, Tarmogoyf 2→3, Urza's Saga
 * 3→4, its shortfall 65→61 — and there is no surface in the app that shows two decks at once, so
 * that half is measured here and read in {@link Modern60}'s card name.
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
 * Stepping a deck card to zero — **and the card goes.**
 *
 * The exact opposite of the collection's asymmetry, and the pair is easy to get backwards.
 * `collection_set_quantity(0)` keeps the row with its condition, its purchase price, its tags
 * and its acquisition story; `deck_set_card_quantity(0)` **deletes** (mirroring the table's
 * `CHECK (quantity > 0)`), because a category slot holds an intention and nothing else.
 *
 * **There is no remove control here to look for**, and that absence is the claim. A deck card
 * simply leaves, and the two ways to make it leave — the stepper's zero and a drop on the
 * remove tray — are the same `setQuantity(…, 0)` write.
 *
 * And the caret does not fall on `<body>` when the control it was on unmounts: it goes to the
 * pile the card left, which is where the reader is looking and which announces its own name.
 *
 * Deck 3 because it is the one seeded deck with a card at a single copy: one press empties the
 * slot. It is also the archived deck, which the editor opens without comment — archiving is a
 * shelf, not a lock.
 */
export const ZeroRemovesTheCard: Story = {
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
    // Gone, not emptied: no card, and nothing offering to remove one.
    await expect(canvas.queryByText("Black Lotus")).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull();
    // The pile's own count moved with it — 22 cards less the one copy.
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("21 cards"),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).toBeNull();
    // The caret went to the pile rather than to `<body>`.
    await expect(canvas.getByRole("region", { name: "Main deck" })).toHaveFocus();
  },
};

/**
 * Moving a card between piles, from the card itself.
 *
 * A native `<select>` rather than the anchored menu it replaces — see this page's own note. The
 * card's current pile is never among its options: `deck_move_card` from a category to itself
 * would touch the deck, reallocate and bump `updated_at` to leave the list exactly as it was.
 *
 * The caret follows the card, which is the same hand-off the stepper's zero makes and the same
 * one a drop makes: the control the reader was using has left the pile it was in, so leaving
 * focus where it was would drop it on `<body>`.
 */
export const MoveBetweenPiles: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByLabelText("Move Black Lotus out of Main deck");
    await expect(within(select).queryByRole("option", { name: "Main deck" })).toBeNull();

    await userEvent.selectOptions(
      select,
      within(select).getByRole("option", { name: "Sideboard" }),
    );

    await waitFor(async () => {
      await expect(
        within(canvas.getByRole("region", { name: "Sideboard" })).getByRole("button", {
          name: /^Black Lotus/,
        }),
      ).toBeInTheDocument();
    });
    await expect(canvas.getByRole("region", { name: "Sideboard" })).toHaveFocus();
  },
};

/**
 * The deck's own filter and the Stats toggle — the two toolbar controls that change what is on
 * screen rather than what is in the deck.
 *
 * The filter narrows the cards **before** they are grouped, so every heading's count is a count
 * of what is under it. A heading reading 60 over four visible cards would be lying about the
 * only thing it is for.
 *
 * The stats block is the reader's to put away, and putting it away gives its width back: it is
 * counted against the same floor the docked search panel is measured by (`DECK_FLOOR`), so the
 * three things on the desk yield in order rather than all squeezing at once.
 */
export const FilterAndStats: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Main deck" });
    await expect(canvas.getByRole("region", { name: "Deck stats" })).toBeVisible();

    await userEvent.type(canvas.getByLabelText("Filter this deck"), "counterspell");

    await waitFor(async () => {
      await expect(
        within(canvas.getByRole("region", { name: "Main deck" })).getByText("4 cards"),
      ).toBeInTheDocument();
    });

    await userEvent.click(canvas.getByRole("button", { name: "Stats" }));
    await expect(canvas.queryByRole("region", { name: "Deck stats" })).toBeNull();
  },
};

/**
 * Five dismissible surfaces, one piece of state — and the reason it has to be one.
 *
 * `useDismissOnEscape` orders exactly two rungs: one capture-phase `"inner"` layer and one
 * bubble-phase `"outer"` one. Every layer this editor owns registers the `"inner"` one, so two
 * of them open at once are not ordered at all — both would consume a single press, and two focus
 * hand-backs would race for the caret. A union cannot express that state; five booleans can, and
 * the failure is invisible to any test that opens one layer at a time.
 *
 * What this story asserts is the *arrangement* rather than either layer's contents: pressing the
 * second trigger leaves exactly one dialog on screen, and it is the second one. The drawer's own
 * contents are `Decks/CategoriesPanel`'s.
 */
export const NeverTwoLayers: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole("button", { name: "1 issue" });

    await userEvent.click(chip);
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Categories & tags" }));

    await waitFor(async () => {
      await expect(canvas.getAllByRole("dialog")).toHaveLength(1);
    });
    await expect(canvas.getByRole("dialog", { name: "Categories and tags" })).toBeInTheDocument();

    // Escape closes the one that is up and hands the caret back to the control that opened it —
    // the editor is a *view*, so the deck is still on screen afterwards.
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog")).toBeNull();
    });
    await expect(canvas.getByRole("button", { name: "Categories & tags" })).toHaveFocus();
  },
};

/**
 * A deck a reader has just made: every pile empty, and the rules already talking.
 *
 * The only editor state no seed can hold, staged through the same `deck_create` the gallery's
 * form sends. Every group says "Nothing here yet." rather than showing an empty box, the charts
 * are not drawn at all (`DeckStats` gates them on `copies > 0` — four empty axes say nothing),
 * and the format check is a full sentence from the first card onwards: advisory, never blocking,
 * because an illegal deck is a deck somebody is still building.
 *
 * **Four groups, not five, and no "Main deck" among them.** `deck_create` seeds
 * `schema::PREDEFINED_CATEGORIES` — Commander, Sideboard, Companion, Maybeboard — and there is
 * deliberately no `main` row in that list: a deck may own any number of `main` categories and
 * the seed names none, so the pile a plain add goes to is *found or created by name* on the
 * first add rather than born with the deck. That is the difference between a deck made today and
 * one the v8 migration converted, which is why the seeded decks above have five.
 */
export const EmptyDeck: Story = {
  args: { deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Commander" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Main deck" })).toBeNull();
    await expect(canvas.getAllByText("Nothing here yet.").length).toBeGreaterThan(0);

    await userEvent.click(canvas.getByRole("button", { name: "1 issue" }));
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
 * A card a sync left a question against — **listed, counted, and asking to be looked at.**
 *
 * The `needsReview` seed puts one orphan in each of the three user card tables; the deck one
 * goes into deck 1's main and takes it to 61, which is legal because Modern's `deckMax` is null.
 * Its sentence is `reconcile::merge`'s, copied verbatim: the printing was merged into an id the
 * card database does not have yet.
 *
 * The card keeps its name, set, collector number and language because `deck_cards` denormalises
 * all four at write time for exactly this day — there is no card left to re-read. It is still
 * counted by the size rule and still priced (at nothing); what it cannot do is draw art, so the
 * stack's frame says "No card" where the picture goes rather than showing an empty one.
 *
 * The validation panel says the same thing in the engine's words, as a **warning** and not an
 * error: the card is not illegal, it is unjudgeable.
 */
export const NeedsReview: Story = {
  args: { deckId: 1 },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Counted: 60 becomes 61, and the heading beside the group's name is where that is said.
    const main = await canvas.findByRole("region", { name: "Main deck" });
    await expect(within(main).getByText("61 cards")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Psychic Frog/ })).toBeInTheDocument();
    await expect(within(main).getAllByText("No card").length).toBeGreaterThan(0);

    await userEvent.click(canvas.getByRole("button", { name: /^No issues|^\d+ issue/ }));
    await expect(
      await canvas.findByText(
        /Scryfall merged this printing into 0c62f9b1-4a7d-4e83-8f15-2b90d4c6e737/,
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A write the database refused, said where the writing happened.
 *
 * `db.ts`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of every
 * write handler and by no read handler — which is why the deck underneath is untouched and still
 * counting sixty.
 *
 * The banner speaks for the **latest** of the three writes the deck's own controls make
 * (set-quantity, move, update), not for whichever is still holding an error — a refused move used
 * to leave its sentence up while a rename succeeded behind it. The docked panel's add is
 * deliberately not among them: it reports beside the button that was pressed.
 *
 * The Built toggle is the write pressed here because it is the one this rebuild still has a
 * control for; before the four views replaced the category columns it would have been a stepper,
 * which also exercised the optimistic rollback. That rollback is still `useDeck`'s and still
 * tested there — what this story shows is the *banner*, and that the deck survives a refusal.
 */
export const Busy: Story = {
  args: { deckId: 1 },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Main deck" });

    await userEvent.click(canvas.getByRole("button", { name: /^Built/ }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change this deck — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    // The deck is still here and still sixty: a refusal is news, not a broken editor.
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("60 cards"),
    ).toBeInTheDocument();
  },
};

/**
 * The deck was deleted from somewhere else while this editor was open.
 *
 * The `gone` fault makes `deck_get` answer `null`, which is a **successful read of nothing** and
 * not an error — the distinction the editor draws between `gone` and `readFailure`. A failed
 * read says "Could not open this deck" and keeps the deck; this says the deck is not there, and
 * sends the reader back to the gallery, because there is nothing on this screen to fix.
 *
 * Everything that would have drawn the deck is behind `row`, so there is no header, no toolbar,
 * no stats block and no view — a paragraph is the whole thing. That is also why any open layer is
 * dropped during render: an `"inner"` Escape rung that nothing draws would eat the first press of
 * whatever the reader does next.
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
    await expect(canvas.queryByRole("region", { name: "Main deck" })).toBeNull();
    // The way out is still here.
    await expect(canvas.getByRole("button", { name: "Back to decks" })).toBeEnabled();
  },
};

/**
 * Two printings of one card in one category, folded into one row — and the sentence that says so.
 *
 * **`deck_swap_printing` folds on `(deck, variant, category, card)`.** A category holds a
 * printing at most once per list, so swapping onto one it already has is not an error and not two
 * rows: the quantities sum, the answer carries `folded: true` with the landed total, and the pane
 * announces it. Without the sentence a card would simply disappear out of the deck, which reads
 * like a bug.
 *
 * **This is the one editor story that renders the card pane, because the swap has no control in
 * the editor at all.** "Use this printing" is drawn on the pane's printings rows and only for a
 * card opened *as a deck card* — `openCardFromDeck` is the sole writer of `paneDeckContext`, so
 * the offer exists exactly where a slot exists to rewrite. The context carries the **variant**
 * too, since schema v8: a swap addressed to the wrong list either misses or rewrites a row the
 * reader is not looking at.
 *
 * Sol Ring is the only fold the corpus can produce: it is the one card with two printings in the
 * fixture that a seeded deck already plays (deck 2's main category holds `c21 263`; `sld 913` is
 * the other). The play adds `sld 913` from the docked panel — a Commander deck's singleton rule
 * now broken, which is beside the point — clicks it, and swaps it onto the printing already in
 * the category.
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

    // **The add target is chosen, not assumed.** The picker opens on the deck's *first* category
    // — which for a deck the v8 migration converted is its Commander pile, `sortOrder` 0 — and
    // this fold is about the printing sitting in the main deck. Picked by the option's own text,
    // because a category's id is the fake's own row numbering and not something a story writes
    // down.
    const target = await canvas.findByLabelText("Add to");
    await userEvent.selectOptions(
      target,
      within(target).getByRole("option", { name: "Main deck" }),
    );

    // **All printings, because the panel collapses like the search page does.** Collapsed, Sol
    // Ring is one tile — its newest printing — which is the right default for building a deck
    // and the wrong one for a story about choosing between two printings.
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

    // Two cards now, both called Sol Ring, both in the Main deck group.
    const main = () => canvas.getByRole("region", { name: "Main deck" });
    await waitFor(
      async () => {
        await expect(within(main()).getAllByRole("button", { name: /^Sol Ring/ })).toHaveLength(2);
      },
      { timeout: 4000 },
    );

    // The pane, opened as a deck card — which is what puts the offer on the *other* printing.
    // Either of the two rows does: they are two printings of one card in one category, so
    // whichever is opened, the swap offered is onto the one that is not open.
    await userEvent.click(within(main()).getAllByRole("button", { name: /^Sol Ring/ })[0]);
    const pane = await canvas.findByRole("complementary", { name: "Card details" });
    const use = await within(pane).findByRole(
      "button",
      { name: /^Use this printing .* in Main deck$/ },
      { timeout: 4000 },
    );
    await userEvent.click(use);

    // One card of two, and the pane saying which. The number is the server's arithmetic, never a
    // guess: `useDeck.swapPrinting` writes no optimistic patch precisely because the fold is the
    // one number only the backend can compute.
    await waitFor(
      async () => {
        await expect(within(main()).getAllByRole("button", { name: /^Sol Ring/ })).toHaveLength(1);
      },
      { timeout: 4000 },
    );
    await expect(
      await canvas.findByText(/^Folded into one row of 2 in Main deck\.$/),
    ).toBeInTheDocument();
  },
};
