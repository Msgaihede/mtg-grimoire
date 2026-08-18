import { describe, expect, it } from "vitest";
import type { CategoryKind } from "@/lib/ipc";
import { packColumns, splitRail } from "./columns";

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

/** Only the fields the split is about. `splitRail` is generic on `{ kind, isActive }` precisely
 *  so a test can hand it this and not a whole `CardGroup`. **`isActive` defaults to `true`** —
 *  being in the deck is the ordinary state, so a case that says nothing about the switch is
 *  asking about the kind, and the cases that do care read as the exception they are. */
const group = (name: string, kind: CategoryKind | null, isActive = true) => ({
  name,
  kind,
  isActive,
});
const names = (groups: readonly { name: string }[]) => groups.map((g) => g.name);

describe("splitRail", () => {
  it("splits a side group out and leaves the rest in order", () => {
    const { flow, rail } = splitRail([
      group("Ramp", "main"),
      group("Sideboard", "side"),
      group("Removal", "main"),
    ]);

    expect(names(flow)).toEqual(["Ramp", "Removal"]);
    expect(names(rail)).toEqual(["Sideboard"]);
  });

  /**
   * **The Maybeboard is railed on exactly the same terms**, which is what makes it one rule and
   * not a `side` rule with a second pile bolted beside it.
   *
   * Both are piles played *beside* the deck rather than in it and both grow big enough to want a
   * fixed place; the split reads that off the kind and nothing else. Asserted on its own, with no
   * `side` group anywhere in the list, because the shape a half-done change takes is a `maybe`
   * that reaches the rail only when a Sideboard has already opened one.
   */
  it("splits a maybe group out with no side group in the deck", () => {
    const { flow, rail } = splitRail([
      group("Ramp", "main"),
      group("Maybeboard", "maybe"),
      group("Removal", "main"),
    ]);

    expect(names(flow)).toEqual(["Ramp", "Removal"]);
    expect(names(rail)).toEqual(["Maybeboard"]);
  });

  /**
   * The name is the user's and the kind is what the rules read.
   *
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so a reader may head a pile of removal
   * "Sideboard" and rename the real one "Board". A split on the heading passes every other test
   * in this block and gets exactly this deck backwards — the homebrew pinned to the right, the
   * pile the format knows about buried in the pack. Both names are used, because both kinds are
   * railed now and a heading-reading split would get a "Maybeboard" of the reader's own wrong the
   * same way.
   */
  it("splits on the kind and never on the heading", () => {
    const { flow, rail } = splitRail([
      group("Sideboard", "main"),
      group("Maybeboard", "main"),
      group("Board", "side"),
      group("Perhaps", "maybe"),
    ]);

    expect(names(flow)).toEqual(["Sideboard", "Maybeboard"]);
    expect(names(rail)).toEqual(["Board", "Perhaps"]);
  });

  /**
   * **The three kinds that still flow while they are switched on, said in one place.**
   *
   * A derived group — "Mana value 3" is a heading and nothing more — has no rules role at all, so
   * it flows; the `kind` decides and the grouping mode never does. `commander` and `companion`
   * flow for a reason of their own that `splitRail`'s doc states: one card each, so railing either
   * would spend a whole column's width on a pile read at a glance. This is the assertion that
   * fails if "the two beside-the-deck kinds" ever creeps outward into "every kind that is not
   * `main`". Every group here is switched **on**, which is what makes it about the kind alone —
   * the switch's own answer for these two is the case below.
   */
  it("keeps a derived, a commander and a companion group in the flow", () => {
    const { flow, rail } = splitRail([
      group("Mana value 3", null),
      group("Commander", "commander"),
      group("Companion", "companion"),
      group("Ramp", "main"),
    ]);

    expect(names(flow)).toEqual(["Mana value 3", "Commander", "Companion", "Ramp"]);
    expect(rail).toEqual([]);
  });

  /**
   * A switched-off pile reaches the rail, and this is the case that puts one among the derived
   * buckets.
   *
   * Under `manaValue` and `type`, `buildGroups` buckets the **active** cards and then appends
   * every inactive category *unchanged* — that is `grouping.ts`'s own headline rule. So a reader
   * who flips the Sideboard's switch and then groups by mana value hands this function exactly
   * the list below: derived headings that flow, and railed piles that do not. The Maybeboard is in
   * this list too because for that pile it is not a corner case at all — it is seeded switched off,
   * so this is the shape it arrives in almost every time.
   *
   * **The derived headings are what make this about more than the switch.** Every bucket
   * `buildGroups` invents is `isActive: true`, so they flow by the second test as well as the
   * first, and a reader can tell the two piles that were railed from the ones that were never
   * eligible.
   *
   * **What a failure looks like:** a split that had learned about `groupBy` leaves those piles
   * flowing between "Mana value 2" and "Mana value 3", where the greedy pack drops them at the end
   * of the run — the position problem the rail exists to remove, back again in the two modes and
   * for the one reader least likely to be believed about it.
   */
  it("carries switched-off railed groups to the rail among derived groups", () => {
    const { flow, rail } = splitRail([
      group("Mana value 2", null),
      group("Mana value 3", null),
      group("Sideboard", "side", false),
      group("Maybeboard", "maybe", false),
    ]);

    expect(names(flow)).toEqual(["Mana value 2", "Mana value 3"]);
    expect(names(rail)).toEqual(["Sideboard", "Maybeboard"]);
  });

  /**
   * **A pile the reader switched off is railed, under the two kinds that head the rail.**
   *
   * This is the whole of the change of 2026-08-17. `is_active = 0` means the pile counts toward
   * nothing — not size, not copies, not legality — so it is not part of the deck being laid out,
   * and leaving it in the flow spent a column of the desk on cards the reader had already said
   * were not in the deck.
   *
   * The order is the assertion that matters: `Cut for now` lands **after** the Sideboard and the
   * Maybeboard even though its `sortOrder` puts it between them here. The kind test runs first,
   * so the rail's head is the two beside-the-deck piles whatever anyone's switch says, and the
   * reader's own switched-off piles follow underneath.
   */
  it("rails a switched-off pile of the reader's own, under the two railed kinds", () => {
    const { flow, rail } = splitRail([
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Cut for now", "main", false),
      group("Maybeboard", "maybe", false),
    ]);

    expect(names(flow)).toEqual(["Ramp"]);
    expect(names(rail)).toEqual(["Sideboard", "Maybeboard", "Cut for now"]);
  });

  /**
   * **Switching the pile back on returns it to the flow, at its own place in it.**
   *
   * There is no state to undo: the split is derived from the two words the group carries, so the
   * round trip is the same list read twice. `Cut for now` comes back **between** Ramp and Removal
   * rather than at either end, which is the half a rail that remembered anything would get wrong —
   * and it is what "they move back to the main stack flow" has to mean for a reader who arranged
   * their categories.
   */
  it("returns a pile to the flow, in its own order, when it is switched back on", () => {
    const piles = (isActive: boolean) => [
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Cut for now", "main", isActive),
      group("Removal", "main"),
    ];

    expect(names(splitRail(piles(false)).flow)).toEqual(["Ramp", "Removal"]);
    expect(names(splitRail(piles(true)).flow)).toEqual(["Ramp", "Cut for now", "Removal"]);
    expect(names(splitRail(piles(true)).rail)).toEqual(["Sideboard"]);
  });

  /**
   * **A switched-off command zone rails like anything else**, which is the one place the two tests
   * disagree about the same pile.
   *
   * `commander` and `companion` are exempt from the rail while they are on, and the exemption's
   * reason is an argument about a pile that is *in* the deck: one card each, so a column of desk
   * spent on either is a column spent permanently. A switched-off command zone is not in the deck
   * at all, so nothing is left of that argument and the second test answers.
   */
  it("rails a switched-off commander or companion", () => {
    const { flow, rail } = splitRail([
      group("Commander", "commander", false),
      group("Companion", "companion", false),
      group("Ramp", "main"),
    ]);

    expect(names(flow)).toEqual(["Ramp"]);
    expect(names(rail)).toEqual(["Commander", "Companion"]);
  });

  /**
   * **Nothing here sorts the rail**, and this is the case that says so.
   *
   * Nothing says a deck has one sideboard: piles the reader split themselves all belong on the
   * right, in the order they arranged them in. The Maybeboard is deliberately in the **middle** of
   * the `side` piles here and last in neither half — a split that grouped by kind, or that
   * appended the maybes after the sides, would answer the same four headings in the wrong order,
   * and it would be silently overruling a reader who had dragged their categories where they
   * wanted them. `sortOrder` is the reader's; the rail inherits it and adds nothing.
   *
   * **The two switched-off piles are the same claim about the rail's second run.** They keep the
   * order they arrived in too, and the run they are in is the only thing the concatenation
   * decides. `Cut for now` is in front of the whole railed run in the input and comes out behind
   * all of it, which is the one re-arrangement this function does make — and it is the rule rather
   * than a sort, because nothing inside either run moves.
   */
  it("carries every railed group in the order it arrived, sorting nothing", () => {
    const { flow, rail } = splitRail([
      group("Cut for now", "main", false),
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Wishboard", "side"),
      group("Maybeboard", "maybe"),
      group("Against control", "side"),
      group("Retired", "main", false),
    ]);

    expect(names(flow)).toEqual(["Ramp"]);
    expect(names(rail)).toEqual([
      "Sideboard",
      "Wishboard",
      "Maybeboard",
      "Against control",
      "Cut for now",
      "Retired",
    ]);
  });

  it("answers two empty arrays for no groups", () => {
    expect(splitRail([])).toEqual({ flow: [], rail: [] });
  });

  /** The common deck. An empty `rail` is what tells both views to draw no rail at all, so this
   *  is the answer every reader with neither pile gets. */
  it("answers an empty rail for a deck with neither pile", () => {
    const { flow, rail } = splitRail([group("Commander", "commander"), group("Ramp", "main")]);

    expect(names(flow)).toEqual(["Commander", "Ramp"]);
    expect(rail).toEqual([]);
  });
});
