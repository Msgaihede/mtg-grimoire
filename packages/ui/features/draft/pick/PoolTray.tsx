import { useEffect, useMemo, type CSSProperties, type JSX } from "react";
import {
  PREVIEW_FRAME_ATTR,
  PrintingPreview,
  usePrintingDwell,
  type DwellRowProps,
} from "@/features/card/PrintingPreview";
import { plural } from "@/lib/counts";
import type { DraftCard } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { LABEL } from "../setup/parts";
import { colorTally, poolRows, type PoolColumn, type PoolRow } from "./pool";
import { ColorTally } from "./PoolColumns";

function columnTitle(column: PoolColumn): string {
  return column === "lands" ? "Lands" : `Mana value ${column}`;
}

/**
 * The colour edge down a row's left side: the card's colour, a hard-stopped band of each of a
 * multicoloured card's, colourless's grey for none. A style rather than a class, for `MANA_FILL`'s
 * own reason — a class assembled at runtime emits no rule.
 */
function edgeOf(colors: readonly string[]): CSSProperties {
  const keys = MANA_KEYS.filter((k): k is ManaKey => colors.includes(k));
  if (keys.length === 0) return { background: MANA_FILL.C };
  if (keys.length === 1) return { background: MANA_FILL[keys[0]!] };
  const step = 100 / keys.length;
  const stops = keys.map(
    (k, i) => `${MANA_FILL[k]} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`,
  );
  return { background: `linear-gradient(to bottom, ${stops.join(", ")})` };
}

/**
 * **The pool as a compact side tray** (issue #1474) — MTG Arena's second drafting view, the
 * alternative to `PoolColumns`' curve under the pack. One line per card name with its count, in
 * the curve's columns (mana value 0 … 6+, then the lands), so a 45-card pool is a short list
 * beside the pack rather than a band of card art under it, and the pack keeps the whole height of
 * the window.
 *
 * **A row's art is a dwell away**: `usePrintingDwell`, the card modal's printings list's own hover
 * preview, draws the card beside its row after a quarter second's rest. The list is its frame
 * (`PREVIEW_FRAME_ATTR`), so the picture is placed in it and clipped by it. Rows are not
 * focusable — there is nothing to do with one — so the preview is the pointer's; the names are
 * plain text a screen reader reads as a list.
 *
 * The tray is the pick's drop target in this layout, as the curve is in the other: `PickScreen`
 * wraps it.
 */
export function PoolTray({ pool }: { pool: readonly DraftCard[] }): JSX.Element {
  const groups = useMemo(() => poolRows(pool), [pool]);
  const tally = useMemo(() => colorTally(pool), [pool]);
  const dwell = usePrintingDwell();
  // A new pick rewrites the rows: a picture hung off one that has just been replaced would be
  // measured against a detached element (`usePrintingDwell`'s `cancel`).
  const { cancel } = dwell;
  useEffect(() => cancel(), [pool, cancel]);
  return (
    <section aria-label="Your pool" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h3 className="m-0 font-heading text-lg font-semibold leading-none">Your pool</h3>
          <span className="font-mono text-sm tabular-nums text-dim">
            {plural(pool.length, "card")}
          </span>
        </div>
        <ColorTally tally={tally} />
      </div>
      {pool.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
          The cards you pick land here, by mana value.
        </p>
      ) : (
        <div
          {...{ [PREVIEW_FRAME_ATTR]: true }}
          className="scrollbar-slim relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
        >
          {groups.map((group) => (
            <div key={group.column} className="flex flex-col gap-1">
              <h4 className={cn(LABEL, "flex items-baseline justify-between")}>
                <span>{columnTitle(group.column)}</span>
                <span className="font-mono tabular-nums">{group.count}</span>
              </h4>
              <ul
                aria-label={`${columnTitle(group.column)}: ${plural(group.count, "card")}`}
                className="m-0 flex list-none flex-col gap-1 p-0"
              >
                {group.rows.map((row) => (
                  <TrayRow key={row.name} row={row} dwell={dwell.rowProps(row.cardId)} />
                ))}
              </ul>
            </div>
          ))}
          <PrintingPreview printingId={dwell.printingId} anchor={dwell.anchor} />
        </div>
      )}
    </section>
  );
}

function TrayRow({ row, dwell }: { row: PoolRow; dwell: DwellRowProps }): JSX.Element {
  return (
    <li
      {...dwell}
      className="flex h-8 items-center gap-2 overflow-hidden rounded-md border border-border bg-surface pr-2.5 text-sm hover:border-accent/55"
    >
      <span aria-hidden="true" className="h-full w-1.5 shrink-0" style={edgeOf(row.colors)} />
      {/* Counts beside a card keep their `×` (the app's rule; `CountTag` is the one over art). */}
      <span className="w-6 shrink-0 font-mono text-xs tabular-nums text-dim">{row.count}×</span>
      {/* No tooltip for a name the tray cuts short: the dwell's picture is the whole card. */}
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
    </li>
  );
}
