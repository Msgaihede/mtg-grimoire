/**
 * A deck's to-do list, read into a tree the home widget can draw and tick.
 *
 * **A to-do is not a note**, and the root `CLAUDE.md`'s four notes are why that sentence is worth
 * writing. A deck's to-do list is one column on the deck (`decks.todos`), edited as one document in
 * the checklist mode of the same editor the deck notes use, and a *to-do* is one line of it — not a
 * row anywhere, with no id, no date and no sync uid. It shares the notes' editor and their inline
 * dialect and nothing else.
 *
 * **This is a reader for Tiptap's own serialization, not a markdown parser**, and the narrow name
 * is `noteMarkdown.ts`' reason carried over. The body is what the task item extension writes:
 * `- [ ] text` and `- [x] text`, each sub-to-do indented under its parent, a hard break as two
 * trailing spaces and the rest of the line on the next. `NoteEditor.test.tsx`'s checklist corpus
 * pins the writing side byte for byte; this file pins the reading side against the same shapes.
 * The inline text goes through `noteMarkdown.ts`' own `parseInlines`, so a to-do and a note are
 * one inline dialect rather than two that agree today.
 *
 * **Depth is compared by width against a stack, never divided out of a constant.** The editor's
 * nesting indent is a setting of the markdown extension (two spaces by default, a tab if anybody
 * changes it) and the implementation task measures it rather than assuming it. A reader that
 * computed `indent / 2` would hold for exactly one answer to that measurement; one that asks "is
 * this line deeper than the open item above it" holds for all of them, and for a body pasted from
 * anywhere else. A tab is measured to its next four-column stop, so a tab and four spaces are one
 * depth.
 *
 * **Nothing is ever dropped for not being understood** — `noteMarkdown.ts`' rule, and the one this
 * file is arranged around. A line with no box reads as an open to-do with its words; a stray
 * paragraph, a thematic break, a bullet somebody typed by hand are all still on screen. No path
 * writes such a line today; the rule exists so that a body from a future build, a sync peer or a
 * paste still shows every line. The one thing that is left out is an **empty** to-do with nothing
 * under it — the editor's placeholder line, which is a place to type rather than a thing to do.
 *
 * **What a to-do is called is its source line.** The widget ticks one by flipping the marker on
 * line `n` of the body it read, and the compare-and-set write is what makes that name safe: a body
 * that moved since is refused rather than guessed at. So {@link toggleTodo} touches that one
 * character and no other byte, and it refuses every line this reader does not draw as a box.
 */
import { HARD_BREAK, inlineText, parseInlines, type Inline } from "./noteMarkdown";

/**
 * One to-do, and the sub-to-dos under it.
 *
 * `line` is the 0-based source line of the item's marker — the name {@link toggleTodo} is handed
 * back. `text` is the plain text, the marks gone; a hard break is a `"\n"` inside it and inside a
 * text run of `inlines`, `noteMarkdown.ts`' convention, so a renderer sets `whitespace-pre-line`
 * or draws the break as a space.
 */
export interface TodoItem {
  done: boolean;
  inlines: Inline[];
  text: string;
  line: number;
  children: TodoItem[];
}

/**
 * A bullet, optionally a box, then the item's text. Group 1 the indent, 2 the box's mark, 3 the
 * text.
 *
 * The box is optional so that a plain bullet is still read as a to-do with its words rather than
 * as one with `- ` glued to the front. `[ \t]+|$` after the bullet is what keeps `**bold**` and
 * `---` from reading as one, and the same after the box is GFM's rule: `[x]glued` is text, not a
 * ticked box. `[\s\S]` rather than a dot, because a dot stops at the line terminators JavaScript
 * counts inside a line and the text would then fail to match at all.
 */
const ITEM = /^([ \t]*)[-*+](?:[ \t]+|$)(?:\[( |x|X)\](?:[ \t]+|$))?([\s\S]*)$/;

/**
 * The same line with the box required — the only lines {@link toggleTodo} will touch.
 *
 * Group 2 is the one character a tick flips. Everything this matches, {@link ITEM} reads as a
 * boxed to-do, and the `(?:[ \t]…)?` after the bracket is what keeps that true of `[x]glued`: a box
 * this file draws as text must never be ticked by the widget that drew it.
 */
const BOXED = /^([ \t]*[-*+][ \t]+\[)( |x|X)(\](?:[ \t][\s\S]*)?)$/;

/** The leading whitespace a depth is measured from. Always matches, if only the empty string. */
const LEAD = /^[ \t]*/;

/** The column a tab advances to the next multiple of — CommonMark's own tab stop. */
const TAB_STOP = 4;

/**
 * What the editor writes for a paragraph with nothing in it, which its own reader reads back as
 * empty — the paragraph extension's marker, entity and character both. Read the same way here, or
 * an emptied to-do would draw as the six characters of an entity and keep a list alive in storage.
 */
const EMPTY_PARAGRAPH = ["&nbsp;", " "];

/** How many columns a run of spaces and tabs occupies, with each tab stopping on a multiple of four. */
function width(indent: string): number {
  let w = 0;
  for (const ch of indent) w = ch === "\t" ? w + TAB_STOP - (w % TAB_STOP) : w + 1;
  return w;
}

/**
 * One source line of an item, and whether the line after it starts on a new row.
 *
 * The break travels with the line before it, `noteMarkdown.ts`' arrangement: consecutive lines are
 * one wrapped sentence unless the reader asked otherwise.
 */
interface Run {
  text: string;
  br: boolean;
}

/** An item as it is being read, before its lines are joined and its empties are dropped. */
interface Draft {
  done: boolean;
  runs: Run[];
  line: number;
  children: Draft[];
}

/**
 * A body → the tree of its to-dos. An empty body answers an empty list.
 *
 * Line-based, with a stack of the items still open for children. A line deeper than the item on
 * top of it is that item's child; a line at the same depth or shallower closes items until one is
 * shallower than it. A line that is not an item continues the item above it when it is indented
 * past that item's marker or when the line before ended in a hard break — the second is how the
 * editor writes a break in a top-level to-do, whose rest of line is not indented at all.
 *
 * @param body the list exactly as `decks.todos` holds it. CRLF is read as LF; nothing is rewritten.
 */
export function parseTodos(body: string): TodoItem[] {
  const roots: Draft[] = [];
  const stack: { indent: number; draft: Draft }[] = [];
  // The line before ended in a hard break, so this one is the rest of it whatever its indent.
  let broke = false;
  // A blank line stands between this line and the last, which inside an item is a second
  // paragraph — drawn as the line break it looks like, since a to-do holds one run of inlines.
  let blank = false;

  body.split("\n").forEach((raw, line) => {
    const src = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (src.trim() === "") {
      broke = false;
      blank = true;
      return;
    }
    // Read before anything trims, because two trailing spaces are a hard break and a trim eats
    // exactly the evidence.
    const br = HARD_BREAK.test(src);
    const indent = width(LEAD.exec(src)?.[0] ?? "");
    const item = ITEM.exec(src);
    const open = stack.length > 0 ? stack[stack.length - 1] : undefined;

    if (!item && open && (indent > open.indent || broke)) {
      const runs = open.draft.runs;
      if (blank) runs[runs.length - 1].br = true;
      runs.push({ text: src, br });
    } else {
      const draft: Draft = {
        done: item?.[2] === "x" || item?.[2] === "X",
        runs: [{ text: item ? item[3] : src, br }],
        line,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
      (parent ? parent.draft.children : roots).push(draft);
      stack.push({ indent, draft });
    }
    broke = br;
    blank = false;
  });

  return finish(roots);
}

/** A run's words: the hard break's marker off its end, the indent off its front. */
function runText(text: string): string {
  const words = text.replace(HARD_BREAK, "").trim();
  return EMPTY_PARAGRAPH.includes(words) ? "" : words;
}

/**
 * An item's runs as one string — a space between them, or a newline after a break.
 *
 * Joined **before** the inlines are read, which is `noteMarkdown.ts`' order and for the same
 * reason: a bold run the reader broke in the middle is one bold run, and reading each line on its
 * own would leave its two halves as stray stars.
 */
function joinRuns(runs: Run[]): string {
  let text = "";
  for (let i = 0; i < runs.length; i += 1) {
    if (i > 0) text += runs[i - 1].br ? "\n" : " ";
    text += runText(runs[i].text);
  }
  return text.trim();
}

/**
 * Drafts → items, children first so an empty item can ask whether anything is under it.
 *
 * An empty to-do is dropped only when it has no children: an emptied parent is still the line its
 * sub-to-dos hang from, and dropping it would lift them a level they were never written at.
 */
function finish(drafts: Draft[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const draft of drafts) {
    const children = finish(draft.children);
    const inlines = parseInlines(joinRuns(draft.runs));
    const text = inlineText(inlines);
    if (text.trim() === "" && children.length === 0) continue;
    out.push({ done: draft.done, inlines, text, line: draft.line, children });
  }
  return out;
}

/**
 * How many to-dos are open and how many done, at every depth.
 *
 * A sub-to-do is a to-do: the count in the band's header and the widget's heading say how much is
 * left to do, and a parent ticked with two open children under it has not got nothing left.
 */
export function countTodos(items: TodoItem[]): { open: number; done: number } {
  let open = 0;
  let done = 0;
  const walk = (level: TodoItem[]): void => {
    for (const item of level) {
      if (item.done) done += 1;
      else open += 1;
      walk(item.children);
    }
  };
  walk(items);
  return { open, done };
}

/**
 * The body with the box on `line` flipped, and not one other byte changed — or `null` when that
 * line has no box to flip.
 *
 * An open box is ticked with a lowercase `x`, which is what the editor writes; a ticked one of
 * either case is opened. A line ending is kept exactly as it was, a trailing `\r` included, so a
 * body written on another platform is not rewritten by a tick. `null` for a line past either end,
 * a line that is not an integer, and every line {@link parseTodos} does not read as a boxed to-do.
 */
export function toggleTodo(body: string, line: number): string | null {
  const lines = body.split("\n");
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
  const raw = lines[line];
  const cr = raw.endsWith("\r") ? "\r" : "";
  const src = cr ? raw.slice(0, -1) : raw;
  const m = BOXED.exec(src);
  if (!m) return null;
  lines[line] = `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}${cr}`;
  return lines.join("\n");
}

/**
 * The to-dos the widget draws, under its two switches. The tree handed in is never changed.
 *
 * With `nested` off, only the top level is drawn and every item's children are dropped. With
 * `showDone` off, a done item is hidden — **unless it still has a visible child**, which it then
 * keeps and is drawn done: a tree must never lose the parent its open sub-to-do sits under, or the
 * sub-to-do reads as a to-do of its own. The two compose in that order, so with sub-to-dos off a
 * done parent is hidden even over an open child, because that child is not drawn either.
 */
export function visibleTodos(
  items: TodoItem[],
  opts: { showDone: boolean; nested: boolean },
): TodoItem[] {
  const out: TodoItem[] = [];
  for (const item of items) {
    const children = opts.nested ? visibleTodos(item.children, opts) : [];
    if (!opts.showDone && item.done && children.length === 0) continue;
    out.push({ ...item, children });
  }
  return out;
}

/**
 * The body as it should be stored: `""` when it holds no to-do, and otherwise exactly as written.
 *
 * An emptied checklist is still one empty item in the editor, and storing that line would keep a
 * deck in the widget's list for ever with nothing to show under it. Anything with a to-do in it is
 * stored byte for byte — the reader's own spacing is theirs, and a normaliser here would be a third
 * place deciding what the dialect looks like.
 */
export function todosText(body: string): string {
  return parseTodos(body).length === 0 ? "" : body;
}
