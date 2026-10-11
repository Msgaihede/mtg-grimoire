import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Dropdown } from "@grimoire/ui/components/Dropdown/Dropdown";
import {
  newTradeMarketplace,
  nextTradeName,
  tradeMarketplaceOffers,
} from "@grimoire/ui/features/trade/tradeWords";
import { useTradeList, useTradeWrites } from "@grimoire/ui/features/trade/useTrades";
import { ipcError } from "@grimoire/ui/lib/ipc";
import { isMarketplaceId, type MarketplaceId } from "@grimoire/ui/lib/marketplace";
import { PRESS_STILL } from "@grimoire/ui/lib/motion";
import { useMarketplace } from "@grimoire/ui/lib/useMarketplace";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet } from "../deck/sheet";
import { GOLD_BUTTON, PLAIN_BUTTON, Refusal } from "./parts";

/**
 * A new trade: what to call it, and whose prices it uses.
 *
 * **Both are optional, and neither is asked again.** A name left empty is `Trade N` — the trade's
 * own number, which only the backend knows: the box's placeholder is the likeliest one
 * (`nextTradeName`) and the sentence under it promises no number at all. The marketplace opens on
 * the one the reader is quoting everywhere else and is the trade's for good: every price in it,
 * after any later switch in Settings, is that shop's, in its currency.
 *
 * **Two of the four are offered only while the app itself is set to them** — Card Kingdom and
 * Mana Pool, whose prices are downloads kept fresh for the selected marketplace alone
 * (`tradeMarketplaceOffers`). The other stays in the picker, greyed, and **why is said in words
 * under it**: a finger opens no tooltip, and a row that refuses in silence teaches nothing.
 *
 * **It opens empty.** Cards go on from the trade's own page, which is where the press that made
 * it lands — `onCreated` is handed the new trade's id for exactly that.
 *
 * The sheet's fields live here rather than in its body because the footer's two presses read them,
 * and the footer is outside the body's scroller; every way out clears them, so the next trade does
 * not open on the last one's name.
 */
export function NewTradeSheet({
  open,
  onClose,
  onDismiss,
  onCreated,
}: {
  open: boolean;
  /** A press on the scrim. */
  onClose: () => void;
  /** Escape, the ✕ and Cancel: closed, and the caret handed back to `New trade`. */
  onDismiss: () => void;
  onCreated: (tradeId: number) => void;
}) {
  const writes = useTradeWrites();
  const { marketplace } = useMarketplace();
  // The list the page behind this sheet is drawing — the same cache entry, so no second read.
  const trades = useTradeList().data ?? [];
  const id = useId();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<MarketplaceId | null>(null);
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The reader's own marketplace until they pick another — and the default where theirs is one
  // this app cannot price, which no trade could be opened in.
  const source = picked ?? newTradeMarketplace(marketplace);
  const offers = tradeMarketplaceOffers(marketplace);
  const refused = offers.filter((offer) => offer.reason !== null);

  const clear = () => {
    setName("");
    setPicked(null);
    setRefusal(null);
  };
  const create = () => {
    if (creating) return;
    setCreating(true);
    setRefusal(null);
    const typed = name.trim();
    writes
      .create({ marketplace: source, ...(typed === "" ? {} : { name: typed }) })
      .then((tradeId) => {
        clear();
        onCreated(tradeId);
      })
      .catch((error: unknown) => setRefusal(ipcError(error)))
      .finally(() => setCreating(false));
  };

  return (
    <ActionSheet
      open={open}
      title="New trade"
      subtitle="It opens empty. Cards go on once it is open."
      closeLabel="Close new trade"
      onClose={() => {
        clear();
        onClose();
      }}
      onDismiss={() => {
        clear();
        onDismiss();
      }}
      footer={
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 pt-3 pb-4">
          <Refusal>{refusal}</Refusal>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => {
                clear();
                onDismiss();
              }}
              className={cn(PLAIN_BUTTON, "flex-1")}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-disabled={creating || undefined}
              aria-busy={creating || undefined}
              onClick={create}
              className={cn(GOLD_BUTTON, "flex-1")}
            >
              <Check aria-hidden className="size-4 shrink-0" />
              Create trade
            </button>
          </div>
        </div>
      }
    >
      <form
        className="flex flex-col gap-[1.125rem] p-4"
        onSubmit={(event) => {
          // Enter in the name box is the gold press, not a document load.
          event.preventDefault();
          create();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
            Name
          </label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={nextTradeName(trades)}
            aria-describedby={`${id}-name-note`}
            autoComplete="off"
            // 16px: below it a phone zooms the page when the box takes the caret.
            className={cn(
              "h-11 w-full min-w-0 rounded-md border border-border bg-bg px-3 text-base text-text",
              "select-text focus:border-accent focus:outline-none",
              PRESS_STILL,
            )}
          />
          <span id={`${id}-name-note`} className="text-xs text-dim">
            Optional. Left empty, the trade is named by its number.
          </span>
        </div>

        {/* The picker is the desktop's own, floored for a thumb from outside it — the search
            sheet's arrangement: its trigger and its rows are 36px there. */}
        <div className="flex flex-col gap-1.5 [&_button]:min-h-11">
          <span id={`${id}-source`} className="text-[0.8125rem] text-dim">
            Prices from
          </span>
          <Dropdown
            labelledBy={`${id}-source`}
            value={source}
            onChange={(value) => {
              if (isMarketplaceId(value)) setPicked(value);
            }}
            options={offers.map(({ marketplace: offered, reason }) => ({
              value: offered.id,
              label: offered.label,
              hint: offered.currency.toUpperCase(),
              // Greyed and refused by the picker — and never given a `title`, which is a tooltip.
              disabled: reason !== null,
            }))}
            fill
          />
          {refused.length > 0 && (
            <ul aria-label="Not offered" className="flex flex-col gap-0.5">
              {refused.map(({ marketplace: offered, reason }) => (
                <li key={offered.id} className="text-xs leading-snug text-dim">
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </ActionSheet>
  );
}
