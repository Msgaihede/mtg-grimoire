import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  DEFAULT_SECTION_ZOOMS,
  DEFAULT_ZOOM,
  MIN_ZOOM,
  scaled,
  ZOOM_SECTIONS,
  ZOOM_STEPS,
} from "@/lib/cardZoom";
import { DROP_MARK_ROOM } from "@/lib/dropMarks";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { MARKETPLACES, type Marketplace } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { dragOnto } from "@/test-drag";
import { card } from "../validation/fixtures";
import type { ValidationIssue } from "../validation/types";
import { stackCardWidth } from "../CardStack";
import {
  CARD_BODY_ATTR,
  DECK_GROUP_ATTR,
  LANDED_ATTR,
  SELECTED_ATTR,
  type DeckCardActions,
} from "../cardControl";
import { deckCardSlot, DECK_CARD_ATTR } from "../dnd";
import { buildGroups, type CardGroup } from "../grouping";
import { RAIL_ATTR } from "./columns";
import { GridView } from "./GridView";
import { flowRowSpan, StackView, STACK_ATTR, stackColumnWidth } from "./StackView";
import { TableView } from "./TableView";
import { TextView } from "./TextView";

/**
 * jsdom lays nothing out, so `@tanstack/react-virtual` computes an empty window and the table
 * renders no rows at all. One number is the whole of what it is missing; the same stub
 * `VirtualTable.test.tsx` and the story runner use, for the same reason.
 *
 * The viewport it fakes is a number and not this app's window, so every assertion below names
 * a row rather than counting them.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

/**
 * Size the cards on the **deck desk**, and leave every other section where it was.
 *
 * `cardZoom` is a number per card section rather than one for the app, so a bare
 * `setState({ cardZoom: 2 })` no longer type-checks and — worse if it did — would be a claim
 * about four surfaces when the two views here are one of them. Written whole from
 * {@link DEFAULT_SECTION_ZOOMS} rather than spread off the live state, so a case that runs after
 * one which zoomed the search column starts from the same place either way.
 */
function setDeckZoom(zoom: number) {
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, deck: zoom } });
}

/**
 * Every section back to 100%, and the pulse with them.
 *
 * The store outlives a test — it is a module singleton — so a case that leaves the desk at 2×
 * silently re-packs every suite that runs after it. `zoomPulse`/`zoomSection` are reset here
 * because the gesture case below writes them and the badge's own suite reads them.
 *
 * Spread into a **copy**, the way {@link setDeckZoom} above and `store.ts`'s own initialiser
 * spread it: `Readonly<>` is a compile-time fence and nothing more, so state holding the exported
 * object itself would let one in-place write corrupt the module constant every other suite in this
 * process resets from — and the failure would surface as an unrelated file going red much later.
 * Nothing writes in place today, because `zoomCards` is the single writer and it spreads; the
 * spelling is kept identical everywhere so that stays the obvious thing to do.
 */
function resetZoom() {
  useAppStore.setState({
    cardZoom: { ...DEFAULT_SECTION_ZOOMS },
    zoomPulse: 0,
    zoomSection: null,
  });
}

function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: 1,
    name: "Ramp",
    kind: "main",
    isActive: true,
    sortOrder: 1,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: over.cardCount ?? 0,
    // A pile the reader made, unless a fixture says otherwise — and the default matters here in
    // a way it does not in most files: `buildGroups` drops an **empty** `origin: "auto"` pile,
    // so a fixture that drifted to `"auto"` would silently take a group out of every column
    // count below. `DRAW` is the one to watch; see its own note.
    origin: "user",
    ...over,
  };
}

const RAMP = category();
const COMMANDER = category({ id: 3, name: "Commander", kind: "commander", sortOrder: 0 });
/** A seeded zone, used as the deck that is one empty pile and nothing else. A fixed zone is the
 *  pile that reaches a view empty under *every* answer `drawsWhenEmpty` has given — the Sideboard
 *  draws empty whatever the format wants and whoever made it — so it is the fixture that keeps
 *  saying what this case is about however that rule is tuned. (It once had a second reason: while
 *  a filter narrowed a deck only the fixed zones survived it. That knob is gone — what a filter
 *  empties now is auto piles, because an empty auto pile is never drawn — and this fixture is
 *  unaffected either way, which is the property it was chosen for.) */
const SIDEBOARD = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 2 });
/**
 * The other pile the rail exists for, and it is seeded **switched off** — `fixtures.ts` mirrors
 * `schema::PREDEFINED_CATEGORIES`, where the Maybeboard is the one predefined category born
 * inactive. So a rail holding it routinely holds a dimmed pile, and the views need no code for
 * that: a group in the rail is the same `StackGroup`/`TextGroup` as one in the flow.
 */
const MAYBE = category({
  id: 5,
  name: "Maybeboard",
  kind: "maybe",
  isActive: false,
  sortOrder: 4,
});
/**
 * The pile the rail was built for first.
 *
 * Added beside the three above rather than folded into one of them: every count and every
 * order asserted in this file is a claim about that fixture, and a fourth category in `GROUPS`
 * would have rewritten all of them.
 *
 * `sortOrder` 2 puts it **between** Ramp and the Maybeboard, which is exactly where a greedy
 * in-order pack used to leave it — the middle of a sideways run — and is what lets a test show
 * the rail drawing it past a pile that comes after it. It is also what makes the rail's own order
 * a claim worth asserting: Sideboard above Maybeboard is these two `sortOrder`s and nothing in
 * `splitRail`. The **id** is the only one here that is load-bearing: it is `fixtures.ts`'s own for
 * a `side` card, so `card({ categoryKind: "side" })` lands in this category rather than arriving
 * as a stray group.
 */
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 2 });
/**
 * An empty pile of the reader's own, and the packing cases' third group.
 *
 * That part used to be the Maybeboard's, which is exactly what this change took away: the
 * Maybeboard is railed now, so a fixture that packed it was asserting the pack against a group
 * the packer no longer sees. A `main` category is the honest stand-in — 66px of heading with
 * nothing under it, flowing, and drawn empty because every pile of the reader's own is a *place*
 * (`drawsWhenEmpty`).
 *
 * **It is `origin: "user"` by the factory's default, and that is the whole of why it still
 * draws.** "Draw" is one of `AUTO_CATEGORY_NAMES` — it is exactly what the app calls a pile it
 * makes while filing a card, and an empty one of those is no longer drawn at all. It is also
 * exactly what a person calls a pile of their own, which is why the rule reads provenance and
 * never the name: this fixture is a reader's pile that happens to be called Draw, it keeps its
 * heading, and if this ever becomes an auto pile every column count in this file moves.
 */
const DRAW = category({ id: 6, name: "Draw", kind: "main", sortOrder: 3 });

const CARDS: DeckCard[] = [
  card({ name: "Sol Ring", quantity: 2, unitPrice: 1.99, gameChanger: true }),
  card({
    name: "Arcane Signet",
    unitPrice: 0.99,
    tagId: 1,
    tagName: "Ramp piece",
    tagColor: "moss",
  }),
  { ...card({ name: "Serah Farron", categoryKind: "commander" }), unitPrice: 4.93 },
  {
    ...card({ name: "Avacyn", categoryKind: "maybe" }),
    quantity: 4,
    unitPrice: null,
  },
];

const BANNED: ValidationIssue = {
  severity: "error",
  code: "banned",
  message: "Sol Ring is banned here.",
  cardIds: ["c-Sol Ring"],
};

const VIOLATIONS = new Map<string, ValidationIssue[]>([["c-Sol Ring", [BANNED]]]);

const GROUPS: CardGroup[] = buildGroups(
  CARDS,
  [COMMANDER, RAMP, MAYBE],
  "category",
  "alphabetical",
);

/**
 * The default marketplace, and every dollar figure below is a claim about it.
 *
 * Named rather than repeated so the currency-switching cases stand out as the ones that mean
 * something by naming a different one — the rest of this file is about geometry, drops and
 * markers, and would only be noisier for restating a currency it is not testing.
 */
const TCG = MARKETPLACES.tcgplayer;

/** The four views, driven identically — every claim below is a claim about all of them. */
const VIEWS = [
  { name: "StackView", render: (props: ViewProps) => <StackView {...props} /> },
  { name: "TableView", render: (props: ViewProps) => <TableView {...props} /> },
  { name: "TextView", render: (props: ViewProps) => <TextView {...props} /> },
  { name: "GridView", render: (props: ViewProps) => <GridView {...props} /> },
] as const;

interface ViewProps {
  groups: readonly CardGroup[];
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** The two marks a card can carry beside its own facts — see the sweep that asserts them. */
  selectedSlot?: string | null;
  landed?: ReadonlyMap<number, number>;
}

/**
 * One printing filed in **two** piles — the shape the whole `(deck, card, category, variant)`
 * grain exists for, and the fixture the selection rule turns on.
 *
 * Kept out of {@link GROUPS} rather than folded into it, for `SIDE`'s reason: every count and
 * every order asserted in this file is a claim about that fixture, and a second Sol Ring in it
 * would have rewritten all of them.
 */
const TWO_PILES: CardGroup[] = buildGroups(
  [card({ name: "Sol Ring" }), card({ name: "Sol Ring", categoryKind: "side" })],
  [RAMP, SIDE],
  "category",
  "alphabetical",
);

describe.each(VIEWS)("$name", ({ render: renderView }) => {
  const setup = (over: Partial<ViewProps> = {}) => {
    const onSelect = vi.fn();
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        violations: VIOLATIONS,
        onSelect,
        ...over,
      }),
    );
    return onSelect;
  };

  /** The brief's own requirement, and the one thing every view owes the reader: a heading
   *  that says what the pile is, how big it is and what it costs. */
  it("heads every group with its name, its copies and its summed cost", () => {
    setup();

    for (const name of ["Commander", "Ramp", "Maybeboard"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Ramp: 2 Sol Rings at $1.99 and one Signet at $0.99 — copies, not rows.
    expect(screen.getByText("3 cards")).toBeInTheDocument();
    expect(screen.getByText("$4.97")).toBeInTheDocument();
    // The Commander pile: one card, one price, and the singular said properly.
    expect(screen.getByText("1 card")).toBeInTheDocument();
    // The Maybeboard holds four copies of one unpriced card, so it quotes no number at all.
    expect(screen.getByText("4 cards")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  /** A price is never shown without saying when it was true, and whose it is. */
  it("says when its prices were true", () => {
    setup();
    expect(screen.getAllByTitle(pricesAsOf(MARKETPLACES.tcgplayer)).length).toBeGreaterThan(0);
  });

  /**
   * **Every view, one claim: the money on screen is the selected marketplace's.**
   *
   * Written as a sweep across all four because the marketplace reaches each of them by a
   * different route — a band's heading, a stacked heading, a tight one, a table column — and a
   * view that quietly formatted in dollars would pass every other assertion in this file.
   *
   * The rows here are what a **Cardmarket** read answers: two Sol Rings at €1 and one Signet at
   * €0.50. That is the shape the whole feature turns on — a switch changes the rows, not which
   * field a cell reads — so the fixture is a different set of numbers rather than a second
   * column, and `$4.97` (what the TCGplayer rows would have summed to) is asserted absent
   * because a view that ignored its `marketplace` prop would print exactly that.
   */
  it("quotes the selected marketplace, and the previous one disappears", () => {
    const priced: DeckCard[] = [
      card({ name: "Sol Ring", quantity: 2, unitPrice: 1 }),
      card({ name: "Arcane Signet", unitPrice: 0.5 }),
    ];
    render(
      renderView({
        groups: buildGroups(priced, [RAMP], "category", "alphabetical"),
        marketplace: MARKETPLACES.cardmarket,
      }),
    );

    expect(screen.getByText("€2.50")).toBeInTheDocument();
    expect(screen.queryByText("$4.97")).not.toBeInTheDocument();
    expect(screen.getAllByTitle(pricesAsOf(MARKETPLACES.cardmarket)).length).toBeGreaterThan(0);
  });

  it("marks the piles the rules read and the piles that count toward nothing", () => {
    setup();

    // The Commander pile has a rules role; a category the reader made does not.
    expect(screen.getAllByText("RULE")).toHaveLength(1);
    expect(screen.getAllByText("INACTIVE")).toHaveLength(1);
    expect(screen.getByText("INACTIVE").getAttribute("title")).toContain("counts toward");
  });

  /**
   * **A card is something the keyboard can reach**, in every view — the claim that stands
   * behind `deckCardName`, the focus recipe and `onSelect` alike, and the one this file had no
   * assertion of anywhere.
   *
   * Reached with `user.tab()` and never with `.focus()`: placing the caret by hand would make
   * this pass on a view that had stopped drawing a control at all, which is exactly the shape
   * `CategoriesDialog.test.tsx` records as self-repairing. Tab from `<body>` walks the document
   * in order, so what it lands on is the view's own first stop.
   */
  it("puts a deck card in the tab order", async () => {
    setup();
    const user = userEvent.setup();

    // Enough presses to clear whatever a view puts in front of its first card — a table's
    // header row has none, and the wall's first stop *is* a card.
    let landed: HTMLElement | null = null;
    for (let i = 0; i < 12 && landed === null; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.closest(`[${DECK_CARD_ATTR}]`)) {
        landed = active;
      }
    }
    expect(landed).not.toBeNull();
  });

  /**
   * And a **group** is not one, in any of them.
   *
   * `deckGroupProps` gives every category `tabIndex={-1}` so the editor can hand the caret to a
   * pile after a card leaves it — a place focus can be *put*, never a stop Tab travels through.
   * A deck with fifteen piles would otherwise be fifteen extra presses on the way to the cards.
   * Asserted by walking, not by reading the attribute (which `$name editing` already does):
   * this is the consequence, and it is what a reader would notice.
   */
  it("does not make a category group a stop on the way", async () => {
    setup();
    const user = userEvent.setup();

    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      expect(active?.hasAttribute(DECK_GROUP_ATTR)).not.toBe(true);
    }
  });
});

/**
 * **The editing controls, across all four views.**
 *
 * A deck card can be stepped, picked up and dropped on, and every view owes the reader all
 * three — so this is a sweep rather than four tests. They come from one module
 * (`cardControl.tsx`) precisely so that this can be one `describe.each`: four copies would be
 * four chances for one surface to quietly stop offering something, and the failure would be a
 * reader who switched view and lost the ability to remove a card.
 *
 * It was all *four* until 2026-08-14, when the card's own `Move…` select was removed and a pile
 * became something a card is dragged into. The drag half of that is swept below and in
 * `dnd.test.ts`; what no test can assert is the affordance that went, so it is written down on
 * `DeckCardControls` instead.
 *
 * What differs between them is *placement* — the table spends them as columns, the other three
 * draw them over the card — and placement is the one thing a table and a wall of card faces
 * genuinely disagree about.
 */
describe.each(VIEWS)("$name editing", ({ render: renderView }) => {
  const actions = () => ({ setQuantity: vi.fn(), drop: vi.fn() });

  const draw = (over: Partial<DeckCardActions> = {}) => {
    const spies = { ...actions(), ...over };
    render(renderView({ groups: GROUPS, marketplace: TCG, actions: spies, onSelect: vi.fn() }));
    return spies;
  };

  /** Absolute, and zero removes — never a `−1` through the add path, which refuses the very
   *  orphans a reader most needs to be able to clear (`useDeck.ts` has the reason). */
  it("steps a card's copies, and sends the zero that removes it", async () => {
    const user = userEvent.setup();
    const spies = draw();

    await user.click(
      screen.getByRole("button", { name: "Increase Copies of Sol Ring in Main deck" }),
    );
    expect(spies.setQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sol Ring" }),
      3,
    );

    await user.click(
      screen.getByRole("button", { name: "Decrease Copies of Arcane Signet in Main deck" }),
    );
    expect(spies.setQuantity).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Arcane Signet" }),
      0,
    );
  });

  /**
   * **The move control is gone from every view, and that is asserted rather than assumed.**
   *
   * Removing it was a four-view change made in one module, so the failure it guards against is
   * the mirror of the sweep above: one surface keeping a control the other three lost, which is
   * exactly what a `<select>` left behind in a view-specific cell would be. Named by its
   * accessible name, because that is what the removal actually took away.
   */
  it("offers no move control on a card", () => {
    draw();
    expect(screen.queryByLabelText(/^Move Sol Ring/)).toBeNull();
    expect(screen.queryByRole("option", { name: "Move…" })).toBeNull();
  });

  /**
   * The control belongs to the *slot*, not to the card: the same printing sits in two piles
   * often enough that a name without the pile is two controls nothing can tell apart.
   *
   * The pile is the **card's own** `categoryName` rather than the heading above it, and the two
   * are the same fact in real data — the fixture here deliberately calls a category "Ramp"
   * while its cards denormalise "Main deck", which is what makes this assert the card's answer
   * rather than the heading's.
   */
  it("names every control by the slot it edits", () => {
    draw();
    expect(screen.getByLabelText("Copies of Serah Farron in Commander")).toBeInTheDocument();
  });

  /** A press on a control is a press, never a drag — `cardDraggable` asks `closest()`, so one
   *  mark on the wrapper covers the buttons inside it. Without it, `−` plus five pixels of
   *  travel takes every copy out of the deck with nothing to undo it. */
  it("keeps a press on a control from starting a drag", () => {
    draw();
    const stepper = screen.getByRole("button", {
      name: "Increase Copies of Sol Ring in Main deck",
    });
    expect(stepper.closest("[data-no-drag]")).not.toBeNull();
  });

  /** The caret's way home after a printing swap. The pane is not in this tree and owns none of
   *  these elements, so the slot is a question the DOM can answer after the fact. */
  it("stamps every card with the slot it draws", () => {
    render(renderView({ groups: GROUPS, marketplace: TCG }));
    const slots = [...document.querySelectorAll(`[${DECK_CARD_ATTR}]`)].map((n) =>
      n.getAttribute(DECK_CARD_ATTR),
    );
    expect(slots).toContain(deckCardSlot(RAMP.id, "c-Sol Ring"));
    // Stamped whether or not the card can be edited: opening a card from a deck is what puts
    // the swap on offer, and that is true of a view drawn read-only.
    expect(slots.length).toBe(4);
  });

  /**
   * **Which card the pane is open on, said the same way by all four.**
   *
   * The mark itself differs and has to: a ring around a card face, a lifted surface on a 22px
   * line, `VirtualTable`'s own quiet row colour. What must not differ is the answer to "which
   * one", which is why this sweeps an attribute rather than a class — a class is a recipe, and
   * a test that asserted `ring-accent` would go red the day the ring became an outline.
   *
   * **By the slot rather than by the printing**, which is the same address every deck write is
   * made to — and the same one `DECK_CARD_ATTR` already stamps, so the mark and the caret's way
   * home cannot spell "which card" two ways.
   */
  it("marks the card the pane is open on", () => {
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        selectedSlot: deckCardSlot(RAMP.id, "c-Sol Ring"),
      }),
    );

    const marked = [...document.querySelectorAll(`[${SELECTED_ATTR}]`)];
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector(`[${DECK_CARD_ATTR}]`) ?? marked[0]).toHaveAttribute(
      DECK_CARD_ATTR,
      deckCardSlot(RAMP.id, "c-Sol Ring"),
    );
  });

  /**
   * **One card at a time, and a printing in two piles is two cards.**
   *
   * The reported defect, and it was the same defect in all four views: the mark was keyed on
   * `cardId` alone, so clicking a card the deck holds in both the Main deck and the Sideboard
   * marked *both* copies — and in `StackView`, where the mark is also what the pile rests open
   * on, stood a card clear of two stacks from one click. A `deck_cards` row is
   * `(deck, card, category, variant)`; the click names one row, so the mark does too.
   *
   * The count is the claim: `TWO_PILES` holds exactly one printing, twice, so a rule that keyed
   * on the printing answers 2 here and can answer nothing else.
   */
  it("marks one pile's copy when the same printing is filed in two", () => {
    render(
      renderView({
        groups: TWO_PILES,
        marketplace: TCG,
        selectedSlot: deckCardSlot(SIDE.id, "c-Sol Ring"),
      }),
    );

    const marked = [...document.querySelectorAll(`[${SELECTED_ATTR}]`)];
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector(`[${DECK_CARD_ATTR}]`) ?? marked[0]).toHaveAttribute(
      DECK_CARD_ATTR,
      deckCardSlot(SIDE.id, "c-Sol Ring"),
    );
  });

  /**
   * The other half of the same rule: a printing this deck *does* hold, picked in a pile it is
   * not in, marks nothing. A `cardId` key could not tell this case from the one above — both are
   * "the deck holds Sol Ring" — which is why the slot is what travels.
   */
  it("marks nothing when the picked slot names a pile the card is not in", () => {
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        selectedSlot: deckCardSlot(SIDE.id, "c-Sol Ring"),
      }),
    );

    expect(document.querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(0);
  });

  it("marks nothing when the pane is open on a card this deck does not hold", () => {
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        selectedSlot: deckCardSlot(RAMP.id, "c-Black Lotus"),
      }),
    );

    expect(document.querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(0);
  });

  /**
   * **Where the card landed, for the five seconds after it did.**
   *
   * Keyed by `deck_cards.id` rather than by the printing, which is the difference that matters:
   * `deck_add_card` folds, so what the reader wants pointed at is the *row* the write landed in
   * — one pile, not every pile holding that card.
   */
  it("marks a card that has just landed", () => {
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        landed: new Map([[CARDS[0].id, 1]]),
      }),
    );

    const marks = [...document.querySelectorAll(`[${LANDED_ATTR}]`)];
    expect(marks).toHaveLength(1);
    expect(marks[0].closest(`[${CARD_BODY_ATTR}], [role="row"]`)).not.toBeNull();
  });

  it("marks nothing when nothing has landed", () => {
    draw();
    expect(document.querySelectorAll(`[${LANDED_ATTR}]`)).toHaveLength(0);
  });

  /** Where the caret goes when a card leaves a pile under it. Only a *category* group is a
   *  place — a derived heading is a heading and no more. */
  it("makes every category group a place the caret can be put", () => {
    draw();
    for (const id of [RAMP.id, COMMANDER.id, MAYBE.id]) {
      const group = document.querySelector(`[${DECK_GROUP_ATTR}="${id}"]`);
      expect(group).not.toBeNull();
      expect(group).toHaveAttribute("tabindex", "-1");
    }
  });

  /**
   * **The pile you let go over is the one that takes the card.** A single target over the whole
   * view would land every drop in whatever the deck's default category happened to be, which is
   * a silent difference between the drag and the button beside it.
   */
  it("takes a dropped card into the group it was dropped on", async () => {
    const spies = draw();
    const target = document.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${MAYBE.id}"]`)!;
    // The drag handle is the whole card: an `<li>` in the three card views, and the row itself
    // in the table. Both carry the slot, so the slot is how one is found either way.
    const marked = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(RAMP.id, "c-Sol Ring")}"]`,
    )!;

    await dragOnto(marked.closest("li") ?? marked, target);

    expect(spies.drop).toHaveBeenCalledWith({
      write: "move",
      cardId: "c-Sol Ring",
      from: RAMP.id,
      to: MAYBE.id,
    });
  });

  /**
   * Nothing can be dropped into "Mana value 3": a derived group is a heading and not a place,
   * which is `grouping.ts`'s own rule rather than a special case in a view.
   *
   * The one group that *is* a place under a derived grouping is the switched-off pile, which
   * `buildGroups` appends as itself rather than bucketing — so exactly one target survives, and
   * it is the Maybeboard. That is the assertion worth making: "none at all" would have passed
   * against a view that dropped the inactive pile on the floor.
   */
  it("makes no drop target of a derived group", () => {
    render(
      renderView({
        groups: buildGroups(CARDS, [COMMANDER, RAMP, MAYBE], "manaValue", "alphabetical"),
        marketplace: TCG,
        actions: actions(),
      }),
    );

    expect(
      [...document.querySelectorAll(`[${DECK_GROUP_ATTR}]`)].map((n) =>
        n.getAttribute(DECK_GROUP_ATTR),
      ),
    ).toEqual([String(MAYBE.id)]);
  });

  /** A view handed nothing draws exactly what it always drew — which is what lets a story or a
   *  test mount one without a deck behind it. */
  it("draws no controls at all when it is given none", () => {
    render(renderView({ groups: GROUPS, marketplace: TCG }));
    expect(screen.queryByLabelText(/^Copies of/)).toBeNull();
    expect(screen.queryByLabelText(/^Move /)).toBeNull();
  });
});

/**
 * **The right-click, across all four views.**
 *
 * A sweep for the reason the editing one is: the menu is built **once**, by `DeckEditor`, and
 * handed down as one more field of `DeckCardActions` — so what each view owes is that it hangs
 * the handlers on the card rather than on the pile, and that it hangs *both* of them. Four
 * copies of that would be four chances for one surface to quietly lose the affordance, and the
 * reader would find it by switching view.
 *
 * The menu itself is `deckCardMenu.test.tsx`'s and `DeckEditor.test.tsx`'s. What is asserted
 * here is the wiring, so the fake records **which card** each press was about: a view that
 * attached the handler to the group would answer about the wrong card or about none.
 */
describe.each(VIEWS)("$name right-click", ({ render: renderView }) => {
  /** The card every case below asks about, found by the slot every view stamps on its own
   *  focusable element — a button in three of them, the row itself in the table. */
  const anchor = () =>
    document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(RAMP.id, "c-Sol Ring")}"]`,
    )!;

  const draw = () => {
    const asked: string[] = [];
    const menu = (card: DeckCard) => ({
      onContextMenu: (e: ReactMouseEvent) => {
        e.preventDefault();
        asked.push(`pointer:${card.name}`);
      },
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key === "F10" && e.shiftKey) asked.push(`keyboard:${card.name}`);
      },
    });
    const onSelect = vi.fn();
    render(
      renderView({
        groups: GROUPS,
        marketplace: TCG,
        onSelect,
        actions: { setQuantity: vi.fn(), drop: vi.fn(), menu },
      }),
    );
    return { asked, onSelect };
  };

  it("asks the card that was right-clicked, not the pile it is in", () => {
    const { asked } = draw();
    fireEvent.contextMenu(anchor());
    expect(asked).toEqual(["pointer:Sol Ring"]);
  });

  /**
   * **Shift+F10, because this menu is the keyboard's only route to moving a card.**
   *
   * The per-card `Move…` select was removed on 2026-08-14 and `cardControl.tsx` records what
   * that cost: a caret cannot drag, so there has been no keyboard path to a move at all. The
   * menu is the replacement, and a menu a keyboard cannot open would not be one.
   */
  it("answers the keyboard's own way of asking for a menu", () => {
    const { asked } = draw();
    fireEvent.keyDown(anchor(), { key: "F10", shiftKey: true });
    expect(asked).toEqual(["keyboard:Sol Ring"]);
  });

  /** Every other key still belongs to whatever was listening for it — the table's row
   *  activation above all, which is `VirtualTable`'s and must survive a second handler being
   *  hung on the same element. */
  it("opens the card on Enter with a menu wired beside it", async () => {
    const { onSelect } = draw();
    anchor().focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "Sol Ring" }));
  });

  /** A view given no menu is exactly the view it was — which is what lets a story or a test
   *  mount one with no editor behind it. */
  it("attaches nothing at all when it is given no menu", () => {
    render(renderView({ groups: GROUPS, marketplace: TCG, actions: { setQuantity: vi.fn() } }));
    // No throw, and the native menu is left alone: nothing calls `preventDefault` on it.
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    anchor().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

/**
 * The three views that draw a card as a control of its own.
 *
 * The table is not one of them and could not be: its rows *are* the controls (`VirtualTable`
 * owns the click, Enter and Space on a row), and its groups are bands rather than lists. It
 * is checked on its own terms further down.
 */
describe.each(VIEWS.filter((v) => v.name !== "TableView"))("$name", ({ render: renderView }) => {
  const setup = () => {
    const onSelect = vi.fn();
    render(renderView({ groups: GROUPS, marketplace: TCG, violations: VIOLATIONS, onSelect }));
    return onSelect;
  };

  it("opens the card that was pressed", async () => {
    const user = userEvent.setup();
    const onSelect = setup();

    await user.click(screen.getByRole("button", { name: /^Arcane Signet/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Arcane Signet");
  });

  /**
   * The mark is a colour in two of these three — a 2px stripe on a 22px text row has no room
   * for the words — so the sentence has to reach a reader who cannot see it. It rides in the
   * control's own name, beside the game-changer note it must never be confused with.
   */
  it("says which card breaks a rule, in words", () => {
    setup();

    const sol = screen.getByRole("button", { name: /^Sol Ring/ });
    expect(sol.getAttribute("aria-label")).toContain("rule break: Sol Ring is banned here.");
    expect(sol.getAttribute("aria-label")).toContain("game changer");
  });

  it("names every group's list for anything that reads structure", () => {
    setup();
    expect(screen.getByRole("list", { name: "Ramp" })).toBeInTheDocument();
  });

  /**
   * **A keyboard reader has to be able to see where they are** — WCAG 2.4.7, and the failure
   * mode is invisible to anyone testing with a mouse.
   *
   * The trap is the offset's sign. A card in the stack and a tile in the grid are both a
   * button *filling* a box that clips its own corners, so an outline standing 2px off the
   * button is painted entirely in the clipped region and never drawn — `VirtualTable` already
   * documents this for its rows. The text row is not that shape and keeps the positive
   * offset the rest of the app uses, so this asserts an outline is asked for rather than
   * which side of the edge it lands on.
   */
  it("gives every card control a focus outline", () => {
    setup();
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("focus-visible:outline-2");
      expect(button.className).toContain("focus-visible:outline-accent");
    }
  });
});

/**
 * The two surfaces whose control fills a clipped box. Written as a sweep because the offset
 * is one character and reverting it silently removes the focus indicator altogether.
 */
describe.each([
  ["CardStack", (props: ViewProps) => <StackView {...props} />],
  ["GridView", (props: ViewProps) => <GridView {...props} />],
] as const)("%s", (_name, renderView) => {
  it("keeps its focus outline inside the box that clips it", () => {
    render(renderView({ groups: GROUPS, marketplace: TCG }));
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("focus-visible:-outline-offset-2");
      expect(button.className).not.toContain("focus-visible:outline-offset-2");
    }
  });
});

describe("the views that are not the table", () => {
  const empty = buildGroups([], [SIDEBOARD], "category", "alphabetical");

  /**
   * A `VirtualTable` has one scroller and one band per group, so an empty group is a band and
   * nothing else — there is no column for it to be a place *in*. The other three draw a
   * sentence, because an empty Sideboard is where the next sideboard card goes.
   *
   * **The empty group is the Sideboard rather than `Ramp`**, and it is a fixed zone on purpose:
   * a seeded pile is the fixture that keeps reaching a view empty however `drawsWhenEmpty` is
   * tuned, and that rule has since been tuned twice. It no longer has a narrowed case at all; it
   * now hides an empty pile the *app* made, which is the case a `Ramp` fixture would have walked
   * straight into. The sentence is what this asserts either way.
   */
  it.each([
    ["StackView", <StackView key="s" groups={empty} marketplace={TCG} />],
    ["TextView", <TextView key="t" groups={empty} marketplace={TCG} />],
    ["GridView", <GridView key="g" groups={empty} marketplace={TCG} />],
  ])("%s says where the next card goes", (_name, element) => {
    render(element);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByText("0 cards")).toBeInTheDocument();
  });

  /**
   * **These three are the app's only scrollers whose drop targets sit flush against their own
   * content edge, and that cost the leftmost pile its ring.** A `DROP_RING` is a box shadow and
   * `FOCUS` is an outline, so neither is inside the box that laid the pile out — but `overflow`
   * clips at the scroller's *padding box*, so with no padding the mark was painted in the clipped
   * region and the reader saw a ring with a side missing for the whole length of a drag.
   *
   * **Written as a class sweep because jsdom cannot see the defect it guards.** There is no
   * layout engine here, so nothing is clipped, every rect is zero and a rendering assertion would
   * pass against a view that had lost the padding again — the same reason `focus outline inside
   * the box that clips it` above is a sweep. The pair is asserted together on purpose: the
   * padding is only load-bearing *because* of the `overflow`, and a view that dropped the
   * `overflow-x-auto` would be a different change entirely (the overhang would reach the page and
   * put an X scrollbar across the whole app, which the 1024px floor forbids).
   *
   * The `TableView` is deliberately not one of these: its rows are absolutely positioned inside a
   * virtualiser, so it draws `ring-inset` and wants no room at all.
   */
  it.each([
    ["StackView", <StackView key="s" groups={GROUPS} marketplace={TCG} />],
    ["TextView", <TextView key="t" groups={GROUPS} marketplace={TCG} />],
    ["GridView", <GridView key="g" groups={GROUPS} marketplace={TCG} />],
  ])("%s leaves its drop marks room inside the box that clips them", (_name, element) => {
    const { container } = render(element);
    const root = container.firstElementChild;

    expect(root?.className).toContain("overflow-x-auto");
    expect(root?.className).toContain(DROP_MARK_ROOM);
  });
});

describe("StackView flow", () => {
  const stacks = () => [...document.querySelectorAll(`[${STACK_ATTR}]`)];
  /** The rail is **not** one of the boxes above — `STACK_ATTR` marks one pile drawn in the flow,
   *  and the rail's piles are lifted out before the flow is drawn — so it is found by its own
   *  attribute. */
  const rail = () => document.querySelector<HTMLElement>(`[${RAIL_ATTR}]`);
  /** By the id each section is `aria-labelledby`, which is the heading's own handle rather
   *  than a guess at the header's shape. */
  const headingsIn = (box: Element) =>
    [...box.querySelectorAll('[id^="group-"]')].map((n) => n.textContent);

  /** The desk's zoom is remembered for the session and this store outlives a test, so a case
   *  that leaves it at 2× would silently re-pack every suite that runs after it. */
  afterEach(resetZoom);

  /**
   * **One box per flowing pile, in the reader's own order — no pile shares a box with another.**
   *
   * This is the whole of what replaced `packColumns` here on 2026-08-14, and it is asserted as a
   * count *and* as a list of one heading each, because the two failures it guards against are
   * opposite shapes: a layout that went back to packing answers three piles in two boxes, and one
   * that lost the split answers them in the wrong order.
   *
   * **The empty `Draw` pile is in the fixture deliberately.** Under the pack it was the group that
   * did not fit and therefore opened the second column — the whole of what made that test a test.
   * It has no such job now, and that is the point: an empty pile is one box like any other, and a
   * layout that treated it as free would leave a hole in the line. See {@link DRAW}.
   *
   * The boxes are read out of the DOM rather than inferred from the cards being present: the first
   * draft of the test this replaces asserted only that both piles were drawn and twelve cards were
   * in Ramp, which is true of a layout that dropped everything into a single box and did no work
   * at all.
   */
  it("draws each flowing pile in its own box, in the reader's own order", () => {
    const three = (kind: "main" | "commander") =>
      Array.from({ length: 3 }, (_, i) =>
        card({ name: `${kind} ${i}`, categoryKind: kind, ownedQuantity: 1 }),
      );
    render(
      <StackView
        groups={buildGroups(
          [...three("commander"), ...three("main")],
          [COMMANDER, RAMP, DRAW],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
      />,
    );

    expect(stacks()).toHaveLength(3);
    expect(stacks().map((s) => headingsIn(s))).toEqual([["Commander"], ["Ramp"], ["Draw"]]);
    // And never split: all three of Ramp's cards are in the one Ramp stack.
    expect(
      within(screen.getByRole("list", { name: "Ramp" })).getAllByRole("listitem"),
    ).toHaveLength(3);
  });

  /**
   * **The column is the card plus its chrome, and never a second number scaled beside it.**
   *
   * The 14rem this replaced was the *given* and the card was derived from it; the arrow points
   * the other way now, because only one of the two can be scaled. Scaling both would agree at 1×
   * and drift at every other stop — a column rounded up while the card inside it rounded down is
   * padding that grows with the zoom, and a card stretched wider than the height its own aspect
   * ratio was computed from.
   *
   * The 14 is the section's `p-1.5` either side and the section's own hairline, neither of which
   * zooms: chrome around a card is not part of one.
   *
   * **That hairline no longer paints a line, and it is still in this sum.** The pile's border is
   * `border-transparent` now — the box reserves its 2px exactly as it always did, and draws
   * nothing with them. Reading the 2 as the border coming *off* and deleting it here would make
   * every stack 2px wider than the height its own aspect ratio was computed from.
   */
  it("sizes a pile's box from the card it holds, at every stop on the ladder", () => {
    for (const zoom of ZOOM_STEPS) {
      expect(stackColumnWidth(zoom)).toBe(stackCardWidth(zoom) + 14);
    }
    // The design canvas's own number, which this has to keep answering where nobody has zoomed.
    expect(stackColumnWidth(DEFAULT_ZOOM)).toBe(224);
  });

  /**
   * …and it reaches the element as an **inline width**, beside the row span the masonry places it
   * by.
   *
   * A computed Tailwind class emits no CSS rule at all — the scanner reads source text — so a
   * pile sized by an interpolated class would lay itself out at whatever its contents came to
   * and the whole view would drift wider as the reader zoomed.
   *
   * **The `flex` basis this used to assert beside the width is gone with the flex box it belonged
   * to** (2026-08-15). The flow is a grid of `auto-fill` tracks over one-pixel rows now, so a pile
   * is placed by `grid-row: span <its own height>` and a `flex` shorthand on it would be inert
   * decoration. The span is asserted in its place, and what it is asserted against says the other
   * half out loud: **jsdom lays nothing out**, so every pile measures 0 here and the number below
   * is `flowRowSpan(0)` — the gutter alone. What a pile really spans is the live pass's to see;
   * what this can see is that the view writes a span at all, which is the half a regression would
   * take away.
   */
  it("writes the zoomed width onto the pile, and a row span beside it", () => {
    setDeckZoom(2);
    render(
      <StackView
        groups={buildGroups([card({ name: "Sol Ring" })], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    );

    const stack = stacks()[0] as HTMLElement;
    expect(stack.style.width).toBe(`${stackColumnWidth(2)}px`);
    expect(stack.style.width).toBe("434px");
    expect(stack.style.gridRow).toBe(`span ${flowRowSpan(0)}`);
    // The basis is asserted *absent*, because reinstating one is the shape the old layout would
    // come back in and nothing else here would notice.
    expect(stack.style.flex).toBe("");
  });

  /**
   * **The span is a height plus one gutter, rounded up, and never zero.**
   *
   * Three cases and each is a live failure the arithmetic has to keep out. Rounding *down* a
   * fractional height — every measured height is fractional — would let the pile below start a
   * pixel inside this one, which reads as two piles touching. `span 0` is invalid CSS and is
   * dropped entirely, so the pile would fall back to a single one-pixel row and every pile after
   * it would be laid over it; that is the answer for an unmeasured box, which is what jsdom hands
   * this view for every pile in the suite.
   */
  it("spans a pile's own height plus one gutter, and never nothing", () => {
    expect(flowRowSpan(300)).toBe(320);
    expect(flowRowSpan(300.2)).toBe(321);
    expect(flowRowSpan(0)).toBe(20);
    expect(flowRowSpan(-40)).toBe(1);
  });

  /**
   * **The box the piles flow in is the masonry, and every clause of it is load-bearing.**
   *
   * `grid` with `repeat(auto-fill, <one pile>)` is CSS counting how many piles fit on a line —
   * the number this view refuses to work out for itself, and the reason no `ResizeObserver` here
   * watches the desk. `grid-auto-rows: 1px` is what makes a span a height: without it a row is
   * content-sized and the layout collapses back to lines as tall as their tallest pile, which is
   * the whole defect.
   *
   * **The absent row gap is the assertion that looks like tidiness and is not.** A grid gap is
   * drawn at every row boundary an item crosses, so a `gap-y-5` here — the class this box carried
   * until 2026-08-15, and the obvious thing to put back when the vertical spacing is being
   * adjusted — would draw one 20px gutter per *pixel* of every pile's height. Nothing would go
   * red, and the deck would be some hundreds of times taller than the window.
   *
   * jsdom lays nothing out, so this is the declaration and never the layout; what the rule
   * actually does to a deck is the live pass's.
   */
  it("lays the flow out as a grid of one-pixel rows, with no row gap", () => {
    render(
      <StackView
        groups={buildGroups([card({ name: "Sol Ring" })], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    );

    const box = (stacks()[0] as HTMLElement).parentElement!;
    const classes = box.className.split(" ");
    expect(classes).toContain("grid");
    expect(classes).toContain("gap-x-4");
    expect(classes).not.toContain("flex-wrap");
    expect(box.className).not.toContain("gap-y");
    expect(box.style.gridTemplateColumns).toBe(
      `repeat(auto-fill, ${stackColumnWidth(DEFAULT_ZOOM)}px)`,
    );
    expect(box.style.gridAutoRows).toBe("1px");
    // **And no cap, because this deck has no rail.** The cap exists to leave the Sideboard one
    // gutter from the deck; with nothing drawn after this box, the width past its last column is
    // desk nobody is looking at, and capping it would narrow the flow for no reader. The `$name
    // rail` block asserts the other side of the same `if`.
    expect(box.style.maxWidth).toBe("");
  });

  /**
   * **How many piles are drawn is a fact about the deck, not about the zoom.**
   *
   * This is the assertion the whole change is for. Under the pack, the number of boxes moved with
   * two things a reader had not asked about — the zoom, because a taller stack meant fewer groups
   * to a column, and the *desk's height*, because that was the pack's ceiling. So the same deck
   * drew three boxes in a tall window and six in a short one, and at 100 % zoom on a 1080p screen
   * it filled three tall columns and left half the desk blank beside them. There is nothing left
   * for either to move: the count is `flow.length`, and CSS decides how many fit on a line.
   *
   * Written across the two ends of the ladder because 1× is where a regression would still agree.
   */
  it("draws the same number of piles however big the cards are", () => {
    const three = (kind: "main" | "commander") =>
      Array.from({ length: 3 }, (_, i) =>
        card({ name: `${kind} ${i}`, categoryKind: kind, ownedQuantity: 1 }),
      );
    const groups = buildGroups(
      [...three("commander"), ...three("main")],
      [COMMANDER, RAMP, DRAW],
      "category",
      "alphabetical",
    );
    const order = [["Commander"], ["Ramp"], ["Draw"]];

    render(<StackView groups={groups} marketplace={TCG} />);
    expect(stacks().map((s) => headingsIn(s))).toEqual(order);
    cleanup();

    setDeckZoom(2);
    render(<StackView groups={groups} marketplace={TCG} />);
    expect(stacks().map((s) => headingsIn(s))).toEqual(order);
    // …and the boxes grew instead, which is the half that says the zoom still reaches the view.
    expect((stacks()[0] as HTMLElement).style.width).toBe(`${stackColumnWidth(2)}px`);
  });

  /**
   * **Neither the Sideboard nor the Maybeboard is part of the flow**, and that is the whole of
   * the change. Both are split off before the flow is drawn and put in the rail beside it — so a
   * reader running a fifteen-category deck down the page never loses the pile they are cutting to,
   * nor the one they are cutting *from*.
   *
   * The fixture puts the Sideboard *between* two flowing piles in the reader's own `sortOrder`
   * (Ramp 1, Sideboard 2, Draw 3, Maybeboard 4), so a split that merely drew the railed kinds last
   * would answer the same set of headings and fail this: what is asserted is that lifting two
   * groups out **closes the gap up** rather than leaving a hole where they were.
   *
   * **The rail's order is the reader's own `sortOrder` and nothing `splitRail` did.** Sideboard
   * (2) above Maybeboard (4) is where the seed put them, which is why this asserts a list rather
   * than a set: a split that sorted by kind would answer the same two headings here and would
   * quietly overrule a reader who had dragged their Maybeboard above their Sideboard.
   *
   * The rail is asserted as the other half rather than instead: "the Sideboard is not in the flow"
   * is equally true of a view that dropped the pile on the floor.
   */
  it("pulls both piles played beside the deck out of the flow and into the rail", () => {
    const three = (kind: "main" | "commander" | "side") =>
      Array.from({ length: 3 }, (_, i) =>
        card({ name: `${kind} ${i}`, categoryKind: kind, ownedQuantity: 1 }),
      );
    render(
      <StackView
        groups={buildGroups(
          [...three("commander"), ...three("main"), ...three("side")],
          [COMMANDER, RAMP, SIDE, DRAW, MAYBE],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
      />,
    );

    // The flowing groups, still in the reader's own order and with the rail's two lifted out.
    expect(stacks().map((s) => headingsIn(s))).toEqual([["Commander"], ["Ramp"], ["Draw"]]);
    expect(headingsIn(rail()!)).toEqual(["Sideboard", "Maybeboard"]);
  });

  /**
   * **The rail is a plain flex child, and there is deliberately nothing sticky about it.**
   *
   * It was `sticky right-0` over an opaque `bg-bg` at `LAYER.raised` with a leftward seam shadow,
   * and every one of those four existed for one reason: to hold the rail in view *while the deck's
   * columns scrolled sideways underneath it*. The piles wrap downward now, so nothing passes
   * under the rail — an opaque backdrop would occlude nothing and the seam shadow would draw a
   * permanent divider across a layout in which nothing moves.
   *
   * **`ml-auto` is asserted absent, and that reverses what this test said until 2026-08-17.** It
   * was the last mechanism the rail had, and it turned out to be the bug rather than the remainder
   * of the fix: a margin that eats free space pinned the rail to the right edge of the *desk*, so
   * everything the flowing box left over — up to very nearly a whole column, and a different
   * number at every zoom stop — opened as a gap between the deck and the Sideboard. The rail hugs
   * the deck now, and what holds it one gutter away is the cap on the flowing box
   * (`flowMaxWidth`), not a margin here. Putting `ml-auto` back restores the gap in full.
   *
   * The negatives are asserted rather than assumed because the alternative shipped: reinstating a
   * sticky rail is a two-word edit that no other test in this file would notice.
   */
  it("draws the rail as a plain flex child, with nothing sticky about it", () => {
    render(
      <StackView
        groups={buildGroups(
          [card({ name: "Blood Moon", categoryKind: "side" })],
          [RAMP, SIDE],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
      />,
    );

    // Whole class names, never a substring: `bg-bg` is a prefix of nothing here, but `border`
    // inside `border-transparent` is exactly the trap this file's group-chrome block names.
    const classes = rail()!.className.split(" ");
    expect(classes).not.toContain("ml-auto");
    // A column of groups — the one box in this view that still stacks piles vertically, which is
    // why the rail changes where a pile sits and nothing about what is in it.
    expect(classes).toContain("flex-col");
    expect(classes).toContain("gap-5");
    expect(classes).not.toContain("sticky");
    expect(classes).not.toContain("bg-bg");
    expect(classes).not.toContain(LAYER.raised);
    expect(rail()!.className).not.toContain("shadow");
    // And it is not one of the flow's boxes, which is the other half of the same claim: a sweep
    // that counts the piles on the desk is counting the ones the reader is building with.
    expect(rail()).not.toHaveAttribute(STACK_ATTR);
  });

  /**
   * **A derived heading never reaches the rail, because a derived group carries `kind: null`.**
   * That is the rule, and a split reading anything other than the group's own kind — a name, a
   * position, "the last group" — would park "Mana value 1" at the right edge of the desk, a
   * bucket the reader never asked to keep in view.
   *
   * **What is not the rule, and reads like it here:** the *grouping mode* does not disable the
   * rail. The Sideboard's heading is absent from this fixture because the pile is **active** and
   * `grouping.ts` buckets an active pile's cards into the derived groups (`buildGroups` line
   * 210, `if (!card.categoryActive) continue;`) — so there is no `side` group left, rather than a
   * `side` group being passed over. The switched-off cases below are the pair that says so.
   *
   * **The Maybeboard had to leave this fixture, and where it went is the point.** It was in the
   * category list here and it is not any more: it is seeded switched off, so `buildGroups` appends
   * it as itself under a derived grouping — a real `maybe` group, which `splitRail` now rails. The
   * pile did not stop arriving; it stopped being an example of "nothing here is railed". That case
   * moved to the switched-off pair below, where it belongs.
   *
   * The cards are asserted **present** as well: "no Sideboard heading" is also true of a view
   * that dropped the pile on the floor.
   */
  it.each(["manaValue", "type"] as const)(
    "draws no rail at all when the grouping is %s",
    (groupBy) => {
      render(
        <StackView
          groups={buildGroups(
            [
              card({ name: "Sol Ring" }),
              card({ name: "Blood Moon", categoryKind: "side" }),
              card({ name: "Pyroblast", categoryKind: "side" }),
            ],
            [RAMP, SIDE],
            groupBy,
            "alphabetical",
          )}
          marketplace={TCG}
        />,
      );

      expect(screen.getByRole("button", { name: /^Blood Moon/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Pyroblast/ })).toBeInTheDocument();
      expect(screen.queryByText("Sideboard")).not.toBeInTheDocument();
      expect(rail()).toBeNull();
    },
  );

  /**
   * **A switched-off railed pile still reaches the rail under a derived grouping**, and this is
   * the pair to the case above: together they say the split reads the group's own `kind` and never
   * the mode the toolbar is in.
   *
   * `buildGroups` buckets the **active** cards and appends every switched-off pile as itself,
   * unchanged and last (its own line 204–207) — so under `manaValue` a sideboard the reader has
   * turned off arrives as a real `side` group, and the split sends it right. That is the wanted
   * answer and not a quirk being tolerated: it is still that pile, still `aria-labelledby` its
   * own name, still a drop target with a `categoryId` — the switch says it counts toward
   * nothing, never that it has stopped being the sideboard.
   *
   * **Both kinds, because for the Maybeboard this is the ordinary case rather than the corner
   * one.** A sideboard is switched off by a reader who chose to; the Maybeboard is seeded off, so
   * under a derived grouping it arrives by this route almost every time.
   *
   * **Both reach the rail by the _kind_ test and not by the switch**, which is why this pair is
   * still worth its own case now that a switched-off pile is railed anyway (2026-08-17). The two
   * tests would agree about these two groups whichever ran first, so the assertion cannot tell
   * them apart — what it can still tell is that the split has not learned about `groupBy`. The
   * ordering of the two tests is asserted where it can fail: the case below, where the reader's own
   * switched-off pile lands under a Maybeboard that is switched off too.
   *
   * Without this, `StackView` could grow a `groupBy` check and every assertion in this file would
   * stay green while a reader who switched their sideboard off and grouped by curve lost the rail.
   */
  it.each([
    { kind: "side", name: "Sideboard", id: 2, sortOrder: 2, cardName: "Blood Moon" },
    { kind: "maybe", name: "Maybeboard", id: 5, sortOrder: 4, cardName: "Avacyn" },
  ] as const)(
    "still draws the rail for a switched-off $name when the grouping is derived",
    ({ kind, name, id, sortOrder, cardName }) => {
      const off = category({ id, name, kind, isActive: false, sortOrder });
      render(
        <StackView
          groups={buildGroups(
            [
              card({ name: "Sol Ring" }),
              card({ name: cardName, categoryKind: kind, categoryActive: false }),
            ],
            [RAMP, off],
            "manaValue",
            "alphabetical",
          )}
          marketplace={TCG}
        />,
      );

      expect(headingsIn(rail()!)).toEqual([name]);
      // And the derived bucket the *active* card went into is in the flow, not a second rail: the
      // pile the reader switched off is the only thing on the right.
      expect(stacks()).toHaveLength(1);
      expect(headingsIn(stacks()[0])).toEqual(["Mana value 1"]);
    },
  );
});

/**
 * **The pile's own chrome, now that the line around it is gone.**
 *
 * A column of stacked card faces is already a shape — every card draws its own edge — and a
 * hairline box around every pile laid a second grid over the first, fifteen rectangles a reader
 * has to look past to see the cards. It is `border-transparent` now rather than absent, and the
 * difference matters twice: the box still reserves its 2px, so `stackColumnWidth`'s sum above is
 * untouched, and the drop ring still has an edge to replace.
 *
 * What is worth pinning is that taking the line off did not take the **signal** off with it. A
 * switched-off pile used to say so with a dashed outline; it says so with a wash and with dimmed
 * cards instead, and those are two assertions rather than one because they are drawn by two
 * different elements.
 *
 * The pile is found by `role="region"` and its accessible name — the `<section>` is
 * `aria-labelledby` its own heading — which is how `DeckEditor.test.tsx` and the stories address
 * a group, and the only handle that does not guess at the markup's shape.
 */
describe("StackView group chrome", () => {
  /** Whole class names, never a substring: `border-transparent` contains `border`, and a
   *  `toContain` on the string would answer yes to a box that had lost its width class. */
  const classesOf = (el: Element) => el.className.split(" ");
  const pile = (name: string) => screen.getByRole("region", { name });
  const draw = () => render(<StackView groups={GROUPS} marketplace={TCG} />);

  /**
   * The resting pile, which is the one a reader sees fifteen of.
   *
   * `border` itself is asserted **present**, which looks like ceremony and is not: the hairline is
   * still 2px of the column's box and {@link stackColumnWidth} adds it. Drop the width class along
   * with the colour and the section's content box grows by two — the cards stretch to fill it, two
   * pixels wider than the height their own aspect ratio was computed from, at every zoom, with
   * nothing red.
   */
  it("draws no line and no wash around a resting pile", () => {
    draw();

    const ramp = classesOf(pile("Ramp"));
    expect(ramp).toContain("border");
    expect(ramp).toContain("border-transparent");
    expect(ramp).not.toContain("border-border");
    expect(ramp).not.toContain("bg-surface/60");
  });

  /**
   * The dashed outline was one of four things saying "this counts toward nothing" — the others
   * being the `INACTIVE` chip, the dimmed heading and the wash — and it is the one that went with
   * the border. The wash carries what is left, which is why it is heavier than the `bg-surface/40`
   * it succeeds: a wash competing with a dashed line can afford to be faint, a wash standing in
   * for one cannot.
   */
  it("still says a switched-off pile is switched off, without the dashes", () => {
    draw();

    const maybe = classesOf(pile("Maybeboard"));
    expect(maybe).toContain("border-transparent");
    expect(maybe).not.toContain("border-dashed");
    expect(maybe).toContain("bg-surface/60");
  });

  /**
   * **A card image is opaque**, so the section's wash paints entirely *behind* the stack and a
   * reader looking down a column of card faces sees none of it. Dimming the list is what reaches
   * them — and it is the one signal that survives the heading leaving the top of the desk, since
   * the chip and the dimmed name go up there with it.
   *
   * Asserted as a pair — dimmed here, not dimmed there — because `opacity-60` on every stack
   * would be no signal at all, only a quieter view.
   */
  it("dims the cards of a switched-off pile, and no others", () => {
    draw();

    expect(classesOf(screen.getByRole("list", { name: "Maybeboard" }))).toContain("opacity-60");
    expect(classesOf(screen.getByRole("list", { name: "Ramp" }))).not.toContain("opacity-60");
  });
});

/**
 * The two views that lay a deck out in fixed-width boxes, and the one number they disagree about.
 *
 * Everything in the block below is true of both — which half of the scroller a group is drawn in,
 * and how wide its box is — so it is a sweep rather than two copies. **What is no longer true of
 * both is the packing**: `TextView` still fills a column to a measured height and opens the next
 * one, while `StackView` draws one box per pile and lets them wrap. Nothing here asks about that,
 * which is why the sweep survived the change whole.
 *
 * The width is the fixture's own field precisely because it is the difference: `StackView`'s box
 * is the card plus its chrome and therefore moves with the reader's zoom, `TextView`'s is a fixed
 * 300px line of text and does not. A view that took the other one's number would pass a sweep that
 * only asked "is there a width".
 */
const COLUMN_VIEWS = [
  {
    name: "StackView",
    render: (props: ViewProps) => <StackView {...props} />,
    /** The id `StackGroup` gives its heading, which is what the section is `aria-labelledby` —
     *  the same handle `StackView flow` reads its layout off. */
    heading: "group-",
    width: `${stackColumnWidth(DEFAULT_ZOOM)}px`,
    zoomedWidth: `${stackColumnWidth(2)}px`,
  },
  {
    name: "TextView",
    render: (props: ViewProps) => <TextView {...props} />,
    /** This view's packed columns carry no attribute of their own — a column here is a box and
     *  nothing else — so its groups are found by the id in `TextGroup`'s `aria-labelledby`. */
    heading: "text-group-",
    /** `COLUMN_WIDTH`, written out because `TextView` does not export it. The two values being
     *  the same string *is* the claim: a decklist line is 300px whatever size the reader is
     *  drawing card faces at. */
    width: "18.75rem",
    zoomedWidth: "18.75rem",
  },
] as const;

/**
 * **The piles played beside the deck are pinned to the right, and the columns beside them come
 * down rather than running off the edge.**
 *
 * Both views packed every group into a row of fixed-width columns that grew sideways, so a
 * fifteen-category deck was an X scrollbar across the whole desk — the one thing `DeckEditor`'s
 * 1024px floor exists to prevent, arriving by a route that floor never measured. And the
 * Sideboard and the Maybeboard, being categories like any other to a greedy in-order pack, landed
 * wherever the pack dropped them: usually the far end of that run, i.e. off screen.
 *
 * **Two piles in one rail, not two rails.** They share a single box and stack down it in the
 * reader's own `sortOrder`, so the desk still spends exactly one column's width on everything
 * played beside the deck — which is the trade `frontend-design.md` measured, and doubling it
 * would have taken the last flowing column at the app's own 1280px window.
 *
 * Every claim below is about which of the scroller's two boxes a group is in, and how wide that
 * box is. **jsdom lays nothing out**, so none of it can watch a column actually wrap — what a
 * test can see is the inputs CSS applies the rule to, which is what these read.
 */
describe.each(COLUMN_VIEWS)(
  // `$name rail`, not `$name's`: vitest quotes an interpolated string, so the possessive would
  // print as `'StackView''s`. Same shape as `$name editing` above.
  "$name rail",
  ({ render: renderView, heading, width, zoomedWidth }) => {
    /** The desk's zoom is remembered for the session and this store outlives a test — the
     *  reason `StackView flow` resets it, and the same reason here. */
    afterEach(resetZoom);

    /** `GROUPS`' deck with a Sideboard in the middle of the reader's own order, and the
     *  Maybeboard after it — the two piles the rail takes, arriving from opposite ends of the
     *  run the rail replaces. */
    const withRail = buildGroups(
      [...CARDS, card({ name: "Rest in Peace", categoryKind: "side" })],
      [COMMANDER, RAMP, SIDE, MAYBE],
      "category",
      "alphabetical",
    );

    const rail = () => document.querySelector<HTMLElement>(`[${RAIL_ATTR}]`);
    /**
     * The box the deck's own piles flow in — read as the rail's own **previous** sibling rather
     * than by position in the tree, because the order of the two is load-bearing. Document order
     * is the whole of what puts the rail after the deck now that no margin does: a rail drawn
     * first would sit at the left with the entire deck flowing after it, and every other
     * assertion here would still pass.
     */
    const flow = () => rail()!.previousElementSibling as HTMLElement;
    const headingsIn = (root: Element) =>
      [...root.querySelectorAll(`[id^="${heading}"]`)].map((n) => n.textContent);

    const draw = (groups: readonly CardGroup[] = withRail, over: Partial<ViewProps> = {}) =>
      render(renderView({ groups, marketplace: TCG, ...over }));

    /**
     * **A `side` group and a `maybe` group are never in the flowing half.** Read as two lists —
     * what is in the flow, and what is in the rail — because either half alone is satisfied by a
     * broken layout: "the Sideboard is in the rail" passes against a view that draws the pile
     * twice, and "the Sideboard is on screen" passed against the packed layout this replaces,
     * which is how the bug survived.
     *
     * Both lists are asserted **in order**. For the flow that is `packColumns`' whole contract:
     * lifting two groups out must close the gaps up rather than reshuffle what is left. For the
     * rail it is the claim that nothing sorted it — Sideboard (`sortOrder` 2) above Maybeboard
     * (4) is the reader's own arrangement arriving intact, and a `splitRail` that ordered by kind
     * would answer this same pair while silently overruling a reader who had swapped them.
     */
    it("lifts the side and maybe groups out of the pack and into the rail", () => {
      draw();

      expect(headingsIn(flow())).toEqual(["Commander", "Ramp"]);
      expect(headingsIn(rail()!)).toEqual(["Sideboard", "Maybeboard"]);
    });

    /**
     * The rail is drawn for an **empty** Sideboard too: an empty pile is where the next
     * sideboard card goes, and a rail that appeared with the first one would shove the entire
     * layout sideways under the hand that dropped it — mid-drag, which is the one moment the
     * reader cannot afford it.
     *
     * `within` rather than `screen`: every empty group in the deck says the same sentence, so a
     * bare `getByText` would find Ramp's and pass with no rail drawn at all.
     */
    it("draws the rail for an empty sideboard, and says where the next card goes", () => {
      draw(buildGroups([], [RAMP, SIDE], "category", "alphabetical"));

      expect(headingsIn(rail()!)).toEqual(["Sideboard"]);
      expect(within(rail()!).getByText("Nothing here yet.")).toBeInTheDocument();
    });

    /**
     * **The Maybeboard reaches the rail on its own, with no Sideboard beside it.**
     *
     * Worth its own case because the rail was the Sideboard's for its whole life, and the two
     * shapes a regression would take both pass everything above: a `splitRail` that still keyed on
     * `side` and merely *drew* the maybe groups after it would answer the pair fixture correctly
     * and answer nothing at all here, and so would one that railed `maybe` only in the presence of
     * a `side` group.
     *
     * The pile is a real one rather than an empty heading — the switch is off, so the group is
     * `isActive: false`, which is the state a reader will actually see. That it is dimmed is the
     * group's business and not the rail's; what is asserted here is that the rail exists, holds
     * it, and is the only place it is drawn.
     */
    it("draws the rail for a Maybeboard with no sideboard in the deck", () => {
      draw(
        buildGroups(
          [card({ name: "Sol Ring" }), card({ name: "Avacyn", categoryKind: "maybe" })],
          [RAMP, MAYBE],
          "category",
          "alphabetical",
        ),
      );

      expect(headingsIn(rail()!)).toEqual(["Maybeboard"]);
      expect(headingsIn(flow())).toEqual(["Ramp"]);
    });

    /**
     * **A pile the reader switched off is drawn in the rail, under the Sideboard and the
     * Maybeboard** — the change of 2026-08-17, in both views.
     *
     * `is_active = 0` is the whole of what `maybe` ever meant: the pile counts toward nothing —
     * not size, not copies, not legality — so it is not part of the deck being laid out, and a
     * column of the desk spent on it was a column spent on cards the reader had already said were
     * out. The unit half of this is `columns.test.ts`; what only a render can say is that the pile
     * arrives in the rail's own box, with its heading and its cards, rather than being dropped
     * somewhere between the two.
     *
     * **The order is the assertion that can fail.** `Draw` is `sortOrder` 3, ahead of the
     * Maybeboard's 4, and it comes out **last** — so `splitRail` really does test the kind before
     * the switch, and the rail's head stays the two beside-the-deck piles whatever their own
     * switches say. That matters in the ordinary case rather than a corner: the Maybeboard is
     * seeded off, so a switch-first split would sink the rail's fixed head under whatever the
     * reader turned off most recently. Swap those two tests and this is the only thing in the suite
     * that goes red — every other assertion here answers the same set of headings either way.
     *
     * The card is asserted present as well: "Draw is not in the flow" is equally true of a view
     * that dropped the pile on the floor, and seeing what is in a pile is the whole affordance for
     * deciding to switch it back on.
     */
    it("rails a pile the reader switched off, under the two played beside the deck", () => {
      const off = { ...DRAW, isActive: false };
      draw(
        buildGroups(
          [
            card({ name: "Sol Ring" }),
            card({
              name: "Rhystic Study",
              categoryId: off.id,
              categoryName: off.name,
              categoryActive: false,
            }),
            card({ name: "Rest in Peace", categoryKind: "side" }),
          ],
          [RAMP, SIDE, off, MAYBE],
          "category",
          "alphabetical",
        ),
      );

      expect(headingsIn(flow())).toEqual(["Ramp"]);
      expect(headingsIn(rail()!)).toEqual(["Sideboard", "Maybeboard", "Draw"]);
      expect(within(rail()!).getByText(/Rhystic Study/)).toBeInTheDocument();
    });

    /**
     * **Switching it back on returns it to the flow, in its own place in it.**
     *
     * The second half of what the change is for, and the half with nothing behind it: the split is
     * derived per render, so there is no state to restore and no journey to reverse. Asserted
     * anyway, because "it comes back" is the promise — and a later edit that cached the rail's
     * contents, to save re-splitting on every render, would break exactly this and nothing else.
     *
     * **`Draw` returns _between_ Ramp and Removal rather than at either end**, which is the part a
     * cache or a `useState` would get wrong even while it got the membership right. `sortOrder` is
     * the reader's own arrangement, and the flow is in it.
     */
    it("returns a switched-off pile to the flow when it is switched back on", () => {
      const REMOVAL = category({ id: 7, name: "Removal", kind: "main", sortOrder: 5 });
      const desk = (isActive: boolean) =>
        buildGroups(
          [card({ name: "Sol Ring" }), card({ name: "Rest in Peace", categoryKind: "side" })],
          [RAMP, SIDE, { ...DRAW, isActive }, MAYBE, REMOVAL],
          "category",
          "alphabetical",
        );

      draw(desk(false));
      expect(headingsIn(flow())).toEqual(["Ramp", "Removal"]);
      expect(headingsIn(rail()!)).toEqual(["Sideboard", "Maybeboard", "Draw"]);
      cleanup();

      draw(desk(true));
      expect(headingsIn(flow())).toEqual(["Ramp", "Draw", "Removal"]);
      expect(headingsIn(rail()!)).toEqual(["Sideboard", "Maybeboard"]);
    });

    /**
     * **The rail is exactly one column wide, inline, in both halves of the `flex` shorthand.**
     *
     * Asserted first against the first box beside it — one number read twice out of the DOM, which
     * no later edit can let drift apart. That box is `TextView`'s packed column and `StackView`'s
     * first pile, which is exactly the point: whatever the flowing half is made of, the rail is
     * one of them wide. Then against the view's own value, without which two empty strings would
     * agree and pass.
     *
     * Drawn at 2× because that is where the two views part company: `StackView`'s rail has to
     * follow the zoom the cards inside it took, and `TextView`'s has to ignore it. The failure
     * either way is silent — a width built by interpolating a Tailwind class emits no CSS rule
     * at all, so the rail keeps its markup and lays itself out at whatever its contents come to.
     *
     * **Only the width is read across the two boxes**, and the *rail's* basis is then read against
     * the view's own number rather than against the flowing box's. It used to be read against both
     * — one number out of the DOM twice — which stopped being possible on 2026-08-15, when
     * `StackView`'s flow became a grid: its piles are placed by a row span and carry no `flex`
     * basis at all, while `TextView`'s packed columns still carry one. The rail is a flex child of
     * the root in both views and keeps its own basis, which is what the last line still pins.
     */
    it("makes the rail one column wide, in both halves of the shorthand", () => {
      setDeckZoom(2);
      draw();

      const column = flow().firstElementChild as HTMLElement;
      expect(rail()!.style.width).toBe(column.style.width);
      expect(rail()!.style.width).toBe(zoomedWidth);
      expect(rail()!.style.flex).toBe(`0 0 ${zoomedWidth}`);
    });

    /**
     * **The flowing area's `minWidth` is the whole of how the rail gets out of the way**, and it
     * is the only part of the wrap a test can see.
     *
     * Too narrow to hold a column and the rail side by side, the outer box's own `flex-wrap`
     * drops the rail onto the next line — but only because the flow refuses to shrink past one
     * column. Without it the flow squeezes, the rail stays on the line, and the desk scrolls
     * sideways again: the exact bug this change removes, reappearing with every element still
     * where the markup says it is.
     */
    it("gives the flowing area a column's minWidth, so the rail wraps instead of scrolling", () => {
      draw();
      expect(flow().style.minWidth).toBe(width);
    });

    /**
     * **And a `maxWidth` at the other end, which is what puts the rail one gutter from the deck**
     * (added 2026-08-17).
     *
     * `flex-1` takes every pixel the rail leaves; a column layout spends only whole columns of it.
     * The remainder — up to very nearly one column, and a different number at every zoom stop —
     * used to sit inside the flowing box as dead desk in front of the rail, which is the gap the
     * reader photographed. `flowMaxWidth` caps the box at the columns it can use, so what is
     * between the last pile and the Sideboard is the gutter and nothing else.
     *
     * **What this can assert is that a cap is there and that it is the floor expression**, and
     * that limit is jsdom's. `cssstyle` does not reject the value, it rewrites it — the real
     * string comes back as `min(464px * , * calc(round(100% * , * down - (224px * 224px) …` — so
     * an exact match here would pin that mangling and go red the day it is fixed. `round(` is the
     * one substring that survives both readings. The arithmetic is asserted on the pure function
     * in `columns.test.ts`; whether the browser then draws one gutter is a story play's, in an
     * engine that lays out.
     */
    it("caps the flowing area at whole columns, so nothing is left over before the rail", () => {
      draw();
      expect(flow().style.maxWidth).toContain("round(");
    });

    /**
     * No `side` and no `maybe` group, no rail. A rail drawn unconditionally would hold a column's
     * width of empty space at the right edge of every deck that has neither, which reads as a
     * layout that has simply been given too much room rather than as a bug.
     *
     * **The fixture is this test's own, and it had to become one.** It used to be `GROUPS` —
     * Commander, Ramp and the Maybeboard — which was a deck with no rail in it right up until the
     * Maybeboard joined the rail, at which point the file's one assertion that the split can
     * answer *nothing* would have started asserting the opposite. It is a deck of a command zone
     * and a pile of the reader's own now, which is what "neither" means and what it will go on
     * meaning.
     *
     * **It is also what protects every column count in this file.** The `StackView columns` block
     * packs decks of ordinary categories, and each of those counts would quietly move the day the
     * split fired on something wider than it should — `isPredefined`, say, or a name a reader typed
     * — failing as arithmetic inside `packColumns`, a long way from the change that caused it. This
     * says the real thing once, so that failure has somewhere to point.
     *
     * **Every category here is switched on, and that is now part of the fixture rather than an
     * accident of it** (2026-08-17). The switch is the split's second test, so a deck with a pile
     * turned off has a rail; "nothing played beside it" means every pile counts and none of the
     * three kinds present is `side` or `maybe`. The two kinds it asserts *do not* rail are exactly
     * the two `splitRail`'s doc gives a reason for leaving in the flow — a commander and a
     * companion are one card each — and that exemption holds only while they are on.
     */
    it("draws no rail when nothing in the deck is played beside it", () => {
      draw(
        buildGroups(
          [
            card({ name: "Sol Ring" }),
            card({ name: "Serah Farron", categoryKind: "commander" }),
            card({ name: "Lurrus", categoryKind: "companion" }),
          ],
          [
            COMMANDER,
            RAMP,
            category({ id: 4, name: "Companion", kind: "companion", sortOrder: 3 }),
          ],
          "category",
          "alphabetical",
        ),
      );
      expect(rail()).toBeNull();
    });

    /**
     * **A group in the rail is the same group, so a card can still be dropped into it.** The
     * rail is a second place these views draw a pile, and a second, lighter definition of one
     * would take the drop target with it: the card would follow the pointer, the pile would
     * light up nothing, and letting go would do nothing at all.
     *
     * **Both piles in the rail, and the Maybeboard is the one that would break quietly.** It is
     * seeded switched off, so it is also the group whose drop target a view would be most tempted
     * to skip — and a Maybeboard that cannot be dragged into is a pile a reader can put nothing in
     * except through the "Move…" select, which is exactly the affordance the rail was meant to
     * restore. That it is inactive changes nothing here: `useCategoryDrop` reads a `categoryId`
     * and the switch is about counting, not about placing.
     *
     * Driven as the real gesture rather than by finding `DECK_GROUP_ATTR`, because the attribute
     * is the half that survives forgetting to call the hook — `deckGroupProps` writes it,
     * `useCategoryDrop` is what makes it a place, and only the drop tells the two apart.
     */
    it.each([
      { name: "sideboard", id: SIDE.id },
      { name: "Maybeboard", id: MAYBE.id },
    ])("takes a dropped card into the $name in the rail", async ({ id }) => {
      const drop = vi.fn();
      draw(withRail, { actions: { setQuantity: vi.fn(), drop } });

      const target = rail()!.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${id}"]`);
      expect(target).not.toBeNull();
      const marked = document.querySelector<HTMLElement>(
        `[${DECK_CARD_ATTR}="${deckCardSlot(RAMP.id, "c-Sol Ring")}"]`,
      )!;

      await dragOnto(marked.closest("li") ?? marked, target!);

      expect(drop).toHaveBeenCalledWith({
        write: "move",
        cardId: "c-Sol Ring",
        from: RAMP.id,
        to: id,
      });
    });
  },
);

/**
 * **The wall's own geometry under the reader's zoom.**
 *
 * The tile used to be a fixed-width Tailwind literal, which is the one shape a zoom cannot take:
 * the scanner reads source text for whole class names, so a width assembled at runtime emits no
 * CSS rule at all — the tile keeps its markup, loses its width and collapses onto its contents,
 * and nothing in a suite that counts elements notices. Everything that moves is an inline style
 * now, and that is what these read.
 *
 * The card scales in both directions; the chrome around it grows and never shrinks. Type has a
 * floor — 9px is already the smallest thing this app writes — and so does the gutter, which is
 * what stops a wall of cards reading as a single sheet at half size.
 */
describe("GridView tiles", () => {
  afterEach(resetZoom);

  const wall = () => screen.getByRole("list", { name: "Ramp" });
  const tile = () => within(wall()).getAllByRole("listitem")[0];
  /** The tile's foot — the rarity gem and the price, which is the last thing in the button. */
  const foot = () => tile().querySelector("button")?.lastElementChild as HTMLElement;
  /** The controls' wrapper, which is what carries their offset off the foot. */
  const controls = () => tile().lastElementChild as HTMLElement;

  const draw = (zoom: number) => {
    setDeckZoom(zoom);
    render(
      <GridView
        groups={buildGroups([card({ name: "Sol Ring" })], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    );
  };

  it("draws a 150px tile at 1× and a scaled one at every other stop", () => {
    for (const zoom of ZOOM_STEPS) {
      draw(zoom);
      expect(tile().style.width).toBe(`${scaled(150, zoom)}px`);
      // The size is inline, never a class — see this block's own note. Read as whole class
      // names rather than as a substring, which `overflow-hidden` would otherwise answer.
      expect(
        tile()
          .className.split(" ")
          .filter((c) => c.startsWith("w-")),
      ).toEqual([]);
      cleanup();
    }

    draw(DEFAULT_ZOOM);
    expect(tile().style.width).toBe("150px");
  });

  /**
   * The foot and the gutter grow with the card and hold at their own size going down, and the
   * controls sit **on** the foot at either end — which is the derivation worth pinning, because
   * the bar's offset was a fixed utility for as long as the foot was a fixed height, and the two
   * would have parted company at exactly the zoom nobody looks at.
   */
  it("grows the foot and the gutter with the tiles, and never shrinks them", () => {
    draw(2);
    expect(wall().style.gap).toBe("20px");
    expect(foot().style.height).toBe("40px");
    expect(foot().style.fontSize).toBe("18px");
    expect(controls().style.bottom).toBe("40px");
    cleanup();

    // Half size: the card halves, and none of the three follows it down.
    draw(0.5);
    expect(tile().style.width).toBe("75px");
    expect(wall().style.gap).toBe("10px");
    expect(foot().style.height).toBe("20px");
    expect(foot().style.fontSize).toBe("9px");
    expect(controls().style.bottom).toBe("20px");
  });

  /**
   * **The face is `components/CardArt`, the same object the search wall draws** — which is what
   * this asserts through the two things only that component puts in the tree: the picture's
   * `alt` is the card's name (the hand-rolled copy this replaced passed `alt=""` and printed the
   * name itself), and the marks chip carries `data-card-marks`.
   *
   * **And the deck's own count is clear of that chip.** `FoilOverlay` owns a tile's top-**right**
   * corner on every card surface in this app; this view drew its copy count there too, in a
   * full-width strip, so a foil card in a deck laid the two on top of one another. Nothing went
   * red — a hit target and an overlap are both invisible to jsdom — and the fixtures had no foil
   * card in a deck, which is why this case builds one. The count is top-left now, which is the
   * corner the wall keeps for exactly this kind of mark.
   */
  it("draws the search wall's card frame, with the deck's count clear of its chip", () => {
    render(
      <GridView
        groups={buildGroups(
          [{ ...card({ name: "Sol Ring", quantity: 3 }), finishes: '["foil"]' }],
          [RAMP],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
      />,
    );

    // The picture itself, by tag: the tile also holds the chip's `role="img"` glyphs, and this
    // case deliberately draws one of them.
    const art = tile().querySelector("img")!;
    expect(art).toHaveAttribute("alt", "Sol Ring");
    // The plain scroller's gate — this view mounts every card in the deck at once, unlike the
    // virtualised wall the same frame is drawn on.
    expect(art).toHaveAttribute("loading", "lazy");

    const chip = tile().querySelector("[data-card-marks]");
    expect(chip).not.toBeNull();
    const count = within(tile()).getByText("3");
    expect(chip!.contains(count)).toBe(false);
    expect(count.closest("[data-card-marks]")).toBeNull();
  });
});

/**
 * **The deck desk is one zoom section, and it is not the search column's.**
 *
 * `useAppStore.cardZoom` holds a number per card section rather than one for the app, and the two
 * views here share the `deck` key: they are one deck drawn two ways, so switching between Stacks
 * and Grid must not resize the cards the reader just settled on. The block above pins what each
 * view does *with* a zoom; this one pins **which number it reads** — the half that has no
 * geometry in it and that every assertion in this file would go on passing without.
 *
 * The failure it exists for is the one the split was made to fix, in both directions: a view
 * reading a section of its own would make the toolbar's `Stacks | Grid` press a resize, and a view
 * left reading `deckSearch` (or a re-merged single number) would put the deck back to being
 * resized by a gesture over the card wall docked beside it.
 */
describe("the deck's two views and their one zoom section", () => {
  afterEach(resetZoom);

  /** One card in one pile, which is all either view needs to state a width. */
  const ONE_CARD = buildGroups([card({ name: "Sol Ring" })], [RAMP], "category", "alphabetical");

  /** The width `StackView` gives one pile's box — the card plus its chrome, so it moves with
   *  the zoom the view read. */
  const columnWidth = () => (document.querySelector(`[${STACK_ATTR}]`) as HTMLElement).style.width;
  /** The width `GridView` gives a tile, which is that view's whole geometry. */
  const tileWidth = () =>
    (within(screen.getByRole("list", { name: "Ramp" })).getAllByRole("listitem")[0] as HTMLElement)
      .style.width;

  /**
   * **Both views draw at `cardZoom.deck`, and a future split of that key fails here.**
   *
   * Asserted as two views against one `setDeckZoom`, and against the *zoomed* answers rather than
   * merely against each other: two views that had each grown a section of their own would still
   * agree with one another at 1×, which is where a test that only compared them would sit.
   */
  it("draws Stacks and Grid at the one zoom the deck section holds", () => {
    setDeckZoom(2);

    render(<StackView groups={ONE_CARD} marketplace={TCG} />);
    expect(columnWidth()).toBe(`${stackColumnWidth(2)}px`);
    expect(columnWidth()).toBe("434px");
    cleanup();

    render(<GridView groups={ONE_CARD} marketplace={TCG} />);
    expect(tileWidth()).toBe(`${scaled(150, 2)}px`);
    expect(tileWidth()).toBe("300px");
  });

  /**
   * **…and neither of them moves when another section is zoomed**, which is the whole of the
   * reader's complaint: the deck editor puts its docked card search column beside the desk, both
   * are walls of cards, and one gesture used to size both.
   *
   * `search` is set as well as `deckSearch` — the two sections the reader is most likely to have
   * left somewhere else — so this fails for a view that went back to reading any single shared
   * number rather than only for one that read the search column's by name.
   */
  it("leaves the deck at its own size when another section is zoomed", () => {
    useAppStore.setState({
      cardZoom: { ...DEFAULT_SECTION_ZOOMS, deckSearch: 2, search: MIN_ZOOM },
    });

    render(<StackView groups={ONE_CARD} marketplace={TCG} />);
    expect(columnWidth()).toBe(`${stackColumnWidth(DEFAULT_ZOOM)}px`);
    expect(columnWidth()).toBe("224px");
    cleanup();

    render(<GridView groups={ONE_CARD} marketplace={TCG} />);
    expect(tileWidth()).toBe("150px");
  });

  /**
   * **The gesture writes the section the pointer is over, and only that one.**
   *
   * Driven as a real `wheel` at the view's own root, which is the element the hook is handed:
   * `useCardZoomGesture` attaches a **native** non-passive listener, so this proves the listener
   * is on the scroller as well as which key it steps — a view that passed the right section to a
   * ref pointing at the wrong element would answer every geometry assertion above.
   *
   * The other three sections are swept out of `ZOOM_SECTIONS` rather than named, so a fifth
   * section added later is covered by this the day it exists. `zoomSection` is asserted beside
   * them because it is what tells the badge which corner to draw itself in — the value the
   * reader sees is `cardZoom[zoomSection]`, so a gesture that stepped `deck` while naming
   * something else would print a number nothing on screen is drawn at.
   */
  it.each([
    ["StackView", <StackView key="s" groups={ONE_CARD} marketplace={TCG} />],
    ["GridView", <GridView key="g" groups={ONE_CARD} marketplace={TCG} />],
  ])("steps only the deck section on a ctrl+wheel over %s", (_name, element) => {
    const before = useAppStore.getState().zoomPulse;
    const { container } = render(element);

    fireEvent.wheel(container.firstElementChild as HTMLElement, { deltaY: -100, ctrlKey: true });

    const { cardZoom, zoomSection, zoomPulse } = useAppStore.getState();
    expect(cardZoom.deck).toBe(1.1);
    for (const section of ZOOM_SECTIONS.filter((s) => s !== "deck")) {
      expect(cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
    expect(zoomSection).toBe("deck");
    // One wheel, one pulse — read as a delta rather than as `1`, because the counter is a
    // session's and this file is not the only thing that has run in it.
    expect(zoomPulse).toBe(before + 1);
  });
});

describe("TableView", () => {
  const setup = () => {
    render(
      <TableView groups={GROUPS} marketplace={TCG} violations={VIOLATIONS} onSelect={vi.fn()} />,
    );
  };

  it("draws the nine columns of the deck table", () => {
    setup();
    for (const header of [
      "Qty",
      "Card name",
      "Mana cost",
      "Type",
      "Owned",
      "Tags",
      "Rarity",
      "Printing",
    ]) {
      expect(
        screen.getByRole("columnheader", { name: new RegExp(`^${header}`) }),
      ).toBeInTheDocument();
    }
    // The Price header carries the as-of sentence in its own name, as every money column in
    // this app does.
    expect(
      screen.getByRole("columnheader", { name: `Price. ${pricesAsOf(MARKETPLACES.tcgplayer)}` }),
    ).toBeInTheDocument();
  });

  /**
   * **The card name gets a floor and the largest share, and the fixed columns pay for it.**
   *
   * Measured in the shipped window before this: seven fixed columns took 696px of an 843px
   * grid, so the two flexible ones split 147px and the card name got **84px** — about ten
   * characters — while the usually-empty Tags column held 112. A deck list whose card names are
   * unreadable is not a deck list.
   *
   * The template is an inline style, so this is one of the few layout facts jsdom really can
   * see. `minmax(0,1fr)` on Type is the half that matters most: it lets the name reach its
   * floor by taking from the column beside it rather than by pushing the grid into a horizontal
   * scroll.
   */
  it("gives the card name a floor and the largest share of the free space", () => {
    setup();

    const row = screen.getByText("Arcane Signet").closest("[role=row]") as HTMLElement;
    const tracks = row.style.gridTemplateColumns.split(" ");
    expect(tracks[1]).toBe("minmax(12rem,3fr)");
    expect(tracks[3]).toBe("minmax(0,1fr)");
    // Every other column is a fixed rem width, and together they are the budget the name is
    // measured against: 3 + 5 + 5 + 4 + 5 + 5 + 5 = 32rem read-only. An editable table spends
    // **3.5rem** more on the Qty column, which is what the stepper takes — it was 8rem more
    // while the `Move…` select stood beside it, and the surplus was 72px of gutter on every row.
    const fixed = (el: HTMLElement) =>
      el.style.gridTemplateColumns
        .split(" ")
        .filter((t) => t.endsWith("rem"))
        .reduce((n, t) => n + Number.parseFloat(t), 0);
    expect(fixed(row)).toBe(32);

    cleanup();
    render(
      <TableView
        groups={GROUPS}
        marketplace={TCG}
        actions={{ setQuantity: vi.fn(), drop: vi.fn() }}
      />,
    );
    expect(fixed(screen.getByText("Arcane Signet").closest("[role=row]") as HTMLElement)).toBe(
      35.5,
    );
  });

  /**
   * The deck's order is the toolbar's — one Group by and one Sort — so a header that
   * re-sorted would give one list two orders with no way to see which was in force.
   *
   * **Asserted as "no button in the header row", not as "no button named /sort/".** A sortable
   * header's accessible name is the column's own label (`SortableHeader.tsx`) — the
   * `sort priority N` suffix appears only in a multi-key sort, which `sort={[]}` makes
   * unreachable here — so the old regex matched nothing whatever this table did. Give all nine
   * columns a `sortKey` and it still answered zero.
   */
  it("has no sortable header, because the toolbar owns the order", () => {
    setup();
    // The header is `aria-rowindex={1}`, which is `VirtualTable`'s own contract for it.
    const header = screen
      .getAllByRole("row")
      .find((r) => r.getAttribute("aria-rowindex") === "1") as HTMLElement;
    expect(header).toBeDefined();
    expect(within(header).getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
  });

  /** A row is the control here, not a button inside it — which is `VirtualTable`'s
   *  arrangement and the reason the table is checked apart from the other three. */
  it("opens the card whose row was pressed, and says what is wrong with it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TableView groups={GROUPS} marketplace={TCG} violations={VIOLATIONS} onSelect={onSelect} />,
    );

    await user.click(screen.getByText("Arcane Signet"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Arcane Signet");

    expect(screen.getByText("Rule break: Sol Ring is banned here.")).toBeInTheDocument();
    expect(screen.getByTitle("Sol Ring is banned here.")).toBeInTheDocument();
    expect(screen.getByTitle("Game changer")).toBeInTheDocument();
  });

  /**
   * A `role="row"` that owns no `role="cell"` is malformed to assistive tech — a row that
   * owns nothing — so the band's heading sits in one real cell spanning every column. That is
   * the design canvas's `colspan="9"`, said in ARIA because these rows are divs.
   */
  it("gives the band one real cell spanning every column", () => {
    setup();

    const band = screen.getByText("Ramp").closest("[role=row]");
    const cells = band!.querySelectorAll("[role=cell]");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("aria-colspan", "9");

    // And a card row still owns one cell per column, so the two kinds of row agree about how
    // wide the table is.
    const cardRow = screen.getByText("Arcane Signet").closest("[role=row]");
    expect(cardRow!.querySelectorAll("[role=cell]")).toHaveLength(9);
  });

  /** A cell announced by two `sr-only` words the marks no longer carry: in a cell they are
   *  really read, which is why the table states them and the three button views do not. */
  it("says a game changer and a rule break in words a cell really reads", () => {
    setup();

    expect(screen.getByText("Game changer")).toHaveClass("sr-only");
    expect(screen.getByText("Rule break: Sol Ring is banned here.")).toHaveClass("sr-only");
    // The badge itself is decoration in every view.
    expect(screen.getByTitle("Game changer")).toHaveAttribute("aria-hidden", "true");
  });

  /**
   * The band is a heading, and pressing one opens nothing.
   *
   * It carries `tabindex="-1"` all the same, and the two are not in tension: a negative index
   * is a place focus can be *put* and never a stop Tab travels through. The editor puts it
   * there when a card leaves this pile under the caret — a stepper reaching zero, or a move
   * landing elsewhere — which is the same hand-off the other three views make to a group's
   * `<section>`. What would make this a row you can open is `tabindex="0"` and an `onClick`,
   * and it has neither.
   */
  it("bands the rows with a heading that is not itself a row you can open", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TableView groups={GROUPS} marketplace={TCG} onSelect={onSelect} />);

    const band = screen.getByText("Ramp").closest("[role=row]");
    expect(band).not.toBeNull();
    expect(band).toHaveAttribute("tabindex", "-1");

    await user.click(band!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  /** The allocator claims nothing for an inactive category, so a badge there would read as
   *  "you own none of these" when the truth is "this deck reserved none". */
  it("draws no owned badge for a card in a switched-off pile", () => {
    render(
      <TableView
        groups={buildGroups(
          [{ ...card({ name: "Avacyn", categoryKind: "maybe" }), ownedQuantity: 4 }],
          [MAYBE],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
      />,
    );

    expect(screen.queryByText("4 in your collection")).not.toBeInTheDocument();
  });
});
