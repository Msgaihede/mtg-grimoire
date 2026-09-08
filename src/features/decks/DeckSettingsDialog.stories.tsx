import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { openDropdown } from "@/test-dropdown";
import { DeckSettingsDialog } from "./DeckSettingsDialog";

/** How long a `waitFor` will wait for `Dialog`'s first frame — the shell's panel carries its
 *  `initial` on it, so nothing inside is visible yet. `Decks/Dialog shell` has the whole reason
 *  and why the number is seconds; each file keeps its own copy because CSF would index an
 *  exported one as a story. */
const FRAME_WAIT = 5_000;

/**
 * Everything about a deck that is not the cards in it.
 *
 * **The fields themselves are `DeckSettingsForm`'s**, which `CreateDeckDialog` draws too — see
 * `Decks/Settings form` for the questions on their own, with no deck behind them, and
 * `Decks/Cover picker` for the picture column. **The frame is `Dialog`'s**, shared with every
 * other modal the deck builder opens — see `Decks/Dialog shell` for the scrim, the trap, the
 * Escape rung and the ✕ with nothing inside them. What is storied *here* is the half that only
 * exists because the deck does: the read, the writes, and the states they leave the panel in.
 *
 * **Every backend on this screen is the fake's** — `deck_get`, `deck_update`,
 * `format_specs_list`, `deck_folder_list`, `deck_set_folder` and `search_cards` (the cover
 * picker's "Search every card" box) — so picking art really writes, the credit line underneath
 * the picture really changes, the Folder select really files the deck, and the notes field and
 * the theory switch really stick. `deck_set_cover_image` was on that list and is deleted with
 * the custom cover; **the one gap this screen had went with it**. That gap was the upload's file
 * picker: `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and outside the app
 * window there is nothing behind it, so the press could only ever end in a refusal line here.
 * Every control on this panel is drivable in the workbench now.
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
 * "Top level" is a real answer rather than a placeholder — the dropdown's `""` is
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
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
    await expect(canvas.getByRole("button", { name: "Folder" })).toHaveTextContent("Top level");
    // The caption beside the label, not the option inside the dropdown — both say the words, and
    // only one of them is the deck's own state.
    //
    // **`waitFor`, because this dialog is a `motion` surface**: its first painted frame carries
    // its `initial`, so `toBeVisible` is false for everything inside it until the next frame —
    // the rule `src/CLAUDE.md` states and the reason an assertion about content in a newly
    // opened overlay cannot be a bare `expect`. It passed as one for exactly as long as nothing
    // else was awaiting on the way in; the oracle-tag reads a deck now makes were enough to
    // move it a frame, and jest-dom prints the failing element with `maxDepth: 0`, so it
    // reported an empty `<p>` and looked for all the world like missing data. The dialog now
    // sits inside `Dialog`'s scrim as well, which is one more animated element again — so
    // the wait is given {@link FRAME_WAIT} rather than the default, for the reason that
    // constant records: under suite load a frame is not the only thing being waited on.
    const caption = within(canvas.getByText("Folder").closest("div") as HTMLElement);
    await waitFor(() => expect(caption.getByText("Top level")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
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
 * parents, and a dropdown that offered "Commander" twice would be a control the reader cannot
 * use.
 */
export const FilingTheDeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText("Name");
    // The caption, which is the deck's own state — the trigger carries the same words as an
    // option.
    const caption = within(canvas.getByText("Folder").closest("div") as HTMLElement);

    // Opened before asserting the row exists — the folder list is a query the deck's own read
    // does not wait on, so the panel can mount before it has arrived and `findByRole` is what
    // gives it room to.
    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await canvas.findByRole("option", { name: "Constructed › Commander" }));
    await waitFor(async () => {
      await expect(caption.getByText("Constructed › Commander")).toBeVisible();
    });

    await openDropdown(userEvent.setup(), "Folder");
    await userEvent.click(await canvas.findByRole("option", { name: "Top level" }));
    await waitFor(async () => {
      await expect(caption.getByText("Top level")).toBeVisible();
    });
  },
};

/**
 * The notebook and the deck's kind, both of which write and stick.
 *
 * `notes` is **not** `description` — a caption is what the gallery tile shows and this is the
 * long-form thing nothing else draws.
 *
 * And setting the kind to `Theory + Actual` **moves the live list into the plan**, in the same
 * write: the deck the reader built becomes the plan, the live list starts empty, and the copies
 * it was holding go back to every other deck. Only when the plan is empty, and only on the way
 * on — a plan somebody has already started is not something a re-press may pour the deck over.
 * Setting it back to `Regular` keeps every row: it hides a tab, it does not delete a list.
 *
 * **It was a `Theory deck` switch until issue #401 made the choice three-way.** What is on trial
 * is unchanged — that a press writes and the panel comes back saying so — and the control is a
 * `role="group"` of three `aria-pressed` buttons rather than a `switch`, because a deck is now a
 * regular deck, a deck with a plan, or one whose cardboard the reader does not own.
 */
export const NotesAndTheory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const notes = await canvas.findByLabelText("Notes");
    await userEvent.type(notes, "Swap the Bolts for Bowmasters when the sideboard arrives.");
    // Blur, which is what commits a text field here.
    await userEvent.click(canvas.getByLabelText("Name"));

    // Named by the heading a reader can see rather than by an `aria-label` repeating it, and
    // each button by its own visible word — the WCAG 2.5.3 rule a control labelled by its own
    // text exists to keep.
    const kind = canvas.getByRole("group", { name: "Deck kind" });
    await expect(within(kind).getByRole("button", { name: "Regular" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(kind).getByRole("button", { name: "Theory + Actual" }));

    await waitFor(async () => {
      await expect(within(kind).getByRole("button", { name: "Theory + Actual" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    // The caption is the answer to the press, so it changes with it — and it is the one place
    // the deck's cards being poured into the plan is said before it happens.
    await expect(canvas.getByText(/starts the actual list empty/)).toBeInTheDocument();
    await expect(notes).toHaveValue("Swap the Bolts for Bowmasters when the sideboard arrives.");
  },
};

/**
 * **Deck 5, the Arena Brawl ladder list — a Virtual deck**, which is the third kind and the one
 * this dialog answers with an *absence*.
 *
 * The reader tracks it without owning the cardboard, so there is nothing in their binder for it
 * to be short of: the whole `Fill this deck from your collection` block is gone — heading, small
 * print and the `Import missing cards from collection…` press alike — rather than drawn and
 * greyed. **Absent, not greyed** is this panel's own standing rule, the same one that keeps
 * `Clear theory list…` off a deck with no plan: a greyed control under a state the reader chose
 * reads as something broken rather than as something absent.
 *
 * **`Empty a list` survives, and its wording is the thing to look at.** A deck the reader owns
 * none of still has a hundred cards in it and can still be emptied — but it keeps *one* list and
 * never meets the word `Actual`, which is half of a pair that only exists where there is a plan.
 * So the button's noun comes from `listName` rather than from a literal, and there is exactly one
 * of them.
 *
 * The seed is the fake's `virtualDeck`, whose deck has **no collection group at all** — which is
 * where the isolation actually comes from rather than from a branch at each reader.
 */
export const VirtualDeck: Story = {
  args: { deckId: 5 },
  parameters: { fake: { seed: "virtualDeck" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText("Name")).toHaveValue("Arena Brawl Ladder");

    const kind = canvas.getByRole("group", { name: "Deck kind" });
    await expect(within(kind).getByRole("button", { name: "Virtual" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await expect(canvas.queryByText("Fill this deck from your collection")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: /Import missing cards from collection/ }),
    ).toBeNull();

    // And the section that stays: one press, and no `Clear theory list…` beside it — a virtual
    // deck's `theoryEnabled` is `false` by construction, so that arm's existing gate is the whole
    // of what keeps it away.
    await expect(canvas.getByText("Empty a list")).toBeInTheDocument();
    const clears = canvas.getAllByRole("button", { name: /^Clear / });
    await expect(clears).toHaveLength(1);
  },
};

/**
 * Picking a card's art is `deckUpdate({ coverCardId })`, and since 2026-08-31 there is no second
 * command it could have been: `deckSetCoverImage` took a file on disk and set
 * `coverKind: "custom"`, and it is deleted with the whole custom-cover feature.
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
 * **Filling the deck from the binder** — the third entrance to `Pull from collection`, and the
 * only one that opens from the gallery rather than from inside the editor.
 *
 * The whole story is the entrance. What the pull panel *draws* — the rows, the source pickers
 * where a printing sits in two places, the shortfall arithmetic — is `Decks/Pull from collection`,
 * against hand-built rows; here the plan is the fake's own `deck_pull_plan` over deck 1, so what
 * is being shown is that pressing this button really opens that dialog over this one with the
 * deck-wide sentence under its heading.
 *
 * **And that one Escape closes one layer.** The pull is mounted *inside* the settings dialog, so
 * the two are peers on `useDismissOnEscape`'s capture stack with the pull on top: the first press
 * takes the pull and hands the caret back to the button that opened it, and the settings dialog is
 * still standing behind it. A ladder that collapsed would close both at once, or the wrong one —
 * which is a thing no rendering assertion can see.
 */
export const ImportFromCollection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText("Name");

    const trigger = await canvas.findByRole("button", {
      name: "Import missing cards from collection…",
    });
    await userEvent.click(trigger);

    const pull = await canvas.findByRole("dialog", { name: "Pull from collection" });
    // The dialog is a `motion` surface inside another one, so its first painted frame carries its
    // `initial` — see `Default` for the whole reason and why the wait is {@link FRAME_WAIT}.
    await waitFor(() => expect(pull).toBeVisible(), { timeout: FRAME_WAIT });
    // The deck-wide sentence, which is the whole of what passing no `cardName` buys: the per-card
    // entrance says "Copies of X you already own" instead.
    await expect(
      within(pull).getByText(/Cards this deck is short of that you already own/),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("dialog", { name: "Deck settings" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(canvas.queryByRole("dialog", { name: "Pull from collection" })).toBeNull(),
    );
    await expect(canvas.getByRole("dialog", { name: "Deck settings" })).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

/**
 * Deck 4, the testbed, which has nothing on the reader's desk that fits a hole in its live list.
 *
 * **An empty plan is the ordinary answer rather than a fault**, so the button greys and says why
 * in its own visible name — the rule the two Clear buttons under it already follow, and the reason
 * is that a greyed control whose name is the bare label reads to a screen reader, and to a test,
 * as a control that is *missing* rather than one with nothing to do.
 *
 * A pull moves only the exact printing **and finish** the list names and never a copy another deck
 * is already holding, which is why a deck can read missing and still have nothing to import.
 */
export const NothingToImport: Story = {
  args: { deckId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByLabelText("Name");

    await expect(
      await canvas.findByRole("button", {
        name: "Import missing cards from collection… (nothing to import)",
      }),
    ).toBeDisabled();
  },
};

/**
 * Closed is **nothing mounted**, not a hidden panel — so a dialog nobody opened asks the
 * backend for no deck, no folder tree and no format table either.
 *
 * That is `Dialog`'s guarantee rather than this file's, and it survives the extraction for a
 * structural reason: the body is handed to the shell as an *element*, and an element React never
 * puts in the tree is a component that never ran.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
