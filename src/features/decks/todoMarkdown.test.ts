import { describe, expect, it } from "vitest";
import {
  countTodos,
  parseTodos,
  sameTodos,
  todosText,
  toggleTodo,
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
 * shape is *read*; that one asserts that a shape this file cannot read is still **shown**.
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

  it("reads a line it does not understand as an open to-do — nothing is dropped", () => {
    expect(parseTodos("just words").map((i) => [i.text, i.done])).toEqual([["just words", false]]);
    expect(parseTodos("- plain bullet")[0]).toMatchObject({ text: "plain bullet", done: false });
    expect(parseTodos("- [x]glued")[0]).toMatchObject({ text: "[x]glued", done: false });
    expect(parseTodos("---")[0].text).toBe("---");
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
    expect(sameTodos(TWO, `${TWO}\n- [ ] `)).toBe(true);
    expect(sameTodos(`${TWO}\n- [ ] `, TWO)).toBe(true);
    expect(sameTodos("- [ ] a\n- [ ] \n- [ ] b", "- [ ] a\n- [ ] b")).toBe(true);
    expect(sameTodos("- [ ] a", "- [ ] a\n  - [ ] ")).toBe(true);
    expect(sameTodos("", "- [ ] ")).toBe(true);
  });

  it("tells apart a tick, a word, a mark, a nesting and an order", () => {
    expect(sameTodos("- [ ] a", "- [x] a")).toBe(false);
    expect(sameTodos("- [ ] a", "- [ ] b")).toBe(false);
    expect(sameTodos("- [ ] a b", "- [ ] a **b**")).toBe(false);
    expect(sameTodos("- [ ] a\n- [ ] b", "- [ ] a\n  - [ ] b")).toBe(false);
    expect(sameTodos("- [ ] a\n- [ ] b", "- [ ] b\n- [ ] a")).toBe(false);
    expect(sameTodos("- [ ] a", "")).toBe(false);
  });

  it("keeps an emptied parent that still has sub-to-dos under it", () => {
    expect(sameTodos("- [ ] \n  - [ ] child", "- [ ] child")).toBe(false);
  });
});

describe("todosText", () => {
  it("stores an empty checklist as nothing", () => {
    expect(todosText("- [ ] ")).toBe("");
    expect(todosText("")).toBe("");
    expect(todosText("- [ ] a")).toBe("- [ ] a");
  });

  it("leaves a body with anything in it byte for byte", () => {
    const body = "- [ ] a  \r\n  b\r\n- [ ] ";
    expect(todosText(body)).toBe(body);
  });
});
