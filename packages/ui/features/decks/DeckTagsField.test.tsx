import { useState, type FormEvent } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeckTagsField } from "./DeckTagsField";
import type { TagInUse } from "./deckTags";

/** What other decks wear, as `tagsInUse` answers it. */
const IN_USE: TagInUse[] = [
  { tag: "Budget", count: 2 },
  { tag: "Meme", count: 1 },
  { tag: "No Gamechangers", count: 1 },
];

/**
 * The field with a host holding its list, which is what the settings dialog is.
 *
 * Against a frozen `tags` every assertion about a *second* act would be about a list that never
 * took the first — and "the picked tag leaves the suggestions" is exactly such an assertion.
 */
function Harness({
  initial = [],
  inUse = IN_USE,
  onChange,
}: {
  initial?: string[];
  inUse?: TagInUse[];
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState(initial);
  return (
    <>
      <DeckTagsField
        tags={tags}
        inUse={inUse}
        onChange={(next) => {
          onChange?.(next);
          setTags(next);
        }}
        id="t"
      />
      {/* Somewhere else to put the caret, for the cases about looking away. */}
      <button type="button">Elsewhere</button>
    </>
  );
}

function field(props: Parameters<typeof Harness>[0] = {}) {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} {...props} />);
  return { onChange, box: screen.getByRole("combobox", { name: "Tags" }) };
}

/** The suggestion rows on screen, by the tag each one offers. */
function suggestions(): string[] {
  const list = screen.queryByRole("listbox", { name: "Tags on other decks" });
  if (list === null) return [];
  return within(list)
    .getAllByRole("option")
    .map((row) => row.firstElementChild?.textContent ?? "");
}

/** The chips, in order. */
function chips(): string[] {
  const list = screen.queryByRole("list", { name: "Tags on this deck" });
  if (list === null) return [];
  return within(list)
    .getAllByRole("listitem")
    .map((chip) => chip.firstElementChild?.textContent ?? "");
}

describe("DeckTagsField", () => {
  it("draws the deck's tags as chips, each with a control to take it off", () => {
    field({ initial: ["Budget", "Meme"] });

    expect(chips()).toEqual(["Budget", "Meme"]);
    expect(screen.getByRole("button", { name: "Remove the Budget tag" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove the Meme tag" })).toBeInTheDocument();
  });

  /** The list is shut until the box has the caret — a dialog that opened with a panel already
   *  hanging off one of its fields would be a dialog with something to dismiss before using. */
  it("keeps the suggestions shut until the box takes the caret", async () => {
    const user = userEvent.setup();
    const { box } = field();

    expect(suggestions()).toEqual([]);
    expect(box).toHaveAttribute("aria-expanded", "false");

    await user.click(box);

    expect(suggestions()).toEqual(["Budget", "Meme", "No Gamechangers"]);
    expect(box).toHaveAttribute("aria-expanded", "true");
  });

  it("says how many decks wear each suggestion", async () => {
    const user = userEvent.setup();
    const { box } = field();
    await user.click(box);

    expect(screen.getByRole("option", { name: /Budget\s*2 decks/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Meme\s*1 deck$/ })).toBeInTheDocument();
  });

  it("offers nothing this deck already wears", async () => {
    const user = userEvent.setup();
    const { box } = field({ initial: ["budget"] });
    await user.click(box);

    expect(suggestions()).toEqual(["Meme", "No Gamechangers"]);
  });

  it("narrows the suggestions to what has been typed", async () => {
    const user = userEvent.setup();
    const { box } = field();

    await user.type(box, "game");

    expect(suggestions()).toEqual(["No Gamechangers"]);
  });

  it("adds a pressed suggestion, empties the box and keeps the caret in it", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ initial: ["Meme"] });

    await user.type(box, "bud");
    await user.click(screen.getByRole("option", { name: /Budget/ }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Meme", "Budget"]);
    expect(chips()).toEqual(["Meme", "Budget"]);
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    // And the tag just taken is no longer on offer, so the next press can be the next tag.
    expect(suggestions()).toEqual(["No Gamechangers"]);
  });

  /**
   * **Nothing is highlighted until an arrow is pressed.** The other shape — the first row
   * pre-selected — is how a typed `Meme` becomes whatever sorted first under it on a fast Enter,
   * and the reader finds a tag on the deck they never chose.
   */
  it("adds what was typed on Enter, not the first suggestion under it", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();

    await user.type(box, "No{Enter}");

    expect(suggestions()).not.toEqual([]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["No"]);
    expect(box).not.toHaveAttribute("aria-activedescendant");
  });

  it("tidies a typed tag the way it will be stored", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();

    await user.type(box, "  Only   removal {Enter}");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Only removal"]);
  });

  it("walks the suggestions with the arrows and adds the highlighted one on Enter", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();
    await user.click(box);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const meme = screen.getByRole("option", { name: /Meme/ });
    expect(meme).toHaveAttribute("aria-selected", "true");
    // The walk is `aria-activedescendant`: the caret never leaves the box, so typing still types.
    expect(box).toHaveAttribute("aria-activedescendant", meme.id);
    expect(box).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Meme"]);
  });

  it("wraps at both ends of the list", async () => {
    const user = userEvent.setup();
    const { box } = field();
    await user.click(box);

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /No Gamechangers/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Budget/ })).toHaveAttribute("aria-selected", "true");
  });

  /** A blank and a repeat are both a press that changes nothing, and neither is a write. */
  it("reports nothing for a blank or for a tag the deck already wears", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ initial: ["Budget"] });

    await user.type(box, "{Enter}");
    await user.type(box, "   {Enter}");
    await user.type(box, "BUDGET{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    // The repeat is answered — the deck wears it — so the box does not go on holding it.
    expect(box).toHaveValue("");
  });

  it("takes a chip off when its control is pressed, and puts the caret in the box", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ initial: ["Budget", "Meme"] });

    await user.click(screen.getByRole("button", { name: "Remove the Budget tag" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Meme"]);
    expect(chips()).toEqual(["Meme"]);
    // The chip's own button has just unmounted; without this the caret would be on `<body>`.
    expect(box).toHaveFocus();
  });

  it("takes the last chip off on Backspace in an empty box, and only in an empty one", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ initial: ["Budget", "Meme"] });

    await user.type(box, "x{Backspace}");
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Budget"]);
  });

  /**
   * **A press, never a held key.** Holding Backspace to rub out a typed word goes on firing once
   * the box is empty, and without the guard each repeat takes a chip — a write, a history line
   * and an undo step apiece. `repeat` is what a held key reports on every event after the first.
   */
  it("does not strip chips on a held Backspace", () => {
    const { box, onChange } = field({ initial: ["Budget", "Meme"] });

    fireEvent.keyDown(box, { key: "Backspace", repeat: true });
    fireEvent.keyDown(box, { key: "Backspace", repeat: true });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Backspace" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Budget"]);
  });

  /**
   * The Enter that confirms an input method's candidate is not the Enter that adds a tag. Both
   * spellings of "composing" are asserted, because engines disagree about which one that
   * keydown carries: `isComposing` where the event is sent mid-composition, and `keyCode` 229
   * where it is sent just after.
   */
  it("leaves Enter alone while an input method is composing", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();
    await user.type(box, "日本");

    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });

    expect(onChange).not.toHaveBeenCalled();
    expect(box).toHaveValue("日本");

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["日本"]);
  });

  /**
   * **Enter in this box is never a form's submit.** No host is a `<form>` today, but the settings
   * form is shared with a create dialog that used to be one, and a single-line input in a
   * `<form>` submits it on Enter unless the key is stopped. The host here is a real form with a real
   * submit button, which is what makes implicit submission possible at all — against a bare
   * `<div>` this would pass with the `preventDefault` deleted.
   */
  it("keeps Enter from submitting a form it is drawn in", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <DeckTagsField tags={[]} inUse={IN_USE} onChange={onChange} id="t" />
        <button type="submit">Create</button>
      </form>,
    );

    await user.type(screen.getByRole("combobox", { name: "Tags" }), "Meme{Enter}");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Meme"]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * `DeckSettingsDialog`'s rule for its other text fields: every other control on that screen has
   * written by the time it closes, so a half-typed tag dropped by a click elsewhere would be the
   * one destructive thing on it.
   */
  it("adds a half-typed tag when the reader looks away", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();

    await user.type(box, "Gimmick");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["Gimmick"]);
    expect(suggestions()).toEqual([]);
  });

  /**
   * **"Away" is the whole field, not the input.** If a press on a chip's ✕ counted, one press
   * would be two reports built from the same list — the add, then a removal that did not know
   * about it — and the second would take the first back off.
   */
  it("does not treat a press on a chip's own control as looking away", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ initial: ["Budget"] });

    await user.type(box, "Gimmick");
    await user.click(screen.getByRole("button", { name: "Remove the Budget tag" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
    expect(box).toHaveValue("Gimmick");
  });

  /**
   * Innermost first: the list, then the draft. Asserted on `defaultPrevented`, which is what a
   * dialog's own Escape rung reads — the third press is the first one it is allowed to take.
   */
  it("spends Escape on the list, then on the draft, and only then lets it through", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field();
    const outer = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener("keydown", outer);

    await user.type(box, "bud");
    expect(suggestions()).toEqual(["Budget"]);

    await user.keyboard("{Escape}");
    expect(suggestions()).toEqual([]);
    expect(box).toHaveValue("bud");

    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");

    await user.keyboard("{Escape}");
    window.removeEventListener("keydown", outer);

    expect(outer.mock.results.slice(-3).map((r) => r.value)).toEqual([true, true, false]);
    // Cancelling is not adding: nothing was reported at any point.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works with nothing to suggest, which is every reader's first tag", async () => {
    const user = userEvent.setup();
    const { box, onChange } = field({ inUse: [] });

    await user.type(box, "First{Enter}");

    expect(suggestions()).toEqual([]);
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(["First"]);
  });
});
