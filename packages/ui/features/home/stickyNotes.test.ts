import { describe, expect, it } from "vitest";

import {
  noteColor,
  notePreview,
  orderedNotes,
  stickyTitle,
  storedOrder,
  UNTITLED_STICKY,
} from "./stickyNotes";

const note = (over: Partial<Parameters<typeof orderedNotes>[0][number]> = {}) => ({
  id: 1,
  title: "",
  body: "",
  color: "slate",
  pinned: false,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("noteColor", () => {
  it("keeps a colour this build knows", () => {
    expect(noteColor("amber")).toBe("amber");
  });

  // The whole point of the column carrying no CHECK: a newer build's word arrives over sync
  // and must draw as something rather than fail.
  it("reads a colour it has never heard of as slate", () => {
    expect(noteColor("puce")).toBe("slate");
    expect(noteColor("")).toBe("slate");
  });
});

describe("stickyTitle", () => {
  it("is the title when there is one", () => {
    expect(stickyTitle({ title: "Trade night", body: "# Heading" })).toBe("Trade night");
  });

  it("is the body's first line when there is not", () => {
    expect(stickyTitle({ title: "", body: "# Bring the binder\n\nand the box" })).toBe(
      "Bring the binder",
    );
  });

  it("is the placeholder when there is neither", () => {
    expect(stickyTitle({ title: "", body: "   " })).toBe(UNTITLED_STICKY);
  });

  // This is `noteTitle`'s trim, and it is why this function delegates rather than re-deciding:
  // a title of spaces is a title the reader did not write, and the body is the better name.
  it("treats a title of only spaces as no title at all", () => {
    expect(stickyTitle({ title: "   ", body: "Bring the binder" })).toBe("Bring the binder");
  });
});

describe("notePreview", () => {
  it("drops blank lines and clamps to the count", () => {
    expect(notePreview("one\n\ntwo\n\nthree", 2)).toBe("one\ntwo");
  });

  // ⚠️ The behaviour a tile author will get wrong: `joinRuns` joins wrapped source lines with
  // a space, so a long paragraph is ONE entry here however many rows it draws.
  it("counts blocks and list items, never visual lines", () => {
    const wrapped = "a very long paragraph\nthat wrapped in the source";
    expect(notePreview(wrapped, 1)).toBe("a very long paragraph that wrapped in the source");
  });

  // The other half of that rule: `blockText` joins a list's items with a newline, so one list
  // block spends as many of `lines` as it has items.
  it("spends one line per list item, and strips the markers", () => {
    expect(notePreview("- **one**\n- two\n- three", 2)).toBe("one\ntwo");
  });

  // A hard break is a `"\n"` inside a text run, so it splits here too — a paragraph the reader
  // broke by hand is two entries, not one.
  it("counts a hard break as a line", () => {
    expect(notePreview("first  \nsecond", 1)).toBe("first");
  });

  it("is empty for an empty body", () => {
    expect(notePreview("   ", 3)).toBe("");
  });
});

describe("orderedNotes", () => {
  const a = note({ id: 1, sortOrder: 0 });
  const b = note({ id: 2, sortOrder: 1, pinned: true });
  const c = note({ id: 3, sortOrder: 2 });

  it("is sort order when pinning is off", () => {
    expect(orderedNotes([c, b, a], false).map((n) => n.id)).toEqual([1, 2, 3]);
  });

  it("lifts the pinned note and keeps the rest in order", () => {
    expect(orderedNotes([c, b, a], true).map((n) => n.id)).toEqual([2, 1, 3]);
  });

  it("leaves the caller's array alone", () => {
    const input = [c, b, a];
    orderedNotes(input, true);
    expect(input.map((n) => n.id)).toEqual([3, 2, 1]);
  });
});

describe("storedOrder", () => {
  // Stored: 1, 2 (pinned), 3, 4 (pinned), 5 — drawn with pinning on as 2, 4, 1, 3, 5.
  const stored = [
    note({ id: 1, sortOrder: 0 }),
    note({ id: 2, sortOrder: 1, pinned: true }),
    note({ id: 3, sortOrder: 2 }),
    note({ id: 4, sortOrder: 3, pinned: true }),
    note({ id: 5, sortOrder: 4 }),
  ];
  const drawnAfter = (ids: number[]) =>
    orderedNotes(
      storedOrder(stored, ids, true).map((id, at) => ({ ...stored.find((n) => n.id === id)!, sortOrder: at })),
      true,
    ).map((n) => n.id);

  it("is the drawn order itself when pinning is off", () => {
    expect(storedOrder(stored, [3, 1, 2, 4, 5], false)).toEqual([3, 1, 2, 4, 5]);
  });

  /** The whole bug: writing the drawn list promoted the pinned notes in the stored order. */
  it("keeps the pinned notes in the slots they already held", () => {
    // 5 moved to the front of the unpinned group: 2, 4, 5, 1, 3.
    expect(storedOrder(stored, [2, 4, 5, 1, 3], true)).toEqual([5, 2, 1, 4, 3]);
  });

  it("reorders the pinned group within its own slots", () => {
    expect(storedOrder(stored, [4, 2, 1, 3, 5], true)).toEqual([1, 4, 3, 2, 5]);
  });

  it("draws back exactly the arrangement the gesture made", () => {
    expect(drawnAfter([2, 4, 5, 1, 3])).toEqual([2, 4, 5, 1, 3]);
    expect(drawnAfter([4, 2, 3, 1, 5])).toEqual([4, 2, 3, 1, 5]);
  });

  /** A drop across the line lands at the nearest place on the note's own side of it. */
  it("clamps an unpinned note dropped above a pinned one to the head of its group", () => {
    expect(drawnAfter([5, 2, 4, 1, 3])).toEqual([2, 4, 5, 1, 3]);
  });

  it("clamps a pinned note dropped among the unpinned to the tail of its group", () => {
    expect(drawnAfter([4, 1, 3, 2, 5])).toEqual([4, 2, 1, 3, 5]);
  });

  it("changes nothing for a drop that clamps back to where the note was", () => {
    expect(storedOrder(stored, [1, 2, 4, 3, 5], true)).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves a list that disagrees with the notes unmapped", () => {
    expect(storedOrder(stored, [2, 4, 1, 3], true)).toEqual([2, 4, 1, 3]);
  });
});
