import { describe, expect, it } from "vitest";
import { parseReleaseNotes, plainText, type Block } from "./releaseNotes";

/** The list items of the first list in `blocks`, as plain strings. */
function items(blocks: Block[]): string[] {
  const list = blocks.find((b) => b.kind === "list");
  return list ? list.items.map(plainText) : [];
}

/**
 * One release body as GitHub actually serves it, copied from this repository's own v0.9.1.
 *
 * Verbatim on purpose, duplicated bullets and all: those two lines are the same commit
 * message landed on two branches, and they are exactly what the reader in the bug report
 * was looking at.
 */
const V0_9_1 = `## [0.9.1](https://github.com/Msgaihede/mtg-grimoire/compare/v0.9.0...v0.9.1) (2026-08-16)


### Bug Fixes

* **decks:** draw the deck grid's tiles with the search wall's CardArt ([23d15d5](https://github.com/Msgaihede/mtg-grimoire/commit/23d15d5d88eeca3ff733c01d255e76c62b4c5734))
* **decks:** draw the deck grid's tiles with the search wall's CardArt ([2f2af37](https://github.com/Msgaihede/mtg-grimoire/commit/2f2af3787c1e4913ac8267edb43826f79b461603))
* **decks:** key the view restore on the deck, not on what it restores ([b707a73](https://github.com/Msgaihede/mtg-grimoire/commit/b707a735cc1c98e60cd7a0d49093b8625c8c0040))
`;

describe("parseReleaseNotes", () => {
  it("reads release-please's whole vocabulary out of one real release body", () => {
    const blocks = parseReleaseNotes(V0_9_1);

    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list"]);
    const heading = blocks[0];
    expect(heading.kind === "heading" && heading.level).toBe(3);
    expect(plainText(heading)).toBe("Bug Fixes");
  });

  /**
   * The version heading the panel already draws above the notes.
   *
   * Every release-please body opens with `## [0.9.1](compare…) (2026-08-16)`, and the row
   * it is rendered under says "0.9.1" and the date in the app's own type. Two of them is
   * the panel repeating itself, so the leading one is dropped — and only the leading one,
   * because a heading further down is a section the author wrote.
   */
  it("drops the leading version heading and nothing that looks like it further down", () => {
    expect(parseReleaseNotes(V0_9_1)[0]).toMatchObject({ level: 3 });

    const later = parseReleaseNotes("### Features\n\n* a thing\n\n## [0.9.0](x) (2026-08-15)");
    expect(later.filter((b) => b.kind === "heading")).toHaveLength(2);
  });

  /**
   * The commit trailer, gone.
   *
   * `([23d15d5](…/commit/23d15d5d…))` is release-please's provenance, and a reader of a
   * desktop changelog can do nothing with a SHA. Only a link whose text is a hex
   * abbreviation of its own commit URL is stripped — an ordinary link in a body is content.
   */
  it("strips the commit-sha trailer and leaves a real link alone", () => {
    expect(items(parseReleaseNotes(V0_9_1))[0]).toBe(
      "decks: draw the deck grid's tiles with the search wall's CardArt",
    );

    const kept = parseReleaseNotes(
      "* see [the research](https://github.com/Msgaihede/mtg-grimoire/blob/main/docs/x.md)",
    );
    const list = kept.find((b) => b.kind === "list");
    expect(list?.items[0]).toContainEqual({
      kind: "link",
      text: "the research",
      href: "https://github.com/Msgaihede/mtg-grimoire/blob/main/docs/x.md",
    });
  });

  /**
   * The duplicates in the bug report, collapsed.
   *
   * Two bullets differing only by SHA are one fact, and they only *become* identical once
   * the trailer is stripped — which is why the order of the two rules matters and is pinned
   * here. A bullet that differs in its words survives, however similar it reads.
   */
  it("collapses bullets that are identical once the sha is gone", () => {
    expect(items(parseReleaseNotes(V0_9_1))).toEqual([
      "decks: draw the deck grid's tiles with the search wall's CardArt",
      "decks: key the view restore on the deck, not on what it restores",
    ]);
  });

  it("keeps two bullets that differ in more than their sha", () => {
    const blocks = parseReleaseNotes(
      "* **decks:** one thing ([aaaaaaa](https://github.com/o/r/commit/aaaaaaa))\n" +
        "* **decks:** another thing ([bbbbbbb](https://github.com/o/r/commit/bbbbbbb))",
    );
    expect(items(blocks)).toHaveLength(2);
  });

  /** Dedup is per list, so a heading between two sections keeps both of their bullets. */
  it("dedupes within a section rather than across the whole body", () => {
    const blocks = parseReleaseNotes(
      "### Features\n\n* a thing\n\n### Bug Fixes\n\n* a thing",
    );
    expect(blocks.filter((b) => b.kind === "list")).toHaveLength(2);
    expect(blocks.flatMap((b) => (b.kind === "list" ? b.items : []))).toHaveLength(2);
  });

  it("reads bold, inline code and a link inside one line", () => {
    const blocks = parseReleaseNotes("* **decks:** call `deck_undo_apply` — [why](https://x.dev)");
    const list = blocks.find((b) => b.kind === "list");
    expect(list?.items[0]).toEqual([
      { kind: "strong", text: "decks:" },
      { kind: "text", text: " call " },
      { kind: "code", text: "deck_undo_apply" },
      { kind: "text", text: " — " },
      { kind: "link", text: "why", href: "https://x.dev" },
    ]);
  });

  /**
   * A link is only a link if it goes somewhere this app is willing to open.
   *
   * `update_open_release_page` already applies exactly this fence in Rust before handing a
   * URL to the opener; a release body is text from the network, and `javascript:` in a
   * markdown link is the oldest trick there is. A refused URL keeps its words and loses its
   * anchor — the reader still reads the sentence.
   */
  it("renders a non-https link as its own text and never as an anchor", () => {
    for (const href of ["javascript:alert%281%29", "http://insecure.example", "/relative"]) {
      const blocks = parseReleaseNotes(`* see [here](${href})`);
      const list = blocks.find((b) => b.kind === "list");
      expect(list?.items[0]).toEqual([
        { kind: "text", text: "see " },
        { kind: "text", text: "here" },
      ]);
    }
  });

  /**
   * release-please escapes angle brackets, and this repo's own v0.8.0 changelog is the
   * evidence: the same commit message is there twice, once as `` `<select>` `` and once as
   * `\&lt;select&gt;\`, because it landed on two branches and one went through the escaper.
   * Undecoded, the second reads as five literal characters in a shipped window.
   */
  it("decodes the entities release-please escapes, outside code spans", () => {
    const blocks = parseReleaseNotes("* an unmatched &lt;select&gt; &amp; a &quot;quote&quot;");
    expect(items(blocks)).toEqual(['an unmatched <select> & a "quote"']);

    // ...and never inside one: a note showing an escape is showing it on purpose.
    const code = parseReleaseNotes("* write `&lt;select&gt;` yourself");
    expect(items(code)).toEqual(["write &lt;select&gt; yourself"]);

    // One pass, so `&amp;lt;` stays the literal `&lt;` its author meant.
    expect(items(parseReleaseNotes("* &amp;lt; stays"))).toEqual(["&lt; stays"]);
  });

  /** Anything the vocabulary does not cover is a paragraph — never a dropped line. */
  it("falls through to a paragraph rather than losing a line it cannot classify", () => {
    const blocks = parseReleaseNotes(
      "### ⚠ BREAKING CHANGES\n\nThe deck format moved.\nRe-import your lists.\n\n> a quote",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "paragraph"]);
    expect(plainText(blocks[1])).toBe("The deck format moved. Re-import your lists.");
    expect(plainText(blocks[2])).toBe("> a quote");
  });

  it("answers nothing at all for a release with an empty body", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("   \n\n  ")).toEqual([]);
  });

  /** A bullet reduced to nothing by the strip is not a bullet. */
  it("drops a bullet whose only content was its sha", () => {
    expect(
      parseReleaseNotes("* ([23d15d5](https://github.com/o/r/commit/23d15d5d88eeca3ff733c))"),
    ).toEqual([]);
  });

  it("reads both bullet markers and an indented one", () => {
    const blocks = parseReleaseNotes("* one\n- two\n  * three");
    expect(items(blocks)).toEqual(["one", "two", "three"]);
  });
});
