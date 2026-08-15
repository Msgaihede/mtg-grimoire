import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckAuditEntry, DeckAuditKind } from "@/lib/ipc";
import { auditDays, auditSentence } from "./auditText";

let nextId = 1;

function entry(
  kind: DeckAuditKind,
  payload: unknown,
  over: Partial<DeckAuditEntry> = {},
): DeckAuditEntry {
  return {
    id: nextId++,
    deckId: 1,
    at: Math.floor(new Date(2026, 7, 11, 14, 12).getTime() / 1000),
    variant: "live",
    kind,
    cardId: "c-1",
    cardName: "Sol Ring",
    payload: JSON.stringify(payload),
    delta: 0,
    ...over,
  };
}

describe("auditSentence", () => {
  it("says what an add was", () => {
    expect(auditSentence(entry("add", { category: "Ramp", quantity: 1 }))).toEqual({
      text: "Added Sol Ring",
      detail: "to Ramp",
    });
    expect(auditSentence(entry("add", { category: "Ramp", quantity: 3 }))).toEqual({
      text: "Added 3 × Sol Ring",
      detail: "to Ramp",
    });
  });

  /** The reason rides in the detail when the backend recorded one — a removal the reconciler
   *  or a rules check caused explains itself where it happened. */
  it("says what a removal was, and why when there is a why", () => {
    expect(auditSentence(entry("remove", { category: "Ramp", quantity: 1, reason: null }))).toEqual(
      { text: "Removed Sol Ring", detail: "from Ramp" },
    );
    expect(
      auditSentence(
        entry("remove", {
          category: "Ramp",
          quantity: 1,
          reason: "banned in Commander",
        }),
      ),
    ).toEqual({ text: "Removed Sol Ring", detail: "from Ramp · banned in Commander" });
  });

  /**
   * **A cleared pile wears the `remove` kind and names no card**, exactly as a replace import's
   * first row does — so `action` is the whole of what tells them apart. Without the branch this
   * pins, `deck_category_clear`'s row renders as `Removed 7 × a card`: a sentence about a card
   * the row has not got, which reads as a bug in the history rather than in the renderer.
   *
   * The wrong-but-plausible answer is asserted too, the way `xGroup`'s spelling is: the `default`
   * arms in this file are all true sentences, so a drift here fails nothing on its own.
   */
  it("words a cleared pile rather than reading it as a card removal", () => {
    const cleared = auditSentence(
      entry(
        "remove",
        { action: "clear", category: "Ramp", cards: 7 },
        { cardId: null, cardName: null, delta: -7 },
      ),
    );

    expect(cleared).toEqual({ text: "Cleared 7 cards from Ramp", detail: null });
    expect(cleared.text).not.toContain("a card");
  });

  it("says one card, not 1 cards, when a pile of one is cleared", () => {
    expect(
      auditSentence(
        entry("remove", { action: "clear", category: "Ramp", cards: 1 }, { cardId: null }),
      ).text,
    ).toBe("Cleared 1 card from Ramp");
  });

  it("says both numbers on a quantity change", () => {
    expect(auditSentence(entry("quantity", { category: "Ramp", from: 1, to: 2 }))).toEqual({
      text: "Changed Sol Ring from 1 to 2",
      detail: "in Ramp",
    });
  });

  it("says where a move went from and to", () => {
    expect(auditSentence(entry("move", { from: "Creature", to: "Maybeboard" }))).toEqual({
      text: "Moved Sol Ring",
      detail: "Creature → Maybeboard",
    });
  });

  /**
   * A swap that folds is the one that has to say so: two rows became one, and a deck list
   * that silently loses a line reads like a bug.
   */
  it("says which printing a swap went to, and whether it folded", () => {
    expect(
      auditSentence(
        entry("swap", { category: "Ramp", fromSet: "CMM", toSet: "3ED", folded: false }),
      ),
    ).toEqual({ text: "Swapped printing of Sol Ring", detail: "CMM → 3ED" });

    expect(
      auditSentence(
        entry("swap", { category: "Ramp", fromSet: "CMM", toSet: "3ED", folded: true }),
      ),
    ).toEqual({
      text: "Swapped printing of Sol Ring",
      detail: "CMM → 3ED · folded into one row",
    });
  });

  /**
   * Set codes are stored lowercase, as `cards.set_code` holds them. Upper-casing is the
   * renderer's job, because a set code is printed on a card in capitals and this app writes
   * it that way everywhere it shows one.
   */
  it("prints a swap's set codes the way they are printed on a card", () => {
    expect(
      auditSentence(
        entry("swap", { category: "Ramp", fromSet: "cmm", toSet: "3ed", folded: false }),
      ).detail,
    ).toBe("CMM → 3ED");
  });

  it("says what a card was tagged, and what it was wearing before", () => {
    expect(auditSentence(entry("tag", { tag: "Cut candidate", previous: null }))).toEqual({
      text: "Tagged Sol Ring",
      detail: "Cut candidate",
    });
    expect(auditSentence(entry("tag", { tag: "Wincon", previous: "Cut candidate" }))).toEqual({
      text: "Tagged Sol Ring",
      detail: "Cut candidate → Wincon",
    });
    expect(auditSentence(entry("tag", { tag: null, previous: "Wincon" }))).toEqual({
      text: "Untagged Sol Ring",
      detail: "was Wincon",
    });
  });

  /**
   * The same kind wears two different events, and `action` is what tells them apart. Without
   * this branch, deleting the "Cut candidate" label renders as "Tagged a card" — a sentence
   * about a card the row does not have, since a tag CRUD row names none.
   */
  it("says what happened to a tag itself, not to a card wearing it", () => {
    const label = (payload: Record<string, unknown>) =>
      auditSentence(entry("tag", payload, { cardId: null, cardName: null }));

    expect(label({ action: "create", tag: "Cut candidate" })).toEqual({
      text: "Created tag Cut candidate",
      detail: null,
    });
    expect(label({ action: "rename", tag: "Wincon", previous: "Win", cards: 4 })).toEqual({
      text: "Renamed tag Win to Wincon",
      detail: "4 cards carry it",
    });
    expect(label({ action: "recolour", tag: "Wincon", color: "moss" })).toEqual({
      text: "Recoloured tag Wincon",
      detail: "moss",
    });
    // Deleting a tag untags its cards rather than deleting them, which is the half of the
    // sentence a reader would otherwise have to go and check.
    expect(label({ action: "delete", tag: "Wincon", cards: 1 })).toEqual({
      text: "Deleted tag Wincon",
      detail: "1 card untagged",
    });
    // An action this build has never heard of still reads as a line of history.
    expect(label({ action: "reticulate", tag: "Wincon" })).toEqual({
      text: "Changed tag Wincon",
      detail: null,
    });
  });

  /** All six category actions, because the sentence is entirely different for each and a
   *  missing branch would read as the fallback with no test able to tell. */
  it("says what happened to a category", () => {
    const cat = (payload: Record<string, unknown>) =>
      auditSentence(entry("category", payload, { cardId: null, cardName: null }));

    expect(cat({ action: "create", name: "Flash enabler", cards: 2 })).toEqual({
      text: "Created category Flash enabler",
      detail: "2 cards moved into it",
    });
    expect(cat({ action: "create", name: "Draw", cards: 0 })).toEqual({
      text: "Created category Draw",
      detail: null,
    });
    expect(cat({ action: "rename", name: "Draw", previousName: "Value", cards: 7 })).toEqual({
      text: "Renamed category Value to Draw",
      detail: "7 cards moved with it",
    });
    expect(cat({ action: "delete", name: "Value", cards: 3 })).toEqual({
      text: "Deleted category Value",
      detail: "3 cards moved out of it",
    });
    expect(cat({ action: "activate", name: "Maybeboard", cards: 10 })).toEqual({
      text: "Activated Maybeboard",
      detail: "10 cards now counted",
    });
    expect(cat({ action: "deactivate", name: "Maybeboard", cards: 10 })).toEqual({
      text: "Deactivated Maybeboard",
      detail: "10 cards no longer counted",
    });
    expect(cat({ action: "reorder", name: "", cards: 0 })).toEqual({
      text: "Reordered the categories",
      detail: null,
    });
  });

  /**
   * **`folder` is nullable and null is the root**, which is a place rather than an absence: a
   * deck at the top level is not a deck with no folder, it is a deck in the one folder that
   * has no name. "Out of its folder" read as a removal.
   */
  it("says which folder a deck was filed in, the top level included", () => {
    const filed = auditSentence(
      entry(
        "folder",
        { action: "move", folder: "Commander › Legends" },
        { cardId: null, cardName: null },
      ),
    );
    expect(filed).toEqual({ text: "Moved the deck to Commander › Legends", detail: null });

    expect(
      auditSentence(
        entry("folder", { action: "move", folder: null }, { cardId: null, cardName: null }),
      ),
    ).toEqual({ text: "Moved the deck to the top level", detail: null });
  });

  it("says which field of the deck changed", () => {
    const deck = (payload: Record<string, unknown>) =>
      auditSentence(entry("deck", payload, { cardId: null, cardName: null }));

    expect(deck({ field: "name", from: "Untitled", to: "Serah's Toolbox" })).toEqual({
      text: "Renamed the deck to Serah's Toolbox",
      detail: "was Untitled",
    });
    expect(deck({ field: "format", from: "casual", to: "Commander" })).toEqual({
      text: "Changed the format to Commander",
      detail: "was casual",
    });
    expect(deck({ field: "cover", from: null, to: "abc" })).toEqual({
      text: "Set the deck cover",
      detail: null,
    });
    // `"custom"` is the literal the backend writes for an uploaded image, and it is the
    // difference between a cover the reader chose off a card and one they made.
    expect(deck({ field: "cover", from: "abc", to: "custom" })).toEqual({
      text: "Set a custom deck cover",
      detail: null,
    });
    expect(deck({ field: "notes", from: null, to: null })).toEqual({
      text: "Edited the deck notes",
      detail: null,
    });
    expect(deck({ field: "description", from: null, to: "A toolbox." })).toEqual({
      text: "Edited the deck description",
      detail: null,
    });
    // Filed away, never deleted — `DeckPatch.archived`'s own words.
    expect(deck({ field: "archived", from: false, to: true })).toEqual({
      text: "Filed the deck away",
      detail: null,
    });
    expect(deck({ field: "archived", from: true, to: false })).toEqual({
      text: "Took the deck out of the archive",
      detail: null,
    });
    expect(deck({ field: "built", from: "false", to: "true" })).toEqual({
      text: "Marked the deck built",
      detail: null,
    });
    expect(deck({ field: "built", from: true, to: false })).toEqual({
      text: "Marked the deck not built",
      detail: null,
    });
    expect(deck({ field: "theory", from: false, to: true })).toEqual({
      text: "Turned the theory list on",
      detail: null,
    });
  });

  /**
   * `decks.separate_x_group` (schema v13), and **the only multi-word field name the backend
   * writes** — every other arm of the switch is a single lowercase word, so this is the first
   * place `deck.rs`'s spelling could drift from `auditText`'s without anything going red: the
   * default arm answers an unrecognised field with "Changed the deck", which is true of every
   * deck edit and therefore never fails. Deriving the word from the column the way `built` and
   * `theory` are derived gives `separateX`, which is **not** what `deck.rs` writes. This test
   * is the pin.
   */
  it("names the X split by the word `deck.rs` writes, not the one the column suggests", () => {
    const deck = (payload: Record<string, unknown>) =>
      auditSentence(entry("deck", payload, { cardId: null, cardName: null }));

    expect(deck({ field: "xGroup", from: false, to: true })).toEqual({
      text: "Split the X spells into their own group",
      detail: null,
    });
    expect(deck({ field: "xGroup", from: true, to: false })).toEqual({
      text: "Folded the X spells back into their mana values",
      detail: null,
    });
    // The wrong-but-plausible spelling, so that a regression to it is a failing test rather
    // than a history line quietly saying less than it knows.
    expect(deck({ field: "separateX", from: false, to: true })).toEqual({
      text: "Changed the deck",
      detail: null,
    });
  });

  /**
   * **Two different rows wear `field: "theory"`.** The copy row carries `copied` and no
   * `from`/`to` at all; the toggle carries `to` and no `copied`. Reading only the toggle
   * answers a copy as `flag(undefined)` — "Turned the theory list off" — which is a sentence
   * about the opposite of what happened.
   */
  it("tells the theory copy apart from the theory toggle", () => {
    const deck = (payload: Record<string, unknown>) =>
      auditSentence(entry("deck", payload, { cardId: null, cardName: null }));

    expect(deck({ field: "theory", copied: 99 })).toEqual({
      text: "Copied the live deck into theory",
      detail: "99 cards",
    });
    expect(deck({ field: "theory", copied: 1 })).toEqual({
      text: "Copied the live deck into theory",
      detail: "1 card",
    });
    // An empty live deck copies nothing, and says so by saying nothing more.
    expect(deck({ field: "theory", copied: 0 })).toEqual({
      text: "Copied the live deck into theory",
      detail: null,
    });
  });

  /**
   * An import is the one `add` that names no card, because it is a hundred of them — the
   * payload carries counts instead, and this file is the only thing that words them.
   */
  it("words a merge import", () => {
    expect(
      auditSentence(
        entry(
          "add",
          { import: { mode: "merge", lines: 105, cards: 117, categories: 9 } },
          { cardId: null, cardName: null, delta: 117 },
        ),
      ),
    ).toEqual({ text: "Imported 117 cards into 9 categories", detail: null });
  });

  /**
   * A replace writes two rows and each says its own half. The add row deliberately does not
   * name the mode: a replace that cleared nothing writes no remove row, and by then it did
   * exactly what a merge into an empty list would have done.
   */
  it("words a replace import's two rows", () => {
    const cleared = auditSentence(
      entry(
        "remove",
        { import: { mode: "replace", cleared: 42 } },
        { cardId: null, cardName: null, delta: -42 },
      ),
    );
    expect(cleared).toEqual({ text: "Cleared 42 cards before importing", detail: null });

    const added = auditSentence(
      entry(
        "add",
        { import: { mode: "replace", lines: 105, cards: 117, categories: 9 } },
        { cardId: null, cardName: null, delta: 117 },
      ),
    );
    expect(added).toEqual({ text: "Imported 117 cards into 9 categories", detail: null });
  });

  it("says one card, not 1 cards", () => {
    const imported = (payload: Record<string, unknown>) =>
      auditSentence(entry("add", { import: payload }, { cardId: null, cardName: null })).text;

    expect(imported({ mode: "merge", lines: 1, cards: 1, categories: 1 })).toBe(
      "Imported 1 card into 1 category",
    );
    expect(
      auditSentence(entry("remove", { import: { mode: "replace", cleared: 1 } }, { cardId: null }))
        .text,
    ).toBe("Cleared 1 card before importing");
  });

  /** The import branch is keyed on the payload, so an ordinary add — which carries none — is
   *  untouched by it. */
  it("still words an ordinary add with a card name", () => {
    expect(auditSentence(entry("add", { category: "Ramp", quantity: 2 }))).toEqual({
      text: "Added 2 × Sol Ring",
      detail: "to Ramp",
    });
  });

  /** A kind this build has no import sentence for falls through to its own branch rather than
   *  being claimed as an import — the payload is a shape a newer build may put anywhere. */
  it("leaves a kind it has no import sentence for to its own branch", () => {
    expect(
      auditSentence(
        entry(
          "category",
          { action: "create", name: "Ramp", import: { mode: "merge" } },
          {
            cardId: null,
            cardName: null,
          },
        ),
      ),
    ).toEqual({ text: "Created category Ramp", detail: null });
  });

  /**
   * Total, and that is the point of storing facts rather than sentences: this table outlives
   * every wording, so a row written by a newer build — or one whose payload lost a field —
   * still reads as a line of history rather than taking the drawer down.
   */
  it("never throws on a payload it cannot read", () => {
    expect(auditSentence({ ...entry("add", {}), payload: "not json" })).toEqual({
      text: "Added Sol Ring",
      detail: null,
    });
    expect(auditSentence({ ...entry("add", {}), payload: "[]" })).toEqual({
      text: "Added Sol Ring",
      detail: null,
    });
    expect(auditSentence(entry("move", {}))).toEqual({ text: "Moved Sol Ring", detail: null });
    expect(auditSentence(entry("add", { category: "Ramp" }, { cardName: null }))).toEqual({
      text: "Added a card",
      detail: "to Ramp",
    });
    expect(auditSentence({ ...entry("deck", {}), kind: "reticulate" as DeckAuditKind })).toEqual({
      text: "Changed the deck",
      detail: null,
    });
    // A payload whose fields are all the wrong type, which is what "untrusted-shaped" means
    // in practice: an object where a string was promised, a string where a number was.
    expect(auditSentence(entry("add", { category: { nested: true }, quantity: "lots" }))).toEqual({
      text: "Added Sol Ring",
      detail: null,
    });
  });
});

/**
 * **This contract is still growing**, and a database outlives the app that wrote it — so a
 * row written by a newer build, or by an older one, has to render as a line of history rather
 * than as a blank or a throw. Every discriminator this file switches on has a fallback, and
 * every fallback has a case here.
 */
describe("auditSentence over a contract it does not fully know", () => {
  it("renders a plain line for a field it has never heard of", () => {
    expect(
      auditSentence(entry("deck", { field: "sleeves", from: "a", to: "b" }, { cardId: null })),
    ).toEqual({ text: "Changed the deck", detail: null });
  });

  it("renders a plain line for a category action it has never heard of", () => {
    expect(
      auditSentence(entry("category", { action: "invert", name: "Ramp" }, { cardId: null })),
    ).toEqual({ text: "Changed category Ramp", detail: null });
  });

  /**
   * The arm really switches. Written to fail against the version that did not: it returned
   * the move sentence whatever the action was, so this test passed while proving nothing —
   * and a row that says "Moved the deck to X" for something that was not a move is a history
   * that lies rather than one that admits it does not know.
   */
  it("renders a plain line for a folder action it has never heard of", () => {
    expect(
      auditSentence(
        entry(
          "folder",
          { action: "invert", folder: "Commander › Legends" },
          { cardId: null, cardName: null },
        ),
      ),
    ).toEqual({ text: "Changed the deck's folder", detail: null });
  });

  /**
   * An undo is a `deck` row and not a tenth audit kind — `deck_audit.kind` carries a CHECK,
   * SQLite cannot alter one, and a tenth word would rebuild every reader's whole deck history.
   * So the sentence has to come out of a `field` this switch had never heard of before.
   */
  describe("an undo and a redo", () => {
    it("words the change they reversed, when the drawer has it", () => {
      const removed = entry("remove", { category: "Ramp", quantity: 2, reason: null });
      const undone = entry("deck", { field: "undo", of: removed.id }, { cardId: null });

      expect(auditSentence(undone, [removed, undone])).toEqual({
        text: "Undid: Removed 2 × Sol Ring",
        detail: "from Ramp",
      });
      expect(
        auditSentence(entry("deck", { field: "redo", of: removed.id }, { cardId: null }), [
          removed,
        ]),
      ).toEqual({ text: "Redid: Removed 2 × Sol Ring", detail: "from Ramp" });
    });

    /** The drawer is capped at 500 rows and a caller may pass no list at all, so the row it
     *  names can genuinely be out of reach. A true short sentence beats "Changed the deck",
     *  which is the `default` arm's answer and is true of every deck edit ever recorded. */
    it("falls back to the bare verb when the row it names is not in reach", () => {
      const undone = entry("deck", { field: "undo", of: 9999 }, { cardId: null });
      expect(auditSentence(undone, [])).toEqual({ text: "Undid a change", detail: null });
      expect(auditSentence(undone)).toEqual({ text: "Undid a change", detail: null });
    });

    /** A payload with no `of` at all — an older or newer build — must not throw and must not
     *  claim a change it cannot name. */
    it("survives a payload with no id in it", () => {
      expect(auditSentence(entry("deck", { field: "undo" }, { cardId: null }), [])).toEqual({
        text: "Undid a change",
        detail: null,
      });
    });

    /** The recursion is one level deep by construction — an undo's own row records no step, so
     *  nothing can ever name one — but the renderer must not depend on that to terminate. */
    it("does not recurse when an undo names another undo", () => {
      const first = entry("deck", { field: "undo", of: 1 }, { cardId: null });
      const second = entry("deck", { field: "undo", of: first.id }, { cardId: null });
      expect(auditSentence(second, [first, second]).text).toBe("Undid: Undid a change");
    });
  });
});

describe("auditDays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A local wall-clock time, so the day boundaries below are the same in every timezone.
    vi.setSystemTime(new Date(2026, 7, 11, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (y: number, m: number, d: number, h: number, min: number) =>
    Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

  it("groups by local calendar day, newest day first", () => {
    const days = auditDays([
      entry("add", {}, { at: at(2026, 7, 11, 14, 12) }),
      entry("add", {}, { at: at(2026, 7, 11, 0, 1) }),
      entry("add", {}, { at: at(2026, 7, 10, 22, 40) }),
      entry("add", {}, { at: at(2026, 7, 3, 18, 2) }),
    ]);

    expect(days.map((d) => d.date)).toEqual(["2026-08-11", "2026-08-10", "2026-08-03"]);
    expect(days.map((d) => d.entries.length)).toEqual([2, 1, 1]);
  });

  it("labels today and yesterday in words and everything else by its date", () => {
    const days = auditDays([
      entry("add", {}, { at: at(2026, 7, 11, 14, 12) }),
      entry("add", {}, { at: at(2026, 7, 10, 22, 40) }),
      entry("add", {}, { at: at(2026, 7, 3, 18, 2) }),
      entry("add", {}, { at: at(2025, 11, 24, 18, 2) }),
    ]);

    expect(days.map((d) => d.label)).toEqual([
      "Today",
      "Yesterday",
      "Monday, August 3",
      // A different year says so, because "Wednesday, December 24" alone is a date the
      // reader would place in the wrong twelvemonth.
      "Wednesday, December 24, 2025",
    ]);
  });

  /** The day header's `+7 / −6` roll-up, and the reason `delta` is signed copies. */
  it("sums the day's delta", () => {
    const days = auditDays([
      entry("add", {}, { at: at(2026, 7, 11, 14, 12), delta: 4 }),
      entry("remove", {}, { at: at(2026, 7, 11, 13, 51), delta: -1 }),
      entry("category", {}, { at: at(2026, 7, 11, 11, 20), delta: 0 }),
      entry("add", {}, { at: at(2026, 7, 10, 22, 40), delta: 7 }),
    ]);

    expect(days.map((d) => d.delta)).toEqual([3, 7]);
  });

  /** The read answers `ORDER BY at DESC`; a grouping that re-sorted inside a day would put
   *  a row where the backend did not, and two surfaces would tell two stories. */
  it("keeps the order it was given inside a day", () => {
    const days = auditDays([
      entry("add", {}, { at: at(2026, 7, 11, 14, 12), id: 90 }),
      entry("add", {}, { at: at(2026, 7, 11, 15, 30), id: 91 }),
    ]);

    expect(days[0].entries.map((e) => e.id)).toEqual([90, 91]);
  });

  it("answers nothing for a deck with no history", () => {
    expect(auditDays([])).toEqual([]);
  });
});
