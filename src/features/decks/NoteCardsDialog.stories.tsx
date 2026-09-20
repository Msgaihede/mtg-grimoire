import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";
import type { DeckNoteCard } from "@/lib/ipc";
import { NoteCardsDialog } from "./NoteCardsDialog";
import type { NoteCardChoice } from "./deckNotes";

/**
 * The deck this picker is offered over.
 *
 * Written out as `NoteCardChoice` literals rather than run through `attachableCards` over
 * `DeckCard` fixtures — `DeckNotesPanel.stories.tsx`' call, for its reason: a story is a statement
 * about what a component *draws*, and building its offer with a derivation this file is not about
 * would make every state below depend on `typeBucket`. `deckNotes.test.ts` owns that derivation
 * and `NoteCardsDialog.test.tsx` exercises the chips through it.
 *
 * **The card ids are the workbench corpus's own**, so the art frames draw real crops through
 * `@/lib/images`, which `.storybook/main.ts` aliases to the fake. Five cards over three buckets,
 * so the chip row has something to narrow and the `Land` rung is a count of more than one.
 */
const ATTACHABLE: NoteCardChoice[] = [
  {
    oracleId: "o-recall",
    name: "Ancestral Recall",
    cardId: "70e7ddf2-5604-41e7-bb9d-ddd03d3e9d0b",
    setCode: "lea",
    collectorNumber: "47",
    typeBucket: "Instant",
    copies: 1,
  },
  {
    oracleId: "o-lotus",
    name: "Black Lotus",
    cardId: "b0faa7f2-b547-42c4-a810-839da50dadfe",
    setCode: "lea",
    collectorNumber: "232",
    typeBucket: "Artifact",
    copies: 1,
  },
  {
    oracleId: "o-forest",
    name: "Forest",
    cardId: "5dda1113-352c-471a-a7e0-a9a3cb3f19c5",
    setCode: "unf",
    collectorNumber: "239",
    typeBucket: "Land",
    copies: 12,
  },
  {
    oracleId: "o-island",
    name: "Island",
    cardId: "90a57c0e-fa61-45ef-955d-d296403967d5",
    setCode: "lea",
    collectorNumber: "288",
    typeBucket: "Land",
    copies: 10,
  },
  {
    oracleId: "o-bolt",
    name: "Lightning Bolt",
    cardId: "d573ef03-4730-45aa-93dd-e45ac1dbaf4a",
    setCode: "lea",
    collectorNumber: "161",
    typeBucket: "Instant",
    copies: 4,
  },
];

/** One card the note already names, as `deck_notes` answers it — a `DeckNoteCard` carries the
 *  oracle id, the name and a printing, and nothing else: no set, no type, no count. */
function namedCard(over: Partial<DeckNoteCard> & { oracleId: string; name: string }): DeckNoteCard {
  return { cardId: null, ...over };
}

/**
 * Which cards a note is about — the whole of what replaced the in-row picker.
 *
 * **There is no Save, and that is the shape rather than an omission.** A tick writes
 * `note_card_attach` and an untick writes `note_card_detach`, the moment it lands, exactly as the
 * row actions did before this dialog existed — so the footer carries one `Done` and no `Cancel`,
 * which would be a lie about what the last ten presses did. Every story below asserts at the
 * callback rather than on the screen, because the screen is the host's answer and not this
 * component's.
 *
 * **The picker offers the deck's cards and nothing wider.** A note is about a card *in this
 * deck* — but a card that later leaves the deck keeps its note, so this list narrows what can be
 * *added* and never what is already named. {@link NamesACardTheDeckCut} is that promise drawn.
 *
 * **Drawn over plain props, like `DeckNotesPanel` beside it.** The states below are shapes of one
 * note against one deck: an empty deck, a stray, a chip pressed. None of them is a seeded world,
 * and standing up a world to reach them would make each story a statement about the seed.
 */
const meta = {
  title: "Decks/NoteCardsDialog",
  component: NoteCardsDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    title: "Mana base",
    // **The casts are what let the stories below exist.** `StoryObj<typeof meta>` takes each
    // argument's type from the value written here, so a bare `[]` would type `named` as `never[]`
    // and no story could set one. `DeckStats`' `onPull`, three bands over, and the same reason.
    named: [] as DeckNoteCard[],
    attachable: ATTACHABLE as NoteCardChoice[],
    onAttach: fn(),
    onDetach: fn(),
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Which cards a note is about, over the open deck's own cards.\n\n" +
          "**Ticking is the write.** Each tick attaches or detaches immediately, so the footer " +
          "carries one `Done` and no `Cancel` — a cancel here could only undo nothing.\n\n" +
          "**The chips count cards and never copies.** Twenty Mountains are one row and one " +
          "thing a note can name, so a `Land` chip beside a list showing one Land row would be " +
          "two numbers for one fact. Each chip spells its count into its own `aria-label`, " +
          "because a label and a count separated by a CSS `gap` compute to `Land1`.\n\n" +
          "**A card the deck no longer holds is still named.** It is drawn at the head of the " +
          "list, ticked, with an empty frame — and with the one thing that is true of it where " +
          "its printing would have been, rather than a lone separator and a `0×`.",
      },
    },
  },
} satisfies Meta<typeof NoteCardsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **A deck with nothing in it, which is every deck for as long as it takes to add a card.**
 *
 * *The deck holds nothing* and *your filter hid everything* look identical on screen and mean
 * opposite things, and only the second is one a reader can act on — so they are two sentences and
 * this is the first. The chips are still drawn: `All` and `Named` are rungs a deck always has, at
 * zero, which is what `typeChipCounts` means by drawing `Named` at zero and the type rungs only
 * where the deck has them.
 */
export const Empty: Story = {
  args: { attachable: [] },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("This deck has no cards to name yet."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("checkbox")).toBeNull();

    // No type rungs, because the deck has no types — but the two that are always true are here.
    await expect(canvas.getByRole("radio", { name: "All, 0 cards" })).toBeInTheDocument();
    await expect(canvas.getByRole("radio", { name: "Named, 0 cards" })).toBeInTheDocument();
  },
};

/**
 * A note that names nothing yet, over a deck of five cards.
 *
 * Every checkbox is named for its own card rather than for what pressing it would do: a column of
 * five controls called `Select` is five controls a screen reader cannot tell apart, and a name
 * that moved with the tick would rename itself under the reader's finger. The note is in the name
 * too, because a reader meets this dialog over several notes in one session.
 */
export const NothingNamed: Story = {
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByText("0 named")).toBeInTheDocument();

    const forest = canvas.getByRole("checkbox", { name: "Name Forest in Mana base" });
    await expect(forest).not.toBeChecked();

    // The tick *is* the write — there is nothing else to press.
    await userEvent.click(forest);
    await expect(args.onAttach).toHaveBeenCalledWith("o-forest");
    await expect(canvas.queryByRole("button", { name: "Save" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Cancel" })).toBeNull();
  },
};

/**
 * Two cards named, and the `Named` rung that finds them again.
 *
 * The readout beside the chips says `2 named` rather than being read off the `Named` chip: a
 * reader who has narrowed to `Land` is looking at a chip that says something else, so the one
 * number that is always about the note is spelled out at the end of the row.
 */
export const SomeNamed: Story = {
  args: {
    named: [
      namedCard({ oracleId: "o-forest", name: "Forest", cardId: ATTACHABLE[2]!.cardId }),
      namedCard({ oracleId: "o-island", name: "Island", cardId: ATTACHABLE[3]!.cardId }),
    ],
  },
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByText("2 named")).toBeInTheDocument();
    await expect(canvas.getByRole("checkbox", { name: "Name Forest in Mana base" })).toBeChecked();
    await expect(
      canvas.getByRole("checkbox", { name: "Name Black Lotus in Mana base" }),
    ).not.toBeChecked();

    // Narrowing to what the note names is the reader's way of checking their own work.
    await userEvent.click(canvas.getByRole("radio", { name: "Named, 2 cards" }));
    await expect(canvas.queryByRole("checkbox", { name: /Black Lotus/ })).toBeNull();

    // And the untick is the detach, in the same press the tick was the attach.
    await userEvent.click(canvas.getByRole("checkbox", { name: "Name Island in Mana base" }));
    await expect(args.onDetach).toHaveBeenCalledWith("o-island");
  },
};

/**
 * The `Land` chip pressed — **two cards, twenty-two copies, and the chip says two.**
 *
 * A chip counts the rows pressing it draws, because a note names a *card* and twelve Forests are
 * one thing it can name. The count is spelled into the `aria-label` as a sentence rather than
 * left to the DOM: the label and the digit are two elements separated by a `gap`, which is CSS
 * and not a text node, so the computed name of an unspelled chip is `Land2`.
 */
export const NarrowedToALand: Story = {
  play: async ({ canvas }) => {
    const land = await canvas.findByRole("radio", { name: "Land, 2 cards" });
    await userEvent.click(land);
    await expect(land).toHaveAttribute("aria-checked", "true");

    await expect(canvas.getByRole("checkbox", { name: /Forest/ })).toBeInTheDocument();
    await expect(canvas.getByRole("checkbox", { name: /Island/ })).toBeInTheDocument();
    await expect(canvas.queryByRole("checkbox", { name: /Lightning Bolt/ })).toBeNull();

    // The row still says which bucket it is in, so a reader can see why it survived the press.
    await expect(canvas.getAllByText("Land")).toHaveLength(2);
  },
};

/**
 * **A card the deck no longer holds, drawn at the head of the list and still ticked.**
 *
 * This is the footer's standing sentence made visible: cutting a card never takes the note with
 * it. The row is synthesised from the `DeckNoteCard` the note carries, which has no printing at
 * all — so `setCode`, `collectorNumber` and `copies` are empty strings and a zero, and none of
 * them is a fact about the card. Unguarded the row reads `Goblin Piledriver · Other0×`: a lone
 * separator, a bucket nobody assigned, and a count of nothing. It says what is true of it
 * instead, which is also what explains the empty frame beside it.
 *
 * It is at the **head** so the unticking press is reachable without hunting: the deck's own cards
 * are sorted by name and a cut card sorts nowhere in particular.
 */
export const NamesACardTheDeckCut: Story = {
  args: {
    named: [
      namedCard({ oracleId: "o-piledriver", name: "Goblin Piledriver" }),
      namedCard({ oracleId: "o-bolt", name: "Lightning Bolt", cardId: ATTACHABLE[4]!.cardId }),
    ],
  },
  play: async ({ canvas, args }) => {
    const stray = await canvas.findByRole("checkbox", {
      name: "Name Goblin Piledriver in Mana base",
    });
    await expect(stray).toBeChecked();

    const row = stray.closest("li")!;
    await expect(row).toHaveTextContent("No longer in this deck");
    await expect(row.textContent).not.toContain("·");
    await expect(row.textContent).not.toContain("×");

    // First in the list, above every card the deck does hold.
    const rows = canvas.getAllByRole("checkbox");
    await expect(rows[0]).toBe(stray);

    // And the one press it is there for still works.
    await userEvent.click(stray);
    await expect(args.onDetach).toHaveBeenCalledWith("o-piledriver");
  },
};
