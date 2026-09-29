// `@tiptap/react` rather than `@tiptap/core`: it re-exports the whole of core, and it is the
// package this app declares. Reaching into an undeclared transitive dependency works until a
// hoist changes.
import { Editor } from "@tiptap/react";
import { fireEvent, render, screen } from "@testing-library/react";
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
import { parseTodos, type TodoItem } from "./todoMarkdown";

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
 * Every shape a deck's to-do list can take, in the spelling Tiptap's task list writes — and the
 * tree the home widget's reader draws from each.
 *
 * **This is the to-do dialect's fence**, the way {@link DIALECT_CORPUS} is the note dialect's: the
 * editor writes these bodies and `todoMarkdown.ts` reads them without mounting an editor, so both
 * halves are pinned to one list here and a shape one side grows is a red build on the other.
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
 */
const CHECKLIST_CORPUS: { body: string; todos: TodoShape[] }[] = [
  // The emptied list: one empty item, which is a place to type rather than a thing to do.
  { body: "- [ ] ", todos: [] },

  // Flat, and the tick.
  { body: "- [ ] Revise tokens", todos: [todo("Revise tokens", false, 0)] },
  { body: "- [x] Revise tokens", todos: [todo("Revise tokens", true, 0)] },
  {
    body: "- [ ] Revise tokens\n- [x] Cut a land\n- [ ] Order sleeves",
    todos: [
      todo("Revise tokens", false, 0),
      todo("Cut a land", true, 1),
      todo("Order sleeves", false, 2),
    ],
  },

  // Nesting — two spaces a level, and it compounds.
  {
    body: "- [ ] Mana\n  - [ ] Cut a land",
    todos: [todo("Mana", false, 0, [todo("Cut a land", false, 1)])],
  },
  {
    body: "- [ ] Mana\n  - [x] Cut a land\n    - [ ] Swap in a Triome",
    todos: [
      todo("Mana", false, 0, [todo("Cut a land", true, 1, [todo("Swap in a Triome", false, 2)])]),
    ],
  },
  // A done parent over an open child, and back out to the top.
  {
    body: "- [x] Mana\n  - [ ] Cut a land\n- [ ] Order sleeves",
    todos: [todo("Mana", true, 0, [todo("Cut a land", false, 1)]), todo("Order sleeves", false, 2)],
  },

  // The inline dialect inside a to-do: the four marks and a link.
  {
    body: "- [ ] **Revise** *the* ~~old~~ `tokens` [list](https://scryfall.com)",
    todos: [todo("Revise the old tokens list", false, 0)],
  },
  // A literal `*` and `_` come back escaped, and the reader has to take the backslash off.
  { body: "- [ ] 2 \\* 3 and a\\_b", todos: [todo("2 * 3 and a_b", false, 0)] },

  // What an append leaves behind: a trailing empty item the reader leaves out.
  { body: "- [ ] Revise tokens\n- [ ] ", todos: [todo("Revise tokens", false, 0)] },
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

  it("settles the alternate spellings on the one it writes", () => {
    expect(checklistTrip("")).toBe("- [ ] ");
    expect(checklistTrip("- [ ] Mana\n    - [ ] Cut a land")).toBe("- [ ] Mana\n  - [ ] Cut a land");
    expect(checklistTrip("* [ ] Revise tokens")).toBe("- [ ] Revise tokens");
    expect(checklistTrip("- [X] Revise tokens")).toBe("- [x] Revise tokens");
    expect(checklistTrip("- [ ] 2 * 3")).toBe("- [ ] 2 \\* 3");
  });

  it("never moves a body twice", () => {
    const unstable = ["", "- [ ] Mana\n    - [ ] Cut a land", "* [ ] a", "- [X] a", "- [ ] 2 * 3"]
      .map((body) => checklistTrip(body))
      .filter((once) => checklistTrip(once) !== once);
    expect(unstable).toEqual([]);
  });

  /**
   * ⚠️ **Why the checklist has no hard break, pinned as the measurement rather than described.**
   *
   * `hardBreak` writes `"  \n"` and leaves the rest of the line unindented, and `TaskList`'s
   * markdown tokenizer reads a task item one line at a time — so the break's second half comes
   * back as a line **outside** the list. The load-time repair can only make that line a to-do of
   * its own, so a broken to-do would split in two the next time it was opened. A construct only
   * one side of the round trip can spell is the one thing the module header says must not enter a
   * dialect, so the node is left out.
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
    const list = editor.state.doc.firstChild;
    expect(list?.childCount).toBe(2);
    expect(list?.child(1).textContent).toBe("second");
    editor.destroy();
  });
});

describe("what the checklist may draw", () => {
  it("is one task list of paragraphs with the inline marks, and nothing else", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: CHECKLIST_EXTENSIONS,
    });
    const nodes = Object.keys(editor.schema.nodes);
    const marks = Object.keys(editor.schema.marks);
    for (const node of ["doc", "paragraph", "text", "taskList", "taskItem"]) {
      expect(nodes).toContain(node);
    }
    for (const mark of ["bold", "italic", "strike", "code", "link"]) {
      expect(marks).toContain(mark);
    }
    for (const node of [
      "heading",
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
    // The top node takes a task list and only a task list — so every line is a to-do.
    expect(editor.schema.topNodeType.spec.content).toBe("taskList");
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

  it("offers the marks, a link, outdent and indent — and none of the note's blocks", () => {
    renderChecklist("- [ ] Revise tokens");

    for (const name of ["Bold", "Italic", "Strikethrough", "Code", "Add a link", "Outdent", "Indent"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of [
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "Quote",
    ]) {
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

  it("teaches Enter and Tab on an empty list", async () => {
    render(<NoteEditor mode="checklist" value="" onChange={vi.fn()} ariaLabel="To-do list" />);

    const empty = await screen.findByRole("textbox");
    // Read as a string rather than through `toHaveAttribute(name, value)`, which checks only that
    // the attribute exists when the value it is handed is `undefined`.
    expect(empty.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")).toBe(
      "Add a to-do — Enter for the next, Tab to nest.",
    );
  });

  it("says what Enter and Tab do", () => {
    expect(TODO_PLACEHOLDER).toBe("Add a to-do — Enter for the next, Tab to nest.");
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
    expect(screen.queryByRole("button", { name: "Heading 1" })).toBeNull();
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
  /** Whether the checklist claimed the last key — `false` is the browser's own. */
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
  {
    name: "Enter on the only, empty to-do does nothing",
    body: "",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "- [ ] ",
    handled: true,
  },
  {
    name: "Enter twice after a to-do makes one empty to-do and no blank line",
    body: "- [ ] a",
    caret: { after: "a" },
    keys: [ENTER, ENTER],
    after: "- [ ] a\n- [ ] ",
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
    after: "- [ ] a\n- [ ] ",
    handled: true,
  },
  {
    name: "Enter on an empty sub-to-do lifts it one level",
    body: "- [ ] a\n  - [ ] ",
    caret: { empty: 0 },
    keys: [ENTER],
    after: "- [ ] a\n- [ ] ",
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
];

describe("the checklist's keys", () => {
  it.each(KEY_ROWS)("$name", ({ body, caret, keys, after, lands, handled }) => {
    const editor = checklistEditor(body);
    placeCaret(editor, caret);

    let claimed = false;
    for (const { key, shiftKey } of keys) claimed = press(editor, key, { shiftKey });

    expect(editor.getMarkdown()).toBe(after);
    expect(() => editor.state.doc.check()).not.toThrow();
    if (lands) {
      const { $from } = editor.state.selection;
      expect({ line: $from.parent.textContent, offset: $from.parentOffset }).toEqual(lands);
    }
    if (handled !== undefined) expect(claimed).toBe(handled);
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

  it("makes a loose line a to-do of its own, and drops a blank one", () => {
    expect(checklistTrip("- [ ] a\n\nloose words")).toBe("- [ ] a\n- [ ] loose words");
    expect(checklistTrip("- [ ] \n\n  &nbsp;")).toBe("- [ ] ");
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
 * {@link PROMPT_UTILITIES} is — every bracketed class in `CHECKLIST_PROSE` and `DELETE_TODO`.
 */
function arbitraryUtilitiesOf(name: string): string[] {
  const block = source.match(new RegExp(`const ${name} = cn\\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)]
    .flatMap(([, literal]) => literal.split(/\s+/))
    .filter((utility) => utility.startsWith("["));
}

const CHECKLIST_UTILITIES = [
  ...arbitraryUtilitiesOf("CHECKLIST_PROSE"),
  ...arbitraryUtilitiesOf("DELETE_TODO"),
];

describe("the checklist's CSS is really compiled", () => {
  it("is drawn from arbitrary selectors at all", () => {
    // A sweep over nothing finds nothing — the prompt's own guard, for the same reason.
    expect(arbitraryUtilitiesOf("CHECKLIST_PROSE").length).toBeGreaterThanOrEqual(10);
    expect(arbitraryUtilitiesOf("DELETE_TODO").length).toBe(2);
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
