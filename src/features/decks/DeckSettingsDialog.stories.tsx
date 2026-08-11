import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DeckSettingsDialog } from "./DeckSettingsDialog";

/**
 * Everything about a deck that is not the cards in it.
 *
 * **Two of this dialog's four backends are not in the fake yet, and the stories say so rather
 * than working around it.** `deck_get`, `deck_update` and `format_specs_list` are answered, so
 * the cover grid, the name, the format and the description are live here — picking art really
 * writes, and the credit line underneath the picture really changes. `deck_folder_list` and
 * `deck_set_folder` are not, so the Folder row draws its own read failure and disables the
 * move; `deck_set_cover_image` is not either. That is the honest picture of the surface today,
 * and the alternative — teaching the fake here — would mean this component's stories were the
 * one place the fake and the mirror disagreed.
 *
 * The **upload** is a third kind of gap and not the fake's to close: its picker is the
 * operating system's, so no browser can show it. See `PickerUnavailable`.
 *
 * The **notes** field and the **theory** switch are a subtler version of the same gap: the fake
 * accepts their patch and answers the row's DDL defaults, so both write and neither sticks.
 * Nothing below asserts that they do.
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
 * Deck 1, the Modern shell: a cover it can credit, sixty cards' worth of art to choose from,
 * and a folder row that says what it could not read.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByLabelText("Name")).toHaveValue("Modern Goodstuff");
    // Scryfall's image policy: an `art` crop has no printed frame, so the illustrator is
    // credited wherever one is shown.
    await expect(canvas.getByText(/^Art by /)).toBeInTheDocument();
    await expect(canvas.getByLabelText("Format")).toHaveValue("modern");
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
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
