import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeckNameField } from "./DeckNameField";

/**
 * The field, with somewhere to Tab to.
 *
 * The button is deliberately *outside* the field, because a blur is half of what this control
 * is about — `QuickAdd.test.tsx` mounts its own escape hatch for the same reason. The name is
 * `Burn`, which is the deck `DeckEditor.test.tsx` opens, so a fixture here and one there are
 * the same deck.
 */
function mount(name = "Burn") {
  const onRename = vi.fn();
  const { container } = render(
    <>
      <DeckNameField name={name} onRename={onRename} />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { onRename, container, field: screen.getByLabelText("Deck name") };
}

describe("DeckNameField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **It is the bare `<input>`, and that is a contract rather than a style.**
   *
   * The field is the flexible child of the editor's identity row: `flex-1` and the `min-w-40`
   * floor only govern anything while the `<input>` *is* that flex item. A wrapper `<div>` here
   * would take the item's place and both classes would stop applying, on a row that has already
   * collapsed to 18px once in the shipped window. jsdom lays nothing out, so what a test can see
   * is **where the input sits**: it is the direct child of what was rendered, so any wrapper at
   * all pushes it a level down and fails this. Asserting only `tagName` would not — the query
   * below finds the `<input>` through a wrapper as happily as without one, which is precisely the
   * change this has to catch, because `DeckEditor.test.tsx`'s title-row test walks
   * `name.parentElement` and would silently start asserting about a different element.
   */
  it("renders the bare input, with the floor and the intrinsic width on it", () => {
    const { container, field } = mount();

    expect(field.tagName).toBe("INPUT");
    // The render root's own child, with nothing between — see the note above.
    expect(field.parentElement).toBe(container);
    // A floor, and not `min-w-0` — the class Tailwind emits is the whole of the fix.
    expect(field.className).toContain("min-w-40");
    expect(field.className).not.toContain("min-w-0");
    // …and an intrinsic width small enough that the floor is the only floor.
    expect(field).toHaveAttribute("size", "1");
  });

  /** There is no Save: the row in the database *is* the draft, so a name is committed the
   *  moment the reader is done with the field. */
  it("renames the deck when the name field is left", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.type(field, "Sunday burn");
    await userEvent.tab();

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Sunday burn"));
  });

  it("renames the deck on Enter without waiting for the caret to leave", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.type(field, "Sunday burn{Enter}");

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Sunday burn"));
  });

  /**
   * Enter commits and then blurs, and the blur handler commits too — in the same tick, off a
   * draft the first call had already decided to send. Two identical `deck_update`s for one
   * press, which the assertion above cannot see because it matches arguments rather than
   * counting calls. The ref this file's `commitName` reads is what makes the second call find
   * nothing to send.
   */
  it("writes one rename for one press of Enter", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.type(field, "Sunday burn{Enter}");

    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
  });

  /** A blank name is not a rename — the backend refuses it in words, and the field should not
   *  have to be told twice. */
  it("keeps the old name when the field is emptied", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.tab();

    expect(onRename).not.toHaveBeenCalled();
    expect(field).toHaveValue("Burn");
  });

  /** Re-typing the name the deck already has is not a change, so nothing is written. */
  it("writes nothing when the name is left as it was", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.type(field, "Burn");
    await userEvent.tab();

    expect(onRename).not.toHaveBeenCalled();
  });

  /**
   * **One press per draft, and the press is spent at the input rather than on `window`.**
   *
   * `DeckEditor.test.tsx`'s "spends exactly one Escape on reverting the name" is the ladder's
   * half of this — that the card pane behind the editor still gets the next press. This is the
   * field's half: back-to-back presses in one tick, which is what a held key sends. Reading the
   * state rather than the ref, the second press sees a draft React has not cleared yet and eats
   * a press it has nothing to spend.
   */
  it("spends exactly one Escape on reverting the draft", async () => {
    const { onRename, field } = mount();

    await userEvent.clear(field);
    await userEvent.type(field, "Sunday");
    // `fireEvent` answers `false` when the press was consumed.
    const first = fireEvent.keyDown(field, { key: "Escape" });
    const second = fireEvent.keyDown(field, { key: "Escape" });

    expect([first, second]).toEqual([false, true]);
    expect(field).toHaveValue("Burn");
    expect(onRename).not.toHaveBeenCalled();
  });
});
