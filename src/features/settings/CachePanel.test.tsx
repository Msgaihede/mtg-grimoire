import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CachePanel } from "./CachePanel";
import type { LocalCache } from "./useDataReset";

function cache(over: Partial<LocalCache> = {}): LocalCache {
  return {
    clear: { run: vi.fn(), pending: false },
    combos: { run: vi.fn(), pending: false },
    status: null,
    ...over,
  };
}

const panel = () => screen.getByRole("region", { name: "Local cache" });
const dialog = () => screen.getByRole("dialog");

/**
 * A panel button by its words, taken **before** anything is opened.
 *
 * `Dialog` renders inline rather than through a portal, so an open confirmation is a descendant
 * of the region — and its confirm button carries the same label as the row button that raised it.
 * `within(panel())` therefore finds two the moment a dialog is up, which is why every press here
 * grabs its element while the panel is still closed.
 */
const rowButton = (name: string) => within(panel()).getByRole("button", { name });

describe("CachePanel", () => {
  /**
   * The promise the panel has to make on its face, because it is what separates this button
   * from the three below it: nothing a reader chose is in here.
   */
  it("says up front that nothing the reader owns or made is touched", () => {
    render(<CachePanel cache={cache()} />);

    expect(panel()).toHaveTextContent("fetched again when it is next needed");
    expect(panel()).toHaveTextContent("collection and decks are not touched");
  });

  /**
   * A confirmation, but a plain one — no typed word. The absence is the assertion: a word typed
   * on every dialog is a word nobody reads, which is what would make it useless on the three
   * that need it.
   */
  it("confirms without asking for a typed word", async () => {
    const user = userEvent.setup();
    const state = cache();
    render(<CachePanel cache={state} />);

    await user.click(within(panel()).getByRole("button", { name: "Clear cache" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(state.clear.run).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Clear cache" }));
    expect(state.clear.run).toHaveBeenCalledOnce();
  });

  it("says what it freed once it has run", () => {
    render(
      <CachePanel cache={cache({ status: { tone: "plain", text: "Freed 330 MB across 5,540 files." } })} />,
    );

    expect(within(panel()).getByRole("alert")).toHaveTextContent("Freed 330 MB across 5,540 files.");
  });

  /**
   * The one refusal this command has. It is a "not now" rather than a fault — the corpus
   * download is mid-flight and reads its own file back — so the reader is told when to try
   * again in the same sentence.
   */
  it("draws the mid-sync refusal it can be given", () => {
    render(
      <CachePanel
        cache={cache({
          status: {
            tone: "problem",
            text: "a card update is running — clear the cache once it has finished",
          },
        })}
      />,
    );

    expect(within(panel()).getByRole("alert")).toHaveTextContent("once it has finished");
  });

  it("goes inert while the sweep is running", () => {
    render(<CachePanel cache={cache({ clear: { run: vi.fn(), pending: true } })} />);

    expect(within(panel()).getByRole("button", { name: "Clear cache" })).toBeDisabled();
  });
});

describe("CachePanel — the combo row", () => {
  /**
   * **The label is asserted through the role query rather than through `textContent`**, because
   * that query is the thing that computes an accessible name: a label and a figure in two spans
   * separated by a CSS gap compute to one run-together string, and reading the element's text
   * back would agree with the mistake. Two buttons and no more is the other half — a third would
   * mean a row arrived without anybody deciding this panel should have one.
   */
  it("offers a second button, named and separate from the images one", () => {
    render(<CachePanel cache={cache()} />);

    expect(rowButton("Clear combos")).toBeInTheDocument();
    expect(within(panel()).getAllByRole("button")).toHaveLength(2);
  });

  /**
   * The three things the copy has to say and the one it must not. What goes, that it comes
   * straight back, and that nobody needs to press it — and no lesson about what a combo is or
   * how often the feed refreshes, which is the panel that was deleted rather than this one.
   */
  it("says what goes, that it returns, and that nobody needs to do it", () => {
    render(<CachePanel cache={cache()} />);

    expect(panel()).toHaveTextContent("The stored combos");
    expect(panel()).toHaveTextContent("downloaded again straight away");
    expect(panel()).toHaveTextContent("Nothing needs this done");
    expect(panel()).not.toHaveTextContent(/once a week|weekly/i);
  });

  /**
   * **It is not the danger zone and must not be dressed as it.** `classList.contains` rather
   * than `className.includes`: this button's hover rule is a `hover:bg-bg` variant, and a
   * substring test over a class string that contains `bg-bg` inside `hover:bg-bg` passes before
   * any state has changed. The glyph is the second half — the two rows are the same box in the
   * same colour at the same end of the same kind of sentence, so the icon is the whole of what
   * separates them at a glance.
   */
  it("wears the plain border and a glyph of its own", () => {
    render(<CachePanel cache={cache()} />);
    const combos = rowButton("Clear combos");

    expect(combos.classList.contains("border-border")).toBe(true);
    expect(combos.classList.contains("border-destructive")).toBe(false);
    expect(combos.querySelector("svg")).not.toHaveClass("lucide-eraser");
    expect(rowButton("Clear cache").querySelector("svg")).toHaveClass("lucide-eraser");
  });

  /**
   * The press is a question first. A plain one — no typed word, for the images row's reason:
   * nothing here is the reader's only copy of anything.
   */
  it("asks first, and runs nothing until the question is answered", async () => {
    const user = userEvent.setup();
    const state = cache();
    render(<CachePanel cache={state} />);

    await user.click(rowButton("Clear combos"));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(state.combos.run).not.toHaveBeenCalled();

    await user.click(within(dialog()).getByRole("button", { name: "Clear combos" }));
    expect(state.combos.run).toHaveBeenCalledOnce();
  });

  /** The one fact the button has no room for: what the download costs. */
  it("puts the size and the wait in the confirmation", async () => {
    const user = userEvent.setup();
    render(<CachePanel cache={cache()} />);

    await user.click(rowButton("Clear combos"));

    expect(dialog()).toHaveTextContent("27.5 MB");
    expect(dialog()).toHaveTextContent("takes a while");
  });

  /**
   * Dismissing has to leave the press unmade — the half a dialog wired to `open` alone gets
   * right and one wired to a bare boolean flag per button often does not.
   */
  it("runs nothing when the question is dismissed", async () => {
    const user = userEvent.setup();
    const state = cache();
    render(<CachePanel cache={state} />);

    await user.click(rowButton("Clear combos"));
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));

    expect(state.combos.run).not.toHaveBeenCalled();
  });

  /**
   * Tens of seconds, not an instant: 27.5 MB gzipped over 639 MB of JSON. `aria-busy` is the
   * half a screen reader gets, and it has to be on the button rather than only in the greying.
   */
  it("goes inert and says it is busy for the whole round trip", () => {
    render(<CachePanel cache={cache({ combos: { run: vi.fn(), pending: true } })} />);
    const combos = rowButton("Clear combos");

    expect(combos).toBeDisabled();
    expect(combos).toHaveAttribute("aria-busy", "true");
  });

  /** A refusal reaches the panel's one line in the destructive tone, and claims nothing. */
  it("draws a failed re-download without reporting a count", () => {
    render(
      <CachePanel
        cache={cache({
          status: { tone: "problem", text: "Commander Spellbook could not be reached." },
        })}
      />,
    );

    const alert = within(panel()).getByRole("alert");
    expect(alert).toHaveTextContent("Commander Spellbook could not be reached.");
    expect(alert).not.toHaveTextContent(/combos,/);
    expect(alert).toHaveClass("text-destructive");
  });

  /**
   * The rows share a panel and nothing else, which is what a single `pending` threaded through
   * both would quietly break — the images sweep is instant and has no business greying off a
   * download that takes tens of seconds.
   */
  it("leaves the images button live while the combos are downloading", () => {
    render(<CachePanel cache={cache({ combos: { run: vi.fn(), pending: true } })} />);

    expect(rowButton("Clear cache")).toBeEnabled();
    expect(rowButton("Clear cache")).not.toHaveAttribute("aria-busy");
  });

  /**
   * And the other direction: `asking` is one value across both rows, so confirming the combo
   * question must not be reading the images row's `onConfirm`.
   */
  it("runs only its own press when it is confirmed", async () => {
    const user = userEvent.setup();
    const state = cache();
    render(<CachePanel cache={state} />);

    await user.click(rowButton("Clear combos"));
    await user.click(within(dialog()).getByRole("button", { name: "Clear combos" }));

    expect(state.combos.run).toHaveBeenCalledOnce();
    expect(state.clear.run).not.toHaveBeenCalled();
  });
});
