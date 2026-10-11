import { describe, expect, it } from "vitest";
import {
  cleanTag,
  hasTag,
  suggestTags,
  tagsInUse,
  withoutTag,
  withTag,
  type TagInUse,
} from "./deckTags";

/** A deck as far as this module reads one. */
const deck = (...tags: string[]) => ({ tags });

describe("cleanTag", () => {
  it("trims the ends and closes each inner run of whitespace to one space", () => {
    expect(cleanTag("  No   Gamechangers \t")).toBe("No Gamechangers");
  });

  it("answers the empty string for a blank, which is what every caller tests for", () => {
    expect(cleanTag("")).toBe("");
    expect(cleanTag("   \t ")).toBe("");
  });

  it("leaves the reader's capitals alone", () => {
    expect(cleanTag("cEDH")).toBe("cEDH");
  });
});

describe("hasTag", () => {
  it("matches whatever the capitals", () => {
    expect(hasTag(["Budget"], "budget")).toBe(true);
    expect(hasTag(["Budget"], "BUDGET")).toBe(true);
  });

  /** The fold is Rust's `to_lowercase` and nothing wider — an accent is a different tag, because
   *  the write would keep both and a field that refused the second would be lying about it. */
  it("does not fold accents, which the write does not either", () => {
    expect(hasTag(["Jötun"], "Jotun")).toBe(false);
  });

  it("matches the whole tag and never a part of one", () => {
    expect(hasTag(["Only removal"], "removal")).toBe(false);
  });
});

describe("withTag", () => {
  it("puts the cleaned tag on the end, in a new list", () => {
    const before = ["Budget"];
    const after = withTag(before, "  Meme ");
    expect(after).toEqual(["Budget", "Meme"]);
    expect(before).toEqual(["Budget"]);
  });

  /** `null` rather than the same list back: a caller that writes on every non-null answer can
   *  then never write a no-op. */
  it("answers null for a blank and for a tag the deck already wears", () => {
    expect(withTag(["Budget"], "   ")).toBeNull();
    expect(withTag(["Budget"], "budget")).toBeNull();
  });
});

describe("withoutTag", () => {
  it("takes the tag off, matched as hasTag matches", () => {
    expect(withoutTag(["Budget", "Meme"], "BUDGET")).toEqual(["Meme"]);
  });

  it("answers the list whole when the tag is not on it", () => {
    expect(withoutTag(["Budget"], "Meme")).toEqual(["Budget"]);
  });
});

describe("tagsInUse", () => {
  it("answers nothing for a gallery that wears no tags", () => {
    expect(tagsInUse([deck(), deck()])).toEqual([]);
  });

  it("lists each tag once, alphabetically, with the number of decks that wear it", () => {
    expect(tagsInUse([deck("Meme", "Budget"), deck("Budget"), deck("No Gamechangers")])).toEqual([
      { tag: "Budget", count: 2 },
      { tag: "Meme", count: 1 },
      { tag: "No Gamechangers", count: 1 },
    ]);
  });

  /** Two spellings are one suggestion, drawn the way most decks draw it — so picking it is what
   *  brings the odd one out into line. */
  it("folds capitals into one row and draws the spelling most decks use", () => {
    expect(tagsInUse([deck("meme"), deck("Meme"), deck("Meme")])).toEqual([
      { tag: "Meme", count: 3 },
    ]);
  });

  /** `deck_list` is most-recently-touched first, so "first seen" would flip a suggestion's
   *  capitals every time either deck was edited. */
  it("settles a tie between spellings the same way whatever order the decks arrive in", () => {
    const one = tagsInUse([deck("meme"), deck("Meme")]);
    const other = tagsInUse([deck("Meme"), deck("meme")]);
    expect(one).toEqual([{ tag: "Meme", count: 2 }]);
    expect(other).toEqual(one);
  });

  /** Rust never stores a repeat, but a peer's row might carry one, and a count is of decks. */
  it("counts a deck once however often its row repeats a tag", () => {
    expect(tagsInUse([deck("Budget", "budget")])).toEqual([{ tag: "Budget", count: 1 }]);
  });
});

describe("suggestTags", () => {
  const inUse: TagInUse[] = [
    { tag: "Budget", count: 2 },
    { tag: "Only removal", count: 1 },
    { tag: "Removal", count: 3 },
  ];

  /** The whole point of the list: the reader tagging a second deck sees the first deck's words
   *  before typing one. */
  it("offers every tag in use for an empty draft", () => {
    expect(suggestTags(inUse, [], "")).toEqual(inUse);
    expect(suggestTags(inUse, [], "   ")).toEqual(inUse);
  });

  it("leaves out the tags this deck already wears, whatever their capitals", () => {
    expect(suggestTags(inUse, ["budget"], "").map((row) => row.tag)).toEqual([
      "Only removal",
      "Removal",
    ]);
  });

  it("narrows to the tags that contain the draft, capitals aside", () => {
    expect(suggestTags(inUse, [], "BUD").map((row) => row.tag)).toEqual(["Budget"]);
    expect(suggestTags(inUse, [], "zzz")).toEqual([]);
  });

  it("lists a tag that starts with the draft above one that merely contains it", () => {
    expect(suggestTags(inUse, [], "re").map((row) => row.tag)).toEqual(["Removal", "Only removal"]);
  });

  /** The draft is cleaned as a tag would be, so a trailing space typed on the way to a second
   *  word does not empty the list. */
  it("reads the draft as the tag it would become", () => {
    expect(suggestTags(inUse, [], " only  rem").map((row) => row.tag)).toEqual(["Only removal"]);
  });
});
