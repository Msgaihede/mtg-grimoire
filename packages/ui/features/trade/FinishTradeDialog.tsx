import { useId, useMemo, useState, type JSX, type ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, flattenFolders } from "@/lib/folderTree";
import { ipcError } from "@/lib/ipc";
import type { CollectionFolder, Trade, TradeFinishOptions } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { notify } from "@/lib/notifications";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import {
  cardCount,
  deckNote,
  defaultFinishOptions,
  fromCents,
  givenNote,
  outcomeSentence,
  receivedNote,
  tradeMoney,
  unwishNote,
  type SideMoney,
} from "./trade";
import { BalanceFigure } from "./TradeBalance";
import { FIGURE, REFUSAL, TRADE_BUTTON, TRADE_BUTTON_ACCENT } from "./tradeControls";
import { fullPriceNote, tradeCurrency, tradeDay, unpricedNote } from "./tradeWords";
import { useTradeWrites } from "./useTrades";

/** The folder picker's word for the collection's root — the Scanner's tray says the same. */
const ROOT_LABEL = "Collection";
/** The root's value in the picker. A `Dropdown` speaks strings, and no folder id is this one. */
const ROOT_VALUE = "root";

/**
 * The four things a finished trade can do to the collection and the wishlist, asked before any
 * of them is done.
 *
 * ## It says what each step will actually move
 *
 * A checkbox reading *Take the cards you gave out of your collection* is a promise about six
 * cards, and the collection may hold four of them. So each question carries a sentence under it,
 * computed from the same facts the backend will act on (`owned`, `wished`): how many it can take,
 * which of the received cards are on the wishlist by name. The sentences are `trade.ts`'s — this
 * file draws them and decides nothing.
 *
 * **And what it will take out of a deck, in red.** Where the given cards outnumber the copies the
 * reader holds outside their decks, the first question carries a second sentence under its note:
 * how many come out of decks, and which (`deckNote`). It is the first question in the dialog, so
 * the warning is on screen as the dialog opens, above anything that could scroll it away.
 *
 * ## It opens on the answers most trades want, with one exception
 *
 * Three on, one off ({@link defaultFinishOptions}). **A trade that was finished once and reopened
 * opens with all four off** and a sentence saying why: the first finish already moved those cards
 * and nothing on the trade says which, so a second pass on the defaults would take the given
 * cards out of the collection twice.
 *
 * ## The footnote is the reassurance
 *
 * Finishing reads as final, and it is not: the trade is archived with the prices and both
 * percentages it closed at, and can be reopened. The footer says so beside the button, because
 * that is where the hesitation is.
 */
export function FinishTradeDialog({
  open,
  trade,
  onFinished,
  onDismiss,
  onClose,
}: {
  open: boolean;
  trade: Trade;
  /**
   * The finish went through. **Not `onDismiss`**, and the difference is the caret: Escape hands
   * it back to the button that opened this, and after a finish that button is about to leave the
   * page — the trade is read-only the moment its read lands — so the page puts the caret
   * somewhere that will still be there.
   */
  onFinished: () => void;
  onDismiss: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Finish trade"
      subtitle={`${trade.name} · opened ${tradeDay(trade.createdAt, true)}`}
      // Not `Cancel` — see `NewTradeDialog`: the footer has a button of that name.
      closeLabel="Close"
      size="w-[37.5rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body trade={trade} onFinished={onFinished} onDismiss={onDismiss} />
    </Dialog>
  );
}

/** Mounted only while open, so the four answers start from the defaults on every opening. */
function Body({
  trade,
  onFinished,
  onDismiss,
}: {
  trade: Trade;
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const writes = useTradeWrites();
  const [options, setOptions] = useState<TradeFinishOptions>(() => defaultFinishOptions(trade));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { folders } = useCollectionFolderList();
  const folderOptions = useMemo(() => folderRows(folders), [folders]);

  const currency = tradeCurrency(trade);
  const money = tradeMoney(trade);
  const set = (change: Partial<TradeFinishOptions>) => setOptions((now) => ({ ...now, ...change }));

  const finish = () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    writes
      .finish(trade.id, options)
      .then((outcome) => {
        // The one trade write that reaches the collection and the wishlist, so the owner's rule
        // for those lists applies: a toast saying what moved, once for the whole finish however
        // many cards it took — `outcomeSentence`'s words, the archived banner's own. The dialog
        // closes on it, and what moved is on two pages the reader is not looking at.
        notify.success(`Finished “${trade.name}”`, {
          body:
            outcomeSentence(outcome) ??
            "Finishing it changed nothing in your collection or your wishlist.",
        });
        onFinished();
      })
      .catch((e: unknown) => {
        // Said in the footer, where the retry is, and as a toast for the rule's record of a
        // refused collection write. The write is one transaction: nothing moved.
        notify.error(`Couldn't finish “${trade.name}”`, { body: ipcError(e) });
        setFailure(`Couldn't finish the trade — ${ipcError(e)}`);
        setBusy(false);
      });
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3",
            "rounded-lg border border-border bg-bg px-4 py-3",
          )}
        >
          <SummarySide label="You give" money={money.mine} currency={currency} align="start" />
          <div className="flex flex-col items-center text-center">
            <BalanceFigure
              balance={money.balance}
              past={false}
              currency={currency}
              size="summary"
            />
          </div>
          <SummarySide label="They give" money={money.theirs} currency={currency} align="end" />
        </div>

        {trade.finishedBefore && (
          <p className="text-[0.8125rem] leading-snug text-dim">
            This trade was finished once before, so every step below starts off: that finish already
            moved its cards, and a second pass would move them twice.
          </p>
        )}

        <fieldset className="flex flex-col">
          <legend className="pt-1 pb-2 text-xs text-dim">Your collection</legend>
          <Question
            id={`${id}-remove`}
            checked={options.removeGiven}
            onChange={(removeGiven) => set({ removeGiven })}
            title="Take the cards you gave out of your collection"
            note={givenNote(trade.lines)}
            warning={deckNote(trade.lines)}
          />
          <Question
            id={`${id}-add`}
            checked={options.addReceived}
            onChange={(addReceived) => set({ addReceived })}
            title="Add the cards you received to your collection"
            note={receivedNote(trade.lines)}
          >
            <span className="mt-1.5 flex items-center gap-2 text-[0.8125rem] text-dim">
              File under
              <Dropdown
                label="Folder for the cards you received"
                size="sm"
                // A folder for cards that are not being added is a question about nothing.
                disabled={!options.addReceived}
                value={options.folderId === null ? ROOT_VALUE : String(options.folderId)}
                options={folderOptions}
                onChange={(value) => set({ folderId: value === ROOT_VALUE ? null : Number(value) })}
              />
            </span>
          </Question>
        </fieldset>

        <fieldset className="flex flex-col">
          <legend className="pt-1 pb-2 text-xs text-dim">Your wishlist</legend>
          <Question
            id={`${id}-unwish`}
            checked={options.unwishReceived}
            onChange={(unwishReceived) => set({ unwishReceived })}
            title="Take the cards you received off your wishlist"
            note={unwishNote(trade.lines)}
          />
          <Question
            id={`${id}-wish`}
            checked={options.wishGiven}
            onChange={(wishGiven) => set({ wishGiven })}
            title="Put the cards you gave on your wishlist"
            note="For the ones you want back one day."
          />
        </fieldset>
      </div>

      <footer className="flex items-center gap-3 border-t border-border px-5 py-3.5">
        {failure !== null ? (
          <p role="alert" className={cn(REFUSAL, "min-w-0 flex-1")}>
            {failure}
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-xs leading-snug text-dim">
            Finishing files the trade in the archive with today's prices and both percentages. You
            can reopen it later.
          </p>
        )}
        <button type="button" onClick={onDismiss} className={TRADE_BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          aria-disabled={busy || undefined}
          onClick={finish}
          className={TRADE_BUTTON_ACCENT}
        >
          <Check className="size-4" aria-hidden="true" />
          Finish trade
        </button>
      </footer>
    </>
  );
}

/**
 * The reader's own folders, as the picker's rows, under the root.
 *
 * **Only `user` folders.** A deck's group is filed by the deck, and *Recently removed* is where
 * cards go on their way out; neither is a place a reader files a card they have just been
 * handed. A folder inside another reads as its path — `Binders / Trade binder` — because a
 * `Dropdown` row is one line of text and two binders in two drawers can share a name.
 */
function folderRows(folders: readonly CollectionFolder[]): DropdownOption[] {
  const mine = folders.filter((folder) => folder.kind === "user");
  const path = new Map<number, string>();
  const rows: DropdownOption[] = [{ value: ROOT_VALUE, label: ROOT_LABEL }];
  // Depth-first, so a parent's path is always written before its children ask for it.
  for (const { folder } of flattenFolders(buildFolderTree(mine, []))) {
    const parent = folder.parentId === null ? undefined : path.get(folder.parentId);
    const label = parent === undefined ? folder.name : `${parent} / ${folder.name}`;
    path.set(folder.id, label);
    rows.push({ value: String(folder.id), label });
  }
  return rows;
}

/**
 * One side of the summary a finish is confirmed against.
 *
 * **It says everything the balance panel's total says** — the full figure beside a rated one, and
 * how many lines have no price and so are in neither. This is the last figure the reader sees
 * before the trade is closed with it; it cannot be the one place that leaves a card out quietly.
 */
function SummarySide({
  label,
  money,
  currency,
  align,
}: {
  label: string;
  money: SideMoney;
  currency: Currency;
  align: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5",
        align === "start" ? "items-start" : "items-end",
      )}
    >
      <span className="text-xs text-dim">{label}</span>
      <span className={cn(FIGURE, "text-lg font-semibold")}>
        {formatPrice(fromCents(money.total), currency)}
      </span>
      {money.rated && (
        <span className={cn(FIGURE, "text-xs text-dim")}>
          {fullPriceNote(formatPrice(fromCents(money.fullTotal), currency))}
        </span>
      )}
      <span className="text-xs text-dim">{cardCount(money.copies)}</span>
      {money.unpriced > 0 && (
        <span className="text-xs text-dim">{unpricedNote(money.unpriced)}</span>
      )}
    </div>
  );
}

/**
 * One checkbox, what it does, and what it will do *here*.
 *
 * **The label is the title alone.** The design wraps the whole row in one, and the folder picker
 * sits in that row: a press on the picker would then also be a press on the label, and choosing
 * a folder would untick the box it belongs to. So the title is the label, and the sentence under
 * it describes the box (`aria-describedby`) without being part of the press.
 *
 * **`warning` is what the step costs that the trade never mentioned** — today, the cards it takes
 * out of a deck (`deckNote`). It sits directly under the note, in the destructive colour and with
 * a mark that is not a colour, and it is part of the box's description: the reader ticks the box
 * against it, so it is read with the box and is on screen wherever the box is.
 */
function Question({
  id,
  checked,
  onChange,
  title,
  note,
  warning = null,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  note: string;
  warning?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 border-t border-border py-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-describedby={warning === null ? `${id}-note` : `${id}-note ${id}-warning`}
        onChange={(e) => onChange(e.target.checked)}
        className={cn("mt-0.5 size-[1.125rem] accent-accent", FOCUS)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          {title}
        </label>
        <span id={`${id}-note`} className="text-[0.8125rem] leading-snug text-dim">
          {note}
        </span>
        {warning !== null && (
          <span className="flex items-start gap-1.5 text-[0.8125rem] leading-snug font-medium text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span id={`${id}-warning`} className="min-w-0">
              {warning}
            </span>
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
