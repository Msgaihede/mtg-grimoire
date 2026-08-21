import { CardImage } from "@/components/CardImage";
import { FinishMark } from "@/components/FinishMark";
import { GAME_CHANGER_LABEL, GameChangerMark } from "@/components/GameChangerMark";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl, WALL_CARD_VARIANT, type ImageVariant } from "@/lib/images";
import { type Treatment, treatmentTitle } from "@/lib/treatment";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";

/**
 * The holo sweep laid over a foil card's art.
 *
 * A real foil card is a diffraction grating: it throws a different hue at every angle, and
 * what the eye actually reads as "shiny" is the **specular streak** running across it rather
 * than the rainbow on its own. Scryfall's photography has neither — the art of a foil-only
 * printing is byte-identical to a nonfoil one — so without this the app has no way to show
 * that 12 366 of its printings are foil.
 *
 * So: a bright narrow band at 41 % of a 115° sweep, with low-alpha rainbow stops either side,
 * in **`screen`**. Every number here was chosen at the window rather than at the keyboard.
 *
 * **`overlay` at 12 % was the first attempt and it was invisible** — measured 2026-08-11 over
 * CDP by screenshotting one magnified foil tile with the sheen shown and hidden: the two
 * images were indistinguishable, and the corner chip was doing all the work. `overlay`
 * preserves the underlying luminance and only nudges hue, which on already-saturated card art
 * is no signal at all. Raising it to 30 % changed nothing worth seeing; `color-dodge` at 28 %
 * was visible but blew the light areas out.
 *
 * `screen` lightens by the overlay's own brightness, so the alphas *are* the strength: the
 * rainbow stops sit at 0.10–0.13 and only the band reaches 0.34. Verified on the live wall —
 * two printings of one card side by side, one foil and one not, told apart at a glance with
 * the rules text on both still readable.
 */
const FOIL_SHEEN =
  "linear-gradient(115deg, rgba(255,0,90,.10) 0%, rgba(255,200,0,.11) 14%, " +
  "rgba(0,255,180,.13) 28%, rgba(255,255,255,.34) 41%, rgba(0,160,255,.13) 56%, " +
  "rgba(180,0,255,.12) 74%, rgba(255,0,120,.10) 100%)";

/**
 * One card's art in its 5:7 frame — the picture, its retry, and what is drawn when there is
 * no picture.
 *
 * Extracted from `CardGrid`'s tile because five surfaces draw a card and each had rebuilt
 * part of this: the wall's tiles, the pane's main art, the pane's printings rows, the deck
 * editor's zone rows and `PrintingPreview`. They agreed on the aspect ratio and disagreed
 * about everything else, which is how a foil marking would otherwise have come to exist in
 * five slightly different versions.
 *
 * **The deck editor's Grid view is a caller since 2026-08-16**, and it is the case that shows
 * what "one definition" is worth: it had opted out and kept a copy of this file inline, which
 * had drifted to `rounded-md`, a second spelling of the aspect ratio (`488/680` against
 * {@link CARD_ASPECT}), a smaller no-picture fallback and no hover lift at all — so the deck a
 * reader was building and the wall docked beside it drew the same card two ways, on one screen.
 * The surfaces that still draw their own frame each say why at their own site
 * (`CardStack`, `CardDetailPane`, `PrintingPreview`, the two cover pickers); none of them is
 * 5:7 with an aspect-driven height, which is the whole of what this owns.
 *
 * `CardImage` stays underneath and does the one thing it has always done — key the `<img>`
 * on its URL, so a slot handed a new card paints nothing rather than the previous card's
 * art. This component is the frame around it and the state machine beside it.
 *
 * What it deliberately does **not** own: the button, the focus ring, the caption and the
 * corner marks. Those differ per surface, and a wall's tile is a button where a deck row's
 * thumbnail is `aria-hidden` decoration.
 */
export function CardArt({
  cardId,
  name,
  face = 0,
  variant = WALL_CARD_VARIANT,
  selected = false,
  hoverZoom = false,
  finish = null,
  treatments,
  gameChanger = false,
  loading,
  className,
}: {
  /**
   * The printing to draw, or `null` to draw the fallback and fetch nothing.
   *
   * `null` is for an orphan — a collection or deck row whose card has left `cards` — which
   * is a row the app still shows and still names. Fetching for it would be a request that
   * can only 404.
   */
  cardId: string | null;
  /**
   * The card's name. It is the `alt`, so it is what a screen reader announces *and* what
   * the fallback prints; "decorative" is the caller's decision to make by passing `""`.
   */
  name: string;
  /** Which physical side. `0` unless the caller is drawing a flipped card. */
  face?: number;
  /**
   * Which stored size. The default is {@link WALL_CARD_VARIANT} — a full card frame at
   * 672×936, big enough that the top of the zoom ladder does not upscale it; `art` is the
   * 626×457 crop, which a caller drawing a cover passes explicitly.
   */
  variant?: ImageVariant;
  /**
   * Ringed, because this is the card an open pane is about. Gold says "focus" as an outline
   * and "state" as a ring everywhere else in the app, and it hugs the art rather than
   * standing off it so a wall keeps its rhythm.
   */
  selected?: boolean;
  /**
   * Grow very slightly while the enclosing `group` is hovered. The wall's tiles want it;
   * a 40px deck-row thumbnail does not, and neither does a static pane.
   */
  hoverZoom?: boolean;
  /**
   * The finish this object *is*, drawn as a holo sheen and a corner chip. `null` — the
   * default — draws neither.
   *
   * "Is", not "could be": a printing sold in both finishes passes `null`, because the mark
   * describes the cardboard and not a choice at the checkout. `soleFinish` in `@/lib/finish`
   * is what a printing-shaped caller derives this with; a collection row passes its entry's
   * own stored finish, which is the one place the answer is known outright.
   */
  finish?: Finish | null;
  /**
   * What this copy is *called*, if anything — `finishTreatments(promoTypes, finish)` from
   * `@/lib/treatment`, passed straight to {@link FoilOverlay}.
   *
   * Empty (the default) is every card that has no name beyond its finish, which is 95 % of the
   * corpus. Non-empty renames the chip's glyph and its word: a Surge Foil says so instead of
   * saying "Foil". It changes the **chip only** — see {@link FoilOverlay.treatments} for why
   * the sheen is not its business.
   */
  treatments?: readonly Treatment[];
  /**
   * Whether this card is one the Commander bracket counts, drawn as a crown in the same corner
   * chip as {@link finish}.
   *
   * A card fact rather than a printing one — every printing of Rhystic Study is a game changer
   * — so unlike `finish` there is nothing to derive: the caller passes the row's own
   * `gameChanger` straight through. `false` by default, because the surfaces that have no such
   * column (a deck row is one, an orphan is another) must draw nothing rather than guess.
   */
  gameChanger?: boolean;
  /**
   * The browser's own intersection gate on this frame's `<img>`. **Absent by default, which
   * emits no attribute at all** — the argued position, not an omission; see where it is passed
   * below, and `CardGrid.test.tsx`, which asserts the attribute's absence rather than its value.
   *
   * `"lazy"` is for a wall that is **not** virtualised, which is the app's standing rule (see
   * `src/CLAUDE.md`): the deck editor's Grid view mounts every card in the deck at once, so the
   * browser's gate is the only thing bounding what a hundred tiles ask for. A virtualised wall
   * has already made that count small and pays only the gate's extra wait, which is why the
   * search wall passes nothing.
   */
  loading?: "eager" | "lazy";
  className?: string;
}) {
  // The self-healing half of the rate limit, and the reset that goes with it: this component
  // belongs to a *slot* rather than to a card, so a new search hands it a different card
  // without remounting it, and the last card's failure must not be the new card's. Both live
  // in the hook — see it for why a failed image comes back twice.
  const image = useImageRetry(cardId === null ? null : cardImageUrl(cardId, face, variant));

  return (
    <span
      className={cn(
        "relative block w-full overflow-hidden rounded-lg bg-surface",
        selected && "ring-2 ring-accent",
        className,
      )}
      style={{ aspectRatio: CARD_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // The name, not "card image": this string is what a screen reader announces and
          // what shows when a fetch fails, and both readers want the card.
          alt={name}
          src={image.src}
          // **Nothing unless the caller says otherwise**, and that default is the argument the
          // wall's tiles settled: "117 k results is 117 k requests if every mounted tile
          // fetches eagerly" is not what happens, because the virtualizer bounds the mounted
          // tiles to the rows on screen plus two — so eager is already bounded at about two
          // dozen images. What the browser's own intersection gate added on top was a second
          // wait — and a lazy image is fetched at low priority, after layout, outside the
          // preload scanner — on exactly the two dozen pictures the reader is about to look
          // at. A wall with **no** virtualiser has no such bound and passes `"lazy"`.
          loading={loading}
          decoding="async"
          // An `<img>` is draggable by default, and the browser picks the *nearest*
          // draggable ancestor as a drag's source — so the art would start a drag of itself
          // and the tile's own drag would never begin. Off here rather than at the caller,
          // because the caller is handed the frame and cannot reach this. Nothing is lost:
          // an `mtgimg:` URL means nothing outside this window.
          draggable={false}
          onError={image.onError}
          className={cn(
            "size-full object-cover",
            hoverZoom &&
              "transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          )}
        />
      ) : (
        // A frame with no art is still a card. The name is what the reader came for and it
        // is known without the image, so a rate-limited screen reads as a list of cards
        // rather than a wall of broken-image icons.
        //
        // It is the one thing in this frame that is *content* rather than a mark, and it scales
        // for that reason rather than in spite of it: this text stands in for the printed name on
        // a card the reader has zoomed, so 12px inside a 340px frame reads as a caption that
        // failed to load rather than as the card. `--mark-scale` is the tile's own factor — see
        // `lib/cardZoom.ts` — and the `, 1` fallback covers the frames drawn at a fixed size.
        <span
          className={cn(
            "flex size-full flex-col items-center justify-center text-center",
            "gap-[calc(0.25rem*var(--mark-scale,1))] px-[calc(0.5rem*var(--mark-scale,1))]",
          )}
        >
          <span className="line-clamp-3 text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]">
            {name}
          </span>
          <span className="text-[calc(0.7rem*var(--mark-scale,1))] text-dim">
            {image.retrying ? "Retrying…" : cardId === null ? "No card" : "No image"}
          </span>
        </span>
      )}

      <FoilOverlay finish={finish} treatments={treatments} gameChanger={gameChanger} />
    </span>
  );
}

/**
 * The marks laid over a card's art — the sheen and the chip that say what this cardboard *is*.
 *
 * Its own component because the card detail pane's main art is **not** a `CardArt`: it keeps
 * a flip fade, a bespoke "no image yet" panel and no retry hook, and routing it through the
 * shared frame would trade three deliberate behaviours for one shared one. What the two must
 * agree on is the marking, so that is what is shared.
 *
 * Two facts share one chip, and the crown is drawn first because it is the broader one.
 * **A game changer is a fact about the card; a finish is a fact about the printing** — every
 * printing of Rhystic Study is a game changer, while a card's printings are foil-only one at a
 * time — so a card can carry either, both or neither. Both means one chip with two glyphs
 * rather than two chips, because a tile's fourth corner is the only one left and a second box
 * beside it would start a row of stickers.
 *
 * The crown is the same glyph the deck stack's `GameChangerBanner` stamps on its ribbon, and the
 * same fact the deck's table and text views abbreviate as `GameChangerBadge`'s gold `GC`; see
 * `GameChangerMark` for why one fact is drawn three ways.
 *
 * The enclosing element needs `relative` and `overflow-hidden`; `CardArt` has both.
 */
export function FoilOverlay({
  finish,
  treatments,
  gameChanger = false,
  mark = true,
}: {
  finish: Finish | null;
  /**
   * What this copy is *called* — `finishTreatments` from `@/lib/treatment`, `[]` for the 95 %
   * of printings with no name beyond their finish.
   *
   * **The chip's business and never the sheen's.** The sheen is a photograph of what the
   * cardboard does to light and this app draws one gradient; a Halo Foil and a Surge Foil do
   * different things to light and neither is that gradient, so a second sheen would be a
   * claim the art cannot support. The chip is where a name belongs — it is the half that
   * *says* foil, as the comment on the sheen below puts it.
   *
   * It is also what lets a **plain** copy carry a mark: `Serialized` and `Poster` are true of
   * the cardboard in any finish, so `finish === null` with a non-empty list draws the chip and
   * no sheen, which is exactly the right picture of a serialized nonfoil card.
   */
  treatments?: readonly Treatment[];
  /**
   * Optional, and it has to stay optional: two callers outside `CardArt` draw this overlay
   * (the card detail pane's main art and the deck stack's card) and neither says anything about
   * the bracket. Those surfaces have their own drawings of it — `GameChangerBanner` on the
   * stack, `GameChangerBadge` on the deck's table and text views. The deck's **Grid** view was
   * a third such caller until 2026-08-16 and is now a `CardArt` like the search wall, so it gets
   * the crown through this prop rather than a `GC` of its own.
   */
  gameChanger?: boolean;
  /**
   * Draw the chip as well as the sheen. `false` for a frame that says the finish **in words
   * somewhere else** — the deck stack's card, whose data line under the art carries a
   * {@link FinishMark} beside the price.
   *
   * That is not a weaker version of this frame, it is the rule below applied: the chip and the
   * sheen do different jobs, and the chip's job is done better by a mark on a line the reader
   * is already reading than by a second badge in a corner two other marks are competing for.
   * What must not happen is *neither* — a sheen with nothing naming it is decoration.
   *
   * **It governs the crown too, and has to.** The chip is the only thing a crown can be drawn
   * as here, so a frame that has moved the finish into words has moved the whole corner: the
   * one caller that passes `false` is the deck stack, which draws `GameChangerBanner` across
   * the card instead. A crown surviving that switch would be the second badge this prop exists
   * to remove.
   */
  mark?: boolean;
}) {
  const tip = useTooltip();
  // Two marks, one chip, and either of them is reason enough to draw it — but only if the
  // caller wanted a chip at all.
  const named = treatments !== undefined && treatments.length > 0;
  const chip = mark && (finish !== null || gameChanger || named);
  if (!finish && !chip) return null;
  // What the chip's own padding says on hover, covering the gap between the two glyphs as
  // well as each glyph's own tooltip (bound separately, in `FinishMark`/`GameChangerMark`
  // themselves, since those components are also drawn standalone — a data line, a table row —
  // with no chip around them). The innermost binding wins on a hover that lands exactly on a
  // glyph, so this is only ever seen over the padding between or around them; it still needs
  // the words, because "Game changer · Foil" is a fact this chip alone states. Joined with the
  // separator the app uses between card facts everywhere else.
  // The finish's own word only where nothing has renamed it: `FinishMark` says
  // "Surge Foil · Serialized" for a named copy, and this padding tooltip must not answer
  // "Foil" over the same chip.
  const chipTitle = [
    gameChanger ? GAME_CHANGER_LABEL : null,
    named ? treatmentTitle(treatments) : finish ? FINISH_LABEL[finish] : null,
  ]
    .filter((word) => word !== null)
    .join(" · ");
  return (
    // **`aria-hidden` over the whole overlay, chip included, and that is load-bearing.** This
    // frame usually sits *inside* a button, and a button's accessible name is computed from
    // its contents — so the chip's "Foil" joined it and a wall of foil tiles became buttons
    // called "Consecrated Sphinx Foil". Measured over CDP 2026-08-11, where a tile button's
    // name came back as bare "Foil". The crown would have made that worse rather than
    // different: "Rhystic Study Game changer", on every game changer in the wall. It is the
    // same trap the owned badge avoids by being a *sibling* of the button rather than a child
    // of it. A tooltip is excluded on the same terms — name computation skips an `aria-hidden`
    // subtree entirely — while `aria-hidden` says nothing about pointer events, so `useTooltip()`
    // still opens on hover, which is the whole reason the tooltips below can exist at all.
    //
    // Nothing is lost: both facts are stated in text on every surface that has room for them —
    // the search table's Name cell, the deck row beside the card's name, the pane's per-finish
    // prices — and the wall's tile adds an `sr-only` word to its caption. This is the
    // decoration; those are the statement.
    //
    // `pointer-events-none` for the second half of the same idea: a full-bleed overlay inside
    // a button would swallow every click on it.
    <span aria-hidden="true" className="pointer-events-none">
      {finish && (
        <span
          data-foil-sheen
          // No opacity class: in `screen` the gradient's own alphas are the strength, and a
          // second multiplier would be one more number to keep in step with them.
          //
          // Only for a finish, never for a crown: the sheen is a *photograph* of what the
          // cardboard does to light, and a game changer's cardboard does nothing special.
          className="absolute inset-0 mix-blend-screen"
          style={{ backgroundImage: FOIL_SHEEN }}
        />
      )}
      {/* The chip is what *says* foil at a glance; the sheen is what *looks* foil. Neither is
          asked to do the other's job — a sheen alone is ambiguous on busy art, and a chip
          alone says nothing about the object being a different physical thing. A game changer
          has only the chip half, because there is nothing about it to photograph.

          Top-right, because a tile's other two corners are spoken for: bottom-left the owned
          badge, top-left the printing count. The backing is the app's own table felt at 85 %,
          matching those two exactly.

          **`pointer-events-auto`, against the wrapper's `none`, and that is a fix rather than
          a decoration.** `pointer-events` inherits, so the chip inherited the wrapper's `none`
          and was not a hit target — which meant the `<title>` on every glyph in it had been
          unreachable since the day it was written: a tooltip is shown by the element the
          pointer *hits*, and nothing here was ever hit. Re-enabling it on the chip alone
          leaves the full-bleed sheen untouchable, which is what the wrapper's `none` was for.
          Nothing is swallowed by giving one chip's worth of hit target back: it sits **inside**
          the enclosing button on every surface that has one — `CardGrid` and the deck's
          `GridView` both render `<CardArt>` inside theirs, and `CardStack` puts this overlay
          inside its own — so a click on the chip bubbles and opens the card exactly as a click
          on the art does.
          `data-card-marks` is the handle a test finds it by; a hit target is otherwise
          invisible to the DOM.

          **The inset, the padding, the gap and the corner are all sizes at 100% zoom**, and every
          one of them is multiplied by the card's own `--mark-scale` (`lib/cardZoom.ts`). The chip
          is the mark this scaling was reported about: held still, it was a 20px sticker on an 85px
          card at 0.5× and a speck in the corner of a 340px one at 2×. The inset scales with the
          rest because 4px is the distance that keeps the chip off the art's rounded corner *at
          this size* — the corner is `CardArt`'s own `rounded-lg`, which does not scale, so the
          inset only has to stay proportionate to the chip it is holding in. */}
      {chip && (
        <span
          data-card-marks
          {...tip(chipTitle, { describes: false })}
          className={cn(
            "pointer-events-auto absolute flex items-center bg-bg/85",
            "top-[calc(0.25rem*var(--mark-scale,1))] right-[calc(0.25rem*var(--mark-scale,1))]",
            "gap-[calc(0.125rem*var(--mark-scale,1))] rounded-[calc(0.25rem*var(--mark-scale,1))]",
            "px-[calc(0.25rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
          )}
        >
          {gameChanger && <GameChangerMark />}
          {(finish || named) && <FinishMark finish={finish ?? "nonfoil"} treatments={treatments} />}
        </span>
      )}
    </span>
  );
}
