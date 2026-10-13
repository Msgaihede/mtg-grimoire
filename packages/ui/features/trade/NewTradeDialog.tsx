import { useEffect, useId, useRef, useState, type JSX } from "react";
import { Plus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { FIELD } from "@/features/decks/formFields";
import { ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { isMarketplaceId, type MarketplaceId } from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { REFUSAL, TRADE_BUTTON, TRADE_BUTTON_ACCENT } from "./tradeControls";
import { newTradeMarketplace, tradeMarketplaceOffers } from "./tradeWords";
import { useTradeWrites } from "./useTrades";

/**
 * The two questions a new trade asks, and both have an answer already.
 *
 * **A name**, which is optional because most trades do not need one: left empty the backend calls
 * the trade after its own number, and the placeholder shows what that will most likely be.
 *
 * **Whose prices**, which is the one thing about a trade that cannot be changed afterwards: every
 * figure on both sides is that marketplace's, in its currency, and two people agreeing a balance
 * have to be reading the same numbers. It opens on the marketplace the reader
 * has the app set to, because that is the one whose prices they have been looking at all day; a
 * reader on a marketplace with no prices (`Card trader`) gets the app's default instead, since a
 * trade whose every line is an em dash is not one anybody meant to open.
 *
 * **And for that same reason two of the four are not always on offer** (`tradeMarketplaceOffers`):
 * Card Kingdom's and Mana Pool's prices are downloads the app keeps fresh only for the one it is
 * set to, so the other stays in the list, greyed, with the way to reach it as its tooltip.
 *
 * It opens **empty** and says so. Cards go on from the page, where both sides and the balance are
 * in view — a dialog that also took cards would be the page again, smaller.
 */
export function NewTradeDialog({
  open,
  placeholder,
  onCreated,
  onDismiss,
  onClose,
}: {
  open: boolean;
  /** The name the trade will most likely get if none is typed — `Trade 6`. */
  placeholder: string;
  /** The new trade exists. The page selects it. */
  onCreated: (id: number) => void;
  onDismiss: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title="New trade"
      subtitle="It opens empty. Cards go on once it is open."
      // Not `Cancel`: the footer has a button of that name, and two controls answering to one
      // name on one panel is a control nobody can address.
      closeLabel="Close"
      size="w-[30rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body placeholder={placeholder} onCreated={onCreated} onDismiss={onDismiss} />
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so the draft is a session and nothing has to reset it. */
function Body({
  placeholder,
  onCreated,
  onDismiss,
}: {
  placeholder: string;
  onCreated: (id: number) => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const writes = useTradeWrites();
  const { marketplace: current } = useMarketplace();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  /** `null` until the reader picks: the app's own marketplace, whenever that read lands. */
  const [picked, setPicked] = useState<MarketplaceId | null>(null);
  const marketplace = picked ?? newTradeMarketplace(current);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The name is the first question and the only one that takes typing, so the caret starts in
  // it. `Dialog` stands down when a body has already placed the caret — `ConfirmDialog` takes
  // the same carve-out for the same reason.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const create = () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const trimmed = name.trim();
    writes
      // A blank name is left out rather than sent empty: absent is "name it for me".
      .create({ ...(trimmed ? { name: trimmed } : {}), marketplace })
      .then((id) => {
        // A receipt for a dialog that writes and closes. A name left blank is the backend's to
        // choose, and this does not have it, so that receipt names no trade.
        notify.success(trimmed ? `Trade “${trimmed}” created` : "Trade created");
        onCreated(id);
      })
      .catch((e: unknown) => {
        setFailure(`Couldn't create the trade — ${ipcError(e)}`);
        setBusy(false);
      });
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-[1.125rem] overflow-y-auto px-5 py-[1.125rem]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
            Name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            type="text"
            value={name}
            placeholder={placeholder}
            aria-describedby={`${id}-name-hint`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            autoComplete="off"
            className={cn(FIELD, "h-9 px-3")}
          />
          <span id={`${id}-name-hint`} className="text-xs text-dim">
            Optional. Left empty, the trade is named by its number.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span id={`${id}-prices`} className="text-[0.8125rem] text-dim">
            Prices from
          </span>
          <Dropdown
            labelledBy={`${id}-prices`}
            fill
            value={marketplace}
            options={tradeMarketplaceOffers(current).map(({ marketplace: m, reason }) => ({
              value: m.id,
              label: m.label,
              hint: m.currency.toUpperCase(),
              disabled: reason !== null,
              title: reason ?? undefined,
            }))}
            onChange={(value) => {
              if (isMarketplaceId(value)) setPicked(value);
            }}
          />
        </div>
      </div>

      <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3.5">
        {failure !== null && (
          <p role="alert" className={cn(REFUSAL, "min-w-0 flex-1")}>
            {failure}
          </p>
        )}
        <button type="button" onClick={onDismiss} className={TRADE_BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          aria-disabled={busy || undefined}
          onClick={create}
          className={TRADE_BUTTON_ACCENT}
        >
          <Plus className="size-4" aria-hidden="true" />
          Create trade
        </button>
      </footer>
    </>
  );
}
