import { describe, expect, it } from "vitest";
import { noteToPlainText, parseNoteBody } from "./noteMarkdown";

/**
 * The dialect, pinned from the reading side.
 *
 * **Two renderers have to agree about one body**: Tiptap writes the markdown and this reader
 * draws it back, and a drift between them is a note that changes shape the second time it is
 * opened. `NoteEditor.test.tsx` pins the writing side against the same construct list; this
 * file pins what each of them comes back as.
 *
 * The test that matters most is the one about a construct with no rule. Everything else here
 * asserts that a shape is *read*; that one asserts that a shape we cannot read is still
 * **shown**, which is the whole reason a hand-written reader is preferable to silence.
 */
describe("parseNoteBody", () => {
  it("reads the whole dialect", () => {
    expect(parseNoteBody("## Mana")).toEqual([
      { kind: "heading", level: 2, inlines: [{ kind: "text", text: "Mana" }] },
    ]);
    expect(parseNoteBody("- one\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
    ]);
    expect(parseNoteBody("**bold** and `code`")).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "strong", text: "bold" },
          { kind: "text", text: " and " },
          { kind: "code", text: "code" },
        ],
      },
    ]);
  });

  it("never drops what it does not understand", () => {
    // The rule `releaseNotes.ts` states: a construct with no rule falls through to a
    // paragraph and renders as written. Silence would lose a reader's typing.
    expect(parseNoteBody("| a | b |")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "| a | b |" }] },
    ]);
  });

  it("reads three heading levels and draws a deeper one at the third", () => {
    expect(
      parseNoteBody("# A\n\n## B\n\n### C").map((b) => b.kind === "heading" && b.level),
    ).toEqual([1, 2, 3]);
  });

  it("clamps a heading deeper than the dialect rather than showing its hashes", () => {
    // ⚠️ This is where the two renderers agree, and both halves are load-bearing.
    // `Heading.configure({ levels })` bounds Tiptap's input rules and **not** its schema, so a
    // pasted `#### four` survives a round trip byte for byte and really does reach this reader —
    // and `NoteEditor.tsx` overrides `renderHTML` to draw an out-of-range level at `max(levels)`.
    // So level 3 here is the editor's own answer rather than this file's taste. Falling through
    // to a paragraph was tried and is what this pins against: it drew the reader `#### four`,
    // hashes and all, beside an editor drawing a heading that read `four`.
    expect(parseNoteBody("#### four")).toEqual([
      { kind: "heading", level: 3, inlines: [{ kind: "text", text: "four" }] },
    ]);
    expect(parseNoteBody("###### six")).toEqual([
      { kind: "heading", level: 3, inlines: [{ kind: "text", text: "six" }] },
    ]);
  });

  it("keeps a lone hash out of the heading rule", () => {
    // `#hashtag` is a word. The space after the hashes is the whole of the difference.
    expect(parseNoteBody("#hashtag")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "#hashtag" }] },
    ]);
  });

  it("reads an ordered list, and says so only when it does not begin at one", () => {
    expect(parseNoteBody("1. one\n2. two")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
    ]);
    // Tiptap keeps the start number and writes it back out, so a reader who began at three and
    // stopped editing must not watch their list renumber itself to one.
    const [list] = parseNoteBody("3. three\n4. four");
    expect(list.kind === "list" && list.start).toBe(3);
  });

  it("keeps a hard break inside a list item in that item", () => {
    // `NoteEditor.test.tsx`'s corpus settles this body on exactly this spelling, so it is in the
    // dialect rather than a curiosity: a second line under the marker. Starting a paragraph here
    // would split one item into a one-item list and a stray paragraph.
    expect(parseNoteBody("- item one  \nitem two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "item one\nitem two" }]],
      },
    ]);
  });

  it("keeps a loose list one list, and ends it at a block that is not an item", () => {
    // CommonMark's loose list — `- one\n\n- two` is one list, which is what a reader gets for
    // pressing Enter twice. Tiptap tightens it on the way out, so only a body from elsewhere
    // arrives spelled this way.
    expect(parseNoteBody("- one\n\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
    ]);
    // Past a blank line the item's reach is over: this is a new block, not a continuation.
    expect(parseNoteBody("- one\n\nA paragraph.").map((b) => b.kind)).toEqual([
      "list",
      "paragraph",
    ]);
  });

  it("reads a nested list one level up", () => {
    // Four levels of block nesting for a body a reader can only produce with the Tab key, against
    // a `Block` that carries none. The words survive and the depth does not, which is
    // `releaseNotes.ts`' answer to the same question.
    expect(parseNoteBody("- outer\n  - inner")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "outer" }], [{ kind: "text", text: "inner" }]],
      },
    ]);
  });

  it("ends one list when the other begins", () => {
    const kinds = parseNoteBody("- one\n1. two").map((b) => b.kind === "list" && b.ordered);
    expect(kinds).toEqual([false, true]);
  });

  it("reads a blockquote, and its own paragraph break as a line break", () => {
    expect(parseNoteBody("> a\n> b")).toEqual([
      { kind: "quote", inlines: [{ kind: "text", text: "a b" }] },
    ]);
    // A bare `>` is what Tiptap writes when a reader presses Enter inside a quote. A `quote`
    // holds inlines and cannot hold two paragraphs, so it becomes the break it looks like.
    expect(parseNoteBody("> a\n>\n> b")).toEqual([
      { kind: "quote", inlines: [{ kind: "text", text: "a\nb" }] },
    ]);
  });

  it("keeps a hard break as a newline and a wrapped line as a space", () => {
    // The union has no break member, so the break travels inside the run. A renderer that does
    // not set `whitespace-pre-line` draws it as a space — a lost line, never a lost word.
    expect(parseNoteBody("a\\\nb")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "a\nb" }] },
    ]);
    expect(parseNoteBody("a  \nb")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "a\nb" }] },
    ]);
    expect(parseNoteBody("a\nb")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "a b" }] },
    ]);
  });

  it("does not read an escaped backslash at the end of a line as a break", () => {
    // `a\` is serialized `a\\`, and without the lookbehind that escaped backslash reads as a
    // line break the reader never typed.
    expect(parseNoteBody("a\\\\\nb")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "a\\ b" }] },
    ]);
  });

  it("reads every inline mark", () => {
    expect(parseNoteBody("*em* ~~gone~~ [Scryfall](https://scryfall.com)")).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "em", text: "em" },
          { kind: "text", text: " " },
          { kind: "strike", text: "gone" },
          { kind: "text", text: " " },
          { kind: "link", text: "Scryfall", href: "https://scryfall.com" },
        ],
      },
    ]);
  });

  it("reads the underscore spellings the editor never writes", () => {
    // Tiptap settles `_x_` on `*x*`, so a stored body never carries these — a pasted or imported
    // one can, and a reader's emphasis must not go dark because it arrived by another door.
    expect(parseNoteBody("_em_ and __strong__")).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "em", text: "em" },
          { kind: "text", text: " and " },
          { kind: "strong", text: "strong" },
        ],
      },
    ]);
  });

  it("leaves an underscore inside a word alone", () => {
    // CommonMark's intraword rule, and the whole reason the branch above is safe in this domain:
    // without it every `deck_note_cards` in a note is a word with an italic in the middle.
    expect(parseNoteBody("deck_note_cards and snake_case")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "deck_note_cards and snake_case" }] },
    ]);
  });

  it("treats a code span as characters and never as markup", () => {
    // CommonMark's own rule, and the only way a note can show a reader what `**bold**` is.
    expect(parseNoteBody("`**a**`")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "code", text: "**a**" }] },
    ]);
  });

  it("keeps a bold run at the start of a line out of the list rules", () => {
    // `*` followed by another `*` is not a bullet. This is the line that made
    // `releaseNotes.ts` require whitespace after the marker.
    expect(parseNoteBody("**Mana:** fourteen sources")).toEqual([
      {
        kind: "paragraph",
        inlines: [
          { kind: "strong", text: "Mana:" },
          { kind: "text", text: " fourteen sources" },
        ],
      },
    ]);
  });

  it("undoes the backslash escapes the editor writes, and merges what is left", () => {
    // prosemirror-markdown escapes a literal `*` on its way out, so a note reading `2 * 3` is
    // *stored* as `2 \* 3`. Reading the escape branch anywhere but first would open an
    // emphasis the reader never wrote; not reading it at all would show them a backslash.
    expect(parseNoteBody("2 \\* 3 and \\# not a heading")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "2 * 3 and # not a heading" }] },
    ]);
  });

  it("keeps an escaped hash out of the heading rule at the block level too", () => {
    expect(parseNoteBody("\\# not a heading")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "# not a heading" }] },
    ]);
  });

  it("keeps both characters of an escape it has no meaning for", () => {
    // `\d` is two characters somebody typed, not a `d`. Only ASCII punctuation is escapable.
    expect(parseNoteBody("\\d")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "\\d" }] },
    ]);
  });

  it("degrades a doubled mark to one and keeps every word", () => {
    // An `Inline` is flat, so `***both***` cannot be both. The italic is what is lost — never
    // the text, and never the delimiters left lying around as punctuation.
    expect(parseNoteBody("***both***")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "strong", text: "both" }] },
    ]);
    // Italicising the tail of a bold run, which is the other way a reader gets two marks on
    // one word. A lazy `**…**` closes at the middle pair without the lookahead.
    expect(parseNoteBody("**bold *and italic***")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "strong", text: "bold and italic" }] },
    ]);
    expect(parseNoteBody("[**bold link**](https://scryfall.com)")).toEqual([
      {
        kind: "paragraph",
        inlines: [{ kind: "link", text: "bold link", href: "https://scryfall.com" }],
      },
    ]);
  });

  it("keeps the words of a link it will not open", () => {
    // `openExternal` hands a URL straight to the opener with no check of its own, so this is
    // the only place a `javascript:` href is stopped — and the sentence around it still reads.
    expect(parseNoteBody("[press me](javascript:bad)")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "press me" }] },
    ]);
  });

  it("answers an empty list for a body with nothing in it", () => {
    expect(parseNoteBody("")).toEqual([]);
    expect(parseNoteBody("   \n\n \t ")).toEqual([]);
  });

  it("reads a whole note without losing a block", () => {
    const body = [
      "# Mana base",
      "",
      "Fourteen sources, which is **one short**.",
      "",
      "- Add a fetch",
      "- Cut a *slow* land",
      "",
      "> Sam disagrees.",
    ].join("\n");
    expect(parseNoteBody(body).map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
    ]);
  });
});

describe("noteToPlainText", () => {
  it("says everything the body says, with the markup gone", () => {
    expect(noteToPlainText("## Mana base\n\n- **one**\n- two")).toBe("Mana base\none\ntwo");
  });

  it("says nothing for a body with nothing in it", () => {
    expect(noteToPlainText("   ")).toBe("");
  });
});
