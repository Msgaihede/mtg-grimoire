import { describe, expect, it } from "vitest";
import type { CategoryKind } from "@/lib/ipc";
import { packColumns, splitSideboard } from "./columns";

const heights = (columns: number[][]) => columns.map((c) => c.reduce((n, h) => n + h, 0));

describe("packColumns", () => {
  it("fills a column before starting the next one", () => {
    expect(packColumns([100, 100, 100, 100], (h) => h, 250)).toEqual([
      [100, 100],
      [100, 100],
    ]);
  });

  /**
   * The whole constraint. A balanced packer fits more into fewer columns and puts the
   * Sideboard between Ramp and Removal — a deck list nobody can find anything in. The order
   * is the reader's `sortOrder`, so it survives.
   *
   * **The input is deliberately not in descending order**, which is the whole of what makes
   * this test able to fail. `[200, 90, 90]` is *already* what a first-fit-**decreasing** packer
   * would sort it into, so that adversary — the one the sentence above names — produces the
   * same answer and the assertion holds against it. `[90, 200, 90]` separates them: in order it
   * costs three columns, and any packer that sorts by height gets two.
   */
  it("never reorders, even when reordering would pack better", () => {
    // Greedy in order: 90 alone (200 will not join it), then 200 alone, then the last 90.
    // Three columns for something that fits in two, and the three are in the reader's order.
    expect(packColumns([90, 200, 90], (h) => h, 200)).toEqual([[90], [200], [90]]);
  });

  /** A ninety-card main deck is a real pile. One that vanished for being too big would be
   *  the worst bug this file could have. */
  it("gives an over-tall item a column of its own rather than dropping it", () => {
    const columns = packColumns([50, 900, 50], (h) => h, 200);

    expect(columns).toEqual([[50], [900], [50]]);
    expect(heights(columns)).toEqual([50, 900, 50]);
  });

  it("answers nothing for nothing", () => {
    expect(packColumns([], (h: number) => h, 200)).toEqual([]);
  });

  it("keeps every item exactly once", () => {
    const items = [10, 20, 30, 40, 50, 60, 70];
    expect(packColumns(items, (h) => h, 100).flat()).toEqual(items);
  });
});

/** Only the two fields the split is about. `splitSideboard` is generic on `{ kind }` precisely
 *  so a test can hand it this and not a whole `CardGroup`. */
const group = (name: string, kind: CategoryKind | null) => ({ name, kind });
const names = (groups: readonly { name: string }[]) => groups.map((g) => g.name);

describe("splitSideboard", () => {
  it("splits a side group out and leaves the rest in order", () => {
    const { flow, sideboard } = splitSideboard([
      group("Ramp", "main"),
      group("Sideboard", "side"),
      group("Removal", "main"),
    ]);

    expect(names(flow)).toEqual(["Ramp", "Removal"]);
    expect(names(sideboard)).toEqual(["Sideboard"]);
  });

  /**
   * The name is the user's and the kind is what the rules read.
   *
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so a reader may head a pile of removal
   * "Sideboard" and rename the real one "Board". A split on the heading passes every other test
   * in this block and gets exactly this deck backwards — the homebrew pinned to the right, the
   * pile the format knows about buried in the pack.
   */
  it("splits on the kind and never on the heading", () => {
    const { flow, sideboard } = splitSideboard([
      group("Sideboard", "main"),
      group("Board", "side"),
    ]);

    expect(names(flow)).toEqual(["Sideboard"]);
    expect(names(sideboard)).toEqual(["Board"]);
  });

  /** A derived group — "Mana value 3" is a heading and nothing more — has no rules role at all,
   *  so it flows. The `kind` decides and the grouping mode never does: a layout of buckets draws
   *  a rail exactly when one of the groups handed over still carries `side`, which none of these
   *  do and the next test's do. */
  it("keeps a derived group in the flow", () => {
    const { flow, sideboard } = splitSideboard([
      group("Mana value 3", null),
      group("Commander", "commander"),
    ]);

    expect(names(flow)).toEqual(["Mana value 3", "Commander"]);
    expect(sideboard).toEqual([]);
  });

  /**
   * A switched-off Sideboard reaches the rail, and this is the case that puts one among the
   * derived buckets.
   *
   * Under `manaValue` and `type`, `buildGroups` buckets the **active** cards and then appends
   * every inactive category *unchanged* — that is `grouping.ts`'s own headline rule. So a reader
   * who flips the Sideboard's switch and then groups by mana value hands this function exactly
   * the list below: headings that flow, and one `side` group that does not.
   *
   * **What a failure looks like:** a split that had learned about `groupBy`, or that read
   * `isActive` as well as `kind`, leaves that pile flowing between "Mana value 2" and "Mana
   * value 3", where the greedy pack drops it at the end of the run — the position problem the
   * rail exists to remove, back again in the two modes and for the one reader least likely to be
   * believed about it.
   */
  it("carries a switched-off side group to the rail among derived groups", () => {
    const { flow, sideboard } = splitSideboard([
      group("Mana value 2", null),
      group("Mana value 3", null),
      // The extra field is the point of the case: this is the pile as `buildGroups` appends it,
      // switch and all, and nothing in the split may read that switch.
      { ...group("Sideboard", "side"), isActive: false },
    ]);

    expect(names(flow)).toEqual(["Mana value 2", "Mana value 3"]);
    expect(names(sideboard)).toEqual(["Sideboard"]);
  });

  /** Nothing says a deck has one. Two piles the reader split themselves both belong on the
   *  right, and in the order they arranged them in. */
  it("carries every side group to the rail, in order", () => {
    const { flow, sideboard } = splitSideboard([
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Wishboard", "side"),
      group("Maybeboard", "maybe"),
      group("Against control", "side"),
    ]);

    expect(names(flow)).toEqual(["Ramp", "Maybeboard"]);
    expect(names(sideboard)).toEqual(["Sideboard", "Wishboard", "Against control"]);
  });

  it("answers two empty arrays for no groups", () => {
    expect(splitSideboard([])).toEqual({ flow: [], sideboard: [] });
  });

  /** The common deck. An empty `sideboard` is what tells both views to draw no rail at all,
   *  so this is the answer nearly every reader gets. */
  it("answers an empty sideboard for a deck with no sideboard category", () => {
    const { flow, sideboard } = splitSideboard([
      group("Commander", "commander"),
      group("Ramp", "main"),
    ]);

    expect(names(flow)).toEqual(["Commander", "Ramp"]);
    expect(sideboard).toEqual([]);
  });
});
