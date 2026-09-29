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
 * sites and across the specs and plans — `grep -rn "141.5" src/ docs/` is the census — and none
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
 * edits a deck's to-do list with {@link CHECKLIST_EXTENSIONS} — one task list and nothing else —
 * and `todoMarkdown.ts` reads those bodies for the home widget without an editor either. So the
 * test file holds a second committed corpus, and asserts both halves against it: the editor's
 * round trip byte for byte, and that reader's tree for the same body.
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
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  EditorContent,
  mergeAttributes,
  // `TiptapNode` because the bare name would shadow the DOM's own `Node`, which the checklist's
  // node view needs for `contains()`.
  Node as TiptapNode,
  useEditor,
  useEditorState,
  type Editor,
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
 * The three that stay on and are *not* in the dialect list are behaviour rather than schema, and
 * each earns its place: `undoRedo` is Ctrl+Z, `listKeymap` is Enter and Backspace inside a list,
 * and `gapcursor` is how a caret gets past a blockquote that is the last thing in the document —
 * which matters here precisely because `trailingNode` is off and there is no spare paragraph to
 * land in. None of them can put a node or a mark into a body. `dropcursor` is off because
 * dragging inside a note is not a gesture this app offers.
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
 * What an empty to-do list says. It teaches the two keys, because the list has no other way in:
 * no toolbar button makes a to-do, and nesting is a keystroke nothing on screen draws.
 */
export const TODO_PLACEHOLDER = "Add a to-do — Enter for the next, Tab to nest.";

/**
 * A document that is one task list and nothing else — so every line is a to-do, and there is no
 * place to type a paragraph outside one.
 *
 * `renderMarkdown` is not optional and its absence is silent: the stock `Document` carries one,
 * and a top node without it serialises **every** body as `""` — measured, on every entry of the
 * corpus at once. One child means the separator is never used; it is `Document`'s own.
 */
const ChecklistDocument = TiptapNode.create({
  name: "doc",
  topNode: true,
  content: "taskList",
  renderMarkdown: (node, h) => (node.content ? h.renderChildren(node.content, "\n\n") : ""),
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
 * Two cases are not a plain delete, because a task list may not be empty. **A sub-to-do that is
 * its list's only item takes the list with it** — the parent keeps its words and loses an empty
 * indent. **The document's only to-do is cleared instead**, to one empty item: a document with no
 * task list is one this schema cannot hold, and one empty to-do is exactly the list's resting
 * state, which `todoMarkdown.ts` reads as nothing at all. Ctrl+Z brings any of the three back.
 *
 * The positions are read off the transaction's own document, so a press racing a keystroke acts
 * on the row as it is now rather than as it was drawn.
 */
function deleteTodo(editor: Editor, getPos: () => number | undefined): void {
  const pos = getPos();
  if (typeof pos !== "number") return;
  editor
    .chain()
    // `focus` first, `TaskItem`'s own checkbox's order: a press from the keyboard leaves the
    // button it was on detached, and the caret has to come back into the list rather than land
    // on `<body>`. No scroll — the reader is looking at the row they just removed.
    .focus(undefined, { scrollIntoView: false })
    .command(({ tr }) => {
      const item = tr.doc.nodeAt(pos);
      if (!item || item.type.name !== "taskItem") return false;
      const $pos = tr.doc.resolve(pos);
      if ($pos.parent.childCount > 1) {
        tr.delete(pos, pos + item.nodeSize);
      } else if ($pos.depth > 1) {
        tr.delete($pos.before(), $pos.after());
      } else {
        const { taskItem, paragraph } = tr.doc.type.schema.nodes;
        tr.replaceWith(
          pos,
          pos + item.nodeSize,
          taskItem.create({ checked: false }, paragraph.create()),
        );
      }
      return true;
    })
    .run();
}

/**
 * `TaskItem`, with a delete button on every row and a Shift-Enter that means something.
 *
 * **The parent's node view is wrapped, never copied** (`this.parent?.()`), so Tiptap's checkbox,
 * its accessible name and its own `update` stay exactly Tiptap's; what this adds is appended to
 * the view it hands back. The button is `contentEditable=false`; `stopEvent` keeps ProseMirror's
 * own mouse and key handling off it, so a press is a press and never a caret placed under it; and
 * `ignoreMutation` keeps its DOM from reading as an edit to the document. Everything the parent's
 * view already answered — its `stopEvent`, its `ignoreMutation` — is still asked first-hand for
 * anything that is not the button.
 *
 * **Shift-Enter makes the next to-do**, because there is no hard break in this dialect for it to
 * make (see {@link CHECKLIST_EXTENSIONS}) and a key that did nothing at all would read as broken.
 */
const ChecklistItem = TaskItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      "Shift-Enter": () => this.editor.commands.splitListItem(this.name),
    };
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

/**
 * The checklist's whole dialect, spelled out — `NOTE_EXTENSIONS`' rule, every option that is off
 * written out, for its reason.
 *
 * **The dialect is a task list of paragraphs with the inline marks**: document (one task list),
 * task list, task item (nested), paragraph, text, bold, italic, strike, code, link. That is what
 * the to-do corpus in `NoteEditor.test.tsx` pins and what `todoMarkdown.ts` reads, and nothing
 * else — so headings, both other lists, list items and blockquote are off: a document that can
 * hold none of them has no button for them either.
 *
 * ⚠️ **`hardBreak` is off, which is where this list departs from the spec** (§3 keeps it), and
 * the reason is a measurement rather than a preference. Its markdown is `"  \n"` with the rest of
 * the line unindented, and `TaskList`'s tokenizer reads a task item **one line at a time** — so
 * the second half of a broken to-do comes back as a paragraph *outside* the list, in a document
 * whose top node may hold nothing but the list. A construct only one side of the round trip can
 * spell is exactly what the module header says must not enter a dialect. `NoteEditor.test.tsx`
 * pins the failure, and goes red the day the tokenizer learns continuation lines.
 *
 * Three behaviours stay, each as in `NOTE_EXTENSIONS`: `undoRedo` is Ctrl+Z, which is the only
 * undo a deleted to-do has; `listKeymap` because its default list types include `taskItem` —
 * Backspace at the head of a to-do and Delete at the end of one — and it skips the `listItem`
 * type this schema does not have rather than failing on it; and `gapcursor` by absence, the one
 * StarterKit type that can only be said as "off". `trailingNode` stays off for the stronger of
 * its two reasons here: the paragraph it pins to the end of a document is one this top node
 * cannot hold at all.
 *
 * **`document: false`, and {@link ChecklistDocument} in its place** — StarterKit builds its own
 * `doc` with `block+` and hands out no handle to change it, the same reason `NoteHeading` exists.
 *
 * **The placeholder takes `includeChildren`**, which the note's does not: it looks for an empty
 * *top-level* textblock by default, and the top level here is the list — so without it an empty
 * checklist would teach nothing at all.
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

    // Replaced below by the one-list document.
    document: false,

    // Out of the dialect: every block a to-do list cannot hold, and the break it cannot read.
    heading: false,
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
  TaskList,
  ChecklistItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: (node, checked) =>
        `Mark "${todoWords(node)}" ${checked ? "not done" : "done"}`,
    },
  }),
  Placeholder.configure({ placeholder: TODO_PLACEHOLDER, includeChildren: true }),
  Markdown,
];

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
  "[&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-text",
  "[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-text",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-dim",
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
 */
const CHECKLIST_PROSE = cn(
  "[&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0",
  "[&_li]:flex [&_li]:items-start [&_li]:gap-2 [&_li]:py-0.5",
  "[&_li>label]:relative [&_li>label]:flex [&_li>label]:h-5 [&_li>label]:shrink-0",
  "[&_li>label]:items-center [&_li>div]:min-w-0 [&_li>div]:flex-1 [&_p]:m-0",
  "[&_li[data-checked=true]>div>p]:text-dim [&_li[data-checked=true]>div>p]:line-through",
  "[&_li[data-checked=true]>div>p_a]:text-dim",
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
  link: boolean;
  href: string;
}

function readMarks(editor: Editor): Marks {
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
  /** The note's body, as CommonMark in the dialect above — or, in checklist mode, a to-do list. */
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
   * a link, Outdent and Indent, and a delete button on every row. Omitted, this is the note
   * editor it has always been. **Read once, at mount** — the schema is built from it, and a
   * schema cannot change under a live document.
   */
  mode?: "note" | "checklist";
  /**
   * Checklist mode only: a counter the host bumps to ask for a fresh to-do at the end of the list
   * with the caret in it — the band's **New to-do**. A counter rather than a flag, so a second
   * press is a second request; `0` and absent ask for nothing, and a mount that already carries a
   * request honours it, because the band opens and asks in one press.
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
   * Honour a request for a fresh to-do: append an empty one at the end of the list — at the top
   * level, under whatever the last to-do holds — unless the last one is already empty, then put
   * the caret there. Either way the request is answered, so the host can stop asking.
   *
   * **An empty last to-do is reused rather than doubled**, which is what makes the press safe to
   * repeat: a reader who presses New to-do twice without typing gets one blank line, not two.
   *
   * The position is the end of the first task list's own content rather than the document's, so
   * a body some other writer left with a stray line after the list still appends into the list.
   * The destroyed guard is the value effect's, for its reason.
   */
  useEffect(() => {
    if (!checklist || !appendRequest || editor.isDestroyed) return;
    const list = editor.state.doc.firstChild;
    if (list?.type.name === "taskList") {
      const last = list.lastChild;
      const lastEmpty = last !== null && last.childCount === 1 && last.textContent === "";
      if (!lastEmpty) {
        editor
          .chain()
          .insertContentAt(list.content.size + 1, {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph" }],
          })
          .run();
      }
    }
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

        {/* The note's blocks. A to-do list can hold none of them, so it draws none of them — a
            heading button over a document that cannot have a heading would be a press that does
            nothing. */}
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

        {/* Tab and Shift-Tab, for a pointer. Not toggles — nothing is "on" about a level — so no
            `aria-pressed`; each is one press that moves the to-do the caret is in one level. */}
        {checklist && (
          <ToolGroup>
            <ToolButton
              icon={ListIndentDecrease}
              name="Outdent"
              onPress={() => editor.chain().focus().liftListItem("taskItem").run()}
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
