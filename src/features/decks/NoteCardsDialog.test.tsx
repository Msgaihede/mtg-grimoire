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

function open(over: Partial<ComponentProps<typeof NoteCardsDialog>> = {}) {
  const onAttach = vi.fn();
  const onDetach = vi.fn();
  render(
    <NoteCardsDialog
      open
      title="Mana base"
      named={[]}
      attachable={DECK}
      onAttach={onAttach}
      onDetach={onDetach}
      onClose={vi.fn()}
      {...over}
    />,
  );
  return { onAttach, onDetach };
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
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
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

  it("draws a stray no printing line and no copies count, rather than empty ones", async () => {
    // `strays` synthesises a choice with empty strings and `copies: 0`, so the two spans the row
    // would draw for a real card have nothing to say. Guarded, they are absent; unguarded they
    // are a lone ` · ` and a `0×` — both of which read as facts about the card. The deck's own
    // rows are asserted beside it so an assertion that passed by drawing *nothing* would fail.
    open({ named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: null }] });

    const stray = screen.getByRole("checkbox", { name: /Goblin Piledriver/ }).closest("li");
    expect(stray).not.toBeNull();
    // The one thing that is true of it, drawn where the printing would have been.
    expect(stray).toHaveTextContent("No longer in this deck");
    expect(stray?.textContent).not.toContain("·");
    expect(stray?.textContent).not.toContain("×");

    // The same two marks on a row the deck does hold, so an assertion that passed by drawing
    // nothing at all would fail here.
    const bolt = screen.getByRole("checkbox", { name: /Lightning Bolt/ }).closest("li");
    expect(bolt?.textContent).toContain("LEA · 161");
    expect(bolt?.textContent).toContain("4×");
  });
});
