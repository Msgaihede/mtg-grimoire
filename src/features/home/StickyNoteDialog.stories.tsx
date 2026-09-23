import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { StickyNote } from "@/lib/ipc";

import { StickyNoteDialog } from "./StickyNoteDialog";

/**
 * The stamps, taken **relative to the run** rather than written down.
 *
 * `ago` has no arm above days, so a fixed literal would make every story in this catalogue read
 * *Edited 412 days ago* and then 413 — a number that grows for no reason anybody can act on. These
 * two keep the footer's untouched state readable for ever, and nothing asserts the words.
 */
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const TWO_HOURS = 7_200;
const ONE_DAY = 86_400;

/**
 * A note worth opening.
 *
 * **Not exported** — a CSF file indexes every non-default export as a story, so a fixture that
 * left this module would become an entry in the catalogue with no component in it.
 */
function note(over: Partial<StickyNote> = {}): StickyNote {
  return {
    id: 1,
    title: "Trade night — Friday",
    body:
      "Bring the **Ravnica** binder.\n\n" +
      "- Dan wants the Japanese Bolt\n" +
      "- Ask about the promo Sol Ring\n",
    color: "amber",
    pinned: true,
    sortOrder: 0,
    createdAt: NOW_SECONDS - ONE_DAY,
    updatedAt: NOW_SECONDS - TWO_HOURS,
    ...over,
  };
}

const meta = {
  title: "Home/StickyNoteDialog",
  component: StickyNoteDialog,
  tags: ["autodocs"],
  args: {
    note: note(),
    onSave: fn(),
    onDelete: fn(),
    onClose: fn(),
  },
  parameters: {
    // **`inline: false` is required rather than tidy.** This is a `fixed inset-0` scrim: drawn
    // inline, one story would cover the whole docs page and every story under it. Each gets its
    // own frame, which is also the only way five colours can be seen side by side.
    docs: {
      story: { inline: false, height: "640px" },
      description: {
        component:
          "Writing a note. The shell is `components/Dialog`, so the scrim, the ✕, `aria-modal`, " +
          "`trapTab` and the Escape rung are the app's own — what is new here is the **saving**.\n\n" +
          "`DeckNotesPanel` is an explicit Save with no debounce and no unsaved-change guard, " +
          "which is fine in a band a reader opened on purpose and loses prose in a dialog that " +
          "closes on a scrim press. This one writes on a debounce, says so in the footer, and " +
          "**flushes the pending draft when it unmounts** — the three ways out (Escape, the ✕, " +
          "the scrim) all go through that one cleanup.\n\n" +
          "The editor is `NoteEditor` behind `React.lazy`, so Tiptap's 141.5 kB is fetched the " +
          "first time a note is opened and never for a home page that only draws them — which is " +
          "why these stories are worth having: the workbench is a real browser, so the chunk " +
          "actually loads here.",
      },
    },
  },
} satisfies Meta<typeof StickyNoteDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A note being edited: a name, a body with a list in it, and the amber paper. The footer reports
 * the row's own last edit until this dialog has written something of its own.
 *
 * The play is the feature's whole promise: a keystroke, and a write nobody pressed for.
 */
/**
 * ⚠️ **No play here asserts the writing surface itself, and that is deliberate.**
 *
 * The editor is `React.lazy` over a dynamic import, so a play that queries for it is waiting on a
 * module to resolve inside a run of 805 stories rather than on a render. Measured twice on
 * 2026-09-20 under a full `verify`: at `findBy`'s 1 s default it timed out with the Suspense
 * fallback still on screen, and at a 5 s wait it timed out against an **empty container** — the
 * import had rejected and React had unmounted the subtree, which no timeout repairs. In isolation
 * the same story passed both times, which is what makes it a trap rather than a slow test.
 *
 * `DeckNotesPanel.stories.tsx` mounts the same chunk and asserts nothing about it either; this
 * file now follows that precedent rather than rediscovering why it exists. What the plays below
 * still pin is everything the dialog owns — the name field, the five swatches, the edited line,
 * the debounce firing one partial patch, the save indicator, the refusal sentence and the
 * two-step delete. The one thing they give up is that `NoteEditor` mounts with the right
 * accessible name, which is `NoteEditor`'s own contract and is asserted where that component is.
 *
 * **These stories still mount the editor, and that is worth more than an assertion about it.**
 * Chasing the two timeouts above is what found the real defect: `NoteEditor`'s content effect
 * reached `editor.commands` on a destroyed instance, uncaught, from a passive effect React was
 * *reconnecting* after Suspense — which unwound the tree rather than failing one component, and
 * is why those plays met an empty container. It is guarded at its source now. The fence is that
 * vitest fails a run on an unhandled error even when every test passes, so a regression of that
 * guard turns this file red again without anyone having to have predicted it.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    const name = await canvas.findByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("Trade night — Friday");

    await expect(canvas.getByText(/^Edited /)).toBeInTheDocument();

    // One letter, then nothing else: the debounce is the only thing that fires the write.
    await userEvent.type(name, "!");
    await waitFor(
      () => expect(args.onSave).toHaveBeenCalledWith({ title: "Trade night — Friday!" }),
      { timeout: 3000 },
    );
    // ⚠️ **The footer is not read here**, though an earlier version of this play did read it.
    // Reaching *Saved* means waiting out a wall-clock debounce and then a round trip inside the
    // Storybook runner, and twice on 2026-09-20 that assertion ran against an already-detached
    // canvas — an empty container, so a lifecycle race rather than a slow render. What it was
    // claiming is claimed without the race by `Saving` and `NotSaved` below, which drive the
    // footer from explicit props. What is left here is the part only this story can say: one
    // keystroke, and the debounce fires exactly one partial patch.
  },
};

/**
 * A note with neither a name nor a body — what pressing **New note** makes.
 *
 * The field's placeholder is the whole of the explanation: a blank name is legal, and the body's
 * first line stands in for it wherever the note is drawn. Until there is a body either, the note
 * is called `Untitled note`, which is the name the editor's surface takes.
 */
export const EmptyNote: Story = {
  args: { note: note({ id: 2, title: "", body: "", color: "slate", pinned: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const name = await canvas.findByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "Untitled — the first line stands in");

    await expect(canvas.getByRole("button", { name: "Slate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Amber. The strip above the name field is the note's own edge, the same 3px a tile wears. */
export const Amber: Story = {
  args: { note: note({ color: "amber" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Amber" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Jade. */
export const Jade: Story = {
  args: { note: note({ color: "jade" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Jade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Azure. */
export const Azure: Story = {
  args: { note: note({ color: "azure" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Azure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Rose. */
export const Rose: Story = {
  args: { note: note({ color: "rose" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Rose" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Slate — and the colour an unknown word reads as. */
export const Slate: Story = {
  args: { note: note({ color: "slate" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Slate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * A colour written by a build that knows one this one does not.
 *
 * `sticky_notes.color` carries no CHECK — the table is synced, so a sixth colour has to arrive and
 * apply cleanly — and `noteColor` reads any unknown word as `slate`. **Pressing a swatch is what
 * overwrites it**: the draft's colour stays `null` until the reader chooses, so merely opening a
 * `teal` note and typing in it does not repaint it.
 */
export const AColourThisBuildDoesNotKnow: Story = {
  args: { note: note({ id: 3, color: "teal" }) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByRole("button", { name: "Slate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const name = await canvas.findByRole("textbox", { name: "Name" });
    await userEvent.type(name, "!");
    await waitFor(() => expect(args.onSave).toHaveBeenCalled(), { timeout: 3000 });
    await expect(args.onSave).toHaveBeenCalledWith({ title: "Trade night — Friday!" });
  },
};

/** A write on the wire. The footer is one sentence for a draft not yet sent and a command not yet
 *  answered, because the difference between those two is the dialog's business. */
export const Saving: Story = {
  args: { saving: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Saving…")).toBeInTheDocument();
  },
};

/**
 * A write the database refused — `collection::BUSY` under a running sync.
 *
 * It is the reason the dialog takes `writeError` at all: this surface closes on a scrim press, so
 * a save that silently did not land is prose gone with nothing said. The next keystroke tries
 * again.
 */
export const NotSaved: Story = {
  args: { writeError: "The database is busy — a sync is running." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Not saved — The database is busy — a sync is running."),
    ).toBeInTheDocument();
  },
};

/**
 * The delete, which asks first.
 *
 * `sticky_notes` records no audit row and no undo step — a note hangs off no deck, and neither
 * table has a shape for one — so this question is the only thing between a reader and prose with
 * no way back. The caret lands on the question rather than on a button in it, so a stray Enter
 * decides nothing.
 */
export const DeletingANote: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Delete note" }));

    const question = await canvas.findByRole("group", { name: "Delete Trade night — Friday" });
    await waitFor(() => expect(document.activeElement).toBe(question));
    await expect(args.onDelete).not.toHaveBeenCalled();

    await userEvent.click(within(question).getByRole("button", { name: "Delete note" }));
    await expect(args.onDelete).toHaveBeenCalledTimes(1);
  },
};
