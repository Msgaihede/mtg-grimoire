import type { JSX } from "react";
import { QuantityStepper } from "@/components/QuantityStepper";
import type { GameManaKind, ManaByType, ManaTable } from "@/lib/ipc";
import { MANA_FILL, MANA_KEYS, MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";

/** The wire's field for each symbol key, in `MANA_KEYS` order — and the type of mana it is. */
const FIELD: Record<ManaKey, GameManaKind> = {
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
 *
 * **With the sandbox on, the pool is the reader's to set** (`onPool`, issue #1723): its row is
 * always drawn, each type a stepper standing in its column — `+` above, `−` below, the number
 * between, which takes a typed amount too. A press adds or takes one (the `mana` sandbox move);
 * a typed number is sent as the difference. It is how a reader makes the mana a card the rules
 * engine does not play would have made. `poolDisabled` greys the steppers while the sandbox's
 * moves do not work (a question asked, the engine busy), as the life plates' are.
 */
export function ManaTableView({
  mana,
  label = "Mana",
  onPool,
  poolDisabled = false,
  className,
}: {
  mana: ManaTable;
  /** The table's accessible name; the playtest board names whose it is. */
  label?: string;
  /** The sandbox is on: add (`delta` above zero) or take mana of `kind` from the pool by hand.
   *  Absent, the pool is the rules' alone and its row is drawn only while mana floats. */
  onPool?: (kind: GameManaKind, delta: number) => void;
  /** The pool's steppers cannot be pressed now. */
  poolDisabled?: boolean;
  className?: string;
}): JSX.Element {
  const rows: [string, ManaByType][] = [["Open", mana.open]];
  if (onPool === undefined && anyMana(mana.floating)) rows.push(["Pool", mana.floating]);
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
        {onPool !== undefined && (
          <tr>
            <th scope="row" className="pr-0.5 text-left font-normal text-dim">
              Pool
            </th>
            {MANA_KEYS.map((key) => {
              const n = mana.floating[FIELD[key]];
              return (
                <td key={key} className="p-0 text-center">
                  {/* A `fieldset` because the stepper has no `disabled` of its own (`LifePlate`). */}
                  <fieldset disabled={poolDisabled} className="m-0 border-0 p-0">
                    <QuantityStepper
                      value={n}
                      onChange={(next) => {
                        if (next !== n) onPool(FIELD[key], next - n);
                      }}
                      min={0}
                      max={99}
                      label={`${MANA_LABEL[key]} mana in your pool`}
                      size="xs"
                      orientation="vertical"
                    />
                  </fieldset>
                </td>
              );
            })}
          </tr>
        )}
      </tbody>
    </table>
  );
}
