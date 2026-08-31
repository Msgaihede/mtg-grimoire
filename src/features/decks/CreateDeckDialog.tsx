import { useCallback, useEffect, useId, useMemo, useState, type JSX } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckInput, type DeckRow } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY } from "./autoCategory";
import { Dialog } from "@/components/Dialog";
import { DeckSettingsForm, folderPaths, type DeckSettingsValue } from "./DeckSettingsForm";
import { DEFAULT_FORMAT } from "./FormatSelect";
import { useDeckFolders } from "./useDeckFolders";
import { ANY_GAME, pickerFormats, useFormatSpecs, type FormatOption } from "./useFormatSpecs";
import type { Decks } from "./useDecks";

/**
 * Every answer a deck is born with, before the reader has changed any of them — **except its
 * format**.
 *
 * `formatKey` is {@link DEFAULT_FORMAT} so the constant is honest read on its own: it is
 * `decks.format_key`'s own DDL default, and a deck that has been given no format really is
 * Casual. But it is the *fallback* rather than the answer — {@link CreateDeckBody} always
 * overwrites it with the `defaultFormatKey` its host resolved, which is the format the reader
 * last created a deck in. Nothing in this file leaves the value as it is written here.
 */
const BLANK: DeckSettingsValue = {
  name: "",
  formatKey: DEFAULT_FORMAT,
  // **Every deck is born on `Any`, and this one is not overwritten the way the format is.**
  // There is no `last_deck_game` beside `last_deck_format`, deliberately: the format a reader
  // last built in is a preference worth carrying, while the game is a *filter* they set to find
  // a format — remembering it would mean the next New deck dialog opened with most of the
  // format list already hidden, for a reason nothing on screen explains.
  gameKey: ANY_GAME,
  description: "",
  notes: "",
  theoryEnabled: false,
  folderId: null,
  // **The one field this dialog never asks about**, and the only honest answer it could give:
  // a deck being created has no categories — `deck_create` seeds the four zones in the same
  // transaction that makes the row — so there is no pile to offer and no id to write. This form
  // is passed no `categories`, so no "Add cards to" row is drawn, and the create sends nothing
  // for it: `decks.default_category_id` has `DEFAULT 0`, which is this same value.
  defaultCategoryId: AUTO_CATEGORY,
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
   * this dialog is opened, so its answer is a real value by the time {@link CreateDeckBody}
   * mounts and can be read straight into the draft's initial state. A read of this component's
   * own would arrive a beat *after* the first paint, which means overwriting a select the
   * reader may already have used — and no `useEffect` can tell "the answer landed" from "the
   * reader has not touched it yet". Making it required is what keeps that guarantee: a host that
   * has not thought about the question cannot quietly get Casual.
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
   * **A mount, not a class**, and it is {@link Dialog}'s guarantee rather than this file's:
   * everything with state — the half-typed name, the picked format, the chosen cover, the caret
   * — lives in {@link CreateDeckBody}, which the shell renders only while this is true. Closing
   * unmounts all of it and reopening starts a genuinely new question rather than one somebody
   * has to remember to clear.
   */
  open: boolean;
  /** The deck the write answered with. The gallery opens it — nobody makes a deck in order to
   *  look at a tile of it. */
  onCreated: (deck: DeckRow) => void;
  /**
   * Escape, the header's ✕ and the trigger pressed again: close, and hand the caret back to
   * whatever opened this. Handed straight to {@link Dialog}, which owns both rungs.
   *
   * **Stability is a courtesy here now, not a requirement.** This said "`useDismissOnEscape`
   * takes it as a dependency, so a function rebuilt on every render of the opener re-registers
   * the window listener just as often" — the hook latches it in a ref and depends only on
   * `enabled` and `layer`. It made that change for a correctness reason worth knowing: once the
   * hook kept a stack, a re-registration popped this layer's token and pushed a new one **on
   * top** of whatever had been opened over it, so the next Escape closed the wrong window. An
   * unstable one now costs a re-render and nothing else.
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
 * **The chrome is {@link Dialog}'s and no longer this file's** (2026-08-16). The scrim, the
 * `LAYER.overlay` rung, `aria-modal`, `trapTab`, the Escape registration on the *flag* and the
 * titled header with its ✕ were a hand-copy of that shell, and a copy is a second decision that
 * happens to agree today: this file's scrim and the shell's were already byte-identical, while
 * the ✕ underneath them had drifted to a second geometry and a second speed. What is left here
 * is the question the dialog asks — see {@link CreateDeckBody}.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects
 * a runtime `<style>`). A `fixed` element is positioned against the viewport *unless* an
 * ancestor carries a `transform`, `filter` or `contain`, any of which makes that ancestor the
 * containing block instead — the gallery's heading row carries none, which is what lets this
 * stay inside `NewDeck` beside the button it belongs to, at 55rem as it did at 24rem. The
 * `Import deck` dialog is mounted in the same row and is the standing proof. The shell's panel
 * is `fixed` for the same reason and inherits the same condition.
 *
 * **The Escape rung is registered on the flag**, which is the shell's own guarantee: with an
 * exit animation the panel outlives `open` by the length of its fade, so a rung that came up
 * with the *element* would still be consuming Escape while the next layer was opening. For the
 * same reason `DecksPage`'s own rung excludes this panel: one layer, one rung.
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
  // `<CreateDeckBody/>` here is an *element*, not a call: React renders it only where the shell
  // puts it in the tree, which is inside the shell's `open &&`. So a closed dialog costs no
  // draft, no folder read and no format read — `DeckSettingsDialog`'s arrangement, for
  // `DeckSettingsDialog`'s reason.
  return (
    <Dialog
      open={open}
      title="New deck"
      closeLabel="Close"
      width="w-[55rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <CreateDeckBody
        create={create}
        defaultFormatKey={defaultFormatKey}
        defaultFolderId={defaultFolderId}
        onCreated={onCreated}
      />
    </Dialog>
  );
}

/**
 * The question the dialog asks — mounted only while it is open, which is
 * {@link Dialog}'s guarantee and what makes every draft below a session rather than
 * something an effect has to clear.
 *
 * It is the shell's `children`, so it renders inside the same `AnimatePresence` child the panel
 * does and is a flex item of the panel: the scroller and the footer below are the two boxes
 * under the shell's header.
 *
 * ## One draft, and nothing written until **Create deck**
 *
 * {@link DeckSettingsForm} takes both `onChange` (every keystroke and press) and `onCommit` (a
 * text field the reader is finished with) because its two hosts differ in exactly that: the
 * settings dialog writes as each control settles, and this one **ignores `onCommit`
 * entirely** — there is nothing to write to until the deck exists. Every change is merged into
 * one local {@link DeckSettingsValue} and sent as a single `deck_create`.
 *
 * **One press is one write again, and that is a deletion rather than a fix.** A cover could be
 * a picture off disk until 2026-08-31, and `deck_set_cover_image` took a path **and a deck id**
 * — so the file was the one answer on this form that could not travel in the create, and had to
 * be uploaded after the INSERT had answered. That made a two-step write out of a one-button act,
 * with a state in the middle nobody wanted: the deck exists and its picture does not. This file
 * carried a `made` row of state, a second mutation, a second failure line and a button that
 * renamed itself to **Open deck**, all of them for that one case — a created deck must be
 * neither lost (a refused *picture* silently discarding a deck the database really has) nor
 * duplicated (a second press of a button still saying "Create deck"). A cover is a card id now
 * and travels in {@link DeckInput.coverCardId}, so the middle state cannot occur and all of it
 * is gone.
 *
 * ## The cover's credit is fetched, because there is no `DeckRow` to carry it
 *
 * The preview draws a card's `art` crop only when the illustrator is known, because an `art`
 * crop has no printed frame and Scryfall's image policy says it must be credited wherever one
 * is shown — `DeckRow.coverArtist`'s own ruling, which the gallery tile makes too. That name is
 * a `LEFT JOIN cards` the backend does on the way out of a deck read, and there is no deck here
 * to read; `CardSummary` carries no `artist` either, and widening `search.rs` for a picker's
 * thumbnails is ruled out. So **this host asks for the card** — see {@link CreateDeckBody}'s `artist`
 * query — because it is the surface that knows it has no row to read the name off.
 *
 * The refusal itself is not weakened anywhere. While the read is in flight the preview says
 * what it says for any cover it cannot credit, the tile's `aria-pressed` is the immediate
 * feedback, and a printing whose artist genuinely cannot be found is still drawn as nothing.
 * The credit arrives **with** the picture and never before it.
 */
function CreateDeckBody({
  create,
  defaultFormatKey,
  defaultFolderId = null,
  onCreated,
}: Omit<CreateDeckDialogProps, "open" | "onDismiss" | "onClose">) {
  /**
   * The draft, seeded with the format the host resolved.
   *
   * **A lazy initializer, and mount-only by construction.** There is no effect anywhere here
   * that could land on top of a format the reader has already picked — the question is asked
   * once, when the body mounts, and the answer is theirs from that moment. That is safe
   * *because* {@link Dialog} renders this only while it is open: closing unmounts the
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

  const { specs } = useFormatSpecs();
  const folders = useDeckFolders();
  const id = useId();

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
   * The formats to offer, narrowed to the game the draft is on. **Never `[]`** — see
   * {@link CASUAL_ONLY}.
   *
   * No `keep` row, unlike the settings dialog's: that one folds in a deck's own format in case
   * the picker no longer offers it, and there is no deck here whose format could have left.
   *
   * **Which means the draft's format can fall out of this list, and that is the one thing the
   * create path has to handle that the edit path does not.** A reader who picks Modern and then
   * switches the game to Arena is holding a `formatKey` no option carries, and a controlled
   * `<select>` with an unmatched value shows its *first* row while still reporting the old one
   * — so the deck would be made in Modern while the dialog read "Alchemy". {@link formatKey}
   * below is what closes that.
   */
  const picker = useMemo(() => pickerFormats(specs, null, value.gameKey), [specs, value.gameKey]);
  const formats = picker.length > 0 ? picker : CASUAL_ONLY;

  /**
   * The format the dialog is actually on — **derived, never written back to the draft.**
   *
   * An effect that repaired `value.formatKey` was the obvious shape and is the one React's own
   * lint refuses (`react-hooks/set-state-in-effect`): state computable from state is a render,
   * not a synchronisation. Deriving it also has a property the repair did not — it is **not
   * destructive**. A reader who narrows to Arena, thinks better of it and goes back to Any finds
   * Modern still selected, because the draft was never overwritten.
   *
   * The first row of the narrowed list when the draft's format is not in it: that is what the
   * `<select>` draws for an unmatched value anyway, so this makes the reported answer agree with
   * the screen rather than inventing a third one.
   *
   * **The `picker.length === 0` arm is the guard, and it is why this reads `picker` rather than
   * {@link formats}.** On the one launch where `format_specs` has not answered, `formats` is
   * {@link CASUAL_ONLY} — a one-row list carrying no `modern` — so deriving against *that* would
   * answer Casual for the whole loading window and quietly discard the format the host resolved.
   * That shipped for one test run as an effect, which is the version the suite caught.
   */
  const formatKey =
    picker.length === 0 || picker.some((f) => f.key === value.formatKey)
      ? value.formatKey
      : picker[0].key;

  const paths = useMemo(() => folderPaths(folders.folders), [folders.folders]);

  // Merged into the one draft. `onCommit` is not passed at all: a text field the reader has
  // finished with is news to a host that writes, and this one has nothing to write to yet.
  const onChange = useCallback(
    (patch: Partial<DeckSettingsValue>) => setValue((v) => ({ ...v, ...patch })),
    [],
  );

  const trimmed = value.name.trim();
  const createFailure = create.isError ? ipcError(create.error) : null;
  const busy = create.isPending;

  const submit = () => {
    // A write is in flight. The press is not a second deck.
    if (busy) return;
    // A name of nothing but spaces is not a name. The control is greyed on the same test, and
    // this is the half that actually refuses — an `aria-disabled` button still delivers its
    // press, which is the whole reason it is not the `disabled` attribute.
    if (!trimmed) return;

    create.mutate(
      {
        name: trimmed,
        // The **derived** key and not the draft's, so the deck is made in the format the select
        // was showing. They differ only after the reader has narrowed the game past their own
        // earlier pick, which is exactly the case this sends the right answer for.
        formatKey,
        gameKey: value.gameKey,
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
      // The row the INSERT answered with, cover and all — there is no follow-up write left to
      // wait for, so the deck opens on the one answer.
      { onSuccess: onCreated },
    );
  };

  return (
    // The shell's header sits above these two, and the panel around them is the `flex flex-col`
    // that makes the scroller work — see {@link Dialog}.
    <>
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
          // The draft, with the **derived** format over it — the same key `submit` sends, so the
          // select cannot show one format while the button makes a deck in another.
          value={{ ...value, formatKey }}
          onChange={onChange}
          // Enter in the Name field, and the same function the button calls — so both guards
          // below (a write in flight, a blank name) refuse a keyboard press exactly as they
          // refuse a pointer's.
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
            // Fetched, because there is no `DeckRow` to read it off — see the `artist` query
            // above. `null` until it lands, and `null` if it cannot be found, which is the
            // preview's own ruling either way: an `art` crop this app cannot credit is not
            // drawn at all.
            coverArtist: artist.data?.artist ?? null,
            // A deck being made has none. The picker's own empty state says exactly that, and
            // its search box is what does the work here.
            deckCards: [],
            // Straight into `useState`: at create the picked id is a draft field like every
            // other, and it travels in the `deck_create` below. The settings dialog writes on
            // this same callback, which is the whole of the difference between the two hosts.
            onPickCard: setCoverCardId,
            idPrefix: id,
          }}
          idPrefix={id}
        />
      </div>

      <footer className="flex items-center gap-4 border-t border-border px-5 py-4">
        {/* One line, and one write to fail: the create is the whole of what this dialog does
              now. There were two sentences here, the second for a deck that was made and could
              not be pictured, which is a state a card-id cover cannot reach. It sits in a row
              that already has the button's height, so it grows nothing when it appears and
              needs no tween. */}
        {createFailure !== null && (
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            Could not create the deck — {createFailure}
          </p>
        )}

        <button
          type="button"
          // `aria-disabled`, never the attribute: a control that greys as the reader types
          // must stay in the tab order, and the caret it would have thrown away on the press
          // that started a write has to have somewhere to come back to. It also keeps the
          // trap's cycle the same length whatever the name field holds. The refusal itself is
          // `submit`'s, which is what makes the two halves one rule.
          aria-disabled={!trimmed || busy ? true : undefined}
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
                deck" is the one whose press opens the deck it created. It used to have a second
                label, **Open deck**, for the deck that existed with no picture on it — a state
                the cover being a card id has taken away. */}
          Create deck
        </button>
      </footer>
    </>
  );
}
