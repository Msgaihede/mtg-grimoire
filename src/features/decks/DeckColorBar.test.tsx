import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MANA_KEYS, type ManaKey, type PipCounts } from "@/lib/mana";
import { DECK_COLOR_SEGMENT_ATTR, DeckColorBar, hasColorBar } from "./DeckColorBar";

/** A pip record with the named colours in it and zero everywhere else — which is the shape
 *  `deckPips` answers and the shape the interesting cases here are all missing something from. */
function pips(counts: Partial<PipCounts>): PipCounts {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...counts };
}

/**
 * What each colour is painted with, and which glyph is printed on it — **written out here by
 * hand, never imported from the component and never rebuilt from its key**.
 *
 * That is this repo's rule about an assertion reading its own constant, and it is the whole value
 * of these two tables: a `MANA_FILL` whose `B` and `C` were transposed, or a `manaSymbolClass`
 * that answered the wrong letter, is a table that agrees with itself perfectly. The expected
 * answer has to come from somewhere the component cannot reach — so these are the six token names
 * and the six class names, typed out, and a `--color-pie-*` string appearing in either is the
 * failure this file exists to make loud.
 */
const EXPECTED_FILL: Record<ManaKey, string> = {
  W: "var(--color-mana-w)",
  U: "var(--color-mana-u)",
  B: "var(--color-mana-b)",
  R: "var(--color-mana-r)",
  G: "var(--color-mana-g)",
  C: "var(--color-mana-c)",
};

/** The `mana-font` class that draws each colour's printed symbol — all six checked against the
 *  bundled `mana.css`, which `mana.test.ts` is what keeps honest across a package bump. */
const EXPECTED_GLYPH: Record<ManaKey, string> = {
  W: "ms-w",
  U: "ms-u",
  B: "ms-b",
  R: "ms-r",
  G: "ms-g",
  C: "ms-c",
};

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
   * no colour to state draws nothing rather than an empty band. `null` is the read still out;
   * an all-zero record is a real answer about a pile of lands and colourless artifacts. A grey
   * band under either is indistinguishable from a rendering fault.
   */
  it("draws nothing while the read is out, and nothing for a deck with no pips", () => {
    expect(render(<DeckColorBar pips={null} />).container).toBeEmptyDOMElement();
    expect(render(<DeckColorBar pips={pips({})} />).container).toBeEmptyDOMElement();
  });

  /**
   * **`hasColorBar` and the drawing are one statement, asserted as one.**
   *
   * `DeckTile` calls the predicate to decide whether the cover art keeps all four of its corners
   * or gives up the bottom two to a band fused under it, and a predicate that drifted from the
   * component would be a *radius* — invisible to jsdom, which lays nothing out, and invisible to
   * any test that renders this component on its own. So the two are checked against each other
   * directly, over every shape the component distinguishes: the read still out, a counted deck
   * with no pips at all, one colour, and all six.
   *
   * **The single-pip case is the boundary and is there on purpose.** The rule is `> 0`, and the
   * plausible way to get it wrong is `> 1` — which every other case in this list agrees with, and
   * which would silently take the band off a deck holding exactly one coloured card.
   */
  it("agrees with hasColorBar about when there is a bar at all", () => {
    const cases: (PipCounts | null)[] = [
      null,
      pips({}),
      pips({ R: 1 }),
      pips({ R: 4 }),
      pips({ W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 }),
    ];

    for (const value of cases) {
      const { container } = render(<DeckColorBar pips={value} />);
      const drew = container.firstElementChild !== null;
      expect(hasColorBar(value), JSON.stringify(value)).toBe(drew);
    }
  });

  /**
   * The bar itself: one segment per colour, in printed order whatever order the record was
   * written in, each as wide as its share.
   *
   * The widths are read off the **inline style**, never off the class list: the share is a
   * number computed per deck, so there is no class to assert and `className.includes` would
   * anyway be satisfied by a substring of something else — this repo has a recorded case of a
   * `hover:` variant making exactly that assertion vacuous. They are written as literals worked
   * out by hand (6 and 2 of 8) rather than as the component's own expression, which would be an
   * assertion that could only ever agree with the code it is checking.
   */
  it("draws each colour's share, in printed order", () => {
    // Written G first on purpose: the record's key order must not reach the drawing.
    const { container } = render(<DeckColorBar pips={pips({ G: 2, W: 6 })} />);

    expect(order(container)).toEqual(["W", "G"]);
    expect(segments(container).map((segment) => segment.style.width)).toEqual(["75%", "25%"]);
  });

  /** Three colours, so a bar that happened to be right about two shares is not right by
   *  accident — and the three add up to the whole band with nothing left over. 1, 2 and 1 of 4. */
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
   * the deck — and since the band carries symbols it would be a glyph clipped to nothing rather
   * than a sliver of colour.
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
    // And the band contributes no *text* either, which is the half the symbols could have
    // changed and did not: a `mana-font` glyph is a `::before`, so the `<i>` is empty.
    expect(bar(container).textContent).toBe("");
  });

  /** Colourless is a colour to this bar — `{C}` is a pip a deck can be built around, and it
   *  takes the last segment because it is printed last. */
  it("gives colourless its own segment, last", () => {
    const { container } = render(<DeckColorBar pips={pips({ R: 3, C: 1 })} />);

    expect(order(container)).toEqual(["R", "C"]);
  });

  /**
   * Every field is a `--color-mana-*` custom property — the fills a real printed symbol's disc
   * carries, which is what a near-black glyph can be read on. The pie deeps this replaced are
   * the colour-identity family and `--color-pie-b` is #3b3a3e, so a black `ms-b` on one is a
   * black symbol on a near-black field. Nothing in this app invents a colour, and a bar mixing
   * its own would be the same deck drawn two ways on two screens.
   */
  it("fills from the mana fills and nothing it mixed itself", () => {
    const all = pips({ W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 });
    const { container } = render(<DeckColorBar pips={all} />);

    expect(order(container)).toEqual([...MANA_KEYS]);
    for (const segment of segments(container)) {
      const key = segment.getAttribute(DECK_COLOR_SEGMENT_ATTR) as ManaKey;
      expect(segment.style.backgroundColor, key).toBe(EXPECTED_FILL[key]);
    }
  });

  /**
   * The symbol printed on each field — the change that made this a band rather than a rule.
   *
   * Asserted as source text, because jsdom loads no stylesheet: the glyph is `content` on the
   * `<i>`'s `::before`, so what is checkable here is that the right classes are on the right
   * segment and that the element stays silent. Whether `.ms-w` draws anything at all is
   * `mana.test.ts`'s question, which it asks of the shipped `mana.css` — all six carry a rule
   * there, so no segment is a coloured block with nothing on it.
   *
   * `classList.contains` rather than `className.includes`, which a longer class containing this
   * one already made vacuous once in this repo.
   */
  it("prints each colour's own mana symbol on its field", () => {
    const all = pips({ W: 1, U: 1, B: 1, R: 1, G: 1, C: 1 });
    const { container } = render(<DeckColorBar pips={all} />);

    for (const segment of segments(container)) {
      const key = segment.getAttribute(DECK_COLOR_SEGMENT_ATTR) as ManaKey;
      const symbol = segment.querySelector("i");
      if (symbol === null) throw new Error(`no symbol drawn on the ${key} segment`);

      expect(symbol.classList.contains("ms"), key).toBe(true);
      expect(symbol.classList.contains(EXPECTED_GLYPH[key]), key).toBe(true);
      // It is a font `::before` on an empty element, so it is announced as nothing whatever the
      // band above says — and it says so itself rather than relying on that.
      expect(symbol.getAttribute("aria-hidden"), key).toBe("true");
    }
  });

  /**
   * **The glyph's size is on the field, and writing it on the `<i>` is the mistake this pins.**
   *
   * `mana-font`'s `.ms` declares `font: … 14px Mana` and then `font-size: inherit`. That is a
   * class selector, exactly as specific as a Tailwind utility, and `main.tsx` imports
   * `mana.css` after `index.css` — so on a tie, source order hands the font the win and a
   * `text-[…]` written on the `<i>` is present in the markup, present in the stylesheet, and
   * doing nothing at all. The symbol takes whatever its parent is.
   *
   * **It shipped that way and three green suites said nothing**, which is why this case is
   * worth its own name. jsdom loads no stylesheet, so a computed-style assertion here is blind;
   * a `classList.contains` on the `<i>` would have passed over the defect, because the class
   * really was there. It was found by measuring the shipped window — `fontSize: "16px"` on a
   * rule asking for 12 — and by stepping the gallery's zoom, where the band went 20px → 14px
   * and the symbol stayed 16px inside it.
   *
   * So this asserts the *placement*: the size belongs to the segment, whose `font-size: inherit`
   * the font itself then honours, and the `<i>` carries no size of its own to be ignored. Both
   * halves, because either one alone passes over the bug.
   */
  it("sizes the symbol from the field, where the font's own `inherit` will honour it", () => {
    const { container } = render(<DeckColorBar pips={pips({ R: 1 })} />);
    const [field] = segments(container);
    const symbol = field.querySelector("i");
    if (symbol === null) throw new Error("no symbol drawn");

    expect(field.classList.contains("text-[calc(0.75rem*var(--mark-scale,1))]")).toBe(true);
    expect([...symbol.classList].filter((name) => name.startsWith("text-["))).toEqual([]);
  });

  /**
   * The band is the tile's foot rather than a rule under a picture, and every size on it moves
   * with `--mark-scale` like the other four sizes on a deck tile.
   *
   * **The absent top margin is the load-bearing assertion**, and it is why this checks for what
   * is *not* there as well as what is: `DeckTile` draws the crop `rounded-t-lg` on the promise
   * that a band abuts it, so air between the two leaves a square-cornered picture floating over
   * a round-footed band — a pairing failure neither component can see alone.
   *
   * jsdom applies no stylesheet, so this is a check on the source text and the pixels are the
   * live pass's to prove.
   */
  it("draws as a band fused to the foot of the crop, at sizes that scale with the zoom", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 1 })} />);
    const band = bar(container);

    expect(band.classList.contains("h-[calc(1.25rem*var(--mark-scale,1))]")).toBe(true);
    expect(band.classList.contains("gap-[calc(2px*var(--mark-scale,1))]")).toBe(true);
    expect(band.classList.contains("rounded-b-lg")).toBe(true);
    expect(band.classList.contains("border-t")).toBe(true);
    expect(band.classList.contains("border-bg/60")).toBe(true);
    // The backstop for five floors inside one narrow tile, and what makes the rounded foot the
    // band's rather than the last segment's.
    expect(band.classList.contains("overflow-hidden")).toBe(true);
    // Nothing above it, at any zoom.
    expect([...band.classList].filter((name) => name.startsWith("mt-"))).toEqual([]);
  });

  /**
   * A splash gets a segment wide enough to still show its symbol, and the share stays honest.
   *
   * A symbol is either legible or it is not — there is no smaller version to draw — so the floor
   * is a `min-width` laid over the true percentage rather than a fudged number. 39 and 1 of 40,
   * by hand: 2.5% of a 220px tile is 5px, and the floor is what puts the blue symbol on screen.
   */
  it("floors a segment at the width its symbol needs, without lying about the share", () => {
    const { container } = render(<DeckColorBar pips={pips({ W: 39, U: 1 })} />);

    for (const segment of segments(container)) {
      expect(
        segment.classList.contains("min-w-[calc(1.625rem*var(--mark-scale,1))]"),
        segment.getAttribute(DECK_COLOR_SEGMENT_ATTR) ?? "",
      ).toBe(true);
    }
    expect(segments(container).map((segment) => segment.style.width)).toEqual(["97.5%", "2.5%"]);
  });
});
