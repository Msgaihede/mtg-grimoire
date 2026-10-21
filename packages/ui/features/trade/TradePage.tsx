import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Plus } from "lucide-react";
import { PageBar } from "@/components/PageBar";
import { ipcError } from "@/lib/ipc";
import type { Trade, TradeSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { NewTradeDialog } from "./NewTradeDialog";
import { TRADE_BUTTON_ACCENT } from "./tradeControls";
import { TradesPane } from "./TradesPane";
import { TradeView } from "./TradeView";
import { defaultTradeId, nextTradeName } from "./tradeWords";
import { useTrade, useTradeList } from "./useTrades";

const NO_TRADES: TradeSummary[] = [];

/**
 * A trade a read has said is gone, and the list answer that was still offering it.
 *
 * **It applies to that one answer and to no other**, which is the whole point of holding the list
 * beside the id. A list read is a moment behind a delete, so for that moment the list on screen
 * offers a trade that is not there; the next answer is the truth, whatever it holds — the trade
 * gone, or a new trade the backend has handed the same id — and this note says nothing about it.
 */
interface Departed {
  id: number;
  list: readonly TradeSummary[] | undefined;
}

/**
 * The Trade view: every trade the reader keeps on the left, and one of them beside it.
 *
 * It replaced a `WorkInProgress` sentence, and the export kept its name so `App.tsx`'s branch did
 * not change — which is what that placeholder was a file of its own for.
 *
 * ## Which trade is on screen is this component's state, and nothing else's
 *
 * Not the store and not the address: a trade is not a destination anything else in the app links
 * to, and a selection that outlived the view would have to be reconciled with a list that may no
 * longer hold it. So the page opens on a default every time — **the newest open trade, else the
 * newest trade** ({@link defaultTradeId}).
 *
 * **The default is chosen once, on arrival, and then it is a pick like any other.** It is a rule
 * about which trade to *open on*, and read on every render it would be a rule about which trade
 * to *be on*: finishing the newest open trade makes the next-newest the answer, and the page
 * would swap trades under the reader on the press that was supposed to show them what the finish
 * did. So the first answer is written into `picked` and stays there.
 *
 * ## A picked trade that has gone is replaced by the default
 *
 * Deleted here, the page is told (`TradeView`'s `onDeleted`). Deleted in another window, the read
 * of it answers `null` — "there is no such trade", as against `undefined`, "not answered yet" —
 * and that is the whole of how the page knows.
 *
 * **Gone is read off that answer every time, and written down nowhere.** This page used to keep a
 * list of the ids it had seen go, and an id is not a trade's for ever: the backend hands the
 * highest one out again once its trade is deleted, so *delete Trade 5, New trade* answered 5 — an
 * id on the list — and the page turned away from the trade it had just been handed. A `null` that
 * is being asked again is not an answer either: it is whatever the cache last heard about that id.
 *
 * What is kept is narrower and lapses by itself: {@link Departed}. Without it the default would
 * be chosen from a list that has not caught up — the trade that has just gone, straight back.
 *
 * ## The four things it can be showing
 *
 * The list has not answered; something could not be read; there are no trades; or there is a pane
 * and a trade. The first three share one centred column and one live region, and the third adds
 * an invitation to it — a sentence saying what a trade is, and the button that starts one.
 *
 * **A trade that could not be read is the second, even with another trade in hand.** The trade on
 * screen is held across a change of selection so the page does not blank on every press in the
 * pane — but a read that *failed* has no next trade coming, and the held one left standing would
 * be Trade A, with every control live, under a pane that says the reader is on Trade B.
 *
 * ## Where the caret goes when its button leaves
 *
 * Three presses here end with the pressed control gone from the page. **A create and a duplicate**
 * land in the new trade once it is drawn (`TradeView`'s `land`), which is a read away — and the
 * button that asked may not outlive that read, since the first trade swaps the empty state's
 * button for the pane's. **A delete** lands on New trade, whichever of the two is drawn
 * afterwards: `newRef` is on both, so it is read after the render that decided, never in the
 * handler.
 */
export function TradePage(): JSX.Element {
  const list = useTradeList();

  const [picked, setPicked] = useState<number | null>(null);
  const [departed, setDeparted] = useState<Departed | null>(null);
  const [creating, setCreating] = useState(false);
  /** Where the shown trade draws its page bar — a callback ref's element, so `TradeView` is
   *  handed it the render after the slot mounts. */
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  /** The trade the caret is owed to once it is drawn: one just created, or just copied. */
  const [landing, setLanding] = useState<number | null>(null);
  /** Counts the presses that owe the caret to New trade. See the effect below. */
  const [newFocus, setNewFocus] = useState(0);
  /** Whichever New trade button is drawn — the pane's, or the empty state's. */
  const newRef = useRef<HTMLButtonElement>(null);

  const trades = useMemo(() => {
    const all = list.data ?? NO_TRADES;
    return departed !== null && departed.list === list.data
      ? all.filter((row) => row.id !== departed.id)
      : all;
  }, [list.data, departed]);

  const trade = useTrade(picked);
  /** "No such trade", and not merely what the cache last heard: nothing is asking again. */
  const gone = picked !== null && trade.data === null && !trade.isFetching;

  /** Turn away from a trade that is gone: note it against this list, and open on the default. */
  const leave = (id: number) => {
    setDeparted({ id, list: list.data });
    setPicked(defaultTradeId((list.data ?? NO_TRADES).filter((row) => row.id !== id)));
  };
  // Both adjustments are made during render, which is React's own answer for state that follows
  // something else: no frame is drawn on a trade the read has just said is not there, and no
  // effect has to notice. Each is guarded by the state it writes, so neither can run twice.
  if (picked !== null && gone) leave(picked);
  if (picked === null) {
    const opening = defaultTradeId(trades);
    if (opening !== null) setPicked(opening);
  }

  /**
   * The trade on screen, held across a change of selection.
   *
   * A newly selected trade's read is pending for a moment, and for that moment the query has no
   * data at all. Drawing the gap as *Loading trade…* would blank both sides on every press in the
   * pane and draw them again a few milliseconds later — so the trade that was showing stays until
   * the next one has answered. **Or has failed to**: then nothing is coming to replace it, and it
   * is let go so the failure is drawn where it stood.
   */
  const [held, setHeld] = useState<Trade | null>(null);
  /** An error and no data: the read of *this* trade failed, with nothing of it to show. */
  const unread = picked !== null && trade.isLoadingError;
  const answered =
    picked === null || unread
      ? null
      : // A `null` being asked again is not an answer yet, any more than no data is.
        trade.data === null && trade.isFetching
        ? undefined
        : trade.data;
  if (answered !== undefined && answered !== held) setHeld(answered);
  const shown = answered === undefined ? held : answered;

  // After the render that decided which New trade button there is: the last trade's delete takes
  // the pane's away and puts the empty state's up, and a caret handed to the first in the handler
  // would be on `<body>` a frame later.
  useEffect(() => {
    if (newFocus > 0) newRef.current?.focus();
  }, [newFocus]);

  /** Show a trade that has just been made, and owe it the caret. */
  const open = (id: number) => {
    setPicked(id);
    setLanding(id);
  };

  const failure = list.isError
    ? `Couldn't read your trades — ${ipcError(list.error)}`
    : unread
      ? `Couldn't read this trade — ${ipcError(trade.error)}`
      : null;
  const status = list.isPending
    ? "Loading trades…"
    : failure !== null
      ? failure
      : trades.length > 0 && shown === null
        ? "Loading trade…"
        : null;
  /** The list answered and holds nothing: the one state with an invitation in it. */
  const empty = list.data !== undefined && trades.length === 0;

  return (
    // Named for the trade on screen, so the region that names a trade holds its bar — its title,
    // rename field and actions — now that the bar spans the page above the trade list.
    // `tabIndex={-1}`: it is where the caret lands when a pressed control leaves (`landOn`).
    <section
      ref={pageRef}
      aria-label={shown?.name}
      tabIndex={-1}
      className="flex h-full min-h-[30rem] flex-col gap-3 outline-none"
    >
      <h2 className="sr-only">Trade</h2>
      {/* **The page bar, across the whole page** (the owner's note, 2026-10-21): above the trade
          list as well as the trade, rather than in the trade's column. With a trade on screen it
          is the trade's own bar (`Trade › <name>`, its rename field and its actions), drawn by
          `TradeView` into this slot through a portal so all of that stays the view's; without
          one — loading, refused or no trades at all — it is the view's name alone, a `div` under
          the `sr-only` `<h2>` above. */}
      {shown !== null ? (
        <div ref={setBarSlot} className="shrink-0" />
      ) : (
        <PageBar title="Trade" titleAs="div" />
      )}
      <div className="flex min-h-0 flex-1 gap-5">
        {trades.length > 0 && (
          <TradesPane
            trades={trades}
            selectedId={picked}
            onSelect={(id) => {
              setPicked(id);
              // A press here is the reader choosing where to be, and the caret stays on it: whatever
              // was owed to a trade still on its way is let go.
              setLanding(null);
            }}
            onNew={() => setCreating(true)}
            newRef={newRef}
          />
        )}
        {shown !== null && (
          <TradeView
            // Keyed, so a rename half typed, a scope chosen or a refusal shown on one trade does not
            // follow the reader to the next.
            key={shown.id}
            trade={shown}
            land={shown.id === landing}
            onLanded={() => setLanding(null)}
            onSelect={open}
            onDeleted={() => {
              leave(shown.id);
              setNewFocus((n) => n + 1);
            }}
            barSlot={barSlot}
            landOn={pageRef}
          />
        )}
        {/* **Always mounted, and swapped into**: a live region that arrived together with its own
            sentence would announce nothing, and a read that fails with a trade on screen is exactly
            that arrival. Beside a trade it is empty and off the page; without one it is the column
            where the trade would be. */}
        <div className={shown !== null ? "sr-only" : "grid min-w-0 flex-1 place-items-center"}>
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <p
              role="status"
              className={cn("text-sm", failure !== null ? "text-destructive" : "text-dim")}
            >
              {shown !== null ? null : status}
            </p>
            {shown === null && empty && (
              <>
                <p className="font-heading text-xl font-semibold">No trades yet</p>
                <p className="text-sm leading-relaxed text-dim">
                  A trade is two piles of cards and the difference between them. Put what you give on
                  one side and what they give on the other, and the page keeps the balance in the
                  prices you choose.
                </p>
                <button
                  ref={newRef}
                  type="button"
                  onClick={() => setCreating(true)}
                  className={TRADE_BUTTON_ACCENT}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  New trade
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <NewTradeDialog
        open={creating}
        placeholder={nextTradeName(trades)}
        onCreated={(id) => {
          open(id);
          setCreating(false);
        }}
        onDismiss={() => {
          setCreating(false);
          newRef.current?.focus();
        }}
        onClose={() => setCreating(false)}
      />
    </section>
  );
}
