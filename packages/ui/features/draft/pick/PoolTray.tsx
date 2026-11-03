import { useEffect, useMemo, type CSSProperties, type JSX } from "react";
import { ManaText } from "@/components/ManaText";
import {
  PrintingPreview,
  usePrintingDwell,
  type DwellRowProps,
} from "@/features/card/PrintingPreview";
import { plural } from "@/lib/counts";
import type { DraftCard } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, type ManaKey } from "@/lib/mana";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { ColumnSymbols } from "./ColumnSymbols";
import { colorTally, columnOf, poolRows, type PoolRow } from "./pool";
import { ColorTally } from "./PoolColumns";
import type { Destination } from "./split";

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
 * preview, draws the card beside its row after a quarter second's rest. Its frame
 * (`PREVIEW_FRAME_ATTR`) is the panel round the trays, which is also their one scroller (`PickScreen`),
 * so the picture is placed in it and clipped by it. Rows are not focusable — there is nothing to do
 * with one — so the preview is the pointer's; the names are plain text a screen reader reads as a
 * list.
 *
 * **A row reads `2× {R} Lightning Bolt`** (issue #1498): the printed cost leads the name, as part of
 * it, so a reader scanning for their two-drops reads the cost first. A column is headed in symbols
 * (`ColumnSymbols`), as the shelf's are.
 *
 * The tray is the pick's drop target in this layout, as the curve is in the other: `PoolZones`
 * wraps it.
 *
 * **The pool is drawn as two of these, Deck and Sideboard** (`PoolZones`, issue #1471). With
 * `moveTo`, each row is a button that sends one copy — the last picked under that name — to the
 * other one, and says so in its name.
 */
export function PoolTray({
  pool,
  title = "Your pool",
  empty = "The cards you pick land here, by mana value.",
  moveTo,
  onMove,
}: {
  pool: readonly DraftCard[];
  /** The heading, and the section's name. */
  title?: string;
  /** What the section says while it holds no card. */
  empty?: string;
  /** Where a press on a row sends one of its copies — absent, a row is not a button. */
  moveTo?: Destination;
  onMove?: (card: DraftCard, to: Destination) => void;
}): JSX.Element {
  const groups = useMemo(() => poolRows(pool), [pool]);
  const tally = useMemo(() => colorTally(pool), [pool]);
  const dwell = usePrintingDwell();
  // A new pick rewrites the rows: a picture hung off one that has just been replaced would be
  // measured against a detached element (`usePrintingDwell`'s `cancel`).
  const { cancel } = dwell;
  useEffect(() => cancel(), [pool, cancel]);
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h3 className="m-0 font-heading text-lg font-semibold leading-none">{title}</h3>
          <span className="font-mono text-sm tabular-nums text-dim">
            {plural(pool.length, "card")}
          </span>
        </div>
        <ColorTally tally={tally} label={`Colours in ${title.toLowerCase()}`} />
      </div>
      {pool.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
          {empty}
        </p>
      ) : (
        // Not positioned: the preview is placed in the frame the caller marks, the trays' panel.
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.column} className="flex flex-col gap-1">
              <h4 className="m-0 flex min-h-5 items-center justify-between gap-1.5">
                <ColumnSymbols
                  symbols={group.symbols}
                  spoken={group.spoken}
                  className="text-base"
                />
                <span className="font-mono text-xs tabular-nums text-dim">{group.count}</span>
              </h4>
              <ul
                aria-label={`${group.spoken}: ${plural(group.count, "card")}`}
                className="m-0 flex list-none flex-col gap-1 p-0"
              >
                {group.rows.map((row) => {
                  // The copy a press moves: the last picked under the row's name in its column.
                  const card = [...pool]
                    .reverse()
                    .find((c) => c.name === row.name && columnOf(c) === group.column);
                  return (
                    <TrayRow
                      key={row.name}
                      row={row}
                      dwell={dwell.rowProps(row.cardId)}
                      onPress={
                        moveTo !== undefined && onMove !== undefined && card !== undefined
                          ? { to: moveTo, press: () => onMove(card, moveTo) }
                          : undefined
                      }
                    />
                  );
                })}
              </ul>
            </div>
          ))}
          <PrintingPreview printingId={dwell.printingId} anchor={dwell.anchor} />
        </div>
      )}
    </section>
  );
}

function TrayRow({
  row,
  dwell,
  onPress,
}: {
  row: PoolRow;
  dwell: DwellRowProps;
  /** A row that moves one copy to the other list on a press. */
  onPress?: { to: Destination; press: () => void };
}): JSX.Element {
  const body = (
    <>
      <span aria-hidden="true" className="h-full w-1.5 shrink-0" style={edgeOf(row.colors)} />
      {/* Counts beside a card keep their `×` (the app's rule; `CountTag` is the one over art). */}
      <span className="shrink-0 font-mono text-xs tabular-nums text-dim">{row.count}×</span>
      {/* The cost leads the name and flows with it — no column of its own, so a short cost leaves
          no gap before the name. A land prints none. */}
      {row.manaCost !== "" && (
        <ManaText source={row.manaCost} className="-mr-0.5 shrink-0 text-[0.8125rem]" />
      )}
      {/* No tooltip for a name the tray cuts short: the dwell's picture is the whole card. */}
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
    </>
  );
  const shape = "flex h-8 items-center gap-2 pr-2.5 text-sm";
  return (
    <li
      {...dwell}
      className="overflow-hidden rounded-md border border-border bg-surface hover:border-accent/55"
    >
      {onPress === undefined ? (
        <div className={shape}>{body}</div>
      ) : (
        <button
          type="button"
          aria-label={`Move ${row.name} to the ${onPress.to}`}
          onClick={onPress.press}
          className={cn(shape, "w-full text-left", FOCUS)}
        >
          {body}
        </button>
      )}
    </li>
  );
}
