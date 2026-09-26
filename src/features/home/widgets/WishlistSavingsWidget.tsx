/**
 * What moving the reader's pinned wishes to their cheapest printings would save — a figure, and the
 * moves that save most.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the popover and the Customize tray; this
 * draws the figure, the rows and two footer lines, cut to the box `fit` describes.
 *
 * ## No new command: the dialog's own plan, over the whole list
 *
 * `wishlist_optimize_plan` already answers, per pinned wish, both printings with their prices and
 * the saving (`WishOptimizeMove`). This asks it about **the whole wishlist** —
 * `wholeWishlistQuery`, flattened, no filters, at the reader's marketplace — which is the question
 * `WishlistPage` puts to the dialog when a press here lands there, so the dialog offers exactly what
 * this card counted. **It is one cache entry, not two copies**: `wishlistSavingsKey` is
 * `useWishlistOptimize`'s own key for that question, and the payload is spelled the way that hook
 * spells it (`limit: 0, offset: 0`, which the command ignores), so the dialog opens on this card's
 * answer and the dialog's apply — which invalidates `["wishlist"]` — refreshes this card with it.
 * The marketplace decides every figure, and it rides inside the query object that ends the key.
 *
 * **What it inherits from the plan and does not paper over**: wishes in a deck's managed wishlist
 * and digital printings are skipped (`wishlist_optimize.rs:201-204, 270`), and the cheaper printing
 * may be in another language — the plan has no language filter. The card says what the dialog will
 * offer; a language rule, if one is wanted, belongs to the plan and both surfaces.
 *
 * ## Money that is not there is said, never summed
 *
 * `saved` is `null` exactly when `from.price` is — a wish whose printing this marketplace does not
 * list. {@link splitSavings} leaves those out of the figure and counts them for a line of their own
 * (`2 more have no current price`); a card whose moves are *all* like that says so in a sentence
 * rather than drawing `Could save $0.00`. The figure is gold and everything else body ink —
 * `WidgetParts.tsx`'s rule.
 *
 * ## Four empty sentences, and `skipped` is never *cheapest*
 *
 * `considered` is **every** wish the plan scanned — an any-printing wish is counted in
 * `alreadyCheapest` (`wishlist_optimize.rs:276-288`) — so `considered === 0` is an empty wishlist,
 * not a list with nothing pinned. No move at all is *every pinned wish is already cheapest*, which is
 * also the true answer for a list of any-printing wishes — **but only when `skipped` is zero**.
 *
 * `skipped` is a pinned wish the plan could not compare at all (`wishlist_optimize.rs:290-316`): no
 * oracle id to find siblings by, a printing `cards` no longer has, or — the one a reader meets — **no
 * printing of the card priced at this marketplace and finish**: Card Kingdom or Mana Pool picked
 * before its feed has landed, a foil wish where nobody quotes foil. With no move and some skipped,
 * *already cheapest* would be false, so {@link skippedOnly} says that no price was there to compare,
 * naming the marketplace, since switching one is what changes the answer. With moves as well, the
 * face is unchanged and {@link skippedFooter} is one more line — counted, never summed. And moves
 * none of which is priced is the fourth sentence.
 *
 * ## Footers are one line
 *
 * The cut, the unpriced and the skipped lines are each `WidgetFooterLine`: one line at any width,
 * drawing a short `line` (`1 more: no Cardmarket price`) and speaking the whole sentence (`1 more has
 * no price at Cardmarket to compare against`) as its hint and to a screen reader. Each is reserved
 * at what one line draws, `fit.ts`' `footerLinePx` — 24px comfortable, 21 compact. The live pass of
 * 2026-09-26 found the skipped sentence on two lines at every two-cell width and three at a 1024px
 * window, against a reservation of one 22px line, and the body scrolling under it.
 *
 * ## A press opens the dialog
 *
 * A row or the figure writes `setActiveView("wishlist")` and then `setPendingOptimize()` — the view
 * first, because the view change clears every hand-off — and `WishlistPage` opens
 * `OptimizeWishlistDialog` over the whole list without touching the reader's own flatten setting.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import { count, plural } from "@/lib/counts";
import { ipc, ipcError, type WishOptimizeMove } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import { footerLinePx } from "../fit";
import { wishlistSavingsKey } from "../keys";
import {
  WidgetFigures,
  WidgetFooterLine,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
  type FooterWords,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx`'s `rowPx` sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;
/** The figure line, comfortable and compact — `CollectionValueWidget.tsx`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;

const PENDING = "Pricing your pinned wishes…";
export const NO_WISHES =
  "Nothing on your wishlist yet — pin a wish to a printing and this card looks for a cheaper one.";
export const ALL_CHEAPEST =
  "Every pinned wish is already on its cheapest printing, and a wish for any printing always is.";

/**
 * The moves split by whether they can be priced: the priced ones **biggest saving first** (ties by
 * name, through `sortOptions`, which copies), how many cannot be, and the sum of what can. A move
 * with no `saved` is never added as zero.
 */
export function splitSavings(moves: readonly WishOptimizeMove[]): {
  priced: WishOptimizeMove[];
  unpriced: number;
  total: number;
} {
  const priced = sortOptions(
    moves.filter((move) => move.saved !== null),
    (move) => move.name,
    (move) => [-(move.saved ?? 0)],
  );
  const total = priced.reduce((sum, move) => sum + (move.saved ?? 0), 0);
  return { priced, unpriced: moves.length - priced.length, total };
}

/** `Pinned $40.00 · cheapest $21.60` — both prices per copy — and the copies when there are more
 *  than one, so a saving twice the difference reads as what it is. */
export function moveCaption(move: WishOptimizeMove, currency: Currency): string {
  const base = `Pinned ${formatPrice(move.from.price, currency)} · cheapest ${formatPrice(move.to.price, currency)}`;
  return move.quantity > 1 ? `${base} · ${count(move.quantity)} copies` : base;
}

/**
 * The moves that did not fit: `4 more save $11.45`, said as `4 more wishes save $11.45`.
 *
 * **Only the priced moves count, in the number as in the sum.** The body only ever cuts from the
 * priced list, so this is a fence for the next caller rather than a branch the card takes: an
 * unpriced move handed in is neither counted as a wish that saves nor added as zero, and a cut with
 * nothing priced in it answers `null` rather than `0 more wishes save $0.00`.
 *
 * Each footer answers two spellings (`FooterWords`), because a footer is one line
 * (`WidgetFooterLine`): the `line` is drawn and the `said` sentence is its hint and what a screen
 * reader hears. See the module doc's *Footers are one line*.
 */
export function cutFooter(cut: readonly WishOptimizeMove[], currency: Currency): FooterWords | null {
  const priced = cut.filter((move) => move.saved !== null);
  if (priced.length === 0) return null;
  const sum = formatPrice(
    priced.reduce((total, move) => total + (move.saved ?? 0), 0),
    currency,
  );
  const n = priced.length;
  return {
    line: `${count(n)} more ${n === 1 ? "saves" : "save"} ${sum}`,
    said: `${count(n)} more ${n === 1 ? "wish saves" : "wishes save"} ${sum}`,
  };
}

/** The moves with no current price, on their own line: `2 more: no current price`, said as
 *  `2 more have no current price`. */
export function unpricedFooter(n: number): FooterWords {
  return {
    line: `${count(n)} more: no current price`,
    said: `${count(n)} more ${n === 1 ? "has" : "have"} no current price`,
  };
}

/** The pinned wishes the plan could not compare, beside moves it could: `2 more: no Card Kingdom
 *  price`, said as `2 more have no price at Card Kingdom to compare against`. */
export function skippedFooter(n: number, marketplace: Marketplace): FooterWords {
  return {
    line: `${count(n)} more: no ${marketplace.label} price`,
    said: `${count(n)} more ${n === 1 ? "has" : "have"} no price at ${marketplace.label} to compare against`,
  };
}

/** No move, and pinned wishes the plan could not compare — a sentence, never *already cheapest*. */
export function skippedOnly(n: number, marketplace: Marketplace): string {
  return `${plural(n, "pinned wish", "pinned wishes")} ${
    n === 1 ? "has" : "have"
  } no price at ${marketplace.label} to compare against — so there is no saving to count.`;
}

/** Moves exist and none of them can be priced — a sentence, never `Could save $0.00`. */
export function unpricedOnly(n: number, marketplace: Marketplace): string {
  return `${plural(n, "pinned wish", "pinned wishes")} could move to a cheaper printing, but ${
    n === 1 ? "its current printing has" : "their current printings have"
  } no price at ${marketplace.label} — so there is no saving to count.`;
}

export function WishlistSavingsWidget({ fit, still }: WidgetBodyProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingOptimize = useAppStore((s) => s.setPendingOptimize);

  const query = useQuery({
    queryKey: wishlistSavingsKey(marketplace.id),
    // `useWishlistOptimize`'s own payload for this question, spelled the same way: the key is the
    // hook's, so the value cached under it has to be the answer the hook would have fetched.
    // `limit`/`offset` are required by `WishlistQuery` and ignored by the command.
    queryFn: () =>
      ipc.wishlistOptimizePlan({ ...wholeWishlistQuery(marketplace.id), limit: 0, offset: 0 }),
  });

  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not price your wishlist — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;

  const plan = query.data;
  const { skipped } = plan;
  if (plan.considered === 0) return <WidgetMessage>{NO_WISHES}</WidgetMessage>;
  if (plan.moves.length === 0) {
    return (
      <WidgetMessage>{skipped === 0 ? ALL_CHEAPEST : skippedOnly(skipped, marketplace)}</WidgetMessage>
    );
  }
  const skippedLine =
    skipped > 0 ? <WidgetFooterLine {...skippedFooter(skipped, marketplace)} /> : null;
  const { priced, unpriced, total } = splitSavings(plan.moves);
  if (priced.length === 0) {
    return (
      <>
        <WidgetMessage>{unpricedOnly(unpriced, marketplace)}</WidgetMessage>
        {skippedLine}
      </>
    );
  }

  /**
   * The furniture is reserved before the rows are laid in — the figure line, the unpriced and the
   * skipped line when there is one of each, and the cut line **only when rows are cut**, which is
   * known only once the rows without it are counted. The second count can only shrink, so the cut
   * line is never drawn into space nothing reserved.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const rowH = captioned ? ROW_CAPTIONED : ROW_BARE;
  const footer = footerLinePx(fit);
  const base =
    (fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX) +
    (unpriced > 0 ? footer : 0) +
    (skipped > 0 ? footer : 0);
  const all = fit.rowsFit(rowH, base);
  const room = priced.length > all ? fit.rowsFit(rowH, base + footer) : all;
  const shown = priced.slice(0, room);
  const cutWords = cutFooter(priced.slice(room), currency);

  const openOptimise = still
    ? undefined
    : () => {
        setActiveView("wishlist");
        setPendingOptimize();
      };
  const totalText = formatPrice(total, currency);
  const wishes = plural(priced.length, "wish", "wishes");

  return (
    <>
      <WidgetFigures
        fit={fit}
        divided
        figures={[
          {
            key: "saved",
            label: "Could save",
            value: totalText,
            note: `on ${wishes}`,
            tone: "accent",
            hint: pricesAsOf(marketplace),
            onPress: openOptimise,
            pressLabel:
              openOptimise === undefined
                ? undefined
                : `Could save ${totalText} on ${wishes} · Optimise prices`,
          },
        ]}
      />
      <WidgetRowList fit={fit} label="Wishes that could cost less">
        {shown.map((move) => {
          const saved = formatPrice(move.saved, currency);
          const caption = moveCaption(move, currency);
          // The whole row in one string (`DecksWidget.tsx`'s rule), saying what the figure is.
          const pressLabel =
            openOptimise === undefined ? undefined : `${move.name} · ${caption} · saves ${saved}`;
          return tile ? (
            <WidgetRow
              key={move.wishId}
              name={move.name}
              caption={saved}
              captionStrong
              onPress={openOptimise}
              pressLabel={pressLabel}
            />
          ) : (
            <WidgetRow
              key={move.wishId}
              name={move.name}
              caption={captioned ? caption : undefined}
              value={saved}
              onPress={openOptimise}
              pressLabel={pressLabel}
            />
          );
        })}
      </WidgetRowList>
      {cutWords !== null && <WidgetFooterLine {...cutWords} />}
      {unpriced > 0 && <WidgetFooterLine {...unpricedFooter(unpriced)} />}
      {skippedLine}
    </>
  );
}
