import { describe, expect, it } from "vitest";
import {
  countTodos,
  isBlankList,
  listTitle,
  parseTodoBody,
  parseTodos,
  sameTodos,
  toggleTodo,
  UNTITLED_LIST,
  visibleTodos,
} from "./todoMarkdown";

/**
 * The to-do dialect, pinned from the reading side.
 *
 * Tiptap writes a deck's to-do list and this reader draws it back in the home widget, so the two
 * have to agree about one body — `NoteEditor.test.tsx`'s checklist corpus pins the writing side.
 * Both indent widths are here on purpose: the editor's own indent is measured rather than assumed,
 * and a reader that divided by a constant would hold for exactly one of them.
 *
 * The case that matters most is the one about a line with no rule. Everything else asserts that a
 * shape is *read*; that one asserts that a shape this file cannot read is still **shown** — as an
 * open to-do under #672, and as text since a list became a document (#688).
 *
 * **Every #672 body below is read exactly as it was.** A list written before headings and text
 * existed is one `todos` block, and `parseTodos` answers the tree it always answered — the stray
 * line is the only case whose expectation moved, and it moved on purpose.
 */
const TWO = "- [ ] Revise tokens\n  - [ ] Add a Treasure maker\n  - [x] Cut Clue tokens\n- [x] Sleeve the deck";
const FOUR = "- [ ] Revise tokens\n    - [ ] Add a Treasure maker\n        - [x] Deeper\n- [ ] Next";

describe("parseTodos", () => {
  it("reads a flat list", () => {
    const items = parseTodos("- [ ] a\n- [x] b");
    expect(items.map((i) => [i.text, i.done, i.line])).toEqual([
      ["a", false, 0],
      ["b", true, 1],
    ]);
  });

  it("nests at two spaces", () => {
    const [top, last] = parseTodos(TWO);
    expect(top.children.map((c) => c.text)).toEqual(["Add a Treasure maker", "Cut Clue tokens"]);
    expect(top.children.map((c) => c.line)).toEqual([1, 2]);
    expect(last.text).toBe("Sleeve the deck");
  });

  it("nests at four spaces, three deep", () => {
    const [top, next] = parseTodos(FOUR);
    expect(top.children[0].children[0]).toMatchObject({ text: "Deeper", done: true, line: 2 });
    expect(next.text).toBe("Next");
  });

  it("reads a tab as indentation", () => {
    expect(parseTodos("- [ ] a\n\t- [ ] b")[0].children[0].text).toBe("b");
  });

  it("measures a tab to its stop, so a tab and four spaces are one depth", () => {
    const [top] = parseTodos("- [ ] a\n\t- [ ] b\n    - [ ] c");
    expect(top.children.map((c) => c.text)).toEqual(["b", "c"]);
  });

  it("closes a deeper level when a shallower sibling arrives", () => {
    const [top] = parseTodos("- [ ] a\n    - [ ] b\n  - [ ] c");
    expect(top.children.map((c) => c.text)).toEqual(["b", "c"]);
  });

  it("accepts X and the other bullets", () => {
    expect(parseTodos("* [X] a\n+ [ ] b").map((i) => i.done)).toEqual([true, false]);
  });

  it("reads inline marks", () => {
    expect(parseTodos("- [ ] cut **three** creatures")[0].inlines).toContainEqual({
      kind: "strong",
      text: "three",
    });
  });

  it("reads an escaped character as the character, not as markup", () => {
    expect(parseTodos("- [ ] 2 \\* 3")[0].text).toBe("2 * 3");
  });

  it("joins a hard-broken continuation into the item", () => {
    const [item] = parseTodos("- [ ] first  \n      second\n- [ ] next");
    expect(item.text).toBe("first\nsecond");
    expect(parseTodos("- [ ] first  \n      second\n- [ ] next")).toHaveLength(2);
  });

  it("carries the break as a newline inside one text run", () => {
    expect(parseTodos("- [ ] first  \n  second")[0].inlines).toEqual([
      { kind: "text", text: "first\nsecond" },
    ]);
  });

  it("reads the trailing backslash prosemirror writes as a hard break too", () => {
    expect(parseTodos("- [ ] first\\\n  second")[0].text).toBe("first\nsecond");
  });

  it("lets a mark run across a hard break", () => {
    expect(parseTodos("- [ ] **bold  \n  still**")[0].inlines).toEqual([
      { kind: "strong", text: "bold\nstill" },
    ]);
  });

  it("joins a soft continuation with a space, as CommonMark does", () => {
    expect(parseTodos("- [ ] first\n  second")[0].text).toBe("first second");
  });

  it("reads a top-level break the way the editor writes it — the rest of the line not indented at all", () => {
    const items = parseTodos("- [ ] first  \nsecond\n- [ ] next");
    expect(items.map((i) => i.text)).toEqual(["first\nsecond", "next"]);
  });

  it("reads a nested break the way the editor writes it — the rest of the line at the marker's own indent", () => {
    const [top] = parseTodos("- [ ] a\n  - [ ] child  \n  more\n  - [ ] sibling");
    expect(top.children.map((c) => c.text)).toEqual(["child\nmore", "sibling"]);
  });

  it("reads a second paragraph inside an item as a line break, not as a to-do of its own", () => {
    const items = parseTodos("- [ ] first\n\n  second\n- [ ] next");
    expect(items.map((i) => i.text)).toEqual(["first\nsecond", "next"]);
  });

  it("reads the editor's empty-paragraph marker as empty, as the editor itself does", () => {
    expect(parseTodos("- [ ] &nbsp;")).toEqual([]);
    expect(parseTodos("- [ ]  ")).toEqual([]);
    expect(parseTodos("- [ ] a &nbsp; b")[0].text).toBe("a &nbsp; b");
  });

  it("drops an empty item — an empty line in the checklist is not a to-do", () => {
    expect(parseTodos("- [ ] ")).toEqual([]);
    expect(parseTodos("- [ ] a\n- [ ] \n- [ ] b").map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("keeps an empty item that has children", () => {
    const [item] = parseTodos("- [ ] \n  - [ ] child");
    expect(item.children[0].text).toBe("child");
  });

  it("reads a line with no bullet as text, not as a to-do — and still drops nothing", () => {
    expect(parseTodos("just words")).toEqual([]);
    expect(parseTodoBody("just words")).toEqual([
      { kind: "text", inlines: [{ kind: "text", text: "just words" }], text: "just words", line: 0 },
    ]);
    expect(parseTodoBody("---")).toMatchObject([{ kind: "text", text: "---", line: 0 }]);
  });

  it("still reads a bullet as a to-do, box or no box", () => {
    expect(parseTodos("- plain bullet")[0]).toMatchObject({ text: "plain bullet", done: false });
    expect(parseTodos("- [x]glued")[0]).toMatchObject({ text: "[x]glued", done: false });
  });

  it("ignores blank lines and CRLF", () => {
    expect(parseTodos("- [ ] a\r\n\r\n- [ ] b").map((i) => i.text)).toEqual(["a", "b"]);
    expect(parseTodos("- [ ] a\r\n- [ ] b").map((i) => i.line)).toEqual([0, 1]);
  });

  it("answers nothing for an empty body", () => {
    expect(parseTodos("")).toEqual([]);
    expect(parseTodos("  \n\n\t")).toEqual([]);
  });
});

describe("countTodos", () => {
  it("counts every depth", () => {
    expect(countTodos(parseTodos(TWO))).toEqual({ open: 2, done: 2 });
    expect(countTodos(parseTodos(FOUR))).toEqual({ open: 3, done: 1 });
  });

  it("counts nothing in nothing", () => {
    expect(countTodos([])).toEqual({ open: 0, done: 0 });
  });
});

describe("toggleTodo", () => {
  it("flips exactly one marker and touches no other byte", () => {
    const next = toggleTodo(TWO, 2)!;
    expect(next).toBe(TWO.replace("  - [x] Cut", "  - [ ] Cut"));
    expect(toggleTodo(next, 0)).toBe(next.replace("- [ ] Revise", "- [x] Revise"));
  });

  it("clears a capital X to an open box", () => {
    expect(toggleTodo("* [X] a", 0)).toBe("* [ ] a");
  });

  it("preserves CRLF", () => {
    expect(toggleTodo("- [ ] a\r\n- [ ] b", 1)).toBe("- [ ] a\r\n- [x] b");
    expect(toggleTodo("- [ ] a\r\n- [ ] b", 0)).toBe("- [x] a\r\n- [ ] b");
  });

  it("answers null for a line with no checkbox", () => {
    expect(toggleTodo("- plain\n- [ ] a", 0)).toBeNull();
    expect(toggleTodo("- [ ] a", 9)).toBeNull();
    expect(toggleTodo("- [ ] a", -1)).toBeNull();
    expect(toggleTodo("- [ ] a", 0.5)).toBeNull();
  });

  it("refuses a box the reader reads as text, so it never ticks what it does not draw", () => {
    expect(toggleTodo("- [x]glued", 0)).toBeNull();
  });

  it("flips the line it was given even when another line reads the same", () => {
    expect(toggleTodo("- [ ] a\n- [ ] a", 1)).toBe("- [ ] a\n- [x] a");
  });
});

describe("visibleTodos", () => {
  const items = parseTodos("- [x] done parent\n  - [ ] open child\n- [x] done alone\n- [ ] open");

  it("hides a done item with nothing open under it, and keeps a done parent of an open child", () => {
    const shown = visibleTodos(items, { showDone: false, nested: true });
    expect(shown.map((i) => i.text)).toEqual(["done parent", "open"]);
    expect(shown[0].children.map((i) => i.text)).toEqual(["open child"]);
  });

  it("keeps every done ancestor of an open to-do however deep it sits", () => {
    const deep = parseTodos("- [x] a\n  - [x] b\n    - [ ] c\n  - [x] d");
    const [a] = visibleTodos(deep, { showDone: false, nested: true });
    expect(a.children.map((i) => i.text)).toEqual(["b"]);
    expect(a.children[0].children.map((i) => i.text)).toEqual(["c"]);
  });

  it("shows everything with completed on", () => {
    expect(visibleTodos(items, { showDone: true, nested: true })).toHaveLength(3);
  });

  it("shows only the top level with sub-to-dos off", () => {
    const shown = visibleTodos(items, { showDone: true, nested: false });
    expect(shown.every((i) => i.children.length === 0)).toBe(true);
  });

  it("hides a done parent with sub-to-dos off, because the open child it kept is not drawn", () => {
    const shown = visibleTodos(items, { showDone: false, nested: false });
    expect(shown.map((i) => i.text)).toEqual(["open"]);
  });

  it("leaves the tree it was handed untouched", () => {
    visibleTodos(items, { showDone: false, nested: false });
    expect(items[0].children).toHaveLength(1);
  });
});

describe("sameTodos", () => {
  it("holds a body the same as itself, and as one with an empty to-do added or taken away", () => {
    expect(sameTodos(TWO, TWO)).toBe(true);
    // A trailing empty to-do, either way round.
    expect(sameTodos(TWO, `${TWO}\n- [ ] `)).toBe(true);
    expect(sameTodos(`${TWO}\n- [ ] `, TWO)).toBe(true);
    // One in the middle, and one nested under the last to-do.
    expect(sameTodos("- [ ] a\n- [ ] \n- [ ] b", "- [ ] a\n- [ ] b")).toBe(true);
    expect(sameTodos("- [ ] a", "- [ ] a\n  - [ ] ")).toBe(true);
    // The editor's empty-paragraph marker, in both spellings, and a ticked empty line.
    expect(sameTodos("- [ ] a", "- [ ] a\n- [ ] &nbsp;")).toBe(true);
    expect(sameTodos("- [ ] a", "- [ ] a\n- [x]  ")).toBe(true);
    // An emptied parent whose only sub-to-do is empty goes with it.
    expect(sameTodos("- [ ] a", "- [ ] a\n- [ ] \n  - [ ] ")).toBe(true);
    expect(sameTodos("", "- [ ] ")).toBe(true);
  });

  it("lets line endings, trailing spaces and trailing blank lines differ", () => {
    expect(sameTodos("- [ ] a\r\n- [ ] b", "- [ ] a\n- [ ] b")).toBe(true);
    expect(sameTodos("- [ ] a  \n- [ ] b\t", "- [ ] a\n- [ ] b")).toBe(true);
    expect(sameTodos("- [ ] a\n\n", "- [ ] a")).toBe(true);
  });

  it("tells apart a tick, a word, a mark, a nesting and an order", () => {
    expect(sameTodos("- [ ] a", "- [x] a")).toBe(false);
    expect(sameTodos("- [ ] a", "- [ ] b")).toBe(false);
    expect(sameTodos("- [ ] a b", "- [ ] a **b**")).toBe(false);
    expect(sameTodos("- [ ] a\n- [ ] b", "- [ ] a\n  - [ ] b")).toBe(false);
    expect(sameTodos("- [ ] a\n- [ ] b", "- [ ] b\n- [ ] a")).toBe(false);
    expect(sameTodos("- [ ] a", "")).toBe(false);
  });

  /**
   * **What a comparison of `parseTodos`' reading could not see**, each one a shape the editor
   * writes: a mark nested inside another (the reader drops the inner one), a link's address inside
   * a mark, and a link with no scheme (the reader draws it as its words).
   */
  it("tells apart edits the reader's own inlines lose", () => {
    expect(sameTodos("- [ ] **a b**", "- [ ] **a *b***")).toBe(false);
    expect(sameTodos("- [ ] **bold nested italic**", "- [ ] **bold *nested italic***")).toBe(false);
    expect(sameTodos("- [ ] **bold and rest**", "- [ ] **bold *and* rest**")).toBe(false);
    expect(sameTodos("- [ ] ~~[x](https://a)~~", "- [ ] ~~[x](https://b)~~")).toBe(false);
    expect(sameTodos("- [ ] word", "- [ ] [word](example.com)")).toBe(false);
  });

  it("keeps an emptied parent that still has sub-to-dos under it", () => {
    expect(sameTodos("- [ ] \n  - [ ] child", "- [ ] child")).toBe(false);
  });
});

/**
 * A to-do list as a document (#688): headings and text between any number of task lists.
 *
 * `DOC` is the plan's body, and the one `NoteEditor.test.tsx`'s corpus pins from the writing side.
 */
const DOC = [
  "## Mana",
  "",
  "- [ ] Cut a land",
  "  - [x] Check curve",
  "",
  "Some notes about **why**.",
  "",
  "- [ ] Revise tokens",
].join("\n");

describe("parseTodoBody", () => {
  it("reads headings, text and two lists in the order they were written", () => {
    expect(parseTodoBody(DOC)).toEqual([
      { kind: "heading", level: 2, inlines: [{ kind: "text", text: "Mana" }], text: "Mana", line: 0 },
      {
        kind: "todos",
        items: [
          {
            done: false,
            inlines: [{ kind: "text", text: "Cut a land" }],
            text: "Cut a land",
            line: 2,
            children: [
              {
                done: true,
                inlines: [{ kind: "text", text: "Check curve" }],
                text: "Check curve",
                line: 3,
                children: [],
              },
            ],
          },
        ],
      },
      {
        kind: "text",
        inlines: [
          { kind: "text", text: "Some notes about " },
          { kind: "strong", text: "why" },
          { kind: "text", text: "." },
        ],
        text: "Some notes about why.",
        line: 5,
      },
      {
        kind: "todos",
        items: [
          {
            done: false,
            inlines: [{ kind: "text", text: "Revise tokens" }],
            text: "Revise tokens",
            line: 7,
            children: [],
          },
        ],
      },
    ]);
  });

  it("reads a #672 body as one list, the tree parseTodos always answered", () => {
    expect(parseTodoBody(TWO)).toEqual([{ kind: "todos", items: parseTodos(TWO) }]);
    expect(parseTodoBody(FOUR)).toEqual([{ kind: "todos", items: parseTodos(FOUR) }]);
  });

  it("reads #, ## and ### as headings, and draws a deeper one as the third", () => {
    expect(
      parseTodoBody("# one\n\n## two\n\n### three\n\n#### four\n\n###### six\n\n####### seven"),
    ).toMatchObject([
      { kind: "heading", level: 1, text: "one", line: 0 },
      { kind: "heading", level: 2, text: "two", line: 2 },
      { kind: "heading", level: 3, text: "three", line: 4 },
      { kind: "heading", level: 3, text: "four", line: 6 },
      { kind: "heading", level: 3, text: "six", line: 8 },
      { kind: "text", text: "####### seven", line: 10 },
    ]);
  });

  it("treats an empty paragraph as no change, and leaves a paragraph with words as one", () => {
    expect(sameTodos("- [ ] a\n\n&nbsp;", "- [ ] a")).toBe(true);
    expect(sameTodos("- [ ] a\n\n&nbsp;\n\n- [ ] b", "- [ ] a\n\n- [ ] b")).toBe(true);
    expect(sameTodos("- [ ] a\n\nwords", "- [ ] a")).toBe(false);
  });

  it("keeps #hashtag as text, since a heading needs the space after its hashes", () => {
    expect(parseTodoBody("#hashtag")).toMatchObject([{ kind: "text", text: "#hashtag" }]);
  });

  it("reads two text lines with no blank between as one paragraph", () => {
    expect(parseTodoBody("first line\nsecond line")).toEqual([
      {
        kind: "text",
        inlines: [{ kind: "text", text: "first line second line" }],
        text: "first line second line",
        line: 0,
      },
    ]);
  });

  it("carries a hard break inside a paragraph as a newline, and a blank line ends it", () => {
    expect(parseTodoBody("first  \nsecond\n\nthird")).toMatchObject([
      { kind: "text", text: "first\nsecond", line: 0 },
      { kind: "text", text: "third", line: 3 },
    ]);
  });

  it("lets a heading interrupt a paragraph, as CommonMark does", () => {
    expect(parseTodoBody("words\n## Head").map((b) => b.kind)).toEqual(["text", "heading"]);
  });

  it("reads the escape the editor writes for a paragraph that starts like a to-do as text", () => {
    expect(parseTodoBody("\\- [ ] not a box")).toEqual([
      {
        kind: "text",
        inlines: [{ kind: "text", text: "- [ ] not a box" }],
        text: "- [ ] not a box",
        line: 0,
      },
    ]);
    expect(parseTodos("\\- [ ] not a box")).toEqual([]);
    // The spelling the editor actually writes escapes the brackets as well.
    expect(parseTodoBody("\\- \\[ \\] not a box")).toMatchObject([
      { kind: "text", text: "- [ ] not a box" },
    ]);
    expect(toggleTodo("\\- \\[ \\] not a box", 0)).toBeNull();
    const escaped = parseTodoBody("\\* star\n\n\\+ plus\n\n\\# hash");
    expect(escaped.map((b) => (b.kind === "todos" ? b.kind : b.text))).toEqual([
      "* star",
      "+ plus",
      "# hash",
    ]);
  });

  it("still lets a line indented under an open to-do continue it rather than become text", () => {
    const body = "- [ ] first\n  more words";
    expect(parseTodoBody(body)).toEqual([{ kind: "todos", items: parseTodos(body) }]);
    expect(parseTodos(body)[0].text).toBe("first more words");
  });

  it("still lets the unindented rest of a hard-broken top-level to-do continue it", () => {
    expect(parseTodoBody("- [ ] first  \nsecond").map((b) => b.kind)).toEqual(["todos"]);
  });

  it("reads an unindented line after a to-do as text, where #672 read an open to-do", () => {
    const body = "- [ ] a\nwords\n- [ ] b";
    expect(parseTodoBody(body).map((b) => b.kind)).toEqual(["todos", "text", "todos"]);
    expect(parseTodos(body).map((i) => i.text)).toEqual(["a", "b"]);
  });

  it("lets a heading close every open to-do, so an indented item after it is a root", () => {
    const body = "- [ ] a\n  - [ ] b\n## Next\n  - [ ] c";
    expect(parseTodoBody(body).map((b) => b.kind)).toEqual(["todos", "heading", "todos"]);
    expect(parseTodos(body).map((i) => i.text)).toEqual(["a", "c"]);
  });

  it("keeps one list across a blank line between its to-dos", () => {
    expect(parseTodoBody("- [ ] a\n\n- [ ] b").map((b) => b.kind)).toEqual(["todos"]);
  });

  it("drops a list with nothing left in it, an empty paragraph and an empty heading", () => {
    expect(parseTodoBody("- [ ] ")).toEqual([]);
    expect(parseTodoBody("# Title\n\n- [ ] \n\nwords").map((b) => b.kind)).toEqual([
      "heading",
      "text",
    ]);
    expect(parseTodoBody("&nbsp;")).toEqual([]);
    expect(parseTodoBody("## ")).toEqual([]);
  });

  it("answers nothing for an empty body", () => {
    expect(parseTodoBody("")).toEqual([]);
    expect(parseTodoBody("  \r\n\n\t")).toEqual([]);
  });

  it("concatenates every list's roots for parseTodos", () => {
    expect(parseTodos(DOC).map((i) => [i.text, i.line])).toEqual([
      ["Cut a land", 2],
      ["Revise tokens", 7],
    ]);
    expect(countTodos(parseTodos(DOC))).toEqual({ open: 2, done: 1 });
  });

  it("ticks a to-do in a document and refuses the text and the headings", () => {
    expect(toggleTodo(DOC, 3)).toBe(DOC.replace("- [x] Check", "- [ ] Check"));
    expect(toggleTodo(DOC, 0)).toBeNull();
    expect(toggleTodo(DOC, 5)).toBeNull();
    expect(toggleTodo("\\- [ ] not a box", 0)).toBeNull();
  });
});

describe("sameTodos over a document", () => {
  it("lets an empty to-do come and go beside text, and tells text apart", () => {
    expect(sameTodos(DOC, `${DOC}\n- [ ] `)).toBe(true);
    expect(sameTodos("words", "other words")).toBe(false);
    expect(sameTodos("## a", "### a")).toBe(false);
    expect(sameTodos("words", "- [ ] words")).toBe(false);
  });
});

describe("isBlankList", () => {
  it("is blank only with no title and no block", () => {
    expect(isBlankList("", "- [ ] ")).toBe(true);
    expect(isBlankList("  ", "")).toBe(true);
    expect(isBlankList("Groceries", "")).toBe(false);
    expect(isBlankList("", "hello")).toBe(false);
    expect(isBlankList("", "# Heading")).toBe(false);
  });
});

describe("listTitle", () => {
  it("answers the trimmed title, or Untitled list", () => {
    expect(UNTITLED_LIST).toBe("Untitled list");
    expect(listTitle("  ")).toBe("Untitled list");
    expect(listTitle("")).toBe("Untitled list");
    expect(listTitle("  Groceries ")).toBe("Groceries");
  });
});
