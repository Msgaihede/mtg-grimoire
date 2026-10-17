import type { JSX } from "react";
import type { ManaByType, ManaTable } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";

/** The wire's field for each symbol key, in `MANA_KEYS` order. */
const FIELD: Record<ManaKey, keyof ManaByType> = {
  W: "white",
  U: "blue",
  B: "black",
  R: "red",
  G: "green",
  C: "colorless",
};

/** Whether any type holds anything — the pool's row is drawn only then. */
export function anyMana(counts: ManaByType): boolean {
  return MANA_KEYS.some((key) => counts[FIELD[key]] > 0);
}

/**
 * A seat's mana by type, the board's mana table (issue #1002): a column per type, WUBRG and then
 * colorless, and a row of what the untapped permanents could make. **All six columns are always
 * drawn**, so a reader learns where each type sits once; a type with none is dimmed rather than
 * left out. The pool's row appears only while mana is floating — mid-payment, or a ritual's mana
 * not yet spent — because a row of zeroes the rest of the time would be noise.
 *
 * Every source counts toward each type it can make, so a dual land is in two columns and the
 * columns sum to more than the seat's "mana open". The reader's, at the board's foot.
 */
export function ManaTableView({
  mana,
  label = "Mana",
  className,
}: {
  mana: ManaTable;
  /** The table's accessible name; the playtest board names whose it is. */
  label?: string;
  className?: string;
}): JSX.Element {
  const rows: [string, ManaByType][] = [["Open", mana.open]];
  if (anyMana(mana.floating)) rows.push(["Pool", mana.floating]);
  return (
    <table
      aria-label={label}
      className={cn(
        "rounded-xl border border-border bg-surface/90 text-xs tabular-nums",
        "border-separate border-spacing-x-1.5 border-spacing-y-1 px-1",
        className,
      )}
    >
      <thead>
        <tr>
          <td />
          {MANA_KEYS.map((key) => (
            <th key={key} scope="col" className="p-0 font-normal">
              <span
                title={MANA_LABEL[key]}
                style={{ backgroundColor: MANA_FILL[key] }}
                className="inline-flex size-[18px] items-center justify-center rounded-full text-[11px] text-black"
              >
                <i className={manaSymbolClass(key)} aria-hidden="true" />
                <span className="sr-only">{MANA_LABEL[key]}</span>
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, counts]) => (
          <tr key={name}>
            <th scope="row" className="pr-0.5 text-left font-normal text-dim">
              {name}
            </th>
            {MANA_KEYS.map((key) => {
              const n = counts[FIELD[key]];
              return (
                <td
                  key={key}
                  className={cn("text-center", n > 0 ? "font-semibold text-text" : "text-dim/60")}
                >
                  {n}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
