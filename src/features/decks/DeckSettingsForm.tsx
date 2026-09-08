import type { JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import type { DeckCategory, DeckFolder, DeckGame } from "@/lib/ipc";
import { compareLabels } from "@/lib/options";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, AUTO_CATEGORY_LABEL } from "./autoCategory";
import { DeckCoverPicker, type DeckCoverPickerProps } from "./DeckCoverPicker";
// The three kinds, their words and the patch that writes them — `deckKind.ts` is the one
// place `theoryEnabled` and `virtualOnly` are read or written together, and this form is a
// consumer of that rule rather than a second copy of it.
import {
  DECK_KIND_HINT,
  DECK_KIND_LABEL,
  DECK_KINDS,
  deckKind,
  deckKindPatch,
  type DeckKind,
} from "./deckKind";
import { CAPTION, FIELD } from "./formFields";
// The **vocabulary**, not the control. `FormatSelect.tsx`'s `GameSelect` draws these same four
// rows for the import dialog and is deliberately not reused here, exactly as its `FormatSelect`
// is not: that file's labels are `text-xs text-dim` and this form's are `CAPTION`, so one
// borrowed control would be the one row in this panel whose caption did not match its
// neighbours. What must not be written twice is the list of games, and it is not.
import { GAME_OPTIONS } from "./useFormatSpecs";

/** How deep a folder path is walked before the walk is called a cycle. */
const MAX_FOLDER_DEPTH = 32;

/** Everything a deck carries that is not the cards in it, as one settled set of answers. */
export interface DeckSettingsValue {
  name: string;
  formatKey: string;
  /**
   * Which platform the deck is for, or `"any"` for none in particular.
   *
   * **It is stored on the deck and it filters the format select beside it, and those are two
   * different jobs done by one answer.** The host is what narrows the list — it calls
   * `pickerFormats` and passes the result as {@link DeckSettingsFormProps.formats} — because
   * only the host knows whether the deck's own format has to be folded back in. This form
   * draws the control and reports the change.
   */
  gameKey: DeckGame;
  description: string;
  notes: string;
  /**
   * Whether this deck keeps a plan beside the list it has actually sleeved up — and **half
   * of a pair, never written on its own**.
   *
   * It is one of the two columns a {@link DeckKind} is folded out of, and the group that
   * draws them writes both at once through `deckKindPatch`. *Reading* it alone is still
   * right and is what the three mark rows below gate on — a mark compares the live list
   * against a plan, so having a plan is the whole question. *Writing* it alone is what would
   * produce the `theoryEnabled && virtualOnly` row `deckKind.ts` exists to keep out of the
   * database.
   */
  theoryEnabled: boolean;
  /**
   * Whether this deck is one the reader tracks **without owning the cardboard** — an MTGO or
   * Arena list, a proxy pile. The other half of that pair, and the same rule.
   *
   * **Required on the value even though nothing else on this panel reads it**, which is
   * {@link DeckSettingsValue.defaultCategoryId}'s rule one field over: a value shape that
   * changed with its host would be two shapes. Both hosts hold it, the create draft holds
   * `false`, and `deckKind(value)` is the only thing that reads the pair.
   */
  virtualOnly: boolean;
  /**
   * Whether this deck draws the **green** theory mark — a live row that is the printing the plan
   * named. See `theoryMatch.ts` for what "off" does, which is not "nothing": an exact row on a
   * deck with this off draws the blue mark instead.
   */
  theoryMarkExact: boolean;
  /** Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   *  not name. */
  theoryMarkName: boolean;
  /**
   * Whether this deck draws the **red** theory mark — a live row the plan does not ask for at
   * all, in any printing (2026-09-08).
   *
   * The tier *below* the other two rather than a third statement about a printing: green and
   * blue both say *your plan asks for this card* and differ only on how precisely, where this
   * one says the plan asks for it **not at all** — a stand-in, a spare, an experiment.
   */
  theoryMarkUnplanned: boolean;
  folderId: number | null;
  /**
   * Which pile an add that names none lands in — `AUTO_CATEGORY` (`0`) for "by what the card
   * does", which is what a deck is born on.
   *
   * On the value even though only one host draws a control for it, because a value shape that
   * changed with the host would be two shapes; the create dialog holds `AUTO_CATEGORY` here and
   * sends nothing, which is exactly what a deck with no categories yet can honestly answer.
   */
  defaultCategoryId: number;
}

export interface DeckSettingsFormProps {
  value: DeckSettingsValue;
  /** Every change, live: a keystroke, a select, a press. */
  onChange: (patch: Partial<DeckSettingsValue>) => void;
  /**
   * A text field the reader is finished with — blur, Enter, or the surface closing. The
   * settings dialog writes here; the create dialog has nothing to write yet and ignores it.
   *
   * The patch carries the field's current text, so a host may either write it or read only
   * *which* key is present and commit its own draft. Firing on every blur is deliberate and
   * safe: `useDeckField.onBlur` is a no-op when nothing was typed, which is exactly what the
   * settings dialog's fields do today.
   *
   * **"The surface closing" is not this form's to notice.** A controlled component has no draft
   * to rescue and no idea what a host means by closed; that half is `useDeckField`'s
   * `useIsPresent` commit, one floor up.
   */
  onCommit?: (patch: Partial<DeckSettingsValue>) => void;
  /**
   * Enter in the **Name** field, and in no other field of this form.
   *
   * **One field's Enter is a submission and every other field's is not**, which is a split
   * rather than an inconsistency:
   *
   * | Field | What Enter means |
   * | --- | --- |
   * | Name | "that is the answer" — a single-line field whose key ends the whole question |
   * | Description, Notes | a newline. A paragraph is what these are for |
   * | The cover picker's search box | "I have finished typing a card name", never "make the deck" — `DeckCoverPicker` prevents the key itself rather than leaving it to whatever is mounted above |
   *
   * The Name field used to get that for free: `CreateDeckDialog` was a `<form>`, so Enter in a
   * single-line input was implicit submission. It is not one now — implicit submission fires
   * from *any* single-line input in a form, and this panel holds a second one — so the meaning
   * of the key is decided here, per field, instead of by the browser for all of them.
   *
   * **Absent is the settings dialog, and its Enter is unchanged**: `preventDefault()` and a
   * blur, because there the blur *is* the write and there is nothing to submit. **Present is a
   * create host**, and then Enter calls this and leaves the caret in the field — a refused
   * create keeps every answer, and the one the reader would fix is the one they are in.
   *
   * The host's own guards decide what the press does: this is the same function its button
   * calls, so a blank name refuses on Enter exactly as it refuses on a press.
   */
  onSubmit?: () => void;
  /**
   * The formats to offer, **already in the order they are offered in** — `pickerFormats`, which
   * the host calls, because only the host knows whether a deck's own format has to be folded in
   * (`src/lib/options.ts` is the app-wide rule and `pickerFormats` is where it is applied for
   * this list).
   */
  formats: readonly { key: string; name: string }[];
  folders: {
    /** {@link folderPaths}' answer, which the host computes for the same reason: the raw rows
     *  come from a query this form may not mount. */
    paths: readonly { id: number; path: string }[];
    /** The folder list could not be read; the select is no use without it and says so. */
    unread: string | null;
    loading: boolean;
    pending: boolean;
  };
  /**
   * Every pile this deck has, **in the order the deck draws them** — `sortOrder`, the reader's
   * own arrangement, and one of the exemptions `src/lib/options.ts` names: sorting them here
   * would make this select disagree with the columns on the desk.
   *
   * **Active and inactive alike, and that is deliberate rather than an omission.** `isActive`
   * means "counts toward nothing" — not size, not copy limits, not legality, not the allocator —
   * and it has never meant "cannot be filed into"; a switched-off Maybeboard is exactly the pile
   * a reader building a shortlist wants every add to land in. Nothing here draws the switch,
   * because this select answers *where*, and the Categories dialog is where a pile is switched.
   *
   * **Absent is a host with no deck yet**, and then no "Add cards to" row is drawn at all:
   * `CreateDeckDialog` renders this form before `deck_create` has seeded the four zones, so it
   * has no pile to offer and no id to write. That is the one field of {@link DeckSettingsValue}
   * the two hosts do not both ask about, and the asymmetry is the honest one — the question is
   * not answerable yet, rather than answerable and skipped.
   */
  categories?: readonly DeckCategory[];
  /**
   * Whether an answer about the deck's three theory marks has anywhere to be **written** —
   * absent (or `false`) for a host asking about a deck that does not exist yet, and then the
   * three rows under the theory switch are not drawn at all.
   *
   * **This is {@link DeckSettingsFormProps.categories}' rule reaching a second field**, and the
   * argument is that one word for word: at create the question is *not answerable yet* rather
   * than answerable and skipped. `DeckInput` carries none of `theoryMarkExact`,
   * `theoryMarkName` and `theoryMarkUnplanned` — the columns are `NOT NULL DEFAULT 1` and the
   * schema owns a new deck's answer — so a reader who switched the plan on inside "New deck" and
   * then switched a mark off would be answering a question nothing could write down: the deck
   * would be born with all three marks on, and nothing on screen would say the press was
   * dropped. **A control that cannot take effect is worse than no control**, because it teaches
   * the reader something false about their deck. All three marks are a *reading* preference, one
   * press away in Deck settings on the deck that opens the moment Create is pressed.
   *
   * **A prop of its own rather than `categories`' absence read a second time.** The two hosts
   * happen to answer both the same way today, and they are two questions — "has this deck any
   * piles to file into" against "is there a deck row for a mark to be written to" — so one prop
   * standing for both would take the marks away the day a host has a deck and passes no piles.
   * `src/features/decks/CLAUDE.md`'s "three independent questions" rule, one field over.
   *
   * **The three fields stay required on {@link DeckSettingsValue} whatever this says**, which is
   * that value's own rule: a shape that changed with its host would be two shapes. The create
   * draft holds `true` for all three and sends none of them.
   */
  canSetTheoryMarks?: boolean;
  cover: DeckCoverPickerProps;
  idPrefix: string;
}

/**
 * Every deck-level field, and **no mutation**.
 *
 * Two surfaces ask the same questions — `DeckSettingsDialog` about a deck that exists, and
 * `CreateDeckDialog` about one that does not yet — so the questions live here once and the two
 * hosts differ only in what they do with the answers.
 *
 * ## The rule that makes that possible
 *
 * **This form imports no hook that reaches the backend.** Not `useDeck`, not `useDeckFolders`,
 * not `useFormatSpecs`, and no `useMutation`. Every fact arrives as a prop and every change
 * leaves as a callback. That is the whole of why it can be rendered before the deck exists, and
 * it is the rule to hold as the file grows: the moment one query is mounted in here, the create
 * dialog is reading a deck with no id.
 *
 * ## Two callbacks, and which control uses which
 *
 * | Control | `onChange` | `onCommit` |
 * | --- | --- | --- |
 * | Name, Description, Notes | every keystroke | on blur — and Enter blurs the name field, unless a host took Enter for {@link DeckSettingsFormProps.onSubmit} |
 * | Game, Format, Deck kind, Folder, the cover | on the one act that settles them | never |
 *
 * A select, a switch and a tile all finish in a single act, so there is nothing for a second
 * callback to add. A text field does not, which is the whole reason the pair exists.
 *
 * There is a third callback, and it is about one key rather than one control:
 * {@link DeckSettingsFormProps.onSubmit} is Enter in the **Name** field and nowhere else. Its
 * doc has the table of what Enter means in each of the others.
 *
 * ## What each host does with them
 *
 * | Host | Writes on |
 * | --- | --- |
 * | `DeckSettingsDialog` (edit) | `onChange` for game, format, the deck's kind, folder and the cover; `onCommit` for the three text fields — which is today's behaviour exactly, one write per control as it settles |
 * | `CreateDeckDialog` (create) | nothing. It merges every `onChange` into a draft and **ignores `onCommit` entirely**, then sends one `deck_create` |
 *
 * ## What it deliberately does not render
 *
 * No dialog chrome: no scrim, no header, no submit button, no write banner and no loading,
 * read-failure or deck-is-gone state. Every one of those is about the *surface* rather than
 * about the deck, and both hosts already own theirs.
 */
export function DeckSettingsForm({
  value,
  onChange,
  onCommit,
  onSubmit,
  formats,
  folders,
  categories,
  // Absent is a host that cannot write the answer, which is the create dialog — see the prop.
  canSetTheoryMarks = false,
  cover,
  idPrefix,
}: DeckSettingsFormProps): JSX.Element {
  return (
    <div className="flex flex-wrap gap-6">
      <div className="w-full space-y-3.5 sm:w-[22.5rem] sm:shrink-0">
        {/* Straight through: the picker owns its own preview, its grid, its search and its
            upload, and this form owns none of that — it owns where the column sits. */}
        <DeckCoverPicker {...cover} />
      </div>

      <div className="min-w-0 flex-1 space-y-3.5">
        <Fields
          value={value}
          onChange={onChange}
          onCommit={onCommit}
          onSubmit={onSubmit}
          formats={formats}
          id={idPrefix}
        />

        <div className="space-y-2.5 border-t border-border pt-3.5">
          {categories !== undefined && (
            <DefaultCategoryRow
              categoryId={value.defaultCategoryId}
              categories={categories}
              onPick={(defaultCategoryId) => onChange({ defaultCategoryId })}
              id={idPrefix}
            />
          )}
          <DeckKindGroup
            kind={deckKind(value)}
            // **Both columns, always.** `deckKindPatch` names `theoryEnabled` *and*
            // `virtualOnly` on every press, so no press can leave the other one standing —
            // which is what keeps the impossible `true, true` row out of a draft as well as
            // out of the database. The patch goes straight into `onChange`, so the edit host's
            // single `deckUpdate` carries the pair and the create host's draft holds it.
            onPick={(kind) => onChange(deckKindPatch(kind))}
            id={idPrefix}
          />
          {/* **Two gates, and they are two different questions.** `theoryEnabled` is *is there a
              plan to compare against* — all three marks are drawn by reading the live list
              against the theory list, so with no plan a row here would change what is on
              screen not at all and nothing on screen would say why. The red one is no exception:
              *not in the theory list* is still a statement about a list, and with no plan every
              row would wear it. {@link DeckSettingsFormProps.canSetTheoryMarks} is *can this host
              write the answer down* — `false` at create, where `DeckInput` carries none of the
              three columns. Neither is a greyed set: a control that changes nothing and a control
              that cannot take effect are both worse than no control.

              **The first gate still reads `theoryEnabled` and deliberately not the kind, and it
              needs no arm for `virtual`.** `deckKindPatch` writes both columns on every press
              and only `theory` sets this one, so `Regular` and `Virtual` each leave it `false`
              — checked against that function rather than assumed, and pinned by
              `DeckSettingsForm.test.tsx`'s *hides the mark rows for both of the other two
              kinds*. So the rows vanish for both by the one test that was already here, and a
              `deckKind(value) === "theory"` beside it would be a second spelling of one fact,
              free to drift from the patch the moment a fourth kind is added. */}
          {value.theoryEnabled && canSetTheoryMarks && (
            <TheoryMarkSwitches
              exact={value.theoryMarkExact}
              name={value.theoryMarkName}
              unplanned={value.theoryMarkUnplanned}
              onExact={(theoryMarkExact) => onChange({ theoryMarkExact })}
              onName={(theoryMarkName) => onChange({ theoryMarkName })}
              onUnplanned={(theoryMarkUnplanned) => onChange({ theoryMarkUnplanned })}
              id={idPrefix}
            />
          )}
          <FolderRow
            folderId={value.folderId}
            paths={folders.paths}
            unread={folders.unread}
            loading={folders.loading}
            pending={folders.pending}
            onMove={(folderId) => onChange({ folderId })}
            id={idPrefix}
          />
        </div>
      </div>
    </div>
  );
}

/** Name, game, format, description, notes — what the deck carries as words. */
function Fields({
  value,
  onChange,
  onCommit,
  onSubmit,
  formats,
  id,
}: {
  value: DeckSettingsValue;
  onChange: (patch: Partial<DeckSettingsValue>) => void;
  onCommit?: (patch: Partial<DeckSettingsValue>) => void;
  onSubmit?: () => void;
  formats: readonly { key: string; name: string }[];
  id: string;
}) {
  const gameOptions: readonly DropdownOption[] = GAME_OPTIONS.map((g) => ({
    value: g.key,
    label: g.name,
  }));
  // The key, because a value with no list beside it is all this form has been
  // given — {@link DeckSettingsValue} carries no display name. A host that can do
  // better hands over a one-row list instead of an empty one, which is what both
  // of them do: the settings dialog folds the deck's own format in through
  // `pickerFormats`' `keep`, and the create dialog falls back to Casual.
  //
  // **Belt and braces since the shell replaced the `<select>`.** A controlled native
  // select whose value matched no option used to show its first row while still
  // reporting the old one; `Dropdown` cannot make that mistake — an unmatched value
  // draws its own em-dash placeholder instead. What is load-bearing now is showing
  // the raw key rather than that placeholder: a host that has handed over no display
  // name at all still reads better as "modern" than as "—".
  const formatOptions: readonly DropdownOption[] =
    formats.length === 0
      ? [{ value: value.formatKey, label: value.formatKey }]
      : formats.map((f) => ({ value: f.key, label: f.name }));

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-40 flex-1">
          <label htmlFor={`${id}-name`} className={cn(CAPTION, "mb-1.5")}>
            Name
          </label>
          <input
            id={`${id}-name`}
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            onBlur={() => onCommit?.({ name: value.name })}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // The key stops here whatever it goes on to mean. Nothing above may add a second
              // meaning to it — and in a host that ever *is* a `<form>` again, this is what
              // keeps implicit submission from firing alongside the branch below.
              e.preventDefault();
              if (onSubmit !== undefined) {
                // A submission. **No blur**: the caret stays in the field, which is where a
                // reader whose create was refused would want it — every answer is still on
                // screen and this is the one they would change. Nor is `onCommit` fired, for
                // the reason the branch below exists: committing *and* submitting would hand
                // a host two events for one press.
                onSubmit();
                return;
              }
              // Blur rather than a direct `onCommit` call: the blur handler above is the one
              // definition of "the reader is finished with this field", and a direct call
              // here would be that definition written twice — which is one edit written
              // twice for any host whose commit is not idempotent.
              e.currentTarget.blur();
            }}
            // Geist and not the display face: a deck's name is *content*, and Cinzel is drawn
            // in caps — which in a field you type into means the letters never match the ones
            // being typed.
            className={cn(FIELD, "h-9")}
          />
        </div>
        {/* Before the format and not after it, because it *narrows* the format list: a reader
            reading left to right meets the question whose answer changes the next control
            first. Narrower than the format dropdown — four short words against "Tiny Leaders:
            Reborn" — and the row wraps, so on a squeezed dialog the two dropdowns fold together
            under the name rather than the name being crushed between them. */}
        <div className="w-32">
          <label id={`${id}-game-label`} htmlFor={`${id}-game`} className={cn(CAPTION, "mb-1.5")}>
            Game
          </label>
          <Dropdown
            id={`${id}-game`}
            labelledBy={`${id}-game-label`}
            value={value.gameKey}
            // The cast is `GameSelect`'s, for its reason: every option is written out of
            // `GAME_OPTIONS`, so no other string can reach this handler.
            onChange={(gameKey) => onChange({ gameKey: gameKey as DeckGame })}
            options={gameOptions}
            fill
          />
        </div>
        <div className="w-44">
          <label
            id={`${id}-format-label`}
            htmlFor={`${id}-format`}
            className={cn(CAPTION, "mb-1.5")}
          >
            Format
          </label>
          <Dropdown
            id={`${id}-format`}
            labelledBy={`${id}-format-label`}
            value={value.formatKey}
            onChange={(formatKey) => onChange({ formatKey })}
            options={formatOptions}
            // The seeded table is read once per session and is normally in hand before this
            // renders; on the one launch where it is not, the trigger still has to say
            // something, and what it says is the format the deck already has. A real
            // `disabled` is right here for the reason `FormatSelect` gives: there is no reader
            // input making it grey, and a dropdown with one option is not a choice to keep in
            // the tab order.
            disabled={formats.length === 0}
            searchable
            fill
          />
        </div>
      </div>

      <div>
        <label htmlFor={`${id}-description`} className={cn(CAPTION, "mb-1.5")}>
          Description
        </label>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
          onBlur={() => onCommit?.({ description: value.description })}
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
          value={value.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          onBlur={() => onCommit?.({ notes: value.notes })}
          className={cn(FIELD, "resize-y py-2 leading-relaxed")}
        />
      </div>
    </>
  );
}

/**
 * Where a card goes when the reader adds one without saying — the editor's old "Add to" select,
 * asked here.
 *
 * **It sat in the deck builder's own chrome until 2026-08-15**, on the docked search panel's
 * header row, and it was `useState` in `DeckEditor`: a reader who pointed it at their Sideboard
 * lost that the moment they closed the deck, and the *other* surface it governed — the toolbar's
 * quick-add field — drew no control at all, so the only way to find out where a quick add would
 * land was to read the field's label. It is `decks.default_category_id` now, one question asked
 * beside the format and the folder and remembered with them.
 *
 * **`Auto` is pinned first and is not a category** — {@link AUTO_CATEGORY}, `0`, which no pile's
 * id can collide with. Everything under it is the deck's own piles in the deck's own order, and
 * an inactive one is in that list like any other: `isActive` decides what a pile *counts*
 * toward, never whether cards may be put in it.
 *
 * A dropdown speaks strings and a category is addressed by number, so the id makes the round
 * trip through `String`/`Number` here rather than anywhere the write can see it: every value in
 * this list was written out of a `DeckCategory.id` or out of the constant, so the parse cannot
 * meet anything else.
 */
function DefaultCategoryRow({
  categoryId,
  categories,
  onPick,
  id,
}: {
  categoryId: number;
  categories: readonly DeckCategory[];
  onPick: (categoryId: number) => void;
  id: string;
}) {
  const picked = categories.find((c) => c.id === categoryId);

  // Pinned above the piles, and the one row here that is not one. **Deliberately not
  // alphabetical** below it, and one of the exceptions `src/lib/options.ts` names: the
  // categories arrive in `sort_order, id` — the order the reader dragged them into in the
  // Categories dialog, and the order every deck view draws its columns in. Sorting them
  // here would make this dropdown disagree with the deck it is about.
  const options: readonly DropdownOption[] = [
    { value: String(AUTO_CATEGORY), label: AUTO_CATEGORY_LABEL },
    ...categories.map((category) => ({
      value: String(category.id),
      label: category.isActive ? category.name : `${category.name} (off)`,
    })),
  ];

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <label
          id={`${id}-default-category-label`}
          htmlFor={`${id}-default-category`}
          className="block text-sm"
        >
          Add cards to
        </label>
        {/* What the answer *means*, in the reader's terms — the same job the folder row's
            second line does. Under `Auto` it names the rule rather than a pile, because there
            is no one pile: it is decided per card. A picked pile that is switched off says so,
            because that is the fact most likely to surprise somebody who set this weeks ago and
            has since switched the pile off in the Categories dialog — the cards still land
            there, and they still count toward nothing. */}
        <p className="mt-0.5 truncate text-[0.6875rem] text-dim">
          {picked === undefined
            ? "Removal, Ramp, Draw — decided per card from what it does."
            : picked.isActive
              ? `Every add lands in ${picked.name}.`
              : `Every add lands in ${picked.name}, which is switched off and counts toward nothing.`}
        </p>
      </div>
      <div className="w-44 shrink-0">
        <Dropdown
          id={`${id}-default-category`}
          labelledBy={`${id}-default-category-label`}
          value={String(categoryId)}
          onChange={(v) => onPick(Number(v))}
          options={options}
          searchable
          size="sm"
          fill
        />
      </div>
    </div>
  );
}

/**
 * Which of the three kinds this deck is — one control, three exclusive presses.
 *
 * It replaced a single `Theory deck` switch on 2026-09-08, when `virtual` became the third
 * kind ([issue #401](https://github.com/Msgaihede/mtg-grimoire/issues/401)). A switch answers
 * a yes-or-no question, and this stopped being one: a deck is a *regular* deck, a deck with
 * a plan, or a deck whose cardboard the reader does not own, and the two booleans behind
 * that are one choice wearing two columns.
 *
 * **`role="group"` with `aria-pressed` per button, never a radiogroup.** That is
 * `features/scanner/panels/ControlsPanel.tsx`'s grammar and its argument verbatim: these are
 * toggles that happen to be exclusive, and a radio's roving tab stop would put the reader
 * inside a three-way keyboard mode to change one word. Its `Segment` is the **precedent and
 * not the component** — that file is a private dev panel, sized and coloured for a debug
 * rail, and importing a control out of it would tie this panel to a surface no reader sees.
 *
 * **It is drawn as the editor's own `Theory | Actual` switch is** (`DeckEditor.tsx`'s variant
 * group): the same joined box, the same `bg-accent`/`text-accent-fg` pressed half against
 * `text-dim hover:text-text`, the same 150ms colour tween with its `motion-reduce` opt-out.
 * That resemblance is the point rather than a coincidence — this control is what decides
 * whether that one is drawn at all, so a reader who sets `Theory + Actual` here should meet
 * the same object in the ribbon rather than two segmented controls that merely rhyme.
 * **The height is this panel's and not that ribbon's**: `h-8`, {@link SwitchButton}'s, where
 * the editor's group is `h-9` because that row is sized by a `ToggleChip` standing in it.
 *
 * **The caption goes underneath, which is the one place this row departs from the panel's
 * heading-left / control-right grammar**, and either half of the reason would be enough on
 * its own. The group is the widest control here — three words against a switch's one and a
 * dropdown's `w-44` — so a caption beside it would be squeezed into a column narrower than
 * the sentence it has to draw, at both hosts' widths. And the sentence *is the answer to the
 * press*: it changes with every one of the three, so it belongs under the buttons it is
 * about, where a caption in the left column would read as a standing description of the row.
 *
 * **It hands back a {@link DeckKind} and never a patch.** The one place `theoryEnabled` and
 * `virtualOnly` are spelled together stays `deckKindPatch`, so this component cannot be the
 * thing that writes one of them alone.
 */
function DeckKindGroup({
  kind,
  onPick,
  id,
}: {
  kind: DeckKind;
  onPick: (kind: DeckKind) => void;
  id: string;
}) {
  return (
    <div>
      <p id={`${id}-kind`} className="text-sm">
        Deck kind
      </p>
      <div
        role="group"
        // Named by the heading a reader can see rather than by an `aria-label` repeating it
        // — WCAG 2.5.3, and {@link SwitchButton}'s own rule two components down.
        aria-labelledby={`${id}-kind`}
        // The editor's variant group character for character, with one substitution: `w-fit`
        // where that one carries `shrink-0`. This is a block child of the panel's `space-y`
        // column rather than an item of a flex row, so `shrink-0` would be an inert class and
        // the box would stretch the full width of the column without something to size it to
        // its buttons.
        className="mt-1.5 flex w-fit overflow-hidden rounded-md border border-border"
      >
        {/* {@link DECK_KINDS}' order, which is an argument rather than an alphabet — the
            kind every deck is born as, then the one that adds a list, then the one that
            takes the collection away — so it is deliberately not put through
            `sortOptions`. The words are {@link DECK_KIND_LABEL}'s, spelled nowhere else,
            because `Theory + Actual` is also the gallery tile's badge and the two must not
            come to name one deck two ways. */}
        {DECK_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            // The pressed one stays pressable and nothing here is disabled — `aria-disabled`
            // included. A group of three toggles of which exactly one is on is what
            // `aria-pressed` says; pressing the kind the deck already is calls back with
            // that kind, and both hosts' writes are a no-op on a patch that changes nothing.
            aria-pressed={k === kind}
            onClick={() => onPick(k)}
            className={cn(
              "h-8 px-2.5 text-xs",
              "transition-colors duration-150 motion-reduce:transition-none",
              k === kind ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
              FOCUS,
            )}
          >
            {DECK_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {/* The **selected** kind's line and only it. Three sentences on screen at once would
          be a paragraph about a choice rather than the meaning of the one that has been
          made, and a reader who has pressed a button is asking what they just did.
          {@link DECK_KIND_HINT} is those words' one home, so no surface can come to
          describe a kind differently from this one. */}
      <p className="mt-1 text-[0.6875rem] leading-snug text-dim">{DECK_KIND_HINT[kind]}</p>
    </div>
  );
}

/**
 * Which of the live list's three theory marks this deck draws.
 *
 * **Drawn only for a deck {@link DeckKindGroup} is showing as `Theory + Actual`**, and indented
 * under it, because these four are one subject: a mark is the live list read *against* the
 * plan, so a deck with no plan has nothing for any of them to compare against. The gate is at
 * the call site rather than here, beside the control it depends on — and it is spelled
 * `value.theoryEnabled` rather than `deckKind(value) === "theory"`, for the reason written
 * there.
 *
 * **Three switches and not one picker**, which is `DeckRow.theoryMarkName`'s argument carried up
 * to the control and widened by the red tier (2026-09-08): a single ordered choice cannot spell
 * blue *without* green, and blue without green is a real answer — a reader who cares that the
 * card is there and not which printing it is. The red one makes the same point from the far end,
 * and it is the case that could not be spelled at all: **a reader may want the red alone**, a
 * proxy player who has no interest in which of their cards are the plan and every interest in
 * which are *not* it. All three off is a real answer too, and is not a second spelling of the
 * the kind above not being `Theory + Actual`.
 *
 * **The swatch is the point of the row's first line.** "Green", "blue" and "red" are the words,
 * and the colours are the reader's own — `useMarkColors` writes `--color-theory-exact`,
 * `--color-theory-name` and `--color-theory-unplanned` at the app root once they have chosen in
 * Settings — so a reader who has recoloured a mark and then comes here would be reading three
 * words about colours they no longer have. The swatch is what makes the sentence true again, and
 * it is drawn from the same property the mark on the card is filled from rather than from a copy
 * of the default.
 */
function TheoryMarkSwitches({
  exact,
  name,
  unplanned,
  onExact,
  onName,
  onUnplanned,
  id,
}: {
  exact: boolean;
  name: boolean;
  unplanned: boolean;
  onExact: (on: boolean) => void;
  onName: (on: boolean) => void;
  onUnplanned: (on: boolean) => void;
  id: string;
}) {
  return (
    // The rule is the indent: it says these belong to the switch above them, which two rows of
    // padding alone would leave to the reader to infer.
    <div className="ml-1 space-y-2.5 border-l border-border pl-3.5">
      <MarkSwitch
        id={`${id}-theory-mark-exact`}
        swatch="var(--color-theory-exact)"
        heading="Matching printing"
        caption="A green mark on a card that is the exact printing your plan names."
        on={exact}
        onChange={onExact}
      />
      <MarkSwitch
        id={`${id}-theory-mark-name`}
        swatch="var(--color-theory-name)"
        heading="Different printing"
        // The second sentence is the half a reader cannot see coming: turning the strict mark
        // off does not leave the card unmarked, it re-resolves the row one tier down. Unsaid, a
        // reader who switches green off and still sees marks reads the control as broken.
        caption="A blue mark on a card your plan asks for in a different printing. Turning the green one off draws this one instead."
        on={name}
        onChange={onName}
      />
      <MarkSwitch
        id={`${id}-theory-mark-unplanned`}
        swatch="var(--color-theory-unplanned)"
        heading="Not in the theory list"
        // The last sentence is what keeps this row from reading as a third printing tier: the two
        // above are statements about *which* printing, and this one is about the card not being
        // asked for at all — so nothing it says can be undone by choosing a different printing.
        caption="A red mark on a card your plan does not ask for at all — a stand-in, a spare or an experiment. It says nothing about the printing; the two marks above do."
        on={unplanned}
        onChange={onUnplanned}
      />
    </div>
  );
}

/** One mark's row: its colour, its name, what it means, and the switch that draws it or not. */
function MarkSwitch({
  id,
  swatch,
  heading,
  caption,
  on,
  onChange,
}: {
  id: string;
  /** The custom property the mark itself is filled from — a `var()`, never a hex, so the
   *  reader's own colour is what this sample shows. */
  swatch: string;
  heading: string;
  caption: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p id={id} className="flex items-center gap-1.5 text-sm">
          {/* `aria-hidden`, so the heading's accessible name is the words alone — the colour is
              already named in them, and a swatch cannot be read out. An inline style rather than
              an arbitrary Tailwind class for `TheoryMatchMark`'s two reasons: the property name
              has to be greppable, and a mistyped arbitrary value emits no rule at all. */}
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: swatch }}
          />
          {heading}
        </p>
        <p className="mt-0.5 text-[0.6875rem] leading-snug text-dim">{caption}</p>
      </div>
      <SwitchButton on={on} headingId={id} onChange={onChange} />
    </div>
  );
}

/**
 * The switch this panel draws three times — one for each of the live list's three theory marks.
 *
 * One definition rather than three copies, because three controls that look alike today are
 * three independent decisions that agree today: the deck editor has already paid for that with
 * two scrim darknesses and three panel heights.
 *
 * **It drew the theory list's own switch as a fourth until 2026-09-08**, when that question
 * stopped being a yes-or-no one and became {@link DeckKindGroup}. Nothing about this component
 * moved with it — a mark really is on or off — which is the whole of why the two shapes can sit
 * in one panel: a group answers *which of three*, a switch answers *whether*.
 *
 * **`aria-labelledby` naming the heading beside it *and* its own state word, in that order.**
 * Never `aria-label`, which would replace the visible "Enabled" with something that does not
 * contain it — the WCAG 2.5.3 failure a control labelled by its own text exists to avoid.
 */
function SwitchButton({
  on,
  /** The id of the heading this switch is about. Its own state word is `${headingId}-state`, so
   *  a caller spells one id rather than two that have to agree. */
  headingId,
  onChange,
}: {
  on: boolean;
  headingId: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={`${headingId} ${headingId}-state`}
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
      <span id={`${headingId}-state`}>{on ? "Enabled" : "Disabled"}</span>
    </button>
  );
}

/** Where the deck is filed, and the one control that can also un-file it. */
function FolderRow({
  folderId,
  paths,
  unread,
  loading,
  onMove,
  pending,
  id,
}: {
  folderId: number | null;
  paths: readonly { id: number; path: string }[];
  /** The folder list could not be read. The dropdown is no use without it, so it says so. */
  unread: string | null;
  loading: boolean;
  onMove: (folderId: number | null) => void;
  pending: boolean;
  id: string;
}) {
  const here = paths.find((f) => f.id === folderId);

  // Pinned above the folders, and the one row here that is not a folder: the top level
  // is where a deck goes when it is in none of them. `""` is that row's value, and it is a
  // real answer rather than a placeholder: filing a deck back at the root is
  // `deckSetFolder(id, null)` — the one thing `DeckPatch` cannot express, because
  // `coalesce(?n, folder_id)` reads a bound NULL as "leave it". At create there is no such
  // trap: `deck_create`'s INSERT takes `None` and means it. Everything under it is
  // `folderPaths`' alphabetical order, by the whole rendered path.
  const options: readonly DropdownOption[] = [
    { value: "", label: "Top level" },
    ...paths.map((f) => ({ value: String(f.id), label: f.path })),
  ];

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <label id={`${id}-folder-label`} htmlFor={`${id}-folder`} className="block text-sm">
          Folder
        </label>
        <p className="mt-0.5 truncate text-[0.6875rem] text-dim">
          {unread !== null
            ? `Could not read the folders — ${unread}`
            : folderId === null
              ? "Top level"
              : (here?.path ?? "In a folder this list does not carry")}
        </p>
      </div>
      <div className="w-44 shrink-0">
        <Dropdown
          id={`${id}-folder`}
          labelledBy={`${id}-folder-label`}
          value={folderId === null ? "" : String(folderId)}
          onChange={(v) => onMove(v === "" ? null : Number(v))}
          options={options}
          disabled={unread !== null || loading || pending}
          searchable
          size="sm"
          fill
        />
      </div>
    </div>
  );
}

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
 *
 * Exported because the **host** calls it: this form takes the paths already made, so that it
 * needs no folder query of its own.
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
