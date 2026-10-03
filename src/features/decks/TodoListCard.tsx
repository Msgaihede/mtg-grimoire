/**
 * One deck to-do list, drawn as a card in the To-do band's grid (issue #688).
 *
 * ⚠️ **Still not a note.** A to-do list has a title, a body and a card, which is exactly the shape a
 * deck note has — so this file borrows `NoteCard`'s *frame* (the surface box, the title at its
 * weight, `Edit` and `Delete` as `RowAction`s, the masonry span) and nothing else. It is not
 * `NoteCard` itself: that one draws card art, a strip of the cards a note names and a reorder grip,
 * and a list has none of the three.
 *
 * **Read-only prose, tickable boxes.** The body is `parseTodoBody`'s blocks drawn with no editor —
 * headings and text in the editor's own `PROSE` steps, to-dos as the widget draws them (a box, the
 * words, one indent per level, a done line struck through). A box ticks **in place**: the card
 * hands the line up and the band writes it through the list's compare-and-set, so a card never
 * owns a draft and never races the dialog that does.
 *
 * **Nothing here imports `NoteEditor`**, statically or otherwise — `DeckNotesPanel.test.tsx`
 * sweeps `src/` for a static import of it, a type-only one included. `Edit`, and a press on the
 * card outside a control, report upward and the band opens the dialog that holds the lazy editor.
 */
import { useCallback, useMemo, type JSX, type MouseEvent } from "react";
import { openExternal } from "@/lib/externalLinks";
import type { DeckTodoList } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useMasonryRowSpan } from "./masonry";
import { RowAction } from "./metaRows";
import { listTitle, parseTodoBody } from "./todoMarkdown";
import { TodoBody } from "./todoBody";

// The body moved to `todoBody.tsx` so the phone face can draw a list without the opener plugin;
// re-exported so every importer of the box's name from here is unchanged.
export { todoTickName } from "./todoBody";

/** The gutter between two cards, in pixels — `NoteCard`'s `NOTE_GAP`, so the two bands stacked
 *  one above the other are spaced by one number. */
export const TODO_LIST_GAP = 8;

/**
 * The card's own element, for a test or a live pass to address — the list id is its value.
 *
 * A card has no role of its own worth querying by (it is a `listitem`, and so is every to-do in
 * it), so without a handle *"the cards are in `sortOrder`"* could only be asserted through the
 * names of the controls on them.
 */
export const TODO_LIST_ATTR = "data-todo-list";

export interface TodoListCardProps {
  list: DeckTodoList;
  /** A tick on **this** card is on the wire. Every box on it is `aria-disabled` meanwhile, because
   *  a second tick would be sent against a body the first one is about to change. */
  ticking: boolean;
  /** A box was pressed — the source line of its to-do, `toggleTodo`'s name for it. */
  onTick: (line: number) => void;
  /** `Edit`, or a press on the card outside any control. */
  onEdit: () => void;
  onDelete: () => void;
}

/** What a press anywhere on the card must leave alone: the controls drawn inside it. */
const CONTROLS = "button, input, a, [role=button], [role=checkbox]";

export function TodoListCard({
  list,
  ticking,
  onTick,
  onEdit,
  onDelete,
}: TodoListCardProps): JSX.Element {
  const title = listTitle(list.title);
  const blocks = useMemo(() => parseTodoBody(list.body), [list.body]);
  const { elementRef, span } = useMasonryRowSpan(TODO_LIST_GAP);

  const attach = useCallback(
    (element: HTMLLIElement | null) => {
      elementRef.current = element;
    },
    [elementRef],
  );

  /**
   * A press on the card opens it — **a pointer convenience, and `Edit` is the whole of the
   * keyboard's route**, which is why the card itself takes no tab stop: a `<li>` holding boxes,
   * links and two buttons cannot also be a button.
   *
   * Two presses are not an open: one that landed on a control inside the card (that control has
   * answered it), and one that ended a text selection — the band is `select-text`, and a reader
   * dragging out a line to copy it has not asked for a dialog.
   */
  const pressCard = (event: MouseEvent<HTMLLIElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest(CONTROLS) !== null) return;
    const selection = window.getSelection?.();
    if (
      selection !== null &&
      selection !== undefined &&
      selection.toString() !== "" &&
      selection.anchorNode !== null &&
      event.currentTarget.contains(selection.anchorNode)
    ) {
      return;
    }
    onEdit();
  };

  return (
    <li
      ref={attach}
      {...{ [TODO_LIST_ATTR]: list.id }}
      onClick={pressCard}
      style={span === null ? undefined : { gridRow: `span ${span}` }}
      // `NoteCard`'s frame, less its drag marks. `min-h-*` is a floor on a grid item, never a
      // ceiling (its `height` stays `auto`), so a long list is as long as it is.
      className={cn(
        "flex min-h-[8rem] cursor-pointer flex-col gap-1.5 rounded-lg border border-border",
        "bg-surface px-3 py-2.5 transition-colors duration-150 hover:border-dim/60",
        "motion-reduce:transition-none",
      )}
    >
      <span className="min-w-0 truncate text-[0.8125rem] font-medium text-text">{title}</span>

      <div className="min-h-0 flex-1">
        <TodoBody
          blocks={blocks}
          body={list.body}
          ticking={ticking}
          onTick={onTick}
          onLink={openLink}
        />
      </div>

      <div className="flex items-center justify-end gap-2.5">
        <RowAction onClick={onEdit}>{actionLabel("Edit", title)}</RowAction>
        <RowAction onClick={onDelete} destructive>
          {actionLabel("Delete", title)}
        </RowAction>
      </div>
    </li>
  );
}

/**
 * A title folded into a verb for a control's name — `NoteCard`'s `actionLabel`, for its reason:
 * a bare text node beside an `sr-only` span, never two elements, or name computation trims each
 * and reads `EditGroceries`.
 */
function actionLabel(verb: string, rest: string): JSX.Element {
  return (
    <>
      {verb} <span className="sr-only">{rest}</span>
    </>
  );
}

/**
 * A line's link, on the desktop: a button that leaves through `openExternal`, `NoteCard`'s reason —
 * this window has nowhere to navigate to. It is inside the card, so the card's own press stands
 * aside for it (`CONTROLS`). Handed to {@link TodoBody} rather than imported by it, because the
 * body is also drawn by the phone face, which may not reach the opener plugin.
 */
function openLink(href: string): void {
  void openExternal(href);
}
