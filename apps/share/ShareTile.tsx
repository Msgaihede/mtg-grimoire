import { CardTile } from "@grimoire/ui/components/CardTile";
import { CountTag } from "@grimoire/ui/components/CountTag";
import { DEFAULT_ZOOM } from "@grimoire/ui/lib/cardZoom";
import { CONDITION_LABEL, type Condition } from "@grimoire/ui/lib/conditions";
import { isFinish, type Finish } from "@grimoire/ui/lib/finish";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { formatPrice } from "@grimoire/ui/lib/prices";
import type { ShareCard } from "@grimoire/ui/lib/shareSnapshot";

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
 * **`CardTile` rather than a frame of its own**, which is most of why a page with no core imports
 * from `packages/ui/` at all: several surfaces in the app draw a card, and `CardTile` composes `CardArt`
 * and `CardChin`, which are the one definition of what a card and its chin look like. A fresh
 * drawing, on the one page a stranger sees, is exactly the drift `packages/ui/CLAUDE.md` was written
 * about.
 *
 * Three things this tile is **not**, and each is a fact about the surface rather than a
 * simplification:
 *
 * * **It is not a button.** There is no card to open — the snapshot carries a printing's
 *   identity and its picture and nothing a detail pane could draw — and a button that opened
 *   nothing would be a control the page cannot honour.
 * * **`cardId={null}`, always — but that is not what carries the picture.** `remoteSrc` is:
 *   this page has no Tauri behind it and so no `mtgimg://` protocol to ask, and `CardArt`'s
 *   `remoteSrc` is the one door for a picture from anywhere else — `CardTile` is what passes
 *   it to `CardArt`, and this tile is the only surface that supplies one. ⚠️ **Always
 *   `card.img ?? null`, never bare `card.img`**: an absent `remoteSrc` means *the cache*, and a
 *   present `null` means *no picture*. A card the publisher's corpus had forgotten carries no
 *   `img`, which `CardArt` draws as a named frame rather than a broken image. The null id is
 *   kept as defence in depth: it means this bundle can never *ask* for the `mtgimg://` protocol
 *   a browser has never heard of.
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
    <li className="flex flex-col">
      <CardTile
        cardId={null}
        name={card.n}
        remoteSrc={card.img ?? null}
        finish={marked}
        rarity={null}
        chin={{ setCode: card.s, collectorNumber: card.cn }}
        zoom={DEFAULT_ZOOM}
        // `undefined` rather than `null`: the chin draws no money slot for the first and an em
        // dash for the second, which is precisely the difference between "nobody asked" and
        // "nobody quoted". Both are live states on this page.
        money={showValue ? formatPrice(card.p ?? null, currency) : undefined}
        overlay={
          card.q > 1 ? (
            // Bottom-left. The art's top-right corner is the finish chip's on every wall in this
            // app, and a bare number laid *on* a card is `CountTag` — no `×`. The tag is
            // `aria-hidden`, so the words are owed elsewhere: the tile's own sr-only line below
            // carries them.
            <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
              <CountTag count={card.q} title={`${card.q} copies`} />
            </span>
          ) : undefined
        }
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
