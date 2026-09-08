/**
 * The three theory marks, and the four things about them a suite can honestly hold.
 *
 * Everything else in `CardMarks.tsx` is geometry drawn on a card face, which jsdom lays out not at
 * all — the stack's marks are pinned through `CardStack.test.tsx`, where they are rendered on a
 * real row. What is checked here is the part that is pure: which **sentence** a tier and a count
 * come to, which **value** the tier writes into `data-theory-match`, which **custom property
 * names** each component paints with, and — since the third tier landed on 2026-09-08 — which
 * **glyph** a tier draws, which is the one of the four that is not a string comparison.
 *
 * ## Why the colour assertions name a property and never a colour
 *
 * The fill moved off Tailwind on 2026-09-07 and is `--color-theory-exact` / `--color-theory-name`
 * / `--color-theory-unplanned`, which a reader may replace in Settings → Appearance. So there is
 * no colour to assert: jsdom
 * resolves no stylesheet, `getComputedStyle` would answer the literal `var(…)` back, and even in a
 * browser the right answer is whatever the reader last chose. **The property name is the contract**
 * — that is what `useMarkColors` writes and what `index.css` defaults — so that is what is pinned.
 *
 * The mirror of that is the pair of absence checks: an inline style that stopped being written
 * would leave a mark drawn in nothing, and a Tailwind fill that came back would beat the reader's
 * choice on one of the four surfaces. Both are `classList.contains`, never `className.includes` —
 * a substring test on a class string passes against the class it is looking for being absent as
 * often as against it being present, which is how that assertion comes to prove nothing.
 *
 * Sentences are pinned as **literals** rather than built from the module's own constants: an
 * assertion that reads its own constant agrees with any reword, including the one that breaks the
 * rule the test exists for — that an `exact` match keeps the sentence it has always had.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  THEORY_MATCH_ATTR,
  THEORY_MATCH_NAME_LABEL,
  THEORY_UNPLANNED_LABEL,
  TheoryMatchBadge,
  TheoryMatchMark,
  theoryDeltaText,
  theoryMatchLabel,
} from "./CardMarks";

/** The one element either component draws, found the way a live probe finds it. */
function drawMark(ui: ReactElement): HTMLElement {
  const { container } = render(ui);
  const el = container.querySelector<HTMLElement>(`[${THEORY_MATCH_ATTR}]`);
  if (el === null) throw new Error("no theory mark rendered");
  return el;
}

describe("theoryMatchLabel", () => {
  it("keeps the exact tier's sentence exactly as it was", () => {
    expect(theoryMatchLabel("exact", 0)).toBe("In the theory list");
  });

  it("says which one a name match is", () => {
    expect(theoryMatchLabel("name", 0)).toBe("In the theory list · a different printing");
    // The constant is the same sentence, built from the exact tier's rather than written twice.
    expect(THEORY_MATCH_NAME_LABEL).toBe("In the theory list · a different printing");
  });

  /**
   * The sign is the action (issue #400): a positive delta is copies to add and a negative one is
   * copies to remove, and the sentence says the action rather than the count. Both signs on both
   * tiers, because a `Math.abs` with the words swapped would pass half of these.
   */
  it("words the count as the action to take, after the tier's own clause, on both tiers", () => {
    expect(theoryMatchLabel("exact", 2)).toBe("In the theory list · 2 to add");
    expect(theoryMatchLabel("exact", -3)).toBe("In the theory list · 3 to remove");
    expect(theoryMatchLabel("name", 6)).toBe(
      "In the theory list · a different printing · 6 to add",
    );
    expect(theoryMatchLabel("name", -1)).toBe(
      "In the theory list · a different printing · 1 to remove",
    );
  });

  /** The glyph and the sentence must point the same way: the characters the mark draws for a
   *  delta and the words its tooltip says are the same sign, read off the same number. */
  it("draws the same sign it speaks", () => {
    expect(theoryDeltaText(2)).toBe("+2");
    expect(theoryDeltaText(-3)).toBe("-3");
  });

  /**
   * The third tier says one thing and never a count — 2026-09-08. Nothing is planned, so there is
   * no order to be short of, and a "3 to add" clause here would be a sentence about an order the
   * plan does not carry.
   *
   * **Every delta, including the ones the resolver never produces**, because the guarantee is the
   * function's rather than its caller's: `theoryMatchMark` answers `0` for this tier today, and a
   * component or a story that hands it something else must still get the one sentence.
   */
  it("says the third tier's one sentence at every count", () => {
    expect(theoryMatchLabel("unplanned", 0)).toBe("Not in the theory list");
    expect(theoryMatchLabel("unplanned", 3)).toBe("Not in the theory list");
    expect(theoryMatchLabel("unplanned", -8)).toBe("Not in the theory list");
    // The constant is the same literal, spelled out rather than negated from the exact tier's —
    // see its own doc for why that composition is the one this file refuses to make.
    expect(THEORY_UNPLANNED_LABEL).toBe("Not in the theory list");
  });
});

describe("TheoryMatchMark", () => {
  it("carries its tier as the attribute's value", () => {
    expect(drawMark(<TheoryMatchMark tier="exact" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "exact",
    );
    expect(drawMark(<TheoryMatchMark tier="name" />).getAttribute(THEORY_MATCH_ATTR)).toBe("name");
    expect(drawMark(<TheoryMatchMark tier="unplanned" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "unplanned",
    );
  });

  it("fills from the exact tier's own two properties", () => {
    const el = drawMark(<TheoryMatchMark tier="exact" />);
    expect(el.style.backgroundColor).toBe("var(--color-theory-exact)");
    expect(el.style.color).toBe("var(--color-theory-exact-fg)");
  });

  it("fills from the name tier's own two properties", () => {
    const el = drawMark(<TheoryMatchMark tier="name" />);
    expect(el.style.backgroundColor).toBe("var(--color-theory-name)");
    expect(el.style.color).toBe("var(--color-theory-name-fg)");
  });

  /** The third tier's own pair, 2026-09-08 — spelled here as literals for the reason at the top
   *  of this file: `--color-theory-${tier}` is the template `CardMarks.tsx` forbids, and an
   *  assertion built the same way would agree with it. */
  it("fills from the unplanned tier's own two properties", () => {
    const el = drawMark(<TheoryMatchMark tier="unplanned" />);
    expect(el.style.backgroundColor).toBe("var(--color-theory-unplanned)");
    expect(el.style.color).toBe("var(--color-theory-unplanned-fg)");
  });

  it("paints with no Tailwind colour utility, so the reader's choice is the only fill", () => {
    for (const tier of ["exact", "name", "unplanned"] as const) {
      for (const variant of ["banner", "chip"] as const) {
        const el = drawMark(<TheoryMatchMark tier={tier} variant={variant} />);
        expect(el.classList.contains("bg-pie-u")).toBe(false);
        expect(el.classList.contains("bg-destructive")).toBe(false);
        expect(el.classList.contains("text-text")).toBe(false);
      }
    }
  });

  it("keeps the banner's mirrored slant and leaves the chip square", () => {
    // The clip and the fill are one `style` object now, so a slant lost to the paint is exactly
    // the regression that rewrite could have caused — and issue #182 is what it would re-open.
    expect(drawMark(<TheoryMatchMark tier="exact" variant="banner" />).style.clipPath).not.toBe("");
    expect(drawMark(<TheoryMatchMark tier="exact" variant="chip" />).style.clipPath).toBe("");
  });

  /**
   * **The glyph is the tier's and is decided before the delta is read** (2026-09-08).
   *
   * `delta={3}` is the assertion rather than a decoration: the resolver answers `0` for this tier
   * today, so a component that read the delta first would pass every case built on what
   * `theoryMatchMark` actually hands it and draw `+3` the day anything else did. Empty text is
   * checked beside the `<svg>` because those are the two halves of "a glyph, not a number" — a
   * mark drawing both would satisfy either assertion alone.
   */
  it("draws a glyph and no number on the unplanned tier, whatever delta it is handed", () => {
    for (const variant of ["banner", "chip"] as const) {
      const el = drawMark(<TheoryMatchMark tier="unplanned" delta={3} variant={variant} />);
      expect(el.querySelector("svg")).not.toBeNull();
      expect(el.textContent).toBe("");
    }
  });

  /** And the other two tiers still turn on the number, which is what says the branch above is
   *  about the tier rather than about the component having stopped drawing counts. */
  it("still draws the count on the two tiers that have one", () => {
    const exact = drawMark(<TheoryMatchMark tier="exact" delta={3} />);
    expect(exact.querySelector("svg")).toBeNull();
    expect(exact.textContent).toBe("+3");
    expect(drawMark(<TheoryMatchMark tier="exact" delta={0} />).querySelector("svg")).not.toBeNull();
  });
});

describe("TheoryMatchBadge", () => {
  it("carries its tier as the attribute's value", () => {
    expect(drawMark(<TheoryMatchBadge tier="exact" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "exact",
    );
    expect(drawMark(<TheoryMatchBadge tier="name" />).getAttribute(THEORY_MATCH_ATTR)).toBe("name");
    expect(drawMark(<TheoryMatchBadge tier="unplanned" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "unplanned",
    );
  });

  it("sets the text colour only — there is no fill for a foreground to be legible on", () => {
    const exact = drawMark(<TheoryMatchBadge tier="exact" />);
    expect(exact.style.color).toBe("var(--color-theory-exact)");
    expect(exact.style.backgroundColor).toBe("");
    const name = drawMark(<TheoryMatchBadge tier="name" delta={-2} />);
    expect(name.style.color).toBe("var(--color-theory-name)");
    expect(name.style.backgroundColor).toBe("");
    // The third tier takes the *fill* as its text colour and never the `-fg` beside it: there is
    // nothing printed on anything here, so the foreground would be a colour for no surface.
    const unplanned = drawMark(<TheoryMatchBadge tier="unplanned" />);
    expect(unplanned.style.color).toBe("var(--color-theory-unplanned)");
    expect(unplanned.style.backgroundColor).toBe("");
  });

  it("paints with no Tailwind colour utility", () => {
    for (const tier of ["exact", "name", "unplanned"] as const) {
      const el = drawMark(<TheoryMatchBadge tier={tier} />);
      expect(el.classList.contains("text-pie-u")).toBe(false);
      expect(el.classList.contains("text-destructive")).toBe(false);
    }
  });

  /** The card-face mark's rule, on the surface with no art: the glyph is the tier's and the delta
   *  is not consulted for it. */
  it("draws a glyph and no number on the unplanned tier, whatever delta it is handed", () => {
    const el = drawMark(<TheoryMatchBadge tier="unplanned" delta={3} />);
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent).toBe("");
    // And the mono face that dresses a *number* is not put on a row that draws a glyph.
    expect(el.classList.contains("font-mono")).toBe(false);
  });
});
