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
export function hasColorBar(pips: PipCounts | null): boolean {
  return pips !== null && pipTotal(pips) > 0;
}

/**
 * One deck's colours, as a band: the pips it costs, in printed order, each colour's own symbol on
 * its own field, each field as wide as its share of the whole.
 *
 * **A deck with nothing to say draws nothing at all.** `null` is the read still being out and an
 * all-zero record is a pile of lands and colourless artifacts, and both answer the same way here:
 * an empty grey band under a tile is a bar that says "this deck has no colours" in the same
 * vocabulary a full band uses to say what they are, and a reader cannot tell that from a rendering
 * fault or from a bar still loading. Silence is the honest drawing of "no pips", and it costs the
 * wall nothing — the tile simply sits shorter, with the crop keeping all four of its own corners,
 * which is what a tile with no colour bar looked like before this component existed. It is the
 * same argument the theory badge and the caption's `Any` row already make on this tile: a mark
 * that would sit on nearly every deck, or on a deck it says nothing about, is a mark not worth
 * drawing. {@link hasColorBar} is that rule stated once, for here and for the crop's radius.
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
export function DeckColorBar({ pips }: { pips: PipCounts | null }): ReactElement | null {
  const tip = useTooltip();

  // Both silences, together and before anything is measured — see the note above. `hasColorBar`
  // is the single statement of when a bar exists, so this early return and the radius `DeckTile`
  // draws the crop with cannot come to disagree.
  //
  // The `pips === null` clause is unreachable at runtime and is there for the compiler:
  // `hasColorBar` answers a plain `boolean` rather than a type predicate, so nothing about its
  // `true` narrows `pips` for the arithmetic below. It is a second *reading* of the rule, never a
  // second copy of it — the rule is the function, and this line cannot answer differently from it.
  if (!hasColorBar(pips) || pips === null) return null;

  // `pipTotal` again, and deliberately not threaded out of the predicate: it is six additions over
  // a record already in hand, and a `hasColorBar` that answered a number instead of a boolean
  // would be a predicate shaped around this one call site rather than around `DeckTile`'s question.
  const total = pipTotal(pips);
  const colors = pipColors(pips);

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
      {...tip(colors.map((key) => `${MANA_LABEL[key]} ${pips[key]}`).join(", "), {
        describes: false,
      })}
      className={cn(
        // No top margin at all: the band abuts the crop, and `DeckTile` rounds only the crop's
        // top so the two read as one object rather than as a picture with a rule under it.
        "flex overflow-hidden rounded-b-lg border-t border-bg/60 bg-surface",
        "h-[calc(1.25rem*var(--mark-scale,1))] gap-[calc(2px*var(--mark-scale,1))]",
      )}
    >
      {colors.map((key) => (
        <span
          key={key}
          {...{ [DECK_COLOR_SEGMENT_ATTR]: key }}
          // The share as a percentage, so the band is correct at every tile width the zoom ladder
          // produces without anything measuring a box, floored at the width a symbol needs to
          // stay legible. `overflow-hidden` on the parent is what makes the band's rounded foot
          // belong to the band rather than to the first and last colour, and what absorbs the
          // floors when a five-colour deck's minimums add past a narrow tile.
          className="grid min-w-[calc(1.625rem*var(--mark-scale,1))] place-items-center"
          style={{ width: `${(pips[key] / total) * 100}%`, backgroundColor: MANA_FILL[key] }}
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
          <i
            className={cn(
              manaSymbolClass(key),
              "text-[calc(0.75rem*var(--mark-scale,1))] leading-none text-black",
            )}
            aria-hidden="true"
          />
        </span>
      ))}
    </span>
  );
}
