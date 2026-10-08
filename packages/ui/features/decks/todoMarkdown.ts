/**
 * A deck to-do list's body, read into the blocks a card draws and the tree the home widget ticks.
 *
 * **A to-do is not a note**, and the root `CLAUDE.md`'s notes are why that sentence is worth
 * writing — more so since a list grew a title and a card of its own (#688), which is exactly the
 * shape a deck note has. A deck to-do list is a row of `deck_todo_lists` with a title and a body,
 * edited in the checklist mode of the same editor the deck notes use, and a *to-do* is one line of
 * that body — not a row anywhere, with no id, no date and no sync uid. It shares the notes' editor,
 * their inline dialect and their card's look, and nothing else.
 *
 * **A body is a document now, not a checklist.** #672 made every line a to-do: a list was one task
 * list, and a line with no box was read as an open to-do with its words, because nothing the
 * editor wrote could be anything else. #688 reversed that — the editor holds headings and
 * paragraphs beside any number of task lists — so {@link parseTodoBody} answers three kinds of
 * {@link TodoBlock}: a `heading` (`#` to `###`), `text` (a paragraph), and `todos` (one task list,
 * as the tree #672 read). **A #672 body reads exactly as it did**: every line of it is an item, so
 * it is one `todos` block holding the same tree, and {@link parseTodos} — every list's items
 * concatenated — answers it byte for byte what it always answered. The one expectation that moved
 * is the stray line: an unindented line that is neither an item nor the rest of one is **text**
 * now, where #672 drew it as an open to-do.
 *
 * **This is a reader for Tiptap's own serialization, not a markdown parser**, and the narrow name
 * is `noteMarkdown.ts`' reason carried over. The body is what the editor writes: blocks separated
 * by one blank line, `# `/`## `/`### ` headings, paragraphs, and task lists of `- [ ] text` and
 * `- [x] text` with each sub-to-do indented under its parent. `NoteEditor.test.tsx`'s checklist
 * corpus pins the writing side byte for byte; this file pins the reading side against the same
 * shapes. The inline text goes through `noteMarkdown.ts`' own `parseInlines`, so a to-do, a line
 * of text and a note are one inline dialect rather than three that agree today — and that is also
 * where the **escape** is read: a paragraph the reader typed as `- [ ] literal` is written
 * `\- \[ \] literal` (the brackets escaped too — measured, `NoteEditor.test.tsx` pins it), which no
 * item rule matches, and whose backslashes `parseInlines` takes off. The
 * same goes for a leading `\*`, `\+` and `\#`, so a paragraph that only *looks* like a to-do or a
 * heading is drawn as the words the reader typed.
 *
 * **Continuation still wins over text.** A line that is not an item continues the open item above
 * it when it is indented past that item's marker, or when the line before it ended in a hard
 * break — the second is how the editor writes a break in a top-level to-do, whose rest of line is
 * not indented at all. Only a line that does neither is text. A heading or a line of text closes
 * every open item, so an item after it starts a new list, however deep it is indented.
 *
 * **Depth is compared by width against a stack, never divided out of a constant.** The editor's
 * nesting indent is a setting of the markdown extension (two spaces by default, a tab if anybody
 * changes it). A reader that computed `indent / 2` would hold for exactly one answer to that
 * question; one that asks "is this line deeper than the open item above it" holds for all of them,
 * and for a body pasted from anywhere else. A tab is measured to its next four-column stop, so a
 * tab and four spaces are one depth.
 *
 * **Nothing is ever dropped for not being understood** — `noteMarkdown.ts`' rule, and the one this
 * file is arranged around. It held under #672 by reading an unknown line as a to-do; it holds now
 * by reading it as text, so a thematic break, a `#hashtag` or a line pasted from anywhere is still
 * on the card. What *is* left out is only what the editor writes for **nothing**:
 * an empty to-do with nothing under it (a place to type rather than a thing to do), a list with no
 * to-do left in it, and an empty paragraph or heading.
 *
 * **What a to-do is called is its source line.** The widget and the card tick one by flipping the
 * marker on line `n` of the body they read, and the compare-and-set write is what makes that name
 * safe: a body that moved since is refused rather than guessed at. So {@link toggleTodo} touches
 * that one character and no other byte, and it refuses every line this reader does not draw as a
 * box — a heading, a line of text and an escaped `\- [ ]` among them.
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
 * One block of a to-do list's body, in the order it was written.
 *
 * `heading` and `text` carry the 0-based source line they start on, for a key and nothing else —
 * neither can be ticked. `todos` is one task list, and its items carry their own lines. **Three
 * kinds because the editor writes three** (`(paragraph | heading | taskList)+`); a construct
 * outside them reads as `text`, which is the *nothing dropped* rule rather than a fourth kind.
 */
export type TodoBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[]; text: string; line: number }
  | { kind: "text"; inlines: Inline[]; text: string; line: number }
  | { kind: "todos"; items: TodoItem[] };

/**
 * What a list with no title is drawn as — the band's card, the dialog, the widget's subheading.
 *
 * One constant so that three surfaces cannot come to say it three ways. It is a **display**
 * answer and never stored: an untitled list is `title = ''` in `deck_todo_lists`, and a reader who
 * later types a title replaces nothing.
 */
export const UNTITLED_LIST = "Untitled list";

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

/**
 * `#` to `######`, then whitespace and the heading's words — or nothing, CommonMark's empty
 * heading. Group 1 the hashes, 2 the words. **Everything past the third is drawn as the third.**
 *
 * `noteMarkdown.ts`' rule and its reason, which the plan for this dialect first got wrong (it read
 * `#### x` as text): the toolbar offers `H1`–`H3`, but a heading's `levels` bound Tiptap's input
 * rules and not its schema, so a pasted `#### four` survives in the body and the editor draws it as
 * a third-level heading. Reading it as text would put `#### four`, hashes and all, on the card
 * beside an editor drawing a heading — the revision `noteMarkdown.ts` records trying and undoing.
 * The space after the hashes is what keeps `#hashtag` text, and ` {0,3}` is CommonMark's indent
 * allowance: four spaces in is not a heading.
 */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/;

/** The leading whitespace a depth is measured from. Always matches, if only the empty string. */
const LEAD = /^[ \t]*/;

/** The column a tab advances to the next multiple of — CommonMark's own tab stop. */
const TAB_STOP = 4;

/**
 * What the editor writes for a paragraph with nothing in it, which its own reader reads back as
 * empty — the paragraph extension's marker, entity and character both. Read the same way here, or
 * an emptied to-do or paragraph would draw as the six characters of an entity and keep a list
 * alive in storage. The character is spelled as an escape because a literal no-break space is
 * invisible in source and one rewrite of this file already turned it into a plain space.
 */
const EMPTY_PARAGRAPH = ["&nbsp;", "\u00a0"];

/** How many columns a run of spaces and tabs occupies, with each tab stopping on a multiple of four. */
function width(indent: string): number {
  let w = 0;
  for (const ch of indent) w = ch === "\t" ? w + TAB_STOP - (w % TAB_STOP) : w + 1;
  return w;
}

/**
 * One source line of an item or a paragraph, and whether the line after it starts on a new row.
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

/** A block as it is being read — a paragraph can still grow, a list can still take items. */
type DraftBlock =
  | { kind: "heading"; level: 1 | 2 | 3; source: string; line: number }
  | { kind: "text"; runs: Run[]; line: number }
  | { kind: "todos"; roots: Draft[] };

/**
 * A body → its blocks, in the order they were written. An empty body answers an empty list.
 *
 * Line-based, with a stack of the items still open for children and at most one paragraph still
 * open for lines. Each non-blank line is tried in this order, and the order is the rule:
 *
 * 1. **An item** (#672's {@link ITEM}) joins the list the last block is, or starts a new one if the
 *    last block is a heading or text. A line deeper than the item on top of the stack is that
 *    item's child; one at the same depth or shallower closes items until one is shallower than it.
 * 2. **The rest of an open item** — indented past its marker, or after a hard break. #672's rule,
 *    unchanged, which is why it is tried before anything that could read the line as text.
 * 3. **The rest of a paragraph after a hard break**, whatever it starts with — the same rule one
 *    block over, so a broken line of text is not split into a paragraph and a heading.
 * 4. **A heading**, which closes the stack and the paragraph. It interrupts a paragraph, as
 *    CommonMark's does.
 * 5. **Text**, which closes the stack and extends the open paragraph or starts one. Consecutive
 *    lines are one paragraph, joined with a space; a blank line ends it.
 *
 * A blank line ends a paragraph and nothing else: inside an item it is a second paragraph (drawn
 * as the line break it looks like), and between two items it leaves them one list — the editor
 * joins adjacent task lists, so a blank between items is not two lists' worth of anything.
 *
 * @param body the list exactly as `deck_todo_lists.body` holds it. CRLF is read as LF; nothing is
 *   rewritten.
 */
export function parseTodoBody(body: string): TodoBlock[] {
  const blocks: DraftBlock[] = [];
  const stack: { indent: number; draft: Draft }[] = [];
  // The paragraph a text line would join, or undefined once a blank line or another block has
  // closed it. The same array as the `runs` of the block it belongs to, so pushing here grows it.
  let paragraph: Run[] | undefined;
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
      paragraph = undefined;
      return;
    }
    // Read before anything trims, because two trailing spaces are a hard break and a trim eats
    // exactly the evidence.
    const br = HARD_BREAK.test(src);
    const indent = width(LEAD.exec(src)?.[0] ?? "");
    const item = ITEM.exec(src);
    const open = stack.length > 0 ? stack[stack.length - 1] : undefined;

    if (item) {
      paragraph = undefined;
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
      let list: { kind: "todos"; roots: Draft[] };
      if (last?.kind === "todos") {
        list = last;
      } else {
        list = { kind: "todos", roots: [] };
        blocks.push(list);
      }
      const draft: Draft = {
        done: item[2] === "x" || item[2] === "X",
        runs: [{ text: item[3], br }],
        line,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
      (parent ? parent.draft.children : list.roots).push(draft);
      stack.push({ indent, draft });
    } else if (open && (indent > open.indent || broke)) {
      const runs = open.draft.runs;
      if (blank) runs[runs.length - 1].br = true;
      runs.push({ text: src, br });
    } else if (paragraph && broke) {
      paragraph.push({ text: src, br });
    } else {
      // Anything past the two continuation rules closes every open item: an item after this
      // block starts a list of its own, however deep it is indented.
      stack.length = 0;
      const heading = HEADING.exec(src);
      if (heading) {
        paragraph = undefined;
        const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
        blocks.push({ kind: "heading", level, source: heading[2] ?? "", line });
      } else if (paragraph) {
        paragraph.push({ text: src, br });
      } else {
        paragraph = [{ text: src, br }];
        blocks.push({ kind: "text", runs: paragraph, line });
      }
    }
    broke = br;
    blank = false;
  });

  return finishBlocks(blocks);
}

/**
 * A body → the tree of its to-dos: every list's top-level items, in order, concatenated.
 *
 * The widget, the band's count and {@link countTodos} read this and not the blocks, because a
 * to-do's text around it changes nothing about how much is left to do. For a #672 body — one
 * list, no text — it is the tree it always was.
 */
export function parseTodos(body: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const block of parseTodoBody(body)) {
    if (block.kind === "todos") items.push(...block.items);
  }
  return items;
}

/**
 * Whether a list says nothing at all: no title once trimmed, and no block in its body.
 *
 * **The dialog's _closed untouched creates nothing_ test**, and the two halves are why it takes
 * both arguments: a list with only a title is a list (the reader named it and will fill it later),
 * and so is a list with only text. A body of the editor's lone empty to-do — what an untouched
 * dialog holds — has no block, so it is blank.
 */
export function isBlankList(title: string, body: string): boolean {
  return title.trim() === "" && parseTodoBody(body).length === 0;
}

/** A list's title as it is drawn: trimmed, or {@link UNTITLED_LIST} when nothing is left. */
export function listTitle(title: string): string {
  return title.trim() || UNTITLED_LIST;
}

/** A run's words: the hard break's marker off its end, the indent off its front. */
function runText(text: string): string {
  const words = text.replace(HARD_BREAK, "").trim();
  return EMPTY_PARAGRAPH.includes(words) ? "" : words;
}

/**
 * Runs as one string — a space between them, or a newline after a break.
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
 * Draft blocks → blocks, each emptied block dropped.
 *
 * **Emptiness is asked of the words, after the marks are read** — a paragraph of `&nbsp;` is the
 * editor's empty line and a heading of nothing is a place a heading was started, and neither says
 * anything a card could draw. A list is dropped only when {@link finish} leaves no item in it,
 * which is the editor's lone empty to-do and nothing else.
 */
function finishBlocks(drafts: DraftBlock[]): TodoBlock[] {
  const out: TodoBlock[] = [];
  for (const draft of drafts) {
    if (draft.kind === "todos") {
      const items = finish(draft.roots);
      if (items.length > 0) out.push({ kind: "todos", items });
      continue;
    }
    const source = draft.kind === "heading" ? runText(draft.source) : joinRuns(draft.runs);
    const inlines = parseInlines(source);
    const text = inlineText(inlines);
    if (text.trim() === "") continue;
    out.push(
      draft.kind === "heading"
        ? { kind: "heading", level: draft.level, inlines, text, line: draft.line }
        : { kind: "text", inlines, text, line: draft.line },
    );
  }
  return out;
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
 * A sub-to-do is a to-do: the count on a card and the widget's heading say how much is left to
 * do, and a parent ticked with two open children under it has not got nothing left.
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
 * a line that is not an integer, and every line {@link parseTodoBody} does not read as a boxed
 * to-do — a heading, a line of text and the escaped `\- [ ]` of a paragraph among them.
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
 * Whether an item line holds no words — nothing after its box, or only the editor's
 * empty-paragraph marker. `trim` takes the marker's no-break-space spelling with the rest of the
 * whitespace; the entity spelling is named.
 */
function emptyItem(line: string): boolean {
  const item = ITEM.exec(line);
  if (!item) return false;
  const words = item[3].trim();
  return words === "" || EMPTY_PARAGRAPH.includes(words);
}

/**
 * A body with nothing taken out of it but what cannot change what it says: every `\r`, the
 * whitespace at the end of each line, the blank lines at the end of the body, and **every empty
 * to-do with nothing under it** — an item line with no words ({@link emptyItem}) whose next
 * non-blank line is not indented deeper. Read from the end, so the line tested against is the next
 * one *kept*: an emptied parent whose only sub-to-do was itself empty goes too, as `parseTodoBody`
 * drops it. **An empty paragraph goes too** — a line that is only the editor's `&nbsp;` marker,
 * which is what Enter on an empty top-level to-do leaves behind — and so a run of blank lines reads
 * as one, since the marker's own line leaves two blanks where there was one: neither changes a word
 * the reader sees, and both would otherwise move the list's `updated_at` over a caret that merely
 * passed through. **Text and headings with words are left exactly as written.** Everything else is
 * the body's own text, character for character.
 */
function normalised(body: string): string {
  const lines = body.replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
  const kept: string[] = [];
  // The indent of the next line kept below this one, or `null` while there is none.
  let below: number | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === "" || (!ITEM.test(line) && EMPTY_PARAGRAPH.includes(line.trim()))) {
      if (kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    const indent = width(LEAD.exec(line)?.[0] ?? "");
    if (emptyItem(line) && (below === null || below <= indent)) continue;
    kept.push(line);
    below = indent;
  }
  return kept.reverse().join("\n").replace(/\n+$/, "");
}

/**
 * Whether two bodies say the same thing: equal once each is {@link normalised} — **a string
 * comparison, and lossless everywhere but the handful of differences that function names**.
 *
 * **The one that matters is an empty to-do with nothing under it**: the line New to-do appends and
 * Enter after the last line makes, which is a place to type rather than a thing to do. The autosave
 * asks this rather than comparing bytes before it writes, because a write for that line alone
 * would move the list's and the deck's `updated_at` — and with them *Last edited* in the widget
 * and the gallery — over a change nothing reads. The rest it lets differ is as invisible: line
 * endings, trailing whitespace, trailing blank lines.
 *
 * ⚠️ **Never compare what {@link parseTodoBody} reads instead**, which this did for one review
 * round. Its inlines are lossy on purpose — `noteMarkdown.ts`' reader drops a mark nested inside
 * another and reads a link with no scheme as plain text — so `**a *b***` against `**a b**`, or two
 * links that differ only in their address, read as one body, and the edit was never sent: it
 * vanished at the next remount. The editor writes exactly those shapes.
 */
export function sameTodos(a: string, b: string): boolean {
  return a === b || normalised(a) === normalised(b);
}
