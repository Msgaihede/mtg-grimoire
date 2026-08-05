import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { card, resetRowIds } from "./validation/fixtures";
import { groupCards, ZONE_LABEL, ZoneColumn } from "./ZoneColumn";

/** Every callback the column reports through, so a test only names the one it is about. */
function handlers() {
  return {
    onOpenMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    onSetQuantity: vi.fn(),
    onMove: vi.fn(),
    onSetCover: vi.fn(),
    onSelect: vi.fn(),
  };
}

function draw(cards: DeckCard[], overrides: Partial<Parameters<typeof ZoneColumn>[0]> = {}) {
  const spies = handlers();
  const props = {
    zone: "main" as const,
    title: ZONE_LABEL.main,
    cards,
    groupBy: null,
    moveTargets: ["side", "maybe"] as const,
    openMenuCardId: null,
    busy: false,
    ...spies,
    ...overrides,
  };
  const view = render(<ZoneColumn {...props} />);
  return { ...spies, ...view, props };
}

beforeEach(() => {
  resetRowIds();
});

describe("groupCards", () => {
  /**
   * The eight printed types in the order they are printed on a card, and the ninth bucket
   * that is not a type: `Other` is where a token, a scheme or a row whose printing has left
   * the card database lands, and it sorts last because it is a remainder rather than a kind.
   */
  it("buckets by the printed types, in printed order, dropping the empty ones", () => {
    const groups = groupCards(
      [
        card({ name: "Wastes", typeLine: "Basic Land" }),
        card({ name: "Bolt", typeLine: "Instant" }),
        card({ name: "Bear", typeLine: "Creature — Bear" }),
        card({ name: "Relic", typeLine: "Artifact" }),
      ],
      "type",
    );

    expect(groups.map((g) => g.label)).toEqual(["Creature", "Instant", "Artifact", "Land"]);
  });

  /** A card with two types is filed under the first one printed order names — an Artifact
   *  Creature is a creature to everyone who has ever built a deck. */
  it("files a card with two types under the earlier of them", () => {
    const groups = groupCards(
      [card({ name: "Golem", typeLine: "Artifact Creature — Golem" })],
      "type",
    );

    expect(groups.map((g) => g.label)).toEqual(["Creature"]);
  });

  /** A double-faced card is what its front says it is: the back of a werewolf is still a
   *  creature, but the back of an adventure or a modal DFC often is not. */
  it("reads the front face's type line and nothing after the slashes", () => {
    const groups = groupCards(
      [card({ name: "Trap", typeLine: "Land // Instant — Adventure" })],
      "type",
    );

    expect(groups.map((g) => g.label)).toEqual(["Land"]);
  });

  /** The orphan case: `deck_cards LEFT JOIN cards` answers a row with nulls, and it is still
   *  a card in the deck. It is listed rather than dropped. */
  it("puts a row with no type line in Other, last", () => {
    const groups = groupCards(
      [card({ name: "Ghost", typeLine: null }), card({ name: "Bolt", typeLine: "Instant" })],
      "type",
    );

    expect(groups.map((g) => g.label)).toEqual(["Instant", "Other"]);
  });

  /** A count on a deck is copies, never rows — four Bolts are four cards. */
  it("counts copies rather than rows", () => {
    const groups = groupCards(
      [
        card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
        card({ name: "Bolt2", typeLine: "Instant", quantity: 2 }),
      ],
      "type",
    );

    expect(groups[0].count).toBe(6);
    expect(groups[0].cards).toHaveLength(2);
  });

  /** The filter chips' own bucketing, so one number means one thing across the app: 0–7 are
   *  exact and 8 is open-ended. */
  it("buckets by mana value, 0 through 7 exactly and 8 or more together", () => {
    const groups = groupCards(
      [
        card({ name: "Bolt", cmc: 1 }),
        card({ name: "Emrakul", cmc: 15 }),
        card({ name: "Ulamog", cmc: 8 }),
        card({ name: "Lotus", cmc: 0 }),
      ],
      "manaValue",
    );

    expect(groups.map((g) => g.label)).toEqual([
      "Mana value 0",
      "Mana value 1",
      "Mana value 8 or more",
    ]);
    expect(groups[2].cards.map((c) => c.name)).toEqual(["Emrakul", "Ulamog"]);
  });

  /**
   * `cmc` is nullable, and null means *unknown* rather than zero — a row whose printing has
   * left the card database has no mana value, and filing it under 0 would be a number this
   * app made up.
   */
  it("keeps a row with no mana value out of the zero bucket", () => {
    const groups = groupCards([card({ name: "Ghost", cmc: null }), card({ cmc: 0 })], "manaValue");

    expect(groups.map((g) => g.label)).toEqual(["Mana value 0", "Mana value unknown"]);
  });
});

describe("ZoneColumn", () => {
  /** The row is what the reader edits: a count they can change, a name they can open, and
   *  the printing's own data underneath in the data face. */
  it("draws a row as its count, name, cost, printing and price", () => {
    draw([card({ name: "Lightning Bolt", quantity: 4, unitPriceUsd: 4.5 })]);

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Copies of Lightning Bolt in Main deck")).toHaveValue(4);
    expect(screen.getByText("LEA · 161")).toBeInTheDocument();
    expect(screen.getByText("$4.50")).toBeInTheDocument();
  });

  /** The zone's own caption: what it is, and how many cards are in it. */
  it("names itself and counts its copies", () => {
    draw([card({ quantity: 4 }), card({ name: "Bear", quantity: 2 })]);

    expect(screen.getByRole("region", { name: "Main deck, 6 cards" })).toBeInTheDocument();
  });

  /**
   * The mark that only appears when something is wrong: the deck wants four and three are in
   * the binder. Fully owned prints nothing at all — absence is the healthy state, and a badge
   * on every row would be noise on the sixty that are fine.
   */
  it("marks a row the collection is short of, and says nothing when it is not", () => {
    draw([
      card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 3 }),
      card({ name: "Bear", quantity: 2, ownedQuantity: 2 }),
    ]);

    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(screen.queryByText("2/2")).not.toBeInTheDocument();
  });

  /**
   * The scratchpad's exception, and it is in the data rather than in the design: the
   * allocator never claims a copy for `maybe`, so every row there reads 0 owned — a mark
   * would report a shortage the reader does not have.
   */
  it("never marks a maybe row as short, because nothing is ever claimed for it", () => {
    draw([card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 0, zone: "maybe" })], {
      zone: "maybe",
      title: ZONE_LABEL.maybe,
    });

    expect(screen.queryByText("0/4")).not.toBeInTheDocument();
  });

  /** Grouping is what turns a list of sixty into a deck you can read. */
  it("draws group headers with their counts when it is asked to group", () => {
    draw(
      [
        card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
        card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 }),
      ],
      { groupBy: "type" },
    );

    const creatures = screen.getByRole("list", { name: "Creature" });
    expect(within(creatures).getByRole("button", { name: "Bear" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Instant" })).toBeInTheDocument();
    // The header carries the copies, in the data face.
    expect(screen.getByText("Instant").parentElement).toHaveTextContent("Instant4");
  });

  /** Zero is how a card leaves a deck: `deck_cards` keeps no emptied rows (the wishlist's
   *  asymmetry, not the collection's). */
  it("reports a step down to zero like any other quantity", async () => {
    const { onSetQuantity } = draw([card({ name: "Lightning Bolt", quantity: 1 })]);

    await userEvent.click(screen.getByRole("button", { name: /decrease copies of lightning bolt/i }));

    expect(onSetQuantity).toHaveBeenCalledWith(expect.objectContaining({ name: "Lightning Bolt" }), 0);
  });

  /**
   * A click on the row's background focuses nothing — and the detail pane hands the caret
   * back to whatever had it when the pane opened. So the row takes the caret itself, or every
   * card opened from a row is a card whose Escape drops focus onto `<body>`.
   */
  it("takes the caret onto the row it opened a card from", async () => {
    draw([card({ name: "Lightning Bolt" })]);

    await userEvent.click(screen.getByText("LEA · 161"));

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveFocus();
  });

  /** The row opens the card; the controls on it do their own job and nothing else. */
  it("opens the card from the row, and not from the stepper", async () => {
    const { onSelect } = draw([card({ name: "Lightning Bolt" })]);

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
    expect(onSelect).toHaveBeenCalledWith("c-Lightning Bolt");

    onSelect.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /increase copies/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  /**
   * A row whose printing has left the card database still says what it is — the name, the set
   * and the number were copied onto it at write time — and it says what happened in the
   * reconciler's own sentence.
   */
  it("lists an orphaned row from what it carries, with the sentence that flagged it", () => {
    const { container } = draw([
      card({
        name: "Lightning Bolt",
        needsReview: "This printing left the card database in the last sync.",
        typeLine: null,
        manaCost: null,
      }),
    ]);

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByText(/left the card database/)).toBeInTheDocument();
    // Nothing tries to draw a picture of a card that is not there.
    expect(container.querySelector("img")).toBeNull();
  });

  /** The click path `deck_move_card` needs, and the one drag is built on top of in Task 14. */
  it("moves a card to another zone from the row's own menu", async () => {
    const { onMove, rerender, props } = draw([card({ name: "Lightning Bolt" })]);

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    expect(props.onOpenMenu).toHaveBeenCalled();

    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);
    await userEvent.click(screen.getByRole("button", { name: "Move to Sideboard" }));

    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ name: "Lightning Bolt" }), "side");
  });

  /** The menu is anchored inside the row, and a press in it is a press on the row unless it is
   *  stopped — "move to the sideboard" is not a request to open the card. */
  it("does not open the card when the menu is used", async () => {
    const { onSelect, rerender, props } = draw([card({ name: "Lightning Bolt" })]);

    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);
    await userEvent.click(screen.getByRole("button", { name: "Move to Sideboard" }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  /** The cheap cover picker: a deck is remembered by its art, and the art is one of its own
   *  cards. */
  it("sets the deck's cover from the row's menu", async () => {
    const { onSetCover, rerender, props } = draw([card({ name: "Lightning Bolt" })]);

    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);
    await userEvent.click(screen.getByRole("button", { name: "Set as cover" }));

    expect(onSetCover).toHaveBeenCalledWith(expect.objectContaining({ name: "Lightning Bolt" }));
  });

  /** A cover is art, and an orphan has none: `cards` has no row for it, so the gallery would
   *  draw an empty frame with no illustrator to credit. Not offered. */
  it("does not offer an orphaned row as a cover", async () => {
    const { rerender, props } = draw([
      card({ name: "Lightning Bolt", needsReview: "This printing left the card database." }),
    ]);

    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);

    expect(screen.queryByRole("button", { name: "Set as cover" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to Sideboard" })).toBeInTheDocument();
  });

  /**
   * The binding pattern from Task 11, on the layer this task adds.
   *
   * Every control in the menu disables itself while the write it started is in flight, and a
   * browser blurs a disabled control **with no `relatedTarget` at all** — which the
   * click-away handler reads as the reader leaving. Without the guard the menu closes as if
   * the write had worked, and a refusal arrives over a question that is no longer on screen.
   * jsdom does not blur a control that becomes disabled, so the event is dispatched here
   * directly; delivered any other way this test passes over a missing guard.
   */
  it("keeps the menu open while a write it started is in flight", () => {
    const { rerender, props } = draw([card({ name: "Lightning Bolt" })]);
    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" busy />);
    const menu = screen.getByRole("dialog", { name: /lightning bolt/i });

    fireEvent.focusOut(menu, { relatedTarget: null });

    expect(props.onCloseMenu).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
  });

  /** And the other half of the same rule: with nothing in flight, looking away closes it. */
  it("closes the menu when focus leaves it and nothing is being written", () => {
    const { rerender, props } = draw([card({ name: "Lightning Bolt" })]);
    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);

    fireEvent.focusOut(screen.getByRole("dialog", { name: /lightning bolt/i }), {
      relatedTarget: null,
    });

    expect(props.onCloseMenu).toHaveBeenCalled();
  });

  /** An empty zone says it is empty rather than leaving a blank panel that reads as a fault. */
  it("says when a zone has nothing in it", () => {
    draw([]);

    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });
});
