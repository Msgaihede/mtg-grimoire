import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_SELECTION } from "./tagFilters";
import { TagSearchBox } from "./TagSearchBox";

/** The box drawn at the state the page opens in, so a default that moved fails here. */
function openBox(overrides: Partial<Parameters<typeof TagSearchBox>[0]> = {}) {
  const onChange = vi.fn();
  const onNamespaceChange = vi.fn();
  render(
    <TagSearchBox
      value=""
      onChange={onChange}
      namespace={EMPTY_SELECTION.namespace}
      onNamespaceChange={onNamespaceChange}
      {...overrides}
    />,
  );
  return { onChange, onNamespaceChange };
}

/**
 * Records, for every Escape that reaches `window`'s bubble phase, whether something nearer the
 * reader had already spent it.
 *
 * Every rung of `useDismissOnEscape` listens on `window` and every one returns early on
 * `defaultPrevented`, so "the box consumed this press" and "whatever is open behind it stayed
 * open" are one fact read in one place. Asserting only that `onChange("")` ran would pass just
 * as well on a handler that emptied the box *and* let the press through behind it.
 */
function watchEscapeAtWindow(): { prevented: boolean[]; stop: () => void } {
  const prevented: boolean[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") prevented.push(e.defaultPrevented);
  };
  window.addEventListener("keydown", onKey);
  return { prevented, stop: () => window.removeEventListener("keydown", onKey) };
}

describe("TagSearchBox", () => {
  /**
   * **The one control on this page with a real hazard.** A reader parked on the wrong taxonomy
   * types a motif, sees nothing, and blames their spelling — so the box opens on the widest
   * setting and the toggle can only ever narrow.
   *
   * Rendered from `EMPTY_SELECTION` rather than from a literal `"both"`, because the default is
   * that constant's and a test that hard-coded the word would stay green if it moved.
   */
  it("opens on Both so the toggle can only ever narrow", () => {
    openBox();
    expect(screen.getByRole("radio", { name: "Both" })).toBeChecked();
  });

  /** Both taxonomies are named, because "Art" alone would not tell a reader what the other
   *  half of the box is for. */
  it("names both taxonomies as choices", () => {
    openBox();
    expect(screen.getByRole("radio", { name: "Art" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Oracle" })).not.toBeChecked();
  });

  it("narrows to one taxonomy when its radio is pressed", async () => {
    const user = userEvent.setup();
    const { onNamespaceChange } = openBox();

    await user.click(screen.getByRole("radio", { name: "Art" }));

    expect(onNamespaceChange).toHaveBeenCalledWith("art");
  });

  /**
   * Typed, not `paste`d — and the caret is put in the field by a **click**, the way a reader
   * puts it there. `user.type(field, …)` would focus whatever it was handed, which is how a
   * focus assertion passes over a component that never moved the caret at all.
   */
  it("reports what the reader typed", async () => {
    const user = userEvent.setup();
    const { onChange } = openBox();

    await user.click(screen.getByRole("searchbox", { name: /tags/i }));
    await user.keyboard("for");

    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: /tags/i }));
    // Controlled and never re-rendered with the new value here, so each press reports the one
    // character it added — the field's own value stays "".
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith("r");
  });

  /**
   * A box with text in it owns exactly one Escape, here as in every other filter box — the rule
   * is `clearFieldOnEscape`'s and what this pins is that *this* field is wired to it.
   *
   * The Tags page has nothing behind it that Escape navigates today, which is the point: the
   * rule has to be true of every filter box or the next one written will guess.
   */
  it("spends one Escape emptying the box, and keeps that press off the layers behind", async () => {
    const user = userEvent.setup();
    const escapes = watchEscapeAtWindow();
    try {
      const { onChange } = openBox({ value: "dragon" });

      await user.click(screen.getByRole("searchbox", { name: /tags/i }));
      await user.keyboard("{Escape}");

      expect(onChange).toHaveBeenCalledWith("");
      expect(escapes.prevented).toEqual([true]);
    } finally {
      escapes.stop();
    }
  });

  /** An empty box has nothing to undo, so the press is not its and travels on untouched. */
  it("lets Escape through an empty box", async () => {
    const user = userEvent.setup();
    const escapes = watchEscapeAtWindow();
    try {
      const { onChange } = openBox();

      await user.click(screen.getByRole("searchbox", { name: /tags/i }));
      await user.keyboard("{Escape}");

      expect(onChange).not.toHaveBeenCalled();
      expect(escapes.prevented).toEqual([false]);
    } finally {
      escapes.stop();
    }
  });

  /** A field with no visible caption still has to have a name. */
  it("names the field for a reader who cannot see the page", () => {
    openBox();
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toBeInTheDocument();
  });

  /** The radios are one group, so a screen reader hears what the choice is *about* rather than
   *  three loose buttons. */
  it("keeps the three choices in one named group", () => {
    openBox();
    const group = screen.getByRole("radiogroup", { name: /which tags/i });
    expect(group).toBeInTheDocument();
  });
});
