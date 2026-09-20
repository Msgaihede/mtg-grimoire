import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckNote } from "@/lib/ipc";
import { NOTES_HEADING, NotesBand } from "./DeckNotesPanel";
import type { NoteCardChoice } from "./deckNotes";
import { NOTE_STRIP_ATTR } from "./NoteCard";

/**
 * One note, with everything a card can carry.
 *
 * The stamps are a fixed instant rather than `Date.now()`: nothing in this band prints a date,
 * and a fixture whose values move between two renders of a docs page is a fixture that can make
 * one story disagree with the next for a reason no reader could see.
 */
function note(over: Partial<DeckNote> & { id: number }): DeckNote {
  return {
    deckId: 1,
    title: "",
    body: "",
    sortOrder: over.id,
    cards: [],
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    ...over,
  };
}

/** The deck this band is drawn over — the picker's whole offer, one row per oracle id with the
 *  printing, the bucket and the folded copy count `attachableCards` hands it in the app.
 *
 *  Written out rather than run through `attachableCards` over `DeckCard` fixtures: a story is a
 *  statement about what the *band* draws, and building its offer with the same function the band
 *  uses would make the picker's states depend on a derivation this file is not about.
 *  `deckNotes.test.ts` owns that derivation. */
const ATTACHABLE: NoteCardChoice[] = [
  {
    oracleId: "o-bolt",
    name: "Lightning Bolt",
    cardId: "c-bolt",
    setCode: "m10",
    collectorNumber: "146",
    typeBucket: "Instant",
    copies: 4,
  },
  {
    oracleId: "o-goblin",
    name: "Goblin Guide",
    cardId: "c-goblin",
    setCode: "zen",
    collectorNumber: "124",
    typeBucket: "Creature",
    copies: 4,
  },
  {
    oracleId: "o-monastery",
    name: "Monastery Swiftspear",
    cardId: "c-monastery",
    setCode: "ktk",
    collectorNumber: "118",
    typeBucket: "Creature",
    copies: 4,
  },
  {
    oracleId: "o-eidolon",
    name: "Eidolon of the Great Revel",
    cardId: "c-eidolon",
    setCode: "jou",
    collectorNumber: "93",
    typeBucket: "Enchantment",
    copies: 3,
  },
  {
    oracleId: "o-mountain",
    name: "Mountain",
    cardId: "c-mountain",
    setCode: "m10",
    collectorNumber: "244",
    typeBucket: "Land",
    copies: 20,
  },
];

/**
 * What the reader has written down about a deck — **drawn over plain props, and that is a
 * decision this file owes an argument for.**
 *
 * Every other band in the deck editor is storied through `.storybook/fake/`, because a seed is
 * the honest way to show what the *app* does with a world. Three of the six states below cannot
 * be reached that way at all: a body long enough to need a clamp, a note naming four cards and a
 * **refused read** are not shapes of a seeded deck — the first two are prose nobody would put in
 * a shared fixture, and the third is a refusal on a command no fault reaches. So the band is
 * split the way `DeckStats` is: `DeckNotesPanel` owns the query and the five writes, and
 * `NotesBand` — this component — owns everything drawn. The workbench stands up the drawing.
 *
 * **The list loads no editor.** Reading a note renders `parseNoteBody`'s blocks: a closed reader
 * over one pinned dialect, no library, no HTML string. Writing mounts Tiptap through
 * `React.lazy`, which is **141.5 kB gzip** against the app's own 481.45 kB — so a band showing
 * twenty notes costs the main chunk nothing, and pressing `New note` or `Edit` is what fetches
 * it. **Exactly one story below opens that door** — {@link Empty}, because the band's one act is
 * the whole of what an empty band is for — and **none of them presses Save**, which is
 * `NoteEditorDialog.stories.tsx`' own rule: a round trip through ProseMirror's serialiser is
 * that file's subject and not this one's.
 *
 * **A note stays in this list whether it names no cards or four.** That is issue #447's central
 * sentence — the card is a reference the note holds, never a place the note lives — and it is
 * why {@link NamingFourCards} is a story rather than a footnote: the note with the most cards on
 * it is drawn as exactly the same card of the grid as the one with none.
 *
 * **The cards are a masonry, and the story that shows it is {@link ManyNotesOfDifferentLengths}.**
 * A card is as tall as its note — there is no clamp and no `+ more` on the prose — so what stays
 * uniform across the grid is the **gutter** and never the height, and a short card beside a tall
 * one leaves 8px under it rather than the tall card's whole height. That is a layout claim and
 * jsdom lays nothing out, so the story is where it can be *looked* at; `NoteCard.tsx` carries the
 * argument and the live pass carries the measurement.
 *
 * **The act is in the heading row**, beside the count and outside the collapsible region — so
 * `New note` is offered whether the band is open or shut, and a reader with no notes meets a
 * control rather than a form standing in for one. It replaced an add row above the list, whose
 * ordering was `LabelsDialog`'s; what survives of that argument is which reader it was for, and
 * {@link Empty} is still that reader.
 */
const meta = {
  title: "Decks/DeckNotesPanel",
  component: NotesBand,
  tags: ["autodocs"],
  args: {
    open: true,
    // **The casts are what let the stories below exist.** `StoryObj<typeof meta>` takes each
    // argument's type from the value written here, so a bare `[]` would type this arg as
    // `never[]` and a bare `null` would make the refusal unwritable — `DeckStats`' `onPull`, one
    // band over, and the same two lines of reason.
    notes: [] as DeckNote[],
    attachable: ATTACHABLE,
    answered: true,
    failure: null as string | null,
    pending: false,
    onToggle: fn(),
    onCreate: fn(),
    onSave: fn(),
    onDelete: fn(),
    onAttach: fn(),
    onDetach: fn(),
  },
  // The band sits at the foot of the editor's column, so it is given a column's width and
  // nothing else. 60rem is roughly the desk at the app's own window with the search panel open.
  decorators: [
    (Story) => (
      <div className="w-[60rem] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Every note on the open deck, in a band at the foot of the editor — the last thing " +
          "on the page, under the price strip and under the Deck stats.\n\n" +
          "**A note belongs to the deck and may name any number of cards.** The card is a " +
          "reference the note holds rather than a place the note lives, so a note that names " +
          "four cards is in this list exactly once, beside a note that names none.\n\n" +
          "**Reading loads no editor.** The list draws a small closed markdown reader; " +
          "pressing `New note` or Edit is what fetches Tiptap, behind `React.lazy`.\n\n" +
          "**The cards are a masonry, not a grid of equal tiles.** A card is as tall as its " +
          "note — no clamp, no `+ more` on the prose — so what stays uniform across the grid " +
          "is the gutter rather than the height.\n\n" +
          "**`New note` is in the heading row**, beside the count and outside the collapsible " +
          "region: the band's one act is offered whether or not the area is open, and a reader " +
          "with no notes is who that is hardest for.\n\n" +
          "**The open state is `decks.notes_open`**, written through the ordinary deck patch — " +
          "so it is an arg here and the press is `onToggle`, exactly as the two bands above it.",
      },
    },
  },
} satisfies Meta<typeof NotesBand>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **A deck nobody has written about yet, which is every deck in the database.**
 *
 * The column is `DEFAULT 0`, so this band is shut on every existing deck — but the disclosure is
 * a control even here, and that is where this band parts company with `Tokens & emblems`. That
 * one draws its heading as plain type on a deck that makes nothing, because there is nothing to
 * disclose.
 *
 * **What the disclosure is worth on an empty deck moved with the add row, and it is still worth
 * something.** The act is `New note` in the heading now, so a reader with nothing written has a
 * control whether this area is open or shut — the offer does not depend on the disclosure, which
 * is the whole reason it is drawn outside the collapsible region. What opening still buys them is
 * the sentence below, which names that control rather than leaving them to find it: the empty
 * band explains the button above it instead of standing in for one.
 *
 * The count beside the heading is absent rather than zero — a bare `0 notes` next to a sentence
 * saying so is the same fact twice.
 */
export const Empty: Story = {
  play: async ({ canvas, args }) => {
    const disclosure = await canvas.findByRole("button", { name: NOTES_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.queryByText(/^\d+ notes?$/)).toBeNull();

    // The sentence is asked for by its opening words and not in full: `New note` inside it is a
    // `<span>`, so the `<p>`'s own text is what is left once that element is taken out — and a
    // whole-string matcher would be asserting a join `getNodeText` never makes.
    await expect(canvas.getByText(/^No notes on this deck yet/)).toBeInTheDocument();

    // **By role, because the words are on screen twice.** That same `<span>` reads `New note`, so
    // `getByText` finds the sentence's own emphasis as well as the control — the press has to be
    // asked for as the thing that can be pressed.
    const newNote = canvas.getByRole("button", { name: "New note" });
    await userEvent.click(newNote);

    // The band's one act opens a door rather than writing: the create is the dialog's Save, which
    // this story deliberately does not press — see the meta.
    const editor = await canvas.findByRole("dialog", { name: "New note" });
    await expect(args.onCreate).not.toHaveBeenCalled();

    // ⚠️ **This story deliberately does not wait for the editing surface, and the reason is a
    // measurement rather than a preference.** The dialog's heading and its footer render at once;
    // the surface itself is behind `React.lazy`, and whichever play imports that chunk *first*
    // pays vite's cold transform of the whole of Tiptap — **33.3 s of import phase against 16.6 s
    // warm**, measured on the two runs this story was written across. A `findBy*` on the surface
    // is therefore a claim about the runner's cache and not about this band, and it failed at the
    // default 1 000 ms the first time it was tried. What the editor draws is
    // `NoteEditorDialog.stories.tsx`' subject; what this one owes is that the press opened it and
    // wrote nothing. Dismissing while the chunk is still in flight costs nothing — the boundary
    // is gone by the time the promise settles, so there is no state to update and no warning.
    //
    // Put it back, so what this story is *about* is what a reader of the docs page is left
    // looking at: the header's control over one sentence.
    await userEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    // The press writes `decks.notes_open`; the editor owns that write, so this is the whole of
    // what the band does with it.
    await userEvent.click(disclosure);
    await expect(args.onToggle).toHaveBeenCalledWith(false);
  },
};

/**
 * One note, with a title and a body.
 *
 * The body is drawn as blocks rather than as source: `**` is bold and `-` is a list marker the
 * accessibility tree never sees, because a real `list-disc` keeps the bullet out of the row's
 * `textContent`. What no press here does is load an editor.
 */
export const OneNote: Story = {
  args: {
    notes: [
      note({
        id: 1,
        title: "Mana base",
        body: "Fourteen sources is **one short** — the curve wants fifteen.\n\n- Swap a Mountain in\n- Cut the fourth Bolt",
      }),
    ],
  },
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });
    await expect(within(region).getByText("1 note")).toBeInTheDocument();

    // Every control on the card names the note it acts on, spelled rather than assembled — a CSS
    // `gap` is not a word separator to name computation, and two elements would compute to
    // `EditMana base`.
    await expect(
      within(region).getByRole("button", { name: "Edit Mana base" }),
    ).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: "Delete Mana base" }),
    ).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: "Cards on Mana base" }),
    ).toBeInTheDocument();

    // **No `N cards` chip, and there is no longer one to be absent.** The redesign deleted it
    // outright — the art strip counts a note's cards now, and this note names none, so it draws
    // no strip either. The chip survives in the picker, where there is no strip to count.
    await expect(within(region).queryByText(/^\d+ cards?$/)).toBeNull();
    await expect(region.querySelector(`[${NOTE_STRIP_ATTR}]`)).toBeNull();

    // The body is rendered, not printed: the emphasis is an element, and the bullet is a real
    // list marker rather than a glyph in a span — so it stays out of the card's own text.
    await expect(within(region).getByText("one short")).toBeInTheDocument();
    const item = within(region).getByText("Swap a Mountain in");
    await expect(item.closest("ul")).not.toBeNull();
    await expect(item).toHaveTextContent("Swap a Mountain in");
  },
};

/**
 * **Many notes, which is the shape the old single `decks.notes` column could not hold at all.**
 *
 * Each one is managed and deleted on its own — that is the issue's ask — so every card carries
 * its own three controls and its own confirmation.
 *
 * **The confirmation is a dialog over the page and no longer a box unfolding under the card**,
 * which is what the masonry bought and what it cost: a question that grew inside one card would
 * reflow every card after it at the moment the reader was reading the question. So it is a
 * `role="dialog"` named `Delete “<note>”?` — the question *is* the heading, and there is no
 * second paragraph asking it.
 *
 * The last card has a **blank title** and reads as its body's first line, computed at render and
 * never stored. A stored derivation would go stale the moment the body was edited, and there is
 * no writer that could notice.
 */
export const ManyNotes: Story = {
  args: {
    notes: [
      note({ id: 1, title: "Mana base", body: "Fourteen sources." }),
      note({
        id: 2,
        title: "Sideboard plan",
        body: "## Against control\n\nBring the Eidolons in.",
        cards: [{ oracleId: "o-eidolon", name: "Eidolon of the Great Revel", cardId: "c-eidolon" }],
      }),
      note({ id: 3, title: "Budget", body: "The fetchlands can wait." }),
      note({ id: 4, title: "", body: "Ask Supreme about the Bolt count" }),
    ],
  },
  play: async ({ canvas, args }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });
    await expect(within(region).getByText("4 notes")).toBeInTheDocument();

    // The blank-titled note stands on its body's first line — and it is a control's name too,
    // so the fallback reaches the reader who cannot see the card.
    await expect(
      within(region).getByRole("button", { name: "Edit Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();

    // A destructive press asks first, and the question says what it does and does not reach.
    // **The curly quotes are the component's own** — the heading is `Delete “${title}”?`, so a
    // straight-quoted matcher here would miss a dialog that is on screen.
    await userEvent.click(within(region).getByRole("button", { name: "Delete Sideboard plan" }));
    const question = await canvas.findByRole("dialog", { name: "Delete “Sideboard plan”?" });
    await expect(
      within(question).getByText(/The cards themselves stay in the deck\./),
    ).toBeInTheDocument();

    await userEvent.click(within(question).getByRole("button", { name: "Delete note" }));
    await expect(args.onDelete).toHaveBeenCalledWith(2);
  },
};

/**
 * **A note long enough to be a document, which is what a rich-text body is for.**
 *
 * The whole dialect is here: headings, both kinds of list, a blockquote, emphasis, inline code
 * and a link. Nothing is truncated in the string **and nothing is clamped in the card** — the
 * spec fixed a note's height at 184px and cut its body to three lines, and the reader's answer
 * reversed that: do the masonry properly, and a long note is simply as long as it is. So this
 * story is what *one* card does with a document, which is grow; **{@link
 * ManyNotesOfDifferentLengths} is what the grid does with several**, and the two are deliberately
 * not the same story — a second long note beside this one would say the layout's sentence in the
 * file's one story about the dialect, and this fixture is already the longest thing the band can
 * be handed.
 *
 * The last paragraph is a table, which the dialect has no rule for. It falls through to a
 * paragraph and renders **as written**: `releaseNotes.ts`' rule, inherited whole, and the reason
 * nothing a reader types can be silently dropped.
 */
export const LongBody: Story = {
  args: {
    notes: [
      note({
        id: 1,
        title: "How this deck wants to be played",
        body: [
          "# The plan",
          "",
          "Burn is a *clock* and a **reach** deck, and the two halves are not the same card.",
          "The clock is the one-drops; the reach is everything that goes to the face.",
          "",
          "## Mulligans",
          "",
          "- Keep any hand with two lands and a one-drop",
          "- Keep one-landers only on the play with two `Mountain`-fixed spells",
          "- Ship seven-card hands with three or more four-drops",
          "",
          "## The turns",
          "",
          "1. One-drop, hold up nothing",
          "2. Attack, second one-drop",
          "3. Burn the blocker, keep attacking",
          "",
          "> Never point a burn spell at a creature you can afford to race.",
          "",
          "See [the primer](https://example.com/burn) for the long form.",
          "",
          "| matchup | plan |",
        ].join("\n"),
      }),
    ],
  },
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });

    await expect(within(region).getByText("Mulligans")).toBeInTheDocument();
    await expect(within(region).getByText("reach")).toBeInTheDocument();
    await expect(within(region).getByText("Mountain")).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: "the primer" }),
    ).toBeInTheDocument();

    // The construct the reader has no rule for is still the reader's typing, drawn as they wrote
    // it — never dropped for not being understood.
    await expect(within(region).getByText("| matchup | plan |")).toBeInTheDocument();
  },
};

/**
 * **Six notes of very different lengths — the story the masonry exists for, and the only one that
 * draws the layout's whole point.**
 *
 * Four one-liners and two documents, in the reader's own order. The band rules its grid in
 * one-pixel rows with `rowGap: 0` and gives each card a `grid-row: span` of its own measured
 * height, so a card that wraps to the next line starts at the **foot of the shortest column**
 * rather than under the tallest card of a shared line. A wrapping flex box cannot do that — a
 * flex line is as tall as its tallest item, which is the defect both this band and
 * `views/StackView.tsx` exist to avoid; `masonry.ts` is the mechanism they share, at two
 * different gutters.
 *
 * **What this story can assert and what it can only _show_ are two lists, and the split is
 * jsdom's.** It lays nothing out and measures every box as `0`, so the play below says that all
 * six cards claim a span, that they are one list in the reader's order, and that a document is
 * drawn whole. It cannot say that anything tiles: four cards up at the editor column's 1192px,
 * two from about 860 and one below about 580, and 8px under a short card rather than the tall
 * card's whole height, are claims only a browser can referee. They belong to Storybook — where
 * this story is a picture rather than an assertion — and to the live pass.
 *
 * The short cards are what the **floor** is for, `min-h-[11.5rem]`. It is a floor and not a
 * ceiling because a `min-h-*` on a grid item replaces `min-height: auto` and leaves the item's own
 * `height: auto` to grow it — which is why a card must never also carry an `h-*`.
 */
export const ManyNotesOfDifferentLengths: Story = {
  args: {
    notes: [
      note({ id: 1, title: "Mana base", body: "Fourteen sources is one short." }),
      note({
        id: 2,
        title: "The long game",
        body: [
          "# The long game",
          "",
          "This deck wins on the fourth turn and loses every game that reaches the seventh, so",
          "every card in it is either a clock or reach.",
          "",
          "## What to keep",
          "",
          "A six with a one-drop beats a seven without one, and the sideboard does not change it.",
          "",
          "> Never point a burn spell at a creature you can afford to race.",
          "",
          "Ship the fourth Bolt against anything that gains life.",
        ].join("\n"),
      }),
      note({ id: 3, title: "Budget", body: "The fetchlands can wait." }),
      note({
        id: 4,
        title: "The control matchup",
        body: [
          "## Their answers",
          "",
          "Four counterspells and two sweepers, so the plan is to spend their counters on the half",
          "of the deck that does not win the game.",
          "",
          "Hold one burn spell back for the turn they tap low.",
          "",
          "The Eidolons come in and every creature that dies to a sweeper comes out.",
        ].join("\n"),
      }),
      note({ id: 5, title: "", body: "Ask Supreme about the Bolt count" }),
      note({ id: 6, title: "Sleeves", body: "Double-sleeve before Friday." }),
    ],
  },
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });
    await expect(within(region).getByText("6 notes")).toBeInTheDocument();

    // **None of the six bodies carries a bullet list, and that is a fixture decision rather than
    // an oversight**: a `-` line draws a real `<ul>`/`<li>` inside a card, so `listitem` would
    // count a note's own bullets as notes and `list` would find more than one grid. The dialect
    // is {@link LongBody}'s subject; this story's is the shape of the grid.
    const cards = within(region).getAllByRole("listitem");
    await expect(cards).toHaveLength(6);

    // Every card claims a span of its own — the one thing the masonry rests on, asked of all six
    // rather than of one. **jsdom measures every box as `0`**, so the number is `NOTE_GAP` alone
    // and says nothing about a height; what it does say is that the measurement reached every
    // card, where a hook wired to the first would tile nothing and still pass a one-card test.
    for (const card of cards) {
      await expect(card.style.gridRow).toMatch(/^span \d+$/);
    }

    // DOM order is the reader's order, which is the property that chooses CSS Grid over N
    // hand-assigned columns: only the *placement* is the browser's, so tab order and what a
    // screen reader hears are `sort_order` whatever the columns do. Read off the controls rather
    // than the titles — a note's title is on its card three times, once as the heading line and
    // once inside each of the two `sr-only` twins that name Edit and Delete.
    await expect(
      within(region)
        .getAllByRole("button", { name: /^Edit / })
        .map((button) => button.textContent),
    ).toEqual([
      "Edit Mana base",
      "Edit The long game",
      "Edit Budget",
      "Edit The control matchup",
      "Edit Ask Supreme about the Bolt count",
      "Edit Sleeves",
    ]);

    // **No clamp and no `+ more` on the prose** — the last line of each document is drawn, which
    // is the whole of what the redesign reversed.
    await expect(
      within(region).getByText("Ship the fourth Bolt against anything that gains life."),
    ).toBeInTheDocument();
    await expect(
      within(region).getByText("Hold one burn spell back for the turn they tap low."),
    ).toBeInTheDocument();
  },
};

/**
 * **One note naming four cards — the issue's own sentence, drawn.**
 *
 * *"A note may have any number of attached cards, since it may refer to multiple cards"*, and
 * *"notes should always appear in the notes list, even when they are attached to a card"*. Both
 * halves are visible here at once: it is an ordinary card of the grid, with an **art strip** where
 * a note naming none has nothing.
 *
 * **The `N cards` chip is gone and the strip counts them instead.** Three crops
 * (`NOTE_THUMBS`) and then a `+N more` chip, so a note naming four draws three pictures and
 * a `+1 more` — and because the crops are `aria-hidden` decoration and `+N more` does not exist
 * below four cards, the count a reader cannot see is carried by an `sr-only` sentence naming
 * **every** card. That sentence is the one thing the redesign took away with the chip and put
 * back; `NoteCard.tsx`'s `namesSentence` carries the argument, including why it joins with `; `.
 *
 * **The picker is a dialog now, not a panel unfolding under the card**, and the reason is the
 * masonry: a list of the deck's cards growing inside one card would reflow every card after it.
 * It is still a control **beside** Edit rather than inside it — reaching it through the editor
 * would make a reader load 141.5 kB of ProseMirror in order to name a card — and it offers the
 * deck's whole list as ticked and unticked checkboxes rather than two lists of presses, so
 * naming and un-naming are one gesture in one place. `NoteCardsDialog.stories.tsx` is that
 * dialog's own workbench; what this story asserts is only that the band wires it to the right
 * note.
 */
export const NamingFourCards: Story = {
  args: {
    notes: [
      note({
        id: 1,
        title: "The one-drop suite",
        body: "All four of these want to be on the play.",
        // **In the order `attachments_by_note` answers, which is by card name** — its statement
        // ends `ORDER BY nc.note_id, coalesce(p.name, nc.oracle_id), nc.oracle_id`. A fixture in
        // any other order would draw three crops the app would never draw together and would put
        // a different card behind `+1 more`.
        cards: [
          { oracleId: "o-eidolon", name: "Eidolon of the Great Revel", cardId: "c-eidolon" },
          { oracleId: "o-goblin", name: "Goblin Guide", cardId: "c-goblin" },
          { oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" },
          { oracleId: "o-monastery", name: "Monastery Swiftspear", cardId: "c-monastery" },
        ],
      }),
      note({ id: 2, title: "Nothing to do with a card", body: "Sleeve these before Friday." }),
    ],
  },
  play: async ({ canvas, args }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });

    // Both notes are in the list, which is the requirement: naming cards does not move a note
    // anywhere.
    await expect(within(region).getByText("2 notes")).toBeInTheDocument();

    // **Where the `4 cards` chip was**, and it is said twice because it is said to two readers.
    // `+1 more` is what four cards leaves over three crops; the sentence beside them names every
    // card and not the three drawn, which is what a reader who cannot see pictures gets in place
    // of a count the crops carry silently.
    await expect(
      within(region).getByRole("button", { name: "1 more card in The one-drop suite" }),
    ).toBeInTheDocument();
    await expect(
      within(region).getByText(
        "Names 4 cards: Eidolon of the Great Revel; Goblin Guide; Lightning Bolt; " +
          "Monastery Swiftspear.",
      ),
    ).toBeInTheDocument();

    // And the note that names none draws no strip at all — an empty row of frames on the band's
    // commonest note is the `0 cards` chip's own failure told in pictures. One strip on a band
    // holding two notes is the whole of that claim, which is why the strip carries an attribute:
    // it has no role, no name and no text, so *no strip* and *an empty strip* are otherwise the
    // same assertion.
    await expect(region.querySelectorAll(`[${NOTE_STRIP_ATTR}]`)).toHaveLength(1);

    await userEvent.click(
      within(region).getByRole("button", { name: "Cards on The one-drop suite" }),
    );

    // Named for the note it was opened over — a reader may meet this dialog over several notes in
    // one session, and the heading is the only thing that says which.
    const picker = await canvas.findByRole("dialog", { name: "The one-drop suite" });

    // **One checkbox per card of the deck, ticked or not**, so un-naming is unticking rather than
    // a second control and the two halves cannot come to disagree about what is named. The write
    // names the card *and* the note, because another note's picker could be open on the same card.
    await userEvent.click(
      within(picker).getByRole("checkbox", { name: "Name Goblin Guide in The one-drop suite" }),
    );
    await expect(args.onDetach).toHaveBeenCalledWith(1, "o-goblin");

    // The deck's fifth card is offered unticked rather than left out: the picker draws the deck
    // and not the difference, which is what lets one gesture do both jobs.
    const mountain = within(picker).getByRole("checkbox", {
      name: "Name Mountain in The one-drop suite",
    });
    await expect(mountain).not.toBeChecked();
    await userEvent.click(mountain);
    await expect(args.onAttach).toHaveBeenCalledWith(1, "o-mountain");
  },
};

/**
 * **The read was refused, which is not the same silence as a deck with no notes.**
 *
 * An empty list and a failed query look identical and mean opposite things — the rule the card
 * modal's four combo states already carry, met here at the band. So the sentence is drawn
 * **outside** the collapsible region: a read refused while the band is shut still owes the reader
 * an answer, and a band that silently counted nothing would be the app asserting a fact it does
 * not have.
 *
 * `answered` is `false` here rather than `true` with an empty list, because that is what a
 * refusal actually is: not pending, and holding no rows. The count beside the heading is absent
 * for the same reason.
 */
export const ReadFailed: Story = {
  args: {
    answered: false,
    failure: "the deck's notes could not be read: database is locked",
  },
  play: async ({ canvas }) => {
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "the deck's notes could not be read: database is locked",
    );

    // Not captioned as an empty deck, and not counted either.
    await expect(canvas.queryByText(/^No notes on this deck yet/)).toBeNull();
    await expect(canvas.queryByText(/^\d+ notes?$/)).toBeNull();
  },
};
