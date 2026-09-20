// `@tiptap/react` rather than `@tiptap/core`: it re-exports the whole of core, and it is the
// package this app declares. Reaching into an undeclared transitive dependency works until a
// hoist changes.
import { Editor } from "@tiptap/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { describe, expect, it, vi } from "vitest";
// Tailwind's own entry, read through Vite rather than `node:fs` — this project has no
// `@types/node` on purpose, which is `tokens.test.ts`'s note and why `?raw` is the house style
// for a test that asserts against a file's text. The entry is self-contained (one
// `@tailwind utilities` and no `@import` of its own), so handing it back from `loadStylesheet`
// is the whole of the resolver the compile below needs.
import twEntry from "tailwindcss/index.css?raw";
import appCss from "@/index.css?raw";
import NoteEditor, { NOTE_EXTENSIONS, NOTE_PLACEHOLDER } from "./NoteEditor";
import source from "./NoteEditor.tsx?raw";

/**
 * jsdom implements no layout, so a `Range` answers nothing about where it is — and it does not
 * merely answer badly, it has **no such method at all**.
 *
 * ProseMirror asks one on every dispatch that scrolls the selection into view (`coordsAtPos` →
 * `singleRect(textRange(...))`), which is every command chained off `.focus()`. The `TypeError`
 * is thrown inside the view's own dispatch, so it escapes as an **unhandled error**: vitest
 * reports it beside the results and the tests themselves still pass, which is the shape of red
 * that reads as a library being broken rather than as the environment being thin.
 *
 * `??=` throughout, so a jsdom that grows a real implementation is used instead of these — the
 * same convention `src/test-setup.ts` uses for its own dozen shims. Local to this file rather
 * than in that one: no other suite mounts a ProseMirror view.
 */
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * Every construct the note dialect has, in the spelling Tiptap emits.
 *
 * **This is the fence between the two renderers.** `noteMarkdown.ts` reads the same bodies without
 * mounting an editor, so a construct this editor can write that the reader has no rule for renders
 * as a literal paragraph — the reader's own markup typed back at them. Both sides are pinned to
 * this list, and widening the dialect means a rule on both.
 *
 * The corpus is written in **canonical** spellings on purpose. CommonMark has more than one way to
 * say most of these (`_italic_` for `*italic*`, a blank line between list items, an indented
 * continuation line) and Tiptap normalises each to one; the normalisations are pinned in their own
 * test below, so that this one can say the stronger thing — a body that came *out* of this editor
 * goes back in and comes out identical, for ever.
 */
const DIALECT_CORPUS = [
  // Paragraph, and the empty document.
  "",
  "A plain paragraph.",
  "A paragraph.\n\nAnother paragraph.",

  // Headings, all three levels the dialect has.
  "# Heading one",
  "## Heading two",
  "### Heading three",
  "# H1\n\n## H2\n\n### H3",
  "# Heading **one**",
  "## A [link](https://scryfall.com) in a heading",

  // The four marks, alone and nested.
  "**bold** and *italic* and ~~strike~~ and `code`",
  "***bold and italic***",
  "**bold *nested italic***",
  "~~struck [link](https://scryfall.com)~~",
  "`code with ** stars`",
  "`a` and `b`",

  // Lists, nested lists, and marks inside items.
  "- one\n- two\n- three",
  "1. one\n2. two\n3. three",
  "5. starts at five\n6. and six",
  "- outer\n  - inner",
  "1. outer\n   1. inner",
  "- a **bold** item\n- a [link](https://x.test) item",

  // Blockquote, including a quote holding more than one block.
  "> a quote",
  "> a quote\n> across two lines",
  "> first\n>\n> second",
  "> - a list in a quote",

  // Hard break — the two-space spelling, in a paragraph and in a list item.
  "line one  \nline two",
  "- item one  \nitem two",

  // Link.
  "[Scryfall](https://scryfall.com)",
  "A [bare link](https://scryfall.com/card/lea/161) inline.",

  // A whole note, the way one is actually written.
  "## Mana\n\nFourteen sources.\n\n- Sol Ring\n- Arcane Signet\n\n> Cut a land.",
];

/** One trip through the editor: markdown in, document, markdown out. */
function roundTrip(markdown: string): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: NOTE_EXTENSIONS,
    content: markdown,
    contentType: "markdown",
  });
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

describe("the note dialect", () => {
  it("round-trips every construct without rewriting it", () => {
    // The two renderers agree only as long as this holds: Tiptap's markdown out must equal the
    // markdown in for every construct `parseNoteBody` has a rule for. A drift here is a note that
    // changes shape the second time it is opened.
    //
    // Asserted as one array rather than in a loop of `expect`s so that a failure names *every*
    // construct that moved, not just the first — the fix for one of these is usually the fix for
    // several, and the whole list is what says which.
    const moved = DIALECT_CORPUS.filter((body) => roundTrip(body) !== body).map(
      (body) => `${JSON.stringify(body)} → ${JSON.stringify(roundTrip(body))}`,
    );
    expect(moved).toEqual([]);
  });

  /**
   * The alternate spellings, and what they settle to.
   *
   * These are not round-trip failures — CommonMark says the same construct several ways and Tiptap
   * picks one — but they are what the *reader* has to cope with, because a body typed as `_x_` is
   * stored as `*x*` and a body pasted with `\*` keeps its backslash. Pinned so the two renderers
   * cannot disagree about which spelling is the stored one.
   */
  it("settles the alternate spellings on one of them", () => {
    expect(roundTrip("**bold _nested italic_**")).toBe("**bold *nested italic***");
    expect(roundTrip("- one\n\n- two")).toBe("- one\n- two");
    expect(roundTrip("- item one  \n  item two")).toBe("- item one  \nitem two");
  });

  /**
   * ⚠️ **A literal `*` or `_` in a reader's prose comes back backslash-escaped**, and that is the
   * one thing about this dialect the read-only renderer cannot infer from the construct list.
   * `noteMarkdown.ts` has to unescape `\<punctuation>`, or a note reading *"a * b"* is drawn as
   * *"a \* b"* — the reader's own sentence with a backslash in it.
   *
   * A backslash before a character that is *not* significant is dropped instead, which is the
   * other half of the same rule.
   */
  it("escapes markdown punctuation in plain text, and drops an escape that means nothing", () => {
    expect(roundTrip("a * b")).toBe("a \\* b");
    expect(roundTrip("a_b_c")).toBe("a\\_b\\_c");
    expect(roundTrip("A line with a\\# hash")).toBe("A line with a# hash");
  });

  /**
   * Every output above is a fixed point — the property the round trip is *for*.
   *
   * The corpus asserts `f(x) === x` for the canonical spellings; this asserts `f(f(x)) === f(x)`
   * for the ones that are not, so a note typed in an alternate spelling settles once and then
   * never moves again. Without it, "it normalises" and "it oscillates" look identical.
   */
  it("never moves a body twice", () => {
    const unstable = ["**bold _nested italic_**", "- one\n\n- two", "- item one  \n  item two", "a * b", "a_b_c"]
      .map((body) => roundTrip(body))
      .filter((once) => roundTrip(once) !== once);
    expect(unstable).toEqual([]);
  });
});

describe("what the editor may draw", () => {
  /**
   * The dialect, read off the configuration rather than off the schema.
   *
   * A StarterKit default that changes in a minor release is a construct entering the dialect on
   * one side only, silently — this build's editor would emit a fenced code block that the reader
   * draws as three backticks and a paragraph. So the four that are off are named here by hand.
   */
  it("has no code block, rule, underline or trailing node", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: NOTE_EXTENSIONS,
    });
    const names = Object.keys(editor.schema.nodes).concat(Object.keys(editor.schema.marks));
    expect(names).not.toContain("codeBlock");
    expect(names).not.toContain("horizontalRule");
    expect(names).not.toContain("underline");
    editor.destroy();
  });

  it("has every node and mark the reader is drawn with", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: NOTE_EXTENSIONS,
    });
    for (const node of [
      "doc",
      "paragraph",
      "text",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "hardBreak",
    ]) {
      expect(Object.keys(editor.schema.nodes)).toContain(node);
    }
    for (const mark of ["bold", "italic", "strike", "code", "link"]) {
      expect(Object.keys(editor.schema.marks)).toContain(mark);
    }
    editor.destroy();
  });

  /**
   * ⚠️ **`levels` bounds the keyboard and the parser, not the `level` attribute** — so a `####` in
   * a body the reader **pasted** survives as a real level-4 node. No reader can *make* one: there
   * is no toolbar button and no input rule past level 3.
   *
   * The body is left exactly as it was pasted, deliberately. Clamping on parse would mean this
   * editor silently rewriting a reader's own text, which is the one thing a note editor must not
   * do — so the level stays on the node and `renderMarkdown`, which reads that attribute and never
   * asks `renderHTML`, writes the four hashes straight back out.
   */
  it("keeps a deeper heading from a pasted body rather than rewriting it", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: NOTE_EXTENSIONS,
      content: "#### four\n\n##### five",
      contentType: "markdown",
    });
    const levels: number[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") levels.push(Number(node.attrs.level));
    });
    expect(levels).toEqual([4, 5]);
    expect(editor.getMarkdown()).toBe("#### four\n\n##### five");
    editor.destroy();
  });

  /**
   * ⚠️ **…and it is *drawn* at level 3, which is the half neither renderer could see alone.**
   *
   * Stock `Heading.renderHTML` draws an out-of-range level as `levels[0]` — **`h1`**, the largest
   * heading on the screen, for the one construct the dialect does not have — while
   * `parseNoteBody` clamps the same body to level 3. So before {@link NOTE_EXTENSIONS} overrode
   * `renderHTML`, one pasted note read as a title while being edited and as the smallest heading
   * while being read, with nothing on either side saying so.
   *
   * **This assertion is also the fence around a duplicate `heading` extension.** `@tiptap/starter-kit`
   * pins its whole family to one exact version, so a bump that moved it and left
   * `@tiptap/extension-heading` behind would put two nodes named `heading` in the schema; Tiptap
   * logs a warning and picks one, the round trip above stays green, and the clamp silently stops
   * working. This is what goes red instead.
   */
  it("draws a deeper heading at the deepest level the dialect has, not the shallowest", () => {
    const element = document.createElement("div");
    const editor = new Editor({
      element,
      extensions: NOTE_EXTENSIONS,
      content: "#### four",
      contentType: "markdown",
    });
    expect(element.querySelector("h3")?.textContent).toBe("four");
    expect(element.querySelector("h1")).toBeNull();
    // The document did not move to make that true: the node is still a 4 and the body still says so.
    expect(editor.getMarkdown()).toBe("#### four");
    editor.destroy();
  });

  it("still draws the three levels it has at their own weights", () => {
    const element = document.createElement("div");
    const editor = new Editor({
      element,
      extensions: NOTE_EXTENSIONS,
      content: "# one\n\n## two\n\n### three",
      contentType: "markdown",
    });
    expect(element.querySelector("h1")?.textContent).toBe("one");
    expect(element.querySelector("h2")?.textContent).toBe("two");
    expect(element.querySelector("h3")?.textContent).toBe("three");
    editor.destroy();
  });
});

describe("NoteEditor", () => {
  it("is a default export, because it is reached only through React.lazy", () => {
    expect(typeof NoteEditor).toBe("function");
  });

  it("names the writing surface with what it was handed", () => {
    render(<NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Mana base body" />);
    expect(screen.getByRole("textbox", { name: "Mana base body" })).toHaveTextContent(
      "Fourteen sources.",
    );
  });

  it("hands the caller markdown rather than HTML or JSON", async () => {
    const onChange = vi.fn();
    render(<NoteEditor value="Fourteen sources." onChange={onChange} ariaLabel="Note body" />);

    await userEvent.click(screen.getByRole("button", { name: "Heading 2" }));

    expect(onChange).toHaveBeenCalledWith("## Fourteen sources.");
  });

  it("says which of its buttons the caret is standing in", async () => {
    render(<NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Note body" />);
    const quote = screen.getByRole("button", { name: "Quote" });
    expect(quote).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(quote);

    expect(screen.getByRole("button", { name: "Quote" })).toHaveAttribute("aria-pressed", "true");
  });

  it("takes a body it did not write, and leaves one it did alone", () => {
    const view = render(
      <NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Note body" />,
    );
    view.rerender(<NoteEditor value="Sixteen sources." onChange={vi.fn()} ariaLabel="Note body" />);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent(
      "Sixteen sources.",
    );
  });

  it("renames the surface when its name changes, rather than keeping the one it mounted with", () => {
    // `editorProps` is captured when the editor is built, so this is the one prop that goes
    // stale silently — and the likeliest caller changes it on every keystroke, since an untitled
    // note is named after its body's first line.
    const view = render(
      <NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Untitled note body" />,
    );
    view.rerender(
      <NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Mana base body" />,
    );
    expect(screen.getByRole("textbox", { name: "Mana base body" })).toBeInTheDocument();
  });

  it("turns the link button into its opposite once the caret is in one", async () => {
    render(
      <NoteEditor
        value="A [bare link](https://scryfall.com) inline."
        onChange={vi.fn()}
        ariaLabel="Note body"
      />,
    );
    // The caret starts at the head of the document, outside the link.
    expect(screen.getByRole("button", { name: "Add a link" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add a link" }));

    expect(screen.getByLabelText("Link address")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel the link" }));
    expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
  });

  it("writes the address as the words when a reader has selected none", async () => {
    // `setLink` over a collapsed selection marks an empty range — no error, no text, and a
    // control that reads as broken. The one press a reader is most likely to make on an empty
    // note has to put something on the page.
    const onChange = vi.fn();
    render(<NoteEditor value="" onChange={onChange} ariaLabel="Note body" />);

    await userEvent.click(screen.getByRole("button", { name: "Add a link" }));
    await userEvent.type(screen.getByLabelText("Link address"), "https://scryfall.com");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenLastCalledWith("[https://scryfall.com](https://scryfall.com)");
  });
});

/**
 * ⚠️ **The CSP check is a source sweep because it cannot be a behavioural one.**
 *
 * The shipped policy is `style-src 'self'` and the dev policy adds `style-src 'unsafe-inline'`, so
 * a runtime stylesheet works perfectly under `npm run tauri dev`, works in jsdom, works in
 * Storybook, and does nothing at all in a built binary — the editor simply draws unstyled and
 * nothing is logged. That is `motion`'s two forbidden APIs exactly, and `src/lib/tokens.test.ts`
 * bans those the same way, for the same reason.
 */
describe("the stylesheet", () => {
  it("is imported so the bundler carries it, and is never injected at runtime", () => {
    expect(source).toContain('import "prosemirror-view/style/prosemirror.css"');
    expect(source).not.toContain("document.head");
    expect(source).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
  });
});

/* ------------------------------------------------------------------ the placeholder ---- */

describe("the empty surface's prompt", () => {
  it("teaches the naming rule on an empty surface, because there is no title field to do it", async () => {
    render(<NoteEditor value="" onChange={vi.fn()} ariaLabel="Body of a new note" />);

    // ProseMirror writes the sentence onto the empty paragraph as `data-placeholder`, and the CSS
    // in `SURFACE` is what paints it. The attribute is the half jsdom can referee.
    const empty = await screen.findByRole("textbox");
    expect(empty.querySelector("[data-placeholder]")).toHaveAttribute(
      "data-placeholder",
      NOTE_PLACEHOLDER,
    );
  });

  it("says nothing on a surface that already has a body", async () => {
    render(<NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Body of Mana base" />);
    const surface = await screen.findByRole("textbox");
    expect(surface.querySelector("[data-placeholder]")).toBeNull();
  });

  /** The sentence the dialog's `NOTE_PLACEHOLDER` is the one home for, pinned so the naming rule
   *  cannot quietly stop being taught by being reworded into saying something else. */
  it("says what happens to the first line", () => {
    expect(NOTE_PLACEHOLDER).toBe("Start typing — the first line becomes the note's name.");
  });
});

/**
 * Compile a utility against the app's **own** stylesheet and hand back the `@layer utilities`
 * block it produced — empty string where Tailwind emitted nothing at all.
 *
 * ⚠️ **Because the failure this guards against is silent.** A mistyped arbitrary value, or a
 * colour token this build does not carry, produces **no rule and no warning**: `tsc` passes,
 * both suites pass, the class sits right there in the source, and the surface simply has no
 * prompt. That is `src/index.css`'s own `@custom-variant` trap one layer out, and
 * `keyboardModality.test.ts`'s `selectorFor` is the shape this copies — including reading both
 * stylesheets through Vite's `?raw` rather than `node:fs`, since this project has no
 * `@types/node`.
 *
 * **`src/index.css` and not a bare `@import "tailwindcss"`**, which is the one thing about this
 * helper that had to be got right: `text-dim` is a project token declared in an `@theme` block
 * there, so compiled against stock Tailwind it emits nothing — and the test would then be
 * reporting the shipped stylesheet's own colour as a defect. Every other `@import` that file
 * makes is answered with an empty sheet: two font families, `tw-animate-css` and shadcn's
 * theme contribute no utility this file is about.
 *
 * **The utilities layer, one candidate at a time, and never the whole sheet.** Two different ways
 * a looser check reads success out of silence, and only the second is about this rule at all:
 *
 * * **`::before` is in preflight**, which names `*, ::after, ::before, ::backdrop,
 *   ::file-selector-button` to zero its box model. So `built.includes("::before")` is `true` for a
 *   candidate that emitted nothing — measured: a junk candidate builds 11 583 characters from
 *   `src/index.css` and 4 614 from stock Tailwind, and both contain it.
 * * **`content:` comes from the *siblings*, and this is the sharper of the two.** Preflight sets
 *   no `content` at all — a sheet built from one junk candidate holds neither `content:` nor
 *   `--tw-content` — but the `before:` variant injects `content: var(--tw-content);` into **every**
 *   rule it makes, so the other four utilities each emit one. Build all five with only the
 *   `content-[…]` one mistyped and the sheet reads `content:` **true** and
 *   `attr(data-placeholder)` **false**: the whole sheet says the prompt is painted while the one
 *   declaration that paints it is missing. Measured, both ways round.
 *
 * Which is why this compiles **one** candidate and returns only what `@layer utilities` holds:
 * nothing a sibling emitted, and nothing preflight wrote, can stand in for the rule being asked
 * about. An earlier draft of this comment claimed the `content:` half came from preflight; it does
 * not, and that was the same mistake one level up — an explanation nobody had falsified.
 */
async function compiledUtilities(utility: string): Promise<string> {
  const built = await buildSheet([utility]);
  return built.match(/@layer utilities \{([\s\S]*?)\n\}/)?.[1].trim() ?? "";
}

/** The whole built sheet for a set of candidates — what {@link compiledUtilities} narrows, and
 *  what the trap above is demonstrated over. */
async function buildSheet(utilities: readonly string[]): Promise<string> {
  const compiler = await compile(appCss, {
    base: "/",
    loadStylesheet: (id: string) =>
      Promise.resolve(
        id === "tailwindcss"
          ? { path: "/tailwindcss/index.css", base: "/tailwindcss", content: twEntry }
          : { path: "/empty.css", base: "/", content: "" },
      ),
    loadModule: () => Promise.reject(new Error("no JS modules expected")),
  });
  return compiler.build([...utilities]);
}

/** The utilities `SURFACE` paints the prompt with, lifted out of the shipped source rather than
 *  copied here — a list written twice is a list that can agree with itself while disagreeing with
 *  the file that ships. */
const PROMPT_UTILITIES = [
  ...source.matchAll(/"(\[&_\.is-editor-empty:first-child\]:before:[^"]+)"/g),
].map(([, utility]) => utility);

describe("the prompt's CSS is really compiled", () => {
  it("is painted from SURFACE at all", () => {
    // A sweep over nothing finds nothing: an empty list would make every assertion below pass
    // while proving the opposite of what it says.
    expect(PROMPT_UTILITIES.length).toBe(5);
  });

  it("emits a rule for every one of them", async () => {
    const silent: string[] = [];
    for (const utility of PROMPT_UTILITIES) {
      if ((await compiledUtilities(utility)) === "") silent.push(utility);
    }
    // Collected as a list rather than asserted one at a time, so a failure names *which* of the
    // five emitted nothing instead of stopping at the first.
    expect(silent).toEqual([]);
  });

  it("really compiles the prompt's content rule", async () => {
    const built = await compiledUtilities(
      "[&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
    );
    expect(built).toContain("content:");
    expect(built).toContain("attr(data-placeholder)");
    // The descendant half of the variant, which is what puts the rule on ProseMirror's own
    // decorated paragraph rather than on the surface itself.
    expect(built).toContain(".is-editor-empty:first-child::before");
  });

  /**
   * The control, and it is what makes the three above mean anything: Tailwind answers a class it
   * cannot parse with **silence**, not with an error — so a test that cannot tell that silence
   * from success is a test that would pass over the defect.
   */
  it("emits nothing at all for a prompt rule that is mistyped", async () => {
    expect(
      await compiledUtilities("[&_.is-editor-empty:first-child]:before:content[attr(data-placeholder)]"),
    ).toBe("");
    expect(await compiledUtilities("[&_.is-editor-empty:first-child]:before:text-dimm")).toBe("");
  });

  /**
   * **The trap {@link compiledUtilities} exists to avoid, asserted rather than described.**
   *
   * Both halves are measurements this file would otherwise only claim, and the first draft of
   * that claim was wrong — so it is pinned instead. Preflight zeroes the box model of
   * `::before`, so the glyph is in every sheet; it sets no `content`, so a sheet built from one
   * junk candidate has none. What puts `content:` there is the **`before:` variant itself**,
   * which injects `content: var(--tw-content)` into every rule it makes — so the four siblings
   * supply the word while the one utility that carries the sentence emits nothing.
   *
   * A whole-sheet check therefore reads *painted* off a surface with no prompt on it, which is
   * the exact shape of vacuous assertion this describe block is about.
   */
  it("would read as painted off the whole sheet, which is why it is not read that way", async () => {
    const mistyped = "[&_.is-editor-empty:first-child]:before:content[attr(data-placeholder)]";
    const siblings = PROMPT_UTILITIES.filter((u) => !u.includes("content-["));
    expect(siblings).toHaveLength(4);

    // One junk candidate alone: the glyph is preflight's, and there is no `content` anywhere.
    const alone = await buildSheet([mistyped]);
    expect(alone).toContain("::before");
    expect(alone).not.toContain("content:");
    expect(alone).not.toContain("--tw-content");

    // The same junk candidate beside its four working siblings: `content:` is back — from them.
    const together = await buildSheet([...siblings, mistyped]);
    expect(together).toContain("content:");
    expect(together).not.toContain("attr(data-placeholder)");
  });
});
