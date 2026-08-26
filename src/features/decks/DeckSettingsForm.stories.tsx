import { useId, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { deckCoverUrl } from "@/lib/images";
import type { DeckCard, DeckCategory, DeckRow } from "@/lib/ipc";
import { openDropdown, pickOption } from "@/test-dropdown";
import { AUTO_CATEGORY } from "./autoCategory";
import type { DeckCoverPickerProps } from "./DeckCoverPicker";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { DEFAULT_FORMAT } from "./FormatSelect";
import { useDeck } from "./useDeck";
import { useDeckFolders } from "./useDeckFolders";
import { pickerFormats, useFormatSpecs } from "./useFormatSpecs";

/**
 * A host, which is the only way this form can be storied at all.
 *
 * `DeckSettingsForm` is **controlled and writes nothing** — it takes a value, hands every change
 * back and mounts no query. So a story has to supply what the two real hosts supply, and doing
 * that here is the point rather than the scaffolding: this is `DeckSettingsDialog`'s and
 * `CreateDeckDialog`'s shared half, written out once.
 *
 * `deckId: null` is the **create** shape — no deck, no cards to pick art from, an empty draft —
 * and a number is the **edit** shape. The two differ in nothing else, which is the claim the
 * whole task is about.
 */
function Form({
  deckId,
  foldersUnread,
  onChange,
  onCommit,
  onSubmit,
}: {
  /** The deck to open on, or `null` for a deck that does not exist yet. */
  deckId: number | null;
  /** Draw the folder select as a list that could not be read. Set here rather than through a
   *  fault because `busy` would take the deck read and the format table with it. */
  foldersUnread: string | null;
  onChange: (patch: Partial<DeckSettingsValue>) => void;
  onCommit: (patch: Partial<DeckSettingsValue>) => void;
  /**
   * Enter in the **Name** field, which only a create host takes.
   *
   * Supplied by one story rather than by the meta, because whether it is there is the whole of
   * what changes the key's meaning: absent, Enter blurs the name and the blur commits, which is
   * the settings dialog's behaviour and unchanged.
   */
  onSubmit?: () => void;
}) {
  const deck = useDeck(deckId);

  if (deckId !== null && deck.deck === null) return <p className="text-sm text-dim">Reading…</p>;

  // Keyed on the deck, so the draft below initialises from the row the read answered with
  // rather than from the `null` that was there while it was in flight.
  return (
    <Body
      key={deck.deck?.id ?? "new"}
      row={deck.deck}
      cards={deck.cards}
      // **`undefined` for the create shape**, which is what stops the "Add cards to" row being
      // drawn there at all: a deck that does not exist has no piles to offer. `useDeck(null)`
      // answers `[]`, and an empty *array* would draw the row over nothing but `Auto`.
      categories={deckId === null ? undefined : deck.categories}
      foldersUnread={foldersUnread}
      onChange={onChange}
      onCommit={onCommit}
      onSubmit={onSubmit}
    />
  );
}

/** The host proper: the draft, the two lists the form takes ready-made, and the cover props. */
function Body({
  row,
  cards,
  categories,
  foldersUnread,
  onChange,
  onCommit,
  onSubmit,
}: {
  row: DeckRow | null;
  cards: readonly DeckCard[];
  categories: readonly DeckCategory[] | undefined;
  foldersUnread: string | null;
  onChange: (patch: Partial<DeckSettingsValue>) => void;
  onCommit: (patch: Partial<DeckSettingsValue>) => void;
  onSubmit?: () => void;
}) {
  const id = useId();
  const { specs } = useFormatSpecs();
  const folders = useDeckFolders();

  const [value, setValue] = useState<DeckSettingsValue>(() => ({
    gameKey: row?.gameKey ?? "any",
    name: row?.name ?? "",
    formatKey: row?.formatKey ?? DEFAULT_FORMAT,
    description: row?.description ?? "",
    notes: row?.notes ?? "",
    theoryEnabled: row?.theoryEnabled ?? false,
    folderId: row?.folderId ?? null,
    // `AUTO_CATEGORY` for a deck that does not exist — the column's own `DEFAULT 0`, and the
    // only answer a deck with no categories could honestly give.
    defaultCategoryId: row?.defaultCategoryId ?? AUTO_CATEGORY,
  }));
  /**
   * The cover, and **the artist goes with the card rather than surviving it**.
   *
   * `DeckRow.coverArtist` is a lookup the backend does on the way out of a write, and this host
   * makes no writes — so once the reader picks a different printing there is nobody to ask. The
   * preview's own ruling then applies: a crop this app cannot credit is not drawn at all. That
   * is honest here and invisible in the app, where the pick is a `deckUpdate` and the answer
   * comes back with the new illustrator on it.
   */
  const [cover, setCover] = useState<{ cardId: string | null; artist: string | null }>(() => ({
    cardId: row?.coverCardId ?? null,
    artist: row?.coverArtist ?? null,
  }));
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);

  /** `pickerFormats` is the **host's** call, which is why the form takes a sorted list rather
   *  than sorting one: only a host knows whether the deck's own format has to be folded in —
   *  and, since the game select landed, which platform to narrow the list to. Narrowed against
   *  the **draft's** game rather than the row's, so changing the select in a story re-filters
   *  the one beside it exactly as it does in the app. */
  const formats = useMemo(() => {
    const picker = pickerFormats(
      specs,
      row ? { key: row.formatKey, name: row.formatName ?? row.formatKey } : null,
      value.gameKey,
    );
    // The create host's fallback, and the one launch that needs it: the seeded table has not
    // answered yet, and a select still has to say what it would make. Casual, which is
    // `decks.format_key`'s own DDL default.
    return picker.length === 0 ? [{ key: DEFAULT_FORMAT, name: "Casual" }] : picker;
  }, [specs, row, value.gameKey]);

  const paths = useMemo(() => folderPaths(folders.folders), [folders.folders]);

  const coverProps: DeckCoverPickerProps = {
    coverCardId: cover.cardId,
    coverKind: row?.coverKind ?? "card_art",
    coverArtist: cover.artist,
    customCoverUrl: row ? deckCoverUrl(row.id) : null,
    customCoverKey: row?.updatedAt,
    deckCards: cards,
    onPickCard: (cardId) => setCover({ cardId, artist: null }),
    onPickFile: setPendingFileName,
    pendingFileName,
    uploading: false,
    idPrefix: `${id}-cover`,
  };

  return (
    <div className="w-[55rem] max-w-full rounded-xl border border-border bg-bg p-5">
      <DeckSettingsForm
        value={value}
        onChange={(patch) => {
          onChange(patch);
          setValue((v) => ({ ...v, ...patch }));
        }}
        // The edit host writes here and the create host does not; this one only reports, so the
        // Actions panel shows the two callbacks side by side — which is the whole design.
        onCommit={onCommit}
        // Undefined in every story but **New deck**, which is the shape that takes it.
        onSubmit={onSubmit}
        formats={formats}
        folders={{
          paths,
          unread: foldersUnread ?? (folders.query.isError ? "Database is busy." : null),
          loading: folders.query.isPending,
          pending: false,
        }}
        categories={categories}
        cover={coverProps}
        idPrefix={id}
      />
    </div>
  );
}

/**
 * Every deck-level field, and no mutation.
 *
 * **The form imports no hook that reaches the backend** — not `useDeck`, not `useDeckFolders`,
 * not `useFormatSpecs`, and no mutation. Everything on this page comes through props, which is
 * what lets the create dialog render it before the deck exists. The host above is what mounts
 * the queries; the form is what draws the answers.
 *
 * **Two callbacks, and the split is the design.** `onChange` fires for every change including
 * each keystroke; `onCommit` fires only for the three text fields, and only when the reader is
 * finished with one. The settings dialog writes on `onChange` for the controls that settle in a
 * single act and on `onCommit` for the text; the create dialog merges every `onChange` into a
 * draft and ignores `onCommit` entirely. Watch the Actions panel — both are logged.
 *
 * **`Add cards to` is the newest question here and the one the two hosts do not both ask**
 * (2026-08-15). Where an add that names no pile lands was the deck builder's own state — a
 * `useState` in `DeckEditor` behind a select on the docked search panel — so a reader who pointed
 * it at their Sideboard lost the choice the moment they closed the deck, and the *other* surface
 * it governed, the toolbar's quick-add field, drew no control at all. It is
 * `decks.default_category_id` now. The row is drawn only where a `categories` prop arrives, which
 * is the edit shape: a deck being created has no piles yet, so **New deck** below asks nothing
 * about it and the column's `DEFAULT 0` — `Auto` — is what the new deck gets.
 *
 * **A third callback is about one key rather than one control.** `onSubmit` is Enter in the **Name**
 * field and nowhere else: the two textareas keep the newline they exist for and the cover
 * picker's search box refuses the key outright, because "I have finished typing a card name"
 * must never mean "make the deck". A host that passes nothing — the settings dialog — keeps
 * today's Enter, which blurs the field, and the blur is what writes. **New deck** below is the
 * one story that supplies it.
 */
const meta = {
  title: "Decks/Settings form",
  component: Form,
  tags: ["autodocs"],
  args: { deckId: 1, foldersUnread: null, onChange: fn(), onCommit: fn() },
} satisfies Meta<typeof Form>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Deck 1, the Modern shell — the **edit** shape, and what the settings dialog draws inside its
 * panel: a cover it can credit, the deck's own art to pick from, and a deck filed nowhere.
 *
 * "Top level" is a real answer rather than a placeholder: filing a deck back at the root is
 * `deckSetFolder(id, null)`, the one thing a `DeckPatch` cannot express.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByLabelText("Name")).toHaveValue("Modern Goodstuff");
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
    await expect(canvas.getByRole("button", { name: "Folder" })).toHaveTextContent("Top level");
    // The caption beside the label, not the option inside the dropdown — both say the words, and
    // only one of them is a statement about this deck.
    const caption = within(canvas.getByText("Folder").closest("div") as HTMLElement);
    await expect(caption.getByText("Top level")).toBeVisible();
  },
};

/**
 * The **create** shape: no deck, so no name, no notes and nothing to pick art from.
 *
 * This is the whole point of the component. Every field the settings dialog offers is here
 * before the deck exists, and the host holds a draft instead of writing — one `deck_create` at
 * the end rather than a create followed by a patch followed by a move.
 *
 * **The one story that supplies `onSubmit`**, because a create host is the only kind that has
 * something for Enter to mean. The press leaves the caret where it was: a refused create keeps
 * every answer on screen, and the field the reader would fix is the one they are already in.
 */
export const NewDeck: Story = {
  args: { deckId: null, onSubmit: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    const name = await canvas.findByLabelText("Name");
    await expect(name).toHaveValue("");

    await userEvent.type(name, "Sunday burn");

    await waitFor(async () => {
      await expect(name).toHaveValue("Sunday burn");
    });
    await expect(args.onChange).toHaveBeenLastCalledWith({ name: "Sunday burn" });

    // Enter, from the keyboard rather than into the field — `userEvent.type` focuses whatever
    // it is handed, so a press delivered that way could not say where the caret was.
    await userEvent.keyboard("{Enter}");

    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    // One press, one event: the field is not blurred, so nothing commits alongside it.
    await expect(args.onCommit).not.toHaveBeenCalled();
    await expect(name).toHaveFocus();
  },
};

/**
 * **The game narrows the format list, and the deck's own format survives the narrowing.**
 *
 * The fixture is a Modern deck. Setting the game to Arena drops every format Arena cannot play
 * — Modern among them — and Modern is still on the list, folded back in by `pickerFormats`'
 * `keep`. That is the whole of "setting a game never re-formats a deck", drawn: the trigger still
 * shows its own value, so the reader's next unrelated change writes the format they can see.
 *
 * Setting it back to Any restores the full list, which is what makes this a *filter* rather than
 * an edit — nothing was written to the deck but the one word.
 */
export const GameNarrowsTheFormats: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByLabelText("Name");
    const game = canvas.getByRole("button", { name: "Game" });
    await expect(game).toHaveTextContent("Any");

    await openDropdown(userEvent.setup(), "Format");
    // **Wait for the seeded table before measuring anything.** `format_specs` is a query, and
    // until it lands `pickerFormats` answers the deck's own format alone — `keep` folds it in
    // whether or not the specs arrived, so the panel is a one-row list that *looks* like a
    // narrowed one. A `wide` captured there is 1, and "fewer than 1" is unreachable. The panel
    // stays open and re-renders as the query resolves, so this waits rather than re-opening.
    await waitFor(async () => {
      await expect(canvas.getByRole("option", { name: "Commander" })).toBeInTheDocument();
    });
    const wide = canvas.getAllByRole("option").length;

    // Picking the game clicks its own trigger, which is an outside click for the Format panel
    // still open above it — the same thing any reader's next move would do, and it closes the
    // panel exactly as a click elsewhere in the app would.
    await pickOption(userEvent.setup(), "Game", "Arena");
    await expect(args.onChange).toHaveBeenLastCalledWith({ gameKey: "arena" });

    await openDropdown(userEvent.setup(), "Format");
    await expect(canvas.getAllByRole("option").length).toBeLessThan(wide);
    // The deck's own format, kept — and still what the trigger is showing.
    await expect(canvas.getByRole("option", { name: "Modern" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");

    await pickOption(userEvent.setup(), "Game", "Any");

    await openDropdown(userEvent.setup(), "Format");
    await expect(canvas.getAllByRole("option")).toHaveLength(wide);
  },
};

/**
 * The two callbacks, side by side.
 *
 * A text field says every keystroke through `onChange` and then says it is **finished** through
 * `onCommit`; a switch, a select and a tile settle in one act and say it once. That difference
 * is why the pair exists: the edit host writes a paragraph on the second event and a format on
 * the first, and the create host never needs the second at all.
 */
export const EveryChangeAndEveryCommit: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);

    // A switch settles in one press, so it never commits — it only changes. Pressed first, so
    // that "has not committed" is still a claim about the whole story rather than about a spy
    // somebody reset.
    await canvas.findByLabelText("Name");
    await userEvent.click(canvas.getByRole("switch", { name: /Theory deck/ }));

    await expect(args.onChange).toHaveBeenLastCalledWith({ theoryEnabled: true });
    await expect(args.onCommit).not.toHaveBeenCalled();

    // A text field does not settle in one act, which is the whole reason for the second
    // callback: every keystroke, and then the blur that says the reader is finished.
    await userEvent.type(canvas.getByLabelText("Notes"), " Cut Avacyn.");
    await expect(args.onCommit).not.toHaveBeenCalled();

    await userEvent.click(canvas.getByLabelText("Name"));
    await waitFor(async () => {
      await expect(args.onCommit).toHaveBeenCalledWith(
        expect.objectContaining({ notes: expect.stringContaining("Cut Avacyn.") }),
      );
    });
  },
};

/**
 * A folder list that could not be read.
 *
 * The dropdown is no use without it, so it says what happened and stops offering the move — a
 * control that offered folders it could not name would file the deck somewhere the reader did
 * not choose.
 */
export const FoldersUnread: Story = {
  args: { foldersUnread: "Database is busy." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByText("Could not read the folders — Database is busy."),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Folder" })).toBeDisabled();
  },
};
