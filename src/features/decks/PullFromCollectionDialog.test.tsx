import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckPullCandidate, DeckPullRow } from "@/lib/ipc";
import { openDropdown, pickOption } from "@/test-dropdown";
import { PullFromCollectionDialog, type PullWrite } from "./PullFromCollectionDialog";

/**
 * One `collection_entries` row as `deck_pull_plan` answers one — the loose English near-mint copy
 * at the root, which is what a candidate is unless a case says otherwise.
 *
 * Every optional trait is off here on purpose: each one that a case turns on is then the single
 * difference between two options, which is the only way an assertion about an option's words can
 * be about the trait rather than about the fixture.
 */
function candidate(over: Partial<DeckPullCandidate> = {}): DeckPullCandidate {
  return {
    entryId: 11,
    quantity: 3,
    folderId: null,
    folderName: null,
    folderKind: null,
    condition: "NM",
    lang: "en",
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    serialNumber: null,
    ...over,
  };
}

/** One printing the deck is short of, with exactly enough loose copies to fill it out of one
 *  place — the row with no decision in it, which is the majority of every real plan. */
function row(over: Partial<DeckPullRow> = {}): DeckPullRow {
  return {
    cardId: "bolt-m10",
    name: "Lightning Bolt",
    setCode: "m10",
    collectorNumber: "146",
    finish: null,
    short: 3,
    categories: ["Removal"],
    imageUris: null,
    candidates: [candidate()],
    ...over,
  };
}

/**
 * The row the issue is actually about: two copies of one printing sitting in two different
 * places, so the dialog has to ask which one to spend.
 *
 * The two differ in **both** terms the option names — the folder and the condition — because a
 * fixture where they differ in only one would pass an assertion that read the wrong term.
 */
const SOL_RING = row({
  cardId: "ring-c21",
  name: "Sol Ring",
  setCode: "c21",
  collectorNumber: "263",
  short: 2,
  categories: ["Ramp", "Artifacts"],
  candidates: [
    candidate({ entryId: 21, quantity: 2 }),
    candidate({
      entryId: 22,
      quantity: 2,
      folderId: 5,
      folderName: "Cube binder",
      folderKind: "user",
      condition: "LP",
    }),
  ],
});

/** The write the footer's one button makes, in whatever state a case needs it. */
function writer(over: Partial<PullWrite> = {}): PullWrite {
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
  rows?: readonly DeckPullRow[] | null;
  loading?: boolean;
  readError?: string | null;
  pull?: Partial<PullWrite>;
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
  const pull = writer(options.pull);
  const onClose = vi.fn();
  const dialog = (
    <PullFromCollectionDialog
      open
      deckName="Burn"
      rows={options.rows === undefined ? [row()] : options.rows}
      loading={options.loading ?? false}
      readError={options.readError ?? null}
      pull={pull}
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
  return { ...view, pull, onClose };
}

/** The panel, addressed the way the app's other Tab sweeps address one. */
const panel = () => screen.getByRole("dialog", { name: "Pull from collection" });

/** One row's box, found through the one control that is named for its card. Scoping matters for
 *  every claim about a *row* — a `queryByRole` over the whole panel would find the other row's
 *  picker and call the absence a presence. */
function rowFor(name: string): HTMLElement {
  const box = screen.getByRole("checkbox", { name: new RegExp(`^Pull ${name},`) }).closest("li");
  if (box === null) throw new Error(`no row for ${name}`);
  return box;
}

/**
 * The source picker's accessible name, spelled out rather than matched loosely.
 *
 * **A dropdown's trigger is a `button`, not a `combobox`** — the combobox is the search box a
 * `searchable` one reveals — so an absence assertion written against `combobox` would find
 * nothing on a picker that was drawn, and pass on the very defect it is for. `test-dropdown.ts`
 * says so in as many words, and this is the trap it was written for.
 *
 * Written out whole because it is also the label's own contract: `From` is the visible word and
 * everything after it is the `sr-only` half that makes the name per card. Spelling the joined
 * string here is what fails if that half is dropped — a name computed from two elements is
 * exactly the kind that comes out silently wrong (`Missing2`).
 */
const sourceName = (printing: string) => `From, which copy of ${printing} to pull`;

describe("PullFromCollectionDialog", () => {
  /**
   * **The four states of the body, and no two of them may look alike.**
   *
   * The empty one is the reason this is a sweep rather than four separate cases: it is the state
   * a reader arrives at from a header saying the deck is short of a dozen cards, and drawn as a
   * bare blank panel it reads as the read having failed. Each case therefore asserts what it
   * draws *and* that it is not drawing one of the others.
   */
  it("says the read is in flight, and nothing else", async () => {
    open({ loading: true, rows: null });

    expect(await screen.findByText("Reading your collection…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to pull.")).not.toBeInTheDocument();
  });

  it("prints the read's own refusal where the rows would have been", async () => {
    open({ rows: null, readError: "database is locked" });

    expect(await screen.findByText("database is locked")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to pull.")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading your collection…")).not.toBeInTheDocument();
  });

  /**
   * An empty plan is the ordinary answer, so the panel has to say **why** the number in the deck
   * header and the number here are allowed to disagree: the pull is narrowed to the exact
   * printing and finish, and to copies no other deck is holding.
   *
   * The refusal styling is asserted by its absence — nothing here is an `alert`, because nothing
   * here has gone wrong.
   */
  it("explains an empty plan rather than drawing a blank panel", async () => {
    open({ rows: [] });

    expect(await screen.findByText("Nothing to pull.")).toBeInTheDocument();
    expect(screen.getByText(/exact printing and finish/)).toHaveTextContent(
      "never a copy another deck is already holding",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("draws the rows with their printing, their piles and their shortfall", async () => {
    open({ rows: [row(), SOL_RING] });

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    const bolt = rowFor("Lightning Bolt");
    expect(within(bolt).getByText("M10 · 146")).toBeInTheDocument();
    expect(within(bolt).getByText("Short in Removal")).toBeInTheDocument();
    // The count column, in the words a screen reader gets rather than the two loose numbers the
    // eye reads under a heading it can see.
    expect(within(bolt).getByText("Pulling 3 of 3 copies")).toBeInTheDocument();
    expect(within(rowFor("Sol Ring")).getByText("Short in Ramp, Artifacts")).toBeInTheDocument();
  });

  /**
   * **A single candidate is a fact stated, not a choice offered.** A `<select>` holding one
   * option is a control that reads as a decision and is not, so the row prints the same sentence
   * as plain text instead.
   *
   * Scoped to the row, because the panel in this very case has another row that *does* draw one
   * — an unscoped absence assertion would pass on a component that drew no picker anywhere.
   */
  it("draws no picker on a row with one candidate, and one on a row with two", async () => {
    const user = userEvent.setup();
    open({ rows: [row(), SOL_RING] });
    await screen.findByText("Lightning Bolt");

    const bolt = rowFor("Lightning Bolt");
    expect(
      within(bolt).queryByRole("button", { name: sourceName("Lightning Bolt") }),
    ).not.toBeInTheDocument();
    expect(within(bolt).getByText("From Collection · Near mint · 3 copies")).toBeInTheDocument();

    // Scoped to the other row, so the presence half is about *that* row rather than about the
    // panel holding a picker somewhere.
    expect(
      within(rowFor("Sol Ring")).getByRole("button", { name: sourceName("Sol Ring") }),
    ).toBeInTheDocument();

    await openDropdown(user, sourceName("Sol Ring"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection · Near mint · 2 copies",
      "Cube binder · Lightly played · 2 copies",
    ]);
  });

  /**
   * The picker shows the source the press would actually spend — the half either picker shell
   * gets silently wrong when handed a value its options do not carry. A `<select>` would land on
   * the first row; `Dropdown` draws a bare em dash, which is the same lie told more quietly. The
   * trigger's own text is what the reader sees, and it is asserted as **the picked row's label**
   * rather than as a value nobody is looking at.
   */
  it("opens the picker on the source the press would use", async () => {
    open({ rows: [SOL_RING] });
    await screen.findByText("Sol Ring");

    expect(screen.getByRole("button", { name: sourceName("Sol Ring") })).toHaveTextContent(
      "Collection · Near mint · 2 copies",
    );
  });

  /** Changing the picker changes which `collection_entries` row the press spends — the whole of
   *  what the issue asked for, asserted at the wire rather than on the screen. */
  it("sends the entry the reader picked, not the one the backend ranked first", async () => {
    const user = userEvent.setup();
    const { pull } = open({ rows: [SOL_RING] });
    await screen.findByText("Sol Ring");

    // The row is picked by what the reader **sees**, which is the honest address for a control
    // whose rows are text — `pickOption`'s own rule.
    await pickOption(user, sourceName("Sol Ring"), "Cube binder · Lightly played · 2 copies");
    await user.click(screen.getByRole("button", { name: "Pull 2 copies" }));

    expect(pull.mutate).toHaveBeenCalledWith([{ entryId: 22, quantity: 2 }]);
  });

  /**
   * **The press sends exactly the plan, in the plan's own order** — one pick per source, never
   * one per row and never the rows themselves.
   *
   * Two rows rather than one, because a payload built from the last row alone would satisfy any
   * single-row case.
   */
  it("sends one pick per source, for every ticked row", async () => {
    const { pull } = open({ rows: [row(), SOL_RING] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: "Pull 5 copies" }));

    expect(pull.mutate).toHaveBeenCalledWith([
      { entryId: 11, quantity: 3 },
      { entryId: 21, quantity: 2 },
    ]);
  });

  /** Unticking is the reader's one amendment to the plan, and it has to reach both the number on
   *  screen and the payload — a footer that kept counting a row the press no longer carries is
   *  the failure worth pinning, because it is invisible until afterwards. */
  it("drops an unticked row from the totals and from the payload", async () => {
    const { pull } = open({ rows: [row(), SOL_RING] });
    await screen.findByText("Lightning Bolt");
    expect(screen.getByText("5 copies across 2 cards")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Pull Lightning Bolt, 3 copies" }));

    expect(screen.getByText("2 copies across 1 card")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pull 2 copies" }));
    expect(pull.mutate).toHaveBeenCalledWith([{ entryId: 21, quantity: 2 }]);
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
    const { pull } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("checkbox", { name: "Pull Lightning Bolt, 3 copies" }));

    const press = screen.getByRole("button", { name: "Pull 0 copies" });
    expect(press).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(press);
    expect(pull.mutate).not.toHaveBeenCalled();
  });

  /**
   * **A shortfall the collection cannot cover is a statement, not a fault.**
   *
   * It is the ordinary answer for a deck that is genuinely short, so it carries no live-region
   * role and none of the destructive colour — a reader's own binder reported as an error is the
   * one thing this sentence must never read as. The class is asserted because there is nothing
   * else in the DOM that distinguishes a plain note from a red one.
   */
  it("states what the collection cannot cover, and does not raise it as an error", async () => {
    open({ rows: [row({ candidates: [candidate({ entryId: 11, quantity: 1 })] })] });
    await screen.findByText("Lightning Bolt");

    const note = screen.getByText(/still missing/);
    expect(note).toHaveTextContent(
      "2 copies still missing — nothing else you own loose matches this printing.",
    );
    expect(note).toHaveClass("text-dim");
    expect(note).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("");
    // What it *can* cover is still offered, which is the point of drawing the row at all.
    expect(screen.getByRole("button", { name: "Pull 1 copy" })).toBeInTheDocument();
  });

  /** An unticked row is short of everything by the reader's own press, so the sentence would be
   *  the control accusing them of its own state. */
  it("says nothing about a shortfall on a row the reader switched off", async () => {
    open({ rows: [row({ candidates: [candidate({ entryId: 11, quantity: 1 })] })] });
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("checkbox", { name: "Pull Lightning Bolt, 3 copies" }));

    expect(screen.queryByText(/still missing/)).not.toBeInTheDocument();
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
    const { rerender, pull } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    rerender(
      <PullFromCollectionDialog
        open
        deckName="Burn"
        // What the caller re-reads after a pull: the holes are filled, so there is nothing left.
        rows={[]}
        loading={false}
        readError={null}
        pull={{ ...pull, isSuccess: true, data: { copies: 3, cards: 1 } }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Pulled 3 copies across 1 card into Burn.");
    // …and the empty list under it is explained rather than left to look like a failed read.
    expect(screen.getByText("Nothing to pull.")).toBeInTheDocument();
  });

  /** A refused batch is announced beside the button that was pressed, not in the editor's banner
   *  behind the scrim — and through `ipcError`, so the backend's own sentence survives. */
  it("raises a refused pull as an alert, in the backend's words", async () => {
    const { rerender, pull } = open({ rows: [row()] });
    await screen.findByText("Lightning Bolt");

    rerender(
      <PullFromCollectionDialog
        open
        deckName="Burn"
        rows={[row()]}
        loading={false}
        readError={null}
        pull={{ ...pull, isError: true, error: "entry 11 is no longer where you left it" }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not pull — entry 11 is no longer where you left it",
    );
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
   * `DeckEditor.test.tsx` runs this sweep in the assembled editor precisely because "must not
   * reach anything behind it" is a claim about what is *behind* it, and a layer mounted alone has
   * nothing to escape to: the test would pass on a broken trap. So this one mounts two focusable
   * siblings either side of the dialog and asserts they are never reached — the same behavioural
   * sweep with something for it to fail against.
   *
   * The walk is measured from the panel rather than being a round number, for that sweep's own
   * reason: a fixed count is a test whose strength depends on how many controls the layer happens
   * to have. One full cycle plus three is the shortest walk that must leave a panel holding
   * nothing, and the three are what catch a trap that wraps once and then leaks.
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

  /**
   * The write in flight: the press is genuinely `disabled` for the half-second it lasts — the one
   * place this app uses the attribute rather than `aria-disabled` — and the way out is not, since
   * declining is not a thing a busy database can refuse.
   */
  it("disables the press while the write is in flight and leaves the way out alone", async () => {
    open({ rows: [row()], pull: { isPending: true } });
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("button", { name: "Pulling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  /**
   * The traits are what tell two copies of one printing apart, and each is drawn only where it is
   * set — an option carrying every column would be the same six words on every row, which is a
   * picker no answer can be given to.
   */
  it("names a copy's language, grade and traits in its option, and nothing it has not got", async () => {
    const user = userEvent.setup();
    open({
      rows: [
        row({
          short: 1,
          candidates: [
            candidate({ entryId: 31, quantity: 1 }),
            candidate({
              entryId: 32,
              quantity: 1,
              folderName: "Japanese",
              lang: "ja",
              grading: "PSA 9",
              signed: true,
            }),
          ],
        }),
      ],
    });
    await screen.findByText("Lightning Bolt");

    await openDropdown(user, sourceName("Lightning Bolt"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection · Near mint · 1 copy",
      "Japanese · Near mint · JA · PSA 9 · Signed · 1 copy",
    ]);
  });

  /**
   * A deck playing the foil and the regular copy of one printing is two rows of this list, so
   * **neither pair of controls may share a name** — the finish is the only thing that tells the
   * two rows apart, and a screen reader hearing "Pull Lightning Bolt, 1 copy" twice has two
   * controls it cannot choose between.
   *
   * Both rows are given two candidates so that both pickers are drawn: their names come from a
   * different helper than the checkboxes' — a noun phrase rather than a clause list, because one
   * sits inside a sentence — and a finish dropped from *that* one would be invisible to a case
   * that only read the checkboxes.
   */
  it("says the finish in both of a row's control names, and only where there is one", async () => {
    const twoPlaces = (a: number, b: number) => [
      candidate({ entryId: a, quantity: 1 }),
      candidate({ entryId: b, quantity: 1, folderId: 5, folderName: "Cube binder" }),
    ];
    open({
      rows: [
        row({ short: 1, candidates: twoPlaces(41, 42) }),
        row({ short: 1, finish: "foil", candidates: twoPlaces(43, 44) }),
      ],
    });
    // Both rows carry the same printed name, which is the whole point of the case — so the wait
    // is on *two* of them rather than on one that could never resolve.
    expect(await screen.findAllByText("Lightning Bolt")).toHaveLength(2);

    expect(
      screen.getByRole("checkbox", { name: "Pull Lightning Bolt, 1 copy" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Pull Lightning Bolt, 1 copy, foil" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: sourceName("Lightning Bolt") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: sourceName("foil Lightning Bolt") }),
    ).toBeInTheDocument();
  });

  /** The deck is named where the copies are going, so a reader with two decks open knows which
   *  one this press fills. */
  it("names the deck the copies are going into", async () => {
    open({ rows: [row()] });

    expect(
      await screen.findByText(
        "Cards this deck is short of that you already own — into Burn",
      ),
    ).toBeInTheDocument();
  });
});
