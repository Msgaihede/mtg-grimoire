import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { transferCard } from "../fixtures";
import type { TransferCard } from "../TransferCard";
// `dropsInactive` rather than a hand-written list of the two formats it names: the sweep in
// "the inactive-category filter" asks the module which answer to expect for each format, so a
// writer entering or leaving `ACTIVE_ONLY` shows up as a red test rather than as a comment here
// that stopped being true.
import { dropsInactive, EXPORT_FORMATS, EXPORT_FORMAT_LABEL } from "./format";

const exportWriteFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { exportWriteFile },
}));

const save = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

/**
 * Which build is answering, for the one test that wants the web one.
 *
 * `isWebTarget()` reads `__CORE__`, a build-time constant vitest fixes at `"tauri"`, so mocking
 * this module is the only way to reach the browser branch of `transfer/files.ts` — where a save
 * is a `Blob` behind an `<a download>` and no path exists at all. Every other test here wants
 * the native branch, which is why it defaults to `false`.
 */
const isWebTarget = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/pwa/target", () => ({ isWebTarget }));

import { ipc } from "@/lib/ipc";
import { save as saveMock } from "@tauri-apps/plugin-dialog";
import { copyText as copyTextMock } from "@/lib/clipboard";
import { useAppStore } from "@/lib/store";
import { ExportDialog, type ExportDialogProps } from "./ExportDialog";

/**
 * One card, overridden per test.
 *
 * The three category defaults are what a single-pile export always looked like — the main deck,
 * switched on — so every assertion written before `TransferCard` existed still means what it
 * did. `format.test.ts` keeps the same builder for the same reason; the two are deliberately not
 * shared, because a fixture exported from either file would be a second thing to keep in step.
 */
const exportCard = (over: Partial<TransferCard> = {}): TransferCard =>
  transferCard({
    name: "Sol Ring",
    setCode: "ltc",
    collectorNumber: "285",
    categoryName: "Main deck",
    categoryKind: "main",
    categoryActive: true,
    ...over,
  });

const BOLT = exportCard({
  name: "Lightning Bolt",
  quantity: 2,
  setCode: "lea",
  collectorNumber: "161",
  finish: null,
});

const noop = () => {};

/**
 * The props every test in this file starts from, `render`ed with `{...props}` and whatever a
 * given test overrides. `surface` is `"deck"` — every card here is shaped like a deck row
 * through `exportCard`'s own defaults (a category name, a kind, a switch) — so a test that wants
 * a different surface passes one of its own, cards included.
 */
const props = {
  open: true,
  subject: "Removal",
  cards: [BOLT] as readonly TransferCard[],
  suggestedFileName: "Removal",
  onDismiss: noop,
  onClose: noop,
  surface: "deck" as const,
};

/**
 * Open the preview, which starts shut.
 *
 * Every assertion about the *text* of an export goes through this rather than through a `<pre>`
 * that is merely hidden — the block is unmounted while the disclosure is shut, so a test that
 * skipped the press would be asserting a line no reader can see.
 */
async function showList(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
}

beforeEach(() => {
  exportWriteFile.mockReset();
  exportWriteFile.mockResolvedValue(undefined);
  save.mockReset();
  save.mockResolvedValue(null);
  copyText.mockReset();
  copyText.mockResolvedValue(undefined);
  isWebTarget.mockReturnValue(false);
  // The chosen format and fields now live in `useAppStore`'s `exportPrefs` rather than in this
  // component's own `useState`, so — unlike before — they survive from one test to the next
  // unless this file resets the store itself.
  useAppStore.setState(useAppStore.getInitialState());
});

describe("ExportDialog", () => {
  it("previews the plain format by default", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    await showList(user);
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
  });

  it("opens with the decklist shut, and draws none of it until it is asked for", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    // Shut is **unmounted**, not hidden: a `<pre>` still holding the text would let every
    // assertion below pass over a preview no reader can see.
    const toggle = await screen.findByRole("button", { name: /Show decklist/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.queryByText("2 Lightning Bolt")).not.toBeInTheDocument();
    // The count is what a shut preview still owes the reader — one line here, said in the
    // singular.
    expect(toggle).toHaveTextContent("Show decklist (1 line)");

    await user.click(toggle);
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hide decklist/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("counts the lines of the file rather than the cards in the pile", async () => {
    render(
      <ExportDialog {...props} />,
    );
    // Moxfield writes a `Deck` heading over the one card, so the file is two lines and the pile
    // is one — and the trailing newline every export ends with is not a third.
    await userEvent.setup().click(await screen.findByRole("radio", { name: "Moxfield" }));
    expect(screen.getByRole("button", { name: /decklist/ })).toHaveTextContent(
      "Show decklist (2 lines)",
    );
  });

  it("redraws the preview when the format changes", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    await showList(user);
    await user.click(await screen.findByRole("radio", { name: "Moxfield" }));
    // Moxfield writes its section heading even for a single section — the vocabulary is fixed, so
    // `Deck` is a fact about where these cards are and not a separator a one-pile file can drop.
    // `findByText` normalizes the newline between the two, which is why this reads as one line.
    expect(await screen.findByText("Deck 2 Lightning Bolt (LEA) 161")).toBeInTheDocument();
  });

  it("offers every format format.ts writes, in that file's own order", async () => {
    render(
      <ExportDialog {...props} />,
    );
    // The row maps `EXPORT_FORMATS`, so this reads the array rather than a list drawn by hand —
    // an eighth writer reaches the reader without an edit here. Compared against the array
    // itself rather than a count, which is a number that rots the moment a writer is added.
    const labels = (await screen.findAllByRole("radio")).map((radio) => radio.textContent);
    expect(labels).toEqual(EXPORT_FORMATS.map((format) => EXPORT_FORMAT_LABEL[format]));
    expect(labels).toContain("TCGplayer");
  });

  it("says how many cards a format leaves out, and stops saying it when one does not", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        {...props}
        subject="Atraxa"
        cards={[
          exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
          exportCard({
            name: "Forest",
            quantity: 6,
            categoryName: "Cuts",
            categoryActive: false,
          }),
        ]}
        suggestedFileName="Atraxa"
      />,
    );
    // Copies, not rows: six basic lands on one row are six cards missing from the file.
    await user.click(await screen.findByRole("radio", { name: "Arena" }));
    expect(screen.getByText(/6 cards in switched-off piles are not written/)).toBeInTheDocument();

    // Moxfield has a maybeboard, so it writes that pile and leaves nothing out. The sentence is
    // about the format on screen, so it has to go with it.
    await user.click(screen.getByRole("radio", { name: "Moxfield" }));
    expect(screen.queryByText(/not written in this format/)).not.toBeInTheDocument();

    // **The tick is what keeps this test's original claim the claim it is making** (issue #390).
    // "Moxfield leaves nothing out" is still true of the *format* — it has a maybeboard and drops
    // nothing of its own accord, which is what the line above asserts — but the dialog now opens
    // with `Include inactive categories` off, so the same six copies are held back by the
    // reader's own default instead. Without the press below this test would have gone on passing
    // while the file under it was short a whole pile, which is the shape of an assertion that
    // outlives its meaning: the sentence it looks for is gone for the reason it always was, and
    // a different one has quietly taken the place on screen. The reader's own line is the
    // `describe` below's subject in full; what is asserted here is that ticking the box is what
    // empties both of them.
    expect(
      screen.getByText("6 cards in inactive categories are not written."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Include inactive categories" }));
    expect(screen.queryByText(/not written/)).not.toBeInTheDocument();
  });

  it("says it in the singular for one card", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        {...props}
        subject="Atraxa"
        cards={[
          exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
          exportCard({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false }),
        ]}
        suggestedFileName="Atraxa"
      />,
    );
    await user.click(await screen.findByRole("radio", { name: "MTGO" }));
    expect(
      screen.getByText("1 card in a switched-off pile is not written in this format."),
    ).toBeInTheDocument();
  });

  /**
   * The deck label's checkboxes, in the dialog — because a field can be perfectly declared in
   * `fields.ts`, perfectly written by `format.ts`, and unreachable from the one surface a reader
   * has. The field row is `availableFields(format, surface)` and nothing else, so what these
   * assert is that the two declarations meet where a reader can press them.
   */
  describe("the deck label", () => {
    const KEEPER = exportCard({
      name: "Lightning Bolt",
      quantity: 2,
      setCode: "lea",
      collectorNumber: "161",
      labelName: "Keeper",
      labelColor: "#4aab08",
    });
    const labelBox = () => screen.getByRole("checkbox", { name: "Label" });

    it("is ticked on Archidekt and offers no colour box of its own", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={[KEEPER]} />);

      await user.click(await screen.findByRole("radio", { name: "Archidekt" }));
      expect(labelBox()).toBeChecked();
      // The colour rides inside `^Keeper,#4aab08^`, so a box for it here would change nothing.
      expect(screen.queryByRole("checkbox", { name: "Label colour" })).not.toBeInTheDocument();
    });

    it("writes the label into the Archidekt preview, and stops when it is unticked", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={[KEEPER]} />);
      await user.click(await screen.findByRole("radio", { name: "Archidekt" }));
      await showList(user);

      expect(screen.getByText(/\^Keeper,#4aab08\^/)).toBeInTheDocument();

      await user.click(labelBox());
      expect(screen.queryByText(/\^Keeper/)).not.toBeInTheDocument();
    });

    it("offers both columns on CSV, off until the reader asks", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={[KEEPER]} />);
      await user.click(await screen.findByRole("radio", { name: "CSV" }));

      const colourBox = screen.getByRole("checkbox", { name: "Label colour" });
      // CSV's defaults are a deliberate core; the label and its colour are both opt-in there.
      expect(labelBox()).not.toBeChecked();
      expect(colourBox).not.toBeChecked();

      await user.click(labelBox());
      await user.click(colourBox);
      await showList(user);
      expect(screen.getByText(/Label,Label colour/)).toBeInTheDocument();
      expect(screen.getByText(/Keeper,#4aab08/)).toBeInTheDocument();
    });

    it("is offered by no format that has nowhere to put it", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={[KEEPER]} />);
      for (const format of ["Plain text", "MTGO", "Arena", "Moxfield", "TCGplayer"]) {
        await user.click(await screen.findByRole("radio", { name: format }));
        expect(
          screen.queryByRole("checkbox", { name: "Label" }),
          format,
        ).not.toBeInTheDocument();
      }
    });
  });

  /**
   * The Arena filter — issue #192. `arena.ts` owns which cards Arena has and has its own tests;
   * these are about the control: that it draws for one format, that ticking it changes the file,
   * and that what it left out is said out loud before Copy is pressed.
   *
   * (This comment sat above `describe("the deck label")` until 2026-09-07, one block too high —
   * moved rather than left, because the `describe` below it is written as this one's twin and a
   * misfiled doc is what makes a reader believe the wrong pair belong together.)
   */
  describe("the Arena filter", () => {
    /** In Arena (Timeless) and not in Arena (paper-only), as the real blobs read. */
    const IN_ARENA = '{"timeless":"legal","historic":"banned"}';
    const PAPER_ONLY = '{"commander":"legal","vintage":"legal"}';
    const MIXED = [
      exportCard({
        name: "Lightning Bolt",
        quantity: 2,
        setCode: "lea",
        collectorNumber: "161",
        legalities: IN_ARENA,
      }),
      exportCard({ name: "Sol Ring", quantity: 1, legalities: PAPER_ONLY }),
    ];
    const arenaBox = () => screen.getByRole("checkbox", { name: "Only cards MTG Arena has" });

    it("is offered by the Arena format and by no other", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} />);
      // Not a field — it changes which cards are written, never what a line says about one —
      // so it is absent everywhere the question cannot be asked.
      expect(
        screen.queryByRole("checkbox", { name: "Only cards MTG Arena has" }),
      ).not.toBeInTheDocument();

      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      expect(arenaBox()).toBeInTheDocument();
      // Off on a first open: the Arena export has written every card handed to it since it
      // shipped, and a filter that started on would change that silently.
      expect(arenaBox()).not.toBeChecked();

      await user.click(screen.getByRole("radio", { name: "Moxfield" }));
      expect(
        screen.queryByRole("checkbox", { name: "Only cards MTG Arena has" }),
      ).not.toBeInTheDocument();
    });

    it("writes every card until it is ticked, and then only the ones Arena has", async () => {
      const user = userEvent.setup();
      const copy = vi.mocked(copyTextMock);
      render(<ExportDialog {...props} cards={MIXED} />);
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      // The whole file rather than a line of the preview: the two cards write two lines into
      // one text node, and `getByText` is a whole-node match.
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith(
        "Deck\n2 Lightning Bolt (LEA) 161\n1 Sol Ring (LTC) 285\n",
      );

      await user.click(arenaBox());
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith("Deck\n2 Lightning Bolt (LEA) 161\n");
    });

    /** Copies rather than rows, and on screen before Copy is pressed — `omittedCount`'s two
     *  rules, held by the line beside it. */
    it("says how many copies it held back, counted in copies", async () => {
      const user = userEvent.setup();
      render(
        <ExportDialog
          {...props}
          cards={[
            exportCard({ name: "Lightning Bolt", quantity: 2, legalities: IN_ARENA }),
            exportCard({ name: "Forest", quantity: 6, legalities: PAPER_ONLY }),
          ]}
        />,
      );
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      expect(screen.queryByText(/not in MTG Arena/)).not.toBeInTheDocument();

      await user.click(arenaBox());
      expect(
        screen.getByText("6 cards are not in MTG Arena and are not written."),
      ).toBeInTheDocument();
    });

    it("says it in the singular for one card", async () => {
      const user = userEvent.setup();
      render(
        <ExportDialog
          {...props}
          cards={[
            exportCard({ name: "Lightning Bolt", legalities: IN_ARENA }),
            exportCard({ name: "Sol Ring", legalities: PAPER_ONLY }),
          ]}
        />,
      );
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      await user.click(arenaBox());
      expect(
        screen.getByText("1 card is not in MTG Arena and is not written."),
      ).toBeInTheDocument();
    });

    /**
     * The two omission lines count different things and must not double-count one card. A
     * switched-off pile full of paper-only cards is reported by the Arena line alone, because
     * the filter runs first and `omittedCount` then measures what this format leaves out of
     * what it was actually handed.
     */
    it("does not report a filtered card twice when it is also in a switched-off pile", async () => {
      const user = userEvent.setup();
      render(
        <ExportDialog
          {...props}
          cards={[
            exportCard({ name: "Lightning Bolt", legalities: IN_ARENA }),
            exportCard({
              name: "Sol Ring",
              quantity: 3,
              legalities: PAPER_ONLY,
              categoryName: "Cuts",
              categoryActive: false,
            }),
          ]}
        />,
      );
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      // Before the tick, the pile is the only thing holding it back.
      expect(screen.getByText(/3 cards in switched-off piles are not written/)).toBeInTheDocument();

      await user.click(arenaBox());
      expect(
        screen.getByText("3 cards are not in MTG Arena and are not written."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/not written in this format/)).not.toBeInTheDocument();
    });

    /** A field set chosen for CSV means nothing to Arena and is re-derived; "leave out what
     *  Arena does not have" is the same answer whatever the reader passed through. */
    it("survives a trip through another format", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={MIXED} />);
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      await user.click(arenaBox());
      await user.click(screen.getByRole("radio", { name: "CSV" }));
      await user.click(screen.getByRole("radio", { name: "Arena" }));
      expect(arenaBox()).toBeChecked();
    });

    /** The filter is fenced on the format as well as on the flag: a reader who ticked it and
     *  moved to CSV must not find their CSV quietly short of rows. */
    it("does not narrow another format's export", async () => {
      const user = userEvent.setup();
      const copy = vi.mocked(copyTextMock);
      render(<ExportDialog {...props} cards={MIXED} />);
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      await user.click(arenaBox());
      await user.click(screen.getByRole("radio", { name: "Plain text" }));
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenCalledWith("2 Lightning Bolt\n1 Sol Ring\n");
    });

    /** Same claim, same reason as the format radios: the preview redraws, the clipboard does
     *  not, so "Copied." would sit beside text it is no longer true of. */
    it("clears the Copied status", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={MIXED} />);
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(await screen.findByText("Copied.")).toBeInTheDocument();

      await user.click(arenaBox());
      expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    });
  });

  /**
   * `Include inactive categories` — issue #390, and the Arena box's twin one row down.
   * `format.ts` owns what each writer does with a switched-off pile and has its own tests for it;
   * these are about the control, in the same four parts the block above is: that it draws exactly
   * where the question can be asked, that it opens off, that ticking it changes the file, and
   * that what it holds back is said out loud in copies before Copy is pressed.
   *
   * **Every assertion here that matters is about the _file_ rather than about the checkbox**, and
   * that is the whole reason this block is as long as it is. The default is a real change to what
   * an existing reader's next deck export contains: plain, Moxfield, Archidekt, TCGplayer and CSV
   * all wrote a switched-off pile before #390 shipped and none of them does now unless the box is
   * ticked. A suite that pinned only the control's presence and its `checked` state would leave
   * the whole of what changed uncovered — and a dialog quietly dropping rows looks exactly
   * correct from the outside, which is the failure mode the golden fence exists for one floor
   * down and this block is the dialog's own version of.
   */
  describe("the inactive-category filter", () => {
    /**
     * One switched-on pile and one switched off — the shape every assertion below is about.
     *
     * **Six copies on the `Cuts` row rather than one**, for `omittedCount`'s own reason: six
     * Forests on one row are six cards missing from the file, so a fixture that gave every row
     * `quantity: 1` would let a row count pass as a copy count and the two lines this dialog
     * draws would both read correctly while counting the wrong thing.
     */
    const CUTS: readonly TransferCard[] = [
      exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
      exportCard({ name: "Forest", quantity: 6, categoryName: "Cuts", categoryActive: false }),
    ];
    const inactiveBox = () =>
      screen.getByRole("checkbox", { name: "Include inactive categories" });
    /** The box, or `null` where the dialog does not offer it — the two fence tests want both. */
    const boxIfDrawn = () =>
      screen.queryByRole("checkbox", { name: "Include inactive categories" });

    /**
     * **The sweep is the point of this one.** `dropsInactive` is `ACTIVE_ONLY` read from outside,
     * and a format entering or leaving that set is exactly the change that should show up here
     * rather than in a reviewer's head — so this walks `EXPORT_FORMATS` and asks the module which
     * answer to expect, instead of naming Arena and MTGO by hand and going quietly stale beside
     * them. The radio row maps the same array, so what is swept is also everything the reader can
     * press: an eighth writer arrives in both places at once or fails here.
     */
    it("draws for every format that has not already answered the question", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={CUTS} />);
      for (const format of EXPORT_FORMATS) {
        const label = EXPORT_FORMAT_LABEL[format];
        await user.click(await screen.findByRole("radio", { name: label }));
        if (dropsInactive(format)) {
          // Arena and MTGO have nowhere to put a maybeboard whatever anybody asks of them, so a
          // box here could never move a byte — the furniture `src/CLAUDE.md` forbids — and
          // `omittedCount`'s own line under those two already says what it cost.
          expect(boxIfDrawn(), label).not.toBeInTheDocument();
        } else {
          expect(boxIfDrawn(), label).toBeInTheDocument();
        }
      }
    });

    /**
     * The surface fence, which closes a different hole from the format one: a collection row and
     * a wishlist row carry `categoryActive: null`, so there is no pile for the box to be about
     * and a control over nothing is the same furniture by another route. `transferCard()`'s own
     * defaults are that shape — this file's `exportCard` is what adds the three deck facts on top
     * — so the cards passed here are the ones those two pages really hand the dialog.
     */
    it("is absent on a surface that has no piles", async () => {
      const user = userEvent.setup();
      for (const surface of ["collection", "wishlist"] as const) {
        const { unmount } = render(
          <ExportDialog {...props} surface={surface} cards={[transferCard()]} />,
        );
        // The format it opens on…
        await screen.findByRole("radio", { name: "Plain text" });
        expect(boxIfDrawn(), surface).not.toBeInTheDocument();
        // …and CSV, which is a format that *does* offer the box on a deck — so a fence written
        // on the format alone would be caught here rather than passing on the opening format.
        await user.click(screen.getByRole("radio", { name: "CSV" }));
        expect(boxIfDrawn(), surface).not.toBeInTheDocument();
        unmount();
      }
    });

    /**
     * **Off on a first open, and what is asserted is the file rather than the checkbox.** This is
     * the half of #390 that is a behaviour change rather than a new control: Moxfield has a
     * maybeboard and wrote that pile into it until the day this shipped, so the sentence worth
     * pinning is "those cards are not in the text", not "the box is unticked".
     *
     * The whole copied text rather than a line of the preview, for the Arena filter's reason —
     * two cards write two lines into one text node and `getByText` is a whole-node match — and
     * the absent `Maybeboard` heading is the half that a filter applied in the wrong place would
     * get wrong: `formatExport` writing a heading over no rows is the other way this could fail
     * and would be invisible to a test that only counted cards.
     */
    it("opens off, so a switched-off pile is not in the first export", async () => {
      const user = userEvent.setup();
      const copy = vi.mocked(copyTextMock);
      render(<ExportDialog {...props} cards={CUTS} />);
      await user.click(await screen.findByRole("radio", { name: "Moxfield" }));
      expect(inactiveBox()).not.toBeChecked();

      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith("Deck\n1 Sol Ring (LTC) 285\n");
    });

    /**
     * **Archidekt is the strongest case, which is why it is the one spelled out in full.** It is
     * the only format here that can say a pile counts toward nothing — `{noDeck}` on the first
     * bracket entry, which `parse.ts` reads straight back as `is_active = 0` — so with the box on
     * this is the round trip that flag exists for rather than merely a longer file. A build that
     * put the cards back and lost the marker would hand a reader an Archidekt import in which
     * their maybeboard had become part of the deck, and the copies would all be present.
     *
     * Moxfield's `Maybeboard` heading is the same statement in the other vocabulary, pressed for
     * in the same session, because the filter is one gate in front of seven writers: a fix that
     * reached one writer's rows and not the other's is exactly the drift one format's test cannot
     * see. It also crosses a format with the box on, which is the trip below asserted in passing.
     */
    it("puts the pile back when it is ticked, {noDeck} and all", async () => {
      const user = userEvent.setup();
      const copy = vi.mocked(copyTextMock);
      render(<ExportDialog {...props} cards={CUTS} />);
      await user.click(await screen.findByRole("radio", { name: "Archidekt" }));
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith("Ramp\n1x Sol Ring (ltc) 285 [Ramp]\n");

      await user.click(inactiveBox());
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith(
        "Ramp\n1x Sol Ring (ltc) 285 [Ramp]\n\nCuts\n6x Forest (ltc) 285 [Cuts{noDeck}]\n",
      );

      await user.click(screen.getByRole("radio", { name: "Moxfield" }));
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith(
        "Deck\n1 Sol Ring (LTC) 285\n\nMaybeboard\n6 Forest (LTC) 285\n",
      );
    });

    /**
     * Copies rather than rows, and on screen before Copy is pressed — the two rules the Arena
     * line beside it holds, held here for the reader's own filter. And it is **absent** once
     * nothing is being held back, which is what stops it from becoming a permanent fixture beside
     * the format radios that nobody reads by the third export.
     */
    it("says how many copies it is holding back, counted in copies", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={CUTS} />);
      expect(
        await screen.findByText("6 cards in inactive categories are not written."),
      ).toBeInTheDocument();

      // `/not written/` rather than `/inactive categor/`: the checkbox's own label carries those
      // two words too, so the looser pattern would match the control that is still on screen and
      // this assertion could never fail.
      await user.click(inactiveBox());
      expect(screen.queryByText(/not written/)).not.toBeInTheDocument();
    });

    it("says it in the singular for one card", async () => {
      render(
        <ExportDialog
          {...props}
          cards={[
            exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
            exportCard({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false }),
          ]}
        />,
      );
      expect(
        await screen.findByText("1 card in an inactive category is not written."),
      ).toBeInTheDocument();
    });

    /**
     * **The double-count test's twin, and the most valuable one in this block.** The two
     * sentences say the same thing about the same copies in two different vocabularies — one
     * names the *format*'s rule, one names the reader's own box — so a build that drew both would
     * tell a reader twice that six copies are missing and send them looking for a control that is
     * not on screen under Arena at all.
     *
     * They cannot both fire, and it is a property rather than an accident: `omitted` is non-zero
     * only where `dropsInactive` is true and `heldBackInactive` only where it is false, which are
     * complementary halves of one set. Asserted from **both** sides on purpose — a fence that
     * only ever gets tested on the side it currently happens to be right about is a fence nobody
     * has tested, and each half here is one deleted `queryByText` away from being that.
     */
    it("never shares the screen with the format's own omission line", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={CUTS} />);
      await user.click(await screen.findByRole("radio", { name: "Arena" }));
      expect(
        screen.getByText("6 cards in switched-off piles are not written in this format."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/inactive categories are not written/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "Moxfield" }));
      expect(
        screen.getByText("6 cards in inactive categories are not written."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/not written in this format/)).not.toBeInTheDocument();
    });

    /**
     * `arenaOnly`'s rule read across: a field set chosen for CSV means nothing to Arena and is
     * re-derived on every format press, while "write my switched-off piles" is the same answer
     * whatever the reader passed through on the way back.
     *
     * **Arena is the right format to pass through**, because there the flag is neither drawn nor
     * read — so one trip pins both halves of the fence at once: the preference survives a format
     * that ignores it, and a reader who ticked the box on CSV does not find Arena's own rule
     * quietly overridden on the way past. That second half is the mirror of the Arena filter's
     * "does not narrow another format's export", and it is the one a filter fenced on the flag
     * alone would fail.
     */
    it("survives a trip through another format", async () => {
      const user = userEvent.setup();
      const copy = vi.mocked(copyTextMock);
      render(<ExportDialog {...props} cards={CUTS} />);
      await user.click(await screen.findByRole("radio", { name: "CSV" }));
      await user.click(inactiveBox());

      await user.click(screen.getByRole("radio", { name: "Arena" }));
      expect(boxIfDrawn()).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      // Arena's own rule stands whatever the reader ticked elsewhere: the pile is out of the file
      // and the format's sentence — not the reader's — is what says so.
      expect(copy).toHaveBeenLastCalledWith("Deck\n1 Sol Ring (LTC) 285\n");

      await user.click(screen.getByRole("radio", { name: "CSV" }));
      expect(inactiveBox()).toBeChecked();
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(copy).toHaveBeenLastCalledWith(
        "Quantity,Name,Set,Collector number,Category,Finish\n" +
          "1,Sol Ring,ltc,285,Ramp,\n6,Forest,ltc,285,Cuts,\n",
      );
    });

    /** Same claim, same reason as the format radios and the Arena box above: the preview redraws,
     *  the clipboard does not, so "Copied." would sit beside text it is no longer true of. */
    it("clears the Copied status", async () => {
      const user = userEvent.setup();
      render(<ExportDialog {...props} cards={CUTS} />);
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(await screen.findByText("Copied.")).toBeInTheDocument();

      await user.click(inactiveBox());
      expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    });

    /**
     * **A switched-off pile exported on its own is an empty file with the box off, and that is a
     * decision rather than a bug.** A category heading's `Export cards…` passes exactly that
     * pile's rows and nothing else, so a pile the reader has switched off arrives here as a list
     * every one of whose cards the default is holding back — and `formatExport` answers `""` for
     * an empty list in every format, CSV's header included.
     *
     * What makes that defensible is that the dialog says so twice before anything is written, and
     * both halves are asserted because either alone would let a silent empty file through. The
     * disclosure's label counts the lines of the **file** rather than the cards the reader
     * pointed at, so it reads `0 lines`; the count line names the copies; and the box sitting
     * above them both is the thing to untick, which is the last assertion here. A reader who
     * exports a pile and gets nothing has been told three times what happened and given the
     * control that undoes it.
     */
    it("exports a switched-off pile on its own as an empty file, and says why", async () => {
      const user = userEvent.setup();
      render(
        <ExportDialog
          {...props}
          subject="Cuts"
          suggestedFileName="Cuts"
          cards={[
            exportCard({
              name: "Forest",
              quantity: 6,
              categoryName: "Cuts",
              categoryActive: false,
            }),
            exportCard({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false }),
          ]}
        />,
      );
      expect(await screen.findByRole("button", { name: /decklist/ })).toHaveTextContent(
        "Show decklist (0 lines)",
      );
      expect(
        screen.getByText("7 cards in inactive categories are not written."),
      ).toBeInTheDocument();

      await user.click(inactiveBox());
      expect(screen.getByRole("button", { name: /decklist/ })).toHaveTextContent(
        "Show decklist (2 lines)",
      );
      await showList(user);
      expect(screen.getByText(/6 Forest/)).toBeInTheDocument();
    });
  });

  it("copies the text of the format that is showing", async () => {
    const user = userEvent.setup();
    const copy = vi.mocked(copyTextMock);
    render(
      <ExportDialog {...props} />,
    );
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(copy).toHaveBeenCalledWith(
      "Quantity,Name,Set,Collector number,Category,Finish\n2,Lightning Bolt,lea,161,Main deck,\n",
    );
  });

  it("clears the Copied status when the format changes, since it would misrepresent what's on the clipboard", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied.");

    // The preview redraws for CSV; the clipboard still holds the Plain-text copy. The status
    // line has to go with it, or it sits beside text it is no longer telling the truth about.
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a clipboard failure rather than swallowing it", async () => {
    const user = userEvent.setup();
    vi.mocked(copyTextMock).mockRejectedValueOnce(new Error("clipboard access denied"));
    render(
      <ExportDialog {...props} />,
    );
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/clipboard access denied/);
    // No false "Copied." beside the refusal.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("writes the file Rust was told to write, at the path the picker answered", async () => {
    const user = userEvent.setup();
    vi.mocked(saveMock).mockResolvedValue("D:\\decks\\Removal.txt");
    render(
      <ExportDialog {...props} />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).toHaveBeenCalledWith(
      "D:\\decks\\Removal.txt",
      "2 Lightning Bolt\n",
    );
  });

  it("writes nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    // The picker answers null on cancel. Writing to "null" is the bug this pins.
    vi.mocked(saveMock).mockResolvedValue(null);
    render(
      <ExportDialog {...props} />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).not.toHaveBeenCalled();
  });

  /**
   * **The same button, and no backend in the path at all.** On the web target
   * `dialog:allow-save` reaches nothing and there is no path to hand `export_write_file` — the
   * text goes out as a `Blob` behind an `<a download>`, which is the browser's own save. This
   * is the whole of what Task 5 changes about the export, driven from the button the reader
   * presses; `transfer/files.test.ts` pins the mechanism and the revoke.
   */
  it("hands the export to the browser as a download on the web target", async () => {
    const user = userEvent.setup();
    isWebTarget.mockReturnValue(true);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:grimoire/export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // Spied rather than allowed through: jsdom answers a real anchor click with "Not
    // implemented: navigation to another Document".
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    render(<ExportDialog {...props} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));

    expect(clicked).toHaveLength(1);
    // The name the native save dialog would have suggested, extension and all.
    expect(clicked[0].download).toBe("Removal.txt");
    expect(vi.mocked(saveMock)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.exportWriteFile)).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("reports a refused write rather than closing on it", async () => {
    const user = userEvent.setup();
    vi.mocked(saveMock).mockResolvedValue("D:\\decks\\Removal.txt");
    vi.mocked(ipc.exportWriteFile).mockRejectedValue("could not write: access denied");
    const onDismiss = vi.fn();
    render(<ExportDialog {...props} onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/access denied/);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("mounts nothing while closed", () => {
    render(<ExportDialog {...props} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers only the fields this format and this surface share", async () => {
    const user = userEvent.setup();
    render(<ExportDialog {...props} surface="wishlist" />);
    await user.click(screen.getByRole("radio", { name: "Archidekt" }));
    // A wishlist has no piles, so the format's bracket has nothing to put in it.
    expect(screen.queryByRole("checkbox", { name: "Category" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Collector number" })).toBeInTheDocument();
  });

  it("redraws the preview when a field is switched off", async () => {
    const user = userEvent.setup();
    // `exportCard()`'s own defaults are Sol Ring, LTC, 285 — the base `props.cards` is `[BOLT]`
    // (Lightning Bolt) instead, which the exact-string CSV and plain-text assertions above pin,
    // so this test names the card its own assertions are about.
    render(<ExportDialog {...props} cards={[exportCard()]} surface="deck" />);
    await user.click(screen.getByRole("radio", { name: "Moxfield" }));
    await user.click(screen.getByRole("button", { name: /Show decklist/ }));
    expect(screen.getByText(/Sol Ring \(LTC\) 285/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Set code" }));
    expect(screen.queryByText(/\(LTC\)/)).not.toBeInTheDocument();
  });

  it("clears the Copied claim when a field moves, not only when the format does", async () => {
    // The clipboard still holds the old text; the sentence beside it would stop being true.
    const user = userEvent.setup();
    render(<ExportDialog {...props} surface="deck" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Finish" }));
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
  });
});

/**
 * Task 11's `scope` prop — the collection and the wishlist pages' own line, drawn above the
 * format radios. `surface="collection"` here rather than `"deck"`: nothing about `scope` cares
 * which surface it is on, but the two real callers are the collection and the wishlist, and
 * `props.cards` (deck-shaped) is irrelevant to every assertion below — none of them read the
 * preview text.
 *
 * This suite is what fix round 1 added: the prop shipped in Task 11 with no coverage at all,
 * which is how the marketplace regression (below, and in `scope.ts`) reached review unnoticed.
 */
describe("the scope line", () => {
  const scope = (
    over: Partial<NonNullable<ExportDialogProps["scope"]>> = {},
  ): NonNullable<ExportDialogProps["scope"]> => ({
    label: "250 cards matching your filters",
    // The caller's words, not the dialog's — since the wishlist's folders, the escape hatch has
    // a second sentence to be able to say, so `scope.ts` composes both and this draws whichever
    // it is handed.
    everythingLabel: "Export everything, ignoring the filters",
    loading: false,
    everything: false,
    onEverything: vi.fn(),
    ...over,
  });

  it("draws the caller's label and an unticked Everything toggle", async () => {
    render(<ExportDialog {...props} surface="collection" scope={scope()} />);
    expect(await screen.findByText("250 cards matching your filters")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    ).not.toBeChecked();
  });

  it("calls onEverything when the checkbox is ticked", async () => {
    const user = userEvent.setup();
    const onEverything = vi.fn();
    render(<ExportDialog {...props} surface="collection" scope={scope({ onEverything })} />);

    await user.click(
      screen.getByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    );

    expect(onEverything).toHaveBeenCalledWith(true);
  });

  /**
   * A still-sweeping `cards` array is a decklist that looks smaller than it is — the failure
   * `scope.loading` exists to prevent is a reader writing or copying a truncated file that
   * looks complete. `aria-busy` on Save as… is the minor half of the same fix round: it used to
   * track `saving` alone, so a screen-reader user got no busy signal for the whole sweep and
   * only for the file write at the very end of it.
   */
  it("makes Copy and Save as… un-pressable while the sweep is still running", async () => {
    const user = userEvent.setup();
    render(<ExportDialog {...props} surface="collection" scope={scope({ loading: true })} />);

    const copyButton = screen.getByRole("button", { name: "Copy" });
    const saveButton = screen.getByRole("button", { name: /Save as/ });
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    expect(saveButton).toHaveAttribute("aria-busy", "true");

    // Not just visually disabled: a press on either must do nothing, or the guard is
    // decoration rather than the thing stopping a truncated file from being written.
    await user.click(copyButton);
    expect(copyTextMock).not.toHaveBeenCalled();
    await user.click(saveButton);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
