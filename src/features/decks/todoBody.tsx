/**
 * A deck to-do list's body, drawn — headings, text and to-dos, a box per to-do and one indent per
 * level — with nothing about the card it sits in.
 *
 * ⚠️ **A to-do list is not a note**, and this is not `noteBody.tsx`: it borrows the notes' inline
 * runs (`MarkdownInlines`) and nothing else.
 *
 * **Out of `TodoListCard.tsx` so the phone face can draw a list.** The card reaches the opener
 * plugin through `openExternal`, which the phone face may not import (`mobile/phone/fence.test.ts`);
 * the link's press is a prop now, and so is the tick — the phone's deck page is read-only, and a
 * list it draws must not offer a box that looks pressable.
 */
import { type JSX } from "react";
import { Check } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { MarkdownInlines } from "./noteBody";
import { toggleTodo, type TodoBlock, type TodoItem } from "./todoMarkdown";

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
export function TodoBody({
  blocks,
  body,
  ticking = false,
  onTick,
  onLink,
}: {
  blocks: TodoBlock[];
  body: string;
  /** A tick is in flight, so every box refuses for its length. */
  ticking?: boolean;
  /**
   * Where a ticked box's line goes. **Absent, the list is read-only**: each box is drawn as a
   * picture of its state with the state in words beside it, and nothing about it can be pressed —
   * a checkbox that refuses every press is a control that lies about being one.
   */
  onTick?: (line: number) => void;
  /** What a link does — `MarkdownInlines`' prop, passed through. */
  onLink?: (href: string) => void;
}): JSX.Element {
  if (blocks.length === 0) {
    return <p className="text-[0.6875rem] text-dim">Nothing on this list yet.</p>;
  }
  return (
    // `whitespace-pre-line` is load-bearing: a hard break arrives as a `"\n"` inside a text run,
    // `noteMarkdown.ts`' convention, and under `normal` it would collapse to a space.
    <div className="space-y-1.5 whitespace-pre-line text-xs leading-relaxed text-dim">
      {blocks.map((block, i) => (
        <TodoBlockView
          key={i}
          block={block}
          body={body}
          ticking={ticking}
          onTick={onTick}
          onLink={onLink}
        />
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
  onLink,
}: {
  block: TodoBlock;
  body: string;
  ticking: boolean;
  onTick?: (line: number) => void;
  onLink?: (href: string) => void;
}): JSX.Element {
  if (block.kind === "heading") {
    return (
      <p className={cn("pt-1 first:pt-0", HEADING[block.level])}>
        <MarkdownInlines inlines={block.inlines} onLink={onLink} codeClassName="bg-bg" />
      </p>
    );
  }
  if (block.kind === "text") {
    return (
      <p>
        <MarkdownInlines inlines={block.inlines} onLink={onLink} codeClassName="bg-bg" />
      </p>
    );
  }
  return (
    <TodoItems items={block.items} body={body} ticking={ticking} onTick={onTick} onLink={onLink} />
  );
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
  onLink,
  nested = false,
}: {
  items: TodoItem[];
  body: string;
  ticking: boolean;
  onTick?: (line: number) => void;
  onLink?: (href: string) => void;
  nested?: boolean;
}): JSX.Element {
  return (
    <ul className={cn("space-y-0.5", nested && "mt-0.5 pl-[1.375rem]")}>
      {items.map((item) => (
        <TodoRow
          key={item.line}
          item={item}
          body={body}
          ticking={ticking}
          onTick={onTick}
          onLink={onLink}
        />
      ))}
    </ul>
  );
}

function TodoRow({
  item,
  body,
  ticking,
  onTick,
  onLink,
}: {
  item: TodoItem;
  body: string;
  ticking: boolean;
  onTick?: (line: number) => void;
  onLink?: (href: string) => void;
}): JSX.Element {
  // A line `toggleTodo` will not flip is drawn as a box that can never be ticked — dashed, and
  // refused — rather than as one that silently does nothing. The reader draws every line it
  // understands as a box; this is the belt for a body from somewhere else.
  const boxless = toggleTodo(body, item.line) === null;
  const refused = ticking || boxless;

  return (
    <li>
      <div className="flex items-start gap-2">
        {onTick === undefined ? (
          // Read-only: the box is a picture of the line's state and the state is said in words,
          // since a picture says nothing to a screen reader. The same 14px box and tick as the
          // checkbox below, so a list reads the same whichever face draws it.
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-0.5 flex size-3.5 shrink-0 rounded-[3px] border",
              item.done ? "border-accent bg-accent" : "border-dim",
              boxless && "border-dashed",
            )}
          >
            {item.done && (
              <Check
                strokeWidth={3.5}
                className="absolute inset-0 m-auto size-2.5 text-accent-fg"
              />
            )}
          </span>
        ) : (
          // A real checkbox, `aria-disabled` rather than `disabled` (a `disabled` control leaves
          // the tab order under the reader's caret — `src/CLAUDE.md`), so the handler is the
          // fence and refuses the same states the box draws. Drawn over an `appearance-none`
          // box in `TickBox`'s colours, with the tick a glyph laid over it.
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
        )}
        <span
          className={cn(
            "min-w-0 flex-1 break-words leading-[1.125rem]",
            item.done ? "text-dim line-through" : "text-text",
          )}
        >
          {onTick === undefined && (
            <span className="sr-only">{item.done ? "Done: " : "To do: "}</span>
          )}
          <MarkdownInlines inlines={item.inlines} onLink={onLink} codeClassName="bg-bg" />
        </span>
      </div>
      {item.children.length > 0 && (
        <TodoItems
          items={item.children}
          body={body}
          ticking={ticking}
          onTick={onTick}
          onLink={onLink}
          nested
        />
      )}
    </li>
  );
}
