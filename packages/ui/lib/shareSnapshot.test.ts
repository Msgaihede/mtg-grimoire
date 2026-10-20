/**
 * The TypeScript half of the golden fence.
 *
 * `apps/desktop/src-tauri/src/share/__golden__/snapshot.json` is written by the Rust writer and asserted
 * byte-for-byte by `share::tests::the_golden_snapshot_is_what_the_writer_produces`. This suite
 * parses **that same file** — imported rather than restated — so a change to the wire format
 * that the writer accepts and this mirror does not is a red build on one side or the other,
 * rather than a viewer that quietly disagrees with the publisher.
 */
import { describe, expect, it } from "vitest";
import golden from "../../../apps/desktop/src-tauri/src/share/__golden__/snapshot.json?raw";
import deckGolden from "../../../apps/desktop/src-tauri/src/share/__golden__/deck.json?raw";
import imageUriRs from "../../../crates/grimoire-core/src/image_uri.rs?raw";
import sharesTs from "../../../infrastructure/share-worker/src/shares.ts?raw";
import {
  parseSnapshot,
  parseSnapshotValue,
  SHARE_IMAGE_ORIGIN,
  shareDeckOf,
  shareImage,
  SNAPSHOT_NOT_A_SNAPSHOT,
  SNAPSHOT_TOO_NEW,
  SNAPSHOT_VERSION,
} from "./shareSnapshot";

describe("the share snapshot mirror", () => {
  it("parses the golden the Rust writer produced", () => {
    const s = parseSnapshot(golden);
    expect(s.v).toBe(SNAPSHOT_VERSION);
    expect(s.title).toBe("Trade binder");
    expect(s.owner).toBe("Giradeli");
    expect(s.cards).toHaveLength(2);
    expect(s.folders.map((f) => f.name)).toEqual(["Trade binder", "Duals"]);
    // The subfolder's card carries its own folder uid, which is what lets the viewer draw a tree.
    expect(s.cards.some((c) => c.fo !== s.folders[0].uid)).toBe(true);
  });

  /**
   * The shared folder is the root of the tree it publishes, so its `parent` is `null` even
   * though it has a real parent at home. A viewer that treats every `parent` as resolvable
   * walks off the end of the snapshot on exactly this row.
   */
  it("gives the shared folder a null parent and its child a real edge", () => {
    const [root, child] = parseSnapshot(golden).folders;
    expect(root.parent).toBeNull();
    expect(child.parent).toBe(root.uid);
  });

  /**
   * ⚠️ The obligation this whole module exists to record: **`fields` advertising a column does
   * not promise every card has it.** The Rust writer omits `c` for an ungraded copy and `p` for
   * a finish the marketplace does not quote, and both are ordinary rather than edge cases. The
   * golden is a *full* snapshot by design, so this is the case it cannot show — the writer's
   * own `an_ungraded_copy_carries_no_condition_at_all` and
   * `an_unpriced_finish_carries_no_value_and_does_not_fail_the_publish` are the other half.
   */
  it("parses a snapshot whose fields advertise columns some cards do not carry", () => {
    const s = JSON.parse(golden) as Record<string, unknown>;
    const cards = s.cards as Record<string, unknown>[];
    delete cards[0].c;
    delete cards[1].p;
    const parsed = parseSnapshot(JSON.stringify(s));
    expect(parsed.fields).toContain("condition");
    expect(parsed.fields).toContain("value");
    expect(parsed.cards[0].c).toBeUndefined();
    expect(parsed.cards[1].p).toBeUndefined();
  });

  /**
   * Not a smoke test: this is the assertion that the writer's absences are real.
   *
   * ⚠️ **It swept five key names and no values until 2026-09-08, while calling itself that** —
   * which is exactly the half `share::tests::no_private_field_can_reach_the_wire` says a key-name
   * sweep passes over: a private column reaching the wire under a short key, or renamed on the
   * way out, carries none of these strings. The golden is written by that same Rust fixture, and
   * every private column in it holds a distinctive `private-…` marker, so this side can sweep the
   * **content** as well and does.
   *
   * The two fences are deliberately not one. Rust's runs over a snapshot built at test time and
   * so holds for *every* input; this one runs over the **committed** file and is what goes red
   * when a golden is regenerated with a leak in it — the case where the writer's own suite was
   * updated in the same commit.
   */
  it("carries no private field, by key name or by value", () => {
    for (const forbidden of [
      // Spec §3's first list — absent from the format, never switched off in it.
      "purchase",
      "acquired",
      "acquisition",
      "notes",
      "tags",
      // Spec §3's second list — absent because nothing in either viewer draws them.
      "needsReview",
      "needs_review",
      "conditionOriginal",
      "condition_original",
      "tradelist",
      "grading",
      "serial",
      "altered",
      "signed",
      "proxy",
      "misprint",
      // The values. Every private column the Rust fixture can write a string into holds the
      // same marker, so one substring sweeps the lot; the two that cannot are spelled out.
      "private-",
      "bought at a GP",
      "9.99",
    ]) {
      expect(golden, forbidden).not.toContain(forbidden);
    }
  });

  it("refuses a snapshot from a newer build by name rather than rendering half of it", () => {
    const newer = JSON.stringify({ ...JSON.parse(golden), v: SNAPSHOT_VERSION + 1 });
    expect(() => parseSnapshot(newer)).toThrow(SNAPSHOT_TOO_NEW);
  });

  it("refuses a body that is not a snapshot at all", () => {
    expect(() => parseSnapshot("not json")).toThrow();
    expect(() => parseSnapshot("{}")).toThrow();
  });

  /**
   * The refusal above reaches neither of the branches this one is about: `"not json"` never
   * parses, and `"{}"` is a perfectly good **object** that is turned away one line further down
   * for having no arrays. A body that parses to something other than an object was going through
   * `parseSnapshot` nowhere at all.
   *
   * **`"[]"` is the case worth having**, and by name rather than merely throwing: a viewer that
   * matches a refusal on the sentence — which is how Tasks 9 and 10 will draw one — cannot tell
   * "refused" from "threw" and must be given the same words for every shape of not-a-snapshot.
   */
  it("refuses a body that parses to something other than an object, by name", () => {
    for (const body of ["42", "null", '"a string"', "[]", "true"]) {
      expect(() => parseSnapshot(body), body).toThrow(SNAPSHOT_NOT_A_SNAPSHOT);
    }
  });

  /**
   * A snapshot from an *older* build is readable, which is the other half of the version
   * check: refusing anything but the current number would make every published share expire
   * the day the format grows a field.
   */
  it("reads a snapshot from an older build", () => {
    const older = JSON.stringify({ ...JSON.parse(golden), v: SNAPSHOT_VERSION - 1 });
    expect(parseSnapshot(older).cards).toHaveLength(2);
  });

  it("refuses a snapshot missing either array by name", () => {
    const noCards = JSON.parse(golden) as Record<string, unknown>;
    delete noCards.cards;
    expect(() => parseSnapshot(JSON.stringify(noCards))).toThrow();
    const noFolders = JSON.parse(golden) as Record<string, unknown>;
    delete noFolders.folders;
    expect(() => parseSnapshot(JSON.stringify(noFolders))).toThrow();
    // A non-array in the slot is the same refusal — `[]` is a shape, not a presence check.
    expect(() => parseSnapshot(JSON.stringify({ ...JSON.parse(golden), cards: {} }))).toThrow();
  });

  /**
   * `JSON.parse`'s own `SyntaxError` names a character offset and nothing a reader could act
   * on, so the module rethrows a sentence. Asserted as "not the raw one" rather than against a
   * literal, because the literal is this module's to change.
   */
  it("throws a sentence rather than a SyntaxError", () => {
    let caught: unknown;
    try {
      parseSnapshot("not json");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/JSON/i);
  });
});

/**
 * The value door, which is the one `ipc.shareOpen` comes through.
 *
 * That command answers `serde_json::Value`, so the in-app viewer already holds a parsed object —
 * and `parseSnapshot(JSON.stringify(v))` over a whole binder is a serialise-and-reparse of the
 * measured 2.07 MB at 50 000 cards for an answer that was already in hand. Every refusal has to
 * be the same one `parseSnapshot` throws, or the two viewers would disagree about what a
 * snapshot is.
 */
describe("the value door", () => {
  it("reads an already-parsed snapshot without a round trip", () => {
    const s = parseSnapshotValue(JSON.parse(golden));
    expect(s.owner).toBe("Giradeli");
    expect(s.cards).toHaveLength(2);
  });

  it("refuses the same ways the text door does", () => {
    expect(() => parseSnapshotValue(null)).toThrow(SNAPSHOT_NOT_A_SNAPSHOT);
    expect(() => parseSnapshotValue([])).toThrow(SNAPSHOT_NOT_A_SNAPSHOT);
    expect(() => parseSnapshotValue(7)).toThrow(SNAPSHOT_NOT_A_SNAPSHOT);
    expect(() => parseSnapshotValue({ ...JSON.parse(golden), v: SNAPSHOT_VERSION + 1 })).toThrow(
      SNAPSHOT_TOO_NEW,
    );
    const noCards = JSON.parse(golden) as Record<string, unknown>;
    delete noCards.cards;
    expect(() => parseSnapshotValue(noCards)).toThrow(SNAPSHOT_NOT_A_SNAPSHOT);
  });

  /**
   * The text door **is** the value door with a `JSON.parse` in front of it, and this is what
   * says so. Two implementations of the four refusals is exactly the drift the delegation
   * exists to prevent, and it is the kind that goes unnoticed: both would pass their own tests
   * while one viewer refused a document the other drew.
   */
  it("is what the text door delegates to", () => {
    expect(parseSnapshot(golden)).toEqual(parseSnapshotValue(JSON.parse(golden)));
  });
});

/**
 * A deck share (issue #1032) — `deck.json`, written by
 * `share::tests::the_golden_deck_snapshot_is_what_the_writer_produces` and parsed here, so the
 * deck half of the format is fenced the way the binder's is.
 */
describe("a shared deck", () => {
  it("parses the deck golden the Rust writer produced", () => {
    const s = parseSnapshot(deckGolden);
    expect(s.v).toBe(SNAPSHOT_VERSION);
    expect(s.title).toBe("Krenko's Goblins");
    // A deck row has no condition, so the question is not claimed.
    expect(s.fields).not.toContain("condition");
    const deck = shareDeckOf(s);
    expect(deck).not.toBeNull();
    expect(deck?.format).toBe("Commander");
    // Every pile is a folder too, named as the reader named it, so a viewer that predates decks
    // draws one drawer per pile.
    const names = deck?.piles.map((p) => s.folders.find((f) => f.uid === p.uid)?.name);
    expect(names).toEqual(["Commander", "Burn"]);
    expect(deck?.piles.map((p) => p.kind)).toEqual(["commander", "main"]);
  });

  it("carries the three facts a deck is read by on every card", () => {
    const bolt = parseSnapshot(deckGolden).cards.find((c) => c.n === "Lightning Bolt");
    expect(bolt).toMatchObject({ t: "Instant", mc: "{R}", mv: 1 });
    expect(bolt?.c).toBeUndefined();
  });

  it("is no deck at all for a binder, whose document did not change", () => {
    const s = parseSnapshot(golden);
    expect(shareDeckOf(s)).toBeNull();
    expect("deck" in (JSON.parse(golden) as object)).toBe(false);
    for (const card of JSON.parse(golden).cards as Record<string, unknown>[]) {
      expect(card.t).toBeUndefined();
      expect(card.mc).toBeUndefined();
      expect(card.mv).toBeUndefined();
    }
  });

  it("reads a deck half it cannot draw as no deck, and drops a pile that names no folder", () => {
    const s = parseSnapshot(deckGolden);
    expect(shareDeckOf({ ...s, deck: "nonsense" as never })).toBeNull();
    expect(shareDeckOf({ ...s, deck: { format: "x" } as never })).toBeNull();
    const deck = shareDeckOf({
      ...s,
      deck: {
        format: 7 as never,
        piles: [
          ...(s.deck?.piles ?? []),
          { uid: "pile-elsewhere", kind: "main", active: true },
          null as never,
        ],
      },
    });
    expect(deck?.format).toBe("");
    expect(deck?.piles.map((p) => p.uid)).toEqual(s.deck?.piles.map((p) => p.uid));
  });
});

/**
 * Issue #1153: a snapshot is its publisher's document and nothing upstream reads its `img`s, so
 * the viewer draws a picture only from the host the writer takes every one of them from.
 */
describe("shareImage", () => {
  it("passes every picture the golden carries", () => {
    for (const text of [golden, deckGolden]) {
      for (const card of parseSnapshot(text).cards) {
        expect(card.img).toBeDefined();
        expect(shareImage(card)).toBe(card.img);
      }
    }
  });

  it("is no picture for a card with none", () => {
    expect(shareImage({})).toBeNull();
    expect(shareImage({ img: null as never })).toBeNull();
    expect(shareImage({ img: 7 as never })).toBeNull();
  });

  it("is no picture for any host but Scryfall's", () => {
    for (const img of [
      "https://tracker.example/?c=1",
      // The trailing slash is the check: the byte after the host must end it.
      "https://cards.scryfall.io.evil.test/x.webp",
      "https://cards.scryfall.io@evil.test/x.webp",
      "http://cards.scryfall.io/x.webp",
      "//cards.scryfall.io/x.webp",
      "/s/AAAAAAAAAAAAAAAA",
      "data:image/svg+xml,<svg/>",
      "",
    ]) {
      expect(shareImage({ img }), img).toBeNull();
    }
  });

  /**
   * One host, written three times: the writer's, the share Worker's (`og:image`, and the
   * shell's `img-src` built from it) and this viewer's. Read as text, as `ipc.test.ts` reads
   * Rust: neither of the other two can be imported into a webview package.
   */
  it("is the host the writer and the share Worker name", () => {
    expect(imageUriRs).toContain(`pub const IMAGE_HOST: &str = "${SHARE_IMAGE_ORIGIN}";`);
    expect(sharesTs).toContain(`export const PREVIEW_IMAGE_ORIGIN = "${SHARE_IMAGE_ORIGIN}";`);
  });
});
