import { useCallback, useId, useMemo, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";
import { Dialog } from "@/components/Dialog";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { useDeck } from "./useDeck";
import { useDeckField } from "./useDeckField";
import { useDeckFolders } from "./useDeckFolders";
import { ANY_GAME, pickerFormats, useFormatSpecs } from "./useFormatSpecs";

export interface DeckSettingsDialogProps {
  deckId: number;
  open: boolean;
  /**
   * Escape, and the close control: hand focus back to whatever opened the dialog, then close.
   *
   * Stable, please — {@link Dialog} passes it to `useDismissOnEscape`, which takes it as a
   * dependency, so a function rebuilt on every render of the opener re-registers the window
   * listener just as often.
   */
  onDismiss: () => void;
  /** A click on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
}

/**
 * Everything about a deck that is not the cards in it: what it is called, what it is for, what
 * it looks like in the gallery, whether it keeps a plan, and where it is filed.
 *
 * **Three files, and the split is by what each one knows.** {@link DeckSettingsForm} asks the
 * questions and is presentational — it mounts no query and no mutation, because
 * `CreateDeckDialog` asks the same ones about a deck that does not exist yet. {@link Dialog}
 * is the chrome: the scrim, the panel, the trap, the Escape rung, the header and the ✕, shared
 * with every other modal the deck builder opens. What is left here is {@link Settings}, and it
 * is everything that is about *this deck existing*: reading it, the two commands that write
 * it, the banner when one is refused, and the loading, read-failure and deck-is-gone states.
 *
 * **There is no Save button and there is not meant to be one.** Every control writes when it is
 * done with — a select on change, the switch on press, a text field on blur, which is the form's
 * `onChange`/`onCommit` split seen from this side. It is the same "the row *is* the draft" model
 * the editor's own name field uses. The one consequence worth stating out loud is at the other
 * end: closing the dialog **commits** whatever is half-typed in a text field rather than
 * discarding it (see {@link useDeckField}), because in a form where every other control has
 * already written, a notes paragraph silently thrown away by a click on the scrim would be the
 * only destructive thing on the screen. That commit rides `useIsPresent()` inside `Settings`,
 * which works because the shell renders `children` inside its own presence subtree — the one
 * thing about this arrangement that a careless edit could break without anything going red.
 *
 * **One command sets a cover, and this file used to be where the choice between two was made.**
 * A cover is `deckUpdate({ coverCardId })` — a printing's art crop, named by a card id — and
 * that is the whole of it. `DeckCoverPicker` still knows nothing about the command: it answers
 * {@link DeckCoverPickerProps.onPickCard}, and *when* to write is this host's business, which is
 * exactly what lets `CreateDeckDialog` render the same picker against a deck that does not exist
 * and fold the id into a `deck_create` instead.
 *
 * **What the second command was, and why its absence is the feature.** `deck_set_cover_image`
 * took a **path** the backend re-encoded beside the database, marked `cover_kind` as `custom`
 * and served at `/cover/<deckId>`; a deck carried both covers at once, so this file chose
 * between two writes and the picker drew two controls. It is deleted, along with the route, the
 * encoder and the directory, because the picture **never survived a sync** — the path was stored
 * absolute, so a second device was handed a `D:\…` that resolved to nothing and drew the card
 * art. Every device but the one that uploaded already showed what this build now shows
 * everywhere. Three things went with it here: the `setCoverImage` mutation, its place in
 * {@link writeFailure}'s list, and the `customCoverUrl`/`customCoverKey` pair — the second of
 * which existed only because that route named the *deck* rather than the picture, so nothing
 * keyed on the URL could notice a replaced file and `updatedAt` had to stand in for one.
 *
 * **Filing goes through {@link ipc.deckSetFolder} in both directions**, and that is the one
 * decision in this file that is load-bearing rather than tidy. `DeckPatch.folderId` writes
 * `coalesce(?n, folder_id)`, so a `null` there means *leave it alone* — a "move to the top
 * level" written as a patch is a control that reports success and does nothing. The command
 * takes `number | null` and means both, so using it for the whole select removes the trap
 * instead of stepping around it. (`deck_create`'s INSERT has no such trap and does take `None`
 * as the top level, which is the create host's business and not this one's.)
 */
export function DeckSettingsDialog({
  deckId,
  open,
  onDismiss,
  onClose,
}: DeckSettingsDialogProps): JSX.Element {
  // `<Settings/>` here is an *element*, not a call: React renders it only where the shell puts
  // it in the tree, which is inside the `open &&`. So a closed dialog costs no `deck_get`, no
  // folder read and no format read — the property that makes the editor's unconditional mount
  // of its dialogs free, and the one `DeckSettingsDialog.test.tsx`'s first case pins.
  return (
    <Dialog
      open={open}
      title="Deck settings"
      closeLabel="Close deck settings"
      width="w-[55rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Settings deckId={deckId} />
    </Dialog>
  );
}

/** The deck half — the queries, the writes and the body's own scroller. Mounted only while the
 *  dialog is open, which is what makes its drafts a session. */
function Settings({ deckId }: { deckId: number }) {
  const deck = useDeck(deckId);
  const { specs } = useFormatSpecs();
  const folders = useDeckFolders();
  const queryClient = useQueryClient();
  const id = useId();

  /** `useDeck`'s rule, on the two writes that have no hook: the whole `["decks"]` root, on
   *  success **and** on refusal — a refused write here is a busy database or a deck another
   *  view has deleted, and the second must not leave this dialog editing a deck that is gone. */
  const invalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ["decks"] }),
    [queryClient],
  );

  /**
   * Filing, in both directions, through the one command that can express both.
   *
   * Not `deckUpdate({ folderId })` even for the *filing* half, though that would work: two
   * commands for one control is two places for the top-level case to be got wrong later.
   */
  const setFolder = useMutation({
    mutationFn: (folderId: number | null) => ipc.deckSetFolder(deckId, folderId),
    onSuccess: invalidate,
    onError: invalidate,
  });

  const row = deck.deck;
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view has deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /** The most recently *started* of the writes this dialog speaks for — the one whose refusal
   *  is still news. `lib/writes.ts`, the one definition of that rule: a refused move must not
   *  leave its sentence up while the reader goes on to rename the deck successfully. Two
   *  entries and not three: the cover is a field of `deck.update` now, not a command of its
   *  own. */
  const bannerFailure = writeFailure([deck.update, setFolder]);

  // `mutate` rather than the mutation object, which is what the memos below can depend on:
  // `useMutation` answers a fresh object every render and a stable `mutate`.
  const update = deck.update.mutate;
  const writeName = useCallback((value: string) => update({ name: value }), [update]);
  const writeDescription = useCallback((value: string) => update({ description: value }), [update]);
  const writeNotes = useCallback((value: string) => update({ notes: value }), [update]);

  /**
   * The three drafts, and they are the whole of what this host adds to the form's `value`.
   *
   * **Held out here rather than inside the `row &&` branch below**, because a hook cannot be
   * conditional and because a draft that unmounted when the deck's read blinked would be a
   * paragraph lost to a refetch. `current` is the row's field, or `""` until it arrives — a
   * blank `current` with no draft over it is what the empty panel would have shown anyway, and
   * `commit` writes nothing at all while `ref.current` is null.
   *
   * Each of them holds its own `useIsPresent()`, which is the shell's presence rather than this
   * component's: `Settings` is rendered as `Dialog`'s `children`, inside the same
   * `AnimatePresence` child as the panel, so "the dialog is closing" reaches these three hooks
   * and the half-typed paragraph is written on the *close* rather than on the unmount a fifth of
   * a second later.
   */
  const name = useDeckField(row?.name ?? "", writeName, { blankIsNoop: true });
  const description = useDeckField(row?.description ?? "", writeDescription);
  const notes = useDeckField(row?.notes ?? "", writeNotes);

  const formatKey = row?.formatKey ?? null;
  const formatName = row?.formatName ?? null;
  const gameKey = row?.gameKey ?? ANY_GAME;
  /** The picker narrowed to the deck's game, plus the deck's own format when that narrowing —
   *  or a seed that no longer carries it — would leave it out. `DeckEditor`'s rule and
   *  `pickerFormats`' code, so the header select and this one cannot come to two answers about
   *  the same deck. Alphabetical, with the deck's own row folded in rather than pinned first.
   *  Computed **here** and not in the form, which mounts no `useFormatSpecs`.
   *
   *  **`keep` is what makes the game a filter rather than an edit**: a Modern deck switched to
   *  Arena still shows Modern, so nothing about setting a game can re-format a deck. This host
   *  needs no draft-repair effect for it, unlike the create dialog — the value is the row's,
   *  and the row only changes when a write does. */
  const formats = useMemo(
    () =>
      formatKey === null
        ? []
        : pickerFormats(specs, { key: formatKey, name: formatName ?? formatKey }, gameKey),
    [specs, formatKey, formatName, gameKey],
  );

  /** Same division of labour: the rows are this host's query, the paths are what the select
   *  draws, and {@link folderPaths} is exported from the form so both hosts spell them once. */
  const paths = useMemo(() => folderPaths(folders.folders), [folders.folders]);

  /**
   * Every change, live — and **which control it came from decides whether it writes now**.
   *
   * A select, a switch and a folder move each settle in one act, so each writes here; the three
   * text fields feed their draft instead and write on {@link commit}. That split is the whole of
   * the difference between this host and the create dialog, which merges every patch into a
   * draft and writes nothing until Create.
   */
  const change = (patch: Partial<DeckSettingsValue>) => {
    if (patch.name !== undefined) name.onChange(patch.name);
    if (patch.description !== undefined) description.onChange(patch.description);
    if (patch.notes !== undefined) notes.onChange(patch.notes);
    if (patch.formatKey !== undefined) update({ formatKey: patch.formatKey });
    // One write and one field: the game narrows the format list on the next render and touches
    // `format_key` neither here nor in Rust.
    if (patch.gameKey !== undefined) update({ gameKey: patch.gameKey });
    if (patch.theoryEnabled !== undefined) update({ theoryEnabled: patch.theoryEnabled });
    // A select, so it settles in one act and writes here. **`0` is a value and not an absence**,
    // which is why this needs no `deckSetFolder`-shaped escape below it: `AUTO_CATEGORY` is a
    // number the patch can carry, so "back to filing by what the card does" is an ordinary
    // write. See `DeckPatch.defaultCategoryId`.
    if (patch.defaultCategoryId !== undefined) update({ defaultCategoryId: patch.defaultCategoryId });
    // `undefined` is "not in this patch" and `null` is the top level, which is why the guard is
    // `!== undefined` rather than a truthiness test — see this file's doc for what `null` costs
    // when it is sent as a patch instead.
    if (patch.folderId !== undefined) setFolder.mutate(patch.folderId);
  };

  /**
   * A text field the reader is finished with.
   *
   * The patch carries that field's current text, and this ignores it: the draft it would write
   * is already in the hook, and `useDeckField.onBlur` is the one definition of "commit it". It
   * fires on **every** blur, which is safe for the same reason `onBlur={name.onBlur}` was safe
   * before — the hook is a no-op when nothing was typed, because `commit` clears its ref where
   * it reads it.
   */
  const commit = (patch: Partial<DeckSettingsValue>) => {
    if (patch.name !== undefined) name.onBlur();
    if (patch.description !== undefined) description.onBlur();
    if (patch.notes !== undefined) notes.onBlur();
  };

  return (
    // The body's own scroller: the shell owns the header and nothing under it, because the
    // deck-builder modals do not agree about what scrolls inside them.
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      {loading && <p className="text-sm text-dim">Reading the deck…</p>}
      {readFailure !== null && (
        <p role="alert" className="text-sm text-destructive">
          Could not read the deck — {readFailure}
        </p>
      )}
      {gone && (
        <p className="text-sm text-dim">
          This deck is gone — another view deleted it while these settings were open.
        </p>
      )}

      {row && (
        <>
          <DeckSettingsForm
            value={{
              name: name.value,
              formatKey: row.formatKey,
              gameKey: row.gameKey,
              description: description.value,
              notes: notes.value,
              theoryEnabled: row.theoryEnabled,
              folderId: row.folderId,
              defaultCategoryId: row.defaultCategoryId,
            }}
            onChange={change}
            onCommit={commit}
            formats={formats}
            // Every pile the deck has, in the deck's own order — `useDeck`'s own list, the same
            // one the editor's views and its Categories dialog are built from, so this select
            // cannot offer a pile the desk is not drawing or miss one it is. Passing it is what
            // draws the "Add cards to" row at all: the create dialog has no deck yet and passes
            // nothing.
            categories={deck.categories}
            folders={{
              paths,
              unread: folders.query.isError ? ipcError(folders.query.error) : null,
              loading: folders.query.isPending,
              pending: setFolder.isPending,
            }}
            cover={{
              coverCardId: row.coverCardId,
              coverArtist: row.coverArtist,
              // The cover printing's own URL, off the same `LEFT JOIN` `coverArtist` comes
              // from — the web build's only way to draw the preview, and ignored on desktop.
              // The gallery tile behind this dialog reads the very same field.
              coverImageUrl: row.imageUris?.art,
              deckCards: deck.cards,
              // The whole of what this host adds to the picker. `row.coverKind` is not passed
              // and the picker takes none: it is `card_art` on every deck, so a component
              // branching on it would be a branch with one live arm — see `DeckCoverKind`.
              onPickCard: (cardId) => update({ coverCardId: cardId }),
              idPrefix: id,
            }}
            idPrefix={id}
          />

          {/* Under both columns rather than beside the fields, which is where it used to
              sit: the form owns the two-column layout now, and a refused filing is as much
              this banner's business as a refused rename. */}
          {bannerFailure !== null && (
            <p role="alert" className="mt-3.5 text-xs text-destructive">
              Could not save that change — {bannerFailure}
            </p>
          )}
        </>
      )}
    </div>
  );
}
