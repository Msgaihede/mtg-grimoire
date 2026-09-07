import type { JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import type { DeckCategory, DeckFolder, DeckGame } from "@/lib/ipc";
import { compareLabels } from "@/lib/options";
import { cn } from "@/lib/utils";
import { AUTO_CATEGORY, AUTO_CATEGORY_LABEL } from "./autoCategory";
import { DeckCoverPicker, type DeckCoverPickerProps } from "./DeckCoverPicker";
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
  theoryEnabled: boolean;
  /**
   * Whether this deck draws the **green** theory mark — a live row that is the printing the plan
   * named. See `theoryMatch.ts` for what "off" does, which is not "nothing": an exact row on a
   * deck with this off draws the blue mark instead.
   */
  theoryMarkExact: boolean;
  /** Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   *  not name. */
  theoryMarkName: boolean;
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
 * | Game, Format, Theory deck, Folder, the cover | on the one act that settles them | never |
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
 * | `DeckSettingsDialog` (edit) | `onChange` for game, format, theory, folder and the cover; `onCommit` for the three text fields — which is today's behaviour exactly, one write per control as it settles |
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
          <TheorySwitch
            on={value.theoryEnabled}
            onChange={(theoryEnabled) => onChange({ theoryEnabled })}
            id={idPrefix}
          />
          {/* **Only while there is a plan**, which is the gate rather than a greyed pair. Both
              marks are drawn by comparing the live list against the theory list, so on a deck
              with no theory list there is nothing for either to compare against — a switch there
              would change what is on screen not at all, and nothing on screen would say why. */}
          {value.theoryEnabled && (
            <TheoryMarkSwitches
              exact={value.theoryMarkExact}
              name={value.theoryMarkName}
              onExact={(theoryMarkExact) => onChange({ theoryMarkExact })}
              onName={(theoryMarkName) => onChange({ theoryMarkName })}
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
          and starts the actual list empty; turning it off hides the Theory/Actual switch and the
          difference list and keeps every row.
        </p>
      </div>
      <SwitchButton on={on} headingId={`${id}-theory`} onChange={onChange} />
    </div>
  );
}

/**
 * Which of the live list's two theory marks this deck draws.
 *
 * **Drawn only under a switched-on {@link TheorySwitch}**, and indented under it, because these
 * three are one subject: a mark is the live list read *against* the plan, so a deck with no plan
 * has nothing for either of them to compare against. The gate is at the call site rather than
 * here, beside the switch it depends on.
 *
 * **Two switches and not one three-way picker**, which is `DeckRow.theoryMarkName`'s argument
 * carried up to the control: `none | exact | both` cannot spell blue *without* green, and blue
 * without green is a real answer — a reader who cares that the card is there and not which
 * printing it is. Both off is a real answer too, and is not a second spelling of the theory
 * switch above being off.
 *
 * **The swatch is the point of the row's first line.** "Green" and "blue" are the words, and the
 * colours are the reader's own — `useMarkColors` writes `--color-theory-exact` and
 * `--color-theory-name` at the app root once they have chosen in Settings — so a reader who has
 * recoloured a mark and then comes here would be reading two words about colours they no longer
 * have. The swatch is what makes the sentence true again, and it is drawn from the same property
 * the mark on the card is filled from rather than from a copy of the default.
 */
function TheoryMarkSwitches({
  exact,
  name,
  onExact,
  onName,
  id,
}: {
  exact: boolean;
  name: boolean;
  onExact: (on: boolean) => void;
  onName: (on: boolean) => void;
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
 * The switch this panel draws three times — the theory list, and each of its two marks.
 *
 * One definition rather than three copies, because three controls that look alike today are
 * three independent decisions that agree today: the deck editor has already paid for that with
 * two scrim darknesses and three panel heights.
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
