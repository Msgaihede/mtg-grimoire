import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StickyNote, StickyNotePatch } from "@/lib/ipc";

interface StandInProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
}

/**
 * The lazy editor, stood in for by a textarea that **follows `value`** — the real one does too: a
 * value it did not produce replaces its document (`NoteEditor`'s value effect), which is what lets
 * an untouched body adopt a row that changed under the dialog.
 */
vi.mock("@/features/decks/NoteEditor", () => ({
  default: function NoteEditorStandIn(props: StandInProps) {
    return (
      <textarea
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  },
}));

import { StickyNoteDialog } from "./StickyNoteDialog";

/* --------------------------------------------------------------------- fixtures ------- */

const NOTE: StickyNote = {
  id: 3,
  title: "Mana",
  body: "old words",
  color: "amber",
  pinned: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * Open the dialog and wait for the lazy editor **on the real clock**, then fake the two timer
 * functions — every `findBy*` polls on `setTimeout`, so a clock faked first never lets one answer
 * (`TodoListDialog.test.tsx`'s `fakeClock`, for the same reason).
 */
async function renderDialog(note: StickyNote = NOTE) {
  const onSave = vi.fn<(patch: StickyNotePatch) => void>();
  const props = { onSave, onDelete: vi.fn(), onClose: vi.fn() };
  const view = render(<StickyNoteDialog note={note} {...props} />);
  await screen.findByRole("textbox", { name: /^Body of / });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return {
    ...view,
    onSave,
    /** The row, replaced under the open dialog — another window, a sync pull, a read-back. */
    arrive: (next: StickyNote, writeError?: unknown) =>
      view.rerender(<StickyNoteDialog note={next} {...props} writeError={writeError} />),
  };
}

/** Past the 600 ms debounce. */
const wait = (ms = 700) => act(() => vi.advanceTimersByTimeAsync(ms));

const body = () => screen.getByRole("textbox", { name: /^Body of / });
const nameField = () => screen.getByRole("textbox", { name: "Name" });

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------ cases ------- */

describe("a row that changes under an open sticky note (issue #1579)", () => {
  it("writes nothing from a dialog nobody typed in, and shows the newer row", async () => {
    const { onSave, arrive } = await renderDialog();

    arrive({ ...NOTE, body: "new words from the other window", updatedAt: 2 });
    await wait();

    expect(onSave).not.toHaveBeenCalled();
    expect(body()).toHaveValue("new words from the other window");
  });

  it("re-seeds an untouched name while the reader is writing the body, and writes only the body", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });

    arrive({ ...NOTE, title: "Renamed elsewhere", updatedAt: 2 });
    expect(nameField()).toHaveValue("Renamed elsewhere");
    await wait();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ body: "my words" });
  });

  it("keeps the reader's own unsaved words over a newer row, and writes them", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });

    arrive({ ...NOTE, body: "their words", updatedAt: 2 });
    expect(body()).toHaveValue("my words");
    await wait();

    expect(onSave).toHaveBeenCalledWith({ body: "my words" });
  });

  it("does not write a saved body back once another window replaces it", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });
    await wait();
    expect(onSave).toHaveBeenCalledTimes(1);

    arrive({ ...NOTE, body: "my words", updatedAt: 2 }); // the read-back
    arrive({ ...NOTE, body: "their words", updatedAt: 3 }); // the other window
    await wait();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(body()).toHaveValue("their words");
  });

  it("adopts a newer row that lands before the dialog's own write reads back", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });
    await wait();

    arrive({ ...NOTE, body: "their words", updatedAt: 3 });
    await wait();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(body()).toHaveValue("their words");
  });

  it("keeps a refused write owed rather than adopting over it", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });
    await wait();

    arrive({ ...NOTE, body: "their words", updatedAt: 3 }, "collection::BUSY");
    expect(body()).toHaveValue("my words");
    await wait();

    expect(onSave).toHaveBeenLastCalledWith({ body: "my words" });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("writes the same words again when the reader retypes them after another window's edit", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.change(body(), { target: { value: "my words" } });
    await wait();
    arrive({ ...NOTE, body: "my words", updatedAt: 2 });
    arrive({ ...NOTE, body: "their words", updatedAt: 3 });

    fireEvent.change(body(), { target: { value: "my words" } });
    await wait();

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith({ body: "my words" });
  });

  it("does not repaint a note whose colour was picked, saved and then changed elsewhere", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Jade" }));
    await wait();
    expect(onSave).toHaveBeenCalledWith({ color: "jade" });

    arrive({ ...NOTE, color: "jade", updatedAt: 2 });
    arrive({ ...NOTE, color: "rose", updatedAt: 3 });
    await wait();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Rose" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not re-pin a note that was pinned, saved and then unpinned elsewhere", async () => {
    const { onSave, arrive } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Pin note" }));
    await wait();
    expect(onSave).toHaveBeenCalledWith({ pinned: true });

    arrive({ ...NOTE, pinned: true, updatedAt: 2 });
    arrive({ ...NOTE, pinned: false, updatedAt: 3 });
    await wait();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pin note" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("still flushes the reader's last words at unmount", async () => {
    const { onSave, unmount } = await renderDialog();
    fireEvent.change(body(), { target: { value: "last phrase" } });

    unmount();

    expect(onSave).toHaveBeenCalledWith({ body: "last phrase" });
  });
});
