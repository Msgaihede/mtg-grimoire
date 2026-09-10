/**
 * A deck card's **face**: the whole printed card, with the app's own marks laid over it.
 *
 * ## One component because two views draw one object
 *
 * `CardStack` built this inline and `views/GridView` drew `components/CardArt` with a set of
 * corner marks of its own, so the deck a reader was building said different things about the
 * same card depending on which of two drawings of it they were looking at: the stack had the
 * printed frame under the picture (the name, the cost, the type line, and the three words the
 * no-picture states say), the quantity tag folded together with the reader's label, and the
 * `Game Changer` ribbon; the tile had a bare 5:7 frame, a `bg-accent` count chip, a separate
 * `LabelDot` and the crown in `FoilOverlay`'s chip. Neither was wrong on its own. Two of them on
 * one screen, one toolbar press apart, is the failure this folder's rules keep naming — so the
 * face is one component and the two views differ only in the box they put it in.
 *
 * ## What it draws, and what it deliberately does not
 *
 * Over the picture go facts about the **deck** — how many copies, which label, whether the deck's
 * plan asks for this card, whether a rule is broken — because they answer "what is this card doing
 * in this pile" and belong on the reveal strip a collapsed stack shows. Under the face goes the
 * chin, which is facts about the **printing**; that is the caller's, because the two views join it
 * to their card differently (`CardChin`'s `seam`) and only the caller knows what else belongs in
 * it.
 *
 * Not `components/CardArt`, which is the 5:7 box with its own no-art fallback and its own retry:
 * the height here is a **computed pixel count** that the stack's whole geometry rests on, and the
 * frame under the picture has to fill exactly it. That is the exemption `src/CLAUDE.md` already
 * grants the stack's card, and the Grid tile is inside it now rather than beside it.
 *
 * **This is also what closes the artist-credit gap on both surfaces.** Scryfall's guideline asks
 * that the illustrator be identifiable wherever a bare `art` crop is shown — *or* that the same
 * interface show a full card image. {@link DECK_CARD_VARIANT} is `display` (672×936) — a whole
 * printed card carrying its own credit — so both deck card views satisfy the second arm with
 * nothing added.
 *
 * ## It takes a width and no zoom
 *
 * Every length drawn *on* the card reads `--mark-scale`, which both card roots already publish
 * through `cardScaleVars(zoom)` — so the one number this component needs is how wide the card is,
 * and the height falls out of {@link cardFaceHeight}. A `zoom` prop would be a second way to ask
 * the same question, and the two would disagree the first time a caller passed one and not the
 * other.
 */
import { FoilOverlay } from "@/components/CardArt";
import { CardImage } from "@/components/CardImage";
import { ManaText } from "@/components/ManaText";
import { playedFinish } from "@/lib/finish";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { QuantityTag, RuleBreakMark, TheoryMatchMark } from "./CardMarks";
import { DECK_CARD_VARIANT, LandedMark } from "./cardControl";
import type { TheoryMark } from "./theoryMatch";

/**
 * A Magic card's proportions, taken from the `grid` variant's own 488×680 — the image these cards
 * draw, so the frame cannot disagree with its contents about what shape a card is.
 *
 * **It lives here rather than in `CardStack`, which is where it was until the face became one
 * component.** The stack's `stackImageHeight(zoom)` is `cardFaceHeight(stackCardWidth(zoom))` now,
 * so there is one spelling of a card's shape and the two views cannot draw two.
 */
export const CARD_ASPECT = 680 / 488;

/**
 * The face's height for a card drawn this wide — the one number the stack's whole geometry rests
 * on, and the one the Grid tile's picture takes too.
 *
 * Off the **rounded** width the browser actually paints rather than off an unrounded one, because
 * deriving the height from a fraction of a pixel puts the frame a fraction out of shape at exactly
 * the zooms where the rounding bites.
 */
export function cardFaceHeight(width: number): number {
  return Math.round(width * CARD_ASPECT);
}

/**
 * The face's own corner: **the card's `rounded-lg` less the 1px border the face sits inside.**
 *
 * A bordered box has two curves, not one — the border box's, and the padding box's one border
 * width tighter — and the face fills the padding box exactly, so this number is the second of
 * them or it is wrong. `src/index.css` sets `--radius: 0.625rem` and `--radius-lg: var(--radius)`,
 * so the card's outer corner is **10px** here rather than Tailwind's stock 8, and the padding
 * box's is **9**.
 *
 * **It was `rounded-[7px]` until 2026-09-10, which is the stock-8 arithmetic**, and 2px too tight
 * is not a rounding preference: everything between the two arcs is *border*, and a face that
 * clips 2px wide of it has a background and a picture and marks to paint over the card's own edge
 * with. So the edge lost its corners — the arc simply did not draw between the top edge and the
 * side edge — and it lost them on every card in both deck views, in whatever colour that card's
 * edge was.
 *
 * **A rule break is where it was reported, because that edge is the one a reader is meant to
 * read.** Driven in Storybook over the dev server (headless Edge, 2026-09-10, `Decks/CardStack`'s
 * `RuleBreakAndGameChanger` and `Decks/Views/GridView`'s `Default`): at 7px the destructive arc
 * was **missing from four pixel rows at each top corner**, with the quantity tag's fill standing
 * in its place — which is exactly what the screenshot that opened the issue shows. At 9px the arc
 * is continuous from the top edge round to the side at both corners, both views, unchanged
 * everywhere else.
 *
 * **Only the *top* two corners ever showed it**, and that is `CardChin`'s doing rather than luck:
 * the chin is `-mx-px border-x` in the card's own `tone`, so it redraws the bottom two corners
 * over whatever the face did to them. **The chin's own `rounded-b-[7px]` is therefore not this
 * number and must not be changed to it** — its box is the *border* box horizontally and the
 * padding box vertically, so it is neither curve; patched to 9px live on the same tile, its
 * border left the card's and the bottom corner read as a 4px smear of two arcs where 7px reads as
 * one. Measured, not reasoned.
 *
 * Written out as a whole class name and never assembled, because Tailwind scans source text: a
 * computed one emits no rule at all and the face would silently have no corner.
 */
const FACE_RADIUS = "rounded-[9px]";

/**
 * The one strip of a collapsed card the reader can see — its printed title bar — as the box the
 * app's own marks are laid over.
 *
 * ## The marks go left, and they used to go right
 *
 * The reversal is the point of keeping this a named constant. The old rule was "never the left,
 * because a printed name is left-aligned and a collapsed stack is read down this strip", and it
 * was right about a **grey chip**: a rectangle of app furniture over the first four characters of
 * a card's name buys nothing and costs the one thing the strip is for.
 *
 * What changed is what is in the corner. {@link QuantityTag} is not a chip — it is the card's
 * label, in the label's colour, with the copy count printed on it, cut to a banner rather than a
 * box. Down a fifteen-card stack that column of colour *is* the structure of the pile, and a
 * reader scans it before they read a single name. Putting it where the eye starts is what makes
 * the scan work; putting it on the right made it a footnote to fifteen names.
 *
 * The cost is real and is paid knowingly: roughly 34px of printed name, which is three or four
 * characters. Two things make it survivable — the name is on the **card pane, the table, the text
 * columns and the button's own accessible name**, none of which this covers; and the no-picture
 * frame under the art insets its own name band by exactly this width ({@link FRAME_NAME_INSET}),
 * so the one case where the app is drawing the name itself never hides a character of it.
 */
const CARD_MARKS_STRIP = cn(
  // **Flush to both of the card's edges, and the right one stopped being an exception on
  // 2026-08-21** (issue #158). It was inset `5px × --mark-scale` "to keep the strip off the card's
  // own clipped corner" — a rule from when the strip's marks were drawn on the *right* and the
  // corner they were tucked into was a `RULE BREAK` box with a hairline border, which a radius
  // really would have clipped a side off. The marks went left in 2026-08-13 and the inset stayed,
  // so the only thing left at that end was {@link TheoryMatchMark}: a filled banner, standing 5px
  // short of an edge its opposite number sits flush against, with a square corner floating where
  // the card's is round. The face is `overflow-hidden` at {@link FACE_RADIUS}, so `right-0` gets
  // that mark the same clipped corner {@link QuantityTag} has always had at `left-0` — the two are
  // bookends now in radius as well as in slant. **That clip is what the card's own edge depends
  // on**: these two marks are the brightest things in the strip and the corners are where they
  // meet the border, so the radius being one border-width off is the whole of what that constant
  // is about.
  "absolute inset-x-0 top-0 flex items-start",
  // 27px is the printed title bar's height **on a card at 100% zoom**. It scales with the card:
  // the strip is a scrim over a band of the picture, so a fixed 27px is most of a halved card's
  // art and a sliver of a doubled one's. `--mark-scale` is the card's own factor —
  // `lib/cardZoom.ts`.
  "h-[calc(27px*var(--mark-scale,1))]",
);

/**
 * How far the no-picture frame's name band is inset from the left, so {@link QuantityTag} never
 * covers a character of a name the **app itself** drew.
 *
 * A printed card's name is Wizards' to place and this component covers 34px of it knowingly
 * ({@link CARD_MARKS_STRIP}). A name this file writes is not, and there is no reason to repeat the
 * compromise where there was no constraint forcing it.
 *
 * **34px is what the tag covers at 100% zoom, and the tag scales**, so the inset scales with it.
 * Left fixed it would be wrong at both ends: a band indented 34px on a 105px card is most of the
 * name gone for a tag drawn at 17, and 34px on a 420px card leaves a gap the tag no longer reaches
 * across.
 *
 * **It is a CSS expression rather than `scaled(34, zoom)`, and that is what lets this component
 * take no zoom at all** (see the file header). It was the multiplication until the face became one
 * component, and the swap loses nothing: `--mark-scale` is *exactly* the factor the tag covering
 * this band is drawn at, and both card roots already publish it through `cardScaleVars(zoom)` — so
 * the inset and the thing it is an inset for cannot come apart, where two multiplications off one
 * prop could. It is written out in full and never interpolated, because a `calc()` assembled from
 * a constant is a string no grep for `34px` finds.
 */
const FRAME_NAME_INSET = "calc(34px * var(--mark-scale, 1))";

/**
 * The no-picture frame's two bars, tinted a step off the surface they sit on.
 *
 * The hairline colour at 35 % rather than a token of its own: the bars have to be *found* against
 * the card body without being read as content, which is a hairline's whole job at a larger area.
 * `color-mix` rather than an alpha, so the bar is opaque — the card behind it is the same colour,
 * but the marks strip's scrim is not.
 */
const FRAME_BAR = "color-mix(in oklab, var(--color-border) 35%, var(--color-surface))";

export interface DeckCardFaceProps {
  card: DeckCard;
  /**
   * How wide the card is drawn, in px — the stack's `stackCardWidth(zoom)` and the Grid tile's
   * `scaled(TILE_WIDTH, zoom)`. The height follows by {@link cardFaceHeight} and nothing else here
   * takes a length: everything drawn *on* the card reads `--mark-scale`, which the caller's own
   * root publishes.
   */
  width: number;
  /** The sentence the `RULE BREAK` mark carries, or `null` when there is nothing wrong. */
  ruleBreakText: string | null;
  /** What the deck's plan says about this row — `theoryMatch.ts`'s `theoryMatchMark`, resolved by
   *  the caller so the face is handed an answer rather than a plan to look itself up in. `null` is
   *  a card the plan does not ask for; otherwise the tier it is in and how far the live list is
   *  from the plan **at that tier's own grain**, where `0` is the card the plan asks for exactly. */
  theoryMark: TheoryMark | null;
  /**
   * Whether a deck note names this card — resolved by the caller through
   * `cardControl.ts`'s `deckCardNoted`, so the face is handed an answer rather than a set to look
   * itself up in. That is {@link theoryMark}'s arrangement above, and its reason: an orphan
   * printing has no oracle id, and the guard that keeps such a card unmarked belongs in one place
   * rather than at each of the four views.
   *
   * **Optional and defaulting to `false`, where the two marks above it are required** — see
   * `QuantityTag.noted`, whose asymmetry this mirrors: an unmarked card is one whose note the
   * reader finds a press away in the Notes band, not a card quietly claimed to be ordinary.
   */
  noted?: boolean;
  /** The nonce this card's last add was given, or `undefined` for a card that did not just arrive
   *  — passed through as the mark's `key`, so a second add replays it. */
  landedKey: number | undefined;
  className?: string;
}

/**
 * The card, drawn at {@link DeckCardFaceProps.width}: the printed frame, the picture over it when
 * there is one, and the deck's own marks over that.
 *
 * It is the whole of what goes inside a deck card's button, and it renders exactly one element —
 * both views address it as the button's first child.
 */
export function DeckCardFace({
  card,
  width,
  ruleBreakText,
  theoryMark,
  noted = false,
  landedKey,
  className,
}: DeckCardFaceProps) {
  // The whole card ({@link DECK_CARD_VARIANT}, which is `display` at 672×936), not the `art` crop.
  // Fed `null` for an orphan, whose printing has left the card database — nothing tries to draw a
  // picture of a card that is not there, and the hook's null story is "no state machine at all".
  //
  // **The comment this moved from said `grid`, 488×680.** That was true when the stack was written
  // and stopped being true when the walls learnt to zoom and every deck surface went to `display`;
  // it is corrected here rather than carried across, because a moved comment is the last place a
  // stale number gets read.
  const face = useImageRetry(
    // **`cardArtSrc` is called here rather than inside `CardArt`** — these two views build their
    // own `<img>` (the height is a computed pixel count, not 5:7), so this is the one deck surface
    // that has to make the desktop/web choice itself. Both candidates go in and one URL comes out:
    // the protocol on Tauri, the row's own URL on web, and `null` for an orphan or a printing with
    // no picture, which is what the frame under it already draws for.
    cardArtSrc(
      card.needsReview === null ? cardImageUrl(card.cardId, 0, DECK_CARD_VARIANT) : null,
      card.imageUris?.[DECK_CARD_VARIANT],
    ),
  );
  const finish = playedFinish(card.finish, card.finishes);
  // There is a URL and it has not failed. Not "the bytes have arrived" — nothing here can know
  // that, and nothing needs to: the frame underneath is what shows while they are on their way.
  const drawing = face.src !== null && !face.failed;

  return (
    /* The card. An explicit height rather than an `aspect-[488/680]`, because the stack's
       arithmetic depends on this number being exactly {@link cardFaceHeight} of the width the
       column was sized from — and it is set here, from that same function, so the frame and that
       file's own sums cannot drift.

       `object-cover` against a 210:293 box where the card is 210:292.6, which crops **0.4px** off
       it. Worth taking over `object-contain`: a fraction of a pixel of the card's border is
       invisible, and a letterbox bar between the printed frame and an overlay strip would not be.
       The rounding is at most half a pixel at any zoom, for the same reason.

       An inline style rather than a height utility, and not merely by preference: Tailwind scans
       source text for whole class names, so a computed one emits no rule at all and the card would
       silently have no height. */
    <span
      style={{ height: cardFaceHeight(width) }}
      className={cn("relative block overflow-hidden bg-surface", FACE_RADIUS, className)}
    >
      {/* **The frame under the picture, drawn whether or not there is one.**

          It used to be the picture's `else` — a name and a reason, centred in an empty box — and
          that made the commonest state of this component the ugliest: a hundred-card category is a
          hundred lazy `<img>`s, and until each one's bytes land its card is a grey rectangle. The
          card is *known* before its picture is; what was missing was anywhere to put what is known.

          So it is a printed card's own three bands, in the app's hand: name and cost in the title
          bar, the reason in the middle where the art goes, the type line at the foot. A stack
          scrolling into view now reads as cards resolving rather than as boxes filling, and the
          three no-picture states inherit the frame instead of each being a consolation. The reason
          band is empty when there is a picture on the way — the frame is a backdrop then, and a
          backdrop should say nothing.

          **The Grid tile inherits all three words with the frame** (`No image`, `No card`,
          `Retrying…`), where it used to draw `CardArt`'s own smaller fallback. That is the drift
          this component removes rather than a new state. */}
      <span className="absolute inset-0 flex flex-col bg-surface">
        {/* Every length in the three bands is a length on a card at 100% zoom. The frame stands in
            for the printed card, so it scales with it exactly as the picture that replaces it does
            — a fixed 11px name inside a 420px frame is the app announcing that it gave up drawing
            a card. The two hairline borders do not scale, for `STACK_CARD_BORDER`'s reason. */}
        <span
          style={{ background: FRAME_BAR, paddingLeft: FRAME_NAME_INSET }}
          className={cn(
            "flex items-center border-b border-border",
            "h-[calc(27px*var(--mark-scale,1))] gap-[calc(0.375rem*var(--mark-scale,1))]",
            "pr-[calc(0.375rem*var(--mark-scale,1))]",
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              "text-[calc(0.6875rem*var(--mark-scale,1))]",
            )}
          >
            {card.name}
          </span>
          <ManaText
            source={card.manaCost}
            className="shrink-0 text-[calc(0.625rem*var(--mark-scale,1))] leading-none"
          />
        </span>
        <span
          className={cn(
            "flex flex-1 items-center justify-center text-center text-dim",
            "px-[calc(0.5rem*var(--mark-scale,1))] text-[calc(0.625rem*var(--mark-scale,1))]",
          )}
        >
          {drawing
            ? ""
            : face.retrying
              ? "Retrying…"
              : card.needsReview !== null
                ? "No card"
                : "No image"}
        </span>
        <span
          style={{ background: FRAME_BAR }}
          className={cn(
            "flex items-center truncate border-t border-border",
            "h-[calc(1.25rem*var(--mark-scale,1))] px-[calc(0.375rem*var(--mark-scale,1))]",
            "text-[calc(0.5625rem*var(--mark-scale,1))]",
          )}
        >
          {card.typeLine}
        </span>
      </span>

      {drawing && (
        <CardImage
          src={face.src as string}
          // Decoration: the button around this face already says the card's name, and an `alt`
          // repeating it would have a screen reader read every card twice.
          alt=""
          // Lazy, because both views that draw this are plain scrollers rather than virtualised
          // walls — a hundred-card category really is a hundred mounted cards, and the browser's
          // gate is the only thing bounding what they ask for.
          loading="lazy"
          onError={face.onError}
          // `relative` and not `absolute`: it has to paint over the frame above it, and a
          // positioned sibling later in the document does that with no z-index at all.
          className="relative block size-full object-cover"
        />
      )}

      {/* The sheen without the chip — the finish is said in words on the chin below, where there
          is room for the word and no corner to compete for. `mark={false}` takes the crown with
          it, and that is still exactly why this card's top-right corner belongs to
          {@link TheoryMatchMark} on both views rather than to a foil chip. The crown itself is not
          lost with the chip: it is printed on the quantity tag at the other end of the strip. */}
      <FoilOverlay finish={finish} mark={false} />

      {/* The reveal strip: what the app knows that the printed card cannot. Over the card's own
          title bar and **left-aligned**, which is a reversal — {@link CARD_MARKS_STRIP} has the
          whole of why. The scrim is what keeps a mark legible over art of any brightness. */}
      <span className={cn(CARD_MARKS_STRIP, "bg-gradient-to-b from-bg/70 to-transparent")}>
        {/* **One mark for the label, the count and the game changer**, which is what the Grid tile
            gave up a `LabelDot` and a `bg-accent` chip for and what took the strip's second gold
            object out of it: the count is printed on the label's own colour, grey where there is
            no label, so gold stays a thing a label means — and a game changer wears a crown in
            front of the number, in whatever foreground that colour is legible in.

            **Folding the crown into the tag is what let both views draw one mark again, and the
            measurement is why it had to be folded.** The marks in this strip are each sized off
            `--mark-scale`, so their widths do not shrink when the card does: driven in the shipped
            window 2026-09-08 (debug build, 1920×1080, a real Commander deck at `cardZoom` 1.1), a
            **165px** Grid tile carried a 28px tag, a **130px** `Game Changer` ribbon and a 28px
            tick in a 163px box — **11px of overflow** past an `overflow-hidden` face, clipping the
            plan's tick by nearly half. Every term scales with the zoom, so the ratio is constant
            and the clip was at *every* stop of the ladder; photographed at 2× to be sure. That
            bought a `"banner" | "crown"` fork on this component for one morning — the spelled-out
            ribbon for a 210px stacked card, the bare crown for the tile — which is one fact drawn
            two ways on two drawings of one deck.

            The crowned tag is roughly **42px** at its widest, narrower than either arm of that
            fork, so the strip's widest term is the tag itself and there is nothing left for a fork
            to decide: the stack and the tile draw the same mark, in the same corner, at both ends
            of the ladder. The fact is printed *on* the mark a reader is already reading rather
            than beside it, which is {@link QuantityTag}'s own merge argument reaching one fact
            further. `RuleBreakMark` is still red, boxed and in the card's opposite corner — see
            `CardMarks.tsx` for why that pair is drawn once and what keeps the two from being
            confusable. */}
        <QuantityTag
          quantity={card.quantity}
          name={card.labelName}
          color={card.labelColor}
          // `DeckCard.gameChanger` is `boolean | null` — an orphan whose printing has left the
          // corpus says nothing either way — so the coercion is what keeps a `null` off a prop
          // whose two states are *crowned* and *not*.
          gameChanger={card.gameChanger === true}
          // The fifth per-card fact, folded into this tag rather than drawn beside it — there was
          // no corner left, and `CardMarks.tsx`'s census and its 11px overflow measurement are
          // the argument. A card that is both a game changer and noted draws both glyphs and the
          // number; the words for both are `deckCardName`'s, since this tag is `aria-hidden`.
          noted={noted}
        />
        {/* The plan's tick, at the far end of the same strip the quantity tag opens.
            **In the strip rather than absolutely positioned beside it**, which is what makes it
            free: this band is already a scrim over the card's printed title bar, already 27px tall
            at 100% zoom and already the full width of the face, so a mark pushed to its right end
            needs no offsets of its own and is legible over art of any brightness for the reason
            the tag beside it is.

            `ml-auto` and not `justify-between`, which is the plainer thing it always should have
            been. The argument for it used to be a third mark: the game changer's ribbon stood
            between these two as a variable-width optional sibling, and a `justify-between` strip
            holding three would have spaced them evenly rather than pushing this one to the end.
            The crown is on the tag now, so the strip is two marks and both rules would agree —
            and a margin is still the honest way to say it, because what is wanted is *this mark at
            the far end* rather than *the row's free space shared out*.

            Top-right is `FoilOverlay`'s chip on every other card face in this app, and this is the
            one surface where that is not a collision: it draws the overlay with `mark={false}` and
            says the finish in its foot instead. **That is also what retired the Grid tile's
            stacking offset**: the tile used to push this mark down by the chip's own measured box
            on the cards that drew one, and there is no chip here to clear. */}
        {theoryMark !== null && (
          <TheoryMatchMark tier={theoryMark.tier} delta={theoryMark.delta} className="ml-auto" />
        )}
      </span>

      {/* **Bottom-left**, which is where the Grid tile has always drawn it and where the stack's
          copy moved on 2026-08-20 to match. The move is the condition of {@link TheoryMatchMark}
          existing rather than a tidy-up: that mark is a *tick*, this one is the only mark on a card
          that says something is wrong, and `CardMarks.tsx`'s founding rule is that the two must
          never be confusable — four separations, of which **place** is the one a reader takes in
          before they have read either. Adjacent in one corner they would have been a tick and a box
          arguing; in opposite corners they are two unrelated facts about one card.

          The offset is **the only sum on this card with a scaled term and a fixed one**, and both
          are needed: `0.25rem × --mark-scale` is the inset the mark is drawn at, and `+ 4px` is
          `CHIN_RISE`, the distance the chin rides **up** over the face to hide its square corners.
          The rise does not scale — it is derived from a Tailwind corner radius that does not — so a
          wholly scaled offset would clear the bar at 1× and put the mark behind it at 0.5×, which
          is exactly the zoom a reader picks when they want to see more cards and fewer details.
          The Grid tile drew the mark 4px lower for as long as its chin was flush; it is the same
          card now, so it takes the same clearance. */}
      {ruleBreakText !== null && (
        <RuleBreakMark
          text={ruleBreakText}
          className={cn(
            "absolute",
            "bottom-[calc(0.25rem*var(--mark-scale,1)+4px)]",
            "left-[calc(5px*var(--mark-scale,1))]",
          )}
        />
      )}

      {/* **Inside the face, which is what makes it findable in a fanned pile.** The face is the one
          box here that a collapsed card still shows 34px of, so a mark laid over it is a lit band
          and a bright hairline exactly where the reader is scanning. Laid over the marks strip
          rather than under it — the strip's tag is 11px type on its own scrim, and a wash tints it
          without touching the contrast between the glyphs and the chip they are printed on, while a
          mark the tag could cover would be missing on precisely the cards that have one. That trade
          got louder on 2026-08-15, when the wash went gold at 40 % over this strip with a glow
          behind it, and it is the one place to look first if the quantity tag ever stops reading
          during an add. See {@link LandedMark}.

          {@link FACE_RADIUS} is the face's own corner, handed over rather than spelled again
          because the mark cannot inherit it — {@link LandedMark} has why, and the shared constant
          is what stops the mark's gold hairline drawing a tighter arc than the face it is inside
          the moment one of the two is corrected. */}
      {landedKey !== undefined && <LandedMark key={landedKey} className={FACE_RADIUS} />}
    </span>
  );
}
