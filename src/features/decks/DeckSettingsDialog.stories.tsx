import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DeckSettingsDialog } from "./DeckSettingsDialog";

/**
 * Everything about a deck that is not the cards in it.
 *
 * **The fields themselves are `DeckSettingsForm`'s**, which `CreateDeckDialog` draws too — see
 * `Decks/Settings form` for the questions on their own, with no deck behind them, and
 * `Decks/Cover picker` for the picture column. **The frame is `DeckDialog`'s**, shared with every
 * other modal the deck builder opens — see `Decks/Dialog shell` for the scrim, the trap, the
 * Escape rung and the ✕ with nothing inside them. What is storied *here* is the half that only
 * exists because the deck does: the read, the writes, and the states they leave the panel in.
 *
 * **Every backend on this screen is the fake's now** — `deck_get`, `deck_update`,
 * `format_specs_list`, `deck_folder_list`, `deck_set_folder`, `deck_set_cover_image` and
 * `search_cards` (the cover picker's "Search every card" box) — so picking art really writes,
 * the credit line underneath the picture really changes, the Folder select really files the
 * deck, and the notes field and the theory switch really stick.
 *
 * **One gap is left, and it is not the fake's to close.** The upload's picker is the operating
 * system's: `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and outside the
 * app window there is nothing behind it. So the press ends in a refusal line, which is exactly
 * what the component does when a picker cannot be opened — see {@link PickerUnavailable}. The two
 * answers a *working* picker gives, a chosen path and a cancel, are unit-tested instead, because
 * only the OS can produce either.
 */
const meta = {
  title: "Decks/Settings dialog",
  component: DeckSettingsDialog,
  tags: ["autodocs"],
  args: {
    deckId: 1,
    open: true,
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    // **Its own frame per docs story, for a reason no other story file here has.** The scrim is
    // `fixed inset-0`: rendered inline, every story on the docs page would cover the whole page
    // rather than its own block, and the last one mounted would be the only one anybody could
    // read. `inline: false` gives each story an iframe, which is the viewport the fixed
    // positioning is then relative to. (`AppShell` and three others carry the same parameter
    // for the unrelated `useAppStore` reason — one parameter, two problems.)
    docs: { story: { inline: false, height: "600px" } },
  },
} satisfies Meta<typeof DeckSettingsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Deck 1, the Modern shell: a cover it can credit, sixty cards' worth of art to choose from, and
 * a deck filed nowhere.
 *
 * "Top level" is a real answer rather than a placeholder — the select's `""` is
 * `deckSetFolder(id, null)`, the one thing a `DeckPatch` cannot express, because
 * `coalesce(?n, folder_id)` reads a bound NULL as "leave it".
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByLabelText("Name")).toHaveValue("Modern Goodstuff");
    // Scryfall's image policy: an `art` crop has no printed frame, so the illustrator is
    // credited wherever one is shown.
    await expect(canvas.getByText(/^Art by /)).toBeInTheDocument();
    await expect(canvas.getByLabelText("Format")).toHaveValue("modern");
    await expect(canvas.getByLabelText("Folder")).toHaveValue("");
    // The caption beside the label, not the option inside the select — both say the words, and
    // only one of them is the deck's own state.
    const caption = within(canvas.getByText("Folder").closest("div") as HTMLElement);
    await expect(caption.getByText("Top level")).toBeVisible();
  },
};

/**
 * Filing the deck, and then un-filing it.
 *
 * The round trip is the claim: the caption under the label is `deck.folderId` resolved against
 * the folder list, so a path that appears there is a write that landed. The second half is the
 * one a patch could not do — **`""` means the root**, and reaching it is why `deck_set_folder`
 * exists as a command rather than as a `DeckPatch` field.
 *
 * The options are **paths**, not names: two folders may be called the same thing in different
 * parents, and a select that offered "Commander" twice would be a control the reader cannot use.
 */
export const FilingTheDeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByLabelText("Folder");
    // The caption, which is the deck's own state — the select carries the same words as options.
    const caption = within(canvas.getByText("Folder").closest("div") as HTMLElement);

    await userEvent.selectOptions(select, "Constructed › Commander");
    await waitFor(async () => {
      await expect(caption.getByText("Constructed › Commander")).toBeVisible();
    });

    await userEvent.selectOptions(select, "");
    await waitFor(async () => {
      await expect(caption.getByText("Top level")).toBeVisible();
    });
  },
};

/**
 * The notebook and the plan switch, both of which write and stick.
 *
 * `notes` is **not** `description` — a caption is what the gallery tile shows and this is the
 * long-form thing nothing else draws.
 *
 * And switching the theory list on **moves the live list into it**, in the same write: the deck
 * the reader built becomes the plan, the live list starts empty, and the copies it was holding
 * go back to every other deck. Only when the plan is empty, and only on the way on — a plan
 * somebody has already started is not something a re-press may pour the deck over. Switching it
 * off keeps every row: it hides a switch, it does not delete a list.
 */
export const NotesAndTheory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const notes = await canvas.findByLabelText("Notes");
    await userEvent.type(notes, "Swap the Bolts for Bowmasters when the sideboard arrives.");
    // Blur, which is what commits a text field here.
    await userEvent.click(canvas.getByLabelText("Name"));

    // A `switch`, named by the heading beside it *and* by its own visible word — `aria-label`
    // would replace "Disabled" with something that does not contain it, which is the WCAG 2.5.3
    // failure a control labelled by its own text exists to avoid.
    const theory = canvas.getByRole("switch", { name: "Theory deck Disabled" });
    await userEvent.click(theory);

    await waitFor(async () => {
      await expect(canvas.getByRole("switch", { name: "Theory deck Enabled" })).toBeChecked();
    });
    await expect(notes).toHaveValue("Swap the Bolts for Bowmasters when the sideboard arrives.");
  },
};

/**
 * Picking a card's art is `deckUpdate({ coverCardId })` — the patch, never
 * `deckSetCoverImage`, which is for a file on disk and sets `coverKind: "custom"`.
 *
 * The proof that the right command went out is the **credit line**: `coverArtist` is a lookup
 * the backend does on the way out of the write, so a line that changes to the new card's
 * illustrator is a round trip that landed, not a control that looked like it did.
 */
export const PickingCoverArt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const choices = await canvas.findByRole("list", { name: "Pick art from cards in this deck" });
    const tiles = within(choices).getAllByRole("button");

    const before = canvas.getByText(/^Art by /).textContent;
    // The last tile rather than the first: the first is the deck's cover already, and a story
    // that pressed it would prove nothing about the write.
    await userEvent.click(tiles[tiles.length - 1]);

    await waitFor(async () => {
      await expect(canvas.getByText(/^Art by /).textContent).not.toBe(before);
    });
    await expect(tiles[tiles.length - 1]).toHaveAttribute("aria-pressed", "true");
  },
};

/**
 * Deck 2, a Commander deck: the commander's art is offered first.
 *
 * `categoryKind` is what decides that and not the category's name — a reader may rename any
 * category to anything, and the rules read the kind.
 */
export const CommanderDeck: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const choices = await canvas.findByRole("list", { name: "Pick art from cards in this deck" });

    const first = within(choices).getAllByRole("button")[0];
    await expect(first).toHaveAccessibleName(/Kenrith/);
  },
};

/**
 * The upload, pressed.
 *
 * **The picker is the operating system's, so it is the one control on this screen that cannot
 * work in a browser.** `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and
 * outside the app window there is nothing behind it — so the press ends in the refusal line
 * beside the button rather than in a file dialog. That is the honest state to story: what a
 * reader sees here is exactly what the component does when the picker cannot be opened, which
 * is a path the unit tests also cover with a rejection.
 *
 * The two answers a *working* picker gives are unit-tested rather than storied, for the same
 * reason: a chosen path and a cancel are both things only the OS can produce.
 */
export const PickerUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Upload an image…" }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /Could not open the file picker/,
    );
    // The button comes back: a picker that would not open is not a control that is now spent.
    await expect(canvas.getByRole("button", { name: "Upload an image…" })).toBeEnabled();
  },
};

/**
 * A write the database refuses.
 *
 * The `busy` fault is set on the **world**, not on one call, so this is what the dialog does
 * with a refusal rather than what one mocked answer looks like. The newest write owns the line:
 * a refused rename must not leave its sentence up while the reader goes on to do something
 * else successfully.
 */
export const WriteRefused: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const name = await canvas.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Modern Goodstuff II{Enter}");

    await expect(await canvas.findByRole("alert")).toHaveTextContent(/Could not save that change/);
  },
};

/**
 * A deck another view deleted while the dialog was open: the read succeeded and answered
 * nothing, which is a different thing from a read that failed.
 */
export const DeckIsGone: Story = {
  parameters: { fake: { fault: "gone" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/This deck is gone/)).toBeInTheDocument();
  },
};

/**
 * Closed is **nothing mounted**, not a hidden panel — so a dialog nobody opened asks the
 * backend for no deck, no folder tree and no format table either.
 *
 * That is `DeckDialog`'s guarantee rather than this file's, and it survives the extraction for a
 * structural reason: the body is handed to the shell as an *element*, and an element React never
 * puts in the tree is a component that never ran.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
