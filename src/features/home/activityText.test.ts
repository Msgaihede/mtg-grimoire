import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditSentence } from "@/features/decks/auditText";
import type { ActivityEntry, DeckAuditEntry } from "@/lib/ipc";
import { activityDays, activityLine } from "./activityText";

let nextId = 1;

function entry(
  scope: string,
  kind: string,
  payload: unknown,
  over: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    id: nextId++,
    at: Math.floor(new Date(2026, 8, 10, 14, 12).getTime() / 1000),
    scope,
    kind,
    deckId: null,
    cardId: "c-1",
    cardName: "Lightning Bolt",
    payload: JSON.stringify(payload),
    delta: 0,
    ...over,
  };
}

/** A payload the backend never wrote — a raw string rather than `JSON.stringify`'d, which is the
 *  only way to reach the arms that answer a truncated or a non-object row. */
function raw(scope: string, kind: string, payload: string, over: Partial<ActivityEntry> = {}) {
  return { ...entry(scope, kind, {}, over), payload };
}

const at = (y: number, m: number, d: number, h: number, min: number) =>
  Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

describe("activityLine — the collection's eight", () => {
  it("says what an add was, with the folder and the finish", () => {
    expect(entryLine("collection", "add", { folder: "Binder A", finish: "foil" }, 3)).toEqual({
      text: "Added 3 × Lightning Bolt",
      detail: "to Binder A · Foil",
    });
  });

  /** One copy is the commonest add there is, and `1 ×` in front of a card name is a multiplier
   *  saying nothing. The count comes off `delta` rather than out of the payload — an `activity`
   *  row carries no `quantity`, and reading it twice would be two numbers to keep in step. */
  it("drops the multiplier for a single copy", () => {
    expect(entryLine("collection", "add", { folder: "Binder A", finish: "nonfoil" }, 1)).toEqual({
      text: "Added Lightning Bolt",
      detail: "to Binder A",
    });
  });

  /**
   * **`nonfoil` draws nothing and a `null` folder draws nothing**, which is two different rules
   * arriving at one empty detail. The finish is `finish.ts`'s: nonfoil is the finish a copy is
   * assumed to be. The folder is this file's: the root is where a copy sits unless somebody filed
   * it, so `to Collection` would spend the quiet half of the line saying nothing.
   */
  it("draws no detail for a plain copy filed at the root", () => {
    expect(entryLine("collection", "add", { folder: null, finish: "nonfoil" }, 2)).toEqual({
      text: "Added 2 × Lightning Bolt",
      detail: null,
    });
  });

  /** A finish the CHECK admits and this build has never heard of is printed as stored —
   *  `finishLabel`'s rule for a column that holds whatever was written into it. */
  it("prints a finish it does not recognise as it was stored", () => {
    expect(entryLine("collection", "add", { finish: "galaxy" }, 1).detail).toBe("galaxy");
  });

  it("says both numbers on a quantity change", () => {
    expect(entryLine("collection", "quantity", { from: 2, to: 1 }, -1)).toEqual({
      text: "Changed Lightning Bolt from 2 to 1",
      detail: null,
    });
  });

  it("says what a removal was, and where from", () => {
    expect(entryLine("collection", "remove", { folder: "Binder A" }, -2)).toEqual({
      text: "Removed 2 × Lightning Bolt",
      detail: "from Binder A",
    });
  });

  it("names the fields an edit touched", () => {
    expect(entryLine("collection", "edit", { fields: ["condition", "notes"] }, 0)).toEqual({
      text: "Edited Lightning Bolt",
      detail: "condition · notes",
    });
  });

  /**
   * A column name is turned into a reader's word rather than looked up, so a field this build has
   * never heard of still appears. A table would answer an unknown key with nothing at all, which
   * is a detail that quietly loses half of what changed.
   */
  it("words a column name rather than looking it up", () => {
    expect(
      entryLine("collection", "edit", { fields: ["purchasePrice", "purchase_price"] }, 0).detail,
    ).toBe("purchase price · purchase price");
  });

  it("says where a move went from and to", () => {
    expect(entryLine("collection", "move", { from: "Binder A", to: "Recently removed" }, 0)).toEqual(
      { text: "Moved Lightning Bolt", detail: "Binder A → Recently removed" },
    );
  });

  /**
   * **A `null` end of a move is the root and is named**, where a `null` folder on an add is not.
   * The arrow needs both of its ends or it is broken, so the cabinet's own breadcrumb word stands
   * in — and the key being *absent* is a different thing again, which the test below pins.
   */
  it("names the root as the end of a move that came out of it", () => {
    expect(entryLine("collection", "move", { from: null, to: "Binder A" }, 0).detail).toBe(
      "Collection → Binder A",
    );
  });

  /** An older build's row or a truncated one carries no `from` at all, and reading that as the
   *  root would claim the copies came from somewhere they may not have. */
  it("degrades a move whose payload names only one end", () => {
    expect(entryLine("collection", "move", { to: "Binder A" }, 0).detail).toBe("to Binder A");
    expect(entryLine("collection", "move", {}, 0).detail).toBeNull();
  });

  it("says what happened to a folder", () => {
    expect(entryLine("collection", "folder", { action: "create", name: "Binder A" }, 0)).toEqual({
      text: "Created folder Binder A",
      detail: null,
    });
    expect(
      entryLine("collection", "folder", { action: "rename", name: "Binder A", from: "Shoebox" }, 0)
        .text,
    ).toBe("Renamed folder Shoebox to Binder A");
    expect(entryLine("collection", "folder", { action: "delete", name: "Binder A" }, 0).text).toBe(
      "Deleted folder Binder A",
    );
  });

  /** The `default` arm is a true sentence about every folder write, so a drift in the `action`
   *  vocabulary fails nothing on its own — which is why the wrong-but-plausible answer is
   *  asserted beside the right one, the way `auditText.ts`'s `xGroup` spelling is. */
  it("claims no act for a folder action it does not know", () => {
    const changed = entryLine("collection", "folder", { action: "reparent", name: "Binder A" }, 0);
    expect(changed).toEqual({ text: "Changed folder Binder A", detail: null });
    expect(changed.text).not.toContain("Created");
    expect(changed.text).not.toContain("Deleted");
  });

  it("names no folder for a folder row that carries no name", () => {
    expect(entryLine("collection", "folder", { action: "create" }, 0).text).toBe("Created a folder");
    expect(entryLine("collection", "folder", { action: "rename" }, 0).text).toBe("Renamed a folder");
    expect(entryLine("collection", "folder", { action: "rename", name: "Binder A" }, 0).text).toBe(
      "Renamed a folder to Binder A",
    );
  });

  /** One row for the whole press — the spec's bulk rule — so the counts have to be in the
   *  sentence. Copies in the text, lines in the detail: forty copies over thirty-seven lines is
   *  one press said two ways. */
  it("says what an import brought in, in copies and in lines", () => {
    expect(entryLine("collection", "import", { cards: 40, rows: 37 }, 40)).toEqual({
      text: "Imported 40 cards into your collection",
      detail: "across 37 rows",
    });
  });

  /** `numberField` reads an absent key as `0`, and "across 0 rows" beside "Imported 40 cards" is
   *  arithmetic that cannot be true — `auditText.ts`'s `labelsCreated` rule. */
  it("draws no detail for an import that carries no line count", () => {
    expect(entryLine("collection", "import", { cards: 40 }, 40).detail).toBeNull();
    expect(entryLine("collection", "import", { cards: 40, rows: 0 }, 40).detail).toBeNull();
  });

  it("says how much a clear emptied", () => {
    expect(entryLine("collection", "clear", { cards: 277 }, -277)).toEqual({
      text: "Cleared 277 cards from your collection",
      detail: null,
    });
  });
});

describe("activityLine — the wishlist's eight", () => {
  /**
   * **Every wishlist line names the wishlist in the sentence**, which is the whole reason there
   * are sixteen of these and not eight. A feed interleaves both cabinets, so a bare `Added
   * Lightning Bolt` above a line saying the same thing about a binder is a line a reader has to
   * look up.
   */
  it("says what a wish was, with the folder and the finish", () => {
    expect(entryLine("wishlist", "add", { folder: "Staples", finish: "etched" }, 3)).toEqual({
      text: "Added 3 × Lightning Bolt to your wishlist",
      detail: "in Staples · Etched",
    });
    expect(entryLine("wishlist", "add", { folder: null, finish: null }, 1)).toEqual({
      text: "Added Lightning Bolt to your wishlist",
      detail: null,
    });
  });

  it("says both numbers on a wish's quantity change", () => {
    expect(entryLine("wishlist", "quantity", { from: 2, to: 1 }, -1)).toEqual({
      text: "Changed Lightning Bolt on your wishlist from 2 to 1",
      detail: null,
    });
  });

  it("says what a wish removal was, and where from", () => {
    expect(entryLine("wishlist", "remove", { folder: "Staples" }, -2)).toEqual({
      text: "Removed 2 × Lightning Bolt from your wishlist",
      detail: "in Staples",
    });
  });

  it("names the fields an edited wish touched", () => {
    expect(entryLine("wishlist", "edit", { fields: ["printing"] }, 0)).toEqual({
      text: "Edited Lightning Bolt on your wishlist",
      detail: "printing",
    });
  });

  it("says where a wish was moved from and to", () => {
    expect(entryLine("wishlist", "move", { from: "Staples", to: null }, 0)).toEqual({
      text: "Moved Lightning Bolt on your wishlist",
      detail: "Staples → Wishlist",
    });
  });

  /** The noun says which cabinet the drawer is in, because a feed draws both and `Created folder
   *  Staples` would send a reader looking in the wrong one. */
  it("says a wishlist folder is a wishlist folder", () => {
    expect(entryLine("wishlist", "folder", { action: "create", name: "Staples" }, 0)).toEqual({
      text: "Created wishlist folder Staples",
      detail: null,
    });
    expect(
      entryLine("wishlist", "folder", { action: "rename", name: "Staples", from: "Someday" }, 0)
        .text,
    ).toBe("Renamed wishlist folder Someday to Staples");
    expect(entryLine("wishlist", "folder", { action: "delete", name: "Staples" }, 0).text).toBe(
      "Deleted wishlist folder Staples",
    );
  });

  it("says what a wishlist import brought in", () => {
    expect(entryLine("wishlist", "import", { cards: 40, rows: 37 }, 40)).toEqual({
      text: "Imported 40 cards into your wishlist",
      detail: "across 37 rows",
    });
  });

  it("says how much a wishlist clear emptied", () => {
    expect(entryLine("wishlist", "clear", { cards: 89 }, -89)).toEqual({
      text: "Cleared 89 cards from your wishlist",
      detail: null,
    });
  });

  /** The two cabinets' sentences are the same eight acts about two places, so the one thing that
   *  must never be true is that a pair of them reads the same. */
  it("words every one of the sixteen differently from its opposite number", () => {
    const kinds = ["add", "quantity", "remove", "edit", "move", "folder", "import", "clear"];
    const payload = {
      folder: "Drawer",
      finish: "foil",
      from: "Drawer",
      to: "Elsewhere",
      fields: ["notes"],
      action: "create",
      name: "Drawer",
      cards: 4,
      rows: 3,
    };
    const said = new Set<string>();
    for (const kind of kinds) {
      for (const scope of ["collection", "wishlist"]) {
        said.add(entryLine(scope, kind, payload, 2).text);
      }
    }
    expect(said.size).toBe(16);
  });
});

describe("activityLine — counts and agreement", () => {
  /** A collection clear is routinely four figures, which is exactly the caller `plural`'s own doc
   *  sends to `count`. The word is still `plural`'s. */
  it("writes a four-figure count with its thousands separators", () => {
    expect(entryLine("collection", "clear", { cards: 5000 }, -5000).text).toBe(
      "Cleared 5,000 cards from your collection",
    );
    expect(entryLine("collection", "import", { cards: 1196, rows: 1042 }, 1196)).toEqual({
      text: "Imported 1,196 cards into your collection",
      detail: "across 1,042 rows",
    });
  });

  it("says one card and one row, not 1 cards and 1 rows", () => {
    expect(entryLine("collection", "clear", { cards: 1 }, -1).text).toBe(
      "Cleared 1 card from your collection",
    );
    expect(entryLine("collection", "import", { cards: 1, rows: 1 }, 1)).toEqual({
      text: "Imported 1 card into your collection",
      detail: "across 1 row",
    });
  });
});

describe("activityLine — degrading", () => {
  it("degrades to its shortest honest form on a payload it does not understand", () => {
    expect(activityLine(raw("collection", "quantity", "{}")).text).toBeTruthy();
    expect(activityLine(raw("collection", "quantity", "not json")).text).toBeTruthy();
    expect(activityLine(raw("collection", "quantity", "{}")).text).toBe("Changed Lightning Bolt");
    expect(activityLine(raw("collection", "quantity", "not json")).text).toBe(
      "Changed Lightning Bolt",
    );
    expect(activityLine(raw("wishlist", "quantity", "{}")).text).toBe(
      "Changed Lightning Bolt on your wishlist",
    );
  });

  /**
   * `JSON.parse` alone is not enough: the column is `CHECK (json_valid(payload))`, which admits
   * `[]` and `"a string"` as readily as `{}`. Every one of these has to answer a sentence.
   */
  it("never throws, for any payload", () => {
    const payloads = ["", "[]", "null", '"s"', '{"from":"two"}', "{not json", "123", "true"];
    for (const p of payloads) {
      for (const scope of ["collection", "wishlist", "deck", "somewhere-new"]) {
        for (const kind of ["add", "quantity", "remove", "edit", "move", "folder", "import", "clear", "brand-new"]) {
          expect(() => activityLine(raw(scope, kind, p))).not.toThrow();
          expect(activityLine(raw(scope, kind, p)).text).toBeTruthy();
        }
      }
    }
  });

  /** A field list that is not a list, and members it cannot print. Neither is a throw and neither
   *  invents a field. */
  it("degrades an edit whose field list it cannot read", () => {
    expect(entryLine("collection", "edit", { fields: "condition" }, 0).detail).toBeNull();
    expect(entryLine("collection", "edit", {}, 0).detail).toBeNull();
    expect(entryLine("collection", "edit", { fields: ["notes", null, 7] }, 0).detail).toBe(
      "notes · 7",
    );
  });

  /** A row that outlived the name of its printing — the backend denormalizes one precisely so
   *  this is rare, and a feed line with no card at all is still worth showing. */
  it("names a card it has no name for rather than dropping the line", () => {
    expect(entryLine("collection", "add", {}, 1, { cardName: null }).text).toBe("Added a card");
  });

  /** A kind a newer build wrote. Both arms are true of every change to that cabinet, which is
   *  what makes them safe and what makes the assertion worth writing down. */
  it("claims no act for a kind it does not know", () => {
    expect(activityLine(entry("collection", "reprice", {}))).toEqual({
      text: "Changed your collection",
      detail: null,
    });
    expect(activityLine(entry("wishlist", "reprice", {}))).toEqual({
      text: "Changed your wishlist",
      detail: null,
    });
  });

  /** A scope this build has never heard of names **no cabinet**: wording it as a collection row
   *  would be a claim about where the change was made. */
  it("names no cabinet for a scope it does not know", () => {
    const named = activityLine(entry("trade", "add", {}, { delta: 3 }));
    expect(named).toEqual({ text: "Changed Lightning Bolt", detail: null });
    expect(named.text).not.toContain("collection");
    expect(named.text).not.toContain("wishlist");
    expect(activityLine(entry("trade", "clear", {}, { cardName: null })).text).toBe(
      "Something changed",
    );
  });
});

describe("activityLine — the deck rows", () => {
  const deckEntry = (kind: string, payload: unknown, over: Partial<ActivityEntry> = {}) =>
    entry("deck", kind, payload, { deckId: 7, ...over });

  /** The same row, both ways: the feed's line and the deck history dialog's line are one
   *  function, so a reword reaches both or neither. */
  it("delegates a deck entry to the deck history's own sentence", () => {
    const row = deckEntry("add", { category: "Ramp", quantity: 3 }, { cardName: "Sol Ring" });
    const mirrored: DeckAuditEntry = {
      id: row.id,
      deckId: 7,
      at: row.at,
      variant: "live",
      kind: "add",
      cardId: row.cardId,
      cardName: row.cardName,
      payload: row.payload,
      delta: row.delta,
    };

    expect(activityLine(row)).toEqual(auditSentence(mirrored));
    expect(activityLine(row)).toEqual({ text: "Added 3 × Sol Ring", detail: "to Ramp" });
  });

  /** A deck line's count comes out of the **payload**, where a collection line's comes off
   *  `delta` — which is the one place delegating rather than re-wording pays for itself. */
  it("reads a deck add's count off its payload and never off the delta", () => {
    expect(activityLine(deckEntry("add", { category: "Ramp", quantity: 3 }, { delta: 3 })).text).toBe(
      "Added 3 × Lightning Bolt",
    );
    expect(activityLine(deckEntry("add", { category: "Ramp", quantity: 3 }, { delta: 0 })).text).toBe(
      "Added 3 × Lightning Bolt",
    );
  });

  /**
   * **The variant is not on the wire, so a whole-list clear names *the deck*.** `activity_recent`
   * unions two tables and `deck_audit.variant` is not among the columns, so this side has no
   * honest answer — and of the three available only a word `auditText` has never heard of is
   * true of a clear whichever list it emptied. Naming a list would be the renderer inventing a
   * fact, which is the one failure worth pinning here.
   */
  it("names the deck and never a list when a whole-list clear reaches the feed", () => {
    const cleared = activityLine(
      deckEntry(
        "remove",
        { action: "clear", scope: "deck", cards: 42 },
        { cardId: null, cardName: null, delta: -42 },
      ),
    );

    expect(cleared).toEqual({ text: "Cleared 42 cards from the deck", detail: null });
    expect(cleared.text).not.toContain("actual list");
    expect(cleared.text).not.toContain("theory list");
  });

  /** A pile's clear still names the pile: `clearedFrom` keys on the payload's own `scope` and
   *  only reaches the variant for a whole-list row. */
  it("still names the pile a deck's category clear emptied", () => {
    expect(
      activityLine(
        deckEntry("remove", { action: "clear", category: "Ramp", cards: 7 }, { cardId: null }),
      ).text,
    ).toBe("Cleared 7 cards from Ramp");
  });

  /** `auditSentence`'s own answer for a caller with no day's rows to resolve `of` against, which
   *  a feed line is by construction — it has to be drawable on its own. */
  it("degrades an undo to the sentence a lone row can honestly carry", () => {
    expect(activityLine(deckEntry("deck", { field: "undo", of: 12 }, { cardId: null }))).toEqual({
      text: "Undid a change",
      detail: null,
    });
  });
});

describe("activityDays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A local wall-clock time, so the day boundaries below are the same in every timezone.
    vi.setSystemTime(new Date(2026, 8, 11, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups by local calendar day, newest day first", () => {
    const days = activityDays([
      entry("collection", "add", {}, { at: at(2026, 8, 11, 14, 12) }),
      entry("collection", "add", {}, { at: at(2026, 8, 11, 0, 1) }),
      entry("wishlist", "add", {}, { at: at(2026, 8, 10, 22, 40) }),
      entry("collection", "add", {}, { at: at(2026, 8, 3, 18, 2) }),
    ]);

    expect(days.map((d) => d.key)).toEqual(["2026-09-11", "2026-09-10", "2026-09-03"]);
    expect(days.map((d) => d.lines.length)).toEqual([2, 1, 1]);
  });

  /**
   * **The regression.** A day sliced off `toISOString()` is UTC, so a change made at 23:30 local
   * files itself under *tomorrow* for half the world — and a "Today" section then contains
   * nothing that happened today. The grouping is `auditText.ts`'s `localDay`, imported rather
   * than re-derived.
   *
   * **Both ends of the day are asserted, and that is what makes the test timezone-independent.**
   * A single 23:30 row proves nothing east of Greenwich — 23:30 at UTC+2 is 21:30 UTC, the same
   * date — and a single 00:30 row proves nothing west of it. One local day held at both ends must
   * be **one** section wherever the suite runs: under the UTC slice a positive offset splits the
   * 00:30 row off the back and a negative offset splits the 23:30 row off the front, so the only
   * machine that passes a broken build is one already running in UTC.
   */
  it("files a change made at 23:30 under its own local day", () => {
    const days = activityDays([
      entry("collection", "add", {}, { at: at(2026, 8, 10, 23, 30) }),
      entry("collection", "add", {}, { at: at(2026, 8, 10, 12, 0) }),
      entry("collection", "add", {}, { at: at(2026, 8, 10, 0, 30) }),
    ]);

    expect(days.map((d) => d.key)).toEqual(["2026-09-10"]);
    expect(days.map((d) => d.label)).toEqual(["Yesterday"]);
    expect(days[0].lines.length).toBe(3);
  });

  it("labels today and yesterday in words and everything else by its date", () => {
    const days = activityDays([
      entry("collection", "add", {}, { at: at(2026, 8, 11, 14, 12) }),
      entry("collection", "add", {}, { at: at(2026, 8, 10, 22, 40) }),
      entry("collection", "add", {}, { at: at(2026, 8, 3, 18, 2) }),
      entry("collection", "add", {}, { at: at(2025, 11, 24, 18, 2) }),
    ]);

    expect(days.map((d) => d.label)).toEqual([
      "Today",
      "Yesterday",
      "Thursday, September 3",
      // A different year says so, because "Wednesday, December 24" alone is a date the reader
      // would place in the wrong twelvemonth.
      "Wednesday, December 24, 2025",
    ]);
  });

  /** The day header's `+7 / −6` roll-up, and the reason `delta` is signed copies. Two counters
   *  rather than one signed sum: a day that gained seven and lost six is not `+1`. */
  it("rolls a day up into added and removed copies", () => {
    const days = activityDays([
      entry("collection", "add", {}, { at: at(2026, 8, 11, 14, 12), delta: 4 }),
      entry("wishlist", "add", {}, { at: at(2026, 8, 11, 13, 55), delta: 3 }),
      entry("collection", "remove", {}, { at: at(2026, 8, 11, 13, 51), delta: -6 }),
      entry("collection", "folder", {}, { at: at(2026, 8, 11, 11, 20), delta: 0 }),
      entry("collection", "add", {}, { at: at(2026, 8, 10, 22, 40), delta: 7 }),
    ]);

    expect(days.map((d) => [d.added, d.removed])).toEqual([
      [7, 6],
      [7, 0],
    ]);
  });

  /** The read answers `ORDER BY at DESC, id DESC`; a grouping that re-sorted inside a day would
   *  put a row where the backend did not, and two surfaces would tell two stories. */
  it("keeps the order it was given inside a day", () => {
    const days = activityDays([
      entry("collection", "add", {}, { at: at(2026, 8, 11, 14, 12), id: 90 }),
      entry("collection", "add", {}, { at: at(2026, 8, 11, 15, 30), id: 91 }),
    ]);

    expect(days[0].lines.map((l) => l.entry.id)).toEqual([90, 91]);
  });

  /** The line is drawn once, here, so a widget draws what it is handed rather than calling the
   *  renderer per row on every render. */
  it("draws each entry's sentence beside the entry itself", () => {
    const days = activityDays([
      entry("collection", "add", { folder: "Binder A" }, { at: at(2026, 8, 11, 14, 12), delta: 2 }),
    ]);

    expect(days[0].lines[0].line).toEqual({
      text: "Added 2 × Lightning Bolt",
      detail: "to Binder A",
    });
  });

  it("answers nothing for a feed with no rows", () => {
    expect(activityDays([])).toEqual([]);
  });
});

/** The fixture the sixteen sentence tests are written against: a payload, and the signed copies
 *  the row carries — which is where a collection or wishlist line reads its count from. */
function entryLine(
  scope: string,
  kind: string,
  payload: unknown,
  delta: number,
  over: Partial<ActivityEntry> = {},
) {
  return activityLine(entry(scope, kind, payload, { delta, ...over }));
}
