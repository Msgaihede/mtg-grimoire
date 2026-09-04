import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { QuantityStepper } from "@/components/QuantityStepper";
// The deck's own vocabulary for these two acts, drawn on a surface that is not a deck dialog.
// `metaRows` is the grammar of a name-and-submit row and `LabelColorPicker` is the app's only
// answer to "what colour is this label" — a second spelling of either here would be the drift
// both of those modules were extracted to prevent.
import { LabelColorButton, LabelColorPanel } from "@/features/decks/LabelColorPicker";
import { DEFAULT_LABEL_COLOR } from "@/features/decks/labelColors";
import { labelNameKey } from "@/features/decks/labelNames";
import { META_FIELD, META_SUBMIT } from "@/features/decks/metaRows";
import { FOCUS } from "@/lib/focus";
import type { CardDetail } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { CardModalScope } from "./cardModalScope";

/**
 * The word beside the stepper, and the stepper's own accessible name, per what it edits.
 *
 * **Two strings rather than one, and the pair is the point.** The visible word has one line of
 * a two-column grid to live in, so it is "Owned" — and a control announced as "Decrease Owned"
 * says nothing about *what* is owned, which `QuantityStepper`'s own doc forbids ("Quantity of
 * Lightning Bolt", not "Quantity"). The modal holds exactly one stepper and the dialog around it
 * is already named after the card, so this is belt and braces rather than the only signpost —
 * but a reader listing the modal's controls hears this one beside a category picker and forty
 * printing rows, and "Owned" alone would be the odd one out that named no object.
 */
const QUANTITY_LABEL: Record<
  NonNullable<CardModalScope["quantity"]>,
  { word: string; name: (cardName: string) => string }
> = {
  deck: { word: "In deck", name: (c) => `Copies of ${c} in this deck` },
  owned: { word: "Owned", name: (c) => `Copies of ${c} you own` },
  wished: { word: "Wished", name: (c) => `Copies of ${c} on your wishlist` },
};

/**
 * A control's height, and the whole of what the phone rung costs this column.
 *
 * 44px below `@min-[900px]/card` and the app's own 36px above it. The fold is spec §2.1's — the
 * *panel's* width, never the window's — and 44 is a touch target rather than a taste: at that
 * rung every one of these is a full-width row of its own, so there is height to spend and a
 * finger to spend it on.
 *
 * `h-11` is the row; `QuantityStepper` draws its own 36px buttons inside one and is not resized
 * to match, because that component's sizes are a fixed ladder (`xs`/`card`/`sm`/`md`) and a
 * fifth rung invented here would be a second opinion about how big a stepper is. What the row
 * buys instead is the space around it.
 */
const CONTROL_HEIGHT = "h-11 @min-[900px]/card:h-9";

/**
 * The label over a control — `text-xs uppercase` is the card pane's own heading scale, kept so
 * this column reads as one thing with the rail beside it.
 */
const FIELD_LABEL = "block text-xs uppercase tracking-wide text-dim";

/**
 * The value the `Create new…` row carries, and the whole of how a create is told from a pick.
 *
 * **It cannot collide.** Every other value in either picker is a row id spelled with `String(id)`,
 * plus the label picker's empty string for "no label" — so a value with brackets in it is not a
 * thing either list can produce.
 */
const NEW_VALUE = "__create__";

/** The quiet way out of the create row — `RenameField`'s cancel, at this file's own timing token
 *  rather than `metaRows`' literal, so it agrees with the action row one column over. */
const CREATE_CANCEL = cn(
  "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
  "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
  "motion-reduce:transition-none",
  FOCUS,
);

/** Which picker's create form is open, and the text the reader had typed when they opened it. */
type Creating = { kind: "category" | "label"; seed: string };

/** One labelled cell: a word, and the control it names under it. */
function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label id={id} htmlFor={`${id}-control`} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
    </div>
  );
}

export interface CardModalControlsProps {
  card: CardDetail;
  /** Spec §7's per-view table, resolved once by `useCardModalScope`. */
  scope: CardModalScope;
  /** How many printings this card has — drawn **inside** the button's name, see below. */
  printingCount: number;
  /**
   * Open the printings **wall** — `AllPrintingsDialog`.
   *
   * **It stays, and `CardModalPrintings` does not make it redundant** (2026-09-03). The inline
   * list beneath this column is a column of facts a reader reads down; the wall is a filtered
   * grid of *art*, at three or four times the width, with a set / language / treatment / finish
   * filter row this column has no room for. They answer two different questions about one card,
   * and the door to the second is here.
   */
  onViewAllPrintings: () => void;

  // ── Everything below is wiring Task 10 supplies. ────────────────────────────────────────
  // Each is optional with an inert default, and that is deliberate rather than lax: this
  // component has to render with no deck, no query client and no store in the tree, or its own
  // test could not exist. A control whose handler never arrived still draws — it is the same
  // control, reporting to nobody — because the alternative is a column whose *shape* depends on
  // how far a parent's queries have got, which is a layout that flickers as data lands.

  /** The count the stepper reports. Ignored entirely when `scope.quantity` is null. */
  quantity?: number;
  onQuantityChange?: (next: number) => void;
  /** The deck's categories. Drawn only when `scope.deckControls`. */
  categories?: readonly DropdownOption[];
  onPickCategory?: (categoryId: number) => void;
  /** Every label there is — one row wears at most one (`DeckCard.labelId`), so this is a single
   *  select rather than a `MultiDropdown`. */
  labels?: readonly DropdownOption[];
  /** The label the deck row wears, or `null` for none. */
  labelId?: number | null;
  onPickLabel?: (labelId: number | null) => void;

  /**
   * Make a pile that does not exist yet and file the card into it — `deck_category_create`, whose
   * rows are `origin: "user"` by construction.
   *
   * **Optional like every other handler here, and the row is absent rather than inert where it
   * is not wired**: a `Create new…` a reader can press and watch do nothing is worse than a
   * picker that only picks. Both creates are deck-only by construction, since the pickers
   * themselves are drawn on `scope.deckControls` alone.
   */
  onCreateCategory?: (name: string) => void;
  /**
   * Make a label and put it on the card — the name **and a colour**, because `deck_labels.color`
   * is NOT NULL and `deck_label_create` refuses a name with no colour rather than inventing one.
   * The colour comes from `labelColors.ts` through the Labels dialog's own picker; nothing here
   * writes a hex of its own.
   */
  onCreateLabel?: (name: string, color: string) => void;
}

/**
 * The card modal's controls: **Quantity**, `View all printings`, and — for a card opened out of
 * a deck — **Category** and **Label**, one to a row.
 *
 * **The `Printing` combobox was the third field and is gone** (2026-09-03). It was a picker over
 * every printing of the card, and it moved to `CardModalPrintings` — the list that now fills the
 * modal's main column — because a picker announces the printing you are *on* and hides the ones
 * you are choosing *between*, which is the comparison the control existed for. The write did not
 * move: `onPickPrinting` is `CardModalPrintings`' `onPick` and reaches the same host callback
 * with the same two meanings.
 *
 * **`View all printings (N)` did not go with it**, and that is a decision rather than a leftover.
 * The inline list is a column of facts read downwards; the wall behind that button is a filtered
 * grid of *art* at three or four times this column's width, with a set / language / treatment /
 * finish filter row there is no room for here. Two questions about one card, and only one of them
 * fits in a column.
 *
 * **Every branch in this file reads `scope` and nothing else.** The per-view table is spec §7's
 * and it is resolved once, in `cardModalScope.ts`, precisely so that the rail, the action row
 * and this column cannot answer it three different ways. Two fields decide everything here:
 * `scope.quantity` says which count the stepper edits (or that there is none to edit), and
 * `scope.deckControls` gates the category and label pickers **together** — they are one fact about
 * one row, and a surface that can file a card into a pile can also label it.
 *
 * What is *not* drawn is absent rather than disabled. A greyed stepper on the search wall would
 * be a claim that the wall keeps a count, which it does not; `Add to collection` in the action
 * row is how a card becomes something with a count, and that is the door every other surface in
 * the app already uses.
 *
 * **This writes nothing.** Category, label and quantity call props; Task 10 connects them to
 * `useDeck`. Keeping the writes out is what lets this render with no deck in the tree.
 */
export function CardModalControls({
  card,
  scope,
  printingCount,
  onViewAllPrintings,
  quantity = 0,
  onQuantityChange,
  categories = [],
  onPickCategory,
  labels = [],
  labelId = null,
  onPickLabel,
  onCreateCategory,
  onCreateLabel,
}: CardModalControlsProps) {
  const uid = useId();
  const stepper = scope.quantity === null ? null : QUANTITY_LABEL[scope.quantity];
  /** At most one create form at a time — there is one column to draw it in, and a reader naming
   *  two things at once is not a thing to design for. */
  const [creating, setCreating] = useState<Creating | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {stepper !== null && (
        <div className="flex min-w-0 flex-col gap-1">
          {/* A plain word rather than a `<label htmlFor>`: `QuantityStepper` owns the id of
              the field inside it and exposes none, and a `<label>` *wrapping* the control
              would forward a press on `−` or `+` to the number box instead of stepping.
              The control carries its own `aria-label`, so nothing is unnamed. */}
          <span className={FIELD_LABEL}>{stepper.word}</span>
          <div className={cn("flex items-center", CONTROL_HEIGHT)}>
            <QuantityStepper
              value={quantity}
              onChange={(next) => onQuantityChange?.(next)}
              label={stepper.name(card.name)}
              // Every row in this column spans it — see the button below and the two pickers,
              // which have always taken `fill`. This is the one control that had to be taught.
              fill
            />
          </div>
        </div>
      )}

      {/* **The door to the printings wall, and it is a row of its own now.**
          It shared a line with the `Printing` combobox until 2026-09-03, inside a `Field`
          labelled `Printing`; the combobox moved to `CardModalPrintings` and the label went with
          it, because a `<label htmlFor>` pointing at a control that is no longer rendered is a
          dangling association rather than a heading. The geometry and the one-text-node name are
          untouched; only the colour changed. */}
      <div className="flex min-w-0">
        <button
          type="button"
          onClick={onViewAllPrintings}
          className={cn(
            // `w-full` and not `shrink-0`: this is a row of the column like every other, and a
            // button sized to its own words left a ragged edge beside four boxes that fill.
            // `truncate` because the name carries a count that can reach four digits.
            "w-full truncate rounded-md border px-3 text-xs",
            // **Accent outline and accent text, which is `FilterChips`' recipe for a pressed
            // chip** — `border-accent text-accent`, the app's one spelling of "this control is
            // lit". It was `border-border text-dim`, the same recipe every settled value in this
            // column wears, and that is what made it disappear: the column is four boxes a
            // reader looks *at*, and this is the one that opens something. The accent is what
            // this app already uses to mark a thing that acts rather than reports.
            //
            // **It does not become a primary button.** `ACTION`'s filled treatment belongs to
            // the footer's row, where the panel's real writes live; a second filled control up
            // here would compete with `Add to deck` for the same claim. An outline says
            // *pressable* without saying *press this one*.
            "border-accent text-accent",
            // The hover cannot go on saying `hover:text-text` — that reads as the accent draining
            // out of the control the moment the pointer arrives, which is backwards. Brightening
            // the outline is the same move `RAIL_ENTRY` makes one column over.
            "hover:border-accent hover:bg-accent/10",
            CONTROL_HEIGHT,
            PRESS,
            FOCUS,
          )}
        >
          {/* **One text node, count included.** A label and its count in two sibling spans
              separated by a CSS `gap` compute to "View all printings4" — the gap is not a
              word separator, and the accessible name is what a test and a screen reader
              both read. This has cost this repo a round before. */}
          {`View all printings (${printingCount})`}
        </button>
      </div>

      {/* **Category and Label, one to a row.** They sat side by side above `@min-[900px]/card`
          until the main area became two columns: the controls are a 15rem column now, and two
          pickers sharing 15rem gave each about 110px of trigger — a width where every category
          name a reader has is an ellipsis. One per row is the same stack the phone rung always
          drew, applied at every rung because the column is narrow at all of them now. */}
      {scope.deckControls && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3">
            {/* **`Category`, not `Deck category`.** The modal is already about a card in a deck
                — the pickers are drawn on `scope.deckControls` and on nothing else — so the
                qualifier named the surface the reader is standing on. It also cost a third of
                the label's width to a word that adds nothing, in a column where the pickers
                below it truncate. */}
            <Field id={`${uid}-category`} label="Category">
              <CreatablePicker
                id={`${uid}-category-control`}
                labelledBy={`${uid}-category`}
                // `scope.deck` is non-null whenever `deckControls` is — they are set together in
                // `cardModalScope.ts` — but the optional chain is kept rather than asserted,
                // because a `!` here would be a claim about a *different* file's invariant.
                value={scope.deck === null ? "" : String(scope.deck.categoryId)}
                onChange={(v) => onPickCategory?.(Number(v))}
                options={categories}
                placeholder={scope.deck?.categoryName ?? "—"}
                // The mockup draws a search field inside this popup, and `Dropdown` supports one
                // (`searchable`) — so it is the shell's box rather than one grown here. A deck can
                // hold dozens of piles once the auto categories have filed a few hundred cards.
                searchLabel="Search categories"
                onCreate={
                  onCreateCategory === undefined
                    ? undefined
                    : (seed) => setCreating({ kind: "category", seed })
                }
              />
            </Field>

            <Field id={`${uid}-label`} label="Label">
              <CreatablePicker
                id={`${uid}-label-control`}
                labelledBy={`${uid}-label`}
                // A row wears at most one label and `null` is a real answer, so the empty string
                // is the value that means "none" — `Dropdown` speaks strings and has no null.
                value={labelId === null ? "" : String(labelId)}
                onChange={(v) => onPickLabel?.(v === "" ? null : Number(v))}
                options={labels}
                placeholder="No label"
                // App-wide since schema v21, so the list is every label the reader has ever made
                // rather than this deck's — which is exactly the list that needs a search box.
                searchLabel="Search labels"
                onCreate={
                  onCreateLabel === undefined
                    ? undefined
                    : (seed) => setCreating({ kind: "label", seed })
                }
              />
            </Field>
          </div>

          {/* **Under the pickers rather than inside the popup, and that is a measurement rather
              than a taste.** `usePopupPlacement` measures the panel *once*, on the frame it
              mounts — a footer that grew after that would leave the popup placed for the box it
              used to be, and nothing clips these panels, so an overgrown one scrolls the whole
              app sideways. The row also has a colour picker in it at the label rung, which is
              not a thing that fits on a line inside a `max-h-64` list.

              Keyed on what it is naming, so switching from one create to the other re-seeds the
              field and puts the caret back in it — React's own answer for per-subject state, and
              the one this repo allows (`src/CLAUDE.md` forbids a `setState` in an effect). */}
          {creating !== null && (
            <CreateRow
              key={`${creating.kind}:${creating.seed}`}
              kind={creating.kind}
              seed={creating.seed}
              existing={creating.kind === "category" ? categories : labels}
              onCreate={(name, color) => {
                setCreating(null);
                if (creating.kind === "category") onCreateCategory?.(name);
                else onCreateLabel?.(name, color);
              }}
              onUse={(value) => {
                setCreating(null);
                if (creating.kind === "category") onPickCategory?.(Number(value));
                else onPickLabel?.(value === "" ? null : Number(value));
              }}
              onCancel={() => setCreating(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A `<Dropdown>` with one extra row at the end of its list: **Create new…**
 *
 * ## Why the row is always there
 *
 * The alternative — reveal it only when the typed text matches nothing — is the shape that reads
 * as clever and behaves as a surprise: the control a reader is reaching for appears and vanishes
 * as they type, and a reader who wants a *second* pile called something close to one they already
 * have (`Removal`, `Removal — sweepers`) can never reach it at all, because their text matches. A
 * row that is always last is a row that can be learnt.
 *
 * ## Why the search is controlled here
 *
 * `<Dropdown>` filters an **uncontrolled** `searchable` list by label substring — which would eat
 * the create row on exactly the query that needs it most, the one matching nothing. So this
 * supplies `query`/`onQueryChange` and does the filtering itself: the same case-insensitive
 * substring test the shell would have made, applied to the caller's options and to nothing else.
 * `onOpen` clears the box, because the shell's own reset is skipped for a controlled caller
 * (deliberately — it owns `query`) and a reader who typed, closed and reopened must not meet a
 * pre-filtered list.
 *
 * **The typed text travels with the press.** A reader who types `Ramp`, finds nothing and presses
 * the row has already said what they want to call it, and asking again in the next field would be
 * the app not listening. Empty text seeds an empty field, which is the plain "make me a new one".
 */
function CreatablePicker({
  id,
  labelledBy,
  value,
  onChange,
  options,
  placeholder,
  searchLabel,
  onCreate,
}: {
  id: string;
  labelledBy: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly DropdownOption[];
  placeholder: string;
  searchLabel: string;
  /** `undefined` where the host wired no create — the row is then absent rather than inert. */
  onCreate?: (seed: string) => void;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim();

  const drawn = useMemo(() => {
    const needle = typed.toLowerCase();
    const matched =
      needle === "" ? options : options.filter((o) => o.label.toLowerCase().includes(needle));
    if (onCreate === undefined) return matched;
    // The typed words in the row itself, so the press says what it is about to make.
    const label = typed === "" ? "Create new…" : `Create “${typed}”…`;
    return [...matched, { value: NEW_VALUE, label }];
  }, [options, typed, onCreate]);

  return (
    <Dropdown
      id={id}
      labelledBy={labelledBy}
      value={value}
      onChange={(v) => (v === NEW_VALUE ? onCreate?.(typed) : onChange(v))}
      options={drawn}
      placeholder={placeholder}
      searchable
      searchLabel={searchLabel}
      query={query}
      onQueryChange={setQuery}
      onOpen={() => setQuery("")}
      fill
      className={CONTROL_HEIGHT}
    />
  );
}

/**
 * The name — and, for a label, the colour — of the thing about to be made.
 *
 * **A row in the column, not a dialog.** A nested `Dialog` would need `layer="stacked"`, a second
 * focus trap and a second Escape rung inside one that is already `"inner"`, all to ask for one
 * word; and the word is being typed on the surface the answer appears on, which is the naming
 * grammar the folder wall settled on for the same reason. Escape is left to the modal around it,
 * which is `RenameField`'s decision verbatim: a second rung inside an `"inner"` layer is the case
 * `useDismissOnEscape` explicitly does not order.
 *
 * **The duplicate check is a courtesy and behaves like one.** `labelNameKey` normalises exactly
 * as Rust's `label_name_key` does, and the `UNIQUE INDEX` behind it is the actual fence — two
 * windows racing one name is what an index is for. What this buys is that a reader who types a
 * name they already have is handed *that row* instead of a round trip and a refusal: the submit
 * changes its word to `Use “…”`, and picking it is all the press then does. The same test serves
 * the category picker, where the grain is `(deckId, name)` and `deck_category_create` refuses a
 * duplicate the same way.
 *
 * The colour is behind one press rather than open, unlike `AddLabelDialog`'s panel: this row
 * lives in a column beside a card and a wheel with a hex field is not a thing that fits on it at
 * rest. {@link DEFAULT_LABEL_COLOR} is what it opens on — `labelColors.ts`' own answer for a new
 * label, never a hex chosen here.
 */
function CreateRow({
  kind,
  seed,
  existing,
  onCreate,
  onUse,
  onCancel,
}: {
  kind: "category" | "label";
  seed: string;
  /** The picker's own rows, for the duplicate courtesy — the list the reader can already see. */
  existing: readonly DropdownOption[];
  onCreate: (name: string, color: string) => void;
  /** The name is one the reader already has: use that row instead of making a second. */
  onUse: (value: string) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(seed);
  const [color, setColor] = useState(DEFAULT_LABEL_COLOR.hex);
  const [palette, setPalette] = useState(false);

  // **Both calls, in this order**, which is `RenameField`'s note and the same trap: per spec
  // `select()` only sets a selection, and jsdom implements the spec where Chromium focuses
  // anyway — so a missing `focus()` looks sufficient in the shipped window and fails in the
  // suite. The caret belongs here because the reader has just pressed a row that says the next
  // thing they do is type a name.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = name.trim();
  const clash = useMemo(() => {
    const key = labelNameKey(trimmed);
    if (key === "") return undefined;
    // The empty value is the label picker's "No label", which is a row rather than a label and
    // can never be the thing a reader is naming.
    return existing.find((o) => o.value !== "" && labelNameKey(o.label) === key);
  }, [existing, trimmed]);

  const word = kind === "label" ? "label" : "category";
  // One text node in every arm: a `gap` is not a word separator to the accessible-name
  // computation, so a name split across two spans reads as one run-on word.
  const submitWord =
    clash !== undefined
      ? `Use “${clash.label}”`
      : trimmed === ""
        ? "Create"
        : `Create “${trimmed}”`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (clash !== undefined) {
          onUse(clash.value);
          return;
        }
        if (trimmed === "") return;
        onCreate(trimmed, color);
      }}
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
    >
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
        <label htmlFor={`${uid}-name`} className={FIELD_LABEL}>
          {kind === "label" ? "New label" : "New category"}
        </label>
        <input
          ref={inputRef}
          id={`${uid}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Name this ${word}…`}
          className={cn(META_FIELD, "w-full flex-none")}
        />
      </div>

      {kind === "label" && (
        <LabelColorButton color={color} open={palette} onToggle={() => setPalette((o) => !o)} />
      )}

      <button type="submit" disabled={trimmed === ""} className={META_SUBMIT}>
        {submitWord}
      </button>
      <button type="button" onClick={onCancel} className={CREATE_CANCEL}>
        Cancel
      </button>

      {/* `basis-full` rather than a second row of markup: the picker is at most half this column
          wide above the 900 fold, and a colour wheel on that line would push the submit out of
          reach. */}
      {kind === "label" && palette && (
        <div className="basis-full">
          <LabelColorPanel value={color} onChange={setColor} />
        </div>
      )}

      {clash !== undefined && (
        <p role="status" className="basis-full text-[0.6875rem] text-dim">
          “{clash.label}” already exists — this uses it.
        </p>
      )}
    </form>
  );
}
