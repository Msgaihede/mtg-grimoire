import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { registerCommands } from "../../../.storybook/fake/core";
import type { DeckRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { CreateDeckDialog } from "./CreateDeckDialog";
import { FOCUS } from "./cardControl";
import { useDecks } from "./useDecks";

/**
 * The dialog with the two things the gallery owns and hands down: the `create` mutation, and
 * the trigger the caret is handed back to.
 *
 * **`create` is `useDecks().create`, mounted here rather than inside the dialog** — the shape
 * `DecksPage` uses, and for the reason the prop's own doc gives: the gallery calls
 * `create.reset()` on the way in, and this dialog is the only place a refused create can be
 * read. A second mutation of the dialog's own would be a second answer, and the one on screen
 * would be the one that never fired.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 */
function Dialog({
  onCreated,
  onDismiss,
  noFormats = false,
}: {
  onCreated: (deck: DeckRow) => void;
  onDismiss: () => void;
  /** Answer `format_specs_list` with nothing, which is the one launch where the seeded table
   *  has not arrived by the time the dialog opens. */
  noFormats?: boolean;
}) {
  // **During render and not in an effect**, for `preview.tsx`'s reason one floor down: an
  // effect runs after the first paint, and by then `useFormatSpecs` has already asked. The
  // world this merges into is this story's own — the decorator's own memo activated it
  // immediately before this render — and running **once** is what keeps it that way, because a
  // *re-render* on a docs page happens with whichever story's scope was activated last.
  //
  // `useState`'s lazy initializer rather than `useMemo`, which `react-hooks/void-use-memo`
  // refuses for a callback with no value: a memo caches a computation, and this is a
  // once-per-mount effect that has to land before the first read.
  useState(() => {
    if (noFormats) registerCommands({ format_specs_list: () => [] });
    return noFormats;
  });

  const { create } = useDecks();
  const [open, setOpen] = useState(true);

  return (
    <div className="grid min-h-[22rem] place-items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-accent px-3 text-sm text-accent",
          FOCUS,
        )}
      >
        New deck
      </button>
      <CreateDeckDialog
        create={create}
        open={open}
        onCreated={(deck) => {
          onCreated(deck);
          setOpen(false);
        }}
        onDismiss={() => {
          onDismiss();
          setOpen(false);
        }}
        // The scrim's way out, which moves no focus — the gallery's `close`.
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

const meta = {
  title: "Decks/Create deck dialog",
  component: Dialog,
  tags: ["autodocs"],
  args: { onCreated: fn(), onDismiss: fn(), noFormats: false },
  parameters: {
    // **Its own frame per docs story**, the same parameter `DeckSettingsDialog` carries and for
    // the same reason: the scrim is `fixed inset-0`, so rendered inline every story on this page
    // would cover the whole page rather than its own block, and the last one mounted would be
    // the only one anybody could read. `inline: false` gives each story an iframe, which is the
    // viewport the fixed positioning is then relative to.
    docs: {
      story: { inline: false, height: "26rem" },
      description: {
        component:
          "Two questions and no more: what the deck is called, and what it is for.\n\n" +
          "**It used to be an anchored popup** pinned to the New deck button and dismissed by " +
          "focus leaving it, which is the right shape for a quick-add and the wrong one for " +
          "the app's one creating act. Three defects went with the change: a refusal can no " +
          "longer be swallowed by the button disabling itself mid-write, Tab cannot walk out " +
          "into a gallery the reader is not looking at, and a `fixed` surface cannot hang off " +
          "the right of the window.\n\n" +
          "Driven end to end by `.storybook/fake/`: `deck_create` really writes and " +
          "`format_specs_list` really answers, so **Default** creates a deck and **Refused** " +
          "shows what a busy database says about it.",
      },
    },
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The dialog as it opens: the caret in the field the reader has to fill, and the seeded
 * formats in `sort_order` behind it.
 *
 * The play writes a real deck through the fake's `deck_create`, which is what a story adds
 * over the unit tests beside it — `onCreated` is handed the row the backend answered with, and
 * the gallery's own handler opens it.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText("Name"), "Sunday burn");
    await userEvent.selectOptions(canvas.getByLabelText("Format"), "modern");
    await userEvent.click(canvas.getByRole("button", { name: "Create deck" }));

    await waitFor(() =>
      expect(args.onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Sunday burn", formatKey: "modern" }),
      ),
    );
  },
};

/**
 * A write the database refuses, in the app's own words.
 *
 * **The dialog is the only place this sentence can land** — `writeFailure` covers the writes a
 * *tile* makes and not this one — so the surface has to outlive the press, and what was typed
 * has to outlive the refusal. Both are what this story shows.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(await canvas.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(canvas.getByRole("button", { name: "Create deck" }));

    await waitFor(async () => {
      await expect(await canvas.findByRole("alert")).toHaveTextContent("Could not create the deck");
    });
    // Still holding the name, so the reader presses again rather than retyping.
    await expect(canvas.getByLabelText("Name")).toHaveValue("Sunday burn");
  },
};

/**
 * The one launch where `format_specs` has not answered yet.
 *
 * The select still has to *say* something, and what it says is what it would create: Casual,
 * which is `decks.format_key`'s own DDL default. A real `disabled` is right here and nowhere
 * else on this surface — there is no reader input to make it grey, and a select with a single
 * option is not a choice worth keeping in the tab order.
 */
export const NoFormats: Story = {
  args: { noFormats: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const format = await canvas.findByLabelText("Format");
    await waitFor(async () => {
      await expect(format).toBeDisabled();
    });
    await expect(format).toHaveValue("casual");
    await expect(within(format).getAllByRole("option")).toHaveLength(1);
  },
};
