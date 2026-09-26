import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TokenModeControl, type TokenMode } from "./TokenModeControl";

/**
 * The deck's token mode — `decks.token_mode`, user schema v52 (token stacks spec §4.5).
 *
 * The words are written out here rather than read off the component's own tables, so a test that
 * passed against a label the component had invented cannot exist.
 */
function draw(value: TokenMode, onChange = vi.fn()) {
  const view = render(<TokenModeControl value={value} onChange={onChange} idPrefix="t" />);
  return { onChange, ...view };
}

/** Every button in the group, as `[word, aria-pressed]` — a list, so "exactly one" is a claim. */
function buttons(): [string, string | null][] {
  return within(screen.getByRole("group", { name: "Tokens" }))
    .getAllByRole("button")
    .map((b) => [b.textContent ?? "", b.getAttribute("aria-pressed")]);
}

describe("TokenModeControl", () => {
  /**
   * **Two of the three words, and the missing one is the point.** `collection` is in the column's
   * `CHECK` from v52, and PR 3 is what gives it custody; a `Collection` button here would behave
   * exactly as `Managed` does, which is a control that lies about what it does.
   */
  it("is a group named Tokens holding Managed and Hide, and no Collection", () => {
    draw("managed");

    expect(buttons().map(([word]) => word)).toEqual(["Managed", "Hide"]);
    expect(screen.queryByRole("button", { name: /collection/i })).toBeNull();
    // Toggles in a group, never a radiogroup — `DeckKindGroup`'s grammar.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  /** The pressed one is the value, and exactly one of the two is pressed. */
  it("presses the button for the value it is given", () => {
    const { rerender } = draw("managed");
    expect(buttons()).toEqual([
      ["Managed", "true"],
      ["Hide", "false"],
    ]);

    rerender(<TokenModeControl value="hidden" onChange={vi.fn()} idPrefix="t" />);
    expect(buttons()).toEqual([
      ["Managed", "false"],
      ["Hide", "true"],
    ]);
  });

  /** A press hands back the column's own word — `hidden`, not the button's `Hide`. */
  it("calls onChange with the mode's stored word", async () => {
    const { onChange } = draw("managed");

    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onChange).toHaveBeenLastCalledWith("hidden");

    await userEvent.click(screen.getByRole("button", { name: "Managed" }));
    expect(onChange).toHaveBeenLastCalledWith("managed");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  /**
   * A deck a newer build put in Collection mode reaches this one through sync. Neither button is
   * that answer, so neither is pressed — pressing one would claim the deck is in a mode it is not.
   */
  it("presses nothing for a mode this build does not draw", () => {
    draw("collection");

    expect(buttons()).toEqual([
      ["Managed", "false"],
      ["Hide", "false"],
    ]);
  });

  /**
   * Named by the word a reader can see beside it — WCAG 2.5.3 — and through the host's prefix,
   * so the band's control and Deck settings' can both be mounted without sharing an `id`.
   */
  it("is labelled by its own visible word, under the host's prefix", () => {
    render(
      <>
        <TokenModeControl value="managed" onChange={vi.fn()} idPrefix="band" />
        <TokenModeControl value="hidden" onChange={vi.fn()} idPrefix="settings" />
      </>,
    );

    const groups = screen.getAllByRole("group", { name: "Tokens" });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.getAttribute("aria-labelledby"))).toEqual([
      "band-token-mode",
      "settings-token-mode",
    ]);
    expect(document.getElementById("band-token-mode")).toHaveTextContent("Tokens");
  });
});
