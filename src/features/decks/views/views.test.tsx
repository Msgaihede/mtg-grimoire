import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM, scaled, ZOOM_STEPS } from "@/lib/cardZoom";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { MARKETPLACES, type Marketplace } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { dragOnto } from "@/test-drag";
import { card } from "../validation/fixtures";
import type { ValidationIssue } from "../validation/types";
import { stackCardWidth, stackHeight } from "../CardStack";
import { DECK_GROUP_ATTR, type DeckCardActions } from "../cardControl";
import { deckCardSlot, DECK_CARD_ATTR } from "../dnd";
import { buildGroups, type CardGroup } from "../grouping";
import { SIDEBOARD_ATTR } from "./columns";
import { GridView } from "./GridView";
import { StackView, STACK_COLUMN_ATTR, stackColumnWidth } from "./StackView";
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
    ...over,
  };
}

const RAMP = category();
const COMMANDER = category({ id: 3, name: "Commander", kind: "commander", sortOrder: 0 });
const MAYBE = category({
  id: 5,
  name: "Maybeboard",
  kind: "maybe",
  isActive: false,
  sortOrder: 4,
});
/**
 * The pile the rail exists for.
 *
 * Added beside the three above rather than folded into one of them: every count and every
 * order asserted in this file is a claim about that fixture, and a fourth category in `GROUPS`
 * would have rewritten all of them.
 *
 * `sortOrder` 2 puts it **between** Ramp and the Maybeboard, which is exactly where a greedy
 * in-order pack used to leave it — the middle of a sideways run. The id is `fixtures.ts`'s own
 * for a `side` card, so `card({ categoryKind: "side" })` lands in this category rather than
 * arriving as a stray group.
 */
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 2 });

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
}

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
   * `CategoriesPanel.test.tsx` records as self-repairing. Tab from `<body>` walks the document
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
 * A deck card can be stepped, moved, picked up and dropped on, and every view owes the reader
 * all four — so this is a sweep rather than four tests. They come from one module
 * (`cardControl.tsx`) precisely so that this can be one `describe.each`: four copies would be
 * four chances for one surface to quietly stop offering something, and the failure would be a
 * reader who switched view and lost the ability to remove a card.
 *
 * What differs between them is *placement* — the table spends them as columns, the other three
 * draw them over the card — and placement is the one thing a table and a wall of card faces
 * genuinely disagree about.
 */
describe.each(VIEWS)("$name editing", ({ render: renderView }) => {
  const actions = () => ({
    setQuantity: vi.fn(),
    move: vi.fn(),
    moveTargets: [COMMANDER, RAMP, MAYBE],
    drop: vi.fn(),
  });

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

  /** A native `<select>` and deliberately not a popup: it needs no rung in the editor's Escape
   *  union, no z-index and no focus hand-back. */
  it("moves a card to another category, and never offers it its own", async () => {
    const user = userEvent.setup();
    const spies = draw();

    const select = screen.getByLabelText("Move Sol Ring out of Main deck");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Move…", "Commander", "Maybeboard"]);

    await user.selectOptions(select, String(MAYBE.id));
    expect(spies.move).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sol Ring" }),
      MAYBE.id,
    );
  });

  /**
   * The controls belong to the *slot*, not to the card: the same printing sits in two piles
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
    expect(screen.getByLabelText("Move Serah Farron out of Commander")).toBeInTheDocument();
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
   * view would land every drop in whatever the toolbar's "Add to" happened to say, which is a
   * silent difference between the drag and the button beside it.
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
  /**
   * A `VirtualTable` has one scroller and one band per group, so an empty group is a band and
   * nothing else — there is no column for it to be a place *in*. The other three draw a
   * sentence, because an empty Sideboard is where the next sideboard card goes.
   */
  it.each([
    [
      "StackView",
      <StackView
        key="s"
        groups={buildGroups([], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    ],
    [
      "TextView",
      <TextView
        key="t"
        groups={buildGroups([], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    ],
    [
      "GridView",
      <GridView
        key="g"
        groups={buildGroups([], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    ],
  ])("%s says where the next card goes", (_name, element) => {
    render(element);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByText("0 cards")).toBeInTheDocument();
  });
});

describe("StackView columns", () => {
  const columns = () => [...document.querySelectorAll(`[${STACK_COLUMN_ATTR}]`)];
  /** By the id each section is `aria-labelledby`, which is the heading's own handle rather
   *  than a guess at the header's shape. */
  const headingsIn = (column: Element) =>
    [...column.querySelectorAll('[id^="group-"]')].map((n) => n.textContent);

  /** The zoom is one number for the whole app and this store outlives a test, so a case that
   *  leaves it at 2× would silently re-pack every suite that runs after it. */
  afterEach(() => useAppStore.setState({ cardZoom: DEFAULT_ZOOM }));

  /**
   * Groups are packed into columns in the reader's own order and never split — so a category
   * that outgrows a column keeps every one of its cards, and the pile after it starts a fresh
   * one rather than being interleaved.
   *
   * The columns are read out of the DOM rather than inferred from the cards being present:
   * the first draft of this asserted only that both piles were drawn and twelve cards were in
   * Ramp, which is true of a layout that packed everything into a single column and did no
   * work at all.
   */
  it("packs groups into columns without reordering or splitting them", () => {
    const three = (kind: "main" | "commander") =>
      Array.from({ length: 3 }, (_, i) =>
        card({ name: `${kind} ${i}`, categoryKind: kind, ownedQuantity: 1 }),
      );
    render(
      <StackView
        groups={buildGroups(
          [...three("commander"), ...three("main")],
          [COMMANDER, RAMP, MAYBE],
          "category",
          "alphabetical",
        )}
        // Exactly two three-card groups tall, and **derived rather than typed**: a group is
        // `46 + stackHeight(n) + 20` (header and padding, the stack, the gap), and a card's height
        // is now a Magic card's aspect applied to the column width rather than a number somebody
        // chose — so a hard-coded ceiling here silently stops testing a pack the day the card
        // frame changes shape. It did: this read 950 against a 388px three-card stack, which is
        // 371 now, and all three groups fitted in one column.
        //
        // At exactly two groups the empty Maybeboard's 66 does not fit, so it starts the second
        // column — which is what makes this assert a *pack* rather than a single box.
        marketplace={TCG}
        columnHeight={2 * (66 + stackHeight(3))}
      />,
    );

    expect(columns()).toHaveLength(2);
    // In the sortOrder the reader set, never a shape the packer preferred.
    expect(headingsIn(columns()[0])).toEqual(["Commander", "Ramp"]);
    expect(headingsIn(columns()[1])).toEqual(["Maybeboard"]);
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
   * The 14 is the section's `p-1.5` either side and the card's two hairline borders, neither of
   * which zooms: chrome around a card is not part of one.
   */
  it("sizes a column from the card it holds, at every stop on the ladder", () => {
    for (const zoom of ZOOM_STEPS) {
      expect(stackColumnWidth(zoom)).toBe(stackCardWidth(zoom) + 14);
    }
    // The design canvas's own number, which this has to keep answering where nobody has zoomed.
    expect(stackColumnWidth(DEFAULT_ZOOM)).toBe(224);
  });

  /**
   * …and it reaches the element as an **inline width**, in both halves of the `flex` shorthand.
   *
   * A computed Tailwind class emits no CSS rule at all — the scanner reads source text — so a
   * column sized by an interpolated class would lay itself out at whatever its contents came to
   * and the whole view would drift wider as the reader zoomed. The `flex` basis is the half worth
   * asserting separately: these columns are `flex` children, so a basis left at the old value
   * would win over the width and nothing about the markup would look wrong.
   */
  it("writes the zoomed column width onto the column, basis included", () => {
    useAppStore.setState({ cardZoom: 2 });
    render(
      <StackView
        groups={buildGroups([card({ name: "Sol Ring" })], [RAMP], "category", "alphabetical")}
        marketplace={TCG}
      />,
    );

    const column = columns()[0] as HTMLElement;
    expect(column.style.width).toBe(`${stackColumnWidth(2)}px`);
    expect(column.style.flex).toBe(`0 0 ${stackColumnWidth(2)}px`);
    expect(column.style.width).toBe("434px");
  });

  /**
   * **The pack has to see the zoom, and this is the failure if it does not.**
   *
   * The same three groups and the same desk, twice: at 1× the Commander and Ramp piles share a
   * column, and at 2× they cannot — a stack twice as wide is more than twice as tall, so the
   * second group no longer fits under the first. A packer working from unzoomed heights would
   * answer the top arrangement in both cases and run the last group in every column off the
   * bottom of the desk, which is a layout bug with no error attached to it.
   *
   * Written as contents rather than as a column count on purpose: both arrangements here happen
   * to come to two columns, and it is *which groups share one* that the zoom changes.
   */
  it("packs fewer groups into a column when the cards are bigger", () => {
    const three = (kind: "main" | "commander") =>
      Array.from({ length: 3 }, (_, i) =>
        card({ name: `${kind} ${i}`, categoryKind: kind, ownedQuantity: 1 }),
      );
    const groups = buildGroups(
      [...three("commander"), ...three("main")],
      [COMMANDER, RAMP, MAYBE],
      "category",
      "alphabetical",
    );
    // The same desk in both halves — two 1× three-card groups tall, as the pack above uses.
    const desk = 2 * (66 + stackHeight(3));

    render(<StackView groups={groups} marketplace={TCG} columnHeight={desk} />);
    expect(headingsIn(columns()[0])).toEqual(["Commander", "Ramp"]);
    expect(headingsIn(columns()[1])).toEqual(["Maybeboard"]);
    cleanup();

    useAppStore.setState({ cardZoom: 2 });
    render(<StackView groups={groups} marketplace={TCG} columnHeight={desk} />);
    expect(headingsIn(columns()[0])).toEqual(["Commander"]);
    expect(headingsIn(columns()[1])).toEqual(["Ramp", "Maybeboard"]);
  });

  /** One column when everything fits — the case the assertion above would have passed
   *  against by accident, pinned deliberately instead. */
  it("uses one column when the groups all fit in one", () => {
    render(
      <StackView
        groups={buildGroups(
          [card({ name: "Sol Ring" })],
          [RAMP],
          "category",
          "alphabetical",
        )}
        marketplace={TCG}
        columnHeight={4000}
      />,
    );

    expect(columns()).toHaveLength(1);
  });
});

/**
 * The two views that lay a deck out as columns, and the one number they disagree about.
 *
 * Everything in the block below is true of both — which box a group is drawn in, and how wide
 * that box is — so it is a sweep rather than two copies. The width is the fixture's own field
 * precisely because it is the difference: `StackView`'s column is the card plus its chrome and
 * therefore moves with the reader's zoom, `TextView`'s is a fixed 300px line of text and does
 * not. A view that took the other one's number would pass a sweep that only asked "is there a
 * width".
 */
const COLUMN_VIEWS = [
  {
    name: "StackView",
    render: (props: ViewProps) => <StackView {...props} />,
    /** The id `StackGroup` gives its heading, which is what the section is `aria-labelledby` —
     *  the same handle `StackView columns` reads its packing off. */
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
 * **The Sideboard is pinned to the right, and the columns beside it come down rather than
 * running off the edge.**
 *
 * Both views packed every group into a row of fixed-width columns that grew sideways, so a
 * fifteen-category deck was an X scrollbar across the whole desk — the one thing `DeckEditor`'s
 * 1024px floor exists to prevent, arriving by a route that floor never measured. And the
 * Sideboard, being a category like any other to a greedy in-order pack, landed wherever the
 * pack dropped it: usually the far end of that run, i.e. off screen.
 *
 * Every claim below is about which of the scroller's two boxes a group is in, and how wide that
 * box is. **jsdom lays nothing out**, so none of it can watch a column actually wrap — what a
 * test can see is the inputs CSS applies the rule to, which is what these read.
 */
describe.each(COLUMN_VIEWS)(
  // `$name sideboard rail`, not `$name's`: vitest quotes an interpolated string, so the
  // possessive would print as `'StackView''s`. Same shape as `$name editing` above.
  "$name sideboard rail",
  ({ render: renderView, heading, width, zoomedWidth }) => {
    /** The zoom is one number for the whole app and this store outlives a test — the reason
     *  `StackView columns` resets it, and the same reason here. */
    afterEach(() => useAppStore.setState({ cardZoom: DEFAULT_ZOOM }));

    /** `GROUPS`' deck with a Sideboard in the middle of the reader's own order. */
    const withSideboard = buildGroups(
      [...CARDS, card({ name: "Rest in Peace", categoryKind: "side" })],
      [COMMANDER, RAMP, SIDE, MAYBE],
      "category",
      "alphabetical",
    );

    const rail = () => document.querySelector<HTMLElement>(`[${SIDEBOARD_ATTR}]`);
    /**
     * The box the columns flow in — read as the rail's own **previous** sibling rather than by
     * position in the tree, because the order of the two is load-bearing. `ml-auto` puts the
     * rail at the right of the line it ends; a rail drawn first would be pinned to the left
     * with the whole deck flowing after it, and every other assertion here would still pass.
     */
    const flow = () => rail()!.previousElementSibling as HTMLElement;
    const headingsIn = (root: Element) =>
      [...root.querySelectorAll(`[id^="${heading}"]`)].map((n) => n.textContent);

    const draw = (groups: readonly CardGroup[] = withSideboard, over: Partial<ViewProps> = {}) =>
      render(renderView({ groups, marketplace: TCG, ...over }));

    /**
     * **A `side` group is never packed.** Read as two lists — what is in the flow, and what is
     * in the rail — because either half alone is satisfied by a broken layout: "the Sideboard
     * is in the rail" passes against a view that draws the pile twice, and "the Sideboard is on
     * screen" passed against the packed layout this replaces, which is how the bug survived.
     *
     * The three that stay are asserted **in order**, which is `packColumns`' whole contract:
     * lifting one group out must close the gap up rather than reshuffle what is left.
     */
    it("lifts a side group out of the pack and into the rail", () => {
      draw();

      expect(headingsIn(flow())).toEqual(["Commander", "Ramp", "Maybeboard"]);
      expect(headingsIn(rail()!)).toEqual(["Sideboard"]);
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
     * **The rail is exactly one column wide, inline, in both halves of the `flex` shorthand.**
     *
     * Asserted first against the column beside it — one number read twice out of the DOM, which
     * no later edit can let drift apart — and then against the view's own value, without which
     * two empty strings would agree and pass.
     *
     * Drawn at 2× because that is where the two views part company: `StackView`'s rail has to
     * follow the zoom the cards inside it took, and `TextView`'s has to ignore it. The failure
     * either way is silent — a width built by interpolating a Tailwind class emits no CSS rule
     * at all, so the rail keeps its markup and lays itself out at whatever its contents come to.
     * The basis is worth its own assertion because these are `flex` children: one left at the
     * old value wins over the width, and nothing about the markup looks wrong.
     */
    it("makes the rail one column wide, in both halves of the shorthand", () => {
      useAppStore.setState({ cardZoom: 2 });
      draw();

      const column = flow().firstElementChild as HTMLElement;
      expect(rail()!.style.width).toBe(column.style.width);
      expect(rail()!.style.flex).toBe(column.style.flex);
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
     * No `side` group, no rail — `GROUPS` is Commander, Ramp and the Maybeboard, and none of
     * them is one. A rail drawn unconditionally would hold a column's width of empty space at
     * the right edge of every deck without a sideboard, which reads as a layout that has simply
     * been given too much room rather than as a bug.
     */
    it("draws no rail when nothing in the deck is a sideboard", () => {
      draw(GROUPS);
      expect(rail()).toBeNull();
    });

    /**
     * **A group in the rail is the same group, so a card can still be dropped into it.** The
     * rail is a second place these views draw a pile, and a second, lighter definition of one
     * would take the drop target with it: the card would follow the pointer, the Sideboard would
     * light up nothing, and letting go would do nothing at all.
     *
     * Driven as the real gesture rather than by finding `DECK_GROUP_ATTR`, because the attribute
     * is the half that survives forgetting to call the hook — `deckGroupProps` writes it,
     * `useCategoryDrop` is what makes it a place, and only the drop tells the two apart.
     */
    it("takes a dropped card into the sideboard in the rail", async () => {
      const drop = vi.fn();
      draw(withSideboard, {
        actions: { setQuantity: vi.fn(), move: vi.fn(), moveTargets: [], drop },
      });

      const target = rail()!.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${SIDE.id}"]`);
      expect(target).not.toBeNull();
      const marked = document.querySelector<HTMLElement>(
        `[${DECK_CARD_ATTR}="${deckCardSlot(RAMP.id, "c-Sol Ring")}"]`,
      )!;

      await dragOnto(marked.closest("li") ?? marked, target!);

      expect(drop).toHaveBeenCalledWith({
        write: "move",
        cardId: "c-Sol Ring",
        from: RAMP.id,
        to: SIDE.id,
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
  afterEach(() => useAppStore.setState({ cardZoom: DEFAULT_ZOOM }));

  const wall = () => screen.getByRole("list", { name: "Ramp" });
  const tile = () => within(wall()).getAllByRole("listitem")[0];
  /** The tile's foot — the rarity gem and the price, which is the last thing in the button. */
  const foot = () => tile().querySelector("button")?.lastElementChild as HTMLElement;
  /** The controls' wrapper, which is what carries their offset off the foot. */
  const controls = () => tile().lastElementChild as HTMLElement;

  const draw = (zoom: number) => {
    useAppStore.setState({ cardZoom: zoom });
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
      expect(tile().className.split(" ").filter((c) => c.startsWith("w-"))).toEqual([]);
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
    // 8rem more on the Qty column, which is where the stepper and the move control live.
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
        actions={{ setQuantity: vi.fn(), move: vi.fn(), moveTargets: [], drop: vi.fn() }}
      />,
    );
    expect(fixed(screen.getByText("Arcane Signet").closest("[role=row]") as HTMLElement)).toBe(40);
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
