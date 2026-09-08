/**
 * The marks a card in a deck can carry, in one place because five surfaces draw them.
 *
 * The stack, the table, the text columns, the grid and the categories panel all say the same
 * three things about a card, and the spec is explicit that **a rule break and a game changer
 * must never be confusable** — one is a problem, the other is a fact about a powerful card.
 * That is only true if they are drawn the same way everywhere, which is what this file buys.
 *
 * Four things separate them and every surface keeps all four: the words (`RULE BREAK` spelled
 * out against two letters), the colour (destructive against the pie gold), the place (over
 * the card's art against its title bar) and the card's own edge, which only a rule break
 * changes. The place is the caller's — a 150px grid tile and a 224px stacked card put them in
 * different corners — so it rides in `className`; the other three are here.
 *
 * **{@link TheoryMatchMark} joined them on 2026-08-20 and made that rule load-bearing rather
 * than merely observed**, because it is a *tick* — the one glyph a reader could take for "this
 * card is fine". It is why `RULE BREAK` is now in the bottom-left corner of a stacked card
 * instead of the top-right one it had held: the four separations are cheap to keep while the
 * marks are apart and impossible to trust while they are adjacent. See that component.
 *
 * ## Every one of these is `aria-hidden`, and that is deliberate
 *
 * It is `FoilOverlay`'s rule, for `FoilOverlay`'s reason. Three of these five surfaces draw a
 * card as a **button with an explicit `aria-label`**, and an `aria-label` *replaces* the
 * element's content for naming purposes — so an `sr-only` span inside one of these marks is
 * announced to nobody at all, which is worse than no text, because it looks accessible. The
 * mark is the decoration; the **statement** is `deckCardName` in `cardControl.ts` on those
 * three, and text the surface owns on the two that are not buttons (`TableView` writes its
 * own `sr-only` beside the badge, in a cell, where it is really read).
 *
 * Adding a mark here means asking which of those two says it in words.
 */
import { Check, Crown } from "lucide-react";
import { COUNT_TAG_BOX_MIRRORED, COUNT_TAG_SLANT_MIRRORED, CountTag } from "@/components/CountTag";
import { FinishMark } from "@/components/FinishMark";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { playedFinish } from "@/lib/finish";
import { finishTreatments } from "@/lib/treatment";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { labelColorCss, labelFgCss } from "./labelColors";
import type { TheoryTier } from "./theoryMatch";

/**
 * The one label a card wears, as an 8px chip in its own colour with the name one hover away.
 *
 * A dot rather than a word: a label is a mark the reader put there and already knows, and a
 * 224px column has no room for a second word beside a card's name.
 *
 * **8px is its size on a card at 100% zoom.** The Grid view lays this on a card face the reader can
 * zoom, so it reads that card's `--mark-scale` (`lib/cardZoom.ts`); the table and text views take
 * the `, 1` fallback and are unchanged. The 1px ring around it does **not** scale — it is a hairline
 * separating the dot from whatever it sits on, which is a job one pixel does at every size.
 */
export function LabelDot({
  name,
  color,
  className,
}: {
  name: string;
  /** The stored palette token, never a CSS colour — see `labelColors.ts`. */
  color: string | null;
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // Redundant with the button's own name: the label's word is already one of
      // `deckCardName`'s clauses (`card.labelName`), so the hint here is for the pointer only —
      // `describes: false` leaves `aria-describedby` unset, which an `aria-hidden` span could
      // not usefully carry anyway.
      {...tip(name, { describes: false })}
      style={{ backgroundColor: labelColorCss(color) }}
      className={cn(
        "size-[calc(0.5rem*var(--mark-scale,1))] shrink-0 rounded-[2px]",
        "shadow-[0_0_0_1px_var(--color-bg)]",
        className,
      )}
    />
  );
}

/**
 * The copy count as a **filled tag in the card's own label colour** — the deck stack's mark, and
 * the one place the label and the quantity are drawn as a single object.
 *
 * ## Why the two were merged
 *
 * The stack draws whole card faces, and the only part of a collapsed one the reader sees is a
 * 34px strip. Two separate marks in it — an 8px dot and a grey count chip — spend that strip
 * twice to say two things a reader takes in as one ("three of these, and they are my ramp").
 * So the count is *printed on* the tag: one object, one glance, and the strip keeps room for
 * the printed name underneath it.
 *
 * **An unlabelled card is grey** — {@link CountTag}'s own `NEUTRAL_COUNT_PAINT`, never the gold a
 * missing token falls to. A filled mark has to be some colour, and if the unlabelled one were
 * gold then gold would stop being something a label says. This is the one caller that draws the
 * distinction, which is why it passes `paint` for a label and nothing at all without one.
 *
 * **The box is {@link CountTag}'s and no longer this file's** — the slant, the height, the mono
 * face, the `aria-hidden` and the number-with-no-`×`. The search wall makes the same statement
 * about a different quantity (how many printings a collapsed tile stands for) and the two have to
 * be one object. What stays here is what makes this one a *label*: the colour it is filled with,
 * the sentence naming both facts, and the z-index below.
 *
 * {@link LabelDot} is untouched and is still what the table, the text columns and the categories
 * panel draw — a row has a column for the count and does not need the two folded together.
 */
export function QuantityTag({
  quantity,
  name,
  color,
  className,
}: {
  quantity: number;
  /** The label's name, or `null` for an unlabelled card. `deck_cards` answers `labelId`,
   *  `labelName` and `labelColor` as a set — all three `null` together — so this decides
   *  both. */
  name: string | null;
  /** The stored palette token, never a CSS colour — see `labelColors.ts`. */
  color: string | null;
  className?: string;
}) {
  return (
    <CountTag
      count={quantity}
      // Both facts, because the count alone would make the colour a riddle and the name alone
      // would make the number one. The words themselves are in `deckCardName`, which is the
      // only text inside a labelled button anyone hears.
      //
      // Still a `title` **prop** — `CountTag` (`components/CountTag.tsx`) owns turning it into
      // a `useTooltip()` binding internally, since that component's file is outside this
      // sweep's list. The prop's name and shape are unchanged, so this call site needed no edit.
      title={name === null ? `${quantity} in this pile` : `${name} · ${quantity} in this pile`}
      // Nothing for an unlabelled card, which is how it lands on the neutral grey — see above.
      paint={name === null ? undefined : { css: labelColorCss(color), fg: labelFgCss(color) }}
      className={cn(
        // **The z-index is load-bearing and `relative` alone was not enough.** This tag has to
        // cover the Game Changer banner tucked 10px under its slanted tail, and the obvious
        // trick — leave the banner static and make this positioned — does not work on flex
        // items: they paint in order-modified document order, so the later sibling won. The
        // lowest rung on the scale, and `layers.ts` has the measurement.
        "relative",
        LAYER.overlappingMark,
        className,
      )}
    />
  );
}

/**
 * What the check means, in words, said once so that the chip's tooltip, the table's `sr-only`
 * twin and `deckCardName`'s clause cannot drift apart.
 *
 * "In the theory list" and not "Planned", "Matches theory" or a tick's worth of nothing: the
 * reader has a tab called **Theory** two inches above the card, and the sentence that costs them
 * no learning is the one naming it. It is also the sentence that does *not* read as a verdict —
 * "matches" invites the question *matches what, and is that good* — which matters more here than
 * anywhere else on the card, because the glyph is a tick and a tick beside a red mark is the one
 * thing this mark must never be mistaken for. See {@link TheoryMatchMark}.
 */
export const THEORY_MATCH_LABEL = "In the theory list";

/**
 * The whole of what blue adds to that sentence — the loose tier said in words.
 *
 * A `name` match is the same *card* in a printing the plan did not name, and
 * {@link THEORY_MATCH_LABEL} alone is true of it: it really is in the theory list. That is exactly
 * why the extra clause is needed rather than optional — the sentence a reader hears would be
 * **identical** on a green mark and a blue one, so the colour would be the only thing carrying the
 * distinction and a reader who cannot see it would be told nothing at all about why this row is
 * not the other one. `theoryMatch.ts` has what the two tiers mean.
 *
 * **Built from {@link THEORY_MATCH_LABEL} rather than written out**, because the exact tier's
 * sentence is the prefix of this one by construction: a reword of the base has to reach both, and
 * two literals sharing four words is two literals that agree until somebody edits one.
 */
export const THEORY_MATCH_NAME_LABEL = `${THEORY_MATCH_LABEL} · a different printing`;

/**
 * What a mark means, in words — the tier and then the count difference, said once so that the
 * chip's tooltip, the table's `sr-only` twin and `deckCardName`'s clause cannot drift apart.
 *
 * **The tier is the first thing it says and it is not defaulted**, for the components' own reason
 * one screen down: a caller that has not thought about which tier this row is in must not be able
 * to word a green sentence over a substitute printing.
 *
 * The count is the second. The mark itself is two characters (`+2`, `-8`) and a sign is not a
 * word: "more than planned" and "fewer than planned" are what the glyph means, and they are the
 * only part of it a reader who cannot see the mark gets. Said here rather than at the three call
 * sites for {@link THEORY_MATCH_LABEL}'s reason.
 *
 * `0` is the base sentence unchanged, which is the tick's own case: adding "0 more than planned"
 * to a card that matches would be the mark explaining itself where there is nothing to explain.
 * `Math.abs` because the sign is already spelled in the words.
 *
 * **The number is at the tier's own grain and this function does not have to know that** — an
 * `exact` row's `-6` is about that printing and a `name` row's `0` is about the card, which is
 * `theoryMatchMark`'s rule and the reason the two arrive here already paired.
 */
export function theoryMatchLabel(tier: TheoryTier, delta: number): string {
  const base = tier === "exact" ? THEORY_MATCH_LABEL : THEORY_MATCH_NAME_LABEL;
  if (delta === 0) return base;
  const word = delta > 0 ? "more" : "fewer";
  return `${base} · ${Math.abs(delta)} ${word} than planned`;
}

/**
 * The difference as the two or three characters the mark draws — `+2`, `-8`.
 *
 * ASCII `+` and `-`, never `−` or `–`: this is set in the tag's `tabular-nums` mono face beside a
 * quantity drawn in the same one, and the typographic minus is not in that face's fixed-advance
 * run — so a `-8` and a `+2` in one deck would be different widths in a box whose whole job is to
 * be the same width as the tag opposite it.
 */
export function theoryDeltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/**
 * How the tick says which one it is, for anything that has to find it **after the fact** — and
 * since 2026-09-07 **which of the two tiers it is**, as the attribute's own value.
 *
 * The same problem `STACK_OPEN_ATTR` and `LANDED_ATTR` solve one file over: the mark used to be
 * addressable by its `title`, and the tooltip sweep moved that text off the DOM attribute a
 * `getByTitle` could read. It is `aria-hidden` and carries no visible text of its own (unlike
 * `RuleBreakMark`'s `RULE BREAK` or `GameChangerBanner`'s spelled-out words), so a test or a
 * live probe needs its own handle rather than `getByText`. On both {@link TheoryMatchMark} and
 * {@link TheoryMatchBadge} — one fact, two drawings, one attribute.
 *
 * **The value is the `TheoryTier`** — `"exact"` or `"name"` — rather than the empty string it
 * carried while there was one tier. That is the whole of how a test or a CDP probe tells the two
 * marks apart **without reading a colour**, which is the one thing neither can do honestly: the
 * fill is a custom property now, jsdom resolves no stylesheet, and a reader who has set their own
 * green in Settings → Appearance has moved the very value an assertion would be pinning.
 * `[data-theory-match]` still selects every mark, so a sweep that counts them is unchanged;
 * `[data-theory-match="name"]` is the new question.
 */
export const THEORY_MATCH_ATTR = "data-theory-match";

/**
 * A card the plan also asks for, as a tick in the shape of that surface's own quantity badge.
 *
 * Drawn only on the **Live** list of a deck that keeps a plan — `theoryMatch.ts` has the whole of
 * when, and the grain it matches on. The statement is "the card in front of you is the one you
 * planned for", which on a live list is the difference between the real thing and the proxy
 * standing in until it arrives.
 *
 * ## It is the surface's own quantity badge, and since 2026-09-08 there is one of those
 *
 * The quantity is the mark a reader's eye already goes to on a deck card, so a second fact drawn
 * in a *different* shape beside it reads as a second kind of object. This is therefore
 * {@link CountTag}'s 22px slanted banner rather than a shape of its own — the tag at one end of
 * the strip and this at the other are one object drawn twice, which is what
 * {@link COUNT_TAG_BOX_MIRRORED} and {@link COUNT_TAG_SLANT_MIRRORED} are exported for and the
 * only thing they are exported for.
 *
 * **It echoed two shapes until 2026-09-08, and the retired one is on the record rather than gone
 * from it.** The two card-face views did not draw the *same* quantity badge: the stack drew that
 * banner and the Grid tile drew a flat 9px chip of its own, so this took a `variant` —
 * `"banner"` or `"chip"` — and echoed whichever it was standing next to. The chip was not a
 * smaller taste, it was the shape that had to **clear `FoilOverlay`'s corner chip**: top-right
 * belongs to that chip on every surface that draws a card as a face, the tile drew one, so the
 * tick **stacked under it**, offset by the chip's own measured box on the cards that had one. The
 * stack's corner was free — it drew `FoilOverlay mark={false}` and said the finish in its foot —
 * so one fact wore two shapes in two corners of one deck, and `variant` was the price of the
 * tile's honesty about a corner it did not own.
 *
 * **The premise went with the tile.** Both card-face views draw one `DeckCardFace` now, which
 * draws `mark={false}` as the stack always did and says the finish in the card's chin — so the
 * corner is the tick's on both, there is nothing left to stack under, and the quantity beside it
 * is the same {@link QuantityTag} banner on both. No second geometry is left to echo, and a prop
 * offering one was drawing one fact a second way for no caller at all.
 *
 * **This is still one fact drawn twice app-wide, and the other drawing is
 * {@link TheoryMatchBadge}** — the table's and the text columns', which have no art to lay a
 * filled mark on. That is the same argument {@link GameChangerBadge} and
 * {@link GameChangerBanner} settle the same way, that one fact may be drawn twice where the two
 * surfaces have genuinely different room. What ended here is a second drawing for two surfaces
 * that turned out to have the *same* room.
 *
 * **The measurement that bought the chip is still true and no longer decides anything.** The
 * banner is 22px on a 210px stacked card and the same 22px on a 150px tile — 7.5 % of the card
 * against 15 % of it — so a wall of tiles read as a wall of blue flags with cards behind them
 * (photographed 2026-08-20). What that pass had in front of it was a banner laid on a bare art
 * tile whose own quantity was the 9px chip. The tile draws the whole 27px marks strip now, with
 * the quantity tag at 22px in the opposite corner, so the weight the chip refused has already
 * been accepted at the other end of the same strip — and refusing it *here* would leave the two
 * bookends mismatched again, which is exactly what issue #212 reported. **Nothing has been
 * re-photographed**: read that as the argument's premise having moved, not as a new measurement.
 *
 * **Echoing the banner means reflecting it** (issue #182). Both are 22px tall and both are cut by
 * the same 10px slant, but the tag is widest along its **top** edge and so is this — a 180°
 * rotation of the polygon puts the bite in the right corner and the taper the wrong way up, which
 * is what shipped and what was reported.
 *
 * **The width parted company with the tag's for one release and no longer does** (issue #212).
 * #182 took this box's paddings down to `6/1`, which fixed the mana cost it was covering and left
 * it visibly the smaller of the two bookends — the reader's report was both halves of that at
 * once. It is `8/3` now over a `min-w` of one digit's worth of the count tag, so a tick and a
 * one-digit quantity draw the same width by construction; {@link COUNT_TAG_BOX_MIRRORED} carries
 * the arithmetic and why a floor rather than a third pair of paddings is what settles it.
 *
 * ## A card the plan asks for a *different number* of says the difference instead of the tick
 *
 * `+2` where the live list holds two more than planned, `-8` where it holds eight fewer, in the
 * same box and the tier's own colour — [issue #212](https://github.com/Msgaihede/mtg-grimoire/issues/212).
 * The tick is what the **matching** card wears, so the two are never drawn together: see the
 * comment on the content below, and `theoryMatch.ts` for what is subtracted from what and for the
 * one rule about singleton decks that keeps this mark off every card of a Commander list.
 *
 * ## The four separations, and the one this mark has to work hardest for
 *
 * A tick is a **verdict-shaped glyph**, and this file's founding rule is that a mark saying a
 * card is fine must never be confusable with {@link RuleBreakMark}, which says a card is a
 * problem. The four separations hold and were the condition of drawing a tick at all: the
 * **place** (this in the top-right corner, the rule break moved to the bottom-left on
 * 2026-08-20 precisely so the two are never adjacent), the **colour** (green or azure against
 * destructive), the **shape** (a filled mark against a hairline box), and the card's own
 * **edge**, which only a rule break changes. A card can be both, and on that card the two marks
 * are in opposite corners saying two unrelated things — which is the arrangement, not an
 * accident of it.
 *
 * **The colour is the one of the four a reader can defeat**, and since 2026-09-07 they can:
 * `--color-theory-exact` and `--color-theory-name` are theirs to set in Settings → Appearance, so
 * nothing stops somebody choosing a red for one of them. That is theirs to do and not this app's
 * to prevent — the other three separations are structural and hold whatever colour is picked,
 * which is exactly why there are four of them rather than one.
 *
 * ## The fill was one azure and is now two colours, and green is no longer disqualified
 *
 * The candidates were photographed 2026-08-20 against the built stylesheet, over real card art,
 * beside the gold banner (`docs/reference/frontend-design.md` has the pass). Two of the three
 * refusals stand unchanged. **Gold** — the obvious first choice, since `bg-accent` is what a chip
 * on a card usually is — put two gold marks in one 27px strip meaning two unrelated things, and
 * read as an extension of {@link GameChangerBanner}. **The neutral count paint** was invisible as
 * a distinction: a grey chip at one end of the strip and a grey chip at the other read as two of
 * the same thing.
 *
 * **The third is reversed.** That pass ruled `--color-ok` out in these words: *it is this app's
 * "nothing is wrong here" colour, which is the one reading a tick must not have.* That was a
 * finding about a mark meaning **this card is in the plan** — a fact, not a verdict — and it stood
 * for as long as the mark said only that.
 *
 * The mark says two things since 2026-09-07. Green is the *exact* tier: this is the printing you
 * planned, which **is** a "nothing is wrong here" verdict and is the one reading it should have.
 * Azure keeps the looser one — the same card in a printing the plan did not name — where the old
 * argument still applies, because that is a fact rather than a verdict.
 *
 * Azure **is** one of the six label colours, and that is the one cost. A card labelled Azure draws
 * an azure {@link QuantityTag} at the other end of this strip — but that mark is a *number* at
 * the opposite end, so the pair are still told apart by content and position, which is the same
 * argument that lets two gold things (a Gold label and the banner) already coexist. **The green is
 * not one of the six**, so the exact tier pays nothing at all here; `#56bd78` is `--color-ok`
 * converted to sRGB and belongs to no label a reader can put on a card.
 *
 * Neither colour is a literal here any more. Both are `--color-theory-*` custom properties, so
 * the reader's own choice in Settings → Appearance moves every surface at once; `src/index.css`
 * holds the defaults — including the `-fg` each fill prints its tick on — and `@/lib/useMarkColors`
 * writes over them.
 *
 * ## `aria-hidden`, like every mark here
 *
 * The surfaces that draw this draw a card as a **button with an explicit `aria-label`**, and a
 * label replaces the element's content for naming — so the words are `deckCardName`'s, where
 * {@link THEORY_MATCH_LABEL} is joined to the rest of the sentence. `TableView` is the exception
 * this file always makes: a cell's text is really read, so there the badge below gets an
 * `sr-only` twin.
 */
export function TheoryMatchMark({
  tier,
  delta = 0,
  className,
}: {
  /**
   * Which of the two statements this mark is making — `theoryMatch.ts`'s `TheoryTier`, and the
   * whole of what decides its colour.
   *
   * **Required, and deliberately not defaulted.** A default would let a caller that has not
   * thought about the tier draw the green *this is the printing you planned* over a substitute
   * printing, which is the exact confusion the two tiers exist to remove — and it would do it
   * silently, on a mark whose whole job is to be believed at a glance.
   */
  tier: TheoryTier;
  /**
   * How many copies the live list holds **over** (positive) or **short** (negative) of what the
   * plan asks for — `theoryMatch.ts`'s `TheoryMark.delta`, which is `0` for the row that matches,
   * where the whole mark is `null` for a card the plan does not ask for at all (drawn as no mark).
   *
   * **It is at {@link tier}'s own grain**, which is that module's rule rather than this one's: an
   * `exact` row's number is about that printing and a `name` row's is about the card, so the two
   * arrive here already paired and nothing is recomputed from a tier here.
   *
   * Defaults to `0`, so a caller that has not thought about counts gets the tick this component
   * has always drawn. The tier above deliberately has no such default.
   */
  delta?: number;
  className?: string;
}) {
  const exact = tier === "exact";
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // The tier as the value, which is how a test and a live probe tell the two marks apart
      // without reading a colour — see {@link THEORY_MATCH_ATTR}.
      {...{ [THEORY_MATCH_ATTR]: tier }}
      // Redundant with `deckCardName`'s own clause (`theoryMatchLabel(tier, delta)`) — the words
      // are already the whole of what a keyboard reader gets from the button this sits inside, so
      // `describes: false` leaves `aria-describedby` unset.
      {...tip(theoryMatchLabel(tier, delta), { describes: false })}
      style={{
        // Mirrored — **reflected** across the vertical axis, not rotated 180°, which is the whole
        // of issue #182 — because this sits in the card's **right**-hand corner; see the constant.
        // Unconditional since the chip went: the slant is what makes this the quantity tag's
        // reflection rather than a box that happens to be the same height.
        clipPath: COUNT_TAG_SLANT_MIRRORED,
        // **Two explicit branches rather than one `--color-theory-${tier}` template**, and the
        // reason is a grep: the four property names have to be findable from this file, which is
        // the only place they are read. It is also why this is an inline style and not a Tailwind
        // arbitrary value — a mistyped `bg-[…]` emits no rule at all, silently, and neither suite
        // nor Storybook can go red for a mark drawn in nothing. (Written `[…]` rather than spelled
        // out for a second reason: Tailwind scans comments too, so a whole class name in prose is
        // a rule in the built sheet that nothing on screen wears.)
        backgroundColor: exact ? "var(--color-theory-exact)" : "var(--color-theory-name)",
        // The fill is the reader's to change, so what is legible on it cannot be a fixed token:
        // `useMarkColors` recomputes each `-fg` from the fill's own luminance.
        color: exact ? "var(--color-theory-exact-fg)" : "var(--color-theory-name-fg)",
      }}
      className={cn(
        // **The mirrored box, and the pairing is not optional** (issues #158, #182 and #212). The
        // slant above and the paddings that centre content inside it are one shape: worn with
        // `COUNT_TAG_BOX`'s paddings, this tick sat 5.5px left of its own banner's visible centre
        // and was reported as left-aligned. The pair is `8/3` now — the same `pl − pr = 5px`
        // centring, over a `min-w` that holds this to the quantity tag's own width — and the
        // constant carries the arithmetic all three issues are instances of.
        COUNT_TAG_BOX_MIRRORED,
        // No fill and no foreground here: both are the `style` above, per the tier. Nothing else
        // about the box changes with the tier.
        className,
      )}
    >
      {/* **The number replaces the tick rather than joining it** (issue #212). A tick beside a
          `-8` would be a mark saying "this is the card you planned" next to one saying "and you
          have eight too few" — two clauses of one sentence in a 25px box, at the end of a strip
          whose other mark is already a number. The tick is what the *matching* card wears, and
          the difference is what a card that does not match wears instead.

          It needs no size of its own: the box's `font-mono tabular-nums` face is
          {@link COUNT_TAG_FACE}'s, so the digits are drawn at exactly the size and advance the
          quantity tag opposite draws its own in — which is the whole reason `min-w` upstream can
          be stated in `ch`. */}
      {delta === 0 ? (
        // 12px is the size {@link FinishMark} is drawn at, because the two are marks on one card
        // face and a tick larger than the foil sparkle would read as the more important of the
        // two. It was 12px on the stack against 9px on the Grid tile while the chip existed; both
        // views draw one card face now, so one size is the whole answer. `strokeWidth` above
        // lucide's 2 default: a tick is three strokes and no fill, so on art it needs the weight
        // the crown gets from its body.
        <Check
          className="block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0"
          strokeWidth={3}
          aria-hidden="true"
        />
      ) : (
        theoryDeltaText(delta)
      )}
    </span>
  );
}

/**
 * The same fact for the two views that draw **no art** — the table's rows and the text columns.
 *
 * A row of type has no corner to lay a banner in, so this is the glyph alone, in the same colour
 * {@link TheoryMatchMark} is *filled* with — `--color-theory-exact` for the exact tier and
 * `--color-theory-name` for the loose one, set as text here rather than as a background. One
 * colour per tier on every surface; only the size and the box change.
 *
 * **It takes no `-fg`, and that is the difference between the two components rather than an
 * omission.** The banner prints its tick *on* the fill and so needs to know what is legible
 * against it; this draws the glyph in the colour itself, on the view's own background, so there
 * is nothing printed on anything.
 *
 * ## It is deliberately **not** {@link GameChangerBadge}'s outlined box, and that is a finding
 *
 * The first draft was, on the obvious reasoning that the marks inline beside a card's name should
 * be one family. Drawn, it was a **checkbox**: a hairline box with a tick inside it is the one
 * control every reader already knows, and a row of them down a decklist reads as something to
 * click. `GC` gets away with the box because it contains *letters*. So the box goes and the tick
 * stands on its own, which is what {@link DeckFinishMark} beside it already does.
 *
 * No `--mark-scale` anywhere in it: neither surface is a card face, so neither zooms.
 *
 * ## The difference is drawn here too, and it is the one place that took an argument
 *
 * Issue #212 is written about the card face, where the mark is a badge beside a quantity badge.
 * These two views draw a **quantity column** instead, so the shortfall is arguably already
 * answerable by reading a number the reader would have to hold the plan in their head to compare
 * against — which is exactly the work the mark exists to save. So `+2` and `-8` are drawn here as
 * well, in the tier's own colour, and the rule stays one rule across all four views: a tick is the
 * card that matches, a signed number is the card that does not.
 *
 * It keeps no box of its own for it, for this component's founding reason — a hairline box with
 * content inside reads as a control — so the number is bare type in the same colour as the glyph,
 * in the mono `tabular-nums` face every count in these two views is set in.
 */
export function TheoryMatchBadge({
  tier,
  delta = 0,
  className,
}: {
  /** See {@link TheoryMatchMark.tier} — required for that component's reason, and the whole of
   *  what decides this glyph's colour. */
  tier: TheoryTier;
  /** See {@link TheoryMatchMark.delta} — `0` is the row that matches, and the tick. */
  delta?: number;
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // The tier as the value — see {@link THEORY_MATCH_ATTR}.
      {...{ [THEORY_MATCH_ATTR]: tier }}
      // Redundant with `deckCardName`'s own clause, exactly as `TheoryMatchMark`'s is.
      {...tip(theoryMatchLabel(tier, delta), { describes: false })}
      // The text colour only — there is no fill to print on. Two explicit branches and an inline
      // style for `TheoryMatchMark`'s two reasons: the property names have to be greppable, and a
      // mistyped Tailwind arbitrary value emits no rule at all.
      style={{ color: tier === "exact" ? "var(--color-theory-exact)" : "var(--color-theory-name)" }}
      // 12px, matching `DeckFinishMark`'s glyph on the same line rather than `GC`'s 9px type —
      // a stroked tick needs the height that two letters in a box do not. The number takes the
      // 9px `GC` is set at instead, because two characters of type beside a card's name is what
      // that badge already is and a 12px one would out-shout the name it sits next to.
      className={cn(
        "flex shrink-0 items-center",
        delta !== 0 && "font-mono text-[0.5625rem] leading-3 tabular-nums",
        className,
      )}
    >
      {delta === 0 ? (
        <Check className="block size-3" strokeWidth={3} aria-hidden="true" />
      ) : (
        theoryDeltaText(delta)
      )}
    </span>
  );
}

/**
 * A game changer, as two gold letters.
 *
 * Gold and abbreviated on purpose: it is a fact about the card, not a problem with the deck,
 * and a deck may hold a dozen of them legally. `bracket.ts` counts them into an advisory;
 * nothing about one is a finding.
 */
export function GameChangerBadge({ className }: { className?: string }) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // Redundant with `deckCardName`'s own "game changer" clause — the words are already the
      // whole of what a keyboard reader gets from the button this sits inside.
      {...tip("Game changer", { describes: false })}
      className={cn(
        "shrink-0 rounded-[2px] border border-pie-gold px-0.5 font-mono text-[0.5625rem]",
        "leading-3 text-pie-gold",
        className,
      )}
    >
      GC
    </span>
  );
}

/**
 * The same fact as a **stamped gold banner**, for the one surface with room to spell it out.
 *
 * `GC` is what a 150px grid tile and a table row can afford; a 210px card face in the stack can
 * carry the words, and it should — two letters are a code the reader has to have learnt, and
 * this is the surface a new reader meets the concept on. The four separations
 * {@link RuleBreakMark} must keep are all still kept, which is the only thing that made
 * spelling it out safe: the **words** differ (`Game Changer` against `RULE BREAK`), the
 * **colour** differs (the gold stamp against destructive), the **place** differs (tucked into
 * the title strip on the left against the top-right corner), and only a rule break changes the
 * card's own **edge**.
 *
 * ## The two details that are not decoration
 *
 * **It is deliberately not positioned, and that is no longer what decides the paint order.**
 * It sits 10px under {@link QuantityTag}'s slanted tail, and the tag has to be the one on top.
 * The first attempt did it by leaving this static and marking the tag `relative`, on the rule
 * that a positioned element paints above a static sibling — **which is false for flex items**,
 * as the shipped window then demonstrated. `LAYER.overlappingMark` on the tag is the answer;
 * this staying static is now only tidiness.
 *
 * What it still buys is the fold — the dark seam that makes the ribbon read as folded rather
 * than printed. It is a **background layer** rather than an absolutely positioned child, which
 * costs nothing and means this element never has to be a containing block for anything.
 *
 * The lettering is `font-heading` at 8px, which is the one place Cinzel goes under the 18px its
 * brief sets. A seal is the exception the brief is about the absence of: two fixed words, never
 * body text, never a string that can grow — and the serif is what makes it read as *stamped
 * into* the metal rather than typed on it.
 *
 * ## Every number in it is a number at 100% zoom
 *
 * This is stamped across a card face in the deck's stack view, which the reader zooms from 0.5× to
 * 2× — so the height, the paddings, the tuck, the crown, the lettering **and the tail's own
 * geometry** are all multiplied by that card's `--mark-scale` (`lib/cardZoom.ts`). The tail is the
 * part that could not be left out: the notch, the fold's 5px band and the 9px it is offset by are
 * one drawing, and holding any of the three still turns the ribbon into a rectangle with a dent at
 * one end of the range and a chevron at the other. `tracking` is already `em`-relative, so it
 * follows the lettering without being named here; the drop shadow does not scale, because a shadow
 * that doubles reads as the banner lifting off the card.
 */
export function GameChangerBanner({ className }: { className?: string }) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // Redundant twice over: the words are `deckCardName`'s "game changer" clause **and**
      // already spelled out on the ribbon itself ("Game Changer", below) — a hint repeating
      // visible text is the other half of the `describes: false` rule.
      {...tip("Game changer", { describes: false })}
      style={{
        // The ribbon's forked tail. The notch is cut into the *right* edge, so the banner
        // points away from the tag it emerges from rather than back into it.
        clipPath:
          "polygon(0 0, 100% 0, calc(100% - 10px*var(--mark-scale,1)) 50%, 100% 100%, 0 100%)",
        backgroundImage: "linear-gradient(90deg, rgba(0,0,0,0.30), rgba(0,0,0,0.05))",
        backgroundSize: "calc(5px*var(--mark-scale,1)) 100%",
        backgroundPosition: "right calc(9px*var(--mark-scale,1)) top",
        backgroundRepeat: "no-repeat",
      }}
      className={cn(
        "-ml-[calc(0.625rem*var(--mark-scale,1))] mt-[calc(0.25rem*var(--mark-scale,1))] flex",
        "h-[calc(0.75rem*var(--mark-scale,1))] flex-none items-center",
        "gap-[calc(0.25rem*var(--mark-scale,1))] bg-pie-gold-deep",
        "pl-[calc(0.875rem*var(--mark-scale,1))] pr-[calc(21px*var(--mark-scale,1))]",
        "text-accent-fg shadow-[0_1px_5px_rgba(0,0,0,0.45)]",
        className,
      )}
    >
      <Crown
        className="block size-[calc(9px*var(--mark-scale,1))] shrink-0"
        strokeWidth={2.5}
        aria-hidden="true"
      />
      <span
        className={cn(
          "font-heading text-[calc(0.5rem*var(--mark-scale,1))] leading-none font-semibold",
          "tracking-[0.06em] whitespace-nowrap",
          "[text-shadow:0_1px_0_rgba(255,255,255,0.25)]",
        )}
      >
        Game Changer
      </span>
    </span>
  );
}

/**
 * A rule this card breaks, spelled out in the destructive colour with the whole sentence one
 * hover away.
 *
 * Errors only — `ruleBreak` in `violations.ts` is what decides, and a warning (an orphaned
 * row, a legality blob this app cannot read) is a fact worth a look rather than a rule the
 * reader broke. It is drawn over the art rather than beside the name so that it cannot be
 * mistaken for part of the card's own printed line.
 *
 * **9px and its padding are what it measures at 100% zoom.** Both surfaces that draw it — the
 * stack's card and the Grid view's tile — are card faces the reader can zoom, so both read that
 * card's `--mark-scale` (`lib/cardZoom.ts`). The border, the radius and the vertical padding stay
 * where they are: all three are one pixel or three, and a hairline is a hairline at every size.
 */
export function RuleBreakMark({ text, className }: { text: string; className?: string }) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      // Redundant with `deckCardName`'s own `rule break: ${text}` clause — the button beside
      // this mark already says the finding in full to a keyboard reader.
      {...tip(text, { describes: false })}
      className={cn(
        "rounded-[3px] border border-destructive/50 bg-bg/85 py-px",
        "px-[calc(0.25rem*var(--mark-scale,1))]",
        "font-mono text-[calc(0.5625rem*var(--mark-scale,1))] text-destructive",
        className,
      )}
    >
      RULE BREAK
    </span>
  );
}

/**
 * The 2px stripe down the left of a text or table row that says, at a glance down a column of
 * eighty, which rows are worth stopping at.
 *
 * Destructive beats gold: a card that is both a game changer and a rule break is a problem
 * first. `transparent` rather than nothing, so every row keeps the same 2px of indent and the
 * names stay in one column.
 */
/**
 * Which object a deck row plays, for the two views that draw **no art** — the table's rows and
 * the text columns.
 *
 * The two views with a card face say this in `FoilOverlay`'s chip, in the art's top-right
 * corner. A row of text has no corner, so it borrows the printings list's answer: the glyph
 * beside the name.
 *
 * **It carries a name on one of its two surfaces and not the other, and that is this file's
 * general rule rather than an exception to it.** `FinishMark` is a `role="img"` with the finish
 * as its accessible name; `TableView` draws rows, where a name inside a cell is really read, so
 * there it says itself. `TextView`'s row is a **button with an explicit `aria-label`** — which
 * replaces its content for naming — so there it is decoration and the word is `deckCardName`'s,
 * exactly as the `GC` badge beside it is. Neither surface has to remember which: the label
 * carries the finish on every view, so this is free to be either.
 *
 * Nothing at all for the regular copy, which is the rule `soleFinish` and `FINISH_LABEL` are
 * both written by: nonfoil is the finish a card is assumed to be — **unless the cardboard has a
 * name of its own**, which is what a trait like Serialized or Poster is (`@/lib/treatment`).
 *
 * The treatment is read against `playedFinish`'s answer and not against the printing, so the
 * deck's own statement still leads: a row that says it sleeves the plain copy of a Surge Foil
 * printing is not called a Surge Foil.
 */
export function DeckFinishMark({
  card,
}: {
  card: Pick<DeckCard, "finish" | "finishes" | "promoTypes">;
}) {
  const finish = playedFinish(card.finish, card.finishes);
  const treatments = finishTreatments(card.promoTypes, finish);
  if (finish === null && treatments.length === 0) return null;
  return <FinishMark finish={finish ?? "nonfoil"} treatments={treatments} />;
}

export function rowMarkColor(ruleBreakText: string | null, gameChanger: boolean | null): string {
  if (ruleBreakText !== null) return "var(--color-destructive)";
  return gameChanger === true ? "var(--color-pie-gold)" : "transparent";
}
