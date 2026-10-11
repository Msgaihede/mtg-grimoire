import { useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heart, Trash2, TriangleAlert } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { CabinetFiling } from "@/components/icons";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cardPrintingsKey } from "@/features/card/cardKeys";
import { FINISH_LABEL, isFinish, parseFinishes, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError } from "@/lib/ipc";
import type { Printing, Trade, TradeLine, TradeLineChange } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { RATE_DEFAULT, fromCents, isOpen, lineMoney, rateOf } from "./trade";
import { FIGURE, REFUSAL, TRADE_BARE_BUTTON } from "./tradeControls";
import { givenMark, printingLabel, printingLine, tradeCurrency } from "./tradeWords";
import { useTradeWrites } from "./useTrades";

/**
 * One line of a trade: a card, what it is worth on this side, and — while the trade is open — the
 * four things that can change about it.
 *
 * ## The figures
 *
 * The right-hand column is the line at the side's percentage, with `2 × $3.25` under it so the
 * total can be checked against the card. When the side is not at 100% a third row says what the
 * line would be at full price, dimmed — the design's rule that a percentage never *replaces* a
 * figure, only stands beside it. A line with no price draws an em dash in both rows and no third:
 * there is nothing for a percentage to have changed.
 *
 * ## The two gold marks, and the red one
 *
 * *from your collection* is where the line came from (`source`), and it is on the reader's own
 * side only: it is the promise that a finish can take the card back out. *on your wishlist* is
 * the other side's — a card they are giving that the reader has been wanting — and it reads
 * `wished`, the live count, rather than anything recorded when the line was added.
 *
 * **A line that would reach into a deck wears neither gold nor those words.** While the trade is
 * open and the line asks for more copies than the collection holds outside the reader's decks,
 * the mark is `1 from your deck Serah`, in the destructive colour, on a row of its own
 * (`givenMark`, the phone's wording too). It is read from the line's live facts, so it appears on
 * the press that steps the quantity past `owned` and goes on the press that steps it back.
 *
 * ## The controls
 *
 * **Every one of them writes at once** through {@link useTradeWrites}; there is no Save. Quantity
 * and finish are patched into the cache before the answer, so the total moves under the press. A
 * printing is not — it brings a new name for the set, a new rarity and new prices, which only the
 * backend has — so that one waits for its read.
 *
 * **A refusal is drawn on the line that earned it.** A finish the new printing does not come in, a
 * trade archived in another window: the backend says which in a sentence, and the sentence goes
 * under the controls rather than into a toast three panels away.
 *
 * **The art opens every printing** (issue #902) while the trade is open: the app's printings wall,
 * asked to rewrite this line rather than to open a card. A line the reader's own collection
 * supplies is shown only the printings they hold — the copies outside every deck, then the decks'
 * own in red, split as the add field splits them — and a press there takes that copy's finish as
 * well, since a copy is one printing in one finish. Any other line is shown every printing, and the
 * finish follows the backend's rule for a printing change. The dropdown beside it stays for the
 * reader who knows the set code they are after.
 *
 * **Closed, it is the same card with the controls gone**: the printing and finish become one line
 * of text, because a `Dropdown` that cannot be opened is a control that lies about being one.
 */
export function TradeLineCard({ trade, line }: { trade: Trade; line: TradeLine }): JSX.Element {
  const tip = useTooltip();
  const writes = useTradeWrites();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const [failure, setFailure] = useState<string | null>(null);

  const currency = tradeCurrency(trade);
  const rate = rateOf(trade, line.side);
  const money = lineMoney(line, rate);
  const editable = isOpen(trade.status);
  const mark = givenMark(line, editable);
  const price = (cents: number | null) => formatPrice(fromCents(cents), currency);

  const change = (what: string, next: TradeLineChange) => {
    setFailure(null);
    writes.updateLine(trade.id, line.id, next).catch((e: unknown) => {
      setFailure(`Couldn't change the ${what} — ${ipcError(e)}`);
    });
  };

  /**
   * The printings wall, on this line. Only the parts of a change that *are* changes are sent, so a
   * press on another finish of the same printing is the finish write — patched into the cache at
   * once — rather than a printing write that waits for its read.
   */
  const oracleId = line.oracleId;
  const openPrintings =
    editable && oracleId !== null
      ? () =>
          openAllPrintings({
            cardId: line.cardId,
            oracleId,
            name: line.name,
            deck: null,
            wish: null,
            trade: {
              owned: line.side === "mine" && line.source === "collection",
              marketplace: trade.marketplace,
              finish: line.finish,
              choose: (cardId, finish) => {
                setFailure(null);
                const next: TradeLineChange = {};
                if (cardId !== line.cardId) next.cardId = cardId;
                if (finish !== null && finish !== line.finish) next.finish = finish;
                return writes.updateLine(trade.id, line.id, next);
              },
            },
          })
      : null;

  const remove = () => {
    setFailure(null);
    writes.removeLine(trade.id, line.id).catch((e: unknown) => {
      setFailure(`Couldn't remove it — ${ipcError(e)}`);
    });
  };

  return (
    <li
      className={cn(
        "relative mx-2 mb-2 grid grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2",
        "rounded-lg border border-border bg-bg p-2.5",
      )}
    >
      {/* The picture itself is decorative: the name is the next thing in the row, and a 56px
          picture announced by the same words would say every card twice. The finish is passed so a
          foil wears its sheen — a line *is* a finish, which is `CardArt`'s own rule for when to
          draw one. While the trade is open it is wrapped in the button that opens every printing,
          and the button's label is what is announced. */}
      {openPrintings ? (
        <button
          type="button"
          aria-label={`Change the printing of ${line.name}`}
          onClick={openPrintings}
          className={cn("row-span-2 w-14 self-start rounded-[3px]", PRESS, FOCUS)}
          {...tip("All printings", { describes: false })}
        >
          <CardArt
            cardId={line.cardId}
            name=""
            variant="thumb"
            finish={line.finish}
            className="w-14 rounded-[3px]"
          />
        </button>
      ) : (
        <CardArt
          cardId={line.cardId}
          name=""
          variant="thumb"
          finish={line.finish}
          className={cn("w-14 self-start rounded-[3px]", editable && "row-span-2")}
        />
      )}

      <div className="flex min-w-0 flex-col gap-0.5">
        <div
          className="truncate text-sm font-medium"
          {...tip(line.name, { whenClipped: true, describes: false })}
        >
          {line.name}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-dim">
          <RarityGem rarity={line.rarity} />
          <span className="min-w-0 truncate">{line.setName ?? line.setCode.toUpperCase()}</span>
          {mark?.place === "collection" && (
            <span className="inline-flex shrink-0 items-center gap-1 text-accent">
              <CabinetFiling className="size-3" aria-hidden="true" />
              {mark.words}
            </span>
          )}
          {line.side === "theirs" && line.wished > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 text-accent">
              <Heart className="size-3" aria-hidden="true" />
              on your wishlist
            </span>
          )}
        </div>
        {mark?.place === "deck" && (
          // A row of its own, so it wraps: two deck names are longer than the set line has room
          // for, and this is the one mark that must never be cut short.
          <div
            data-mark="deck"
            className="flex items-start gap-1 text-xs leading-snug text-destructive"
          >
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{mark.words}</span>
          </div>
        )}
        {!editable && (
          <div className={cn(FIGURE, "mt-0.5 text-xs text-dim")}>
            {printingLine(line.setCode, line.collectorNumber, line.finish)}
          </div>
        )}
      </div>

      <div className={cn(FIGURE, "flex flex-col items-end gap-0.5")}>
        <div className="text-sm font-semibold" data-figure="total">
          {price(money.total)}
        </div>
        <div className="text-xs text-dim">
          {line.quantity} × {price(money.unit)}
        </div>
        {rate !== RATE_DEFAULT && money.fullTotal !== null && (
          <div className="text-xs text-dim">{price(money.fullTotal)} at 100%</div>
        )}
      </div>

      {editable && (
        <div className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <PrintingPicker
            trade={trade}
            line={line}
            currency={currency}
            onPick={(cardId) => change("printing", { cardId })}
          />
          <Dropdown
            label={`Finish of ${line.name}`}
            size="sm"
            value={line.finish}
            options={finishOptions(line, currency)}
            onChange={(finish) => {
              if (isFinish(finish) && finish !== line.finish) change("finish", { finish });
            }}
          />
          <QuantityStepper
            label={`Quantity of ${line.name}`}
            size="sm"
            min={1}
            value={line.quantity}
            onChange={(quantity) => {
              if (quantity !== line.quantity) change("quantity", { quantity });
            }}
          />
          <button
            type="button"
            aria-label={`Remove ${line.name} from the trade`}
            onClick={remove}
            className={cn(TRADE_BARE_BUTTON, "ml-auto")}
            {...tip("Remove", { describes: false })}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {failure !== null && (
        <p role="alert" className={cn(REFUSAL, "col-span-2 col-start-2")}>
          {failure}
        </p>
      )}
    </li>
  );
}

/**
 * The finishes this printing comes in, each with today's price as its hint.
 *
 * `finishPrices` and not `unitPrice`: the hint is what the line *would* cost in that finish, and
 * it is live even on a line whose own price is not. A printing whose finishes are unknown still
 * offers the one the line is in, so the control never draws an empty list over a real card.
 */
function finishOptions(line: TradeLine, currency: Currency): DropdownOption[] {
  const listed = parseFinishes(line.finishes);
  const finishes: Finish[] = listed.includes(line.finish) ? listed : [line.finish, ...listed];
  return finishes.map((finish) => ({
    value: finish,
    label: FINISH_LABEL[finish],
    hint: formatPrice(line.finishPrices[finish], currency),
  }));
}

/**
 * Which printing a line is, and every other printing it could be.
 *
 * **The list is read when the control is opened, not when the line is drawn.** A trade of twenty
 * cards would otherwise ask for twenty lists of printings to draw twenty closed buttons, and a
 * much-reprinted card's list is hundreds of rows. Until it answers, the one row the control has is
 * the line's own, which is all a closed trigger ever shows.
 *
 * **Keyed as the card modal keys it** ({@link cardPrintingsKey}) and asked with no `limit`, which
 * that key's own comment requires: the modal's printings row and this control are then one cache
 * entry, and a reader who has just looked at a card's printings opens this list for nothing.
 *
 * **A row is `MH2 · 138` with the set's name and a price as its hint.** The design draws a richer
 * row — a picture, the rarity, a tick — and `Dropdown` deliberately has no render prop to draw one
 * with; see `Dropdown/types.ts` for why. What survives is the part a reader chooses by: which set,
 * which number, what it costs. The price is the one the line would take on, which is this finish
 * where the printing has it and otherwise the first one it does have, named.
 */
function PrintingPicker({
  trade,
  line,
  currency,
  onPick,
}: {
  trade: Trade;
  line: TradeLine;
  currency: Currency;
  onPick: (cardId: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const printings = useQuery({
    queryKey: cardPrintingsKey(line.oracleId, trade.marketplace),
    queryFn: () => ipc.cardPrintings(line.oracleId ?? "", trade.marketplace),
    enabled: opened && line.oracleId !== null,
  });

  const options = useMemo(() => {
    const own: DropdownOption = {
      value: line.cardId,
      label: printingLabel(line.setCode, line.collectorNumber),
      hint: line.setName ?? undefined,
    };
    const items = printings.data?.items;
    if (!items) return [own];
    const rows = items.map((printing) => printingOption(printing, line.finish, currency));
    // The list is capped at the backend's ceiling, so a card with more printings than that can
    // have the line's own cut off the end — and a control whose value is not among its options
    // draws a dash where the printing should be.
    return rows.some((row) => row.value === line.cardId) ? rows : [own, ...rows];
  }, [printings.data, line, currency]);

  return (
    <Dropdown
      label={`Printing of ${line.name}`}
      size="sm"
      value={line.cardId}
      options={options}
      // A search box once the list is long enough to need one. It matches the row's own text,
      // so a reader types the set code they are after.
      searchable={options.length > 10}
      searchPlaceholder="Set code"
      searchLabel="Search printings"
      emptyLine={printings.isError ? "Couldn't read the printings." : "No printing matches."}
      onOpen={() => setOpened(true)}
      onChange={(cardId) => {
        if (cardId !== line.cardId) onPick(cardId);
      }}
    />
  );
}

function printingOption(printing: Printing, held: Finish, currency: Currency): DropdownOption {
  const finishes = parseFinishes(printing.finishes);
  // The backend's own rule for a printing change, said before the press: the finish is kept
  // where the new printing has it, and otherwise the first one it lists is taken.
  const keeps = finishes.length === 0 || finishes.includes(held);
  const finish = keeps ? held : finishes[0];
  const cost = formatPrice(printing.finishPrices[finish], currency);
  const note = keeps ? cost : `${FINISH_LABEL[finish]} only, ${cost}`;
  return {
    value: printing.id,
    label: printingLabel(printing.setCode, printing.collectorNumber),
    hint: printing.setName === null ? note : `${printing.setName} · ${note}`,
  };
}
