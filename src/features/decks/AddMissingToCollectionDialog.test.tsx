import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckMissingRow, DeckQuickAddWish } from "@/lib/ipc";
import {
  AddMissingToCollectionDialog,
  type AddMissingWrite,
} from "./AddMissingToCollectionDialog";

/** One wishlist line as `deck_quick_add_wishes` answers one — at the root, which is the
 *  commonest place a wish sits and the one whose name the *page* has to supply. */
function wish(over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish {
  return { id: 1, quantity: 4, folderId: null, folderName: null, ...over };
}

/**
 * One printing the live list is short of, with no wishlist line against it — the majority of
 * every real plan, and the row with nothing to say beyond what it is.
 *
 * `wishes` is empty by default so that a case turning it on is showing the wish half rather than
 * a fixture: the sentence beside a row is the one thing here that is decided by a field the
 * reader cannot see.
 */
function row(over: Partial<DeckMissingRow> = {}): DeckMissingRow {
  return {
    cardId: "bolt-m10",
    name: "Lightning Bolt",
    setCode: "m10",
    collectorNumber: "146",
    finish: null,
    short: 3,
    categories: ["Removal"],
    imageUris: null,
    wishes: [],
    ...over,
  };
}

/** A second row, so every claim about *one* row is scoped rather than being the only thing the
 *  panel could have matched. */
const SOL_RING = row({
  cardId: "ring-c21",
  name: "Sol Ring",
  setCode: "c21",
  collectorNumber: "263",
  short: 2,
  categories: ["Ramp", "Artifacts"],
});

/** The write the footer's one button makes, in whatever state a case needs it. */
function writer(over: Partial<AddMissingWrite> = {}): AddMissingWrite {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    ...over,
  };
}

interface Options {
  rows?: readonly DeckMissingRow[] | null;
  loading?: boolean;
  readError?: string | null;
  add?: Partial<AddMissingWrite>;
  /** Two focusable siblings outside the panel, for the Tab sweep. See its own comment. */
  neighbours?: boolean;
}

/**
 * Mount the dialog open, with no query client and no provider of any kind.
 *
 * **That is the assertion this helper quietly makes on every case.** The component's whole
 * contract is that the read and the write arrive as props — `DeckSettingsForm`'s fence — so a
 * stray query or mutation added to it later fails the suite here rather than in a review.
 */
function open(options: Options = {}) {
  const add = writer(options.add);
  const onClose = vi.fn();
  const dialog = (
    <AddMissingToCollectionDialog
      open
      deckName="Burn"
      rows={options.rows === undefined ? [row()] : options.rows}
      loading={options.loading ?? false}
      readError={options.readError ?? null}
      add={add}
      onClose={onClose}
    />
  );
  const view = render(
    options.neighbours === true ? (
      <>
        <button type="button">Before</button>
        {dialog}
        <button type="button">After</button>
      </>
    ) : (
      dialog
    ),
  );
  return { ...view, add, onClose };
}

/** The panel, addressed the way the app's other Tab sweeps address one. */
const panel = () => screen.getByRole("dialog", { name: "Add missing to collection" });

/**
 * The footer's readout, found by the one phrase only it carries.
 *
 * Addressed by a regex and asserted on `textContent` rather than fetched by its whole string,
 * because the wishlist clause is appended into the same paragraph — so an exact `getByText`
 * would silently be a test that only ever runs on rows with no wish.
 */
const tally = () => screen.getByText(/ across /);

/**
 * One row's box, found through the one control that is named for its printing.
 *
 * Scoping matters for every claim about a *row*: an unscoped `queryByText` over the whole panel
 * would find the other row's wish sentence and call the absence a presence.
 */
function rowFor(name: string): HTMLElement {
  const box = screen.getByRole("checkbox", { name: `Add ${name}` }).closest("li");
  if (box === null) throw new Error(`no row for ${name}`);
  return box;
}

/**
 * The wrapper the dim is drawn on — everything in the row *after* the tick.
 *
 * Reached from the checkbox rather than by a class query, because that relationship is the claim:
 * the control that undoes the state must not be inside the box the state greys.
 */
function bodyOf(name: string): HTMLElement {
  const tick = screen.getByRole("checkbox", { name: `Add ${name}` });
  const body = tick.nextElementSibling;
  if (!(body instanceof HTMLElement)) throw new Error(`no body beside ${name}`);
  return body;
}

describe("AddMissingToCollectionDialog", () => {
  /**
   * **The four states of the body, and no two of them may look alike.**
   *
   * The empty one is why these are sweeps rather than four bare cases: a reader arrives here from
   * a band saying the deck is short of a dozen cards, and drawn as a blank panel it reads as the
   * read having failed. Each case therefore asserts what it draws *and* that it is not drawing
   * one of the others.
   */
  it("says the read is in flight, and nothing else", async () => {
    open({ loading: true, rows: null });

    expect(await screen.findByText("Reading what this deck is short of…")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here can be recorded/)).not.toBeInTheDocument();
  });

  it("prints the read's own refusal where the rows would have been", async () => {
    open({ rows: null, readError: "database is locked" });

    expect(await screen.findByText("database is locked")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here can be recorded/)).not.toBeInTheDocument();
    expect(screen.queryByText("Reading what this deck is short of…")).not.toBeInTheDocument();
  });

  /**
   * An empty plan is the ordinary answer, so the panel has to say **why** the number in the stats
   * band and the number here are allowed to disagree: the plan leaves out a printing the card
   * database has dropped, because that is exactly the row the write could only refuse.
   *
   * The refusal styling is asserted by its absence — nothing here is an `alert`, because nothing
   * here has gone wrong.
   */
  it("explains an empty plan rather than drawing a blank panel", async () => {
    open({ rows: [] });

    expect(
      await screen.findByText(
        "Nothing here can be recorded — everything this deck is short of has left the card " +
          "database.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot be filed at all/)).toHaveTextContent(
      "its set, its collector number and its language are read off that row",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("draws the rows with their printing, their piles and their shortfall", async () => {
    open({ rows: [row(), SOL_RING] });

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    const bolt = rowFor("Lightning Bolt, M10 146");
    expect(within(bolt).getByText("M10 · 146")).toBeInTheDocument();
    expect(within(bolt).getByText("Short in Removal")).toBeInTheDocument();
    expect(within(bolt).getByText("of 3")).toBeInTheDocument();
    expect(
      within(rowFor("Sol Ring, C21 263")).getByText("Short in Ramp, Artifacts"),
    ).toBeInTheDocument();
  });

  /**
   * **Everything ticked at its whole shortfall, which is the press the reader almost always
   * wants.** The default is the plan and the state holds only departures from it, so this is also
   * the assertion that the dialog opens holding nothing at all.
   */
  it("opens with every row ticked at its full shortfall", async () => {
    const { add } = open({ rows: [row(), SOL_RING] });
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("checkbox", { name: "Add Lightning Bolt, M10 146" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Add Sol Ring, C21 263" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Copies of Lightning Bolt, M10 146" })).toHaveValue(
      3,
    );
    expect(tally().textContent).toBe("5 copies across 2 cards");

    await userEvent.click(screen.getByRole("button", { name: "Add 5 copies to collection" }));
    expect(add.mutate).toHaveBeenCalledWith({
      picks: [
        { cardId: "bolt-m10", finish: null, quantity: 3 },
        { cardId: "ring-c21", finish: null, quantity: 2 },
      ],
      clearWishes: true,
    });
  });

  /** Unticking is one of the reader's two amendments, and it has to reach both the number on
   *  screen and the payload — a footer that kept counting a row the press no longer carries is
   *  the failure worth pinning, because it is invisible until afterwards. */
  it("drops an unticked row from the footer count and from the picks", async () => {
    const { add } = open({ rows: [row(), SOL_RING] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("checkbox", { name: "Add Lightning Bolt, M10 146" }));

    expect(tally().textContent).toBe("2 copies across 1 card");
    await userEvent.click(screen.getByRole("button", { name: "Add 2 copies to collection" }));
    expect(add.mutate).toHaveBeenCalledWith({
      picks: [{ cardId: "ring-c21", finish: null, quantity: 2 }],
      clearWishes: true,
    });
  });

  /**
   * **The row is dimmed whole rather than emptied**, and the tick that undoes the state stays
   * outside the box the state greys.
   *
   * Asserted with `classList.contains` and never `className.includes`: the row also carries a
   * `hover:` variant, so a substring test would find the word in a class that is not the one being
   * asked about and pass before the state had changed at all.
   */
  it("dims an unticked row without dimming the tick that brings it back", async () => {
    open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    const body = bodyOf("Lightning Bolt, M10 146");
    expect(body.classList.contains("opacity-60")).toBe(false);

    const tick = screen.getByRole("checkbox", { name: "Add Lightning Bolt, M10 146" });
    await userEvent.click(tick);

    expect(body.classList.contains("opacity-60")).toBe(true);
    expect(body.contains(tick)).toBe(false);
  });

  /**
   * The reader's other amendment, and the one this dialog exists for: they bought two of the four
   * their deck wants.
   *
   * The stepper stays live on an unticked row by design, so this case keeps the row on — what is
   * being asserted is that a lowered count reaches the footer *and* the wire, which are two
   * numbers a component could easily derive twice.
   */
  it("lowers the footer count and the pick's quantity from the stepper", async () => {
    const { add } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: "Decrease Copies of Lightning Bolt, M10 146" }),
    );

    expect(tally().textContent).toBe("2 copies across 1 card");
    await userEvent.click(screen.getByRole("button", { name: "Add 2 copies to collection" }));
    expect(add.mutate).toHaveBeenCalledWith({
      picks: [{ cardId: "bolt-m10", finish: null, quantity: 2 }],
      clearWishes: true,
    });
  });

  /** The stepper cannot leave the range the backend will accept: one copy at the floor, the row's
   *  own shortfall at the ceiling. Below one is a pick `collection::ZERO_ADD` refuses and above
   *  the shortfall is `MORE_THAN_MISSING`, so both ends are the write's rules drawn as a control. */
  it("floors the stepper at one copy and caps it at the shortfall", async () => {
    open({ rows: [row({ short: 1 })] });
    await screen.findByText("Lightning Bolt");

    expect(
      screen.getByRole("button", { name: "Decrease Copies of Lightning Bolt, M10 146" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Increase Copies of Lightning Bolt, M10 146" }),
    ).toBeDisabled();
    expect(screen.getByText("of 1")).toBeInTheDocument();
  });

  /**
   * **The wish half is stated per row and pressed once**, which is the whole shape of the
   * feature: the backend acts only on an unambiguous match, so each row says which of the three
   * shapes it is *before* the press.
   *
   * `clears` is the wish's own quantity where that is the smaller number — the backend never
   * takes more off a line than the line holds — and the root is worded here rather than by the
   * backend.
   */
  it("says which folder a lone wish is cleared from", async () => {
    open({ rows: [row({ wishes: [wish({ folderId: 5, folderName: "Buy soon" })] })] });
    await screen.findByText("Lightning Bolt");

    const note = screen.getByText("Clears 3 copies off a wish in Buy soon");
    expect(note).toBeInTheDocument();
    // A statement, not a warning: a wish is not a fault and must not be coloured as one.
    expect(note).toHaveClass("text-dim");
    expect(note).not.toHaveAttribute("role");
  });

  it("words a wish at the root as the wishlist itself", async () => {
    open({ rows: [row({ short: 1, wishes: [wish({ quantity: 4 })] })] });
    await screen.findByText("Lightning Bolt");

    // One copy recorded against a wish for four takes one off it — the cap is the *press*, not
    // the line, and this is the direction the other case cannot show.
    expect(screen.getByText("Clears 1 copy off a wish in Wishlist")).toBeInTheDocument();
  });

  /** Two or more matching lines are left standing, and the reader is told so before the press
   *  rather than left to find out. The count comes off the plan and is never recounted here. */
  it("says two matching wishes are left alone", async () => {
    open({ rows: [row({ wishes: [wish({ id: 1 }), wish({ id: 2, folderName: "Buy soon" })] })] });
    await screen.findByText("Lightning Bolt");

    expect(screen.getByText("2 wishlist lines match — left alone")).toBeInTheDocument();
    expect(tally().textContent).toBe("3 copies across 1 card");
  });

  /**
   * Most cards a reader records are on no shopping list, so the ordinary row says nothing about
   * one — an absent wish is not a sentence saying there is no wish.
   *
   * Scoped to the row, because the footer's own checkbox says *wishlist* on every open: an
   * unscoped absence assertion here would fail on a working component for a reason that has
   * nothing to do with the row.
   */
  it("says nothing about wishes on a row that has none", async () => {
    open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    expect(
      within(rowFor("Lightning Bolt, M10 146")).queryByText(/wish/i),
    ).not.toBeInTheDocument();
    expect(tally().textContent).toBe("3 copies across 1 card");
  });

  /** An unticked row goes on reporting what its own line would do — the sentence is a fact about
   *  the wishlist entry, and the dim is what says the press will not act on it. */
  it("keeps a row's wish sentence when the row is switched off", async () => {
    open({ rows: [row({ wishes: [wish({ folderName: "Buy soon" })] })] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("checkbox", { name: "Add Lightning Bolt, M10 146" }));

    expect(screen.getByText("Clears 3 copies off a wish in Buy soon")).toBeInTheDocument();
  });

  /**
   * **The checkbox is on by default and collapses every wish sentence when it is off — the
   * ambiguous ones included.**
   *
   * That second half is the one easy to get wrong: "2 wishlist lines match — left alone" over a
   * press that was never going to touch a wish is a true sentence about the wrong world.
   */
  it("sends clearWishes true by default and false once the checkbox is off", async () => {
    const { add } = open({
      rows: [
        row({ wishes: [wish({ folderName: "Buy soon" })] }),
        SOL_RING,
        row({
          cardId: "swords",
          name: "Swords to Plowshares",
          short: 1,
          wishes: [wish({ id: 7 }), wish({ id: 8, folderId: 5, folderName: "Buy soon" })],
        }),
      ],
    });
    await screen.findByText("Lightning Bolt");

    const toggle = screen.getByRole("checkbox", { name: "Also take these off my wishlist" });
    expect(toggle).toBeChecked();
    expect(tally().textContent).toBe("6 copies across 3 cards · 3 copies off your wishlist");

    await userEvent.click(toggle);

    expect(screen.queryByText(/off a wish in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/wishlist lines match/)).not.toBeInTheDocument();
    expect(tally().textContent).toBe("6 copies across 3 cards");

    await userEvent.click(screen.getByRole("button", { name: "Add 6 copies to collection" }));
    // The picks are unchanged — the flag is the whole of what this control decides, and a
    // checkbox that also dropped rows would be one control doing two things.
    expect(add.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ clearWishes: false, picks: expect.any(Array) }),
    );
  });

  /**
   * Nothing ticked is nothing to press.
   *
   * **`aria-disabled` rather than the attribute**, which is this app's rule for a control that
   * greys as the reader works: a real `disabled` button leaves the tab order, so a reader who
   * unticked their last row would find the caret thrown out of the footer by their own press. The
   * guard is asserted as well as the attribute — an `aria-disabled` control still delivers its
   * click, so the paint without the guard is a lie.
   */
  it("greys the press when nothing is ticked, and writes nothing if it is pressed anyway", async () => {
    const { add } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("checkbox", { name: "Add Lightning Bolt, M10 146" }));

    const press = screen.getByRole("button", { name: "Add 0 copies to collection" });
    expect(press).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(press);
    expect(add.mutate).not.toHaveBeenCalled();
  });

  /**
   * The write in flight: the press is genuinely `disabled` for the half-second it lasts — the one
   * place this app uses the attribute rather than `aria-disabled` — and the way out is not, since
   * declining is not a thing a busy database can refuse.
   */
  it("disables the press while the write is in flight and leaves the way out alone", async () => {
    open({ rows: [row()], add: { isPending: true } });
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("button", { name: "Recording…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  /**
   * **The live region is in the tree before it has anything to say.**
   *
   * A region mounted together with its own text announces nothing — there was no change for a
   * screen reader to notice — so the sentence has to be *swapped into* a region that was already
   * there. Element identity is what proves it: the same node before and after, with the text
   * having appeared inside it.
   */
  it("swaps the answer into a live region that was already mounted", async () => {
    const { rerender, add } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    rerender(
      <AddMissingToCollectionDialog
        open
        deckName="Burn"
        // What the caller re-reads after a press: the holes are closed, so there is nothing left.
        rows={[]}
        loading={false}
        readError={null}
        add={{ ...add, isSuccess: true, data: { copies: 3, cards: 1, wishCopies: 2 } }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent(
      "Recorded 3 copies of 1 card into Burn. 2 copies off your wishlist.",
    );
    // …and the empty list under it is explained rather than left to look like a failed read.
    expect(screen.getByText(/Nothing here can be recorded/)).toBeInTheDocument();
  });

  /** The wishlist half is a separate sentence and is drawn only when it happened — a press with
   *  the checkbox off, or over rows with no unambiguous match, says nothing about a wishlist. */
  it("leaves the wishlist clause off an answer that cleared nothing", async () => {
    const { rerender, add } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    rerender(
      <AddMissingToCollectionDialog
        open
        deckName="Burn"
        rows={[]}
        loading={false}
        readError={null}
        add={{ ...add, isSuccess: true, data: { copies: 1, cards: 1, wishCopies: 0 } }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Recorded 1 copy of 1 card into Burn.");
  });

  /** A refused batch is announced beside the button that was pressed, not in the editor's banner
   *  behind the scrim — and through `ipcError`, so the backend's own sentence survives. */
  it("raises a refused press as an alert inside the panel, in the backend's words", async () => {
    const { rerender, add } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    rerender(
      <AddMissingToCollectionDialog
        open
        deckName="Burn"
        rows={[row()]}
        loading={false}
        readError={null}
        add={{
          ...add,
          isError: true,
          error: "That is more copies than this deck is short of.",
        }}
        onClose={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not record — That is more copies than this deck is short of.",
    );
    expect(panel().contains(alert)).toBe(true);
  });

  /**
   * A deck playing the foil and the regular copy of one printing is two rows of this list, and so
   * is a deck short of two printings of one card — **so neither pair of controls may share a
   * name.** A screen reader hearing "Add Lightning Bolt" twice has two controls it cannot choose
   * between.
   *
   * The stepper is checked alongside the tick because the two names come from one helper, and a
   * clause dropped from it would be invisible to a case that only read the checkboxes.
   */
  it("tells two rows of one card apart by finish and by printing, in both control names", async () => {
    open({
      rows: [
        row({ short: 1 }),
        row({ short: 1, finish: "foil" }),
        row({ cardId: "bolt-2x2", setCode: "2x2", collectorNumber: "117", short: 1 }),
      ],
    });
    expect(await screen.findAllByText("Lightning Bolt")).toHaveLength(3);

    for (const name of [
      "Lightning Bolt, M10 146",
      "Lightning Bolt, foil, M10 146",
      "Lightning Bolt, 2X2 117",
    ]) {
      expect(screen.getByRole("checkbox", { name: `Add ${name}` })).toBeInTheDocument();
      expect(screen.getByRole("spinbutton", { name: `Copies of ${name}` })).toBeInTheDocument();
    }
  });

  /** The deck is named where the copies are going, and the sentence says the thing a reader could
   *  otherwise get wrong about a button sitting beside `Pull from collection`. */
  it("names the deck's folder and says nothing leaves the collection", async () => {
    open({ rows: [row()] });

    expect(
      await screen.findByText(
        "Records copies you have just acquired into Burn's folder. Nothing is moved out of your " +
          "collection.",
      ),
    ).toBeInTheDocument();
  });

  /** The shell's rung, checked through this host: Escape is the dismiss route, which is what
   *  hands the caret back to whatever opened the dialog. */
  it("closes on Escape", async () => {
    const { onClose } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * **Tab cannot leave the panel** — the half of `aria-modal="true"` no attribute delivers.
   *
   * A layer mounted alone has nothing to escape to, so the test would pass on a broken trap:
   * this one mounts two focusable siblings either side of the dialog and asserts they are never
   * reached. The walk is measured from the panel rather than being a round number, because a
   * fixed count is a test whose strength depends on how many controls the layer happens to have.
   */
  it("keeps Tab inside itself", async () => {
    open({ rows: [row(), SOL_RING], neighbours: true });
    await screen.findByText("Lightning Bolt");

    const layer = panel();
    expect(layer).toHaveAttribute("aria-modal", "true");

    const stops = layer.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ).length;
    expect(stops).toBeGreaterThan(0);

    for (let i = 0; i < stops + 3; i += 1) {
      await userEvent.tab();
      expect(layer.contains(document.activeElement)).toBe(true);
    }
    expect(screen.getByRole("button", { name: "Before" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "After" })).not.toHaveFocus();
  });
});
