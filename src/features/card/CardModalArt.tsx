import { useState, type JSX } from "react";
import {
  ArrowRight,
  Combine,
  FlipHorizontal2,
  Gem,
  RotateCcw,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { FoilOverlay } from "@/components/CardArt";
import { CardImage } from "@/components/CardImage";
import { RarityGem } from "@/components/RarityGem";
import { FINISH_LABEL, parseFinishes, soleFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
import type { CardDetail, DeckFinish, MeldRelation } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { finishTreatments, treatmentName } from "@/lib/treatment";
import { cn } from "@/lib/utils";
import { cardTurn, meldPartsOf, meldResultOf, type CardTurn } from "./orientation";
import { faceCount } from "./printings";

/**
 * One control in the row under the art — the row that changes **what the picture shows** and
 * never what the card is.
 *
 * A local copy of `CardDetailPane`'s `ART_CONTROL` rather than an import, because that file was
 * deleted with the dock on 2026-09-03; the two lived side by side for one wave, and this is the
 * one that survived. `grow basis-[calc(50%-0.5rem)]`
 * and not `flex-1` for the reason that constant already gives — a zero basis makes a lone button
 * a third of a line instead of the full-width bar it has always been, and the explicit half
 * basis is what lets the pair wrap instead of shrinking. The slack is deliberate: a basis of
 * exactly `50% - gap/2` sums to 100% and sub-pixel rounding then wraps a pair that was meant to
 * fit.
 *
 * **44px below the fold and 36px above it**, which is spec §2.1's one instruction about this
 * column's controls: at `< 640px` the panel is full-bleed on a phone and every target in it is a
 * thumb's. Above that the app's own 36px control height applies, so the row matches the
 * dropdowns in the column beside it. The two heights are at different variants, so `cn`'s
 * `twMerge` keeps both — a second class at the *same* variant would silently leave only the
 * last, which is this plan's own warning about multi-rung strings.
 */
const ART_CONTROL =
  "flex h-11 min-w-0 grow basis-[calc(50%-0.5rem)] items-center justify-center gap-1.5 " +
  "rounded-md border border-border text-xs text-dim transition-colors duration-150 " +
  "hover:text-text motion-reduce:transition-none " +
  "aria-pressed:border-accent/40 aria-pressed:text-text " +
  "@min-[640px]/card:h-9";

/**
 * {@link CARD_ASPECT} on its side — the box a quarter-turned card fills.
 *
 * **Derived rather than written out**, and that is a rule this repo has already paid for: the
 * deck editor's Grid view kept `aspect-[488/680]` beside `CARD_ASPECT` for weeks and drew the
 * same card two ways on one screen (`src/CLAUDE.md`). A reciprocal spelled `"7 / 5"` is a second
 * place the proportions of a Magic card are stated, and the one that would be missed if they
 * ever changed.
 */
const TURNED_CARD_ASPECT = CARD_ASPECT.split("/")
  .map((side) => side.trim())
  .reverse()
  .join(" / ");

/**
 * The finish this printing's foil toggle is *about*, or `null` where there is nothing to toggle.
 *
 * Copied from `CardDetailPane`'s `foilViewFinish` before that file was deleted, and it answers only
 * where a printing is sold **both** ways: a foil-only printing has nothing to switch to, and
 * `soleFinish` — which states what the cardboard simply *is* — already speaks for it. The return
 * is `DeckFinish` rather than `Finish | null` because the two arms answer `foil` and `etched` and
 * nothing else, which is exactly `deck_cards.finish`'s vocabulary, so the toggle can ask for what
 * it shows without a cast.
 */
function foilViewFinish(finishesJson: string | null): DeckFinish {
  const finishes = parseFinishes(finishesJson);
  if (!finishes.includes("nonfoil")) return null;
  if (finishes.includes("foil")) return "foil";
  if (finishes.includes("etched")) return "etched";
  return null;
}

/**
 * The meld half of the row under the art — what the counterparts are, which one is being looked
 * at, and the two things a press can do about it.
 *
 * **The host supplies a fact and never a decision**, which is the same division `deckRow` is
 * passed under: `relations` is `ipc.cardMeldParts`' answer verbatim, and which of them is a
 * result and which are halves is `orientation.ts`'s conclusion, drawn here. That is what keeps
 * this file presentational with a meld control in it — the query, the `melded` state and the
 * store write all belong to `CardDetailModal`, because the **artist credit** it draws has to
 * move with the picture and only the host draws that credit.
 */
export interface MeldTarget {
  /** `ipc.cardMeldParts`' answer, or `[]` for every card that is not a meld. */
  relations: readonly MeldRelation[];
  /** The counterpart whose picture is standing in for the card's own, or `null`. */
  melded: MeldRelation | null;
  /** Show a counterpart's picture here, or `null` to go back to the card's own. */
  onMeld: (to: MeldRelation | null) => void;
  /** Make a counterpart the open card. */
  onOpen: (cardId: string) => void;
}

/**
 * The card modal's left column: the picture, what printing it is, what it costs.
 *
 * ## What is here and what is deliberately not
 *
 * Top to bottom: the art in a bordered box with a **chin** under it (rarity, set code, collector
 * number, and the set's name pushed right), the row that changes what the picture shows, and one
 * price cell per finish.
 *
 * **Three sentences are not here, and all three are the panel's footnotes** — the artist credit,
 * the Scryfall source line and, since 2026-09-03, spec §5's *how old these prices are*. The first
 * two were never here: the image policy requires both wherever art is shown, and the artist that
 * has to be credited is the one whose art is *on screen*, which with a meld view up is not this
 * card's illustrator at all. The third **was** here, under the cells it dates, and moved for this
 * file's own argument rather than against it — two copies of one sentence in one panel is worse
 * than one, and the footer is where the panel's footnotes live. `CardDetailModal` draws all
 * three, stacked in the action row's left corner, and it withholds the price line on exactly the
 * `finishes.length > 0` this column withholds the cells on.
 *
 * ## The price block is the reason this file has a test
 *
 * The mockup hardcodes a `Nonfoil` / `Foil` pair and spec §4 refuses it. `finishes` says how
 * shiny a copy is; `promoTypes` says *which* shiny (issue #160). A printing sold only as etched,
 * or only as a Surge Foil, would price as an em dash under a literal reading of the mockup while
 * the app is holding a real number for it — so this draws **one cell per finish the printing
 * actually has**, named through `finishTreatments`/`treatmentName`, in the mockup's bordered
 * two-up grid, wrapping to a third row where a printing has three finishes.
 *
 * ## Presentational, on purpose — and still presentational with the meld control back
 *
 * It owns exactly two pieces of state, and both are about *what the picture shows*: whether the
 * reader has asked to see the shiny copy, and whether they have asked for the card to be turned.
 * It reads no store and no query. Every fact is a prop and every write is a callback, so the host
 * can mount it over a deck row, over a collection tile or over nothing at all, and so this file's
 * test can exist without a deck, a query client or a store in the tree.
 *
 * **The meld view is the host's state rather than this component's**, which is the one place that
 * division was not obvious: the picture is drawn here, but the credit under the whole panel names
 * the illustrator of the face on screen, and that is `CardDetailModal`'s line to draw. A `melded`
 * held here would be a fact the credit could not see.
 */
export function CardModalArt({
  card,
  face,
  onFlip,
  marketplace,
  deckRow,
  openedAs,
  onToggleFoil,
  meld,
}: {
  card: CardDetail;
  /** Which face the picture is of — 0 is the front. */
  face: number;
  onFlip: () => void;
  /** Which marketplace every cell below is quoted from. */
  marketplace: Marketplace;
  /**
   * The deck row this card was opened out of, or `null` outside a deck.
   *
   * **A row and not a bare finish**, which is a correction to this task's brief rather than a
   * preference: `DeckFinish` is already `"foil" | "etched" | null`, so `DeckFinish | null`
   * collapses to itself and cannot tell "no deck behind the modal" from "a deck row playing a
   * regular copy" — and that is precisely the distinction the button's label turns on. A
   * `PaneDeckContext` satisfies this structurally, so the host passes `scope.deck` unchanged.
   */
  deckRow: { finish: DeckFinish } | null;
  /**
   * The finish the surface that opened this card named, or `null` where nothing knew one.
   *
   * **The store read that used to live inside this component, turned into a prop.**
   * `CardDetailPane` seeded its foil view from `useAppStore(s => s.paneFinish)` as well as from
   * the deck row; this file is presentational, so `CardDetailModal` — the one component here
   * allowed to read the store — reads it and hands it over. A collection tile that *is* a foil
   * and the deck editor's search panel both write that field, which is why a foil tile opened
   * plain for as long as the prop was missing.
   *
   * `Finish` and not `DeckFinish`, because `nonfoil` is a real answer here and a meaningful one:
   * it is a surface saying "the copy they pressed is the plain one", which seeds nothing, and it
   * is a different statement from "nobody knew".
   */
  openedAs: Finish | null;
  /**
   * The reader pressed the foil toggle, and this is the finish they are asking the deck row to
   * play — `null` for the regular copy.
   *
   * The argument is what the brief's bare `() => void` could not carry: the press is a *view*
   * change everywhere and a **write** where there is a row, and the host cannot tell which way
   * the toggle went without being told. A handler that ignores it still typechecks.
   */
  onToggleFoil: (next: DeckFinish) => void;
  /** The meld counterparts and what a press does about them — see {@link MeldTarget}. */
  meld: MeldTarget;
}): JSX.Element {
  const sides = faceCount(card.layout, card.faces.length);
  const finishes = parseFinishes(card.finishes);
  const foilable = foilViewFinish(card.finishes);

  /**
   * This printing is sold **only** as a regular card — what the greyed control states, and
   * deliberately narrower than `foilable === null`.
   *
   * `foilViewFinish` answers `null` for four different printings and only one of them has no
   * foil, which is why this is its own question rather than the toggle's gate read backwards:
   *
   * - `["nonfoil"]` — no shiny copy exists. This one, and the whole of issue #167.
   * - `["foil"]` / `["etched"]` — 12 366 and 892 printings, which answer `null` because there is
   *   nothing to switch *to*. `soleFinish` is already drawing "this cardboard is foil" over the
   *   art for them, so a `No foil` control under that sheen would be the two halves of this file
   *   contradicting each other about one piece of cardboard.
   * - `["foil","etched"]` — no plain copy to return to, and two foils.
   * - `[]` — nothing is known about this printing's finishes, which is not the same claim as
   *   knowing there is no foil. The price grid below draws no cells for it either.
   */
  const noFoil = finishes.length > 0 && finishes.every((f) => f === "nonfoil");

  // The src that failed, so a flip or a new card clears it without an effect. The host keys this
  // column on the card, so browsing away throws the whole subtree out.
  const [broken, setBroken] = useState<string | null>(null);
  // Opened showing the copy the reader actually has, where the surface knew of one — a deck row
  // that plays a foil, or a collection tile that *is* one. `nonfoil` and `null` both seed
  // nothing, which is right: regular is the finish a card is assumed to be.
  const [foilView, setFoilView] = useState(
    deckRow?.finish != null || openedAs === "foil" || openedAs === "etched",
  );

  /**
   * How far this card has to be turned to be read, and whether the reader has asked for it.
   *
   * `null` for the overwhelming majority of cards, which is what keeps the row unchanged for
   * them: a `transform` still gets its flip and nothing else, because a second *side* and a
   * sideways *printing* are different problems and the flip control already solved the first.
   *
   * The state needs no reset for `foilView`'s reason — the host keys this column on the card.
   */
  const turn = cardTurn(card.layout, card.faces);
  const [turned, setTurned] = useState(false);
  const angle: CardTurn | 0 = turned && turn !== null ? turn : 0;
  const quarter = angle === 90 || angle === -90;

  /**
   * The two meld controls' subjects: the melded card a half offers, and the halves a melded card
   * offers. Exactly one of them is ever non-empty — see `orientation.ts`, where that asymmetry is
   * the reason they are two functions rather than one.
   */
  const meldResult = meldResultOf(meld.relations);
  const meldParts = meldPartsOf(meld.relations);

  // **Through `cardArtSrc`, which is the whole of what makes this frame draw in a browser.** An
  // `mtgimg://` URL is registered natively with the webview and wasm cannot register a scheme, so
  // handing one to a browser `<img>` paints a *broken* image where a card belongs — worse than
  // the named empty frame a `null` gives.
  //
  // **A meld view replaces the card's own art with a counterpart's** — a different printing, so a
  // different id, and always its only side. That counterpart has no supplied URL and therefore
  // answers `null` on the web target: `card_meld_parts` carries no image columns, which is a
  // known gap rather than an oversight, and it costs the meld view its picture in a browser while
  // every other card in the panel still draws.
  const src = meld.melded
    ? cardArtSrc(cardImageUrl(meld.melded.id, 0, "display"), null)
    : cardArtSrc(cardImageUrl(card.id, face, "display"), card.imageUris?.display);
  const pictured = meld.melded?.name || card.faces[face]?.name || card.name;

  // What the sheen is asked for. `soleFinish` is the *statement* — this printing is foil — and
  // the toggle is the only thing that ever adds to it; the two cannot both answer, because
  // `soleFinish` speaks only for a printing with one finish and `foilable` only for one with at
  // least two.
  //
  // **Nothing at all while a meld view is up**, and that is not the same rule as hiding the
  // button below: the statement arm survives a hidden toggle, so a foil-only printing would
  // otherwise go on drawing "this cardboard is foil" over a photograph of the *other* card. Both
  // halves are needed or the mark outlives the control that explains it.
  const marked = meld.melded ? null : foilView && foilable ? foilable : soleFinish(card.finishes);
  const FoilGlyph = foilable === "etched" ? Gem : Sparkles;

  /**
   * What the foil button says, and it says what the press **does** rather than what it shows.
   *
   * `Set as …` behind a deck row and `View as …` without one, because those are two different
   * acts and a label naming only the visible half would be a control that quietly edits a deck.
   * **`regular` rather than `FINISH_LABEL.nonfoil`** on the write arm: "set as nonfoil" is not a
   * thing anybody says, and `Regular` is the word the deck card's own menu uses for the same
   * choice. The view arm keeps the wording the pane shipped with.
   */
  const foilLabel = (() => {
    if (foilable === null) return "";
    const shiny = FINISH_LABEL[foilable].toLowerCase();
    if (deckRow !== null) return foilView ? "Set as regular" : `Set as ${shiny}`;
    return foilView ? `View as ${FINISH_LABEL.nonfoil.toLowerCase()}` : `View as ${shiny}`;
  })();

  /**
   * What the turn button says, and — like the foil button above — it says what the press
   * **does**.
   *
   * A half turn names the half it brings up, because a `flip` card's two halves have two
   * different names and "turn it over" is not what a reader is after: they want Tok-Tok. A
   * quarter turn names nothing, because both halves of a split and every word of a plane are
   * already on screen and the only thing the press changes is whether they can be read.
   */
  const turnLabel = (() => {
    if (turn === 180) {
      const half = card.faces[turned ? 0 : 1];
      return `Turn to ${half?.name || "the other half"}`;
    }
    return turned ? "Turn back" : "Turn to read";
  })();

  /**
   * The glyph on that button, which names the **direction the press turns the card** — so it
   * reverses once the card is turned, and a reader who has turned a plane clockwise is shown the
   * counter-clockwise arrow that puts it back.
   *
   * A half turn has no direction to name and takes the clockwise glyph either way.
   */
  const TurnGlyph = (() => {
    if (turn === 180) return RotateCw;
    return (turned ? turn === -90 : turn === 90) ? RotateCw : RotateCcw;
  })();

  /**
   * The press: a view toggle always, **and a write where there is a row behind the modal**.
   *
   * Both halves, not one or the other. The sheen turns on at the press — the reader asked to see
   * it, and a control that waited on a round trip to change anything would read as broken — and
   * the host's write goes out beside it. A refused write is the host's banner to draw; there is
   * nothing here to roll back, because the *view* really did change.
   */
  const pressFoil = () => {
    const next = !foilView;
    setFoilView(next);
    onToggleFoil(next ? foilable : null);
  };

  return (
    <div className="space-y-3">
      {/* The picture and the line naming the printing, in **one** bordered box — they are the
          same statement, and a chin floating under a separate frame reads as a caption about
          something else.

          **No `overflow-hidden` here, which is the turn's doing.** A card mid-quarter-turn is a
          rectangle wider than the box that holds it, so a clip at this edge chops the corners off
          a card while it is turning — visibly, for the length of the transition, and only on the
          three layouts the turn exists for. The rounding it used to carry belongs to the card
          instead, which is where the rounded corners actually are; at rest the card fills the
          frame exactly, so the only thing the missing clip changes is that the turn is drawn
          whole. */}
      <div className="rounded-xl border border-border bg-bg">
        {/* **The frame is what the column sees, and the card inside it is what turns.**

            Two elements rather than one, because a quarter-turned card is a *landscape* rectangle
            and the panel's own layout has to know that: the frame carries the proportions, so
            everything under the art — the price cells, and the controls column beside it — moves
            up to meet a turned card instead of leaving a hand's width of nothing under it.

            `aspect-ratio` is transitioned rather than snapped, which is worth stating because it
            is not obvious that it can be: Chromium interpolates a `<ratio>`, sampled over a 600ms
            transition on a standalone page in Chromium 151 — 280.0px → 208.3px → 142.8px across
            79 frames, 2026-08-22 — and the shipped window (WebView2, `Edg/151`) was then driven
            through the turn and measured at rest in both states.

            Positioned, so the card and the foil sheen have something to hang from, and full width
            at every rung — below `@min-[640px]/card` the panel is one full-bleed column, and at
            and above it the column's width is the parent grid's business rather than this box's.
            The proportions are `CARD_ASPECT` and never a hand-written ratio: the deck editor's
            Grid view kept `aspect-[488/680]` beside it for weeks and drew one card two ways on
            one screen. */}
        <div
          className={cn(
            "relative w-full transition-[aspect-ratio] duration-[var(--duration-slow)]",
            "ease-standard motion-reduce:transition-none",
          )}
          style={{ aspectRatio: quarter ? TURNED_CARD_ASPECT : CARD_ASPECT }}
        >
          {/* Centred on the frame and turned about its own middle.

              **The size is the whole trick.** A card that has been quarter-turned has to be as
              wide as the frame is *tall*, and as tall as the frame is *wide*, for its rotated
              self to fill the frame exactly — which is `CARD_ASPECT` of the frame's width and its
              reciprocal of the frame's height, the same ratio read both ways round. At rest in
              either state the card and the frame are the same rectangle, so the foil sheen laid
              over it needs no arithmetic of its own; only the 260ms between them is a card
              slightly larger than its box, which is why nothing clips it.

              **Centred by `inset-0 m-auto` rather than by `translate(-50%, -50%)`, and that is a
              sharpness fix rather than a preference.** A translate-centred card resolved to a
              half-pixel composited offset on every card the app drew in the pane's 335px column,
              turnable or not. Auto margins are a *layout* operation and land on the pixel grid,
              so the resting transform is the identity and nothing is resampled. */}
          <span
            // How far the card is turned, in degrees, as a handle a test can find it by —
            // `data-foil-sheen`'s idiom one component over. It is not decoration: jsdom has no
            // layout engine and no opinion about a `transform`, so the *only* thing a suite can
            // assert about a turn is that the component decided on one. The pixels are checked in
            // the running window, which is where a rotation can be seen at all.
            data-card-turn={angle}
            className={cn(
              "absolute inset-0 m-auto block overflow-hidden rounded-xl",
              "transition-[width,height,transform] duration-[var(--duration-slow)]",
              "ease-standard motion-reduce:transition-none",
            )}
            style={{
              width: quarter ? `calc(100% * ${CARD_ASPECT})` : "100%",
              height: quarter ? `calc(100% * ${TURNED_CARD_ASPECT})` : "100%",
              // Omitted rather than written as `rotate(0deg)` for the resting card: an identity
              // transform is still a compositing layer, and this frame is drawn for every card
              // the reader opens. A transition *from* `none` interpolates from the identity, so
              // the turn animates either way.
              transform: angle === 0 ? undefined : `rotate(${angle}deg)`,
            }}
          >
            {src === null || broken === src ? (
              // A rate-limited image is a 503 the `<img>` cannot read, so this says what is known
              // rather than guessing: the card is still identified, and the way back is stated.
              <div
                // `size-full` rather than an aspect ratio, because the box around it already has
                // one and it is not always the card's: a turned frame is landscape, and a panel
                // that insisted on 5:7 inside it would stand proud of its own frame.
                className="flex size-full flex-col items-center justify-center gap-1 px-6 text-center"
              >
                <span className="text-sm">{pictured}</span>
                <span className="text-xs text-dim">
                  {src === null
                    ? // The row carried no picture at all, which on the web target is the honest
                      // end of the road rather than a delay — there is no local cache to fill and
                      // no second place to look.
                      "No image for this printing."
                    : "No image yet — it may still be downloading. Reopen the card to try again."}
                </span>
              </div>
            ) : (
              <CardImage
                // The name, not "card image": this is what a screen reader announces *and* what
                // shows if the fetch fails, and both readers want the card. It follows a meld
                // view onto the melded card, because that is the card in the picture.
                alt={pictured}
                src={src}
                onError={() => setBroken(src)}
                decoding="async"
                // No filters and no crop: distorting, recolouring or cropping a card image is
                // forbidden by Scryfall's usage rules. **A turn is none of those three** — it is
                // the card at its own proportions, the way a reader would hold a plane or a split
                // card at the table, and it is what Scryfall's own card pages offer.
                //
                // `size-full` rather than a width and an aspect ratio, because the box it fills is
                // sized by the turn now and the two would fight. `object-cover` is a no-op at rest
                // in both states — the box is the card's own rectangle either way up — and never
                // stretches, which is the part the rules are about.
                className="size-full animate-in bg-bg object-cover fade-in duration-150 motion-reduce:animate-none"
              />
            )}
            <FoilOverlay finish={marked} treatments={finishTreatments(card.promoTypes, marked)} />
          </span>
        </div>
        {/* Which piece of cardboard this is, in the data face. The set's **name** is pushed right
            and is the elastic half — at the narrowest rung there is no width to give back, so the
            fixed things are the code and the number a reader is matching against a card in hand,
            and the name is what truncates.

            **It stays the open card's while a meld view is up**, which is deliberate and is the
            same rule the price cells below follow: the picture is a counterpart's, and everything
            else in this panel is still about the card the reader opened. The one fact that has to
            move with the picture is the illustrator, and that is drawn by the host. */}
        <p className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 text-xs text-dim">
          {card.rarity && <RarityGem rarity={card.rarity} className="shrink-0" />}
          {/* One text node rather than three spans in a `gap`: the separator has to survive into
              the text a screen reader reads, and `LEA` `·` `161` in three boxes reads as
              "LEA161" wherever the accessible name is computed from contents. */}
          <span className="shrink-0 font-mono">
            {card.setCode.toUpperCase()} · {card.collectorNumber}
          </span>
          {card.setName && <span className="ml-auto min-w-0 truncate">{card.setName}</span>}
        </p>
      </div>

      {/* Every way of looking at the card, under it — **one wrapping row rather than stacked
          bars**, so a double-faced card that also has a foil printing does not put two full-width
          buttons under the picture the direction doc calls the loudest thing on the screen. A
          card with none of these draws no row at all.

          **It wraps because a meld card asks for three.** A half offers *Meld* and *Open*, and a
          printing with a foil offers that too; a third button on one line would leave each of
          them a third of a column, so the row breaks and the odd one out takes a line of its own.
          `min-w-0` and a truncating label throughout, because these name *cards* and half a
          column is not enough for "Hanweir, the Writhing Township". */}
      {(foilable !== null ||
        noFoil ||
        sides === 2 ||
        turn !== null ||
        meldResult !== null ||
        meldParts.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {/* `faceCount` and never `faces.length`: `split`, `adventure` and `flip` all print two
              faces on one side of one piece of cardboard, so offering to turn one over would show
              a card back. */}
          {sides === 2 && (
            <button type="button" onClick={onFlip} className={cn(ART_CONTROL, FOCUS)}>
              <FlipHorizontal2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Flip card</span>
            </button>
          )}
          {/* The other axis, and the one `faceCount` says nothing about: `split`, `planar` and
              `flip` print some of their text at ninety or a hundred and eighty degrees to the
              rest, so a reader with no way to turn the picture simply cannot read that half.
              `orientation.ts` is the rule and this is its only control in the app — a wall of
              tiles is for finding a card, not reading one. */}
          {turn !== null && (
            <button
              type="button"
              // A toggle, on the foil control's terms below: the state is `aria-pressed` rather
              // than two buttons swapping places, and the visible words change with it because
              // they *are* the accessible name.
              aria-pressed={turned}
              onClick={() => setTurned((t) => !t)}
              className={cn(ART_CONTROL, FOCUS)}
            >
              <TurnGlyph className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{turnLabel}</span>
            </button>
          )}
          {/* A half of a meld gets both verbs, and they are different acts rather than two
              spellings of one. **Meld** puts the melded card's picture in this frame, on a panel
              that is still about the card the reader opened — which is how you check what two
              halves make without losing your place. **Open** makes it the open card, with its own
              prices, printings and collection state.

              The glyphs are what tell them apart at a glance and they are used that way
              throughout this row: `Combine` means *shown here*, the arrow means *go there*. */}
          {meldResult !== null && (
            <>
              <button
                type="button"
                aria-pressed={meld.melded !== null}
                onClick={() => meld.onMeld(meld.melded ? null : meldResult)}
                className={cn(ART_CONTROL, FOCUS)}
              >
                <Combine className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">Meld — {meldResult.name}</span>
              </button>
              <button
                type="button"
                onClick={() => meld.onOpen(meldResult.id)}
                className={cn(ART_CONTROL, FOCUS)}
              >
                <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">Open melded card</span>
              </button>
            </>
          )}
          {/* The melded card's own two controls, and they only open. There is nothing for a *view*
              to do here — the picture in the frame already **is** the meld — so what a reader on
              Brisela wants of Gisela and Bruna is their cards: what they cost, which printings
              exist, whether the collection holds one. The label names the relationship because
              nothing else on this panel would say why those two cards are under this one. */}
          {meldParts.map((part) => (
            <button
              key={part.id}
              type="button"
              onClick={() => meld.onOpen(part.id)}
              className={cn(ART_CONTROL, FOCUS)}
            >
              <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Meld part — {part.name}</span>
            </button>
          ))}
          {/* Not while a meld view is up: the sheen and the chip are a statement about **this
              printing's** cardboard, and the picture in the frame is another card's. A control
              that stayed and marked the wrong card would be the artist-credit bug drawn instead
              of written. */}
          {foilable !== null && meld.melded === null && (
            <button
              type="button"
              // A **toggle**, so the state is `aria-pressed` and not two buttons swapping places
              // — a reader who tabbed onto it is told both what it does and whether it is on. The
              // visible words change with it, because they *are* the accessible name here, and a
              // name that no longer contains the visible label is a control voice control can no
              // longer press (WCAG 2.5.3).
              aria-pressed={foilView}
              onClick={pressFoil}
              className={cn(ART_CONTROL, FOCUS)}
            >
              {/* The glyph straight from lucide rather than through `FinishMark`, deliberately:
                  that component is a `role="img"` carrying the finish as its accessible name, and
                  a labelled image inside a button *joins* the button's name — this control would
                  be called "Foil View as foil". */}
              <FoilGlyph className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{foilLabel}</span>
            </button>
          )}
          {/* **A printing with no shiny copy says so, rather than losing its control** (issue
              #167). A row that simply drops a button cannot be told from an app that forgot to
              draw one: the reader's question is "is there a foil of this?", and silence answers
              it the same way a bug would. The greyed control is the answer, in the slot the
              toggle would have occupied.

              Not while a meld view is up, and **the two conditions stay two** — the toggle above
              is hidden there because the sheen it explains would be marking another card's
              photograph, which is a statement about the *picture*. This one is a statement about
              *this printing's cardboard*, and it is withheld for the same reason the price cells
              would be if they were about the frame: while the frame holds a counterpart, nothing
              in this row may look like a caption for it. */}
          {noFoil && meld.melded === null && (
            <button
              type="button"
              // **`disabled` and not this app's usual `aria-disabled`**, which is `StepChevron`'s
              // exception rather than a new one. That rule is for a control that greys as the
              // reader types, where leaving the caret on something that just went dead under
              // their hands is what makes it wrong. Nothing a reader can do here gives this
              // printing a foil — another printing is another card, and the modal is keyed on the
              // card — so a tab stop would buy the caret a place to stop and nothing to do in it.
              // It is also the state `Dialog`'s `trapTab` already reads: `disabled` is filtered
              // out of the cycle, so this costs Tab one stop rather than swallowing a wrap.
              disabled
              className={cn(
                ART_CONTROL,
                // The whole of what greyed means, on `StepChevron`'s and `QuantityStepper`'s
                // terms: dimmed, and the hover response dropped — a control that still lights up
                // under the pointer is one a reader goes on trying to press. No `FOCUS`: a
                // `disabled` button never takes the caret, so the outline would be a rule nothing
                // can ever draw.
                "disabled:opacity-40 disabled:hover:text-dim",
              )}
            >
              {/* The glyph the toggle would have drawn, greyed with the rest of the control. It
                  names what this control is *about* and does not claim the copy is foil —
                  `FoilOverlay`'s chip is what makes that claim, and on this printing it is
                  drawing nothing. */}
              <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
              {/* The visible words **are** the accessible name — the glyph is `aria-hidden` and
                  there is nothing else in the box — so a reader hearing this modal is told "No
                  foil, dimmed button" and gets the fact rather than an unnamed dead control. */}
              <span className="min-w-0 truncate">No foil</span>
            </button>
          )}
        </div>
      )}

      {/* **One cell per finish, which is spec §4 and the reason the mockup is not copied here.**
          Priced by the backend at the marketplace the modal asked for, and **never across
          marketplaces**: an unpriced finish arrives as `null` and reads "—". The holes are real
          and differ per marketplace — `eur_etched` is not a key Scryfall has, so Etched on
          Cardmarket is always an em dash — and another marketplace's number would be a quote
          nobody made.

          Two columns, and a third finish therefore starts a second row rather than squeezing the
          first: three is the ceiling (`cards.finishes` is built from three words across all
          116 712 rows) and two cells of air under a two-finish printing is what the mockup
          draws.

          **Spec §5's as-of sentence is no longer under these cells.** It is a footnote of the
          panel now, drawn once by `CardDetailModal` beside the Scryfall credit — the two
          sentences share the footer's left corner rather than each hanging under the block it is
          about. The condition travelled with it: the host draws the sentence only where this
          `finishes.length > 0` is true, because a printing with no finishes is priced nowhere and
          a caption about nothing is worse than none. */}
      {finishes.length > 0 && (
        <dl className="grid grid-cols-2 gap-2">
          {finishes.map((f) => (
            <div key={f} className="min-w-0 rounded-md border border-border px-2.5 py-1.5">
              {/* **The treatment's word where the copy has one** — `Halo Foil  $95.79` rather
                  than `Foil  $95.79`, which is the whole of issue #160 stated in the one place
                  on this column that has room for words. `treatmentName` and not
                  `treatmentTitle`: a cell has one line for the label, so "Silver Foil · Scroll"
                  would push the price out of it — the joined reading belongs to the marks.

                  Per finish, so the fence does the work: the nonfoil cell of a Surge Foil
                  printing still reads `Nonfoil`, because the plain copy is not a Surge Foil. */}
              <dt className="truncate text-xs text-dim">
                {treatmentName(finishTreatments(card.promoTypes, f)) ?? FINISH_LABEL[f]}
              </dt>
              <dd className="truncate font-mono text-sm tabular-nums">
                {formatPrice(card.finishPrices[f], marketplace.currency)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
