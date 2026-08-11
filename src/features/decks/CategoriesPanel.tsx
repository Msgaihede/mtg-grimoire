/**
 * The deck's piles and its labels, as things in themselves — a right-hand drawer over the
 * editor.
 *
 * Everywhere else in the app a category is a *heading*: a column the cards live under. This is
 * the one surface where the pile itself is the subject — what it is called, what order the
 * columns come in, whether it counts, and whether it should exist at all. The tags below it are
 * the same idea one floor down: a label is a thing a reader made, and this is where it is made,
 * renamed and taken away.
 *
 * ## The three rules the drawer has to say out loud
 *
 * None of them is guessable from the controls, so each is printed beside the controls it
 * governs rather than left to a tooltip:
 *
 * 1. **Only active categories count toward the deck.** The switch is the whole of "counts
 *    toward nothing" ({@link DeckCategory.isActive}) — size, copy limits, legality, and the
 *    allocator's claims all read it.
 * 2. **The four categories every deck starts with can be switched off but not renamed or
 *    deleted.** That is a backend refusal (`deck_category_rename`/`deck_category_delete`), and
 *    it is why those rows carry no Rename and no Delete rather than two greyed-out controls.
 * 3. **Tags belong to this deck; the suggestions come from every deck.** `deck_tag_suggestions`
 *    is the one command in the deck surface that takes no deck id at all.
 *
 * ## What this deliberately does not decide
 *
 * The `RULE` marker. `views/GroupHeader.tsx` owns it, and this file renders that component for
 * every row rather than drawing its own name-and-counts line — so the drawer cannot be the
 * surface where `RULE` starts meaning something different from what a column heading means by
 * it. (It is *not* "predefined and undeletable": the Maybeboard is predefined and carries
 * `INACTIVE` instead, and a switched-off Sideboard carries both.) There is no format branch
 * anywhere in here, and there must never be one: a deck's rules role is `kind`, which the
 * backend seeds, and every question this panel asks about a category is answered by `kind`,
 * `isActive` or the name.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from "react";
import { GripVertical, X } from "lucide-react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { ToggleChip } from "@/components/FilterChips";
import {
  ipcError,
  type DeckCard,
  type DeckCategory,
  type DeckTag,
  type DeckVariant,
  type TagColor,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { PREDEFINED_CATEGORY_NAMES } from "./autoCategory";
import { FOCUS, FOCUS_INSET } from "./cardControl";
import type { CardGroup } from "./grouping";
import { DEFAULT_TAG_COLOR, TAG_COLORS, tagColorCss } from "./tagColors";
import { useDeck } from "./useDeck";
import { useDeckMeta, type DeckMeta } from "./useDeckMeta";
import { GroupHeader } from "./views/GroupHeader";

/* ------------------------------------------------------------------ reordering ------- */

/**
 * The mark that says a drag is *this* drawer reordering its own list, and nothing else.
 *
 * A key of its own rather than `dnd.ts`'s, because the two carry different things and must not
 * be mistaken for each other: that one carries a **card** between categories, this one carries
 * a **category** past its neighbours. `readDragData` refuses anything without its own mark, so
 * a category picked up here can never be dropped into a zone column, and a card dragged from
 * the search wall can never land on a row in this drawer.
 */
const CATEGORY_MARK = "mtg-grimoire/category-order";

function categoryDragData(id: number): Record<string, unknown> {
  return { [CATEGORY_MARK]: true, categoryId: id };
}

/** The category a drag is carrying, or `null` for every other drag in the window. Field by
 *  field, like `dnd.ts`'s reader: the library's store is untyped by construction. */
function readCategoryDrag(data: Record<string, unknown>): number | null {
  if (data[CATEGORY_MARK] !== true) return null;
  const id = data.categoryId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * One id moved to one position — the whole of what a reorder is, as a pure function.
 *
 * `deck_category_reorder` takes **every** id and writes `sortOrder` from position, so a move is
 * expressed as the list it produces rather than as a from/to pair. Total: an id the list does
 * not hold, and a position off either end, both answer a copy of the list they were given
 * rather than throwing — a reorder that raced a delete still lands somewhere sensible.
 */
export function movedTo(ids: readonly number[], id: number, to: number): number[] {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from < 0) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (from === target) return next;
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

/* ----------------------------------------------------------------------- shell ------- */

export interface CategoriesPanelProps {
  deckId: number;
  /** Scopes every count and every price on screen, and nothing else: which categories a deck
   *  has is a fact about the deck rather than about one of its two lists. */
  variant: DeckVariant;
  open: boolean;
  /** Escape, and the ✕: hand focus back to whatever opened the panel, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * `null` when closed, and the drawer is a separate component for that reason: the queries and
 * the Escape registration belong to a panel that is *up*, and a hook cannot be skipped. A
 * closed drawer therefore costs nothing at all — no `deck_category_list`, no `deck_tag_list`,
 * no window listener — which is what makes it safe for the editor to mount this unconditionally.
 */
export function CategoriesPanel(props: CategoriesPanelProps): JSX.Element | null {
  if (!props.open) return null;
  return <Drawer {...props} />;
}

function Drawer({ deckId, variant, onDismiss, onClose }: CategoriesPanelProps) {
  const meta = useDeckMeta(deckId, variant);
  // The deck's own rows, for one control: `autoCategorise` reads type lines, so it is handed
  // cards rather than ids. Free in the app — the editor behind this drawer is already holding
  // `["decks", "detail", deckId, variant]`, and this is that same query.
  const { cards } = useDeck(deckId, variant);

  const panelRef = useRef<HTMLDivElement>(null);

  // The `"inner"` rung: capture phase, `preventDefault()`, so one press closes this and leaves
  // the card pane behind the view holding its own. See `useDismissOnEscape`'s header — the
  // protocol orders exactly two rungs, so nothing else `"inner"` may be open beside this.
  useDismissOnEscape({ layer: "inner", onDismiss });

  // The caret moves into the layer, as it does for every other one in the app: the drawer's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      // The scrim. A press that lands on it and not on the drawer is the reader leaving:
      // `onClose`, which closes without yanking the caret back — the outside-click half of the
      // Escape contract, and deliberately not the same answer as the ✕.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "fixed inset-0 flex justify-end bg-black/60",
        // `dragTray`'s number rather than `popup`'s, and the name is the awkward half: this is
        // a full-window layer that has to cover every anchored popup in the editor behind it,
        // and `popup` would *tie* with them — equal z-indexes resolve by document order, and
        // where the editor mounts this drawer is the editor's choice, not this file's. The two
        // never contend for the rung itself: the tray is drawn only during a card drag, and no
        // card drag can be in flight while this is up.
        LAYER.dragTray,
      )}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Categories and tags"
        // Not `aria-modal`, and not portalled: the shipped CSP is `style-src 'self'` and every
        // overlay primitive in reach injects a runtime `<style>` the moment it opens
        // (`SetCombobox`'s decision, for its reason).
        className={cn(
          "flex h-full w-[35rem] max-w-full flex-col border-l border-border bg-bg shadow-2xl",
          // The outline goes *inside*: the drawer is flush against the window's right edge, so
          // an outline standing 2px off it is painted off-screen — `FOCUS_INSET`'s whole case.
          FOCUS_INSET,
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="font-heading text-xl leading-none">Categories &amp; tags</h2>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close categories and tags"
            className={cn(
              "ml-auto rounded-md p-1 text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-6 pt-4">
          <Categories meta={meta} cards={cards} />
          <Tags meta={meta} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ categories ------- */

/** No cards are drawn here, so every row's group is built with none — its counts come off the
 *  category row itself, which is what `deck_category_list` exists to answer. */
const NO_CARDS: never[] = [];

/**
 * A category as the group that *is* it, so `GroupHeader` draws this row's name, its markers and
 * its two numbers exactly as a column heading draws them.
 *
 * `isPredefined` is `grouping.ts`'s own expression, by kind **and** by name: a user is free to
 * call a pile of their own "Sideboard" — the grain allows it, because the predefined Sideboard
 * was never named by the user — and that one is theirs to rename and delete like any other.
 */
function groupOf(category: DeckCategory): CardGroup {
  return {
    key: `cat-${category.id}`,
    name: category.name,
    kind: category.kind,
    categoryId: category.id,
    isActive: category.isActive,
    isPredefined:
      category.kind !== "main" && PREDEFINED_CATEGORY_NAMES.includes(category.name),
    cards: NO_CARDS,
    count: category.cardCount,
    totalPriceUsd: category.totalPriceUsd,
  };
}

function Categories({ meta, cards }: { meta: DeckMeta; cards: readonly DeckCard[] }) {
  const { categories, categoriesQuery, reorderCategories } = meta;
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  /**
   * The order on screen while the write is in flight.
   *
   * A reorder is one round trip and a re-read, and a list that only moved after the answer came
   * back would make the arrow keys feel broken. So the move lands here first and the mutation
   * follows. It is dropped the moment it stops describing the same set of rows — a category
   * created or deleted anywhere rebuilds from the server's order — and on a refusal, which is
   * the case that matters: a lie about what the deck's columns look like must not outlive the
   * write that failed.
   */
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const ordered = useMemo(() => {
    if (localOrder === null) return categories;
    const byId = new Map(categories.map((c) => [c.id, c]));
    const picked = localOrder.flatMap((id) => {
      const found = byId.get(id);
      return found ? [found] : [];
    });
    return picked.length === categories.length ? picked : categories;
  }, [categories, localOrder]);

  const move = useCallback(
    (id: number, to: number) => {
      const ids = movedTo(
        ordered.map((c) => c.id),
        id,
        to,
      );
      setLocalOrder(ids);
      reorderCategories.mutate(ids, { onError: () => setLocalOrder(null) });
    },
    [ordered, reorderCategories],
  );

  const add = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    meta.createCategory.mutate(trimmed, { onSuccess: () => setName("") });
  };

  const failure = firstFailure(
    meta.createCategory.error,
    meta.renameCategory.error,
    meta.setCategoryActive.error,
    meta.reorderCategories.error,
    meta.deleteCategory.error,
    categoriesQuery.error,
  );

  return (
    <section aria-labelledby="deck-categories-heading">
      <h3 id="deck-categories-heading" className="text-[0.8125rem] font-medium">
        Categories
      </h3>
      <p className="mb-2.5 mt-1 text-[0.6875rem] leading-relaxed text-dim">
        Only active categories count toward the deck — a switched-off pile counts toward no size,
        no copy limit and no legality check, and reserves no copy from your collection. Drag a row
        by its handle to reorder, or press the up and down arrow keys on it. The four categories
        every deck starts with can be switched off, but not renamed or deleted.
      </p>

      {categoriesQuery.isPending ? (
        <p className="text-xs text-dim">Reading this deck’s categories…</p>
      ) : ordered.length === 0 ? (
        <p className="text-xs text-dim">This deck has no categories.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {ordered.map((category, index) => (
            <CategoryRow
              key={category.id}
              category={category}
              index={index}
              total={ordered.length}
              meta={meta}
              onMove={move}
              renaming={renaming === category.id}
              onRename={() => setRenaming(category.id)}
              confirming={confirming === category.id}
              onConfirm={() => setConfirming(category.id)}
              onDone={() => {
                setRenaming(null);
                setConfirming(null);
              }}
              others={ordered.filter((c) => c.id !== category.id)}
            />
          ))}
        </ul>
      )}

      <form onSubmit={add} className="mt-2.5 flex gap-2">
        <label htmlFor="new-category-name" className="sr-only">
          New category name
        </label>
        <input
          id="new-category-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name…"
          className={cn(
            "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
            "placeholder:text-dim focus:border-accent focus:outline-none",
          )}
        />
        <button
          type="submit"
          disabled={meta.createCategory.isPending || name.trim() === ""}
          className={cn(
            "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Add
        </button>
      </form>

      <AutoCategorise meta={meta} cards={cards} />

      {failure && (
        <p className="mt-2 text-[0.6875rem] text-destructive" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

/**
 * One pile: the handle, the heading `GroupHeader` draws, and the three things that can be done
 * to it.
 *
 * The row is the drop target as well as the drag source, and a drop *lands the dragged category
 * where this one is* rather than above or below it. One rule instead of an edge-detection
 * hitbox, and it is the rule the keyboard already has — ArrowDown means "one further down the
 * list", which is the same move.
 */
function CategoryRow({
  category,
  index,
  total,
  meta,
  onMove,
  renaming,
  onRename,
  confirming,
  onConfirm,
  onDone,
  others,
}: {
  category: DeckCategory;
  index: number;
  total: number;
  meta: DeckMeta;
  onMove: (id: number, to: number) => void;
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onDone: () => void;
  /** Where this category's cards could go instead of being deleted with it. */
  others: readonly DeckCategory[];
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  const group = groupOf(category);

  useEffect(() => {
    const row = rowRef.current;
    const handle = handleRef.current;
    if (!row || !handle) return;
    // Only a press that started on the handle may drag the row, and it is remembered from
    // `mousedown` rather than declared with the library's own `dragHandle`.
    //
    // Two reasons, and the second is why this is not a style choice. The first is the one
    // `cardDraggable` already documents: a row is full of controls — a toggle, two text
    // buttons, a field while it is being renamed — and `canDrag` is asked at `dragstart` with
    // the pointer's *coordinates*, never with what was pressed, so without this a press on the
    // toggle plus five pixels of travel is a drag of the whole row. The second: the library's
    // `dragHandle` resolves the pointer through `elementFromPoint`, which jsdom does not
    // answer — so a handle declared that way is a reorder **no test in this repository can
    // reach**, and this is a gesture whose whole risk is landing a row in the wrong place.
    // Capture phase, so a control that stops the press cannot hide it from this.
    let fromHandle = false;
    const press = (event: Event) => {
      fromHandle = event.target instanceof Node && handle.contains(event.target);
    };
    row.addEventListener("mousedown", press, true);

    const stops = [
      draggable({
        element: row,
        canDrag: () => fromHandle,
        getInitialData: () => categoryDragData(category.id),
      }),
      dropTargetForElements({
        element: row,
        canDrop: ({ source }) => {
          const dragged = readCategoryDrag(source.data);
          return dragged !== null && dragged !== category.id;
        },
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: ({ source }) => {
          setOver(false);
          const dragged = readCategoryDrag(source.data);
          if (dragged !== null && dragged !== category.id) onMove(dragged, index);
        },
      }),
    ];
    return () => {
      row.removeEventListener("mousedown", press, true);
      for (const stop of stops) stop();
    };
  }, [category.id, index, onMove]);

  return (
    <li
      ref={rowRef}
      className={cn(
        "rounded-md border bg-bg px-2 py-1.5",
        "transition-colors duration-150 motion-reduce:transition-none",
        over ? "border-accent" : "border-border hover:border-accent/60",
      )}
    >
      <div className="flex items-center gap-2.5">
        <button
          ref={handleRef}
          type="button"
          // The whole of the keyboard reorder. A handle a mouse can drag and a keyboard cannot
          // is a reorder half the readers do not have — and the position is in the name because
          // the only other way to know where a row landed is to look at it.
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onMove(category.id, index - 1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onMove(category.id, index + 1);
            }
          }}
          aria-label={`Move ${category.name}, ${index + 1} of ${total}`}
          title="Drag to reorder, or press the up and down arrow keys"
          className={cn(
            "shrink-0 cursor-grab rounded-sm text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>

        <GroupHeader group={group} className="flex-1" />

        {!group.isPredefined && (
          <RowAction onClick={onRename} disabled={renaming}>
            Rename
          </RowAction>
        )}
        {!group.isPredefined && (
          <RowAction onClick={onConfirm} disabled={confirming} destructive>
            Delete
          </RowAction>
        )}

        <ToggleChip
          label={category.isActive ? "Active" : "Inactive"}
          pressed={category.isActive}
          // The row's own name, so eight chips reading "Active" are eight addressable controls
          // rather than one repeated eight times. `ToggleChip` puts it in the accessible name
          // after the visible word, which is the order WCAG 2.5.3 asks for.
          hint={category.name}
          onClick={() =>
            meta.setCategoryActive.mutate({ id: category.id, isActive: !category.isActive })
          }
        />
      </div>

      {renaming && (
        <RenameField
          label={`Rename ${category.name}`}
          initial={category.name}
          pending={meta.renameCategory.isPending}
          onSave={(next) =>
            meta.renameCategory.mutate({ id: category.id, name: next }, { onSuccess: onDone })
          }
          onCancel={onDone}
        />
      )}

      {confirming && (
        <DeleteCategory
          category={category}
          others={others}
          meta={meta}
          onCancel={onDone}
          onDeleted={onDone}
        />
      )}
    </li>
  );
}

/**
 * Delete a pile, and say which of the two things is about to happen.
 *
 * **This is the one destructive control on the drawer, and the destruction is optional** —
 * `deck_category_delete` takes `moveToCategoryId`, and `null` is the half that takes the cards
 * with the category by cascade. One command rather than two, so a caller cannot lose the cards
 * between a move and a delete that failed; one *question*, for the same reason, with the
 * confirm button's own words changing with the answer. A dialog that said "Delete category" over
 * both outcomes would be a dialog that hid the difference it exists to ask about.
 *
 * An empty category asks nothing — there is nothing to move and nothing to lose.
 */
function DeleteCategory({
  category,
  others,
  meta,
  onCancel,
  onDeleted,
}: {
  category: DeckCategory;
  others: readonly DeckCategory[];
  meta: DeckMeta;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  /** `"delete"` or a category id as text — one `<select>` value, because the two outcomes are
   *  one decision and a checkbox beside a picker would be two. */
  const [choice, setChoice] = useState<string>(() =>
    // The safe answer is the default: a reader who presses through without reading keeps their
    // cards. Reaching the destructive one takes a deliberate pick.
    others.length > 0 ? String(others[0].id) : "delete",
  );
  const cards = category.cardCount;
  const count = `${cards} ${cards === 1 ? "card" : "cards"}`;
  /** The question is only asked when there is something to lose *and* somewhere to put it. */
  const choosing = cards > 0 && others.length > 0;
  const target = choosing ? (others.find((c) => String(c.id) === choice) ?? null) : null;
  /** What the command is sent. **`null` is the destructive half** — the cards go with the
   *  category by cascade — so an empty pile sends it too: there is nothing to move, and naming
   *  a target for zero cards would be a move this dialog never offered. */
  const moveTo = target?.id ?? null;
  /** Whether pressing through loses cards. Not the same question as `moveTo === null`, and
   *  that difference is the whole reason this is a separate name: an empty pile is deleted
   *  with `null` and destroys nothing. */
  const losing = cards > 0 && moveTo === null;

  return (
    <div role="group" aria-label={`Delete ${category.name}`} className="mt-2 border-t border-border pt-2">
      <p className="text-xs">Delete “{category.name}”?</p>

      {choosing && (
        <div className="mt-1.5 flex items-center gap-2">
          <label htmlFor={`delete-${category.id}-cards`} className="text-[0.6875rem] text-dim">
            Its {count}
          </label>
          <select
            id={`delete-${category.id}-cards`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className={cn(
              "h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-xs",
              FOCUS,
            )}
          >
            {others.map((c) => (
              <option key={c.id} value={String(c.id)}>
                move to “{c.name}”
              </option>
            ))}
            <option value="delete">are deleted with it</option>
          </select>
        </div>
      )}

      {/* The sentence, not the button, is where the outcome is spelled out — a reader who has
          just changed the picker is looking here, and this is the line that changes under them. */}
      <p
        className={cn(
          "mt-1.5 text-[0.6875rem] leading-relaxed",
          losing ? "text-destructive" : "text-dim",
        )}
      >
        {cards === 0
          ? "It is empty, so nothing goes with it."
          : losing
            ? `The ${count} in it are deleted too. This cannot be undone.`
            : `The ${count} in it move to “${target?.name}”. Nothing is lost.`}
      </p>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={meta.deleteCategory.isPending}
          onClick={() =>
            meta.deleteCategory.mutate(
              { id: category.id, moveToCategoryId: moveTo },
              { onSuccess: onDeleted },
            )
          }
          className={cn(
            "rounded-md border px-2 py-1 text-xs",
            "transition-colors duration-150 disabled:opacity-50 motion-reduce:transition-none",
            losing
              ? "border-destructive text-destructive hover:bg-destructive hover:text-bg"
              : "border-border text-text hover:border-accent hover:text-accent",
            FOCUS,
          )}
        >
          {moveTo === null ? `Delete “${category.name}”` : `Move ${count} and delete`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-xs text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * File the loose cards into piles named after their types, in one press.
 *
 * The rule is `autoCategoryFor` and lives in TypeScript; `useDeckMeta` orchestrates it and
 * refuses to empty a pile a person made. What this adds is the sentence afterwards: the press
 * moves cards and the drawer does not draw any, so without a count the reader has no way to
 * know whether anything happened.
 */
function AutoCategorise({ meta, cards }: { meta: DeckMeta; cards: readonly DeckCard[] }) {
  const { autoCategorise } = meta;
  const moved = autoCategorise.data;

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={autoCategorise.isPending}
        onClick={() => autoCategorise.mutate(cards)}
        className={cn(
          "h-8 w-full rounded-md border border-dashed border-border px-3 text-xs text-dim",
          "transition-colors duration-150 hover:border-accent hover:text-accent",
          "disabled:opacity-50 motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Auto-categorise from card types
      </button>
      <p role="status" className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {autoCategorise.isPending
          ? "Filing cards…"
          : moved === undefined
            ? "Files the cards nobody has filed into piles named after their types. Categories you made are left alone."
            : moved === 0
              ? "Nothing to file — every card is already in a pile somebody chose."
              : `Filed ${moved} ${moved === 1 ? "card" : "cards"}.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ tags ------- */

function Tags({ meta }: { meta: DeckMeta }) {
  const { tags, tagsQuery, suggestions } = meta;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>(DEFAULT_TAG_COLOR.token);

  // A suggestion this deck already has is not an offer — it is the row above it.
  const taken = useMemo(() => new Set(tags.map((t) => t.name)), [tags]);
  const offers = useMemo(
    () => suggestions.filter((s) => !taken.has(s.name)),
    [suggestions, taken],
  );

  const failure = firstFailure(
    meta.createTag.error,
    meta.updateTag.error,
    meta.deleteTag.error,
    tagsQuery.error,
  );

  return (
    <section aria-labelledby="deck-tags-heading">
      <h3 id="deck-tags-heading" className="text-[0.8125rem] font-medium">
        Tags
      </h3>
      <p className="mb-2.5 mt-1 text-[0.6875rem] leading-relaxed text-dim">
        Tags belong to this deck, and a card carries at most one. The suggestions below come from
        every deck you have — picking one makes a tag of that name here. Deleting a tag keeps its
        cards and takes the label off them.
      </p>

      {tagsQuery.isPending ? (
        <p className="text-xs text-dim">Reading this deck’s tags…</p>
      ) : tags.length === 0 ? (
        <p className="text-xs text-dim">No tags yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              meta={meta}
              renaming={renaming === tag.id}
              onRename={() => setRenaming(tag.id)}
              confirming={confirming === tag.id}
              onConfirm={() => setConfirming(tag.id)}
              onDone={() => {
                setRenaming(null);
                setConfirming(null);
              }}
            />
          ))}
        </ul>
      )}

      {/* Not on the design canvas, and here because the canvas's own answer only works for a
          reader who already has decks: with no other deck there are no suggestions, and without
          this field the very first tag could never be made. It is the Categories section's add
          field wearing the same clothes, plus the one thing a tag has that a category does not. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          meta.createTag.mutate({ name: trimmed, color }, { onSuccess: () => setName("") });
        }}
        className="mt-2.5 flex flex-wrap items-center gap-2"
      >
        <label htmlFor="new-tag-name" className="sr-only">
          New tag name
        </label>
        <input
          id="new-tag-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag name…"
          className={cn(
            "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
            "placeholder:text-dim focus:border-accent focus:outline-none",
          )}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button
          type="submit"
          disabled={meta.createTag.isPending || name.trim() === ""}
          className={cn(
            "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Add tag
        </button>
      </form>

      <p className="mb-1.5 mt-3 text-[0.6875rem] text-dim">Suggested from your other decks</p>
      {offers.length === 0 ? (
        <p className="text-[0.6875rem] text-dim">
          Nothing yet — tags you use in other decks are offered here.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {offers.map((s) => (
            <button
              key={`${s.name}-${s.color}`}
              type="button"
              disabled={meta.createTag.isPending}
              onClick={() => meta.createTag.mutate({ name: s.name, color: s.color })}
              aria-label={`Add tag ${s.name}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-xl border border-dashed border-border",
                "px-2 py-0.5 text-[0.6875rem] text-dim",
                "transition-colors duration-150 hover:border-accent hover:text-accent",
                "disabled:opacity-50 motion-reduce:transition-none",
                FOCUS,
              )}
            >
              <Swatch color={s.color} />
              {s.name}
            </button>
          ))}
        </div>
      )}

      {failure && (
        <p className="mt-2 text-[0.6875rem] text-destructive" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

function TagRow({
  tag,
  meta,
  renaming,
  onRename,
  confirming,
  onConfirm,
  onDone,
}: {
  tag: DeckTag;
  meta: DeckMeta;
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onDone: () => void;
}) {
  const [color, setColor] = useState<TagColor>(tag.color);

  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-2.5">
        <Swatch color={tag.color} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{tag.name}</span>
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {tag.cardCount} {tag.cardCount === 1 ? "card" : "cards"}
        </span>
        <RowAction onClick={onRename} disabled={renaming}>
          Rename
        </RowAction>
        <RowAction onClick={onConfirm} disabled={confirming} destructive>
          Delete
        </RowAction>
      </div>

      {renaming && (
        <RenameField
          label={`Rename ${tag.name}`}
          initial={tag.name}
          pending={meta.updateTag.isPending}
          // Both fields, always: `deck_tag_update` renames **and** recolours in one command and
          // has no patch shape, so a caller changing one sends the other back unchanged.
          extra={<ColorPicker value={color} onChange={setColor} />}
          onSave={(next) =>
            meta.updateTag.mutate({ id: tag.id, name: next, color }, { onSuccess: onDone })
          }
          onCancel={() => {
            setColor(tag.color);
            onDone();
          }}
        />
      )}

      {confirming && (
        <div
          role="group"
          aria-label={`Delete ${tag.name}`}
          className="mt-2 border-t border-border pt-2"
        >
          <p className="text-xs">Delete “{tag.name}”?</p>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
            {tag.cardCount === 0
              ? "No card is wearing it."
              : `Its ${tag.cardCount} ${tag.cardCount === 1 ? "card stays" : "cards stay"} in the deck and lose the label.`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={meta.deleteTag.isPending}
              onClick={() => meta.deleteTag.mutate(tag.id, { onSuccess: onDone })}
              className={cn(
                "rounded-md border border-destructive px-2 py-1 text-xs text-destructive",
                "transition-colors duration-150 hover:bg-destructive hover:text-bg",
                "disabled:opacity-50 motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Delete tag
            </button>
            <button
              type="button"
              onClick={onDone}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs text-dim",
                "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** A tag's colour, 9px square — the same scale as a rarity gem, which is what keeps the
 *  direction's colour budget on the card art where it belongs. `aria-hidden`: the colour is
 *  never the only carrier of anything, and the name is right beside it. */
function Swatch({ color }: { color: TagColor }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: tagColorCss(color) }}
      className="size-2.5 shrink-0 rounded-[2px]"
    />
  );
}

/** The palette, as the picker offers it. Buttons rather than radios: `aria-pressed` is the
 *  shape every other toggle in the app takes, and a stored colour is a **token name** — never
 *  a hex string, which would outlive the theme that chose it. */
function ColorPicker({
  value,
  onChange,
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
}) {
  return (
    <div role="group" aria-label="Tag colour" className="flex shrink-0 gap-1">
      {TAG_COLORS.map((c) => (
        <button
          key={c.token}
          type="button"
          aria-pressed={value === c.token}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.token)}
          style={{ backgroundColor: c.css }}
          className={cn(
            "size-5 rounded-[3px] border",
            "transition-colors duration-150 motion-reduce:transition-none",
            value === c.token ? "border-accent" : "border-transparent hover:border-border",
            FOCUS,
          )}
        />
      ))}
    </div>
  );
}

/** The two words a row offers, in one shape, so a category row and a tag row read as one
 *  family. */
function RowAction({
  children,
  onClick,
  disabled,
  destructive,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "shrink-0 rounded-sm text-[0.6875rem] text-dim",
        "transition-colors duration-150 disabled:opacity-50 motion-reduce:transition-none",
        destructive ? "hover:text-destructive" : "hover:text-text",
        FOCUS,
      )}
    >
      {children}
    </button>
  );
}

/** Rename in place: one field, its own Save, and Escape's job left to the drawer — a second
 *  Escape rung inside an `"inner"` layer is the case `useDismissOnEscape` explicitly does not
 *  order. Cancel is a control, and it is the one that hands the caret back. */
function RenameField({
  label,
  initial,
  pending,
  extra,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  pending: boolean;
  extra?: ReactNode;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  // The caret starts in the field the reader opened, with the current name selected: the
  // commonest rename replaces the word rather than editing inside it.
  useEffect(() => {
    ref.current?.select();
  }, []);

  const trimmed = value.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        onSave(trimmed);
      }}
      className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2"
    >
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={label}
        className={cn(
          "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
          "focus:border-accent focus:outline-none",
        )}
      />
      {extra}
      <button
        type="submit"
        disabled={pending || trimmed === ""}
        className={cn(
          "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
          "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
          "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={cn(
          "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Cancel
      </button>
    </form>
  );
}

/**
 * The first refusal any of a section's writes is holding, as a sentence.
 *
 * One line per section rather than one per control: every refusal here is either a busy
 * database or a category, tag or deck another surface has deleted, and both are facts about the
 * section rather than about the button that happened to hit them.
 */
function firstFailure(...errors: unknown[]): string | null {
  const found = errors.find((e) => e !== null && e !== undefined);
  return found === undefined ? null : ipcError(found);
}
