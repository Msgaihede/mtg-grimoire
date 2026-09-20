import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { attachableCards } from "./deckNotes";
import { NoteCardsDialog } from "./NoteCardsDialog";
import { card } from "./validation/fixtures";

/**
 * The deck this picker is offered over, through the derivation the app hands it.
 *
 * Built with `attachableCards` rather than written out as `NoteCardChoice` literals, which is
 * the opposite of `DeckNotesPanel.stories.tsx`' call and right for the opposite reason: a story
 * is a statement about what a component *draws* and must not depend on a derivation it is not
 * about, where these cases are about the chips — and a chip's count, its key and its label all
 * come out of `typeBucket`, so a hand-written `typeBucket: "Land"` would make the `Land` chip
 * pass whatever that function actually answers for `Basic Land — Mountain`.
 *
 * Three cards, one per bucket, so every chip below is a count of exactly one and a narrowing
 * that answered "everything" could not pass.
 */
const DECK = attachableCards([
  card({
    cardId: "1",
    oracleId: "o-guide",
    name: "Goblin Guide",
    typeLine: "Creature — Goblin Scout",
    quantity: 4,
  }),
  card({
    cardId: "2",
    oracleId: "o-mountain",
    name: "Mountain",
    typeLine: "Basic Land — Mountain",
    quantity: 20,
  }),
  card({
    cardId: "3",
    oracleId: "o-bolt",
    name: "Lightning Bolt",
    typeLine: "Instant",
    quantity: 4,
  }),
]);

type Props = ComponentProps<typeof NoteCardsDialog>;

function open(over: Partial<Props> = {}) {
  const onAttach = vi.fn();
  const onDetach = vi.fn();
  const onClose = vi.fn();
  const props = (extra: Partial<Props> = {}): Props => ({
    open: true,
    title: "Mana base",
    named: [],
    attachable: DECK,
    onAttach,
    onDetach,
    onClose,
    ...over,
    ...extra,
  });
  const view = render(<NoteCardsDialog {...props()} />);
  return {
    onAttach,
    onDetach,
    onClose,
    /** Redraw with one prop moved. Every tick in this dialog is a write, so what the reader sees
     *  next is the host handing back new props — which is the only way to reach a state where a
     *  chip the reader has already pressed is no longer one of the rungs. */
    redraw: (extra: Partial<Props>) => view.rerender(<NoteCardsDialog {...props(extra)} />),
  };
}

describe("naming cards in a note", () => {
  it("names the note in its heading and says what the dialog is for", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "Mana base" })).toBeInTheDocument();
    expect(screen.getByText("Which cards this note is about")).toBeInTheDocument();
  });

  it("gives every checkbox the card's own name, never a bare Select", async () => {
    open();
    // A column of checkboxes sharing one name is a column a screen reader cannot tell apart.
    expect(screen.getByRole("checkbox", { name: /Goblin Guide/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).toBeInTheDocument();
  });

  it("ticks a card the note already names", async () => {
    open({ named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }] });
    expect(screen.getByRole("checkbox", { name: /Lightning Bolt/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).not.toBeChecked();
  });

  it("attaches on the tick rather than on a Save that does not exist", async () => {
    const { onAttach } = open();
    await userEvent.click(screen.getByRole("checkbox", { name: /Mountain/ }));
    expect(onAttach).toHaveBeenCalledWith("o-mountain");
  });

  it("detaches on the untick, and the note stays where it is", async () => {
    const { onDetach } = open({
      named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }],
    });
    await userEvent.click(screen.getByRole("checkbox", { name: /Lightning Bolt/ }));
    expect(onDetach).toHaveBeenCalledWith("o-bolt");
  });

  it("narrows to a type on a chip, counting cards and not copies", async () => {
    open();
    // 20 Mountains are one row and one thing a note can name.
    await userEvent.click(screen.getByRole("radio", { name: /^Land, 1 card$/ }));
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Goblin Guide/ })).not.toBeInTheDocument();
  });

  it("narrows to what the note already names", async () => {
    open({ named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }] });
    await userEvent.click(screen.getByRole("radio", { name: /^Named, 1 card$/ }));
    expect(screen.getByRole("checkbox", { name: /Lightning Bolt/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Mountain/ })).not.toBeInTheDocument();
  });

  it("finds a card by typing, and says so when nothing matches", async () => {
    open();
    const box = screen.getByRole("searchbox");

    // The positive half. Without it the needle arm can be mutated to match **nothing** and every
    // case here still passes, because an absence assertion is satisfied by a filter that hides
    // everything — which is exactly what a broken needle does.
    await userEvent.type(box, "moun");
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Goblin Guide/ })).not.toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/No card in this deck matches/)).toBeInTheDocument();
  });

  it("says a deck with nothing in it has nothing to name, which is not a no-match", async () => {
    open({ attachable: [] });
    expect(screen.getByText("This deck has no cards to name yet.")).toBeInTheDocument();
  });

  it("keeps a card the note names even when the deck no longer holds it", async () => {
    // The standing sentence: cutting a card never takes the note with it.
    open({ named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: null }] });
    expect(screen.getByRole("checkbox", { name: /Goblin Piledriver/ })).toBeChecked();
  });

  it("draws no picture for a named card the corpus knows no printing of", async () => {
    // The *rare* stray, and the only one whose frame is empty. `cardId` is null when
    // `attachments_by_note`'s corpus-wide subquery found nothing at all — never because the deck
    // row went, which is what the test above asserts. The box is still drawn: an omitted frame
    // would put this row's name in a different column from every other row's.
    open({ named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: null }] });

    const orphan = screen.getByRole("checkbox", { name: /Goblin Piledriver/ }).closest("li");
    expect(orphan?.querySelector("img")).toBeNull();
    expect(orphan?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("says the standing sentence, and offers Done as the only way out", async () => {
    // **The footer was fenced by nothing**: deleting it whole left every other case here green,
    // and the two absence assertions in the tick case pass *better* without it. The sentence is
    // one of this redesign's global constraints — it is the whole reason a stray row exists — so
    // it is asserted rather than assumed, and so is the one press beside it. A `Cancel` would be a
    // lie about what the ticks above have already written, so its absence is asserted too.
    const { onClose } = open();

    expect(
      screen.getByText(
        "A note keeps the cards it names even after they leave the deck — cutting a card never " +
          "takes the note with it.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("falls back to All when the rung the reader pressed stops existing", async () => {
    // **A type rung is drawn only where the deck has cards of that type, and the rows behind one
    // can go while it is pressed.** A stray is the reachable case: it is the only `Other` row
    // here, so unticking it takes the rung away in the same render — and the reader is left with
    // a radiogroup carrying no `aria-checked="true"` rung at all, over a list saying nothing
    // matches. That is a narrowing nothing on screen can undo.
    //
    // It has to be driven through a **redraw**, because the press is legal when it is made and
    // only the write that follows moves the rungs. Asserting the opening state instead is a case
    // that can never fail — which is what the first version of this one did.
    const { redraw } = open({
      named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: null }],
    });

    await userEvent.click(screen.getByRole("radio", { name: "Other, 1 card" }));
    expect(screen.getByRole("checkbox", { name: /Goblin Piledriver/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Mountain/ })).not.toBeInTheDocument();

    redraw({ named: [] });

    expect(screen.queryByRole("radio", { name: /^Other,/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All, 3 cards" })).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("draws a stray no printing line and no copies count, rather than empty ones", async () => {
    // **The ordinary stray keeps its picture**, which is the case this asserts: `deck_notes.rs`
    // resolves a printing over the whole corpus, so cutting a card takes its deck row and not its
    // art. What it has no answer for is the printing, the type and the count — `strays`
    // synthesises all three — so the two spans the row would draw for a deck card have nothing to
    // say. Guarded they are absent; unguarded they are a lone ` · `, a bucket nobody assigned and
    // a `0×`. The deck's own rows are asserted beside it so an assertion that passed by drawing
    // *nothing at all* would fail.
    open({
      named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: "cut-printing" }],
    });

    const stray = screen.getByRole("checkbox", { name: /Goblin Piledriver/ }).closest("li");
    expect(stray).not.toBeNull();
    // The one thing that is true of it, drawn where the printing would have been.
    expect(stray).toHaveTextContent("No longer in this deck");
    expect(stray?.textContent).not.toContain("·");
    expect(stray?.textContent).not.toContain("×");
    // And the frame is a picture rather than a hole, because the card still has a printing.
    expect(stray?.querySelector("img")).not.toBeNull();

    // The same two marks on a row the deck does hold, so an assertion that passed by drawing
    // nothing at all would fail here.
    const bolt = screen.getByRole("checkbox", { name: /Lightning Bolt/ }).closest("li");
    expect(bolt?.textContent).toContain("LEA · 161");
    expect(bolt?.textContent).toContain("4×");
  });
});
