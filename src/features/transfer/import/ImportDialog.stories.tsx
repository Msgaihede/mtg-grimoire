import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import type { DeckVariant } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { pickOption } from "@/test-dropdown";
import type { ImportDestination } from "./destination";
import { collectionDestination } from "./destinations/CollectionPreview";
import { deckDestination } from "./destinations/deckInto";
import { NewDeckPreview } from "./destinations/NewDeckPreview";
import { newDeckDestination } from "./destinations/newDeck";
import { wishlistDestination } from "./destinations/WishlistPreview";
import { REFERENCE_LIST } from "./fixtures";
import { ImportDialog } from "./ImportDialog";

/**
 * The dialog with the trigger both entry points give it.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 *
 * **Nothing about the deck's *contents* is stated here**, which is what `DeckEditor` does too:
 * the count a `replace` would clear is read by the preview off the same `deck_get`, so a story
 * cannot state a number the seeded data disagrees with — and the wrapper below stays memoised on
 * identity alone.
 *
 * **One destination either way**, which is what both entry points hand it: the editor builds the
 * deck that is open, the gallery the deck a list is about to become. A shell given one draws no
 * destination radios — a choice between one thing is not a choice. The deck arm's header line
 * comes from that destination; the gallery's is the host fallback below, because the deck it
 * describes does not exist yet.
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

  const destination = useMemo<ImportDestination>(() => {
    const landed = (id: number, added: number) => onImported(id, added);
    return deckId === null
      ? {
          ...newDeckDestination,
          Preview: (props) => (
            <NewDeckPreview {...props} onImported={(id, out) => landed(id, out.added)} />
          ),
        }
      : deckDestination({ deckId, variant, onImported: (id, out) => landed(id, out.added) });
  }, [deckId, variant, onImported]);

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
        subtitle="Paste a list or choose a file, and it becomes a deck of its own."
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
 * corpus is 52 printings; the real one is 116 k, where this list resolves to 117 cards across
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
    await pickOption(userEvent.setup(), "Format", "Commander");

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
 *
 * **And the sentence under the radios says where that cardboard then goes** (issue #336). A
 * `replace` on the live list releases the copies behind the rows it deletes into
 * `Recently removed`, exactly as **Clear live list…** does, so it makes the same promise in the
 * same words — the fourth site for a sentence `ClearDeck`, `ClearCategory` and
 * `CategoriesDialog` already share. It is drawn on the press rather than on the option: Merge
 * removes nothing, so the frame this story opens on carries no such line at all.
 */
export const IntoExistingDeck: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring\n1 Rhystic Study");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));

    await expect(await canvas.findByLabelText(/^Merge/)).toBeChecked();
    const replace = canvas.getByLabelText(/^Replace — removes the \d+ cards in Actual first/);
    await expect(replace).toBeInTheDocument();

    // Merge is the mode that clears nothing, so it promises nothing.
    await expect(canvas.queryByText(/Recently removed/)).toBeNull();
    await userEvent.click(replace);
    await expect(
      canvas.getByText("Any copies you own go back to Recently removed."),
    ).toBeInTheDocument();
  },
};

/**
 * An Archidekt export carrying labels — `^Keeper,#4aab08^` — and the picker that decides which
 * of them come across.
 *
 * **All ticked**, because a list that carries labels is a list somebody labelled on purpose: the
 * boxes are there for the one they have finished with, not as a decision to make before every
 * import.
 *
 * **Two rows, drawn two ways, and that is the whole story.** `Cut candidate` is one the fake's
 * database already has, so it reads *already yours* and its swatch is the colour the reader gave
 * it — the file's `#ff0000` is discarded, because `commit_import` finds that row and uses it as
 * it stands. `Keeper` is one this app has never heard of, so it reads *new tag* in the file's own
 * green, which is the colour the row will really be made with. That asymmetry is not cosmetic: a
 * tag is app-wide since schema v21, so recolouring one from a pasted decklist would recolour it
 * in every deck the reader owns.
 *
 * The count on each row is **copies**, like every other number on this step.
 */
export const WithArchidektTags: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste(
      "2x Sol Ring [Ramp] ^Keeper,#4aab08^\n" +
        "1x Rhystic Study [Draw] ^Keeper,#4aab08^\n" +
        "1x Lightning Bolt [Removal] ^Cut candidate,#ff0000^\n" +
        "1x Counterspell [Counters]",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));

    const keeper = await canvas.findByRole("checkbox", { name: "Keeper" });
    await expect(keeper).toBeChecked();
    await expect(canvas.getByRole("checkbox", { name: "Cut candidate" })).toBeChecked();
    // The label the reader already has says so, and the one they do not says the other thing.
    await expect(canvas.getByText("already yours")).toBeInTheDocument();
    await expect(canvas.getByText("new tag")).toBeInTheDocument();

    // Unticking is what the boxes are for, and the sentence above them counts what is left.
    await userEvent.click(keeper);
    await expect(keeper).not.toBeChecked();
    await expect(canvas.getByText(/1 of them will be brought across\./)).toBeInTheDocument();
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

/**
 * The collection and the wishlist each hand the shell exactly **one** destination — a plain
 * value rather than {@link deckDestination}'s builder, because neither closes over anything the
 * deck's does (an id, a variant it writes into). {@link Dialog}'s own `deckId`/`variant` args
 * belong to that builder alone, so these two stories carry their own trigger rather than reusing
 * it — the same shape `CollectionPage.tsx` and `WishlistPage.tsx` mount, minus the surrounding
 * page.
 *
 * **The trigger says "Open import", not "Import"** — unlike the real pages' own button, which
 * really is named `Import`. The preview step's own commit button carries that exact name
 * (`CommitBar`'s `label` prop), and this story's trigger stays mounted beside the open dialog
 * rather than being replaced by it, so the two would otherwise be indistinguishable by role and
 * name at once — a collision the real page never has to answer because nothing there queries the
 * trigger and the commit button by the same string.
 */
function SingleDestinationDialog({ destination }: { destination: ImportDestination }) {
  const [open, setOpen] = useState(true);
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
        Open import
      </button>
      <ImportDialog
        destinations={[destination]}
        open={open}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

/**
 * Into the reader's own collection — `CollectionPage`'s `Import` button, over
 * `collectionDestination`. **Two facts a text list cannot carry, asked before the reader
 * commits**: what condition and finish a line with neither becomes. `add`/`set`, never
 * `replace` — a collection is thousands of rows a 40-line paste must not be able to empty, so
 * the word the deck's own preview offers is not in this destination's vocabulary at all.
 */
export const IntoCollection: Story = {
  render: () => <SingleDestinationDialog destination={collectionDestination} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring\n2 Lightning Bolt");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));

    await expect(await canvas.findByText(/will be added to your collection/)).toBeInTheDocument();
    // The trigger's accessible name is supplied by `labelledBy`, not a wrapping `<label>` — see
    // `CollectionPreview.tsx`'s own comment — so it is found by role rather than `getByLabelText`.
    await expect(
      canvas.getByRole("button", { name: /Condition when the file doesn.t say/ }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: /Finish when the file doesn.t say/ }),
    ).toBeInTheDocument();
    // `add`/`set`, and `add` first — never `replace`, which belongs to the deck's own preview.
    await expect(canvas.getByLabelText(/^Add these copies/)).toBeChecked();
    await expect(canvas.queryByText(/^Replace/)).toBeNull();
    await expect(canvas.getByRole("button", { name: "Import" })).toBeEnabled();
  },
};

/**
 * Into the reader's own wishlist — `WishlistPage`'s `Import` button, over
 * `wishlistDestination`. **No condition question at all**: a wish is a card the reader does not
 * own yet, so recording a grade for cardboard nobody has is a question this destination has
 * never asked. The finish picker survives — "the shiny one" is an answer about taste, which a
 * wish can carry the same as a collection entry can.
 */
export const IntoWishlist: Story = {
  render: () => <SingleDestinationDialog destination={wishlistDestination} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring\n2 Lightning Bolt");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));

    await expect(await canvas.findByText(/will be added to your wishlist/)).toBeInTheDocument();
    // `labelledBy`, not a wrapping `<label>` — `WishlistPreview.tsx`'s own comment says why —
    // so the name is found by role rather than `getByLabelText`.
    await expect(
      canvas.getByRole("button", { name: /Finish when the file doesn.t say/ }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /Condition/ })).toBeNull();
    await expect(canvas.getByLabelText(/^Add these wishes/)).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Import" })).toBeEnabled();
  },
};
