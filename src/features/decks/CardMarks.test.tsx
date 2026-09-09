/**
 * `CardMarks.tsx`'s two subjects a suite can hold honestly: the **quantity tag** and the **three
 * theory marks**.
 *
 * The rest of that file is geometry drawn on a card face, which jsdom lays out not at all — the
 * stack's marks are pinned through `CardStack.test.tsx`, where they are rendered on a real row.
 *
 * ## The theory marks, and the five things about them
 *
 * What is checked is the part that is pure: which **sentence** a tier and a count
 * come to, which **value** the tier writes into `data-theory-match`, which **custom property
 * names** each component paints with, that the mark's mirrored **clip** is written at all — a
 * string in an inline style rather than a shape anything has to lay out, which is the one piece
 * of this mark's geometry jsdom can read back — and, since the third tier landed on 2026-09-08,
 * which **glyph** a tier draws, which is the one of the five that is not a string comparison. (It
 * said "three" while the clip case was already here and "four" on two branches that each added a
 * fifth; the count is re-taken in the commit that changes it.)
 *
 * ## The quantity tag, and why it is here at all (2026-09-08)
 *
 * {@link QuantityTag} joined this file's subjects when the game changer folded into it. It was a
 * mark whose whole contract was geometry-plus-a-colour and was therefore `CardStack.test.tsx`'s
 * alone; what it has now is a **boolean with three consequences** — a crown is drawn, a clause is
 * appended to the sentence, and the colour of the glyph is decided by the fill rather than fixed —
 * and all three are answerable with no layout. The stack's suite still owns *the mark on a card*:
 * that the crown is in the title strip, and that the rule break is still told apart from it four
 * ways. What is owned here is the component's own promise, which is what every one of the four
 * views is relying on.
 *
 * **{@link CountTag} is covered here too, and it is covered here because it has no test file of
 * its own** — `src/components/` carries `CountTag.tsx` and `CountTag.stories.tsx` and nothing
 * else. Its `crowned` prop is where the crown, the gap and the arithmetic actually live, and
 * `QuantityTag` is one line of pass-through over it, so a suite that only drove the wrapper would
 * be unable to say which of the two had lost the glyph. A `CountTag.test.tsx` would be the better
 * home the day that component grows a second crowned caller; until then a second file for two
 * cases is a second place to look.
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
 * rule the test exists for — that an `exact` match keeps the sentence it has always had. The
 * quantity tag's sentence is written out for the same reason, ` · Game changer` included: a
 * literal is what would go red for a reword of `GAME_CHANGER_LABEL` that reached one surface and
 * not the others, and a template built from that constant is what would not.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { CountTag } from "@/components/CountTag";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import {
  QuantityTag,
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

/**
 * The tag's own sentence, read the only way it can be read.
 *
 * `CountTag` has bound `useTooltip()` since the tooltip sweep, so there is no `title` attribute
 * left to look at — the words exist only once a pointer has arrived and the provider has drawn
 * its panel. `describes: false`, so the panel is not `role="tooltip"` and is found by
 * `TOOLTIP_PANEL_ID`, the one stable id the provider ever draws. This is `CardStack.test.tsx`'s
 * `openTooltip` in miniature; real timers, because the provider's open timer is a plain
 * `setTimeout` and nothing here needs a fake clock.
 */
async function tooltipOf(anchor: Element): Promise<HTMLElement> {
  fireEvent.pointerEnter(anchor);
  await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
    timeout: TOOLTIP_OPEN_MS + 1000,
  });
  return document.getElementById(TOOLTIP_PANEL_ID) as HTMLElement;
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
      const el = drawMark(<TheoryMatchMark tier={tier} />);
      expect(el.classList.contains("bg-pie-u")).toBe(false);
      expect(el.classList.contains("bg-destructive")).toBe(false);
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
    for (const tier of ["exact", "name", "unplanned"] as const) {
      expect(drawMark(<TheoryMatchMark tier={tier} />).style.clipPath).not.toBe("");
    }
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
    const el = drawMark(<TheoryMatchMark tier="unplanned" delta={3} />);
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent).toBe("");
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

/**
 * The mark that says three facts at once (2026-09-08) — the count, the label it is filled with,
 * and whether the card is one the format calls a game changer.
 *
 * lucide's own `lucide-crown` is the handle throughout. The glyph carries no text, no role and no
 * name — it is `aria-hidden` inside an `aria-hidden` tag — so there is nothing in the
 * accessibility tree to find it by, and inventing a `data-` attribute for it would be a query
 * handle for a question only a test asks. It is the same handle `CardArt.stories.tsx` already
 * uses on the crown the search wall draws.
 */
describe("QuantityTag", () => {
  /**
   * The tag, found the way `CardStack.test.tsx` finds it: by the count it prints.
   *
   * Scoped to this render's own container rather than to `screen`, because two of the cases below
   * draw several tags in one test and a document-wide `getByText` would throw on the second — the
   * tooltip panel is still looked up globally, since the provider mounts it at the root by design.
   */
  const drawTag = (ui: ReactElement, count: string): HTMLElement => {
    const { container } = render(<TooltipProvider>{ui}</TooltipProvider>);
    return within(container).getByText(count);
  };

  /**
   * **The flag decides the glyph, in both directions.** `false` is the tag this component has
   * drawn since it existed and is what the great majority of a deck's cards wear, so the absence
   * is as much the contract as the presence — a crown drawn on every card would say nothing, and
   * would be exactly as green against a test that only checked the `true` arm.
   */
  it("draws the crown for a game changer and nothing for an ordinary card", () => {
    expect(
      drawTag(<QuantityTag quantity={2} name={null} color={null} gameChanger />, "2").querySelector(
        ".lucide-crown",
      ),
    ).not.toBeNull();
    expect(
      drawTag(
        <QuantityTag quantity={3} name={null} color={null} gameChanger={false} />,
        "3",
      ).querySelector(".lucide-crown"),
    ).toBeNull();
  });

  /**
   * **The crown announces nothing, and it is hidden twice.**
   *
   * `FoilOverlay`'s rule for `FoilOverlay`'s reason: every surface that draws this tag draws the
   * card as a button with an explicit `aria-label`, and a label *replaces* its element's content
   * for naming — so a named glyph in here is announced to nobody at all and only looks
   * accessible. The tag is `aria-hidden` and so is the crown inside it, and it is worth pinning
   * at the glyph rather than inferring it from the ancestor: the inner one is what a future
   * caller lifting this mark out of a hidden box would be relying on. `deckCardName` is where the
   * words are, and `CardStack.test.tsx` is where that is pinned.
   */
  it("hides the crown and the tag from the accessibility tree", () => {
    const tag = drawTag(<QuantityTag quantity={2} name={null} color={null} gameChanger />, "2");
    expect(tag).toHaveAttribute("aria-hidden", "true");
    expect(tag.querySelector(".lucide-crown")).toHaveAttribute("aria-hidden", "true");
    // Nothing in the tag is text but the number, which is the other half of "the words are
    // somewhere else": a crown that spelled its fact out would be spelling it inside a box no
    // screen reader reads.
    expect(tag.textContent).toBe("2");
  });

  /**
   * **The fact is a clause on the sentence rather than a sentence of its own**, appended, which
   * is what keeps an ordinary card's tooltip byte-for-byte the string it always was.
   *
   * The old `Game Changer` ribbon had a hint of its own; the crown does not, because it is
   * *inside* `CountTag`, whose `title` is the tooltip for the whole tag. So a pointer resting
   * anywhere on the mark — on the crown or on the digits — gets one sentence saying every fact
   * the mark draws, in the order it draws them.
   */
  it("appends the game changer to the sentence, and only when it is one", async () => {
    const tag = drawTag(
      <QuantityTag quantity={2} name="Fast mana" color="#d3202a" gameChanger />,
      "2",
    );
    expect(await tooltipOf(tag)).toHaveTextContent(/^Fast mana · 2 in this pile · Game changer$/);
  });

  /**
   * The other arm, anchored on purpose: `toHaveTextContent` takes a **substring**, so an
   * unanchored assertion here passes just as happily against a clause on the end. What this
   * case is about is that there is nothing on the end.
   */
  it("leaves an ordinary card's sentence exactly as it was", async () => {
    const tag = drawTag(
      <QuantityTag quantity={2} name="Fast mana" color="#d3202a" gameChanger={false} />,
      "2",
    );
    expect(await tooltipOf(tag)).toHaveTextContent(/^Fast mana · 2 in this pile$/);
  });

  /** And the unlabelled arm, which is the same append over the shorter of the tag's two strings —
   *  a card with no label says the count alone and then, if it is one, the fact. */
  it("appends it to the unlabelled sentence too", async () => {
    const tag = drawTag(<QuantityTag quantity={4} name={null} color={null} gameChanger />, "4");
    expect(await tooltipOf(tag)).toHaveTextContent(/^4 in this pile · Game changer$/);
  });

  /**
   * **The crown is the tag's own foreground and emphatically not gold**, which is the half of
   * this design most likely to be "corrected" back by resemblance to
   * `components/GameChangerMark` — that one *is* gold, because a crown floating on somebody's
   * artwork has nothing but its colour saying which fact it is.
   *
   * Printed on a filled tag it has something: the fill is the card's **label**, a colour the
   * reader chose. So the glyph carries no colour at all — `currentColor`, no utility class — and
   * takes whatever `labelFgCss` computed to be legible on that fill. Three consequences, and the
   * loop is what makes them one claim rather than three coincidences:
   *
   * - **Gold is the case that proves it.** `#d9b95c` is one of the six quick picks, and a fixed
   *   gold crown on a Gold-labelled tag is a glyph nobody can see. Its luma clears the 0.55
   *   threshold, so the crown is the dark `--color-accent-fg` printed on gold.
   * - **A dark label goes the other way**, to `--color-text` on Azure's deep blue — so the answer
   *   really is computed from the fill rather than fixed at one end.
   * - **Neither is a red**, which is the separation from `RuleBreakMark` that
   *   `CardMarks.tsx`'s header is written around and the one a reader could otherwise defeat by
   *   picking a colour.
   *
   * The two foregrounds are written as literals rather than through `labelFgCss`, for this
   * file's own rule: an assertion that calls the function it is checking agrees with the
   * function whatever it answers.
   */
  it("prints the crown in the tag's own foreground, never in gold and never in a red", () => {
    const cases = [
      // hex, the fill jsdom normalises it to, and what is legible printed on it.
      ["#d9b95c", "rgb(217, 185, 92)", "var(--color-accent-fg)"],
      ["#0e68ab", "rgb(14, 104, 171)", "var(--color-text)"],
    ] as const;
    for (const [hex, fill, fg] of cases) {
      const tag = drawTag(<QuantityTag quantity={2} name="Label" color={hex} gameChanger />, "2");
      const crown = tag.querySelector(".lucide-crown") as SVGElement;
      expect(tag.style.backgroundColor).toBe(fill);
      expect(tag.style.color).toBe(fg);
      // The glyph itself decides nothing: `currentColor` and no colour utility, so it is the line
      // above and cannot be anything else.
      expect(crown.getAttribute("stroke")).toBe("currentColor");
      expect(crown.getAttribute("class")).not.toContain("text-");
    }
  });

  /** An unlabelled card is the colourless deep with `CountTag`'s neutral foreground on it — never
   *  the gold a missing token used to fall to, or gold would stop being something a label says. */
  it("crowns an unlabelled card on the colourless deep", () => {
    const tag = drawTag(<QuantityTag quantity={2} name={null} color={null} gameChanger />, "2");
    expect(tag.style.backgroundColor).toBe("var(--color-pie-c)");
    expect(tag.style.color).toBe("var(--color-accent-fg)");
    expect(tag.querySelector(".lucide-crown")).not.toBeNull();
  });
});

/**
 * `CountTag`'s `crowned` prop, which is where the crown, the gap and the arithmetic actually
 * live — {@link QuantityTag} above is a line of pass-through over it.
 *
 * **Covered here because `components/CountTag.tsx` has no test file of its own**: the component
 * ships with a stories file and nothing else, and its one crowned caller is the tag above. The
 * header of this file carries the whole of that argument.
 */
describe("CountTag's crown", () => {
  /** Both tags in one render, so the two class lists can be compared without a cleanup between
   *  them. No `TooltipProvider`: with none mounted `useTooltip` binds nothing, which is exactly
   *  what these class-only cases want. */
  const pair = () => {
    const { container } = render(
      <>
        <CountTag count={7} title="seven" />
        <CountTag count={7} title="seven" crowned />
      </>,
    );
    const [plain, crowned] = Array.from(container.querySelectorAll<HTMLElement>(":scope > span"));
    return { plain, crowned };
  };

  /**
   * **`crowned` defaults to `false`**, which is the tag this component has always drawn, and is
   * what every caller that has not thought about the bracket gets. The default is the assertion:
   * a prop that defaulted the other way would put a crown on every count in the app.
   */
  it("draws no crown unless it is asked to", () => {
    const { plain, crowned } = pair();
    expect(plain.querySelector(".lucide-crown")).toBeNull();
    expect(crowned.querySelector(".lucide-crown")).not.toBeNull();
  });

  /**
   * **An uncrowned tag's classes are byte-identical to what they were**, and the gap is the whole
   * of the difference.
   *
   * That is the component's own claim and it is not decoration: this box is on every card of
   * every deck. The gap rides on the flag rather than on the box because an uncrowned tag holds
   * one anonymous flex item, where a `column-gap` draws between nothing — and *inert* there is a
   * fact about today's content rather than a property of the class, so it is written where it
   * does something.
   *
   * The subtraction is what makes this a claim about the *whole* class list rather than about
   * one string being present: anything else the flag added would fail it too.
   */
  it("adds the gap and nothing else to the box", () => {
    const { plain, crowned } = pair();
    const plainClasses = plain.className.split(" ");
    const crownedClasses = crowned.className.split(" ");

    expect(plainClasses).not.toContain("gap-[calc(3px*var(--mark-scale,1))]");
    expect(crownedClasses).toContain("gap-[calc(3px*var(--mark-scale,1))]");
    expect(crownedClasses.filter((c) => c !== "gap-[calc(3px*var(--mark-scale,1))]")).toEqual(
      plainClasses,
    );
  });

  /**
   * **The 14px it costs is 11 of glyph and 3 of gap, and both scale.**
   *
   * `--mark-scale` is the card's own factor and the reader zooms 0.5×–2×, so a mark that held
   * still would be a sticker on a doubled card and a smudge on a halved one — the rule every
   * other number on a card face obeys. The classes are written out here because Tailwind scans
   * source text: a size assembled from a variable emits no rule at all, and a mark drawn at no
   * size is exactly what neither jsdom nor Storybook can go red for.
   */
  it("sizes the crown and its gap off the card's own scale", () => {
    const { crowned } = pair();
    const crown = crowned.querySelector(".lucide-crown") as SVGElement;
    expect(crown.getAttribute("class")).toContain("size-[calc(11px*var(--mark-scale,1))]");
    expect(crowned.className).toContain("gap-[calc(3px*var(--mark-scale,1))]");
  });

  /**
   * **The number is still the whole of what the tag says**, crowned or not — this component's
   * founding refusal (`the number alone, never ×N`) read against the one glyph that was let in.
   * The crown is drawn *before* the number rather than instead of it, so a crowned tag still
   * prints a count and nothing else.
   *
   * `firstChild` and deliberately not `firstElementChild`: the count is a bare text node, so the
   * element-only walk skips it and answers "the crown" whichever side of the number the crown is
   * drawn on. Driven both ways — the element form is green against a `CountTag` with the count
   * moved in front of the glyph.
   */
  it("puts the crown before the number and leaves the number alone", () => {
    const { plain, crowned } = pair();
    expect(plain.textContent).toBe("7");
    expect(crowned.textContent).toBe("7");
    expect(crowned.firstChild).toBe(crowned.querySelector(".lucide-crown"));
  });
});
