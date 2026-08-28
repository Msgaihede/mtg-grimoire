import { useEffect, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckCategory } from "@/lib/ipc";
import { boxed, startPointerDrag } from "@/test-drag";
import { useCategoryDrop } from "./cardControl";
import { cardDraggable, type DeckWrite, type DragPayload } from "./dnd";
import { QUICK_ZONE_ATTR, QuickCategoryDialog, QuickZones } from "./QuickZones";

/**
 * The bar of drop targets that appears while a card is in the air.
 *
 * **Driven over the drag library's own code path** — `src/test-drag.ts` says how a real press,
 * real pointer moves and a real release reach `@dnd-kit/dom`, and what that costs: jsdom lays
 * nothing out, so every source and every target here is given a box by hand. What is *not*
 * reachable from here and is therefore the live pass's to prove is the whole of the layout claim:
 * that the bar costs no height when it appears, that it sits over the editor's own header rather
 * than over a pile, and that `sticky top-0` keeps it on screen down a long deck.
 *
 * `dropWrite`'s answers are `dnd.test.ts`'s, exhaustively and without a DOM. What is asserted
 * here is that this surface asks it and carries the answer.
 */

const MAIN = 1;
const SIDE = 2;
const MAYBE = 3;

function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  return {
    deckId: 1,
    kind: "main",
    origin: "user",
    isActive: true,
    sortOrder: over.id,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: 0,
    ...over,
  };
}

const CATEGORIES = [
  category({ id: MAIN, name: "Main deck" }),
  category({ id: SIDE, name: "Sideboard", kind: "side" }),
  category({ id: MAYBE, name: "Maybeboard", kind: "maybe", isActive: false }),
];

/** A printing off a wall — the drag the `Auto` zone exists for. */
const TILE: DragPayload = {
  kind: "search-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  typeLine: "Instant",
};

/** A row of this deck, picked up off the desk. */
const ROW: DragPayload = {
  kind: "deck-card",
  finish: null,
  cardId: "c-bolt",
  name: "Lightning Bolt",
  fromCategoryId: MAIN,
};

/** Something to pick up. `cardDraggable` rather than the library's `draggable` directly, so the
 *  payload travels exactly as a card's does from any of the app's four drag sources. */
function Source({ payload }: { payload: DragPayload }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A box of its own, well clear of the bar's: dnd-kit hit-tests by coordinate and jsdom
    // measures every rect as zero, so a source with no box is pressed at the origin — which is
    // inside whatever else has been given a rect there.
    boxed(element, 0);
    return cardDraggable({ element, payload: () => payload });
  }, [payload]);
  return <div ref={ref}>the card</div>;
}

const onDrop = vi.fn<(writes: DeckWrite[]) => void>();
const onNewCategory = vi.fn<(payload: DragPayload) => void>();

function mount(payload: DragPayload) {
  render(
    <>
      <Source payload={payload} />
      <QuickZones categories={CATEGORIES} onDrop={onDrop} onNewCategory={onNewCategory} />
    </>,
  );
  return () => startPointerDrag(screen.getByText("the card"));
}

/** One box, by the label it draws. The bar is `aria-hidden` and two of its four labels are also
 *  headings on the desk behind it, which is what {@link QUICK_ZONE_ATTR} is for. */
function zone(label: string): HTMLElement {
  // **Every zone gets a box, and they are stacked so that no two overlap.** The bar only exists
  // during a drag, so this is where they can first be measured — and a target with no rect is
  // one dnd-kit can never collide with, silently.
  const all = [...document.querySelectorAll<HTMLElement>(`[${QUICK_ZONE_ATTR}]`)];
  all.forEach((element, index) => boxed(element, 100 + index * 60));
  const found = all.find((element) => element.getAttribute(QUICK_ZONE_ATTR) === label);
  expect(found).not.toBeUndefined();
  return found!;
}

function zones(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`[${QUICK_ZONE_ATTR}]`)].map(
    (element) => element.getAttribute(QUICK_ZONE_ATTR) ?? "",
  );
}

beforeEach(() => {
  onDrop.mockReset();
  onNewCategory.mockReset();
});

describe("QuickZones", () => {
  /** Nothing at all until a card is in the air, and gone again the moment it lands — the remove
   *  tray's rule at the other end of the window. */
  it("is drawn only while a card is being dragged", async () => {
    const pick = mount(TILE);
    expect(zones()).toEqual([]);

    const held = await pick();
    expect(zones()).toEqual(["Auto", "New category", "Maybeboard", "Sideboard"]);

    await held.cancel();
    await waitFor(() => expect(zones()).toEqual([]));
  });

  /**
   * The `Auto` zone is the toolbar's `Add to → Auto (by what it does)` as a drop: no category,
   * the card's own type line, and the pile left to `useDeck.addCard`.
   */
  it("files a dragged-in card by what it does", async () => {
    const pick = mount(TILE);

    const held = await pick();
    await held.over(zone("Auto"));
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith([
      {
        write: "auto-add",
        cardId: "c-bolt",
        typeLine: "Instant",
      },
    ]);
  });

  /** A fixed zone is an ordinary category drop — the same write a drop onto that pile's own
   *  heading makes, through the same rule. */
  it("adds a dragged-in card to the sideboard", async () => {
    const pick = mount(TILE);

    const held = await pick();
    await held.over(zone("Sideboard"));
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith([{ write: "add", cardId: "c-bolt", categoryId: SIDE }]);
  });

  /**
   * A card already in the deck is *moved* rather than added, which is `dropWrite`'s answer and
   * not this component's — the point being that the zones carry both kinds of drag.
   */
  it("moves a deck card into the maybeboard", async () => {
    const pick = mount(ROW);

    const held = await pick();
    await held.over(zone("Maybeboard"));
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith([
      {
        write: "move",
        finish: null,
        cardId: "c-bolt",
        from: MAIN,
        to: MAYBE,
      },
    ]);
  });

  /**
   * **`Auto` re-files a card the deck already holds** (changed 2026-08-15; it used to grey and
   * refuse). The write it resolves to is an **address** rather than a destination — the pile is
   * not knowable here, because naming it means reading the card's Oracle tags — so what this
   * pins is that the zone stays live for such a drag and hands the slot up.
   */
  it("re-files a deck card dropped on Auto rather than refusing it", async () => {
    const pick = mount(ROW);

    const held = await pick();
    expect(zone("Auto")).not.toHaveClass("opacity-40");
    await held.over(zone("Auto"));
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith([
      {
        write: "auto-refile",
        cardId: "c-bolt",
        from: MAIN,
        finish: null,
      },
    ]);
  });

  /** A row dropped on the pile it is already in is not a move — `dropWrite` says so, and the
   *  greying is how the bar says it before the reader lets go. */
  it("greys the pile a dragged card is already in", async () => {
    const pick = mount({ ...ROW, fromCategoryId: SIDE });

    const held = await pick();
    expect(zone("Sideboard")).toHaveClass("opacity-40");
    expect(zone("Maybeboard")).not.toHaveClass("opacity-40");

    await held.cancel();
  });

  /** The box the pointer is over says so, and only that one. `DROP_RING`/`DROP_OVER` are the
   *  sidebar's own pair, said here so a drop target reads the same wherever a card is carried. */
  it("marks the box the pointer is over", async () => {
    const pick = mount(TILE);

    const held = await pick();
    await held.over(zone("Sideboard"));
    expect(zone("Sideboard")).toHaveClass("ring-accent");
    expect(zone("Maybeboard")).not.toHaveClass("ring-accent");

    await held.leave();
    await waitFor(() => expect(zone("Sideboard")).not.toHaveClass("ring-accent"));

    await held.cancel();
  });

  /**
   * **New category writes nothing on the drop.** The pile has no name yet and a modal cannot be
   * opened mid-gesture, so what the drop does is hand the payload up — and the payload has to
   * travel, because by the time the dialog is on screen there is no drag left to read it from.
   */
  it("hands the whole payload up when a card lands on New category", async () => {
    const pick = mount(ROW);

    const held = await pick();
    await held.over(zone("New category"));
    await held.drop();

    expect(onNewCategory).toHaveBeenCalledWith(ROW);
    expect(onDrop).not.toHaveBeenCalled();
  });

  /** The pile's own name, not the fixed word — the two agree while the seeded zones cannot be
   *  renamed, and a heading and a drop target reading differently would be two names for one
   *  pile. */
  it("labels a fixed zone with the category's own name", async () => {
    render(
      <>
        <Source payload={TILE} />
        <QuickZones
          categories={[category({ id: SIDE, name: "On the bench", kind: "side" })]}
          onDrop={onDrop}
          onNewCategory={onNewCategory}
        />
      </>,
    );

    const held = await startPointerDrag(screen.getByText("the card"));
    expect(zones()).toEqual(["Auto", "New category", "Maybeboard", "On the bench"]);

    await held.cancel();
  });
});

/**
 * **The bar is drawn on top of the deck and dnd-kit does not care**, which is the one habit
 * pragmatic-dnd left behind and the reason every zone carries a `collisionPriority`.
 *
 * That library hit-tested with `event.target` and walked up with `Element.closest`, so a sticky
 * bar painted over a pile won simply by being on top. dnd-kit's default detector is
 * `pointerIntersection`, which scores a hit as `1 / distance` from a droppable's **centre** and
 * consults no z-index at all — so a short bar over a tall pile loses the pointer to the pile
 * whenever the pile's middle happens to be nearer.
 *
 * The boxes below are chosen so that it does: the pile is 200px tall with its centre at y 200 and
 * the zone is 40px with its centre at y 170, and the pointer sits at y 188 — 12px from the pile's
 * centre and 18 from the zone's. Without the priority the pile takes the drop; with it the zone
 * does, which is what a reader aiming at a box drawn over the deck means.
 */
describe("a zone drawn over a pile", () => {
  /** A pile, as the desk draws one: the other target a card in the air can land on. */
  function Pile({ onDrop: onPile }: { onDrop: (writes: DeckWrite[]) => void }) {
    const { attach } = useCategoryDrop(MAIN, onPile);
    return <div ref={attach} data-pile="" />;
  }

  it("takes the drop from the pile underneath it", async () => {
    const onPile = vi.fn<(writes: DeckWrite[]) => void>();
    render(
      <>
        <Source payload={TILE} />
        <Pile onDrop={onPile} />
        <QuickZones categories={CATEGORIES} onDrop={onDrop} onNewCategory={onNewCategory} />
      </>,
    );

    const held = await startPointerDrag(screen.getByText("the card"));
    // Boxed here rather than through `zone()`, because this case is about two rectangles that
    // deliberately overlap and the helper stacks them clear of each other.
    boxed(document.querySelector<HTMLElement>("[data-pile]")!, 100, 200);
    boxed(document.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="Sideboard"]`)!, 150, 40);
    await held.moveTo(100, 188);
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith([{ write: "add", cardId: "c-bolt", categoryId: SIDE }]);
    expect(onPile).not.toHaveBeenCalled();
  });
});

describe("QuickCategoryDialog", () => {
  const onCreate = vi.fn<(name: string) => void>();

  beforeEach(() => onCreate.mockReset());

  function open(failure: string | null = null, pending = false) {
    render(
      <QuickCategoryDialog
        open
        cardName="Lightning Bolt"
        pending={pending}
        failure={failure}
        onCreate={onCreate}
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  /** It names the card, because the platform's drag preview was the last thing that did and it
   *  is gone by the time this opens. */
  it("says which card is being filed, and takes a name for the pile", async () => {
    open();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("New category name"), "Removal");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith("Removal");
  });

  /** The caret is in the field on open — the one dialog in this editor that does that, because
   *  it is a question and nothing else. */
  it("puts the caret in the field", async () => {
    open();
    await waitFor(() => expect(screen.getByLabelText("New category name")).toHaveFocus());
  });

  /**
   * A blank name is nothing to send. `aria-disabled` rather than the attribute — a `disabled`
   * button leaves the tab order, and in a two-control dialog that is half of what Tab reaches —
   * so the refusal has to be in the handler as well as in the greying.
   */
  it("sends nothing for a blank name, and stays reachable by Tab", async () => {
    open();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();

    // From the field the caret opened in — one stop, which is what the attribute would have
    // taken away.
    screen.getByLabelText("New category name").focus();
    await userEvent.tab();
    expect(create).toHaveFocus();
  });

  /** Whitespace is not a name, and what is sent is the trimmed one. */
  it("trims the name it sends", async () => {
    open();
    await userEvent.type(screen.getByLabelText("New category name"), "  Ramp  ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledWith("Ramp");
  });

  /**
   * A refused create is said **inside** this dialog, and that is not a duplicate of the editor's
   * banner — it is the only place the sentence can be seen, since the banner is behind this
   * dialog's own scrim. The delete confirmation makes the same call for the same reason.
   */
  it("draws a refusal where the reader is looking", () => {
    open("Could not make that category — a category called Ramp already exists");
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
  });
});
