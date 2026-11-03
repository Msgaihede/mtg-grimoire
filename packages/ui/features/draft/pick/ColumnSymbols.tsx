import type { JSX } from "react";
import { ManaText } from "@/components/ManaText";
import { cn } from "@/lib/utils";

/**
 * A pool column's heading in symbols — a mana value as its generic mana symbol (`{3}`, `{6}+`,
 * `{0}–{2}`), the lands as the land symbol — the same on the shelf under the pack and in the side
 * tray, so every column of the pool is named one way.
 *
 * The symbols are a picture (`role="img"`) named in words, so a screen reader hears "Mana value 3"
 * rather than `ManaText`'s own spoken tokens.
 */
export function ColumnSymbols({
  symbols,
  spoken,
  className,
}: {
  /** `ManaText`'s source, or `null` for the land symbol. */
  symbols: string | null;
  spoken: string;
  /** The size: the symbols are glyphs, so a `text-*` class sizes them. */
  className?: string;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label={spoken}
      className={cn("inline-flex items-center leading-none text-text", className)}
    >
      {symbols === null ? (
        <i className="ms ms-land" aria-hidden="true" />
      ) : (
        <ManaText source={symbols} />
      )}
    </span>
  );
}
