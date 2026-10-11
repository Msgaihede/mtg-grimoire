/**
 * One side of an open trade as a destination (issue #903) — the wishlist preview's shape with
 * every control taken out.
 *
 * **No mode and no default finish.** An import onto a side only ever *adds*: a printing and
 * finish the side already holds is raised, which is what `trade_add_lines` does with any line,
 * and a side is short enough to clear by hand — a `set` mode would be a bulk delete on a list the
 * reader is negotiating over. A line that says nothing about its finish is the regular copy,
 * which is what the side's own search field adds too; the stepper on the line changes it after.
 *
 * **One write, all or nothing**: `trade_add_lines` takes the whole list in one savepoint, so a
 * refusal — the trade archived in another window, a line past 9999 copies — leaves the side as
 * it was and is drawn in the commit bar, with the paste one Back away.
 */
import { useMemo, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { count } from "@/lib/counts";
import { ipcError, type TradeSide } from "@/lib/ipc";
import { sideWords } from "@/features/trade/tradeWords";
import { useTradeWrites } from "@/features/trade/useTrades";
import type { DestinationPreviewProps, ImportDestination } from "../destination";
import { CommitBar } from "../shared/CommitBar";
import { ImportProblems } from "../shared/Problems";
import { planTradeImport } from "./trade";

/** Which trade, which side — identity only, for `deckDestination`'s reason: a presentational
 *  value in the closure would remount the step whenever it changed. */
export interface TradeImportInto {
  tradeId: number;
  side: TradeSide;
}

function TradePreview({
  into,
  list,
  resolved,
  onDone,
  onBack,
}: DestinationPreviewProps & { into: TradeImportInto }): JSX.Element {
  const writes = useTradeWrites();
  const plan = useMemo(() => planTradeImport(list, resolved), [list, resolved]);
  const commit = useMutation({
    mutationFn: () => writes.addLines(into.tradeId, into.side, plan.items),
  });

  const runImport = () => {
    if (plan.items.length === 0 || commit.isPending) return;
    commit.mutate(undefined, {
      onSuccess: () => onDone(`${cards(plan.totalCards)} put on ${sideWords(into.side)}.`),
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        runImport();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-sm">
          {cards(plan.totalCards)} will be put on {sideWords(into.side)}.
        </p>
        <ImportProblems
          unmatched={plan.unmatched}
          hintMisses={plan.hintMisses}
          parseIssues={plan.parseIssues}
        />
      </div>

      <CommitBar
        label="Import"
        pendingLabel="Importing…"
        pending={commit.isPending}
        disabled={plan.items.length === 0}
        message={
          commit.error === null ? "" : `Couldn't import the list — ${ipcError(commit.error)}`
        }
        failed={commit.error !== null}
        onBack={onBack}
      />
    </form>
  );
}

/** `1 card`, `3,000 cards` — the other previews' own helper, kept local for their reason. */
function cards(n: number): string {
  return `${count(n)} ${n === 1 ? "card" : "cards"}`;
}

/**
 * The side as a destination, with its identity closed over — `deckDestination`'s shape and its
 * rule: **call it inside a `useMemo` keyed on the trade's id and the side**, because what comes
 * back is a component identity and a fresh one remounts the step under the reader.
 */
export function tradeDestination(into: TradeImportInto): ImportDestination {
  return {
    key: "trade",
    label: sideWords(into.side),
    Preview: (props) => <TradePreview {...props} into={into} />,
  };
}
