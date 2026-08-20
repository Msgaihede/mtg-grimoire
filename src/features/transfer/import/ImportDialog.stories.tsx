import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import type { DeckVariant } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useDeck } from "@/features/decks/useDeck";
import type { ImportDestination } from "./destination";
import { DeckImportSubtitle, deckDestination } from "./destinations/DeckPreview";
import { NewDeckPreview } from "./destinations/NewDeckPreview";
import { newDeckDestination } from "./destinations/newDeck";
import { REFERENCE_LIST } from "./fixtures";
import { ImportDialog } from "./ImportDialog";

/**
 * The dialog with the trigger both entry points give it.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 *
 * **`cardsInVariant` is read from the deck rather than passed in**, which is what `DeckEditor`
 * does with the same number: it is the count of the list on screen, and a story that stated it
 * would be the one thing here not computed from the seeded data.
 *
 * **One destination either way**, which is what both entry points hand it: the editor builds the
 * deck that is open, the gallery the deck a list is about to become. A shell given one draws no
 * destination radios — a choice between one thing is not a choice.
 */
function Dialog({
  deckId,
  variant,
  onDismiss,
  onImported,
}: {
  /** `null` imports into a deck of its own — the gallery's entry point. A number is the
   *  editor's, importing into the deck that is open. */
  deckId: number | null;
  variant: DeckVariant;
  onDismiss: () => void;
  onImported: (deckId: number, added: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const deck = useDeck(deckId, variant);
  const cardsInVariant = deck.cards.reduce((n, card) => n + card.quantity, 0);

  const destination = useMemo<ImportDestination>(() => {
    const landed = (id: number, added: number) => onImported(id, added);
    return deckId === null
      ? {
          ...newDeckDestination,
          Preview: (props) => (
            <NewDeckPreview {...props} onImported={(id, out) => landed(id, out.added)} />
          ),
        }
      : deckDestination({
          deckId,
          variant,
          cardsInVariant,
          onImported: (id, out) => landed(id, out.added),
        });
  }, [deckId, variant, cardsInVariant, onImported]);

  return (
    <div className="grid min-h-[30rem] place-items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-border px-3 text-sm text-dim",
          FOCUS,
        )}
      >
        Import deck
      </button>
      <ImportDialog
        destinations={[destination]}
        subtitle={
          deckId === null ? (
            "Paste a list or choose a file, and it becomes a deck of its own."
          ) : (
            <DeckImportSubtitle deckId={deckId} variant={variant} />
          )
        }
        open={open}
        onDismiss={() => {
          onDismiss();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

const meta = {
  title: "Transfer/Import dialog",
  component: Dialog,
  tags: ["autodocs"],
  args: { deckId: null, variant: "live" as DeckVariant, onDismiss: fn(), onImported: fn() },
  parameters: {
    // **Its own frame per docs story**, the same parameter `CreateDeckDialog` and
    // `DeckSettingsDialog` carry and for the same reason: the scrim is `fixed inset-0`, so
    // rendered inline every story on this page would cover the whole page rather than its own
    // block, and the last one mounted would be the only one anybody could read.
    docs: {
      story: { inline: false, height: "40rem" },
      description: {
        component:
          "A decklist, from anywhere, into whatever the host offered — in two steps and one " +
          "panel.\n\n" +
          "**Nothing is written until Import.** The reader pastes or picks a file, presses " +
          "Preview, and is shown what the import would do: which pile every card lands in, " +
          "which lines nothing answered, which printing was used where theirs could not be " +
          "found, and who the commander is going to be.\n\n" +
          "**The second step belongs to the destination**, which is why the new deck's name, " +
          "format and game are drawn beside the tally they change rather than under the paste " +
          "box. The shell owns the text, the file picker and the one `import_resolve` call, " +
          "and knows nothing else about where the cards are going.\n\n" +
          "Driven end to end by `.storybook/fake/`: `import_resolve` really looks every " +
          "name up and `deck_import_commit` really writes. **The workbench's corpus is 43 " +
          "printings**, not the app's 116 k, so a list of real cards mostly quotes itself back " +
          "here — which is why `PastedReferenceList` shows what it does. The one gesture no " +
          "story can reach is the file picker: `open()` from `@tauri-apps/plugin-dialog` is " +
          "the operating system's window, and outside the app there is nothing behind it.",
      },
    },
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The dialog as it opens: an empty box with the caret in it, and a Preview that cannot be
 *  pressed until there is something to read. */
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const box = await canvas.findByLabelText("Decklist");
    await waitFor(async () => {
      await expect(box).toHaveFocus();
    });
    await expect(canvas.getByRole("button", { name: "Preview" })).toBeDisabled();
  },
};

/**
 * The 105-line list this feature was designed around, previewed.
 *
 * **Most of it quotes itself back, and that is the workbench rather than the app.** The fake's
 * corpus is 43 printings; the real one is 116 k, where this list resolves to 117 cards across
 * eight piles. What the story is worth is the shape at that size: a hundred quoted lines in a
 * box that scrolls inside the dialog rather than growing it, with the tally of what *did*
 * resolve still readable above them.
 *
 * The name is typed on the preview step, which is where the new-deck destination asks for it —
 * beside the tally its format changes rather than under the box the list was pasted into.
 */
export const PastedReferenceList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste(REFERENCE_LIST);
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    await userEvent.type(await canvas.findByLabelText("Name"), "Selvala");

    // Something landed, so the import is live — and the rest is quoted with its line number.
    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Import" })).toBeEnabled();
    });
    await expect((await canvas.findAllByText(/^line \d+ · "/)).length).toBeGreaterThan(50);
  },
};

/**
 * One typo among cards that resolve.
 *
 * A line nothing answered is **quoted, never an error**: 99 good lines must not be lost to one
 * bad one, so the import stays live and the reader decides what to do about line 3.
 */
export const WithUnmatchedLines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("4 Lightning Bolt\n2 Sol Ring\n1 Lightning Bolth\n1 Counterspell");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    await userEvent.type(await canvas.findByLabelText("Name"), "Burn");

    await expect(await canvas.findByText('line 3 · "1 Lightning Bolth"')).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Import" })).toBeEnabled();
  },
};

/**
 * More than one card in the list could be the commander, so the dialog asks.
 *
 * **Multi-select, because partners are two commanders.** Nothing pairs by itself — a pairing is
 * a choice, and the editor's own validation panel judges it once the deck exists — so this play
 * sends the pair back and the preview files both under Commander.
 *
 * The format is picked here rather than read from a deck, which is the new-deck arm's whole
 * difference: change the select and the commander question changes with it, on the same step.
 */
export const AmbiguousCommander: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste(
      "1 Tymna the Weaver\n1 Thrasios, Triton Hero\n1 Kenrith, the Returned King\n1 Sol Ring",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    await userEvent.type(await canvas.findByLabelText("Name"), "Partners");
    await userEvent.selectOptions(canvas.getByLabelText("Format"), "commander");

    const tymna = await canvas.findByRole("button", { name: /Tymna the Weaver/ });
    await userEvent.click(tymna);
    await userEvent.click(canvas.getByRole("button", { name: /Thrasios, Triton Hero/ }));

    await waitFor(async () => {
      await expect(tymna).toHaveAttribute("aria-pressed", "true");
    });
    // The escape hatch stops being the answer the moment a card is picked.
    await expect(canvas.getByRole("button", { name: "No commander" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

/**
 * Into a deck that already exists, where the reader gets the one choice the gallery's entry
 * point does not have: add to the list, or clear it first.
 *
 * **Replace names what it would clear before it clears it**, and it names the *variant* — an
 * import lands in one list and clears at most one, which is the reason `variant` is in the
 * deck-card grain at all.
 */
export const IntoExistingDeck: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring\n1 Rhystic Study");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));

    await expect(await canvas.findByLabelText(/^Merge/)).toBeChecked();
    await expect(
      canvas.getByLabelText(/^Replace — removes the \d+ cards in Live first/),
    ).toBeInTheDocument();
  },
};

/**
 * A write the database refuses, in its own words.
 *
 * The dialog stays open holding what was pasted — Back still has the list — so the retry is one
 * press rather than a retype. That is the same reason `CreateDeckDialog` outlives its refusal,
 * one dialog along.
 */
export const Refused: Story = {
  args: { deckId: 2 },
  parameters: { fake: { fault: "busy" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Import" }));

    await waitFor(async () => {
      await expect(await canvas.findByRole("status")).toHaveTextContent(
        "Could not import the list",
      );
    });
    await expect(args.onImported).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(await canvas.findByLabelText("Decklist")).toHaveValue("1 Sol Ring");
  },
};
