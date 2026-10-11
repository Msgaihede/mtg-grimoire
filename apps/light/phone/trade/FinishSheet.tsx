import { useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Folder, TriangleAlert } from "lucide-react";
import { useCollectionFolderList } from "@grimoire/ui/features/collection/useCollectionFolders";
import {
  cardCount,
  deckNote,
  defaultFinishOptions,
  givenNote,
  receivedNote,
  tradeMoney,
  unwishNote,
  type SideMoney,
} from "@grimoire/ui/features/trade/trade";
import { fullPriceNote, tradeDay, unpricedNote } from "@grimoire/ui/features/trade/tradeWords";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { buildFolderTree, flattenFolders } from "@grimoire/ui/lib/folderTree";
import type { Trade, TradeFinishOptions } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet, SheetBack, SheetChoice } from "../deck/sheet";
import { BalanceFigure, GOLD_BUTTON, PLAIN_BUTTON, Refusal } from "./parts";
import { money } from "./text";

/** The collection's own word for its top level — the scanner tray's, and `CopyActions`'. */
const ROOT_LABEL = "Collection";

type Page = "main" | "folder";

/**
 * Finish trade: what the trade comes to, and the four things finishing can do to the reader's
 * collection and wishlist — each a question, each answered before anything is written.
 *
 * - *Take the cards you gave out of your collection* — and the line under it says how many of
 *   them the collection actually holds, because only those are taken (`givenNote`). Where some of
 *   those would come out of a deck, a second line says how many and which decks, in the
 *   destructive colour (`deckNote`) — the first question, so it is in view as the sheet opens.
 * - *Add the cards you received to your collection* — into the root or one of the reader's own
 *   folders, picked on a page of this sheet as the scanner's tray picks its folder.
 * - *Take the cards you received off your wishlist* — naming the ones that are on it.
 * - *Put the cards you gave on your wishlist* — off unless the reader means it.
 *
 * **It opens on `defaultFinishOptions(trade)`**, which is three on and one off for a trade that
 * has never been finished and **all four off for one that has**: the first finish already moved
 * those cards, a reopen undoes none of it, and a second pass would move them twice. The sheet
 * says so, in a line above the questions, rather than leaving four empty boxes to be wondered at.
 *
 * The choices live here, not in the body, because the footer's `Finish trade` sends them and the
 * footer is outside the body's scroller. **They are forgotten on the render that closes the sheet,
 * however it closed** — a finish that went through closes it from outside, with no press on a way
 * out — so the next opening starts from the defaults of the trade as it is *then*: reopened after
 * that finish, all four off.
 *
 * **One transaction, and no undo.** The press is the trade's last write; the page behind draws
 * the finished trade and says what the finish did.
 */
export function FinishSheet({
  open,
  trade,
  currency,
  refusal,
  finishing,
  onFinish,
  onClose,
  onDismiss,
}: {
  open: boolean;
  trade: Trade;
  currency: Currency;
  refusal: string | null;
  /** The finish is in flight: the press greys and says it is busy. */
  finishing: boolean;
  onFinish: (options: TradeFinishOptions) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const [chosen, setChosen] = useState<TradeFinishOptions | null>(null);
  const [page, setPage] = useState<Page>("main");
  const options = chosen ?? defaultFinishOptions(trade);
  const set = (change: Partial<TradeFinishOptions>) => setChosen({ ...options, ...change });
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setChosen(null);
      setPage("main");
    }
  }

  const folderList = useCollectionFolderList();
  const mine = useMemo(
    () => folderList.folders.filter((folder) => folder.kind === "user"),
    [folderList.folders],
  );
  const nodes = useMemo(() => flattenFolders(buildFolderTree(mine, [])), [mine]);
  const folderName =
    options.folderId === null
      ? ROOT_LABEL
      : (mine.find((folder) => folder.id === options.folderId)?.name ?? ROOT_LABEL);

  return (
    <ActionSheet
      open={open}
      title="Finish trade"
      subtitle={`${trade.name} · opened ${tradeDay(trade.createdAt, true)}`}
      closeLabel="Close finish trade"
      onClose={onClose}
      onDismiss={onDismiss}
      footer={
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 pt-3 pb-4">
          <Refusal>{refusal}</Refusal>
          <div className="flex gap-2.5">
            <button type="button" onClick={onDismiss} className={cn(PLAIN_BUTTON, "flex-1")}>
              Cancel
            </button>
            <button
              type="button"
              aria-disabled={finishing || undefined}
              aria-busy={finishing || undefined}
              onClick={() => {
                if (!finishing) onFinish(options);
              }}
              className={cn(GOLD_BUTTON, "flex-1")}
            >
              <Check aria-hidden className="size-4 shrink-0" />
              Finish trade
            </button>
          </div>
        </div>
      }
    >
      {page === "folder" ? (
        <>
          <SheetBack label="File under" onBack={() => setPage("main")} />
          <ul aria-label="Folders">
            <SheetChoice
              label={ROOT_LABEL}
              current={options.folderId === null}
              onPick={() => {
                set({ folderId: null });
                setPage("main");
              }}
            />
            {nodes.map(({ folder, depth }) => (
              <SheetChoice
                key={folder.id}
                label={folder.name}
                current={folder.id === options.folderId}
                indent={depth}
                note={folder.locked ? "set aside" : undefined}
                onPick={() => {
                  set({ folderId: folder.id });
                  setPage("main");
                }}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-col gap-3.5 px-4 py-3.5">
          <Summary trade={trade} currency={currency} />

          {trade.finishedBefore && (
            <p className="text-[0.8125rem] leading-snug text-dim">
              This trade was finished once already, and reopening it undid none of that. Everything
              below is off so the same cards are not moved twice.
            </p>
          )}

          <Group caption="Your collection">
            <Question
              label="Take the cards you gave out of your collection"
              note={givenNote(trade.lines)}
              warning={deckNote(trade.lines)}
              checked={options.removeGiven}
              onChange={(removeGiven) => set({ removeGiven })}
            />
            <Question
              label="Add the cards you received to your collection"
              note={receivedNote(trade.lines)}
              checked={options.addReceived}
              onChange={(addReceived) => set({ addReceived })}
            >
              <button
                type="button"
                // Named outright: the caption, the folder and the chevron are three boxes a gap
                // apart.
                aria-label={`File under: ${folderName}`}
                aria-haspopup="true"
                // Greyed with the question it belongs to: a folder for cards that are not being
                // added is a choice about nothing.
                aria-disabled={!options.addReceived || undefined}
                onClick={() => {
                  if (options.addReceived) setPage("folder");
                }}
                className={cn(
                  "mt-1.5 inline-flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border px-3",
                  "text-[0.8125rem]",
                  PRESS,
                  "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:active:scale-100",
                  FOCUS,
                )}
              >
                <Folder aria-hidden className="size-4 shrink-0 text-dim" />
                <span className="shrink-0 text-dim">File under</span>
                <span className="min-w-0 flex-1 truncate text-right">{folderName}</span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
              </button>
            </Question>
          </Group>

          <Group caption="Your wishlist">
            <Question
              label="Take the cards you received off your wishlist"
              note={unwishNote(trade.lines)}
              checked={options.unwishReceived}
              onChange={(unwishReceived) => set({ unwishReceived })}
            />
            <Question
              label="Put the cards you gave on your wishlist"
              note="For the ones you want back one day."
              checked={options.wishGiven}
              onChange={(wishGiven) => set({ wishGiven })}
            />
          </Group>
        </div>
      )}
    </ActionSheet>
  );
}

/**
 * Both totals and the balance between them, as the page's footer states them — in a box.
 *
 * **Everything the footer says about a total, this says too**: the full figure under a side that
 * is not at 100%, and how many of its lines have no price and so are in neither figure. The
 * reader presses `Finish trade` against this box; it cannot be the one place that leaves a card
 * out without a word.
 */
function Summary({ trade, currency }: { trade: Trade; currency: Currency }) {
  const figures = tradeMoney(trade);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-bg p-3">
      <SummarySide heading="You give" money={figures.mine} currency={currency} end={false} />
      {/* Never the past tense here: the trade is still open while this sheet is. */}
      <BalanceFigure balance={figures.balance} past={false} currency={currency} size="box" />
      <SummarySide heading="They give" money={figures.theirs} currency={currency} end />
    </div>
  );
}

function SummarySide({
  heading,
  money: sideMoney,
  currency,
  end,
}: {
  heading: string;
  money: SideMoney;
  currency: Currency;
  /** Their side's, set against the far edge. */
  end: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", end && "items-end text-right")}>
      <span className="text-xs text-dim">{heading}</span>
      <span className="font-mono text-base font-semibold tabular-nums">
        {money(sideMoney.total, currency)}
      </span>
      {sideMoney.rated && (
        <span className="font-mono text-[0.6875rem] text-dim tabular-nums">
          {fullPriceNote(money(sideMoney.fullTotal, currency))}
        </span>
      )}
      <span className="text-xs text-dim">{cardCount(sideMoney.copies)}</span>
      {sideMoney.unpriced > 0 && (
        <span className="text-xs text-dim">{unpricedNote(sideMoney.unpriced)}</span>
      )}
    </div>
  );
}

function Group({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col">
      <legend className="pt-1 pb-2 text-xs text-dim">{caption}</legend>
      {children}
    </fieldset>
  );
}

/**
 * One question: a checkbox, what it does, and what it would do to *these* cards.
 *
 * The whole row is the label, so the press is the row's width and well over a thumb's height —
 * the box itself is 18px and nobody should have to hit it. The note is the box's description, so
 * a screen reader hears how many cards the answer is about along with the question.
 *
 * `children` sit under the note and **outside the label**: a press inside a label is a press on
 * its checkbox, and the folder's press must not tick the question it hangs from.
 *
 * `warning` is what the answer costs that the trade never said — the cards it takes out of a deck
 * (`deckNote`). Under the note and inside the label, in the destructive colour with a mark that
 * is not a colour, and part of the box's description: it is what the reader ticks the box against.
 */
function Question({
  label,
  note,
  warning = null,
  checked,
  onChange,
  children,
}: {
  label: string;
  note: string;
  warning?: string | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="border-t border-border py-3">
      <label className="grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          // Named by the question alone and described by the note: both sit inside the label, so
          // left to the label the note would be read twice, once as the end of the name.
          aria-labelledby={`${id}-label`}
          aria-describedby={warning === null ? `${id}-note` : `${id}-note ${id}-warning`}
          className={cn("mt-0.5 size-[1.125rem] shrink-0 accent-accent", FOCUS)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span id={`${id}-label`} className="text-sm font-medium">
            {label}
          </span>
          <span id={`${id}-note`} className="text-[0.8125rem] leading-snug text-dim">
            {note}
          </span>
          {warning !== null && (
            <span className="flex items-start gap-1.5 text-[0.8125rem] leading-snug font-medium text-destructive">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span id={`${id}-warning`} className="min-w-0">
                {warning}
              </span>
            </span>
          )}
        </span>
      </label>
      {children !== undefined && <div className="pl-8">{children}</div>}
    </div>
  );
}
