import { CardImage } from "@/components/CardImage";
import { FinishMark } from "@/components/FinishMark";
import { GAME_CHANGER_LABEL, GameChangerMark } from "@/components/GameChangerMark";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl, type ImageVariant } from "@/lib/images";
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
  variant = "grid",
  selected = false,
  hoverZoom = false,
  finish = null,
  gameChanger = false,
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
  /** Which stored size. `grid` is a full card frame; `art` is the 626×457 crop. */
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
   * Whether this card is one the Commander bracket counts, drawn as a crown in the same corner
   * chip as {@link finish}.
   *
   * A card fact rather than a printing one — every printing of Rhystic Study is a game changer
   * — so unlike `finish` there is nothing to derive: the caller passes the row's own
   * `gameChanger` straight through. `false` by default, because the surfaces that have no such
   * column (a deck row is one, an orphan is another) must draw nothing rather than guess.
   */
  gameChanger?: boolean;
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
          // No `loading="lazy"`. It was on the wall's tiles against "117 k results is 117 k
          // requests if every mounted tile fetches eagerly", and that is not what happens:
          // the virtualizer bounds the mounted tiles to the rows on screen plus two, so
          // eager is already bounded at about two dozen images. What the browser's own
          // intersection gate added on top was a second wait — and a lazy image is fetched
          // at low priority, after layout, outside the preload scanner — on exactly the two
          // dozen pictures the reader is about to look at.
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
        <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center">
          <span className="line-clamp-3 text-xs">{name}</span>
          <span className="text-[0.7rem] text-dim">
            {image.retrying ? "Retrying…" : cardId === null ? "No card" : "No image"}
          </span>
        </span>
      )}

      <FoilOverlay finish={finish} gameChanger={gameChanger} />
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
 * The crown is the same fact the deck views draw as `GameChangerBadge`'s gold `GC`; see
 * `GameChangerMark` for why one fact is drawn twice.
 *
 * The enclosing element needs `relative` and `overflow-hidden`; `CardArt` has both.
 */
export function FoilOverlay({
  finish,
  gameChanger = false,
}: {
  finish: Finish | null;
  /**
   * Optional, and it has to stay optional: three callers outside `CardArt` draw this overlay
   * (the pane's main art, the deck stack's card, the deck grid's tile) and none of them says
   * anything about the bracket.
   */
  gameChanger?: boolean;
}) {
  if (!finish && !gameChanger) return null;
  // What the chip's own padding says on hover, since a `<title>` inside a glyph only covers
  // the 12px the glyph occupies. Joined with the separator the app uses between card facts
  // everywhere else, so "Game changer · Foil" reads as one line rather than a sentence.
  const chipTitle = [gameChanger ? GAME_CHANGER_LABEL : null, finish ? FINISH_LABEL[finish] : null]
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
    // of it. A `title` attribute is excluded on the same terms — name computation skips an
    // `aria-hidden` subtree entirely — while the browser still shows it on hover, which is the
    // whole reason the tooltips below can exist at all.
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
          the enclosing button on every surface that has one — `CardGrid` renders `<CardArt>` as
          that button's only child, `CardStack` and `GridView` put this overlay inside theirs —
          so a click on the chip bubbles and opens the card exactly as a click on the art does.
          `data-card-marks` is the handle a test finds it by; a hit target is otherwise
          invisible to the DOM. */}
      <span
        data-card-marks
        title={chipTitle}
        className="pointer-events-auto absolute top-1 right-1 flex items-center gap-0.5 rounded bg-bg/85 px-1 py-0.5"
      >
        {gameChanger && <GameChangerMark />}
        {finish && <FinishMark finish={finish} />}
      </span>
    </span>
  );
}
