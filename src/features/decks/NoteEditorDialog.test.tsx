import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DeckNote } from "@/lib/ipc";
import { NoteEditorDialog } from "./NoteEditorDialog";
import { noteToPlainText } from "./noteMarkdown";

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
 * ⚠️ **Warm the lazy chunk once, because `findBy*` gives it one second and a cold transform can
 * take longer than that.**
 *
 * Every case below waits on the surface through `Suspense`, and the surface is Tiptap behind a
 * dynamic import — so on the *first* test of a cold run, `findByRole("textbox")` is racing Vite
 * transforming ProseMirror. Observed in this suite: the same file passed in 3.5 s and, on a run
 * whose setup alone took 2.7 s, failed with the first test timing out on exactly that await.
 * That is the shape of flake `verify` produces under load and a single run never reproduces.
 *
 * Awaiting it here puts the cost in `beforeAll`, where vitest's own timeout applies rather than
 * testing-library's one second, and leaves every case measuring the dialog instead of the
 * bundler. It is an `import()` expression and not an import statement, so the 141.5 kB sweep in
 * `DeckNotesPanel.test.tsx` is untouched by it — and a `.test.` file is exempt from that sweep
 * regardless.
 */
beforeAll(async () => {
  await import("./NoteEditor");
});

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
    // Awaited before it is counted: the surface arrives through `Suspense`, so a bare
    // `getAllByRole` would be counting the frame before the lazy chunk landed.
    await screen.findByRole("textbox");

    /*
     * **Counted, not name-matched**, and the weakness is in the *query* rather than in what it
     * happened to find.
     *
     * `queryByRole("textbox", { name: /title/i })` is what this assertion used to be. Against the
     * fields it was written for it worked honestly: both title inputs at `9a429679^` carried a
     * real `<label class="sr-only">` — `New note title` on the add row and `Title of {title}` on
     * the edit row — so their accessible names were `"New note title"` and `"Title of Mana base"`,
     * and `/title/i` matched a name a reader is actually given. (Measured with
     * `computeAccessibleName`, not inferred: a `<label for>` outranks a placeholder, and in this
     * stack a placeholder-only input computes to `""` rather than to its placeholder at all.)
     *
     * What it cannot do is say there is **no** title field, because it pins a *name pattern*: an
     * unlabelled `<input type="text" />` computes to `""`, and one labelled `Name`, `Heading` or
     * `Subject` computes to a name `/title/i` misses — every one of them the field this redesign
     * deleted, wearing a different word, and every one of them passing.
     *
     * So the box is *counted* and then identified: exactly one, and it is the body.
     */
    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAccessibleName("Body of New note");
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

  /**
   * **The blank check goes through `noteToPlainText` and never the markdown string, and this is
   * the only test that can tell those two apart.**
   *
   * Every other case here uses a `new` draft (seeded `""`, where both spellings agree) or a body
   * with real words in it — so `blank = body.trim() === ""` passes all of them, and the constraint
   * the brief, the component's header, its inline comment and its Storybook page all argue for
   * would be checked by nothing. Mutating the guard is what showed that; see the fix report.
   *
   * ⚠️ **`">"` is what Tiptap actually stores for an empty blockquote**, measured against
   * `NOTE_EXTENSIONS` rather than assumed: `toggleBlockquote()` on an empty document serialises
   * to exactly that one character. It is the real path, not a contrivance — the blockquote input
   * rule is `>` and a space, so a reader who presses those two keys and stops has a document with
   * a quote bar and nothing in it. Written raw, the body is not blank and Save would be offered,
   * producing the note named `Untitled note` with nothing in it that this rule exists to refuse.
   *
   * (An empty *heading* is not a second case and was checked: Tiptap serialises it to `""`, where
   * the two spellings agree.)
   */
  it("refuses a body that is markup and no words", async () => {
    // The premise, pinned locally — without it this test could quietly stop distinguishing the
    // two implementations while still passing, which is the failure it is here to prevent.
    const EMPTY_QUOTE = ">";
    expect(noteToPlainText(EMPTY_QUOTE).trim()).toBe("");
    expect(EMPTY_QUOTE.trim()).not.toBe("");

    const onSave = vi.fn();
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 3, title: "", body: EMPTY_QUOTE }) }}
        pending={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();

    // And the name such a note would have got, which is the whole of why it is refused.
    expect(screen.getByRole("heading", { name: "Untitled note" })).toBeInTheDocument();
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
