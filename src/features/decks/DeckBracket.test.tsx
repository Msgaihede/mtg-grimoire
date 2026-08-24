import { useRef, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { commander, gameChanger, islands } from "./validation/fixtures";
import { estimateBracket } from "./validation/bracket";
import { DeckBracket } from "./DeckBracket";

/** The real estimate, watched: the only thing worth asserting about it here is *how often* it is
 *  asked, so it delegates rather than pretending. */
vi.mock("./validation/bracket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./validation/bracket")>();
  return { ...actual, estimateBracket: vi.fn(actual.estimateBracket) };
});

/** The editor's own wiring, in the smallest thing that can hold it: one piece of state, and the
 *  two ways out kept apart (Escape hands the caret back, a click away does not). */
function Harness({ cards }: { cards: DeckCard[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button">Elsewhere</button>
      <DeckBracket
        cards={cards}
        open={open}
        buttonRef={button}
        onOpen={() => setOpen(true)}
        onDismiss={() => {
          button.current?.focus();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Bracket \d, an estimate$/ });

describe("DeckBracket", () => {
  /**
   * **The number is on the button, which is the whole of what moved on 2026-08-24.** It rode
   * inside the format check's panel before that, so a reader who wanted to know what bracket their
   * deck read as had to open a list of *findings* and scroll past them.
   */
  it("prints the estimate on its own readout", () => {
    render(<Harness cards={[commander(), gameChanger("Rhystic Study"), islands(98)]} />);

    expect(trigger()).toHaveTextContent("Bracket ~3");
  });

  /**
   * The `~` is drawn and is not spoken — a screen reader says "tilde two" or nothing at all — and
   * the word the glyph stands for is in the name instead. Advisory in the copy as well as in the
   * code: Wizards' scale is explicitly "advisory only, not hard validation".
   */
  it("says the estimate is one, in the name the glyph cannot carry", () => {
    render(<Harness cards={[commander(), islands(99)]} />);

    expect(trigger()).toHaveAccessibleName("Bracket 1, an estimate");
  });

  /** The one card fact that decides the number is a column a sync fills, so a deck with none of
   *  them reads as the bottom of the scale rather than as nothing at all. */
  it("estimates the lowest bracket for a deck with nothing in it to see", async () => {
    render(<Harness cards={[commander(), islands(99)]} />);
    await userEvent.click(trigger());

    expect(
      within(screen.getByRole("dialog")).getByText("Bracket ~1 · 0 game changers"),
    ).toBeInTheDocument();
  });

  /** The disclosure names every card the number was read from — a reader who disagrees with a
   *  heuristic can see which card caused it, which is what makes a guess worth showing. */
  it("names what it read, behind a disclosure", async () => {
    const deck = [
      commander(),
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      islands(97),
    ];
    render(<Harness cards={deck} />);
    await userEvent.click(trigger());
    const panel = screen.getByRole("dialog");

    expect(within(panel).getByText("Bracket ~3 · 2 game changers")).toBeInTheDocument();
    expect(within(panel).getByText(/estimate/i)).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: /what this read/i }));

    expect(within(panel).getByText(/Rhystic Study/)).toBeInTheDocument();
    expect(within(panel).getByText(/Cyclonic Rift/)).toBeInTheDocument();
  });

  /** Nothing to disclose for a deck the estimate read nothing off — an empty "What this read"
   *  is a control promising an answer it has not got. */
  it("offers no disclosure when it read nothing", async () => {
    render(<Harness cards={[commander(), islands(99)]} />);
    await userEvent.click(trigger());

    expect(
      within(screen.getByRole("dialog")).queryByRole("button", { name: /what this read/i }),
    ).not.toBeInTheDocument();
  });

  /** A trigger with `aria-expanded` has to be able to close what it opened — the press blurs the
   *  panel first, so a blur-away that did not know the button would close and reopen it for
   *  ever. */
  it("closes from the button that opened it", async () => {
    render(<Harness cards={[commander(), islands(99)]} />);

    await userEvent.click(trigger());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(trigger());

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  /** Escape is the keyboard way out and hands the caret back; the rung is the app's `"inner"`
   *  one, registered on the flag rather than on the panel's mount. */
  it("closes on Escape and hands the caret back", async () => {
    render(<Harness cards={[commander(), islands(99)]} />);
    await userEvent.click(trigger());

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  /** Focus leaving the control closes it and hands nothing back — the reader who tabbed away is
   *  already somewhere else. */
  it("closes when the caret leaves it, and leaves the caret where it went", async () => {
    render(<Harness cards={[commander(), islands(99)]} />);
    await userEvent.click(trigger());
    const panel = await screen.findByRole("dialog");
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });

    fireEvent.focusOut(panel, { relatedTarget: elsewhere });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).not.toHaveFocus();
  });

  /** The caret moves into the layer, as it does for every other one in this editor: the
   *  disclosure is then the next thing Tab reaches, and Escape has something to hand back. */
  it("takes the caret into the panel", async () => {
    render(<Harness cards={[commander(), gameChanger("Rhystic Study"), islands(98)]} />);
    await userEvent.click(trigger());

    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  /**
   * **The estimate runs on every edit now, and the memo is what keeps that affordable.** It used
   * to be gated on the panel being open, which stopped being possible the day the button printed
   * the number — `estimateBracket` greps every face of every card for four phrases, so one pass
   * per *change to the deck* is the cost, and one per render is not.
   */
  it("re-reads the deck only when the deck changes", () => {
    vi.mocked(estimateBracket).mockClear();
    const deck = [commander(), islands(99)];
    const view = render(<Harness cards={deck} />);
    expect(estimateBracket).toHaveBeenCalledTimes(1);

    view.rerender(<Harness cards={deck} />);
    expect(estimateBracket).toHaveBeenCalledTimes(1);

    view.rerender(<Harness cards={[...deck, gameChanger("Rhystic Study")]} />);
    expect(estimateBracket).toHaveBeenCalledTimes(2);
  });

  /** A trigger that is not pressed costs no panel at all: closed means unmounted, not hidden. */
  it("draws no panel until it is pressed", () => {
    render(<Harness cards={[commander(), islands(99)]} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("does not open itself when the caller says it is closed", () => {
    render(
      <DeckBracket
        cards={[commander(), islands(99)]}
        open={false}
        buttonRef={{ current: null }}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
