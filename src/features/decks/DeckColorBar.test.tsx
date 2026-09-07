import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MANA_KEYS, type ManaKey, type PipCounts } from "@/lib/mana";
import { DECK_COLOR_SEGMENT_ATTR, DeckColorBar } from "./DeckColorBar";

/** A pip record with the named colours in it and zero everywhere else — which is the shape
 *  `deckPips` answers and the shape the interesting cases here are all missing something from. */
function pips(counts: Partial<PipCounts>): PipCounts {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...counts };
}

/**
 * The segments, in document order.
 *
 * `DECK_COLOR_SEGMENT_ATTR` is the only handle they have and that is deliberate — see the
 * constant's own note. Order matters to every assertion below, and `querySelectorAll` answers in
 * document order, which is the order the bar is drawn in.
 */
function segments(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[${DECK_COLOR_SEGMENT_ATTR}]`)];
}

/** Which colour each segment is for, left to right. */
function order(container: HTMLElement): (string | null)[] {
  return segments(container).map((segment) => segment.getAttribute(DECK_COLOR_SEGMENT_ATTR));
}

/**
 * The bar itself.
 *
 * By element rather than by role, because it deliberately has none — see the component, and the
 * `names nothing at all` case below. A query that could name it would be a query that proved the
 * opposite of what this file asserts.
 */
function bar(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("the bar drew nothing");
  return el;
}

describe("DeckColorBar", () => {
  /**
   * The two silences, and they are one rule: a bar is a statement about colour, so a deck with
   * no colour to state draws nothing rather than an empty rule. `null` is the read still out;
   * an all-zero record is a real answer about a pile of lands and colourless artifacts. A grey
   * line under either is indistinguishable from a rendering fault.
   */
  it("draws nothing while the read is out, and nothing for a deck with no pips", () => {
    expect(render(<DeckColorBar pips={null} />).container).toBeEmptyDOMElement();
    expect(render(<DeckColorBar pips={pips({})} />).container).toBeEmptyDOMElement();
  });

  /**
   * The bar itself: one segment per colour, in printed order whatever order the record was
   * written in, each as wide as its share.
   *
   * The widths are read off the **inline style**, never off the class list: the share is a
   * number computed per deck, so there is no class to assert and `className.includes` would
   * anyway be satisfied by a substring of something else — this repo has a recorded case of a
   * `hover:` variant making exactly that assertion vacuous.
   */
  it("draws each colour's share, in printed order", () => {
    // Written G first on purpose: the record's key order must not reach the drawing.
    const { container } = render(<DeckColorBar pips={pips({ G: 2, W: 6 })} />);

    expect(order(container)).toEqual(["W", "G"]);
    expect(segments(container).map((segment) => segment.style.width)).toEqual(["75%", "25%"]);
  });

  /** Three colours, so a bar that happened to be right about two shares is not right by
   *  accident — and the three add up to the whole rule with nothing left over. */
  it("divides the whole bar between the colours present", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 1, U: 2, B: 1 })} />);

    expect(order(container)).toEqual(["W", "U", "B"]);
    expect(segments(container).map((segment) => segment.style.width)).toEqual([
      "25%",
      "50%",
      "25%",
    ]);
  });

  /**
   * **A colour the deck does not play has no element**, rather than a zero-width one.
   *
   * The two are the same pixels and not the same DOM: a zero-width span is something a test can
   * find, a `querySelectorAll` counts and a rule can style, standing for a colour that is not in
   * the deck.
   */
  it("gives a colour with no pips no element at all", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 3, G: 1 })} />);

    expect(segments(container)).toHaveLength(2);
    for (const key of ["U", "B", "R", "C"] as const) {
      expect(container.querySelector(`[${DECK_COLOR_SEGMENT_ATTR}="${key}"]`)).toBeNull();
    }
  });

  /**
   * The name joins the tile's button, so it says what a reader walking the wall wants: the
   * deck's colours, spelled the way a player says them out loud, and no arithmetic. The counts
   * live in the tooltip.
   */
  it("names nothing at all, and hides itself from the accessibility tree", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 11, G: 8 })} />);

    // The whole subtree is hidden, so there is no role in here to find and nothing this element
    // could contribute to the accessible name of the button it is drawn inside. That is the
    // point: the sentence is `DeckTile`'s `sr-only` span, placed *after* the deck's name, and a
    // name here would land in front of it.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(bar(container).getAttribute("aria-hidden")).toBe("true");
    expect(bar(container).getAttribute("aria-label")).toBeNull();
  });

  /** Colourless is a colour to this bar — `{C}` is a pip a deck can be built around, and it
   *  takes the last segment because it is printed last. */
  it("gives colourless its own segment, last", () => {
    const { container } = render(<DeckColorBar pips={pips({ R: 3, C: 1 })} />);

    expect(order(container)).toEqual(["R", "C"]);
  });

  /**
   * Every fill is a `--color-pie-*` custom property — the identity deeps `DeckStats` already
   * draws its pips in. Nothing in this app invents a colour, and a bar mixing its own would be
   * the same deck drawn two ways on two screens.
   */
  it("fills from the pie deeps and nothing it mixed itself", () => {
    const all = pips({ W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 });
    const { container } = render(<DeckColorBar pips={all} />);

    expect(order(container)).toEqual([...MANA_KEYS]);
    for (const segment of segments(container)) {
      const key = segment.getAttribute(DECK_COLOR_SEGMENT_ATTR) as ManaKey;
      expect(segment.style.backgroundColor).toBe(`var(--color-pie-${key.toLowerCase()})`);
    }
  });

  /**
   * The bar is drawn on a card tile, so its height moves with `--mark-scale` like the other four
   * sizes there — a rule that ignored the zoom would be the one thing on the wall that did.
   *
   * `classList.contains` rather than `className.includes`: a substring match on a class list is
   * satisfied by any longer class that happens to contain this one, which is how a class
   * assertion in this repo went vacuous once already. jsdom applies no stylesheet, so this is a
   * check on the source text and the pixels are the live pass's to prove.
   */
  it("scales its height with the tile's zoom", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 1 })} />);

    const rule = bar(container);
    expect(rule.classList.contains("h-[calc(0.3125rem*var(--mark-scale,1))]")).toBe(true);
    expect(rule.classList.contains("mt-[calc(0.25rem*var(--mark-scale,1))]")).toBe(true);
  });
});
