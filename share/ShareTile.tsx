import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import { CountTag } from "@/components/CountTag";
import { cardScaleVars, DEFAULT_ZOOM } from "@/lib/cardZoom";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { isFinish, type Finish } from "@/lib/finish";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { ShareCard } from "@/lib/shareSnapshot";

/**
 * The absence, drawn.
 *
 * One character in one constant, because three columns answer it — condition, language and
 * money — and `formatPrice` already writes this exact glyph for a `null`. Two spellings of an
 * em dash on one tile is one column looking broken.
 */
export const NOTHING = "—";

/** `"foil"` off the wire as a {@link Finish}, or `null` for anything this build does not know. */
export function wireFinish(f: string): Finish | null {
  return isFinish(f) ? f : null;
}

/**
 * One published copy, drawn as the card it is.
 *
 * **`CardArt` and `CardChin` rather than a frame of its own**, which is most of why a page with
 * no core imports from `src/` at all: several surfaces in the app draw a card and those two are
 * the one definition of what that looks like. A fresh drawing, on the one page a stranger sees,
 * is exactly the drift `src/CLAUDE.md` was written about.
 *
 * Three things this tile is **not**, and each is a fact about the surface rather than a
 * simplification:
 *
 * * **It is not a button.** There is no card to open — the snapshot carries a printing's
 *   identity and its picture and nothing a detail pane could draw — and a button that opened
 *   nothing would be a control the page cannot honour.
 * * **`cardId={null}`, always — but that is not what carries the picture.** ⚠️ `cardArtSrc` is
 *   `isWebTarget() ? (suppliedUrl ?? null) : protocolUrl`, so what makes the frame draw
 *   `card.img` is **`__CORE__ === "web"`**, which `vite.share.config.ts` defines and this
 *   bundle's build is the only place it comes from. With `cardId={null}` on a *tauri* build the
 *   same call returns `null` and no `<img>` is drawn at all — which is why the suite mocks
 *   `@/pwa/target`, and why a doc saying "the supplied URL on every build" would be wrong.
 *   The null is kept as defence in depth: it means this bundle can never *ask* for the
 *   `mtgimg://` protocol a browser has never heard of, even if that define were ever wrong.
 *   A card the publisher's corpus had forgotten carries no `img` — which `CardArt` draws as a
 *   named frame rather than a broken image.
 * * **`rarity={null}` on the chin.** Rarity is not on the wire (spec §3's absences), so the gem
 *   says *unknown* rather than being derived from a corpus this page does not have.
 */
export function ShareTile({
  card,
  currency,
  showValue,
  showCondition,
  showLang,
}: {
  card: ShareCard;
  currency: Currency;
  /**
   * Whether `fields` named `value`.
   *
   * ⚠️ **Not "whether this card has a price".** A snapshot that answered the money question
   * still carries cards the marketplace does not quote, and those draw {@link NOTHING} — the
   * absence `shareSnapshot.ts`'s header calls ordinary rather than an edge case. `false` here
   * draws no money slot at all, which is the other answer entirely: nobody asked.
   */
  showValue: boolean;
  /** Whether `fields` named `condition`. The same rule: this is the column, not the value. */
  showCondition: boolean;
  /** Whether `fields` named `lang`. The same rule again. */
  showLang: boolean;
}) {
  // A published copy *is* the finish it was stored as — a collection row's own answer, not a
  // printing's "could be" — so foil and etched are marked. `nonfoil` goes unmarked, which is the
  // app's rule everywhere and not this page's shortcut.
  const finish = wireFinish(card.f);
  const marked = finish === "nonfoil" ? null : finish;
  // `== null` and not `=== undefined`, throughout both viewers: the writer emits neither — `c`
  // carries `skip_serializing_if` — but nothing validates a document on the way in, and a
  // `c: null` would take the label arm and render the blank cell this comment block forbids.
  const condition = card.c == null ? NOTHING : (CONDITION_LABEL[card.c as Condition] ?? card.c);

  return (
    <li className="group flex flex-col" style={cardScaleVars(DEFAULT_ZOOM)}>
      <div className="relative">
        <CardArt cardId={null} name={card.n} imageUrl={card.img} finish={marked} />
        {card.q > 1 && (
          // Bottom-left. The art's top-right corner is the finish chip's on every wall in this
          // app, and a bare number laid *on* a card is `CountTag` — no `×`. The tag is
          // `aria-hidden`, so the words are owed elsewhere: the tile's own sr-only line below
          // carries them.
          <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
            <CountTag count={card.q} title={`${card.q} copies`} />
          </span>
        )}
      </div>
      <CardChin
        zoom={DEFAULT_ZOOM}
        rarity={null}
        setCode={card.s}
        collectorNumber={card.cn}
        finish={marked}
        // `undefined` rather than `null`: the chin draws no money slot for the first and an em
        // dash for the second, which is precisely the difference between "nobody asked" and
        // "nobody quoted". Both are live states on this page.
        money={showValue ? formatPrice(card.p ?? null, currency) : undefined}
        seam="art"
      />
      {(showCondition || showLang) && (
        // **Two spans and a gap, not one string joined by a middle dot.** Each column has to be
        // able to say {@link NOTHING} on its own — a joined line renders `— · EN` as one word
        // and the absence stops being a value.
        <span className="mt-1 flex items-baseline gap-2 overflow-hidden text-[0.6875rem]">
          {showCondition && <span className="truncate text-dim">{condition}</span>}
          {showLang && (
            <span className="shrink-0 font-mono uppercase text-dim">{card.l ?? NOTHING}</span>
          )}
        </span>
      )}
      {/* The name, for the reader who cannot see the picture. `CardArt`'s `alt` carries it too;
          one duplicated name on a tile is cheaper than a wall of cards with no text at all. */}
      <span className="sr-only">
        {card.n}
        {card.q > 1 ? `, ${card.q} copies` : ""}
      </span>
    </li>
  );
}
