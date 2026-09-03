import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KEY_MAP_LABEL, KeyMap } from "@/components/KeyMap";
import { useAppStore } from "@/lib/store";

/**
 * The panel with a trigger, which is the only shape it has: {@link KeyMap} takes the button as
 * its child so that the panel follows it in DOM order.
 *
 * A plain `<button>` rather than `TitleBar`'s `CaptionButton` — what is under test here is the
 * panel, and pulling the caption in would bring the two Tauri fakes with it for the sake of
 * three utility classes. The button's own name and `aria-expanded` are asserted where they live,
 * in `TitleBar.test.tsx`.
 */
function Harness() {
  const open = useAppStore((s) => s.keyMapOpen);
  const setOpen = useAppStore((s) => s.setKeyMapOpen);
  return (
    <>
      {/* Something else to hold the caret, because that is the state `F1` opens this panel in:
          the reader was typing or walking a wall, and the panel took no focus from them. */}
      <input aria-label="Somewhere else" />
      <KeyMap>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {KEY_MAP_LABEL}
        </button>
      </KeyMap>
    </>
  );
}

/** The caps drawn for one row, in order — the `<dd>` beside the `<dt>` carrying that label. */
function capsFor(label: string): string[] {
  const caps = screen.getByText(label).nextElementSibling?.querySelectorAll("kbd") ?? [];
  return [...caps].map((cap) => cap.textContent ?? "");
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe("KeyMap", () => {
  /**
   * `activeScopes` order, drawn: what is true everywhere, then what is true where the reader is
   * standing. The editor is the second section rather than `Decks` because `App.tsx` renders it
   * *instead of* the deck gallery — a `Decks` heading over an open editor would list chords for
   * a page that is not on screen.
   */
  it("draws a section per live scope, in order", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 7, keyMapOpen: true });
    render(<Harness />);

    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Everywhere", "Deck editor"]);
    expect(screen.getByText("Undo the last change")).toBeInTheDocument();
  });

  /**
   * **A scope with nothing in it draws nothing at all** — not a heading over a gap, and not a
   * sentence promising one later. Five of the six views are in that state today, so this is the
   * case a reader is in most of the time rather than an edge one.
   */
  it("draws no heading for a scope with no shortcuts", () => {
    useAppStore.setState({ activeView: "search", openDeckId: null, keyMapOpen: true });
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Everywhere" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  /**
   * One `<kbd>` per cap, and the word `or` between two spellings of one intent. Written out
   * literally rather than through `chordParts`: an assertion that reads its own constant passes
   * against the defect it was written for.
   */
  it("draws one cap per part and joins two spellings with the word or", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 7, keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Undo the last change")).toEqual(["Ctrl", "Z"]);
    expect(capsFor("Redo the change you undid")).toEqual(["Ctrl", "Y", "Ctrl", "Shift", "Z"]);
    expect(screen.getByText("Redo the change you undid").nextElementSibling?.textContent).toContain(
      "or",
    );
  });

  /**
   * Six chords is a range rather than six alternatives, so the ends are drawn and the word
   * between them is `to`. The count is the assertion that matters: `Ctrl 1 or Ctrl 2 or …` down
   * to `Ctrl 6` is eleven caps of arithmetic in the widest row of a 384px panel.
   */
  it("draws a run of more than two chords as a range", () => {
    useAppStore.setState({ activeView: "search", openDeckId: null, keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Jump to a section")).toEqual(["Ctrl", "1", "Ctrl", "6"]);
    expect(screen.getByText("Jump to a section").nextElementSibling?.textContent).toContain("to");
  });

  /** A gesture no `KeyboardEvent` matcher can serve is still a row, and its caps say so. */
  it("draws the pointer gestures as caps of their own", () => {
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Resize the cards")).toEqual(["Ctrl", "Scroll"]);
    expect(capsFor("Pick more than one card")).toEqual(["Ctrl", "Click", "Shift", "Click"]);
  });

  /**
   * Escape closes it **and hands the caret back to the trigger**, which is this app's rule for a
   * layer Escape dismissed and is load-bearing here rather than tidy: `F1` opens this panel with
   * the caret wherever the reader left it, so without the hand-back the press would leave focus
   * in a field behind a panel that has just gone.
   *
   * The caret is walked in with Tab rather than placed with `focus()` — a programmatic focus is
   * the one caret a reader cannot produce — and never with a click, which is a press *outside*
   * the box and would close the panel before Escape could.
   */
  it("closes on Escape and hands the caret back to the trigger", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    await user.tab();
    expect(screen.getByLabelText("Somewhere else")).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: KEY_MAP_LABEL })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();
  });

  /**
   * A press somewhere else closes it and **does not** move the caret — the other half of the
   * same rule. The reader who pressed elsewhere is already elsewhere, and taking their caret to
   * the top-right corner of the window would undo the press they just made.
   */
  it("closes on a press outside the box and leaves the caret alone", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    await user.click(screen.getByLabelText("Somewhere else"));

    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Somewhere else")).toHaveFocus();
  });

  /** Closed is closed: nothing of the panel is in the tree until the flag says so. */
  it("draws nothing while the flag is false", () => {
    render(<Harness />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByText("Show this list")).not.toBeInTheDocument();
  });
});
