import { useState, type JSX } from "react";
import { FlipHorizontal2, Gem, Sparkles } from "lucide-react";
import { FoilOverlay } from "@/components/CardArt";
import { CardImage } from "@/components/CardImage";
import { RarityGem } from "@/components/RarityGem";
import { FINISH_LABEL, parseFinishes, soleFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
import type { CardDetail, DeckFinish } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { finishTreatments, treatmentName } from "@/lib/treatment";
import { cn } from "@/lib/utils";
import { faceCount } from "./printings";

/**
 * One control in the row under the art — the row that changes **what the picture shows** and
 * never what the card is.
 *
 * A local copy of `CardDetailPane`'s `ART_CONTROL` rather than an import, because that file is
 * deleted with the dock; the two live side by side for one wave. `grow basis-[calc(50%-0.5rem)]`
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
 * The finish this printing's foil toggle is *about*, or `null` where there is nothing to toggle.
 *
 * Copied from `CardDetailPane`'s `foilViewFinish` for that file's deletion, and it answers only
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
 * The card modal's left column: the picture, what printing it is, what it costs.
 *
 * ## What is here and what is deliberately not
 *
 * Top to bottom: the art in a bordered box with a **chin** under it (rarity, set code, collector
 * number, and the set's name pushed right), the row that changes what the picture shows, one
 * price cell per finish, and the sentence saying how old those prices are.
 *
 * **The artist credit and the Scryfall source line are not here**, though the image policy
 * requires both wherever art is shown. They are the panel's footnotes, drawn once by
 * `CardDetailModal` — the artist that has to be credited is the one whose art is *on screen*,
 * which the host is the only thing that knows, and two copies of a credit is worse than one.
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
 * ## Presentational, on purpose
 *
 * It owns exactly one piece of state — whether the reader has asked to *see* the shiny copy —
 * and reads no store and no query. Every write is a prop, so the host can mount it over a deck
 * row, over a collection tile or over nothing at all, and so this file's test can exist without
 * a deck in the tree.
 */
export function CardModalArt({
  card,
  face,
  onFlip,
  marketplace,
  deckRow,
  onToggleFoil,
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
   * The reader pressed the foil toggle, and this is the finish they are asking the deck row to
   * play — `null` for the regular copy.
   *
   * The argument is what the brief's bare `() => void` could not carry: the press is a *view*
   * change everywhere and a **write** where there is a row, and the host cannot tell which way
   * the toggle went without being told. A handler that ignores it still typechecks.
   */
  onToggleFoil: (next: DeckFinish) => void;
}): JSX.Element {
  const sides = faceCount(card.layout, card.faces.length);
  const finishes = parseFinishes(card.finishes);
  const foilable = foilViewFinish(card.finishes);

  // The src that failed, so a flip or a new card clears it without an effect. The host keys this
  // column on the card, so browsing away throws the whole subtree out.
  const [broken, setBroken] = useState<string | null>(null);
  // Opened showing the copy the reader actually has, where the surface knew of one. `null` seeds
  // nothing, which is right — regular is the finish a card is assumed to be.
  const [foilView, setFoilView] = useState(deckRow?.finish != null);

  // **Through `cardArtSrc`, which is the whole of what makes this frame draw in a browser.** An
  // `mtgimg://` URL is registered natively with the webview and wasm cannot register a scheme, so
  // handing one to a browser `<img>` paints a *broken* image where a card belongs — worse than
  // the named empty frame a `null` gives.
  const src = cardArtSrc(cardImageUrl(card.id, face, "display"), card.imageUris?.display);
  const pictured = card.faces[face]?.name || card.name;

  // What the sheen is asked for. `soleFinish` is the *statement* — this printing is foil — and
  // the toggle is the only thing that ever adds to it; the two cannot both answer, because
  // `soleFinish` speaks only for a printing with one finish and `foilable` only for one with at
  // least two.
  const marked = foilView && foilable ? foilable : soleFinish(card.finishes);
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
          something else. `overflow-hidden` clips the art to the box's own corners, which is what
          lets the image itself carry no rounding. */}
      <div className="overflow-hidden rounded-xl border border-border bg-bg">
        {/* Positioned, so the art and the foil sheen have something to hang from, and full width
            at every rung — below `@min-[640px]/card` the panel is one full-bleed column, and at
            and above it the column's width is the parent grid's business rather than this box's.
            The proportions are `CARD_ASPECT` and never a hand-written ratio: the deck editor's
            Grid view kept `aspect-[488/680]` beside it for weeks and drew one card two ways on
            one screen. */}
        <div className="relative w-full" style={{ aspectRatio: CARD_ASPECT }}>
          {src === null || broken === src ? (
            // A rate-limited image is a 503 the `<img>` cannot read, so this says what is known
            // rather than guessing: the card is still identified, and the way back is stated.
            <div className="flex size-full flex-col items-center justify-center gap-1 px-6 text-center">
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
              // shows if the fetch fails, and both readers want the card.
              alt={pictured}
              src={src}
              onError={() => setBroken(src)}
              decoding="async"
              // No filters and no crop: distorting, recolouring or cropping a card image is
              // forbidden by Scryfall's usage rules. `object-cover` is a no-op here — the box is
              // the card's own rectangle — and never stretches, which is the part the rules are
              // about.
              className="size-full animate-in bg-bg object-cover fade-in duration-150 motion-reduce:animate-none"
            />
          )}
          <FoilOverlay finish={marked} treatments={finishTreatments(card.promoTypes, marked)} />
        </div>
        {/* Which piece of cardboard this is, in the data face. The set's **name** is pushed right
            and is the elastic half — at the narrowest rung there is no width to give back, so the
            fixed things are the code and the number a reader is matching against a card in hand,
            and the name is what truncates. */}
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
          card with neither draws no row at all. */}
      {(foilable !== null || sides === 2) && (
        <div className="flex flex-wrap gap-2">
          {foilable !== null && (
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
          {/* `faceCount` and never `faces.length`: `split`, `adventure` and `flip` all print two
              faces on one side of one piece of cardboard, so offering to turn one over would show
              a card back. */}
          {sides === 2 && (
            <button type="button" onClick={onFlip} className={cn(ART_CONTROL, FOCUS)}>
              <FlipHorizontal2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Flip card</span>
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
          draws. */}
      {finishes.length > 0 && (
        <div className="space-y-1.5">
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
          {/* Spec §5: a price is never shown without saying how old it is — and, now that there
              is more than one answer, whose it is. `pricesAsOf` says which of the two clocks this
              marketplace runs on: the card-data sync for the blob-backed pair, the last
              price-feed refresh for the two this app downloads. */}
          <p className="text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        </div>
      )}
    </div>
  );
}
