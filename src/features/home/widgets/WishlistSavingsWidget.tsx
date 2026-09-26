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
 * ## Three empty sentences
 *
 * `considered` is **every** wish the plan scanned — an any-printing wish is counted in
 * `alreadyCheapest` (`wishlist_optimize.rs:276-288`) — so `considered === 0` is an empty wishlist,
 * not a list with nothing pinned. No move at all is *every pinned wish is already cheapest*, which is
 * also the true answer for a list of any-printing wishes. And moves none of which is priced is the
 * third.
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

import { wishlistSavingsKey } from "../keys";
import {
  WidgetFigures,
  WidgetFooter,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx`'s `rowPx` sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;
/** The figure line, comfortable and compact — `CollectionValueWidget.tsx`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;
/** One footer line and the gap above it. */
const FOOTER_PX = 22;

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

/** The moves that did not fit: `4 more wishes save $11.45`. */
export function cutFooter(cut: readonly WishOptimizeMove[], currency: Currency): string {
  const sum = cut.reduce((total, move) => total + (move.saved ?? 0), 0);
  const n = cut.length;
  return `${count(n)} more ${n === 1 ? "wish saves" : "wishes save"} ${formatPrice(sum, currency)}`;
}

/** The moves with no current price, on their own line: `2 more have no current price`. */
export function unpricedFooter(n: number): string {
  return `${count(n)} more ${n === 1 ? "has" : "have"} no current price`;
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
  if (plan.considered === 0) return <WidgetMessage>{NO_WISHES}</WidgetMessage>;
  if (plan.moves.length === 0) return <WidgetMessage>{ALL_CHEAPEST}</WidgetMessage>;
  const { priced, unpriced, total } = splitSavings(plan.moves);
  if (priced.length === 0) {
    return <WidgetMessage>{unpricedOnly(unpriced, marketplace)}</WidgetMessage>;
  }

  /**
   * The furniture is reserved before the rows are laid in — the figure line, the unpriced line when
   * there is one, and the cut line **only when rows are cut**, which is known only once the rows
   * without it are counted. The second count can only shrink, so the cut line is never drawn into
   * space nothing reserved.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const rowH = captioned ? ROW_CAPTIONED : ROW_BARE;
  const base = (fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX) + (unpriced > 0 ? FOOTER_PX : 0);
  const all = fit.rowsFit(rowH, base);
  const room = priced.length > all ? fit.rowsFit(rowH, base + FOOTER_PX) : all;
  const shown = priced.slice(0, room);
  const cut = priced.slice(room);

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
      {cut.length > 0 && <WidgetFooter>{cutFooter(cut, currency)}</WidgetFooter>}
      {unpriced > 0 && <WidgetFooter>{unpricedFooter(unpriced)}</WidgetFooter>}
    </>
  );
}
