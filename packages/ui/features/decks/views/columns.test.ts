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
  /** Every case in this block destructures all three runs and asserts on all three, including
   *  the empty ones. The split is a partition — a group is in exactly one run — so a case that
   *  looked at two of them could not tell a pile that moved to the third from a pile that was
   *  dropped, and dropping a pile is the one failure this function must never have. */
  it("splits a side group out and leaves the rest in order", () => {
    const { command, flow, rail } = splitRail([
      group("Ramp", "main"),
      group("Sideboard", "side"),
      group("Removal", "main"),
    ]);

    expect(command).toEqual([]);
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
    const { command, flow, rail } = splitRail([
      group("Ramp", "main"),
      group("Maybeboard", "maybe"),
      group("Removal", "main"),
    ]);

    expect(command).toEqual([]);
    expect(names(flow)).toEqual(["Ramp", "Removal"]);
    expect(names(rail)).toEqual(["Maybeboard"]);
  });

  /**
   * The name is the user's and the kind is what the rules read.
   *
   * `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so a reader may head a pile of removal
   * "Sideboard" and rename the real one "Board". A split on the heading passes every other test
   * in this block and gets exactly this deck backwards — the homebrew pinned to the right, the
   * pile the format knows about buried in the pack.
   *
   * **"Commander" and "Companion" are in the list for the same reason the other two are, and
   * they are the newest way to get this wrong.** A command zone is now the most prominent place
   * on the desk, so a split that read the heading would give it to a `main` pile a reader had
   * named after their commander — which is what somebody who files their deck by its centrepiece
   * calls that pile — and leave the real zone in the pack. All four homebrews flow, because
   * `main` is what they are; the two real zones are the two rows below them.
   */
  it("splits on the kind and never on the heading", () => {
    const { command, flow, rail } = splitRail([
      group("Sideboard", "main"),
      group("Maybeboard", "main"),
      group("Commander", "main"),
      group("Companion", "main"),
      group("Board", "side"),
      group("Perhaps", "maybe"),
    ]);

    expect(command).toEqual([]);
    expect(names(flow)).toEqual(["Sideboard", "Maybeboard", "Commander", "Companion"]);
    expect(names(rail)).toEqual(["Board", "Perhaps"]);
  });

  /**
   * **The command zones come out as a run of their own, and this is the case that says so**
   * (changed 2026-08-20; they used to flow).
   *
   * A commander is not a card in the curve, it is the card the curve was built *around*, played
   * from a zone of its own — and the same is true of a companion. Flowing, either sat wherever
   * `sortOrder` or a derived bucket happened to put it and moved down the desk every time the
   * reader changed the grouping; handed out separately, the views draw the two stacked in one
   * column that is always in the same place.
   *
   * **The derived bucket and the `main` pile are in the list to keep this about the two kinds
   * rather than about "not `main`".** "Mana value 3" carries `kind: null` and has no rules role
   * at all, so it flows; Ramp flows because it is in the deck. This is the assertion that fails
   * if the first test ever creeps outward.
   *
   * Every group here is switched **on**, which is what makes it about the kind alone — the
   * switch's own answer for these two is the case below.
   */
  it("hands an active commander and companion out as the command run, in the order given", () => {
    const { command, flow, rail } = splitRail([
      group("Mana value 3", null),
      group("Commander", "commander"),
      group("Companion", "companion"),
      group("Ramp", "main"),
    ]);

    expect(names(command)).toEqual(["Commander", "Companion"]);
    expect(names(flow)).toEqual(["Mana value 3", "Ramp"]);
    expect(rail).toEqual([]);
  });

  /**
   * **Nothing here sorts `command`, and the input is deliberately the wrong way round to prove
   * it.**
   *
   * Commander then companion is a *deck* fact: `buildGroups` puts them in that order in all three
   * grouping modes, and this file preserves the order it is handed rather than re-deriving it. A
   * two-element swap here would be a second statement of one rule — and the second statement is
   * the one that gets edited without the first — as well as this file knowing that a commander is
   * read before a companion, which is precisely the kind of thing its whole discipline is not
   * knowing.
   *
   * So the answer to a list in the wrong order is the same list in the wrong order. **That is
   * what makes this test able to fail at all**: handed the conventional order, a sorting split
   * and a preserving split give the same answer, and the assertion checks nothing.
   */
  it("preserves the command run's given order rather than re-deriving it", () => {
    const { command } = splitRail([
      group("Companion", "companion"),
      group("Commander", "commander"),
    ]);

    expect(names(command)).toEqual(["Companion", "Commander"]);
  });

  /**
   * A switched-off pile reaches the rail, and this is the case that puts one among the derived
   * buckets.
   *
   * Under `manaValue` and `type`, `buildGroups` buckets the **active** cards that are not in a
   * command zone and then appends every inactive category *unchanged* — that is `grouping.ts`'s
   * own headline rule. So a reader who flips the Sideboard's switch and then groups by mana value
   * hands this function exactly the list below: derived headings that flow, and railed piles that
   * do not. The Maybeboard is in this list too because for that pile it is not a corner case at
   * all — it is seeded switched off, so this is the shape it arrives in almost every time.
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
    const { command, flow, rail } = splitRail([
      group("Mana value 2", null),
      group("Mana value 3", null),
      group("Sideboard", "side", false),
      group("Maybeboard", "maybe", false),
    ]);

    expect(command).toEqual([]);
    expect(names(flow)).toEqual(["Mana value 2", "Mana value 3"]);
    expect(names(rail)).toEqual(["Sideboard", "Maybeboard"]);
  });

  /**
   * **A derived grouping hands the command zones through as themselves, and that is the list this
   * split has to get right for the whole change to be worth anything.**
   *
   * Under `manaValue` and `type` there are no categories on the desk at all — every heading is a
   * bucket `buildGroups` invented — except for the piles it appends as themselves, which are now
   * two different things: the active command zones and every switched-off pile. So the list below
   * is what those two modes really produce, and the two zones arrive carrying `kind: "commander"`
   * / `"companion"` and `isActive: true`, which is exactly what the first test reads. No mode
   * check anywhere; the same two words answer in all three modes.
   *
   * **The order they arrive in is the answer**: `buildGroups` appends the command zones *first*,
   * ahead of the buckets, and they come out in that order because nothing here re-derives it.
   */
  it("takes the command zones out of a derived grouping by their two words alone", () => {
    const { command, flow, rail } = splitRail([
      group("Commander", "commander"),
      group("Companion", "companion"),
      group("Mana value 1", null),
      group("Mana value 2", null),
      group("Maybeboard", "maybe", false),
    ]);

    expect(names(command)).toEqual(["Commander", "Companion"]);
    expect(names(flow)).toEqual(["Mana value 1", "Mana value 2"]);
    expect(names(rail)).toEqual(["Maybeboard"]);
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
    const { command, flow, rail } = splitRail([
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Cut for now", "main", false),
      group("Maybeboard", "maybe", false),
    ]);

    expect(command).toEqual([]);
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
   * **A switched-off command zone rails like anything else, and is in no part of the command
   * run** — the one place the first two tests disagree about the same pile.
   *
   * `commander` and `companion` lead the answer while they are on, and the reason is an argument
   * about a pile that is *in* the deck: it is the card the deck was built around, so it earns the
   * most prominent place on the desk permanently. A switched-off command zone counts toward
   * nothing — not size, not copies, not legality — so nothing is left of that argument, and giving
   * the top of the desk to the one pile the reader has said is not playing would be the worst
   * possible reading of the switch. The `isActive &&` half of the first test is the whole of what
   * keeps this true.
   *
   * **The Sideboard is in the list to pin where they land**: it arrives *after* both zones and
   * comes out *in front of* them, because the kind test still runs before the switch test and the
   * rail's head is the two beside-the-deck piles whatever anyone's switch says.
   */
  it("rails a switched-off commander or companion, under the rail's own head", () => {
    const { command, flow, rail } = splitRail([
      group("Commander", "commander", false),
      group("Companion", "companion", false),
      group("Sideboard", "side"),
      group("Ramp", "main"),
    ]);

    expect(command).toEqual([]);
    expect(names(flow)).toEqual(["Ramp"]);
    expect(names(rail)).toEqual(["Sideboard", "Commander", "Companion"]);
  });

  /**
   * **Nothing here sorts anything**, and this is the case that says so about all three runs at
   * once.
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
   *
   * **The command zones are the third claim, and they are the two furthest apart in the input**:
   * Commander sits between Ramp and Wishboard, Companion five rows later behind the Maybeboard,
   * and they come out adjacent and in that order. Adjacency is the split's; the order inside it is
   * `buildGroups`', preserved rather than restated.
   */
  it("carries every group in the order it arrived, in all three runs, sorting nothing", () => {
    const { command, flow, rail } = splitRail([
      group("Cut for now", "main", false),
      group("Sideboard", "side"),
      group("Ramp", "main"),
      group("Commander", "commander"),
      group("Wishboard", "side"),
      group("Maybeboard", "maybe"),
      group("Companion", "companion"),
      group("Against control", "side"),
      group("Retired", "main", false),
    ]);

    expect(names(command)).toEqual(["Commander", "Companion"]);
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

  it("answers three empty runs for no groups", () => {
    expect(splitRail([])).toEqual({ command: [], flow: [], rail: [] });
  });

  /** The common deck: a commander, some piles, and nothing beside the deck at all. An empty
   *  `rail` is what tells both views to draw no rail, and a one-pile `command` run is what most
   *  Commander decks hand them — a companion is the rare second card, not the ordinary case, so
   *  the stacked column has to read right holding one pile. */
  it("answers an empty rail, and a command run of one, for a deck with neither pile", () => {
    const { command, flow, rail } = splitRail([
      group("Commander", "commander"),
      group("Ramp", "main"),
    ]);

    expect(names(command)).toEqual(["Commander"]);
    expect(names(flow)).toEqual(["Ramp"]);
    expect(rail).toEqual([]);
  });
});
