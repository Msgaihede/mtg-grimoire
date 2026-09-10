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
 * an ordinary row: the toolbar is icon-only, so the hint is the whole of what a pointer gets.
 */
import "prosemirror-view/style/prosemirror.css";

import Heading, { type Level } from "@tiptap/extension-heading";
import { Markdown } from "@tiptap/markdown";
import {
  EditorContent,
  mergeAttributes,
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
  "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5",
  "[&_code]:font-mono [&_code]:text-[0.8125rem]",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
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
 */
const SURFACE = cn(
  "min-h-32 w-full px-2.5 py-2 text-sm text-text",
  "focus:outline-none",
  PRESS_STILL,
  PROSE,
);

/**
 * What the writing surface is, as far as ProseMirror is concerned.
 *
 * A factory rather than a constant because `ariaLabel` is a prop: `editorProps` is captured when
 * the editor is built, so a label that changed after mount would go stale silently — and the
 * likeliest caller changes it on every keystroke, since an untitled note's name is its body's
 * first line. Both the build and the update read this one object.
 */
function surfaceAttributes(ariaLabel: string): Record<string, string> {
  return {
    class: SURFACE,
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
}: {
  /** The note's body, as CommonMark in the dialect above. */
  value: string;
  /** Called with **markdown** on every edit — never HTML and never ProseMirror JSON. */
  onChange: (markdown: string) => void;
  /**
   * What the writing surface is called. Required, because a page can draw two of these at once —
   * one note being edited beside another — and "Note body" twice is two boxes a keyboard reader
   * cannot tell apart.
   */
  ariaLabel: string;
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

  const linkFieldId = useId();

  const editor = useEditor({
    extensions: NOTE_EXTENSIONS,
    content: value,
    contentType: "markdown",
    editorProps: { attributes: surfaceAttributes(ariaLabel) },
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
   */
  useEffect(() => {
    if (editor.getMarkdown() === value) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  // The name follows the prop rather than the mount. See {@link surfaceAttributes}.
  useEffect(() => {
    editor.setOptions({ editorProps: { attributes: surfaceAttributes(ariaLabel) } });
  }, [editor, ariaLabel]);

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
            aria-label="Cancel the link"
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
