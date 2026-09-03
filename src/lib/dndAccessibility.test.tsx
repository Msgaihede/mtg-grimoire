import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { dndManager } from "@/lib/dndManager";
import type { CollectionFolder, CollectionRow, DeckCategory, DeckFolder, WishlistFolder } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import type { FolderNode } from "@/lib/folderTree";
import { CollectionFolderCard, type CollectionFolderTotals } from "@/features/collection/CollectionFolderCard";
import { CollectionTable } from "@/features/collection/CollectionTable";
import { WishFolderCard } from "@/features/wishlist/WishFolderCard";
import { FolderTree } from "@/features/decks/FolderTree";
import type { FolderNode as DeckFolderNode } from "@/features/decks/folders";
import { card } from "@/features/decks/validation/fixtures";
import { buildGroups } from "@/features/decks/grouping";
import type { DeckCardActions } from "@/features/decks/cardControl";
import { StackView } from "@/features/decks/views/StackView";
import { TableView } from "@/features/decks/views/TableView";
import { GridView } from "@/features/decks/views/GridView";

/**
 * **What a drag in this app is to a reader who is not holding a mouse — pinned as it is, not as
 * it should be.**
 *
 * 3a removed dnd-kit's `Accessibility` plugin because its DOM mutations take the `listitem` role
 * off a folder card and add a tab stop per row, and kept `KeyboardSensor` on the stated grounds
 * that "dragging a folder from the keyboard is unaffected". 3b then removed `KeyboardSensor` too,
 * for a different reason again — it answers Enter and Space with `preventDefault()` **and**
 * `stopImmediatePropagation()`, and from the moment every card in the app became a drag source
 * that was Enter no longer opening a card. `dndManager.test.ts` fences that one.
 *
 * **So this file is not about either removal. It is the inventory neither of them measured**: for
 * every draggable in the app, what a keyboard can reach and what a screen reader is told. Every
 * assertion here is a **measurement**. If one starts failing, read it as news rather than as a
 * defect — it means the markup under a drag changed, and the decision recorded in
 * `docs/reference/frontend-design.md` may no longer follow from the facts it was taken on.
 *
 * **The registry is the instrument, not `grep`.** `dndManager.registry.draggables` is the same
 * list `Accessibility.registerEffect` walks, and `draggable.handle ?? draggable.element` is the
 * exact expression that plugin uses to pick the element it would stamp and `KeyboardSensor.bind`
 * uses to pick the element it would listen on. Reading it back off a rendered surface answers the
 * question those two ask, rather than the question a source sweep can answer.
 *
 * **Driven in the shipped window on the same day**, `tauri dev` over `scripts/cdp.mjs`, against a
 * copy of the real database: the live manager's `sensors` is `[PointerSensor]`, its `plugins` does
 * not include `Accessibility`, and a real in-flight drag adds nothing to a source but the library's
 * own `data-dnd-dragging` and `popover`. `docs/reference/frontend-design.md` has that pass in full,
 * along with what could not be measured without a screen reader.
 */

/**
 * jsdom lays nothing out, and `@tanstack/react-virtual` sizes its scroller with `offsetHeight`
 * and scrolls through `Element.scrollTo`. The same stub every table test and every table story in
 * this repo installs; without it a virtualised table draws no rows at all and this file's most
 * important measurement would be taken over an empty list.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

/**
 * Whatever is still in the air, let go of — `src/test-drag.ts`'s `afterEach`, spelled here because
 * this file drives its gestures with `userEvent` and imports none of that module's helpers.
 *
 * It is not a precaution. The manager keeps **one** drag operation, and a test that walks away
 * mid-gesture leaves the next one unable to start: `handlePointerDown` returns early unless the
 * operation is idle. Measured while mutating this file on 2026-08-28 — with a keyboard sensor
 * temporarily back in the manager, the drag one case started ran on into the next test, whose
 * `Tab` then walked past the grip and landed on `<body>`. One broken assertion reading as two.
 */
afterEach(() => {
  if (!dndManager.dragOperation.status.idle) {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }
});

/**
 * One animation frame, and **this is not a nicety: without it every absence asserted below is
 * vacuous.**
 *
 * `Accessibility.registerEffect` does not touch the DOM as it runs. It collects its mutations into
 * a set and hands them to `@dnd-kit/dom/utilities`'s `scheduler`, whose backing call is
 * `requestAnimationFrame` — so the `role`, the `tabindex`, the `aria-*` attributes and the two
 * elements it appends to `<body>` all land a frame after the render that registered the draggable.
 *
 * Measured by mutation on 2026-08-28: with the plugin put back into the manager's list and the
 * assertions read synchronously, **every test in this file still passed**. The absences were
 * being read before anything could have written them. Awaiting a frame is what makes the same
 * mutation red, which is the only thing that makes these measurements worth anything.
 */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/** One draggable, described the way the plugin and the keyboard sensor both look at it. */
interface Activator {
  /** The element `draggable.handle ?? draggable.element` resolves to, lower-cased. */
  tag: string;
  /** Its own `role`, or `null` — the plugin stamps `role="button"` only where this is `null`. */
  role: string | null;
  /** Its own `tabindex`, or `null`. `"0"` is a real stop in the Tab order; `"-1"` is not. */
  tabindex: string | null;
  /** Whether the source declared a `handle`, which is what moves the activator off the element. */
  handled: boolean;
}

/**
 * Every draggable currently registered, as its activator.
 *
 * Read after a render rather than built from a fixture: a registration lands on whatever element
 * the feature handed its ref to, and that is the one fact this whole file is about.
 */
function activators(): Activator[] {
  return [...dndManager.registry.draggables].map((draggable) => {
    const element = (draggable.handle ?? draggable.element) as HTMLElement | undefined;
    return {
      tag: element?.tagName.toLowerCase() ?? "(none)",
      role: element?.getAttribute("role") ?? null,
      tabindex: element?.getAttribute("tabindex") ?? null,
      handled: draggable.handle !== undefined,
    };
  });
}

/** Whether the Tab key can land on an activator: a real stop is `tabindex="0"`, or a `<button>`
 *  that has not been taken out of the order. Everything else a reader cannot put the caret on. */
function tabReachable(a: Activator): boolean {
  if (a.tabindex === "0") return true;
  return a.tabindex === null && a.tag === "button";
}

// ---------------------------------------------------------------------------------------------
// The surfaces. Each renders the real component with the smallest props that make it draw, and
// none of them invents markup: the element a registration lands on is the whole measurement, and
// a hand-written stand-in would be measuring the stand-in.
// ---------------------------------------------------------------------------------------------

const COLLECTION_FOLDER: CollectionFolder = {
  id: 3,
  name: "Trade binder",
  parentId: null,
  kind: "user",
  deckId: null,
  sortOrder: 3,
};

const WISH_FOLDER: WishlistFolder = { id: 4, name: "Buy next", parentId: null, sortOrder: 4 };

function collectionNode(): FolderNode<CollectionFolder> {
  return { folder: COLLECTION_FOLDER, depth: 0, count: 0, children: [] };
}

function wishNode(): FolderNode<WishlistFolder> {
  return { folder: WISH_FOLDER, depth: 0, count: 0, children: [] };
}

const ROW_MENU = { onContextMenu: vi.fn(), onKeyDown: vi.fn(), onClick: vi.fn() };

/**
 * A folder card whose name is **not** being edited, which is the state both walls are in here.
 *
 * The rename field replaces the card's own button with an `<input>` and marks its `<form>`
 * `data-no-drag` — a different set of elements, and one press the sensor refuses — where every
 * measurement in this file is about the element a registration lands on. That element is the
 * `<li>` either way, so a renaming card would answer the same question with more moving parts.
 * The field's own drag guard is `CollectionFolderCard.test.tsx`'s.
 */
const RESTING_RENAME = {
  active: false,
  pending: false,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
};

async function renderCollectionWall() {
  render(
    <ul aria-label="Folders">
      <CollectionFolderCard
        node={collectionNode()}
        summary={{ cards: 12, value: 340.25 } as CollectionFolderTotals}
        currency="usd"
        onOpen={vi.fn()}
        rowMenu={ROW_MENU}
        rename={RESTING_RENAME}
        canDrop={() => true}
        onDropCard={vi.fn()}
        canDropFolder={() => true}
        onDropFolder={vi.fn()}
      />
    </ul>,
  );
  await frame();
}

async function renderWishWall() {
  render(
    <ul aria-label="Folders">
      <WishFolderCard
        node={wishNode()}
        summary={null}
        currency="usd"
        onOpen={vi.fn()}
        rowMenu={ROW_MENU}
        rename={RESTING_RENAME}
        canDrop={() => true}
        onDropWish={vi.fn()}
        canDropFolder={() => true}
        onDropFolder={vi.fn()}
      />
    </ul>,
  );
  await frame();
}

const DECK_FOLDER: DeckFolder = { id: 1, parentId: null, name: "Commander", sortOrder: 0 };

async function renderFolderTree() {
  const nodes: DeckFolderNode[] = [{ folder: DECK_FOLDER, depth: 0, count: 2, children: [] }];
  render(
    <TooltipProvider>
      <FolderTree
        nodes={nodes}
        totalDecks={2}
        selectedId={null}
        onSelect={vi.fn()}
        drag={null}
        canDropIn={() => true}
        onDropIn={vi.fn()}
        canDropFolder={() => true}
        onDropFolder={vi.fn()}
        naming={null}
        onOpenNew={vi.fn()}
        onOpenRename={vi.fn()}
        onCloseNaming={vi.fn()}
        onName={vi.fn()}
        busy={false}
        failure={null}
        pending={false}
        rowMenu={() => ({ onContextMenu: vi.fn(), onKeyDown: vi.fn(), onClick: vi.fn() })}
        menuOpenerRef={{ current: null }}
      />
    </TooltipProvider>,
  );
  await frame();
}

const RAMP: DeckCategory = {
  id: 1,
  deckId: 1,
  name: "Ramp",
  kind: "main",
  origin: "user",
  isActive: true,
  sortOrder: 1,
  cardCount: 1,
  totalPrice: null,
  cardCountAllVariants: 1,
};
const DRAW: DeckCategory = { ...RAMP, id: 6, name: "Draw", sortOrder: 2 };

const GROUPS = buildGroups(
  [card({ name: "Sol Ring", categoryId: 1 }), card({ name: "Ponder", categoryId: 6 })],
  [RAMP, DRAW],
  "category",
  "alphabetical",
);

/** A move written by the grip's own arrow keys, so the one keyboard gesture in this file's
 *  subject can be counted rather than described. */
const onMoveCategory = vi.fn();

/**
 * The three things `DeckEditor` wires that this file's measurements depend on, and no more.
 *
 * `drop` is what arms `useDeckCardDrag` — without it a view registers no card sources at all and
 * the inventory would be taken over a deck nobody can drag out of. `menu` is what puts
 * `tabIndex={-1}` on a card, through `deckCardMenuProps`, and **that is a fact worth knowing
 * rather than a fixture detail**: the tab-stop rule `src/CLAUDE.md` states as "`tabIndex={-1}`,
 * never `0`" arrives with the *menu*, not with the drag, so a view mounted without one has cards
 * carrying no `tabindex` at all. Both are unreachable to Tab; only one of them is the shipped
 * editor. `moveCategory` is what draws the grip at all — `StackView` passes `null` to
 * `useCategoryDragSource` without it, so a pile is neither draggable nor reorderable.
 */
function deckActions(): DeckCardActions {
  return {
    drop: vi.fn(),
    moveCategory: onMoveCategory,
    menu: () => ({ onContextMenu: vi.fn(), onKeyDown: vi.fn() }) as never,
  };
}

async function renderDeckView(which: "stack" | "table" | "grid") {
  const props = {
    groups: GROUPS,
    marketplace: MARKETPLACES.tcgplayer,
    actions: deckActions(),
    onSelect: vi.fn(),
  };
  render(
    <TooltipProvider>
      {which === "stack" ? (
        <StackView {...props} />
      ) : which === "table" ? (
        <TableView {...props} />
      ) : (
        <GridView {...props} />
      )}
    </TooltipProvider>,
  );
  await frame();
}

const COLLECTION_ROW: CollectionRow = {
  id: 42,
  cardId: "c1",
  folderId: null,
  folderName: null,
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "nonfoil",
  condition: "NM",
  quantity: 5,
  tradelistQuantity: 0,
  unitPrice: null,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
  promoTypes: null,
  legalities: null,
};

async function renderCollectionTable() {
  render(
    <CollectionTable
      rows={[COLLECTION_ROW]}
      total={1}
      listKey="a11y"
      sort={[]}
      onSort={vi.fn()}
      onNeedNextPage={vi.fn()}
      onSetQuantity={vi.fn()}
      onRemove={vi.fn()}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
  await frame();
}

describe("what a drag is to a screen reader", () => {
  /**
   * **The measurement 3a refused the plugin on, restated so it cannot go stale silently.**
   *
   * `Accessibility.registerEffect` stamps `role="button"` on any activator that is not a
   * `<button>` and carries no role of its own — which is exactly a folder card's `<li>` — and
   * `role="button"` on an `<li>` takes the `listitem` role away, so the wall stops being a list a
   * screen reader can count. Both walls are asserted because both are `<li>`s and only one of
   * them (`CollectionPage.test.tsx`) had a test that would have caught it.
   */
  it("keeps every folder card a listitem, on both walls", async () => {
    await renderCollectionWall();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(activators()).toEqual([{ tag: "li", role: null, tabindex: null, handled: false }]);
  });

  it("keeps every wishlist folder card a listitem too", async () => {
    await renderWishWall();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(activators()).toEqual([{ tag: "li", role: null, tabindex: null, handled: false }]);
  });

  /**
   * The plugin appends a hidden instructions `<div>` and a live region to `<body>`, prefixed
   * `dnd-kit-description` and `dnd-kit-announcement`. It is filtered out of the manager's plugin
   * list, so neither should ever exist — and **this is the assertion that the filter takes effect
   * on a real surface** rather than only in the array literal `dndManager.ts` builds.
   *
   * It is also the whole of what this app says to a screen reader during a drag: nothing.
   */
  it("appends no instructions element and no live region, because nothing writes one", async () => {
    await renderCollectionWall();
    expect(document.querySelector("[id^='dnd-kit-description']")).toBeNull();
    expect(document.querySelector("[id^='dnd-kit-announcement']")).toBeNull();
    expect(document.body.querySelector("[aria-live]")).toBeNull();
  });

  /** The attributes the plugin keeps in step with a drag that the app could **not** pre-empt by
   *  stamping its own (it skips an element that already has a `role` or a `tabindex`, and offers
   *  no opt-out for any of these): measured absent at rest, on the element a reader would grab. */
  it("puts no aria-roledescription, aria-grabbed, aria-pressed or aria-disabled on a source", async () => {
    await renderCollectionWall();
    const [drag] = [...dndManager.registry.draggables];
    const element = drag.element as HTMLElement;
    for (const attribute of [
      "aria-roledescription",
      "aria-describedby",
      "aria-grabbed",
      "aria-pressed",
      "aria-disabled",
    ]) {
      expect(element.getAttribute(attribute), attribute).toBeNull();
    }
  });
});

describe("what a drag is to a keyboard", () => {
  /**
   * **The four surfaces the 3c plan tabulated, confirmed.** Three of them put the registration on
   * an element with no `tabindex` at all and the fourth on one with `tabIndex={-1}`, so none is
   * somewhere a reader can put the caret — which is the whole of why no keyboard drag was ever
   * lost when `KeyboardSensor` went.
   */
  it("puts the deck folder tree's source on a div a caret cannot reach", async () => {
    await renderFolderTree();
    expect(activators()).toEqual([{ tag: "div", role: null, tabindex: null, handled: false }]);
  });

  it("puts a deck card's source on a list item that is out of the tab order", async () => {
    await renderDeckView("grid");
    const cards = activators().filter((a) => a.tag === "li");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((a) => a.tabindex === "-1")).toBe(true);
    expect(cards.some(tabReachable)).toBe(false);
  });

  /**
   * **The one activator the plan predicted a keyboard would reach, and it is a real button.**
   * `useCategoryDragSource` declares the grip as the source's `handle`, so `handle ?? element`
   * resolves to that `<button>` — the element `KeyboardSensor` would have bound its `keydown` to,
   * had the manager still carried one.
   */
  it("puts a pile's source behind a grip button that is in the tab order", async () => {
    await renderDeckView("stack");
    const grips = activators().filter((a) => a.handled);
    expect(grips.length).toBeGreaterThan(0);
    expect(grips.every((a) => a.tag === "button" && a.tabindex === null)).toBe(true);
    expect(grips.every(tabReachable)).toBe(true);
  });

  /**
   * **The finding the 3c plan's table does not have, and the reason this file exists at all.**
   *
   * That table says the four surfaces above are the whole list and that the grip is the *only*
   * tab-reachable draggable in the app. It is not. `VirtualTable` gives its rows
   * `tabIndex: onActivate ? 0 : undefined` so that Enter and Space open the card, and the deck
   * editor's table view registers `useDeckCardDrag` on **that same row element** — one `<div>`
   * carrying `role="row"`, `tabindex="0"`, a `Draggable` and a `Droppable`. Every row of a deck's
   * table view is therefore a drag source a reader can put the caret on.
   *
   * Nothing is broken by it today, because there is no `KeyboardSensor` for the caret to meet.
   * It is written down because it is exactly the shape of thing that would acquire a
   * half-working keyboard drag the moment one came back — and because a decision taken from the
   * plan's table would be taken from a list that is missing its most numerous member.
   */
  it("puts a drag on every row of the deck's table view, which IS in the tab order", async () => {
    await renderDeckView("table");
    const rows = activators().filter((a) => a.role === "row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.tag === "div" && a.tabindex === "0")).toBe(true);
    expect(rows.every(tabReachable)).toBe(true);
  });

  /** The same shape again on the collection's table, by the same route: `onActivate` opens the
   *  card, so `VirtualTable` gives the row a tab stop, and `collectionDraggable` registers on it. */
  it("puts a drag on every row of the collection table, which IS in the tab order", async () => {
    await renderCollectionTable();
    const rows = activators().filter((a) => a.tabindex === "0");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.tag === "div")).toBe(true);
  });

  /**
   * **The claim this file was written for, asked of the surface where it is hardest to be sure
   * of.** `KeyboardSensor` is not in the manager's sensor list, so no press anywhere should start
   * a drag — and the grip is where that would show, because it is the one activator a reader can
   * focus and because `Space` and `Enter` are that sensor's own start codes.
   *
   * The caret is put on the grip the way a reader puts it there — `Tab` from the document, never
   * `element.focus()`, which tests a caret a reader cannot produce.
   */
  it("starts no drag from Space or Enter on the one activator a caret can reach", async () => {
    await renderDeckView("stack");
    const user = userEvent.setup();
    const grip = screen.getAllByRole("button", { name: /^Move / })[0];

    await user.tab();
    while (document.activeElement !== grip && document.activeElement !== document.body) {
      await user.tab();
    }
    expect(document.activeElement).toBe(grip);

    await user.keyboard(" ");
    expect(dndManager.dragOperation.status.idle).toBe(true);
    await user.keyboard("{Enter}");
    expect(dndManager.dragOperation.status.idle).toBe(true);
    // Still on the grip: nothing consumed the press and moved the caret, and nothing scrolled.
    expect(document.activeElement).toBe(grip);
  });

  /**
   * **The same question asked of a table row, and this is the assertion that covers the manager's
   * sensor list rather than one source's.**
   *
   * Measured by mutation on 2026-08-28: putting `KeyboardSensor` back into `dndManager`'s
   * `sensors` array does **not** change what Space does on the grip, because
   * `useCategoryDragSource` passes a per-source `sensors: [PointerSensor…]` and
   * `Draggable`'s effect reads `this.sensors ?? [...manager.sensors]` — a per-source list
   * **replaces** the manager's rather than extending it. So the grip is fenced by its own
   * registration and says nothing about the window.
   *
   * A deck table row is the opposite case and the one that matters: `useDeckCardDrag` goes
   * through `cardDraggable` with the default `notFrom`, which passes **no** `sensors` at all, so
   * that row inherits whatever the manager carries. It is also `tabindex="0"`. If a keyboard
   * sensor ever comes back for the window, this row is where it lands — and `VirtualTable`'s
   * own Enter and Space, which open the card, are what it would take, because
   * `KeyboardSensor.handleStart` answers with `preventDefault()` **and**
   * `stopImmediatePropagation()`.
   */
  it("starts no drag from Space on a deck table row, which inherits the manager's sensors", async () => {
    await renderDeckView("table");
    const user = userEvent.setup();
    const row = document.querySelector<HTMLElement>('[role="row"][tabindex="0"]');
    expect(row).not.toBeNull();

    await user.tab();
    while (document.activeElement !== row && document.activeElement !== document.body) {
      await user.tab();
    }
    expect(document.activeElement).toBe(row);

    await user.keyboard(" ");
    expect(dndManager.dragOperation.status.idle).toBe(true);
    await user.keyboard("{Enter}");
    expect(dndManager.dragOperation.status.idle).toBe(true);
  });

  /**
   * The grip's arrow keys are this app's keyboard reorder, and they are the gesture any future
   * keyboard drag would have to share the grip with. Asserted here so that a sensor added later
   * cannot take them without a red build: `KeyboardSensor`'s codes include all four arrows.
   */
  it("still reorders a pile with the arrow keys on its grip", async () => {
    await renderDeckView("stack");
    const user = userEvent.setup();
    onMoveCategory.mockClear();
    const grip = screen.getAllByRole("button", { name: /^Move / })[0];

    await user.tab();
    while (document.activeElement !== grip && document.activeElement !== document.body) {
      await user.tab();
    }
    expect(document.activeElement).toBe(grip);

    await user.keyboard("{ArrowRight}");

    expect(onMoveCategory).toHaveBeenCalledTimes(1);
    expect(dndManager.dragOperation.status.idle).toBe(true);
  });
});
