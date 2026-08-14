import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { ART_ASPECT, cardImageUrl, deckCoverUrl } from "@/lib/images";
import {
  ipc,
  ipcError,
  type DeckCard,
  type DeckFolder,
  type DeckPatch,
  type DeckRow,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { compareLabels } from "@/lib/options";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { FOCUS, FOCUS_INSET } from "./cardControl";
import { useDeck } from "./useDeck";
import { useDeckFolders } from "./useDeckFolders";
import { pickerFormats, useFormatSpecs } from "./useFormatSpecs";

/** A field's label: 11px and dim, the direction's caption size, used for every one here. */
const CAPTION = "block text-[0.6875rem] text-dim";

/** A text field, the shape `CreateDeckDialog` set for this app's inputs. */
const FIELD = cn(
  "w-full rounded-md border border-border bg-bg px-2.5 text-sm text-text",
  "focus:border-accent focus:outline-none",
);

/** How deep a folder path is walked before the walk is called a cycle. */
const MAX_FOLDER_DEPTH = 32;

/**
 * What the file picker will offer, and it is **the backend's decoder list written out**.
 *
 * `src-tauri/Cargo.toml` builds the `image` crate with exactly five formats — `png`, `jpeg`,
 * `gif`, `bmp`, `webp` — chosen as "the five a person actually has on disk". A filter wider
 * than that would let a reader pick a TIFF the re-encode then refuses, which is a refusal the
 * picker could have prevented; a filter narrower would hide files that work. `jpg` and `jpeg`
 * are one decoder and two extensions people really have.
 *
 * A list, not a scope: the dialog plugin has no path scope to grant (measured against the
 * generated ACL manifest — `dialog:allow-open` carries no `scope` and the plugin declares no
 * global scope schema), so *which files* may be offered is decided here and nowhere else.
 */
const COVER_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp"];

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
 * **There is no Save button and there is not meant to be one.** Every control here writes when
 * it is done with — a select on change, the switch on press, a text field on blur — which is
 * the same "the row *is* the draft" model the editor's own name field uses. The one consequence
 * worth stating out loud is at the other end: closing the dialog **commits** whatever is
 * half-typed in a text field rather than discarding it (see {@link useDeckField}), because in a
 * form where every other control has already written, a notes paragraph silently thrown away by
 * a click on the scrim would be the only destructive thing on the screen.
 *
 * **Two commands set a cover and they are not interchangeable.** `deckUpdate({ coverCardId })`
 * points the deck at a printing's art crop and puts `coverKind` back to `card_art`;
 * {@link ipc.deckSetCoverImage} hands the backend a path, which it re-encodes into the app's
 * own cover shape and marks `custom`. A deck usually carries both at once, so the grid and the
 * upload are two ways in rather than two modes.
 *
 * **Filing goes through {@link ipc.deckSetFolder} in both directions**, and that is the one
 * decision in this file that is load-bearing rather than tidy. `DeckPatch.folderId` writes
 * `coalesce(?n, folder_id)`, so a `null` there means *leave it alone* — a "move to the top
 * level" written as a patch is a control that reports success and does nothing. The command
 * takes `number | null` and means both, so using it for the whole select removes the trap
 * instead of stepping around it.
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
            <div className="flex flex-wrap gap-6">
              <div className="w-full space-y-3.5 sm:w-[22.5rem] sm:shrink-0">
                <CoverSection
                  deck={row}
                  cards={deck.cards}
                  pick={(cardId) => deck.update.mutate({ coverCardId: cardId })}
                  upload={setCoverImage.mutate}
                  uploading={setCoverImage.isPending}
                  id={id}
                />
              </div>

              <div className="min-w-0 flex-1 space-y-3.5">
                <Fields deck={row} specs={specs} update={deck.update.mutate} id={id} />

                <div className="space-y-2.5 border-t border-border pt-3.5">
                  <TheorySwitch
                    on={row.theoryEnabled}
                    onChange={(theoryEnabled) => deck.update.mutate({ theoryEnabled })}
                    id={id}
                  />
                  <FolderRow
                    deck={row}
                    folders={folders.folders}
                    unread={folders.query.isError ? ipcError(folders.query.error) : null}
                    loading={folders.query.isPending}
                    onMove={setFolder.mutate}
                    pending={setFolder.isPending}
                    id={id}
                  />
                </div>

                {bannerFailure !== null && (
                  <p role="alert" className="text-xs text-destructive">
                    Could not save that change — {bannerFailure}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * A text field that writes what it holds when the reader is finished with it.
 *
 * Three of them here, and all three need the same two things `DeckEditor`'s name field needed:
 *
 * * **a draft plus a ref.** Enter commits and then blurs, and the blur handler commits again —
 *   in the same tick, with the draft state still holding the closure's value, which is one edit
 *   written twice. The ref is cleared *where it is read*, so the second call has nothing to
 *   send.
 * * **a commit on the way out.** Every other control in this dialog has already written by the
 *   time the reader reaches for the scrim; a field that threw its paragraph away would be the
 *   one control that punishes closing. So closing commits too — through the same ref, so a
 *   field that was blurred normally writes once and not twice.
 *
 * ## "On the way out" is the *close*, not the unmount, and that is a decision
 *
 * It used to be the unmount, which was the same instant. It is not any more: the panel now
 * outlives the flag by the length of its fade, so an unmount commit would hold a paragraph the
 * reader typed for a fifth of a second after they asked for it to be put away — a **write
 * waiting on an animation**, which is a coupling with nothing to recommend it and one real
 * hazard behind it: whatever else takes the write connection in that window goes first, and a
 * dialog dismissed as part of leaving the deck entirely would be racing its own editor's
 * teardown. So the commit is driven by `useIsPresent`, which is false on the render that starts
 * the exit — the same instant `open` went false upstairs.
 *
 * The unmount cleanup stays as a backstop and cannot double-write: `commit` clears the ref
 * **where it reads it**, so the second caller has nothing to send. It is what covers the paths
 * that have no exit at all — the editor unmounting under the dialog, a story or a test
 * rendering the panel outside an `AnimatePresence` (where `useIsPresent` is `true` forever,
 * which is exactly the answer that leaves those callers on the old behaviour).
 *
 * `blankIsNoop` is the name's: the backend refuses a blank name in words, and a name is not
 * something a deck should be able to lose by tabbing through the field. A description or a set
 * of notes emptied on purpose *is* an edit, and `coalesce(?n, column)` writes an empty string
 * happily — what no patch can do is put the column back to NULL, which is a distinction nothing
 * on screen can see.
 */
function useDeckField(
  current: string,
  write: (value: string) => void,
  { blankIsNoop = false }: { blankIsNoop?: boolean } = {},
) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  const present = useIsPresent();

  const commit = useCallback(() => {
    const value = ref.current;
    ref.current = null;
    setDraft(null);
    if (value === null) return;
    const trimmed = value.trim();
    if (blankIsNoop && trimmed === "") return;
    if (trimmed === current) return;
    write(trimmed);
  }, [blankIsNoop, current, write]);

  // The latest-ref pattern, and it has to be one: the cleanup below runs with an empty
  // dependency list — it is an *unmount* commit, not a re-commit on every keystroke — so
  // without this it would call the very first render's `commit`, which closes over the empty
  // draft and would write nothing at all.
  const latest = useRef(commit);
  useEffect(() => {
    latest.current = commit;
  });
  // The close, and then the unmount behind it. Both go through `latest` and both are the same
  // idempotent call; see this hook's doc for why there are two.
  useEffect(() => {
    if (!present) latest.current();
  }, [present]);
  useEffect(() => () => latest.current(), []);

  return {
    value: draft ?? current,
    onChange: (value: string) => {
      ref.current = value;
      setDraft(value);
    },
    onBlur: commit,
  };
}

/** The picture, the choices, and the credit the choices' own frames cannot carry. */
function CoverSection({
  deck,
  cards,
  pick,
  upload,
  uploading,
  id,
}: {
  deck: DeckRow;
  cards: readonly DeckCard[];
  pick: (cardId: string) => void;
  upload: (sourcePath: string) => void;
  uploading: boolean;
  id: string;
}) {
  const choices = useMemo(() => coverChoices(cards), [cards]);

  return (
    <>
      <div>
        <p className={cn(CAPTION, "mb-1.5")}>Deck picture</p>
        <CoverPreview deck={deck} />
        {/* Scryfall's image policy, and the gallery tile's ruling verbatim: an `art` crop has
            no printed frame, so the illustrator is credited wherever one is shown — and a cover
            whose artist is unknown draws no line at all rather than the word "null". A custom
            cover is the reader's own picture and has no Scryfall artist to credit, which is why
            `coverArtist` is `null` for one while the frame quite properly draws it. */}
        {deck.coverArtist !== null && deck.coverKind === "card_art" && (
          <p className="mt-1.5 truncate text-[0.6875rem] text-dim" title={deck.coverArtist}>
            Art by {deck.coverArtist}
          </p>
        )}
      </div>

      <div>
        <p id={`${id}-choices`} className={cn(CAPTION, "mb-1.5")}>
          Pick art from cards in this deck
        </p>
        {choices.length === 0 ? (
          <p className="text-xs text-dim">
            Nothing to pick from yet — a card in the deck is a cover this deck can wear.
          </p>
        ) : (
          <ul
            aria-labelledby={`${id}-choices`}
            // Every printing in the deck rather than the first eight: a reader looking for one
            // particular card's art should not have to reorder the deck to reach it. Four
            // columns and a scroller, so the list cannot push the fields beside it off screen.
            className="grid max-h-52 grid-cols-4 gap-1.5 overflow-y-auto"
          >
            {choices.map((card) => (
              <li key={card.cardId}>
                <ChoiceTile
                  card={card}
                  current={deck.coverKind === "card_art" && deck.coverCardId === card.cardId}
                  onPick={() => pick(card.cardId)}
                />
              </li>
            ))}
          </ul>
        )}
        <Upload upload={upload} pending={uploading} />
      </div>
    </>
  );
}

/**
 * The cover as the gallery would draw it: the card's `art` crop, or the reader's own picture.
 *
 * {@link DeckRow.coverKind} is the one answer to which of the two is showing — a deck usually
 * carries both, because setting one leaves the other alone.
 */
function CoverPreview({ deck }: { deck: DeckRow }) {
  const custom = deck.coverKind === "custom";
  const url = custom
    ? deckCoverUrl(deck.id)
    : deck.coverCardId !== null && deck.coverArtist !== null
      ? cardImageUrl(deck.coverCardId, 0, "art")
      : null;
  const image = useImageRetry(url);

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src !== null ? (
        <CardImage
          // Decorative: the deck's name is a field on the other half of this dialog, and the
          // credit line underneath already says whose picture it is.
          alt=""
          src={image.src}
          // **A custom cover's URL never changes**, because it names the deck and not the
          // picture (`/cover/<deckId>`, served `no-store` for exactly this reason). So
          // `CardImage`'s own key cannot notice a new upload, and this one does: `updatedAt`
          // moves on every write to the deck, which includes the one that replaced the file.
          key={custom ? deck.updatedAt : undefined}
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      ) : (
        // Three different things, said as three: no cover chosen, art on the way back, art that
        // did not arrive. The fourth case hides inside the first — a card cover whose artist
        // this app does not know is not drawn at all, and an orphaned cover heals on the next
        // sync — which is why this says "No cover" rather than claiming a failure.
        <span aria-hidden="true" className="text-xs text-dim">
          {url === null ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * One printing offered as a cover.
 *
 * The `art` crop, at the shape a cover is: this is a picture of what pressing it would do, and
 * a 5:7 card face here would be a preview of a different picture.
 *
 * **A known gap against the art-credit rule, recorded here rather than quietly inherited.**
 * The rule is absolute — an `art` crop has no printed frame, so wherever one is shown the
 * illustrator must be credited — and it lives in **`src/CLAUDE.md`'s binding rules**, in full in
 * **`docs/reference/frontend-design.md`**, and on
 * {@link DeckRow.coverArtist}'s own doc, with the original statement in
 * `docs/superpowers/plans/2026-08-04-02-images-card-browsing.md`. These tiles do not credit
 * one. Nor do `CardStack` (the stacked card), `views/GridView` (the wall tile) or
 * `TheoryDiffDialog` (the diff row), which draw the same crop everywhere else in the editor;
 * this follows those three deliberately, because a picker that was stricter than the views it
 * picks *from* would be an inconsistency a reader could see, where this one is one only a
 * lawyer can. What holds it together is that each crop sits inside a control that **names the
 * card**, so the illustrator is one press away in the card pane, which does credit them.
 *
 * The way to close it for all four at once is a per-row `artist`, which `DeckCard` does not
 * carry; the alternative here alone is the `grid` variant, whose printed frame carries the
 * credit, at the cost of the cover-shaped tile. The **cover preview** above is strict either
 * way: an unknown artist is not drawn at all, which is `DeckRow.coverArtist`'s own ruling, and
 * `DecksPage`'s gallery tile makes the same refusal.
 */
function ChoiceTile({
  card,
  current,
  onPick,
}: {
  card: DeckCard;
  current: boolean;
  onPick: () => void;
}) {
  const image = useImageRetry(cardImageUrl(card.cardId, 0, "art"));

  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={current}
      // The name is the whole accessible name: the picture is `alt=""` because it is the very
      // thing being chosen and "Shivan Dragon" twice is not more information.
      aria-label={card.name}
      title={card.name}
      className={cn(
        "block w-full overflow-hidden rounded-md border bg-surface",
        "transition-colors duration-150 motion-reduce:transition-none",
        current ? "border-accent" : "border-border hover:border-accent",
        // The button *is* the tile and the tile clips its own corners, so an outline standing
        // off its edge is painted entirely in the clipped region and is never seen.
        FOCUS_INSET,
      )}
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src !== null && (
        <CardImage
          alt=""
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </button>
  );
}

/**
 * The reader's own picture, through the system file picker.
 *
 * **One press, one `open()`, and the path goes straight to the command that already existed.**
 * `deck_set_cover_image` takes a path the backend reads rather than bytes — that is its whole
 * contract — so the picker's answer is handed across unchanged. Nothing is read in the webview,
 * which is why this needs no filesystem permission of any kind: `dialog:allow-open` lets the
 * page *ask for a name*, and Rust is what opens the file.
 *
 * The disclosure this replaced asked the reader to type a path. It worked, and it was the wrong
 * affordance for a desktop app.
 */
function Upload({ upload, pending }: { upload: (sourcePath: string) => void; pending: boolean }) {
  /** The picker itself could not be opened — a different failure from a write the database
   *  refused, and it belongs beside the button rather than in the dialog's write banner. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const choose = async () => {
    setPickerFailure(null);
    setPicking(true);
    try {
      const chosen = await pickFile({
        multiple: false,
        directory: false,
        title: "Choose a deck picture",
        filters: [{ name: "Images", extensions: COVER_EXTENSIONS }],
      });
      // **A cancelled picker is not a failure.** `open` answers `null` when the reader closed
      // it without choosing, which is an ordinary way to use a file dialog — the most ordinary
      // one after changing your mind. Treating it as an error would put a red sentence under
      // the button every time somebody looked and decided not to.
      if (chosen !== null) upload(chosen);
    } catch (e) {
      setPickerFailure(ipcError(e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void choose()}
        // Disabled through both halves of the round trip — the picker being up and the
        // re-encode running — because both are states in which a second press does nothing
        // useful. The label does not change: an action keeps its name through the whole flow.
        disabled={picking || pending}
        className={cn(
          "mt-2 h-8 w-full rounded-md border border-dashed border-border text-xs text-dim",
          "transition-colors duration-150 hover:border-accent hover:text-accent",
          "disabled:opacity-50 disabled:hover:border-border disabled:hover:text-dim",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Upload an image…
      </button>
      <p className="mt-1 text-[0.6875rem] text-dim">
        Copied and re-encoded into the deck’s own picture, so moving or deleting the original
        afterwards changes nothing.
      </p>
      {pickerFailure !== null && (
        <p role="alert" className="mt-1 text-[0.6875rem] text-destructive">
          Could not open the file picker — {pickerFailure}
        </p>
      )}
    </>
  );
}

/** Name, format, description, notes — the four the deck carries as words. */
function Fields({
  deck,
  specs,
  update,
  id,
}: {
  deck: DeckRow;
  specs: ReturnType<typeof useFormatSpecs>["specs"];
  update: (patch: DeckPatch) => void;
  id: string;
}) {
  const writeName = useCallback((value: string) => update({ name: value }), [update]);
  const writeDescription = useCallback((value: string) => update({ description: value }), [update]);
  const writeNotes = useCallback((value: string) => update({ notes: value }), [update]);

  const name = useDeckField(deck.name, writeName, { blankIsNoop: true });
  const description = useDeckField(deck.description ?? "", writeDescription);
  const notes = useDeckField(deck.notes ?? "", writeNotes);

  /** The picker, plus the deck's own format when the seed no longer offers it — `DeckEditor`'s
   *  rule and `pickerFormats`' code, so the header select and this one cannot come to two
   *  answers about the same deck. Alphabetical, with the deck's own row folded in rather than
   *  pinned first. */
  const formats = useMemo(
    () => pickerFormats(specs, { key: deck.formatKey, name: deck.formatName ?? deck.formatKey }),
    [specs, deck.formatKey, deck.formatName],
  );

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-40 flex-1">
          <label htmlFor={`${id}-name`} className={cn(CAPTION, "mb-1.5")}>
            Name
          </label>
          <input
            id={`${id}-name`}
            value={name.value}
            onChange={(e) => name.onChange(e.target.value)}
            onBlur={name.onBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            // Geist and not the display face: a deck's name is *content*, and Cinzel is drawn
            // in caps — which in a field you type into means the letters never match the ones
            // being typed.
            className={cn(FIELD, "h-9")}
          />
        </div>
        <div className="w-44">
          <label htmlFor={`${id}-format`} className={cn(CAPTION, "mb-1.5")}>
            Format
          </label>
          <select
            id={`${id}-format`}
            value={deck.formatKey}
            onChange={(e) => update({ formatKey: e.target.value })}
            // The seeded table is read once per session and is normally in hand before this
            // opens; on the one launch where it is not, the select still has to say something,
            // and what it says is the format the deck already has.
            disabled={formats.length === 0}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
              "disabled:opacity-60",
              FOCUS,
            )}
          >
            {formats.length === 0 ? (
              <option value={deck.formatKey}>{deck.formatName ?? deck.formatKey}</option>
            ) : (
              formats.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.name}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor={`${id}-description`} className={cn(CAPTION, "mb-1.5")}>
          Description
        </label>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={description.value}
          onChange={(e) => description.onChange(e.target.value)}
          onBlur={description.onBlur}
          className={cn(FIELD, "resize-y py-2 leading-relaxed")}
        />
        {/* The two long fields are not the same field, and the gallery is where the difference
            shows. Said once, under the shorter of them. */}
        <p className="mt-1 text-[0.6875rem] text-dim">The one line the gallery tile shows.</p>
      </div>

      <div>
        <label htmlFor={`${id}-notes`} className={cn(CAPTION, "mb-1.5")}>
          Notes
        </label>
        <textarea
          id={`${id}-notes`}
          rows={6}
          value={notes.value}
          onChange={(e) => notes.onChange(e.target.value)}
          onBlur={notes.onBlur}
          className={cn(FIELD, "resize-y py-2 leading-relaxed")}
        />
      </div>
    </>
  );
}

/** The second list, and what turning it off does — which is less than a reader would fear. */
function TheorySwitch({
  on,
  onChange,
  id,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  id: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p id={`${id}-theory`} className="text-sm">
          Theory deck
        </p>
        <p className="mt-0.5 text-[0.6875rem] leading-snug text-dim">
          A second list you are building towards. Turning it on makes the deck you have the plan
          and starts the live list empty; turning it off hides the Theory/Live switch and the
          difference list and keeps every row.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        // Named by the heading beside it *and* by its own word, in that order: `aria-label`
        // would replace the visible "Enabled" with something that does not contain it, which
        // is the WCAG 2.5.3 failure a control labelled by its own text exists to avoid.
        aria-labelledby={`${id}-theory ${id}-theory-state`}
        onClick={() => onChange(!on)}
        className={cn(
          "h-8 shrink-0 rounded-md border px-2.5 text-xs",
          "transition-colors duration-150 motion-reduce:transition-none",
          on
            ? "border-accent text-accent"
            : "border-border text-dim hover:border-accent hover:text-accent",
          FOCUS,
        )}
      >
        <span id={`${id}-theory-state`}>{on ? "Enabled" : "Disabled"}</span>
      </button>
    </div>
  );
}

/** Where the deck is filed, and the one control that can also un-file it. */
function FolderRow({
  deck,
  folders,
  unread,
  loading,
  onMove,
  pending,
  id,
}: {
  deck: DeckRow;
  folders: readonly DeckFolder[];
  /** The folder list could not be read. The select is no use without it, so it says so. */
  unread: string | null;
  loading: boolean;
  onMove: (folderId: number | null) => void;
  pending: boolean;
  id: string;
}) {
  const paths = useMemo(() => folderPaths(folders), [folders]);
  const here = paths.find((f) => f.id === deck.folderId);

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={`${id}-folder`} className="block text-sm">
          Folder
        </label>
        <p className="mt-0.5 truncate text-[0.6875rem] text-dim">
          {unread !== null
            ? `Could not read the folders — ${unread}`
            : deck.folderId === null
              ? "Top level"
              : (here?.path ?? "In a folder this list does not carry")}
        </p>
      </div>
      <select
        id={`${id}-folder`}
        // `""` is the top level, and it is a real answer rather than a placeholder: filing a
        // deck back at the root is `deckSetFolder(id, null)` — the one thing `DeckPatch` cannot
        // express, because `coalesce(?n, folder_id)` reads a bound NULL as "leave it".
        value={deck.folderId === null ? "" : String(deck.folderId)}
        onChange={(e) => onMove(e.target.value === "" ? null : Number(e.target.value))}
        disabled={unread !== null || loading || pending}
        className={cn(
          "h-8 w-44 shrink-0 rounded-md border border-border bg-surface px-2 text-xs",
          "disabled:opacity-60",
          FOCUS,
        )}
      >
        {/* Pinned above the folders, and the one row here that is not a folder: the top level
            is where a deck goes when it is in none of them. Everything under it is
            `folderPaths`' alphabetical order, by the whole rendered path. */}
        <option value="">Top level</option>
        {paths.map((f) => (
          <option key={f.id} value={f.id}>
            {f.path}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Every printing in the deck, once each, commanders first.
 *
 * **Commanders first because a commander deck's cover is almost always its commander** — and
 * `categoryKind` is what answers that, not the category's name, which the reader may have
 * renamed to anything. `Array.prototype.sort` is stable, so everything else keeps the read's
 * own order: category `sortOrder`, then name.
 *
 * An orphan is left out. Its printing has left `cards`, so there is no art to fetch and no
 * artist to credit — and a cover pointing at one would be a cover the gallery declines to draw.
 */
export function coverChoices(cards: readonly DeckCard[]): DeckCard[] {
  const seen = new Set<string>();
  return [...cards]
    .sort((a, b) => rank(a) - rank(b))
    .filter((card) => {
      if (card.needsReview !== null || seen.has(card.cardId)) return false;
      seen.add(card.cardId);
      return true;
    });
}

const rank = (card: DeckCard): number => (card.categoryKind === "commander" ? 0 : 1);

/**
 * Every folder as the path a reader would say out loud — `Commander › Legends`.
 *
 * `deck_folders` is flat and the tree is the reader's to build, so a select that showed bare
 * names would list two "Legends" with nothing to tell them apart.
 *
 * The depth fence is not decoration. The backend refuses a move that would make a cycle, but a
 * read is a read: a walk with no fence is an infinite loop in exactly the case nobody can
 * reproduce.
 *
 * Alphabetically by the **rendered path**, through the app's one collator (`compareLabels`)
 * rather than a bare `localeCompare`. The bare call reads the host locale, which is the trap
 * `sorting.ts` names: the collation is part of what the app does, and a list that reorders
 * itself on a different machine is a list two readers cannot compare. It also brings the
 * numeric rule with it, so a reader's `Cube 2` sits above their `Cube 10`.
 */
export function folderPaths(folders: readonly DeckFolder[]): { id: number; path: string }[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: DeckFolder): string => {
    const parts: string[] = [];
    let at: DeckFolder | undefined = folder;
    for (let depth = 0; at !== undefined && depth < MAX_FOLDER_DEPTH; depth += 1) {
      parts.unshift(at.name);
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
    return parts.join(" › ");
  };
  return folders
    .map((f) => ({ id: f.id, path: pathOf(f) }))
    .sort((a, b) => compareLabels(a.path, b.path));
}
