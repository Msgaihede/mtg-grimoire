import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { startDrag } from "@/test-drag";
import { deckCardSlot, DECK_CARD_ATTR } from "./dnd";
import { DROP_LINE_ATTR } from "./DropIndicator";
import { card, resetRowIds } from "./validation/fixtures";
import { groupCards, shouldFlipUp, ZoneColumn } from "./ZoneColumn";

/**
 * One of the deck's categories, as `deck_get` answers it.
 *
 * Local rather than borrowed: `validation/fixtures` builds deck *rows* and knows nothing about
 * the piles they sit in, and `.storybook/fake/fixtures.ts` is the Storybook fake's. Three
 * fields decide everything this column does with a category — the `id` every write is
 * addressed by, the `name` it is announced by, and `isActive`, which decides whether a
 * shortage is a shortage — and the rest are what a freshly seeded row carries.
 */
function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: 4,
    name: "Main deck",
    kind: "main",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPriceUsd: null,
    ...over,
  };
}

/**
 * The three piles these tests move cards between, named as `schema::PREDEFINED_CATEGORIES`
 * names them — the Maybeboard included, which is seeded **off** and is the one category whose
 * default says something.
 */
const MAIN = category();
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 1 });
const MAYBE = category({ id: 5, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 4 });

/** Every callback the column reports through, so a test only names the one it is about. */
function handlers() {
  return {
    onOpenMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    onSetQuantity: vi.fn(),
    onMove: vi.fn(),
    onSetCover: vi.fn(),
    onSelect: vi.fn(),
    onDropCard: vi.fn(),
  };
}

function draw(cards: DeckCard[], overrides: Partial<Parameters<typeof ZoneColumn>[0]> = {}) {
  const spies = handlers();
  const props = {
    category: MAIN,
    cards,
    groupBy: null,
    moveTargets: [SIDE, MAYBE],
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

/**
 * The flip is arithmetic on purpose: jsdom lays nothing out, so every rectangle a component
 * test could read is zero and a test of the rendered menu would pass over any decision at all.
 * The column's scroller clips, and there is nothing under it to scroll to.
 */
describe("shouldFlipUp", () => {
  /** A row at the top of a column: the menu fits below it, so it opens where the reader is
   *  looking. */
  it("opens downwards while there is room", () => {
    expect(
      shouldFlipUp({ rowTop: 100, rowBottom: 140, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(false);
  });

  /** A row near the foot of the column: opening down would put half the menu past the
   *  scroller's edge. */
  it("opens upwards when the menu would run out of the bottom", () => {
    expect(
      shouldFlipUp({ rowTop: 520, rowBottom: 560, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(true);
  });

  /** A menu taller than the column it is in fits neither way, so it opens the way it reads —
   *  flipping would move it without gaining anything. */
  it("stays downwards when neither direction fits", () => {
    expect(
      shouldFlipUp({ rowTop: 150, rowBottom: 190, menuHeight: 300, viewTop: 100, viewBottom: 260 }),
    ).toBe(false);
  });

  /** Exactly enough room is room. */
  it("does not flip on a menu that fits to the pixel", () => {
    expect(
      shouldFlipUp({ rowTop: 460, rowBottom: 500, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(false);
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

  /** The category's own caption: what it is called, and how many cards are in it. */
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
   * The switched-off exception, and it is in the data rather than in the design: the allocator
   * claims no copy for an inactive category, so every row in one reads 0 owned — a mark would
   * report a shortage the reader does not have.
   */
  it("never marks a row in a switched-off category as short, because nothing is claimed for one", () => {
    draw([card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 0, categoryKind: "maybe" })], {
      category: MAYBE,
    });

    expect(screen.queryByText("0/4")).not.toBeInTheDocument();
  });

  /**
   * And the other half of what schema v7 changed: the **switch** decides this, never the kind.
   *
   * A Maybeboard the reader turned on counts like any other pile — the allocator claims copies
   * for it and a shortage in it is a real shortage — so a column that read
   * `categoryKind === "maybe"` would answer this row backwards while passing the test above.
   */
  it("marks a row in a switched-on Maybeboard exactly like any other", () => {
    draw([card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 1, categoryKind: "maybe" })], {
      category: category({ ...MAYBE, isActive: true }),
    });

    expect(screen.getByText("1/4")).toBeInTheDocument();
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

    await userEvent.click(
      screen.getByRole("button", { name: /decrease copies of lightning bolt/i }),
    );

    expect(onSetQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Lightning Bolt" }),
      0,
    );
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

  /**
   * **And the caret can be handed back to this row after the row is gone.**
   *
   * The other half of the hand-back above, for the case the stashed element cannot answer: a
   * swap deletes the row the pane was opened from — the new printing's row is a different React
   * key — so the pane finds the *slot* instead, `document.querySelector` over the attribute
   * every deck control draws (`CardDetailPane`'s `deckControlFor`, `dnd.ts`'s
   * {@link deckCardSlot}). `App.test.tsx` exercises the whole hand-back end to end; this pin
   * is what lets that test name the mechanism — delete the attribute and both fail.
   */
  it("marks the row with the slot the card pane hands the caret back to", () => {
    const row = card({ name: "Lightning Bolt" });
    draw([row]);

    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toHaveAttribute(
      DECK_CARD_ATTR,
      deckCardSlot(MAIN.id, row.cardId),
    );
  });

  /**
   * The row opens the card; the controls on it do their own job and nothing else.
   *
   * **With the category it was opened from**, which is not decoration: the pane the click opens
   * offers to swap this row's printing, and a swap is addressed by the slot — deck, category,
   * printing. The same card sits in the main deck and the sideboard often enough that the
   * column has to say which one the reader pressed.
   */
  it("opens the card from the row, and not from the stepper", async () => {
    const { onSelect } = draw([card({ name: "Lightning Bolt" })]);

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));
    expect(onSelect).toHaveBeenCalledWith("c-Lightning Bolt", MAIN.id);

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

  /**
   * The thumbnail is the `art` crop, drawn as decoration: the name is the row's text and the
   * picture repeats it, so it hides from the accessibility tree and carries no alt of its
   * own. `draggable={false}` is load-bearing — the row is the drag source, and a browser
   * would otherwise offer the picture itself as the thing being dragged.
   */
  it("draws the row's art crop as decoration the drag cannot pick up", () => {
    const { container } = draw([card({ name: "Lightning Bolt" })]);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", expect.stringContaining("/art/"));
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("draggable", "false");
    expect(img?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  /** The click path `deck_move_card` needs, and the one drag is built on top of in Task 14 —
   *  which is why the menu reports the target's **id** and draws its name. */
  it("moves a card to another category from the row's own menu", async () => {
    const { onMove, rerender, props } = draw([card({ name: "Lightning Bolt" })]);

    await userEvent.click(screen.getByRole("button", { name: "More actions for Lightning Bolt" }));
    expect(props.onOpenMenu).toHaveBeenCalled();

    rerender(<ZoneColumn {...props} openMenuCardId="c-Lightning Bolt" />);
    await userEvent.click(screen.getByRole("button", { name: "Move to Sideboard" }));

    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Lightning Bolt" }),
      SIDE.id,
    );
  });

  /** A column never offers itself: "Move to Main deck" from the main deck is a no-op wearing a
   *  verb, and the editor hands down every category rather than remembering to leave one out. */
  it("leaves its own category out of the move targets", () => {
    const { rerender, props } = draw([card({ name: "Lightning Bolt" })]);

    rerender(
      <ZoneColumn {...props} moveTargets={[MAIN, SIDE]} openMenuCardId="c-Lightning Bolt" />,
    );

    expect(screen.getByRole("button", { name: "Move to Sideboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to Main deck" })).not.toBeInTheDocument();
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

  /** An empty category says it is empty rather than leaving a blank panel that reads as a
   *  fault. */
  it("says when a category has nothing in it", () => {
    draw([]);

    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });
});

/**
 * The column as one end of a drag: what it accepts, what it refuses, and what it says while
 * a card is in the air over it.
 *
 * These drive the drag library's own code path — real `dragstart`, `dragenter`, `dragover`
 * and `drop` events at the real registrations (`src/test-drag.ts` explains why that works in
 * jsdom and what it still cannot reach). The *editor's* end of the same wiring — which write
 * each drop becomes, and the remove tray — is `DeckEditor.test.tsx`.
 */
describe("ZoneColumn drops", () => {
  /** The attribute a column marks its own scroller with. Duplicated from `ZoneColumn` rather
   *  than exported for a test: it is the drop target, and a test that dropped somewhere else
   *  would pass without ever reaching one. */
  const SCROLLER = "[data-zone-scroller]";

  /**
   * Two columns, because a move needs both ends: a row is dragged out of one category and into
   * another, and the column that takes it is not the column that had it.
   */
  function drawPair(cards: DeckCard[]) {
    const main = handlers();
    const side = handlers();
    const common = {
      groupBy: null,
      moveTargets: [MAIN, SIDE],
      openMenuCardId: null,
      busy: false,
    };
    render(
      <>
        <ZoneColumn category={MAIN} cards={cards} {...common} {...main} />
        <ZoneColumn category={SIDE} cards={[]} {...common} {...side} />
      </>,
    );
    const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });
    return {
      main,
      side,
      column,
      scroller: (name: string) => column(name).querySelector(SCROLLER)!,
      line: (name: string) => column(name).querySelector(`[${DROP_LINE_ATTR}]`),
    };
  }

  /**
   * Anything else in the window that can be dragged — the app's next feature, standing in for
   * itself.
   *
   * Torn down in an `afterEach` rather than at the end of the test that made it: it is not
   * part of a render, and a failed assertion half way through would otherwise leave a
   * registered draggable in the document for every later test in this file.
   */
  let registered: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of registered) cleanup();
    registered = [];
  });

  function elsewhere(data: Record<string, unknown>): HTMLElement {
    const element = document.createElement("div");
    document.body.append(element);
    const unregister = draggable({ element, getInitialData: () => data });
    registered.push(() => {
      unregister();
      element.remove();
    });
    return element;
  }

  /** A row dropped on another column is a move, and the column names the write itself: it is
   *  what knows which category it is. */
  it("takes a row dragged out of another category", async () => {
    const { main, side, scroller } = drawPair([card({ name: "Lightning Bolt" })]);

    const held = await startDrag(screen.getByRole("listitem"));
    await held.over(scroller("Sideboard"));
    await held.drop();

    expect(side.onDropCard).toHaveBeenCalledWith({
      write: "move",
      cardId: "c-Lightning Bolt",
      from: MAIN.id,
      to: SIDE.id,
    });
    // The category the card left hears nothing: a drop happens in one place.
    expect(main.onDropCard).not.toHaveBeenCalled();
  });

  /** The line is the whole of the promise: it says *this* column, on the column that would
   *  take the card, and it is gone the moment the card is somewhere else. */
  it("draws the drop line on the column that would take the card, and nowhere else", async () => {
    const { line, scroller } = drawPair([card({ name: "Lightning Bolt" })]);

    const held = await startDrag(screen.getByRole("listitem"));
    await held.over(scroller("Sideboard"));

    expect(line("Sideboard")).toBeInTheDocument();
    expect(line("Main deck")).toBeNull();

    await held.leave();
    expect(line("Sideboard")).toBeNull();

    await held.cancel();
  });

  /**
   * A row dropped back where it came from is not a write, and the column says so before the
   * reader lets go: no line, and nothing to undo.
   *
   * `deck_move_card` from a category to itself would touch the deck, reallocate and bump
   * `updated_at` to leave the list exactly as it was.
   */
  it("does not offer itself to a row it already holds", async () => {
    const { main, line, scroller } = drawPair([card({ name: "Lightning Bolt" })]);

    // Out to the sideboard and back again, which is a reader changing their mind — and the
    // only way to ask this column the question, since a card that never left it was never
    // over anything else either.
    const held = await startDrag(screen.getByRole("listitem"));
    await held.over(scroller("Sideboard"));
    await held.over(scroller("Main deck"));

    expect(line("Main deck")).toBeNull();
    expect(line("Sideboard")).toBeNull();

    await held.drop();
    expect(main.onDropCard).not.toHaveBeenCalled();
  });

  /**
   * A drag from somewhere else in the app is inert here — no line, no write — even when what
   * it carries is shaped exactly like a card.
   *
   * This is the mark in `dnd.ts` doing the only job it has. The payload below is a deck
   * drag's in every field; the one thing it is missing is the one thing that is checked.
   */
  it("ignores a drag that is not a deck drag's", async () => {
    const { side, line, scroller } = drawPair([]);
    const other = elsewhere({
      kind: "deck-card",
      cardId: "c-Lightning Bolt",
      name: "Lightning Bolt",
      fromCategoryId: MAIN.id,
    });

    const held = await startDrag(other);
    await held.over(scroller("Sideboard"));

    expect(line("Sideboard")).toBeNull();

    await held.drop();
    expect(side.onDropCard).not.toHaveBeenCalled();
  });

  /**
   * **A press on one of the row's own controls is not a drag of the row.**
   *
   * The whole row is draggable and the row is full of controls, so this is the failure that
   * costs a reader a deck: Chromium starts a drag from the nearest draggable *ancestor* of
   * whatever was pressed, and the drag library excludes nothing of its own. Measured in the
   * running window before the guard existed (2026-08-05): `mousedown` on a stepper's `−` plus
   * five pixels of travel dragged the row, the press was never delivered as a click, and
   * letting go over another column moved all four copies.
   *
   * The guard is `cardDraggable`'s, and what it reads is where the *press* landed — which is
   * why this test presses one place and drags from another, exactly as the platform does.
   */
  it("does not drag the row when the press landed on one of its controls", async () => {
    const { main, side, line, scroller } = drawPair([card({ name: "Lightning Bolt" })]);
    const row = screen.getByRole("listitem");

    const held = await startDrag(row, {
      pressOn: screen.getByRole("button", { name: /decrease copies/i }),
    });

    expect(held.started).toBe(false);

    await held.over(scroller("Sideboard"));
    expect(line("Sideboard")).toBeNull();

    await held.drop();
    expect(side.onDropCard).not.toHaveBeenCalled();
    expect(main.onDropCard).not.toHaveBeenCalled();
  });

  /** And the row itself still is one: the guard is a control's press, not a row's. */
  it("still drags the row when the press landed on the row", async () => {
    const { side, scroller } = drawPair([card({ name: "Lightning Bolt" })]);
    const row = screen.getByRole("listitem");

    const held = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(held.started).toBe(true);

    await held.over(scroller("Sideboard"));
    await held.drop();

    expect(side.onDropCard).toHaveBeenCalledWith(
      expect.objectContaining({ write: "move", to: SIDE.id }),
    );
  });

  /**
   * Letting go of a cancelled drag *over* a column, rather than after wandering off it: the
   * library clears its drop targets before it finishes, so the line comes down on the way out
   * and nothing is written on the way past.
   */
  it("writes nothing when a drag is cancelled over a column", async () => {
    const { side, line, scroller } = drawPair([card({ name: "Lightning Bolt" })]);

    const held = await startDrag(screen.getByRole("listitem"));
    await held.over(scroller("Sideboard"));
    expect(line("Sideboard")).toBeInTheDocument();

    await held.cancel();

    expect(line("Sideboard")).toBeNull();
    expect(side.onDropCard).not.toHaveBeenCalled();
  });
});
