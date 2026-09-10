import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckNote } from "@/lib/ipc";
import { NOTES_HEADING, NotesBand } from "./DeckNotesPanel";

/**
 * One note, with everything a row can carry.
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

/** The deck this band is drawn over — the picker's whole offer, deduped by oracle id and by
 *  name, which is what `attachableCards` hands it in the app. */
const ATTACHABLE = [
  { oracleId: "o-bolt", name: "Lightning Bolt" },
  { oracleId: "o-goblin", name: "Goblin Guide" },
  { oracleId: "o-monastery", name: "Monastery Swiftspear" },
  { oracleId: "o-eidolon", name: "Eidolon of the Great Revel" },
  { oracleId: "o-mountain", name: "Mountain" },
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
 * over one pinned dialect, no library, no HTML string. Editing mounts Tiptap through
 * `React.lazy`, which is **141.5 kB gzip** against the app's own 481.45 kB — so a band showing
 * twenty notes costs the main chunk nothing, and pressing Edit is what fetches it. None of the
 * stories below presses Edit, which is the point rather than an omission.
 *
 * **A note stays in this list whether it names no cards or four.** That is issue #447's central
 * sentence — the card is a reference the note holds, never a place the note lives — and it is
 * why {@link NamingFourCards} is a story rather than a footnote: the note with the most cards on
 * it is drawn in exactly the same row as the one with none.
 *
 * **Add first**, which is `LabelsDialog`'s ordering and its reason: a reader with no notes is who
 * this screen is hardest for, and {@link Empty} is that reader.
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
          "pressing Edit is what fetches Tiptap, behind `React.lazy`.\n\n" +
          "**Adding comes first**, above the list rather than under it: a reader with no notes " +
          "is who this screen is hardest for.\n\n" +
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
 * disclose. Here the empty band is precisely where the reader has something to do: the way to
 * write a first note is *inside* it.
 *
 * The count beside the heading is absent rather than zero — a bare `0 notes` next to a sentence
 * saying so is the same fact twice.
 */
export const Empty: Story = {
  play: async ({ canvas, args }) => {
    const disclosure = await canvas.findByRole("button", { name: NOTES_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.queryByText(/^\d+ notes?$/)).toBeNull();

    await expect(
      canvas.getByText("No notes on this deck yet — name one above, then write it out."),
    ).toBeInTheDocument();

    // Add first: the field is above the sentence, and it is the only thing on screen a reader
    // with no notes can press.
    const field = canvas.getByLabelText("New note title");
    await userEvent.type(field, "Mana base");
    await userEvent.click(canvas.getByRole("button", { name: "Add note" }));
    await expect(args.onCreate).toHaveBeenCalledWith("Mana base");

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

    // Every control on the row names the row it acts on, spelled rather than assembled — a CSS
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

    // No card-count chip on a note that names none.
    await expect(within(region).queryByText(/^\d+ cards?$/)).toBeNull();

    // The body is rendered, not printed: the emphasis is an element, and the bullet is a real
    // list marker rather than a glyph in a span — so it stays out of the row's own text.
    await expect(within(region).getByText("one short")).toBeInTheDocument();
    const item = within(region).getByText("Swap a Mountain in");
    await expect(item.closest("ul")).not.toBeNull();
    await expect(item).toHaveTextContent("Swap a Mountain in");
  },
};

/**
 * **Many notes, which is the shape the old single `decks.notes` column could not hold at all.**
 *
 * Each one is managed and deleted on its own — that is the issue's ask — so every row carries its
 * own three controls and its own confirmation. Only one row's panel is ever open at a time: a
 * band with three rows unfolded is a band with no list left in it.
 *
 * The last row has a **blank title** and reads as its body's first line, computed at render and
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
        cards: [{ oracleId: "o-eidolon", name: "Eidolon of the Great Revel" }],
      }),
      note({ id: 3, title: "Budget", body: "The fetchlands can wait." }),
      note({ id: 4, title: "", body: "Ask Supreme about the Bolt count" }),
    ],
  },
  play: async ({ canvas, args }) => {
    const region = await canvas.findByRole("region", { name: NOTES_HEADING });
    await expect(within(region).getByText("4 notes")).toBeInTheDocument();

    // The blank-titled note stands on its body's first line — and it is a control's name too,
    // so the fallback reaches the reader who cannot see the row.
    await expect(
      within(region).getByRole("button", { name: "Edit Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();

    // A destructive press asks first, and the question says what it does and does not reach.
    await userEvent.click(within(region).getByRole("button", { name: "Delete Sideboard plan" }));
    const question = await within(region).findByRole("group", { name: "Delete Sideboard plan" });
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
 * and a link. Nothing is truncated in the string — a row grows to hold what the reader wrote,
 * because a note cut off halfway is a note that has stopped being one.
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
 * **One note naming four cards — the issue's own sentence, drawn.**
 *
 * *"A note may have any number of attached cards, since it may refer to multiple cards"*, and
 * *"notes should always appear in the notes list, even when they are attached to a card"*. Both
 * halves are visible here at once: the row is an ordinary row of the list, with a card-count chip
 * where a note with none has nothing.
 *
 * The `Cards` panel is where a card is named or un-named, and it is a row action **beside** Edit
 * rather than inside it — reaching it through the editor would make a reader load 141.5 kB of
 * ProseMirror in order to name a card. The picker offers the deck's own cards, minus the four
 * this note already names.
 */
export const NamingFourCards: Story = {
  args: {
    notes: [
      note({
        id: 1,
        title: "The one-drop suite",
        body: "All four of these want to be on the play.",
        cards: [
          { oracleId: "o-bolt", name: "Lightning Bolt" },
          { oracleId: "o-goblin", name: "Goblin Guide" },
          { oracleId: "o-monastery", name: "Monastery Swiftspear" },
          { oracleId: "o-eidolon", name: "Eidolon of the Great Revel" },
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
    await expect(within(region).getByText("4 cards")).toBeInTheDocument();

    await userEvent.click(
      within(region).getByRole("button", { name: "Cards on The one-drop suite" }),
    );

    // Un-naming one names the card and the note, because a second note's panel could be open on
    // the same card.
    const detach = await within(region).findByRole("button", {
      name: "Detach Goblin Guide from The one-drop suite",
    });
    await userEvent.click(detach);
    await expect(args.onDetach).toHaveBeenCalledWith(1, "o-goblin");

    // The picker offers the deck's fifth card and not the four already named — a press that could
    // only fold into a row that is already there is a press with nothing to do.
    await expect(
      within(region).getByRole("button", { name: "Name Mountain in The one-drop suite" }),
    ).toBeInTheDocument();
    await expect(
      within(region).queryByRole("button", { name: "Name Lightning Bolt in The one-drop suite" }),
    ).toBeNull();

    await userEvent.click(
      within(region).getByRole("button", { name: "Name Mountain in The one-drop suite" }),
    );
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
