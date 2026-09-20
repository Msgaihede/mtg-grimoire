import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckNote } from "@/lib/ipc";
import { NoteEditorDialog } from "./NoteEditorDialog";

/**
 * The two `Range` methods jsdom does not implement, shimmed for the ProseMirror view this dialog
 * mounts — `NoteEditor.test.tsx` carries the whole argument at its own copy. `??=` so a jsdom that
 * grows a real implementation is used instead of these.
 *
 * Local to this file rather than in `src/test-setup.ts` for that file's reason: these two suites
 * are the only ones in the app that mount an editor.
 */
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * A reader typing into the surface, with **no delay between keystrokes**.
 *
 * ⚠️ **This deliberately steps around a race, and what it steps around is worth knowing before
 * anybody "simplifies" it back to a bare `userEvent.type`.** `NoteEditor` is controlled: each
 * keystroke serialises to markdown, the host stores it, and the editor's own sync effect then
 * compares `editor.getMarkdown()` against the `value` that render was given. `userEvent`'s
 * default inter-key delay yields to the macrotask queue between letters, so that effect can run
 * holding the *previous* keystroke's markdown while the document has already moved on — the
 * guard fails, `setContent` puts the older body back, and the caret goes with it. Measured in
 * this suite: `"Fourteen sources."` typed at the default delay arrives as `"Futen ore."`, and
 * arrives intact at `delay: null`, uncontrolled, or pasted.
 *
 * **So a bare `type` here would go red for a reason that is not this dialog's** — the same
 * arrangement, and the same race, is what `DeckNotesPanel` already had. Whether it is reachable
 * at a human typing speed in the shipped window is a live question rather than one jsdom can
 * settle, and it is recorded rather than fixed here: this file's subject is the dialog around the
 * surface.
 */
function typist() {
  return userEvent.setup({ delay: null });
}

function note(over: Partial<DeckNote> & { id: number }): DeckNote {
  return {
    deckId: 4,
    title: "",
    body: "",
    sortOrder: over.id,
    cards: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("writing a note in a dialog", () => {
  it("has no title field anywhere in the create flow", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "new" }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "New note" });
    // One box, and it is the body. A title field here is the thing this redesign deleted.
    expect(screen.queryByRole("textbox", { name: /title/i })).not.toBeInTheDocument();
  });

  /**
   * The old add row refused a blank title for this exact reason: written blank it would make a
   * note with nothing in it at all, named `Untitled note`, that the reader then has to delete.
   *
   * ⚠️ **`aria-disabled` and not `toBeDisabled()`.** That matcher reads the `disabled` *property*
   * and says nothing about `aria-disabled`, so asserting it here would have demanded the one
   * spelling this button may not use: a real `disabled` control leaves the tab order, and this
   * one greys and un-greys as the reader types. The second half is what makes the first mean
   * anything — an `aria-disabled` button still delivers its press, so the refusal has to be
   * checked by pressing it.
   */
  it("refuses to save a note with nothing in it", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "new" }}
        pending={false}
        onSave={onSave}
        onClose={onClose}
      />,
    );

    const save = await screen.findByRole("button", { name: "Save note" });
    expect(save).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(save);

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  /** The other kind of no, and the one that really is the attribute: the half-second a write is
   *  in flight, where there is nothing for the caret to be kept in reach *for*. */
  it("takes the button out of reach while the write is in flight", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 1, title: "Mana base", body: "Fourteen sources." }) }}
        pending
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("sends the body the reader typed", async () => {
    const onSave = vi.fn();
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "new" }}
        pending={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    await typist().type(await screen.findByRole("textbox"), "Fourteen sources.");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    // `stringContaining` rather than an equality: what crosses this callback is **markdown**, and
    // the dialect escapes punctuation — the sentence is the assertion, not the serialisation,
    // which `NoteEditor.test.tsx`'s round trip owns.
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining("Fourteen sources."));
  });

  it("names an edit by the note it opened on, and seeds the body", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 1, title: "Mana base", body: "Fourteen sources." }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Mana base" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox")).toHaveTextContent("Fourteen sources.");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("names a blank-titled note by its body's first line", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{
          kind: "edit",
          note: note({ id: 1, title: "", body: "Ask Supreme about the Bolt count" }),
        }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();
  });

  it("says which card a note born from the card menu will name", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "newFromCard", card: { oracleId: "o-bolt", name: "Lightning Bolt" } }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/will name Lightning Bolt/)).toBeInTheDocument();
  });

  it("writes nothing when the reader backs out", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "new" }}
        pending={false}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await typist().type(await screen.findByRole("textbox"), "Half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * `Dialog` mounts and unmounts its children, which is what makes a fresh open a fresh draft —
   * so there is no reset to write and no effect syncing the draft back to the prop.
   *
   * Asserted by *closing and reopening on a different draft*, because that is the only thing that
   * can tell the two arrangements apart: a `useState` seeded once in a component that never
   * unmounted would go on showing the first note's body under the second note's heading.
   *
   * ⚠️ **The close has to be waited for.** `Dialog` unmounts through `AnimatePresence`, so the
   * panel outlives `open === false` by its exit — and `MotionGlobalConfig.skipAnimations` makes
   * that one animation frame rather than none. Two `rerender`s in the same tick therefore never
   * unmount anything, and the test passes green against the very arrangement it is written to
   * refuse.
   */
  it("starts a fresh draft on every open", async () => {
    const view = render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 1, title: "Mana base", body: "Fourteen sources." }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("textbox")).toHaveTextContent("Fourteen sources.");

    view.rerender(
      <NoteEditorDialog
        open={false}
        draft={{ kind: "edit", note: note({ id: 1, title: "Mana base", body: "Fourteen sources." }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());

    view.rerender(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 2, title: "Sideboard", body: "Two Pyroblast." }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Sideboard" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox")).toHaveTextContent("Two Pyroblast.");
  });
});
