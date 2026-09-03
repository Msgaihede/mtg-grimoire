import { useId, type ReactNode } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { QuantityStepper } from "@/components/QuantityStepper";
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
 * but a reader listing the modal's controls hears this one beside a printing picker and a
 * category picker, and "Owned" alone would be the odd one out that named no object.
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
  onViewAllPrintings: () => void;

  // ── Everything below is wiring Task 10 supplies. ────────────────────────────────────────
  // Each is optional with an inert default, and that is deliberate rather than lax: this
  // component has to render with no deck, no query client and no store in the tree, or its own
  // test could not exist. A control whose handler never arrived still draws — it is the same
  // control, reporting to nobody — because the alternative is a column whose *shape* depends on
  // how far a parent's queries have got, which is a layout that flickers as data lands.

  /** The card's printings, in the shape `Dropdown` draws. Empty until that query answers. */
  printings?: readonly DropdownOption[];
  onPickPrinting?: (printingId: string) => void;
  /** The count the stepper reports. Ignored entirely when `scope.quantity` is null. */
  quantity?: number;
  onQuantityChange?: (next: number) => void;
  /** The deck's categories. Drawn only when `scope.deckControls`. */
  categories?: readonly DropdownOption[];
  onPickCategory?: (categoryId: number) => void;
  /** Every tag there is — one row wears at most one (`DeckCard.tagId`), so this is a single
   *  select rather than a `MultiDropdown`. */
  tags?: readonly DropdownOption[];
  /** The tag the deck row wears, or `null` for none. */
  tagId?: number | null;
  onPickTag?: (tagId: number | null) => void;
}

/**
 * The card modal's centre column: **Quantity**, **Printing**, and — for a card opened out of a
 * deck — **Deck category** and **Tag**.
 *
 * **Every branch in this file reads `scope` and nothing else.** The per-view table is spec §7's
 * and it is resolved once, in `cardModalScope.ts`, precisely so that the rail, the action row
 * and this column cannot answer it three different ways. Two fields decide everything here:
 * `scope.quantity` says which count the stepper edits (or that there is none to edit), and
 * `scope.deckControls` gates the category and tag pickers **together** — they are one fact about
 * one row, and a surface that can file a card into a pile can also tag it.
 *
 * What is *not* drawn is absent rather than disabled. A greyed stepper on the search wall would
 * be a claim that the wall keeps a count, which it does not; `Add to collection` in the action
 * row is how a card becomes something with a count, and that is the door every other surface in
 * the app already uses.
 *
 * **This writes nothing.** Category, tag and quantity call props; Task 10 connects them to
 * `useDeck`. Keeping the writes out is what lets this render with no deck in the tree.
 */
export function CardModalControls({
  card,
  scope,
  printingCount,
  onViewAllPrintings,
  printings = [],
  onPickPrinting,
  quantity = 0,
  onQuantityChange,
  categories = [],
  onPickCategory,
  tags = [],
  tagId = null,
  onPickTag,
}: CardModalControlsProps) {
  const uid = useId();
  const stepper = scope.quantity === null ? null : QUANTITY_LABEL[scope.quantity];

  return (
    <div className="flex flex-col gap-4">
      {/* Quantity and Printing share one row at the widest rungs and stack below.
          `auto 1fr` — the stepper is the fixed thing (three controls of a size it chose) and
          the printing picker is the elastic one, because a set name is what has to truncate.
          Two whole class strings rather than one built by interpolation: Tailwind scans source
          text, and a class assembled at runtime emits no rule at all.

          With no stepper the row is one cell, and it must say so: left at
          `grid-cols-[auto_1fr]` a lone picker would sit in the `auto` track and draw at its own
          content width, which on the search wall is most of this column left blank. */}
      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          stepper === null
            ? "@min-[900px]/card:grid-cols-1"
            : "@min-[900px]/card:grid-cols-[auto_1fr]",
        )}
      >
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
              />
            </div>
          </div>
        )}

        <Field id={`${uid}-printing`} label="Printing">
          <div className="flex min-w-0 items-center gap-2">
            <Dropdown
              id={`${uid}-printing-control`}
              labelledBy={`${uid}-printing`}
              // The open card *is* the picked printing, so the trigger reads the set this copy
              // is from. `printings` is empty until the query answers, and the placeholder is
              // what the trigger says meanwhile — never the card's name, which would make a
              // control whose whole job is to say *which* Lightning Bolt say "Lightning Bolt".
              value={card.id}
              onChange={(v) => onPickPrinting?.(v)}
              options={printings}
              placeholder={card.setName ?? card.setCode.toUpperCase()}
              searchable
              searchLabel="Search printings"
              fill
              className={cn("min-w-0 flex-1", CONTROL_HEIGHT)}
            />
            <button
              type="button"
              onClick={onViewAllPrintings}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md border border-border px-3 text-xs text-dim",
                "hover:text-text",
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
        </Field>
      </div>

      {/* Deck category and Tag, side by side above the fold and stacked below it.
          `grid-cols-2` rather than the spec's literal `repeat(2,1fr)`: Tailwind's spelling is
          `repeat(2, minmax(0, 1fr))`, and the `minmax(0,` is what lets a long category name
          truncate instead of pushing the tag picker out of the column. */}
      {scope.deckControls && (
        <div className="grid grid-cols-1 gap-3 @min-[900px]/card:grid-cols-2">
          <Field id={`${uid}-category`} label="Deck category">
            <Dropdown
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
              searchable
              searchLabel="Search categories"
              fill
              className={CONTROL_HEIGHT}
            />
          </Field>

          <Field id={`${uid}-tag`} label="Tag">
            <Dropdown
              id={`${uid}-tag-control`}
              labelledBy={`${uid}-tag`}
              // A row wears at most one tag and `null` is a real answer, so the empty string is
              // the value that means "none" — `Dropdown` speaks strings and has no null.
              value={tagId === null ? "" : String(tagId)}
              onChange={(v) => onPickTag?.(v === "" ? null : Number(v))}
              options={tags}
              placeholder="No tag"
              // App-wide since schema v21, so the list is every tag the reader has ever made
              // rather than this deck's — which is exactly the list that needs a search box.
              searchable
              searchLabel="Search tags"
              fill
              className={CONTROL_HEIGHT}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
