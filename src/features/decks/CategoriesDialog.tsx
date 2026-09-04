/**
 * The deck's piles, as things in themselves — a centred dialog over the editor.
 *
 * Everywhere else in the app a category is a *heading*: a column the cards live under. This is
 * the one surface where the pile itself is the subject — what it is called, what order the
 * columns come in, whether it counts, and whether it should exist at all.
 *
 * **The labels are next door rather than below.** This used to be the upper half of one
 * right-hand drawer called "Categories & tags" — the title it carried while a label was called
 * a tag — with {@link LabelsDialog}'s subject scrolled under it; they are two dialogs off the
 * same toolbar now, because they are two questions and a reader
 * arrives with one of them. Nothing is shared between the two but a `useDeckMeta` and the row
 * grammar in `metaRows.tsx`.
 *
 * ## The two rules this dialog has to say out loud
 *
 * Neither is guessable from the controls, so each is printed beside the controls it governs
 * rather than left to a tooltip:
 *
 * 1. **Only active categories count toward the deck.** The switch is the whole of "counts
 *    toward nothing" ({@link DeckCategory.isActive}) — size, copy limits, legality, and the
 *    allocator's claims all read it.
 * 2. **The four categories every deck starts with can be switched off but not renamed or
 *    deleted.** That is a backend refusal (`deck_category_rename`/`deck_category_delete`), and
 *    it is why those rows carry no Rename and no Delete rather than two greyed-out controls.
 *
 * ## What this deliberately does not decide
 *
 * The `RULE` marker. `views/GroupHeader.tsx` owns it, and this file renders that component for
 * every row rather than drawing its own name-and-counts line — so this dialog cannot be the
 * surface where `RULE` starts meaning something different from what a column heading means by
 * it. (It is *not* "predefined and undeletable": the Maybeboard is predefined and carries
 * `INACTIVE` instead, and a switched-off Sideboard carries both.) There is no format branch
 * anywhere in here, and there must never be one: a deck's rules role is `kind`, which the
 * backend seeds, and every question this dialog asks about a category is answered by `kind`,
 * `isActive` or the name.
 *
 * **The format now reaches the editor, and that is not a reason to let it in here.** A Standard
 * deck draws no empty command zone and no empty Companion — `grouping.ts`'s `drawsWhenEmpty`,
 * asked about a group holding nothing. This dialog is the surface that answers "what piles does
 * this deck have", and the answer is all of them: a heading the editor leaves out is exactly the
 * pile a reader comes here to find, rename, reorder or delete. Every row, always.
 *
 * **`DeckCategory.origin` is the second fact the editor now leaves piles out by, and the same
 * reasoning covers it: no branch on it in here either.** A pile the app made while filing a card
 * (`origin: 'auto'` — Ramp, Draw, Removal) draws no heading until it holds one, so an auto pile
 * the reader empties is gone from the desk altogether — which makes "every row, always" more
 * load-bearing than it was, not less: this dialog is then the only surface where that pile can be
 * found, renamed or deleted at all. Predefined, auto and user-made are three answers to *when is
 * an empty pile drawn* and one answer to *what piles does this deck have*, and this dialog asks
 * only the second question. The class still travels to {@link groupOf} as `isAuto`, because
 * `GroupHeader` is handed a whole group and must draw this row exactly as the desk would.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
import { GripVertical } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { ipcError, type DeckCard, type DeckCategory, type DeckVariant } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { PREDEFINED_CATEGORY_NAMES } from "./autoCategory";
// The gesture itself is `categoryDrag.ts`, shared with the deck's own piles: this dialog and
// `StackView` draw a category completely differently and mean exactly the same write.
import { movedTo, useCategoryDragSource, useCategoryReorderDrop } from "./categoryDrag";
import { Dialog } from "@/components/Dialog";
import type { CardGroup } from "./grouping";
import {
  CONFIRM_CANCEL,
  CONFIRM_DESTRUCTIVE,
  META_FIELD,
  META_SUBMIT,
  RenameField,
  RowAction,
  sectionFailure,
  useConfirmFocus,
} from "./metaRows";
import { useDeck } from "./useDeck";
import { useDeckMeta, type DeckMeta } from "./useDeckMeta";
import { GroupHeader } from "./views/GroupHeader";

/* ----------------------------------------------------------------------- shell ------- */

export interface CategoriesDialogProps {
  deckId: number;
  /** Scopes every count and every price on screen, and nothing else: which categories a deck
   *  has is a fact about the deck rather than about one of its two lists. */
  variant: DeckVariant;
  open: boolean;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The chrome is {@link Dialog}'s and the body below is this file's.
 *
 * **The body is a separate component and that is not tidiness**: a closed {@link Dialog}
 * mounts no children at all, so the queries belong one floor down where they only exist while
 * the dialog is up. A closed dialog therefore costs nothing — no `deck_category_list`, no
 * `deck_get` — which is what makes it safe for the editor to mount this unconditionally beside
 * five others. The Escape rung is the shell's, registered on the flag for the reason its own doc
 * gives.
 *
 * `48rem` because a row is a drag handle, a whole `GroupHeader` (name, two markers, a count and
 * a price), two text buttons and a switch on one line, and the deck this describes is behind it.
 */
export function CategoriesDialog({
  deckId,
  variant,
  open,
  onDismiss,
  onClose,
}: CategoriesDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Categories"
      closeLabel="Close categories"
      size="w-[48rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <CategoriesBody deckId={deckId} variant={variant} />
    </Dialog>
  );
}

function CategoriesBody({ deckId, variant }: { deckId: number; variant: DeckVariant }) {
  // Each row draws a `GroupHeader`, which prints the pile's total — so this dialog quotes prices
  // and has to say whose. Read once here and handed down, for `GroupHeader`'s reason: two rows
  // of one list must not name two marketplaces.
  const { marketplace } = useMarketplace();
  // **One hook over a deck's piles *and* its labels, so this reads the label lists too**, and
  // that is the price of the two dialogs sharing it rather than each growing a hook of its own.
  // It is cheap and it is deliberate: the editor opens at most one of them, so the pair costs
  // one set of reads however the reader arrives — and the two lists cannot durably disagree,
  // because every write in the app invalidates the one `["decks"]` root both keys sit under.
  const meta = useDeckMeta(deckId, variant);
  // The deck's own rows, for one control: `autoCategorise` files by what a card *does* and
  // falls back to its type line, so it is handed cards rather than ids — the type line travels
  // on the row, and the card ids are what its one bulk tag read is keyed by. Free in the app —
  // the editor behind this dialog is already holding `["decks", "detail", deckId, variant]`,
  // and this is that same query.
  const { cards } = useDeck(deckId, variant);

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

  /**
   * The drop's own spelling of the same move.
   *
   * `useCategoryReorderDrop` hands back the **id** of the pile the drag was let go over — a move
   * is two ids and never an index, because the piles a surface draws are a subset of the deck's
   * list — while this dialog's `move` takes a position, since the arrow keys ask for one. This
   * dialog holds the whole list in order, so it is the place that can resolve the one into the
   * other.
   */
  const moveOnto = useCallback(
    (dragged: number, targetId: number) => {
      const to = ordered.findIndex((one) => one.id === targetId);
      if (to >= 0) move(dragged, to);
    },
    [ordered, move],
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
    // The body's own scroller, with its own padding: the shell owns the header and stops there,
    // because the deck's dialogs do not agree about what goes inside one.
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
      {/* No heading of its own — the dialog is titled "Categories" one element up, and a second
          "Categories" under it would be the same word twice with nothing between them. */}
      <p className="mb-2.5 text-[0.6875rem] leading-relaxed text-dim">
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
              onMoveOnto={moveOnto}
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
          className={META_FIELD}
        />
        <button
          type="submit"
          disabled={meta.createCategory.isPending || name.trim() === ""}
          className={META_SUBMIT}
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
 *
 * `isAuto` is carried across from the row's `origin` rather than guessed from the name, for the
 * reason `origin` exists at all: "Ramp" and "Draw" are exactly what a person calls a pile of
 * their own, and the name is the user's while the kind — here the provenance — is what the rules
 * read. It changes **nothing about which rows this component is drawn for**; it is here so that
 * a heading in this dialog and the same heading on the desk are one component fed one shape.
 */
function groupOf(category: DeckCategory): CardGroup {
  return {
    key: `cat-${category.id}`,
    name: category.name,
    kind: category.kind,
    categoryId: category.id,
    isActive: category.isActive,
    isPredefined: category.kind !== "main" && PREDEFINED_CATEGORY_NAMES.includes(category.name),
    isAuto: category.origin === "auto",
    cards: NO_CARDS,
    count: category.cardCount,
    // Rust summed this at the marketplace the category list was read at, so it is carried
    // across rather than chosen here. `null` is a pile nothing in which that marketplace
    // quotes — an em dash, never another marketplace's figure in disguise.
    totalPrice: category.totalPrice,
  };
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
  onMoveOnto,
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
  /** The keyboard's move: this row, to a position. */
  onMove: (id: number, to: number) => void;
  /** The drop's move: the dragged pile, onto the pile it was let go over. Two ids, resolved
   *  against the whole list by the dialog. */
  onMoveOnto: (dragged: number, targetId: number) => void;
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onDone: () => void;
  /** Where this category's cards could go instead of going with it. */
  others: readonly DeckCategory[];
}) {
  const tip = useTooltip();
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocus = useRef(false);
  const group = groupOf(category);

  // The gesture is `categoryDrag.ts`'s, shared with the desk's own piles. This dialog carried its
  // own copy of it from before that module existed; the row and the pile are the same write, so
  // there is one of it now.
  const { attach, over } = useCategoryReorderDrop(category.id, onMoveOnto);
  const { attachSource, attachHandle } = useCategoryDragSource(category.id);

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

  /**
   * The row is both the drag source and the drop target, and since 3b that is two registrations
   * on one element rather than one.
   *
   * **dnd-kit keys its registry by entity id**, and a `Draggable` and a `Droppable` are two
   * registries besides — so unlike `StackView.tsx`, which nests its reorder target in a `<div>` of
   * its own, this row needs no second box. What pragmatic-dnd could not do was put two *drop*
   * targets on one element; that is what the nesting elsewhere is for, and it is not this.
   *
   * React takes one ref per element, so the two callbacks are joined here.
   */
  const attachRow = useCallback(
    (element: HTMLLIElement | null) => {
      const stopSource = attachSource(element);
      const stopTarget = attach(element);
      return () => {
        stopSource?.();
        stopTarget();
      };
    },
    [attachSource, attach],
  );

  return (
    <li
      ref={attachRow}
      className={cn(
        "rounded-md border bg-bg px-2 py-1.5",
        "transition-colors duration-150 motion-reduce:transition-none",
        over ? "border-accent" : "border-border hover:border-accent/60",
      )}
    >
      <div className="flex items-center gap-2.5">
        <button
          ref={attachHandle}
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
          {...tip("Drag to reorder, or press the up and down arrow keys")}
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
 * `DeleteCategory`'s confirm button on the arm that **moves** the cards somewhere: an ordinary
 * affirmative, because that press destroys nothing.
 *
 * It stays in this file rather than joining {@link CONFIRM_DESTRUCTIVE} in `metaRows.tsx` for two
 * reasons, and the second is the stronger. It is one control's second state rather than a shape
 * three sites share — the clear and the label delete have no such arm. And the state is **live**:
 * the reader flips between the two by working the picker above it, so this is not a variant a
 * site picks once at build time.
 *
 * **Above `DeleteCategory`'s own doc rather than between it and the component.** TSDoc attaches a
 * block to the nearest declaration *after* it, so slipping a `const` in between orphaned the
 * component's 27 lines — hovering `DeleteCategory` showed nothing at all — and the sentence that
 * went dark was the `cardCountAllVariants` rule this file's one prohibition exists to protect.
 */
const CONFIRM_MOVING = cn(
  "rounded-md border px-2 py-1 text-xs",
  "transition-colors duration-150 disabled:opacity-50 motion-reduce:transition-none",
  "border-border text-text hover:border-accent hover:text-accent",
  FOCUS,
);

/**
 * Delete a pile, and say which of the two things is about to happen.
 *
 * **This is the one destructive control on this dialog, and the destruction is optional** —
 * `deck_category_delete` takes `moveToCategoryId`, and `null` is the half that takes the cards
 * with the category by cascade. One command rather than two, so a caller cannot lose the cards
 * between a move and a delete that failed; one *question*, for the same reason, with the
 * confirm button's own words changing with the answer. A dialog that said "Delete category" over
 * both outcomes would be a dialog that hid the difference it exists to ask about.
 *
 * An empty category asks nothing — there is nothing to move and nothing to lose.
 *
 * **Exported, and the deck editor is the second host** (2026-08-14). A category heading's
 * right-click offers `Delete…`, and that row must ask the same question in the same words as
 * this dialog does — a second confirmation would be a second chance to get "the cards go with
 * it" wrong. The editor renders it inside a `Dialog` of its own; nothing here assumes the
 * row it was written in, because it draws a self-contained `role="group"` and takes every
 * mutation it needs through `meta`.
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
export function DeleteCategory({
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
  /** `"delete"` or a category id as text — one dropdown value, because the two outcomes are
   *  one decision and a checkbox beside a picker would be two. */
  const [choice, setChoice] = useState<string>(() =>
    // The safe answer is the default: a reader who presses through without reading keeps their
    // cards. Reaching the destructive one takes a deliberate pick.
    others.length > 0 ? String(others[0].id) : "delete",
  );

  // **Deliberately not alphabetical** — one of the exceptions `src/lib/options.ts` names.
  // `others` is this dialog's own list minus this row, in `sort_order`: the order the reader
  // dragged these piles into, on the very screen where they dragged them. Alphabetising it
  // would make the dropdown disagree with the list it sits inside. The destructive answer is
  // pinned **last**, and never first: it must not be what the dropdown opens on.
  const choiceOptions: readonly DropdownOption[] = [
    ...others.map((c) => ({ value: String(c.id), label: `move to “${c.name}”` })),
    // It read `are deleted with it` until schema v25, and that had become the one wrong half of
    // a true sentence: the `deck_cards` rows do go, but the copies the reader physically owns
    // are filed into `Recently removed` rather than destroyed. `go with it` is what is true of
    // both halves, and the sentence below says where the cards themselves end up.
    { value: "delete", label: "go with it" },
  ];

  // The caret moves into the question, as it does for every other layer in this app
  // (`DecksPage`'s `DeleteConfirm`, `FolderTree`'s, both of the deck's meta dialogs). **The
  // row's Delete trigger is `disabled` the moment this opens**, and Chromium blurs a control it
  // disables — so without this the caret is on `<body>` and the next Tab restarts at the top of
  // the document, which is the bug commit `10761c1` fixed for `RenameField`, now in
  // `metaRows.tsx`. The question's own box and not a button in it: the reader has not decided
  // yet, and a stray Enter must not decide for them. That reason is this site's own — the hook
  // carries the mechanism, each site carries why it needs it.
  const confirm = useConfirmFocus(`Delete ${category.name}`);
  // Both lists, because both go. See this component's doc.
  const cards = category.cardCountAllVariants;
  const count = `${cards} ${cards === 1 ? "card" : "cards"}`;
  /** Copies in the list the reader is **not** looking at. `> 0` is exactly the condition for
   *  mentioning the other list at all: a deck with no theory rows in this pile has one list to
   *  talk about, and a sentence about two would be chrome. */
  const elsewhere = cards - category.cardCount;
  const bothLists =
    elsewhere > 0 ? " — that is both the theory and actual lists, not just the one on screen" : "";
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
    <div {...confirm}>
      <p className="text-xs">Delete “{category.name}”?</p>

      {choosing && (
        <div className="mt-1.5 flex items-center gap-2">
          <label
            id={`delete-${category.id}-cards-label`}
            htmlFor={`delete-${category.id}-cards`}
            className="text-[0.6875rem] text-dim"
          >
            Its {count}
          </label>
          <div className="min-w-0 flex-1">
            <Dropdown
              id={`delete-${category.id}-cards`}
              labelledBy={`delete-${category.id}-cards-label`}
              value={choice}
              onChange={setChoice}
              options={choiceOptions}
              size="sm"
              fill
            />
          </div>
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
            ? `The ${count} in it go with it${bothLists}. Any copies you own go back to Recently removed.`
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
          className={losing ? CONFIRM_DESTRUCTIVE : CONFIRM_MOVING}
        >
          {moveTo === null ? `Delete “${category.name}”` : `Move ${count} and delete`}
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
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
 * for — a polite `role="status"`, because this dialog draws no cards and without it there is no
 * way to tell a no-op from a failure. A refusal is news the reader did *not* ask for and has to
 * act on, so it is an `alert`, in the body's own colour for a refused write. It is rendered
 * here rather than through `sectionFailure` because this press is the one whose refusal has a
 * *reach* worth stating — `useDeckMeta` words that sentence, so the hook that decided to move
 * nothing is the thing that says so.
 *
 * **Whether a pile this press empties keeps its heading in the editor behind this dialog depends
 * on who made it**, and that sentence has been through all three answers. It once said the
 * heading always goes; then, when `drawsWhenEmpty` was reversed, that it always stays — a pile
 * the cards left is still the place the next one goes. That argument survives for a pile a
 * *person* made and for the seeded zones, and `origin` is now what tells them apart. The two
 * piles this press is allowed to empty (`useDeckMeta`'s `LOOSE_PILES`) are one of each:
 * `Main deck` is the v8 migration's own pile and keeps its heading, while `Uncategorized` is made
 * by the app filing a card and is therefore `origin: 'auto'` — so emptying it takes its heading
 * off the desk. Nothing is lost either way, and the list above never depended on it at all: it is
 * `deck_category_list` and draws every category a deck has, because this is the surface where a
 * pile is the subject rather than a heading over cards.
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
