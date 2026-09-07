/**
 * What colours a deck is, drawn as one rule under its cover art.
 *
 * The gallery could already say what a deck is *called*, what format it is and how big it is,
 * and none of those is what a reader browsing a wall of forty decks is actually looking for.
 * Colour is — it is the first thing anybody says about a Commander deck and the first thing
 * they sort their shelf by — and it is the one fact about a deck that a picture of a single
 * card cannot carry, because a deck's cover is one printing and its identity is the other
 * ninety-nine. Issue #387.
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
import { MANA_LABEL, type ManaKey, type PipCounts } from "@/lib/mana";
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
 */
export const DECK_COLOR_SEGMENT_ATTR = "data-deck-color";

/**
 * The pie deep one colour is filled with — `DeckStats.tsx`'s `PIP_COLOR` and its `COLORLESS`
 * beside it, keyed over all six of {@link MANA_KEYS} rather than the five the identity pips draw.
 *
 * **The tokens are the shared fact, and they are the whole of what must not drift.** A colour in
 * this app is a `--color-*` custom property and nothing else invents one (`src/CLAUDE.md`), so
 * this table is a second *keying* of the same six properties rather than a second palette: a
 * deck's colour bar and the same deck's identity pie are one drawing of one fact and could not
 * come apart without somebody editing `index.css`. What is not shared is the JavaScript object,
 * because `DeckStats` keeps its own private, files colourless in a separate constant, and is a
 * file this change does not own. If a third surface ever fills by colour key, the three want one
 * home in `mana.ts` rather than a third copy here.
 *
 * A record with the `var()` spelled out, never a class built from the key: Tailwind scans source
 * text for whole class names, so an interpolated `bg-pie-${key}` emits no rule at all and the bar
 * would draw six transparent segments with nothing going red. That is `src/CLAUDE.md`'s rule and
 * it is the same reason `DeckStats` writes its table this way.
 */
const PIE_DEEP: Record<ManaKey, string> = {
  W: "var(--color-pie-w)",
  U: "var(--color-pie-u)",
  B: "var(--color-pie-b)",
  R: "var(--color-pie-r)",
  G: "var(--color-pie-g)",
  C: "var(--color-pie-c)",
};

/**
 * One deck's colours, as a bar: the pips it costs, in printed order, each segment as wide as its
 * share of the whole.
 *
 * **A deck with nothing to say draws nothing at all.** `null` is the read still being out and an
 * all-zero record is a pile of lands and colourless artifacts, and both answer the same way here:
 * an empty grey rule under a tile is a bar that says "this deck has no colours" in the same
 * vocabulary a bar full of colours uses to say what they are, and a reader cannot tell that from
 * a rendering fault or from a bar still loading. Silence is the honest drawing of "no pips", and
 * it costs the wall nothing — the tile simply sits 9px shorter, which is what a tile with no
 * colour bar looked like before this component existed. It is the same argument the theory badge
 * and the caption's `Any` row already make on this tile: a mark that would sit on nearly every
 * deck, or on a deck it says nothing about, is a mark not worth drawing.
 *
 * **A colour with no pips draws no segment either, rather than a zero-width one.** The two are
 * the same pixels and they are not the same DOM: a zero-width `<span>` is an element a test can
 * find, a `querySelectorAll` counts and a future `:first-child` rule can style, standing for a
 * colour that is not in the deck. `deckPips`' `pipColors` is what drops them, so the order and
 * the census are one answer rather than a filter written at every call site.
 *
 * **The size scales with `--mark-scale`, like the other four sizes on a deck tile.** Written as a
 * `calc` off the inherited variable rather than as a scaled pixel prop, which is `cardZoom.ts`'s
 * arrangement and its reason: the variable is set once on the tile's root and every mark drawn
 * inside it follows with no call site involved. **5px at 100%**, which is between Tailwind's
 * `h-1` and `h-1.5` and is why it is spelled as a number: 4px reads as a hairline and is lost
 * against the rounded edge of the crop above it, and 6px starts to read as a band competing with
 * the deck's name rather than as a rule belonging to the picture. The 4px above it is half the
 * 8px under it for the same reason — the bar is a fact about the cards and it is drawn as part of
 * the picture, so it hugs the art and leaves the name its own air.
 */
export function DeckColorBar({ pips }: { pips: PipCounts | null }): ReactElement | null {
  const tip = useTooltip();

  // Both silences, together and before anything is measured — see the note above. `pipTotal` is
  // the denominator every segment below divides by, so the zero case has to leave here anyway.
  if (pips === null) return null;
  const total = pipTotal(pips);
  if (total === 0) return null;

  const colors = pipColors(pips);

  return (
    <span
      // **The bar is decorative, and the colours are said in words somewhere else.** This span
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
        "mt-[calc(0.25rem*var(--mark-scale,1))] flex overflow-hidden rounded-full",
        "h-[calc(0.3125rem*var(--mark-scale,1))]",
      )}
    >
      {colors.map((key) => (
        <span
          key={key}
          {...{ [DECK_COLOR_SEGMENT_ATTR]: key }}
          // The share as a percentage, so the bar is correct at every tile width the zoom ladder
          // produces without anything measuring a box. `overflow-hidden` on the parent is what
          // makes the pill's ends belong to the bar rather than to the first and last colour.
          style={{ width: `${(pips[key] / total) * 100}%`, backgroundColor: PIE_DEEP[key] }}
        />
      ))}
    </span>
  );
}
