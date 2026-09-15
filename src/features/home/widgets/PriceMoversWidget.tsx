/**
 * The owned printings whose price moved most over a window — gainers, losers, or both ranked
 * together by the size of the move.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip and the tray; this draws the rows
 * and the footer, cut to the box it was handed.
 *
 * ## Two empty sentences, never one
 *
 * An empty list here means one of two things and a reader must never be handed one for the other.
 * **There is no history yet** — the app has only just started remembering prices, so there is
 * nothing to measure a move against; that heals by itself as refreshes happen, and saying *nothing
 * moved* would be a claim about prices nobody has compared. **Or nothing moved** — there is history
 * behind the window and no owned printing changed price over it, which is a real answer about the
 * reader's cards. `PriceMovers.days` and `since` are what tell the two apart, which is why the
 * command answers them beside the list: a count of zero movers cannot.
 *
 * ## Money
 *
 * Every figure is quoted at the marketplace the reader picked, with that id **in the key**, so a
 * switch re-issues the read — `src/CLAUDE.md`'s rule, and here it decides more than the numbers:
 * the history is kept per marketplace, so a switch can move the widget from *nothing moved* to
 * *no history yet*. A move is written with its sign, and the minus is a real minus sign (U+2212),
 * which is what every other signed figure on this page draws.
 *
 * **Colour is a fill, never ink** — `WidgetParts.tsx`'s rule: the move sits on a tinted chip in body
 * ink, and the green or red is spent on the chip and on the glyph beside the name.
 *
 * ## One read, whatever the box
 *
 * The read asks for {@link PRICE_MOVERS_READ} rows — the command's own ceiling — and the box cuts
 * that to whole rows. A read sized to the rows that fit would re-issue itself on every drag of the
 * resize corner and draw *pending* over a list that was already right; a hundred rows over local
 * SQLite is not a cost worth that.
 */
import { useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { ReactElement } from "react";

import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import {
  ipc,
  ipcError,
  type PriceMover,
  type PriceMoverDirection,
  type PriceMovers,
  type PriceMoverWindow,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";

import { priceMoversKey } from "../keys";
import {
  DOWN_FILL,
  UP_FILL,
  WidgetFooter,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf } from "../widgetSettings";

/** How many movers the widget reads — `price_movers`' own clamp. See the module doc. */
export const PRICE_MOVERS_READ = 100;

/** A row's height with its caption, and without — the design's two. */
const ROW_PX = 51;
const BARE_ROW_PX = 36;
/** What the footer line takes off the body, gap included. */
const FOOTER_PX = 22;

/** The minus sign every signed figure draws — never a hyphen. */
const MINUS = "−";

const PENDING = "Reading price history…";
export const NO_HISTORY =
  "No price history yet. Prices are remembered from each refresh from now on, and the biggest moves will show here once there is a day to compare against.";

function windowOf(value: string | number | undefined): PriceMoverWindow {
  return value === "30d" || value === "all" ? value : "7d";
}

function directionOf(value: string | number | undefined): PriceMoverDirection {
  return value === "up" || value === "down" ? value : "both";
}

/** What a window measures against, as the footer says it. */
export function windowPhrase(range: PriceMoverWindow): string {
  return range === "7d"
    ? "the last seven days"
    : range === "30d"
      ? "the last thirty days"
      : "the oldest price kept";
}

/** A move with its sign: `+$184.00`, `−$8.60`. */
export function signedMoney(delta: number, currency: Currency): string {
  return `${delta < 0 ? MINUS : "+"}${formatPrice(Math.abs(delta), currency)}`;
}

/**
 * The sentence for a list with nothing in it — see the module doc for why there are two.
 *
 * `null` when there is something to draw. **History first**: a database remembering its first day
 * of prices has no baseline for any window, and telling that reader nothing moved would be a claim
 * about a comparison nobody made. With history, a window that reaches past the oldest snapshot is
 * the same situation at a longer range and says so in its own words.
 */
export function emptySentence(
  answer: PriceMovers,
  range: PriceMoverWindow,
  direction: PriceMoverDirection,
): string | null {
  if (answer.days < 2) return NO_HISTORY;
  if (answer.since === null) {
    return `Prices have been remembered for ${plural(answer.days, "day")} so far — not long enough to measure ${windowPhrase(range)} yet.`;
  }
  if (answer.movers.length > 0) return null;
  const span = range === "all" ? "since the oldest price kept" : `over ${windowPhrase(range)}`;
  const moved =
    direction === "up" ? "went up" : direction === "down" ? "went down" : "changed price";
  return `Nothing you own ${moved} ${span}.`;
}

export function PriceMoversWidget({ widget, fit }: WidgetBodyProps): ReactElement {
  // `range` rather than `window`, which would shadow the global inside a component body.
  const range = windowOf(pickOf(widget, "window"));
  const direction = directionOf(pickOf(widget, "direction"));
  const { marketplace, currency } = useMarketplace();

  const query = useQuery({
    queryKey: priceMoversKey(range, direction, marketplace.id, PRICE_MOVERS_READ),
    queryFn: () => ipc.priceMovers(range, direction, marketplace.id, PRICE_MOVERS_READ),
  });

  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read price history — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  const empty = emptySentence(query.data, range, direction);
  if (empty !== null) return <WidgetMessage>{empty}</WidgetMessage>;

  const bare = fit.compact || fit.tier === 0;
  const footer = fit.tier >= 2 && fit.h >= 2;
  const shown = query.data.movers.slice(
    0,
    fit.rowsFit(bare ? BARE_ROW_PX : ROW_PX, footer ? FOOTER_PX : 0),
  );

  return (
    <>
      <WidgetRowList fit={fit} label="Price movers">
        {shown.map((mover) => (
          <MoverRow
            key={`${mover.cardId}:${mover.finish}`}
            mover={mover}
            currency={currency}
            bare={bare}
            tile={fit.tier === 0}
          />
        ))}
      </WidgetRowList>
      {footer && (
        <WidgetFooter>
          Against {windowPhrase(range)} of {marketplace.label} prices.
        </WidgetFooter>
      )}
    </>
  );
}

/** One mover: the glyph that says which way, the name, where it is from, and the move. */
function MoverRow({
  mover,
  currency,
  bare,
  tile,
}: {
  mover: PriceMover;
  currency: Currency;
  bare: boolean;
  tile: boolean;
}): ReactElement {
  const up = mover.delta > 0;
  const Glyph = up ? TrendingUp : TrendingDown;
  const money = signedMoney(mover.delta, currency);
  const caption = `${mover.setCode.toUpperCase()} · ${FINISH_LABEL[mover.finish].toLowerCase()}`;
  const common = {
    name: mover.name,
    icon: <Glyph aria-hidden="true" className="size-3.5" />,
    iconColor: up ? UP_FILL : DOWN_FILL,
    // Both ends of the move, for a pointer — the row itself only has room for the difference.
    hint: `${formatPrice(mover.then, currency)} then, ${formatPrice(mover.now, currency)} now`,
  };
  // At two cells the move goes under the name, `WidgetRow`'s rule for a tile.
  return tile ? (
    <WidgetRow {...common} caption={money} captionStrong />
  ) : (
    <WidgetRow
      {...common}
      caption={bare ? undefined : caption}
      value={money}
      delta={up ? "up" : "down"}
    />
  );
}
