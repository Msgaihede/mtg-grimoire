/**
 * The two theory marks, and the four things about them a suite can honestly hold.
 *
 * Everything else in `CardMarks.tsx` is geometry drawn on a card face, which jsdom lays out not at
 * all — the stack's marks are pinned through `CardStack.test.tsx`, where they are rendered on a
 * real row. What is checked here is the part that is pure: which **sentence** a tier and a count
 * come to, which **value** the tier writes into `data-theory-match`, which **custom property
 * names** each component paints with, and that the mark's mirrored **clip** is written at all —
 * a string in an inline style rather than a shape anything has to lay out, which is the one
 * piece of this mark's geometry jsdom can read back. (It said "three" while that fourth case was
 * already here; the count is re-taken in the commit that rewrote the case.)
 *
 * ## Why the colour assertions name a property and never a colour
 *
 * The fill moved off Tailwind on 2026-09-07 and is `--color-theory-exact` / `--color-theory-name`,
 * which a reader may replace in Settings → Appearance. So there is no colour to assert: jsdom
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
});

describe("TheoryMatchMark", () => {
  it("carries its tier as the attribute's value", () => {
    expect(drawMark(<TheoryMatchMark tier="exact" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "exact",
    );
    expect(drawMark(<TheoryMatchMark tier="name" />).getAttribute(THEORY_MATCH_ATTR)).toBe("name");
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

  it("paints with no Tailwind colour utility, so the reader's choice is the only fill", () => {
    for (const tier of ["exact", "name"] as const) {
      const el = drawMark(<TheoryMatchMark tier={tier} />);
      expect(el.classList.contains("bg-pie-u")).toBe(false);
      expect(el.classList.contains("text-text")).toBe(false);
    }
  });

  it("wears the mirrored slant whichever tier it is", () => {
    // Two regressions, and the loop is what catches the second. The clip and the fill are one
    // `style` object, so a slant lost to the paint is exactly what that rewrite could have cost —
    // issue #182 is what it would re-open. And the slant is now **unconditional**: it was written
    // only for the `"banner"` variant while the Grid tile drew a square 9px chip of its own, and
    // that prop went on 2026-09-08 when both card-face views became one `DeckCardFace`. So the
    // property worth pinning is that nothing branches here at all — a shape re-derived from the
    // tier, or from anything else, is a second drawing coming back.
    for (const tier of ["exact", "name"] as const) {
      expect(drawMark(<TheoryMatchMark tier={tier} />).style.clipPath).not.toBe("");
    }
  });
});

describe("TheoryMatchBadge", () => {
  it("carries its tier as the attribute's value", () => {
    expect(drawMark(<TheoryMatchBadge tier="exact" />).getAttribute(THEORY_MATCH_ATTR)).toBe(
      "exact",
    );
    expect(drawMark(<TheoryMatchBadge tier="name" />).getAttribute(THEORY_MATCH_ATTR)).toBe("name");
  });

  it("sets the text colour only — there is no fill for a foreground to be legible on", () => {
    const exact = drawMark(<TheoryMatchBadge tier="exact" />);
    expect(exact.style.color).toBe("var(--color-theory-exact)");
    expect(exact.style.backgroundColor).toBe("");
    const name = drawMark(<TheoryMatchBadge tier="name" delta={-2} />);
    expect(name.style.color).toBe("var(--color-theory-name)");
    expect(name.style.backgroundColor).toBe("");
  });

  it("paints with no Tailwind colour utility", () => {
    for (const tier of ["exact", "name"] as const) {
      expect(drawMark(<TheoryMatchBadge tier={tier} />).classList.contains("text-pie-u")).toBe(
        false,
      );
    }
  });
});
