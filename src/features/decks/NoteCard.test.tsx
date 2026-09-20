/**
 * One note as a card in the band's masonry.
 *
 * **Nothing here mounts a `QueryClientProvider` and nothing stubs IPC**, which is the property
 * worth stating rather than the coverage: this card reaches no backend at all — it is handed a
 * `DeckNote` and three callbacks — so a stray query added to it fails this suite rather than the
 * review. `DeckSettingsForm.test.tsx` makes the same promise the same way.
 *
 * The art crops resolve through `cardArtSrc`, which branches on `__CORE__` — pinned to `"tauri"`
 * by `vite.config.ts`, so a frame with a printing really does draw an `<img>` here and the orphan
 * case is a measurable absence rather than a vacuous one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeckNote, DeckNoteCard } from "@/lib/ipc";
import { NOTE_THUMBS, NoteCard } from "./NoteCard";

function note(over: Partial<DeckNote> & { id: number }): DeckNote {
  return {
    deckId: 4,
    title: "",
    body: "",
    sortOrder: over.id,
    cards: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Five named cards, each with a printing to draw — one more than {@link NOTE_THUMBS} plus the
 *  one the `+N more` chip is written about. */
function five(): DeckNoteCard[] {
  return ["Krenko, Mob Boss", "Goblin Chieftain", "Purphoros", "Skirk Prospector", "Goblin Matron"]
    .map((name, i) => ({ oracleId: `o-${i}`, name, cardId: `c-${i}` }));
}

function draw(note: DeckNote, over: Partial<React.ComponentProps<typeof NoteCard>> = {}) {
  return render(
    <ul>
      <NoteCard
        note={note}
        focused={null}
        onEdit={vi.fn()}
        onCards={vi.fn()}
        onDelete={vi.fn()}
        {...over}
      />
    </ul>,
  );
}

describe("a note as a card", () => {
  it("names a blank-titled note by its body's first line, in its controls too", () => {
    draw(note({ id: 1, title: "", body: "Ask Supreme about the Bolt count" }));
    // **`getByText` cannot ask this, and the brief's draft of the test used it.** A blank title
    // is *drawn* as the body's first line, so that one string is on the card five times over —
    // the name line, the body's own run, and the three `sr-only` halves of `actionLabel` — and
    // the query throws *found multiple*. So the name line is read structurally and the controls
    // by their computed names, which is exactly the two halves this claim is about.
    expect(screen.getByRole("listitem").firstElementChild).toHaveTextContent(
      "Ask Supreme about the Bolt count",
    );
    for (const name of [
      "Cards on Ask Supreme about the Bolt count",
      "Edit Ask Supreme about the Bolt count",
      "Delete Ask Supreme about the Bolt count",
    ]) {
      // `toHaveAccessibleName`'s reason, from the other end: the verb and the title are a text
      // node and a sibling span, so a `gap` or a wrapping element between them would compute to
      // `EditAsk Supreme…` and this query would find nothing.
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("renders the body rather than printing it", () => {
    draw(note({ id: 1, title: "Plan", body: "Cut the **third** land." }));
    // `parseNoteBody`'s blocks, not a string with asterisks in it.
    expect(screen.getByText("third").tagName).toBe("STRONG");
  });

  it("draws three crops and counts the rest", () => {
    const { container } = draw(
      note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }),
    );
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(NOTE_THUMBS);
    // **`plural` answers `2 more cards` and not `Two more cards`** — the brief's own assertion
    // spelled the number out, and the helper is where "never print 1 cards" is decided, so the
    // assertion is what moves rather than the component.
    expect(
      screen.getByRole("button", { name: "2 more cards in Krenko line" }),
    ).toBeInTheDocument();
    // The anti-vacuity half of the orphan case below: a card with a printing really does draw a
    // picture here, so that test's absence means something.
    expect(container.querySelectorAll("img")).toHaveLength(NOTE_THUMBS);
  });

  it("draws no strip at all for a note that names nothing", () => {
    draw(note({ id: 1, title: "Table notes", body: "Two of them are on bracket 3." }));
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("draws an empty frame for a card with no printing, never a broken image", () => {
    const { container } = draw(
      note({
        id: 1,
        title: "Cut list",
        body: "Gone.",
        cards: [{ oracleId: "o-x", name: "Ghost", cardId: null }],
      }),
    );
    expect(screen.getByRole("button", { name: "Open Ghost" })).toBeInTheDocument();
    // `querySelector` and not `queryByRole("img")`: an `<img alt="">` is presentational and would
    // answer that query with `null` whether or not it was drawn.
    expect(container.querySelector("img")).toBeNull();
  });

  it("carries no `N cards` chip — the strip is what counts them", () => {
    draw(note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }));
    expect(screen.queryByText("5 cards")).not.toBeInTheDocument();
  });

  it("claims a row span, so the masonry can place it", () => {
    draw(note({ id: 1, title: "Plan", body: "Short." }));
    // jsdom measures every box as 0, so the span is the gutter alone — the assertion is that
    // the card claims *a* span rather than the default single row, which would stack every card
    // at row 1.
    expect(screen.getByRole("listitem").style.gridRow).toBe("span 8");
  });
});
