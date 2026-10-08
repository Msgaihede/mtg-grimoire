/**
 * The rich-text editor a deck note is written in — Tiptap 3 over one pinned CommonMark dialect.
 *
 * **A default export, because nothing imports this eagerly.** It is reached only through
 * `React.lazy`, and that is not a style preference: `@tiptap/react` + `@tiptap/starter-kit` +
 * `@tiptap/markdown` measured **141.5 kB gzip** against the app's own 481.45 kB
 * (`esbuild --bundle --minify`, React external, `gzip -9`, 2026-09-10). A single static import
 * anywhere on a path the deck editor mounts puts all of it back in the main chunk, and **nothing
 * goes red** when it happens — the bundle simply gets a third bigger.
 *
 * ⚠️ **That measurement names three packages and this file imports four, and the *premise* is
 * what needed correcting rather than the figure.** `@tiptap/extensions` arrived with
 * {@link Placeholder} on 2026-09-20 and is **not** a fourth download: `@tiptap/starter-kit`
 * already depends on it and already pulls it into the graph, so what the named import adds is
 * that one extension's own code — **12–15 bytes gzip**, measured 2026-09-21, which is inside the
 * rounding on 141.5. So 141.5 kB remains the number to quote, and the sentence above remains the
 * reason this module is lazy.
 *
 * **`@tiptap/extension-list` is a fifth on the same terms** (2026-09-29, the checklist below):
 * `@tiptap/starter-kit` already depends on it at the same version — its bullet list, list item
 * and list keymap live there — so it was in the graph before it was named, and `package.json`
 * declares it only so the import is not reaching into another package's transitive tree. What
 * naming it adds is `TaskList` and `TaskItem`'s own code, which was **not measured**; nothing
 * here claims a figure for it.
 *
 * **This is the canonical site for that figure.** It is repeated at roughly fifteen other call
 * sites and across the specs and plans — `grep -rn "141.5" packages/ui/ docs/` is the census — and none
 * of them is wrong, so none of them was rewritten: a prose-only sweep routes to neither CI job
 * and would be fifteen chances to introduce a disagreement over a number nobody disputes.
 *
 * ## The dialect is the contract, not a starting point
 *
 * There are two renderers for a note body and only one of them is this file. The band's list, the
 * card menu's submenu and the card modal's overlay all render **read-only**, through
 * `noteMarkdown.ts`'s small closed AST, because mounting a ProseMirror instance per note to read
 * one would be absurd. So every construct this editor can emit is a construct that reader needs a
 * rule for, and a construct it has no rule for falls through to a literal paragraph — the reader's
 * own sentence typed back at them with its markup showing.
 *
 * That is why {@link NOTE_EXTENSIONS} names **every** StarterKit option, including the ones set to
 * `false`. A default that changes in a minor release is a construct that silently enters the
 * dialect on one side only. `NoteEditor.test.tsx` holds the committed corpus and asserts that
 * Tiptap's markdown out is byte-identical to the markdown in for each of them.
 *
 * **There is a second dialect since 2026-09-29, and it has a second reader.** `mode="checklist"`
 * edits a deck's to-do list with {@link CHECKLIST_EXTENSIONS} — a **to-do document**: paragraphs
 * and headings beside any number of task lists (issue #688; it was one task list and nothing else
 * under #672) — and `todoMarkdown.ts` reads those bodies for the band's cards and the home widget
 * without an editor either. So the test file holds a second committed corpus, and asserts both
 * halves against it: the editor's round trip byte for byte, and that reader's tree for the same
 * body.
 *
 * ## Two things the CSP decides, and both fail silently if you get them wrong
 *
 * **The stylesheet is imported so Vite bundles it**, never injected at runtime. The shipped policy
 * is `style-src 'self'`; the dev policy adds `style-src 'unsafe-inline'`, so a runtime stylesheet
 * would work perfectly under `npm run tauri dev` and do nothing at all in a built binary. That is
 * exactly how `motion`'s two forbidden APIs fail here. `prosemirror-view` was read on 2026-09-10
 * and appends nothing to the document's head — its only `styleSheets` reference is inside
 * `readHTML`, against a *detached* document while parsing pasted clipboard HTML — and the inline
 * `style` attributes it does set are covered by the policy's `style-src-attr 'unsafe-inline'`.
 * (Spelled that way round on purpose: the sweep in `NoteEditor.test.tsx` reads this file as text,
 * so a doc comment naming the property would fail it. `motion.ts` spells `<style>` without its
 * angle bracket for the same reason.)
 *
 * ⚠️ **`prosemirror-view` was the wrong library to have read, and the paragraph above was true of
 * it while the editor injected a sheet anyway** (found 2026-10-04, on the live web app). Tiptap's
 * own editor class appends a style element of its own to the page's head as each view is built,
 * unless its `injectCSS` option is off — and it is on by default. Every shipped host refused it:
 * one `style-src-elem` violation and one console error **per editor built**, since the element
 * is taken away with the last editor and made again for the next. Measured in the packaged
 * desktop window that day (a `--debug` build, which enforces the shipped policy): the element's
 * `sheet` was `null`, and the surface computed `white-space: break-spaces` and
 * `position: relative` regardless — from the import below, which is why nobody had seen it.
 *
 * **So the option is off, and nothing was added in the refused sheet's place.** It is
 * ProseMirror's base rules over again, plus three things the import does not carry, each
 * measured in that window rather than assumed: a `white-space: normal` on non-editable islands
 * (a to-do's box and its delete button hold no whitespace to collapse — all 22 rectangles of a
 * nested list were identical with and without it); the gap cursor's drawing (no position in
 * either dialect can hold one — `NoteEditor.test.tsx` sweeps both corpora and goes red when that
 * stops being true); and a zero size on ProseMirror's separator image, which is 0 × 0 here
 * without it. `packages/ui/lib/tokens.test.ts` refuses an editor built with the option left on, anywhere
 * in the app. [light-app.md](../../../../docs/reference/light-app.md) §9.7 has the day.
 *
 * **Every hint is `useTooltip()`'s spread and never a `title`**, which matters more here than on
 * an ordinary row: the toolbar is icon-only, so the hint is the whole of what a pointer gets. The
 * checklist's per-row delete button is the one control here that binds none, and not by choice:
 * it is plain DOM inside a ProseMirror node view, where no hook can run — so it carries no
 * `title` either, and its `aria-label` is the whole of its name.
 */
import "prosemirror-view/style/prosemirror.css";

import Heading, { type Level } from "@tiptap/extension-heading";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  Extension,
  mergeAttributes,
  // `TiptapNode` because the bare name would shadow the DOM's own `Node`, which the checklist's
  // node view needs for `contains()`.
  Node as TiptapNode,
  useEditor,
  useEditorState,
  type ChainedCommands,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Strikethrough,
  TextQuote,
  Unlink,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { PRESS, PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The three heading levels the dialect has. Written once: the node is configured with it and
 *  {@link NoteHeading} clamps against it. */
const HEADING_LEVELS: Level[] = [1, 2, 3];

/**
 * `Heading`, drawing anything deeper than the dialect's own levels at the deepest one it has.
 *
 * ⚠️ **`levels` bounds the keyboard and the parser, not the `level` attribute** — so a body a
 * reader *pasted* can hold a `#### four`, and the stock `renderHTML` draws an out-of-range level
 * as `levels[0]`, which here is **`h1`**. That is the largest heading on the screen, for the one
 * construct the dialect does not have. Found from the read-only renderer's side on 2026-09-10:
 * `parseNoteBody` clamps the same body to level **3**, so one note drew as a title while being
 * edited and as the smallest heading while being read.
 *
 * **The fix is in the drawing and deliberately not in the document.** Clamping on *parse* would
 * mean this editor silently rewriting text a reader pasted, which is the one thing a note editor
 * must not do. `renderMarkdown` reads `node.attrs.level` directly and never asks `renderHTML`, so
 * overriding the latter moves what is on screen and leaves the serialized body untouched:
 * `#### four` still round-trips byte for byte, and both surfaces now draw it at level 3.
 *
 * `some(...)` rather than `includes(...)` so a plain `number` needs no cast to `Level`, and
 * `Math.max` rather than a literal `3` so the clamp cannot come apart from
 * {@link HEADING_LEVELS} above it.
 */
const NoteHeading = Heading.extend({
  renderHTML({ node, HTMLAttributes }) {
    const level = Number(node.attrs.level);
    const drawn = this.options.levels.some((allowed) => allowed === level)
      ? level
      : Math.max(...this.options.levels);
    return [`h${drawn}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

/**
 * What an empty surface says, and **the only teaching left in the create flow**.
 *
 * The redesign deleted the title field: a note is written with `title: ""` and `noteTitle()`
 * answers the body's first line. That rule is invisible unless something says it, and the one
 * place a reader is looking when it matters is the empty box they are about to type in.
 */
export const NOTE_PLACEHOLDER = "Start typing. The first line becomes the title.";

/**
 * The whole dialect, spelled out — **including every option that is off**.
 *
 * The list is the same one `noteMarkdown.ts` reads and `docs/superpowers/specs/…-deck-notes-design.md`
 * §6 pins: document, paragraph, text, bold, italic, strike, code, headings 1–3, bullet and ordered
 * lists, list items, blockquote, hard break, link. Nothing else, and the `false`s are written out
 * rather than left to the defaults for the reason the module header gives.
 *
 * Four of them turn a node or a mark off and each would be a construct the reader could not draw:
 * `codeBlock` (fenced blocks), `horizontalRule`, `underline` (a mark with no CommonMark spelling at
 * all, which would serialise as HTML) and `trailingNode` — that last one is the subtle one, because
 * it is not a construct a reader types: it keeps an empty paragraph pinned at the end of the
 * document, which comes back out as trailing blank lines and makes the round trip fail on every
 * body at once.
 *
 * The three that stay on and are *not* in the dialect list are behaviour rather than schema:
 * `undoRedo` is Ctrl+Z, `listKeymap` is Enter and Backspace inside a list, and `gapcursor` is on
 * only because it cannot be named (below). None of them can put a node or a mark into a body.
 * `dropcursor` is off because dragging inside a note is not a gesture this app offers.
 *
 * ⚠️ **`gapcursor` does nothing in this dialect, and this paragraph claimed otherwise until
 * 2026-10-04** — that it "is how a caret gets past a blockquote that is the last thing in the
 * document". It is not: a gap cursor stands only beside a *closed* node (an atom, an isolating
 * node, an empty one), and a quote ends in a paragraph a real caret can enter. Driven in the
 * packaged window that day, neither ArrowDown nor ArrowRight at the end of a trailing quote made
 * one; the way out of a quote is Enter on its empty last line. `NoteEditor.test.tsx` asks the
 * library's own validity rule of every position in both corpora and finds none — which is also
 * why the app bundles no rule to draw one.
 *
 * **A fourth behaviour extension is added below rather than configured in there**, because it is
 * not a StarterKit option: {@link Placeholder}, which paints the empty surface's prompt. The
 * sentence above holds unchanged — it can put no node and no mark into a body either, so the
 * dialect and `noteMarkdown.test.ts`' round trip are untouched by it.
 *
 * ⚠️ **Four of the dialect's members cannot be named here at all, and that is a type fact rather
 * than an omission.** `StarterKitOptions` types `document`, `text` and `gapcursor` as literally
 * `false` — the only thing sayable about them is "off" — so *on* is spelled as absence, and
 * `listItem` is carried in by `bulletList`/`orderedList` needing something to hold. A future
 * reader adding `document: {}` back gets a compile error, not a dialect change.
 *
 * **`link` comes from StarterKit itself in v3** rather than as a separate import, which is the
 * same extension either way and one fewer package to keep in step.
 */
export const NOTE_EXTENSIONS = [
  StarterKit.configure({
    // In the dialect. `document`, `text` and `gapcursor` are on by being absent — see above.
    paragraph: {},
    bold: {},
    italic: {},
    strike: {},
    code: {},
    // Off here and added below as {@link NoteHeading} — the only way to reach its `renderHTML`,
    // since StarterKit builds its own copy of the node and hands out no handle to it.
    heading: false,
    bulletList: {},
    orderedList: {},
    listItem: {},
    blockquote: {},
    hardBreak: {},
    // `openOnClick` would navigate the webview out of the app on a press inside the editor —
    // a reader clicking a link they are in the middle of writing means to put the caret in it.
    link: { openOnClick: false },

    // Out of the dialect: four nodes and marks the reader must not be able to make.
    codeBlock: false,
    horizontalRule: false,
    underline: false,
    trailingNode: false,

    // Behaviour, not schema. See the doc above for why these two stay and this one goes.
    undoRedo: {},
    listKeymap: {},
    dropcursor: false,
  }),
  NoteHeading.configure({ levels: HEADING_LEVELS }),

  /**
   * **Behaviour, not schema** — the same kind `undoRedo`, `listKeymap` and `gapcursor` already
   * are, and the first one named at this list's own level rather than inside StarterKit's
   * options. It can put no node and no mark into a body, so the pinned dialect and
   * `noteMarkdown.test.ts`' round trip are untouched. What it does is write `data-placeholder`
   * onto an empty node and add `is-empty` / `is-editor-empty`; {@link SURFACE} is what paints it.
   *
   * `showOnlyWhenEditable` is the default and is right: a read-only surface with a prompt on it is
   * a box inviting a press it will refuse. `showOnlyCurrent` keeps the sentence on the one empty
   * paragraph the caret is in rather than on every empty paragraph in a long note.
   */
  Placeholder.configure({ placeholder: NOTE_PLACEHOLDER }),

  Markdown,
];

/**
 * What an empty to-do list says. It teaches both halves of the document — text is written, a
 * to-do is added — and the two keys, because nesting is a keystroke nothing on screen draws.
 */
export const TODO_PLACEHOLDER = "Write, or add a to-do — Enter for the next, Tab to nest.";

/**
 * A **to-do document**: paragraphs and headings beside any number of task lists (issue #688).
 *
 * It was `content: "taskList"` under #672 — one list and nothing else, so every line was a to-do
 * and a heading button over it would have been a press that did nothing. A reader asked for text
 * between their to-dos, so the heading buttons, a **Paragraph** button and a **To-do** button now
 * decide what a line is, and none of the marks do.
 *
 * **`paragraph` is written first, and the order is load-bearing**: ProseMirror's split takes the
 * first textblock the parent's content allows as the block a split makes, so this is what makes
 * Enter at the end of a heading a paragraph rather than a second heading.
 *
 * Two lists side by side are a shape this expression allows and the dialect never writes — the
 * reader would read them back as one — so {@link JoinTodoLists} joins them after every edit and
 * {@link ChecklistMarkdown} on every load.
 *
 * `renderMarkdown` is not optional and its absence is silent: the stock `Document` carries one,
 * and a top node without it serialises **every** body as `""` — measured, on every entry of the
 * corpus at once. The `"\n\n"` is the blank line between blocks, and `Document`'s own separator.
 * Each child is rendered on its own rather than through `renderChildren` so a paragraph's line can
 * be escaped ({@link escapeLineStart}); for blocks, which carry no marks, the two are the same
 * call — `renderChildren` over block nodes is `renderChild` joined.
 */
const ChecklistDocument = TiptapNode.create({
  name: "doc",
  topNode: true,
  content: "(paragraph | heading | taskList)+",
  renderMarkdown: (node, h) =>
    (node.content ?? [])
      .map((child, index) => {
        // Typed optional; the manager always passes it (measured), and `renderChildren` over one
        // node is the same call if a later version stops.
        const written = h.renderChild ? h.renderChild(child, index) : h.renderChildren([child]);
        return child.type === "paragraph" ? escapeLineStart(written) : written;
      })
      .join("\n\n"),
});

/**
 * A top-level paragraph's line, escaped where CommonMark would read it as the start of **another
 * block** — so it reads back as the paragraph it is.
 *
 * ⚠️ **Measured before it was written, and the failure was loss rather than a reshape** (2026-09-29,
 * `@tiptap/markdown` 3.31.3). The paragraph renderer escapes `` \ ` * _ [ ] ~ `` anywhere in a line
 * and nothing at its start, so a paragraph whose words begin `- ` was written as a bullet list —
 * and this dialect has no bullet list, so the parse **dropped the line outright**: `"- plain dash"`,
 * `"+ plus"` and a typed `"- [ ] literal"` (written `"- \[ \] literal"`) each came back as nothing,
 * `"# not a heading"` came back a heading, and `"1. not a list"` a list. Under #672 no line of text
 * could exist to be written this way; #688's paragraphs are what made each of these reachable.
 *
 * The escapes are CommonMark's own backslash escapes, which the parse reads back as the character,
 * and which `todoMarkdown.ts` has to take off in the same place:
 *
 * * **`#` to `######` then a space or the end** — an ATX heading — becomes `\#…`.
 * * **`-` or `+` then a space or the end** — a bullet — becomes `\-…` / `\+…`; so does a line of
 *   three or more `-` — a thematic break. (`*`, `_`, `` ` ``, `~`, `[` and `]` are escaped
 *   anywhere in a line already, so `- [ ] literal` is written `\- \[ \] literal`.)
 * * **one to nine digits, then `.` or `)`, then a space or the end** — an ordered list — keeps its
 *   digits and escapes the delimiter: `1\. …`.
 * * **Leading spaces are taken off**: CommonMark takes up to three off a paragraph anyway, and four
 *   or more would open an indented code block, which this dialect would drop the same way.
 *
 * `>` needs nothing here: the manager writes `<`, `>` and `&` as entities wherever they fall, so a
 * quote cannot be spelt by accident. Every case above was measured round-tripping after this, in
 * `NoteEditor.test.tsx`. Only a top-level paragraph: a to-do's line is read as the item's inline
 * content, where `- [ ] # a` and `- [ ] - a` already round-trip unescaped (measured), and a
 * heading has its `#`s.
 */
function escapeLineStart(line: string): string {
  const text = line.replace(/^[ \t]+/, "");
  if (/^(?:#{1,6}(?=[ \t]|$)|[-+](?=[ \t]|$)|-[ \t]*-[ \t]*-[- \t]*$)/.test(text)) {
    return `\\${text}`;
  }
  const ordered = /^\d{1,9}(?=[.)](?:[ \t]|$))/.exec(text);
  return ordered ? `${ordered[0]}\\${text.slice(ordered[0].length)}` : text;
}

/**
 * Two task lists side by side, joined into one after every transaction that changed the document.
 *
 * **Behaviour, not schema**, and it exists because a list can come to sit beside another in more
 * ways than any key below owns: a paragraph between two lists deleted by a selection, a line
 * lifted out of the middle of a list (the to-dos after it split off and land next to the lifted
 * line's own sub-to-dos), a Backspace joining a paragraph's words into the list above it. The
 * dialect has no spelling for two adjacent lists — a blank line between two task lists reads back
 * as one list — so leaving them apart would be a document that changes shape on its next load.
 *
 * `appendTransaction`, so the join rides the edit that caused it: one undo step, one `onUpdate`.
 */
const JoinTodoLists = Extension.create({
  name: "joinTodoLists",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _before, state) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const seams: number[] = [];
          let previous: ProseMirrorNode | null = null;
          state.doc.forEach((node, offset) => {
            if (previous?.type.name === "taskList" && node.type.name === "taskList") {
              seams.push(offset);
            }
            previous = node;
          });
          if (seams.length === 0) return null;
          const tr = state.tr;
          // Last seam first, so each join leaves the positions before it where they were.
          for (const seam of seams.reverse()) tr.join(seam);
          return tr;
        },
      }),
    ];
  },
});

/** The words a row's controls are named after: the to-do's own line, and nothing under it. */
function todoWords(node: ProseMirrorNode): string {
  // `firstChild` rather than the item's own `textContent`, which runs a parent's sub-to-dos on
  // after its words — `Mark "ManaCut a land" done` for a to-do that says "Mana". The home
  // widget names its boxes from the reader's own line too, and the two must say one thing.
  return node.firstChild?.textContent || "empty to-do";
}

/** A to-do's checkbox: the app's own `size-4 accent-accent` box, and its keyboard outline. */
const TODO_CHECKBOX = cn("size-4 cursor-pointer accent-accent", FOCUS);

/**
 * A row's delete button, quiet until the row is the one being pointed at.
 *
 * ⚠️ **The two reveals are compiled in `NoteEditor.test.tsx`, not read** — an arbitrary variant
 * Tailwind cannot parse emits no rule and no warning, and the button would simply never appear.
 *
 * **The innermost row only.** A sub-to-do is inside its parent's `<li>`, so a bare `li:hover`
 * would light the parent's button too, and a pointer resting on one line would offer to delete
 * three. The `:not(:has(…))` is what makes it the row under the pointer and no row around it.
 * The same test for a caret: a Tab onto a row's own box or button shows that row's button, and
 * only that row's. Focus in the text itself is the surface's, never a row's, so typing shows none.
 *
 * Invisible rather than absent, so the row never reflows as the pointer crosses it, and still in
 * the tab order, which is what makes the caret half reachable at all.
 */
const DELETE_TODO = cn(
  "flex size-5 shrink-0 items-center justify-center rounded text-dim opacity-0 hover:text-text",
  "[li:hover:not(:has(li:hover))>&]:opacity-100",
  "[li:focus-within:not(:has(li:focus-within))>&]:opacity-100",
  FOCUS,
);

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Lucide's `X` — the glyph the link row's Cancel draws — built as DOM, because a node view is
 * not React and cannot render the component. The two paths and the attributes are
 * `lucide-react`'s own (v1.28, ISC, © Lucide Contributors), copied rather than redrawn.
 */
function removeGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of [
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
    ["class", "size-3.5"],
  ]) {
    svg.setAttribute(name, value);
  }
  for (const d of ["M18 6 6 18", "m6 6 12 12"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Take the to-do at `getPos()` out of the document, **with its sub-to-dos** — a sub-to-do belongs
 * to its parent, so deleting the parent and orphaning the children would leave them indented
 * under a line that is gone.
 *
 * Two cases are not a plain delete, because a task list may not be empty. **A to-do that is its
 * list's only item takes the list with it** — a sub-to-do's parent keeps its words and loses an
 * empty indent, and a top-level list goes from between the text around it. **The document's only
 * block is cleared instead**, to one empty item: a document with nothing in it is one this schema
 * cannot hold, and one empty to-do is exactly the list's resting state, which `todoMarkdown.ts`
 * reads as nothing at all. Ctrl+Z brings any of them back.
 *
 * The positions are read off the transaction's own document, so a press racing a keystroke acts
 * on the row as it is now rather than as it was drawn.
 */
function removeTodoAt(tr: Transaction, pos: number): boolean {
  const item = tr.doc.nodeAt(pos);
  if (!item || item.type.name !== "taskItem") return false;
  const $pos = tr.doc.resolve(pos);
  if ($pos.parent.childCount > 1) {
    tr.delete(pos, pos + item.nodeSize);
  } else if ($pos.depth > 1 || tr.doc.childCount > 1) {
    tr.delete($pos.before(), $pos.after());
  } else {
    const { taskItem, paragraph } = tr.doc.type.schema.nodes;
    tr.replaceWith(pos, pos + item.nodeSize, taskItem.create({ checked: false }, paragraph.create()));
  }
  return true;
}

/** The row's delete button: {@link removeTodoAt} on the row it is drawn on. */
function deleteTodo(editor: Editor, getPos: () => number | undefined): void {
  const pos = getPos();
  if (typeof pos !== "number") return;
  editor
    .chain()
    // `focus` first, `TaskItem`'s own checkbox's order: a press from the keyboard leaves the
    // button it was on detached, and the caret has to come back into the list rather than land
    // on `<body>`. No scroll — the reader is looking at the row they just removed.
    .focus(undefined, { scrollIntoView: false })
    .command(({ tr }) => removeTodoAt(tr, pos))
    .run();
}

/**
 * The to-do the caret is standing in, as the positions every key below needs — or `null` when the
 * caret is not on a to-do's own line. With {@link ChecklistItem}'s content that is the only line a
 * to-do has, so "the paragraph the caret is in" and "the to-do's line" are the same test.
 */
function todoAt($pos: ResolvedPos) {
  if ($pos.parent.type.name !== "paragraph" || $pos.depth < 2) return null;
  const itemDepth = $pos.depth - 1;
  const item = $pos.node(itemDepth);
  if (item.type.name !== "taskItem") return null;
  const listDepth = itemDepth - 1;
  return {
    item,
    itemPos: $pos.before(itemDepth),
    listDepth,
    // ⚠️ **Asked of the list's parent, never of a depth.** #672's test was `listDepth > 1`, true
    // while the list was the document's only child; a list is still a child of the document when
    // text sits beside it, so the depth happens to agree, but what the keys mean is "is there a
    // to-do above this list", and that is what this says.
    nested: $pos.node(listDepth - 1).type.name !== "doc",
    empty: $pos.parent.content.size === 0,
  };
}

/** The top-level text block — a paragraph or a heading, never a to-do's line — the caret is in. */
function textAt($pos: ResolvedPos) {
  if ($pos.depth !== 1 || !$pos.parent.isTextblock) return null;
  return { block: $pos.parent, blockPos: $pos.before(1), index: $pos.index(0) };
}

/**
 * Before a lift: the to-dos after the lifted run, moved into its last to-do's own sub-list.
 *
 * ⚠️ **Never ProseMirror's `liftListItem` alone.** When the lifted to-do has sub-to-dos *and*
 * siblings after it, `liftToOuterList` first wraps those siblings as a second list inside it and
 * joins the two afterwards — and a to-do here holds at most one list, so that intermediate step
 * throws out of the key handler (`TransformError: Invalid content for node taskItem`, measured with
 * this step taken out). The siblings are moved into the to-do's own sub-list first, which is
 * exactly where ProseMirror would have put them, so the lift that follows has nothing after it to
 * wrap and never builds the shape.
 *
 * At the top list there is nothing to move: the lift there is `liftOutOfList`, which splits the
 * list around the line instead, and {@link JoinTodoLists} puts the halves that end up side by side
 * back together.
 */
function moveFollowersIn({ tr }: { tr: Transaction }): boolean {
  const { $from, $to } = tr.selection;
  const range = $from.blockRange(
    $to,
    (node) => node.childCount > 0 && node.firstChild?.type.name === "taskItem",
  );
  if (!range || range.depth < 2 || range.endIndex >= range.parent.childCount) return true;
  const last = range.parent.child(range.endIndex - 1);
  const followers = tr.doc.slice(range.end, range.$to.end(range.depth)).content;
  tr.delete(range.end, range.$to.end(range.depth));
  if (last.childCount > 1) {
    // Inside the sub-list it already has, at its end.
    tr.insert(range.end - 2, followers);
  } else {
    tr.insert(range.end - 1, tr.doc.type.schema.nodes.taskList.create(null, followers));
  }
  return true;
}

/**
 * Lift the to-do the caret is in (or the run a selection spans) one level — Shift-Tab, Outdent,
 * and a Backspace or an Enter that means *out*.
 *
 * **A top-level to-do is not lifted, and answers `false`.** Out of the top list is text now — a
 * lift there would make the line a paragraph — and #672's Shift-Tab and Outdent over a top-level
 * to-do do nothing, which stands: turning a to-do into text is the Paragraph button's job, and
 * Enter's on an empty one. `false` rather than `true` so Shift-Tab still walks the caret out of
 * the editor, the key's own meaning when it has nothing to do.
 */
function liftTodo(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  const range = $from.blockRange(
    $to,
    (node) => node.childCount > 0 && node.firstChild?.type.name === "taskItem",
  );
  if (!range || range.depth < 2) return false;
  return editor.chain().command(moveFollowersIn).liftListItem("taskItem").run();
}

/** How many task lists the position is inside — how many lifts take its line out of all of them. */
function listsAround($pos: ResolvedPos): number {
  let lists = 0;
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "taskList") lists += 1;
  }
  return lists;
}

/**
 * The chain that takes the caret's to-do line out of **every** list, leaving it a top-level
 * paragraph at the place it was read — or the chain untouched when the caret is not on a to-do.
 *
 * **Its sub-to-dos stay a list, after it**, and so does everything the list held after it: each
 * lift moves the followers into the line's own sub-list ({@link moveFollowersIn}), so by the last
 * one they are all under it, and `liftOutOfList` then leaves them as the list that follows the
 * line — every one of them at the top level, which is the only level a list after a paragraph has.
 * The to-dos before the line stay where they were.
 *
 * A selection running past the line is set down on it first: a lift over two lines at two depths
 * is not a thing one press can mean, and the buttons that call this are about a line.
 */
function liftLineOut(chain: ChainedCommands, $from: ResolvedPos, $to: ResolvedPos): ChainedCommands {
  if (!todoAt($from)) return chain;
  let lifted = $to.sameParent($from) ? chain : chain.setTextSelection($from.pos);
  for (let lift = listsAround($from); lift > 0; lift--) {
    lifted = lifted.command(moveFollowersIn).liftListItem("taskItem");
  }
  return lifted;
}

/**
 * **Heading *n*** and **Paragraph**: the caret's line becomes that text block. On a to-do's line it
 * is lifted out of every list first ({@link liftLineOut}), so a heading or a paragraph is never
 * made inside a to-do — a to-do is one line of words, and the schema refuses anything else there.
 */
function lineToText(editor: Editor, level: Level | null): boolean {
  const { $from, $to } = editor.state.selection;
  const chain = liftLineOut(editor.chain().focus(), $from, $to);
  return (level === null ? chain.setParagraph() : chain.setHeading({ level })).run();
}

/**
 * **To-do**: a paragraph or a heading becomes a to-do, joined to a list directly above or below it
 * (`toggleList` joins both ways, and {@link JoinTodoLists} would anyway). A heading is made a
 * paragraph first, because a to-do's line is a paragraph. Pressed on a to-do — the button is lit
 * there — it is the Paragraph button, since a toggle that is on turns off.
 */
function lineToTodo(editor: Editor): boolean {
  if (todoAt(editor.state.selection.$from)) return lineToText(editor, null);
  return editor.chain().focus().setParagraph().toggleList("taskList", "taskItem").run();
}

/**
 * Enter on a to-do's line. **A to-do with words splits into the next one; an empty one never makes
 * a line that is not a to-do — until it is at the top.** An empty sub-to-do lifts one level, which
 * is how a reader walks back out of a nest; an empty top-level to-do **lifts out of the list as a
 * paragraph**, so the list ends where the reader stopped and what they type next is text. It did
 * nothing under #672, when out of the list was nowhere.
 *
 * Not on a to-do's line, it answers `false` and the Enter is the ordinary one: a paragraph splits,
 * and a heading's Enter makes a paragraph ({@link ChecklistDocument} says why).
 */
function enterTodo(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!todoAt(selection.$from)) return false;
  if (!selection.empty) editor.commands.deleteSelection();
  const at = todoAt(editor.state.selection.$from);
  // The deletion took the caret out of every to-do: an ordinary Enter from here.
  if (!at) return false;
  if (at.empty) {
    if (at.nested) liftTodo(editor);
    else {
      const { $from, $to } = editor.state.selection;
      liftLineOut(editor.chain(), $from, $to).setParagraph().run();
    }
    return true;
  }
  editor.commands.splitListItem("taskItem");
  return true;
}

/**
 * Shift-Enter on a text line. There is no hard break in this dialect ({@link CHECKLIST_EXTENSIONS}),
 * so the key does what Enter does rather than leave the browser to invent a `<br>` the schema has
 * no node for: the core keymap's own Enter, spelled out.
 */
function enterText(editor: Editor): boolean {
  return editor.commands.first(({ commands }) => [
    () => commands.createParagraphNear(),
    () => commands.liftEmptyBlock(),
    () => commands.splitBlock(),
  ]);
}

/**
 * Backspace at the start of a to-do's line. Anywhere else it is an ordinary Backspace and this
 * answers `false`.
 *
 * * **An empty to-do with nothing under it is removed**, and the caret goes to the end of the line
 *   above — the previous to-do in reading order, which for a first sub-to-do is its parent, or the
 *   text over a list — or, for the document's first line, to the start of the one below. The
 *   document's only block stays: it is the empty list.
 * * **A sub-to-do lifts one level**, the way out of a nest a reader expects from the key.
 * * **A top-level to-do joins its words onto the end of the line above**, and **its sub-to-dos go
 *   with them**, becoming the sub-to-dos of the to-do that took the words. That is always valid:
 *   the line above is the last line of everything before, so the to-do it belongs to has no
 *   sub-list of its own for them to collide with.
 * * **The first to-do of a list has no to-do above it.** At the top of the document it stays where
 *   it is. **Under a paragraph or a heading it becomes a paragraph** (issue #688) — the Paragraph
 *   button's lift, its sub-to-dos staying a list after it — rather than joining its words onto
 *   text that cannot hold its sub-to-dos. A second Backspace is then the ordinary join of two
 *   paragraphs, so the key still walks the line up one step at a time.
 *
 * Handled at all, rather than left to `listKeymap` and the core keymap, because their fallbacks
 * are the ones the review found: a join that leaves a second paragraph inside a to-do, and a lift
 * that leaves a line outside every to-do. The schema now refuses the first; this is what the key
 * does instead.
 */
function backspaceTodo(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!selection.empty || selection.$from.parentOffset !== 0) return false;
  const at = todoAt(selection.$from);
  if (!at) return false;
  const { item, itemPos } = at;
  const list = selection.$from.node(at.listDepth);

  if (at.empty && item.childCount === 1) {
    if (!at.nested && list.childCount === 1 && selection.$from.doc.childCount === 1) return true;
    return editor
      .chain()
      .command(({ tr }) => {
        removeTodoAt(tr, itemPos);
        const $at = tr.doc.resolve(tr.mapping.map(itemPos));
        tr.setSelection(
          Selection.findFrom($at, -1, true) ??
            Selection.findFrom($at, 1, true) ??
            Selection.atStart(tr.doc),
        );
        // A key's edit follows the caret, as upstream `joinBackward` does: the line it lands on
        // can be above the fold of a long list.
        tr.scrollIntoView();
        return true;
      })
      .run();
  }

  if (at.nested) return liftTodo(editor) || true;
  if (selection.$from.index(at.listDepth) === 0) {
    if (selection.$from.index(0) === 0) return true;
    return liftLineOut(editor.chain(), selection.$from, selection.$to).setParagraph().run() || true;
  }

  return editor
    .chain()
    .command(({ tr }) => {
      const above = Selection.findFrom(tr.doc.resolve(itemPos), -1, true);
      if (!above) return false;
      const joinAt = above.$head.pos;
      const words = item.firstChild?.content;
      const under = item.childCount > 1 ? item.child(1) : null;
      tr.delete(itemPos, itemPos + item.nodeSize);
      if (words) tr.insert(joinAt, words);
      const lineEnd = joinAt + (words?.size ?? 0);
      if (under) {
        const $line = tr.doc.resolve(lineEnd);
        const owner = $line.node($line.depth - 1);
        if (owner.childCount > 1) {
          // Not reachable by construction (see above), and still not a second list if it were.
          tr.insert($line.after($line.depth - 1) - 2, under.content);
        } else {
          tr.insert($line.after(), under);
        }
      }
      tr.setSelection(TextSelection.create(tr.doc, joinAt));
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/**
 * Backspace at the start of a paragraph or a heading **directly under a list**: the ordinary join
 * — the block's words go onto the end of the line above, which is the list's last line in reading
 * order, and the block goes. Its words take that to-do's line; nothing else about the to-do moves.
 *
 * Handled here because `listKeymap`'s answer to exactly this case cuts the block into the last
 * to-do *as a second paragraph* and joins from there, which is the shape {@link ChecklistItem}
 * refuses. Under text, or at the top of the document, it answers `false` and the key is the
 * ordinary one.
 */
function backspaceText(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!selection.empty || selection.$from.parentOffset !== 0) return false;
  const text = textAt(selection.$from);
  if (!text || text.index === 0) return false;
  if (selection.$from.doc.child(text.index - 1).type.name !== "taskList") return false;
  return editor
    .chain()
    .command(({ tr }) => {
      const above = Selection.findFrom(tr.doc.resolve(text.blockPos), -1, true);
      if (!above) return false;
      const joinAt = above.$head.pos;
      tr.delete(text.blockPos, text.blockPos + text.block.nodeSize);
      tr.insert(joinAt, text.block.content);
      tr.setSelection(TextSelection.create(tr.doc, joinAt));
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/**
 * Delete at the end of a to-do's line: **the next line joins onto this one**, the mirror of a
 * Backspace at its start. The to-do that line belonged to goes, and its sub-to-dos stay in the
 * list they were in: when it was this to-do's own first sub-to-do, its sub-to-dos take its place
 * in that list; otherwise this to-do has no sub-list of its own (the next line would be in it)
 * and they become that. **A paragraph or a heading after the list's last line joins the same
 * way**, its words onto this line and the block gone — the mirror of {@link backspaceText}.
 * Nothing after the last line: nothing happens.
 *
 * Handled rather than left upstream because `listKeymap`'s join builds a second paragraph inside
 * a to-do, which {@link ChecklistItem} refuses — and what ProseMirror fits in its place instead is
 * the next to-do nested under this one, which is not what the key says.
 */
function deleteTodoForward(editor: Editor): boolean {
  const { selection } = editor.state;
  const { $from } = selection;
  if (!selection.empty || $from.parentOffset !== $from.parent.content.size) return false;
  const at = todoAt($from);
  if (!at) return false;
  return editor
    .chain()
    .command(({ tr }) => {
      const joinAt = $from.pos;
      const next = Selection.findFrom(tr.doc.resolve($from.after()), 1, true);
      if (!next) return true;
      const $next = next.$head;
      const text = textAt($next);
      if (text) {
        tr.delete(text.blockPos, text.blockPos + text.block.nodeSize);
        tr.insert(joinAt, text.block.content);
        tr.setSelection(TextSelection.create(tr.doc, joinAt));
        tr.scrollIntoView();
        return true;
      }
      const nextItem = $next.node($next.depth - 1);
      if ($next.parent.type.name !== "paragraph" || nextItem.type.name !== "taskItem") return true;
      const words = nextItem.firstChild?.content ?? Fragment.empty;
      const under = nextItem.childCount > 1 ? nextItem.child(1) : null;
      const { taskList } = tr.doc.type.schema.nodes;
      if (at.item.childCount > 1) {
        // The next line is this to-do's own first sub-to-do: its sub-to-dos take its place.
        const list = at.item.child(1);
        const listPos = at.itemPos + 1 + (at.item.firstChild?.nodeSize ?? 0);
        const items = (under?.content ?? Fragment.empty).append(list.content.cut(nextItem.nodeSize));
        if (items.childCount > 0) {
          tr.replaceWith(listPos, listPos + list.nodeSize, taskList.create(null, items));
        } else {
          tr.delete(listPos, listPos + list.nodeSize);
        }
      } else {
        const nextPos = $next.before($next.depth - 1);
        tr.delete(nextPos, nextPos + nextItem.nodeSize);
        if (under) tr.insert(joinAt + 1, under);
      }
      tr.insert(joinAt, words);
      tr.setSelection(TextSelection.create(tr.doc, joinAt));
      // Upstream `joinForward`'s scroll, which this replaces along with its join.
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/**
 * Delete at the end of a paragraph or a heading **directly over a list**: the list's first to-do
 * joins its words onto this line and goes, and its sub-to-dos take its place at the head of the
 * list — the mirror of a Backspace at the start of that to-do, and of {@link deleteTodoForward}'s
 * own rule one level up. Over text, or at the end of the document, it answers `false` and the key
 * is the ordinary one — which here would lift the to-do's line out from under its checkbox.
 */
function deleteTextForward(editor: Editor): boolean {
  const { selection } = editor.state;
  const { $from } = selection;
  if (!selection.empty || $from.parentOffset !== $from.parent.content.size) return false;
  const text = textAt($from);
  if (!text || text.index + 1 >= $from.doc.childCount) return false;
  const list = $from.doc.child(text.index + 1);
  if (list.type.name !== "taskList") return false;
  return editor
    .chain()
    .command(({ tr }) => {
      const joinAt = $from.pos;
      const listPos = $from.after(1);
      const first = list.firstChild;
      if (!first) return false;
      const words = first.firstChild?.content ?? Fragment.empty;
      const under = first.childCount > 1 ? first.child(1) : null;
      const items = (under?.content ?? Fragment.empty).append(list.content.cut(first.nodeSize));
      if (items.childCount > 0) {
        tr.replaceWith(listPos, listPos + list.nodeSize, list.type.create(null, items));
      } else {
        tr.delete(listPos, listPos + list.nodeSize);
      }
      tr.insert(joinAt, words);
      tr.setSelection(TextSelection.create(tr.doc, joinAt));
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/**
 * The checklist's keys, ahead of everything upstream.
 *
 * **An extension of their own, at priority 102, rather than bindings on {@link ChecklistItem}.**
 * Tiptap runs keymaps by priority, highest first, so a binding on the item (priority 100) runs
 * before `listKeymap` and the core keymap but *after* `TaskItem`'s own branching Delete keymap,
 * which sits at 101 — and that one is what nested the next to-do under this one. A node's
 * priority also orders the schema, so raising the item's to get ahead of it would move more than
 * keys; an extension that holds nothing but keys moves nothing else.
 *
 * **Each key asks about a to-do's line first and then about text beside a list**, and answers
 * `false` for everything else, which is the ordinary key: two paragraphs join and split as they do
 * anywhere. Tab is not here: `TaskItem`'s `sinkListItem` already nests a to-do under the one above
 * and joins the sub-list it has, which is a shape this schema holds.
 */
const ChecklistKeys = Extension.create({
  name: "checklistKeys",
  priority: 102,

  addKeyboardShortcuts() {
    const enter = () => enterTodo(this.editor);
    const backspace = () => backspaceTodo(this.editor) || backspaceText(this.editor);
    const forward = () => deleteTodoForward(this.editor) || deleteTextForward(this.editor);
    return {
      Enter: enter,
      // There is no hard break in this dialect (see {@link CHECKLIST_EXTENSIONS}), so the key
      // does what Enter does rather than nothing.
      "Shift-Enter": () => enter() || enterText(this.editor),
      "Shift-Tab": () => liftTodo(this.editor),
      Backspace: backspace,
      "Mod-Backspace": backspace,
      "Shift-Backspace": backspace,
      Delete: forward,
      "Mod-Delete": forward,
    };
  },
});

/**
 * A plain-text paste on a to-do's line, as the to-dos it reads as: **every line with words in it
 * a to-do at the caret's level** — or `null` anywhere else, which is ProseMirror's own parse.
 *
 * ⚠️ **Without it a paste nests, and the document stays valid while it does** (measured
 * 2026-10-01, `prosemirror-view` 1.42.3). That parse makes each line a paragraph, and a to-do
 * holds exactly one ({@link ChecklistItem}), so where lines 2..n go is the fitter's guess, made
 * from the document's shape: `"x\ny"` after `a` in `- [ ] a\n  - [ ] s\n- [ ] b` gave
 * `- [ ] ax\n  - [ ] y\n- [ ] \n  - [ ] s\n- [ ] b` — the second line a sub-to-do, and an empty
 * to-do that nobody wrote holding `s` — while `"x\ny\nz"` in a list with no sub-to-dos happened to
 * land as siblings. `doc.check()` passes on all of it, so no layer below sees it.
 *
 * **The answer is the lines as typed with Enter between them**, less the blank ones:
 *
 * * **The first line goes onto the caret's line**, after the words before the caret, and the
 *   caret's to-do keeps its own tick.
 * * **Every other line with words in it is a new, open to-do** at the caret's level — a sub-to-do
 *   when the caret is in one.
 * * **The last line takes the words after the caret and the to-do's sub-to-dos**, which is
 *   Enter's split ({@link enterTodo}): what was under the caret's to-do stays under the line that
 *   took its tail.
 * * **A blank line is never a to-do.** One between two lines is dropped. One at either end is the
 *   break it stands for only where the reader has words on its far side — so a paste starting
 *   with a newline after words starts a new to-do, and one ending with a newline before words
 *   leaves those words a to-do of their own — and is otherwise dropped too, so a paste never
 *   leaves an empty to-do behind, the trailing newline a copied line usually carries included.
 * * **Whitespace at a to-do's edge is trimmed**, except where a line meets the reader's own words:
 *   the reader trims a to-do's line as it loads (`- [ ]    lead` reads back as `lead`, measured),
 *   so a pasted indent would be drawn now and gone at the next load.
 *
 * **One line with no line break is declined**: an inline insert is already right. So is a paste
 * anywhere but a to-do's line, where a paragraph per line is the right answer and the note's
 * whole behaviour. The text carries the caret's marks, as that parse's does.
 *
 * The slice is a run of to-dos **open two deep at both ends** — into the first line's paragraph
 * and out of the last's — so the replace joins its first line to the words before the caret and
 * its last to the words after, and every to-do between stands in the caret's own list.
 *
 * **The first to-do carries the attributes of the to-do pasted into, and one case needs it**: an
 * empty to-do with nothing under it is a range ProseMirror's replace takes whole, and a first
 * to-do that differs from it goes in its place — so an empty ticked to-do came back open
 * (measured). Everywhere else the first to-do is opened into and its attributes are never read.
 *
 * **Plain text only, by construction**: ProseMirror asks this only when the clipboard has no
 * HTML (or the paste is Ctrl+Shift+V), so to-dos copied inside the editor arrive as HTML, with
 * their own structure, and never reach it.
 */
function pastedTodos(text: string, $context: ResolvedPos, view: EditorView): Slice | null {
  const at = todoAt($context);
  const lines = text.split(/\r\n?|\n/);
  if (!at || lines.length < 2) return null;

  // A paste replaces the selection, so the words after it are past its end; a dropped text lands
  // at a point that is not the selection, and its context is both ends at once.
  const { selection } = view.state;
  const $end = selection.from === $context.pos ? selection.$to : $context;
  const wordsBefore = $context.parentOffset > 0;
  const wordsAfter = $end.parentOffset < $end.parent.content.size;

  const last = lines.length - 1;
  const kept = lines.filter(
    (line, index) =>
      line.trim() !== "" || (index === 0 && wordsBefore) || (index === last && wordsAfter),
  );
  if (kept.length === 0) return Slice.empty;

  const { schema } = $context.doc.type;
  const { taskItem, paragraph } = schema.nodes;
  const marks = $context.marks();
  const todos = kept.map((line, index) => {
    let words = line;
    if (index > 0 || !wordsBefore) words = words.trimStart();
    if (index < kept.length - 1 || !wordsAfter) words = words.trimEnd();
    return taskItem.create(
      index === 0 ? at.item.attrs : { checked: false },
      paragraph.create(null, words ? schema.text(words, marks) : null),
    );
  });
  return new Slice(Fragment.from(todos), 2, 2);
}

/**
 * {@link pastedTodos} as the editor's plain-text parser — **an extension in
 * {@link CHECKLIST_EXTENSIONS}, never `editorProps`**, so the note's kit cannot carry it and every
 * editor built from the checklist's kit does, the bare ones the tests drive included.
 */
const ChecklistPaste = Extension.create({
  name: "checklistPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // ⚠️ Typed as always answering a `Slice`, and read as `if (parsed)`: `null` is how a
          // parser says "not mine", and ProseMirror's own parse then runs.
          clipboardTextParser: (text, $context, _plain, view) =>
            pastedTodos(text, $context, view) as Slice,
        },
      }),
    ];
  },
});

/**
 * `TaskItem`, narrowed to one line and at most one sub-list, with a delete button on every row.
 *
 * **`content: "paragraph taskList?"`** where `TaskItem` has `paragraph block*`. A to-do is one
 * line, so a second paragraph inside one is a shape this dialect has no spelling for — it came out
 * as an indented blank and read back as a line outside the list — and the narrower expression
 * makes every command that would build it fail rather than succeed. The markdown parse builds
 * exactly this shape (a paragraph, then one list of sub-to-dos), so no body in the corpus moved.
 *
 * **The parent's node view is wrapped, never copied** (`this.parent?.()`), so Tiptap's checkbox,
 * its accessible name and its own `update` stay exactly Tiptap's; what this adds is appended to
 * the view it hands back. The button is `contentEditable=false`; `stopEvent` keeps ProseMirror's
 * own mouse and key handling off it, so a press is a press and never a caret placed under it; and
 * `ignoreMutation` keeps its DOM from reading as an edit to the document. Everything the parent's
 * view already answered — its `stopEvent`, its `ignoreMutation` — is still asked first-hand for
 * anything that is not the button.
 *
 * Its keys are {@link ChecklistKeys}', which says why they are not bindings here — **all but Tab**,
 * which is `TaskItem`'s `sinkListItem` kept as it was. `TaskItem`'s Enter and Shift-Tab are
 * dropped rather than left behind ours: since text can stand beside a list, its Shift-Tab on a
 * top-level to-do is a `liftListItem` that *succeeds* — out of the list and into a paragraph —
 * which is exactly the press {@link liftTodo} declines, and a binding that ran whenever ours
 * answered `false` would do it anyway.
 */
const ChecklistItem = TaskItem.extend({
  content: "paragraph taskList?",

  addKeyboardShortcuts() {
    return { Tab: () => this.editor.commands.sinkListItem(this.name) };
  },

  addNodeView() {
    const parent = this.parent?.();
    if (!parent) return null;

    return (props) => {
      const view = parent(props);
      const row = view.dom;

      if (row instanceof HTMLElement) {
        row.querySelector("input[type=checkbox]")?.setAttribute("class", TODO_CHECKBOX);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.contentEditable = "false";
      remove.className = DELETE_TODO;
      remove.setAttribute("aria-label", `Delete "${todoWords(props.node)}"`);
      remove.append(removeGlyph());
      // The caret stays where it is — `ToolButton`'s rule: a press that took focus would drop the
      // selection a mouse reader is in the middle of, one row over.
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        deleteTodo(props.editor, props.getPos);
      });
      row.appendChild(remove);

      return {
        ...view,
        update: (node, decorations, innerDecorations) => {
          const kept = view.update?.(node, decorations, innerDecorations) ?? false;
          // The name follows the words, the checkbox's own rule: a reader who retyped a to-do
          // must not be offered the deletion of the line it used to be.
          if (kept) remove.setAttribute("aria-label", `Delete "${todoWords(node)}"`);
          return kept;
        },
        stopEvent: (event) =>
          (event.target instanceof Node && remove.contains(event.target)) ||
          (view.stopEvent?.(event) ?? false),
        ignoreMutation: (mutation) =>
          remove.contains(mutation.target) || (view.ignoreMutation?.(mutation) ?? false),
      };
    };
  },
});

/** A node's words, marks and all taken off — what a stray block becomes a line with. */
function plainWords(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(plainWords).join("");
}

/**
 * Every node of a parsed body **inside a to-do** as to-dos, in reading order and at the level they
 * were found: a list gives its items, an item is squared up by {@link oneTodo}, and any other block
 * with words in it becomes one open to-do holding them — a second paragraph in a to-do becomes its
 * sub-to-do, which is #672's repair and still the only shape a to-do can hold. A block with no
 * words — a blank line, the `&nbsp;` an emptied paragraph is written as — is dropped rather than
 * drawn as an empty to-do.
 */
function todosOf(nodes: readonly JSONContent[]): JSONContent[] {
  return nodes.flatMap((node): JSONContent[] => {
    if (node.type === "taskList") return todosOf(node.content ?? []);
    if (node.type === "taskItem") return [oneTodo(node)];
    const words = plainWords(node);
    if (words.trim() === "") return [];
    const line =
      node.type === "paragraph" ? node : { type: "paragraph", content: [{ type: "text", text: words }] };
    return [{ type: "taskItem", attrs: { checked: false }, content: [line] }];
  });
}

/** One to-do in {@link ChecklistItem}'s shape: its own line, then at most one list under it. */
function oneTodo(item: JSONContent): JSONContent {
  const [first, ...rest] = item.content ?? [];
  const ownLine = first?.type === "paragraph";
  const under = todosOf(ownLine ? rest : (item.content ?? []));
  const line = ownLine ? first : { type: "paragraph" };
  return { ...item, content: under.length > 0 ? [line, { type: "taskList", content: under }] : [line] };
}

/** Whether a block has any words at all — a blank line and an `&nbsp;` have none. */
function hasWords(node: JSONContent): boolean {
  return plainWords(node).trim() !== "";
}

/**
 * A block {@link ChecklistDocument} cannot hold, as the top-level paragraphs it reads as: one per
 * line of words inside it, marks kept, so a quote keeps its lines and its emphasis and loses only
 * the construct. A block whose words sit in no line of their own is one paragraph of those words.
 *
 * ⚠️ **A bullet or numbered list never gets this far**: this dialect has no node for either, and
 * the parse drops such a list before the repair sees it — measured, `"- plain dash"` parses to
 * nothing at all. Nothing this editor writes is one ({@link escapeLineStart} is why), so the loss
 * is confined to a body some other writer made.
 */
function linesOf(node: JSONContent): JSONContent[] {
  if (node.type === "paragraph" || node.type === "heading") {
    return hasWords(node) ? [{ type: "paragraph", content: node.content }] : [];
  }
  const inner = (node.content ?? []).flatMap((child) => (child.type === "text" ? [] : linesOf(child)));
  if (inner.length > 0) return inner;
  const words = plainWords(node);
  return words.trim() === "" ? [] : [{ type: "paragraph", content: [{ type: "text", text: words }] }];
}

/**
 * A parsed body as a document this schema can hold: **text and task lists, in the order written**.
 *
 * **The second line of defence, and it exists because the first one can be late.** Tiptap loads
 * a parsed body without checking it against the schema, so a body already written in a shape the
 * keys can no longer make would open as an invalid document and break the next keystroke. Written
 * bodies in such shapes exist: the review found #672's editor saving `"- [ ] a\n\n  \n- [ ] b"`
 * before its keys were bound, which reads back as two top-level lists. So, block by block:
 *
 * * **Paragraphs and headings pass through** — the text beside the to-dos, which #672 turned into
 *   to-dos of their own and #688 is what stopped that. A heading deeper than the dialect's three
 *   keeps its level, `NoteHeading`'s rule: drawn at three, never rewritten.
 * * **A task list's to-dos are squared up** ({@link oneTodo}), and **a list directly after another
 *   joins it**, so the two-list body opens as the one list it was meant to be.
 * * **Any other block becomes paragraphs of its words** ({@link linesOf}) — a quote, say — where
 *   #672 made it a to-do.
 * * **A block with no words is dropped** — a blank line, the `&nbsp;` an emptied paragraph is
 *   written as — which is #672's rule for a blank line, kept: a reader cannot see one, and a body
 *   that kept them would grow a line at the end every time Enter left the list.
 * * **A document left with nothing is one empty to-do**, the list's resting state — what a new
 *   list opens on, and what the reader reads as nothing at all.
 *
 * A valid body passes through unchanged, which the round-trip corpus pins.
 */
function todoDocBody(doc: JSONContent): JSONContent {
  const blocks: JSONContent[] = [];
  const pushTodos = (todos: JSONContent[]) => {
    if (todos.length === 0) return;
    const last = blocks[blocks.length - 1];
    if (last?.type === "taskList") last.content = [...(last.content ?? []), ...todos];
    else blocks.push({ type: "taskList", content: todos });
  };
  for (const node of doc.content ?? []) {
    if (node.type === "taskList") pushTodos(todosOf(node.content ?? []));
    else if (node.type === "taskItem") pushTodos([oneTodo(node)]);
    else if (node.type === "paragraph" || node.type === "heading") {
      if (hasWords(node)) blocks.push(node);
    } else blocks.push(...linesOf(node));
  }
  const content =
    blocks.length > 0
      ? blocks
      : [
          {
            type: "taskList",
            content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }],
          },
        ];
  return { ...doc, content };
}

/**
 * `Markdown`, with every parse this editor makes squared up by {@link todoDocBody}.
 *
 * Both roads a body takes into the editor go through the manager's `parse` — the first paint (its
 * `onBeforeCreate` converts `content` before the document exists) and every later `setContent` —
 * so the repair is one wrap of that method, after the parent has built the manager, plus the
 * initial content the parent has already converted by then. `onCreate` would be too late: Tiptap
 * fires it on a timer, after the first paint and after the value effect.
 */
const ChecklistMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.editor.markdown;
    if (!manager) return;
    const parse = manager.parse.bind(manager);
    manager.parse = (markdown: string) => todoDocBody(parse(markdown));
    const initial = this.editor.options.content;
    if (initial !== null && typeof initial === "object" && !Array.isArray(initial)) {
      this.editor.options.content = todoDocBody(initial as JSONContent);
    } else if (typeof initial === "string" && this.editor.options.contentType === "markdown") {
      // ⚠️ The parent leaves a body that parses to nothing — `""` — as the string it was, and the
      // editor then fills the document from the schema: one empty **paragraph**, since the top
      // node's content expression names it first. Under #672 that fill was one empty to-do by
      // construction; now it has to be asked for, or a new list opens on a line of text.
      this.editor.options.content = manager.parse(initial);
    }
  },
});

/**
 * The checklist's whole dialect, spelled out — `NOTE_EXTENSIONS`' rule, every option that is off
 * written out, for its reason.
 *
 * **The dialect is a to-do document with the inline marks**: document (paragraphs, headings and
 * task lists), heading (levels 1–3, the note's {@link NoteHeading}), task list, task item (nested),
 * paragraph, text, bold, italic, strike, code, link. That is what the to-do corpus in
 * `NoteEditor.test.tsx` pins and what `todoMarkdown.ts` reads, and nothing else — so both other
 * lists, list items, blockquote, code block and rule are off, for #672's reasons: a document that
 * can hold none of them has no button for them either, and the reader has no rule for them.
 *
 * **Headings came in with #688, and only at the top level.** A to-do's line is a paragraph
 * ({@link ChecklistItem}), so the heading buttons lift a to-do's line out of every list before
 * they make it a heading, and the `#` input rule does nothing inside a to-do — `setBlockType`
 * cannot put a heading where the item's content expression wants a paragraph.
 *
 * ⚠️ **`hardBreak` is off, which is where this list departs from the spec** (§3 keeps it), and
 * the reason is a measurement rather than a preference. Its markdown is `"  \n"` with the rest of
 * the line unindented, and `TaskList`'s tokenizer reads a task item **one line at a time** — so
 * the second half of a broken to-do comes back as a line *outside* the list, which
 * {@link ChecklistMarkdown} can only turn into a line of its own. A construct only one side of the
 * round trip can spell is exactly what the module header says must not enter a dialect.
 * `NoteEditor.test.tsx` pins the split, and goes red the day the tokenizer learns continuation
 * lines. A paragraph has no break either, for the same dialect's sake: Shift-Enter starts the
 * next line, on text and on a to-do alike.
 *
 * **Four layers keep a to-do one line of words**, and each covers what the one before cannot.
 * {@link ChecklistItem} narrows a to-do to one line and at most one sub-list, so no command can
 * build a second paragraph or a heading inside one; {@link ChecklistKeys} gives Enter, Backspace,
 * Delete and Shift-Tab answers that never need the shapes the schema now refuses;
 * {@link JoinTodoLists} puts back together two lists an edit left side by side; and
 * {@link ChecklistMarkdown} squares up a body already written in one of those shapes before it is
 * drawn. **What a line _is_ is decided by the block buttons and by nothing else** — Heading 1–3,
 * Paragraph and To-do — so a mark, a link or a keystroke never turns text into a to-do or back.
 *
 * **A plain-text paste is a fifth way in, and it needs a layer for a different reason**:
 * {@link ChecklistPaste}. ProseMirror's fitter already keeps a pasted document valid; what it does
 * not keep is the reader's lines as to-dos of their own, because a to-do holds one paragraph and
 * the fitter nests lines 2..n under the one pasted into. Valid, and not what was pasted.
 *
 * Three behaviours stay, each as in `NOTE_EXTENSIONS`: `undoRedo` is Ctrl+Z, which is the only
 * undo a deleted to-do has; `listKeymap`, whose default list types include `taskItem` and which
 * skips the `listItem` type this schema does not have rather than failing on it — kept for what it
 * does that {@link ChecklistKeys} does not claim, though the keys that key off a to-do's line
 * boundaries are all answered before it; and `gapcursor` by absence, the one StarterKit type that
 * can only be said as "off". `trailingNode` stays off for the note's reason, and a second one: the
 * blank paragraph it pins to the end of a document comes back out as a blank line, and
 * {@link ChecklistMarkdown} drops a blank line on the next load — so the two would take it in turns
 * to add it and remove it, and every list would end under a line of text nobody wrote.
 *
 * **`document: false`, and {@link ChecklistDocument} in its place** — StarterKit builds its own
 * `doc` with `block+` and hands out no handle to change it, the same reason `NoteHeading` exists.
 * **`heading: false`, and `NoteHeading` in its place** — the note's own arrangement, for its
 * reason.
 *
 * **The placeholder takes `includeChildren`**, which the note's does not: it looks for an empty
 * *top-level* textblock by default, and an empty to-do list is one empty to-do — a textblock two
 * levels down — so without it an empty checklist would teach nothing at all.
 */
export const CHECKLIST_EXTENSIONS = [
  StarterKit.configure({
    // In the dialect. `text` and `gapcursor` are on by being absent.
    paragraph: {},
    bold: {},
    italic: {},
    strike: {},
    code: {},
    link: { openOnClick: false },

    // Replaced below by the to-do document, and by the note's clamped heading.
    document: false,
    heading: false,

    // Out of the dialect: every block a to-do list cannot hold, and the break it cannot read.
    bulletList: false,
    orderedList: false,
    listItem: false,
    blockquote: false,
    hardBreak: false,
    codeBlock: false,
    horizontalRule: false,
    underline: false,
    trailingNode: false,

    // Behaviour, not schema.
    undoRedo: {},
    listKeymap: {},
    dropcursor: false,
  }),
  ChecklistDocument,
  NoteHeading.configure({ levels: HEADING_LEVELS }),
  TaskList,
  ChecklistItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: (node, checked) =>
        `Mark "${todoWords(node)}" ${checked ? "not done" : "done"}`,
    },
  }),
  ChecklistKeys,
  ChecklistPaste,
  JoinTodoLists,
  Placeholder.configure({ placeholder: TODO_PLACEHOLDER, includeChildren: true }),
  ChecklistMarkdown,
];

/**
 * How a heading is drawn, on both surfaces — a to-do list's headings are the note's
 * {@link NoteHeading}, so the three levels read at the same weights one band apart. Every bracketed
 * class here is compiled in `NoteEditor.test.tsx`, beside the checklist's own.
 */
const HEADING_PROSE = cn(
  "[&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-text",
  "[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-text",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-dim",
);

/**
 * How the body is drawn inside the box.
 *
 * Written out one whole class at a time because Tailwind scans source **text** — a descendant
 * variant built by interpolation emits no rule at all and the note simply renders unstyled.
 *
 * The headings step down in weight rather than in size past `h1`: a note is a paragraph or two in
 * a band at the foot of the deck, so three display sizes inside a 128px box would be a document's
 * hierarchy drawn at a caption's scale. `code` takes the surface colour, `blockquote` a rule in
 * the app's own border, and a link the accent — the three places the palette already means
 * "quoted", "aside" and "somewhere to go".
 */
const PROSE = cn(
  HEADING_PROSE,
  "[&_p]:my-1",
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>p]:my-0",
  "[&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border",
  "[&_blockquote]:pl-3 [&_blockquote]:text-dim",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
);

/**
 * How the inline marks are drawn, on both surfaces — a to-do and a note are one inline dialect,
 * so a `code` span or a link must not look like two things one band apart.
 */
const INLINE_PROSE = cn(
  "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5",
  "[&_code]:font-mono [&_code]:text-[0.8125rem]",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
);

/**
 * How a to-do list is drawn inside the box. Every bracketed class here is compiled in
 * `NoteEditor.test.tsx`, for `SURFACE`'s reason below.
 *
 * **No bullet and no indent of the list's own**: the box is the marker, and a sub-list sits inside
 * its parent's text column, so each level's boxes line up under the words of the to-do above them
 * — the indent is the row's own geometry, one box and one gap, rather than a number to keep in
 * step with it.
 *
 * **One row per to-do** — the box's label, the words, and the row's delete button at the far end.
 * The label is the first line's own height, so the box sits on that line whatever wraps beneath
 * it, and it is `relative` because `TaskItem` names the box with an absolutely positioned hidden
 * span inside it, which with no positioned ancestor is laid out against the page instead.
 *
 * **Done strikes the to-do's own line and nothing under it.** `>div>p` is the item's first
 * paragraph and never a sub-to-do's, which sits one list further down — a done parent over an open
 * child is a thing a reader writes, and striking the child would say it was done too. A link in a
 * done line goes dim with the words around it rather than staying the one lit thing in the row.
 *
 * **The text between the lists is spaced as the note's is** (issue #688): a top-level paragraph
 * and a top-level list each take `my-1`, the headings take {@link HEADING_PROSE}, and the first and
 * last blocks give their outer margin back — `PROSE`'s own recipe. A to-do's line and a sub-list
 * stay flush (`[&_li_p]`, `[&_li_ul]`), which is why neither selector is the bare element any more:
 * a bare `[&_p]:m-0` and `[&>p]:my-1` would both match a top-level paragraph at one specificity,
 * and which won would be the stylesheet's order rather than anything written here.
 */
const CHECKLIST_PROSE = cn(
  "[&_ul]:list-none [&_ul]:p-0 [&_li_ul]:m-0",
  "[&_li]:flex [&_li]:items-start [&_li]:gap-2 [&_li]:py-0.5",
  "[&_li>label]:relative [&_li>label]:flex [&_li>label]:h-5 [&_li>label]:shrink-0",
  "[&_li>label]:items-center [&_li>div]:min-w-0 [&_li>div]:flex-1 [&_li_p]:m-0",
  "[&_li[data-checked=true]>div>p]:text-dim [&_li[data-checked=true]>div>p]:line-through",
  "[&_li[data-checked=true]>div>p_a]:text-dim",
  "[&>p]:my-1 [&>ul]:my-1 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
  HEADING_PROSE,
  INLINE_PROSE,
);

/**
 * The writing surface itself.
 *
 * **{@link PRESS_STILL} and never {@link PRESS}**, which is the one rule on this component that is
 * not about the dialect: nothing a reader types into takes the press dip. A box that shrinks 3%
 * under the pointer pressing it moves its own contents — and its caret — out from under that
 * pointer, which is issue #179 one control along. The recipe without the dip is what
 * `FilterChips`' `FILTER_FIELD` already wears for the same reason.
 *
 * `focus:outline-none` with a border that goes gold instead: an outline on a box the reader is
 * typing in draws a second edge around an edge that is already there, and the border is what every
 * other field in these dialogs lights up (`META_FIELD`, `FIELD`).
 *
 * ⚠️ **The prompt's five utilities are compiled in `NoteEditor.test.tsx` rather than read.** An
 * arbitrary value Tailwind cannot parse emits **no rule and no warning**, so a surface with no
 * prompt is what a typo here buys — and nothing else in either build can see it.
 *
 * **The checklist draws the same box** ({@link CHECKLIST_SURFACE}), prompt included: the prompt
 * paints only while the whole document is empty (`is-editor-empty`), and a list of one empty
 * to-do is exactly that, so the empty paragraph it lands on is the first child of that to-do's
 * text column and the recipe needs no second spelling.
 */
const SURFACE_BOX = cn(
  "min-h-32 w-full px-2.5 py-2 text-sm text-text",
  "focus:outline-none",
  // The prompt, painted on the empty paragraph {@link Placeholder} marked. `float-left h-0` is
  // ProseMirror's own recipe: a `::before` in flow would push the caret down a line, and a
  // floated zero-height box leaves the caret exactly where an empty paragraph puts it.
  "[&_.is-editor-empty:first-child]:before:pointer-events-none",
  "[&_.is-editor-empty:first-child]:before:float-left",
  "[&_.is-editor-empty:first-child]:before:h-0",
  "[&_.is-editor-empty:first-child]:before:text-dim",
  "[&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
  PRESS_STILL,
);

const SURFACE = cn(SURFACE_BOX, PROSE, INLINE_PROSE);

/** A to-do list's writing surface: the note's box, drawn as rows. */
const CHECKLIST_SURFACE = cn(SURFACE_BOX, CHECKLIST_PROSE);

/**
 * What the writing surface is, as far as ProseMirror is concerned.
 *
 * A factory rather than a constant because `ariaLabel` is a prop: `editorProps` is captured when
 * the editor is built, so a label that changed after mount would go stale silently — and the
 * likeliest caller changes it on every keystroke, since an untitled note's name is its body's
 * first line. Both the build and the update read this one object.
 */
function surfaceAttributes(ariaLabel: string, surface: string): Record<string, string> {
  return {
    class: surface,
    // ProseMirror's `contenteditable` maps to a textbox in a real browser and to nothing at all
    // in jsdom, so the role is spelled out: without it every test here would have to address the
    // box by a class.
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": ariaLabel,
  };
}

/** One icon button in the toolbar: 28px square, quiet until it has something to say. */
const TOOL_BUTTON = cn(
  "flex size-7 shrink-0 items-center justify-center rounded-md border",
  PRESS,
  FOCUS,
);

/**
 * On, off, and out of reach — `filterChipState`'s vocabulary, with the resting border cleared.
 *
 * A filter chip carries a hairline when it is off so the row reads as a row of controls. These are
 * eleven 28px squares in a strip above the box they act on, and eleven hairlines there is a grid
 * rather than a toolbar — so off is borderless and dim, and the border arrives *with* the accent
 * when the caret is standing in the thing the button makes. Pressed is `border-accent text-accent`
 * unchanged, because that is what a pressed control means everywhere else in this app.
 */
function toolState(pressed: boolean): string {
  return pressed ? "border-accent text-accent" : "border-transparent text-dim hover:text-text";
}

function ToolButton({
  icon: Icon,
  name,
  pressed,
  onPress,
}: {
  icon: LucideIcon;
  /** The accessible name **and** the hint — the button draws a glyph and no words. */
  name: string;
  /**
   * Whether the caret is standing in the thing this button makes. Omitted, and the button is not
   * a toggle at all — which is the link's case, where the *name* changes instead.
   */
  pressed?: boolean;
  onPress: () => void;
}) {
  const tip = useTooltip();
  return (
    <button
      type="button"
      // The caret has to stay in the document. A press that took focus would collapse the
      // selection the command is about, so the mark would land on nothing — the same refusal
      // the quick add's dropdown rows make, one gesture along.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      aria-pressed={pressed}
      aria-label={name}
      // `describes: false` — the hint is the `aria-label` verbatim, so describing it would have a
      // screen reader say the same three words twice.
      {...tip(name, { describes: false })}
      className={cn(TOOL_BUTTON, toolState(pressed === true))}
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}

/** A group of buttons about one kind of thing. Spacing rather than a rule: four hairlines in a
 *  28px strip is furniture, and the gap already says where one group ends. */
function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

/**
 * A fresh, empty to-do at the **end of the document**, at the top level — the New to-do press.
 *
 * * **After a list, it joins that list**, under whatever its last to-do holds — **unless the last
 *   to-do is already empty**, which is reused rather than doubled: that is what makes the press
 *   safe to repeat, since a reader who presses it twice without typing gets one blank line, not
 *   two.
 * * **After text, it starts a new list** — the document ends on a paragraph or a heading, and the
 *   to-do goes under it rather than into a list further up the page.
 * * **A blank paragraph at the end is where the to-do goes**, not a line under it: it is what an
 *   Enter on an empty to-do leaves, and a to-do pressed for straight after would otherwise sit
 *   under a gap nobody meant. The list before it, if there is one, is then the one appended to.
 *
 * The end of the document rather than the end of the first list, which is what #672 appended to:
 * a list then was the whole document, and a to-do list with text in it is read top to bottom.
 */
function appendTodo(tr: Transaction): boolean {
  const { taskList, taskItem, paragraph } = tr.doc.type.schema.nodes;
  const item = taskItem.create({ checked: false }, paragraph.create());
  const end = () => tr.doc.content.size;
  let last = tr.doc.lastChild;
  if (last?.type === paragraph && last.content.size === 0) {
    if (tr.doc.childCount === 1) {
      tr.replaceWith(0, end(), taskList.create(null, item));
      return true;
    }
    tr.delete(end() - last.nodeSize, end());
    last = tr.doc.lastChild;
  }
  if (last?.type === taskList) {
    const tail = last.lastChild;
    if (!(tail && tail.childCount === 1 && tail.textContent === "")) tr.insert(end() - 1, item);
  } else {
    tr.insert(end(), taskList.create(null, item));
  }
  return true;
}

/** What the toolbar reads off the document, recomputed only when one of these answers changes. */
interface Marks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bullet: boolean;
  ordered: boolean;
  quote: boolean;
  /** The caret is in a **top-level** paragraph — the checklist's Paragraph button. A to-do's own
   *  line is a paragraph too, and is not this: it is {@link Marks.todo}. */
  paragraph: boolean;
  /** The caret is on a to-do's line — the checklist's To-do button. */
  todo: boolean;
  link: boolean;
  href: string;
}

function readMarks(editor: Editor): Marks {
  const { $from } = editor.state.selection;
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    h1: editor.isActive("heading", { level: 1 }),
    h2: editor.isActive("heading", { level: 2 }),
    h3: editor.isActive("heading", { level: 3 }),
    bullet: editor.isActive("bulletList"),
    ordered: editor.isActive("orderedList"),
    quote: editor.isActive("blockquote"),
    paragraph: $from.depth === 1 && $from.parent.type.name === "paragraph",
    todo: todoAt($from) !== null,
    link: editor.isActive("link"),
    href: String(editor.getAttributes("link").href ?? ""),
  };
}

export default function NoteEditor({
  value,
  onChange,
  ariaLabel,
  mode = "note",
  appendRequest,
  onAppendHandled,
}: {
  /** The note's body, as CommonMark in the dialect above — or, in checklist mode, a to-do list's. */
  value: string;
  /** Called with **markdown** on every edit — never HTML and never ProseMirror JSON. */
  onChange: (markdown: string) => void;
  /**
   * What the writing surface is called. Required, because a page can draw two of these at once —
   * one note being edited beside another — and "Note body" twice is two boxes a keyboard reader
   * cannot tell apart.
   */
  ariaLabel: string;
  /**
   * `"checklist"` edits a deck's to-do list: {@link CHECKLIST_EXTENSIONS}, a toolbar of the marks,
   * a link, Heading 1–3, Paragraph, To-do, Outdent and Indent, and a delete button on every
   * to-do's row. Omitted, this is the note editor it has always been. **Read once, at mount** —
   * the schema is built from it, and a schema cannot change under a live document.
   */
  mode?: "note" | "checklist";
  /**
   * Checklist mode only: a counter the host bumps to ask for a fresh to-do at the end of the
   * document with the caret in it — a **New to-do** press. A counter rather than a flag, so a
   * second press is a second request; `0` and absent ask for nothing, and a mount that already
   * carries a request honours it, because a host can open and ask in one press.
   */
  appendRequest?: number;
  /** Called once each request has been honoured — including one that appended nothing. */
  onAppendHandled?: () => void;
}) {
  // Latched, because `useEditor` builds its `onUpdate` once and would otherwise call the first
  // render's callback for the life of the editor. An unstable prop is then a re-render rather
  // than a note whose edits go nowhere. Written in an effect and not during render: the React
  // Compiler lint rules refuse a ref written in the render phase, and an edit cannot arrive
  // before the mount effects have run anyway.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // The same latch, for the same reason, so a host's inline callback is not a dependency of the
  // append below — which would otherwise run again, and ask again, on every host render.
  const onAppendHandledRef = useRef(onAppendHandled);
  useEffect(() => {
    onAppendHandledRef.current = onAppendHandled;
  }, [onAppendHandled]);

  // **Chosen once, at mount, and never again.** The schema is built from the extension list the
  // editor is first handed, so a list that changed under a live editor would be a toolbar and a
  // surface drawn for one kit over a document of the other. Both lists are module constants, so
  // latching the choice is all it takes for `useEditor` to see one stable array for life.
  const [checklist] = useState(mode === "checklist");
  const extensions = checklist ? CHECKLIST_EXTENSIONS : NOTE_EXTENSIONS;
  const surface = checklist ? CHECKLIST_SURFACE : SURFACE;

  const linkFieldId = useId();

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    // ⚠️ **Never left to its default**, which appends a sheet at runtime that every shipped host
    // refuses, with a console error for each editor opened. The module header has what it
    // carried and why nothing replaces it; `tokens.test.ts` goes red for an editor without this.
    injectCSS: false,
    editorProps: { attributes: surfaceAttributes(ariaLabel, surface) },
    onUpdate: ({ editor: instance }) => onChangeRef.current(instance.getMarkdown()),
  });

  const marks = useEditorState({ editor, selector: ({ editor: e }) => readMarks(e) });

  // `null` is closed. The draft is held here rather than read off the document so that a reader
  // editing an existing link can clear the box without the link going with it.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const linkFieldRef = useRef<HTMLInputElement>(null);

  /**
   * A `value` the editor did not produce — the note reloaded, or another device's copy arriving —
   * replaces the document. A value it *did* produce is skipped, or every keystroke would rebuild
   * the document under the caret and put it back at the start.
   *
   * `emitUpdate: false`, so restoring a body is not itself an edit worth writing back.
   *
   * ⚠️ **The destroyed guard is load-bearing, and both calls below need it.** `editor.commands`
   * and `editor.getMarkdown()` both reach through `editor.view`, which is `null` once the
   * instance is torn down — so either one throws `Cannot read properties of null`, uncaught,
   * from inside a passive effect, which unwinds the whole React tree rather than failing one
   * component. It is reachable because this editor is always mounted behind `Suspense`: React
   * hides and *reconnects* that subtree (`reconnectPassiveEffects`), so this effect can run
   * again after the instance it closed over has gone. Found on 2026-09-20 from the home page's
   * sticky-note dialog, where a story play mounts the surface — `DeckNotesPanel`'s stories never
   * do, which is the only reason the deck band had not hit it.
   */
  useEffect(() => {
    if (editor.isDestroyed) return;
    if (editor.getMarkdown() === value) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  // The name follows the prop rather than the mount. See {@link surfaceAttributes}.
  useEffect(() => {
    editor.setOptions({ editorProps: { attributes: surfaceAttributes(ariaLabel, surface) } });
  }, [editor, ariaLabel, surface]);

  /**
   * Honour a request for a fresh to-do — {@link appendTodo} — then put the caret at the end of the
   * document, which is that to-do's line. Either way the request is answered, so the host can stop
   * asking. The destroyed guard is the value effect's, for its reason.
   */
  useEffect(() => {
    if (!checklist || !appendRequest || editor.isDestroyed) return;
    editor.chain().command(({ tr }) => appendTodo(tr)).run();
    editor.commands.focus("end");
    onAppendHandledRef.current?.();
  }, [editor, appendRequest, checklist]);

  function openLink() {
    setLinkDraft(marks.href);
    // After the row has been drawn. A caret put in a box that does not exist yet lands nowhere.
    requestAnimationFrame(() => linkFieldRef.current?.focus());
  }

  function applyLink(href: string) {
    const trimmed = href.trim();
    setLinkDraft(null);

    // An emptied box is how a link comes off without leaving the row — the press a reader would
    // otherwise have to cancel out of first.
    if (trimmed === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    // ⚠️ **Nothing selected means there is nothing for the mark to be on.** `setLink` over a
    // collapsed selection writes a mark across an empty range: no error, no text, and a control
    // that reads as broken. The address becomes the words instead, which is what "add a link"
    // means when a reader has not picked any.
    if (editor.state.selection.empty && !editor.isActive("link")) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text: trimmed,
          marks: [{ type: "link", attrs: { href: trimmed } }],
        })
        .run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
  }

  return (
    <div className="rounded-md border border-border bg-bg focus-within:border-accent">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-1.5 py-1">
        <ToolGroup>
          <ToolButton
            icon={Bold}
            name="Bold"
            pressed={marks.bold}
            onPress={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolButton
            icon={Italic}
            name="Italic"
            pressed={marks.italic}
            onPress={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolButton
            icon={Strikethrough}
            name="Strikethrough"
            pressed={marks.strike}
            onPress={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolButton
            icon={Code}
            name="Code"
            pressed={marks.code}
            onPress={() => editor.chain().focus().toggleCode().run()}
          />
        </ToolGroup>

        {/* The note's blocks. A to-do list draws its own heading buttons after the link — they lift
            a to-do's line out of its list first, which the note's toggle has no reason to — and
            none of the others, because it can hold no list but its own and no quote. */}
        {!checklist && (
          <>
            <ToolGroup>
              <ToolButton
                icon={Heading1}
                name="Heading 1"
                pressed={marks.h1}
                onPress={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              />
              <ToolButton
                icon={Heading2}
                name="Heading 2"
                pressed={marks.h2}
                onPress={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              />
              <ToolButton
                icon={Heading3}
                name="Heading 3"
                pressed={marks.h3}
                onPress={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              />
            </ToolGroup>

            <ToolGroup>
              <ToolButton
                icon={List}
                name="Bulleted list"
                pressed={marks.bullet}
                onPress={() => editor.chain().focus().toggleBulletList().run()}
              />
              <ToolButton
                icon={ListOrdered}
                name="Numbered list"
                pressed={marks.ordered}
                onPress={() => editor.chain().focus().toggleOrderedList().run()}
              />
              <ToolButton
                icon={TextQuote}
                name="Quote"
                pressed={marks.quote}
                onPress={() => editor.chain().focus().toggleBlockquote().run()}
              />
            </ToolGroup>
          </>
        )}

        <ToolGroup>
          {/* Two names on one button, which is `Set as foil` / `Set as regular`'s grammar: the
              press does the opposite thing in the two states, so it says which. No `aria-pressed`
              — a control whose *name* changes is not a control that is on. */}
          {marks.link ? (
            <ToolButton
              icon={Unlink}
              name="Remove the link"
              onPress={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
            />
          ) : (
            <ToolButton icon={LinkIcon} name="Add a link" onPress={openLink} />
          )}
        </ToolGroup>

        {/* What the caret's line **is** — the only buttons in the checklist that change it, so a
            mark pressed on a line of text never makes a to-do (issue #688). Five toggles, each lit
            for the block the caret stands in: a heading of that level, a top-level paragraph, a
            to-do's line. A lit heading or To-do pressed again turns the line back into a
            paragraph; a lit Paragraph has nothing to turn back into. */}
        {checklist && (
          <ToolGroup>
            <ToolButton
              icon={Heading1}
              name="Heading 1"
              pressed={marks.h1}
              onPress={() => lineToText(editor, marks.h1 ? null : 1)}
            />
            <ToolButton
              icon={Heading2}
              name="Heading 2"
              pressed={marks.h2}
              onPress={() => lineToText(editor, marks.h2 ? null : 2)}
            />
            <ToolButton
              icon={Heading3}
              name="Heading 3"
              pressed={marks.h3}
              onPress={() => lineToText(editor, marks.h3 ? null : 3)}
            />
            <ToolButton
              icon={Pilcrow}
              name="Paragraph"
              pressed={marks.paragraph}
              onPress={() => lineToText(editor, null)}
            />
            <ToolButton
              icon={ListTodo}
              name="To-do"
              pressed={marks.todo}
              onPress={() => lineToTodo(editor)}
            />
          </ToolGroup>
        )}

        {/* Tab and Shift-Tab, for a pointer. Not toggles — nothing is "on" about a level — so no
            `aria-pressed`; each is one press that moves the to-do the caret is in one level. */}
        {checklist && (
          <ToolGroup>
            <ToolButton
              icon={ListIndentDecrease}
              name="Outdent"
              onPress={() => {
                editor.commands.focus();
                liftTodo(editor);
              }}
            />
            <ToolButton
              icon={ListIndentIncrease}
              name="Indent"
              onPress={() => editor.chain().focus().sinkListItem("taskItem").run()}
            />
          </ToolGroup>
        )}
      </div>

      {linkDraft !== null && (
        <form
          className="flex items-center gap-2 border-b border-border px-1.5 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink(linkDraft);
          }}
        >
          {/* `useId`, because a band can draw two editors at once and a duplicated `id` points
              one note's label at another note's box. */}
          <label className="sr-only" htmlFor={linkFieldId}>
            Link address
          </label>
          <input
            id={linkFieldId}
            ref={linkFieldRef}
            type="url"
            inputMode="url"
            placeholder="https://scryfall.com/…"
            value={linkDraft}
            onChange={(event) => setLinkDraft(event.target.value)}
            className={cn(
              "h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-[0.8125rem]",
              "placeholder:text-dim focus:border-accent focus:outline-none",
              PRESS_STILL,
            )}
          />
          <button
            type="submit"
            className={cn(
              "h-7 shrink-0 rounded-md border border-accent px-2.5 text-xs text-accent",
              "hover:bg-accent hover:text-accent-foreground",
              PRESS,
              FOCUS,
            )}
          >
            Apply
          </button>
          <button
            type="button"
            aria-label="Cancel"
            onClick={() => setLinkDraft(null)}
            className={cn(TOOL_BUTTON, toolState(false))}
          >
            <X aria-hidden className="size-4" />
          </button>
        </form>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
