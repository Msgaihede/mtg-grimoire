import { useId, useState } from "react";
import {
  formatLabel,
  legalityRows,
  legalitySummary,
  statusClass,
  statusWord,
} from "@/features/card/legality";
import { plural } from "@/lib/counts";
import { cn } from "@/lib/utils";
import { Note, SheetSection, ShowMore } from "./parts";

/**
 * Where this card may be played — **every format, the ones it may not included**, folded behind
 * one line that counts them.
 *
 * The rows, their order, their names and their words are `LegalityDialog`'s, read out of
 * `@/features/card/legality` rather than written again; what is the sheet's own is the fold. The
 * dialog draws 23 rows because a reader pressed *Legality* to ask exactly this. Here the grid sits
 * in a scroll of everything else about the card, where 23 rows open would bury the combos under
 * a list most readers glance at for one format.
 *
 * **Folded, and still never silent.** The dialog's argument is that a format missing from a grid
 * reads as data that failed to load — so the fold says how many formats are behind it and how
 * many the card may be played in, which is a statement about the rows rather than an absence of
 * them, and the whole grid is one press away.
 *
 * Each badge carries the **word**: four statuses land on four treatments, and a reader who cannot
 * tell the green from the red still gets the answer in type.
 */
export function LegalitySection({ legalities }: { legalities: string | null }) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const rows = legalityRows(legalities);
  const summary = legalitySummary(rows);

  return (
    <SheetSection title="Legality">
      {summary === null ? (
        // A card the corpus holds no legality blob for at all — a token, an art card — which is
        // not "legal nowhere" (that is 23 `not_legal` rows and draws in full).
        <Note>Scryfall lists no formats for this card.</Note>
      ) : (
        <>
          <p className="text-sm">{summary}</p>
          {expanded && (
            // The list keeps a name of its own, the more exact of the two: the heading says what
            // the section is about, this says what the items in it are.
            <ul id={listId} aria-label="Format legality" className="flex flex-col gap-1">
              {rows.map(({ format, status }) => (
                <li key={format} className="flex items-center gap-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{formatLabel(format)}</span>
                  {/* One width for every badge, so the words line up into a column the eye can
                      run down — the grid's whole readability at 23 rows. */}
                  <span
                    className={cn(
                      "w-[5.5rem] shrink-0 rounded-full border px-2 py-0.5 text-center text-[0.7rem]",
                      statusClass(status),
                    )}
                  >
                    {statusWord(status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <ShowMore
            expanded={expanded}
            controls={listId}
            onToggle={() => setExpanded((open) => !open)}
            more={`Show all ${plural(rows.length, "format")}`}
            fewer="Hide the formats"
          />
        </>
      )}
    </SheetSection>
  );
}
