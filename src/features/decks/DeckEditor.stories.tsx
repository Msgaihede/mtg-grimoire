import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
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
 * **`formatKey` matters only on that path, and it is an argument because the format is the one
 * fact deciding an empty heading that does not travel on the pile** (`grouping.ts`'
 * `drawsWhenEmpty` — the other two, its `kind` and who made it, are the pile's own).
 * The same four seeded piles read differently in Modern and in Commander, and the pair of stories
 * that shows it — {@link EmptyDeck} and {@link EmptyCommandZone} — differ in this and in nothing
 * else. It is in the query key too: a deck is made once per key, so two formats have to be two
 * keys or the second story would open the first one's deck.
 *
 * **The pane is the editor's own now** (issue #183, 2026-08-22) and this wrapper no longer draws
 * one. It used to render a `CardDetailPane` as a *sibling*, exactly as `App.tsx` did, keyed on
 * the card id — and both halves of that have moved: the editor draws the pane as an overlay over
 * one of its two columns, and `App` steps aside for it. A copy left here would be a second
 * `complementary` landmark answering to the same name as the real one, which is precisely what
 * `SwapFolds` reaches for.
 */
function Editor({ deckId, formatKey = "modern" }: { deckId: number | null; formatKey?: string }) {
  const created = useQuery({
    queryKey: ["story", "empty-deck", formatKey],
    queryFn: () => ipc.deckCreate({ name: "Untitled", formatKey }),
    enabled: deckId === null,
    staleTime: Infinity,
  });
  const id = deckId ?? created.data?.id ?? null;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="min-w-0 flex-1">{id !== null && <DeckEditor key={id} deckId={id} />}</div>
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
  // the same key, for the same reason. `formatKey` is in the key because on the `deckId: null`
  // path it changes which deck is made, and therefore which headings the editor draws.
  render: (args) => <Editor key={`${args.deckId}:${args.formatKey}`} {...args} />,
  decorators: [
    // The editor is `h-full`, so it needs a parent with a height or its views have none.
    // 1032px is exactly the content column at the app's narrow rung — the 1280-wide window
    // `src-tauri/src/window.rs` opens on a 1080p desk: 1280 less the sidebar's `w-52` (208px)
    // and less `main`'s `p-5` on both sides (40px). 720px of height is chosen rather than
    // derived — the ribbon above it is not a fixed number of pixels.
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
          "them and which of its layers is open — and it draws no card and no heading itself. " +
          "`grouping.ts` says what the groups are and `views/` draw them, which is what stops " +
          "four surfaces answering “how many cards are in the Ramp column” four ways.\n\n" +
          "**The groups are the deck's own categories** (schema v8), in `sortOrder`, " +
          "switched-off ones included — never a fixed set of zones. A category is a row the user " +
          "names, orders and switches on or off, and **no pile of theirs is ever cut out of this " +
          "list**; the only ones that come out are piles the *app* made and nothing is left in, " +
          "which is the next paragraph. The format judges the deck through the check chip, and " +
          "the only thing it decides about the *drawing* is the two conditional zones.\n\n" +
          "**An empty pile draws or not by who made it, and there are three classes.** A pile " +
          "the *reader* made draws for as long as it exists: a column is a *place* as well as a " +
          "heading, their empty `Ramp` is where they mean the next ramp spell to go, and " +
          "**delete is the only way to remove one** — there is no hide flag and `isActive` is " +
          "not one. A pile the *app* made while filing a card (`deck_categories.origin` is " +
          "`auto`, schema v15) **arrives with its first card and goes with its last**: nobody " +
          "asked for it, so an empty one is a heading about a card the deck does not contain. " +
          "The two **conditional zones** answer to the format instead — a command zone draws " +
          "empty only where the format has one (`requiresCommander`), and a companion slot " +
          "draws empty in no format, because a companion is a card you either have or do not. " +
          "{@link AutoPileArrivesWithItsCard} is all three in one deck.\n\n" +
          "**The test is provenance and never the name**, which is the whole reason it is a " +
          "column: “Ramp”, “Draw” and “Removal” are exactly what a person calls a pile they " +
          "made, and `category_for_name` *finds* an existing pile before it makes one — so " +
          "filing a ramp spell into the reader's own `Ramp` leaves it theirs, and it goes on " +
          "drawing when they empty it. **A pile holding cards always draws whatever any of this " +
          "says** — `drawsWhenEmpty` is asked about empty piles only, so nothing here can hide " +
          "cardboard, and a Modern deck whose Commander pile still holds a card draws it. " +
          "Switched-off is a fourth question again: an inactive category holding cards still " +
          "draws, because `isActive` decides whether a pile *counts* and the cards under it " +
          "decide whether it is *drawn*.\n\n" +
          "**A filter decides nothing about which headings exist, and it used to.** " +
          "`EmptyGroupRules.narrowed` made the four fixed zones the only empty piles that " +
          "survived a filter, so that three letters could not answer with twenty headings over " +
          "three cards. That flag is gone: the wall it was aimed at was always *auto* piles, " +
          "and a pile the filter empties **is** empty, so they stay out either way — while the " +
          "reader's own piles go on drawing, filter or no filter, exactly as they do when the " +
          "reader empties one by hand.\n\n" +
          "**Every layer, one piece of state.** The anchored format check and the editor's " +
          'full-window dialogs each register the `"inner"` Escape rung, and two of them open at ' +
          "once is not a state this editor draws — a union rather than a boolean apiece is what " +
          "makes “never two” structural rather than remembered, and {@link NeverTwoLayers} is " +
          "that, pressed. **Count them off the `Layer` union in `DeckEditor.tsx`, never off a " +
          "list or a number on this page**: this paragraph carried both, and both had stopped " +
          "being true by the next thing that landed, with nothing going red — which is exactly " +
          "what a prose-only edit costs.\n\n" +
          "**The shell is `Dialog`** (2026-08-14), and the exception list is the thing worth " +
          "carrying rather than the count: the scrim, the centring, `aria-modal`, the tab trap, " +
          "the ✕ and the Escape rung are written once and every host passes a title, a close " +
          "label and a width, so Categories, Tags, History, Deck settings, the export dialog, " +
          "the quick zones' New category and both destructive confirmations are one behaviour. " +
          "**Import cards and the theory difference are the two still off it**: each carries its " +
          "own copy of that chrome, deliberately out of scope rather than exempt, so until they " +
          "move a change to how a modal behaves here is an edit to more than one file. " +
          "**The card search column did " +
          "not follow them**, because it is worked *out of* rather than consulted: its tiles " +
          "are drag sources into the deck's own columns, and a scrim would end that path and " +
          "cover the card pane a reader flips printings in. It stays docked, and collapsed " +
          "until pressed.\n\n" +
          "**Categories and tags are two dialogs, not two sections of one drawer.** They shared " +
          "a panel and a scroll; each is one press now, and each is sized for what it draws — " +
          "`w-[48rem]` for the piles and their reordering, `w-[36rem]` for the labels.\n\n" +
          "**The first three toolbar controls are remembered on the deck row.** Which list, " +
          "which grouping, which sort: each press writes its own field through " +
          "`deck_set_view_state`, which moves no `updated_at`, records no history and " +
          "reallocates nothing — looking at a tab is not editing a deck — and the editor reads " +
          "the triple back when it opens. Deliberately **not** `useAppStore`: the two view " +
          "preferences are one session-wide answer and `cardZoom` is one per card *section* — " +
          "the desk here is `deck`, shared with the Grid view because they are one deck drawn " +
          "two ways and separate from the docked search column's `deckSearch` — so both are " +
          "facts about a **surface**, kept for a session and the same whichever deck is open, " +
          "while which list of a *particular* deck somebody was reading is a fact about that " +
          "deck. " +
          "{@link ReopensOnThePlan} is the deck that was left on its plan.\n\n" +
          "**An inactive category counts toward nothing at all** — not size, not copies, not " +
          "legality — and the allocator never claims a copy for one, so every card in it reads " +
          "`0` owned **by design** rather than for want of copies. That is `isActive` and never " +
          "the word `maybe`: the Maybeboard is one seeded row that starts switched off, and a " +
          "pile of the user's own that they switch off behaves identically. {@link MaybePile} " +
          "is the proof, on a card that is `modern: not_legal` while the chip beside it still " +
          "reads no issues.\n\n" +
          "**Owned is where the card physically is, never a claim staked over it.** A deck's " +
          "copies are the collection rows filed into that deck's group, so every deck blocks " +
          "every other by construction and there is no reservation to switch on. The header " +
          "carried a `Built` toggle until the claim ledger was deleted — it meant \"this deck " +
          "is on a table, so its claims come off what the others can reach\", which is now " +
          "what *being in the deck at all* means. {@link Modern60} reads one of those marks." +
          "\n\n" +
          "**Every card carries the same three affordances in every view, from one module.** A " +
          "stepper whose zero *removes* the card, a `draggable()` registration and the slot " +
          "attribute the card pane finds its way home by all come from `cardControl.tsx` — " +
          "four copies would be four chances for one surface to quietly stop offering " +
          "something, and the reader would find it by switching view and losing the ability to " +
          "remove a card. What each view decides is *placement*: the table spends them as a " +
          "column, the other three draw them over the card, revealed by the same hover and " +
          "focus that lift a stacked card.\n\n" +
          "**There were four until 2026-08-14, and the fourth was a move control** — a native " +
          "`Move…` `<select>` listing every other pile of the deck. It was removed whole, with " +
          "a different control expected later, so **moving a card between piles is a drag and " +
          "nothing else today**. What that costs is one thing rather than the two it cost " +
          "yesterday, written here because no story can assert an absence usefully: there is no " +
          "keyboard path to a move. The second cost was that an empty pile drew no heading and " +
          "a heading that is not drawn is not a drop target — the select was the one control " +
          "built from the deck's categories rather than from the drawn groups, which is what " +
          "used to close that hole. **Every pile the reader made now draws empty**, so a drawn " +
          "heading is the affordance itself; what is left undroppable is an empty *auto* pile, " +
          "which is a pile nobody asked for and which the add path files into by name anyway. " +
          "{@link NoMoveControl} is the absence, pinned.\n\n" +
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
          "Those three came through the v8 migration, so all three carry five *categories* — " +
          "Commander, Main deck, Sideboard, Companion, Maybeboard — which is no longer the same " +
          "number as five *headings*: only deck 2 draws all five, because only its format has a " +
          "command zone and only its companion slot holds a card. Decks 1 and 3 draw three. A " +
          "deck made *today* starts with only the four predefined categories " +
          "({@link EmptyDeck}) and grows the rest by name. **Deck 4 " +
          "`Rhystic Testbed`** is that second shape filled in: three `main` piles — two the " +
          "reader named, one of them switched off, and `Ramp`, which the add path made and " +
          "which therefore carries `origin: auto` — plus two game changers, a tagged card, a " +
          "copy limit broken on purpose and a theory list that differs from the deck. Its " +
          "`Ramp` is the pile whose *name* proves nothing: the two beside it are the reader's " +
          "and one of them is called `Card advantage`. The categories, tags, history " +
          "and theory commands the dialogs read are all the fake's now, so those surfaces are " +
          "driven rather than degraded — see `Decks/CategoriesDialog`, `Decks/TagsDialog`, " +
          "`Decks/DeckHistoryDialog` and `Decks/TheoryDiffDialog` for what each of them draws, " +
          "and `Decks/Dialog shell` for the shell they share.",
      },
    },
  },
} satisfies Meta<typeof Editor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Sixty Modern-legal cards, a full sideboard, and nothing wrong with any of it.
 *
 * **Five categories, three headings** — and which three is the format's answer rather than the
 * deck's. Every pile of the reader's own draws whether or not anything is in it, so Main deck,
 * Sideboard and Maybeboard are all here; the two that are missing are the **conditional zones**,
 * and each is missing for its own reason. Modern has no command zone at all, so an empty
 * Commander pile is not a fact about this deck but a zone the game it is being built for does not
 * have. An empty Companion pile is hidden in every format, Commander included: a companion is a
 * card you either have or do not, and an empty slot says nothing its absence does not say more
 * quietly. {@link CommanderDeck} is the same two piles with cards in them, and
 * {@link EmptyCommandZone} is the command zone drawn empty where the format wants one.
 *
 * **All five are `origin: user`, so the auto rule takes nothing away here** — four are
 * `create_deck`'s seeds and the fifth is the pile schema v8's migration built out of this deck's
 * old `main` zone, which v15's backfill deliberately leaves alone: "Main deck" is a real pile
 * holding real cards and not a name the app would ever invent. The format is therefore the only
 * variable in the paragraph above. {@link AutoPileArrivesWithItsCard} is the other class, on a
 * deck made today.
 *
 * **Neither category is gone, and neither is unreachable.** `deck.categories` is still all five —
 * deck settings' "Add cards to" select and `CategoriesDialog` are built from
 * that list and not from the drawn groups — and the moment a card is filed into the Commander
 * pile the heading arrives with it, because `drawsWhenEmpty` is never asked about a group holding
 * cards.
 *
 * The order is the v8 migration's own — Commander, Main deck, Sideboard, Companion, Maybeboard
 * — because a *seeded* deck comes out of that migration rather than out of `deck_create`. That
 * is the order the categories are **in**, and in Stacks it is not the order they are **drawn**:
 * the Sideboard and the Maybeboard are pinned to the right-hand rail and everything else packs
 * in front of them, which for this deck leaves the Main deck alone in the flow. See
 * `Decks/Views/StackView` for what the rail is for.
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
    // The empty Maybeboard is here too: a pile of the reader's own draws with nothing in it.
    await expect(canvas.getByRole("region", { name: "Maybeboard" })).toBeVisible();
    // …and the two conditional zones are not, each for its own reason: Modern has no command
    // zone, and an empty companion slot draws in no format. Asserted beside the three positives
    // above on purpose — a pair of absences alone would pass against a view that drew nothing.
    await expect(canvas.queryByRole("region", { name: "Commander" })).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Companion" })).toBeNull();
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("60 cards"),
    ).toBeInTheDocument();

    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    // Not the 75 copies the price and the shortfall are counted over.
    await expect(canvas.getByText("+ 15 sideboard")).toBeInTheDocument();

    // The shortage, spoken rather than only marked: every mark on a stacked card is
    // `aria-hidden`, so the button's own name is the whole of what a keyboard reader gets.
    //
    // **2 since v25, where this read 1.** The figure is now `sum(quantity)` over the copies in
    // this deck's *own* collection group, matched by oracle id — a Bolt is still a Bolt — and
    // the seed files two Counterspells into it. It is no longer a claim the allocator worked
    // out across the whole collection, which is why a number here can move without any card
    // being bought or sold.
    await expect(
      canvas.getByRole("button", { name: /^Counterspell.*you own 2 of 4/ }),
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
 * below still counts its one issue) and decides nothing about which piles exist. **The two
 * conditional zones are drawn here because they hold cards and not because this is Commander** —
 * `drawsWhenEmpty` is asked about empty piles only, so the command zone and the companion slot in
 * this deck would draw in Modern too. {@link EmptyCommandZone} is the half the format really
 * answers, and {@link Modern60} is the same two piles empty in a format that has neither.
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
    await userEvent.click(canvas.getByRole("button", { name: "1 issue · Commander" }));
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toHaveTextContent(
      "Lurrus of the Dream-Den needs every permanent card in your deck to have mana value 2 " +
        "or less; Kenrith, the Returned King does not.",
    );
  },
};

/**
 * One deck, four ways of looking at it — and the same headings in every one.
 *
 * The switch is the toolbar's **View** select, the groups are `grouping.ts`'s, and each view
 * decides only how a card is drawn: a stack of card faces, a `VirtualTable` row, a 22px line, a
 * 150px tile. That is what makes this a switch rather than four screens — the Sort and Group by
 * beside it keep meaning the same thing whichever is picked, and the table's own headers
 * deliberately do not sort, because one list with two orders is a list nobody can read.
 *
 * All three of those controls are the same `<select>`, which is what this play walks: three
 * questions about one list, asked one way.
 */
export const FourViews: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pick = (id: string) => userEvent.selectOptions(canvas.getByLabelText("View"), id);
    await canvas.findByRole("region", { name: "Main deck" });

    await pick("table");
    await expect(await canvas.findByRole("table", { name: "This deck" })).toBeInTheDocument();

    await pick("text");
    await waitFor(async () => await expect(canvas.queryByRole("table")).toBeNull());
    await expect(canvas.getByRole("region", { name: "Main deck" })).toBeVisible();

    await pick("grid");
    await expect(canvas.getByRole("region", { name: "Main deck" })).toBeVisible();

    await pick("stacks");
    await expect(canvas.getByRole("list", { name: "Main deck" })).toBeInTheDocument();
    await expect(canvas.getByLabelText("View")).toHaveValue("stacks");
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
 * it, its state is **the deck's** (`decks.separate_x_group`, schema v13) rather than this
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
 * The deck that was left on its plan, reopening on it — the tab, the grouping and the sort all
 * three.
 *
 * **The editor's opening state is a fact about the deck, not about the session.** `lastVariant`,
 * `lastGroupBy` and `lastSortBy` are columns on the deck row, written by `deck_set_view_state`
 * as the reader presses each control and read back here on the way in. Deck 4 is seeded on
 * `theory`/`type`/`manaCost` for exactly this — the other three decks carry the defaults, and a
 * seed where every deck read the same way could not show the memory at all.
 *
 * **Theory is the left-hand tab**, and that is the order the switch produces rather than a
 * preference: turning the plan on *moves* the live list into it, so the tab holding the cards is
 * the one a reader lands on and Live is the column that fills as they acquire them.
 *
 * Smuggler's Copter is the proof that the *list* changed and not just which button is lit — it is
 * in this deck's plan and in no part of what is sleeved up. Pressing Live is what the memory is
 * not: a starting point, never a lock.
 *
 * **It is also the seeded half of {@link AutoPileArrivesWithItsCard}.** This deck's "Cut list" is
 * a pile the reader made and switched off, and the plan has nothing in it — so the heading is
 * here, empty, over the words "Nothing here yet.". A pile the *app* made would be gone in that
 * state; the switch decides only whether what is in it counts. (Its `Ramp` is the `auto` one, and
 * it is not a heading here at all: under `type` an active pile's cards are bucketed by what they
 * are, and only switched-off piles are appended as themselves.)
 */
export const ReopensOnThePlan: Story = {
  args: { deckId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = within(await canvas.findByRole("group", { name: "Deck list" }));

    // Theory first, Live second — read off the DOM order, because "on the left" is the claim.
    const [theory, live] = tabs.getAllByRole("button");
    await expect([theory.textContent, live.textContent]).toEqual(["Theory", "Live"]);
    await expect(theory).toHaveAttribute("aria-pressed", "true");

    await expect(canvas.getByLabelText("Group by")).toHaveValue("type");
    await expect(canvas.getByLabelText("Sort")).toHaveValue("manaCost");

    // Empty in the plan and drawn regardless, because the reader made it.
    await expect(
      within(canvas.getByRole("region", { name: "Cut list" })).getByText("Nothing here yet."),
    ).toBeInTheDocument();

    const copter = await canvas.findByRole("button", { name: /^Smuggler's Copter/ });
    await expect(copter).toBeInTheDocument();

    await userEvent.click(live);
    await waitFor(async () => {
      await expect(canvas.queryByRole("button", { name: /^Smuggler's Copter/ })).toBeNull();
    });
    await expect(live).toHaveAttribute("aria-pressed", "true");
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
    // No disclosure to press: the pile is a group, drawn from the first paint. In Stacks it
    // rides the right-hand rail under the Sideboard, which is its own `sortOrder` (last, for a
    // deck that came through the v8 migration) and never a sort by kind.
    const pile = await canvas.findByRole("region", { name: "Maybeboard" });
    await expect(within(pile).getByText("INACTIVE")).toBeInTheDocument();
    const tomb = within(pile).getByRole("button", { name: /^Ancient Tomb/ });
    await expect(tomb).toBeInTheDocument();
    // No shortage, and not in the name either — the one place in the editor where owning
    // nothing is not worth saying.
    await expect(tomb.getAttribute("aria-label")).not.toMatch(/you own/i);

    // And nothing it holds reaches the size figure or the rules: two copies are on screen and
    // the deck is still sixty cards, still legal, still short of the same shortage.
    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toBeInTheDocument();
    await expect(
      within(canvas.getByRole("region", { name: "Main deck" })).getByText("60 cards"),
    ).toBeInTheDocument();
    // **72, not the 65 this read before v25**, and the three copies of the difference are the
    // whole of what changed: the deck owns what its *own collection group* holds, and the seed
    // files three copies into deck 1's group. Before, "owned" was whatever the allocator had
    // reserved out of the entire collection, so a deck could read owned for copies sitting
    // loose in a binder. It cannot any more — which is the point of the feature and is why this
    // number went **up**.
    await expect(canvas.getByText("72 of 75 missing")).toBeInTheDocument();
  },
};

/**
 * Stepping a deck card to zero — **and the card goes, while the copies come back.**
 *
 * A deck row holds an intention and nothing else, so zero deletes it (mirroring the table's
 * `CHECK (quantity > 0)`). What the reader physically owns is a different thing in a different
 * table: on the **Live** list the copies the deck's group was holding are filed into
 * `Recently removed`, which is what `deck_to_collection` does in the same transaction and what
 * the standing sentence at the foot of the deck says. The collection's own zero is the pair
 * that is easy to get backwards — `collection_set_quantity(0)` deletes as well since schema
 * v24, taking the condition, the purchase price and the acquisition story with it.
 *
 * **There is no remove control here to look for**, and that absence is the claim. A deck card
 * simply leaves, and the three ways to make it leave — the stepper's zero, a drop on the remove
 * tray and the card menu's `Remove card` — are one write, routed through
 * `useDeck.setQuantity`.
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
 * **A card carries a stepper and nothing else** — the `Move…` select that stood beside it was
 * removed on 2026-08-14, and a different control for moving a card between piles is expected
 * later.
 *
 * This is what took `MoveBetweenPiles`' place, and it is the weaker of the two on purpose:
 * moving a card is a drag now, and Storybook cannot drive one (see this page's own note on why
 * a green drag here would prove nothing). What a story *can* still hold is that the control
 * really is gone from every one of the four views rather than from the module that drew it —
 * the deck opens on Stacks, and {@link FourViews} walks the other three.
 */
export const NoMoveControl: Story = {
  args: { deckId: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The stepper is still there, so this is not passing on a deck that drew no controls.
    await canvas.findByRole("spinbutton", { name: "Copies of Black Lotus in Main deck" });

    await expect(canvas.queryByLabelText(/^Move Black Lotus/)).toBeNull();
    await expect(canvas.queryByRole("option", { name: "Move…" })).toBeNull();
  },
};

/**
 * The deck's own filter, and the stats band it deliberately does not reach.
 *
 * The filter narrows the cards **before** they are grouped, so every heading's count is a count
 * of what is under it. A heading reading 60 over four visible cards would be lying about the
 * only thing it is for.
 *
 * The band at the foot of the page is unfiltered, and that is the pairing worth seeing in one
 * story: the filter says what is *on screen*, and a deck's curve, colours and price are facts
 * about the deck. It is also permanent — it was an aside on the desk row with a toggle in the
 * toolbar, which existed only to give its 280px back to the docked search panel, and a band
 * under the deck takes no width from anything.
 */
export const FilterAndStats: Story = {
  args: { deckId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Main deck" });
    const stats = canvas.getByRole("region", { name: "Deck stats" });
    await expect(stats).toBeVisible();
    const cards = within(stats).getByText("Cards").nextElementSibling;
    const whole = cards?.textContent;

    await userEvent.type(canvas.getByLabelText("Filter this deck"), "counterspell");

    await waitFor(async () => {
      await expect(
        within(canvas.getByRole("region", { name: "Main deck" })).getByText("4 cards"),
      ).toBeInTheDocument();
    });

    // The whole deck, not the four rows the filter left on screen — and nothing offers to put
    // the band away.
    await expect(cards).toHaveTextContent(whole ?? "");
    await expect(canvas.queryByRole("button", { name: "Stats" })).toBeNull();
  },
};

/**
 * Seven dismissible surfaces, one piece of state — and the reason it has to be one.
 *
 * **The Escape argument that used to stand here is gone, and it was wrong in both directions.**
 * It read "`useDismissOnEscape` orders exactly two rungs, so two `"inner"` peers open at once are
 * not ordered at all — both would consume a single press". Two `"inner"` peers *are* ordered now:
 * that hook keeps a module-level stack of capture-phase registrations and only the token on top
 * acts, which is what lets a context menu open over a dialog opened over the card pane and give
 * one press to each. And the old behaviour was not "both close" either — the capture rung checks
 * `defaultPrevented` too, so the **first-registered** peer took the press and the newer one, the
 * thing the reader had just opened, was starved (measured `{ first: 1, second: 0 }`, 2026-08-14).
 *
 * The reason for one slot survives all of that, because it never rested on Escape: seven booleans
 * can express "Categories and History both up", which is two scrims, two `aria-modal` panels and
 * two focus traps over one screen. A union cannot say it, and the failure is invisible to any
 * test that opens one layer at a time.
 *
 * **Categories and Tags are the pair worth pressing in a row**, because until 2026-08-14 they
 * were one drawer called "Categories & tags" and a reader reaching for the second still reaches
 * for it next. Two dialogs, one slot: the second press replaces the first rather than stacking
 * on it.
 *
 * What this story asserts is the *arrangement* rather than any layer's contents: each press
 * leaves exactly one dialog on screen, and it is the one just pressed. Their own contents are
 * `Decks/CategoriesDialog`'s and `Decks/TagsDialog`'s.
 */
export const NeverTwoLayers: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole("button", { name: "1 issue · Commander" });
    const only = async (name: string) => {
      await waitFor(async () => {
        await expect(canvas.getAllByRole("dialog")).toHaveLength(1);
      });
      await expect(canvas.getByRole("dialog", { name })).toBeInTheDocument();
    };

    await userEvent.click(chip);
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Categories" }));
    await only("Categories");

    // The half the split makes worth showing: the button beside it, pressed while the first is
    // still up, and no second panel behind it.
    await userEvent.click(canvas.getByRole("button", { name: "Tags" }));
    await only("Tags");

    // Escape closes the one that is up and hands the caret back to the control that opened it —
    // the editor is a *view*, so the deck is still on screen afterwards.
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => {
      await expect(canvas.queryByRole("dialog")).toBeNull();
    });
    await expect(canvas.getByRole("button", { name: "Tags" })).toHaveFocus();
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
 * **Four categories, and no "Main deck" among them.** `deck_create` seeds
 * `schema::PREDEFINED_CATEGORIES` — Commander, Sideboard, Companion, Maybeboard — and there is
 * deliberately no `main` row in that list: a deck may own any number of `main` categories and
 * the seed names none, so the pile a plain add goes to is *found or created by name* on the
 * first add rather than born with the deck. That is the difference between a deck made today and
 * one the v8 migration converted, which is why the seeded decks above have five.
 *
 * **All four are `origin: user`**, which is what keeps two of them on screen: a seed is not the
 * app filing a card. The first `auto` pile this deck can have arrives with its first add, because
 * `category_for_name` is the one writer that stamps one — {@link AutoPileArrivesWithItsCard}
 * carries on from exactly here.
 *
 * **Two of those four are drawn, because this deck is Modern.** Sideboard and Maybeboard are
 * unconditional piles and say "Nothing here yet."; the command zone belongs to a format this
 * deck is not being built for, and the companion slot draws empty in no format at all. So the
 * emptiest state the editor has is also the one where the conditional rule is easiest to read —
 * {@link EmptyCommandZone} is this same act one format over, and the only thing that differs
 * between the two stories is the word in `formatKey`.
 */
export const EmptyDeck: Story = {
  args: { deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Sideboard" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Maybeboard" })).toBeVisible();
    // Seeded, reachable by name from deck settings' "Add cards to" select, and not drawn: Modern
    // has no command zone, and an empty companion slot is drawn in no format.
    await expect(canvas.queryByRole("region", { name: "Commander" })).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Companion" })).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Main deck" })).toBeNull();
    await expect(canvas.getAllByText("Nothing here yet.").length).toBeGreaterThan(0);

    await userEvent.click(canvas.getByRole("button", { name: "1 issue · Modern" }));
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
 * The same empty deck one format over — **and the command zone is here, saying nothing is in
 * it.**
 *
 * {@link EmptyDeck} and this story differ in a single word, `formatKey`, and that is the whole
 * demonstration: a Commander deck's four seeded piles draw three headings where a Modern deck's
 * four draw two. **An empty command zone in a Commander deck is itself a fact about the deck** —
 * it is the one heading the editor must never answer a question about by leaving it out, and the
 * check chip beside it is saying the same thing in words. In Modern that same empty pile is not a
 * fact about the deck at all, but a zone the game it is being built for does not have, which is
 * why `drawsWhenEmpty` reads the format's `requiresCommander` rather than the pile.
 *
 * **The Companion slot is absent here too, and that is the half that is not about the format.**
 * Commander allows companions; an empty companion pile still draws nothing, in this format and in
 * every other, because a companion is a card you either have or do not and an empty slot says
 * nothing that its absence does not say more quietly. One rule, two clauses, and only the first
 * of them asks what format the deck is.
 */
export const EmptyCommandZone: Story = {
  args: { deckId: null, formatKey: "commander" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const commander = await canvas.findByRole("region", { name: "Commander" });
    await expect(within(commander).getByText("Nothing here yet.")).toBeInTheDocument();
    // The unconditional piles, so the absence below is read against a view that drew something.
    await expect(canvas.getByRole("region", { name: "Sideboard" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Maybeboard" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Companion" })).toBeNull();

    // The heading and the sentence are the same fact drawn twice: the zone is empty, and this
    // format needs it not to be. The count is left to the regex — the size rule is talking too —
    // and the format is not, because it is the deck's own and the whole point of the story.
    await userEvent.click(canvas.getByRole("button", { name: /^\d+ issues · Commander$/ }));
    await expect(canvas.getByRole("dialog", { name: "Commander check" })).toHaveTextContent(
      "Commander decks need a commander; the commander zone is empty.",
    );
  },
};

/**
 * **The whole of the empty-pile rule, in one deck: a pile the reader made, and a pile the app
 * made, side by side with nothing in either.**
 *
 * The two are indistinguishable on screen once they hold cards, so the only way to see the rule is
 * to empty them — and the only way to be honest about which is which is to *make* them the way the
 * app does. Both writes here are the real commands through the fake: `Combo pieces` comes from the
 * panel's "New category" button (`deck_category_create`, `origin: user`) and `Ramp` is invented by
 * `category_for_name` while the quick add files a Sol Ring (`origin: auto`) — `autoCategoryFor`
 * reads that card's Oracle tags (`mana-producer`, `ramp`) and answers with the word this deck has
 * never heard before.
 *
 * **Then the card is stepped out again, which is the assertion the story exists for.** The heading
 * `Ramp` goes with its last card, because nobody asked for that pile; `Combo pieces` stays, empty,
 * because somebody did. Neither *category* was deleted — deck settings' "Add cards to" still
 * offers both by name, which is what makes hiding one survivable: no surface a card is filed with
 * is built from the drawn groups.
 *
 * A fresh deck rather than a seeded one, because the two facts have to be **made** rather than
 * asserted: a hand-written seed row could claim any `origin` it liked and would be a story about
 * this file's opinion. {@link ReopensOnThePlan}'s deck 4 is the seeded half — its `Ramp` is `auto`
 * and holds cards in both lists, and its switched-off `Cut list` is a user pile the plan leaves
 * empty.
 */
export const AutoPileArrivesWithItsCard: Story = {
  args: { deckId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = (name: string) => canvas.queryByRole("region", { name });
    await canvas.findByRole("region", { name: "Sideboard" });

    // --- the pile the reader asks for -------------------------------------------------------
    await userEvent.click(canvas.getByRole("button", { name: "Categories" }));
    const dialog = await canvas.findByRole("dialog", { name: "Categories" });
    await userEvent.type(within(dialog).getByLabelText("New category name"), "Combo pieces");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(async () => {
      await expect(within(dialog).getByText("Combo pieces")).toBeInTheDocument();
    });
    // Out of the way: the dialog is `position: fixed` over the deck it is about.
    await userEvent.keyboard("{Escape}");
    await waitFor(async () => await expect(canvas.queryByRole("dialog")).toBeNull());

    const theirs = await canvas.findByRole("region", { name: "Combo pieces" });
    await expect(within(theirs).getByText("Nothing here yet.")).toBeInTheDocument();
    // And no `Ramp` yet — the deck has no such category at all, which is the state the next
    // three lines change.
    await expect(heading("Ramp")).toBeNull();

    // --- the pile the app makes -------------------------------------------------------------
    await userEvent.type(
      canvas.getByRole("combobox", { name: "Quick add a card" }),
      "Sol Ring{Enter}",
    );
    const auto = await canvas.findByRole("region", { name: "Ramp" }, { timeout: 4000 });
    await expect(within(auto).getByRole("button", { name: /^Sol Ring/ })).toBeInTheDocument();

    // --- and the difference between them ----------------------------------------------------
    await userEvent.click(
      canvas.getByRole("button", { name: "Decrease Copies of Sol Ring in Ramp" }),
    );
    await waitFor(async () => await expect(heading("Ramp")).toBeNull(), { timeout: 4000 });
    // Empty since it was made, and still drawn: a place the reader chose to keep.
    await expect(canvas.getByRole("region", { name: "Combo pieces" })).toBeVisible();
    // The row is still in `deck.categories`, which is what deck settings' "Add cards to" select
    // is built from — undrawn is not deleted, and the next Sol Ring lands back in it by name.
    // That select was the docked panel's until 2026-08-15, when where an unfiled add lands
    // became a deck setting; the claim is unchanged and only the surface moved.
    await userEvent.click(canvas.getByRole("button", { name: "Deck settings" }));
    const addTo = within(await canvas.findByLabelText("Add cards to"));
    await expect(addTo.getByRole("option", { name: "Ramp" })).toBeInTheDocument();
    await expect(addTo.getByRole("option", { name: "Combo pieces" })).toBeInTheDocument();
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
 * The header's `Deck game` select is the write pressed here because it is a one-act deck-row
 * write the header always draws; before the four views replaced the category columns it would
 * have been a stepper, which also exercised the optimistic rollback. That rollback is still
 * `useDeck`'s and still tested there — what this story shows is the *banner*, and that the deck
 * survives a refusal. (It was the `Built` toggle until that chip was removed with the claim
 * ledger.)
 */
export const Busy: Story = {
  args: { deckId: 1 },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Main deck" });

    await userEvent.selectOptions(canvas.getByLabelText("Deck game"), "paper");

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
 * **This is the one editor story that opens the card pane, because the swap has no control in
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
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **The panel is open at rest again** (issue #183), so there is no disclosure to press
    // first — the card pane it used to trade width with is an overlay now and takes none. The
    // button and the search field share the name "Search cards" — the disclosure names what it
    // reveals — so each is still addressed by its own role.
    //
    // The wall is searched rather than scrolled: it is virtualised, one column wide under
    // `src/stories.test.tsx`'s layout stub, and Sol Ring is far enough down an alphabetical list
    // of 36 cards that its tile is not mounted.
    await userEvent.type(
      await canvas.findByRole("searchbox", { name: "Search cards" }),
      "Sol Ring",
    );

    // **The add target is chosen, not assumed** — and since 2026-08-15 it is chosen in **deck
    // settings**, because where an unfiled add lands is a fact about the deck rather than about
    // the search column beside it. This fold is about the printing sitting in the main deck, so
    // the deck is pointed there and the dialog closed again. Picked by the option's own text,
    // because a category's id is the fake's own row numbering and not something a story writes
    // down.
    await userEvent.click(canvas.getByRole("button", { name: "Deck settings" }));
    const target = await canvas.findByLabelText("Add cards to");
    await userEvent.selectOptions(
      target,
      within(target).getByRole("option", { name: "Main deck" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Close deck settings" }));
    await waitFor(async () => await expect(canvas.queryByRole("dialog")).toBeNull());

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
