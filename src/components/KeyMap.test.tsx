import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Caps, KEY_MAP_LABEL, KeyMap } from "@/components/KeyMap";
import { QUERY_KEYWORDS, parseQuery } from "@/features/search/queryLanguage";
import type { Shortcut } from "@/lib/shortcuts";
import { useAppStore } from "@/lib/store";
import { isWebTarget } from "@/pwa/target";

// `isWebTarget` reads `__CORE__`, which vitest fixes at "tauri", so the one case below that is
// about the web build can only get there by mocking the module — its own doc says so.
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

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

/**
 * What the row is *read out* as: the `<dd>`'s text flattened the way a text alternative is
 * flattened — runs of whitespace collapsed to one space, the ends trimmed.
 *
 * **{@link capsFor} cannot see this and never could.** It reads each `<kbd>` on its own, so it is
 * green whether or not anything separates them, while what an assistive technology gets is the
 * concatenation — `Ctrl1toCtrl9` for caps held apart by nothing but a flex `gap`.
 */
function readingOf(label: string): string {
  const row = screen.getByText(label).nextElementSibling;
  return (row?.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.mocked(isWebTarget).mockReturnValue(false);
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
   * sentence promising one later. All nine views are in that state today — `deckEditor` is a
   * scope of its own that *replaces* `decks` rather than filling it — so this is the case a
   * reader is in most of the time rather than an edge one.
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
   * `switchView` **declares** itself a range, so the ends are drawn and the word between them is
   * `to`. The count is the assertion that matters: `Ctrl 1 or Ctrl 2 or …` down to `Ctrl 9` is
   * eighteen caps of arithmetic in the widest row of a 384px panel — two per chord, `Ctrl` plus
   * the digit.
   */
  it("draws a shortcut that declares itself a range as its two ends, joined by to", () => {
    useAppStore.setState({ activeView: "search", openDeckId: null, keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Jump to a section")).toEqual(["Ctrl", "1", "Ctrl", "9"]);
    expect(screen.getByText("Jump to a section").nextElementSibling?.textContent).toContain("to");
  });

  /**
   * The other direction, and the one the catalogue cannot supply: **three chords that are three
   * spellings**, which the old `chords.length > 2` rule would have drawn as `Alt A` to `Alt C` —
   * a panel promising a reader `Alt+B` when nothing binds it.
   *
   * Constructed here rather than added to `SHORTCUTS`, because a row in the catalogue is a row
   * the shipped panel draws: the fixture would be advertising a chord to real readers to keep a
   * test honest. {@link Caps} is exported for exactly this.
   */
  it("draws a multi-chord shortcut that is not a range as every chord, joined by or", () => {
    const alternatives: Shortcut = {
      id: "threeSpellings",
      label: "Do the thing three ways",
      chords: [
        { key: "a", alt: true },
        { key: "b", alt: true },
        { key: "c", alt: true },
      ],
    };
    render(
      <dl>
        <dt>{alternatives.label}</dt>
        <Caps shortcut={alternatives} />
      </dl>,
    );

    expect(capsFor(alternatives.label)).toEqual(["Alt", "A", "Alt", "B", "Alt", "C"]);
    const drawn = screen.getByText(alternatives.label).nextElementSibling?.textContent ?? "";
    expect(drawn).toContain("or");
    expect(drawn).not.toContain("to");
  });

  /** A gesture no `KeyboardEvent` matcher can serve is still a row, and its caps say so. */
  it("draws the pointer gestures as caps of their own", () => {
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Resize the cards")).toEqual(["Ctrl", "Scroll"]);
    expect(capsFor("Pick more than one card")).toEqual(["Ctrl", "Click", "Shift", "Click"]);
  });

  /**
   * **A second window exists only on the desktop, so its row is drawn only there.** The catalogue
   * carries it on every build and `shownOn` is the filter; this pair is what holds the panel to
   * applying it, since `shortcuts.test.ts` can only say what the filter answers, not that anybody
   * asks. Both halves, because a panel that never drew the row passes the second on its own.
   */
  it("lists Ctrl+Shift+N for a new window on the desktop", () => {
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    expect(capsFor("Open a new window")).toEqual(["Ctrl", "Shift", "N"]);
  });

  it("leaves the new-window row off the web build, where nothing binds it", () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    expect(screen.queryByText("Open a new window")).not.toBeInTheDocument();
    // The section is still drawn, so this is the one row filtered rather than the panel empty.
    expect(screen.getByText("Show this list")).toBeInTheDocument();
  });

  /**
   * **The caps are separated by text, not by the `gap` between them**, and a gap is read out as
   * nothing at all: without a text node the range row flattens to `Ctrl1toCtrl9`. This repo has
   * paid for that once already — a label and its count in two spans computed to `Missing2` — and
   * a stylesheet cannot fix it, since the separation has to exist in the markup an assistive
   * technology reads. Every shape is pinned, because each puts a different thing between two
   * caps: a range's `to`, two spellings' `or`, and a single chord's modifiers with nothing
   * between them but the space this case exists for.
   */
  it("reads out with a space between the caps", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 7, keyMapOpen: true });
    render(<Harness />);

    expect(readingOf("Jump to a section")).toBe("Ctrl 1 to Ctrl 9");
    expect(readingOf("Redo the change you undid")).toBe("Ctrl Y or Ctrl Shift Z");
    expect(readingOf("Undo the last change")).toBe("Ctrl Z");
  });

  /**
   * Escape closes it and the caret stays on the trigger — this app's rule for a layer Escape
   * dismissed, met from the side where the hand-back is what it has always been.
   *
   * **Opened by pressing the trigger**, which is the half of this the case below is not: a click
   * puts the caret inside the box, so the guarded hand-back fires and lands where the caret
   * already was.
   */
  it("closes on Escape and leaves the caret on the trigger it was opened from", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: KEY_MAP_LABEL }));
    expect(screen.getByRole("heading", { name: "Everywhere" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: KEY_MAP_LABEL })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();
  });

  /**
   * **A caret with nowhere to go is rescued, and that is the other half of the same rule.**
   * Nothing in the panel is focusable, so a press on its own text blurs the trigger to `<body>`
   * — and Escape closing the panel there would leave the caret on `<body>` for good, where the
   * next Tab restarts from the top of the app. `contains()` alone answers `false` for that
   * state, which is why the condition asks whether the caret has anywhere to go rather than
   * where it is.
   *
   * The heading is clicked rather than the caret placed by hand, because *how* the caret came to
   * be nowhere is the case: `userEvent` blurs to `<body>` when a press lands on something with
   * no focusable ancestor, which is exactly what a reader's press on a `<kbd>` does. It is a
   * press **inside** the box, so the outside-click rule leaves the panel open.
   */
  it("closes on Escape and rescues a caret the panel dropped on the body", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: KEY_MAP_LABEL }));
    await user.click(screen.getByRole("heading", { name: "Everywhere" }));
    expect(document.body).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: KEY_MAP_LABEL })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();
  });

  /**
   * The other way in, and the one an unconditional hand-back gets wrong: **`F1` opens this panel
   * without moving the caret**, so a reader typing in the deck editor's quick-add box never left
   * that box — and Escape carrying them off to the caption row is a layer handing back a caret it
   * never took.
   *
   * The rationale this replaced said the hand-back stopped Escape "leaving focus in a field
   * behind a panel that has just gone", which describes a state that cannot occur: the field
   * still holds the caret and is still on screen, because the panel took neither. This case and
   * the one above fail for different reasons and are both needed — an unconditional `focus()`
   * reddens this one alone, and a bare `contains()` reddens that one alone.
   *
   * The flag is written rather than the trigger pressed, because that is exactly what `F1` does
   * to this component — `AppShell` owns the key and this panel only ever sees the flag turn over
   * — and the caret is walked in with Tab rather than placed with `focus()`, a programmatic focus
   * being the one caret a reader cannot produce.
   */
  it("closes on Escape and leaves the caret where F1 found it", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    await user.tab();
    expect(screen.getByLabelText("Somewhere else")).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.getByLabelText("Somewhere else")).toHaveFocus();
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

/**
 * The panel's second half: what a reader may type into any card search box.
 *
 * **The whole of why this is a tab rather than a fifth section** is that the panel is 384px wide
 * and is opened to find a chord: fourteen keywords with examples appended under the chord
 * sections would bury the thing it is for. The two halves are also not the same shape — a
 * syntax row is a word you type and an explanation, not a chord — so they cannot share the
 * caps layout.
 */
describe("KeyMap's search syntax tab", () => {
  /**
   * `shortcuts.ts`'s principle, one module over: **the panel and the parser read one table**, so
   * the panel cannot advertise a keyword nothing parses. There it is `SHORTCUTS`, read by the
   * handler that fires and the panel that lists it; here it is `QUERY_KEYWORDS`, read by
   * `parseQuery` and by `QuerySyntaxHelp`.
   *
   * Every `example` is the claim: a reader who copies it gets exactly one term and no leftover
   * free text. A row whose example parses to nothing would be a keyword the panel promises and
   * the box ignores — the drift both modules exist to end, and the one failure a reader cannot
   * tell from a search that simply matched nothing.
   */
  it("draws only keywords the parser actually reads", () => {
    for (const spec of QUERY_KEYWORDS) {
      const parsed = parseQuery(spec.example);
      expect(
        parsed.predicates.length + parsed.tags.length,
        `${spec.example} did not parse to exactly one term`,
      ).toBe(1);
      expect(parsed.text, `${spec.example} leaked free text`).toBe("");
    }
  });

  /**
   * The other half of the same fence, and it is not implied by the first: a table every row of
   * which parses is worth nothing if the panel draws twelve of its fourteen rows. The grouping
   * is derived rather than written down, so a keyword added to the table with a shape nobody
   * anticipated must still reach the screen — this is what says it did.
   */
  it("draws a row for every keyword in the table", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Search syntax" }));

    for (const spec of QUERY_KEYWORDS) {
      expect(screen.getByText(spec.keywords.join(" · "))).toBeInTheDocument();
      expect(screen.getByText(spec.example)).toBeInTheDocument();
      expect(screen.getByText(spec.blurb)).toBeInTheDocument();
    }
  });

  /**
   * Shortcuts is what F1 opens on, and pressing the other tab replaces the panel's body rather
   * than adding to it. Both halves are asserted: a tab that switched the heading and left the
   * chords underneath would pass the first assertion alone.
   */
  it("shows shortcuts first and switches to syntax on the tab", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeView: "search", openDeckId: null, keyMapOpen: true });
    render(<Harness />);

    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Show this list")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Search syntax" }));

    expect(screen.getByRole("tab", { name: "Search syntax" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("t:goblin")).toBeInTheDocument();
    expect(screen.queryByText("Show this list")).not.toBeInTheDocument();
  });

  /**
   * **A reader who opened F1 for a chord should find chords**, whatever the last reader of this
   * panel was looking up. The state is held by a component that mounts with the panel, so the
   * reset is the element going away rather than an effect watching a flag — see
   * {@link KeyMap}'s own note on why.
   */
  it("opens on Shortcuts again after being closed", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: KEY_MAP_LABEL }));
    await user.click(screen.getByRole("tab", { name: "Search syntax" }));
    expect(screen.getByText("t:goblin")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: KEY_MAP_LABEL }));

    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("t:goblin")).not.toBeInTheDocument();
  });

  /**
   * **`role="tab"` is a contract and not a name**, which is exactly why `DeckSearchPanel`'s strip
   * refuses it and settles for `aria-pressed`. Taking the role here means honouring it: one tab
   * stop for the pair, the arrows walking between them, and the selection following the caret.
   * A `tab` role with no keyboard behaviour is worse than no role at all — a screen reader
   * announces a contract the control does not keep.
   *
   * Clicked rather than focused by hand: a programmatic `focus()` is the one caret a reader
   * cannot produce, and what is under test is the key that follows a real press.
   */
  it("walks the two tabs with the arrow keys, and only one of them is a tab stop", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    const shortcuts = screen.getByRole("tab", { name: "Shortcuts" });
    const syntax = screen.getByRole("tab", { name: "Search syntax" });
    expect(shortcuts).toHaveAttribute("tabindex", "0");
    expect(syntax).toHaveAttribute("tabindex", "-1");

    await user.click(shortcuts);
    await user.keyboard("{ArrowRight}");

    expect(syntax).toHaveFocus();
    expect(syntax).toHaveAttribute("aria-selected", "true");
    expect(shortcuts).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("t:goblin")).toBeInTheDocument();

    // It wraps, because two tabs and a one-way arrow is a dead end at either end.
    await user.keyboard("{ArrowRight}");
    expect(shortcuts).toHaveFocus();
    expect(screen.getByText("Show this list")).toBeInTheDocument();
  });

  /**
   * The wiring rather than the attributes: a panel whose `id` is not the one its tab points at
   * is two controls that look related and are not, and every assertion about the presence of
   * `role="tabpanel"` passes over it.
   */
  it("names each panel with the tab that opens it", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    const onShortcuts = screen.getByRole("tabpanel");
    expect(onShortcuts).toHaveAccessibleName("Shortcuts");
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute(
      "aria-controls",
      onShortcuts.id,
    );

    await user.click(screen.getByRole("tab", { name: "Search syntax" }));

    const onSyntax = screen.getByRole("tabpanel");
    expect(onSyntax).toHaveAccessibleName("Search syntax");
    expect(screen.getByRole("tab", { name: "Search syntax" })).toHaveAttribute(
      "aria-controls",
      onSyntax.id,
    );
  });

  /**
   * The one sentence of prose on the tab, and the one claim in it no table can keep honest.
   * `-t:land` is written by hand, so it is checked by hand — against the parser, not against a
   * copy of itself.
   */
  it("says how terms combine, in a form the parser honours", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ keyMapOpen: true });
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "Search syntax" }));
    expect(screen.getByText("-t:land")).toBeInTheDocument();

    const parsed = parseQuery("-t:land");
    expect(parsed.predicates).toHaveLength(1);
    expect(parsed.predicates[0].negated).toBe(true);
    expect(parsed.text).toBe("");
  });
});
