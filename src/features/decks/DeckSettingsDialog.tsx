import { useCallback, useEffect, useId, useMemo, useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { deckCoverUrl } from "@/lib/images";
import { ipc, ipcError } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { FOCUS } from "./cardControl";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { useDeck } from "./useDeck";
import { useDeckField } from "./useDeckField";
import { useDeckFolders } from "./useDeckFolders";
import { pickerFormats, useFormatSpecs } from "./useFormatSpecs";

export interface DeckSettingsDialogProps {
  deckId: number;
  open: boolean;
  /**
   * Escape, and the close control: hand focus back to whatever opened the dialog, then close.
   *
   * Stable, please — {@link useDismissOnEscape} takes it as a dependency, so a function rebuilt
   * on every render of the opener re-registers the window listener just as often.
   */
  onDismiss: () => void;
  /** A click on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
}

/**
 * Everything about a deck that is not the cards in it: what it is called, what it is for, what
 * it looks like in the gallery, whether it keeps a plan, and where it is filed.
 *
 * **The questions are {@link DeckSettingsForm}'s and the answers are this file's.** The form is
 * presentational and mounts no query and no mutation, because `CreateDeckDialog` asks the same
 * questions about a deck that does not exist yet. What is left here is everything that is about
 * *this deck existing*: reading it, the three commands that write it, the banner when one is
 * refused, and the dialog chrome — the scrim, the trap, the Escape rung and the loading,
 * read-failure and deck-is-gone states.
 *
 * **There is no Save button and there is not meant to be one.** Every control writes when it is
 * done with — a select on change, the switch on press, a text field on blur, which is the form's
 * `onChange`/`onCommit` split seen from this side. It is the same "the row *is* the draft" model
 * the editor's own name field uses. The one consequence worth stating out loud is at the other
 * end: closing the dialog **commits** whatever is half-typed in a text field rather than
 * discarding it (see {@link useDeckField}), because in a form where every other control has
 * already written, a notes paragraph silently thrown away by a click on the scrim would be the
 * only destructive thing on the screen.
 *
 * **Two commands set a cover and they are not interchangeable.** `deckUpdate({ coverCardId })`
 * points the deck at a printing's art crop and puts `coverKind` back to `card_art`;
 * {@link ipc.deckSetCoverImage} hands the backend a path, which it re-encodes into the app's
 * own cover shape and marks `custom`. A deck usually carries both at once, so the grid and the
 * upload are two ways in rather than two modes. `DeckCoverPicker` knows neither command — it
 * answers `onPickCard` and `onPickFile`, and choosing between them is this host's job.
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
  // The `"inner"` rung, **registered out here on the flag** rather than one floor down on the
  // panel's mount. One press closes this and the card pane behind the view keeps its own — and
  // because an inner layer listens in the **capture** phase, it beats any handler a field
  // inside the dialog could register. That is why no text field here tries to make Escape mean
  // "revert what I typed": the press never reaches it, and a control that works only sometimes
  // is worse than one that never claimed to.
  //
  // Out here because the panel now outlives `open` by the length of its fade, and a rung that
  // came up with the *element* would still be consuming Escape while the next overlay opens —
  // two `"inner"` peers, which `useDismissOnEscape` explicitly does not order. `enabled: open`
  // kills it on the render that starts the exit.
  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  // Closed is *nothing mounted*, not a hidden panel: the body below reads the deck, the folder
  // tree and the format table, and a dialog nobody opened has no business asking for any of
  // them. It also means every draft, every disclosure and the caret's position start clean on
  // each open, which is what a settings dialog should do — so the state lives one floor down
  // rather than being reset by an effect up here.
  return (
    <AnimatePresence>
      {open && <Settings key="settings" deckId={deckId} onDismiss={onDismiss} onClose={onClose} />}
    </AnimatePresence>
  );
}

/** The dialog proper — mounted only while it is open, which is what makes its state a session. */
function Settings({
  deckId,
  onDismiss,
  onClose,
}: {
  deckId: number;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const deck = useDeck(deckId);
  const { specs } = useFormatSpecs();
  const folders = useDeckFolders();
  const queryClient = useQueryClient();
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the fade out — see {@link useDeckField}, which writes on
   *  it, and the panel below, which goes inert on it. */
  const present = useIsPresent();

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

  /** The reader's own picture. A **path the backend reads**, not bytes and not a `file://` URL. */
  const setCoverImage = useMutation({
    mutationFn: (sourcePath: string) => ipc.deckSetCoverImage(deckId, sourcePath),
    onSuccess: invalidate,
    onError: invalidate,
  });

  // The caret moves into the layer, as it does for every other one in the app: the dialog's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back. No
  // field is focused — this is a form of settled values, not a question, and dropping the caret
  // into the name would make the first keystroke a rename.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const row = deck.deck;
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view has deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /** The most recently *started* of the writes this dialog speaks for — the one whose refusal
   *  is still news. `lib/writes.ts`, the one definition of that rule: a refused move must not
   *  leave its sentence up while the reader goes on to rename the deck successfully. */
  const bannerFailure = writeFailure([deck.update, setFolder, setCoverImage]);

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
   */
  const name = useDeckField(row?.name ?? "", writeName, { blankIsNoop: true });
  const description = useDeckField(row?.description ?? "", writeDescription);
  const notes = useDeckField(row?.notes ?? "", writeNotes);

  const formatKey = row?.formatKey ?? null;
  const formatName = row?.formatName ?? null;
  /** The picker, plus the deck's own format when the seed no longer offers it — `DeckEditor`'s
   *  rule and `pickerFormats`' code, so the header select and this one cannot come to two
   *  answers about the same deck. Alphabetical, with the deck's own row folded in rather than
   *  pinned first. Computed **here** and not in the form, which mounts no `useFormatSpecs`. */
  const formats = useMemo(
    () =>
      formatKey === null
        ? []
        : pickerFormats(specs, { key: formatKey, name: formatName ?? formatKey }),
    [specs, formatKey, formatName],
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
    if (patch.theoryEnabled !== undefined) update({ theoryEnabled: patch.theoryEnabled });
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
    // Scrim and panel in one presence: the ground fades first and the panel scales up over it,
    // and the dialog is unmounted only once the later of the two tweens has finished.
    <motion.div
      {...scrim}
      // A **scrim**, and the app's first: every other layer here is anchored to its trigger and
      // leaves the view behind it live. This one covers the window, which is what the direction
      // asks for and what makes `aria-modal` below honest rather than a claim — see the panel.
      className={cn(
        "fixed inset-0 grid place-items-center bg-bg/75 p-4 sm:p-6",
        !present && "pointer-events-none",
        // Above every anchored popup and above the editor's drag tray: a settings dialog opened
        // over the editor must not be painted under a menu the reader left open behind it. Below
        // `gate`, which is `SyncProgress` taking the whole window.
        LAYER.overlay,
      )}
      // On the way out it is a picture: nothing to press, and nothing in the accessibility tree
      // — a second `role="dialog"` beside whichever overlay the reader opened next would be a
      // form they have already dismissed. Focus left with the flag.
      aria-hidden={present ? undefined : true}
      // `onMouseDown`, not `onClick`, and the target check is why: a drag that starts on a
      // textarea's resize handle and ends out here fires a `click` on this element — the two
      // targets' common ancestor — so a click handler would close the dialog on a gesture that
      // never left it. Where the press *lands* is unambiguous.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        {...dialogMotion}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        // **`aria-modal` here where `SyncProgress` refuses it, and the difference is the
        // scrim.** That component is a full-window takeover with nothing over the app behind
        // it: the ribbon and every view stay reachable by keyboard, so claiming modality there
        // would hide from assistive technology a screen anyone can still Tab into — its own
        // comment says exactly that, and it is right. This one paints a scrim a pointer cannot
        // cross, and `trapTab` below keeps the caret inside to match. The claim is true for
        // both input methods, which is the only condition under which it may be made — and if
        // either half is ever removed, this attribute goes with it.
        onKeyDown={trapTab}
        className={cn(
          "flex max-h-full w-[55rem] max-w-full flex-col rounded-xl border border-border",
          "bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          {/* Cinzel at 20px — the display face's own rule in this app: view titles and hero
              copy, never below 18px. */}
          <h2 id={`${id}-title`} className="font-heading text-xl leading-none">
            Deck settings
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close deck settings"
            className={cn(
              "ml-auto rounded-md p-1 text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

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
                  description: description.value,
                  notes: notes.value,
                  theoryEnabled: row.theoryEnabled,
                  folderId: row.folderId,
                }}
                onChange={change}
                onCommit={commit}
                formats={formats}
                folders={{
                  paths,
                  unread: folders.query.isError ? ipcError(folders.query.error) : null,
                  loading: folders.query.isPending,
                  pending: setFolder.isPending,
                }}
                cover={{
                  coverCardId: row.coverCardId,
                  coverKind: row.coverKind,
                  coverArtist: row.coverArtist,
                  customCoverUrl: deckCoverUrl(row.id),
                  // **A custom cover's URL never changes**, because it names the deck and not
                  // the picture (`/cover/<deckId>`, served `no-store` for exactly this reason),
                  // so nothing keyed on the URL can notice a new upload. `updatedAt` moves on
                  // every write to the deck, which includes the one that replaced the file.
                  customCoverKey: row.updatedAt,
                  deckCards: deck.cards,
                  onPickCard: (cardId) => update({ coverCardId: cardId }),
                  // This host has a deck id, so a chosen file is uploaded on the press and
                  // there is never a file waiting to be applied — that state is the create
                  // dialog's, which has no id to upload against.
                  onPickFile: setCoverImage.mutate,
                  pendingFileName: null,
                  uploading: setCoverImage.isPending,
                  idPrefix: id,
                }}
                idPrefix={id}
              />

              {/* Under both columns rather than beside the fields, which is where it used to
                  sit: the form owns the two-column layout now, and a refused cover upload is
                  as much this banner's business as a refused rename. */}
              {bannerFailure !== null && (
                <p role="alert" className="mt-3.5 text-xs text-destructive">
                  Could not save that change — {bannerFailure}
                </p>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
