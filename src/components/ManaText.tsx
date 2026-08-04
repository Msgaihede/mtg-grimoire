import { Fragment } from "react";
import { manaParts } from "@/lib/mana";
import { cn } from "@/lib/utils";

/**
 * A printed cost or a line of rules text, with real mana symbols.
 *
 * The direction doc's rule: mana symbols come from the bundled `mana-font`, never from a
 * CDN and never as `{2}{U}` typed out — the symbols are how a Magic player reads a cost,
 * and the braces are a wire format that happens to be legible.
 *
 * Each glyph is a font `::before` on an empty `<i>`, so it is invisible to a screen
 * reader — and its token therefore rides along beside it as `sr-only` text, in place.
 * Beside each symbol rather than as one label for the whole run, because the run is often
 * a line of rules text: a label would read the prose a second time, and an `aria-label` on
 * a `<span>` with no role is a name assistive tech is free to ignore anyway.
 */
export function ManaText({ source, className }: { source: string | null; className?: string }) {
  const parts = manaParts(source);
  if (parts.length === 0) return null;

  return (
    <span className={cn("inline-flex items-center gap-px align-middle", className)}>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <Fragment key={i}>{part.value}</Fragment>
        ) : part.glyph === null ? (
          // No glyph for it in this version of the font — new symbols are printed faster
          // than the package ships them. The token stays visible in braces, which is how
          // Scryfall writes it and is at worst a cost the reader has to decode.
          <Fragment key={i}>{`{${part.token}}`}</Fragment>
        ) : (
          <Fragment key={i}>
            {/* `ms-cost` is the font's own pill: a dark circle with the glyph knocked out,
                exactly like a printed symbol. The fills are the font's here rather than
                the theme's — a cost is many small symbols in a row, and they read as the
                printed article or not at all. */}
            <i className={cn(part.glyph, "ms-cost text-[0.85em]")} aria-hidden="true" />
            {/* The trailing space is load-bearing: without it `{2}{U}` reaches a screen
                reader as "2U", one word it will try to pronounce. */}
            <span className="sr-only">{part.token} </span>
          </Fragment>
        ),
      )}
    </span>
  );
}
