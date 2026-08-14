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
  type Ref,
} from "react";
import { GripVertical, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
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
import type { Marketplace } from "@/lib/marketplace";
import { drawerRight, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { writeFailure, type Write } from "@/lib/writes";
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
 * Nothing when closed, and the drawer is a separate component for that reason: the queries
 * belong to a panel that is *up*, and a hook cannot be skipped. A closed drawer therefore costs
 * nothing at all — no `deck_category_list`, no `deck_tag_list` — which is what makes it safe for
 * the editor to mount this unconditionally.
 *
 * **The Escape rung is registered here rather than one floor down, and that is not tidiness.**
 * With an exit animation the drawer outlives `open` by the length of its slide, so a rung that
 * came up with the *element* would still be consuming Escape while the next overlay is opening
 * — and two `"inner"` peers are not ordered by this protocol at all (`useDismissOnEscape`'s own
 * doc). The editor's `Layer` union guarantees "never two" only because unmounting used to be
 * synchronous. Registered out here on `enabled: open`, the rung is dead on the render that
 * starts the exit, and the guarantee holds for the reason it always claimed to.
 */
export function CategoriesPanel(props: CategoriesPanelProps): JSX.Element {
  const { open, onDismiss } = props;

  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  return <AnimatePresence>{open && <Drawer key="categories" {...props} />}</AnimatePresence>;
}

function Drawer({ deckId, variant, onDismiss, onClose }: CategoriesPanelProps) {
  // Each row draws a `GroupHeader`, which prints the pile's total — so this drawer quotes
  // prices and has to say whose. Read once here and handed down, for `GroupHeader`'s reason:
  // two rows of one list must not name two marketplaces.
  const { marketplace } = useMarketplace();
  const meta = useDeckMeta(deckId, variant);
  // The deck's own rows, for one control: `autoCategorise` files by what a card *does* and
  // falls back to its type line, so it is handed cards rather than ids — the type line travels
  // on the row, and the card ids are what its one bulk tag read is keyed by. Free in the app —
  // the editor behind this drawer is already holding `["decks", "detail", deckId, variant]`,
  // and this is that same query.
  const { cards } = useDeck(deckId, variant);

  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the slide out. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for every other one in the app: the drawer's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    // The scrim and the panel, one presence and two tweens: the ground darkens at the
    // interaction tier and the drawer arrives more slowly over it, so it is never seen sliding
    // across an undimmed window. Both register with the presence, so this is unmounted when the
    // later of the two has finished.
    <motion.div
      {...scrim}
      // The scrim. A press that lands on it and not on the drawer is the reader leaving:
      // `onClose`, which closes without yanking the caret back — the outside-click half of the
      // Escape contract, and deliberately not the same answer as the ✕.
      //
      // `onMouseDown`, not `onClick`, and the two dialogs document why: a click fires on the
      // nearest common ancestor of press and release, so a text selection that starts on a
      // sentence in the drawer and ends past its edge is a "click" out here — and this drawer
      // is full of selectable text. Where the press *lands* is unambiguous.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // On the way out the layer is a picture and nothing else: not pressable, and not a second
      // `role="dialog"` sitting in the accessibility tree beside whichever overlay the reader
      // opened next. Focus left with the flag.
      aria-hidden={present ? undefined : true}
      className={cn(
        "fixed inset-0 flex justify-end bg-black/60",
        !present && "pointer-events-none",
        // The editor's overlay rung, above every anchored popup in the view behind this: `popup`
        // would *tie* with them, and equal z-indexes resolve by document order — where the editor
        // mounts this drawer is the editor's choice, not this file's.
        LAYER.overlay,
      )}
    >
      <motion.div
        {...drawerRight}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Categories and tags"
        // **Modal, and the scrim above is the whole argument.** This drawer used to claim the
        // opposite — "the editor behind stays live and reachable" — which was true of a keyboard
        // and false of a pointer, because that `bg-black/60` covers the whole window. A scrim is
        // not decoration: it is a statement that what is behind it is not available right now.
        // Tabbing back into an editor the pointer cannot touch does not preserve a capability,
        // it contradicts what the surface says, for one input method only. So the claim is made
        // to assistive tech and `trapTab` makes it true for the caret as well — and if either
        // half is ever removed, the other goes with it.
        aria-modal="true"
        onKeyDown={trapTab}
        // Not portalled, whatever the modality: the shipped CSP is `style-src 'self'` and every
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
          <Categories meta={meta} cards={cards} marketplace={marketplace} />
          <Tags meta={meta} />
        </div>
      </motion.div>
    </motion.div>
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
    isPredefined: category.kind !== "main" && PREDEFINED_CATEGORY_NAMES.includes(category.name),
    cards: NO_CARDS,
    count: category.cardCount,
    // Rust summed this at the marketplace the category list was read at, so it is carried
    // across rather than chosen here. `null` is a pile nothing in which that marketplace
    // quotes — an em dash, never another marketplace's figure in disguise.
    totalPrice: category.totalPrice,
  };
}

function Categories({
  meta,
  cards,
  marketplace,
}: {
  meta: DeckMeta;
  cards: readonly DeckCard[];
  marketplace: Marketplace;
}) {
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

  const failure = sectionFailure(
    [
      meta.createCategory,
      meta.renameCategory,
      meta.setCategoryActive,
      meta.reorderCategories,
      meta.deleteCategory,
    ],
    categoriesQuery,
  );

  return (
    <section aria-labelledby="deck-categories-heading">
      <h3 id="deck-categories-heading" className="text-[0.8125rem] font-medium">
        Categories
      </h3>
      <p className="mb-2.5 mt-1 text-[0.6875rem] leading-relaxed text-dim">
        Only active categories count toward the deck — a switched-off pile counts toward no size, no
        copy limit and no legality check, and reserves no copy from your collection. Drag a row by
        its handle to reorder, or press the up and down arrow keys on it. The four categories every
        deck starts with can be switched off, but not renamed or deleted.
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
              marketplace={marketplace}
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
  marketplace,
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
  /** Which marketplace this row's total is quoted from. */
  marketplace: Marketplace;
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
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocus = useRef(false);
  const [over, setOver] = useState(false);
  const group = groupOf(category);

  // The other end of the hand-back, and it has to be an effect for `DecksPage`'s
  // `refocusFolderRef` reason: the trigger is **disabled** while the question is up, so
  // focusing it from the Cancel handler would be a call on a control the browser still skips.
  // It is re-enabled by the render this effect runs after. Only after a cancel — a delete that
  // went through takes the row with it, and there is nothing left to hand back to.
  useEffect(() => {
    if (confirming || !owedFocus.current) return;
    owedFocus.current = false;
    deleteRef.current?.focus();
  }, [confirming]);

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

        <GroupHeader group={group} marketplace={marketplace} className="flex-1" />

        {!group.isPredefined && (
          <RowAction onClick={onRename} disabled={renaming}>
            Rename
          </RowAction>
        )}
        {!group.isPredefined && (
          <RowAction ref={deleteRef} onClick={onConfirm} disabled={confirming} destructive>
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
          // "Keep it" is the reader saying put me back, so it does — the same split every
          // other layer here makes between a Cancel control and a click somewhere else.
          onCancel={() => {
            owedFocus.current = true;
            onDone();
          }}
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
 *
 * **Every number in here is `cardCountAllVariants`, never `cardCount`.** A category is not
 * per-variant: `deck_cards.category_id` is `ON DELETE CASCADE`, so the delete reaches the live
 * list and the theory list alike, and the move arm moves both. The row above this dialog shows
 * the variant-scoped count and is right to — that is the list the reader is editing — but a
 * confirmation quoting it would promise less than it takes, and it would understate the
 * **destructive** arm in particular. Found on the fake's seeded deck 4, where "Ramp" offered to
 * move 2 cards and moved 7. When copies exist in the list that is *not* on screen, the sentence
 * says so in words: the reader can see one list and cannot be asked to infer the other.
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
  const ref = useRef<HTMLDivElement>(null);

  // The caret moves into the question, as it does for every other layer in this app
  // (`DecksPage`'s `DeleteConfirm`, `FolderTree`'s, both drawers). **The row's Delete trigger
  // is `disabled` the moment this opens**, and Chromium blurs a control it disables — so
  // without this the caret is on `<body>` and the next Tab restarts at the top of the document,
  // which is the bug commit `10761c1` fixed for `RenameField` eight lines of this file away.
  // The panel and not a button: the reader has not decided yet, and a stray Enter must not
  // decide for them.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // Both lists, because both go. See this component's doc.
  const cards = category.cardCountAllVariants;
  const count = `${cards} ${cards === 1 ? "card" : "cards"}`;
  /** Copies in the list the reader is **not** looking at. `> 0` is exactly the condition for
   *  mentioning the other list at all: a deck with no theory rows in this pile has one list to
   *  talk about, and a sentence about two would be chrome. */
  const elsewhere = cards - category.cardCount;
  const bothLists =
    elsewhere > 0 ? " — that is both the live and theory lists, not just the one on screen" : "";
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
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={`Delete ${category.name}`}
      className={cn("mt-2 border-t border-border pt-2", FOCUS)}
    >
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
            ? `The ${count} in it are deleted too${bothLists}. This cannot be undone.`
            : `The ${count} in it move to “${target?.name}”${bothLists}. Nothing is lost.`}
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
 * File the loose cards by what they do, in one press.
 *
 * The rule is `autoCategoryFor` and lives in TypeScript; `useDeckMeta` orchestrates it, reads
 * the Oracle tags it files by in one call, and refuses to empty a pile a person made. What this
 * adds is the words: the label, the sentence describing the rule, and the sentence afterwards.
 *
 * **The label says what the rule does, and it used to say what the rule *did*.** "Auto-categorise
 * from card types" was exactly true while the type line was the whole of the rule; a card's
 * function is the primary answer now (Removal, Ramp, Draw and ten more) and the type line is
 * the fallback under it, so the old words undersold the press and mis-described what a reader
 * would get back.
 *
 * **Two sentences, two roles, and the split is the point.** The count is news the reader asked
 * for — a polite `role="status"`, because the drawer draws no cards and without it there is no
 * way to tell a no-op from a failure. A refusal is news the reader did *not* ask for and has to
 * act on, so it is an `alert`, in the section's own colour for a refused write. It is rendered
 * here rather than through `sectionFailure` because this press is the one whose refusal has a
 * *reach* worth stating — `useDeckMeta` words that sentence, so the hook that decided to move
 * nothing is the thing that says so.
 *
 * A pile this press empties disappears from the **editor** behind the drawer (`grouping.ts`'s
 * `drawsWhenEmpty`) and stays in the list above, which is `deck_category_list` and draws every
 * category a deck has. That is not a contradiction: this drawer is the surface where a pile is
 * the subject rather than a heading over cards.
 */
function AutoCategorise({ meta, cards }: { meta: DeckMeta; cards: readonly DeckCard[] }) {
  const { autoCategorise } = meta;
  const moved = autoCategorise.data;
  const refusal = autoCategorise.isError ? ipcError(autoCategorise.error) : null;

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
        File cards by what they do
      </button>
      <p role="status" className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {autoCategorise.isPending
          ? "Filing cards…"
          : moved === undefined
            ? "Files the cards nobody has filed by what they do — Removal, Ramp, Draw — falling back to the card’s type. Categories you made are left alone."
            : moved === 0
              ? "Nothing to file — every card is already in a pile somebody chose."
              : `Filed ${moved} ${moved === 1 ? "card" : "cards"}.`}
      </p>
      {refusal && (
        <p role="alert" className="mt-1 text-[0.6875rem] leading-relaxed text-destructive">
          {refusal}
        </p>
      )}
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
  const offers = useMemo(() => suggestions.filter((s) => !taken.has(s.name)), [suggestions, taken]);

  const failure = sectionFailure([meta.createTag, meta.updateTag, meta.deleteTag], tagsQuery);

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
              // Both lists, for the confirmation only — the row above it keeps the scoped
              // count. See `DeleteTag`.
              cardsAllVariants={meta.tagCardCountsAllVariants?.get(tag.id) ?? null}
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
  cardsAllVariants,
  meta,
  renaming,
  onRename,
  confirming,
  onConfirm,
  onDone,
}: {
  tag: DeckTag;
  /** Copies wearing this tag in **both** lists, or `null` while the other one is still being
   *  read. Only the confirmation uses it. */
  cardsAllVariants: number | null;
  meta: DeckMeta;
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onDone: () => void;
}) {
  const [color, setColor] = useState<TagColor>(tag.color);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocus = useRef(false);

  // `CategoryRow`'s hand-back, on the sibling control and for the identical reason.
  useEffect(() => {
    if (confirming || !owedFocus.current) return;
    owedFocus.current = false;
    deleteRef.current?.focus();
  }, [confirming]);

  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-2.5">
        <Swatch color={tag.color} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{tag.name}</span>
        {/* The list on screen, and right to be: this row is the list the reader is editing.
            Only the confirmation below changes scope — see `DeleteTag`. */}
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {tag.cardCount} {tag.cardCount === 1 ? "card" : "cards"}
        </span>
        <RowAction onClick={onRename} disabled={renaming}>
          Rename
        </RowAction>
        <RowAction ref={deleteRef} onClick={onConfirm} disabled={confirming} destructive>
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
        <DeleteTag
          tag={tag}
          cardsAllVariants={cardsAllVariants}
          meta={meta}
          onCancel={() => {
            owedFocus.current = true;
            onDone();
          }}
          onDeleted={onDone}
        />
      )}
    </li>
  );
}

/**
 * Delete a label, and say how many cards lose it.
 *
 * **The number is both lists, never {@link DeckTag.cardCount}** — the same correction
 * {@link DeleteCategory} carries, for the same reason one floor down: `deck_cards.tag_id` is
 * `ON DELETE SET NULL`, and a tag is not per-variant, so the label comes off the theory rows
 * wearing it as surely as off the live ones. Viewing Live, a tag worn by 2 live and 5 theory
 * rows used to say "Its 2 cards stay in the deck and lose the label" — and, worse, a tag worn
 * by nothing on screen and five cards off it said flatly **"No card is wearing it."** A
 * confirmation is the one place a reader is entitled to the whole reach of the press.
 *
 * Where the category gets its total from a backend column (`cardCountAllVariants`), this gets
 * it from a second `deck_tag_list` — see {@link useDeckMeta}. That read can be in flight, which
 * is what the `null` arm is: no number, and the sentence still names both lists, because
 * "unknown" must never be spelled as the smaller of the two.
 *
 * Nothing is destroyed here, so there is no picker and no choice — a tag delete has one
 * outcome, and the whole of the dialog is saying what it is.
 */
function DeleteTag({
  tag,
  cardsAllVariants,
  meta,
  onCancel,
  onDeleted,
}: {
  tag: DeckTag;
  cardsAllVariants: number | null;
  meta: DeckMeta;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The caret comes into the question, for {@link DeleteCategory}'s reason.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  /** Copies in the list the reader is **not** looking at. `> 0` is exactly the condition for
   *  mentioning the other list: a deck whose theory list wears this label nowhere has one list
   *  to talk about, and a sentence about two would be chrome. */
  const elsewhere = cardsAllVariants === null ? 0 : cardsAllVariants - tag.cardCount;
  const bothLists =
    elsewhere > 0 ? " — that is both the live and theory lists, not just the one on screen" : "";
  const wearing =
    cardsAllVariants === 1
      ? "Its 1 card stays in the deck and loses the label"
      : `Its ${cardsAllVariants} cards stay in the deck and lose the label`;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={`Delete ${tag.name}`}
      className={cn("mt-2 border-t border-border pt-2", FOCUS)}
    >
      <p className="text-xs">Delete “{tag.name}”?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {cardsAllVariants === null
          ? "Every card wearing it stays in the deck and loses the label, in the live list and the theory list alike."
          : cardsAllVariants === 0
            ? "No card in either list is wearing it."
            : `${wearing}${bothLists}.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={meta.deleteTag.isPending}
          onClick={() => meta.deleteTag.mutate(tag.id, { onSuccess: onDeleted })}
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
  ref,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** So the row can put the caret back on the control that opened a confirmation — which it
   *  cannot do until the render that re-enables it. See `CategoryRow`'s effect. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
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
  //
  // **Both calls, in this order, and `focus()` is not the redundant one.** Per spec
  // `HTMLInputElement.select()` sets a selection and does *not* move focus; Chromium focuses
  // anyway, which is exactly what makes the bug invisible where a person would meet it. Without
  // the `focus()` the caret stays on the Rename trigger — which this component has just
  // **disabled**, so it is parked on a dead control — and the reader's first keystroke goes to
  // the page. Found from outside by the agent building the decks page, which had the identical
  // line; `puts the caret in the rename field` is the test that holds it.
  useEffect(() => {
    ref.current?.focus();
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
 * The refusal a section is still owed a sentence about.
 *
 * One line per section rather than one per control: every refusal here is either a busy
 * database or a category, tag or deck another surface has deleted, and both are facts about the
 * section rather than about the button that happened to hit them.
 *
 * **The newest write, never the first one still holding an error** — {@link writeFailure}, the
 * rule the editor, the gallery and the settings dialog all follow. This drawer used to pick the
 * first non-null error in an argument list, which is the opposite: a refused reorder would sit
 * on screen while the reader went on to rename a pile successfully.
 *
 * The read comes last and only when no write refused. A failed `deck_category_list` is a
 * different kind of news and outranks nothing: if a write has just been refused, that is what
 * the reader pressed.
 */
function sectionFailure(
  writes: readonly [Write, ...Write[]],
  read: { isError: boolean; error: unknown },
): string | null {
  return writeFailure(writes) ?? (read.isError ? ipcError(read.error) : null);
}
