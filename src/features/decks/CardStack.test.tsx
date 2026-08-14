import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, scaled, ZOOM_STEPS } from "@/lib/cardZoom";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import {
  CardStack,
  STACK_ADVANCE,
  STACK_CARD_HEIGHT,
  STACK_CARD_WIDTH,
  STACK_CLOSE_DELAY_MS,
  STACK_COLLAPSED_MARGIN,
  STACK_DATA_HEIGHT,
  STACK_DATA_RISE,
  STACK_IMAGE_HEIGHT,
  STACK_LIFTED_MARGIN,
  STACK_OPEN_ATTR,
  STACK_OPEN_DWELL_MS,
  stackAdvance,
  stackCardHeight,
  stackCardWidth,
  stackCollapsedMargin,
  stackDataHeight,
  stackHeight,
  stackImageHeight,
} from "./CardStack";
import { LANDED_ATTR, SELECTED_ATTR } from "./cardControl";
import { card } from "./validation/fixtures";
import type { ValidationIssue } from "./validation/types";

/** Sol Ring is the only card here the collection cannot cover, so the shortage is legible in
 *  one place and its absence is legible everywhere else. */
const CARDS: DeckCard[] = [
  card({
    name: "Sol Ring",
    quantity: 2,
    ownedQuantity: 1,
    unitPrice: 1.99,
    rarity: "uncommon",
  }),
  card({
    name: "Arcane Signet",
    ownedQuantity: 1,
    unitPrice: 0.99,
    colorIdentity: null,
  }),
  card({
    name: "The Great Henge",
    ownedQuantity: 1,
    unitPrice: 38.5,
    colorIdentity: "G",
    gameChanger: true,
  }),
];

/** The names those three cards answer to, once every mark is folded into them. */
const SOL_RING = "Sol Ring, 2 copies, you own 1 of 2";
const SIGNET = "Arcane Signet";
const HENGE = "The Great Henge, game changer";

const list = () => screen.getByRole("list", { name: "Ramp" });
const items = () => screen.getAllByRole("listitem");
/** The open card, as the component itself says which one it is. See `STACK_OPEN_ATTR`. */
const openCard = () => list().querySelector(`[${STACK_OPEN_ATTR}]`);
const openCards = () => list().querySelectorAll(`[${STACK_OPEN_ATTR}]`);

/**
 * The three pointer moves the stack cares about, and they are spelled as `pointerover` /
 * `pointerout` on purpose.
 *
 * **React does not listen for `pointerenter`.** It listens for `over`/`out` and *derives* the
 * enter and leave pairs from the two targets, which is what gives them their non-bubbling
 * boundary semantics — so `fireEvent.pointerEnter` dispatches an event the component never
 * hears, and a test built on it passes by never having fired the handler at all.
 * `userEvent.hover` sends the right pair and the geometry suite uses it; these three exist
 * because `userEvent` cannot be driven under a fake clock (Testing Library's async wrapper
 * waits on a real `setTimeout` it only knows how to advance through Jest).
 */
/** The pointer arrives on a card from outside the stack. */
const arriveOn = (li: Element) => fireEvent.pointerOver(li);
/** The pointer crosses to another card without leaving the stack — no `pointerleave` on the
 *  list, which is exactly the case the close delay is not for. */
const crossTo = (from: Element, to: Element) => fireEvent.pointerOut(from, { relatedTarget: to });
/** The pointer leaves the whole stack, which is what schedules the collapse. */
const leaveStack = (from: Element) => fireEvent.pointerOut(from, { relatedTarget: document.body });

describe("CardStack geometry", () => {
  /**
   * The numbers have to agree or the trick does not work: a card advances the stack by exactly
   * one reveal strip, and the list is the collapsed stack plus one lift's worth of slack.
   *
   * **A card's height is now derived rather than chosen** — it is a Magic card's aspect applied
   * to the width `StackView`'s fixed 14rem column leaves, since the card *is* a whole card image
   * now. So this checks the derivation as well as the sums: get the width or the ratio wrong and
   * every number below moves together, which is exactly the failure a single asserted constant
   * would hide.
   *
   * They decide the whole interaction as well as the look: with card *N* open, card *k*'s top is
   * `k·34` for `k ≤ N`, so stepping to card *N+1* moves exactly one card by 293px and leaves
   * every other top alone.
   *
   * **None of them is a Tailwind literal any more.** The collapsed margin used to be written
   * out as a negative arbitrary-value utility, because Tailwind scans source text and a class
   * assembled at runtime emits no rule at all — so the number existed twice and only prose kept
   * the two in step. `motion` writes the margin as an inline style now, which means the
   * constants below are the only place these numbers live and arithmetic reaches every one of
   * them. (Do not spell that old class here, even in a comment: this file is under `@source`,
   * so naming it would emit a rule for a utility nothing uses.)
   */
  it("advances by one reveal strip per card and leaves one lift of slack", () => {
    // 210px of image at 488×680, rounded, plus the card's own 1px border top and bottom, plus
    // the data line standing under the face less the 4px it rides back up over it.
    expect(STACK_CARD_WIDTH).toBe(210);
    expect(STACK_IMAGE_HEIGHT).toBe(Math.round((STACK_CARD_WIDTH * 680) / 488));
    expect(STACK_IMAGE_HEIGHT).toBe(293);
    expect(STACK_DATA_HEIGHT).toBe(28);
    expect(STACK_DATA_RISE).toBe(4);
    expect(STACK_CARD_HEIGHT).toBe(STACK_IMAGE_HEIGHT + 2 + STACK_DATA_HEIGHT - STACK_DATA_RISE);
    expect(STACK_CARD_HEIGHT).toBe(319);

    expect(STACK_CARD_HEIGHT + STACK_COLLAPSED_MARGIN).toBe(STACK_ADVANCE);
    expect(STACK_ADVANCE).toBe(34);
    expect(STACK_COLLAPSED_MARGIN).toBe(-285);
    expect(STACK_LIFTED_MARGIN).toBe(8);
    // What one step down the stack costs the one card that moves.
    expect(STACK_LIFTED_MARGIN - STACK_COLLAPSED_MARGIN).toBe(293);

    // The canvas's own formula, `34 * cards.length + 293`.
    for (const n of [1, 2, 5, 17]) expect(stackHeight(n)).toBe(34 * n + 293);
    // The last card's bottom edge, with the slack under it.
    expect(stackHeight(5) - (STACK_ADVANCE * 4 + STACK_CARD_HEIGHT)).toBe(STACK_LIFTED_MARGIN);
  });

  it("draws no box for a group with nothing in it", () => {
    expect(stackHeight(0)).toBe(0);
    const { container } = render(<CardStack cards={[]} label="Ramp" currency="usd" />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * **The margin is the animation, and it is written as an inline style now.**
   *
   * It used to be two Tailwind literals — the collapsed margin and a `hover:` lift — and the
   * test in this slot pinned those strings, because nothing else about the lift was reachable
   * from jsdom. `motion` writes `margin-bottom` onto the element instead (which the shipped
   * CSP allows: `style-src-attr`), driven by the open card's index, so the two ends of the
   * geometry are readable rather than merely spelled. That is what this asserts.
   *
   * **The card carries no CSS transition of its own any more**, which is the second half and
   * the reason `lib/tokens.test.ts`'s opt-out sweep no longer has anything here to find. The
   * opt-out that replaces it is `useReducedMotion()` inside the component: the app-wide
   * `MotionConfig reducedMotion="user"` makes transforms and `width`/`height`/`top`/`left`
   * instant and **`margin-bottom` is not in that set**, so a 293px reflow would otherwise run
   * at full travel for a reader who asked their OS for less. That branch is a source fact — it
   * produces no DOM difference under the suite's `skipAnimations` — and the live CDP pass owns
   * proving it, exactly as it owns the paint.
   *
   * Real timers, deliberately: `motion` commits the style on an animation frame, and the fake
   * clock the flip-through tests run on does not drive one.
   */
  it("writes the margin as an inline style, from −285px collapsed to 8px open", async () => {
    const user = userEvent.setup();
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    for (const item of items()) {
      expect(item.style.marginBottom).toBe(`${STACK_COLLAPSED_MARGIN}px`);
      expect(item.className).not.toContain("transition-");
    }

    await user.hover(items()[0]);
    await waitFor(() => expect(items()[0]).toHaveAttribute(STACK_OPEN_ATTR));
    await waitFor(() => expect(items()[0].style.marginBottom).toBe(`${STACK_LIFTED_MARGIN}px`));
    // And nothing else moved: one step, one card.
    expect(items()[1].style.marginBottom).toBe(`${STACK_COLLAPSED_MARGIN}px`);
    expect(items()[2].style.marginBottom).toBe(`${STACK_COLLAPSED_MARGIN}px`);
  });
});

/**
 * **The same arithmetic read at a zoom**, which is the whole of what the reader's ctrl+wheel
 * changes here.
 *
 * Every claim in the suite above is a claim about 1×, and the constants it pins are the base the
 * functions below answer with when nobody has zoomed. What is tested here is that the ladder
 * still derives — width → face → card → advance → margin → list — at each of the ten stops, and
 * that the one number which is *not* a proportion keeps its floor.
 *
 * Pure functions rather than rendered pixels, deliberately: jsdom lays nothing out, so a test
 * that asked how wide a card came out would be reading back the number it had just written. The
 * one render at the bottom asks the only question jsdom can answer honestly — whether the numbers
 * reach the element at all, and as inline styles rather than as classes Tailwind never emitted.
 */
describe("CardStack geometry at a zoom", () => {
  it("answers exactly the base geometry at 1×, function by function", () => {
    expect(stackCardWidth(DEFAULT_ZOOM)).toBe(STACK_CARD_WIDTH);
    expect(stackImageHeight(DEFAULT_ZOOM)).toBe(STACK_IMAGE_HEIGHT);
    expect(stackCardHeight(DEFAULT_ZOOM)).toBe(STACK_CARD_HEIGHT);
    expect(stackAdvance(DEFAULT_ZOOM)).toBe(STACK_ADVANCE);
    expect(stackCollapsedMargin(DEFAULT_ZOOM)).toBe(STACK_COLLAPSED_MARGIN);
    // …and the default really is 1×, so every caller that passes no zoom — the stories, the
    // suite above, `groupHeight` — is asking the question it always asked.
    for (const n of [0, 1, 2, 5, 17]) expect(stackHeight(n)).toBe(stackHeight(n, DEFAULT_ZOOM));
  });

  /**
   * A card is a picture of a card, so its shape is not negotiable: the face is the printed
   * 488×680 applied to whatever width the zoom made, and the border is a hairline that does not
   * scale. Reading the height off the **rounded** width is what keeps the two within half a pixel
   * of the printed proportion at every stop rather than at the round-numbered ones.
   */
  it("keeps a Magic card's shape at every stop on the ladder", () => {
    for (const zoom of ZOOM_STEPS) {
      const width = stackCardWidth(zoom);
      expect(width).toBe(scaled(STACK_CARD_WIDTH, zoom));
      expect(stackImageHeight(zoom)).toBe(Math.round((width * 680) / 488));
      // The *face* is what keeps the printed proportion. The card is the face plus two hairlines
      // and the foot standing under it, and the foot is floored rather than scaled — so the whole
      // card is deliberately not a Magic card's shape below 1×, and only the face has to be.
      expect(stackCardHeight(zoom)).toBe(
        stackImageHeight(zoom) + 2 + (stackDataHeight(zoom) - STACK_DATA_RISE),
      );
      expect(Math.abs(stackImageHeight(zoom) / width - 680 / 488)).toBeLessThan(0.01);
    }

    // The two ends, written out, so a change to the ladder is visible here rather than merely
    // consistent with itself. At 0.5× the foot is still its floored 28 and the face is 146, which
    // is why the card is 172 and not the 148 the face alone would give.
    expect([stackCardWidth(MIN_ZOOM), stackCardHeight(MIN_ZOOM)]).toEqual([105, 172]);
    expect([stackCardWidth(MAX_ZOOM), stackCardHeight(MAX_ZOOM)]).toEqual([420, 639]);
  });

  /**
   * The data line takes the same floor as the reveal strip, and for the same reason: it holds the
   * printing's facts in type that is already at the app's smallest, so a bar scaled to 14px would
   * be shorter than the words in it. Two floors in one file is two chances to "simplify" a `max`
   * away, so both are pinned the same way — the second assertion in each loop is the one that
   * fails if the floor stops doing work.
   */
  it("holds the data line at its floor going down, and grows it going up", () => {
    for (const zoom of ZOOM_STEPS.filter((z) => z < DEFAULT_ZOOM)) {
      expect(stackDataHeight(zoom)).toBe(STACK_DATA_HEIGHT);
      expect(scaled(STACK_DATA_HEIGHT, zoom)).toBeLessThan(STACK_DATA_HEIGHT);
    }
    for (const zoom of ZOOM_STEPS.filter((z) => z > DEFAULT_ZOOM)) {
      expect(stackDataHeight(zoom)).toBe(scaled(STACK_DATA_HEIGHT, zoom));
      expect(stackDataHeight(zoom)).toBeGreaterThan(STACK_DATA_HEIGHT);
    }
    // The rise never moves: it hides the seam under a 7px corner that is a Tailwind class.
    expect(STACK_DATA_RISE).toBe(4);
  });

  /**
   * **The trap in this file, and the one thing here a plain multiply gets wrong.**
   *
   * The reveal strip is a legibility floor rather than a fraction of the card: the quantity chip
   * is drawn over it and is 11px type at every zoom, so a strip scaled to 17px would be covered
   * by the chip of the card below it. It grows above 1× and holds at 34 below, and the second
   * assertion in each loop is what fails the day somebody "simplifies" the `Math.max` away — it
   * says the floor is doing work, not merely agreeing with the multiplication.
   */
  it("holds the reveal strip at its floor going down, and grows it going up", () => {
    for (const zoom of ZOOM_STEPS.filter((z) => z < DEFAULT_ZOOM)) {
      expect(stackAdvance(zoom)).toBe(STACK_ADVANCE);
      expect(scaled(STACK_ADVANCE, zoom)).toBeLessThan(STACK_ADVANCE);
    }
    for (const zoom of ZOOM_STEPS.filter((z) => z > DEFAULT_ZOOM)) {
      expect(stackAdvance(zoom)).toBe(scaled(STACK_ADVANCE, zoom));
      expect(stackAdvance(zoom)).toBeGreaterThan(STACK_ADVANCE);
    }
  });

  /**
   * …and the floor is still nowhere near the card, which is the property that actually has to
   * hold: the collapsed margin is negative at every stop, so every card is pulled up over its
   * neighbour and the pile is painted in document order. An advance that reached the card's own
   * height would stack it the other way round and nothing would throw.
   *
   * A third of the card is a generous ceiling — the real ratio is 23 % at the tightest stop
   * (34 of 148, at half size) and 11.6 % at 1× — chosen so this fails on a mistake rather than
   * on a taste.
   */
  it("never lets one card's reveal approach the height of the card", () => {
    for (const zoom of ZOOM_STEPS) {
      expect(stackCollapsedMargin(zoom)).toBeLessThan(0);
      expect(stackAdvance(zoom)).toBeLessThan(stackCardHeight(zoom) / 3);
      // The reveal is what is left of a card once its successor has covered it, which is the
      // same statement the collapsed margin makes from the other side.
      expect(stackCardHeight(zoom) + stackCollapsedMargin(zoom)).toBe(stackAdvance(zoom));
    }
  });

  /** The list's height is the collapsed stack plus one lift's slack, at whatever size the cards
   *  are — and an empty group draws no box at any zoom. */
  it("gives the list one advance per card and one lift of slack, at every zoom", () => {
    for (const zoom of ZOOM_STEPS) {
      expect(stackHeight(0, zoom)).toBe(0);
      for (const n of [1, 2, 5, 17]) {
        expect(stackHeight(n, zoom)).toBe(
          stackAdvance(zoom) * (n - 1) + stackCardHeight(zoom) + STACK_LIFTED_MARGIN,
        );
      }
      // One more card is one more advance — the property the flip-through's "exactly one card
      // moves" rests on, and it survives the zoom because both sides of it come off `stackAdvance`.
      expect(stackHeight(6, zoom) - stackHeight(5, zoom)).toBe(stackAdvance(zoom));
    }

    // And a bigger card really is a taller stack: ten stops, ten different heights, in order.
    const heights = ZOOM_STEPS.map((zoom) => stackHeight(8, zoom));
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(new Set(heights).size).toBe(ZOOM_STEPS.length);
  });

  /**
   * The numbers reach the DOM, and they reach it as **inline styles**.
   *
   * That is the half jsdom can prove and the half that has silently broken this codebase before:
   * Tailwind scans source text for whole class names, so a size assembled at runtime emits no CSS
   * rule at all — the card would keep its markup, lose its height, and every test that counted
   * elements would go on passing.
   *
   * Read against the 1× answers as well as the 2× ones, because a component that ignored its
   * `zoom` prop entirely would satisfy every `toBe` here that did not.
   */
  it("draws the list, the cards and their margins at the zoom it is given", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" zoom={2} />);

    expect(list().style.height).toBe(`${stackHeight(CARDS.length, 2)}px`);
    expect(list().style.height).not.toBe(`${stackHeight(CARDS.length)}px`);

    for (const item of items()) {
      expect(item.style.marginBottom).toBe(`${stackCollapsedMargin(2)}px`);
    }

    // The card face: the first thing inside the button, and the one number the whole file's
    // arithmetic is about.
    const face = items()[0].querySelector("button")?.firstElementChild as HTMLElement;
    expect(face.style.height).toBe(`${stackImageHeight(2)}px`);
    expect(face.style.height).toBe("585px");
  });
});

/**
 * **The defect this component was rebuilt for, and the two delays that close it.**
 *
 * A closed card is overlapped by 285px by its successor, so the only hittable part of one is
 * its 34px strip — which means a continuous downward sweep crosses four or five of them in
 * ~60ms. Under the CSS `:hover` this replaced, every one of those armed instantly and the
 * reader landed several cards below the one they aimed at. What was missing was hover intent:
 * an open dwell, so a sweep commits to nothing until it settles, and a close delay that
 * *arming another card cancels*, so crossing between two cards never shows a closed stack.
 *
 * The clock is fake and only `setTimeout` is faked — `requestAnimationFrame` is left real so
 * `motion` is never mid-anything these assertions can trip over. What is read is the component's
 * own answer to "which card is open" (`STACK_OPEN_ATTR`), which React commits synchronously.
 */
describe("CardStack flip-through", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const mount = () =>
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" onSelect={vi.fn()} />);

  /** Advance the fake clock and let React commit whatever that woke. */
  const tick = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  /**
   * **The sweep.** Three strips crossed, none of them dwelt on, and nothing opens — then the
   * one the pointer settles on does. This is the whole bug: before the dwell, this sequence
   * opened and closed three cards and left the third one up.
   */
  it("opens nothing while the pointer is still crossing strips", async () => {
    mount();

    arriveOn(items()[0]);
    await tick(STACK_OPEN_DWELL_MS - 1);
    expect(openCard()).toBeNull();

    for (const index of [1, 2]) {
      crossTo(items()[index - 1], items()[index]);
      await tick(STACK_OPEN_DWELL_MS - 1);
      expect(openCard()).toBeNull();
    }

    // Standing still on the last of them is what commits, and it commits to that one only.
    await tick(1);
    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[2]);
  });

  it("opens exactly one card once the pointer settles", async () => {
    mount();

    arriveOn(items()[1]);
    expect(openCard()).toBeNull();
    await tick(STACK_OPEN_DWELL_MS);

    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[1]);
  });

  /**
   * **Arming a card cancels a pending close, and this is the frame it exists for.**
   *
   * The close is scheduled 180ms out; the second card's dwell commits at 200ms. Without the
   * cancel the stack would be fully closed for those twenty milliseconds — and in the real
   * gesture, for however long the reader takes between two cards. The assertion at 199ms is
   * the one that fails if the cancel is dropped.
   */
  it("never shows a closed stack while the reader crosses to the next card", async () => {
    mount();

    arriveOn(items()[0]);
    await tick(STACK_OPEN_DWELL_MS);
    expect(openCard()).toBe(items()[0]);

    // The pointer leaves the stack, which schedules the collapse rather than performing it.
    leaveStack(items()[0]);
    await tick(STACK_CLOSE_DELAY_MS - 60);
    expect(openCard()).toBe(items()[0]);

    // …and arriving on another card cancels it. 120 + 79 = 199ms in, nineteen past the moment
    // the collapse was due, and card 0 is still the one standing.
    arriveOn(items()[1]);
    await tick(STACK_OPEN_DWELL_MS - 1);
    expect(openCard()).toBe(items()[0]);

    await tick(1);
    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[1]);
  });

  it("closes after the delay when the pointer leaves the stack, and not before", async () => {
    mount();

    arriveOn(items()[0]);
    await tick(STACK_OPEN_DWELL_MS);
    leaveStack(items()[0]);

    await tick(STACK_CLOSE_DELAY_MS - 1);
    expect(openCard()).toBe(items()[0]);
    await tick(1);
    expect(openCard()).toBeNull();
  });

  /**
   * **The caret does not dwell.** A pointer crossing a strip may not have meant it; a reader
   * who moved the caret did, so a delay there is lag and nothing else. The close delay is
   * kept, because stepping between two cards would otherwise collapse the stack between them.
   *
   * Focus is put on the button by hand rather than by `userEvent.tab()`, for the fake clock's
   * sake — the tab *order* is a different claim and `reaches every card with the keyboard`
   * makes it on a real one.
   */
  it("opens at once for the caret, and closes on the same delay as the pointer", async () => {
    mount();
    const buttons = screen.getAllByRole("button");

    act(() => buttons[0].focus());
    expect(buttons[0]).toHaveFocus();
    // No tick at all: the caret does not wait out the dwell.
    expect(openCard()).toBe(items()[0]);

    act(() => buttons[1].focus());
    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[1]);

    // Off the stack entirely: still up, and down after the delay.
    act(() => buttons[1].blur());
    expect(openCard()).toBe(items()[1]);
    await tick(STACK_CLOSE_DELAY_MS);
    expect(openCard()).toBeNull();
  });

  /** A dwell that outlives its stack would call `setState` on a component that is gone — and
   *  a group unmounts whenever the deck regroups, which is every card write. */
  it("takes its timers with it when the group unmounts", () => {
    const { unmount } = render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    arriveOn(items()[0]);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The pile's **resting state**, which used to be "closed" and is now "the picked card".
 *
 * The defect it fixes needs no fake clock to state: a reader clicks a card to read it in the
 * pane docked beside the deck, moves the pointer off the stack to get there, and the card they
 * are reading about drops back into the pile. The card pane is open on it, the deck says
 * nothing.
 */
describe("CardStack selection", () => {
  const mountPicked = (cardId: string | null) =>
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" selectedCardId={cardId} />);

  it("rests on the picked card rather than on a closed pile", () => {
    mountPicked(CARDS[1].cardId);

    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[1]);
  });

  /** Still exactly one, which is the property the whole geometry note at the top of
   *  `CardStack.tsx` is arithmetic about — two open cards would push the tail of the pile twice
   *  as far over whatever is drawn below it. */
  it("opens nothing at all when the picked card is in another pile", () => {
    mountPicked("c-Somewhere Else");

    expect(openCards()).toHaveLength(0);
  });

  /**
   * The mark is an attribute rather than a class assertion on purpose — see `SELECTED_ATTR`.
   * One card carries it, and it is the same card the pile is resting open on.
   */
  it("marks the picked card, and only it", () => {
    mountPicked(CARDS[2].cardId);

    const marked = list().querySelectorAll(`[${SELECTED_ATTR}]`);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(items()[2]);
    expect(openCard()).toBe(items()[2]);
  });

  /** Nothing picked is the old behaviour exactly, which is what keeps every other case in this
   *  file a claim about the flip-through rather than about the selection. */
  it("marks nothing and opens nothing when no card is picked", () => {
    mountPicked(null);

    expect(list().querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(0);
    expect(openCards()).toHaveLength(0);
  });
});

describe("CardStack landed mark", () => {
  const mountLanded = (landed: ReadonlyMap<number, number>) =>
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" landed={landed} />);

  /**
   * **Inside the card's face, which is the whole of why it can be found in a fanned pile.**
   *
   * A collapsed card is overlapped by its successor by all but the 34px of its own printed title
   * bar, and that strip is the top of the face. A mark drawn on the card's outer element instead
   * would have three of its four edges painted over by the next card, and the reader would be
   * told a card had landed somewhere in this pile without being told which one.
   */
  it("draws the mark inside the card's face, where a collapsed card still shows it", () => {
    mountLanded(new Map([[CARDS[1].id, 1]]));

    const marks = list().querySelectorAll(`[${LANDED_ATTR}]`);
    expect(marks).toHaveLength(1);
    expect(items()[1].contains(marks[0])).toBe(true);
    expect(marks[0].closest("button")).not.toBeNull();
  });

  /**
   * **A second add of the same card has to be a new element, or nothing happens on screen.**
   *
   * The fade is a CSS animation and a CSS animation runs once per element — so a card still
   * glowing from its first copy would take a second one in silence: the count goes up and the
   * card the reader was told to look at does not so much as blink. The nonce in the map is
   * passed straight through as React's `key` for exactly this, and element identity is the only
   * honest way to ask about it.
   */
  it("replays the mark when the same card lands again", () => {
    const { rerender } = mountLanded(new Map([[CARDS[1].id, 1]]));
    const first = list().querySelector(`[${LANDED_ATTR}]`);

    rerender(
      <CardStack cards={CARDS} label="Ramp" currency="usd" landed={new Map([[CARDS[1].id, 2]])} />,
    );

    const second = list().querySelector(`[${LANDED_ATTR}]`);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("draws nothing when nothing has landed", () => {
    mountLanded(new Map());

    expect(list().querySelectorAll(`[${LANDED_ATTR}]`)).toHaveLength(0);
  });
});

describe("CardStack selection and the pointer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  /**
   * **The hover wins while there is one, and what it falls back to is the picked card.**
   *
   * Both halves matter and only the second is new. A reader running down a pile has to be able
   * to look at a card that is not the one they picked — otherwise picking one would freeze the
   * flip-through — and when they stop, the pile has to go back to the card the pane is about
   * rather than to nothing.
   */
  it("lets the pointer open a neighbour, and comes back to the picked card", async () => {
    render(
      <CardStack cards={CARDS} label="Ramp" currency="usd" selectedCardId={CARDS[0].cardId} />,
    );
    expect(openCard()).toBe(items()[0]);

    arriveOn(items()[2]);
    await tick(STACK_OPEN_DWELL_MS);
    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[2]);

    leaveStack(items()[2]);
    await tick(STACK_CLOSE_DELAY_MS);
    expect(openCards()).toHaveLength(1);
    expect(openCard()).toBe(items()[0]);
  });
});

describe("CardStack does not reflow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  /**
   * **The rule the whole component exists for.** The list's height is a function of the card
   * count and nothing else, so opening a card cannot resize the group — the header above it
   * does not move, and neither does any group under it in the column.
   *
   * It was `hovering_a_card_does_not_change_the_group_height`, and the rename is the point:
   * the old version could only *drive the gestures that would set a hover state if one
   * existed*, because the lift was CSS and jsdom applies none. There is a state now, this test
   * really opens a card — the assertion on `STACK_OPEN_ATTR` is what says so — and the height
   * is read back across an open, a close and a focus. It fails the day `stackHeight`'s answer
   * learns which card is up.
   *
   * What it cannot see is the paint. That is the live pass's, and the numbers it would
   * measure are pinned by the geometry suite above.
   */
  it("opening_a_card_does_not_change_the_group_height", async () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" onSelect={vi.fn()} />);

    const before = list().style.height;
    expect(before).toBe(`${stackHeight(CARDS.length)}px`);

    // The first card, which every card after it is pushed down by; then the last, which
    // nothing follows.
    for (const index of [0, CARDS.length - 1]) {
      arriveOn(items()[index]);
      await tick(STACK_OPEN_DWELL_MS);
      expect(items()[index]).toHaveAttribute(STACK_OPEN_ATTR);
      expect(list().style.height).toBe(before);

      leaveStack(items()[index]);
      await tick(STACK_CLOSE_DELAY_MS);
      expect(openCard()).toBeNull();
      expect(list().style.height).toBe(before);
    }

    // And the caret, which does the same thing the pointer does.
    act(() => screen.getByRole("button", { name: SOL_RING }).focus());
    expect(items()[0]).toHaveAttribute(STACK_OPEN_ATTR);
    expect(list().style.height).toBe(before);
  });

  /**
   * **And the controls cannot change it either**, which is the claim worth making twice.
   *
   * A stepper was added to every card after this component was built, and the obvious place to
   * put it — in the card, under the data line — would have made {@link STACK_CARD_HEIGHT} a lie
   * and every number above it with it. It is drawn *over* the card instead, absolutely
   * positioned, so it takes no height at all: the same card is still 319px whether it can be
   * edited or not, and `stackHeight` never learns that actions exist.
   *
   * This is the test that fails the day somebody puts them in the flow — including the day the
   * `Move…` select removed on 2026-08-14 comes back in some other form. It is deliberately not
   * "the classes contain `absolute`" — it is the height, measured both ways, which is the thing
   * that actually has to hold.
   */
  it("keeps its height when its cards carry controls", () => {
    const actions = { setQuantity: vi.fn(), drop: vi.fn() };
    const { unmount } = render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);
    const plain = list().style.height;
    unmount();

    render(<CardStack cards={CARDS} label="Ramp" currency="usd" actions={actions} />);

    expect(list().style.height).toBe(plain);
    expect(list().style.height).toBe(`${stackHeight(CARDS.length)}px`);
    // …and the controls really are there, so this is not passing by drawing nothing.
    expect(screen.getByRole("button", { name: "Decrease Copies of Sol Ring in Main deck" }));
  });

  /**
   * The other half of the same idea, and neither works alone: the height is what stops the
   * group resizing, and `overflow: visible` is what lets the open card — and the cards it
   * pushes down — leave the box instead of being clipped inside it.
   */
  it("lets an open card leave the box rather than clipping it", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);
    expect(list().className).toContain("overflow-visible");
  });

  /**
   * **The stack comes forward; a card in it never does.** Two different questions that used to
   * be answered with the same class:
   *
   * The *list* is raised while anything is open, because the cards it pushes down leave its box
   * on purpose and would otherwise be painted over by the next group in the column.
   *
   * A *card* is not, and this is the assertion that matters. These are `relative` siblings, so
   * painting order is document order — every card is drawn over the one before it, which is the
   * stacked look itself. Raising the open one inverts that against the whole tail of the stack,
   * and it does it on the first frame, while the cards after it are still 293px from where they
   * are going: the card appears to jump in front and the stack catches up around it. Letting
   * them uncover it is the whole of the fix, and once they settle nothing is over it anyway.
   *
   * It used to be a pair of `LAYER` entries spelling `hover:` and `focus-within:` variants,
   * which meant every card in every stack carried both rules whether or not anything was open —
   * so a variant could not have said this even to be wrong.
   */
  it("raises the stack but never a card in it", async () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    for (const element of [list(), ...items()]) {
      expect(element.className).not.toContain(LAYER.raised);
    }

    arriveOn(items()[1]);
    await tick(STACK_OPEN_DWELL_MS);

    // The group, yes.
    expect(list().className).toContain(LAYER.raised);
    // The open card, no — nor any of its neighbours. Document order is the whole z-order.
    expect(openCard()).toBe(items()[1]);
    for (const element of items()) {
      expect(element.className).not.toContain(LAYER.raised);
    }
  });
});

describe("CardStack cards", () => {
  it("reaches every card with the keyboard, in the order they are stacked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" onSelect={onSelect} />);

    await user.tab();
    expect(screen.getByRole("button", { name: SOL_RING })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: SIGNET })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Arcane Signet");
  });

  /** A press on a card opens it in the pane, once — and the flip-through, which now hears the
   *  focus that press causes, must not have turned one press into two. */
  it("opens a card once when it is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: HENGE }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("The Great Henge");
  });

  /**
   * **The focus outline is drawn inside the card's own edge**, and it has to be: the button
   * fills an `overflow-hidden` `<li>`, so an outline standing 2px *off* it is painted
   * entirely in the clipped region and is never seen. A positive offset here is not a
   * smaller ring — it is no focus indicator at all, WCAG 2.4.7, and invisible to anyone
   * testing with a mouse. `VirtualTable`'s rows already document the same trap.
   */
  it("keeps the focus outline inside the box that clips it", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("focus-visible:-outline-offset-2");
      expect(button.className).not.toContain("focus-visible:outline-offset-2");
    }
  });

  it("draws the copies, the rarity, the printing and its own price over the card", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    // The copies badge — 2 of the Sol Ring, and nothing else on screen is a bare "2".
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("$1.99")).toBeInTheDocument();
    expect(screen.getAllByText("LEA · 161")).toHaveLength(3);
    // `RarityGem` names the rarity even where it only draws a dot ("Rarity: uncommon").
    expect(screen.getAllByText(/uncommon/)).not.toHaveLength(0);
  });

  /**
   * The data line writes its price in the marketplace's currency — this line is the only place
   * a deck card states a number of its own, so a stale currency here would be a card claiming
   * a price the strip above it does not agree with.
   *
   * The row is what a **Cardmarket** read answers, because that is the shape the whole feature
   * turns on: switching changes the rows rather than which field a cell reads.
   */
  it("prices a card in the currency it is given", () => {
    render(
      <CardStack
        cards={[card({ name: "Sol Ring", unitPrice: 1.5 })]}
        label="Ramp"
        currency="eur"
      />,
    );

    expect(screen.getByText("€1.50")).toBeInTheDocument();
    expect(screen.queryByText("$1.50")).not.toBeInTheDocument();
  });

  /**
   * A card the selected marketplace does not quote — an etched printing on Cardmarket, where
   * `eur_etched` is not a key Scryfall's data has — arrives with a `null` price and draws an em
   * dash. There is no second number on the row to borrow.
   */
  it("draws an em dash for a card unpriced in this currency", () => {
    render(
      <CardStack
        cards={[card({ name: "Etched Bomb", unitPrice: null })]}
        label="Ramp"
        currency="eur"
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$38.50")).not.toBeInTheDocument();
  });

  /**
   * **The frame is drawn under every card, whether or not a picture arrives to cover it.**
   *
   * It used to be the picture's `else`, which made the commonest state of this component its
   * worst: a category is a wall of lazy `<img>`s, and until each one's bytes land its card was
   * a grey box. The card is known before its picture is, so the app now draws what it knows —
   * name, cost, type line — and the photograph paints over it when it arrives.
   *
   * That is the assertion here, and its converse: the printed card is still the card, so the
   * `<img>` is `alt=""` decoration, and the *accessible* name is still `deckCardName`'s on the
   * button. A card whose only name were inside a decorative image is one a screen reader cannot
   * tell from any other.
   */
  it("draws the frame under the picture, and still names the card on the button", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    // The frame is there, under the art: the name in text and the cost as `mana-font` pills.
    expect(screen.getByText("Sol Ring")).toBeInTheDocument();
    expect(document.querySelectorAll("i.ms-cost")).toHaveLength(CARDS.length);
    // Its reason band says nothing while a picture is on its way — a backdrop is not a state.
    for (const reason of ["No image", "No card", "Retrying…"]) {
      expect(screen.queryByText(reason)).not.toBeInTheDocument();
    }

    // The picture is the card, and it is decoration: the button beside it does the talking.
    const art = document.querySelectorAll("img");
    expect(art).toHaveLength(CARDS.length);
    for (const image of art) expect(image).toHaveAttribute("alt", "");
    expect(screen.getByRole("button", { name: SOL_RING })).toBeInTheDocument();
  });

  /**
   * …and where the picture cannot be drawn, the same frame says why.
   *
   * An orphan is the case that reaches it without a network: its printing has left `cards`, so
   * nothing is fetched at all, and a tile reading only "No card" would be the one place in the app
   * that shows a deck card without saying which card it is.
   */
  it("writes the name in the fallback when there is no picture to draw", () => {
    render(
      <CardStack
        cards={[card({ name: "Gone Card", needsReview: "This printing has left the database." })]}
        label="Ramp"
        currency="usd"
      />,
    );

    expect(screen.getByText("Gone Card")).toBeInTheDocument();
    expect(screen.getByText("No card")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  /**
   * The shortage is drawn as a red figure and **said in the button's name**, which is the
   * only text inside an `aria-label`-ed button that anybody hears. An `sr-only` span here
   * would be announced to nobody — which is how a keyboard reader came to get no word of the
   * one number on this card that is about them.
   */
  it("says how many copies are missing, in the figure and in the name", () => {
    render(<CardStack cards={CARDS} label="Ramp" currency="usd" />);

    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SOL_RING })).toBeInTheDocument();
    expect(SOL_RING).toContain("you own 1 of 2");
    // The two fully covered rows print nothing and say nothing.
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
    expect(SIGNET).not.toContain("you own");
  });

  /** The allocator claims no copy for an inactive category, so every card in one reads 0
   *  owned by construction — a shortage there is one the reader does not have. */
  it("never calls an inactive category short of copies", () => {
    render(
      <CardStack
        cards={[card({ name: "Avacyn", quantity: 3, ownedQuantity: 0, categoryActive: false })]}
        label="Maybeboard"
        currency="usd"
      />,
    );

    expect(screen.queryByText("0/3")).not.toBeInTheDocument();
  });

  /**
   * **The tag and the copy count are one mark now**, and this is what says so: there is no
   * second element carrying the tag, the count is drawn on it, and both facts are in the one
   * `title`. A stack's reveal strip is 34px and was spending it twice to say two things a
   * reader takes in as one.
   */
  it("shows a tag as the colour of the copy count, with both facts behind it", () => {
    render(
      <CardStack
        cards={[
          card({
            name: "Sol Ring",
            quantity: 3,
            ownedQuantity: 1,
            tagId: 1,
            tagName: "Wincon",
            tagColor: "moss",
          }),
        ]}
        label="Ramp"
        currency="usd"
      />,
    );

    // One mark, carrying the count as its text and the tag as its colour.
    const tag = screen.getByTitle("Wincon · 3 in this pile");
    expect(tag).toHaveAttribute("aria-hidden", "true");
    expect(tag).toHaveTextContent("3");
    expect(tag.style.backgroundColor).toBe("var(--color-pie-g)");
    // The word itself is in the button's name, which is the only place a reader inside a
    // labelled button hears anything.
    expect(
      screen.getByRole("button", { name: "Sol Ring, 3 copies, you own 1 of 3, Wincon" }),
    ).toBeInTheDocument();
  });

  /** An untagged card still needs a colour under its count, and it is the colourless deep —
   *  never the gold a missing token falls to, or gold would stop being something a tag says. */
  it("draws an untagged card's count on the colourless deep", () => {
    render(<CardStack cards={[card({ name: "Sol Ring" })]} label="Ramp" currency="usd" />);

    const tag = screen.getByTitle("1 in this pile");
    expect(tag.style.backgroundColor).toBe("var(--color-pie-c)");
  });

  /**
   * Every mark on a card is decoration and says so, which is `FoilOverlay`'s rule for
   * `FoilOverlay`'s reason: an `aria-label` replaces its element's content, so an `sr-only`
   * span inside one of these buttons is announced to nobody and only looks accessible.
   */
  it("marks every badge as decoration, and says all of it in the name instead", () => {
    render(
      <CardStack
        cards={[
          card({
            name: "Mana Crypt",
            quantity: 2,
            ownedQuantity: 0,
            gameChanger: true,
            tagId: 1,
            tagName: "Fast mana",
            tagColor: "ember",
          }),
        ]}
        label="Ramp"
        currency="usd"
        violations={
          new Map([
            [
              "c-Mana Crypt",
              [
                {
                  severity: "error" as const,
                  code: "banned",
                  message: "Mana Crypt is banned in Commander.",
                  cardIds: ["c-Mana Crypt"],
                },
              ],
            ],
          ])
        }
      />,
    );

    // The banner's own words are inside it, so the element carrying `aria-hidden` is the mark
    // rather than the text — `closest` asks the question the way the DOM answers it.
    for (const label of ["Game Changer", "RULE BREAK", "0/2"]) {
      expect(screen.getByText(label).closest("[aria-hidden]")).not.toBeNull();
    }
    expect(screen.getByTitle("Fast mana · 2 in this pile")).toHaveAttribute("aria-hidden", "true");

    expect(
      screen.getByRole("button", {
        name: "Mana Crypt, 2 copies, you own 0 of 2, Fast mana, game changer, rule break: Mana Crypt is banned in Commander.",
      }),
    ).toBeInTheDocument();
  });
});

describe("CardStack tooltips", () => {
  /**
   * **Every mark on a card carries its own sentence for the pointer**, and that is a separate
   * contract from the accessible name.
   *
   * `deckCardName` on the button is what a screen reader gets, and it is the *whole* of what one
   * gets — an `aria-label` replaces its element's content, so every `sr-only` span inside these
   * marks is announced to nobody. A sighted reader using a pointer has the opposite problem:
   * they can see a 6px gold dot, a slanted colour tag and a crown, and none of those is a word.
   * The `title` is what closes that half, and it is per mark rather than per card because the
   * question a reader has is about the mark they are pointing at.
   *
   * The rarity gem is the one worth naming: it is drawn here **without** its word, so the colour
   * was the entire message until `RarityGem` grew a `title` of its own.
   */
  it("gives every mark on a card its own sentence for the pointer", () => {
    render(
      <CardStack
        cards={[
          card({
            name: "Mana Crypt",
            quantity: 2,
            ownedQuantity: 0,
            rarity: "mythic",
            gameChanger: true,
            tagId: 1,
            tagName: "Fast mana",
            tagColor: "ember",
            finishes: JSON.stringify(["foil"]),
          }),
        ]}
        label="Ramp"
        currency="usd"
        violations={
          new Map([
            [
              "c-Mana Crypt",
              [
                {
                  severity: "error" as const,
                  code: "banned",
                  message: "Mana Crypt is banned in Commander.",
                  cardIds: ["c-Mana Crypt"],
                },
              ],
            ],
          ])
        }
      />,
    );

    for (const sentence of [
      // The tag and the count are one mark, so one `title` says both.
      "Fast mana · 2 in this pile",
      "Game changer",
      "Mana Crypt is banned in Commander.",
      // The gem's colour, in a word — the data line draws no rarity text.
      "Mythic",
      // What the three-letter code stands for. `PF26` is not a word anybody knows.
      "Limited Edition Alpha · #161",
      "You own 0 of the 2 this deck wants",
      // `FinishMark`'s own `<title>`, which is how an SVG says it.
      "Foil",
    ]) {
      expect(screen.getByTitle(sentence)).toBeInTheDocument();
    }
  });

  /** An untagged card still answers the question the colour raises — the count alone, with no
   *  tag name invented for it. */
  it("says only the count on an untagged card", () => {
    render(
      <CardStack cards={[card({ name: "Sol Ring", quantity: 4 })]} label="Ramp" currency="usd" />,
    );

    expect(screen.getByTitle("4 in this pile")).toBeInTheDocument();
  });

  /**
   * **An orphan's printing gets no tooltip at all, and that is the honest answer.**
   *
   * `setCode` and `collectorNumber` are denormalised onto `deck_cards` precisely so a printing
   * that has left the corpus is still listed and counted; `setName` is read from `cards`, which
   * no longer has the row. The code stands on its own rather than being annotated with a guess.
   */
  it("leaves the printing unannotated when the set's name is not known", () => {
    render(
      <CardStack
        cards={[card({ name: "Gone Card", setName: null, needsReview: "It left the database." })]}
        label="Ramp"
        currency="usd"
      />,
    );

    expect(screen.getByText("LEA · 161")).not.toHaveAttribute("title");
  });
});

describe("CardStack marks", () => {
  const banned: ValidationIssue = {
    severity: "error",
    code: "banned",
    message: "Mana Crypt is banned in Commander.",
    cardIds: ["c-Mana Crypt"],
  };

  const withIssue = () =>
    render(
      <CardStack
        cards={[
          card({ name: "Mana Crypt", gameChanger: true }),
          card({ name: "Sol Ring", gameChanger: true }),
        ]}
        label="Ramp"
        currency="usd"
        violations={new Map([["c-Mana Crypt", [banned]]])}
      />,
    );

  /**
   * The spec's own requirement: a rule break and a game changer must not be confusable,
   * because one is a problem and the other is a fact about a powerful card. Four things
   * separate them and this pins all four — the words, the colour, the place, and the card's
   * own edge, which only a rule break changes.
   */
  it("tells a rule break and a game changer apart four ways", () => {
    withIssue();
    const [first, second] = screen.getAllByRole("listitem");
    const mark = screen.getByText("RULE BREAK");
    const banners = screen.getAllByTitle("Game changer");

    // The words, and the whole sentence behind them — in the mark's `title` for the pointer
    // and in the card's own name for everyone else. Both marks are spelled out on this
    // surface, which is what makes the other three separations carry the whole load.
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveAttribute("title", "Mana Crypt is banned in Commander.");
    expect(
      screen.getByRole("button", {
        name: /rule break: Mana Crypt is banned in Commander\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Game Changer")).toHaveLength(2);

    // The colour: destructive for the break, the deep gold stamp for the banner.
    expect(mark.className).toContain("text-destructive");
    expect(banners[0].className).toContain("bg-pie-gold-deep");
    expect(banners[0].className).not.toContain("destructive");

    // The place: the break is the card's top-right corner, the banner is in the title strip
    // on the left, tucked under the quantity tag.
    expect(mark.className).toContain("absolute");
    expect(mark.className).toContain("right-[5px]");
    expect(banners[0].className).not.toContain("absolute");

    // The edge: only the card that breaks a rule gets one.
    expect(first.className).toContain("border-destructive");
    expect(second.className).toContain("border-border");
    expect(second.className).not.toContain("border-destructive");
  });

  /**
   * **That edge is drawn by two elements, and the seam is where it used to break.** The data
   * line is `relative` and later in the document than the face, so its own border paints over
   * the card's for the length of its box; left at `border-border` it put a grey stripe back
   * through the left and right edges of a red card exactly where the foot joins the face, which
   * is the one place the single-object illusion is looked at. The bar's own bottom border is
   * gone with it — it sat 1px *above* the card's rather than on top of it, so the two stacked
   * into a 2px foot under a 1px everything else the moment the colour made them visible.
   *
   * The class strings rather than computed styles, for the reason every assertion in this file
   * reads them: jsdom has no Tailwind, so a colour utility resolves to nothing at all.
   */
  it("carries the rule break's edge through the data line as well", () => {
    withIssue();
    const [first, second] = screen.getAllByRole("listitem");
    // The bar, found by what only it says — the printing, which is a fact about the object
    // rather than a mark over the art.
    const foot = (li: HTMLElement) => within(li).getByText("LEA · 161").parentElement;

    expect(foot(first)?.className).toContain("border-destructive");
    expect(foot(second)?.className).toContain("border-border");
    expect(foot(second)?.className).not.toContain("border-destructive");
    // Sides only: the card's own border is the bottom edge, in whichever colour it is.
    expect(foot(first)?.className).toContain("border-x");
  });

  /** A warning is a fact worth a look, not a rule the reader broke — `ruleBreak`'s rule,
   *  seen from the surface that draws it. */
  it("draws no rule break for a warning", () => {
    render(
      <CardStack
        cards={[card({ name: "Sword of the Meek" })]}
        label="Ramp"
        currency="usd"
        violations={
          new Map([
            [
              "c-Sword of the Meek",
              [
                {
                  severity: "warning" as const,
                  code: "orphan",
                  message: "This printing is not in the card database.",
                },
              ],
            ],
          ])
        }
      />,
    );

    expect(screen.queryByText("RULE BREAK")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0].className).not.toContain("border-destructive");
  });
});
