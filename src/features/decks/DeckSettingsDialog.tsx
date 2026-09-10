import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type DeckVariant } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";
import { Dialog } from "@/components/Dialog";
import { ClearDeck } from "./ClearDeck";
import { deckKind, deckKindPatch, tracksCollection } from "./deckKind";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { listName } from "./listNames";
import { RowAction } from "./metaRows";
import { PullFromCollectionDialog } from "./PullFromCollectionDialog";
import { useDeck, usePullPlan } from "./useDeck";
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
 * is everything that is about *this deck existing*: reading it, the commands that write it, the
 * banner when one is refused, and the loading, read-failure and deck-is-gone states. **Emptying
 * a whole list is the one thing here that is not a setting**, and it is here for want of a
 * cheaper screen rather than because it belongs — the section's own comment argues that, and
 * argues why it could not follow the form into `CreateDeckDialog`.
 *
 * **There is no Save button and there is not meant to be one.** Every control writes when it is
 * done with — a select on change, the switch on press, a text field on blur, which is the form's
 * `onChange`/`onCommit` split seen from this side. It is the same "the row *is* the draft" model
 * the editor's own name field uses. The one consequence worth stating out loud is at the other
 * end: closing the dialog **commits** whatever is half-typed in a text field rather than
 * discarding it (see {@link useDeckField}), because in a form where every other control has
 * already written, a half-typed description thrown away by a click on the scrim would be the
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
      size="w-[55rem]"
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

  /**
   * Does this deck read the reader's collection at all — and therefore, does this screen draw
   * anything collection-shaped?
   *
   * **One boolean for three consequences**, because they are one fact rather than three: the
   * pull plan is not asked for, the `Fill this deck from your collection` section is not drawn,
   * and the dialog it opens is not mounted. Spelling `!row.virtualOnly` at each of the three
   * would be three places for a fourth kind that also owns nothing to be missed at.
   * {@link tracksCollection} is the app-wide predicate and this is one of ~ten callers; it takes
   * the flags rather than a kind, precisely so a site like this one asks *may I draw an owned
   * count* rather than *which of the three is it*.
   *
   * **`row !== null` is folded in on purpose and is not merely a null check.** It was the pull
   * plan's whole gate before this — `deck_pull_plan` refuses a deck that is not there rather
   * than answering `[]` — and a virtual deck is the same refusal one axis over: Rust refuses
   * `deck_pull_plan` for one **by name** (`deck::VIRTUAL_HOLDS_NOTHING`), so a query left
   * running would put a real error on screen under a section that has no business being there.
   * Two reasons not to ask, one gate.
   */
  const collects = row !== null && tracksCollection(row);

  /**
   * Which list a destructive question is up about, or `null` while the two buttons are drawn.
   *
   * **One piece of state rather than a flag each**, so "only one question at a time" is
   * structural rather than something two `useState`s have to be remembered to agree about —
   * `DeckEditor`'s `Layer` union, at the scale this section needs.
   */
  const [confirming, setConfirming] = useState<DeckVariant | null>(null);
  const liveTrigger = useRef<HTMLButtonElement>(null);
  const theoryTrigger = useRef<HTMLButtonElement>(null);

  /** Whether the pull is up, and the button it was opened from — which is where the caret goes
   *  back to, since {@link PullFromCollectionDialog} takes one close callback and leaves that
   *  half of the contract to whoever owns the trigger. */
  const [importing, setImporting] = useState(false);
  const importTrigger = useRef<HTMLButtonElement>(null);

  /**
   * What this deck is short of that the reader already owns — the read behind the import button
   * and behind the dialog it opens.
   *
   * **The gate is the mount, and then the deck.** `DeckEditor` gates the same hook on its `Layer`
   * being up because its editor is on screen for as long as the deck is open; `Settings` is passed
   * to {@link Dialog} as an *element* and is therefore in the tree only while the dialog is, which
   * is the same property this file already leans on for `deck_get`, the folder read and the format
   * read. A second gate on {@link importing} would be wrong rather than merely redundant: the
   * button's own **name** is a statement about the plan, so the plan has to have been asked for
   * before the press rather than because of it.
   *
   * **{@link collects} is the rest of it, and it is the section's own `{collects && …}` said one
   * render earlier.** It carries two refusals rather than one, and they are the same refusal.
   * `useDeck` answers `null` both while `deck_get` is in flight and when it came back empty, and
   * `deck_pull_plan` refuses a deck that is not there rather than answering `[]` — so without
   * this a dialog opened on a deck another view has deleted, or one whose read was refused,
   * spends the widest query on this screen on a question that can only be refused in turn. A
   * **virtual** deck is refused by name for the second reason, so the same gate keeps a real
   * error message off a screen that draws no section for it. What it costs is that the two reads
   * run in series rather than side by side, which is the right way round: this one is behind a
   * button the reader has to be *shown* first, and the section it is drawn in does not exist
   * until the same `row` arrives.
   *
   * The key is the deck's, under the `["decks"]` root, so this is the same cached answer the
   * editor's own entrance draws — two entrances to one dialog can never show two plans for one
   * deck, and the pull itself invalidates it.
   */
  const pullPlan = usePullPlan(deckId, collects);

  /**
   * **Nothing to import, as distinct from nothing known yet** — and the difference is what keeps
   * the button live over a plan that has not answered.
   *
   * `PullFromCollectionDialog` has four states and words all four: reading, refused, an empty
   * plan and rows to review. Greying this button on anything but the third would make two of
   * those unreachable — most sharply the refusal, whose whole job is to tell the reader in the
   * backend's own words why there is no list. So the button is greyed exactly when the read has
   * come back and come back empty; while it is in flight or has failed, the press opens the
   * dialog and the dialog says which.
   *
   * An empty plan is the ordinary answer rather than a fault, which is why it is worth saying in
   * the name: a pull moves only the exact printing **and finish** the list names and never a copy
   * another deck is already holding, so a deck reading *12 missing* can legitimately have nothing
   * on the reader's desk that fills a hole.
   */
  const nothingToPull = pullPlan.data !== undefined && pullPlan.data.length === 0;
  /** Which trigger is owed the caret back, set by a cancel and cleared by the effect below. */
  const owedFocus = useRef<DeckVariant | null>(null);

  /**
   * The caret's way back out of a question the reader declined.
   *
   * `CategoryRow`'s effect, and it has to be an effect for a sharper version of that row's
   * reason: there the trigger is merely **disabled** while the question is up, here it is not in
   * the tree at all — the question replaces it — so a `focus()` from the Cancel handler would be
   * a call on a ref that is still `null`. The render this runs after is the one that puts the
   * button back.
   *
   * **Only after a cancel.** A clear that went through leaves a different screen behind it: the
   * counts have moved, so the button the reader pressed is the one that has just greyed itself,
   * and handing the caret to a disabled control is the dead-caret failure `metaRows.tsx` names
   * rather than a courtesy.
   */
  useEffect(() => {
    if (confirming !== null || owedFocus.current === null) return;
    const owed = owedFocus.current;
    owedFocus.current = null;
    (owed === "theory" ? theoryTrigger : liveTrigger).current?.focus();
  }, [confirming]);

  /**
   * How many copies each list holds — **both answers off the read this dialog already makes**.
   *
   * `Settings` mounts `useDeck(deckId)`, which is the **live** list, and a {@link DeckCategory}
   * carries two counts rather than one: `cardCount` is the copies filed in that pile *in the
   * variant that was asked for* — so, here, live — and `cardCountAllVariants` is the copies
   * across both lists at once, the same answer whichever variant did the asking. The plan's
   * total is therefore a subtraction, and that is the whole reason there is no second query on
   * this screen: a later reader who "fixes" this by mounting `useDeck(deckId, "theory")` beside
   * it would be buying a second `deck_get` for a number already in hand.
   *
   * Read both fields' own docs in `src/lib/ipc.ts` before touching either. They are one word
   * apart, and a destructive control quoting the wrong one mis-states the press being confirmed
   * — which is the one direction a confirmation must never be wrong in.
   */
  const { liveCount, theoryCount } = useMemo(() => {
    let live = 0;
    let both = 0;
    for (const category of deck.categories) {
      live += category.cardCount;
      both += category.cardCountAllVariants;
    }
    return { liveCount: live, theoryCount: both - live };
  }, [deck.categories]);

  /** The most recently *started* of the writes this dialog speaks for — the one whose refusal
   *  is still news. `lib/writes.ts`, the one definition of that rule: a refused move must not
   *  leave its sentence up while the reader goes on to rename the deck successfully. The cover
   *  is not among them — it is a field of `deck.update` now, not a command of its own — and the
   *  clear is, so a refused clear draws the sentence this dialog already had rather than a
   *  second one of its own. Read the array; a count written out here is a number no build
   *  answers. */
  const bannerFailure = writeFailure([deck.update, setFolder, deck.clearDeck]);

  /**
   * The question actually on screen, which is not always the one that was opened.
   *
   * **The theory switch is a few rows up this same dialog**, so a reader can take the deck's
   * plan away with its own clear confirmation standing — and `Clear the theory list?` over a
   * deck that has just reported it keeps no plan is a question about a list nothing else on the
   * screen admits to. The trigger below is gated on `theoryEnabled` and the open question was
   * not, which is the two halves of one control disagreeing about whether the list is there.
   *
   * **Derived rather than reconciled in an effect.** It is a render-time consequence of two
   * pieces of state that are both already here, and a `setConfirming(null)` from an effect is
   * exactly the reflexive derived-state sync `no-setstate-in-an-effect` exists to refuse.
   *
   * **`confirming` is deliberately left alone**, so switching the plan back on puts the reader's
   * own unanswered question back rather than making them find the button again. The switch's own
   * copy promises that turning it off "keeps every row", so the cards this question is about are
   * still there — it is the *list* that has gone, not its contents.
   */
  const asking: DeckVariant | null =
    confirming === "theory" && row?.theoryEnabled !== true ? null : confirming;

  // `mutate` rather than the mutation object, which is what the memos below can depend on:
  // `useMutation` answers a fresh object every render and a stable `mutate`.
  const update = deck.update.mutate;
  const writeName = useCallback((value: string) => update({ name: value }), [update]);
  const writeDescription = useCallback((value: string) => update({ description: value }), [update]);

  /**
   * The two drafts, and they are the whole of what this host adds to the form's `value`.
   *
   * **Held out here rather than inside the `row &&` branch below**, because a hook cannot be
   * conditional and because a draft that unmounted when the deck's read blinked would be a
   * paragraph lost to a refetch. `current` is the row's field, or `""` until it arrives — a
   * blank `current` with no draft over it is what the empty panel would have shown anyway, and
   * `commit` writes nothing at all while `ref.current` is null.
   *
   * Each of them holds its own `useIsPresent()`, which is the shell's presence rather than this
   * component's: `Settings` is rendered as `Dialog`'s `children`, inside the same
   * `AnimatePresence` child as the panel, so "the dialog is closing" reaches both hooks
   * and the half-typed paragraph is written on the *close* rather than on the unmount a fifth of
   * a second later.
   */
  const name = useDeckField(row?.name ?? "", writeName, { blankIsNoop: true });
  const description = useDeckField(row?.description ?? "", writeDescription);

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
   * A select, a switch and a folder move each settle in one act, so each writes here; the two
   * text fields feed their draft instead and write on {@link commit}. That split is the whole of
   * the difference between this host and the create dialog, which merges every patch into a
   * draft and writes nothing until Create.
   */
  const change = (patch: Partial<DeckSettingsValue>) => {
    if (patch.name !== undefined) name.onChange(patch.name);
    if (patch.description !== undefined) description.onChange(patch.description);
    if (patch.formatKey !== undefined) update({ formatKey: patch.formatKey });
    // One write and one field: the game narrows the format list on the next render and touches
    // `format_key` neither here nor in Rust.
    if (patch.gameKey !== undefined) update({ gameKey: patch.gameKey });
    // **The deck's kind is one write carrying both columns, normalised on the way out.**
    // `DeckSettingsForm`'s three-way group hands back `deckKindPatch`'s pair, so both fields
    // arrive together and that is the ordinary path; the round trip through `deckKind` is what
    // makes it a *guarantee* rather than a convention — no combination of a half patch and the
    // row it is patching can leave the `theoryEnabled && virtualOnly` row `deckKind.ts` exists
    // to keep out of the database. **Two `update` calls were the other shape and are refused**:
    // that is two transactions, two history lines for one press, and one moment in between in
    // which the deck is neither kind — and switching *to* theory pours the live list into the
    // plan, so the moment in between is one a card write could land in.
    if (patch.theoryEnabled !== undefined || patch.virtualOnly !== undefined)
      update(
        deckKindPatch(
          deckKind({
            theoryEnabled: patch.theoryEnabled ?? row?.theoryEnabled ?? false,
            virtualOnly: patch.virtualOnly ?? row?.virtualOnly ?? false,
          }),
        ),
      );
    // The three marks, relayed one field at a time for the reason there are three of them: blue
    // without green is a real answer and so is red alone, so a write that carried the set would
    // make them a single ordered control the columns deliberately are not. Unlike the switch
    // above them none of the three moves a card — they are reading preferences,
    // `separateXGroup`'s kind of write.
    if (patch.theoryMarkExact !== undefined) update({ theoryMarkExact: patch.theoryMarkExact });
    if (patch.theoryMarkName !== undefined) update({ theoryMarkName: patch.theoryMarkName });
    if (patch.theoryMarkUnplanned !== undefined)
      update({ theoryMarkUnplanned: patch.theoryMarkUnplanned });
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
              theoryEnabled: row.theoryEnabled,
              // The other half of the kind. Passed even though this host reads it only through
              // {@link collects}: the value shape is the *form's*, one shape for both hosts,
              // and `deckKind(value)` — which is what the group draws itself from — needs the
              // pair rather than either column.
              virtualOnly: row.virtualOnly,
              theoryMarkExact: row.theoryMarkExact,
              theoryMarkName: row.theoryMarkName,
              theoryMarkUnplanned: row.theoryMarkUnplanned,
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
            // This host has a deck row and an ordinary `deck_update` for all three columns, so
            // the mark switches are answerable here — which the create dialog's are not. Drawn
            // only where the deck also keeps a plan; the form owns that second half.
            canSetTheoryMarks
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

          {/* **The other direction from `Empty a list`, and it sits above it because it is the
              constructive half.** A deck reads *N missing* and some of those copies are already
              on the reader's desk; this is the press that files them into the deck's folder
              without spending anything. It is the third entrance to
              {@link PullFromCollectionDialog} — the stats band's button and a deck card's
              `Collection ▸ Pull …` are the other two — and it earns its place here because the
              other two live in the **editor**, and this dialog opens from the gallery as well.

              **Mounted nested rather than handed up to `DeckEditor`'s `Layer` union**, which is
              forced rather than chosen: this file has three hosts and two of them have no editor
              and no layer to hand it to. `useDismissOnEscape`'s capture stack is innermost-last
              by mount order and was built for a layer opened over an open dialog, so one Escape
              closes the pull and the next closes this. `Dialog` is `fixed inset-0` and
              unportalled, and the nested one is a *descendant* of this one's scrim, so it paints
              above with no z-index of its own — this needs no `layer="stacked"`, which is for two
              dialogs that are siblings.

              **No `cardName`**, which is the whole of what makes this the deck-wide press: the
              per-card entrance narrows the rows it hands over and passes a name so the subtitle
              says so, and this one hands over the plan entire.

              **A Virtual deck draws none of this, and *absent* is the whole of the rule** (issue
              #401). Not a greyed button, not a sentence saying the deck owns nothing: a greyed
              control under a state the reader chose reads as something broken rather than as
              something absent, which is the argument the `Clear theory list…` arm below has
              made since it shipped, met here for a second reason. The deck has no
              `collection_folders` group at all, so there is nothing this press could move and no
              shortfall for it to be measured against — and Rust refuses `deck_pull_plan` and
              `deck_pull` for one by name, so a drawn-but-dead section would be the one place on
              this screen a reader could produce a real error message on purpose. The way to get
              the section back is the kind control a few rows up, which is where the fact lives.
              */}
          {collects && (
            <div className="mt-5 border-t border-border pt-4">
              <h3 className="text-xs">Fill this deck from your collection</h3>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
                Copies you already own move into this deck&rsquo;s folder. Nothing is added to the
                list and nothing is bought.
              </p>
              {/* The small print states the one thing a reader standing here has not seen: this
                  writes no `deck_cards` row, so a 4-copy line the deck is 3 short of stays a
                  4-copy line. The pull's own footer says it too, and that footer is behind the
                  press. */}
              <div className="mt-2.5">
                {/* The reason travels in the *name* for the Clear buttons' reason below, and the
                    words are the visible ones for the same one. */}
                <RowAction
                  ref={importTrigger}
                  disabled={nothingToPull}
                  onClick={() => setImporting(true)}
                >
                  {nothingToPull
                    ? "Import missing cards from collection… (nothing to import)"
                    : "Import missing cards from collection…"}
                </RowAction>
              </div>
            </div>
          )}

          {/* **Emptying a whole list is drawn here because this is the deck's cheapest
              screen, and that is an argument rather than a placement.** The other candidate
              was the editor's toolbar, and it is full: `ACTIONS` already gives up a word per
              button at 1100px and the rest of them at 900px, so a control pressed once a
              season would be paid for in width by the six that are pressed all day. This
              dialog is opened deliberately, read, and shut.

              **It is deliberately not in `DeckSettingsForm`, and that fence is structural
              rather than tidy.** `CreateDeckDialog` draws the same form over a deck that does
              not exist yet, where "empty the actual list" is a question about nothing — the form
              owns no mutation and reaches no backend precisely so that it can be drawn there,
              and a destructive control is the one thing that cannot follow it.

              **The first button is unconditional and the theory one is not**, because the two
              lists are not peers. Every deck has one list — a Virtual deck included, which is
              why this whole section survives on one where the section above it does not: a deck
              the reader owns none of still has cards in it and can still be emptied. A deck with
              `theoryEnabled` off has no plan at all, so a greyed `Clear theory list…` under it
              would be a control about a feature the reader has not turned on — which reads as
              something broken rather than as something absent, on a screen whose own switch is
              the way to turn it on.

              **What the first button is *called* is not unconditional**, and that is the one
              thing about this section a Virtual deck does move: `Actual` is half of a pair the
              reader only meets where there is a plan, so the word comes from {@link listName}
              rather than from a literal here. See the row itself. */}
          <div className="mt-5 border-t border-border pt-4">
            <h3 className="text-xs">Empty a list</h3>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
              Every card leaves the list. The piles it was filed in stay where they are.
            </p>

            {asking === null ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-4">
                {/* The reason travels in the *name*, because a greyed control whose name is
                    the bare label reads to a screen reader — and to a test — as a control
                    that is missing rather than one that has nothing to do. It is the visible
                    words that carry it: `RowAction` is a row's small print and takes no label
                    of its own, and a sighted reader is owed the same sentence.

                    **The noun is {@link listName}'s, never a literal, and that is what makes
                    this row honest on a Virtual deck.** `Actual` is one half of a pair — it
                    means *the list you have actually sleeved up, as against the plan* — and a
                    virtual deck has no plan and no such pair, so a button offering to clear its
                    "actual list" would be naming a distinction the deck does not draw and the
                    reader has never been shown. `live` is still the stored variant on such a
                    deck (see `DeckRow.virtualOnly`), so the *argument* is unchanged and only the
                    prose moves — which is the same join this helper was extracted to be. */}
                <RowAction
                  ref={liveTrigger}
                  destructive
                  disabled={liveCount === 0 || deck.clearDeck.isPending}
                  onClick={() => setConfirming("live")}
                >
                  {/* One expression and therefore one text node: two adjacent children would
                      be two, and the accessible-name algorithm trims each contribution before
                      joining — the `Missing2` failure this repo has already had once. */}
                  {`Clear ${listName("live", { virtual: !collects })}…` +
                    (liveCount === 0 ? " (already empty)" : "")}
                </RowAction>

                {/* **Gated on the plan, which is already the whole of the virtual gate** —
                    `theory_enabled` and `virtual_only` are two columns spelling one three-way
                    choice, so a virtual deck's `theoryEnabled` is `false` by construction and
                    Rust writes the pair defensively (`deckKind.ts`). A second `collects` test
                    here would be a redundant guard that reads as though the two facts were
                    independent, which is exactly the misreading `deckKind.ts` exists to stop. */}
                {row.theoryEnabled && (
                  <RowAction
                    ref={theoryTrigger}
                    destructive
                    disabled={theoryCount === 0 || deck.clearDeck.isPending}
                    onClick={() => setConfirming("theory")}
                  >
                    {`Clear ${listName("theory")}…` +
                      (theoryCount === 0 ? " (already empty)" : "")}
                  </RowAction>
                )}
              </div>
            ) : (
              /* The question stands where the buttons were — `CategoryRow`'s shape, an inline
                 confirmation inside a dialog that is already open, rather than a second scrim
                 over the first one. **It closes on success and only on success**: a refused
                 clear leaves the question up with the banner below explaining why, which is
                 what `ClearDeck` taking `pending` rather than closing itself is for. */
              <ClearDeck
                variant={asking}
                // The same answer `collects` is drawn from, inverted at the one call site that
                // needs it that way round: this asks *does this deck keep cardboard*, and the
                // confirmation's second sentence is a promise about where that cardboard goes.
                virtual={!collects}
                cardCount={asking === "theory" ? theoryCount : liveCount}
                // The list that is *not* being emptied, which is the reassurance the sentence
                // is there to give — so it is the other one of the same pair, never a repeat
                // of the subject.
                otherCount={asking === "theory" ? liveCount : theoryCount}
                pending={deck.clearDeck.isPending}
                onCancel={() => {
                  owedFocus.current = asking;
                  setConfirming(null);
                }}
                onCleared={() =>
                  deck.clearDeck.mutate(asking, { onSuccess: () => setConfirming(null) })
                }
              />
            )}
          </div>

          {/* Under both columns rather than beside the fields, which is where it used to
              sit: the form owns the two-column layout now, and a refused filing is as much
              this banner's business as a refused rename. */}
          {bannerFailure !== null && (
            <p role="alert" className="mt-3.5 text-xs text-destructive">
              Could not save that change — {bannerFailure}
            </p>
          )}

          {/* **Fed rather than fetching**, exactly as `DeckEditor` feeds it: the read is the
              hook above, so "what does a closed dialog cost" stays a question about one mount
              rather than about `AnimatePresence`'s teardown. Loading and a refused read go down
              as their own props because the dialog words all four of its states.

              **The mutation goes down whole and narrowed by the dialog's own `PullWrite`** —
              `deck.pullFromCollection`, which `useDeck` already mounts here for the clear's sake,
              so there is one command with one set of invalidations behind all three entrances. Its
              refusal is drawn *inside* that panel and is deliberately absent from
              {@link bannerFailure}'s list: this dialog's banner is behind the pull's own scrim,
              which is the delete confirmation's rule one surface over.

              **Last in the block, and the caret goes back to the trigger.** `Dialog` splits
              Escape and the ✕ from a press on the scrim, and this component folds the two into
              one `onClose` because where the caret lands is the *opener's* half of the contract.
              The trigger is drawn over rather than replaced — unlike the clear's, which the
              question takes the place of — so it is in the tree on this very render and needs no
              effect to reach it.

              **Behind the same {@link collects} gate as the section that opens it, and that is
              belt as well as braces on purpose.** `importing` cannot be set true on a Virtual
              deck because the only thing that sets it is a button that is not drawn — so this
              could have been left mounted and closed. It is not, for two reasons that both
              outlive today's wiring: the pull is fed `pullPlan`, which this deck deliberately
              never asks for, so a mounted panel would be one whose `rows` and `readError` are
              permanently the answers to a question nobody put; and *unreachable* is a property
              of one call site, where *not mounted* is a property of the tree. A second entrance
              added to this file later inherits the second and not the first. */}
          {collects && (
            <PullFromCollectionDialog
              open={importing}
              deckName={row.name}
              rows={pullPlan.data ?? null}
              loading={pullPlan.isLoading}
              readError={pullPlan.isError ? ipcError(pullPlan.error) : null}
              pull={deck.pullFromCollection}
              onClose={() => {
                setImporting(false);
                importTrigger.current?.focus();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
