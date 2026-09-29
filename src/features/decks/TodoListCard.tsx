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
import { Check } from "lucide-react";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import type { DeckTodoList } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useMasonryRowSpan } from "./masonry";
import { RowAction } from "./metaRows";
import type { Inline } from "./noteMarkdown";
import {
  listTitle,
  parseTodoBody,
  toggleTodo,
  type TodoBlock,
  type TodoItem,
} from "./todoMarkdown";

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
        <TodoBody blocks={blocks} body={list.body} ticking={ticking} onTick={onTick} />
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

/** A to-do's checkbox name — the editor's and the widget's words, so a reader driving by voice
 *  says one thing in all three places. Whitespace is collapsed: a hard break is a line on screen,
 *  not in a name. */
export function todoTickName(item: TodoItem): string {
  const text = item.text.replace(/\s+/g, " ").trim() || "empty to-do";
  return `Mark "${text}" ${item.done ? "not done" : "done"}`;
}

/**
 * The body, drawn — or the one sentence an empty list is.
 *
 * **An empty list is a list**, not a failure: New to-do list makes one with a title and nothing
 * under it, so the card says which of the two an empty box is.
 */
function TodoBody({
  blocks,
  body,
  ticking,
  onTick,
}: {
  blocks: TodoBlock[];
  body: string;
  ticking: boolean;
  onTick: (line: number) => void;
}): JSX.Element {
  if (blocks.length === 0) {
    return <p className="text-[0.6875rem] text-dim">Nothing on this list yet.</p>;
  }
  return (
    // `whitespace-pre-line` is load-bearing: a hard break arrives as a `"\n"` inside a text run,
    // `noteMarkdown.ts`' convention, and under `normal` it would collapse to a space.
    <div className="space-y-1.5 whitespace-pre-line text-xs leading-relaxed text-dim">
      {blocks.map((block, i) => (
        <TodoBlockView key={i} block={block} body={body} ticking={ticking} onTick={onTick} />
      ))}
    </div>
  );
}

/**
 * The editor's `PROSE` steps at the card's scale: `h1` and `h2` in the text colour at two sizes,
 * `h3` a step down in weight and dim. Drawn as `<p>` and not as headings — the band has no heading
 * outline for a reader's own `# Mana` to join, and three of them per card would make one.
 */
const HEADING: Record<1 | 2 | 3, string> = {
  1: "text-sm font-semibold text-text",
  2: "text-[0.8125rem] font-semibold text-text",
  3: "text-xs font-medium text-dim",
};

function TodoBlockView({
  block,
  body,
  ticking,
  onTick,
}: {
  block: TodoBlock;
  body: string;
  ticking: boolean;
  onTick: (line: number) => void;
}): JSX.Element {
  if (block.kind === "heading") {
    return (
      <p className={cn("pt-1 first:pt-0", HEADING[block.level])}>
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "text") {
    return (
      <p>
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  return <TodoItems items={block.items} body={body} ticking={ticking} onTick={onTick} />;
}

/**
 * One level of to-dos. A sub-list sits inside its parent's text column — `pl-[1.375rem]` is the
 * box's 14px and the row's 8px gap — so each level's boxes line up under the words of the to-do
 * above them, which is the editor's own arrangement.
 */
function TodoItems({
  items,
  body,
  ticking,
  onTick,
  nested = false,
}: {
  items: TodoItem[];
  body: string;
  ticking: boolean;
  onTick: (line: number) => void;
  nested?: boolean;
}): JSX.Element {
  return (
    <ul className={cn("space-y-0.5", nested && "mt-0.5 pl-[1.375rem]")}>
      {items.map((item) => (
        <TodoRow key={item.line} item={item} body={body} ticking={ticking} onTick={onTick} />
      ))}
    </ul>
  );
}

function TodoRow({
  item,
  body,
  ticking,
  onTick,
}: {
  item: TodoItem;
  body: string;
  ticking: boolean;
  onTick: (line: number) => void;
}): JSX.Element {
  // A line `toggleTodo` will not flip is drawn as a box that can never be ticked — dashed, and
  // refused — rather than as one that silently does nothing. The reader draws every line it
  // understands as a box; this is the belt for a body from somewhere else.
  const boxless = toggleTodo(body, item.line) === null;
  const refused = ticking || boxless;

  return (
    <li>
      <div className="flex items-start gap-2">
        {/* A real checkbox, `aria-disabled` rather than `disabled` (a `disabled` control leaves
            the tab order under the reader's caret — `src/CLAUDE.md`), so the handler is the
            fence and refuses the same states the box draws. Drawn over an `appearance-none`
            box in `TickBox`'s colours, with the tick a glyph laid over it. */}
        <span className="relative mt-0.5 flex size-3.5 shrink-0">
          <input
            type="checkbox"
            checked={item.done}
            aria-label={todoTickName(item)}
            aria-disabled={refused || undefined}
            onChange={() => {
              if (refused) return;
              onTick(item.line);
            }}
            className={cn(
              "peer size-3.5 cursor-pointer appearance-none rounded-[3px] border",
              "border-dim checked:border-accent checked:bg-accent",
              "enabled:hover:border-accent aria-disabled:cursor-default",
              "aria-disabled:hover:border-dim aria-disabled:checked:hover:border-accent",
              boxless && "border-dashed",
              ticking && "opacity-50",
              FOCUS,
            )}
          />
          <Check
            aria-hidden="true"
            strokeWidth={3.5}
            className="pointer-events-none absolute inset-0 m-auto hidden size-2.5 text-accent-fg peer-checked:block"
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 break-words leading-[1.125rem]",
            item.done ? "text-dim line-through" : "text-text",
          )}
        >
          <Inlines inlines={item.inlines} />
        </span>
      </div>
      {item.children.length > 0 && (
        <TodoItems items={item.children} body={body} ticking={ticking} onTick={onTick} nested />
      )}
    </li>
  );
}

/**
 * A line's runs — the notes' five marks and a link, the dialect `noteMarkdown.ts` pins.
 *
 * A link is a button and not an `<a href>`, `NoteCard`'s reason: this window has nowhere to
 * navigate to, and `openExternal` is the one call that leaves it. It is inside the card, so the
 * card's own press stands aside for it (`CONTROLS`).
 */
function Inlines({ inlines }: { inlines: readonly Inline[] }): JSX.Element {
  return (
    <>
      {inlines.map((run, i) => {
        switch (run.kind) {
          case "strong":
            return (
              <strong key={i} className="font-medium text-text">
                {run.text}
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                {run.text}
              </em>
            );
          case "strike":
            return (
              <s key={i} className="line-through">
                {run.text}
              </s>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-bg px-1 py-0.5 font-mono text-[0.95em]">
                {run.text}
              </code>
            );
          case "link":
            return (
              <button
                key={i}
                type="button"
                onClick={() => void openExternal(run.href)}
                className={cn("rounded-sm text-accent underline-offset-2 hover:underline", FOCUS)}
              >
                {run.text}
              </button>
            );
          default:
            return <span key={i}>{run.text}</span>;
        }
      })}
    </>
  );
}
