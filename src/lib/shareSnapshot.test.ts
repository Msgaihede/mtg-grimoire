/**
 * The TypeScript half of the golden fence.
 *
 * `src-tauri/src/share/__golden__/snapshot.json` is written by the Rust writer and asserted
 * byte-for-byte by `share::tests::the_golden_snapshot_is_what_the_writer_produces`. This suite
 * parses **that same file** — imported rather than restated — so a change to the wire format
 * that the writer accepts and this mirror does not is a red build on one side or the other,
 * rather than a viewer that quietly disagrees with the publisher.
 */
import { describe, expect, it } from "vitest";
import golden from "../../src-tauri/src/share/__golden__/snapshot.json?raw";
import { parseSnapshot, SNAPSHOT_TOO_NEW, SNAPSHOT_VERSION } from "./shareSnapshot";

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

  /** Not a smoke test: this is the assertion that the writer's absences are real. */
  it("carries no private field", () => {
    for (const forbidden of ["purchase", "acquired", "notes", "tags", "tradelist"]) {
      expect(golden).not.toContain(forbidden);
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
