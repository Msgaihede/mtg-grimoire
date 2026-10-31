import { useMemo, type JSX } from "react";
import { CardArt } from "@/components/CardArt";
import { scaled } from "@/lib/cardZoom";
import { plural } from "@/lib/counts";
import type { DraftCard } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, manaSymbolClass } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { LABEL } from "../setup/parts";
import { colorTally, POOL_COLUMNS, poolColumns, type PoolColumn } from "./pool";

const COLUMN_TITLE: Record<PoolColumn, string> = {
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6+": "6+",
  lands: "Lands",
};

/**
 * A column's widest at 100%, px — the pack's tile width, so a card picked from the pack lands at the
 * size it was taken at.
 */
const POOL_COLUMN_WIDTH = 190;

/**
 * The pool so far, as a curve: one column per mana value, each a stack of cards with only the
 * top strip of all but the last showing, and the lands in a column of their own. A count over
 * every column and a tally of colours over the whole.
 *
 * A stack rather than a wall because a 45-card pool has to fit under the pack without a scroll
 * of its own: eight columns of overlapping cards is the shape a reader lays a pool out in on a
 * table.
 *
 * **The draft's zoom sets how wide a column may grow, never how narrow it must be** (issue
 * #1433): the eight columns share the row equally up to `POOL_COLUMN_WIDTH` at the reader's zoom,
 * so zooming out shrinks the pool and zooming in grows it until the row is full — past that a
 * column would push the lands off the side, and the pool's whole point is fitting without a scroll.
 */
export function PoolColumns({ pool }: { pool: readonly DraftCard[] }): JSX.Element {
  const zoom = useAppStore((s) => s.cardZoom.draft);
  const columns = useMemo(() => poolColumns(pool), [pool]);
  const tally = useMemo(() => colorTally(pool), [pool]);
  return (
    <section aria-label="Your pool" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h3 className="m-0 font-heading text-lg font-semibold leading-none">Your pool</h3>
        <span className="font-mono text-sm tabular-nums text-dim">
          {plural(pool.length, "card")}
        </span>
        <ColorTally tally={tally} />
      </div>
      {pool.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-dim">
          The cards you pick land here, by mana value.
        </p>
      ) : (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${POOL_COLUMNS.length}, minmax(0, ${scaled(POOL_COLUMN_WIDTH, zoom)}px))`,
          }}
        >
          {POOL_COLUMNS.map((column) => {
            const cards = columns[column];
            return (
              <div key={column} className="flex min-w-0 flex-col gap-1.5">
                <h4 className={cn(LABEL, "flex items-baseline justify-between")}>
                  <span>{COLUMN_TITLE[column]}</span>
                  <span className="font-mono tabular-nums">{cards.length}</span>
                </h4>
                <ul
                  aria-label={`${column === "lands" ? "Lands" : `Mana value ${column}`}: ${plural(cards.length, "card")}`}
                  className="m-0 flex list-none flex-col p-0"
                >
                  {cards.map((card) => (
                    <li
                      key={card.instanceId}
                      // Every card after the first is pulled up over the one before until only
                      // that one's title bar shows: a 5:7 card is 140% of its width tall, and
                      // −122% leaves 18% — the name line — in sight.
                      className="[&:not(:first-child)]:-mt-[122%]"
                    >
                      <CardArt cardId={card.cardId} name={card.name} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One pip per colour with its count, the colours the pool holds none of dimmed. */
export function ColorTally({ tally }: { tally: Record<string, number> }): JSX.Element {
  return (
    <ul aria-label="Colours in your pool" className="m-0 flex list-none items-center gap-2.5 p-0">
      {MANA_KEYS.map((key) => (
        <li
          key={key}
          className={cn("flex items-center gap-1", tally[key] === 0 && "opacity-40")}
          title={`${MANA_LABEL[key]}: ${tally[key]}`}
        >
          <span
            style={{ backgroundColor: MANA_FILL[key] }}
            className="inline-flex size-[18px] items-center justify-center rounded-full text-[11px] text-black"
          >
            <i className={manaSymbolClass(key)} aria-hidden="true" />
          </span>
          <span className="font-mono text-xs tabular-nums text-dim">
            <span className="sr-only">{MANA_LABEL[key]} </span>
            {tally[key]}
          </span>
        </li>
      ))}
    </ul>
  );
}
