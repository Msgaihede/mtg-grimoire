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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckNote, DeckNoteCard } from "@/lib/ipc";
import { NOTE_STRIP_ATTR, NOTE_THUMBS, NoteCard } from "./NoteCard";

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

/**
 * Five named cards, each with a printing to draw — one more than {@link NOTE_THUMBS} plus the one
 * the `+N more` chip is written about.
 *
 * **Two of the five carry a comma in their own name**, which is the fixture doing work rather than
 * flavour: the strip's `sr-only` sentence joins names with `; `, and a `, ` join would read as
 * seven items under a count that says five. The exact-string assertion below is what catches it.
 */
function five(): DeckNoteCard[] {
  return [
    "Krenko, Mob Boss",
    "Goblin Chieftain",
    "Purphoros, God of the Forge",
    "Skirk Prospector",
    "Goblin Matron",
  ].map((name, i) => ({ oracleId: `o-${i}`, name, cardId: `c-${i}` }));
}

/** The whole of what the strip says to a screen reader for {@link five}'s cards. */
const FIVE_SPOKEN =
  "Names 5 cards: Krenko, Mob Boss; Goblin Chieftain; Purphoros, God of the Forge; " +
  "Skirk Prospector; Goblin Matron.";

/** The art strip, which has no role and no name of its own — see {@link NOTE_STRIP_ATTR}. */
function strip(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[${NOTE_STRIP_ATTR}]`);
  if (el === null) throw new Error("no art strip on this card");
  return el;
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
    // is *drawn* as the body's first line, so that exact string is on the card **four** times —
    // the name line, the body's own inline run, and the `sr-only` halves of `Edit` and `Delete`
    // — and the query throws *found multiple*. (`Cards`' span is not a fifth: `actionLabel`
    // gives it `on Ask Supreme…`, and `getByText` is exact by default. Nor are the `<li>`, the
    // `<p>` or the body `<div>`: `getNodeText` concatenates a node's *direct* text children
    // only, so an element whose text is all in a descendant never matches.) So the name line is
    // read structurally and the controls by their computed names, which is exactly the two
    // halves this claim is about.
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

  it("draws three crops and counts the rest, as decoration with one control", () => {
    const { container } = draw(
      note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }),
    );
    // **No `onOpenCard`, which is what the band passes** — so the crops are `aria-hidden` frames
    // with no role, no name and no tab stop, and the chip is the strip's only control. Three
    // named buttons per card that did nothing when pressed is what this branch exists to avoid.
    expect(screen.queryAllByRole("button", { name: /^Open / })).toHaveLength(0);
    expect(within(strip(container)).getAllByRole("button")).toHaveLength(1);
    // **`plural` answers `2 more cards` and not `Two more cards`** — the brief's own assertion
    // spelled the number out, and the helper is where "never print 1 cards" is decided, so the
    // assertion is what moves rather than the component.
    expect(
      screen.getByRole("button", { name: "2 more cards in Krenko line" }),
    ).toBeInTheDocument();
    // Three crops are still *drawn*, which is both the point of the strip and the anti-vacuity
    // half of the orphan case below: a card with a printing really does draw a picture here, so
    // that test's absence means something.
    expect(container.querySelectorAll("img")).toHaveLength(NOTE_THUMBS);
  });

  it("says the count and every name it does not draw, in one sr-only sentence", () => {
    draw(note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }));
    // **All five, not the three the strip draws** — and the two card names carrying commas of
    // their own are why the separator is `; `: a `, ` join reads as seven items under a count
    // that says five. This is the one thing the redesign took away and did not put back, so the
    // whole string is asserted rather than a fragment of it.
    expect(screen.getByText(FIVE_SPOKEN)).toBeInTheDocument();
  });

  it("makes each crop a control where a host passes a handler", async () => {
    const onOpenCard = vi.fn();
    const cards = five();
    draw(note({ id: 1, title: "Krenko line", body: "Haste first.", cards }), { onOpenCard });

    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(NOTE_THUMBS);
    // The sentence is drawn on this branch too, and that is the ruling rather than an accident:
    // named buttons carry the three names that are *drawn* and say nothing about the count or the
    // two that are not, so one sentence covering both branches is one thing to keep true.
    expect(screen.getByText(FIVE_SPOKEN)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Goblin Chieftain" }));
    // The card itself, not its oracle id: a host that opens a modal needs the printing and the
    // name too, and `DeckNoteCard` is what the note already holds.
    expect(onOpenCard).toHaveBeenCalledWith(cards[1]);
  });

  it("draws no strip at all for a note that names nothing", () => {
    const { container } = draw(
      note({ id: 1, title: "Table notes", body: "Two of them are on bracket 3." }),
    );
    // **The container's absence, not its contents'.** Asserting only that there is no `Open …`
    // button and no `+N more` is equally true of an *empty* strip — deleting the
    // `note.cards.length > 0` guard leaves a childless `<div>` behind, and both of the lines
    // below go on passing under a test whose title says "no strip at all". Mutation run and
    // recorded in the task report: without this line the suite stays green over the defect.
    expect(container.querySelector(`[${NOTE_STRIP_ATTR}]`)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    // And nothing is *said* either. The sentence lives inside the strip, so a note that names
    // nothing announces nothing rather than `Names 0 cards:` with an empty list after it.
    expect(screen.queryByText(/^Names /)).not.toBeInTheDocument();
  });

  it("draws an empty frame for a card with no printing, never a broken image", () => {
    const { container } = draw(
      note({
        id: 1,
        title: "Cut list",
        body: "Gone.",
        cards: [{ oracleId: "o-x", name: "Ghost", cardId: null }],
      }),
      // A handler, so this also pins the half of the frame's doc that only the control branch can
      // show: a frame with no bytes in it is still a control that goes somewhere.
      { onOpenCard: vi.fn() },
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
