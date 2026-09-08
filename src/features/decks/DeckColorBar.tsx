/**
 * What colours a deck is, drawn as the foot of its cover art.
 *
 * The gallery could already say what a deck is *called*, what format it is and how big it is,
 * and none of those is what a reader browsing a wall of forty decks is actually looking for.
 * Colour is — it is the first thing anybody says about a Commander deck and the first thing
 * they sort their shelf by — and it is the one fact about a deck that a picture of a single
 * card cannot carry, because a deck's cover is one printing and its identity is the other
 * ninety-nine. Issue #387.
 *
 * **It stopped being a rule floating under a picture and became the tile's foot.** It shipped as
 * a 5px pill with 4px of air above it, filled with the colour-identity deeps — a hairline that
 * belonged to the crop the way a card's own frame line does. It is a 20px band fused to the
 * bottom edge of that crop now, carrying the **printed mana symbols** on their own colour fields,
 * and those are one change rather than two: a band that abuts the art reads as the same object
 * rather than as a second caption, and a band with that much room can say *which* colours in the
 * vocabulary a Magic player already has, instead of asking a reader to learn what six fills mean.
 * The other half of the join is `DeckTile`'s, which draws the crop `rounded-t-lg` where
 * {@link hasColorBar} says a band is coming and `rounded-lg` where it is not.
 *
 * **The pips are counted from the printed mana costs, and the counting happens elsewhere.**
 * Rust answers cost strings, `mana.ts` tokenises them and `deckPips.ts` folds them into a
 * {@link PipCounts} — this component draws a record it is handed and computes nothing but
 * percentages. That is the app's Rust/TS boundary read one floor further in: a component that
 * did its own tokenising would be a second answer to "what is a pip", and `{W/U}` is exactly
 * the symbol two implementations disagree about.
 */
import type { ReactElement } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { MANA_LABEL, manaSymbolClass, type ManaKey, type PipCounts } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { pipColors, pipTotal } from "./deckPips";

/**
 * How a test finds one segment, and which colour it found.
 *
 * The bar is `aria-hidden` and nothing in here has a name at all — the colours are said in an
 * `sr-only` span beside it, off `deckPips`' {@link deckColorsLabel}, and the counts only in the
 * tooltip. So nothing about a segment's identity or
 * its share is reachable through the accessibility tree, and a class assertion would be a check
 * on source text rather than on the drawing (jsdom applies no stylesheet). An attribute is
 * therefore the handle, in the shape `FolderDropLine`'s `FOLDER_DROP_LINE_ATTR` and
 * `DropIndicator`'s `DROP_LINE_ATTR` already use, and it **carries the colour key as its value**
 * for that same file's reason: which colour a segment is drawn for is the fact under test, and a
 * segment in the wrong place is the bar telling a reader their mono-blue deck is green.
 *
 * **The printed symbols did not give the segments a second handle and could not.** A `mana-font`
 * glyph is a `content` on an empty `<i>`'s `::before`, so under jsdom — which loads no stylesheet
 * — that element has no text at all, and in the shipped window it has none the accessibility tree
 * can see either. The classes on it are assertable as *source text* and are asserted that way;
 * this attribute stays the only thing that says which colour a segment is *for*.
 */
export const DECK_COLOR_SEGMENT_ATTR = "data-deck-color";

/**
 * The fill one colour's field is painted with — `--color-mana-*`, the values a real printed
 * symbol's disc is filled with, keyed over all six of {@link MANA_KEYS}.
 *
 * **This is the switch away from the pie deeps, and the band is what forced it.** The 5px rule
 * this replaced was filled from `--color-pie-*`, the colour-identity deeps, and that was right for
 * what it was: `index.css` calls them "saturated enough to carry meaning at 1px", which is exactly
 * the demand a hairline makes. A 20px band with a black glyph printed on it makes the opposite
 * demand. `ms-b` in near-black on `--color-pie-b` (#3b3a3e) is a black symbol on a near-black
 * field — invisible, on the one colour a reader is most likely to be checking for — and the fills
 * are the family the palette *already* says a glyph sits on: "Glyphs sit on these in near-black,
 * exactly like a real symbol", at the token itself. `FilterChips`' `ManaChip` is the shipped
 * precedent for the pair, character for character — `text-black` over an inline
 * `backgroundColor: var(--color-mana-…)`.
 *
 * **The tokens are the shared fact, and they are the whole of what must not drift.** A colour in
 * this app is a `--color-*` custom property and nothing else invents one (`src/CLAUDE.md`), so
 * this table is a second *keying* of six properties rather than a second palette. What it is no
 * longer keyed alongside is `DeckStats`' `PIP_COLOR`: the tile and the editor's identity pie now
 * answer with two different families, and that is the honest reading rather than a drift — a pie
 * slice is a colour with nothing printed on it and a segment here is a field with a symbol on it,
 * so they are two demands on the palette and the palette has two answers.
 *
 * A record with the `var()` spelled out, never a class built from the key: Tailwind scans source
 * text for whole class names, so an interpolated `bg-mana-${key}` emits no rule at all and the bar
 * would draw six transparent segments with nothing going red. That is `src/CLAUDE.md`'s rule and
 * it is the same reason `DeckStats` writes its own table this way.
 */
const MANA_FILL: Record<ManaKey, string> = {
  W: "var(--color-mana-w)",
  U: "var(--color-mana-u)",
  B: "var(--color-mana-b)",
  R: "var(--color-mana-r)",
  G: "var(--color-mana-g)",
  C: "var(--color-mana-c)",
};

/**
 * Does this record draw a bar at all?
 *
 * `true` exactly when {@link DeckColorBar} renders something rather than `null`, and that
 * equivalence *is* the export: `DeckTile` asks it to decide whether the cover art is drawn
 * `rounded-t-lg` — a band is coming, and the crop and the band are one object — or `rounded-lg`,
 * where the picture keeps all four of its own corners. Disagreeing costs a square corner under
 * nothing, or a rounded one behind a band, on every tile of every deck it is wrong about.
 *
 * **A function rather than the same condition written at two sites, and the component's own early
 * return goes through it too.** The two silences below are a rule with an argument behind it, and
 * a copy of that argument in `DeckTile` is a second place for it to be corrected — where the
 * symptom is a *radius*, which no test rendering this component alone can reach and which jsdom
 * cannot see at all, having no layout engine and no stylesheet. So the predicate and the drawing
 * are one statement, and `DeckColorBar.test.tsx` asserts the agreement directly, which is the
 * thing a drifting copy would break first.
 */

/** One field of the band: which colour, how many pips bought it, and how wide that makes it. */
interface ColorField {
  key: ManaKey;
  count: number;
  /** The share as a CSS percentage — the band is correct at every tile width without measuring. */
  width: string;
}

/**
 * The fields to draw, which is **empty for both silences** — see {@link DeckColorBar}.
 *
 * A function rather than three expressions in the component, and the reason is narrowing: `pips`
 * is `PipCounts | null`, the arithmetic needs it non-null, and the alternative is a `!` or a
 * second `pips === null` test beside the one that already decided. Here the guard and the
 * arithmetic are the same statement, and the component below never touches `pips` at all.
 *
 * The zero-total case returns empty rather than dividing by it: a deck of nothing but lands has a
 * record and no pips, and `0/0` fields would each be `NaN%`.
 *
 * **A colour with no pips is dropped rather than drawn zero-width.** The two are the same pixels
 * and they are not the same DOM: a zero-width `<span>` is an element a test can find, a
 * `querySelectorAll` counts and a future `:first-child` rule can style, standing for a colour
 * that is not in the deck. `deckPips`' `pipColors` is what drops them, so the order and the
 * census are one answer rather than a filter written at every call site. It matters more than it
 * did: a zero-width field now also holds a symbol, so the failure would be a glyph clipped to
 * nothing rather than a sliver of colour.
 */
function colorFields(pips: PipCounts | null): ColorField[] {
  if (pips === null) return [];
  const total = pipTotal(pips);
  if (total === 0) return [];
  return pipColors(pips).map((key) => ({
    key,
    count: pips[key],
    width: `${(pips[key] / total) * 100}%`,
  }));
}

/**
 * One deck's colours, as a band: the pips it costs, in printed order, each colour's own symbol on
 * its own field, each field as wide as its share of the whole.
 *
 * **A deck with nothing to say draws the band empty, and that reverses what this file argued
 * until 2026-09-08.** It used to return `null` for both silences — `null` pips is the read still
 * out, an all-zero record is a pile of lands and colourless artifacts — on the reasoning that an
 * empty grey strip says "no colours" in the same vocabulary a full band uses to say what they
 * are, so silence was the honest drawing. That argument was about the *band* and it missed what
 * the band had become: a structural course in the tile rather than a mark laid on one.
 *
 * **The cost was measured on the shipped wall and it is the whole reason this changed.** A
 * bandless tile is 20px shorter than every tile beside it, so its name and its caption sit 20px
 * high — and because the wall is a grid of stretched cells, nothing moves *down* to meet them.
 * The reader does not see a deck with no colours; they see one tile's type out of line with the
 * row, which reads as a layout fault. One deck with an empty list (the commonest deck there is,
 * for exactly as long as it takes to fill) was enough to ragged a whole row.
 *
 * So the band is now **always drawn** and the empty case is a bare 20px course of the tile's own
 * `bg-surface` — no fields, no symbols, nothing claiming a colour. That is still the honest
 * drawing of "no pips": what it says is *nothing*, in the space where colours would be. What it
 * is not allowed to be is a full-width colourless field, which would say the deck **is**
 * colourless — false for a deck whose read has not landed, and a claim `pips === null` has no
 * business making.
 *
 * The knock-on is that the crop is now `rounded-t-lg` unconditionally: there is always something
 * fused under it, so `DeckTile` has no question to ask and the `hasColorBar` predicate this file
 * exported for it is gone.
 *
 * **A colour with no pips draws no segment either, rather than a zero-width one.** The two are
 * the same pixels and they are not the same DOM: a zero-width `<span>` is an element a test can
 * find, a `querySelectorAll` counts and a future `:first-child` rule can style, standing for a
 * colour that is not in the deck. `deckPips`' `pipColors` is what drops them, so the order and
 * the census are one answer rather than a filter written at every call site. It matters more than
 * it did: a zero-width segment now also holds a symbol, so the failure would be a glyph clipped to
 * nothing rather than a sliver of colour.
 *
 * **The size scales with `--mark-scale`, like the other four sizes on a deck tile.** Written as a
 * `calc` off the inherited variable rather than as a scaled pixel prop, which is `cardZoom.ts`'s
 * arrangement and its reason: the variable is set once on the tile's root and every mark drawn
 * inside it follows with no call site involved. Four numbers, and each answers a different
 * question:
 *
 * - **20px of height at 100%.** It is what a 12px printed symbol needs to sit in with air either
 *   side of it, where the 5px this replaced was sized for a rule with nothing in it. The symbol
 *   is what sets the floor here; the band is not a thickness anybody chose.
 * - **26px of width per segment, as a minimum.** A three-colour deck that plays one splash is a
 *   segment at 3% of the tile, and a symbol is either legible or it is not — there is no smaller
 *   version of it to draw. The floor scales rather than being a fixed pixel, which is what keeps
 *   five colours inside a tile at 0.5× instead of six floors adding up past a shrunken tile; the
 *   container's `overflow-hidden` is the backstop for the case where they still do not fit, and
 *   clipping the last segment is better than a band wider than the picture above it.
 * - **2px between segments, as a `gap` and never a border.** What shows through is the band's own
 *   `bg-surface`, so the seam is the tile's surface rather than a line this component picked a
 *   colour for — and a seam is what stops `--color-mana-b` and `--color-mana-c` (#cbc2bf against
 *   #c8c4bf) reading as one field on an Eldrazi deck.
 * - **`rounded-b-lg`, matching the crop's `rounded-t-lg`, and the top corners stay square.** The
 *   two radii are one 0.5rem and neither scales, which is the app's standing rule for a Tailwind
 *   corner: the class does not scale, so the number derived from it must not either.
 *
 * The `border-t` above all of it is a hairline in `bg-bg/60` — the page behind the tile at 60% —
 * so the band is *separated* from the picture rather than washed into it. A band flush against a
 * crop full of dark art loses its own top edge, and the seam is what says the two are one object
 * rather than one bleeding into the other.
 */
export function DeckColorBar({ pips }: { pips: PipCounts | null }): ReactElement {
  const tip = useTooltip();
  const fields = colorFields(pips);

  return (
    <span
      // **The band is decorative, and the colours are said in words somewhere else.** This span
      // sits inside the tile's `<button>` between the cover and the deck's name, so anything named
      // here would join that button's accessible name *ahead of the deck* — which is precisely the
      // argument `DeckTile` already makes about the theory badge, and the reason that badge is
      // drawn outside the button rather than in it. A tile is named for its deck.
      //
      // It was written the other way first and the cost was measured: with `role="img"` and an
      // `aria-label` here the tile's accessible name came out `"White, Red Zoo …"`, so
      // `getByRole("button", { name: /^Zoo/ })` matched nothing and anybody driving the app by
      // voice could not say "click Zoo". Three assertions in the gallery's own suite had to be
      // rewritten around it, which was the tile telling us it had lost its name.
      //
      // **The printed symbols make this more true rather than less.** A `mana-font` glyph is a
      // `::before` on an empty `<i>`, so it reaches a screen reader as nothing whatever this
      // attribute says — a band that dropped `aria-hidden` would announce six empty elements and
      // still not name a single colour.
      //
      // The words live in an `sr-only` span after the deck's name — `deckPips`'
      // {@link deckColorsLabel}, one definition for both — and the arithmetic stays in the tooltip
      // below, where a reader who wants it can ask.
      aria-hidden="true"
      // The counts, as the label plus its numbers — one vocabulary in two depths rather than two
      // ways of saying the same thing.
      //
      // **`describes: false`, and it is a fact about where this element sits rather than a
      // preference.** `aria-describedby` has to land on something a reader can reach; this span
      // is not focusable and lives inside a button whose name is computed from its contents, so a
      // description wired here is announced to nobody. Binding it anyway would put an id on the
      // panel for a relationship that does not exist. Note the trap this repo has recorded: a
      // `describes: false` tooltip carries no `role="tooltip"`, so probing for that role finds
      // nothing on a tooltip that is working perfectly.
      //
      // **An empty band binds no tooltip**, because `useTooltip` refuses falsy content and
      // `[].join(", ")` is `""`. That is the right silence rather than a lucky one: a hint
      // reading "no colours" over a strip that is already saying so by being empty is the
      // vocabulary problem this component's head describes, moved into a popup.
      {...tip(fields.map((field) => `${MANA_LABEL[field.key]} ${field.count}`).join(", "), {
        describes: false,
      })}
      className={cn(
        // No top margin at all: the band abuts the crop, and `DeckTile` rounds only the crop's
        // top so the two read as one object rather than as a picture with a rule under it.
        "flex overflow-hidden rounded-b-lg border-t border-bg/60 bg-surface",
        "h-[calc(1.25rem*var(--mark-scale,1))] gap-[calc(2px*var(--mark-scale,1))]",
      )}
    >
      {/* Nothing at all when there are no colours to draw, which is the empty band: a bare 20px
          course of the tile's own surface, holding the row's line where a deck with costs holds
          its fields. See the head — an empty band is not a colourless one. */}
      {fields.map((field) => (
        <span
          key={field.key}
          {...{ [DECK_COLOR_SEGMENT_ATTR]: field.key }}
          // The share as a percentage, so the band is correct at every tile width the zoom ladder
          // produces without anything measuring a box, floored at the width a symbol needs to
          // stay legible. `overflow-hidden` on the parent is what makes the band's rounded foot
          // belong to the band rather than to the first and last colour, and what absorbs the
          // floors when a five-colour deck's minimums add past a narrow tile.
          // **The glyph's size is set here, on the field, and not on the `<i>` that draws it.**
          // `mana-font`'s own `.ms` rule declares `font: … 14px Mana` and then `font-size:
          // inherit` — a class selector, exactly as specific as a Tailwind utility, and
          // `main.tsx` imports `mana.css` after `index.css`, so on a tie source order hands the
          // font the win. A `text-[…]` written on the `<i>` is therefore in the markup, in the
          // stylesheet, and doing nothing: the symbol takes whatever its parent is, which was
          // the page's 16px. **Nothing can see that** — the class is present so a source
          // assertion passes, jsdom applies no stylesheet so a computed-style assertion is
          // blind, and at 100% zoom a 16px symbol in a 20px band merely looks bold. It was
          // found by measuring the shipped window, where the tell was `fontSize: "16px"` on a
          // rule asking for 12.
          // Setting it on the field is not a workaround for that but the arrangement the font
          // asks for: `font-size: inherit` is `.ms`'s own declaration, so the glyph follows its
          // parent by design, and the parent is the one element here that already knows how big
          // the band is. It also puts the size on the same element as the floor it has to fit
          // inside. `text-black` stays on the `<i>`: `.ms` sets no colour, so nothing contests it.
          className={cn(
            "grid min-w-[calc(1.625rem*var(--mark-scale,1))] place-items-center",
            "text-[calc(0.75rem*var(--mark-scale,1))] leading-none",
          )}
          style={{ width: field.width, backgroundColor: MANA_FILL[field.key] }}
        >
          {/* The printed symbol, in near-black on its own fill — the arrangement `index.css`
              states at the token and `FilterChips`' `ManaChip` already ships. `aria-hidden`
              because the glyph is a font `::before` on an empty element and has nothing to
              announce; the band above it is hidden anyway, so this is the honest shape rather
              than a second defence.

              **Every one of the six is drawn by the bundled font**, checked against
              `node_modules/mana-font/css/mana.css` — `.ms-w`, `.ms-u`, `.ms-b`, `.ms-r`, `.ms-g`
              and `.ms-c` each carry a `::before` rule (mana-font 1.18.0), so no key here is a
              coloured block with nothing on it. Were one ever to lose its glyph in a package
              bump, that is exactly what it would degrade to and exactly what it should: the
              field, its width and its `data-deck-color` are the segment, and the symbol is what
              the band adds on top of them. `mana.test.ts` is what would go red, since it asserts
              every class this app names against the shipped stylesheet. */}
          <i className={cn(manaSymbolClass(field.key), "text-black")} aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}
