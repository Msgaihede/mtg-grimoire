import { useCallback, useEffect, useId, useMemo, useState, type JSX } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { ipc, ipcError, type DeckInput, type DeckRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { DEFAULT_FORMAT } from "./FormatSelect";
import { useDeckFolders } from "./useDeckFolders";
import { pickerFormats, useFormatSpecs, type FormatOption } from "./useFormatSpecs";
import type { Decks } from "./useDecks";

/**
 * Every answer a deck is born with, before the reader has changed any of them — **except its
 * format**.
 *
 * `formatKey` is {@link DEFAULT_FORMAT} so the constant is honest read on its own: it is
 * `decks.format_key`'s own DDL default, and a deck that has been given no format really is
 * Casual. But it is the *fallback* rather than the answer — {@link Panel} always overwrites it
 * with the `defaultFormatKey` its host resolved, which is the format the reader last created a
 * deck in. Nothing in this file leaves the value as it is written here.
 */
const BLANK: DeckSettingsValue = {
  name: "",
  formatKey: DEFAULT_FORMAT,
  description: "",
  notes: "",
  theoryEnabled: false,
  folderId: null,
};

/**
 * What the format select offers on the one launch where `format_specs` has not answered yet.
 *
 * **`[]` is never passed down, and that is the point of this constant.**
 * {@link DeckSettingsValue} carries no display name for a format — only the key — so a form
 * handed an empty list can do nothing better than label the option with the key itself, and the
 * select would read `casual` rather than `Casual`. A host that knows better hands over a
 * one-row list instead, which is what both of them do: the settings dialog folds the deck's own
 * format in through `pickerFormats`' `keep`, and this one falls back to here.
 *
 * Casual because in that window it really is what this dialog would create. The value and the
 * one row it offers are kept in step by `newDeckFormat`'s last arm: with no specs in hand the
 * picker is empty, so the resolved `defaultFormatKey` falls all the way through to
 * {@link DEFAULT_FORMAT} — `decks.format_key`'s own DDL default — and the select's only option
 * is the value it is holding. Once the table has answered, both halves move together: the list
 * is the seed's and the value is the format the reader last built for.
 */
const CASUAL_ONLY: readonly FormatOption[] = [{ key: DEFAULT_FORMAT, name: "Casual" }];

/**
 * The last segment of a path the file picker answered with.
 *
 * Both separators, because the picker answers in the operating system's own spelling and this
 * app is built for Windows while its suites and its workbench run wherever they are run. `||`
 * rather than `??` so a path that somehow ends in a separator falls back to the whole string
 * instead of showing an empty frame.
 */
const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

/**
 * A text field the reader left empty is **absent**, never `""`.
 *
 * `deck_create` is an INSERT, so an absent field is the column's own default — NULL — while an
 * empty string is a description the deck really has and the gallery tile really draws, as a
 * blank line under the name. Trimmed for {@link DeckInput.name}'s reason: the deck should carry
 * what the reader can see they typed.
 */
const trimmedOrAbsent = (text: string): string | undefined => text.trim() || undefined;

export interface CreateDeckDialogProps {
  /**
   * `useDecks().create`, owned by the gallery and handed down.
   *
   * A prop rather than a hook of this component's own, and the reason is the refusal: the
   * gallery calls `create.reset()` on the way in, so a refusal from the last attempt is not
   * news about this one — and this dialog is **the only place a refused create can be read**,
   * because `writeFailure` covers the writes a *tile* makes and not this one. Two mutations
   * would be two answers, and the one on screen would be the one that never fired.
   */
  create: Decks["create"];
  /**
   * The format the draft starts on — the one the reader last created a deck in, else Commander.
   *
   * **Required, and resolved by the host rather than here.** The gallery is mounted long before
   * this dialog is opened, so its answer is a real value by the time {@link Panel} mounts and
   * can be read straight into the draft's initial state. A read of this component's own would
   * arrive a beat *after* the first paint, which means overwriting a select the reader may
   * already have used — and no `useEffect` can tell "the answer landed" from "the reader has
   * not touched it yet". Making it required is what keeps that guarantee: a host that has not
   * thought about the question cannot quietly get Casual.
   */
  defaultFormatKey: string;
  /**
   * The folder the draft starts in — `null` for the top level, which is where a deck made from
   * the gallery's own "New deck" has always started.
   *
   * **It exists because a folder row's menu offers "New deck here", and "here" has to be true.**
   * The draft used to seed `folderId: null` whatever opened it, so that row would have made the
   * deck at the top level and said otherwise. Seeded exactly as {@link defaultFormatKey} is, in
   * the same mount-only initializer and for the same reason: this is a *default*, not a
   * constraint, and the form's own Folder select is right there for a reader who changes their
   * mind.
   *
   * Optional, unlike the format, and the asymmetry is deliberate: the format is a question every
   * deck must answer and Casual is a wrong answer to have arrived at by accident, while the top
   * level is a real, ordinary answer and the only one a host with no folder in mind could give.
   */
  defaultFolderId?: number | null;
  /**
   * **A mount, not a class**, exactly as `TheoryDiffDialog`'s is: everything with state — the
   * half-typed name, the picked format, the chosen cover, the caret — lives one component down,
   * so closing unmounts all of it and reopening starts a genuinely new question rather than one
   * somebody has to remember to clear.
   */
  open: boolean;
  /** The deck the write answered with. The gallery opens it — nobody makes a deck in order to
   *  look at a tile of it. */
  onCreated: (deck: DeckRow) => void;
  /**
   * Escape, the header's ✕ and the trigger pressed again: close, and hand the caret back to
   * whatever opened this.
   *
   * **Stability is a courtesy here now, not a requirement.** This said "{@link
   * useDismissOnEscape} takes it as a dependency, so a function rebuilt on every render of the
   * opener re-registers the window listener just as often" — the hook latches it in a ref and
   * depends only on `enabled` and `layer`. It made that change for a correctness reason worth
   * knowing: once the hook kept a stack, a re-registration popped this layer's token and pushed a
   * new one **on top** of whatever had been opened over it, so the next Escape closed the wrong
   * window. An unstable one now costs a re-render and nothing else.
   */
  onDismiss: () => void;
  /**
   * A press on the scrim: close without moving focus.
   *
   * **Two callbacks, and it used to be one.** The single one handed the caret back on every way
   * out, which reads reasonable and is the opposite of the rule every other layer in this app
   * follows: Escape is the reader saying *put me back*, and a click outside is the reader
   * already being somewhere else. `TheoryDiffDialog` and `DeckSettingsDialog` are the precedent
   * and this now agrees with them.
   */
  onClose: () => void;
}

/**
 * The whole deck, described before it exists.
 *
 * **It used to ask two questions**, name and format, and everything else a deck carries —
 * description, notes, cover, folder, theory — was reachable only from `DeckSettingsDialog`. So
 * the app's one *creating* act produced a deck the reader then had to go and configure. It
 * hosts one {@link DeckSettingsForm} now, in the same 55rem two-column panel the settings
 * dialog draws, and one `deck_create` writes every answer at once.
 *
 * **A real modal, and it used to be an anchored popup.** The form was a 288px panel pinned to
 * the "New deck" button, dismissed by focus leaving it — which is the right shape for a
 * quick-add and the wrong one for the app's one creating act. Three things fall out of the
 * change and each was a defect in the old form: a modal is not dismissed by a blur, so a
 * refusal cannot be swallowed by the button disabling itself mid-write; the caret is trapped,
 * so Tab cannot walk out into a gallery the reader is not looking at; and the surface is
 * `fixed` rather than `absolute`, so it cannot hang off the right of the window.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects
 * a runtime `<style>`). A `fixed` element is positioned against the viewport *unless* an
 * ancestor carries a `transform`, `filter` or `contain`, any of which makes that ancestor the
 * containing block instead — the gallery's heading row carries none, which is what lets this
 * stay inside `NewDeck` beside the button it belongs to, at 55rem as it did at 24rem. The
 * `Import deck` dialog is mounted in the same row and is the standing proof.
 *
 * **The Escape rung is registered up here, on the flag.** With an exit animation the panel
 * outlives `open` by the length of its fade, so a rung that came up with the *element* would
 * still be consuming Escape while the next layer was opening — and two `"inner"` peers are not
 * ordered by that protocol at all. For the same reason `DecksPage`'s own rung excludes this
 * panel: one layer, one rung.
 */
export function CreateDeckDialog({
  create,
  defaultFormatKey,
  defaultFolderId = null,
  open,
  onCreated,
  onDismiss,
  onClose,
}: CreateDeckDialogProps): JSX.Element {
  // `useCallback`, because `onDismiss` is a dependency of the hook's effect and an unstable one
  // re-registers the window listener on every render of the gallery.
  const dismiss = useCallback(() => onDismiss(), [onDismiss]);
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  return (
    <AnimatePresence>
      {open && (
        <Panel
          key="create-deck"
          create={create}
          defaultFormatKey={defaultFormatKey}
          defaultFolderId={defaultFolderId}
          onCreated={onCreated}
          onDismiss={onDismiss}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
}

/**
 * The dialog itself, mounted only while it is open — see {@link CreateDeckDialog}.
 *
 * ## One draft, and nothing written until **Create deck**
 *
 * {@link DeckSettingsForm} takes both `onChange` (every keystroke and press) and `onCommit` (a
 * text field the reader is finished with) because its two hosts differ in exactly that: the
 * settings dialog writes as each control settles, and this one **ignores `onCommit`
 * entirely** — there is nothing to write to until the deck exists. Every change is merged into
 * one local {@link DeckSettingsValue} and sent as a single `deck_create`.
 *
 * ## The one non-obvious state: the deck was made and its picture was not
 *
 * `deck_set_cover_image` takes a **path and a deck id**, so a file the reader chose can only be
 * applied *after* the INSERT has answered — it is the one field of this form that cannot travel
 * in the create. That makes a two-step write out of a one-button act, and a two-step write has
 * a state in the middle:
 *
 * | What happened | What the reader sees |
 * | --- | --- |
 * | No file chosen | one `deck_create`, then the deck opens |
 * | File chosen, upload worked | the deck opens, showing the picture |
 * | File chosen, upload refused | **the deck exists** — it is held in `made`, the line says so, and the control becomes **Open deck** |
 *
 * The third row is the whole reason `made` is state rather than a local. **A deck that has been
 * created must be neither lost nor duplicated**: losing it would mean a refused *picture*
 * silently discarding a deck the database really has, and duplicating it is what a second press
 * of a button still saying "Create deck" would do. So the deck is held, the control is renamed
 * to what pressing it now does, and {@link Panel}'s submit opens it instead of writing again.
 * `made` is set **only** on the upload's refusal, which is what keeps the label honest while
 * the upload is still in flight.
 *
 * ## The cover's credit is fetched, because there is no `DeckRow` to carry it
 *
 * The preview draws a card's `art` crop only when the illustrator is known, because an `art`
 * crop has no printed frame and Scryfall's image policy says it must be credited wherever one
 * is shown — `DeckRow.coverArtist`'s own ruling, which the gallery tile makes too. That name is
 * a `LEFT JOIN cards` the backend does on the way out of a deck read, and there is no deck here
 * to read; `CardSummary` carries no `artist` either, and widening `search.rs` for a picker's
 * thumbnails is ruled out. So **this host asks for the card** — see {@link Panel}'s `artist`
 * query — because it is the surface that knows it has no row to read the name off.
 *
 * The refusal itself is not weakened anywhere. While the read is in flight the preview says
 * what it says for any cover it cannot credit, the tile's `aria-pressed` is the immediate
 * feedback, and a printing whose artist genuinely cannot be found is still drawn as nothing.
 * The credit arrives **with** the picture and never before it.
 */
function Panel({
  create,
  defaultFormatKey,
  defaultFolderId = null,
  onCreated,
  onDismiss,
  onClose,
}: Omit<CreateDeckDialogProps, "open">) {
  /**
   * The draft, seeded with the format the host resolved.
   *
   * **A lazy initializer, and mount-only by construction.** There is no effect anywhere here
   * that could land on top of a format the reader has already picked — the question is asked
   * once, when the panel mounts, and the answer is theirs from that moment. That is safe
   * *because* {@link CreateDeckDialog} renders this only while it is open: closing unmounts the
   * whole draft, so every reopen asks again and gets the freshly invalidated answer rather than
   * a value cached from the last deck the reader started and abandoned.
   */
  const [value, setValue] = useState<DeckSettingsValue>(() => ({
    ...BLANK,
    formatKey: defaultFormatKey,
    // The same mount-only seed, for a folder row's "New deck here" — see {@link
    // CreateDeckDialogProps.defaultFolderId}. `null` is the top level and is what every other
    // way into this dialog passes.
    folderId: defaultFolderId,
  }));
  /**
   * The printing whose art the new deck wears. Not part of {@link DeckSettingsValue} — that is
   * the shape both hosts share, and the settings dialog's cover is a write rather than a field.
   */
  const [coverCardId, setCoverCardId] = useState<string | null>(null);
  /** A path the file picker answered with, held until there is a deck id to upload it against. */
  const [file, setFile] = useState<string | null>(null);
  /** The deck, once it exists **and its picture did not save**. See {@link Panel}'s doc. */
  const [made, setMade] = useState<DeckRow | null>(null);

  const { specs } = useFormatSpecs();
  const folders = useDeckFolders();
  const queryClient = useQueryClient();
  const id = useId();
  /** False from the render that starts the fade out. */
  const present = useIsPresent();

  /**
   * The follow-up write, and the only one this component owns.
   *
   * `useDecks().create` is the gallery's and arrives as a prop; this one has no home there
   * because no tile ever makes it. Invalidating the whole `["decks"]` root on success **and**
   * on refusal is `useDeck`'s rule kept on the write rather than on a call site: the create
   * already invalidated once, before this ran, so without a second one the gallery would hold a
   * tile drawn without the picture that had just been put on it.
   */
  const setCover = useMutation({
    mutationFn: ({ deckId, sourcePath }: { deckId: number; sourcePath: string }) =>
      ipc.deckSetCoverImage(deckId, sourcePath),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["decks"] }),
    onError: () => void queryClient.invalidateQueries({ queryKey: ["decks"] }),
  });

  /**
   * Who illustrated the picked printing — the one card fact this dialog reads, and the reason
   * the preview can draw anything at all before the deck exists.
   *
   * **The preview refuses an uncredited `art` crop and that refusal stays exactly as strict.**
   * A crop has no printed frame, so Scryfall's image policy credits the illustrator wherever
   * one is shown; `DeckRow.coverArtist` is where every other surface gets the name, and this
   * one has no row. So it asks `card_detail`, whose `artist` is documented as *"required by
   * Scryfall's image policy wherever art is shown"* — the same fact from the same table, read
   * by the host that knows it is missing rather than bolted onto `CardSummary` for the grid.
   *
   * **Keyed on the card, gated on there being one.** `skipToken` rather than `enabled: false`,
   * because it says the true thing in the types as well as at runtime: with nothing picked
   * there is no id to ask about, so nothing is fetched and nothing is cached. A second pick is
   * a different key and fetches again, which is what stops the credit under the picture from
   * naming the printing before it.
   *
   * **No marketplace in the key, and that is not the price rule being bent.** `marketplace`
   * decides {@link CardDetail.finishPrices} and nothing else about the answer; this reads
   * `artist`, draws no money, and is deliberately **not** the card pane's key
   * (`["card", id, marketplace]`), so no priced surface can ever be served out of this entry
   * and there is nothing here for a switch to refetch. The argument is not optional, so it is
   * the app-wide default — which is also what the backend falls back to on its own.
   *
   * A refusal is left to say nothing, like an orphan: no artist is no picture, which is the
   * preview's existing sentence, and a red line about a *credit* over a deck that is otherwise
   * ready to be made would be the loudest thing on the panel for the least of its reasons.
   */
  const artist = useQuery({
    queryKey: ["cards", "artist", coverCardId],
    queryFn:
      coverCardId === null ? skipToken : () => ipc.cardDetail(coverCardId, DEFAULT_MARKETPLACE),
  });

  // The caret starts in the field the reader has to fill — the one difference from
  // `DeckSettingsDialog`, which focuses its panel because that is a form of settled values and
  // dropping the caret into the name would make the first keystroke a rename. Here the name is
  // the question.
  //
  // By id and not by ref: the field belongs to `DeckSettingsForm`, which is controlled and
  // exposes no ref for it — and the id it labels that input with is built from the prefix this
  // component hands it, so asking the document for it is asking for something this component
  // named. `getElementById` rather than a selector because `useId` spells its values with
  // characters a CSS id selector would have to escape.
  useEffect(() => {
    document.getElementById(`${id}-name`)?.focus({ preventScroll: true });
  }, [id]);

  /**
   * The formats to offer. **Never `[]`** — see {@link CASUAL_ONLY}.
   *
   * No `keep` row, unlike the settings dialog's: that one folds in a deck's own format in case
   * the seed no longer offers it, and there is no deck here whose format could have left.
   */
  const formats = useMemo(() => {
    const picker = pickerFormats(specs);
    return picker.length > 0 ? picker : CASUAL_ONLY;
  }, [specs]);

  const paths = useMemo(() => folderPaths(folders.folders), [folders.folders]);

  // Merged into the one draft. `onCommit` is not passed at all: a text field the reader has
  // finished with is news to a host that writes, and this one has nothing to write to yet.
  const onChange = useCallback(
    (patch: Partial<DeckSettingsValue>) => setValue((v) => ({ ...v, ...patch })),
    [],
  );

  const trimmed = value.name.trim();
  const createFailure = create.isError ? ipcError(create.error) : null;
  const coverFailure = setCover.isError ? ipcError(setCover.error) : null;
  const busy = create.isPending || setCover.isPending;

  /** The upload arm, which can only run once the INSERT has answered with an id. */
  const applyCover = (deck: DeckRow) => {
    if (file === null) {
      onCreated(deck);
      return;
    }
    setCover.mutate(
      { deckId: deck.id, sourcePath: file },
      {
        // The row the *upload* answered with, not the one the create did: it is the deck as the
        // gallery would now read it, `coverKind` already `custom`.
        onSuccess: (withCover) => onCreated(withCover),
        // Hold the deck. This is the state {@link Panel}'s doc is about, and setting `made`
        // here — on the refusal alone — is what keeps the control saying "Create deck" while
        // the upload is still running.
        onError: () => setMade(deck),
      },
    );
  };

  const submit = () => {
    // A write is in flight. The press is neither a second deck nor an early open.
    if (busy) return;
    // The deck exists and only its picture failed: this press opens it, and there is no path
    // from here to a second `deck_create`.
    if (made !== null) {
      onCreated(made);
      return;
    }
    // A name of nothing but spaces is not a name. The control is greyed on the same test, and
    // this is the half that actually refuses — an `aria-disabled` button still delivers its
    // press, which is the whole reason it is not the `disabled` attribute.
    if (!trimmed) return;

    create.mutate(
      {
        name: trimmed,
        formatKey: value.formatKey,
        description: trimmedOrAbsent(value.description),
        notes: trimmedOrAbsent(value.notes),
        coverCardId: coverCardId ?? undefined,
        // `number | null` in the draft, `number | undefined` on the wire. This is an INSERT, so
        // an absent folder genuinely means the top level and means it — `DeckPatch.folderId`'s
        // `coalesce` trap, which reads a bound NULL as "leave it", does not apply here.
        folderId: value.folderId ?? undefined,
        theoryEnabled: value.theoryEnabled,
        // Typed against the mirror at the one place the object is built: `src/lib/ipc.ts` is
        // hand-written and nothing checks it against the crate, so a field misspelled here
        // would otherwise travel as a silently ignored key.
      } satisfies DeckInput,
      { onSuccess: applyCover },
    );
  };

  return (
    // Scrim and panel in one presence: the ground darkens first and the panel scales up over
    // it, and the dialog is unmounted only once the later of the two tweens has finished.
    //
    // `LAYER.overlay` is the rung every full-window surface in this app shares. The number is
    // deliberately not written out here, in prose or anywhere else: Tailwind's scanner reads a
    // comment as eagerly as it reads code, so naming the class in a sentence emits a rule for
    // it — and `layers.test.ts`' sweep counts that as a second place the scale is written.
    <motion.div
      {...scrim}
      className={cn(
        "fixed inset-0 grid place-items-center bg-bg/75 p-4 sm:p-6",
        !present && "pointer-events-none",
        LAYER.overlay,
      )}
      // On the way out it is a picture: nothing to press, and nothing in the accessibility
      // tree. Focus left with the flag.
      aria-hidden={present ? undefined : true}
      // A press on the scrim and nowhere else. `onMouseDown` rather than `onClick`, because a
      // click fires on the nearest common ancestor of press and release — so a drag that starts
      // on the notes textarea and ends past the panel's edge is a "click" on the scrim, and the
      // dialog would vanish under a reader who was selecting the words they had just typed.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        {...dialogMotion}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        // Labelled **by the heading**, not by an `aria-label` beside it: the words are on
        // screen, so there is nothing for a second copy to drift from.
        aria-labelledby={`${id}-title`}
        // The caret stays inside, which is what makes the `aria-modal` above true rather than
        // merely claimed — see {@link trapTab}. Registered on the panel, which is where that
        // helper reads it from.
        onKeyDown={trapTab}
        className={cn(
          "flex max-h-full w-[55rem] max-w-full flex-col rounded-xl border border-border",
          "bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 font-heading text-xl leading-none">
            New deck
          </h2>
          <button
            type="button"
            // The ✕ is the reader saying "put me back", exactly as Escape is — so it hands the
            // caret over rather than dropping it where the dialog used to be.
            onClick={onDismiss}
            aria-label="Close"
            className={cn(
              "-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {/* Not a `<form>`, and that is a decision rather than an omission — but Enter still
            makes the deck. Implicit submission fires from *any* single-line input in a form,
            and this panel holds two of them: the name, where Enter means "that is the answer",
            and the cover picker's search box, where it means "I have finished typing a card
            name" and must never mean "make the deck". A form cannot tell those apart, so the
            key is decided per field instead: `DeckSettingsForm` calls `onSubmit` from the name
            and the picker prevents it in the search box. Enter or Space on the focused button
            reaches the same `submit`, which is where the blank-name refusal lives. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <DeckSettingsForm
            value={value}
            onChange={onChange}
            // Enter in the Name field, and the same function the button calls — so the three
            // guards below (a write in flight, a deck already made, a blank name) refuse a
            // keyboard press exactly as they refuse a pointer's.
            onSubmit={submit}
            formats={formats}
            folders={{
              paths,
              unread: folders.query.isError ? ipcError(folders.query.error) : null,
              loading: folders.query.isPending,
              // Nothing is filing anything: a deck that does not exist cannot be moved, so the
              // select is only ever waiting on the *read*.
              pending: false,
            }}
            cover={{
              coverCardId,
              // The DDL default, and not settable at create — a picked card *is* card art, and
              // a custom picture becomes `custom` through the upload below.
              coverKind: "card_art",
              // Fetched, because there is no `DeckRow` to read it off — see the `artist` query
              // above. `null` until it lands, and `null` if it cannot be found, which is the
              // preview's own ruling either way: an `art` crop this app cannot credit is not
              // drawn at all.
              coverArtist: artist.data?.artist ?? null,
              // No deck id, so no `/cover/<deckId>` route for a custom picture to be served at.
              customCoverUrl: null,
              // A deck being made has none. The picker's own empty state says exactly that, and
              // its search box is what does the work here.
              deckCards: [],
              onPickCard: setCoverCardId,
              onPickFile: setFile,
              pendingFileName: file === null ? null : basename(file),
              // The re-encode running — and one state more, which that button's own doc already
              // covers: "a second press does nothing useful". Once the deck exists this surface
              // is finished writing, so a file chosen now would never be applied by it.
              uploading: setCover.isPending || made !== null,
              idPrefix: id,
            }}
            idPrefix={id}
          />
        </div>

        <footer className="flex items-center gap-4 border-t border-border px-5 py-4">
          {/* One line, and at most one of the two can be true: a refused create leaves no deck
              to have failed to picture. It sits in a row that already has the button's height,
              so it grows nothing when it appears and needs no tween. */}
          {createFailure !== null && (
            <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
              Could not create the deck — {createFailure}
            </p>
          )}
          {coverFailure !== null && (
            <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
              The deck was made, but its picture could not be saved — {coverFailure}
            </p>
          )}

          <button
            type="button"
            // `aria-disabled`, never the attribute: a control that greys as the reader types
            // must stay in the tab order, and the caret it would have thrown away on the press
            // that started a write has to have somewhere to come back to. It also keeps the
            // trap's cycle the same length whatever the name field holds. The refusal itself is
            // `submit`'s, which is what makes the two halves one rule.
            aria-disabled={made === null && (!trimmed || busy) ? true : undefined}
            onClick={submit}
            className={cn(
              "ml-auto h-9 shrink-0 rounded-md border border-accent px-4 text-sm text-accent",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "hover:bg-accent hover:text-accent-foreground",
              "aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
              "aria-disabled:hover:text-accent",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            {/* The verb keeps its name through the flow, so the control that says "Create
                deck" is the one whose press opens the deck it created — except in the one state
                where the deck already exists, where saying "Create deck" would be an offer to
                make a second one. */}
            {made === null ? "Create deck" : "Open deck"}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
