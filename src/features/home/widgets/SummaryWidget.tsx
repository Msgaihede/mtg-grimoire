/**
 * What the whole grimoire adds up to: four figures — the collection's copies, the decks, the
 * wishlist's copies, and what the collection is worth — each a press that opens the view it is
 * about.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the tray and the settings popover; this
 * draws the figure line inside it, cut to the box it was handed. {@link SummaryWidgetSettings} is
 * the one setting the registry cannot declare as a pick or a toggle: which of the four figures the
 * reader wants at all.
 *
 * ## Four reads, and why they are four rather than one
 *
 * There is no `home_summary` command and there deliberately is not one. Every figure here is
 * already answered by the command the view it names is built on — `collection_summary`,
 * `deck_list`, `deck_values`, `wishlist_summary` — so a fifth command would be a fifth place
 * the same arithmetic is written, and the first time one of them changed its mind about what
 * it counts this widget would quietly disagree with the page a press from it opens. Four reads
 * of the same rows a reader can navigate to is the whole point: **the number on this card and
 * the number on that page are one query, not two answers.**
 *
 * It is also why the four keys it reads are the roots that data already lives under. Every write
 * in this app already fires `invalidateQueries({ queryKey: ["collection"] })`, `["decks"]` or
 * `["wishlist"]` — `lib/query.ts` names the set — so this widget refreshes after an add, a
 * move or a removal with **no mutation anywhere learning a new key**. A `["home", …]` root
 * would have needed every one of those writes to grow a line, and the 30 s `staleTime` would
 * have hidden whichever one was forgotten.
 *
 * All four live in `../keys`, which is where that argument is written out in full, and it is
 * **one definition apiece rather than four spellings**: `deckListKey` is `["decks", "list"]`
 * **exactly** — `features/decks/useDecks.ts`'s own key rather than a private one beside it —
 * and `collectionTotalKey` and `wishlistTotalKey` are the very functions the two value widgets
 * read through. Two observers of one key are one fetch, so the gallery and this card can never
 * come to disagree about how many decks there are, and neither can this card and the value card
 * beside it about what the collection is worth.
 *
 * **All four reads run whichever figures are drawn.** A figure the reader hid or the box had no
 * room for still names its money in a neighbour's press label, and a read that switched on and off
 * with a resize would be a fetch per drag of the corner.
 *
 * ## What the line shows, and what the words carry
 *
 * The redesign's figure line has room for one number apiece, so the three counts draw their counts
 * and **Value** draws the collection's money. The deck value and the wishlist cost the previous
 * face printed under each count are not dropped: each count's **press label** is still the whole
 * sentence — `Decks: 2 decks, $120.25, 62 unpriced` — and its **hint** says the same money to a
 * pointer. A figure line that lost two totals to make room would be a summary that summarises less.
 *
 * ## Money
 *
 * Every figure is quoted at the marketplace the reader picked, which is why its id is in each
 * priced key: switching marketplace re-issues the query rather than re-reading a second field
 * that does not exist. `formatPrice` writes it and `pricesAsOf` dates it. A `null` is an em dash
 * and never another marketplace's number.
 *
 * ## The three sentences
 *
 * Loading, empty and refused are three different statements and never one shrug. "We have not
 * read it yet", "there is nothing to read" and "the read was refused" send a reader to three
 * different places, and a widget that drew zeroes for all three would be lying in two of them.
 * A refusal says what the backend said, through `ipcError`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type CollectionSummary,
  type DeckValue,
  type HomeWidget,
  type WishlistSummary,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore, type ViewId } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import type { WidgetFit } from "../fit";
import {
  collectionTotalKey,
  deckListKey,
  deckValuesKey,
  wishlistTotalKey,
} from "../keys";
import { widgetConfig } from "../layout";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { WidgetFigures, WidgetMessage, type WidgetFigureItem } from "../WidgetParts";

// The four keys this widget reads through live in `../keys`, and **two of them are shared**:
// `collectionTotalKey` is also `CollectionValueWidget`'s and `wishlistTotalKey` is also
// `WishlistValueWidget`'s, so each pair is one fetch rather than two. See that file's module doc,
// and `keys.test.tsx` for the assertion that keeps the pairs equal.

/** The four figures, by the key `config.hide` stores. */
export type SummaryFigureKey = "collection" | "decks" | "wishlist" | "value";

/**
 * The four figures in the order they are drawn, and the words the settings checklist names them
 * by. **The order is the fit's priority**: a card with room for two draws the first two a reader
 * has not hidden, so the counts outrank the money on a tile — the figure a press opens a view with
 * is the more useful one to keep.
 */
export const SUMMARY_FIGURES: readonly { key: SummaryFigureKey; label: string }[] = [
  { key: "collection", label: "Collection" },
  { key: "decks", label: "Decks" },
  { key: "wishlist", label: "Wishlist" },
  { key: "value", label: "Value" },
];

/**
 * The figure keys the reader switched off.
 *
 * Through `widgetConfig`, whose empty-array fallback accepts any stored array, and then narrowed to
 * strings: a hand-edited `[1, null]` is no figure hidden rather than a crash. A key this build has
 * never heard of is kept in the set and matches nothing, so a newer build's fifth figure survives
 * an older build's checklist press — see {@link SummaryWidgetSettings}.
 */
function hiddenFigures(widget: HomeWidget): string[] {
  const { hide } = widgetConfig<{ hide: unknown[] }>(widget, { hide: [] });
  return hide.filter((key): key is string => typeof key === "string");
}

/**
 * Every deck's worth as one figure, and the copies no price was found for.
 *
 * **`DeckValue.value` is `number | null` and the two are not the same zero.** `null` is *the
 * marketplace priced nothing in this deck* — a pile of tokens, a deck of cards a bulk feed has
 * never listed — so it contributes nothing to the sum; `0` is a real answer and contributes it.
 * A sum that started at `0` would turn "we could not price a single card in any of your decks"
 * into `$0.00`, which is a number nobody quoted. So the total stays `null` until some deck
 * actually contributes, and `formatPrice` draws the em dash.
 *
 * `unpriced` is summed across every row regardless, because it is a count of copies rather than
 * a price: a deck whose value is `null` is exactly the deck with the most of them.
 *
 * Exported for its own test — the null rule is arithmetic, and arithmetic is worth asserting
 * without a render in the way.
 */
export function sumDeckValues(values: readonly DeckValue[]): {
  value: number | null;
  unpriced: number;
} {
  let value: number | null = null;
  let unpriced = 0;
  for (const row of values) {
    if (row.value !== null) value = (value ?? 0) + row.value;
    unpriced += row.unpriced;
  }
  return { value, unpriced };
}

/**
 * How many figures this box draws — the design's grid question, over the figures the reader kept.
 *
 * **The reader's picks come first and the fit is applied to what is left**: a figure they switched
 * off is not a figure competing for room. Figures wrap, so what fits is how many share a line
 * (~110px each) times how many lines the body has (~40px each); what is *wanted* is by tier — a
 * two-cell tile is an honest pair, a three-cell panel is a pair on one row and all four on two, and
 * anything wider carries all four. Never fewer than one: a Summary with a figure left to draw draws
 * it rather than an empty body.
 */
function figuresFor(fit: WidgetFit): number {
  const perRow = Math.max(1, Math.floor(fit.widthPx / 110));
  const rowsOfFigures = Math.max(1, Math.floor(fit.bodyHeightPx / 40));
  const wanted = fit.tier >= 2 ? 4 : fit.tier === 1 ? (fit.h >= 2 ? 4 : 2) : 2;
  return Math.max(1, Math.min(wanted, perRow * rowsOfFigures));
}

export function SummaryWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const { marketplace } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);

  const collection = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // No filters at all, which is what makes this the *whole* collection: `folderId` absent and
    // `rootOnly` absent is every folder there is — `CollectionQuery.folderId` says so — and
    // `excludeLocked` keeps its `false` default, so a drawer the reader set aside is still
    // cardboard they own. `limit: 0` is the summary's own idiom for "count, do not list".
    queryFn: () => ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const decks = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const deckValues = useQuery({
    queryKey: deckValuesKey(marketplace.id),
    queryFn: () => ipc.deckValues(marketplace.id),
  });
  const wishlist = useQuery({
    queryKey: wishlistTotalKey(marketplace.id),
    queryFn: () => ipc.wishlistSummary(marketplace.id),
  });

  // The first refusal there is, whichever read produced it. One sentence rather than four,
  // because a reader whose database will not answer one of these is not helped by learning
  // which: the card has no figures either way, and the message the backend gave is the part
  // worth reading.
  const failure = collection.error ?? decks.error ?? deckValues.error ?? wishlist.error;
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Your totals could not be read. {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (
    collection.data === undefined ||
    decks.data === undefined ||
    deckValues.data === undefined ||
    wishlist.data === undefined
  ) {
    return <WidgetMessage>Adding up your collection, decks and wishlist…</WidgetMessage>;
  }

  // The empty state is *all three* being empty. One empty list among three is not an empty
  // grimoire — a reader with a collection and no decks is owed the collection's figure and a
  // plain `0` beside it, which is a true statement about their decks rather than a gap.
  if (collection.data.totalCards === 0 && decks.data.length === 0 && wishlist.data.copies === 0) {
    return (
      <WidgetMessage>
        Nothing to add up yet. Cards you collect, decks you build and cards you wish for are counted
        here.
      </WidgetMessage>
    );
  }

  const hidden = hiddenFigures(widget);
  const chosen = figures({
    collection: collection.data,
    deckCount: decks.data.length,
    deckValues: deckValues.data,
    wishlist: wishlist.data,
    currency: marketplace.currency,
    asOf: pricesAsOf(marketplace),
    // **A still body opens nothing** — a catalogue preview is a picture of this card, and a
    // figure there that navigated would take the reader out of the dialog they are choosing in.
    onOpen: still ? null : setActiveView,
  }).filter((figure) => !hidden.includes(figure.key));

  if (chosen.length === 0) {
    // Every figure switched off. Not an empty body: a card that draws nothing reads as a card
    // that failed, and the reader who emptied it is owed the way back.
    return (
      <WidgetMessage>
        Every figure is hidden. Turn one back on in this card&rsquo;s settings.
      </WidgetMessage>
    );
  }

  return <WidgetFigures figures={chosen.slice(0, figuresFor(fit))} fit={fit} />;
}

/**
 * The four figures, built once from the four answers.
 *
 * A plain function rather than a `useMemo`: it is four object literals over numbers that are
 * already in hand, and the array is read by the render that made it.
 */
function figures({
  collection,
  deckCount,
  deckValues,
  wishlist,
  currency,
  asOf,
  onOpen,
}: {
  collection: CollectionSummary;
  deckCount: number;
  deckValues: readonly DeckValue[];
  wishlist: WishlistSummary;
  currency: Currency;
  asOf: string;
  /** `null` on a still body, which draws the figures as text rather than presses. */
  onOpen: ((view: ViewId) => void) | null;
}): (WidgetFigureItem & { key: SummaryFigureKey })[] {
  const decks = sumDeckValues(deckValues);

  /**
   * One count figure: its number, its unit, and — in the press label and the hint — the money
   * the previous face printed under it. See the module doc's second section.
   */
  const counted = (
    key: SummaryFigureKey,
    view: ViewId,
    label: string,
    copies: number,
    noun: string,
    worth: { word: string; value: number | null; unpriced: number },
  ): WidgetFigureItem & { key: SummaryFigureKey } => {
    const unit = copies === 1 ? noun : `${noun}s`;
    const price = formatPrice(worth.value, currency);
    const note = worth.unpriced > 0 ? `${count(worth.unpriced)} unpriced` : null;
    return {
      key,
      label,
      value: count(copies),
      note: unit,
      tone: "text",
      // Which marketplace's money this is and how old it is — the sentence this app puts on
      // every price that has no room to write it out.
      hint: onOpen === null ? undefined : `${worth.word} ${price}${note ? ` (${note})` : ""}. ${asOf}`,
      onPress: onOpen === null ? undefined : () => onOpen(view),
      // **Written out rather than assembled from the visible text.** A name computed from the
      // figure's two lines is the text nodes run together with no separator — a label and a count
      // come out as one word — so the sentence is stated here, in the order the eye reads it.
      pressLabel: `${label}: ${count(copies)} ${unit}, ${price}${note ? `, ${note}` : ""}`,
    };
  };

  const collectionNote =
    collection.unpriced > 0 ? `${count(collection.unpriced)} unpriced` : undefined;
  const collectionPrice = formatPrice(collection.value, currency);

  return [
    counted("collection", "collection", "Collection", collection.totalCards, "card", {
      word: "Worth",
      value: collection.value,
      unpriced: collection.unpriced,
    }),
    // **Every deck, archived ones included**, which is what the gallery a press from here opens
    // also draws — archived last rather than absent. The count and the value are one set of decks
    // for that reason: a total over piles the count leaves out is a figure that cannot be checked
    // against anything on screen.
    counted("decks", "decks", "Decks", deckCount, "deck", {
      word: "Worth",
      value: decks.value,
      unpriced: decks.unpriced,
    }),
    // Copies rather than `wishes`: the other two counts are cardboard, and a line that counted
    // *things shopped for* beside two that count copies would be numbers in two units under one
    // heading.
    counted("wishlist", "wishlist", "Wishlist", wishlist.copies, "card", {
      word: "Costs",
      value: wishlist.cost,
      unpriced: wishlist.unpriced,
    }),
    {
      key: "value",
      label: "Value",
      value: collectionPrice,
      // A qualification rather than a unit, so `WidgetFigures` drops it where there is no room to
      // read it — the press label and the hint still carry it.
      note: collectionNote,
      tone: "accent",
      hint: onOpen === null ? undefined : asOf,
      onPress: onOpen === null ? undefined : () => onOpen("collection"),
      pressLabel: `Collection value: ${collectionPrice}${collectionNote ? `, ${collectionNote}` : ""}`,
    },
  ];
}

/**
 * Which of the four totals this card carries — the design's `Figures` checklist, at the foot of
 * the settings popover.
 *
 * **One list rather than a single "show figures" switch**, because Summary *is* its figures: a
 * reader who keeps a wishlist but no decks wants three of them, and turning the lot off would
 * leave an empty card.
 *
 * **It writes the whole hidden list and keeps what it does not recognise**: a key a newer build
 * hid stays hidden through this build's press. Nothing hidden is stored as *absent* rather than as
 * `[]`, the toggles' rule — an unconfigured card and a card the reader put back the way it was are
 * one config.
 */
export function SummaryWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const hidden = hiddenFigures(widget);
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 p-0 text-xs text-dim">Figures</legend>
      {SUMMARY_FIGURES.map((figure) => {
        const on = !hidden.includes(figure.key);
        return (
          <label
            key={figure.key}
            className="flex items-center justify-between gap-2 py-px text-[0.8125rem]"
          >
            <span className={on ? "text-text" : "text-dim"}>{figure.label}</span>
            <input
              type="checkbox"
              checked={on}
              onChange={() => {
                const next = on
                  ? [...hidden, figure.key]
                  : hidden.filter((key) => key !== figure.key);
                onConfig({ hide: next.length === 0 ? undefined : next });
              }}
              className={cn("size-3.5 accent-accent", FOCUS)}
            />
          </label>
        );
      })}
    </fieldset>
  );
}
