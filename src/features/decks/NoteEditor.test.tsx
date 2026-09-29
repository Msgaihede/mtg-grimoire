// `@tiptap/react` rather than `@tiptap/core`: it re-exports the whole of core, and it is the
// package this app declares. Reaching into an undeclared transitive dependency works until a
// hoist changes.
import { Editor } from "@tiptap/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { describe, expect, it, vi, type Mock } from "vitest";
// Tailwind's own entry, read through Vite rather than `node:fs` — this project has no
// `@types/node` on purpose, which is `tokens.test.ts`'s note and why `?raw` is the house style
// for a test that asserts against a file's text. The entry is self-contained (one
// `@tailwind utilities` and no `@import` of its own), so handing it back from `loadStylesheet`
// is the whole of the resolver the compile below needs.
import twEntry from "tailwindcss/index.css?raw";
import appCss from "@/index.css?raw";
import NoteEditor, {
  CHECKLIST_EXTENSIONS,
  NOTE_EXTENSIONS,
  NOTE_PLACEHOLDER,
  TODO_PLACEHOLDER,
} from "./NoteEditor";
import source from "./NoteEditor.tsx?raw";
import { parseTodoBody, parseTodos, type TodoBlock, type TodoItem } from "./todoMarkdown";

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
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
    expect(NOTE_PLACEHOLDER).toBe("Start typing. The first line becomes the title.");
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
  return layerOf(await buildSheet([utility]), "utilities");
}

/**
 * One `@layer <name> { … }` block out of a built sheet — `""` where the build emitted none.
 *
 * **Regions rather than the whole sheet, because the whole sheet includes `src/index.css`'s own
 * rules.** A `content:` added anywhere in that stylesheet would redden an assertion about what
 * *preflight* does; narrowing to the layer being asked about keeps the test's subject and the
 * test's scope the same thing. The **first** `@layer base` is preflight — this build emits two,
 * the second being the app's own base rules — which the caller pins by checking for
 * `box-sizing`.
 */
function layerOf(sheet: string, name: "base" | "utilities"): string {
  return sheet.match(new RegExp(`@layer ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1].trim() ?? "";
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

    // **One junk candidate alone.** Read off preflight rather than off the whole sheet: the glyph
    // is preflight's and so is the absence of `content`, and `src/index.css` is free to grow a
    // `content:` of its own without that becoming a claim about this rule. `box-sizing` pins that
    // the region really is preflight and not the app's own `@layer base` below it.
    const alone = await buildSheet([mistyped]);
    const preflight = layerOf(alone, "base");
    expect(preflight).toContain("box-sizing");
    expect(preflight).toContain("::before");
    expect(preflight).not.toContain("content:");
    // And the candidate emitted no utility at all, which is the other half of the silence.
    expect(layerOf(alone, "utilities")).toBe("");

    // **The same junk candidate beside its four working siblings**: `content:` is back — theirs —
    // in the utilities layer itself, with the declaration that paints the prompt still missing.
    const together = layerOf(await buildSheet([...siblings, mistyped]), "utilities");
    expect(together).toContain("content:");
    expect(together).not.toContain("attr(data-placeholder)");
  });
});

/* ------------------------------------------------------------------ the checklist ---- */

/** A to-do as {@link parseTodos} reads it, with the inline runs left out — the tree, not the marks. */
interface TodoShape {
  text: string;
  done: boolean;
  line: number;
  children: TodoShape[];
}

function todo(text: string, done: boolean, line: number, children: TodoShape[] = []): TodoShape {
  return { text, done, line, children };
}

function shapeOf(items: TodoItem[]): TodoShape[] {
  return items.map((item) => ({
    text: item.text,
    done: item.done,
    line: item.line,
    children: shapeOf(item.children),
  }));
}

/**
 * The blocks {@link parseTodoBody} reads, one short line each — the order and kind of every block,
 * a heading's level and a paragraph's words. The to-dos' own trees are {@link TodoShape}'s job; a
 * list is summarised by how many to-dos it holds at its top.
 */
function blocksOf(blocks: TodoBlock[]): string[] {
  return blocks.map((block) =>
    block.kind === "heading"
      ? `h${block.level}: ${block.text}`
      : block.kind === "text"
        ? `p: ${block.text}`
        : `todos: ${block.items.length}`,
  );
}

/**
 * Every shape a deck's to-do list can take, in the spelling Tiptap writes — and what the reader
 * draws from each: the blocks a card draws, and the tree the widget ticks.
 *
 * **This is the to-do dialect's fence**, the way {@link DIALECT_CORPUS} is the note dialect's: the
 * editor writes these bodies and `todoMarkdown.ts` reads them without mounting an editor, so both
 * halves are pinned to one list here and a shape one side grows is a red build on the other.
 *
 * **The #672 entries are kept byte for byte** — every line a to-do, one list — and each reads as
 * one `todos` block holding the tree it always did, which is the promise that a body written
 * before #688 opens and ticks exactly as it did. The entries after them are #688's: headings and
 * paragraphs beside two lists, and a paragraph whose words only look like a to-do.
 *
 * ⚠️ **Measured, not assumed (2026-09-29, `@tiptap/extension-list` 3.31.3):**
 *
 * * **A sub-to-do is indented by two spaces a level** — `renderNestedMarkdownContent` through the
 *   markdown extension's default `indent`, and the three-deep entry pins that it compounds (two,
 *   then four). Four spaces in is read back and written out as two (the normalisations below).
 * * **The emptied list is `"- [ ] "`, with its trailing space** — one empty item, which is what a
 *   task list that may not be empty collapses to, and which the reader leaves out.
 * * **There is no hard break in this dialect at all.** `hardBreak` writes `"  \n"` and the
 *   continuation unindented, and the task list's own tokenizer is line-based, so that second line
 *   comes back as a paragraph *outside* the list. {@link CHECKLIST_EXTENSIONS} therefore leaves
 *   the node out; the case below that pins the upstream failure is what goes red if it is fixed.
 * * **Blocks are separated by one blank line** (#688) — a heading, a paragraph and a list alike —
 *   and a list after text is a list of its own, with no blank line inside it.
 * * **A paragraph whose words start `- [ ] ` is written `\- \[ \] `**: the editor's own escape of
 *   the leading bullet (`escapeLineStart`), and the markdown writer's of the brackets, which it
 *   escapes anywhere in a line. Unescaped, the line was written as a bullet list this dialect has
 *   no node for, and the parse dropped it — measured, and the reason for the escape.
 */
const CHECKLIST_CORPUS: { body: string; blocks: string[]; todos: TodoShape[] }[] = [
  // The emptied list: one empty item, which is a place to type rather than a thing to do.
  { body: "- [ ] ", blocks: [], todos: [] },

  // Flat, and the tick.
  { body: "- [ ] Revise tokens", blocks: ["todos: 1"], todos: [todo("Revise tokens", false, 0)] },
  { body: "- [x] Revise tokens", blocks: ["todos: 1"], todos: [todo("Revise tokens", true, 0)] },
  {
    body: "- [ ] Revise tokens\n- [x] Cut a land\n- [ ] Order sleeves",
    blocks: ["todos: 3"],
    todos: [
      todo("Revise tokens", false, 0),
      todo("Cut a land", true, 1),
      todo("Order sleeves", false, 2),
    ],
  },

  // Nesting — two spaces a level, and it compounds.
  {
    body: "- [ ] Mana\n  - [ ] Cut a land",
    blocks: ["todos: 1"],
    todos: [todo("Mana", false, 0, [todo("Cut a land", false, 1)])],
  },
  {
    body: "- [ ] Mana\n  - [x] Cut a land\n    - [ ] Swap in a Triome",
    blocks: ["todos: 1"],
    todos: [
      todo("Mana", false, 0, [todo("Cut a land", true, 1, [todo("Swap in a Triome", false, 2)])]),
    ],
  },
  // A done parent over an open child, and back out to the top.
  {
    body: "- [x] Mana\n  - [ ] Cut a land\n- [ ] Order sleeves",
    blocks: ["todos: 2"],
    todos: [todo("Mana", true, 0, [todo("Cut a land", false, 1)]), todo("Order sleeves", false, 2)],
  },

  // The inline dialect inside a to-do: the four marks and a link.
  {
    body: "- [ ] **Revise** *the* ~~old~~ `tokens` [list](https://scryfall.com)",
    blocks: ["todos: 1"],
    todos: [todo("Revise the old tokens list", false, 0)],
  },
  // A literal `*` and `_` come back escaped, and the reader has to take the backslash off.
  {
    body: "- [ ] 2 \\* 3 and a\\_b",
    blocks: ["todos: 1"],
    todos: [todo("2 * 3 and a_b", false, 0)],
  },

  // What an append leaves behind: a trailing empty item the reader leaves out.
  {
    body: "- [ ] Revise tokens\n- [ ] ",
    blocks: ["todos: 1"],
    todos: [todo("Revise tokens", false, 0)],
  },

  /* ---- #688: a to-do document ---- */

  // A heading, a list with a sub-to-do, a paragraph with a mark, and a second list — the todos
  // are both lists' top-level items in order, the text between them no to-do at all.
  {
    body: "## Mana\n\n- [ ] Cut a land\n  - [x] Check curve\n\nSome notes about **why**.\n\n- [ ] Revise tokens",
    blocks: ["h2: Mana", "todos: 1", "p: Some notes about why.", "todos: 1"],
    todos: [
      todo("Cut a land", false, 2, [todo("Check curve", true, 3)]),
      todo("Revise tokens", false, 7),
    ],
  },
  // Text and nothing else is a list too — a list with no to-dos in it yet.
  { body: "# Title\n\nplain words", blocks: ["h1: Title", "p: plain words"], todos: [] },
  // Two lists with a line of text between them stay two lists.
  {
    body: "- [ ] a\n\nbetween\n\n- [ ] b",
    blocks: ["todos: 1", "p: between", "todos: 1"],
    todos: [todo("a", false, 0), todo("b", false, 4)],
  },
  // A paragraph whose words are `- [ ] literal`: escaped on the way out, and never a box.
  { body: "\\- \\[ \\] literal", blocks: ["p: - [ ] literal"], todos: [] },
];

/** One trip through the checklist editor: markdown in, document, markdown out. */
function checklistTrip(markdown: string): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: CHECKLIST_EXTENSIONS,
    content: markdown,
    contentType: "markdown",
  });
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

describe("the to-do dialect", () => {
  it("round-trips every shape without rewriting it", () => {
    const moved = CHECKLIST_CORPUS.filter(({ body }) => checklistTrip(body) !== body).map(
      ({ body }) => `${JSON.stringify(body)} → ${JSON.stringify(checklistTrip(body))}`,
    );
    expect(moved).toEqual([]);
  });

  /** The other half of the fence: the widget's reader draws the same bodies as the same trees. */
  it("reads every shape as the tree the editor drew", () => {
    const misread = CHECKLIST_CORPUS.filter(
      ({ body, todos }) => JSON.stringify(shapeOf(parseTodos(body))) !== JSON.stringify(todos),
    ).map(({ body }) => `${JSON.stringify(body)} → ${JSON.stringify(shapeOf(parseTodos(body)))}`);
    expect(misread).toEqual([]);
  });

  /** …and the card's reader draws them as the same blocks, text and headings where they were. */
  it("reads every shape as the blocks the editor drew", () => {
    const misread = CHECKLIST_CORPUS.filter(
      ({ body, blocks }) => JSON.stringify(blocksOf(parseTodoBody(body))) !== JSON.stringify(blocks),
    ).map(({ body }) => `${JSON.stringify(body)} → ${JSON.stringify(blocksOf(parseTodoBody(body)))}`);
    expect(misread).toEqual([]);
  });

  /** The same bodies, as the editor holds them: a heading, a paragraph and a list where written. */
  it("opens text as text and to-dos as to-dos", () => {
    const editor = checklistEditor(
      "## Mana\n\n- [ ] Cut a land\n  - [x] Check curve\n\nSome notes about **why**.\n\n- [ ] Revise tokens",
    );
    const blocks: string[] = [];
    editor.state.doc.forEach((node) => blocks.push(node.type.name));
    expect(blocks).toEqual(["heading", "taskList", "paragraph", "taskList"]);
    expect(editor.state.doc.child(0).attrs.level).toBe(2);
    expect(() => editor.state.doc.check()).not.toThrow();
    editor.destroy();
  });

  it("settles the alternate spellings on the one it writes", () => {
    expect(checklistTrip("")).toBe("- [ ] ");
    expect(checklistTrip("- [ ] Mana\n    - [ ] Cut a land")).toBe("- [ ] Mana\n  - [ ] Cut a land");
    expect(checklistTrip("* [ ] Revise tokens")).toBe("- [ ] Revise tokens");
    expect(checklistTrip("- [X] Revise tokens")).toBe("- [x] Revise tokens");
    expect(checklistTrip("- [ ] 2 * 3")).toBe("- [ ] 2 \\* 3");
    // A setext heading is written the one way the dialect has.
    expect(checklistTrip("Title\n===")).toBe("# Title");
  });

  it("never moves a body twice", () => {
    const unstable = [
      "",
      "- [ ] Mana\n    - [ ] Cut a land",
      "* [ ] a",
      "- [X] a",
      "- [ ] 2 * 3",
      "Title\n===",
    ]
      .map((body) => checklistTrip(body))
      .filter((once) => checklistTrip(once) !== once);
    expect(unstable).toEqual([]);
  });

  /**
   * ⚠️ **A line of text that would read back as another block is escaped at its start** (#688) —
   * `escapeLineStart`, and every row here is the measurement behind it.
   *
   * The markdown writer escapes `` \ ` * _ [ ] ~ `` anywhere in a line and `< > &` as entities,
   * and nothing about the line's **start**. Before the escape, a paragraph beginning `- ` or `+ `
   * was written as a bullet list — which this dialect has no node for, so the parse dropped the
   * line outright — a `# ` one came back a heading, and a `1. ` one a list. Each row is written
   * as a paragraph, asserted in the exact spelling the editor writes, and read back as the same
   * paragraph with the same words.
   */
  it.each([
    ["- [ ] literal", "\\- \\[ \\] literal"],
    ["- plain dash", "\\- plain dash"],
    ["+ plus", "\\+ plus"],
    ["# not a heading", "\\# not a heading"],
    ["###### six", "\\###### six"],
    ["1. not a list", "1\\. not a list"],
    ["2) paren", "2\\) paren"],
    ["---", "\\---"],
    ["- - -", "\\- - -"],
    // Nothing to escape — none of these starts a block — and so nothing is.
    ["#hashtag", "#hashtag"],
    ["-5 life", "-5 life"],
    ["2024 was a year", "2024 was a year"],
    // Entities and the inline escapes, which the writer applies anywhere in a line.
    ["> quoted", "&gt; quoted"],
    ["* star", "\\* star"],
    ["[x] box", "\\[x\\] box"],
    // Four spaces in would be an indented code block, which this dialect would drop too.
    ["    four spaces", "four spaces"],
  ])("writes a line of text %j as %j, and reads it back as that text", (words, written) => {
    const editor = checklistEditor("x");
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: words }] }],
    });
    const body = editor.getMarkdown();
    editor.destroy();
    expect(body).toBe(written);

    const back = checklistEditor(body);
    expect(back.state.doc.childCount).toBe(1);
    expect(back.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(back.state.doc.firstChild?.textContent).toBe(words.trimStart());
    expect(back.getMarkdown()).toBe(body);
    back.destroy();
    // And the card's reader draws it as the words too, never as a box or a heading. ⚠️ Not asked
    // of an entity: the writer spells `<`, `>` and `&` as `&lt;` `&gt;` `&amp;` — in a note and a
    // to-do's line alike, measured — and `noteMarkdown.ts`' `parseInlines` decodes none of them,
    // on the stated belief that Tiptap does not write them. That is the readers' to settle, and
    // is older than #688; what is asserted above is that the *editor* reads them back.
    if (!written.includes("&")) {
      expect(blocksOf(parseTodoBody(body))).toEqual([`p: ${words.trimStart()}`]);
    }
  });

  /**
   * ⚠️ **`\- [ ] literal` — the bullet's escape alone — is not a spelling this editor reads back as
   * text, and it is not one it writes.** It writes `\- \[ \] literal` (the corpus's last entry),
   * because the markdown writer escapes brackets anywhere. Measured: given the shorter spelling,
   * `TaskList`'s tokenizer still finds `- [ ] ` past the backslash, and the line opens as a
   * paragraph holding only `\` over a to-do. Pinned so that anything reaching for the shorter
   * spelling — a reader's test, a fixture, a seed — finds out here that the brackets' escapes are
   * what keep the line text.
   */
  it("reads the bullet-only escape as a to-do, which is why the brackets are escaped too", () => {
    const editor = checklistEditor("\\- [ ] literal");
    const kinds: string[] = [];
    editor.state.doc.forEach((node) => kinds.push(`${node.type.name}:${node.textContent}`));
    expect(kinds).toEqual(["paragraph:\\", "taskList:literal"]);
    editor.destroy();
  });

  /**
   * ⚠️ **Why the checklist has no hard break, pinned as the measurement rather than described.**
   *
   * `hardBreak` writes `"  \n"` and leaves the rest of the line unindented, and `TaskList`'s
   * markdown tokenizer reads a task item one line at a time — so the break's second half comes
   * back as a line **outside** the list: since #688, a paragraph of its own under the list. So a
   * broken to-do would split in two the next time it was opened. A construct only one side of the
   * round trip can spell is the one thing the module header says must not enter a dialect, so the
   * node is left out.
   *
   * **This goes red the day the tokenizer learns continuation lines** — the body would then read
   * back as one to-do — which is the day a hard break could come back.
   */
  it("has no hard break, because its own reader cannot read one back out of a to-do", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: CHECKLIST_EXTENSIONS,
      content: "- [ ] first  \nsecond",
      contentType: "markdown",
    });
    expect(Object.keys(editor.schema.nodes)).not.toContain("hardBreak");
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).textContent).toBe("second");
    editor.destroy();
  });
});

describe("what the checklist may draw", () => {
  it("is a to-do document of paragraphs, headings and task lists with the inline marks, and nothing else", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: CHECKLIST_EXTENSIONS,
    });
    const nodes = Object.keys(editor.schema.nodes);
    const marks = Object.keys(editor.schema.marks);
    for (const node of ["doc", "paragraph", "heading", "text", "taskList", "taskItem"]) {
      expect(nodes).toContain(node);
    }
    for (const mark of ["bold", "italic", "strike", "code", "link"]) {
      expect(marks).toContain(mark);
    }
    for (const node of [
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "hardBreak",
    ]) {
      expect(nodes).not.toContain(node);
    }
    expect(marks).not.toContain("underline");
    // Text beside the to-dos (#688), where #672's top node took one task list and nothing else.
    // `paragraph` first: it is what a split makes, so a heading's Enter makes a paragraph.
    expect(editor.schema.topNodeType.spec.content).toBe("(paragraph | heading | taskList)+");
    // …and a to-do is still one line of words: no heading inside one.
    expect(editor.schema.nodes.taskItem.spec.content).toBe("paragraph taskList?");
    expect(editor.extensionManager.extensions.find((e) => e.name === "heading")?.options.levels).toEqual(
      [1, 2, 3],
    );
    editor.destroy();
  });
});

/** The ProseMirror instance behind a mounted surface — Tiptap hangs it on the view's own DOM. */
function editorOf(surface: HTMLElement): Editor {
  return (surface as HTMLElement & { editor: Editor }).editor;
}

/** Put the caret at the end of the first text run containing `text`. */
function caretAfter(editor: Editor, text: string): void {
  let at: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (at !== null || !node.isText) return at === null;
    const index = node.text?.indexOf(text) ?? -1;
    if (index >= 0) at = pos + index + text.length;
    return false;
  });
  if (at === null) throw new Error(`no text run holds ${JSON.stringify(text)}`);
  editor.commands.setTextSelection(at);
}

function renderChecklist(
  value: string,
  props: Partial<{
    onChange: Mock<(markdown: string) => void>;
    appendRequest: number;
    onAppendHandled: () => void;
  }> = {},
) {
  const onChange = props.onChange ?? vi.fn<(markdown: string) => void>();
  const view = render(
    <NoteEditor
      mode="checklist"
      value={value}
      onChange={onChange}
      ariaLabel="To-do list"
      appendRequest={props.appendRequest}
      onAppendHandled={props.onAppendHandled}
    />,
  );
  const surface = screen.getByRole("textbox", { name: "To-do list" });
  return { view, surface, editor: editorOf(surface), onChange };
}

describe("NoteEditor in checklist mode", () => {
  it("draws one task list, and a checkbox named after each to-do's own words", () => {
    const { surface } = renderChecklist("- [ ] Mana\n  - [x] Cut a land\n- [ ] Order sleeves");

    expect(surface.querySelectorAll('ul[data-type="taskList"]')).toHaveLength(2);
    expect(surface.querySelectorAll("input[type=checkbox]")).toHaveLength(3);
    // A parent is named for its own line, never for its sub-to-dos' words run on after it.
    expect(screen.getByRole("checkbox", { name: 'Mark "Mana" done' })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: 'Mark "Cut a land" not done' })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: 'Mark "Order sleeves" done' })).not.toBeChecked();
  });

  it("hands the caller the ticked markdown when a box is pressed", async () => {
    const { onChange } = renderChecklist("- [ ] Revise tokens");

    await userEvent.click(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" done' }));

    expect(onChange).toHaveBeenLastCalledWith("- [x] Revise tokens");
    expect(screen.getByRole("checkbox", { name: 'Mark "Revise tokens" not done' })).toBeChecked();
  });

  /**
   * Driven through ProseMirror's own keydown path rather than through the commands, so the
   * bindings are what is under test — `TaskItem`'s Enter, Tab and Shift-Tab reach the keymap
   * plugin in jsdom exactly as they do in the window.
   */
  it("makes the next to-do on Enter, nests it on Tab and lifts it back on Shift-Tab", () => {
    const { surface, editor, onChange } = renderChecklist("- [ ] Revise tokens");
    caretAfter(editor, "Revise tokens");

    fireEvent.keyDown(surface, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n- [ ] ");

    fireEvent.keyDown(surface, { key: "Tab" });
    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n  - [ ] ");

    fireEvent.keyDown(surface, { key: "Tab", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n- [ ] ");
  });

  /** There is no hard break to make (see the dialect's own case), so the key does the list thing. */
  it("makes the next to-do on Shift-Enter too, since there is no line to break", () => {
    const { surface, editor, onChange } = renderChecklist("- [ ] Revise tokens");
    caretAfter(editor, "Revise tokens");

    fireEvent.keyDown(surface, { key: "Enter", shiftKey: true });

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n- [ ] ");
  });

  it("deletes a to-do with its sub-to-dos from the row's own button", async () => {
    const { onChange } = renderChecklist(
      "- [ ] Mana\n  - [ ] Cut a land\n    - [ ] Swap in a Triome\n- [ ] Order sleeves",
    );

    await userEvent.click(screen.getByRole("button", { name: 'Delete "Mana"' }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Order sleeves");
    expect(screen.queryByRole("button", { name: 'Delete "Cut a land"' })).toBeNull();
    expect(screen.queryByRole("button", { name: 'Delete "Swap in a Triome"' })).toBeNull();
  });

  it("takes an only sub-to-do's list with it, rather than leaving an empty one behind", async () => {
    const { onChange } = renderChecklist("- [ ] Mana\n  - [ ] Cut a land\n- [ ] Order sleeves");

    await userEvent.click(screen.getByRole("button", { name: 'Delete "Cut a land"' }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n- [ ] Order sleeves");
  });

  /**
   * A task list may not be empty, so deleting the last to-do leaves one empty one — the list's
   * own resting state, which the reader draws as nothing at all.
   */
  it("leaves one empty to-do when the only one is deleted", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Revise tokens");

    await userEvent.click(screen.getByRole("button", { name: 'Delete "Revise tokens"' }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] ");
    expect(parseTodos(onChange.mock.lastCall?.[0] ?? "unset")).toEqual([]);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(screen.getByRole("checkbox", { name: 'Mark "empty to-do" done' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Delete "empty to-do"' })).toBeInTheDocument();
  });

  it("renames a row's delete button as its words change", () => {
    const { editor } = renderChecklist("- [ ] Revise tokens");
    caretAfter(editor, "Revise tokens");

    editor.commands.insertContent(" twice");

    expect(screen.getByRole("button", { name: 'Delete "Revise tokens twice"' })).toBeInTheDocument();
  });

  it("appends an empty to-do when asked, puts the caret in it, and says it has", () => {
    const handled = vi.fn();
    const onChange = vi.fn();
    const { view, editor } = renderChecklist("- [ ] Revise tokens", {
      onChange,
      appendRequest: 0,
      onAppendHandled: handled,
    });
    expect(handled).not.toHaveBeenCalled();

    view.rerender(
      <NoteEditor
        mode="checklist"
        value="- [ ] Revise tokens"
        onChange={onChange}
        ariaLabel="To-do list"
        appendRequest={1}
        onAppendHandled={handled}
      />,
    );

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n- [ ] ");
    expect(handled).toHaveBeenCalledTimes(1);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("paragraph");
    expect($from.parent.content.size).toBe(0);
    expect($from.index(1)).toBe(1);
  });

  it("appends nothing when the last to-do is already empty, and still says it has", () => {
    const handled = vi.fn();
    const onChange = vi.fn();
    const { view } = renderChecklist("- [ ] Revise tokens\n- [ ] ", {
      onChange,
      appendRequest: 0,
      onAppendHandled: handled,
    });

    view.rerender(
      <NoteEditor
        mode="checklist"
        value={"- [ ] Revise tokens\n- [ ] "}
        onChange={onChange}
        ariaLabel="To-do list"
        appendRequest={1}
        onAppendHandled={handled}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledTimes(1);
  });

  /** The band opens and asks in one press, so the editor mounts already holding the request. */
  it("appends on a mount that already carries a request", () => {
    const handled = vi.fn();
    const { onChange } = renderChecklist("- [ ] Revise tokens", {
      appendRequest: 1,
      onAppendHandled: handled,
    });

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n- [ ] ");
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("appends at the top level, under a last to-do that has sub-to-dos", () => {
    const { onChange } = renderChecklist("- [ ] Mana\n  - [ ] Cut a land", { appendRequest: 1 });

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n  - [ ] Cut a land\n- [ ] ");
  });

  it("offers the marks, a link, the blocks a line can be, outdent and indent — in that order", () => {
    renderChecklist("- [ ] Revise tokens");

    const toolbar = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((name) => !name.startsWith("Delete "));
    expect(toolbar).toEqual([
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "Add a link",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Paragraph",
      "To-do",
      "Outdent",
      "Indent",
    ]);
    // The block buttons are toggles; Outdent and Indent are presses.
    for (const name of ["Heading 1", "Heading 2", "Heading 3", "Paragraph", "To-do"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed");
    }
    for (const name of ["Outdent", "Indent"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-pressed");
    }
    // None of the note's other blocks: a to-do document holds no list but its own, and no quote.
    for (const name of ["Bulleted list", "Numbered list", "Quote"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("nests and lifts a to-do from the toolbar", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Mana\n- [ ] Cut a land");
    caretAfter(editor, "Cut a land");

    await userEvent.click(screen.getByRole("button", { name: "Indent" }));
    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n  - [ ] Cut a land");

    await userEvent.click(screen.getByRole("button", { name: "Outdent" }));
    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n- [ ] Cut a land");
  });

  it("teaches writing, Enter and Tab on an empty list", async () => {
    render(<NoteEditor mode="checklist" value="" onChange={vi.fn()} ariaLabel="To-do list" />);

    const empty = await screen.findByRole("textbox");
    // Read as a string rather than through `toHaveAttribute(name, value)`, which checks only that
    // the attribute exists when the value it is handed is `undefined`.
    expect(empty.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")).toBe(
      "Write, or add a to-do — Enter for the next, Tab to nest.",
    );
    // An empty list opens on one empty to-do, not on a line of text: the schema would fill an
    // empty document with a paragraph, since that is what its content expression names first.
    expect(empty.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
  });

  it("says what a list holds, and what Enter and Tab do", () => {
    expect(TODO_PLACEHOLDER).toBe("Write, or add a to-do — Enter for the next, Tab to nest.");
  });

  /**
   * The kit is chosen once, at mount. `useEditor` builds its schema from the list it is handed
   * first, so a list that changed under a live editor would be a toolbar and a schema disagreeing
   * about what the document can hold.
   */
  it("keeps the kit and the editor it mounted with across a re-render", () => {
    const { view, surface, editor } = renderChecklist("- [ ] Revise tokens");

    view.rerender(
      <NoteEditor value="- [ ] Revise tokens" onChange={vi.fn()} ariaLabel="To-do list" />,
    );

    expect(editorOf(surface)).toBe(editor);
    expect(surface.querySelector('ul[data-type="taskList"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Indent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bulleted list" })).toBeNull();
  });

  it("appends a new list after a trailing line of text", () => {
    const { editor, onChange } = renderChecklist("- [ ] Revise tokens\n\nSome notes", {
      appendRequest: 1,
    });

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Revise tokens\n\nSome notes\n\n- [ ] ");
    const { $from } = editor.state.selection;
    expect($from.parent.content.size).toBe(0);
    expect($from.node($from.depth - 1).type.name).toBe("taskItem");
    expect(editor.state.doc.childCount).toBe(3);
  });

  it("appends after a trailing heading as well", () => {
    const { onChange } = renderChecklist("## Mana", { appendRequest: 1 });
    expect(onChange).toHaveBeenLastCalledWith("## Mana\n\n- [ ] ");
  });

  it("deletes a list's only to-do from between two lines of text, and the list with it", async () => {
    const { editor, onChange } = renderChecklist("Before\n\n- [ ] Revise tokens\n\nAfter");

    await userEvent.click(screen.getByRole("button", { name: 'Delete "Revise tokens"' }));

    expect(onChange).toHaveBeenLastCalledWith("Before\n\nAfter");
    expect(() => editor.state.doc.check()).not.toThrow();
  });
});

/* ----------------------------------------------------------- the block buttons ---- */

/**
 * Issue #688, in the reader's words: *"when clicking a typography in the rich text editor (like
 * h1, h2, bold, italic, etc.) we don't create a to-do item. Also add a 'p' (paragraph) button for
 * regular text not as a todo item."* Heading 1–3, Paragraph and To-do are the only presses that
 * decide what a line is, and every one is driven here through the button a reader presses.
 */
describe("the checklist's block buttons", () => {
  it("makes a to-do's line a heading, and leaves the to-dos after it a list", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Mana\n- [ ] Colours\n- [ ] Curve");
    caretAfter(editor, "Colours");

    await userEvent.click(screen.getByRole("button", { name: "Heading 2" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n\n## Colours\n\n- [ ] Curve");
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  /**
   * A nested to-do is lifted out of **every** list: its own sub-to-dos, and every to-do that came
   * after it at any depth, follow it as one list at the top — the to-dos before it stay put.
   */
  it("lifts a nested to-do out of every list, and its sub-to-dos stay a list after it", async () => {
    const { editor, onChange } = renderChecklist(
      "- [ ] a\n  - [ ] b\n    - [ ] c\n  - [ ] d\n- [ ] e",
    );
    caretAfter(editor, "b");

    await userEvent.click(screen.getByRole("button", { name: "Heading 2" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] a\n\n## b\n\n- [ ] c\n- [ ] d\n- [ ] e");
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  it("keeps a lifted to-do's tick off the heading, and its done sub-to-do done", async () => {
    const { editor, onChange } = renderChecklist("- [x] Mana\n  - [x] Cut a land");
    caretAfter(editor, "Mana");

    await userEvent.click(screen.getByRole("button", { name: "Heading 1" }));

    expect(onChange).toHaveBeenLastCalledWith("# Mana\n\n- [x] Cut a land");
  });

  it("makes a to-do's line a paragraph", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Mana\n- [ ] Some thoughts");
    caretAfter(editor, "Some thoughts");

    await userEvent.click(screen.getByRole("button", { name: "Paragraph" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n\nSome thoughts");
  });

  it("makes a heading a paragraph, and a lit heading pressed again a paragraph too", async () => {
    const { editor, onChange } = renderChecklist("## Mana\n\n### Curve");
    caretAfter(editor, "Mana");
    await userEvent.click(screen.getByRole("button", { name: "Paragraph" }));
    expect(onChange).toHaveBeenLastCalledWith("Mana\n\n### Curve");

    caretAfter(editor, "Curve");
    await userEvent.click(screen.getByRole("button", { name: "Heading 3" }));
    expect(onChange).toHaveBeenLastCalledWith("Mana\n\nCurve");
  });

  it("makes a paragraph a to-do, joined to the list above it", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Mana\n\nColours");
    caretAfter(editor, "Colours");

    await userEvent.click(screen.getByRole("button", { name: "To-do" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana\n- [ ] Colours");
    expect(editor.state.doc.childCount).toBe(1);
  });

  it("joins the lists above and below a paragraph it makes a to-do", async () => {
    const { editor, onChange } = renderChecklist("- [ ] a\n\nb\n\n- [ ] c");
    caretAfter(editor, "b");

    await userEvent.click(screen.getByRole("button", { name: "To-do" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] a\n- [ ] b\n- [ ] c");
    expect(editor.state.doc.childCount).toBe(1);
  });

  it("makes a heading a to-do, since a to-do's line is a paragraph", async () => {
    const { editor, onChange } = renderChecklist("## Mana");
    caretAfter(editor, "Mana");

    await userEvent.click(screen.getByRole("button", { name: "To-do" }));

    expect(onChange).toHaveBeenLastCalledWith("- [ ] Mana");
  });

  it("turns a to-do back into a paragraph when the lit To-do is pressed", async () => {
    const { editor, onChange } = renderChecklist("- [ ] Mana");
    caretAfter(editor, "Mana");

    await userEvent.click(screen.getByRole("button", { name: "To-do" }));

    expect(onChange).toHaveBeenLastCalledWith("Mana");
  });

  /** The complaint itself: a mark on a line of text used to be a mark on a to-do. */
  it("never makes a to-do from a mark on a line of text", async () => {
    const { editor, onChange } = renderChecklist("plain words");
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    await userEvent.click(screen.getByRole("button", { name: "Italic" }));

    expect(onChange).toHaveBeenLastCalledWith("***plain*** words");
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("says which block the caret is standing in", () => {
    const { editor } = renderChecklist("## Mana\n\nSome words\n\n- [ ] Revise tokens");
    const pressed = () =>
      ["Heading 1", "Heading 2", "Heading 3", "Paragraph", "To-do"].filter(
        (name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true",
      );

    act(() => caretAfter(editor, "Mana"));
    expect(pressed()).toEqual(["Heading 2"]);

    act(() => caretAfter(editor, "Some words"));
    expect(pressed()).toEqual(["Paragraph"]);

    // A to-do's own line is a paragraph too — and it is the To-do that is lit, not Paragraph.
    act(() => caretAfter(editor, "Revise tokens"));
    expect(pressed()).toEqual(["To-do"]);
  });

  it("does nothing to a top-level to-do from Outdent", async () => {
    const { editor, onChange } = renderChecklist("Some words\n\n- [ ] Revise tokens");
    caretAfter(editor, "Revise tokens");

    await userEvent.click(screen.getByRole("button", { name: "Outdent" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ the checklist's keys ---- */

/** An editor on the checklist kit, outside React — what the key table drives. */
function checklistEditor(markdown: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: CHECKLIST_EXTENSIONS,
    content: markdown,
    contentType: "markdown",
  });
}

/**
 * One keypress through ProseMirror's own `handleKeyDown` chain — every keymap plugin in priority
 * order, the path a real key takes — answering whether any of them claimed it. `false` is the
 * browser's own key: what a real window would then do is the default action, which jsdom does not
 * perform, so the document standing still is the assertion.
 */
function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  return editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event)) ?? false;
}

/** What the line a position is in is: a to-do's, a top-level paragraph, or a heading. */
function blockOf($pos: Editor["state"]["selection"]["$from"]): string {
  if ($pos.parent.type.name === "heading") return "heading";
  if ($pos.depth >= 2 && $pos.node($pos.depth - 1).type.name === "taskItem") return "todo";
  return $pos.depth === 1 ? $pos.parent.type.name : "other";
}

/** Where a row of the table puts the caret before its keys. */
type Caret = { after: string } | { before: string } | { empty: number };

function placeCaret(editor: Editor, caret: Caret): void {
  if ("after" in caret) return caretAfter(editor, caret.after);
  if ("before" in caret) {
    caretAfter(editor, caret.before);
    editor.commands.setTextSelection(editor.state.selection.from - caret.before.length);
    return;
  }
  const empties: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.content.size === 0) empties.push(pos + 1);
  });
  const at = empties[caret.empty];
  if (at === undefined) throw new Error(`no empty to-do number ${caret.empty}`);
  editor.commands.setTextSelection(at);
}

interface KeyRow {
  name: string;
  body: string;
  caret: Caret;
  keys: { key: string; shiftKey?: boolean }[];
  /** The body after the keys. */
  after: string;
  /** Where the caret ends up: the words of its line and its offset in them. */
  lands?: { line: string; offset: number };
  /** What the caret's line is afterwards: a to-do's, a paragraph at the top, or a heading. */
  block?: "todo" | "paragraph" | "heading";
  /** Whether any keymap claimed the last key — `false` is the browser's own. */
  handled?: boolean;
}

const ENTER = { key: "Enter" };
const BACKSPACE = { key: "Backspace" };
const DELETE = { key: "Delete" };

/**
 * Every answer the checklist gives Enter, Shift-Enter, Backspace, Delete and Shift-Tab, one row
 * each. **The first four rows are the review's own reproductions** (2026-09-29): before the keys
 * were bound, the first saved `"- [ ] a\n\n  \n- [ ] b"` — two top-level lists on reload — and the
 * next three each left a line under a checkbox that was not a to-do. Every row asserts the body
 * *and* that the document is one this schema holds, because the defect was a body that looked
 * plausible while being a shape nothing can reopen.
 */
const KEY_ROWS: KeyRow[] = [
  {
    name: "Enter then Backspace at the end of a to-do puts the list back as it was",
    body: "- [ ] a\n- [ ] b",
    caret: { after: "a" },
    keys: [ENTER, BACKSPACE],
    after: "- [ ] a\n- [ ] b",
    lands: { line: "a", offset: 1 },
  },
  // #688: out of the top list is a line of text now, so an empty top-level to-do's Enter ends the
  // list there. An empty paragraph is written as nothing — the blank line after the list is the
  // separator before it — and the load drops it, so an unwritten line costs the body nothing.
  {
    name: "Enter on the only, empty to-do lifts it out to an empty line of text",
    body: "",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "",
    block: "paragraph",
    handled: true,
  },
  {
    name: "Enter twice after a to-do ends the list on a line of text, with no empty to-do",
    body: "- [ ] a",
    caret: { after: "a" },
    keys: [ENTER, ENTER],
    after: "- [ ] a\n\n",
    block: "paragraph",
    handled: true,
  },
  {
    name: "Shift-Enter twice does what Enter does",
    body: "- [ ] a",
    caret: { after: "a" },
    keys: [
      { key: "Enter", shiftKey: true },
      { key: "Enter", shiftKey: true },
    ],
    after: "- [ ] a\n\n",
    block: "paragraph",
    handled: true,
  },
  {
    name: "Enter on an empty to-do between two ends the list there, and the rest follows as one",
    body: "- [ ] a\n- [ ] \n- [ ] b\n  - [ ] c",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "- [ ] a\n\n\n\n- [ ] b\n  - [ ] c",
    block: "paragraph",
  },
  {
    name: "Enter on an emptied to-do with sub-to-dos leaves them a list under the line",
    body: "- [ ] a\n- [ ] \n  - [ ] c\n- [ ] d",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "- [ ] a\n\n\n\n- [ ] c\n- [ ] d",
    block: "paragraph",
  },
  {
    name: "Enter on an empty sub-to-do lifts it one level",
    body: "- [ ] a\n  - [ ] ",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "- [ ] a\n- [ ] ",
    block: "todo",
  },
  {
    name: "Enter inside a line of text is the ordinary split",
    body: "Some words",
    caret: { after: "Some" },
    keys: [ENTER],
    after: "Some\n\nwords",
    lands: { line: " words", offset: 0 },
    block: "paragraph",
  },
  {
    name: "Enter at the end of a heading makes a line of text under it",
    body: "## Mana",
    caret: { after: "Mana" },
    keys: [ENTER],
    after: "## Mana\n\n",
    lands: { line: "", offset: 0 },
    block: "paragraph",
  },
  {
    name: "Shift-Enter on a line of text splits it, since there is no break to make",
    body: "Some words",
    caret: { after: "Some" },
    keys: [{ key: "Enter", shiftKey: true }],
    after: "Some\n\nwords",
    block: "paragraph",
    handled: true,
  },
  {
    name: "Backspace in an empty last to-do removes it and lands at the end of the line above",
    body: "- [ ] a\n- [ ] ",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "- [ ] a",
    lands: { line: "a", offset: 1 },
  },
  {
    name: "Backspace in an empty first to-do removes it and lands at the start of the next",
    body: "- [ ] \n- [ ] b",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "- [ ] b",
    lands: { line: "b", offset: 0 },
  },
  {
    name: "Backspace in the only, empty to-do leaves the list as one empty to-do",
    body: "- [ ] ",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "- [ ] ",
    handled: true,
  },
  {
    name: "Backspace in an empty only sub-to-do takes its list and lands on its parent's line",
    body: "- [ ] a\n  - [ ] ",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "- [ ] a",
    lands: { line: "a", offset: 1 },
  },
  {
    name: "Backspace at the start of a sub-to-do lifts it",
    body: "- [ ] a\n  - [ ] b",
    caret: { before: "b" },
    keys: [BACKSPACE],
    after: "- [ ] a\n- [ ] b",
  },
  {
    name: "Backspace at the start of a to-do joins its words onto the line above",
    body: "- [ ] a\n- [ ] b",
    caret: { before: "b" },
    keys: [BACKSPACE],
    after: "- [ ] ab",
    lands: { line: "ab", offset: 1 },
  },
  {
    name: "Backspace at the start of a to-do brings its sub-to-dos with its words",
    body: "- [ ] a\n- [ ] b\n  - [ ] c",
    caret: { before: "b" },
    keys: [BACKSPACE],
    after: "- [ ] ab\n  - [ ] c",
    lands: { line: "ab", offset: 1 },
  },
  {
    name: "Backspace at the start of a to-do joins onto the last line above, however deep",
    body: "- [ ] a\n  - [ ] b\n- [ ] c",
    caret: { before: "c" },
    keys: [BACKSPACE],
    after: "- [ ] a\n  - [ ] bc",
    lands: { line: "bc", offset: 1 },
  },
  {
    name: "Backspace at the start of the first line stays put",
    body: "- [ ] a\n- [ ] b",
    caret: { before: "a" },
    keys: [BACKSPACE],
    after: "- [ ] a\n- [ ] b",
    handled: true,
  },
  {
    name: "Backspace inside a line is the browser's own",
    body: "- [ ] ab",
    caret: { after: "a" },
    keys: [BACKSPACE],
    after: "- [ ] ab",
    handled: false,
  },
  {
    name: "Delete at the end of a to-do joins the next line onto it",
    body: "- [ ] a\n- [ ] b\n  - [ ] c",
    caret: { after: "a" },
    keys: [DELETE],
    after: "- [ ] ab\n  - [ ] c",
    lands: { line: "ab", offset: 1 },
  },
  {
    name: "Delete into a to-do's own first sub-to-do puts that one's sub-to-dos in its place",
    body: "- [ ] a\n  - [ ] b\n    - [ ] c\n  - [ ] d",
    caret: { after: "a" },
    keys: [DELETE],
    after: "- [ ] ab\n  - [ ] c\n  - [ ] d",
    lands: { line: "ab", offset: 1 },
  },
  {
    name: "Delete at the end of the last line does nothing",
    body: "- [ ] a\n- [ ] b",
    caret: { after: "b" },
    keys: [DELETE],
    after: "- [ ] a\n- [ ] b",
    handled: true,
  },
  {
    name: "Shift-Tab lifts a to-do that has sub-to-dos and siblings after it",
    body: "- [ ] a\n  - [ ] b\n    - [ ] c\n  - [ ] d",
    caret: { after: "b" },
    keys: [{ key: "Tab", shiftKey: true }],
    after: "- [ ] a\n- [ ] b\n  - [ ] c\n  - [ ] d",
  },

  /* ---- #688: #672's answers, re-checked with text beside the list ---- */

  {
    name: "Shift-Tab on a top-level to-do still does nothing, and leaves the key to the browser",
    body: "Some words\n\n- [ ] a",
    caret: { after: "a" },
    keys: [{ key: "Tab", shiftKey: true }],
    after: "Some words\n\n- [ ] a",
    block: "todo",
    handled: false,
  },
  {
    name: "Backspace at the start of the first line still stays put, over text below",
    body: "- [ ] a\n\nSome words",
    caret: { before: "a" },
    keys: [BACKSPACE],
    after: "- [ ] a\n\nSome words",
    handled: true,
  },
  {
    name: "Backspace at the start of a list's first to-do under text makes it a line of text",
    body: "Some words\n\n- [ ] a\n  - [ ] b\n- [ ] c",
    caret: { before: "a" },
    keys: [BACKSPACE],
    after: "Some words\n\na\n\n- [ ] b\n- [ ] c",
    lands: { line: "a", offset: 0 },
    block: "paragraph",
    handled: true,
  },
  {
    name: "…and a second Backspace is the ordinary join onto the text above",
    body: "Some words\n\n- [ ] a",
    caret: { before: "a" },
    keys: [BACKSPACE, BACKSPACE],
    after: "Some wordsa",
    lands: { line: "Some wordsa", offset: 10 },
  },
  {
    name: "Backspace in an empty first to-do under text removes it and lands at the end of the text",
    body: "Some words\n\n- [ ] \n- [ ] b",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "Some words\n\n- [ ] b",
    lands: { line: "Some words", offset: 10 },
  },
  {
    name: "Backspace in a list's only, empty to-do takes the list from between two lines of text",
    body: "Before\n\n- [ ] \n\nAfter",
    caret: { empty: 0 },
    keys: [BACKSPACE],
    after: "Before\n\nAfter",
    lands: { line: "Before", offset: 6 },
  },
  {
    name: "Backspace at the start of text under a list joins its words onto the list's last line",
    body: "- [ ] a\n  - [ ] b\n\nSome words",
    caret: { before: "Some words" },
    keys: [BACKSPACE],
    after: "- [ ] a\n  - [ ] bSome words",
    lands: { line: "bSome words", offset: 1 },
    block: "todo",
    handled: true,
  },
  {
    name: "Backspace at the start of a heading under a list joins it the same way",
    body: "- [ ] a\n\n## Mana",
    caret: { before: "Mana" },
    keys: [BACKSPACE],
    after: "- [ ] aMana",
    lands: { line: "aMana", offset: 1 },
    block: "todo",
  },
  {
    name: "Backspace on the empty line an Enter left under a list puts the caret back on the list",
    body: "- [ ] a",
    caret: { after: "a" },
    keys: [ENTER, ENTER, BACKSPACE],
    after: "- [ ] a",
    lands: { line: "a", offset: 1 },
    block: "todo",
  },
  {
    name: "Backspace joining text between two lists leaves one list",
    body: "- [ ] a\n\nb\n\n- [ ] c",
    caret: { before: "b" },
    keys: [BACKSPACE],
    after: "- [ ] ab\n- [ ] c",
    lands: { line: "ab", offset: 1 },
  },
  {
    name: "Backspace at the start of text under text is the ordinary join",
    body: "## Mana\n\nSome words",
    caret: { before: "Some words" },
    keys: [BACKSPACE],
    after: "## ManaSome words",
    lands: { line: "ManaSome words", offset: 4 },
    block: "heading",
  },
  {
    name: "Delete at the end of a list's last line joins the text under it onto the to-do",
    body: "- [ ] a\n\nSome words\n\n- [ ] c",
    caret: { after: "a" },
    keys: [DELETE],
    after: "- [ ] aSome words\n- [ ] c",
    lands: { line: "aSome words", offset: 1 },
    block: "todo",
    handled: true,
  },
  {
    name: "Delete at the end of text over a list joins the first to-do's words, its sub-to-dos in its place",
    body: "Some words\n\n- [ ] a\n  - [ ] b\n- [ ] c",
    caret: { after: "Some words" },
    keys: [DELETE],
    after: "Some wordsa\n\n- [ ] b\n- [ ] c",
    lands: { line: "Some wordsa", offset: 10 },
    block: "paragraph",
    handled: true,
  },
  {
    name: "Delete at the end of text over a one-to-do list takes the list",
    body: "Some words\n\n- [ ] a\n\nAfter",
    caret: { after: "Some words" },
    keys: [DELETE],
    after: "Some wordsa\n\nAfter",
  },
  {
    name: "Delete at the end of text over text is the ordinary join",
    body: "Some\n\nwords",
    caret: { after: "Some" },
    keys: [DELETE],
    after: "Somewords",
    lands: { line: "Somewords", offset: 4 },
  },
];

describe("the checklist's keys", () => {
  it.each(KEY_ROWS)("$name", ({ body, caret, keys, after, lands, block, handled }) => {
    const editor = checklistEditor(body);
    placeCaret(editor, caret);

    let claimed = false;
    for (const { key, shiftKey } of keys) claimed = press(editor, key, { shiftKey });

    expect(editor.getMarkdown()).toBe(after);
    expect(() => editor.state.doc.check()).not.toThrow();
    const { $from } = editor.state.selection;
    if (lands) {
      expect({ line: $from.parent.textContent, offset: $from.parentOffset }).toEqual(lands);
    }
    if (block) expect(blockOf($from)).toBe(block);
    if (handled !== undefined) expect(claimed).toBe(handled);
    // Never two lists side by side: the dialect has no spelling for them.
    const kinds: string[] = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds.join(" ")).not.toContain("taskList taskList");
    editor.destroy();
  });

  /**
   * **A key's edit follows the caret**, as the upstream `joinBackward` and `joinForward` these
   * replace did — in a long list the line the caret lands on can be off screen. jsdom scrolls
   * nothing, so what is asserted is the transaction's own flag, the thing the view acts on.
   */
  const SCROLL_ROWS: [string, string, Caret, string][] = [
    ["Backspace removing an empty to-do", "- [ ] a\n- [ ] ", { empty: 0 }, "Backspace"],
    ["Backspace joining a line onto the one above", "- [ ] a\n- [ ] b", { before: "b" }, "Backspace"],
    ["Delete joining the next line on", "- [ ] a\n- [ ] b", { after: "a" }, "Delete"],
  ];
  it.each(SCROLL_ROWS)("scrolls the caret into view after %s", (_name, body, caret, key) => {
    const editor = checklistEditor(body);
    placeCaret(editor, caret);
    const edits: boolean[] = [];
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) edits.push(transaction.scrolledIntoView);
    });

    expect(press(editor, key)).toBe(true);

    expect(edits).toEqual([true]);
    editor.destroy();
  });

  /** The narrowed item is the first line of defence: a to-do cannot hold a second paragraph. */
  it("holds one line and at most one sub-list in a to-do", () => {
    const editor = checklistEditor("- [ ] a");
    expect(editor.schema.nodes.taskItem.spec.content).toBe("paragraph taskList?");
    editor.destroy();
  });
});

/* ----------------------------------------------------------- a body in a bad shape ---- */

describe("a body written in a shape the keys can no longer make", () => {
  /**
   * The review's reproduction, verbatim: what Enter then Backspace saved before the keys were
   * bound. Its blank middle line splits it into two top-level lists, which this schema cannot hold
   * — it now opens as the one list it was meant to be.
   */
  it("opens the old two-list body as one valid list", () => {
    const editor = checklistEditor("- [ ] a\n\n  \n- [ ] b");
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("- [ ] a\n- [ ] b");
    editor.destroy();
  });

  /** #672 made a loose line a to-do of its own, because nothing else could hold it; #688 keeps it
   *  the line of text it is. A blank one is still dropped, at any level. */
  it("keeps a loose line as text, and drops a blank one", () => {
    expect(checklistTrip("- [ ] a\n\nloose words")).toBe("- [ ] a\n\nloose words");
    expect(checklistTrip("- [ ] \n\n  &nbsp;")).toBe("- [ ] ");
    expect(checklistTrip("Some words\n\n&nbsp;\n\n- [ ] a")).toBe("Some words\n\n- [ ] a");
    expect(checklistTrip("&nbsp;")).toBe("- [ ] ");
  });

  /** A block this dialect has no node for keeps its words, as text — marks and all. */
  it("reads a quote as the line of text it holds", () => {
    expect(checklistTrip("- [ ] a\n\n> a **quoted** line")).toBe("- [ ] a\n\na **quoted** line");
  });

  it("joins two lists the parse left side by side, whatever came between them", () => {
    const editor = checklistEditor("- [ ] a\n\n&nbsp;\n\n- [ ] b");
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("- [ ] a\n- [ ] b");
    editor.destroy();
  });

  it("makes a second paragraph inside a to-do its sub-to-do", () => {
    expect(checklistTrip("- [ ] a\n\n  b")).toBe("- [ ] a\n  - [ ] b");
  });

  /** Both roads into the editor: the first paint, and a body handed in later (`setContent`). */
  it("draws one list on mount and on a later value alike", () => {
    const onChange = vi.fn<(markdown: string) => void>();
    const { view, surface, editor } = renderChecklist("- [ ] a\n\n  \n- [ ] b", { onChange });
    expect(surface.querySelectorAll(":scope > ul")).toHaveLength(1);
    expect(() => editor.state.doc.check()).not.toThrow();

    view.rerender(
      <NoteEditor
        mode="checklist"
        value={"- [ ] c\n\n  \n- [ ] d"}
        onChange={onChange}
        ariaLabel="To-do list"
      />,
    );

    expect(surface.querySelectorAll(":scope > ul")).toHaveLength(1);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.getMarkdown()).toBe("- [ ] c\n- [ ] d");
    // Squaring a body up is not an edit: nothing was written back for it.
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * The checklist's own arbitrary utilities, lifted out of the shipped source the way
 * {@link PROMPT_UTILITIES} is — every bracketed class in `CHECKLIST_PROSE`, `HEADING_PROSE` (its
 * headings since #688, shared with the note) and `DELETE_TODO`.
 */
function arbitraryUtilitiesOf(name: string): string[] {
  const block = source.match(new RegExp(`const ${name} = cn\\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)]
    .flatMap(([, literal]) => literal.split(/\s+/))
    .filter((utility) => utility.startsWith("["));
}

const CHECKLIST_UTILITIES = [
  ...arbitraryUtilitiesOf("CHECKLIST_PROSE"),
  ...arbitraryUtilitiesOf("HEADING_PROSE"),
  ...arbitraryUtilitiesOf("DELETE_TODO"),
];

describe("the checklist's CSS is really compiled", () => {
  it("is drawn from arbitrary selectors at all", () => {
    // A sweep over nothing finds nothing — the prompt's own guard, for the same reason.
    expect(arbitraryUtilitiesOf("CHECKLIST_PROSE").length).toBeGreaterThanOrEqual(10);
    // The headings a to-do document holds since #688, shared with the note's surface.
    expect(arbitraryUtilitiesOf("HEADING_PROSE").length).toBeGreaterThanOrEqual(10);
    expect(arbitraryUtilitiesOf("DELETE_TODO").length).toBe(2);
  });

  /** The text between the lists is spaced; a to-do's own line and a sub-list stay flush. */
  it("spaces the top-level blocks and not a to-do's line", async () => {
    for (const utility of ["[&>p]:my-1", "[&>ul]:my-1", "[&_li_p]:m-0", "[&_li_ul]:m-0"]) {
      expect(CHECKLIST_UTILITIES).toContain(utility);
    }
    expect(await compiledUtilities("[&>p]:my-1")).toMatch(/>\s*p\s*\{/);
    expect(await compiledUtilities("[&_li_p]:m-0")).toMatch(/li\s+p\s*\{/);
  });

  it("emits a rule for every one of them", async () => {
    const silent: string[] = [];
    for (const utility of CHECKLIST_UTILITIES) {
      if ((await compiledUtilities(utility)) === "") silent.push(utility);
    }
    expect(silent).toEqual([]);
  });

  /**
   * The other way a class in the source can fail to reach the page: `cn` is `tailwind-merge`, which
   * drops whichever of two classes it judges to conflict. A compiled rule on no element paints
   * nothing, so the drawn surface and the drawn button are asked for every one of them.
   */
  it("reaches the drawn surface and the drawn button intact", () => {
    const { surface } = renderChecklist("- [ ] Revise tokens");
    const button = screen.getByRole("button", { name: 'Delete "Revise tokens"' });
    const onSurface = surface.className.split(/\s+/);
    const onButton = button.className.split(/\s+/);

    expect(
      arbitraryUtilitiesOf("CHECKLIST_PROSE").filter((utility) => !onSurface.includes(utility)),
    ).toEqual([]);
    expect(
      arbitraryUtilitiesOf("HEADING_PROSE").filter((utility) => !onSurface.includes(utility)),
    ).toEqual([]);
    expect(
      arbitraryUtilitiesOf("DELETE_TODO").filter((utility) => !onButton.includes(utility)),
    ).toEqual([]);
    expect(onButton).toContain("opacity-0");
  });

  /** A done to-do strikes its own line and never its sub-to-dos' — the `>div>p` is the point. */
  it("strikes a done to-do's own paragraph and nothing under it", async () => {
    expect(CHECKLIST_UTILITIES).toContain("[&_li[data-checked=true]>div>p]:line-through");
    const struck = await compiledUtilities("[&_li[data-checked=true]>div>p]:line-through");
    expect(struck).toContain("line-through");
    expect(struck).toMatch(/li\[data-checked=["']?true["']?\]\s*>\s*div\s*>\s*p/);
  });

  /** Hovering a sub-to-do shows its own button and not its parent's as well. */
  it("reveals a row's delete button on the innermost row under the pointer only", async () => {
    expect(CHECKLIST_UTILITIES).toContain("[li:hover:not(:has(li:hover))>&]:opacity-100");
    const shown = await compiledUtilities("[li:hover:not(:has(li:hover))>&]:opacity-100");
    expect(shown).toContain("opacity");
    expect(shown).toMatch(/li:hover:not\(:has\(li:hover\)\)\s*>/);
  });
});
